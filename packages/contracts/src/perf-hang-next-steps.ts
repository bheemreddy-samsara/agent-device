/** One main-thread freeze window attributed from a native trace. */
export type PerfHang = Readonly<{
  /** Offset from trace start in milliseconds. */
  startOffsetMs: number;
  durationMs: number;
  thread: string;
  /** Innermost sampled symbol with the most running weight inside the window. */
  topSymbol?: string;
  runningMs: number;
  blockedMs: number;
  source: string;
  nextSteps: string[];
}>;

export type PerfHangCause = Readonly<{
  runningMs: number;
  blockedMs: number;
  topSymbol?: string;
  threadName?: string;
}>;

/**
 * Static rule table for one classified hang. Returns agent-actionable next steps
 * from the hang cause only; it never parses free-form tool output.
 */
export function perfHangNextSteps(cause: PerfHangCause): string[] {
  if (cause.runningMs >= cause.blockedMs) {
    return cause.topSymbol
      ? [
          `Inspect ${cause.topSymbol} on the main thread; it holds the most samples in this window.`,
          'Run perf cpu profile around the interaction for a symbol-level breakdown.',
        ]
      : ['Run perf cpu profile around the interaction to attribute CPU work inside this window.'];
  }
  return [
    'The main thread is blocked, not running; move the waiting work (I/O, binder, lock) off the main thread.',
  ];
}

/**
 * Static rule for hitch evidence without a CPU hotspot.
 */
export function perfHitchNextSteps(): string[] {
  return [
    'Frame hitches have no matching CPU hotspot; check layout cost and overdraw, then open the trace in Instruments or the Perfetto UI.',
  ];
}

/** A symbol ranked by accumulated on-CPU self-sample weight. */
export type PerfTraceHotspot = Readonly<{
  symbol: string;
  binary?: string;
  selfSampleMs: number;
}>;

/** Hitch tally for the attached app only. */
export type PerfTraceHitches = Readonly<{
  available: boolean;
  count: number;
  maxDurationMs?: number;
  nextSteps: string[];
}>;

/**
 * Shared unavailable half of a trace-analysis stop summary. Each platform names
 * its own typed reasons; the envelope stays one shape for CLI and clients.
 */
export type PerfTraceAnalysisUnavailable<Reason extends string> = Readonly<{
  available: false;
  reason: Reason;
  message: string;
  hint: string;
}>;

/**
 * Shared trace-analysis envelope attached to a native `perf trace stop` result
 * `summary` on every platform: either interpreted evidence or a typed failure.
 */
export type PerfTraceAnalysis<Hang, Hotspot, UnavailableReason extends string> =
  | Readonly<{
      available: true;
      tracePath: string;
      hangs: Hang[];
      hangCount: number;
      hitches?: PerfTraceHitches;
      hotspots: Hotspot[];
      notes: string[];
    }>
  | PerfTraceAnalysisUnavailable<UnavailableReason>;
