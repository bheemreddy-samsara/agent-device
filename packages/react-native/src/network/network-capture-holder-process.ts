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
/** Body reads must finish inside one budget so the drain reply still crosses the socket in time. */
const BODY_READ_BUDGET_MS = 8_000;

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

  /**
   * Reads the newest `limit` finished entries. The buffer keeps its eviction count unsettled until
   * `commitDrain` or `reattachUndelivered`, because until the reply crosses the socket the reader
   * has received nothing and the window must stay reportable.
   */
  async drain(limit: number): Promise<HolderDrain> {
    const notes: string[] = [];
    if (this.#session === undefined) {
      const rearmed = await this.#rearm();
      if (!rearmed.ok) throw rearmed.error;
    }
    const gap = this.#pendingGapNote;
    if (gap !== undefined) notes.push(gap);
    const drained = this.#buffer.take(limit);
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

  /** Confirms a drain's reply reached its reader, which spends the eviction count it reported. */
  commitDrain(): void {
    this.#buffer.delivered();
    this.#pendingGapNote = undefined;
  }

  /** A reply that never crossed the socket returns its entries; the window was never handed over. */
  reattachUndelivered(entries: readonly CapturedCdpRequest[]): void {
    this.#buffer.reattach(entries);
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
    // Request ids belong to one debugger connection: what was in flight on the dead one can never
    // settle, and a completed id from it must not hold back a new request that reuses the id.
    this.#buffer.reopened();
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
          { reason: NETWORK_CAPTURE_TYPED_REASONS.cdpNetworkUnsupported },
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
   * missing, never guessed at. This phase runs inside one deadline short of the reader's own, so a
   * slow runtime keeps most of the drain budget for answering. A drain that overruns the reader's
   * deadline anyway costs nothing permanent: the reply is destroyed in flight, the undelivered
   * entries go back into the buffer, and the next dump reports them.
   */
  async #readResponseBodies(
    entries: readonly CapturedCdpRequest[],
    notes: string[],
  ): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const deadline = Date.now() + BODY_READ_BUDGET_MS;
    const counts = { body: 0, binary: 0, missing: 0 };
    for (const entry of entries) {
      if (entry.error !== undefined || entry.status === undefined) continue;
      if (Date.now() >= deadline) {
        counts.missing += 1;
        continue;
      }
      counts[await readOneBody(session, entry)] += 1;
    }
    if (counts.missing > 0) {
      notes.push(
        `${counts.missing} response bod${counts.missing === 1 ? 'y was' : 'ies were'} not reported: the app runtime no longer held it, or reading it ran out of time.`,
      );
    }
    if (counts.binary > 0) {
      notes.push(
        `${counts.binary} response bod${counts.binary === 1 ? 'y was' : 'ies were'} binary and has no text form to report.`,
      );
    }
  }
}

/**
 * Reads one entry's response body onto the entry. A binary body has no text form to report; a body
 * the runtime dropped or refused is missing, never guessed at.
 */
async function readOneBody(
  session: InspectorSession,
  entry: CapturedCdpRequest,
): Promise<'body' | 'binary' | 'missing'> {
  try {
    const body = (await within(
      session.send('Network.getResponseBody', { requestId: entry.requestId }),
      'The app runtime did not answer Network.getResponseBody in time.',
    )) as { body?: string; base64Encoded?: boolean };
    if (typeof body?.body !== 'string') return 'missing';
    if (body.base64Encoded === true) return 'binary';
    (entry as { responseBody?: string }).responseBody = body.body;
    return 'body';
  } catch {
    return 'missing';
  }
}

/**
 * Serves one holder over a unix socket: `drain`, `stats`, `stop`. The socket lives in the session's
 * owner's state dir and is reachable by that owner alone.
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
  // Replies carry captured headers and bodies the runtime reported unredacted; the redaction rules
  // belong to the reader that owns them. The socket is therefore owner-only, stated here as an
  // invariant rather than inherited from whatever umask the spawn happened to carry.
  // One request at a time, across every connection: the holder owns the single debugger connection
  // the domain needs, and two concurrent drains would both find it down and open two, orphaning the
  // first. Within one connection, pipelined requests queue in arrival order.
  let queue: Promise<void> = Promise.resolve();
  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const request = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // The catch keeps one failed answer from poisoning the chain: a rejected link would make
        // every later request's `then` run on it, and the holder would go deaf without dying.
        queue = queue
          .then(() => respond(connection, request))
          .catch(() => {
            // `respond` answers every failure itself; a rejection reaching here is a defect in this
            // file, and the socket stays serving regardless.
          });
        newline = buffer.indexOf('\n');
      }
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
        if (await deliver(connection, { ok: true, ...drained })) {
          holder.commitDrain();
        } else {
          // The reader went away (it gave up waiting, or its process died): hand the window back so
          // the next dump reports it instead of reporting a quiet one that was never watched.
          holder.reattachUndelivered(drained.entries);
        }
        return;
      }
      if (request.action === 'stats') {
        await deliver(connection, { ok: true, ...holder.stats() });
        return;
      }
      if (request.action === 'stop') {
        await holder.close();
        await deliver(connection, { ok: true });
        await stopServing();
        onStop?.();
        return;
      }
      await deliver(connection, {
        ok: false,
        reason: 'network-capture-request-unknown',
      });
    } catch (error) {
      const reason =
        error instanceof AppError && typeof error.details?.reason === 'string'
          ? error.details.reason
          : NETWORK_CAPTURE_TYPED_REASONS.captureLost;
      await deliver(connection, { ok: false, reason, message: messageOf(error) });
      if (holder.ended) {
        // The holder has nothing left to watch, so it stops serving. Who ends the process decides
        // for itself: the detached holder exits, because a pid left behind would read as a live
        // capture to the next reader's probe.
        await stopServing();
        onGaveUp?.();
      }
    }
  }
  /** Writes one reply and answers whether it actually crossed the socket. */
  function deliver(connection: net.Socket, payload: Record<string, unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (connection.destroyed) {
        resolve(false);
        return;
      }
      let failed = false;
      const onError = () => {
        failed = true;
      };
      connection.once('error', onError);
      connection.end(`${JSON.stringify(payload)}\n`, () => {
        connection.removeListener('error', onError);
        resolve(!failed);
      });
    });
  }
  /** Ends the capture and the socket. Total: no step's failure may skip the steps that clean up. */
  async function stopServing(): Promise<void> {
    try {
      await holder.close();
    } catch {
      // The connection is going away whatever it says about it.
    }
    try {
      server.close();
    } catch {
      // A server already closed has nothing left to refuse.
    }
    fs.rmSync(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);
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
  let holder: NetworkCaptureHolder;
  try {
    holder = await NetworkCaptureHolder.connect(scope, state, host.pid);
  } catch (error) {
    // A holder that cannot arm never serves a socket, so its status is the only channel that can
    // carry why: record the typed reason before exiting so `network start` reports the same reason
    // a mid-window dump would for the identical condition.
    writeNetworkCaptureHolderStatus(scope, {
      pid: host.pid,
      status: 'ended',
      reason: typedFailureReason(error) ?? NETWORK_CAPTURE_TYPED_REASONS.captureLost,
      targetId: state.binding.targetId,
    });
    host.report(`${error instanceof Error ? error.message : String(error)}\n`);
    host.exit(1);
    return;
  }
  writeNetworkCaptureHolderStatus(scope, {
    pid: host.pid,
    status: 'capturing',
    targetId: holder.state.binding.targetId,
  });
  let stop = async () => {};
  const shutdown = async () => {
    // SIGTERM and the lifetime bound have no reader waiting on a socket: without a recorded
    // ending, the holder's status would keep claiming a capture that had stopped, indistinguishable
    // from one killed outright. A socket `stop` needs no record — `network stop` deletes the
    // capture's files as it answers.
    await holder.end('holder-terminated');
    await stop();
    host.exit(0);
  };
  stop = await serveNetworkCaptureHolder(
    holder,
    scope,
    () => {
      host.exit(0);
    },
    () => {
      host.exit(0);
    },
  );
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
