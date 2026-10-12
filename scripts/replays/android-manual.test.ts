import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

test.each([
  [7, false, 7],
  [0, true, 2],
  [7, true, 7],
  [0, true, 11],
] as const)(
  'emulator action preserves suite status %i and separates diagnostic failure',
  async (replayExit, diagnostic, expectedExit) => {
    const cwd = await mkdtempForTest('android-manual-invocation-');
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    const writeTool = (name: string, script: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    writeTool(
      'adb',
      String.raw`if [ "$1" = devices ]; then printf "List of devices attached\nemulator-7000\tdevice\n"; else printf '%s\n' "$*"; trap 'touch logger-stopped; exit 0' TERM; for tick in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; done; fi`,
    );
    writeTool('timeout', 'shift; shift; shift; exec "$@"');
    writeTool(
      'pnpm',
      String.raw`printf "%s\n" "$*" >> "$READINESS_TEST_LOG"
if [ "$1 $2" = "gate replay-android" ]; then
  if [ "$READINESS_TEST_DIAGNOSTIC" = true ]; then read stamp logger < test/artifacts/readiness-experiment/android-diagnostic/native-logcat-start.txt; kill -0 "$logger" || exit 42; sleep 0.1; fi
  exit "$READINESS_TEST_REPLAY_EXIT"
fi`,
    );
    writeTool(
      'node',
      String.raw`if [ "$3" = begin ]; then touch started; sleep 0.1; exit "$READINESS_TEST_BEGIN_EXIT"; fi
if [ "$3" = summarize ]; then touch summarized; exit "$READINESS_TEST_SUMMARY_EXIT"; fi
if [ "$2" = scripts/replays/android-search-diagnostic.ts ]; then read stamp logger < test/artifacts/readiness-experiment/android-diagnostic/native-logcat-start.txt; if kill -0 "$logger" 2>/dev/null; then exit 42; fi; touch diagnosed; exit 2; fi`,
    );
    fs.mkdirSync(path.join(cwd, 'scripts/replays'), { recursive: true });
    fs.copyFileSync(
      'scripts/replays/android-manual.sh',
      path.join(cwd, 'scripts/replays/android-manual.sh'),
    );
    const workflow = parse(fs.readFileSync('.github/workflows/replays-manual.yml', 'utf8'));
    const runner = workflow.jobs['manual-android'].steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('reactivecircus/android-emulator-runner@'),
    );
    const script = runner.with.script
      .replaceAll(/\$\{\{ inputs.readiness_wait \}\}/g, 'enabled')
      .replaceAll(/\$\{\{ inputs.android_diagnostic \}\}/g, String(diagnostic))
      .replaceAll(/\$\{\{ steps.fixture-app.outputs.apk-path \}\}/g, '')
      .replaceAll(/\$\{\{ steps.fixture-app.outputs.app-id \}\}/g, '')
      .replaceAll(/\$\{\{ steps.android-setup.outputs.seconds \}\}/g, '0');
    const commands = script
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith('#'));
    const log = path.join(cwd, 'calls.log');
    let exitCode = 0;
    for (const command of commands) {
      exitCode = runCmdSync('sh', ['-c', command], {
        cwd,
        allowFailure: true,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          ANDROID_SERIAL: 'emulator-legacy',
          AGENT_DEVICE_STATE_DIR: path.join(cwd, 'state'),
          READINESS_TEST_LOG: log,
          READINESS_TEST_REPLAY_EXIT: String(replayExit),
          READINESS_TEST_DIAGNOSTIC: String(diagnostic),
          READINESS_TEST_SUMMARY_EXIT: replayExit === 7 ? '9' : '0',
          READINESS_TEST_BEGIN_EXIT: expectedExit === 11 ? '11' : '0',
        },
      }).exitCode;
      if (exitCode !== 0) break;
    }
    expect(exitCode).toBe(expectedExit);
    expect(fs.existsSync(path.join(cwd, 'started'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'summarized'))).toBe(expectedExit !== 11);
    expect(fs.existsSync(path.join(cwd, 'diagnosed'))).toBe(diagnostic && expectedExit !== 11);
    const native = path.join(cwd, 'test/artifacts/readiness-experiment/android-diagnostic');
    expect(fs.existsSync(native)).toBe(diagnostic);
    if (diagnostic) {
      expect(fs.existsSync(path.join(cwd, 'logger-stopped'))).toBe(true);
      expect(fs.readFileSync(path.join(native, 'native-logcat.stdout.txt'), 'utf8')).toContain(
        '-s emulator-7000 logcat',
      );
    }
    if (expectedExit !== 11)
      expect(fs.readFileSync(log, 'utf8')).toContain(
        'replay-android --serial emulator-7000 --debug --retries 0',
      );
  },
);
