import type { MetroInspectorTarget } from '../react-devtools/metro-inspector.ts';

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
 */
export class CdpNetworkBuffer {
  readonly #limit: number;
  #inflight = new Map<string, InflightRequest>();
  #startedAt = new Map<string, number>();
  #finished: InflightRequest[] = [];
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
    if (requestId === undefined) return;
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
    const requestId = readString(params.requestId) ?? '';
    const entry = this.#inflight.get(requestId);
    if (!entry) return;
    this.#inflight.delete(requestId);
    entry.durationMs = this.#durationMs(requestId, params.timestamp);
    this.#push(entry);
  }

  #onFailed(params: Record<string, unknown>): void {
    const requestId = readString(params.requestId) ?? '';
    const entry = this.#inflight.get(requestId);
    if (!entry) return;
    this.#inflight.delete(requestId);
    entry.error = readString(params.errorText) ?? 'Request failed';
    entry.durationMs = this.#durationMs(requestId, params.timestamp);
    this.#push(entry);
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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readHeaders(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (typeof entry === 'string') headers[name] = entry;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
