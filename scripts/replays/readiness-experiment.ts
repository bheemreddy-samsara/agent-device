import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseXmlDocumentSync } from '@agent-device/xml';
import { safeSessionName } from '@agent-device/host-kit/session-paths';

const DEFAULT_SOURCE = 'packages/replay-port/src/daemon-port/session-replay-action-runtime.ts';
const DEFAULT_DECLARATION = 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;';
const ATTRIBUTION_SOURCE =
  'packages/replay-port/src/daemon-port/session-replay-runtime-engine-adapter.ts';
const OUTPUT = 'test/artifacts/readiness-experiment';

export function baselineSource(source: string): string {
  if (source.split(DEFAULT_DECLARATION).length !== 2) {
    throw new Error('Expected exactly one replay readiness default declaration');
  }
  return source.replace(DEFAULT_DECLARATION, 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 0;');
}

export type ReadinessEvent = {
  phase?: string;
  ts?: string;
  session?: string;
  command?: string;
  data?: {
    polls?: number;
    end?: string;
    command?: string;
    replaySession?: string;
    replayPath?: string;
    step?: number;
  };
};

export function countReadiness(events: readonly ReadinessEvent[]) {
  const waits = events.filter((event) => event.phase === 'interaction_target_readiness');
  const engaged = waits.filter((event) => (event.data?.polls ?? 0) > 1);
  const resolved = engaged.filter((event) => event.data?.end === 'done').length;
  return {
    observations: waits.length,
    firstPoll: waits.filter((event) => event.data?.polls === 1).length,
    engaged: engaged.length,
    resolved,
    incomplete: engaged.length - resolved,
    targetGate: engaged.filter((event) => event.data?.command !== undefined).length,
    dispatch: engaged.filter((event) => event.data?.command === undefined).length,
  };
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function findFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(file, suffix);
    return entry.name.endsWith(suffix) ? [file] : [];
  });
}

function readNdjson<T>(file: string): T[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function prepare(mode: string, head: string) {
  if (!['enabled', 'disabled'].includes(mode) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('prepare requires enabled/disabled and an exact commit SHA');
  }
  const source = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  const baseline = baselineSource(source);
  const applied = mode === 'disabled' ? baseline : source;
  if (mode === 'disabled') fs.writeFileSync(DEFAULT_SOURCE, applied);
  writeJson(path.join(OUTPUT, 'variant.json'), {
    head,
    mode,
    sourceScope: 'private-comparison-candidate',
    declaration: DEFAULT_DECLARATION,
    unmodifiedSourceSha256: createHash('sha256').update(source).digest('hex'),
    instrumentation: {
      source: ATTRIBUTION_SOURCE,
      sha256: createHash('sha256').update(fs.readFileSync(ATTRIBUTION_SOURCE)).digest('hex'),
      fields: ['replaySession', 'replayPath', 'step'],
    },
    dispatch: {
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      ref: process.env.GITHUB_REF,
      readinessWait: mode,
    },
    corpus: Object.fromEntries(
      ['android', 'ios'].map((platform) => [
        platform,
        corpusFiles(platform).map((file) => ({
          name: path.basename(file),
          sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        })),
      ]),
    ),
    source: DEFAULT_SOURCE,
    sourceSha256: createHash('sha256').update(applied).digest('hex'),
    defaultBudgetMs: mode === 'enabled' ? 2_000 : 0,
  });
  fs.writeFileSync(
    path.join(OUTPUT, 'source.patch'),
    mode === 'disabled'
      ? `--- a/${DEFAULT_SOURCE}\n+++ b/${DEFAULT_SOURCE}\n@@\n-${DEFAULT_DECLARATION}\n+const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 0;\n`
      : '',
  );
}

function begin(platform: string) {
  if (!['ios', 'android'].includes(platform)) throw new Error('Expected ios/android');
  writeJson(path.join(OUTPUT, `${platform}-start.json`), { startedMs: Date.now() });
}

type SuiteCase = {
  file: string;
  session: string;
  status: string;
  attempts: number;
  replayed: number;
  healed: number;
  failure?: string;
};
type ReplayAction = {
  session: string;
  replayPath: string;
  step: number;
  command: string;
  startedMs: number;
  finishedMs: number;
  ok: boolean;
  errorCode?: string;
};
type TraceEvent = {
  type: string;
  ts: string;
  replayPath: string;
  session: string;
  step: number;
  command: string;
  ok: boolean;
  errorCode?: string;
};
const ACTING_COMMANDS = ['press', 'click', 'longpress'];

function canonicalFile(file: string): string {
  return fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
}

function corpusFiles(platform: string): string[] {
  const dir =
    platform === 'ios'
      ? 'test/integration/replays/ios/simulator'
      : 'test/integration/replays/android/emulator';
  return findFiles(dir, '.ad').map(canonicalFile).sort();
}

function readSuite(platform: string, junitPath: string) {
  const junit = fs.existsSync(junitPath) ? fs.readFileSync(junitPath, 'utf8') : '';
  const suite = parseXmlDocumentSync(junit)
    .find((node) => node.name === 'testsuites')
    ?.children.find((node) => node.name === 'testsuite');
  const testcases = suite?.children.filter((node) => node.name === 'testcase') ?? [];
  const cases: SuiteCase[] = testcases.map((node) => {
    const output = node.children.find((child) => child.name === 'system-out')?.text ?? '';
    const replayed = output.split('\n').filter((line) => line.startsWith('replayed:'));
    return {
      file: canonicalFile(node.attributes.file ?? ''),
      session: /^session: (.+)$/m.exec(output)?.[1] ?? '',
      status: /^status: (.+)$/m.exec(output)?.[1] ?? '',
      attempts: Number(/^attempts: (.+)$/m.exec(output)?.[1]),
      replayed:
        replayed.length === 1 && /^replayed: \d+$/.test(replayed[0]!)
          ? Number(replayed[0]!.slice('replayed: '.length))
          : Number.NaN,
      healed: Number(/^healed: (.+)$/m.exec(output)?.[1]),
      failure: node.children.find((child) => child.name === 'failure')?.text,
    };
  });
  const expectedFiles = corpusFiles(platform);
  const corpusMatches =
    JSON.stringify(cases.map((item) => item.file).sort()) === JSON.stringify(expectedFiles);
  const caseSessionsValid =
    cases.every((item) => item.session.length > 0) &&
    new Set(cases.map((item) => item.session)).size === cases.length;
  const countsPassed =
    suite?.attributes.failures === '0' &&
    suite.attributes.skipped === '0' &&
    Number(suite.attributes.tests) === cases.length &&
    cases.every((item) => item.status === 'passed' && item.attempts === 1 && item.healed === 0);
  return {
    cases,
    passed: corpusMatches && caseSessionsValid && countsPassed,
    replayTimeMs: Number(suite?.attributes.time) * 1_000,
    corpus: expectedFiles.map((file) => ({
      name: path.basename(file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })),
  };
}

function matchingStops(trace: readonly TraceEvent[], start: TraceEvent) {
  return trace.filter(
    (event) =>
      event.type === 'replay_action_stop' &&
      event.step === start.step &&
      event.replayPath === start.replayPath &&
      event.command === start.command,
  );
}

function actionsFromTrace(trace: readonly TraceEvent[], session: string): ReplayAction[] {
  return trace
    .filter(
      (event) => event.type === 'replay_action_start' && ACTING_COMMANDS.includes(event.command),
    )
    .flatMap((start) => {
      const stops = matchingStops(trace, start);
      if (stops.length !== 1) return [];
      const stop = stops[0]!;
      return [
        {
          session,
          replayPath: canonicalFile(start.replayPath),
          step: start.step,
          command: start.command,
          startedMs: Date.parse(start.ts),
          finishedMs: Date.parse(stop.ts),
          ok: stop.ok === true,
          errorCode: stop.errorCode,
        },
      ];
    });
}

function completeDispatchTrace(trace: readonly TraceEvent[], item: SuiteCase): boolean {
  const starts = trace.filter((event) => event.type === 'replay_action_start');
  const stops = trace.filter((event) => event.type === 'replay_action_stop');
  if (
    !Number.isSafeInteger(item.replayed) ||
    item.replayed < 0 ||
    starts.length !== item.replayed ||
    stops.length !== item.replayed ||
    new Set(starts.map((start) => start.step)).size !== starts.length
  )
    return false;
  return starts.every((start) => {
    const endings = matchingStops(trace, start);
    return (
      Number.isSafeInteger(start.step) &&
      start.step > 0 &&
      typeof start.command === 'string' &&
      start.command.length > 0 &&
      canonicalFile(start.replayPath) === item.file &&
      endings.length === 1 &&
      typeof endings[0]!.ok === 'boolean' &&
      Number.isFinite(Date.parse(start.ts)) &&
      Date.parse(endings[0]!.ts) >= Date.parse(start.ts)
    );
  });
}

function loadActions(artifactDir: string, cases: readonly SuiteCase[]) {
  const actions: ReplayAction[] = [];
  const files: string[] = [];
  const matches = new Map<string, number>();
  let completeActions = true;
  for (const file of findFiles(artifactDir, 'replay-timing.ndjson')) {
    const trace = readNdjson<TraceEvent>(file);
    const attempts = trace.filter((event) => event.type === 'replay_test_attempt_start');
    if (attempts.length !== 1) continue;
    const attempt = attempts[0]!;
    const item = cases.find(
      (item) => item.session === attempt.session && item.file === canonicalFile(attempt.replayPath),
    );
    if (!item) continue;
    const identity = JSON.stringify([attempt.session, canonicalFile(attempt.replayPath)]);
    matches.set(identity, (matches.get(identity) ?? 0) + 1);
    files.push(file);
    completeActions &&= completeDispatchTrace(trace, item);
    actions.push(...actionsFromTrace(trace, attempt.session));
  }
  return {
    actions,
    files,
    complete:
      completeActions &&
      cases.length > 0 &&
      cases.every((item) => matches.get(JSON.stringify([item.session, item.file])) === 1),
  };
}

function eventBelongsToCases(event: ReadinessEvent, cases: readonly SuiteCase[]): boolean {
  if (event.data?.replaySession !== undefined) {
    return cases.some(
      (item) =>
        item.session === event.data?.replaySession &&
        item.file === canonicalFile(event.data?.replayPath ?? ''),
    );
  }
  return cases.some((item) => item.session === event.session);
}

function loadDiagnostics(stateDir: string, cases: readonly SuiteCase[]) {
  const events: ReadinessEvent[] = [];
  const files: string[] = [];
  for (const file of findFiles(path.join(stateDir, 'sessions'), '.ndjson')) {
    if (path.basename(path.dirname(file)) !== 'requests') continue;
    const selected = readNdjson<ReadinessEvent>(file).filter((event) =>
      eventBelongsToCases(event, cases),
    );
    if (selected.length === 0) continue;
    files.push(path.relative(stateDir, file));
    events.push(...selected);
  }
  const complete =
    cases.length > 0 &&
    cases.every((item) => {
      const requestDir = path.join('sessions', safeSessionName(item.session), 'requests');
      return files.some((file) => path.dirname(file) === requestDir);
    });
  return { events, files, complete };
}

function candidatesForWait(event: ReadinessEvent, actions: readonly ReplayAction[]) {
  if (event.data?.replaySession !== undefined) {
    return actions.filter(
      (action) =>
        action.session === event.data?.replaySession &&
        action.replayPath === canonicalFile(event.data?.replayPath ?? '') &&
        action.step === event.data?.step &&
        action.command === event.data?.command,
    );
  }
  const observedMs = Date.parse(event.ts ?? '');
  return actions.filter(
    (action) =>
      action.session === event.session &&
      action.command === event.command &&
      action.startedMs <= observedMs &&
      action.finishedMs >= observedMs,
  );
}

function attributeResolvedWaits(
  events: readonly ReadinessEvent[],
  actions: readonly ReplayAction[],
) {
  const rescued = new Set<string>();
  let unattributedResolvedWaits = 0;
  const resolved = events.filter(
    (event) =>
      event.phase === 'interaction_target_readiness' &&
      (event.data?.polls ?? 0) > 1 &&
      event.data?.end === 'done',
  );
  for (const event of resolved) {
    const candidates = candidatesForWait(event, actions);
    if (candidates.length !== 1 || !candidates[0]!.ok) {
      unattributedResolvedWaits++;
      continue;
    }
    const action = candidates[0]!;
    rescued.add(JSON.stringify([action.session, action.replayPath, action.step]));
  }
  return { rescuedActions: rescued.size, unattributedResolvedWaits };
}

function evidenceValidity(params: {
  suitePassed: boolean;
  pathProven: boolean;
  diagnosticsComplete: boolean;
  variantMatches: boolean;
  actionsSuccessful: boolean;
  startedMs: number;
  finishedMs: number;
  replayTimeMs: number;
  unattributed: number;
}) {
  return (
    params.suitePassed &&
    params.pathProven &&
    params.diagnosticsComplete &&
    params.variantMatches &&
    params.actionsSuccessful &&
    Number.isFinite(params.startedMs) &&
    params.finishedMs > params.startedMs &&
    Number.isFinite(params.replayTimeMs) &&
    params.replayTimeMs > 0 &&
    params.unattributed === 0
  );
}

function summarize(platform: string, stateDir: string, junitPath: string, diagnosticOnly = false) {
  const finishedMs = Date.now();
  const startPath = path.join(OUTPUT, `${platform}-start.json`);
  const startedMs = fs.existsSync(startPath) ? readJson(startPath).startedMs : Number.NaN;
  const variant = readJson(path.join(OUTPUT, 'variant.json'));
  const suite = readSuite(platform, junitPath);
  const trace = loadActions(path.dirname(junitPath), suite.cases);
  const diagnostics = loadDiagnostics(stateDir, suite.cases);
  const readiness = countReadiness(diagnostics.events);
  const attribution = attributeResolvedWaits(diagnostics.events, trace.actions);
  const sourceMatchesManifest =
    createHash('sha256').update(fs.readFileSync(DEFAULT_SOURCE)).digest('hex') ===
      variant.sourceSha256 &&
    createHash('sha256').update(fs.readFileSync(ATTRIBUTION_SOURCE)).digest('hex') ===
      variant.instrumentation.sha256;
  const corpusMatchesManifest =
    JSON.stringify(suite.corpus) === JSON.stringify(variant.corpus[platform]);
  const completedActions = trace.actions.filter((action) => action.ok).length;
  const pathProven =
    trace.complete &&
    completedActions > 0 &&
    (variant.mode === 'enabled' ? readiness.observations > 0 : readiness.observations === 0);
  const summary = {
    ...variant,
    platform,
    diagnosticOnly,
    validityScope: 'machine-evidence-only',
    rescueAttributionScope: 'successful-waited-dispatch-only',
    cases: suite.cases,
    sourceMatchesManifest,
    corpusMatchesManifest,
    actionTracesComplete: trace.complete,
    failedActions: trace.actions.filter((action) => !action.ok),
    suitePassed: suite.passed,
    pathProven,
    validForDecision:
      !diagnosticOnly &&
      evidenceValidity({
        suitePassed: suite.passed,
        pathProven,
        diagnosticsComplete: diagnostics.complete,
        variantMatches: sourceMatchesManifest && corpusMatchesManifest,
        actionsSuccessful: trace.actions.every((action) => action.ok),
        startedMs,
        finishedMs,
        replayTimeMs: suite.replayTimeMs,
        unattributed: attribution.unattributedResolvedWaits,
      }),
    wallTimeMs: Number.isFinite(startedMs) ? finishedMs - startedMs : null,
    replayTimeMs: suite.replayTimeMs,
    corpus: suite.corpus,
    readiness: { ...readiness, ...attribution },
    completedActions,
    actionTraceFiles: trace.files,
    requestFiles: diagnostics.files,
  };
  writeJson(path.join(OUTPUT, `${platform}-summary.json`), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') prepare(args[0]!, args[1]!);
  else if (command === 'begin') begin(args[0]!);
  else if (command === 'summarize')
    summarize(args[0]!, args[1]!, args[2]!, args[3] === 'diagnostic-only');
  else throw new Error('Expected prepare, begin, or summarize');
}
