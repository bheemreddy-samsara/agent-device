import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeAppleTraceTables,
  matchesAppleTraceTarget,
  readAppleTraceTableSchemas,
} from '../perf-trace-analysis.ts';

// Excerpts captured with xctrace (Xcode 27.1) from an iOS simulator run of a hang app:
// busy main-thread hangs. Hangs are derived from the time-profile samples because
// Instruments does not fill potential-hangs on simulated devices.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tocXml = readFileSync(path.join(fixtures, 'perf-trace-analysis-toc.xml'), 'utf8');
const timeProfileXml = readFileSync(
  path.join(fixtures, 'perf-trace-analysis-timeprofile.xml'),
  'utf8',
);

const TARGET = {
  tracePath: '/tmp/HangApp.trace',
  targetProcesses: ['HangApp'],
  targetPids: [64549],
};

// Non-monotonic merge: a sample whose (time + weight) ends before the current run
// end must not move that end backwards, so the run duration keeps the accounting
// span instead of collapsing to the late sample's small end.
function nonMonotonicTimeProfileXml(): string {
  const thread =
    '<thread id="2" fmt="Main Thread (0xeb48872) (HangApp, pid: 64549)"><tid id="3" fmt="0xeb48872">246712434</tid><process id="4" fmt="HangApp (64549)"><pid id="5" fmt="64549">64549</pid></process></thread>';
  const running = '<thread-state id="8" fmt="Running">Running</thread-state>';
  const frame = '<frame id="11" name="busy_spin"><binary id="12" name="HangApp"/></frame>';
  return `<trace-toc><run><data><schema name="time-profile">
    <row><sample-time id="1">1000000000</sample-time>${thread}${running}<weight id="9">3000000000</weight><backtrace id="10">${frame}</backtrace></row>
    <row><sample-time id="1b">1000000000</sample-time><thread ref="2"/>${running}<weight id="9b">100000000</weight><backtrace ref="10"/></row>
    <row><sample-time id="1c">1100000000</sample-time><thread ref="2"/>${running}<weight id="9c">100000000</weight><backtrace ref="10"/></row>
  </schema></data></run></trace-toc>`;
}

test('deriveAppleHangs keeps a non-monotonic sample from moving the run end backwards', () => {
  // Sample 1 spans 1.0s..4.0s. Sample 2 (time 1.0s, weight 0.1s) merges into the
  // run and its end (1.1s) is before the run end (4.0s): with a plain assignment
  // the duration would collapse to 0.1s and drop below the 250ms threshold.
  // The monotonic Math.max keeps the 3.0s span with running capped by exposure.
  const result = analyzeAppleTraceTables({
    target: TARGET,
    tocXml,
    timeProfileXml: nonMonotonicTimeProfileXml(),
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.hangs.length, 1);
  const hang = result.hangs[0]!;
  assert.equal(hang.durationMs, 3_000);
  assert.equal(hang.runningMs, 3_000);
  assert.equal(hang.runningMs + hang.blockedMs <= hang.durationMs, true);
});

test('readAppleTraceTableSchemas lists TOC schemas from a real Time Profiler export', () => {
  const schemas = readAppleTraceTableSchemas(tocXml);
  assert.ok(schemas.includes('time-profile'));
  assert.ok(schemas.includes('potential-hangs'));
  assert.ok(schemas.includes('hang-risks'));
  assert.ok(!schemas.includes('hitches'));
  assert.deepEqual(schemas, [...schemas].sort());
});

test('analyzeAppleTraceTables derives main-thread hangs from real time-profile samples', () => {
  const result = analyzeAppleTraceTables({
    target: TARGET,
    tocXml,
    timeProfileXml,
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  // The fixture holds one induced busy main-thread window from a hang-app run.
  const busyHang = result.hangs.find((hang) => hang.durationMs > 1_000);
  assert.ok(busyHang, 'expected a >=1s derived hang');
  assert.equal(busyHang.source, 'time-profile');
  assert.equal(Math.abs(busyHang.startOffsetMs - 2_111) < 50, true);
  assert.equal(Math.abs(busyHang.durationMs - 1_094) < 100, true);
  assert.equal(
    Math.abs(busyHang.runningMs - busyHang.durationMs) < busyHang.runningMs * 0.25,
    true,
  );
  assert.ok(busyHang.topSymbol && busyHang.topSymbol.length > 0);
  assert.ok(busyHang.nextSteps.length > 0);
  assert.match(busyHang.nextSteps.join('\n'), /Inspect .*main thread|perf cpu profile/i);
  // The split and top symbol come only from the samples that formed the run, so a
  // hang can never claim more time than it spans.
  assert.equal(busyHang.runningMs + busyHang.blockedMs <= busyHang.durationMs, true);
  assert.match(result.notes.join('\n'), /hangs were derived from contiguous Time Profiler samples/);
});

test('analyzeAppleTraceTables names table-export-failed when the TOC lists time-profile but its export failed', () => {
  const result = analyzeAppleTraceTables({
    target: TARGET,
    tocXml,
    failedTables: ['time-profile'],
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'table-export-failed');
  assert.ok(!/template/.test(result.hint), 'the hint must not send the agent to re-record');
  assert.ok(result.tableSchemas.includes('time-profile'));
});

test('analyzeAppleTraceTables ranks hotspots from real samples', () => {
  const result = analyzeAppleTraceTables({
    target: TARGET,
    tocXml,
    timeProfileXml,
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.ok(result.hotspots.length > 0);
  const totals = result.hotspots.map((hotspot) => hotspot.selfSampleMs);
  assert.deepEqual(
    totals,
    [...totals].sort((left, right) => right - left),
  );
  assert.ok(totals[0] !== undefined && totals[0] > 0);
});

test('analyzeAppleTraceTables reports unavailable without a time-profile table', () => {
  const result = analyzeAppleTraceTables({ target: TARGET, tocXml });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'no-time-profile-table');
  assert.match(result.hint, /Time Profiler/);
  assert.ok(result.tableSchemas.includes('time-profile'));
});

test('analyzeAppleTraceTables reports unavailable when samples belong to another process', () => {
  const result = analyzeAppleTraceTables({
    target: { tracePath: '/tmp/Other.trace', targetProcesses: ['com.other.app'], targetPids: [1] },
    tocXml,
    timeProfileXml,
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'no-process-samples');
});

test('analyzeAppleTraceTables counts only the app hitches from a real exported hitches table', () => {
  // Three byte-exact rows from a real "Animation Hitches" export (xctrace, Xcode
  // 27.1, attached app), plus one foreign-process row that reuses the real cell
  // encoding (a single-process attach never emitted foreign rows here, and every
  // multi-process capture crashed xctrace export). The target matches by bare
  // process name, so the foreign row must fall out of the process filter.
  const hitchesXml = readFileSync(path.join(fixtures, 'perf-trace-analysis-hitches.xml'), 'utf8');
  const timeProfileHangToolXml = readFileSync(
    path.join(fixtures, 'perf-trace-analysis-timeprofile-hangtool.xml'),
    'utf8',
  );
  const result = analyzeAppleTraceTables({
    target: {
      tracePath: '/tmp/HangTool.trace',
      targetProcesses: ['HangTool'],
      targetPids: [],
    },
    tocXml,
    timeProfileXml: timeProfileHangToolXml,
    hitchesXml,
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.ok(result.hitches, 'an exported hitches table must be reported');
  assert.equal(result.hitches.available, true);
  // The fixture holds three attached-app rows and one foreign-process row.
  assert.equal(result.hitches.count, 3);
  assert.equal(result.hitches.maxDurationMs, 16.7);
  assert.ok(result.hitches.nextSteps.length > 0);
});

test('analyzeAppleTraceTables reports hitches unavailable without the table', () => {
  const result = analyzeAppleTraceTables({
    target: TARGET,
    tocXml,
    timeProfileXml,
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.hitches, undefined);
});

test('matchesAppleTraceTarget accepts the recorded pid and bare executable name only for the target app', () => {
  const target = { targetProcesses: ['com.example.HangApp'], targetPids: [64549] };
  assert.equal(matchesAppleTraceTarget('HangApp (64549)', 64549, target), true);
  assert.equal(
    matchesAppleTraceTarget('HangApp (64549)', 64549, { ...target, targetPids: [] }),
    true,
  );
  assert.equal(matchesAppleTraceTarget('BackBoardASD (501)', 501, target), false);
});
