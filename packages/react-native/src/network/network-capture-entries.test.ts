import { test } from 'vitest';
import assert from 'node:assert/strict';
import { captureBufferNotes, projectCapturedNetworkEntries } from './network-capture-entries.ts';

const PAYLOAD_BUDGET = 64;

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-10-24T09:00:00.000Z',
    method: 'GET',
    url: 'https://api.test/v1/orders',
    status: 200,
    durationMs: 42,
    transport: 'cdp',
    ...overrides,
  };
}

test('a summary dump carries the request identity and the transport it ran on', () => {
  const [projected] = projectCapturedNetworkEntries([entry()], 'summary', PAYLOAD_BUDGET);
  assert.deepEqual(projected, {
    timestamp: '2026-10-24T09:00:00.000Z',
    method: 'GET',
    url: 'https://api.test/v1/orders',
    status: 200,
    durationMs: 42,
    metadata: { transport: 'cdp' },
  });
});

test('the newest capture leads the dump, so a caller reads what just happened first', () => {
  const projected = projectCapturedNetworkEntries(
    [
      entry({ url: 'https://api.test/first' }),
      entry({ url: 'https://api.test/second' }),
      entry({ url: 'https://api.test/third' }),
    ],
    'summary',
    PAYLOAD_BUDGET,
  );
  assert.deepEqual(
    projected.map((value) => value.url),
    ['https://api.test/third', 'https://api.test/second', 'https://api.test/first'],
  );
});

test('a URL is the one field a capture may not lose, so an entry without it is the only thing dropped', () => {
  const projected = projectCapturedNetworkEntries(
    [entry(), entry({ url: undefined }), entry({ url: '' }), 'nope', null],
    'summary',
    PAYLOAD_BUDGET,
  );
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.url, 'https://api.test/v1/orders');
});

test('headers ride along only when asked for, and a secret header name never leaves its value behind', () => {
  const captured = [
    entry({
      requestHeaders: {
        Accept: 'application/json',
        Authorization: 'Bearer sk-secret-value',
        'X-Capture-Header': 'plain',
      },
      responseHeaders: { 'Set-Cookie': 'session=abc123' },
    }),
  ];

  const quiet = projectCapturedNetworkEntries(captured, 'summary', PAYLOAD_BUDGET);
  assert.equal(quiet[0]?.requestHeaders, undefined);
  assert.equal(quiet[0]?.responseHeaders, undefined);

  const loud = projectCapturedNetworkEntries(captured, 'headers', PAYLOAD_BUDGET);
  assert.deepEqual(loud[0]?.requestHeaders, {
    Accept: 'application/json',
    Authorization: '[REDACTED]',
    'X-Capture-Header': 'plain',
  });
  assert.deepEqual(loud[0]?.responseHeaders, { 'Set-Cookie': '[REDACTED]' });
});

test('bodies are opt-in, redacted by the shared secret rules, and bounded to the capture budget', () => {
  const captured = [
    entry({
      requestBody: '{"apiKey":"sk-live-123","note":"order 7"}',
      responseBody: `tail:${'x'.repeat(200)}`,
    }),
  ];

  assert.equal(
    projectCapturedNetworkEntries(captured, 'headers', PAYLOAD_BUDGET)[0]?.responseBody,
    undefined,
  );

  const [projected] = projectCapturedNetworkEntries(captured, 'all', PAYLOAD_BUDGET);
  assert.equal(projected?.requestBody, '{"apiKey":"[REDACTED]","note":"order 7"}');
  assert.ok(projected?.responseBody);
  assert.ok(projected.responseBody.endsWith('...<truncated>'));
  assert.ok(projected.responseBody.length <= PAYLOAD_BUDGET);
});

test('a failed request is reported with the reason the runtime gave, not as a silent gap', () => {
  const [projected] = projectCapturedNetworkEntries(
    [entry({ status: undefined, error: 'net::ERR_CONNECTION_REFUSED' })],
    'summary',
    PAYLOAD_BUDGET,
  );
  assert.equal(projected?.status, undefined);
  assert.deepEqual(projected?.metadata, {
    transport: 'cdp',
    error: 'net::ERR_CONNECTION_REFUSED',
  });
});

test('a field the runtime misreports is left out instead of poisoning the entry', () => {
  const [projected] = projectCapturedNetworkEntries(
    [entry({ status: '200', durationMs: null, method: 7, requestHeaders: ['not', 'headers'] })],
    'all',
    PAYLOAD_BUDGET,
  );
  assert.equal(projected?.status, undefined);
  assert.equal(projected?.durationMs, undefined);
  assert.equal(projected?.method, undefined);
  assert.equal(projected?.requestHeaders, undefined);
});

test('the accounting a buffer keeps is reported as what a caller can still do', () => {
  assert.deepEqual(captureBufferNotes({ buffered: 3, dropped: 0 }), [
    '3 older captured requests remain buffered; dump again or raise the limit.',
  ]);
  assert.deepEqual(captureBufferNotes({ buffered: 1, dropped: 1 }), [
    '1 older captured request remains buffered; dump again or raise the limit.',
    '1 captured request was evicted from the 200-entry capture buffer before this dump.',
  ]);
  assert.deepEqual(captureBufferNotes({ buffered: 0, dropped: 0 }), []);
  assert.deepEqual(captureBufferNotes({ buffered: undefined, dropped: 0 }), []);
});
