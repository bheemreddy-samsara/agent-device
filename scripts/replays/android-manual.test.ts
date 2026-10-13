import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

const pipeline = (serial: string) => [
  'pnpm|gate build',
  'pnpm|clean:daemon',
  `adb|-s ${serial} install -r fixture.apk`,
  `node|--experimental-strip-types src/bin.ts replay examples/test-app/replays/drag-android.ad --platform android --serial ${serial} --session nightly-android-target-drag --json`,
  'pnpm|clean:daemon',
  'node|--experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-android-emulator.test.ts',
  `env|1|full|${serial}|fixture.apk|com.fixture`,
  'pnpm|gate replay-android --retries 2 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml',
];

const workflow = () => parse(fs.readFileSync('.github/workflows/replays-manual.yml', 'utf8'));

type ShellOptions = {
  serial?: string;
  mode?: string;
  fullExit?: number;
  buildExit?: number;
  preparationExit?: number;
  variantExit?: number;
  replayExit?: number;
  summaryExit?: number;
  preflightExit?: number;
};

async function createShellFixture(options: ShellOptions = {}) {
  const cwd = await mkdtempForTest('android-manual-shell-');
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  const tool = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  tool(
    'pnpm',
    String.raw`printf 'pnpm|%s\n' "$*" >> calls.log
case "$1 $2" in
 'gate build') exit "$BUILD_EXIT";;
 'gate replay-android'|'gate replay-ios') exit "$REPLAY_EXIT";;
esac`,
  );
  tool(
    'adb',
    String.raw`if [ "$1" = devices ]; then
 printf 'List of devices attached\n%s\tdevice\n' "$EXPECTED_SERIAL"
 exit 0
fi
printf 'adb|%s\n' "$*" >> calls.log
test "$1" = -s && test "$2" = "$EXPECTED_SERIAL" || exit 42
exit "$INSTALL_EXIT"`,
  );
  tool(
    'node',
    String.raw`printf 'node|%s\n' "$*" >> calls.log
case "$2 $3" in
 'scripts/replays/android-search-prepare.ts '*) exit "$PREPARATION_EXIT";;
 'scripts/replays/readiness-experiment.ts prepare') exit "$VARIANT_EXIT";;
 'scripts/replays/readiness-experiment.ts begin') exit 0;;
 'scripts/replays/readiness-experiment.ts summarize') exit "$SUMMARY_EXIT";;
 'src/bin.ts prepare') exit "$PREFLIGHT_EXIT";;
esac
if [ "$3" = replay ]; then exit "$DRAG_EXIT"; fi
printf 'env|%s|%s|%s|%s|%s\n' "$AGENT_DEVICE_ANDROID_E2E" "$AGENT_DEVICE_ANDROID_E2E_TIER" "$AGENT_DEVICE_ANDROID_SERIAL" "$AGENT_DEVICE_FIXTURE_APP_PATH" "$AGENT_DEVICE_FIXTURE_APP_ID" >> calls.log
exit "$FULL_EXIT"`,
  );
  tool(
    'date',
    String.raw`case "$(cat clock-index 2>/dev/null || echo 0)" in
 0) echo 100; echo 1 > clock-index;;
 1) echo 120; echo 2 > clock-index;;
 *) echo 145;;
esac`,
  );
  fs.mkdirSync(path.join(cwd, 'scripts/replays'), { recursive: true });
  fs.symlinkSync(
    path.resolve('scripts/replays/android-manual.sh'),
    path.join(cwd, 'scripts/replays/android-manual.sh'),
  );

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    ANDROID_SERIAL: options.serial ?? 'emulator-7000',
    EXPECTED_SERIAL: options.serial ?? 'emulator-7000',
    BUILD_EXIT: String(options.buildExit ?? 0),
    INSTALL_EXIT: '0',
    DRAG_EXIT: '0',
    FULL_EXIT: String(options.fullExit ?? 0),
    REPLAY_EXIT: String(options.replayExit ?? 0),
    PREPARATION_EXIT: String(options.preparationExit ?? 0),
    VARIANT_EXIT: String(options.variantExit ?? 0),
    SUMMARY_EXIT: String(options.summaryExit ?? 0),
    PREFLIGHT_EXIT: String(options.preflightExit ?? 0),
    READINESS_MODE: options.mode ?? 'normal',
    GITHUB_SHA: 'a'.repeat(40),
    AGENT_DEVICE_STATE_DIR: 'state',
    IOS_COMPARISON_UDID: 'simulator-own',
    AGENT_DEVICE_IOS_PREPARE_TIMEOUT_MS: '420000',
  };
  const expand = (script: string) =>
    script
      .replaceAll('${{ steps.fixture-app.outputs.apk-path }}', 'fixture.apk')
      .replaceAll('${{ steps.fixture-app.outputs.app-id }}', 'com.fixture')
      .replaceAll('${{ steps.android-setup.outputs.seconds }}', '90')
      .replaceAll('${{ inputs.readiness_wait }}', options.mode ?? 'normal')
      .replaceAll('${{ steps.ios-simulator.outputs.simulator-udid }}', 'simulator-own');
  const run = (script: string) =>
    runCmdSync('bash', ['-eo', 'pipefail', '-c', expand(script)], {
      cwd,
      env,
      allowFailure: true,
      timeoutMs: 10_000,
    });
  const calls = () => fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8').trim().split('\n');
  const android = () => {
    const runner = workflow().jobs['manual-android'].steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('reactivecircus/android-emulator-runner@'),
    );
    let result = { exitCode: 0, stderr: '', stdout: '' };
    let stdout = '';
    if (options.mode && options.mode !== 'normal') {
      const prepare = workflow().jobs['manual-android'].steps.find(
        (step: { name: string }) => step.name === 'Prepare Android comparison source',
      );
      result = run(prepare.run);
      stdout += result.stdout;
      if (result.exitCode !== 0) return { ...result, stdout };
    }
    // The emulator action executes every script line in a separate shell.
    for (const line of runner.with.script.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      result = run(line);
      stdout += result.stdout;
      if (result.exitCode !== 0) break;
    }
    return { ...result, stdout };
  };
  return { run, calls, android };
}

test.each([
  { serial: 'emulator-7000', fullExit: 0 },
  { serial: 'emulator-8100', fullExit: 0 },
  { serial: 'emulator-8100', fullExit: 13 },
])(
  'manual action preserves serial $serial and full-suite status $fullExit with timing',
  async ({ serial, fullExit }) => {
    const fixture = await createShellFixture({ serial, fullExit });
    const result = fixture.android();
    expect(result.exitCode, result.stderr).toBe(fullExit);
    const expected = pipeline(serial);
    expect(fixture.calls()).toEqual(fullExit === 0 ? expected : expected.slice(0, -1));
    expect(result.stdout).toContain('Android setup before emulator: 10s');
    expect(result.stdout).toContain('Android full scenario wall time: 25s');
  },
);

const comparisonPipeline = (serial: string) => [
  'pnpm|gate build',
  'pnpm|clean:daemon',
  `node|--experimental-strip-types scripts/replays/android-search-prepare.ts ${serial} test/artifacts/readiness-experiment/android-preparation`,
  'node|--experimental-strip-types scripts/replays/readiness-experiment.ts begin android',
  `pnpm|gate replay-android --serial ${serial} --debug --retries 0 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml`,
  'node|--experimental-strip-types scripts/replays/readiness-experiment.ts summarize android state test/artifacts/replays-android.junit.xml',
];

test.each([
  { mode: 'enabled', serial: 'emulator-7000' },
  { mode: 'disabled', serial: 'emulator-8100' },
  { mode: 'enabled', serial: 'emulator-8100', preparationExit: 2 },
  { mode: 'disabled', serial: 'emulator-8100', variantExit: 2 },
  { mode: 'disabled', serial: 'emulator-7000', buildExit: 8 },
  { mode: 'enabled', serial: 'emulator-7000', replayExit: 13, summaryExit: 7 },
  { mode: 'disabled', serial: 'emulator-8100', summaryExit: 7 },
])('Android comparison preserves preparation and measurement boundaries: %j', async (options) => {
  const fixture = await createShellFixture(options);
  const result = fixture.android();
  const expectedStatus =
    options.variantExit ??
    options.buildExit ??
    options.preparationExit ??
    options.replayExit ??
    options.summaryExit ??
    0;
  expect(result.exitCode, result.stderr).toBe(expectedStatus);
  const expected = [
    `node|--experimental-strip-types scripts/replays/readiness-experiment.ts prepare ${options.mode} ${'a'.repeat(40)}`,
    ...comparisonPipeline(options.serial),
  ];
  expect(fixture.calls()).toEqual(
    options.variantExit
      ? expected.slice(0, 1)
      : options.buildExit
        ? expected.slice(0, 2)
        : options.preparationExit
          ? expected.slice(0, 4)
          : expected,
  );
});

test.each([
  { mode: 'enabled' },
  { mode: 'disabled' },
  { mode: 'enabled', variantExit: 2 },
  { mode: 'disabled', preflightExit: 9 },
  { mode: 'enabled', replayExit: 13, summaryExit: 7 },
  { mode: 'disabled', summaryExit: 7 },
])(
  'iOS comparison runs selected-source build and preflight outside measurement: %j',
  async (options) => {
    const fixture = await createShellFixture(options);
    const steps = workflow().jobs['manual-ios'].steps;
    const setup = steps.find(
      (step: { name: string }) => step.name === 'Prepare and build iOS comparison source',
    );
    const preflight = steps.find(
      (step: { name: string }) => step.name === 'Preflight iOS runner through public CLI',
    );
    const replay = steps.find(
      (step: { name: string }) => step.name === 'Run iOS comparison replay suite',
    );
    let result = fixture.run(setup.run);
    if (result.exitCode === 0) result = fixture.run(preflight.run);
    if (result.exitCode === 0) result = fixture.run(replay.run);
    expect(result.exitCode, result.stderr).toBe(
      options.variantExit ??
        options.preflightExit ??
        options.replayExit ??
        options.summaryExit ??
        0,
    );
    const expected = [
      `node|--experimental-strip-types scripts/replays/readiness-experiment.ts prepare ${options.mode} ${'a'.repeat(40)}`,
      'pnpm|gate build',
      'pnpm|clean:daemon',
      'node|--experimental-strip-types src/bin.ts prepare ios-runner --platform ios --udid simulator-own --timeout 420000 --json',
      'node|--experimental-strip-types scripts/replays/readiness-experiment.ts begin ios',
      'pnpm|gate replay-ios --udid simulator-own --debug --retries 0 --artifacts-dir test/artifacts/replays-ios-simulator --report-junit test/artifacts/replays-ios-simulator.junit.xml',
      'node|--experimental-strip-types scripts/replays/readiness-experiment.ts summarize ios state test/artifacts/replays-ios-simulator.junit.xml',
    ];
    expect(fixture.calls()).toEqual(
      options.variantExit
        ? expected.slice(0, 1)
        : options.preflightExit
          ? expected.slice(0, 4)
          : expected,
    );
    expect(steps.indexOf(setup)).toBeLessThan(
      steps.findIndex(
        (step: { name: string }) => step.name === 'Restore and build iOS XCTest runner',
      ),
    );
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(replay));
  },
);
