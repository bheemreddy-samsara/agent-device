import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import {
  NETWORK_CAPTURE_STATE_DIR,
  NETWORK_CAPTURE_TYPED_REASONS,
  type NetworkCaptureSource,
  type NetworkCaptureState,
} from '@agent-device/contracts/network-capture';

/**
 * Where one session's armed capture lives, and how its surfaces find each other.
 *
 * Both files sit beside the session's Metro binding in the host's state dir, because the React
 * Native capture is driven from there, and each has exactly one writer:
 *
 * - the state file, written by `network start` and cleared by `network stop`, records the chosen
 *   source, the runtime it bound, and the live holder's pid;
 * - the holder file, written by the holder alone, records what the holder knows only while it runs:
 *   that it followed a JavaScript reload, or why it ended.
 *
 * A reader trusts neither file alone: the holder's pid decides whether a capture is live.
 */
export type NetworkCaptureScope = Readonly<{ stateDir: string; session: string }>;

/** The holder's own status, written only by the holder process. */
export type NetworkCaptureHolderStatus = Readonly<{
  pid: number;
  status: 'capturing' | 'ended';
  /** The target id the holder is capturing, which a JavaScript reload changes. */
  targetId?: string;
  /** When the holder re-armed on the replacement target of a reloaded runtime. */
  rearmedAt?: number;
  /** Why the holder ended, so a later read names it instead of guessing. */
  reason?: string;
}>;

/**
 * One session's capture files share this base name.
 *
 * A long session name is shortened with a digest rather than truncated, because three surfaces
 * address the same capture by name and a collision would hand one session another's traffic. The
 * bound also keeps the socket path inside the 104-byte limit a unix socket address has on macOS.
 */
export function networkCaptureFileBase(session: string): string {
  const safe = safeSessionName(session);
  if (safe.length <= NETWORK_CAPTURE_FILE_BASE_MAX) return safe;
  return `${safe.slice(0, 23)}-${createHash('sha256').update(safe).digest('hex').slice(0, 16)}`;
}

const NETWORK_CAPTURE_FILE_BASE_MAX = 40;

export function networkCaptureStatePath(scope: NetworkCaptureScope): string {
  return path.join(
    scope.stateDir,
    NETWORK_CAPTURE_STATE_DIR,
    `${networkCaptureFileBase(scope.session)}.json`,
  );
}

export function networkCaptureHolderPath(scope: NetworkCaptureScope): string {
  return path.join(
    scope.stateDir,
    NETWORK_CAPTURE_STATE_DIR,
    `${networkCaptureFileBase(scope.session)}.holder.json`,
  );
}

/** Where the live holder answers drains, binds, and takes its stop request. */
export function networkCaptureSocketPath(scope: NetworkCaptureScope): string {
  return path.join(
    scope.stateDir,
    NETWORK_CAPTURE_STATE_DIR,
    `${networkCaptureFileBase(scope.session)}.sock`,
  );
}

/** Where the detached holder's own stdout and stderr go, for the hint that names it on failure. */
export function networkCaptureHolderLogPath(scope: NetworkCaptureScope): string {
  return path.join(
    scope.stateDir,
    NETWORK_CAPTURE_STATE_DIR,
    `${networkCaptureFileBase(scope.session)}.holder.log`,
  );
}

export function writeNetworkCaptureState(
  scope: NetworkCaptureScope,
  state: NetworkCaptureState,
): void {
  writeJsonFile(networkCaptureStatePath(scope), state);
}

/** The armed capture for this session, or undefined when none was written or it is unreadable. */
export function readNetworkCaptureState(
  scope: NetworkCaptureScope,
): NetworkCaptureState | undefined {
  return readCaptureState(readJsonFile(networkCaptureStatePath(scope)));
}

export function writeNetworkCaptureHolderStatus(
  scope: NetworkCaptureScope,
  status: NetworkCaptureHolderStatus,
): void {
  writeJsonFile(networkCaptureHolderPath(scope), status);
}

export function readNetworkCaptureHolderStatus(
  scope: NetworkCaptureScope,
): NetworkCaptureHolderStatus | undefined {
  const record = readJsonFile(networkCaptureHolderPath(scope));
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = record as Record<string, unknown>;
  if (typeof value.pid !== 'number') return undefined;
  if (value.status !== 'capturing' && value.status !== 'ended') return undefined;
  return {
    pid: value.pid,
    status: value.status,
    ...(typeof value.targetId === 'string' ? { targetId: value.targetId } : {}),
    ...(typeof value.rearmedAt === 'number' ? { rearmedAt: value.rearmedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

/** Ends one session's capture and removes everything its surfaces exchange. */
export function clearNetworkCaptureState(scope: NetworkCaptureScope): void {
  for (const file of [
    networkCaptureStatePath(scope),
    networkCaptureHolderPath(scope),
    networkCaptureSocketPath(scope),
    networkCaptureHolderLogPath(scope),
  ]) {
    fs.rmSync(file, { force: true });
  }
}

/** An armed capture whose holder is gone is not capturing, whatever its state file claims. */
export function networkCaptureHolderAlive(state: NetworkCaptureState): boolean {
  if (state.pid === undefined) return true;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch (error) {
    // A live process owned by another user answers EPERM rather than ESRCH, and a recycled pid can
    // land on one. Only "no such process" ends a capture; a capture that cannot be probed is read as
    // live, so a reader still hears about it from the holder instead of silently re-arming.
    return (error as Readonly<{ code?: string }>).code === 'EPERM';
  }
}

export function networkCaptureNotStarted(): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    'This session has no armed network capture, so no live source can answer for it.',
    {
      reason: NETWORK_CAPTURE_TYPED_REASONS.captureNotStarted,
      hint: 'Run network start first. Without it, network dump reports the session app log and labels it source=app-log.',
    },
  );
}

export function networkCaptureLost(reason: string | undefined): AppError {
  const ended = reason === undefined ? '' : ` The capture holder reported: ${reason}.`;
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `The network capture armed for this session is no longer running, so this dump cannot answer for the window it covered.${ended}`,
    {
      reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost,
      hint: 'Run network start again to arm a capture on the runtime the app uses now.',
    },
  );
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The state a caller can route on: a source, a session, and the runtime it is bound to. */
function readCaptureState(value: unknown): NetworkCaptureState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const binding = record.binding;
  if (!isCaptureSource(record.source)) return undefined;
  if (
    typeof record.session !== 'string' ||
    typeof record.startedAt !== 'number' ||
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding)
  ) {
    return undefined;
  }
  const target = binding as Record<string, unknown>;
  if (
    typeof target.serverUrl !== 'string' ||
    typeof target.appId !== 'string' ||
    typeof target.logicalDeviceId !== 'string' ||
    typeof target.targetId !== 'string'
  ) {
    return undefined;
  }
  return {
    source: record.source,
    session: record.session,
    startedAt: record.startedAt,
    binding: {
      serverUrl: target.serverUrl,
      appId: target.appId,
      logicalDeviceId: target.logicalDeviceId,
      targetId: target.targetId,
      ...(typeof target.deviceName === 'string' ? { deviceName: target.deviceName } : {}),
    },
    ...(typeof record.pid === 'number' ? { pid: record.pid } : {}),
    includesBodies: record.includesBodies === true,
    maxPayloadChars: typeof record.maxPayloadChars === 'number' ? record.maxPayloadChars : 2048,
    ...(record.requiresRelaunch === true ? { requiresRelaunch: true } : {}),
    ...(typeof record.rearmedAt === 'number' ? { rearmedAt: record.rearmedAt } : {}),
  };
}

function isCaptureSource(value: unknown): value is NetworkCaptureSource {
  return value === 'metro-cdp' || value === 'metro-js-hook';
}
