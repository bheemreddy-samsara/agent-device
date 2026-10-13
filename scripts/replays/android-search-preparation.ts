import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { captureReplayCommand } from './replay-command-evidence.ts';

const knownProvider = 'com.google.android.settings.intelligence';
const knownFingerprint =
  'google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.D1/13818094:user/release-keys';
const receivers = ['BootBroadcastReceiver', 'PeriodicJobReceiver'].map(
  (name) => `${knownProvider}.modules.battery.impl.usage.${name}`,
);
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

type PreparationInput = { serial: string; outputDir: string; startedAt: number; deadline: number };

function createPreparation({ serial, startedAt, deadline }: PreparationInput) {
  const commands: {
    name: string;
    executable: string;
    args: string[];
    exitCode: number;
    startedAt: number;
    finishedAt: number;
    timeoutMs: number;
    failure: unknown;
  }[] = [];
  const preparation = {
    head: process.env.GITHUB_SHA,
    serial,
    provider: undefined as string | undefined,
    fingerprint: undefined as string | undefined,
    uid: undefined as number | undefined,
    budgetMs: deadline - startedAt,
    startedAt,
    finishedAt: undefined as number | undefined,
    complete: false,
    satisfied: false,
    observations: [] as unknown[],
    error: undefined as string | undefined,
    commands,
  };
  return preparation;
}

async function capture(
  input: PreparationInput,
  preparation: ReturnType<typeof createPreparation>,
  name: string,
  args: string[],
  timeoutMs: number,
) {
  const { serial, outputDir } = input;
  const { result, record } = await captureReplayCommand({
    name,
    executable: 'adb',
    args: ['-s', serial, ...args],
    outputDir,
    timeoutMs,
  });
  preparation.commands.push(record);
  return result;
}

async function observeProvider(
  input: PreparationInput,
  preparation: ReturnType<typeof createPreparation>,
) {
  const prepDeadline = input.deadline;
  const probe = async (name: string, args: string[]) => {
    const remaining = prepDeadline - Date.now();
    if (remaining <= 0) throw new Error('Native provider preparation deadline exceeded');
    const result = await capture(input, preparation, name, args, Math.min(15_000, remaining));
    if (result.exitCode !== 0) throw new Error('Native provider preparation probe failed');
    if (Date.now() > prepDeadline) throw new Error('Native provider preparation deadline exceeded');
    return result.stdout;
  };
  const resolution = await probe('prep-search-resolution', [
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
  const provider = /^([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+$/m.exec(resolution)?.[1];
  preparation.provider = provider;
  const fingerprint = (
    await probe('prep-fingerprint', ['shell', 'getprop', 'ro.build.fingerprint'])
  ).trim();
  preparation.fingerprint = fingerprint;
  if (provider !== knownProvider || fingerprint !== knownFingerprint)
    throw new Error('Native provider precondition is unsupported for this image/provider');
  for (let attempt = 0; Date.now() < prepDeadline; attempt += 1) {
    const state = providerState(
      await probe(`prep-${attempt}-package`, ['shell', 'dumpsys', 'package', knownProvider]),
    );
    preparation.uid = state.uid;
    const records = broadcastRecords(
      await probe(`prep-${attempt}-broadcasts`, [
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
        await probe('prep-recheck', ['shell', 'dumpsys', 'package', knownProvider]),
      );
      if (recheck.uid !== state.uid || recheck.disabled.length !== receivers.length)
        throw new Error('Native provider precondition changed before replay');
      return { provider, fingerprint, uid: state.uid };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, prepDeadline - Date.now()))),
    );
  }
  throw new Error('Native provider preparation deadline exceeded');
}

export async function prepareAndroidSearch(input: PreparationInput) {
  fs.mkdirSync(input.outputDir, { recursive: true });
  const preparation = createPreparation(input);
  let outcome;
  try {
    const identity = await observeProvider(input, preparation);
    outcome = { ...preparation, ...identity, complete: true as const, satisfied: true as const };
  } catch (error) {
    outcome = {
      ...preparation,
      complete: false as const,
      satisfied: false as const,
      error: String(error),
      failure: normalizeError(error),
    };
  }
  outcome.finishedAt = Date.now();
  fs.writeFileSync(
    path.join(input.outputDir, 'preparation.json'),
    JSON.stringify(outcome, null, 2) + '\n',
  );
  return outcome;
}
