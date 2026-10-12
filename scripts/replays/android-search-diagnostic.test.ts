import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

const provider = 'com.google.android.settings.intelligence';
const fingerprint =
  'google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.D1/13818094:user/release-keys';
const packageState = fs.readFileSync(
  path.resolve('scripts/replays/fixtures/android-search-package.txt'),
  'utf8',
);
const history = fs.readFileSync(
  path.resolve('scripts/replays/fixtures/android-search-broadcasts.txt'),
  'utf8',
);
const defaultState = packageState.split('      disabledComponents:')[0];

type Scenario = {
  replayExit?: number;
  probeExit?: number;
  categories?: boolean;
  mask?: string;
  state?: string;
  history?: string;
  transition?: boolean;
  recheck?: string;
  identity?: string;
  resolvedProvider?: string;
  packageExit?: number;
  preflightCost?: number;
};

async function diagnostic(scenario: Scenario = {}) {
  const cwd = await mkdtempForTest('android-search-actor-');
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.writeFileSync(path.join(cwd, 'clock'), '1000000');
  fs.writeFileSync(path.join(cwd, 'package.txt'), scenario.state ?? packageState);
  fs.writeFileSync(path.join(cwd, 'default.txt'), defaultState);
  fs.writeFileSync(
    path.join(cwd, 'recheck.txt'),
    scenario.recheck ?? scenario.state ?? packageState,
  );
  fs.writeFileSync(path.join(cwd, 'history.txt'), scenario.history ?? history);
  const preload = path.join(cwd, 'clock.mjs');
  fs.writeFileSync(
    preload,
    String.raw`
import fs from 'node:fs';
Date.now = () => Number(fs.readFileSync('clock', 'utf8'));
globalThis.setTimeout = (callback, delay, ...args) => {
  fs.writeFileSync('clock', String(Date.now() + Number(delay)));
  queueMicrotask(() => callback(...args));
  return 0;
};
`,
  );
  fs.writeFileSync(
    path.join(cwd, 'bin/adb'),
    String.raw`#!/bin/sh
printf '%s\n' "$*" >> calls.log
clock=$(cat clock); cost=1000
case "$*" in *--async_start*) cost=$PREFLIGHT_COST;; esac
echo $((clock + cost)) > clock
case "$*" in
 *--list_categories) printf 'pm - Package Manager\n'; if [ "$CATEGORIES" = true ]; then echo 'ss - System Server'; fi;;
 *resolve-activity*) echo "$PROVIDER/.search.SearchActivity";;
 *ro.build.fingerprint) echo "$FINGERPRINT";;
 *debug.atrace.tags.enableflags) echo "$MASK";;
 *--async_stop|*--async_dump) echo 'trace_event_clock_sync: realtime_ts=1000'; echo 'broadcastPackageChanged; cpnft=caller.raw';;
 *"dumpsys package"*)
   count=0; if [ -f package-count ]; then count=$(cat package-count); fi
   count=$((count + 1)); echo "$count" > package-count
   if [ "$PACKAGE_EXIT" != 0 ]; then echo 'native package getter failed' >&2; exit "$PACKAGE_EXIT"; fi
   if [ "$TRANSITION" = true ] && [ "$count" = 1 ]; then cat default.txt
   elif [ "$count" -ge "$RECHECK_AT" ]; then cat recheck.txt
   else cat package.txt; fi;;
 *"broadcasts history") cat history.txt;;
 *) echo "native producer: $*";;
esac
case "$*" in *input_method) exit "$PROBE_EXIT";; esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(cwd, 'bin/agent-device.mjs'),
    String.raw`
import fs from 'node:fs';
fs.appendFileSync('calls.log', 'REPLAY ' + JSON.stringify(process.argv.slice(2)) + '\n');
process.exitCode = Number(process.env.REPLAY_EXIT);
`,
  );
  const corpusDir = path.join(cwd, 'test/integration/replays/android/emulator');
  fs.mkdirSync(corpusDir, { recursive: true });
  for (const file of ['04-text-input-keyboard.ad', '01-settings.ad'])
    fs.writeFileSync(path.join(corpusDir, file), 'context platform=android\n');
  const output = path.join(cwd, 'artifacts/native');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'artifacts/variant.json'), '{"head":"source-variant"}');
  const marker = path.join(output, 'owned');
  const result = runCmdSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve('scripts/replays/android-search-diagnostic.ts'),
      'emulator-own',
      output,
      path.join(cwd, 'state'),
      marker,
    ],
    {
      cwd,
      allowFailure: true,
      timeoutMs: 10_000,
      env: {
        PATH: `${cwd}/bin:${process.env.PATH}`,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
          .filter(Boolean)
          .join(' '),
        REPLAY_EXIT: String(scenario.replayExit ?? 0),
        PROBE_EXIT: String(scenario.probeExit ?? 0),
        CATEGORIES: String(scenario.categories ?? true),
        MASK: scenario.mask ?? '786432',
        TRANSITION: String(scenario.transition ?? false),
        RECHECK_AT: scenario.transition ? '3' : '2',
        PROVIDER: scenario.resolvedProvider ?? provider,
        FINGERPRINT: scenario.identity ?? fingerprint,
        PACKAGE_EXIT: String(scenario.packageExit ?? 0),
        PREFLIGHT_COST: String(scenario.preflightCost ?? 1000),
      },
    },
  );
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
  const calls = fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8');
  expect(summary.diagnosticOnly).toBe(true);
  expect(summary.validForDecision).toBe(false);
  expect(summary.variant.head).toBe('source-variant');
  expect(summary.corpus).toHaveLength(2);
  expect(fs.existsSync(marker)).toBe(false);
  expect(
    summary.commands.every(
      (command: { timeoutMs: number }) => command.timeoutMs > 0 && command.timeoutMs <= 180_000,
    ),
  ).toBe(true);
  expect(
    calls
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('REPLAY'))
      .every((line) => line.startsWith('-s emulator-own ')),
  ).toBe(true);
  expect(calls).not.toMatch(
    /shell (?:am start|input|ime |pm (?:enable|disable)|cmd package (?:enable|disable|set-))/,
  );
  return { result, summary, calls, output };
}

test.each([
  [0, 0, true, '786432', 0],
  [7, 0, true, '786432', 7],
  [0, 3, true, '786432', 2],
  [0, 0, false, '786432', 2],
  [0, 0, true, '0', 2],
] as const)(
  'actor diagnostic separates replay=%i probe=%i category support=%s mask=%s',
  async (replayExit, probeExit, categories, mask, status) => {
    const { result, summary, calls, output } = await diagnostic({
      replayExit,
      probeExit,
      categories,
      mask,
    });
    const replayReached = categories && mask !== '0';
    expect(result.exitCode, result.stderr).toBe(status);
    expect(summary.traceProbeComplete).toBe(replayReached && probeExit === 0);
    expect(calls.includes('REPLAY')).toBe(replayReached);
    expect(calls.includes('--async_stop')).toBe(categories);
    if (replayReached) {
      expect(summary.preparation.satisfied).toBe(true);
      expect(calls.indexOf('--async_dump')).toBeLessThan(calls.indexOf('REPLAY'));
      expect(calls.indexOf('--async_stop')).toBeGreaterThan(calls.indexOf('REPLAY'));
      expect(calls).toContain(
        'test/integration/replays/android/emulator/04-text-input-keyboard.ad',
      );
      expect(calls).toContain('"--serial","emulator-own"');
      expect(summary.replayExit).toBe(replayExit);
      expect(
        summary.commands.find((command: { name: string }) => command.name === 'replay').timeoutMs,
      ).toBe(180_000);
      expect(summary.preparation.finishedAt - summary.preparation.startedAt).toBeLessThanOrEqual(
        40_000,
      );
      for (const name of ['atrace-prep', 'atrace-stop'])
        expect(fs.readFileSync(path.join(output, `${name}.stdout.txt`), 'utf8')).toContain(
          'cpnft=caller.raw',
        );
      expect(fs.readFileSync(path.join(output, 'measured-end-ime.stdout.txt'), 'utf8')).toBe(
        'native producer: -s emulator-own shell dumpsys input_method\n',
      );
    }
  },
);

test('natural transition preserves default and disabled observations before unchanged replay', async () => {
  const { result, summary, calls, output } = await diagnostic({ transition: true });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    summary.preparation.observations.map(
      (observation: { state: { disabled: string[] } }) => observation.state.disabled.length,
    ),
  ).toEqual([0, 2]);
  expect(
    summary.preparation.observations[1].killRecords.map((record: { id: string }) => record.id),
  ).toEqual(['6b135e3', '1f473ba']);
  expect(summary.preparation.observations[1].deliveries).toEqual([
    { record: 'a820e6e', index: 98, state: 'FAILURE' },
  ]);
  expect(summary.preparation.complete).toBe(true);
  expect(summary.preparation.traceDumpClearsBuffer).toBe(true);
  expect(calls.indexOf('--async_start')).toBeLessThan(calls.indexOf('dumpsys package'));
  expect(fs.readFileSync(path.join(output, 'prep-0-package.stdout.txt'), 'utf8')).toBe(
    defaultState,
  );
  expect(fs.readFileSync(path.join(output, 'prep-1-broadcasts.stdout.txt'), 'utf8')).toBe(history);
});

test.each([
  ['default state', { state: defaultState }],
  [
    'not installed for user 0',
    { state: packageState.replace('installed=true', 'installed=false') },
  ],
  ['wrong user state', { state: packageState.replace('User 0:', 'User 10:') }],
  [
    'missing component state',
    {
      state: packageState.replace(
        `${provider}.modules.battery.impl.usage.PeriodicJobReceiver`,
        'other.Receiver',
      ),
    },
  ],
  ['no package callback', { history: history.replaceAll('PACKAGE_CHANGED', 'PACKAGE_ADDED') }],
  [
    'non-killing callback',
    { history: history.replaceAll('DONT_KILL_APP=false', 'DONT_KILL_APP=true') },
  ],
  [
    'replacement callback',
    {
      history: history.replaceAll(
        'DONT_KILL_APP=false',
        'DONT_KILL_APP=false, android.intent.extra.REPLACING=true',
      ),
    },
  ],
  ['wrong callback user', { history: history.replaceAll('/u0} to user 0', '/u10} to user 10') }],
  ['wrong affected UID', { history: history.replaceAll('extra.UID=10145', 'extra.UID=1000') }],
  [
    'wrong component callback',
    {
      history: history.replaceAll(
        'changed_component_name_list=[com.google.android.settings.intelligence.modules.battery.impl.usage.PeriodicJobReceiver]',
        'changed_component_name_list=[other.Receiver]',
      ),
    },
  ],
  [
    'ongoing BOOT delivery',
    { history: history.replace('FAILURE scheduled', 'SCHEDULED scheduled') },
  ],
  [
    'wrong BOOT receiver',
    {
      history: history.replace(
        '\n          name=com.google.android.settings.intelligence.modules.battery.impl.usage.BootBroadcastReceiver',
        '\n          name=other.BootBroadcastReceiver',
      ),
    },
  ],
  ['state reverted during recheck', { recheck: defaultState }],
  ['unsupported image', { identity: 'other/image' }],
  ['unsupported provider', { resolvedProvider: 'other.provider' }],
  ['failed getter', { packageExit: 3 }],
  ['preflight consumes preparation budget', { preflightCost: 40_000 }],
] satisfies [string, Scenario][])(
  'native preparation refuses %s without invoking GUI',
  async (_name, scenario) => {
    const { result, summary, calls } = await diagnostic(scenario);
    expect(result.exitCode, result.stderr).toBe(2);
    expect(summary.preparation.complete).toBe(false);
    expect(summary.preparation.satisfied).toBe(false);
    expect(summary.traceProbeComplete).toBe(false);
    expect(summary.replayExit).toBeUndefined();
    expect(calls).not.toContain('REPLAY');
    expect(calls).toContain('--async_stop');
    expect(summary.diagnosticError).toBeTruthy();
    const prepCommands = summary.commands.filter((command: { name: string }) =>
      command.name.startsWith('prep-'),
    );
    expect(
      prepCommands.every(
        (command: { startedAt: number; timeoutMs: number }) =>
          command.startedAt + command.timeoutMs <= summary.startedAt + 40_000,
      ),
    ).toBe(true);
  },
);
