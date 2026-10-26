import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindingMatchesTarget,
  cdpMethodUnsupported,
  CdpNetworkBuffer,
  logicalDeviceFromTargetId,
  type CapturedCdpRequest,
} from './cdp-network-buffer.ts';
import type { MetroInspectorTarget } from '../react-devtools/metro-inspector.ts';

function requestWillBeSent(
  requestId: string,
  url: string,
  timestamp: number,
  extra: Record<string, unknown> = {},
) {
  return {
    method: 'Network.requestWillBeSent',
    params: {
      requestId,
      timestamp,
      request: { url, method: 'GET', headers: { Accept: 'application/json' }, ...extra },
    },
  };
}

function responseReceived(requestId: string, status: number, timestamp = 0) {
  return {
    method: 'Network.responseReceived',
    params: {
      requestId,
      timestamp,
      response: { status, headers: { 'content-type': 'application/json' } },
    },
  };
}

function loadingFinished(requestId: string, timestamp: number) {
  return { method: 'Network.loadingFinished', params: { requestId, timestamp } };
}

function finishedEntries(buffer: CdpNetworkBuffer, limit = 25): CapturedCdpRequest[] {
  const drained = buffer.take(limit);
  buffer.delivered();
  return drained.entries;
}

test('a request is held until its own loading event names it complete', () => {
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 100));
  buffer.add(responseReceived('r1', 200));

  assert.equal(buffer.buffered(), 0, 'an inflight request is not reportable yet');
  buffer.add(loadingFinished('r1', 100.5));

  const [entry] = finishedEntries(buffer);
  assert.ok(entry);
  assert.equal(entry.url, 'https://api.test/a');
  assert.equal(entry.status, 200);
  assert.equal(entry.durationMs, 500);
  assert.equal(entry.transport, 'cdp');
});

test('interleaved requests are matched by request id and answered with their own response', () => {
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/one', 10));
  buffer.add(requestWillBeSent('r2', 'https://api.test/two', 11));
  buffer.add(responseReceived('r2', 500));
  buffer.add(responseReceived('r1', 204));
  buffer.add(loadingFinished('r1', 12));
  buffer.add(loadingFinished('r2', 13));

  const entries = finishedEntries(buffer);
  assert.deepEqual(
    entries.map((entry) => [entry.url, entry.status, entry.durationMs]),
    [
      ['https://api.test/one', 204, 2000],
      ['https://api.test/two', 500, 2000],
    ],
  );
});

test('a failed load lands as an error entry with the reason the runtime gave', () => {
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/gone', 5));
  buffer.add({
    method: 'Network.loadingFailed',
    params: { requestId: 'r1', timestamp: 5.25, errorText: 'net::ERR_NAME_NOT_RESOLVED' },
  });

  const [entry] = finishedEntries(buffer);
  assert.ok(entry);
  assert.equal(entry.error, 'net::ERR_NAME_NOT_RESOLVED');
  assert.equal(entry.status, undefined);
  assert.equal(entry.durationMs, 250);
});

test('headers are kept as the runtime reported them and absent when it sent none', () => {
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 1));
  buffer.add({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r2', timestamp: 1, request: { url: 'https://api.test/b' } },
  });
  buffer.add(loadingFinished('r1', 1));
  buffer.add(loadingFinished('r2', 1));

  const [withHeaders, withoutHeaders] = finishedEntries(buffer);
  assert.deepEqual(withHeaders?.requestHeaders, { Accept: 'application/json' });
  assert.equal(withoutHeaders?.requestHeaders, undefined);
});

test('a request re-emitted under a completed id does not duplicate until the connection reopens', () => {
  // Hermes re-sends requests it already completed when a new debugger client attaches, under the
  // same request id. The buffer ignores that until the holder reopens the connection.
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 100));
  buffer.add(loadingFinished('r1', 100.25));
  assert.equal(finishedEntries(buffer).length, 1);

  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 200));
  buffer.add(loadingFinished('r1', 200.25));
  assert.equal(finishedEntries(buffer).length, 0, 'a re-emitted completed id must not replay');

  buffer.reopened();
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 300));
  buffer.add(loadingFinished('r1', 300.25));
  assert.equal(finishedEntries(buffer).length, 1, 'a new connection settles the reused id');
});

test('a drain hands each entry over once and reports only its own eviction window', () => {
  const buffer = new CdpNetworkBuffer(2);
  for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
    buffer.add(requestWillBeSent(id, `https://api.test/${index}`, index));
    buffer.add(loadingFinished(id, index));
  }

  const first = buffer.take(25);
  buffer.delivered();
  assert.deepEqual(
    first.entries.map((entry) => entry.url),
    ['https://api.test/1', 'https://api.test/2'],
  );
  assert.equal(first.dropped, 1, 'the oldest request left the ring buffer');

  const second = buffer.take(25);
  buffer.delivered();
  assert.deepEqual(second.entries, []);
  assert.equal(second.dropped, 0, 'a window nobody wrote to drops nothing');
});

test('an undelivered drain is re-offered rather than lost', () => {
  const buffer = new CdpNetworkBuffer(10);
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 1));
  buffer.add(loadingFinished('r1', 1.25));

  const lost = buffer.take(25);
  buffer.reattach(lost.entries);

  const retried = buffer.take(25);
  assert.equal(retried.entries.length, 1, 'the window the reader never got is reportable again');
  assert.equal(retried.dropped, 0);
});

test("evictions after a drain's snapshot survive its delivery instead of being zeroed", () => {
  // A body read keeps one drain open across arrivals. The count a delivered reply spent covers its
  // own window only; what the ring buffer gave up while the reply was in flight belongs to the next.
  const buffer = new CdpNetworkBuffer(2);
  for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
    buffer.add(requestWillBeSent(id, `https://api.test/${index}`, index));
    buffer.add(loadingFinished(id, index));
  }

  const first = buffer.take(25);
  assert.equal(first.dropped, 1);
  for (const [index, id] of ['r4', 'r5', 'r6'].entries()) {
    buffer.add(requestWillBeSent(id, `https://api.test/${index}`, index));
    buffer.add(loadingFinished(id, index));
  }
  buffer.delivered();

  const second = buffer.take(25);
  assert.equal(
    second.dropped,
    1,
    'the request lost while the first reply was in flight is still owed a report',
  );
  buffer.delivered();
  assert.equal(buffer.take(25).dropped, 0, 'and it is reported once');
});

test('an undelivered drain reports its eviction count once, not twice', () => {
  const buffer = new CdpNetworkBuffer(2);
  for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
    buffer.add(requestWillBeSent(id, `https://api.test/${index}`, index));
    buffer.add(loadingFinished(id, index));
  }

  const lost = buffer.take(25);
  assert.equal(lost.dropped, 1);
  buffer.reattach(lost.entries);

  const retried = buffer.take(25);
  assert.equal(retried.dropped, 1, 'the count the reply never carried is still owed');
  buffer.delivered();
  assert.equal(buffer.take(25).dropped, 0);
});

test('a drain takes the newest entries and keeps them oldest first', () => {
  const buffer = new CdpNetworkBuffer(10);
  for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
    buffer.add(requestWillBeSent(id, `https://api.test/${index}`, index));
    buffer.add(loadingFinished(id, index));
  }

  assert.deepEqual(
    finishedEntries(buffer, 2).map((entry) => entry.url),
    ['https://api.test/1', 'https://api.test/2'],
  );
});

test('events for a request the buffer never saw cannot invent an entry', () => {
  const buffer = new CdpNetworkBuffer(5);
  buffer.add(responseReceived('unknown', 200));
  buffer.add(loadingFinished('unknown', 1));
  buffer.add({ method: 'Network.webSocketCreated', params: { requestId: 'x' } });

  assert.equal(buffer.buffered(), 0);
});

test('a duration is never reported from an origin the runtime changed mid-request', () => {
  const buffer = new CdpNetworkBuffer(5);
  buffer.add(requestWillBeSent('r1', 'https://api.test/a', 10));
  buffer.add(loadingFinished('r1', 9));
  assert.equal(finishedEntries(buffer)[0]?.durationMs, undefined);

  buffer.add(requestWillBeSent('r2', 'https://api.test/b', 10));
  buffer.add({ method: 'Network.loadingFinished', params: { requestId: 'r2', timestamp: '9' } });
  assert.equal(finishedEntries(buffer)[0]?.durationMs, undefined);
});

test('only the protocol method-not-found code falls back to the JavaScript hook', () => {
  const refusal = (code: number | undefined, message: string) =>
    new AppError('COMMAND_FAILED', `Debugger protocol error: ${message}`, { protocolCode: code });

  assert.equal(cdpMethodUnsupported(refusal(-32601, "'Network.enable' was not found")), true);
  assert.equal(cdpMethodUnsupported(refusal(-32601, 'whatever the runtime wording is')), true);
  assert.equal(cdpMethodUnsupported(refusal(-32603, 'Method not supported')), false);
  assert.equal(cdpMethodUnsupported(refusal(undefined, 'unhandled method')), false);
  assert.equal(cdpMethodUnsupported(new Error('socket hang up')), false);
});

function target(id: string, extra: Partial<MetroInspectorTarget> = {}): MetroInspectorTarget {
  return {
    id,
    title: 'React Native',
    webSocketDebuggerUrl: `ws://127.0.0.1:8081/inspector/debug?page=${id}`,
    reactNative: { logicalDeviceId: id.slice(0, id.lastIndexOf('-')) },
    ...extra,
  };
}

test('the bound identity is one target of one device, and a reload is not it', () => {
  const binding = { logicalDeviceId: 'pixel', targetId: 'pixel-1' };
  assert.equal(bindingMatchesTarget(binding, target('pixel-1')), true);
  assert.equal(bindingMatchesTarget(binding, target('pixel-2')), false);
  assert.equal(bindingMatchesTarget(binding, target('other-1')), false);
});

test('a dev server without the metadata field still identifies the device by its page id', () => {
  const binding = { logicalDeviceId: 'pixel', targetId: 'pixel-1' };
  assert.equal(bindingMatchesTarget(binding, target('pixel-1', { reactNative: {} })), true);
  assert.equal(logicalDeviceFromTargetId('pixel-12'), 'pixel');
  assert.equal(logicalDeviceFromTargetId('flat'), 'flat');
});
