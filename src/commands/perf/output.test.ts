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
test('Android trace stop output lists hangs and bounds them to five rows', () => {
  const hangs = Array.from({ length: 7 }, (_, index) => ({
    startOffsetMs: index * 1_000,
    durationMs: 500 + index,
    thread: 'main (com.example.hangapp)',
    runningMs: 400,
    blockedMs: 100,
    source: 'thread_state',
    nextSteps: ['Run perf cpu profile around the interaction.'],
  }));
  const text = format({
    action: 'stop',
    kind: 'perfetto',
    type: 'trace',
    platform: 'android',
    state: 'stopped',
    outPath: '/tmp/app.perfetto-trace',
    sizeBytes: 2_190_000,
    summary: {
      capture: { durationMs: 26_000, packageName: 'com.example.hangapp' },
      // Interpreted hangs appear once on the summary, beside capture metadata.
      hangs,
      notes: [],
    },
  });
  assert.match(text, /Hangs \(7\):/);
  const hangSection = text.split('Next steps:')[0] ?? '';
  const hangLines = hangSection.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(hangLines.length, 6, 'five hangs plus the overflow line');
  assert.match(text, /and 2 more, see the JSON summary/);
  const nextStepsSection = text.split('Next steps:')[1] ?? '';
  assert.equal(nextStepsSection.split('\n').filter((line) => line.startsWith('- ')).length, 1);
});

test('Android trace stop output prints the typed unavailable note without hangs', () => {
  const text = format({
    action: 'stop',
    kind: 'perfetto',
    type: 'trace',
    platform: 'android',
    state: 'stopped',
    outPath: '/tmp/app.perfetto-trace',
    summary: {
      capture: { durationMs: 26_000, packageName: 'com.example.hangapp' },
      // The unavailable envelope spreads onto the summary, like Apple's shape.
      available: false,
      reason: 'trace-processor-missing',
      message: 'trace_processor is not installed.',
      hint: 'Install it.',
      notes: [],
    },
  });
  assert.match(text, /Trace analysis: unavailable - trace-processor-missing/);
  // The CLI text carries the actionable hint, so the doc line "adds a note with
  // install steps" and the help line "prints an install hint" are true in text.
  assert.match(text, /Install it\./);
  assert.ok(!text.includes('Hangs'));
});
