/**
 * Shared vocabulary for `network start` / `network dump` / `network stop`.
 *
 * One capture source serves one session, chosen when capture starts. A dump reads only that
 * source and reports it. With no capture started, a dump keeps the app-log parse and labels it
 * `app-log`. A source that needs the app relaunched says so with `requiresRelaunch`; it never
 * relaunches silently.
 */

/**
 * Where one armed capture keeps its state, relative to the agent-device state dir.
 *
 * `metro-cdp` captures through the dev server's debugger, `metro-js-hook` through a hook installed
 * in the app's own JavaScript runtime. Both are chosen at start and reported on every dump.
 */
export const NETWORK_CAPTURE_SOURCES = ['metro-cdp', 'metro-js-hook'] as const;
export type NetworkCaptureSource = (typeof NETWORK_CAPTURE_SOURCES)[number];

/** What one `network dump` reports as its source, including the un-armed app-log parse. */
export type NetworkDumpSource = NetworkCaptureSource | 'app-log';

/**
 * Where a React Native armed capture keeps its state, relative to the agent-device state dir.
 * Named for the runtime that owns it, so it never shares a directory with another source's state.
 */
export const NETWORK_CAPTURE_STATE_DIR = 'network-capture-metro';

/**
 * The payload budget one armed capture applies to the text it keeps. It matches the budget the
 * app-log parse uses, so a dump reads the same size whichever source answers it.
 */
export const NETWORK_CAPTURE_MAX_PAYLOAD_CHARS = 2048;

/**
 * The runtime binding one live capture owns. Every later read must reach this same target; when it
 * is gone or was replaced, the read fails closed instead of following the app onto another runtime.
 */
export type NetworkCaptureBinding = Readonly<{
  /** The dev server the target registered on, as the session's Metro binding reports it. */
  serverUrl: string;
  /** Bundle id or package name, as the dev server reports it. */
  appId: string;
  /** The dev server's device identity for the target. */
  logicalDeviceId: string;
  /** The `/json/list` target id the capture was armed on. */
  targetId: string;
  deviceName?: string;
}>;

/**
 * The state one armed capture writes for its session. A provider-native source records its own
 * `source` and the fields it needs; every source keeps `source`, `session`, `startedAt`, and
 * `binding`, so `network dump` can route without knowing that source.
 */
export type NetworkCaptureState = Readonly<{
  source: NetworkCaptureSource;
  session: string;
  startedAt: number;
  binding: NetworkCaptureBinding;
  /** The live connection holder's pid, when the source keeps one. */
  pid?: number;
  /** Whether the source keeps request and response bodies. Bodies are opt-in at start. */
  includesBodies: boolean;
  /** Payload budget the source applies to what it keeps. */
  maxPayloadChars: number;
  requiresRelaunch?: boolean;
  /** Set when a JavaScript reload replaced the bound target and the holder re-armed once. */
  rearmedAt?: number;
}>;

export const NETWORK_CAPTURE_TYPED_REASONS = {
  /** Several app runtimes match the session and nothing narrows them. */
  ambiguous: 'metro-runtime-ambiguous',
  /** The bound target no longer registers on the dev server. */
  targetGone: 'metro-runtime-gone',
  /** The bound device now runs another app, so the armed capture no longer covers this session. */
  targetReplaced: 'metro-runtime-replaced',
  /** The session has no Metro dev-server binding, so the React Native source cannot apply. */
  metroBindingMissing: 'metro-binding-missing',
  /** The app runtime's CDP implementation has no `Network` domain, so a CDP capture cannot run. */
  cdpNetworkUnsupported: 'metro-cdp-network-unsupported',
  /** The session has no armed capture, so a live read cannot answer. */
  captureNotStarted: 'network-capture-not-started',
  /** A capture is already armed for this session. */
  captureAlreadyArmed: 'network-capture-already-armed',
  /** The capture holder stopped while its state still claimed it was capturing. */
  captureLost: 'network-capture-lost',
  /** The capture lives in the CLI process, so another surface cannot read it. */
  cliRequired: 'network-capture-cli-required',
} as const;
