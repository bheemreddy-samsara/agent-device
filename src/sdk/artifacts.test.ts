import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function malformedArchiveWithAapt() {
  const root = await mkdtempForTest('sdk-artifacts-aapt-');
  const buildTools = path.join(root, 'build-tools', '36.0.0');
  await mkdir(buildTools, { recursive: true });
  await writeFile(
    path.join(buildTools, 'aapt'),
    `#!${process.execPath}\nprocess.stdout.write("package: name='com.example.aapt' versionCode='1'\\n");\n`,
    { mode: 0o755 },
  );
  await writeFile(path.join(root, 'AndroidManifest.xml'), '<manifest>unparseable</manifest>');
  const archive = path.join(root, 'app.apk');
  execFileSync('zip', ['-q', archive, 'AndroidManifest.xml'], { cwd: root });
  vi.stubEnv('ANDROID_SDK_ROOT', root);
  return { archive, root };
}

test.skipIf(process.platform === 'win32')(
  'standalone archive resolution falls back to aapt when the manifest cannot name a package',
  async () => {
    const { archive } = await malformedArchiveWithAapt();
    const { resolveAndroidArchivePackageName } = await import('./artifacts.ts');

    assert.equal(await resolveAndroidArchivePackageName(archive), 'com.example.aapt');
  },
);

test.skipIf(process.platform === 'win32')(
  'an initial unscoped SDK call does not poison aapt lookup for later scoped mechanics calls',
  async () => {
    const { archive, root } = await malformedArchiveWithAapt();
    const { resolveAndroidArchivePackageName } = await import('./artifacts.ts');
    await resolveAndroidArchivePackageName(archive);
    const { withCommandHost } = await import('@agent-device/host-kit/command');
    const { resolveAndroidArchivePackageName: resolveOnHost } =
      await import('@agent-device/platform-android/mechanics');

    const resolved = await withCommandHost(
      {
        host: { env: { ...process.env, ANDROID_SDK_ROOT: root }, cwd: root },
        requestEnv: undefined,
      },
      () => resolveOnHost(archive),
    );
    assert.equal(resolved, 'com.example.aapt');
  },
);
