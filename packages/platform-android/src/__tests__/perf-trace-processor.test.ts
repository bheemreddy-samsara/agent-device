import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeAndroidPerfettoTrace,
  buildAndroidTraceHangs,
  buildAndroidTraceHangsSql,
  parseTraceProcessorCsv,
  type TraceProcessorRow,
} from '../perf-trace-processor.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(),
    whichCmd: vi.fn(async () => false),
  };
});

import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import { bindAndroidAdbHostStub } from '../adb-host.fixtures.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

// CSVs captured with trace_processor (v57) running the production query over live
// Perfetto captures on the API 35 emulator: the hang fixture holds three induced
// 4s busy main-thread windows; the idle fixture holds a settled app whose main
// thread only sleeps.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const hangsCsv = readFileSync(path.join(fixtures, 'perf-trace-processor-hangs.csv'), 'utf8');
const idleCsv = readFileSync(path.join(fixtures, 'perf-trace-processor-idle.csv'), 'utf8');

/** In-memory host port so the SQL file and cleanup are observable without touching disk. */
function bindInMemoryHost(written: Map<string, string>): { removedDirs: string[] } {
  const removedDirs: string[] = [];
  bindAndroidAdbHostStub({
    files: {
      access: async () => {},
      ensureDirectory: async () => {},
      isExecutable: async () => false,
      makeTempDirectory: async (prefix) => `/tmp/${prefix}one`,
      readBytes: async () => Buffer.alloc(0),
      readDirectory: async () => [],
      readText: async () => '',
      remove: async (target) => {
        removedDirs.push(target);
      },
      sha256: () => 'stub',
      stat: async () => ({ isFile: true, size: 0 }),
      writeAtomicText: async (target, value) => {
        written.set(target, value);
      },
      writeBytes: async () => {},
    },
  });
  return { removedDirs };
}

function bindResolvableTool(): void {
  mockWhichCmd.mockImplementation(async (candidate) => candidate === 'trace_processor_shell');
}

beforeEach(() => {
  vi.resetAllMocks();
});

test('parseTraceProcessorCsv reads trace_processor window rows', () => {
  const rows = parseTraceProcessorCsv(hangsCsv);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['bounds', 'run', 'run', 'run'],
  );
  const run = rows.find((row) => row.kind === 'run');
  assert.ok(run);
  assert.ok(run.dur > 3_000_000_000, 'the first induced hang spans ~4s');
  assert.ok(run.runningNs <= run.dur, 'running time cannot exceed the window');
});

test('buildAndroidTraceHangs turns real induced hangs into separate running-dominant hangs', () => {
  const result = buildAndroidTraceHangs({
    rows: parseTraceProcessorCsv(hangsCsv),
    packageName: 'com.example.hangapp',
    tracePath: '/tmp/app.perfetto-trace',
  });
  assert.equal(result.hangs.length, 3, 'three induced 4s hangs must stay three windows');
  for (const hang of result.hangs) {
    assert.equal(Math.abs(hang.durationMs - 4000) < 100, true);
    assert.ok(hang.runningMs > hang.blockedMs, 'busy hangs must be running-dominant');
    assert.equal(hang.runningMs + hang.blockedMs <= hang.durationMs + 0.2, true);
    assert.equal(hang.thread, 'main (com.example.hangapp)');
    assert.equal(hang.source, 'thread_state');
    assert.match(hang.nextSteps.join('\n'), /perf cpu profile/);
  }
  const starts = result.hangs.map((hang) => hang.startOffsetMs).sort((left, right) => left - right);
  assert.equal(starts.length, 3);
  assert.ok(
    starts[1]! - starts[0]! > 3_000 && starts[2]! - starts[1]! > 3_000,
    'windows must sit apart, near the +3/+10/+17s schedule',
  );
});

test('buildAndroidTraceHangs reports no hangs for an idle main thread', () => {
  const result = buildAndroidTraceHangs({
    rows: parseTraceProcessorCsv(idleCsv),
    packageName: 'com.example.hangapp',
    tracePath: '/tmp/app.perfetto-trace',
  });
  assert.deepEqual(result.hangs, []);
  assert.equal(result.hangCount, 0);
});

test('buildAndroidTraceHangsSql excludes idle sleep from windows and filters the threshold in SQL', () => {
  const sql = buildAndroidTraceHangsSql("com.example.o'brien");
  assert.ok(sql.includes("'com.example.o''brien'"), 'the package name must be escaped');
  // One SELECT chain so trace_processor prints one CSV block.
  assert.equal((sql.match(/^SELECT/gm) ?? []).length, 2);
  assert.equal((sql.match(/UNION ALL/g) ?? []).length, 1);
  assert.ok(sql.includes('ORDER BY kind, ts'));
  // Idle sleep closes a window and never counts: only non-idle states are grouped.
  assert.ok(sql.includes("state IN ('Running', 'R', 'R+', 'D')"));
  assert.ok(sql.includes('LAG(state)'));
  assert.ok(sql.includes("prev_state NOT IN ('Running', 'R', 'R+', 'D')"));
  // The main thread is found by joining thread to process, not a scalar pid subquery.
  assert.ok(sql.includes('JOIN process p USING (upid)'));
  assert.ok(sql.includes('t.tid = p.pid'));
  // The 250ms threshold is stated once, in SQL.
  assert.equal((sql.match(/250000000/g) ?? []).length, 1);
  assert.ok(!sql.includes('actual_frame_timeline_slice'), 'the frame-timeline pass is dropped');
});

// The window rule itself, run over an in-memory database shaped like Perfetto's
// thread_state/process tables. SQLite evaluates the same window functions
// trace_processor's engine does, so this pins S-closes-window, the state split,
// and the threshold independently of the committed CSV fixtures.
function queryHangWindowsSqlite(states: Array<[number, number, string]>): TraceProcessorRow[] {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE process (upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
    CREATE TABLE thread (utid INTEGER PRIMARY KEY, tid INTEGER, upid INTEGER);
    CREATE TABLE thread_state (utid INTEGER, ts INTEGER, dur INTEGER, state TEXT);
    CREATE TABLE trace_bounds (start_ts INTEGER, end_ts INTEGER);
    INSERT INTO process VALUES (1, 4321, 'com.example.hangapp');
    INSERT INTO thread VALUES (7, 4321, 1);
    INSERT INTO trace_bounds VALUES (0, 30000000000);
  `);
  const insert = db.prepare('INSERT INTO thread_state VALUES (7, ?, ?, ?)');
  for (const [ts, dur, state] of states) insert.run(ts, dur, state);
  const sql = buildAndroidTraceHangsSql('com.example.hangapp');
  const rows = db.prepare(sql).all() as Array<{
    kind: string;
    ts: number;
    dur: number;
    running_ns: number;
  }>;
  db.close();
  return rows.map((row) => ({
    kind: row.kind,
    ts: Number(row.ts),
    dur: Number(row.dur),
    runningNs: Number(row.running_ns),
  }));
}

test('the window SQL yields separate non-idle windows, S closing them, over an in-memory database', () => {
  // One 4s busy window, a 6s idle sleep, another 4s busy window, an 80ms blocked
  // window under the threshold, and one 4s window with a D (blocked) state row.
  const states: Array<[number, number, string]> = [
    [1_000_000_000, 2_000_000_000, 'Running'],
    [3_000_000_000, 2_000_000_000, 'Running'], // continues the first window
    [5_000_000_000, 6_000_000_000, 'S'], // idle sleep closes the window
    [11_000_000_000, 4_000_000_000, 'Running'],
    [15_000_000_000, 2_000_000_000, 'S'],
    [17_000_000_000, 80_000_000, 'D'], // below the 250ms threshold
    [17_080_000_000, 2_000_000_000, 'S'],
    [19_000_000_000, 2_000_000_000, 'Running'],
    [21_000_000_000, 2_000_000_000, 'D'], // blocked inside the same window
  ];
  const rows = queryHangWindowsSqlite(states);
  const windows = rows.filter((row) => row.kind === 'run');
  assert.equal(windows.length, 3, 'S closes windows; the short D window drops below the threshold');
  assert.deepEqual(
    windows.map((w) => [w.ts, w.dur]),
    [
      [1_000_000_000, 4_000_000_000],
      [11_000_000_000, 4_000_000_000],
      [19_000_000_000, 4_000_000_000],
    ],
    'idle sleep must not stretch or merge windows',
  );
  assert.deepEqual(
    windows.map((w) => w.runningNs),
    [4_000_000_000, 4_000_000_000, 2_000_000_000],
    'only Running counts as running; the D half counts as blocked',
  );
  assert.equal(rows.find((row) => row.kind === 'bounds')?.dur, 30_000_000_000);
});

test('analyzeAndroidPerfettoTrace reports a typed note when trace_processor is missing', async () => {
  mockWhichCmd.mockResolvedValue(false);
  bindInMemoryHost(new Map());
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'trace-processor-missing');
  assert.match(result.hint, /trace_processor/);
});

test('analyzeAndroidPerfettoTrace prefers trace_processor_shell when both tools are on PATH', async () => {
  mockWhichCmd.mockResolvedValue(true);
  bindInMemoryHost(new Map());
  mockRunCmd.mockResolvedValue({ stdout: hangsCsv, stderr: '', exitCode: 0 });
  await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  const shellCall = mockRunCmd.mock.calls.find(([command]) => command === 'trace_processor_shell');
  assert.ok(shellCall, 'PATH lookup must prefer the shell build');
  assert.equal(
    mockRunCmd.mock.calls.some(([command]) => command === 'trace_processor'),
    false,
    'the plain tool must not also run',
  );
});

test('analyzeAndroidPerfettoTrace writes the SQL script and runs the resolved tool', async () => {
  bindResolvableTool();
  const written = new Map<string, string>();
  bindInMemoryHost(written);
  mockRunCmd.mockResolvedValue({ stdout: hangsCsv, stderr: '', exitCode: 0 });
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.tracePath, '/tmp/app.perfetto-trace');
  assert.deepEqual(result.hotspots, []);
  assert.equal(result.hangCount, 3);
  const sqlPath = [...written.keys()][0];
  assert.ok(sqlPath && sqlPath.endsWith('hangs.sql'));
  assert.equal(written.get(sqlPath), buildAndroidTraceHangsSql('com.example.hangapp'));
  const call = mockRunCmd.mock.calls.find(([command]) => command === 'trace_processor_shell');
  assert.ok(call);
  assert.deepEqual(call[1].slice(0, 3), ['query', '-f', sqlPath]);
  assert.equal(call[2]?.allowFailure, true);
  assert.equal(typeof call[2]?.timeoutMs, 'number');
});

test('analyzeAndroidPerfettoTrace reports a failed query with the tool stderr detail', async () => {
  bindResolvableTool();
  bindInMemoryHost(new Map());
  mockRunCmd.mockResolvedValue({
    stdout: '',
    stderr: 'error: no such column: bogus\nmore output',
    exitCode: 1,
  });
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'trace-processor-failed');
  assert.match(result.message, /no such column: bogus/);
  assert.match(result.hint, /ui\.perfetto\.dev/);
});

test('analyzeAndroidPerfettoTrace reports a failed query when the tool run throws', async () => {
  bindResolvableTool();
  const host = bindInMemoryHost(new Map());
  mockRunCmd.mockRejectedValue(new Error('spawn trace_processor_shell timeout'));
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'trace-processor-failed');
  assert.match(result.message, /timeout/);
  // The SQL temp directory is cleaned even when the query dies mid-run.
  assert.equal(host.removedDirs.includes('/tmp/agent-device-perfetto-query-one'), true);
});

test('analyzeAndroidPerfettoTrace reports a failed query when the SQL write fails', async () => {
  bindResolvableTool();
  // The default stub host throws from makeTempDirectory, pinning the catch around
  // the SQL-file setup.
  bindAndroidAdbHostStub();
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.equal(result.reason, 'trace-processor-failed');
  assert.match(result.message, /makeTempDirectory/);
});

test('analyzeAndroidPerfettoTrace stays available when trace_processor prints malformed CSV', async () => {
  bindResolvableTool();
  bindInMemoryHost(new Map());
  mockRunCmd.mockResolvedValue({
    stdout: 'kind,ts,dur,running_ns\n"broken,row\nrun,notanumber,alsonotanumber,0\n',
    stderr: '',
    exitCode: 0,
  });
  const result = await analyzeAndroidPerfettoTrace({
    tracePath: '/tmp/app.perfetto-trace',
    packageName: 'com.example.hangapp',
  });
  assert.equal(result.available, true);
  if (!result.available) return;
  // Garbage lines drop at the parse boundary; the capture result stays intact.
  assert.deepEqual(result.hangs, []);
  assert.equal(result.hangCount, 0);
});
