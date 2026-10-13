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
  state?: string;
  history?: string;
  transition?: boolean;
  recheck?: string;
  identity?: string;
  resolvedProvider?: string;
  packageExit?: number;
  fingerprintExit?: number;
  preflightCost?: number;
  readyAfterMs?: number;
};

function createNativeFixture(cwd: string, scenario: Scenario) {
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.writeFileSync(path.join(cwd, 'clock'), '1000000');
  fs.writeFileSync(path.join(cwd, 'package.txt'), scenario.state ?? packageState);
  fs.writeFileSync(path.join(cwd, 'default.txt'), defaultState);
  fs.writeFileSync(
    path.join(cwd, 'recheck.txt'),
    scenario.recheck ?? scenario.state ?? packageState,
  );
  fs.writeFileSync(path.join(cwd, 'history.txt'), scenario.history ?? history);
  fs.writeFileSync(
    path.join(cwd, 'pending-history.txt'),
    history
      .slice(
        history.indexOf('      BroadcastRecord{a820e6e'),
        history.indexOf('      BroadcastRecord{1f473ba'),
      )
      .replace(/^([ \t]*)FAILURE[^\n]+$/m, '$1PENDING (-1) #98: (manifest)')
      .replace('        reason: onApplicationCleanupLocked\n', ''),
  );
  const preload = path.join(cwd, 'clock.mjs');
  fs.writeFileSync(
    preload,
    String.raw`
import fs from 'node:fs';
Date.now = () => Number(fs.readFileSync('clock', 'utf8'));
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (Number(delay) > 250) return nativeSetTimeout(callback, delay, ...args);
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
case "$*" in *resolve-activity*) cost=$PREFLIGHT_COST;; esac
echo $((clock + cost)) > clock
case "$*" in
 *resolve-activity*) echo "$PROVIDER/.search.SearchActivity";;
 *ro.build.fingerprint) if [ "$FINGERPRINT_EXIT" != 0 ]; then echo "native fingerprint getter failed" >&2; exit "$FINGERPRINT_EXIT"; fi; echo "$FINGERPRINT";;
 *"dumpsys package"*)
   count=0; if [ -f package-count ]; then count=$(cat package-count); fi
   count=$((count + 1)); echo "$count" > package-count
   if [ "$PACKAGE_EXIT" != 0 ]; then echo 'native package getter failed' >&2; exit "$PACKAGE_EXIT"; fi
   if [ $((clock + cost)) -lt "$READY_AT" ]; then cat default.txt
   elif [ "$TRANSITION" = true ] && [ "$count" = 1 ]; then cat default.txt
   elif [ "$count" -ge "$RECHECK_AT" ]; then cat recheck.txt
   else cat package.txt; fi;;
 *"broadcasts history") if [ $((clock + cost)) -lt "$READY_AT" ]; then cat pending-history.txt; else cat history.txt; fi;;
 *) echo "native producer: $*";;
esac
`,
    { mode: 0o755 },
  );
  const output = path.join(cwd, 'artifacts/native');
  fs.mkdirSync(output, { recursive: true });
  return { output, preload };
}

function fixtureEnvironment(cwd: string, preload: string, scenario: Scenario) {
  return {
    PATH: `${cwd}/bin:${process.env.PATH}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`]
      .filter(Boolean)
      .join(' '),
    TRANSITION: String(scenario.transition ?? false),
    RECHECK_AT: scenario.transition ? '3' : '2',
    PROVIDER: scenario.resolvedProvider ?? provider,
    FINGERPRINT: scenario.identity ?? fingerprint,
    PACKAGE_EXIT: String(scenario.packageExit ?? 0),
    FINGERPRINT_EXIT: String(scenario.fingerprintExit ?? 0),
    PREFLIGHT_COST: String(scenario.preflightCost ?? 1000),
    READY_AT: String(1_000_000 + (scenario.readyAfterMs ?? 0)),
  };
}

export async function runSearchFixture(scenario: Scenario = {}) {
  const cwd = await mkdtempForTest('android-search-preparation-');
  const { output, preload } = createNativeFixture(cwd, scenario);
  const result = runCmdSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve('scripts/replays/android-search-prepare.ts'),
      'emulator-own',
      output,
    ],
    {
      cwd,
      allowFailure: true,
      timeoutMs: 10_000,
      env: fixtureEnvironment(cwd, preload, scenario),
    },
  );
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'preparation.json'), 'utf8'));
  const calls = fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8');
  return { result, summary, calls, output };
}
