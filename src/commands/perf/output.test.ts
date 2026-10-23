import { test } from 'vitest';
import assert from 'node:assert/strict';
import { perfCliOutputFormatters } from './output.ts';

function format(data: Record<string, unknown>): string {
  const output = perfCliOutputFormatters.perf({
    result: { ok: true, ...data } as never,
  } as never);
  return output.text ?? '';
}

const APPLE_HANG = {
  startOffsetMs: 2_111,
  durationMs: 3_999,
  thread: 'Main Thread',
  topSymbol: 'HangViewController.blockMainThread(seconds:)',
  runningMs: 3_900,
  blockedMs: 99,
  source: 'time-profile',
  nextSteps: ['Inspect HangViewController.blockMainThread(seconds:) on the main thread.'],
};

test('Apple trace stop output lists hangs, hotspots, and next steps', () => {
  const text = format({
    kind: 'xctrace',
    mode: 'trace',
    perf: 'stopped',
    template: 'Time Profiler',
    outPath: '/tmp/app.trace',
    summary: {
      available: true,
      hangs: [APPLE_HANG],
      hangCount: 1,
      hitches: { available: true, count: 2, nextSteps: [] },
      hotspots: [{ symbol: 'swift_getTupleTypeMetadata', selfSampleMs: 1_250 }],
      notes: [],
    },
  });
  assert.match(text, /Perf trace: stopped/);
  assert.match(
    text,
    /Hangs \(1\):\n- \+2s 4s Main Thread - HangViewController\.blockMainThread\(seconds:\) - running 4s \/ blocked 99ms/,
  );
  assert.match(text, /Hitches: 2 animation hitches/);
  assert.match(text, /Hotspots:\n- 1s swift_getTupleTypeMetadata/);
  assert.match(text, /Next steps:\n- Inspect HangViewController/);
});
