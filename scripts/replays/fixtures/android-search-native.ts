import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

export const provider = 'com.google.android.settings.intelligence';
const fingerprint =
  'google/sdk_gphone64_x86_64/emu64xa:16/BE2A.250530.026.D1/13818094:user/release-keys';
export const packageState = fs.readFileSync(
  path.resolve('scripts/replays/fixtures/android-search-package.txt'),
  'utf8',
);
export const history = fs.readFileSync(
  path.resolve('scripts/replays/fixtures/android-search-broadcasts.txt'),
  'utf8',
);
export const defaultState = packageState.split('      disabledComponents:')[0];

export type Scenario = {
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
  fingerprintExit?: number;
  preflightCost?: number;
};

export async function runSearchFixture(scenario: Scenario = {}, diagnostic = true) {
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
case "$*" in *--async_start*|*resolve-activity*) cost=$PREFLIGHT_COST;; esac
echo $((clock + cost)) > clock
case "$*" in
 *--list_categories) printf 'pm - Package Manager\n'; if [ "$CATEGORIES" = true ]; then echo 'ss - System Server'; fi;;
 *resolve-activity*) echo "$PROVIDER/.search.SearchActivity";;
 *ro.build.fingerprint) if [ "$FINGERPRINT_EXIT" != 0 ]; then echo "native fingerprint getter failed" >&2; exit "$FINGERPRINT_EXIT"; fi; echo "$FINGERPRINT";;
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
      path.resolve(
        diagnostic
          ? 'scripts/replays/android-search-diagnostic.ts'
          : 'scripts/replays/android-search-prepare.ts',
      ),
      'emulator-own',
      output,
      ...(diagnostic ? [path.join(cwd, 'state'), marker] : []),
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
        FINGERPRINT_EXIT: String(scenario.fingerprintExit ?? 0),
        PREFLIGHT_COST: String(scenario.preflightCost ?? 1000),
      },
    },
  );
  const summary = JSON.parse(
    fs.readFileSync(path.join(output, diagnostic ? 'summary.json' : 'preparation.json'), 'utf8'),
  );
  const calls = fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8');
  return { result, summary, calls, output, marker };
}
