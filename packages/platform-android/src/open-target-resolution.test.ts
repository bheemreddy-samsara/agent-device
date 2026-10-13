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
      '--query-flags',
      '0x10000',
      '-a',
      'android.settings.SETTINGS',
    ],
    { allowFailure: true, timeoutMs: 2_000 },
  );
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('intent launch and ownership retain intent overrides and extra values that resemble launch controls', async () => {
  const { openAndroidApp } = await import('./app-lifecycle.ts');
  const launchArgs = [
    '-n',
    'com.example.app/.MainActivity',
    '-p',
    'com.example.app',
    '-d',
    'content://example/settings',
    '-t',
    'text/plain',
    '-c',
    'com.example.CUSTOM',
    '--user',
    '10',
    '--es',
    'launch_control',
    '--display',
    '--esn',
    '-S',
    '--ei',
    'offset',
    '-1',
  ];
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockImplementation(async (_device, args: string[]) => ({
    stdout: args.includes('com.example.app/.MainActivity')
      ? 'com.example.app/.MainActivity'
      : 'com.android.settings/.Settings',
    stderr: '',
    exitCode: 0,
  }));

  await openAndroidApp(androidDevice, 'settings', { launchArgs });
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings', launchArgs)).resolves.toBe(
    'com.example.app',
  );
  const commands = runAndroidShell.mock.calls.map((call) => call[1]);
  const intentArgs = ['-a', 'android.settings.SETTINGS', ...launchArgs];
  expect(commands[0]).toEqual(['am', 'start', '-W', ...intentArgs]);
  expect(commands[1]).toEqual([
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '--query-flags',
    '0x10000',
    ...intentArgs,
  ]);
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('intent launch controls reach am start without breaking native package ownership', async () => {
  const { openAndroidApp } = await import('./app-lifecycle.ts');
  const launchArgs = ['-S', '-R', '2', '--display', '0'];
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockImplementation(async (_device, args: string[]) => {
    if (args[0] === 'cmd' && args.slice(8).includes('-S')) {
      return {
        stdout: '',
        stderr: 'java.lang.IllegalArgumentException: Unknown option: -S',
        exitCode: 1,
      };
    }
    return { stdout: 'com.android.settings/.Settings', stderr: '', exitCode: 0 };
  });

  await openAndroidApp(androidDevice, 'settings', { launchArgs });
  await expect(resolveAndroidPackageForOpen(androidDevice, 'settings', launchArgs)).resolves.toBe(
    'com.android.settings',
  );
  const commands = runAndroidShell.mock.calls.map((call) => call[1]);
  expect(commands[0]).toEqual([
    'am',
    'start',
    '-W',
    '-a',
    'android.settings.SETTINGS',
    ...launchArgs,
  ]);
  expect(commands[1]).toEqual([
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '--query-flags',
    '0x10000',
    '-a',
    'android.settings.SETTINGS',
  ]);
  expect(getAndroidAppState).not.toHaveBeenCalled();
});

test('intent selectors resolve only handlers eligible for activity launch', async () => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockImplementation(async (_device, args: string[]) => ({
    stdout:
      args.includes('--query-flags') && args[args.indexOf('--query-flags') + 1] === '0x10000'
        ? 'com.example.default/.Main'
        : 'com.example.nondefault/.Main',
    stderr: '',
    exitCode: 0,
  }));

  await expect(
    resolveAndroidPackageForOpen(androidDevice, 'settings', [
      '--selector',
      '-a',
      'com.example.VIEW',
    ]),
  ).resolves.toBe('com.example.default');
  expect(runAndroidShell).toHaveBeenCalledWith(
    androidDevice,
    [
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '--query-flags',
      '0x10000',
      '-a',
      'android.settings.SETTINGS',
      '--selector',
      '-a',
      'com.example.VIEW',
    ],
    { allowFailure: true, timeoutMs: 2_000 },
  );
});

test.each([
  ['-a', 'android.intent.action.VIEW', '-d', 'content://example/image/1'],
  ['-dcontent://example/image/1'],
  ['--selector', '-d', 'content://example/image/1'],
  ['content://example/image/1'],
])('implicit content MIME resolution retains unknown ownership: %j', async (...launchArgs) => {
  resolveAndroidApp.mockResolvedValue({ type: 'intent', value: 'android.settings.SETTINGS' });
  runAndroidShell.mockResolvedValue({
    stdout: 'com.example.generic/.Main',
    stderr: '',
    exitCode: 0,
  });
  await expect(
    resolveAndroidPackageForOpen(androidDevice, 'settings', launchArgs),
  ).resolves.toBeUndefined();
  expect(runAndroidShell).not.toHaveBeenCalled();
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
  await expect(
    resolveAndroidPackageForOpen(androidDevice, 'settings', [
      '-n',
      'com.example.app/.MainActivity',
    ]),
  ).resolves.toBeUndefined();
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
