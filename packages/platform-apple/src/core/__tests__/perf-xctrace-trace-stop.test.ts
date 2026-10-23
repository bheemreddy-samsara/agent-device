import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(actual.runCmd),
    runCmdBackground: vi.fn(actual.runCmdBackground),
  };
});

import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import {
  analyzeAppleXctraceTrace,
  stopAppleXctracePerfCapture,
  type AppleXctracePerfCapture,
} from '../perf-xctrace.ts';
import { mockHostCommands, type MockRunCmdResult } from './perf.fixtures.ts';

const mockRunCmdBackground = vi.mocked(runCmdBackground);

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tocXml = readFileSync(path.join(fixtures, 'perf-trace-analysis-toc.xml'), 'utf8');
const timeProfileXml = readFileSync(
  path.join(fixtures, 'perf-trace-analysis-timeprofile.xml'),
  'utf8',
);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmdBackground.mockImplementation(() => mockBackgroundXctrace());
});

function emptyRunResult(): MockRunCmdResult {
  return { stdout: '', stderr: '', exitCode: 0 };
}

function readOutputPath(args: readonly string[], flag = '--output'): string {
  return args[args.indexOf(flag) + 1]!;
}

function mockBackgroundXctrace(): ReturnType<typeof runCmdBackground> {
  return {
    child: { kill: vi.fn(() => true), pid: 1234 } as unknown as ReturnType<
      typeof runCmdBackground
    >['child'],
    wait: Promise.resolve(emptyRunResult()),
  };
}

function traceCapture(tracePath: string): AppleXctracePerfCapture {
  return {
    kind: 'xctrace',
    mode: 'trace',
    template: 'Time Profiler',
    outPath: tracePath,
    appBundleId: 'com.example.hangapp',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [64549],
    targetProcesses: ['HangApp'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 } as unknown as AppleXctracePerfCapture['child'],
    wait: Promise.resolve(emptyRunResult()),
  };
}

test('stopAppleXctracePerfCapture attaches interpreted hangs from the exported tables', async () => {
  const tmpDir = await mkdtempForTest('agent-device-xctrace-stop-analysis-');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  mockHostCommands([
    async (_cmd, args) => {
      if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
      const xpath = args[args.indexOf('--xpath') + 1] ?? '';
      const xml = args.includes('--toc')
        ? tocXml
        : xpath.includes('time-profile')
          ? timeProfileXml
          : undefined;
      if (xml === undefined) return { stdout: '', stderr: 'no such table', exitCode: 1 };
      await fs.writeFile(readOutputPath(args), xml, 'utf8');
      return emptyRunResult();
    },
  ]);

  try {
    const result = await stopAppleXctracePerfCapture(traceCapture(tracePath));
    assert.ok(result.summary, 'trace-mode stop must attach the analysis summary');
    assert.equal(result.summary.available, true);
    if (!result.summary.available) return;
    const busyHang = result.summary.hangs.find((hang) => hang.durationMs > 1_000);
    assert.ok(busyHang, 'the exported time-profile table must reach the analyzer');
    assert.equal(busyHang.source, 'time-profile');
    assert.ok(busyHang.topSymbol);
    assert.ok(result.summary.hotspots.length > 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('stopAppleXctracePerfCapture reports a typed unavailable summary when table exports fail', async () => {
  const tmpDir = await mkdtempForTest('agent-device-xctrace-stop-analysis-fail-');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  mockHostCommands([
    async (_cmd, args) => {
      if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
      if (args.includes('--toc')) {
        await fs.writeFile(readOutputPath(args), tocXml, 'utf8');
        return emptyRunResult();
      }
      return { stdout: '', stderr: 'table export failed', exitCode: 1 };
    },
  ]);

  try {
    const result = await stopAppleXctracePerfCapture(traceCapture(tracePath));
    assert.ok(result.summary);
    assert.equal(result.summary.available, false);
    if (result.summary.available) return;
    // The TOC lists time-profile, so the failure is an export failure, not a
    // missing table: the agent must not be sent to re-record with the same template.
    assert.equal(result.summary.reason, 'table-export-failed');
    assert.ok(result.summary.tableSchemas.includes('time-profile'));
    assert.ok(!/template/i.test(result.summary.hint));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('analyzeAppleXctraceTrace abandons analysis when the stop budget is exhausted', async () => {
  // The stop path derives the budget from its static cap minus the stop wait
  // already spent; with nothing left, analysis must not run any host command.
  const result = await analyzeAppleXctraceTrace({
    tracePath: '/tmp/app.trace',
    targetProcesses: ['HangApp'],
    targetPids: [1],
    budgetMs: 0,
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'analysis-timeout');
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
});

test('stopAppleXctracePerfCapture shrinks the analysis budget by the stop wait spent', async () => {
  // The budget is the static cap minus the time between stop entry and analysis
  // start. A stop wait that consumed 41s of the 40s cap leaves nothing, so the
  // summary is the typed analysis-timeout and no export command runs.
  const tmpDir = await mkdtempForTest('agent-device-xctrace-stop-budget-');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  const nowSpy = vi.spyOn(Date, 'now');
  const startedMs = nowSpy();
  let enteredAnalysis = false;
  mockHostCommands([
    async (_cmd, args) => {
      if (args[0] !== 'xctrace' || args[1] !== 'export') return null;
      enteredAnalysis = true;
      return { stdout: '', stderr: '', exitCode: 1 };
    },
  ]);
  // stopAppleXctracePerfCapture reads Date.now() at entry, derives the budget
  // before analysis, and the export pass reads it again per export. Return the
  // entry time first, then a clock 41s ahead for every later read.
  let nowCalls = 0;
  nowSpy.mockImplementation(() => (++nowCalls === 1 ? startedMs : startedMs + 41_000));

  try {
    const result = await stopAppleXctracePerfCapture(traceCapture(tracePath));
    assert.ok(result.summary);
    assert.equal(result.summary.available, false);
    if (result.summary.available) return;
    assert.equal(result.summary.reason, 'analysis-timeout');
    assert.equal(
      enteredAnalysis,
      false,
      'an exhausted stop-path budget must not spawn a single export',
    );
  } finally {
    nowSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
