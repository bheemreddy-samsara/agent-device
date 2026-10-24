/**
 * The readers every captured entry crosses one of two boundaries to arrive: a debugger connection
 * or a capture holder's socket. What arrives is untrusted JSON, so each field is read by kind and
 * an unreadable field stays absent rather than guessed at.
 */

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readHeaders(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (typeof entry === 'string') headers[name] = entry;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
