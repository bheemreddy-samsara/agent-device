import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { NETWORK_CAPTURE_STATE_DIR } from '@agent-device/contracts/network-capture';
import fs from 'node:fs';
import path from 'node:path';
import { writeMetroSessionHints } from '../metro/metro-session-hints.ts';
import {
  startMetroNetworkCapture,
  dumpMetroNetworkCapture,
  stopMetroNetworkCapture,
} from './network-capture.ts';
import {
  NetworkCaptureHolder,
  serveNetworkCaptureHolder,
} from './network-capture-holder-process.ts';
import {
  networkCaptureStatePath,
  readNetworkCaptureState,
  writeNetworkCaptureState,
  type NetworkCaptureScope,
} from './network-capture-state.ts';
import {
  cdpRequestEvents,
  startMetroCdpHarness,
  type MetroCdpHarness,
} from './metro-cdp-harness.fixtures.ts';

const APP_ID = 'com.example.app';
const openHarnesses: MetroCdpHarness[] = [];
const tempDirs: string[] = [];

async function harness(
  targets: Parameters<typeof startMetroCdpHarness>[0],
): Promise<MetroCdpHarness> {
  const started = await startMetroCdpHarness(targets);
  openHarnesses.push(started);
  return started;
}

/** A session that records its dev server the way an opened Metro session does. */
async function scopeFor(serverUrl: URL, session = 'net-test'): Promise<NetworkCaptureScope> {
  const stateDir = mkdtempForTestSync('agent-device-network-capture-');
  tempDirs.push(stateDir);
  const scope = { stateDir, session };
  writeMetroSessionHints({ stateDir, session, hints: { controlBaseUrl: serverUrl.toString() } });
  return scope;
}

const PIXEL = { id: 'pixel-1', appId: APP_ID, deviceName: 'Pixel 9', logicalDeviceId: 'pixel' };

afterEach(async () => {
  while (openHarnesses.length > 0) await openHarnesses.pop()?.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('a runtime that answers the Network domain is armed as the CDP source and recorded as bound', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const spawned: string[] = [];

  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => {
      spawned.push('holder');
      return 4242;
    },
  });

  assert.equal(started.source, 'metro-cdp');
  assert.equal(started.requiresRelaunch, false, 'the domain sees traffic from the moment it opens');
  assert.deepEqual(started.notes, []);
  assert.deepEqual(spawned, ['holder'], 'the domain needs a connection held open for the window');
  assert.equal(started.state.pid, 4242);
  assert.deepEqual(started.state.binding, {
    serverUrl: server.serverUrl.toString(),
    appId: APP_ID,
    logicalDeviceId: 'pixel',
    targetId: 'pixel-1',
    deviceName: 'Pixel 9',
  });
  assert.ok(fs.existsSync(networkCaptureStatePath(scope)));
});

test('a runtime older than the Network domain arms the in-app hook and asks for a relaunch', async () => {
  const server = await harness([PIXEL]);
  server.refuseMethod('Network.enable');
  let installed = 0;
  server.answer('Runtime.evaluate', (message) => {
    const expression = String((message.params as { expression?: string })?.expression ?? '');
    if (expression.includes('.stats()')) {
      return {
        result: { value: JSON.stringify({ ok: true, capturing: true, captureBodies: false }) },
      };
    }
    if (expression.includes('__AGENT_DEVICE_NETWORK__')) installed += 1;
    return { result: { value: 'installed' } };
  });
  const scope = await scopeFor(server.serverUrl);

  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => {
      throw new Error('the hook buffer lives in the app, so no holder is needed');
    },
  });

  assert.equal(started.source, 'metro-js-hook');
  assert.equal(installed, 1, 'the hook is installed while the capture is armed');
  assert.equal(started.state.pid, undefined);
  assert.match(started.notes[0] ?? '', /relaunch the app/i);
});

test('a dev server that refuses the domain for another reason is not read as an older runtime', async () => {
  const server = await harness([PIXEL]);
  // A refusal with a code other than "Method not found" is some other failure, not an old runtime.
  server.refuseMethod('Network.enable', 'Runtime is busy draining the bridge', -32603);
  const scope = await scopeFor(server.serverUrl);

  await assert.rejects(
    startMetroNetworkCapture({
      scope,
      includesBodies: false,
      maxPayloadChars: 2048,
      spawnHolder: async () => 1,
    }),
    /Debugger protocol error: Runtime is busy draining the bridge/,
  );
  assert.equal(readNetworkCaptureState(scope), undefined, 'a failed arm leaves no capture');
});

test('a session without a recorded dev server is refused instead of capturing on the default port', async () => {
  const stateDir = mkdtempForTestSync('agent-device-network-capture-none-');
  tempDirs.push(stateDir);
  const scope = { stateDir, session: 'no-hints' };

  await assert.rejects(
    startMetroNetworkCapture({
      scope,
      includesBodies: false,
      maxPayloadChars: 2048,
      spawnHolder: async () => 1,
    }),
    (error: { code: string; details: { reason: string } }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'metro-binding-missing');
      return true;
    },
  );
});

test('two app runtimes on two devices are refused until one device is named, and the named one wins', async () => {
  const server = await harness([
    PIXEL,
    {
      id: 'ipad-1',
      appId: APP_ID,
      deviceName: 'iPad Pro',
      logicalDeviceId: 'ipad',
    },
  ]);
  const scope = await scopeFor(server.serverUrl);
  const input = {
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => 1,
  };

  await assert.rejects(
    startMetroNetworkCapture(input),
    (error: { code: string; details: { reason: string; runtimes: string[] } }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details.reason, 'metro-runtime-ambiguous');
      assert.deepEqual(error.details.runtimes, [`${APP_ID} on Pixel 9`, `${APP_ID} on iPad Pro`]);
      return true;
    },
  );

  const started = await startMetroNetworkCapture({ ...input, metroDevice: 'iPad Pro' });
  assert.equal(started.state.binding.targetId, 'ipad-1');
});

test('a second start on a live capture is refused, because the first source still owns the session', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const input = {
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  };
  await startMetroNetworkCapture(input);

  await assert.rejects(
    startMetroNetworkCapture(input),
    (error: { code: string; details: { reason: string } }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'network-capture-already-armed');
      return true;
    },
  );
});

test('a capture holder that died is reported as lost instead of as a quiet window', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => 999_999,
  });
  writeNetworkCaptureState(scope, { ...started.state, pid: missingPid() });

  await assert.rejects(
    dumpMetroNetworkCapture(scope, { maxEntries: 25, include: 'summary', maxPayloadChars: 2048 }),
    (error: { code: string; details: { reason: string } }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'network-capture-lost');
      return true;
    },
  );
});

test('a dump drains the live holder, names the CDP source, and hands each entry over once', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  const stop = await serveHolder(scope, started.state.binding.targetId);
  try {
    for (const [index, id] of ['r1', 'r2'].entries()) {
      for (const event of cdpRequestEvents(id, `https://api.test/${index}`, {
        status: index === 0 ? 200 : 500,
      })) {
        server.emit(event.method, event.params);
      }
    }

    const first = await dumpMetroNetworkCapture(scope, {
      maxEntries: 1,
      include: 'summary',
      maxPayloadChars: 2048,
    });
    assert.equal(first.source, 'metro-cdp');
    assert.equal(first.backend, 'metro-cdp');
    assert.deepEqual(
      first.entries.map((entry) => [entry.url, entry.status]),
      [['https://api.test/1', 500]],
    );
    assert.match(
      first.notes?.find((note) => note.includes('buffered')) ?? '',
      /1 older captured request remains buffered; dump again or raise the limit\./,
    );

    const second = await dumpMetroNetworkCapture(scope, {
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
    });
    assert.deepEqual(
      second.entries.map((entry) => entry.url),
      ['https://api.test/0'],
      'a drain never repeats an entry',
    );
  } finally {
    await stop();
  }
});

test('a dump reports the header detail it asks for and names the bodies its own start left out', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  const stop = await serveHolder(scope, started.state.binding.targetId);
  try {
    for (const event of cdpRequestEvents('r1', 'https://api.test/a', {
      status: 200,
      requestHeaders: { Authorization: 'Bearer sk-secret', Accept: 'application/json' },
      responseHeaders: { 'x-trace': 'abc' },
    })) {
      server.emit(event.method, event.params);
    }

    const summary = await dumpMetroNetworkCapture(scope, {
      maxEntries: 5,
      include: 'summary',
      maxPayloadChars: 2048,
    });
    assert.equal(summary.entries[0]?.url, 'https://api.test/a');
    assert.equal(summary.entries[0]?.requestHeaders, undefined);

    for (const event of cdpRequestEvents('r2', 'https://api.test/b', {
      status: 200,
      requestHeaders: { Accept: 'application/json' },
      responseHeaders: { 'x-trace': 'abc' },
    })) {
      server.emit(event.method, event.params);
    }
    const headers = await dumpMetroNetworkCapture(scope, {
      maxEntries: 5,
      include: 'all',
      maxPayloadChars: 2048,
    });
    assert.deepEqual(headers.entries[0]?.requestHeaders, { Accept: 'application/json' });
    assert.deepEqual(headers.entries[0]?.responseHeaders, { 'x-trace': 'abc' });
    assert.equal(
      headers.entries[0]?.responseBody,
      undefined,
      'a capture armed without bodies has none to hand over, whatever a dump asks for',
    );
    assert.match(headers.notes?.join(' ') ?? '', /Bodies are off for this capture/);
  } finally {
    await stop();
  }
});

test('a capture asked for bodies reads them from the runtime that served the response', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  server.answer('Network.getResponseBody', (message) => ({
    body: `body-for:${(message.params as { requestId?: string }).requestId}`,
  }));
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: true,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  const stop = await serveHolder(scope, started.state.binding.targetId);
  try {
    for (const event of cdpRequestEvents('r1', 'https://api.test/a', { status: 200 })) {
      server.emit(event.method, event.params);
    }
    const dumped = await dumpMetroNetworkCapture(scope, {
      maxEntries: 5,
      include: 'all',
      maxPayloadChars: 2048,
    });
    assert.equal(dumped.entries[0]?.responseBody, 'body-for:r1');
    assert.equal(
      dumped.notes?.some((note) => note.includes('Bodies are off')),
      false,
    );
  } finally {
    await stop();
  }
});

test('the in-app hook is drained from the runtime the capture bound to and reports its own install', async () => {
  const server = await harness([PIXEL]);
  server.refuseMethod('Network.enable');
  const scope = await scopeFor(server.serverUrl);
  let evaluations = 0;
  server.answer('Runtime.evaluate', (message) => {
    const expression = String((message.params as { expression?: string })?.expression ?? '');
    evaluations += 1;
    if (expression.includes('.drain(')) {
      return {
        result: {
          value: JSON.stringify({
            entries: [
              {
                timestamp: '2026-10-24T09:00:00.000Z',
                method: 'GET',
                url: 'https://api.test/hooked',
                status: 201,
                durationMs: 12,
                transport: 'fetch',
              },
            ],
            dropped: 0,
          }),
        },
      };
    }
    if (expression.includes('.stats()')) {
      return { result: { value: JSON.stringify({ captured: 1, buffered: 1, dropped: 0 }) } };
    }
    return { result: { value: 'already-installed' } };
  });
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => {
      throw new Error('the hook source needs no holder');
    },
  });
  assert.equal(started.source, 'metro-js-hook');

  const dumped = await dumpMetroNetworkCapture(scope, {
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
  });
  assert.equal(dumped.source, 'metro-js-hook');
  assert.equal(dumped.backend, 'react-native-app');
  assert.deepEqual(
    dumped.entries.map((entry) => [entry.url, entry.status]),
    [['https://api.test/hooked', 201]],
  );
  assert.ok(evaluations >= 3, 'the hook is checked, drained, and read its stats on every dump');
});

test('a hook capture ends at a JS reload, because the buffer lived in the runtime it replaced', async () => {
  const server = await harness([PIXEL]);
  server.refuseMethod('Network.enable');
  const scope = await scopeFor(server.serverUrl);
  await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => {
      throw new Error('the hook source needs no holder');
    },
  });
  // The same app on the same device registers a fresh target id: a JS reload, which discarded
  // the in-app buffer along with the runtime that held it.
  server.removeTarget('pixel-1');
  server.addTarget({ ...PIXEL, id: 'pixel-2' });

  await assert.rejects(
    dumpMetroNetworkCapture(scope, { maxEntries: 25, include: 'summary', maxPayloadChars: 2048 }),
    (error: { code: string; details: { reason: string }; message: string }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'metro-runtime-gone');
      assert.match(error.message, /reloaded its JavaScript/);
      return true;
    },
  );
});

test('a capture whose runtime is gone mid-window is refused rather than followed', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  const started = await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  assert.equal(started.source, 'metro-cdp');
  server.removeTarget('pixel-1');

  await assert.rejects(
    dumpMetroNetworkCapture(scope, { maxEntries: 25, include: 'summary', maxPayloadChars: 2048 }),
    (error: { code: string; details: { reason: string } }) => {
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details.reason, 'network-capture-lost');
      return true;
    },
  );
});

test('stop closes the capture so the next dump is the daemon app-log read again', async () => {
  const server = await harness([PIXEL]);
  const scope = await scopeFor(server.serverUrl);
  await startMetroNetworkCapture({
    scope,
    includesBodies: false,
    maxPayloadChars: 2048,
    spawnHolder: async () => process.pid,
  });
  await stopMetroNetworkCapture(scope);

  assert.equal(readNetworkCaptureState(scope), undefined);
  assert.equal(
    fs.existsSync(path.join(scope.stateDir, NETWORK_CAPTURE_STATE_DIR, 'net-test.holder.log')),
    false,
  );
  await assert.rejects(
    dumpMetroNetworkCapture(scope, { maxEntries: 25, include: 'summary', maxPayloadChars: 2048 }),
    (error: { details: { reason: string } }) => {
      assert.equal(error.details.reason, 'network-capture-not-started');
      return true;
    },
  );
});

/** Serves the production holder on this process, as the detached holder would, on the real socket. */
async function serveHolder(
  scope: NetworkCaptureScope,
  targetId: string,
): Promise<() => Promise<void>> {
  const state = readNetworkCaptureState(scope);
  assert.ok(state);
  const holder = await NetworkCaptureHolder.connect(
    scope,
    { ...state, pid: process.pid },
    process.pid,
  );
  assert.equal(holder.state.binding.targetId, targetId);
  return await serveNetworkCaptureHolder(holder, scope);
}

/** A pid no process can hold, so the liveness probe must report the capture as gone. */
function missingPid(): number {
  for (let pid = 999_999; pid < 1_000_100; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('no unused pid found');
}
