import fs from 'node:fs';
import path from 'node:path';
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

test('CLI evidence uses reporter file identity and deduplicates gate/dispatch rescues; failed dispatch cannot vote', async () => {
  const cwd = await mkdtempForTest('readiness-evidence-');
  const script = path.resolve('scripts/replays/readiness-experiment.ts');
  const source = 'packages/replay-port/src/daemon-port/session-replay-action-runtime.ts';
  fs.mkdirSync(path.dirname(path.join(cwd, source)), { recursive: true });
  fs.writeFileSync(path.join(cwd, source), 'const REPLAY_DEFAULT_READINESS_TIMEOUT_MS = 2_000;');
  const corpus = path.join(cwd, 'test/integration/replays/android/emulator');
  fs.mkdirSync(corpus, { recursive: true });
  const file = path.join(corpus, 'navigation.ad');
  fs.writeFileSync(file, 'context platform=android\nclick label=Ready\n');
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
        replayed: 2,
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
  trace.push(trace[1]!, trace[2]!);
  fs.writeFileSync(tracePath, trace.map((event) => JSON.stringify(event)).join('\n'));
  invoke('summarize', 'android', state, junit);
  summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  expect(summary.validForDecision).toBe(false);
  expect(summary.readiness.unattributedResolvedWaits).toBeGreaterThan(0);
});
