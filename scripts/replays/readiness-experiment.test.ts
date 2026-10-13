import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { emitDiagnostic, withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { createJunitReplayTestReporter } from '../../src/cli/replay-test/reporters/junit.ts';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';
import { baselineSource, countReadiness } from './readiness-experiment.ts';

test('baseline disables only the declared default and refuses a changed or duplicated owner', () => {
  const declaration = 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;';
  const refusal = 'Expected exactly one replay readiness default declaration';
  expect(baselineSource(`before\n${declaration}\nafter`)).toBe(
    'before\nconst REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 0;\nafter',
  );
  expect(() => baselineSource('const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 3_000;')).toThrow(
    refusal,
  );
  expect(() => baselineSource(`${declaration}\n${declaration}`)).toThrow(refusal);
});

test('engagement counts actual repeated polls and separates exhausted waits from rescues', () => {
  expect(
    countReadiness([
      { phase: 'interaction_target_readiness', data: { polls: 1, end: 'done' } },
      { phase: 'interaction_target_readiness', data: { polls: 2, end: 'done' } },
      { phase: 'interaction_target_readiness', data: { polls: 3, end: 'expired' } },
      { phase: 'other', data: { polls: 4, end: 'done' } },
    ]),
  ).toEqual({
    observations: 3,
    firstPoll: 1,
    engaged: 2,
    resolved: 1,
    incomplete: 1,
    targetGate: 0,
    dispatch: 2,
  });
});

test.each(['enabled', 'disabled'])(
  'source variant CLI records the private source, both corpora and exact %s mutation',
  async (mode) => {
    const cwd = await mkdtempForTest('readiness-variant-');
    const script = path.resolve('scripts/replays/readiness-experiment.ts');
    const source = 'packages/replay-port/src/daemon-port/session-replay-action-runtime.ts';
    const attribution =
      'packages/replay-port/src/daemon-port/session-replay-runtime-engine-adapter.ts';
    fs.mkdirSync(path.dirname(path.join(cwd, source)), { recursive: true });
    const original = fs.readFileSync(source, 'utf8');
    fs.writeFileSync(path.join(cwd, source), original);
    fs.copyFileSync(attribution, path.join(cwd, attribution));
    for (const dir of [
      'test/integration/replays/android/emulator',
      'test/integration/replays/ios/simulator',
    ]) {
      fs.cpSync(dir, path.join(cwd, dir), { recursive: true });
    }
    const result = runCmdSync(
      process.execPath,
      ['--experimental-strip-types', script, 'prepare', mode, 'a'.repeat(40)],
      {
        cwd,
        env: { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/private' },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = path.join(cwd, 'test/artifacts/readiness-experiment');
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'variant.json'), 'utf8'));
    const selected = fs.readFileSync(path.join(cwd, source), 'utf8');
    expect(selected).toBe(
      mode === 'enabled'
        ? original
        : original.replace(
            'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;',
            'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 0;',
          ),
    );
    expect(manifest).toMatchObject({
      head: 'a'.repeat(40),
      mode,
      sourceScope: 'private-comparison-candidate',
      defaultBudgetMs: mode === 'enabled' ? 2000 : 0,
      sourceSha256: createHash('sha256').update(selected).digest('hex'),
      instrumentation: {
        source: attribution,
        sha256: createHash('sha256').update(fs.readFileSync(attribution)).digest('hex'),
      },
      dispatch: { runId: '42', runAttempt: '1', ref: 'refs/heads/private', readinessWait: mode },
    });
    expect(manifest.corpus.android).toHaveLength(6);
    expect(manifest.corpus.ios).toHaveLength(6);
    for (const [platform, dir] of [
      ['android', 'test/integration/replays/android/emulator'],
      ['ios', 'test/integration/replays/ios/simulator'],
    ]) {
      for (const entry of manifest.corpus[platform]) {
        expect(entry.sha256).toBe(
          createHash('sha256')
            .update(fs.readFileSync(path.join(dir!, entry.name)))
            .digest('hex'),
        );
      }
    }
    expect(fs.readFileSync(path.join(output, 'source.patch'), 'utf8')).toBe(
      mode === 'enabled'
        ? ''
        : `--- a/${source}\n+++ b/${source}\n@@\n-const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;\n+const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 0;\n`,
    );
  },
);

test('variant CLI refuses invalid mode and non-exact head before source writes', async () => {
  const cwd = await mkdtempForTest('readiness-invalid-variant-');
  const source = 'packages/replay-port/src/daemon-port/session-replay-action-runtime.ts';
  fs.mkdirSync(path.dirname(path.join(cwd, source)), { recursive: true });
  const original = 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;';
  fs.writeFileSync(path.join(cwd, source), original);
  for (const args of [
    ['normal', 'a'.repeat(40)],
    ['disabled', '30942ef'],
  ]) {
    const result = runCmdSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve('scripts/replays/readiness-experiment.ts'),
        'prepare',
        ...args,
      ],
      { cwd, allowFailure: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('prepare requires enabled/disabled and an exact commit SHA');
    expect(fs.readFileSync(path.join(cwd, source), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(cwd, 'test/artifacts/readiness-experiment/variant.json'))).toBe(
      false,
    );
  }
});

test('CLI evidence uses reporter file identity and deduplicates gate/dispatch rescues; failed dispatch cannot vote', async () => {
  const cwd = await mkdtempForTest('readiness-evidence-');
  const script = path.resolve('scripts/replays/readiness-experiment.ts');
  const source = 'packages/replay-port/src/daemon-port/session-replay-action-runtime.ts';
  fs.mkdirSync(path.dirname(path.join(cwd, source)), { recursive: true });
  fs.writeFileSync(path.join(cwd, source), 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;');
  const attributionSource =
    'packages/replay-port/src/daemon-port/session-replay-runtime-engine-adapter.ts';
  fs.writeFileSync(path.join(cwd, attributionSource), 'private attribution fixture');
  const corpus = path.join(cwd, 'test/integration/replays/android/emulator');
  fs.mkdirSync(corpus, { recursive: true });
  const file = path.join(corpus, 'navigation.ad');
  fs.writeFileSync(
    file,
    'context platform=android\nclick label=Ready\nclick label=Ready\nwait 1\n',
  );
  const invoke = (...args: string[]) =>
    runCmdSync(process.execPath, ['--experimental-strip-types', script, ...args], { cwd });
  invoke('prepare', 'enabled', 'a'.repeat(40));
  invoke('begin', 'android');
  const state = path.join(cwd, 'state');
  const session = 'readiness:fixture';
  const requestDir = path.join(state, 'sessions', safeSessionName(session), 'requests');
  fs.mkdirSync(requestDir, { recursive: true });
  const baseMs = Date.now();
  const ts = (offset: number) => new Date(baseMs + offset).toISOString();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const outerDir = path.join(state, 'sessions', safeSessionName('readiness:suite'), 'requests');
    fs.mkdirSync(outerDir, { recursive: true });
    await withDiagnosticsScope(
      {
        session: 'readiness:suite',
        command: 'test',
        debug: true,
        logPath: path.join(outerDir, 'suite.ndjson'),
      },
      async () => {
        vi.setSystemTime(baseMs + 1);
        emitDiagnostic({
          phase: 'interaction_target_readiness',
          data: {
            polls: 2,
            end: 'done',
            command: 'click',
            replaySession: session,
            replayPath: file,
            step: 1,
          },
        });
        emitDiagnostic({
          phase: 'interaction_target_readiness',
          data: {
            polls: 2,
            end: 'done',
            command: 'click',
            replaySession: 'unrelated',
            replayPath: file,
            step: 1,
          },
        });
      },
    );
    await withDiagnosticsScope(
      { session, command: 'click', debug: true, logPath: path.join(requestDir, 'request.ndjson') },
      async () => {
        vi.setSystemTime(baseMs + 3);
        emitDiagnostic({ phase: 'interaction_target_readiness', data: { polls: 2, end: 'done' } });
        vi.setSystemTime(baseMs + 6);
        emitDiagnostic({ phase: 'interaction_target_readiness', data: { polls: 2, end: 'done' } });
      },
    );
  } finally {
    vi.useRealTimers();
  }
  const artifacts = path.join(cwd, 'test/artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const tracePath = path.join(artifacts, 'replay-timing.ndjson');
  const trace = [
    { type: 'replay_test_attempt_start', session, replayPath: file },
    { type: 'replay_action_start', replayPath: file, ts: ts(2), step: 1, command: 'click' },
    {
      type: 'replay_action_stop',
      replayPath: file,
      ts: ts(4),
      step: 1,
      command: 'click',
      ok: true,
    },
    { type: 'replay_action_start', replayPath: file, ts: ts(5), step: 2, command: 'click' },
    {
      type: 'replay_action_stop',
      replayPath: file,
      ts: ts(7),
      step: 2,
      command: 'click',
      ok: false,
    },
    { type: 'replay_action_start', replayPath: file, ts: ts(8), step: 3, command: 'wait' },
    { type: 'replay_action_stop', replayPath: file, ts: ts(9), step: 3, command: 'wait', ok: true },
  ];
  const junit = path.join(artifacts, 'suite.xml');
  const reporter = createJunitReplayTestReporter(junit);
  reporter.onSuiteEnd!({
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    notRun: 0,
    durationMs: 50,
    failures: [],
    tests: [
      {
        file,
        title: 'A renamed & readable title',
        session,
        status: 'passed',
        durationMs: 50,
        attempts: 1,
        replayed: 3,
        healed: 0,
      },
    ],
  });
  fs.writeFileSync(tracePath, trace.map((event) => JSON.stringify(event)).join('\n'));
  invoke('summarize', 'android', state, junit);
  const summaryPath = path.join(artifacts, 'readiness-experiment/android-summary.json');
  let summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.suitePassed).toBe(true);
  expect(summary.corpus[0].name).toBe('navigation.ad');
  expect(summary.readiness).toMatchObject({
    engaged: 3,
    rescuedActions: 1,
    unattributedResolvedWaits: 1,
  });
  expect(summary.validForDecision).toBe(false);
  trace[4] = { ...trace[4], ok: true };
  fs.writeFileSync(tracePath, trace.map((event) => JSON.stringify(event)).join('\n'));
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.readiness.rescuedActions).toBe(2);
  expect(summary.validForDecision).toBe(true);
  invoke('summarize', 'android', state, junit, 'diagnostic-only');
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.diagnosticOnly).toBe(true);
  expect(summary.suitePassed).toBe(true);
  expect(summary.pathProven).toBe(true);
  expect(summary.validForDecision).toBe(false);
  const childRequest = path.join(requestDir, 'request.ndjson');
  const requestLog = fs.readFileSync(childRequest, 'utf8');
  fs.writeFileSync(childRequest, requestLog.replaceAll('"command":"click"', '"command":"press"'));
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.validForDecision).toBe(false);
  expect(summary.readiness.unattributedResolvedWaits).toBe(2);
  fs.writeFileSync(childRequest, requestLog);
  const originalSource = fs.readFileSync(path.join(cwd, source), 'utf8');
  fs.appendFileSync(path.join(cwd, source), '\nchanged source');
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.sourceMatchesManifest).toBe(false);
  expect(summary.validForDecision).toBe(false);
  fs.writeFileSync(path.join(cwd, source), originalSource);
  const originalCorpus = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '\nchanged corpus');
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.corpusMatchesManifest).toBe(false);
  expect(summary.validForDecision).toBe(false);
  fs.writeFileSync(file, originalCorpus);
  const originalJunit = fs.readFileSync(junit, 'utf8');
  for (const changed of [
    originalJunit.replace('attempts: 1', 'attempts: 2'),
    originalJunit.replace('healed: 0', 'healed: 1'),
  ]) {
    fs.writeFileSync(junit, changed);
    invoke('summarize', 'android', state, junit);
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.suitePassed).toBe(false);
    expect(summary.validForDecision).toBe(false);
  }
  fs.writeFileSync(junit, originalJunit);
  for (const replayed of ['', 'replayed: 3.0', 'replayed: -1', 'replayed: 3\nreplayed: 3']) {
    fs.writeFileSync(junit, originalJunit.replace('replayed: 3', replayed));
    invoke('summarize', 'android', state, junit);
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.actionTracesComplete).toBe(false);
    expect(summary.validForDecision).toBe(false);
    expect(summary.completedActions).toBe(2);
  }
  fs.writeFileSync(junit, originalJunit);
  const completeTrace = fs.readFileSync(tracePath, 'utf8');
  fs.writeFileSync(
    tracePath,
    trace
      .slice(0, -1)
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.actionTracesComplete).toBe(false);
  expect(summary.validForDecision).toBe(false);
  fs.writeFileSync(tracePath, completeTrace);
  for (const incomplete of [
    trace.slice(0, 5),
    trace.slice(0, 1),
    [...trace, { ...trace[6], step: 4 }],
    trace.map((event) => (event.step === 3 ? { ...event, step: 1 } : event)),
  ]) {
    fs.writeFileSync(tracePath, incomplete.map((event) => JSON.stringify(event)).join('\n'));
    invoke('summarize', 'android', state, junit);
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.suitePassed).toBe(true);
    expect(summary.validForDecision).toBe(false);
    expect(summary.actionTracesComplete).toBe(false);
    expect(summary.readiness.engaged).toBe(3);
  }
  fs.writeFileSync(tracePath, completeTrace);
  const outerLog = path.join(
    state,
    'sessions',
    safeSessionName('readiness:suite'),
    'requests/suite.ndjson',
  );
  fs.renameSync(outerLog, outerLog + '.held');
  fs.writeFileSync(
    tracePath,
    trace
      .map((event) =>
        JSON.stringify(
          event.type.startsWith('replay_action_')
            ? { ...event, replayPath: path.join(corpus, 'wrong-source.txt') }
            : event,
        ),
      )
      .join('\n'),
  );
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.actionTracesComplete).toBe(false);
  expect(summary.validForDecision).toBe(false);
  fs.renameSync(outerLog + '.held', outerLog);
  fs.writeFileSync(tracePath, completeTrace);
  trace.push(trace[1]!, trace[2]!);
  fs.writeFileSync(tracePath, trace.map((event) => JSON.stringify(event)).join('\n'));
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.validForDecision).toBe(false);
  expect(summary.readiness.unattributedResolvedWaits).toBeGreaterThan(0);
});
