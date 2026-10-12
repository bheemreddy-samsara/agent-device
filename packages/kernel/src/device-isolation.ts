import path from 'node:path';
import { AppError } from './errors.ts';

const DAEMON_IOS_SIMULATOR_DEVICE_SET_ENV = 'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET';

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveIosSimulatorDeviceSetPath(
  flagValue: string | undefined,
): string | undefined {
  return normalizeNonEmpty(flagValue);
}

/**
 * The simulator set a daemon request reaches. `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` in the
 * daemon's environment is the operator's set: it applies to every request that names none, and a
 * request naming another set is refused because it would reach simulators outside it.
 */
export function resolveRequestIosSimulatorDeviceSetPath(
  requestedValue: string | undefined,
): string | undefined {
  const requested = normalizeNonEmpty(requestedValue);
  const operatorSet = normalizeNonEmpty(process.env[DAEMON_IOS_SIMULATOR_DEVICE_SET_ENV]);
  if (!operatorSet) return requested;
  if (requested && path.resolve(requested) !== path.resolve(operatorSet)) {
    throw new AppError(
      'INVALID_ARGS',
      `This daemon only reaches iOS simulators in the set "${operatorSet}" (${DAEMON_IOS_SIMULATOR_DEVICE_SET_ENV}), but the request named --ios-simulator-device-set "${requested}".`,
      {
        reason: 'ios_simulator_device_set_outside_daemon_set',
        hint: `Omit --ios-simulator-device-set, or pass "${operatorSet}".`,
      },
    );
  }
  return operatorSet;
}

export function parseSerialAllowlist(value: string): Set<string> {
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function resolveAndroidSerialAllowlist(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | undefined {
  const configured =
    normalizeNonEmpty(flagValue) ?? normalizeNonEmpty(env.AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST);
  if (!configured) return undefined;
  return parseSerialAllowlist(configured);
}
