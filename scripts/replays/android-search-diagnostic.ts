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
let preparing = true;
let replayExit: number | undefined;
let diagnosticError: string | undefined;
let variant: unknown;
let corpus: unknown;
const casePath = 'test/integration/replays/android/emulator/04-text-input-keyboard.ad';
const knownProvider = 'com.google.android.settings.intelligence';
const knownFingerprint =
  'google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.D1/13818094:user/release-keys';
const receivers = ['BootBroadcastReceiver', 'PeriodicJobReceiver'].map(
  (name) => `${knownProvider}.modules.battery.impl.usage.${name}`,
);
const preparation = {
  budgetMs: 40_000,
  startedAt,
  finishedAt: undefined as number | undefined,
  complete: false,
  satisfied: false,
  observations: [] as unknown[],
  traceDumpClearsBuffer: false,
};

function descendants(lines: string[], header: RegExp, optional = false): string[] {
  const matches = lines.flatMap((line, index) => (header.test(line.trim()) ? [index] : []));
  if (optional && matches.length === 0) return [];
  if (matches.length !== 1) throw new Error('Native precondition section missing or ambiguous');
  const start = matches[0];
  const indent = lines[start].length - lines[start].trimStart().length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.trim() && line.length - line.trimStart().length <= indent,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}
function providerState(output: string) {
  const packages = descendants(output.split('\n'), /^Packages:$/);
  const pkg = descendants(
    packages,
    /^Package \[com\.google\.android\.settings\.intelligence\] \([a-f0-9]+\):$/,
  );
  const uid = Number(
    pkg
      .find((line) => /^appId=\d+$/.test(line.trim()))
      ?.trim()
      .slice('appId='.length),
  );
  const user = pkg.find((line) => /^User 0: /.test(line.trim()));
  if (!Number.isSafeInteger(uid) || !user || !/(?:^| )installed=true(?: |$)/.test(user.trim())) {
    throw new Error('Native precondition requires the installed provider for user 0');
  }
  const disabled = descendants(descendants(pkg, /^User 0: /), /^disabledComponents:$/, true).map(
    (line) => line.trim(),
  );
  return { uid, disabled: receivers.filter((receiver) => disabled.includes(receiver)) };
}
function broadcastRecords(output: string) {
  return output.split(/(?=^\s*BroadcastRecord\{)/m).flatMap((body) => {
    const header =
      /^\s*BroadcastRecord\{([a-f0-9]+) (android\.intent\.action\.[A-Z_]+)\/u(-?\d+)\} to user (-?\d+)/.exec(
        body,
      );
    return header
      ? [
          {
            id: header[1],
            action: header[2],
            user: Number(header[3]),
            targetUser: Number(header[4]),
            body,
          },
        ]
      : [];
  });
}
function packageChanges(records: ReturnType<typeof broadcastRecords>, uid: number) {
  return records
    .filter((record) => {
      const intent =
        record.body.split('\n').find((line) => line.trim().startsWith('Intent {')) ?? '';
      const extras =
        record.body.split('\n').find((line) => line.trim().startsWith('extras: Bundle[')) ?? '';
      return (
        record.action === 'android.intent.action.PACKAGE_CHANGED' &&
        record.user === 0 &&
        record.targetUser === 0 &&
        /(?:^| )dat=package:com\.google\.android\.settings\.intelligence(?: |$)/.test(intent) &&
        /android\.intent\.extra\.DONT_KILL_APP=false(?:,|})/.test(extras) &&
        !/android\.intent\.extra\.REPLACING=true(?:,|})/.test(extras) &&
        new RegExp(`android\\.intent\\.extra\\.UID=${uid}(?:,|})`).test(extras) &&
        /android\.intent\.extra\.user_handle=0(?:,|})/.test(extras)
      );
    })
    .map((record) => {
      const extras =
        record.body.split('\n').find((line) => line.trim().startsWith('extras: Bundle[')) ?? '';
      const names =
        /android\.intent\.extra\.changed_component_name_list=\[([^\]]*)\]/
          .exec(extras)?.[1]
          .split(',')
          .map((name) => name.trim()) ?? [];
      return {
        id: record.id,
        components: receivers.filter((receiver) => names.includes(receiver)),
      };
    });
}
function bootDeliveries(records: ReturnType<typeof broadcastRecords>) {
  return records
    .filter(
      (record) =>
        record.action === 'android.intent.action.BOOT_COMPLETED' &&
        record.user === 0 &&
        record.targetUser === 0 &&
        /android\.intent\.extra\.user_handle=0(?:,|})/.test(record.body),
    )
    .flatMap((record) =>
      record.body.split(/(?=^\s*[A-Z_]+[^\n]*#\d+:)/m).flatMap((delivery) => {
        const state = /^\s*([A-Z_]+)[^\n]*#(\d+):/.exec(delivery);
        const name = delivery
          .split('\n')
          .find((line) => line.trim().startsWith('name='))
          ?.trim()
          .slice(5);
        const pkg = delivery
          .split('\n')
          .find((line) => line.trim().startsWith('packageName='))
          ?.trim()
          .slice(12);
        return state && name === receivers[0] && pkg === knownProvider
          ? [{ record: record.id, index: Number(state[2]), state: state[1] }]
          : [];
      }),
    );
}
async function prepareProvider() {
  const prepDeadline = Math.min(startedAt + preparation.budgetMs, deadline - 195_000);
  const probe = (name: string, args: string[]) => {
    const remaining = prepDeadline - Date.now();
    if (remaining <= 0) throw new Error('Native provider preparation deadline exceeded');
    const result = capture(name, 'adb', ['-s', serial, ...args], Math.min(15_000, remaining));
    if (result.exitCode !== 0) throw new Error('Native provider preparation probe failed');
    return result.stdout;
  };
  const fingerprint = probe('prep-fingerprint', [
    'shell',
    'getprop',
    'ro.build.fingerprint',
  ]).trim();
  if (provider !== knownProvider || fingerprint !== knownFingerprint)
    throw new Error('Native provider precondition is unsupported for this image/provider');
  for (let attempt = 0; Date.now() < prepDeadline; attempt += 1) {
    const state = providerState(
      probe(`prep-${attempt}-package`, ['shell', 'dumpsys', 'package', knownProvider]),
    );
    const records = broadcastRecords(
      probe(`prep-${attempt}-broadcasts`, [
        'shell',
        'dumpsys',
        'activity',
        '-a',
        'broadcasts',
        'history',
      ]),
    );
    const changes = packageChanges(records, state.uid);
    const deliveries = bootDeliveries(records);
    const killRecords = receivers.map((receiver) =>
      changes.find((change) => change.components.includes(receiver)),
    );
    const bootEnded =
      deliveries.length > 0 &&
      deliveries.every((delivery) =>
        ['DELIVERED', 'SKIPPED', 'FAILURE', 'TIMEOUT'].includes(delivery.state),
      );
    preparation.observations.push({
      attempt,
      observedAt: Date.now(),
      fingerprint,
      provider,
      state,
      killRecords,
      deliveries,
      bootEnded,
    });
    if (state.disabled.length === receivers.length && killRecords.every(Boolean) && bootEnded) {
      const recheck = providerState(
        probe('prep-recheck', ['shell', 'dumpsys', 'package', knownProvider]),
      );
      if (recheck.uid !== state.uid || recheck.disabled.length !== receivers.length)
        throw new Error('Native provider precondition changed before replay');
      probe('atrace-prep', ['shell', 'atrace', '--async_dump']);
      preparation.traceDumpClearsBuffer = true;
      preparation.complete = true;
      preparation.satisfied = true;
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, prepDeadline - Date.now()))),
    );
  }
  throw new Error('Native provider preparation deadline exceeded');
}

function capture(
  name: string,
  executable: string,
  args: string[],
  budgetMs = 15_000,
  cleanup = false,
) {
  const remaining = Math.min(
    deadline - Date.now() - (cleanup ? 0 : 15_000),
    preparing && !cleanup
      ? startedAt + preparation.budgetMs - Date.now()
      : Number.POSITIVE_INFINITY,
  );
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
  await prepareProvider();
  adb('provider-before', ['shell', 'dumpsys', 'package', provider]);
  clock('before-replay');
  if (deadline - Date.now() < 195_000)
    throw new Error('Native preparation left insufficient replay budget');
  preparation.finishedAt = Date.now();
  preparing = false;
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
  preparation.finishedAt ??= Date.now();
  preparing = false;
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
  adb('broadcast-history', ['shell', 'dumpsys', 'activity', '-a', 'broadcasts', 'history']);
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
const traceProbeComplete =
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
      preparation,
      startedAt,
      finishedAt: Date.now(),
      traceProbeComplete,
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
    : traceProbeComplete
      ? 0
      : 2;
