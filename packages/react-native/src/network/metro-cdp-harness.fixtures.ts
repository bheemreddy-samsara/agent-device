import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

/**
 * A dev server a React Native capture can arm against: it lists app runtimes at `/json/list`,
 * answers CDP requests by method name on the inspector socket, and can push the id-less `Network.*`
 * notifications a runtime sends after its domain is enabled. It also lets a test drop a debugger
 * connection and re-register a target, which is what a JavaScript reload looks like from outside.
 */

export type HarnessTarget = Readonly<{
  id: string;
  appId: string;
  deviceName?: string;
  logicalDeviceId?: string;
}>;

type CdpResponder = (
  message: Record<string, unknown>,
  connection: CdpConnection,
) => unknown | undefined;

type CdpConnection = Readonly<{
  push: (method: string, params: Record<string, unknown>) => void;
  drop: () => void;
}>;

export type MetroCdpHarness = Readonly<{
  serverUrl: URL;
  /** Registers a runtime, or replaces the registration of the same id. */
  addTarget: (target: HarnessTarget) => void;
  /** Ends the registration, which is what happens when the app closes or reloads. */
  removeTarget: (id: string) => void;
  inspectorConnections: number;
  /** Method refusals the harness answers with the protocol's own error, keyed by method. */
  refuseMethod: (method: string, message?: string) => void;
  /** Method calls the harness answers however a test decides, overriding the default answers. */
  answer: (method: string, responder: CdpResponder) => void;
  /** Pushes one CDP notification to every open inspector socket. */
  emit: (method: string, params: Record<string, unknown>) => void;
  /** Ends every inspector socket, as a runtime restart or a JS reload does. */
  dropInspectorConnections: () => void;
  close: () => Promise<void>;
}>;

function readFrame(
  buffer: Buffer,
): { frame: { opcode: number; payload: Buffer }; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
  return {
    frame: { opcode: buffer[0]! & 0x0f, payload },
    rest: buffer.subarray(offset + 4 + length),
  };
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

const DEFAULT_ANSWERS: Record<string, unknown> = {
  'Network.enable': {},
  'Network.disable': {},
};

export async function startMetroCdpHarness(
  targets: readonly HarnessTarget[] = [],
  /** An exact port, for a driver that must name the address to another process before it starts. */
  preferredPort = 0,
): Promise<MetroCdpHarness> {
  const registered = new Map<string, HarnessTarget>(targets.map((t) => [t.id, t]));
  const refusals = new Map<string, string>();
  const answers = new Map<string, CdpResponder>();
  const connections = new Set<Duplex>();
  let inspectorConnections = 0;

  const server: Server = createServer((req, res) => {
    if (!req.url?.startsWith('/json/list')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        [...registered.values()].map((target) => ({
          id: target.id,
          title: 'React Native',
          description: 'React Native Bridgeless [C++ connection]',
          appId: target.appId,
          deviceName: target.deviceName,
          reactNative: {
            logicalDeviceId: target.logicalDeviceId ?? target.id,
            version: '0.88.0',
          },
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?page=${target.id}`,
        })),
      ),
    );
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const page = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('page') ?? '';
    if (!registered.has(page)) {
      socket.destroy();
      return;
    }
    inspectorConnections += 1;
    connections.add(socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection: CdpConnection = {
      push: (method, params) => {
        if (socket.destroyed) return;
        socket.write(textFrame(JSON.stringify({ method, params })));
      },
      drop: () => socket.destroy(),
    };
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let read = readFrame(pending); read; read = readFrame(pending)) {
        pending = read.rest;
        if (read.frame.opcode === 0x8) {
          socket.end();
          return;
        }
        const message = JSON.parse(read.frame.payload.toString('utf8')) as Record<string, unknown>;
        const id = message.id;
        if (typeof id !== 'number') continue;
        const method = String(message.method ?? '');
        const refusal = refusals.get(method);
        if (refusal !== undefined) {
          socket.write(textFrame(JSON.stringify({ id, error: { message: refusal } })));
          continue;
        }
        const responder = answers.get(method);
        const result = responder ? responder(message, connection) : DEFAULT_ANSWERS[method];
        socket.write(textFrame(JSON.stringify({ id, result: result ?? {} })));
      }
    });
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => connections.delete(socket));
  });

  server.listen(preferredPort, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  return {
    serverUrl: new URL(`http://127.0.0.1:${port}`),
    addTarget: (target) => {
      registered.set(target.id, target);
    },
    removeTarget: (id) => {
      registered.delete(id);
    },
    get inspectorConnections() {
      return inspectorConnections;
    },
    refuseMethod: (method, message = `'${method}' was not found`) => {
      refusals.set(method, message);
    },
    answer: (method, responder) => {
      answers.set(method, responder);
    },
    emit: (method, params) => {
      for (const connection of connections) {
        if (!connection.destroyed) connection.write(textFrame(JSON.stringify({ method, params })));
      }
    },
    dropInspectorConnections: () => {
      for (const connection of connections) connection.destroy();
      connections.clear();
    },
    close: async () => {
      for (const connection of connections) connection.destroy();
      connections.clear();
      server.close();
      await once(server, 'close');
    },
  };
}

/** The `Network` event triple one finished request is made of, as a runtime reports it. */
export function cdpRequestEvents(
  requestId: string,
  url: string,
  options: Readonly<{
    status?: number;
    method?: string;
    startedAt?: number;
    finishedAt?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    errorText?: string;
  }> = {},
): Array<Readonly<{ method: string; params: Record<string, unknown> }>> {
  const startedAt = options.startedAt ?? 100;
  const events: Array<{ method: string; params: Record<string, unknown> }> = [
    {
      method: 'Network.requestWillBeSent',
      params: {
        requestId,
        timestamp: startedAt,
        request: {
          url,
          method: options.method ?? 'GET',
          headers: options.requestHeaders ?? { Accept: 'application/json' },
        },
      },
    },
  ];
  if (options.status !== undefined) {
    events.push({
      method: 'Network.responseReceived',
      params: {
        requestId,
        timestamp: startedAt,
        response: { status: options.status, headers: options.responseHeaders ?? {} },
      },
    });
  }
  events.push(
    options.errorText === undefined
      ? {
          method: 'Network.loadingFinished',
          params: { requestId, timestamp: options.finishedAt ?? startedAt + 0.5 },
        }
      : {
          method: 'Network.loadingFailed',
          params: {
            requestId,
            timestamp: options.finishedAt ?? startedAt + 0.5,
            errorText: options.errorText,
          },
        },
  );
  return events;
}
