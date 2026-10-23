import { uniqueStrings } from '@agent-device/kernel/collections';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import {
  findAllXmlNodes,
  indexXmlNodesById,
  rememberXmlReferences,
  resolveXmlNumber,
  resolveXmlReference,
  type XmlReference,
} from './perf-xml.ts';
import {
  perfHangNextSteps,
  perfHitchNextSteps,
  type PerfHang,
  type PerfHangCause,
  type PerfTraceAnalysis,
  type PerfTraceAnalysisUnavailable,
  type PerfTraceHitches,
  type PerfTraceHotspot,
} from '@agent-device/contracts/perf-hang-next-steps';
import { parseAppleHitchRows } from './perf-frame.ts';

// Mirrors the Time Profiler "Hangs" instrument default hangsThreshold (ms).
const APPLE_HANG_THRESHOLD_MS = 250;

export type AppleTraceHang = Omit<PerfHang, 'source'> & {
  source: 'time-profile';
};

export type AppleTraceHotspot = PerfTraceHotspot;

export type AppleTraceUnavailableReason =
  | 'no-time-profile-table'
  | 'no-process-samples'
  | 'toc-export-failed'
  | 'table-export-failed'
  | 'analysis-timeout'
  | 'analysis-failed';

export type AppleTraceAnalysis = Extract<
  PerfTraceAnalysis<AppleTraceHang, AppleTraceHotspot, AppleTraceUnavailableReason>,
  { available: true }
>;

export type AppleTraceAnalysisUnavailable =
  PerfTraceAnalysisUnavailable<AppleTraceUnavailableReason> &
    Readonly<{
      /** Schemas the trace TOC listed, so an agent can tell absent from unexportable. */
      tableSchemas: string[];
    }>;

export type AppleTraceAnalysisResult = AppleTraceAnalysis | AppleTraceAnalysisUnavailable;

export type AppleTraceAnalysisTable = 'time-profile' | 'hang-risks' | 'hitches';

export type AppleTraceAnalysisTarget = {
  tracePath: string;
  targetProcesses: string[];
  targetPids: number[];
};

export function readAppleTraceTableSchemas(tocXml: string): string[] {
  return uniqueStrings(
    findAllXmlNodes(parseXmlDocumentSync(tocXml), (node) => node.name === 'table')
      .map((node) => node.attributes.schema)
      .filter((schema): schema is string => typeof schema === 'string' && schema.length > 0),
  ).sort();
}

export function analyzeAppleTraceTables(params: {
  target: AppleTraceAnalysisTarget;
  tocXml: string;
  timeProfileXml?: string;
  hangRisksXml?: string;
  hitchesXml?: string;
  /** TOC-listed tables whose xctrace export failed (for example hit the export timeout). */
  failedTables?: string[];
}): AppleTraceAnalysisResult {
  const { target } = params;
  const tableSchemas = readAppleTraceTableSchemas(params.tocXml);
  const failedTables = new Set(params.failedTables ?? []);
  if (!params.timeProfileXml) {
    if (failedTables.has('time-profile')) {
      return {
        available: false,
        reason: 'table-export-failed',
        message:
          'The trace lists a time-profile table, but exporting it failed, so hangs and hotspots are not attributable.',
        hint: `The trace was recorded with the needed tables already; retry perf trace stop, or open ${target.tracePath} in Instruments if the export keeps failing.`,
        tableSchemas,
      };
    }
    return {
      available: false,
      reason: 'no-time-profile-table',
      message:
        'The Apple trace contains no time-profile table, so hangs and hotspots are not attributable.',
      hint: `Record with --template "Time Profiler" for hang and hotspot evidence, or open ${target.tracePath} in Instruments for the raw tables.`,
      tableSchemas,
    };
  }
  const samples = parseAppleTraceSamples(params.timeProfileXml, target);
  if (samples.length === 0) {
    return {
      available: false,
      reason: 'no-process-samples',
      message:
        'The Apple trace time-profile table contains no samples for the session app process.',
      hint: `Keep the app active while recording, then retry. Open ${target.tracePath} in Instruments to inspect the raw trace.`,
      tableSchemas,
    };
  }
  // potential-hangs is parsed only once a physical-device capture provides a real
  // fixture; this environment (iOS simulators, Xcode 27.1) exports it with zero rows.
  const hangs = deriveAppleHangsFromSamples(samples);
  const hitches = analyzeAppleHitches(params.hitchesXml, target);
  return {
    available: true,
    tracePath: target.tracePath,
    hangs,
    hangCount: hangs.length,
    hitches,
    hotspots: rankAppleHotspots(samples).slice(0, APPLE_TRACE_HOTSPOT_LIMIT),
    notes: buildAppleTraceNotes(hangs.length, params.hangRisksXml),
  };
}

const APPLE_TRACE_HOTSPOT_LIMIT = 20;

type AppleTraceSample = {
  timeNs: number;
  weightNs: number;
  threadId: string;
  threadName: string;
  isMainThread: boolean;
  running: boolean;
  symbol: string;
  binary?: string;
};

function parseAppleTraceSamples(
  xml: string,
  target: { targetProcesses: string[]; targetPids: number[] },
): AppleTraceSample[] {
  const nodes = parseXmlDocumentSync(xml);
  const nodesById = indexXmlNodesById(nodes);
  const references = new Map<string, XmlReference>();
  for (const node of nodes) {
    rememberXmlReferences([node], references);
  }
  const samples: AppleTraceSample[] = [];
  for (const row of findAllXmlNodes(nodes, (node) => node.name === 'row')) {
    const sample = readAppleTraceSample(row, nodesById, references, target);
    if (sample) samples.push(sample);
  }
  samples.sort((left, right) => left.timeNs - right.timeNs);
  return samples;
}

function readAppleTraceSample(
  row: XmlNode,
  nodesById: Map<string, XmlNode>,
  references: Map<string, XmlReference>,
  target: { targetProcesses: string[]; targetPids: number[] },
): AppleTraceSample | undefined {
  const timeNs = resolveXmlNumber(
    row.children.find((node) => node.name === 'sample-time' || node.name === 'time'),
    references,
  );
  const weightNs = resolveXmlNumber(
    row.children.find((node) => node.name === 'weight'),
    references,
  );
  if (timeNs === null || weightNs === null || weightNs <= 0) return undefined;
  const threadCell = resolveXmlReference(
    row.children.find((node) => node.name === 'thread'),
    nodesById,
  );
  const processCell = resolveXmlReference(
    threadCell?.children.find((node) => node.name === 'process'),
    nodesById,
  );
  if (!processCell) return undefined;
  const pid = readAppleProcessPid(processCell, nodesById);
  if (!matchesAppleTraceTarget(processCell.attributes.fmt ?? '', pid, target)) return undefined;
  const stack = resolveXmlReference(
    row.children.find((node) => node.name === 'backtrace' || node.name === 'tagged-backtrace'),
    nodesById,
  );
  const frame = stack
    ? resolveXmlReference(
        stack.children.find((node) => node.name === 'frame'),
        nodesById,
      )
    : undefined;
  const binary = frame
    ? resolveXmlReference(
        frame.children.find((node) => node.name === 'binary'),
        nodesById,
      )
    : undefined;
  const state = resolveXmlReference(
    row.children.find((node) => node.name === 'thread-state'),
    nodesById,
  );
  const threadFmt = threadCell?.attributes.fmt ?? '';
  const threadId = threadCell?.attributes.id ?? threadCell?.attributes.ref ?? threadFmt;
  return {
    timeNs,
    weightNs,
    threadId,
    threadName: appleThreadLabel(threadFmt),
    isMainThread: isAppleMainThread(threadFmt),
    running: (state?.text ?? state?.attributes.fmt ?? '').trim().toLowerCase() === 'running',
    symbol: frame?.attributes.name?.trim() || '<unknown>',
    binary: binary?.attributes.name?.trim() || undefined,
  };
}

// Instruments labels the main thread "Main Thread" (or the com.apple.main-thread
// queue) in the thread cell fmt. The tid is not the pid on Darwin, so the label is
// the identification.
function isAppleMainThread(threadFmt: string): boolean {
  return /^(main thread|com\.apple\.main-thread)/i.test(threadFmt.trim());
}

function readAppleProcessPid(processCell: XmlNode, nodesById: Map<string, XmlNode>): number {
  const pidCell = resolveXmlReference(
    processCell.children.find((node) => node.name === 'pid'),
    nodesById,
  );
  return Number(
    pidCell?.text ?? processCell.attributes.fmt?.match(/\((\d+)\)$/)?.[1] ?? Number.NaN,
  );
}

export function matchesAppleTraceTarget(
  processFmt: string,
  pid: number,
  target: { targetProcesses: string[]; targetPids: number[] },
): boolean {
  if (target.targetPids.length > 0 && target.targetPids.includes(pid)) return true;
  const processName = processFmt.replace(/\s*\(\d+\)\s*$/, '').trim();
  if (processName.length === 0) return false;
  return target.targetProcesses.some(
    (candidate) =>
      processName === candidate ||
      processName.endsWith(`.${candidate}`) ||
      (candidate.includes('.') && processName === candidate.split('.').pop()),
  );
}

function appleThreadLabel(threadFmt: string): string {
  const match = threadFmt.match(/^(.*?)\s+\(0x[0-9a-fA-F]+\)\s/);
  return (match?.[1] ?? threadFmt).trim() || '<unknown>';
}

function topWeightedSymbol(weights: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestWeight = 0;
  for (const [symbol, weight] of weights) {
    if (weight > bestWeight) {
      best = symbol;
      bestWeight = weight;
    }
  }
  return best;
}

type DerivedAppleHangRun = {
  threadId: string;
  threadName: string;
  startNs: number;
  endNs: number;
  runningNs: number;
  blockedNs: number;
  /** End of the time already attributed to this run; keeps overlapping sample weights from double-counting. */
  coveredNs: number;
  /** Running weight per symbol, accumulated only from the samples that formed this run. */
  symbolWeightsNs: Map<string, number>;
};

// Merges contiguous main-thread samples into frozen windows. Contiguity uses each
// sample's own weight as the sampling period, so sparse traces bridge and idle or
// sleep gaps (where the main thread has no on-CPU samples) stay split. The running
// and blocked split and the top symbol accumulate per run from exactly the samples
// that formed it, counting only each sample's uncovered exposure, so a hang never
// claims neighbouring work and its running+blocked total never exceeds its span.
function deriveAppleHangsFromSamples(samples: AppleTraceSample[]): AppleTraceHang[] {
  const main = samples.filter((sample) => sample.isMainThread);
  if (main.length === 0) return [];
  const runs: DerivedAppleHangRun[] = [];
  for (const sample of main) {
    const gapNs = sample.weightNs * 4;
    const previous = runs.at(-1);
    if (
      previous &&
      previous.threadId === sample.threadId &&
      sample.timeNs - previous.endNs <= gapNs
    ) {
      // Sample ends must never move the run end backwards; a non-monotonic sample
      // keeps running+blocked inside the run duration.
      previous.endNs = Math.max(previous.endNs, sample.timeNs + sample.weightNs);
    } else {
      runs.push({
        threadId: sample.threadId,
        threadName: sample.threadName,
        startNs: sample.timeNs,
        endNs: sample.timeNs + sample.weightNs,
        runningNs: 0,
        blockedNs: 0,
        coveredNs: sample.timeNs,
        symbolWeightsNs: new Map(),
      });
    }
    const run = runs.at(-1)!;
    const sampleEndNs = sample.timeNs + sample.weightNs;
    const exposureNs = Math.max(0, sampleEndNs - run.coveredNs);
    run.coveredNs = Math.max(run.coveredNs, sampleEndNs);
    if (sample.running) {
      run.runningNs += exposureNs;
      run.symbolWeightsNs.set(
        sample.symbol,
        (run.symbolWeightsNs.get(sample.symbol) ?? 0) + exposureNs,
      );
    } else {
      run.blockedNs += exposureNs;
    }
  }
  return runs
    .filter((run) => run.endNs - run.startNs >= APPLE_HANG_THRESHOLD_MS * 1_000_000)
    .map((run) => {
      const cause: PerfHangCause = {
        runningMs: roundMs(run.runningNs / 1_000_000),
        blockedMs: roundMs(run.blockedNs / 1_000_000),
        topSymbol: topWeightedSymbol(run.symbolWeightsNs),
        threadName: run.threadName,
      };
      return {
        startOffsetMs: roundMs(run.startNs / 1_000_000),
        durationMs: roundMs((run.endNs - run.startNs) / 1_000_000),
        thread: run.threadName,
        topSymbol: cause.topSymbol,
        runningMs: cause.runningMs,
        blockedMs: cause.blockedMs,
        source: 'time-profile' as const,
        nextSteps: perfHangNextSteps(cause),
      };
    })
    .sort((left, right) => right.durationMs - left.durationMs);
}

function analyzeAppleHitches(
  xml: string | undefined,
  target: AppleTraceAnalysisTarget,
): PerfTraceHitches | undefined {
  if (!xml) return undefined;
  // The hitches table also carries other processes' rows; only the attached app's
  // rows count. parseAppleHitchRows drops system rows and resolves the cells;
  // matchesAppleTraceTarget accepts pid, exact process name, and bundle-id shaped
  // targets, so it covers every row the perf-frame pid-or-name filter accepts.
  const rows = parseAppleHitchRows(xml).filter((row) =>
    matchesAppleTraceTarget(row.processName ?? '', row.pid ?? Number.NaN, target),
  );
  let maxDurationMs: number | undefined;
  for (const row of rows) {
    maxDurationMs = Math.max(maxDurationMs ?? 0, roundMs(row.durationNs / 1_000_000));
  }
  return {
    available: true,
    count: rows.length,
    maxDurationMs: rows.length > 0 ? maxDurationMs : undefined,
    nextSteps: rows.length > 0 ? perfHitchNextSteps() : [],
  };
}

function rankAppleHotspots(samples: AppleTraceSample[]): AppleTraceHotspot[] {
  const weights = new Map<string, { symbol: string; binary?: string; weightNs: number }>();
  for (const sample of samples) {
    const key = `${sample.binary ?? ''}\u0000${sample.symbol}`;
    const previous = weights.get(key);
    weights.set(key, {
      symbol: sample.symbol,
      binary: sample.binary,
      weightNs: (previous?.weightNs ?? 0) + sample.weightNs,
    });
  }
  return [...weights.values()]
    .sort(
      (left, right) => right.weightNs - left.weightNs || left.symbol.localeCompare(right.symbol),
    )
    .map(({ symbol, binary, weightNs }) => ({
      symbol,
      binary,
      selfSampleMs: roundMs(weightNs / 1_000_000),
    }));
}

function buildAppleTraceNotes(
  derivedHangCount: number,
  hangRisksXml: string | undefined,
): string[] {
  const notes: string[] = [];
  if (derivedHangCount > 0) {
    notes.push(
      'hangs were derived from contiguous Time Profiler samples on the main thread; Instruments does not fill potential-hangs on simulated devices.',
    );
  }
  if (hangRisksXml && countAppleRows(hangRisksXml) > 0) {
    notes.push(
      'hang-risks rows are advisory; the derived main-thread hangs are the primary evidence.',
    );
  }
  return notes;
}

function countAppleRows(xml: string): number {
  return findAllXmlNodes(parseXmlDocumentSync(xml), (node) => node.name === 'row').length;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}
