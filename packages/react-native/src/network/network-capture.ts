import { AppError } from '@agent-device/kernel/errors';
import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { NetworkProviderDumpResult } from '@agent-device/contracts/network-runtime';
import {
  NETWORK_CAPTURE_TYPED_REASONS,
  type NetworkCaptureSource,
  type NetworkCaptureState,
} from '@agent-device/contracts/network-capture';
import {
  readMetroSessionHints,
  resolveSessionMetroServerUrl,
} from '../metro/metro-session-hints.ts';
import type { MetroReloadTargetInput } from '../metro/metro-reload-endpoints.ts';
import { debuggerUrlOn, InspectorSession } from '../react-devtools/metro-inspector.ts';
import {
  clearNetworkCaptureState,
  networkCaptureHolderAlive,
  networkCaptureLost,
  networkCaptureNotStarted,
  readNetworkCaptureHolderStatus,
  readNetworkCaptureState,
  writeNetworkCaptureState,
  type NetworkCaptureScope,
} from './network-capture-state.ts';
import { askNetworkCaptureHolder } from './network-capture-socket.ts';
import {
  resolveNetworkCaptureTarget,
  type ResolvedCaptureTarget,
} from './network-capture-target.ts';
import {
  projectCapturedNetworkEntries,
  captureBufferNotes,
  includesBody,
} from './network-capture-entries.ts';
import {
  NETWORK_CAPTURE_HEADER_CHARS,
  NETWORK_CAPTURE_MAX_ENTRIES,
  NETWORK_CAPTURE_RUNTIME_GLOBAL,
  NETWORK_CAPTURE_RUNTIME_SOURCE,
  NETWORK_CAPTURE_RUNTIME_VERSION,
} from './network-capture-runtime.ts';

const HOLDER_DRAIN_TIMEOUT_MS = 15_000;

/**
 * How long a `metro-cdp` state may claim a capture with no pid yet. The state file is written
 * before the holder spawns — the holder reads its binding from it — so between that write and the
 * pid answer there is a real window with no process to probe. Past it, a pid-less state is what a
 * start that died mid-arm leaves behind, and a session must be able to arm again without `stop`.
 */
const HOLDER_SPAWN_GRACE_MS = 60_000;

function captureStillLive(state: NetworkCaptureState): boolean {
  if (!networkCaptureHolderAlive(state)) return false;
  if (state.source !== 'metro-cdp' || state.pid !== undefined) return true;
  if (Date.now() - state.startedAt <= HOLDER_SPAWN_GRACE_MS) return true;
  // A pid-less state whose grace has passed is not capturing, and its own files go away with the
  // start that takes over, so nothing is left to clean up here.
  return false;
}

/** What a start needs to know; everything else it decides itself. */
export type StartMetroNetworkCaptureInput = Readonly<{
  scope: NetworkCaptureScope;
  /** Narrows the dev server's runtime list; `network start --app` and `--metro-device`. */
  appBundleId?: string;
  metroDevice?: string;
  /** `--metro-host`, `--metro-port`, or `--bundle-url`; names the dev server directly. */
  metro?: MetroReloadTargetInput;
  includesBodies: boolean;
  maxPayloadChars: number;
  /** Starts the live holder for the CDP source. Supplied by the caller that can spawn processes. */
  spawnHolder: (scope: NetworkCaptureScope) => Promise<number>;
}>;

export type StartedNetworkCapture = Readonly<{
  source: NetworkCaptureSource;
  state: NetworkCaptureState;
  requiresRelaunch: boolean;
  notes: readonly string[];
}>;

/**
 * Arms the React Native capture for one session and returns the source it chose.
 *
 * The CDP `Network` domain is preferred, because RN 0.83 and newer report every request the app
 * makes through the platform's own network stack, including the ones a JavaScript hook cannot see.
 * A runtime that refuses the domain — an older React Native, or a dev server that does not proxy it
 * — falls back to the in-app fetch/XHR hook, which sees only JavaScript traffic and therefore needs
 * an app relaunch to catch requests made during startup.
 */
export async function startMetroNetworkCapture(
  input: StartMetroNetworkCaptureInput,
): Promise<StartedNetworkCapture> {
  const existing = readNetworkCaptureState(input.scope);
  if (existing && captureStillLive(existing)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'This session already has a network capture running.',
      {
        reason: NETWORK_CAPTURE_TYPED_REASONS.captureAlreadyArmed,
        hint: `Its source is ${existing.source}. Run network stop first to choose another.`,
      },
    );
  }
  // The dev server a capture binds to has to be the one this session's app loads its bundle from.
  // The caller may name it with --metro-host, --metro-port, or --bundle-url; otherwise the session's
  // recorded binding answers. Without either, the fallback address is only a default, so a capture
  // must not claim to cover the session's traffic from it.
  if (!namesDevServer(input.metro) && !readMetroSessionHints(input.scope)) {
    throw metroBindingMissing();
  }
  const serverUrl = resolveSessionMetroServerUrl(input.scope, input.metro ?? {});
  const resolved = await resolveNetworkCaptureTarget(serverUrl, {
    ...(input.appBundleId === undefined ? {} : { appId: input.appBundleId }),
    ...(input.metroDevice === undefined ? {} : { device: input.metroDevice }),
  });
  const session = await InspectorSession.connect(debuggerUrlOn(serverUrl, resolved.target));
  let armedRuntime: Awaited<ReturnType<typeof armReactNativeRuntime>>;
  try {
    armedRuntime = await armReactNativeRuntime(session, {
      includesBodies: input.includesBodies,
      maxPayloadChars: input.maxPayloadChars,
    });
  } finally {
    session.close();
  }
  const { source, includesBodies } = armedRuntime;
  const notes: string[] = [...armedRuntime.notes];
  let pid: number | undefined;
  let requiresRelaunch = false;
  const state = { ...stateFor(input, resolved, source), includesBodies };
  if (source === 'metro-cdp') {
    // The holder is a detached process and reads its binding from the state file, so the file has to
    // exist before the spawn; the pid that proves the capture is live is written once it answers.
    writeNetworkCaptureState(input.scope, state);
    try {
      pid = await input.spawnHolder(input.scope);
    } catch (error) {
      clearNetworkCaptureState(input.scope);
      throw error;
    }
  } else {
    requiresRelaunch = true;
    notes.push(
      'In-app fetch/XHR capture is armed, so it holds no request made before it was installed; relaunch the app to capture its startup traffic.',
    );
  }
  const armed = { ...state, ...(pid === undefined ? {} : { pid }) };
  writeNetworkCaptureState(input.scope, armed);
  return {
    source,
    state: armed,
    requiresRelaunch,
    notes: Object.freeze(notes),
  };
}

/**
 * Reads the armed React Native capture, from the runtime its binding names and no other.
 *
 * The CDP source drains the live holder, which holds the one connection the domain needs. The hook
 * source reads the app's own buffer over a fresh debugger connection, because the buffer lives in
 * the app's JavaScript runtime rather than in the host.
 */
export async function dumpMetroNetworkCapture(
  scope: NetworkCaptureScope,
  input: Readonly<{ maxEntries: number; include: NetworkIncludeMode; maxPayloadChars: number }>,
): Promise<NetworkProviderDumpResult & Readonly<{ source: NetworkCaptureSource }>> {
  const state = readNetworkCaptureState(scope);
  if (!state) throw networkCaptureNotStarted();
  // Only the CDP source keeps a process holding its connection; the hook's buffer lives in the app
  // runtime, so a dump reaches it over a fresh debugger connection instead.
  if (state.source === 'metro-cdp' && !networkCaptureHolderAlive(state)) {
    const ended = readNetworkCaptureHolderStatus(scope);
    throw networkCaptureLost(ended?.reason);
  }
  if (state.source === 'metro-cdp') {
    const drained = await drainCaptureHolder(scope, input.maxEntries, HOLDER_DRAIN_TIMEOUT_MS);
    const entries = projectCapturedNetworkEntries(
      drained.entries,
      input.include,
      input.maxPayloadChars,
    );
    return {
      source: 'metro-cdp',
      backend: 'metro-cdp',
      entries,
      notes: Object.freeze([
        ...captureBufferNotes({ buffered: drained.buffered, dropped: drained.dropped }),
        ...drained.notes,
        ...(state.includesBodies || !includesBody(input.include)
          ? []
          : ['Bodies are off for this capture; run network start again to capture them.']),
      ]),
    };
  }
  const hook = await drainHookRuntime(state, input);
  return { source: 'metro-js-hook', ...hook };
}

/** Stops the live holder and clears the session's capture state. */
export async function stopMetroNetworkCapture(scope: NetworkCaptureScope): Promise<void> {
  const state = readNetworkCaptureState(scope);
  if (state && state.source === 'metro-cdp' && networkCaptureHolderAlive(state)) {
    const answered = await askNetworkCaptureHolder(scope, { action: 'stop' }, 5_000).then(
      () => true,
      () => false,
    );
    if (!answered && state.pid !== undefined) {
      // A holder busy in a long drain never reads its socket in time. Leaving it alive would hold
      // the runtime's one debugger connection with no reachable owner — a later start would arm a
      // second holder on the same runtime — so the recorded pid is stopped directly.
      await retireHolderProcess(state.pid);
    }
  }
  clearNetworkCaptureState(scope);
}

async function retireHolderProcess(pid: number): Promise<void> {
  try {
    const { stopProcessAndConfirmExit, readProcessStartTime } =
      await import('@agent-device/host-kit/process');
    await stopProcessAndConfirmExit(
      // The start time read now is what keeps the signal from aiming at a recycled pid.
      { pid, identity: { startTime: readProcessStartTime(pid) ?? undefined } },
      { termTimeoutMs: 2_000, killTimeoutMs: 2_000 },
    );
  } catch {
    // Nothing left to prove: the caller clears every file that names this capture either way.
  }
}

/** Whether the caller named a dev server, which stands in for the session's recorded binding. */
function namesDevServer(metro: MetroReloadTargetInput | undefined): boolean {
  return (
    metro !== undefined &&
    (metro.bundleUrl !== undefined ||
      (metro.metroHost !== undefined && metro.metroPort !== undefined) ||
      metro.metroPort !== undefined)
  );
}

/** The session never recorded a dev server, so nothing here can be trusted to carry its traffic. */
function metroBindingMissing(): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    'This session has no recorded dev server binding, so this command cannot tell which app runtime its traffic runs on.',
    {
      reason: NETWORK_CAPTURE_TYPED_REASONS.metroBindingMissing,
      hint: 'Open the app from a development build that loads its bundle from this dev server, or name the dev server with --metro-host/--metro-port (or --bundle-url), then run network start again.',
    },
  );
}

async function armReactNativeRuntime(
  session: InspectorSession,
  options: Readonly<{ includesBodies: boolean; maxPayloadChars: number }>,
): Promise<
  Readonly<{ source: NetworkCaptureSource; includesBodies: boolean; notes: readonly string[] }>
> {
  if (await cdpNetworkAvailable(session)) {
    return { source: 'metro-cdp', includesBodies: options.includesBodies, notes: [] };
  }
  const installed = await session.evaluate(
    `(${NETWORK_CAPTURE_RUNTIME_SOURCE})(${JSON.stringify(NETWORK_CAPTURE_RUNTIME_VERSION)}, ${NETWORK_CAPTURE_MAX_ENTRIES}, ${options.maxPayloadChars}, ${NETWORK_CAPTURE_HEADER_CHARS}, ${options.includesBodies ? 'true' : 'false'})`,
  );
  const notes: string[] = [];
  let includesBodies = options.includesBodies;
  if (installed === 'ready') {
    // A hook from an earlier capture is still patched and still holding its buffer. That traffic
    // belongs to no window this capture watched, so it is discarded here rather than handed to the
    // first dump as if it did.
    const discarded = readJson(
      await session.evaluate(
        `${NETWORK_CAPTURE_RUNTIME_GLOBAL}.drain(${NETWORK_CAPTURE_MAX_ENTRIES})`,
      ),
      'drain',
    );
    const count = Array.isArray(discarded.entries) ? discarded.entries.length : 0;
    notes.push(
      count > 0
        ? `The app runtime still held a capture from an earlier run; its ${count} unread entr${count === 1 ? 'y' : 'ies'} were discarded so this window starts clean.`
        : 'The app runtime already held the capture hook from an earlier run, so this window starts at that install.',
    );
    // A hook already installed decides its own body rule at its own install; the state must record
    // what the runtime actually does, not what this caller asked for.
    const stats = readJson(
      await session.evaluate(`${NETWORK_CAPTURE_RUNTIME_GLOBAL}.stats()`),
      'stats',
    );
    includesBodies = stats.captureBodies === true;
  }
  return { source: 'metro-js-hook', includesBodies, notes: Object.freeze(notes) };
}

/**
 * Asks the runtime for the CDP `Network` domain. A refusal that names the method means the runtime
 * predates network inspection, which is the only reason to fall back to the JavaScript hook; any
 * other failure is the app's or the dev server's, and the caller must hear about it.
 */
async function cdpNetworkAvailable(session: InspectorSession): Promise<boolean> {
  try {
    await session.send('Network.enable');
    await session.send('Network.disable');
    return true;
  } catch (error) {
    const { cdpMethodUnsupported } = await import('./cdp-network-buffer.ts');
    if (cdpMethodUnsupported(error)) return false;
    throw error;
  }
}

async function drainHookRuntime(
  state: NetworkCaptureState,
  input: Readonly<{ maxEntries: number; include: NetworkIncludeMode; maxPayloadChars: number }>,
): Promise<NetworkProviderDumpResult> {
  const serverUrl = new URL(state.binding.serverUrl);
  const { readBoundCaptureTarget, boundRuntimeReloaded, boundTargetLost } =
    await import('./network-capture-target.ts');
  const resolved = await readBoundCaptureTarget(state.binding);
  // The hook's buffer lives in the runtime, so the reload that replaced the target already
  // discarded it: no follow can recover what the CDP source could, and the dump says so.
  if (resolved.status === 'reloaded') throw boundRuntimeReloaded();
  if (resolved.status !== 'bound') throw boundTargetLost(resolved);
  const session = await InspectorSession.connect(debuggerUrlOn(serverUrl, resolved.target));
  try {
    const installed = await session.evaluate(
      `(${NETWORK_CAPTURE_RUNTIME_SOURCE})(${JSON.stringify(NETWORK_CAPTURE_RUNTIME_VERSION)}, ${NETWORK_CAPTURE_MAX_ENTRIES}, ${input.maxPayloadChars}, ${NETWORK_CAPTURE_HEADER_CHARS}, ${state.includesBodies ? 'true' : 'false'})`,
    );
    const drained = readJson(
      await session.evaluate(`${NETWORK_CAPTURE_RUNTIME_GLOBAL}.drain(${input.maxEntries})`),
      'drain',
    );
    const stats = readJson(
      await session.evaluate(`${NETWORK_CAPTURE_RUNTIME_GLOBAL}.stats()`),
      'stats',
    );
    const entries = projectCapturedNetworkEntries(
      Array.isArray(drained.entries) ? drained.entries : [],
      input.include,
      input.maxPayloadChars,
    );
    const notes = [
      ...captureBufferNotes({
        buffered: typeof stats.buffered === 'number' ? stats.buffered : undefined,
        dropped: typeof drained.dropped === 'number' ? drained.dropped : 0,
      }),
    ];
    if (!state.includesBodies && includesBody(input.include)) {
      notes.push('Bodies are off for this capture; run network start again to capture them.');
    }
    if (entries.length === 0) {
      notes.push(
        installed === 'installed'
          ? 'In-app network capture was installed by this read, so it holds no earlier traffic.'
          : 'The app runtime captured no request since the last dump.',
      );
    }
    return { backend: 'react-native-app', entries, notes: Object.freeze(notes) };
  } finally {
    session.close();
  }
}

function stateFor(
  input: StartMetroNetworkCaptureInput,
  resolved: ResolvedCaptureTarget,
  source: NetworkCaptureSource,
): NetworkCaptureState {
  return {
    source,
    session: input.scope.session,
    startedAt: Date.now(),
    binding: resolved.binding,
    includesBodies: input.includesBodies,
    maxPayloadChars: input.maxPayloadChars,
  };
}

function drainCaptureHolder(
  scope: NetworkCaptureScope,
  limit: number,
  timeoutMs: number,
): Promise<
  Readonly<{
    entries: readonly Record<string, unknown>[];
    dropped: number;
    buffered: number;
    notes: readonly string[];
  }>
> {
  return askNetworkCaptureHolder(scope, { action: 'drain', limit }, timeoutMs).then((reply) => ({
    entries: Array.isArray(reply.entries)
      ? (reply.entries as readonly Record<string, unknown>[])
      : [],
    dropped: typeof reply.dropped === 'number' ? reply.dropped : 0,
    buffered: typeof reply.buffered === 'number' ? reply.buffered : 0,
    notes: Array.isArray(reply.notes)
      ? reply.notes.filter((note): note is string => typeof note === 'string')
      : [],
  }));
}

function readJson(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new AppError('COMMAND_FAILED', 'The app network capture returned no result.', {
      reason: 'network-capture-result-unreadable',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppError('COMMAND_FAILED', 'The app network capture returned unparseable JSON.', {
      reason: 'network-capture-result-unreadable',
      method,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('COMMAND_FAILED', 'The app network capture returned a malformed result.', {
      reason: 'network-capture-result-unreadable',
      method,
    });
  }
  return parsed as Record<string, unknown>;
}
