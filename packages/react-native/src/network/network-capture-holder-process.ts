import net from 'node:net';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { NetworkCaptureState } from '@agent-device/contracts/network-capture';
import { NETWORK_CAPTURE_TYPED_REASONS } from '@agent-device/contracts/network-capture';
import {
  networkCaptureSocketPath,
  readNetworkCaptureState,
  writeNetworkCaptureHolderStatus,
  type NetworkCaptureScope,
} from './network-capture-state.ts';
import {
  boundTargetLost,
  readBoundCaptureTarget,
  typedFailureReason,
} from './network-capture-target.ts';
import {
  CdpNetworkBuffer,
  cdpMethodUnsupported,
  type CapturedCdpRequest,
} from './cdp-network-buffer.ts';
import {
  debuggerUrlOn,
  InspectorSession,
  type MetroInspectorTarget,
} from '../react-devtools/metro-inspector.ts';

const CDP_TIMEOUT_MS = 10_000;
const CDP_BUFFER_ENTRIES = 200;

export type HolderDrain = Readonly<{
  entries: readonly CapturedCdpRequest[];
  dropped: number;
  buffered: number;
  notes: readonly string[];
}>;

/**
 * The live holder for one session's Metro CDP capture.
 *
 * It keeps the one debugger connection the CDP `Network` domain needs for the whole capture window,
 * because that domain stops emitting the moment its connection closes. `network dump` drains it over
 * a unix socket in the session's state dir; a drain removes what it hands over, so a second dump
 * never repeats an entry. When the bound runtime goes away, the holder follows a JavaScript reload
 * once onto the target its own device and app register, and says so; anything else ends the capture
 * with a typed reason, so an empty window is never reported as a quiet one.
 */
export class NetworkCaptureHolder {
  readonly #scope: NetworkCaptureScope;
  readonly #pid: number;
  readonly #buffer = new CdpNetworkBuffer(CDP_BUFFER_ENTRIES);
  #state: NetworkCaptureState;
  #session: InspectorSession | undefined;
  #closed = false;
  /** Set once the holder has given up, so the process can leave rather than serve a dead capture. */
  #ended = false;
  /**
   * What this holder's window cannot cover since the last dump, because the runtime it reads was
   * reloaded or its debugger connection was interrupted. The note rides the next drain once, so a
   * gap is named exactly where it happened rather than on every later read.
   */
  #pendingGapNote: string | undefined;

  private constructor(scope: NetworkCaptureScope, state: NetworkCaptureState, pid: number) {
    this.#scope = scope;
    this.#state = state;
    this.#pid = pid;
  }

  /** Connects to the bound runtime and answers `Network.enable` before the holder reports ready. */
  static async connect(
    scope: NetworkCaptureScope,
    state: NetworkCaptureState,
    /** The holder process's own pid, which its status records so a reader can probe it. */
    pid: number,
  ): Promise<NetworkCaptureHolder> {
    const holder = new NetworkCaptureHolder(scope, state, pid);
    await holder.#arm();
    return holder;
  }

  get state(): NetworkCaptureState {
    return this.#state;
  }

  async drain(limit: number): Promise<HolderDrain> {
    const notes: string[] = [];
    if (this.#session === undefined) {
      const rearmed = await this.#rearm();
      if (!rearmed.ok) throw rearmed.error;
    }
    const gap = this.#pendingGapNote;
    if (gap !== undefined) {
      this.#pendingGapNote = undefined;
      notes.push(gap);
    }
    const drained = this.#buffer.drain(limit);
    if (this.#state.includesBodies && this.#session) {
      await this.#readResponseBodies(drained.entries, notes);
    }
    return {
      entries: drained.entries,
      dropped: drained.dropped,
      buffered: this.#buffer.buffered(),
      notes,
    };
  }

  stats(): Readonly<{ capturing: boolean; buffered: number }> {
    return { capturing: this.#session !== undefined, buffered: this.#buffer.buffered() };
  }

  /** Whether this holder has told its readers it is done, which is its last answer. */
  get ended(): boolean {
    return this.#ended;
  }

  /** Ends the debugger connection. The state file stays, so only `network stop` clears a capture. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#session?.close();
    this.#session = undefined;
  }

  /** Tells every surface why this holder gave up, so a later dump names it instead of guessing. */
  async end(reason: string | undefined): Promise<void> {
    this.#ended = true;
    await this.close();
    writeNetworkCaptureHolderStatus(this.#scope, {
      pid: this.#pid,
      status: 'ended',
      reason,
      targetId: this.#state.binding.targetId,
    });
  }

  async #arm(): Promise<void> {
    const reading = await readBoundCaptureTarget(this.#state.binding);
    if (reading.status === 'gone' || reading.status === 'app-changed') {
      throw boundTargetLost(reading);
    }
    // Arming on a runtime that already reloaded since the caller chose it would hide a gap, so the
    // holder takes the replacement and names that gap on the first dump.
    if (reading.status === 'reloaded') {
      this.#follow(reading.target);
      this.#pendingGapNote =
        'The app runtime had already reloaded its JavaScript by the time the capture connected, so this capture holds no request made before that reload.';
    }
    await this.#connect(reading.target);
  }

  /**
   * Re-opens the debugger connection the domain needs, on the runtime the session's app now runs.
   *
   * A JavaScript reload registers a new target id for the same app and device, which the holder
   * follows exactly once: the first reload costs a window nobody can reconstruct, and a second one
   * would mean following the app around while claiming to have watched it the whole time. Anything
   * else — the device running another app, or registering nothing — ends the capture, so an empty
   * window is never reported as a quiet one.
   */
  async #rearm(): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: AppError }>> {
    const reading = await readBoundCaptureTarget(this.#state.binding);
    // The follow is spent: the state already records one, so the app reloaded again.
    if (reading.status === 'reloaded' && this.#state.rearmedAt !== undefined) {
      const error = new AppError(
        'UNSUPPORTED_OPERATION',
        'The app runtime this network capture was armed on reloaded its JavaScript again, and a capture follows one reload because the first already cost it a window it cannot reconstruct.',
        {
          reason: NETWORK_CAPTURE_TYPED_REASONS.targetGone,
          hint: 'Run network stop and network start again to bind the capture to the runtime the app uses now.',
        },
      );
      await this.end(typedFailureReason(error));
      return { ok: false, error };
    }
    if (reading.status !== 'bound' && reading.status !== 'reloaded') {
      const error = boundTargetLost(reading);
      await this.end(typedFailureReason(error));
      return { ok: false, error };
    }
    const previous = this.#state;
    if (reading.status === 'reloaded') this.#follow(reading.target);
    try {
      await this.#connect(reading.target);
    } catch (error) {
      this.#state = previous;
      await this.end(NETWORK_CAPTURE_TYPED_REASONS.captureLost);
      return {
        ok: false,
        error:
          error instanceof AppError
            ? error
            : new AppError('COMMAND_FAILED', String(error), {
                reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost,
              }),
      };
    }
    this.#pendingGapNote =
      reading.status === 'reloaded'
        ? 'The app runtime was reloaded during this capture window, so the capture re-armed on its replacement target; requests made before the reload are not in this dump.'
        : 'The debugger connection to the app runtime was interrupted and opened again, so requests made while it was down are not in this dump.';
    if (reading.status === 'reloaded') {
      writeNetworkCaptureHolderStatus(this.#scope, {
        pid: this.#pid,
        status: 'capturing',
        targetId: reading.target.id,
        rearmedAt: this.#state.rearmedAt,
      });
    }
    return { ok: true };
  }

  /** Points the holder at the runtime that replaced the one it lost, and records when that happened. */
  #follow(target: MetroInspectorTarget): void {
    this.#state = {
      ...this.#state,
      binding: { ...this.#state.binding, targetId: target.id },
      rearmedAt: Date.now(),
    };
  }

  async #connect(target: MetroInspectorTarget): Promise<void> {
    const serverUrl = new URL(this.#state.binding.serverUrl);
    const session = await within(
      InspectorSession.connect(debuggerUrlOn(serverUrl, target)),
      'The app runtime did not accept the debugger connection in time.',
    );
    try {
      await within(
        session.send('Network.enable'),
        'The app runtime did not answer Network.enable in time.',
      );
    } catch (error) {
      session.close();
      if (cdpMethodUnsupported(error)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'This app runtime does not implement the CDP Network domain, so this capture cannot keep running on it.',
          { reason: 'metro-cdp-network-unsupported' },
        );
      }
      throw error;
    }
    session.onEvent((event) => this.#buffer.add(event));
    session.onClose(() => {
      if (this.#session === session) this.#session = undefined;
    });
    this.#session = session;
  }

  /**
   * Reads each drained entry's response body through `Network.getResponseBody`, which the runtime
   * serves from its own bounded preview buffer. A body the runtime already gave up is counted as
   * missing, never guessed at.
   */
  async #readResponseBodies(
    entries: readonly CapturedCdpRequest[],
    notes: string[],
  ): Promise<void> {
    const session = this.#session;
    if (!session) return;
    for (const entry of entries) {
      if (entry.error !== undefined || entry.status === undefined) continue;
      try {
        const body = (await within(
          session.send('Network.getResponseBody', { requestId: entry.requestId }),
          'The app runtime did not answer Network.getResponseBody in time.',
        )) as { body?: string; base64Encoded?: boolean };
        if (typeof body?.body === 'string' && body.base64Encoded !== true) {
          (entry as { responseBody?: string }).responseBody = body.body;
        }
      } catch {
        this.#buffer.recordFailedBodyRead();
      }
    }
    const failed = this.#buffer.takeFailedBodyReads();
    if (failed > 0) {
      notes.push(
        `${failed} response bod${failed === 1 ? 'y was' : 'ies were'} no longer held by the app runtime when this dump asked for it.`,
      );
    }
  }
}

/**
 * Serves one holder over a unix socket: `drain`, `stats`, `stop`. The socket lives in the session's
 * state dir, so only a reader on the host that armed the capture can reach it.
 */
export async function serveNetworkCaptureHolder(
  holder: NetworkCaptureHolder,
  scope: NetworkCaptureScope,
  /** Runs when the holder has answered its last read because it gave up. */
  onGaveUp?: () => void,
  /** Runs when the socket answered a `stop`, for a host that ends its own process. */
  onStop?: () => void,
): Promise<() => Promise<void>> {
  const socketPath = networkCaptureSocketPath(scope);
  fs.mkdirSync(scope.stateDir, { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void respond(connection, request);
    });
    connection.on('error', () => connection.destroy());
  });
  async function respond(connection: net.Socket, raw: string): Promise<void> {
    let request: { action?: string; limit?: number };
    try {
      request = JSON.parse(raw) as { action?: string; limit?: number };
    } catch {
      connection.end(
        `${JSON.stringify({ ok: false, reason: 'network-capture-request-unreadable' })}\n`,
      );
      return;
    }
    try {
      if (request.action === 'drain') {
        const drained = await holder.drain(request.limit ?? 25);
        connection.end(`${JSON.stringify({ ok: true, ...drained })}\n`);
        return;
      }
      if (request.action === 'stats') {
        connection.end(`${JSON.stringify({ ok: true, ...holder.stats() })}\n`);
        return;
      }
      if (request.action === 'stop') {
        await holder.close();
        connection.end(`${JSON.stringify({ ok: true })}\n`);
        await stopServing();
        onStop?.();
        return;
      }
      connection.end(
        `${JSON.stringify({ ok: false, reason: 'network-capture-request-unknown' })}\n`,
      );
    } catch (error) {
      const reason =
        error instanceof AppError && typeof error.details?.reason === 'string'
          ? error.details.reason
          : NETWORK_CAPTURE_TYPED_REASONS.captureLost;
      connection.end(`${JSON.stringify({ ok: false, reason, message: messageOf(error) })}\n`);
      if (holder.ended) {
        // The holder has nothing left to watch, so it stops serving. Who ends the process decides
        // for itself: the detached holder exits, because a pid left behind would read as a live
        // capture to the next reader's probe.
        await stopServing();
        onGaveUp?.();
      }
    }
  }
  async function stopServing(): Promise<void> {
    await holder.close();
    server.close();
    fs.rmSync(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return stopServing;
}

function messageOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError('COMMAND_FAILED', message, { reason: 'network-capture-timeout' }));
    }, CDP_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const HOLDER_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** What the holder host supplies for ending its own process; the holder itself never ends it. */
export type HolderProcessHost = Readonly<{
  pid: number;
  /** Ends the process after its last answer, with the exit code the outcome calls for. */
  exit: (code: number) => void;
  /** Reports a fatal holder problem to the host's own output. */
  report: (message: string) => void;
  /** Runs the holder's orderly shutdown when the host receives SIGTERM. */
  onTerminate: (shutdown: () => void) => void;
}>;

/**
 * One session's capture holder, as the detached process runs it: it connects to the bound runtime,
 * serves drains until stopped, and owns nothing else — no daemon, no session, no device. The
 * lifetime bound is a safety net for a holder nobody stopped, because a capture that outlives its
 * session would keep a debugger connection to a runtime nobody is watching. The host that runs it
 * supplies how its process ends; the holder decides only when.
 */
export async function runNetworkCaptureHolderProcess(
  env: NodeJS.ProcessEnv,
  host: HolderProcessHost,
): Promise<void> {
  const scope = resolveHolderScopeFromEnv(env);
  const state = readNetworkCaptureState(scope);
  if (!state) {
    host.report('No network capture state for this session.\n');
    host.exit(1);
    return;
  }
  const holder = await NetworkCaptureHolder.connect(scope, state, host.pid);
  writeNetworkCaptureHolderStatus(scope, {
    pid: host.pid,
    status: 'capturing',
    targetId: holder.state.binding.targetId,
  });
  let stop = async () => {};
  const shutdown = async () => {
    await stop();
    host.exit(0);
  };
  stop = await serveNetworkCaptureHolder(holder, scope, shutdown, shutdown);
  const timer = setTimeout(() => {
    void shutdown();
  }, HOLDER_MAX_LIFETIME_MS);
  timer.unref();
  host.onTerminate(() => {
    void shutdown();
  });
}

/** The two variables the detached holder needs; it reads everything else from the session's state. */
export const HOLDER_ENV_STATE_DIR = 'AGENT_DEVICE_STATE_DIR';
export const HOLDER_ENV_SESSION = 'AGENT_DEVICE_NETWORK_CAPTURE_SESSION';

function resolveHolderScopeFromEnv(env: NodeJS.ProcessEnv): NetworkCaptureScope {
  const stateDir = env[HOLDER_ENV_STATE_DIR];
  const session = env[HOLDER_ENV_SESSION];
  if (!stateDir || !session) {
    throw new Error(
      `The network capture holder needs ${HOLDER_ENV_STATE_DIR} and ${HOLDER_ENV_SESSION}.`,
    );
  }
  return { stateDir, session };
}
