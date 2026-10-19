import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import '../platform-runtime-android-adb-host.ts';
import * as mechanics from '@agent-device/platform-android/mechanics';
import { withSdkCommandHost } from './command-host.ts';
import type { AndroidAdbExecutor } from '@agent-device/platform-android/mechanics';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';

export type {
  AndroidAdbExecutor,
  AndroidAdbExecutorOptions,
  AndroidAdbProvider,
  AndroidPortReverseEndpoint,
  AndroidKeyboardDismissResult,
  AndroidKeyboardState,
} from '@agent-device/platform-android/mechanics';
export type { ShellWord } from '@agent-device/kernel/device-shell';

export const runAndroidShell: typeof mechanics.runAndroidShell = (...args) =>
  withSdkCommandHost(() => mechanics.runAndroidShell(...args));

export const runAndroidExecOut: typeof mechanics.runAndroidExecOut = (...args) =>
  withSdkCommandHost(() => mechanics.runAndroidExecOut(...args));

export const runAdbShell: typeof mechanics.runAdbShell = (...args) =>
  withSdkCommandHost(() => mechanics.runAdbShell(...args));

export const runAdbExecOut: typeof mechanics.runAdbExecOut = (...args) =>
  withSdkCommandHost(() => mechanics.runAdbExecOut(...args));

export const listAndroidAppsWithAdb: typeof mechanics.listAndroidAppsWithAdb = (...args) =>
  withSdkCommandHost(() => mechanics.listAndroidAppsWithAdb(...args));

export const forceStopAndroidAppWithAdb: typeof mechanics.forceStopAndroidAppWithAdb = (...args) =>
  withSdkCommandHost(() => mechanics.forceStopAndroidAppWithAdb(...args));

export const openAndroidAppWithAdb: typeof mechanics.openAndroidAppWithAdb = (...args) =>
  withSdkCommandHost(() => mechanics.openAndroidAppWithAdb(...args));

export const captureAndroidLogcatWithAdb: typeof mechanics.captureAndroidLogcatWithAdb = (
  ...args
) => withSdkCommandHost(() => mechanics.captureAndroidLogcatWithAdb(...args));

export const dismissAndroidKeyboardWithAdb: typeof mechanics.dismissAndroidKeyboardWithAdb = (
  ...args
) => withSdkCommandHost(() => mechanics.dismissAndroidKeyboardWithAdb(...args));

export const getAndroidKeyboardStatusWithAdb: typeof mechanics.getAndroidKeyboardStatusWithAdb = (
  ...args
) => withSdkCommandHost(() => mechanics.getAndroidKeyboardStatusWithAdb(...args));

export const readAndroidClipboardWithAdb: typeof mechanics.readAndroidClipboardWithAdb = (
  ...args
) => withSdkCommandHost(() => mechanics.readAndroidClipboardWithAdb(...args));

export const writeAndroidClipboardWithAdb: typeof mechanics.writeAndroidClipboardWithAdb = (
  ...args
) => withSdkCommandHost(() => mechanics.writeAndroidClipboardWithAdb(...args));

export function createAndroidPortReverseManager(
  provider: mechanics.AndroidAdbProvider | AndroidAdbExecutor,
): ReturnType<typeof mechanics.createAndroidPortReverseManager>;
export function createAndroidPortReverseManager(
  ...args: Parameters<typeof mechanics.createAndroidPortReverseManager>
): ReturnType<typeof mechanics.createAndroidPortReverseManager>;
export function createAndroidPortReverseManager(
  provider: mechanics.AndroidAdbProvider | AndroidAdbExecutor,
  options?: Parameters<typeof mechanics.createAndroidPortReverseManager>[1],
): ReturnType<typeof mechanics.createAndroidPortReverseManager> {
  return withSdkCommandHost((host) => {
    const manager =
      options && typeof provider === 'function'
        ? mechanics.createAndroidPortReverseManager(provider, options)
        : mechanics.createAndroidPortReverseManager(provider);
    return mechanics.scopeAndroidPortReverseManager(manager, (target) =>
      withMethodScope(target, (task) => withSdkCommandHost(task, host)),
    );
  });
}

export async function getAndroidAppStateWithAdb(
  adb: AndroidAdbExecutor,
  signal?: AbortSignal,
): Promise<AppStateRuntimeResult> {
  return await withSdkCommandHost(async () => {
    const { getAndroidAppStateWithAdb: read } = await import('../platform-runtime.ts');
    return await read(adb, signal);
  });
}
