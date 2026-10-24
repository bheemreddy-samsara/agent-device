import type { CliFlags } from '@agent-device/contracts/command';
import type { NetworkCaptureCommandOptions } from '@agent-device/react-native';
import { AppError } from '@agent-device/kernel/errors';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { writeCliOutput } from './shared.ts';
import { observabilityCliOutputFormatters } from '../../commands/observability/output.ts';

const DEFAULT_DUMP_LIMIT = 25;

/**
 * The React Native network capture, run where its dev server is reachable: in this CLI process.
 *
 * `network start` chooses one capture source, `network dump` reads only that source and names it, and
 * `network stop` closes it. This runner sits beside `react-devtools` for the same reason it does: it
 * works against a remote daemon and against a device reached through the Metro companion tunnel,
 * because in both cases this host is the machine that can reach the app dev server's debugger socket.
 *
 * Returns false when no live capture can answer here, which is how a `network dump` with nothing
 * armed keeps its daemon route and reports the session app log.
 */
export async function runNetworkCaptureCommand(
  params: Readonly<{
    positionals: string[];
    flags: CliFlags;
    sessionName: string;
    stateDir: string;
  }>,
): Promise<boolean> {
  const action = (params.positionals[0] ?? 'dump').toLowerCase();
  if (action !== 'start' && action !== 'dump' && action !== 'stop') return false;
  const options = captureOptions(params);
  const capture = await import('@agent-device/react-native');
  if (action === 'start') {
    await writeCaptureResult(params.flags, await capture.runNetworkCaptureStart(options));
    return true;
  }
  if (action === 'stop') {
    await writeCaptureResult(params.flags, await capture.runNetworkCaptureStop(options));
    return true;
  }
  if (!capture.readArmedNetworkCapture(options)) return false;
  await writeCaptureResult(
    params.flags,
    await capture.runNetworkCaptureDump(options, {
      maxEntries: readDumpLimit(params.positionals[1]),
    }),
  );
  return true;
}

function captureOptions(
  params: Parameters<typeof runNetworkCaptureCommand>[0],
): NetworkCaptureCommandOptions {
  return {
    scope: { stateDir: params.stateDir, session: params.sessionName },
    // The detached holder inherits this process's environment, as every detached process does.
    host: captureHostEnvironment(process),
    ...(params.flags.targetApp ? { appBundleId: params.flags.targetApp } : {}),
    // `--device` names the device to capture on, which is how the dev server's runtime list narrows
    // when more than one app runtime is connected to it.
    ...(params.flags.device ? { metroDevice: params.flags.device } : {}),
    ...(params.flags.networkInclude ? { include: params.flags.networkInclude } : {}),
    // The dev server flags name the server directly, so a session that never recorded one can still
    // start a capture on the app runtime the caller can reach from this host.
    ...metroServerFromFlags(params.flags),
  };
}

function metroServerFromFlags(
  flags: CliFlags,
): Readonly<{ metro: { metroHost?: string; metroPort?: number; bundleUrl?: string } }> {
  return {
    metro: {
      ...(flags.metroHost ? { metroHost: flags.metroHost } : {}),
      ...(flags.metroPort ? { metroPort: flags.metroPort } : {}),
      ...(flags.bundleUrl ? { bundleUrl: flags.bundleUrl } : {}),
    },
  };
}

function readDumpLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DUMP_LIMIT;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AppError('INVALID_ARGS', 'network dump limit must be an integer in range 1..200');
  }
  return limit;
}

async function writeCaptureResult(
  flags: CliFlags,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  const output = await observabilityCliOutputFormatters.network({
    input: {},
    result: data,
    env: process.env as Record<string, string | undefined>,
  });
  await writeCliOutput(flags, output);
}
