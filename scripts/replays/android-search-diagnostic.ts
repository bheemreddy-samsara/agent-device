import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCmdSync } from '@agent-device/host-kit/command';
import { normalizeError } from '@agent-device/kernel/errors';

const [serial, outputDir, stateDir, traceMarker] = process.argv.slice(2);
if (!serial || !outputDir || !stateDir || !traceMarker) {
  throw new Error(
    'Usage: android-search-diagnostic.ts <serial> <output-dir> <state-dir> <trace-marker>',
  );
}
fs.mkdirSync(outputDir, { recursive: true });
const startedAt = Date.now();
const deadline = startedAt + 240_000;
const commands: unknown[] = [];
let probesSucceeded = true;
let traceOwned = false;
let replayExit: number | undefined;
let diagnosticError: string | undefined;
let variant: unknown;
let corpus: unknown;
const casePath = 'test/integration/replays/android/emulator/04-text-input-keyboard.ad';

function capture(
  name: string,
  executable: string,
  args: string[],
  budgetMs = 15_000,
  cleanup = false,
) {
  const remaining = deadline - Date.now() - (cleanup ? 0 : 15_000);
  if (remaining <= 0) throw new Error('Native diagnostic wall-clock budget exhausted');
  const commandStartedAt = Date.now();
  let result;
  let failure;
  try {
    result = runCmdSync(executable, args, {
      allowFailure: true,
      timeoutMs: Math.min(budgetMs, remaining),
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    failure = normalizeError(error);
    result = { exitCode: -1, stdout: '', stderr: String(error) };
  }
  fs.writeFileSync(path.join(outputDir, `${name}.stdout.txt`), result.stdout);
  fs.writeFileSync(path.join(outputDir, `${name}.stderr.txt`), result.stderr);
  if (name !== 'replay') probesSucceeded &&= result.exitCode === 0;
  commands.push({
    name,
    executable,
    args,
    exitCode: result.exitCode,
    failure,
    startedAt: commandStartedAt,
    finishedAt: Date.now(),
    timeoutMs: Math.min(budgetMs, remaining),
  });
  return result;
}

function adb(name: string, args: string[], cleanup = false) {
  return capture(name, 'adb', ['-s', serial, ...args], 15_000, cleanup);
}
function clock(prefix: string) {
  adb(`${prefix}-clock`, ['shell', 'date', '+%s.%N']);
  adb(`${prefix}-uptime`, ['shell', 'cat', '/proc/uptime']);
}
let provider: string | undefined;
try {
  variant = JSON.parse(fs.readFileSync(path.join(path.dirname(outputDir), 'variant.json'), 'utf8'));
  const corpusDir = path.dirname(casePath);
  corpus = fs
    .readdirSync(corpusDir)
    .filter((file) => file.endsWith('.ad'))
    .sort()
    .map((file) => ({
      file: path.join(corpusDir, file),
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(corpusDir, file)))
        .digest('hex'),
    }));
  const categories = adb('atrace-categories', ['shell', 'atrace', '--list_categories']);
  if (
    categories.exitCode !== 0 ||
    !['ss', 'pm'].every((category) =>
      new RegExp(`^\\s*${category}\\s+-`, 'm').test(categories.stdout),
    )
  ) {
    throw new Error('Native diagnostic requires supported ss and pm atrace categories');
  }
  const resolution = adb('search-resolution', [
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.settings.APP_SEARCH_SETTINGS',
    '-c',
    'android.intent.category.DEFAULT',
  ]);
  provider = /^([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+$/m.exec(resolution.stdout)?.[1];
  if (resolution.exitCode !== 0 || !provider)
    throw new Error('Native diagnostic did not resolve the Search provider');
  adb('atrace-prefer-sdk-before', ['shell', 'getprop', 'debug.atrace.prefer_sdk']);
  adb('atrace-flags-before', ['shell', 'getprop', 'debug.atrace.tags.enableflags']);
  fs.writeFileSync(traceMarker, JSON.stringify({ serial, startedAt }));
  traceOwned = true;
  if (
    adb('atrace-start', ['shell', 'atrace', '--async_start', '-b4096', 'ss', 'pm']).exitCode !== 0
  ) {
    throw new Error('Native diagnostic could not start atrace');
  }
  adb('atrace-prefer-sdk', ['shell', 'getprop', 'debug.atrace.prefer_sdk']);
  const enabledFlags = adb('atrace-enabled-flags', [
    'shell',
    'getprop',
    'debug.atrace.tags.enableflags',
  ]);
  if (enabledFlags.exitCode !== 0 || (BigInt(enabledFlags.stdout.trim()) & 0xc0000n) !== 0xc0000n) {
    throw new Error('Native diagnostic atrace did not enable ss and pm');
  }
  adb('provider-before', ['shell', 'dumpsys', 'package', provider]);
  clock('before-replay');
  replayExit = capture(
    'replay',
    process.execPath,
    [
      'bin/agent-device.mjs',
      'test',
      casePath,
      '--platform',
      'android',
      '--serial',
      serial,
      '--state-dir',
      stateDir,
      '--debug',
      '--retries',
      '0',
      '--artifacts-dir',
      'test/artifacts/replays-android',
      '--report-junit',
      'test/artifacts/replays-android.junit.xml',
    ],
    180_000,
  ).exitCode;
} catch (error) {
  diagnosticError = String(error);
} finally {
  if (traceOwned) {
    try {
      if (adb('atrace-stop', ['shell', 'atrace', '--async_stop'], true).exitCode === 0)
        fs.unlinkSync(traceMarker);
    } catch (error) {
      diagnosticError ??= String(error);
    }
  }
}
try {
  clock('after-replay');
  if (provider) {
    adb('provider-after', ['shell', 'dumpsys', 'package', provider]);
    adb('search-exit-info', ['shell', 'dumpsys', 'activity', 'exit-info', provider]);
  }
  adb('measured-end-window', ['shell', 'dumpsys', 'window', 'windows']);
  adb('measured-end-activity', ['shell', 'dumpsys', 'activity', 'activities']);
  adb('measured-end-ime', ['shell', 'dumpsys', 'input_method']);
  adb('image', ['shell', 'getprop']);
} catch (error) {
  diagnosticError ??= String(error);
}
const nativeComplete =
  probesSucceeded && !diagnosticError && replayExit !== undefined && !fs.existsSync(traceMarker);
fs.writeFileSync(
  path.join(outputDir, 'summary.json'),
  JSON.stringify(
    {
      head: process.env.GITHUB_SHA,
      serial,
      diagnosticOnly: true,
      validForDecision: false,
      casePath,
      variant,
      corpus,
      startedAt,
      finishedAt: Date.now(),
      nativeComplete,
      replayExit,
      diagnosticError,
      commands,
    },
    null,
    2,
  ) + '\n',
);
process.exitCode =
  replayExit !== undefined && replayExit !== 0
    ? replayExit > 0
      ? replayExit
      : 2
    : nativeComplete
      ? 0
      : 2;
