import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const resolveAndroidApp = vi.hoisted(() => vi.fn());
const getAndroidAppState = vi.hoisted(() => vi.fn());
const runAndroidShell = vi.hoisted(() => vi.fn());

vi.mock('./app-deployment-resolution.ts', () => ({ resolveAndroidApp }));
vi.mock('./window-state.ts', () => ({ getAndroidAppState }));
vi.mock('./adb.ts', () => ({ runAndroidShell }));

const { resolveAndroidPackageForOpen, inferAndroidPackageAfterOpen } =
  await import('./open-target-resolution.ts');

const androidDevice: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
};
const appleDevice: DeviceInfo = {
  platform: 'apple',
  id: '00000000-0000-0000-0000-000000000000',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

test('resolveAndroidPackageForOpen returns the resolved package for a package match', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'package', value: 'com.example.demo' });

  await expect(resolveAndroidPackageForOpen(androidDevice, 'demo')).resolves.toBe(
    'com.example.demo',
  );
  expect(runAndroidShell).not.toHaveBeenCalled();
});

test('resolveAndroidPackageForOpen retains the native requested intent package without adopting foreground Search', async () => {
  const deployment = await vi.importActual<typeof import('./app-deployment-resolution.ts')>(
    './app-deployment-resolution.ts',
  );
  resolveAndroidApp.mockImplementationOnce(deployment.resolveAndroidApp);

  runAndroidShell.mockResolvedValue({
    stdout: 'priority=0 preferredOrder=0 match=0x108000\ncom.android.settings/.Settings\n',
    stderr: '',
    exitCode: 0,
  });
  getAndroidAppState.mockResolvedValue({
    package: 'com.google.android.settings.intelligence',
    activity: '.search.SearchActivity',
  });
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBe(
    'com.android.settings',
  );
  expect(runAndroidShell).toHaveBeenCalledWith(
    androidDevice,
    [
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.settings.SETTINGS',
      '-c',
      'android.intent.category.DEFAULT',
    ],
    { allowFailure: true, timeoutMs: 2_000 },
  );
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test.each([
  'No activity found',
  'com.android.settings/Invalid-Class',
  'wrong-package/.Settings',
  '/data/apps/settings.apk',
  'warning /not/a/component',
  'com.android.settings/',
])(
  'intent package ownership refuses malformed or unresolved native component %s',
  async (stdout) => {
    resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
    runAndroidShell.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBeUndefined();
    expect(getAndroidAppState).not.toHaveBeenCalled();
  },
);

test('intent package ownership does not adopt a component from a failed native resolution', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockResolvedValue({
    stdout: 'com.android.settings/.Settings',
    stderr: '',
    exitCode: 1,
  });
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBeUndefined();
});

test('intent package ownership reads its native handler rather than assuming the Settings package', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockResolvedValue({
    stdout: 'com.vendor.settings/org.vendor.Settings$Panel',
    stderr: '',
    exitCode: 0,
  });
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBe(
    'com.vendor.settings',
  );
});

test('intent resolution retains unknown ownership on an ADB failure', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockRejectedValue(new AppError('COMMAND_FAILED', 'ADB unavailable'));
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings')).resolves.toBeUndefined();
});

test('resolveAndroidPackageForOpen swallows resolution failures', async () => {
  resolveAndroidApp.mockRejectedValue(new AppError('APP_NOT_INSTALLED', 'No package found'));

  await expect(resolveAndroidPackageForOpen(androidDevice, 'demo')).resolves.toBeUndefined();
  expect(resolveAndroidApp).toHaveBeenCalled();
});

test('resolveAndroidPackageForOpen skips non-Android devices without resolving', async () => {
  await expect(resolveAndroidPackageForOpen(appleDevice, 'demo')).resolves.toBeUndefined();
  expect(resolveAndroidApp).not.toHaveBeenCalled();
});

test('resolveAndroidPackageForOpen skips a deep-link target without resolving', async () => {
  await expect(
    resolveAndroidPackageForOpen(androidDevice, 'myapp://login'),
  ).resolves.toBeUndefined();
  expect(resolveAndroidApp).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen reads the foreground package for a deep-link open', async () => {
  getAndroidAppState.mockResolvedValue({
    package: 'host.exp.exponent',
    activity: 'host.exp.exponent.experience.ExperienceActivity',
  });

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBe('host.exp.exponent');
});

test('inferAndroidPackageAfterOpen keeps an already-known bundle id without reading state', async () => {
  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', 'com.example.demo'),
  ).resolves.toBe('com.example.demo');
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen leaves a non-deep-link target unchanged', async () => {
  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'com.example.demo', undefined),
  ).resolves.toBeUndefined();
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('inferAndroidPackageAfterOpen swallows a foreground-state read failure', async () => {
  getAndroidAppState.mockRejectedValue(new Error('adb connection dropped'));

  await expect(
    inferAndroidPackageAfterOpen(androidDevice, 'exp://127.0.0.1:8082', undefined),
  ).resolves.toBeUndefined();
});
