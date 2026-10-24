import type { MetroInspectorTarget } from '../react-devtools/metro-inspector.ts';
import { asRecord, readHeaders, readNumber, readString } from './network-capture-json.ts';

/** One request the CDP `Network` domain reported, merged from its events. */
export type CapturedCdpRequest = Readonly<{
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
  transport: 'cdp';
}>;

type InflightRequest = {
  requestId: string;
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
  transport: 'cdp';
};

/**
 * Accumulates the id-less `Network.*` notifications one app runtime sends after `Network.enable`,
 * keyed by CDP request id, and hands over one entry per finished request.
 *
 * The events of one request can arrive interleaved with other requests, so nothing is emitted until
 * `Network.loadingFinished` or `Network.loadingFailed` names it complete. A duration is the
 * difference of two CDP `timestamp` values from one connection, which that runtime reports on a
 * monotonic clock; the wall-clock stamp an entry carries is the host clock at receipt, so an entry
 * stays comparable with the rest of a session's evidence.
 *
 * A Hermes runtime re-reports a completed request — the same `requestId` with the same event
 * sequence can arrive more than once on one connection. A completed id is therefore remembered:
 * its events never produce a second entry. The memory is per connection, because a re-armed
 * connection starts a fresh id space and may reuse a number for a genuinely new request.
 */
export class CdpNetworkBuffer {
  readonly #limit: number;
  #inflight = new Map<string, InflightRequest>();
  #startedAt = new Map<string, number>();
  #finished: InflightRequest[] = [];
  #completed: string[] = [];
  #completedIds = new Set<string>();
  #dropped = 0;
  #failedBodyReads = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Feeds one CDP notification. Unrelated methods are ignored, not errors. */
  add(event: { method: string; params: Record<string, unknown> }): void {
    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.#onRequest(event.params);
        return;
      case 'Network.responseReceived':
        this.#onResponse(event.params);
        return;
      case 'Network.loadingFinished':
        this.#onFinished(event.params);
        return;
      case 'Network.loadingFailed':
        this.#onFailed(event.params);
        return;
    }
  }

  /**
   * Removes and returns the newest `limit` finished entries, oldest first, along with the eviction
   * count for the same window. Like the app-side buffer, an entry is handed over once.
   */
  drain(limit: number): { entries: CapturedCdpRequest[]; dropped: number } {
    const count = Math.max(0, Math.min(limit, this.#finished.length));
    const drained = this.#finished.splice(this.#finished.length - count, count);
    const dropped = this.#dropped;
    this.#dropped = 0;
    return { entries: drained, dropped };
  }

  buffered(): number {
    return this.#finished.length;
  }

  /** Counts a response body that could not be read, so a dump can say what it omitted. */
  recordFailedBodyRead(): void {
    this.#failedBodyReads += 1;
  }

  takeFailedBodyReads(): number {
    const count = this.#failedBodyReads;
    this.#failedBodyReads = 0;
    return count;
  }

  #onRequest(params: Record<string, unknown>): void {
    const requestId = readString(params.requestId);
    if (requestId === undefined || this.#completedIds.has(requestId)) return;
    const request = asRecord(params.request);
    this.#inflight.set(requestId, {
      requestId,
      timestamp: new Date().toISOString(),
      method: (readString(request?.method) ?? 'GET').toUpperCase(),
      url: readString(request?.url) ?? '',
      requestHeaders: readHeaders(request?.headers),
      transport: 'cdp',
    });
    const startedAt = readTimestamp(params.timestamp);
    if (startedAt !== undefined) this.#startedAt.set(requestId, startedAt);
  }

  #onResponse(params: Record<string, unknown>): void {
    const entry = this.#inflight.get(readString(params.requestId) ?? '');
    if (!entry) return;
    const response = asRecord(params.response);
    entry.status = readNumber(response?.status);
    entry.responseHeaders = readHeaders(response?.headers);
  }

  #onFinished(params: Record<string, unknown>): void {
    this.#settle(params, undefined);
  }

  #onFailed(params: Record<string, unknown>): void {
    this.#settle(params, readString(params.errorText) ?? 'Request failed');
  }

  /** Ends one in-flight request: finished or failed, its entry leaves the map and joins the buffer. */
  #settle(params: Record<string, unknown>, error: string | undefined): void {
    const requestId = readString(params.requestId) ?? '';
    const entry = this.#inflight.get(requestId);
    if (!entry) return;
    this.#inflight.delete(requestId);
    if (error !== undefined) entry.error = error;
    entry.durationMs = this.#durationMs(requestId, params.timestamp);
    this.#push(entry);
    this.#rememberCompleted(requestId);
  }

  /** Keeps the completed ids of one connection, bounded to what the buffer itself can hold. */
  #rememberCompleted(requestId: string): void {
    this.#completedIds.add(requestId);
    this.#completed.push(requestId);
    while (this.#completed.length > this.#limit) {
      const oldest = this.#completed.shift();
      if (oldest !== undefined) this.#completedIds.delete(oldest);
    }
  }

  /**
   * Called when the debugger connection is opened anew: request ids belong to a connection, so
   * neither an id left in flight on a dead connection nor a completed id from an older one may
   * hold back a request the new connection reports.
   */
  reopened(): void {
    this.#inflight.clear();
    this.#startedAt.clear();
    this.#completedIds.clear();
    this.#completed = [];
  }

  #durationMs(requestId: string, finishedAt: unknown): number | undefined {
    const startedAt = this.#startedAt.get(requestId);
    this.#startedAt.delete(requestId);
    const end = readTimestamp(finishedAt);
    if (startedAt === undefined || end === undefined) return undefined;
    const seconds = end - startedAt;
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }

  #push(entry: InflightRequest): void {
    this.#finished.push(entry);
    if (this.#finished.length > this.#limit) {
      const evicted = this.#finished.length - this.#limit;
      this.#dropped += evicted;
      this.#finished.splice(0, evicted);
    }
  }
}

/**
 * Answers whether the runtime's CDP implementation refused a method, which is how a React Native
 * runtime older than the `Network` domain reports itself. Only the protocol's own refusal counts.
 */
export function cdpMethodUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /was not found|not supported|unhandled method|method not found/i.test(message);
}

/** The identity a capture holds on: the same target of the same device, or the capture is over. */
export function bindingMatchesTarget(
  binding: Readonly<{ logicalDeviceId: string; targetId: string }>,
  target: MetroInspectorTarget,
): boolean {
  return (
    target.id === binding.targetId &&
    (target.reactNative?.logicalDeviceId ?? logicalDeviceFromTargetId(target.id)) ===
      binding.logicalDeviceId
  );
}

/** Hermes page ids are `<logicalDeviceId>-<page>`; older dev servers omit the metadata field. */
export function logicalDeviceFromTargetId(id: string): string {
  const separator = id.lastIndexOf('-');
  return separator > 0 ? id.slice(0, separator) : id;
}

/** CDP `timestamp` is monotonic seconds since an origin the app runtime chose. */
function readTimestamp(value: unknown): number | undefined {
  return readNumber(value);
}
