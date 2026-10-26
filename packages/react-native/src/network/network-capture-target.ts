import { AppError } from '@agent-device/kernel/errors';
import type { NetworkCaptureBinding } from '@agent-device/contracts/network-capture';
import { NETWORK_CAPTURE_TYPED_REASONS } from '@agent-device/contracts/network-capture';
import {
  listMetroInspectorTargets,
  selectReactNativeCaptureTarget,
  targetAppId,
  type MetroInspectorTarget,
} from '../react-devtools/metro-inspector.ts';
import { bindingMatchesTarget, logicalDeviceFromTargetId } from './cdp-network-buffer.ts';

/** The runtime one capture owns, chosen from the dev server's own target list. */
export type ResolvedCaptureTarget = Readonly<{
  target: MetroInspectorTarget;
  binding: NetworkCaptureBinding;
}>;

/**
 * Chooses the app runtime a capture will bind to. Exactly one runtime for the app wins; several
 * devices narrow by the caller's or the session's device name; anything still ambiguous fails closed
 * as `metro-runtime-ambiguous` and lists the candidates.
 */
export async function resolveNetworkCaptureTarget(
  serverUrl: URL,
  filter: { appId?: string; device?: string },
): Promise<ResolvedCaptureTarget> {
  const target = selectReactNativeCaptureTarget(await listMetroInspectorTargets(serverUrl), filter);
  return { target, binding: bindingForTarget(serverUrl, target) };
}

function bindingForTarget(serverUrl: URL, target: MetroInspectorTarget): NetworkCaptureBinding {
  return {
    serverUrl: serverUrl.toString(),
    appId: targetAppId(target),
    logicalDeviceId: target.reactNative?.logicalDeviceId ?? logicalDeviceFromTargetId(target.id),
    targetId: target.id,
    ...(target.deviceName ? { deviceName: target.deviceName } : {}),
  };
}

/**
 * What the dev server's target list now says about the runtime one capture is bound to.
 *
 * A React Native runtime that reloads its JavaScript keeps its device and app and registers a new
 * target id, which is the one change a capture can follow — a holder that re-arms on it can keep
 * capturing and must say the window it holds starts after the reload. Every other answer ends the
 * capture: a device that now runs another app is not this session's traffic, and a device that no
 * longer registers has nothing to read.
 */
export type BoundTargetReading =
  | Readonly<{ status: 'bound'; target: MetroInspectorTarget }>
  | Readonly<{ status: 'reloaded'; target: MetroInspectorTarget }>
  | Readonly<{ status: 'app-changed' }>
  | Readonly<{ status: 'gone' }>;

/** Re-reads the dev server's target list and answers for the target the capture is bound to. */
export async function readBoundCaptureTarget(
  binding: NetworkCaptureBinding,
): Promise<BoundTargetReading> {
  const targets = await listMetroInspectorTargets(new URL(binding.serverUrl));
  const bound = targets.find((target) => bindingMatchesTarget(binding, target));
  if (bound) {
    return targetAppId(bound) === binding.appId
      ? { status: 'bound', target: bound }
      : { status: 'app-changed' };
  }
  const replacement = targets.find(
    (target) =>
      (target.reactNative?.logicalDeviceId ?? logicalDeviceFromTargetId(target.id)) ===
        binding.logicalDeviceId && targetAppId(target) === binding.appId,
  );
  return replacement ? { status: 'reloaded', target: replacement } : { status: 'gone' };
}

/**
 * Fails closed on a runtime the holder cannot follow, naming what the caller can do next. A second
 * reload is refused because the first one already cost this capture a window it cannot reconstruct.
 */
export function boundTargetLost(
  reading: Exclude<BoundTargetReading, Readonly<{ status: 'bound' }>>,
): AppError {
  const reasons = {
    'app-changed': {
      reason: NETWORK_CAPTURE_TYPED_REASONS.targetReplaced,
      message:
        'The app runtime this network capture was armed on now reports a different app, so this capture no longer covers the session.',
    },
    reloaded: {
      reason: NETWORK_CAPTURE_TYPED_REASONS.targetGone,
      message:
        'The app runtime this network capture was armed on reloaded its JavaScript again, and a capture follows one reload because the first already cost it a window it cannot reconstruct.',
    },
    gone: {
      reason: NETWORK_CAPTURE_TYPED_REASONS.targetGone,
      message:
        'The app runtime this network capture was armed on is no longer connected to the dev server.',
    },
  } as const;
  const failure = reasons[reading.status];
  return new AppError('UNSUPPORTED_OPERATION', failure.message, {
    reason: failure.reason,
    hint: 'Run network stop and network start again to bind the capture to the runtime the app uses now.',
  });
}

/** The in-app buffer cannot outlive the runtime that held it, so a reload ends that capture. */
export function boundRuntimeReloaded(): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    'The app runtime this network capture was armed on reloaded its JavaScript, which discarded the in-app capture buffer with it.',
    {
      reason: NETWORK_CAPTURE_TYPED_REASONS.targetGone,
      hint: 'Run network stop and network start again to install the capture on the runtime the app uses now.',
    },
  );
}

/** The typed reason a capture failure carries, so a holder can record what it told its readers. */
export function typedFailureReason(error: unknown): string | undefined {
  return error instanceof AppError && typeof error.details?.reason === 'string'
    ? error.details.reason
    : undefined;
}
