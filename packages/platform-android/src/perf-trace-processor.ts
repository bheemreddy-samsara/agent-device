import path from 'node:path';
import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import {
  perfHangNextSteps,
  type PerfHang,
  type PerfTraceAnalysis,
  type PerfTraceHotspot,
} from '@agent-device/contracts/perf-hang-next-steps';
import { requireAndroidAdbHost } from './adb-host.ts';

// Mirrors the Time Profiler "Hangs" instrument default hangsThreshold (ms).
const ANDROID_HANG_THRESHOLD_MS = 250;

const TRACE_PROCESSOR_TIMEOUT_MS = 60_000;

/** Main-thread states that keep a busy window open; `S` and unknown states close it. */
const ANDROID_MAIN_THREAD_NON_IDLE_STATES = "('Running', 'R', 'R+', 'D')";

export type AndroidTraceUnavailableReason = 'trace-processor-missing' | 'trace-processor-failed';

/**
 * Shared trace-analysis envelope: interpreted main-thread hangs plus an empty
 * hotspot list (simpleperf owns Android symbol attribution), or a typed failure.
 */
export type AndroidTraceAnalysis = PerfTraceAnalysis<
  PerfHang,
  PerfTraceHotspot,
  AndroidTraceUnavailableReason
>;

/**
 * Runs one fixed SQL script over a pulled .perfetto-trace with the host
 * trace_processor tool and interprets main-thread hangs. Best-effort by
 * contract: every failure path returns a typed unavailable summary instead of
 * failing the capture stop.
 */
export async function analyzeAndroidPerfettoTrace(params: {
  tracePath: string;
  packageName: string;
}): Promise<AndroidTraceAnalysis> {
  const tool = await resolveAndroidTraceProcessorTool();
  if (!tool) {
    return {
      available: false,
      reason: 'trace-processor-missing',
      message:
        'trace_processor is not installed, so the Perfetto trace was not interpreted for hangs.',
      hint: 'Install the Perfetto trace processor on PATH (curl -LO https://get.perfetto.dev/trace_processor && chmod +x ./trace_processor && mv ./trace_processor /usr/local/bin/) to get hangs and next steps at perf trace stop.',
    };
  }
  const result = await runTraceProcessorQuery({
    tool,
    tracePath: params.tracePath,
    packageName: params.packageName,
  });
  if (result.status === 'failed') {
    return {
      available: false,
      reason: 'trace-processor-failed',
      message: `trace_processor could not query the Perfetto trace (${result.detail}).`,
      hint: `Open ${params.tracePath} in the Perfetto UI (https://ui.perfetto.dev) to inspect the raw trace.`,
    };
  }
  return {
    available: true,
    tracePath: params.tracePath,
    hotspots: [],
    ...buildAndroidTraceHangs({
      rows: parseTraceProcessorCsv(result.csv),
      packageName: params.packageName,
      tracePath: params.tracePath,
    }),
  };
}

async function resolveAndroidTraceProcessorTool(): Promise<string | undefined> {
  const environment = requireAndroidAdbHost().environment;
  for (const candidate of ['trace_processor_shell', 'trace_processor']) {
    if (await whichCmd(candidate, environment)) return candidate;
  }
  return undefined;
}

async function runTraceProcessorQuery(params: {
  tool: string;
  tracePath: string;
  packageName: string;
}): Promise<{ status: 'ok'; csv: string } | { status: 'failed'; detail: string }> {
  const host = requireAndroidAdbHost();
  let sqlPath: string | undefined;
  try {
    sqlPath = path.join(
      await host.files.makeTempDirectory('agent-device-perfetto-query-'),
      'hangs.sql',
    );
    await host.files.writeAtomicText(sqlPath, buildAndroidTraceHangsSql(params.packageName));
    const result = await runCmd(params.tool, ['query', '-f', sqlPath, params.tracePath], {
      allowFailure: true,
      timeoutMs: TRACE_PROCESSOR_TIMEOUT_MS,
      env: host.environment,
    });
    if (result.exitCode !== 0) {
      return {
        status: 'failed',
        detail: firstLine(result.stderr) || `exit code ${result.exitCode}`,
      };
    }
    return { status: 'ok', csv: result.stdout };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (sqlPath) {
      await host.files
        .remove(path.dirname(sqlPath), { force: true, recursive: true })
        .catch(() => {});
    }
  }
}

/**
 * One SELECT (UNION ALL) so trace_processor prints one CSV block. A hang window
 * is a maximal run of consecutive main-thread `thread_state` rows whose state is
 * non-idle: idle sleep (`S`) and unknown states close a window and never count
 * toward duration or blocked time. Only `Running` counts as running; `R`, `R+`
 * and `D` count as blocked. Windows below the 250ms threshold are filtered in
 * SQL. Rows: `run` = hang windows, `bounds` = trace window.
 */
export function buildAndroidTraceHangsSql(packageName: string): string {
  const safePackage = sqlString(packageName);
  // Every non-idle row whose previous main-thread row was idle (or absent) opens
  // a new window; summing that flag gives each window its run id.
  return `WITH main AS (
  SELECT t.utid AS utid
  FROM thread t JOIN process p USING (upid)
  WHERE t.tid = p.pid AND p.name = ${safePackage}
), states AS (
  SELECT ts, dur, state,
    LAG(state) OVER (ORDER BY ts) AS prev_state
  FROM thread_state WHERE utid IN (SELECT utid FROM main)
), grouped AS (
  SELECT ts, dur, state,
    SUM(CASE WHEN prev_state IS NULL OR prev_state NOT IN ${ANDROID_MAIN_THREAD_NON_IDLE_STATES}
      THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS window_id
  FROM states WHERE state IN ${ANDROID_MAIN_THREAD_NON_IDLE_STATES}
)
SELECT 'run' kind, MIN(ts) ts, MAX(ts + dur) - MIN(ts) dur,
  SUM(CASE WHEN state = 'Running' THEN dur ELSE 0 END) running_ns
FROM grouped GROUP BY window_id
HAVING MAX(ts + dur) - MIN(ts) >= ${ANDROID_HANG_THRESHOLD_MS * 1_000_000}
UNION ALL
SELECT 'bounds', start_ts, end_ts, 0 FROM trace_bounds
ORDER BY kind, ts
`;
}

export type TraceProcessorRow = {
  kind: string;
  ts: number;
  dur: number;
  runningNs: number;
};

export function parseTraceProcessorCsv(csv: string): TraceProcessorRow[] {
  const rows: TraceProcessorRow[] = [];
  const lines = csv.split('\n');
  let header: string[] | undefined;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.length !== header.length) continue;
    const record = Object.fromEntries(header.map((key, index) => [key, cells[index]]));
    const ts = Number(record.ts);
    const dur = Number(record.dur);
    if (!Number.isFinite(ts) || !Number.isFinite(dur)) continue;
    rows.push({
      kind: record.kind ?? '',
      ts,
      dur,
      runningNs: Number(record.running_ns) || 0,
    });
  }
  return rows;
}

export function buildAndroidTraceHangs(params: {
  rows: TraceProcessorRow[];
  packageName: string;
  tracePath: string;
}): Pick<Extract<AndroidTraceAnalysis, { available: true }>, 'hangs' | 'hangCount' | 'notes'> {
  const bounds = params.rows.find((row) => row.kind === 'bounds');
  const runs = params.rows
    .filter((row) => row.kind === 'run')
    .sort((left, right) => right.dur - left.dur);
  const traceStartNs = bounds?.ts ?? (runs.length > 0 ? Math.min(...runs.map((r) => r.ts)) : 0);
  const hangs: PerfHang[] = runs.map((run) => {
    const runningMs = ms(run.runningNs);
    const blockedMs = ms(run.dur - run.runningNs);
    const cause = {
      runningMs,
      blockedMs,
      // Simpleperf owns symbol attribution for Android; state rows do not carry symbols.
      topSymbol: undefined,
      threadName: params.packageName,
    };
    return {
      startOffsetMs: ms(run.ts - traceStartNs),
      durationMs: ms(run.dur),
      thread: `main (${params.packageName})`,
      runningMs,
      blockedMs,
      source: 'thread_state',
      nextSteps: perfHangNextSteps(cause),
    };
  });
  const notes: string[] = [];
  notes.push(`Open ${params.tracePath} in https://ui.perfetto.dev for the full timeline.`);
  return { hangs, hangCount: hangs.length, notes };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function firstLine(value: string): string {
  return (
    value
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}

function ms(nanoseconds: number): number {
  return Math.round((nanoseconds / 1_000_000) * 10) / 10;
}
