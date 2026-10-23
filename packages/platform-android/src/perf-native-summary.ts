import type { DeviceInfo } from '@agent-device/kernel/device';
import { sampleAndroidFramePerf } from './perf-frame.ts';
import type { AndroidTraceAnalysis } from './perf-trace-processor.ts';
import type {
  AndroidNativePerfFrameHealthSummary,
  AndroidNativePerfOptions,
  AndroidNativePerfSession,
  AndroidNativePerfStopSummary,
} from './perf-native-types.ts';

export async function buildAndroidNativePerfStopSummary(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  sizeBytes: number,
  durationMs: number,
  options: AndroidNativePerfOptions,
): Promise<AndroidNativePerfStopSummary> {
  let traceAnalysis: AndroidTraceAnalysis | undefined;
  if (session.kind === 'perfetto' && session.type === 'trace') {
    // The trace analyzer and host-tool lookup load on demand so the mechanics
    // closure stays as light as the merge-base. Unexpected throws (for example a
    // missing host binding) become the typed failed reason instead of vanishing.
    traceAnalysis = await import('./perf-trace-processor.ts')
      .then(({ analyzeAndroidPerfettoTrace }) =>
        analyzeAndroidPerfettoTrace({
          tracePath: session.outPath,
          packageName: session.packageName,
        }),
      )
      .catch((error: unknown): AndroidTraceAnalysis => ({
        available: false,
        reason: 'trace-processor-failed',
        message: `Trace analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        hint: `Open ${session.outPath} in the Perfetto UI (https://ui.perfetto.dev) to inspect the raw trace.`,
      }));
  }
  // Like Apple, the trace-analysis envelope is spread onto the stop summary; the
  // frame-health capture note leads and the envelope's notes follow it.
  const frameNote =
    session.kind === 'perfetto'
      ? 'Frame health is sampled from Android gfxinfo around the trace window; open the Perfetto artifact for timeline root cause.'
      : 'Open the Simpleperf report artifact for symbol-level CPU attribution.';
  return {
    capture: {
      durationMs,
      packageName: session.packageName,
      appPid: session.appPid,
      artifactPath: session.outPath,
      sizeBytes,
    },
    frameHealth:
      session.kind === 'perfetto'
        ? await sampleAndroidNativePerfFrameHealth(device, session.packageName, options)
        : undefined,
    ...(traceAnalysis ?? {}),
    notes: [frameNote, ...(traceAnalysis?.available ? traceAnalysis.notes : [])],
  };
}

async function sampleAndroidNativePerfFrameHealth(
  device: DeviceInfo,
  packageName: string,
  options: AndroidNativePerfOptions,
): Promise<AndroidNativePerfFrameHealthSummary> {
  try {
    const sample = await sampleAndroidFramePerf(device, packageName, options);
    return {
      available: true,
      droppedFramePercent: sample.droppedFramePercent,
      droppedFrameCount: sample.droppedFrameCount,
      totalFrameCount: sample.totalFrameCount,
      method: sample.method,
      worstWindows: sample.worstWindows?.slice(0, 3).map((window) => ({
        startOffsetMs: window.startOffsetMs,
        endOffsetMs: window.endOffsetMs,
        missedDeadlineFrameCount: window.missedDeadlineFrameCount,
        worstFrameMs: window.worstFrameMs,
      })),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'Android frame health was not available',
    };
  }
}
