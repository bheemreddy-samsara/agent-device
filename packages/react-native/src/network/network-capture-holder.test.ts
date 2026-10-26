import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import fs from 'node:fs';
import { writeMetroSessionHints } from '../metro/metro-session-hints.ts';
import { startMetroNetworkCapture, dumpMetroNetworkCapture } from './network-capture.ts';
import {
  NetworkCaptureHolder,
  serveNetworkCaptureHolder,
} from './network-capture-holder-process.ts';
import {
  networkCaptureSocketPath,
  readNetworkCaptureHolderStatus,
  readNetworkCaptureState,
  type NetworkCaptureScope,
} from './network-capture-state.ts';
import {
  cdpRequestEvents,
  startMetroCdpHarness,
  type HarnessTarget,
  type MetroCdpHarness,
} from './metro-cdp-harness.fixtures.ts';

const APP_ID = 'com.example.app';
const PIXEL: HarnessTarget = {
  id: 'pixel-1',
  appId: APP_ID,
  deviceName: 'Pixel 9',
  logicalDeviceId: 'pixel',
};

const openHarnesses: MetroCdpHarness[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openHarnesses.length > 0) await openHarnesses.pop()?.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('a holder follows the one JavaScript reload its runtime performs and says so once', async () => {
  const { server, scope, stop } = await armedHolderSession([PIXEL]);
  try {
    emitRequest(server, 'r1', 'https://api.test/before');
    const before = await dump(scope);
    assert.deepEqual(
      before.entries.map((entry) => entry.url),
      ['https://api.test/before'],
    );

    // What a reload does to the dev server's view: the socket ends, and the same app on the same
    // device registers a new target id.
    server.dropInspectorConnections();
    server.removeTarget('pixel-1');
    server.addTarget({ ...PIXEL, id: 'pixel-2' });

    const after = await dump(scope);
    assert.deepEqual(after.entries, [], 'the buffer died with the runtime that held it');
    assert.match(
      after.notes?.find((note) => note.includes('reloaded')) ?? '',
      /re-armed on its replacement target; requests made before the reload are not in this dump/,
    );
    assert.equal(readNetworkCaptureHolderStatus(scope)?.targetId, 'pixel-2');
    assert.equal(typeof readNetworkCaptureHolderStatus(scope)?.rearmedAt, 'number');

    emitRequest(server, 'r2', 'https://api.test/after');
    const following = await dump(scope);
    assert.deepEqual(
      following.entries.map((entry) => entry.url),
      ['https://api.test/after'],
      'the follow is not a one-request reprieve',
    );
    assert.equal(
      following.notes?.some((note) => note.includes('reloaded')),
      false,
      'one reload is reported once, not on every later dump',
    );
  } finally {
    await stop();
  }
});

test('a second reload ends the capture instead of silently following it', async () => {
  const { server, scope, stop } = await armedHolderSession([PIXEL]);
  try {
    server.dropInspectorConnections();
    server.removeTarget('pixel-1');
    server.addTarget({ ...PIXEL, id: 'pixel-2' });
    await dump(scope);

    server.dropInspectorConnections();
    server.removeTarget('pixel-2');
    server.addTarget({ ...PIXEL, id: 'pixel-3' });

    await assert.rejects(dump(scope), (error: { code: string; details: { reason: string } }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'metro-runtime-gone', 'one follow is all a capture gets');
      return true;
    });
    assert.equal(readNetworkCaptureHolderStatus(scope)?.status, 'ended');
  } finally {
    await stop();
  }
});

test('a runtime that comes back running another app ends the capture for this session', async () => {
  const { server, scope, stop } = await armedHolderSession([PIXEL]);
  try {
    server.dropInspectorConnections();
    server.removeTarget('pixel-1');
    server.addTarget({ ...PIXEL, appId: 'com.other.app' });

    await assert.rejects(dump(scope), (error: { details: { reason: string } }) => {
      assert.equal(
        error.details.reason,
        'metro-runtime-replaced',
        'another app is not this session',
      );
      return true;
    });
    assert.equal(readNetworkCaptureHolderStatus(scope)?.status, 'ended');
  } finally {
    await stop();
  }
});

test('a runtime that never comes back names the device it lost', async () => {
  const { server, scope, stop } = await armedHolderSession([PIXEL]);
  try {
    server.dropInspectorConnections();
    server.removeTarget('pixel-1');

    await assert.rejects(dump(scope), /no longer running|no longer connected/);
    assert.equal(readNetworkCaptureHolderStatus(scope)?.status, 'ended');
  } finally {
    await stop();
  }
});

test('a holder that gave up stops serving, so its socket cannot answer a later read', async () => {
  const { server, scope, stop } = await armedHolderSession([PIXEL]);
  try {
    server.dropInspectorConnections();
    server.removeTarget('pixel-1');
    await assert.rejects(dump(scope), /no longer connected/);
    await assert.rejects(
      dump(scope),
      /did not answer|no longer running/,
      'the dead capture is named, never read as empty',
    );
  } finally {
    await stop();
  }
});

test('a holder whose own error handling fails still answers the next request', async () => {
  // The socket serves requests from one promise queue. A rejection escaping one answer must not
  // become the queue's settled state: every later request would run on that rejection and the holder
  // would go deaf while its pid still reads as a live capture. The failure is thrown where the
  // answer's own guard cannot catch it — inside the error handler's next step.
  const stateDir = mkdtempForTestSync('agent-device-network-holder-deaf-');
  tempDirs.push(stateDir);
  const scope: NetworkCaptureScope = { stateDir, session: 'deaf-test' };
  const failing = {
    drain: async () => {
      throw new Error('the drain behind this answer is broken');
    },
    commitDrain: () => {},
    reattachUndelivered: () => {},
    stats: () => ({ capturing: true, buffered: 0 }),
    get ended(): boolean {
      // The error handler reads this after answering, outside every guard respond runs under.
      throw new Error('the gave-up check is broken');
    },
    close: async () => {},
    end: async () => {},
  };
  const stop = await serveNetworkCaptureHolder(
    failing as unknown as NetworkCaptureHolder,
    scope,
    () => {},
    () => {},
  );
  try {
    await assert.rejects(ask(scope, { action: 'drain', limit: 5 }), /drain behind this answer/);
    const answered = await ask(scope, { action: 'stats' });
    assert.equal(answered.buffered, 0, 'the queue still serves the read that follows the failure');
  } finally {
    await stop();
  }
});

/** One request-response line over the holder's real socket. */
async function ask(
  scope: NetworkCaptureScope,
  request: Readonly<{ action: string; limit?: number }>,
): Promise<{ ok: boolean; buffered?: number; reason?: string; message?: string }> {
  const socketPath = networkCaptureSocketPath(scope);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      const reply = JSON.parse(buffer.slice(0, newline)) as {
        ok: boolean;
        buffered?: number;
        reason?: string;
        message?: string;
      };
      if (!reply.ok) reject(new Error(reply.message ?? reply.reason ?? 'refused'));
      else resolve(reply);
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

/**
 * Arms one capture and serves the production holder in-process, so the socket, the buffering, and
 * the reload follow are exercised over a real debugger connection rather than a fake one.
 */
async function armedHolderSession(
  targets: readonly HarnessTarget[],
): Promise<
  Readonly<{ server: MetroCdpHarness; scope: NetworkCaptureScope; stop: () => Promise<void> }>
> {
  const server = await startMetroCdpHarness(targets);
  openHarnesses.push(server);
  const stateDir = mkdtempForTestSync('agent-device-network-holder-');
  tempDirs.push(stateDir);
  const scope = { stateDir, session: 'holder-test' };
  writeMetroSessionHints({
    stateDir,
    session: 'holder-test',
    hints: { controlBaseUrl: server.serverUrl.toString() },
  });
  await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  const state = readNetworkCaptureState(scope);
  assert.ok(state);
  const holder = await NetworkCaptureHolder.connect(
    scope,
    { ...state, pid: process.pid },
    process.pid,
  );
  const stop = await serveNetworkCaptureHolder(holder, scope);
  return { server, scope, stop };
}

function emitRequest(server: MetroCdpHarness, requestId: string, url: string): void {
  for (const event of cdpRequestEvents(requestId, url, { status: 200 })) {
    server.emit(event.method, event.params);
  }
}

function dump(scope: NetworkCaptureScope) {
  return dumpMetroNetworkCapture(scope, {
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
  });
}
