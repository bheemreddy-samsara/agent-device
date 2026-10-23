import type {
  NetworkDumpInput,
  NetworkProviderDumpResult,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';

/**
 * A provider source answers a dump with entries, with nothing yet to report, or not at all.
 * `unavailable` carries why: a session whose app-side capture broke mid-repro must not read as
 * an empty traffic window.
 */
export type NetworkProviderCapture =
  | Readonly<{ status: 'captured'; result: NetworkProviderDumpResult }>
  | Readonly<{ status: 'armed'; notes: readonly string[] }>
  | Readonly<{
      status: 'unavailable';
      /** The session names a provider source that could not answer; the note says why. */
      notes: readonly string[];
    }>;

// A wedged app runtime must not cost the dump more than this; the session's second capture
// source answers after it, well inside the command envelope.
const PROVIDER_CAPTURE_BUDGET_MS = 12_000;

/**
 * Reads one session's provider network source, when its transport declares one. A provider that
 * only armed its capture during this call reports `armed` with no entries, so the caller answers
 * the current window from its own source and keeps the arming note. Every provider failure stays
 * a typed `unavailable` note; this function never throws.
 */
export async function captureNetworkProviderTraffic(
  host: Pick<PlatformRuntimeHost, 'networkTransports'>,
  device: DeviceInfo,
  input: NetworkDumpInput,
  signal: AbortSignal,
): Promise<NetworkProviderCapture> {
  const scope: NetworkTransportScope = {
    sessionId: input.sessionId,
    ...(input.stateDir === undefined ? {} : { stateDir: input.stateDir }),
    ...(input.appBundleId === undefined ? {} : { appBundleId: input.appBundleId }),
    maxPayloadChars: input.maxPayloadChars,
  };
  let transport;
  try {
    transport = await host.networkTransports.resolve(device, scope);
  } catch (error) {
    return { status: 'unavailable', notes: [providerFailureNote(error)] };
  }
  const dump = transport.dump;
  if (!dump) return { status: 'unavailable', notes: [] };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_CAPTURE_BUDGET_MS)]);
  let result;
  try {
    // Racing the budget signal bounds the whole provider read: the transport's own steps can
    // each carry longer internal timeouts, and an unbounded provider would push the dump past
    // the command envelope while its work keeps running after capture-kit moved on.
    result = await Promise.race([
      dump({ maxEntries: input.maxEntries, include: input.include }, bounded),
      abortRejection(bounded, input.sessionId),
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'unavailable', notes: [providerFailureNote(error)] };
  }
  if (result.armed && result.entries.length === 0) {
    return { status: 'armed', notes: result.notes ?? [] };
  }
  return { status: 'captured', result };
}

function abortRejection(signal: AbortSignal, sessionId: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`The in-app network capture exceeded its budget for session ${sessionId}.`));
      return;
    }
    signal.addEventListener(
      'abort',
      () =>
        reject(
          new Error(`The in-app network capture exceeded its budget for session ${sessionId}.`),
        ),
      { once: true },
    );
  });
}

function providerFailureNote(error: unknown): string {
  // The message can carry text from a local dev server or the app runtime, so it passes through
  // the diagnostic redaction owner before it reaches a response note.
  const { message } = redactDiagnosticData({
    message: error instanceof Error ? error.message : String(error),
  });
  return `In-app network capture could not answer this dump: ${message} This dump reads the session app log instead.`;
}
