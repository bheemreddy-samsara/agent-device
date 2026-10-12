import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveAndroidApp } from './app-deployment-resolution.ts';
import { getAndroidAppState } from './window-state.ts';
import { runAndroidShell } from './adb.ts';
import { androidActivityComponent, parseAndroidLaunchComponent } from './app-lifecycle.ts';

const INTENT_PACKAGE_RESOLUTION_TIMEOUT_MS = 2_000;

/** Resolves an ADB app open to its package or the native handler of its requested intent. */
export async function resolveAndroidPackageForOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
): Promise<string | undefined> {
  if (device.platform !== 'android' || !openTarget || isDeepLinkTarget(openTarget))
    return undefined;
  try {
    const resolved = await resolveAndroidApp(device, openTarget);
    if (resolved.type === 'package') return resolved.value;
    const result = await runAndroidShell(
      device,
      [
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        resolved.value,
        '-c',
        'android.intent.category.DEFAULT',
      ],
      { allowFailure: true, timeoutMs: INTENT_PACKAGE_RESOLUTION_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return undefined;
    const component = parseAndroidLaunchComponent(result.stdout);
    if (!component) return undefined;
    const packageName = component.split('/')[0];
    if (!packageName || androidActivityComponent(packageName, component) !== component)
      return undefined;
    return packageName;
  } catch {
    return undefined;
  }
}

/** A deep-link open can foreground a different package than the one requested; read it back. */
export async function inferAndroidPackageAfterOpen(
  device: DeviceInfo,
  openTarget: string | undefined,
  currentAppBundleId: string | undefined,
): Promise<string | undefined> {
  if (currentAppBundleId) return currentAppBundleId;
  if (device.platform !== 'android' || !openTarget || !isDeepLinkTarget(openTarget)) {
    return currentAppBundleId;
  }
  try {
    const foreground = await getAndroidAppState(device);
    return foreground.package?.trim() || currentAppBundleId;
  } catch {
    return currentAppBundleId;
  }
}
