import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('../perf-trace-processor.ts', () => ({
  analyzeAndroidPerfettoTrace: vi.fn(),
}));
vi.mock('../perf-frame.ts', () => ({
  sampleAndroidFramePerf: vi.fn(async () => {
    throw new Error('gfxinfo unavailable in test');
  }),
}));

import { analyzeAndroidPerfettoTrace } from '../perf-trace-processor.ts';
import { buildAndroidNativePerfStopSummary } from '../perf-native-summary.ts';
import type { AndroidNativePerfSession } from '../perf-native-types.ts';

const mockedAnalyze = vi.mocked(analyzeAndroidPerfettoTrace);

const DEVICE = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as unknown as DeviceInfo;

function traceSession(overrides: Partial<AndroidNativePerfSession> = {}): AndroidNativePerfSession {
  return {
    kind: 'perfetto',
    type: 'trace',
    packageName: 'com.example.hangapp',
    appPid: '4321',
    profilerPid: '4399',
    state: 'running',
    startedAt: 1,
    outPath: '/tmp/app.perfetto-trace',
    remotePath: '/data/misc/perfetto-traces/app.perfetto-trace',
    ...overrides,
  } as AndroidNativePerfSession;
}

beforeEach(() => {
  mockedAnalyze.mockReset();
});

test('trace stop summary mirrors interpreted hangs onto the summary', async () => {
  const hang = {
    startOffsetMs: 2_100,
    durationMs: 4_000,
    thread: 'main (com.example.hangapp)',
    runningMs: 3_900,
    blockedMs: 100,
    source: 'thread_state',
    nextSteps: ['Run perf cpu profile around the interaction.'],
  };
  mockedAnalyze.mockResolvedValue({
    available: true,
    tracePath: '/tmp/app.perfetto-trace',
    hotspots: [],
    hangs: [hang],
    hangCount: 1,
    notes: [],
  });
  const summary = await buildAndroidNativePerfStopSummary(DEVICE, traceSession(), 100, 26_000, {});
  // The envelope spreads onto the summary: hangs and hangCount once, at top level.
  assert.equal(summary.available, true);
  assert.deepEqual(summary.hangs, [hang]);
  assert.equal(summary.hangCount, 1);
  assert.deepEqual(summary.notes, [
    'Frame health is sampled from Android gfxinfo around the trace window; open the Perfetto artifact for timeline root cause.',
  ]);
  assert.deepEqual(mockedAnalyze.mock.calls[0]?.[0], {
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
});

test('trace stop summary adds the install note when trace_processor is missing', async () => {
  mockedAnalyze.mockResolvedValue({
    available: false,
    reason: 'trace-processor-missing',
    message: 'trace_processor is not installed, so the Perfetto trace was not interpreted.',
    hint: 'Install the Perfetto trace processor on PATH.',
  });
  const summary = await buildAndroidNativePerfStopSummary(DEVICE, traceSession(), 100, 26_000, {});
  // The unavailable half of the envelope spreads onto the summary, like Apple's.
  assert.equal(summary.available, false);
  if (summary.available) return;
  assert.equal(summary.reason, 'trace-processor-missing');
  assert.match(summary.message, /trace_processor is not installed/);
});

test('trace stop summary maps an analyzer throw to the typed failed reason', async () => {
  mockedAnalyze.mockRejectedValue(new Error('Android adb host binding is not registered'));
  const summary = await buildAndroidNativePerfStopSummary(DEVICE, traceSession(), 100, 26_000, {});
  assert.equal(summary.available, false);
  if (summary.available) return;
  assert.equal(summary.reason, 'trace-processor-failed');
  assert.match(summary.message, /adb host binding/);
});

test('cpu-profile stop summary never runs trace interpretation', async () => {
  const summary = await buildAndroidNativePerfStopSummary(
    DEVICE,
    traceSession({ kind: 'simpleperf', type: 'cpu-profile' }),
    100,
    26_000,
    {},
  );
  assert.equal(mockedAnalyze.mock.calls.length, 0);
  assert.equal(summary.available, undefined);
  assert.ok(!summary.notes.join('\n').includes('trace_processor'));
});
