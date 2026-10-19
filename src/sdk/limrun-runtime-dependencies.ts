import { withSdkCommandHost } from './command-host.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import '../platform-runtime-android-adb-host.ts';
// ProviderDeviceRuntime.getInteractor is synchronous, so this factory is the deliberate static edge;
// making it lazy would require a proxy interactor rather than this seam.
import { createAndroidInteractor } from '../core/interactors/android.ts';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  runAndroidHostAdb,
  scopeAndroidPortReverseManager,
} from '@agent-device/platform-android/mechanics';
import { execFailureDetails, runCmd } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';

export function createLimrunRuntimeDependencies(host: HostEnvironment): LimrunRuntimeDependencies {
  return {
    clientVersion: readVersion(),
    android: {
      createInteractor: (device, adb) =>
        withSdkCommandHost(
          () =>
            withMethodScope(
              createAndroidInteractor(device, adb),
              async (task) => await withSdkCommandHost(task, host),
            ),
          host,
        ),
      createPortReverse: async (adb, options) => {
        return await withSdkCommandHost(async () => {
          const { createAndroidPortReverseManager } =
            await import('@agent-device/platform-android/mechanics');
          return scopeAndroidPortReverseManager(
            createAndroidPortReverseManager(adb, options),
            (target) => withMethodScope(target, (task) => withSdkCommandHost(task, host)),
          );
        }, host);
      },
      inferAppName: async (packageName) => {
        return await withSdkCommandHost(async () => {
          const { inferAndroidAppName } = await import('@agent-device/platform-android/mechanics');
          return inferAndroidAppName(packageName);
        }, host);
      },
      listApps: async (adb, filter) => {
        return await withSdkCommandHost(async () => {
          const { listAndroidAppsWithAdb } =
            await import('@agent-device/platform-android/mechanics');
          return (
            await listAndroidAppsWithAdb(adb, {
              filter,
              target: 'mobile',
            })
          ).map((app) => ({ id: app.package, name: app.name }));
        }, host);
      },
      getForegroundApp: async (_device, adb, signal) => {
        return await withSdkCommandHost(async () => {
          const { getAndroidAppStateWithAdb } = await import('../platform-runtime.ts');
          const app = await getAndroidAppStateWithAdb(
            async (args, options) => await adb(args, { ...options, signal }),
            signal,
          );
          return app.package ? { appId: app.package, activity: app.activity } : undefined;
        }, host);
      },
      getKeyboardState: async (adb) => {
        return await withSdkCommandHost(async () => {
          const { getAndroidKeyboardStatusWithAdb } =
            await import('@agent-device/platform-android/mechanics');
          return await getAndroidKeyboardStatusWithAdb(adb);
        }, host);
      },
      dismissKeyboard: async (adb) => {
        return await withSdkCommandHost(async () => {
          const { dismissAndroidKeyboardWithAdb } =
            await import('@agent-device/platform-android/mechanics');
          return await dismissAndroidKeyboardWithAdb(adb);
        }, host);
      },
      readLogs: async (adb, lineLimit) => {
        return await withSdkCommandHost(async () => {
          const { captureAndroidLogcatWithAdb } =
            await import('@agent-device/platform-android/mechanics');
          return await captureAndroidLogcatWithAdb(adb, {
            lines: lineLimit,
            timeoutMs: 5_000,
          });
        }, host);
      },
      forceStopApp: async (adb, packageName, signal) => {
        return await withSdkCommandHost(async () => {
          const { runAdbShell } = await import('@agent-device/platform-android/mechanics');
          await runAdbShell(
            async (args, options) => await adb(args, { ...options, signal }),
            ['am', 'force-stop', packageName],
            { allowFailure: true },
          );
        }, host);
      },
      deviceAdbInvocation: (serial, command) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command) => androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message, result, invocation) => {
        return await withSdkCommandHost(async () => {
          // Error construction is async so the platform helper remains lazy until an ADB failure.
          const { androidAdbResultError, serializeAndroidAdbInvocation } =
            await import('@agent-device/platform-android/mechanics');
          return androidAdbResultError(
            message,
            result,
            invocation
              ? { command: `adb ${serializeAndroidAdbInvocation(invocation).join(' ')}` }
              : undefined,
          );
        }, host);
      },
    },
    host: {
      runAdb: async (invocation, options) =>
        await withSdkCommandHost(() => runAndroidHostAdb(invocation, options), host),
      downloadFile: async (options) => {
        return await withSdkCommandHost(async () => {
          const { downloadLimrunFile } = await import('./limrun-download-file.ts');
          await downloadLimrunFile(options);
        }, host);
      },
      archiveDirectory: async ({ sourceDirectory, entryName, archivePath }) => {
        return await withSdkCommandHost(async () => {
          const args = ['-qr', archivePath, entryName];
          const result = await runCmd('zip', args, {
            cwd: sourceDirectory,
            timeoutMs: 120_000,
          });
          if (result.exitCode !== 0) {
            throw new AppError('COMMAND_FAILED', 'Failed to package iOS .app for Limrun install', {
              command: ['zip', ...args].join(' '),
              ...execFailureDetails(result),
            });
          }
        }, host);
      },
    },
    ios: {
      applySimctlSetting: async (request) => {
        return await withSdkCommandHost(async () => {
          const { applySimctlSetting } =
            await import('@agent-device/platform-apple/simctl-settings');
          return await applySimctlSetting(request);
        }, host);
      },
      resolveAppAlias: async (app) => {
        return await withSdkCommandHost(async () => {
          const { resolveIosAppAlias } =
            await import('@agent-device/platform-apple/app-resolution');
          return resolveIosAppAlias(app);
        }, host);
      },
      readBundleAppName: async (appPath) => {
        return await withSdkCommandHost(async () => {
          const { readIosBundleInfo } =
            await import('@agent-device/platform-apple/install-artifact');
          return (await readIosBundleInfo(appPath)).appName;
        }, host);
      },
    },
  };
}
