import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { normalizeError } from '@agent-device/kernel/errors';

const [serial, outputDir] = process.argv.slice(2);
if (!serial || !outputDir) {
  throw new Error('Usage: android-search-diagnostic.ts <serial> <output-dir>');
}
fs.mkdirSync(outputDir, { recursive: true });
const startedAt = Date.now();
const deadline = startedAt + 90_000;
const commands: unknown[] = [];
let probesSucceeded = true;

function capture(name: string, args: string[]) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Native diagnostic wall-clock budget exhausted');
  let result;
  let failure;
  try {
    result = runCmdSync('adb', ['-s', serial, ...args], {
      allowFailure: true,
      timeoutMs: Math.min(15_000, remaining),
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    failure = normalizeError(error);
    result = { exitCode: -1, stdout: '', stderr: String(error) };
  }
  fs.writeFileSync(path.join(outputDir, `${name}.stdout.txt`), result.stdout);
  fs.writeFileSync(path.join(outputDir, `${name}.stderr.txt`), result.stderr);
  probesSucceeded &&= result.exitCode === 0;
  commands.push({ name, args: ['-s', serial, ...args], exitCode: result.exitCode, failure });
  return result.stdout;
}

let diagnosticError: string | undefined;
let loggerExit: number | undefined;
try {
  capture('measured-end-window', ['shell', 'dumpsys', 'window', 'windows']);
  capture('measured-end-activity', ['shell', 'dumpsys', 'activity', 'activities']);
  capture('measured-end-ime', ['shell', 'dumpsys', 'input_method']);
  capture('image', ['shell', 'getprop']);
  const resolution = capture('search-resolution', [
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
  const resolvedPackage = /^([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+$/m.exec(resolution)?.[1];
  if (!resolvedPackage) throw new Error('Native diagnostic did not resolve the Search provider');
  capture('search-exit-info', ['shell', 'dumpsys', 'activity', 'exit-info', resolvedPackage]);
  loggerExit = Number(
    fs.readFileSync(path.join(outputDir, 'native-logcat-end.txt'), 'utf8').trim().split(' ')[1],
  );
} catch (error) {
  diagnosticError = String(error);
}
const complete = probesSucceeded && !diagnosticError && [0, 124, 143].includes(loggerExit ?? -1);
fs.writeFileSync(
  path.join(outputDir, 'summary.json'),
  JSON.stringify(
    {
      head: process.env.GITHUB_SHA,
      serial,
      diagnosticOnly: true,
      startedAt,
      finishedAt: Date.now(),
      complete,
      loggerExit,
      diagnosticError,
      commands,
    },
    null,
    2,
  ) + '\n',
);
process.exitCode = complete ? 0 : 2;
