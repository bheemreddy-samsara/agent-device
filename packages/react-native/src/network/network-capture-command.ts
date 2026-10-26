import {
  NETWORK_CAPTURE_MAX_PAYLOAD_CHARS,
  type NetworkDumpSource,
} from '@agent-device/contracts/network-capture';
import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readNetworkCaptureState, type NetworkCaptureScope } from './network-capture-state.ts';
import {
  startMetroNetworkCapture,
  dumpMetroNetworkCapture,
  stopMetroNetworkCapture,
} from './network-capture.ts';
import { spawnNetworkCaptureHolder } from './network-capture-holder-spawn.ts';

/** What the caller knows when it asks for one of the three capture commands. */
export type NetworkCaptureCommandOptions = Readonly<{
  scope: NetworkCaptureScope;
  /**
   * The caller's environment and working directory, captured from its process at the entry.
   * The detached holder inherits them, the way every other detached agent-device process does.
   */
  host: HostEnvironment;
  /** The session's app id, when the caller knows one; it narrows the dev server's runtime list. */
  appBundleId?: string;
  /** `--device`, which narrows the dev server's runtime list to one device. */
  metroDevice?: string;
  /**
   * `--metro-host`, `--metro-port`, or `--bundle-url`, which name the dev server directly.
   * They stand in for the session's recorded binding, so `network start` binds the server the
   * caller names even when the session never opened its app through that dev server.
   */
  metro?: { metroHost?: string; metroPort?: number; bundleUrl?: string };
  /**
   * How much detail to report. Only `network start` decides what is kept: bodies are opt-in there,
   * while headers are always kept, so a dump can ask for them at any time.
   */
  include?: NetworkIncludeMode;
}>;

/** The armed capture one session has, if any; the routing question a dump asks before it reads. */
export function readArmedNetworkCapture(
  options: NetworkCaptureCommandOptions,
): Readonly<{ source: NetworkDumpSource }> | undefined {
  const state = readNetworkCaptureState(options.scope);
  return state ? { source: state.source } : undefined;
}

/** The whole `network start` answer: the one source now serving this session, and how to read it. */
export type StartedNetworkCapture = Readonly<{
  started: true;
  source: NetworkDumpSource;
  binding: unknown;
  requiresRelaunch: boolean;
  bodies: boolean;
  notes: readonly string[];
}>;

/** Arms the capture for one session: picks the source, binds one runtime, and starts what must run. */
export async function runNetworkCaptureStart(
  options: NetworkCaptureCommandOptions,
): Promise<StartedNetworkCapture> {
  const includesBodies = options.include === 'body' || options.include === 'all';
  const device = options.metroDevice;
  const started = await startMetroNetworkCapture({
    scope: options.scope,
    ...(options.appBundleId === undefined ? {} : { appBundleId: options.appBundleId }),
    ...(device === undefined ? {} : { metroDevice: device }),
    ...(options.metro ? { metro: options.metro } : {}),
    includesBodies,
    maxPayloadChars: NETWORK_CAPTURE_MAX_PAYLOAD_CHARS,
    spawnHolder: (scope) => spawnNetworkCaptureHolder(scope, options.host),
  });
  return {
    started: true,
    source: started.source,
    binding: started.state.binding,
    requiresRelaunch: started.requiresRelaunch,
    // What the runtime will actually record, which an adopted hook can decide against this call.
    bodies: started.state.includesBodies,
    notes: started.notes,
  };
}

/** Reads the armed capture. A session with none is the caller's decision, never a silent app-log read. */
export async function runNetworkCaptureDump(
  options: NetworkCaptureCommandOptions,
  input: Readonly<{ maxEntries: number }>,
): Promise<
  Readonly<{
    source: NetworkDumpSource;
    backend: string;
    entries: readonly unknown[];
    notes: readonly string[];
  }>
> {
  const state = readNetworkCaptureState(options.scope);
  const result = await dumpMetroNetworkCapture(options.scope, {
    maxEntries: input.maxEntries,
    include: options.include ?? 'summary',
    maxPayloadChars: state?.maxPayloadChars ?? NETWORK_CAPTURE_MAX_PAYLOAD_CHARS,
  });
  return {
    source: result.source,
    backend: result.backend,
    entries: result.entries,
    notes: result.notes ?? [],
  };
}

/** Ends one session's capture: the live holder stops and every file that describes it goes away. */
export async function runNetworkCaptureStop(options: NetworkCaptureCommandOptions): Promise<
  Readonly<{
    stopped: true;
    source?: NetworkDumpSource;
    notes: readonly string[];
  }>
> {
  const state = readNetworkCaptureState(options.scope);
  const { holderRetained } = await stopMetroNetworkCapture(options.scope);
  return {
    stopped: true,
    ...(state ? { source: state.source } : {}),
    notes: [
      ...(state
        ? [
            holderRetained
              ? "The metro-cdp holder did not confirm its exit, so it may still hold the app runtime's debugger connection; a later network start can refuse until it is gone."
              : state.source === 'metro-cdp'
                ? 'The metro-cdp capture is closed and its holder is stopped.'
                : 'The metro-js-hook capture is closed; the app keeps no capture of its own once it reloads.',
          ]
        : ['This session had no armed capture, so nothing was capturing.']),
      'Later network dump calls read the session app log again and label it source=app-log.',
    ],
  };
}
