import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { runCmdDetached } from '@agent-device/host-kit/command';
import { hostNodeExecutablePath, isProcessAlive } from '@agent-device/host-kit/process';
import { NETWORK_CAPTURE_TYPED_REASONS } from '@agent-device/contracts/network-capture';
import {
  networkCaptureHolderLogPath,
  readNetworkCaptureHolderStatus,
  type NetworkCaptureScope,
} from './network-capture-state.ts';
import { HOLDER_ENV_SESSION, HOLDER_ENV_STATE_DIR } from './network-capture-holder-process.ts';
import { askNetworkCaptureHolder } from './network-capture-socket.ts';

/** The entry the detached holder runs, without its extension. */
const HOLDER_ENTRYPOINT = 'network-capture-holder';

const HOLDER_READY_TIMEOUT_MS = 15_000;
const HOLDER_READY_POLL_MS = 100;

/**
 * Starts the detached holder for one session's CDP capture and waits until it answers.
 *
 * The CDP `Network` domain emits only while a debugger connection is open, so the connection has to
 * outlive the `network start` process: the holder keeps it, and every `network dump` drains it over
 * the session's socket. Waiting for the first answer is what makes `network start` honest — a holder
 * that cannot reach the runtime fails here, before the command reports a capture as armed.
 */
export async function spawnNetworkCaptureHolder(
  scope: NetworkCaptureScope,
  /** The caller's environment, which the holder inherits; the caller captured it from its process. */
  host: HostEnvironment,
): Promise<number> {
  const modulePath = resolveNetworkCaptureHolderEntryPath();
  const logPath = networkCaptureHolderLogPath(scope);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  // The holder's stderr lands here, and the process's umask does not carry into a file its parent
  // opens; say the mode here.
  fs.fchmodSync(logFd, 0o600);
  let pid = 0;
  try {
    pid = runCmdDetached(hostNodeExecutablePath(), holderExecArgs(modulePath), {
      cwd: host.cwd,
      env: {
        ...host.env,
        [HOLDER_ENV_STATE_DIR]: scope.stateDir,
        [HOLDER_ENV_SESSION]: scope.session,
      },
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError('COMMAND_FAILED', 'The network capture holder process did not start.', {
      reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost,
      hint: `Its output is in ${logPath}.`,
    });
  }
  const failure = await waitForNetworkCaptureHolder(pid, scope);
  if (failure) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `The network capture holder could not hold the app runtime's network domain: ${failure.message}`,
      {
        reason: failure.reason,
        hint: `Its output is in ${logPath}.`,
      },
    );
  }
  return pid;
}

/**
 * Polls the holder until it answers `stats`, so the caller learns whether the runtime accepted
 * `Network.enable`. A holder that exits is not retried: its exit reason is the answer.
 */
async function waitForNetworkCaptureHolder(
  pid: number,
  scope: NetworkCaptureScope,
): Promise<Readonly<{ reason: string; message: string }> | undefined> {
  const deadline = Date.now() + HOLDER_READY_TIMEOUT_MS;
  let lastFailure = unreadable('the holder never answered its socket');
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return exitedBeforeAnswer(pid, scope, lastFailure);
    const attempt = await probeNetworkCaptureHolder(scope);
    if (attempt.answered) return undefined;
    lastFailure = attempt;
    // Only "nobody is listening yet" is worth polling. Every other refusal is the holder's final
    // answer, and it is carried through with the reason the holder gave.
    if (attempt.reason !== NETWORK_CAPTURE_TYPED_REASONS.captureLost) return attempt;
    await sleep(HOLDER_READY_POLL_MS);
  }
  return {
    reason: lastFailure.reason,
    message: `the holder did not answer within ${HOLDER_READY_TIMEOUT_MS}ms (${lastFailure.message})`,
  };
}

type HolderProbeFailure = Readonly<{ reason: string; message: string }>;

function unreadable(message: string): HolderProbeFailure {
  return { reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost, message };
}

/** One readiness probe of the holder's socket: an answer, or the refusal with its reason. */
async function probeNetworkCaptureHolder(
  scope: NetworkCaptureScope,
): Promise<Readonly<{ answered: true }> | (Readonly<{ answered: false }> & HolderProbeFailure)> {
  try {
    await askNetworkCaptureHolder(scope, { action: 'stats' }, 2_000);
    return { answered: true };
  } catch (error) {
    const reason =
      error instanceof AppError && typeof error.details?.reason === 'string'
        ? error.details.reason
        : NETWORK_CAPTURE_TYPED_REASONS.captureLost;
    return {
      answered: false,
      reason,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Why the wait ends when the holder's process is simply gone. */
function exitedBeforeAnswer(
  pid: number,
  scope: NetworkCaptureScope,
  lastFailure: HolderProbeFailure,
): HolderProbeFailure {
  // The holder records why it gave up before it exits, keyed to its own pid; a record from an
  // older holder describes a different process. Without a matching record, all that is known is
  // that this process is gone.
  const ended = readNetworkCaptureHolderStatus(scope);
  return {
    reason: ended?.pid === pid && ended.reason !== undefined ? ended.reason : lastFailure.reason,
    message: `the holder process exited before it answered (pid ${pid})`,
  };
}

function holderExecArgs(modulePath: string): string[] {
  return modulePath.endsWith('.ts') ? ['--experimental-strip-types', modulePath] : [modulePath];
}

/**
 * Finds the holder entry beside this module, in whichever layout the caller is running from: the
 * workspace's `src` tree under type stripping, or the build's `dist` tree. Mirrors how the companion
 * tunnel finds its entry, because both are detached processes started from either layout.
 */
function resolveNetworkCaptureHolderEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extension = path.extname(fileURLToPath(import.meta.url)) || '.js';
  const candidates = [
    path.join(here, `${HOLDER_ENTRYPOINT}${extension}`),
    path.join(here, 'internal', `${HOLDER_ENTRYPOINT}${extension}`),
  ];
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  if (!entry) {
    throw new AppError(
      'COMMAND_FAILED',
      'The network capture holder entry was not found beside the React Native runtime module.',
      {
        reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost,
        hint: 'Rebuild agent-device so the holder entry is part of the install.',
        candidates,
      },
    );
  }
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
