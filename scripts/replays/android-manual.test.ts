import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

test.each([
  [false, 7, false, 0, 7],
  [true, 2, false, 0, 2],
  [true, 7, false, 0, 7],
  [true, 0, true, 0, 143],
  [true, 0, false, 1, 2],
  [true, 7, false, 1, 7],
] as const)(
  'manual diagnostic=%s helper=%i interruption=%s logcat=%i cleans only owned collectors',
  async (diagnostic, commandExit, interrupt, logcatExit, expectedExit) => {
    const cwd = await mkdtempForTest('android-manual-actor-');
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    const tool = (name: string, script: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    tool('timeout', 'while [ "${1#--}" != "$1" ]; do shift; done; shift; exec "$@"');
    tool(
      'adb',
      String.raw`case "$*" in
 devices) printf 'List of devices attached\nemulator-7000\tdevice\n';;
 *logcat*) printf '%s\n' "$*"; if [ "$LOGCAT_FAILURE" != 0 ]; then exit "$LOGCAT_FAILURE"; fi; trap 'touch logger-stopped; exit 0' TERM; touch logger-ready; for tick in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do sleep 0.1; done;;
 *--async_stop) printf '%s\n' "$*" > trace-stopped;;
esac`,
    );
    tool(
      'pnpm',
      String.raw`printf '%s\n' "$*" >> calls.log
if [ "$1 $2" = 'gate replay-android' ]; then exit "$COMMAND_EXIT"; fi`,
    );
    tool(
      'node',
      String.raw`if [ "$3" = begin ]; then touch begun; fi
if [ "$3" = summarize ]; then touch summarized; exit 9; fi
if [ "$2" = scripts/replays/android-search-diagnostic.ts ]; then
 read stamp logger < "$4/native-logcat-start.txt"
 if [ "$LOGCAT_FAILURE" = 0 ]; then
   ticks=0
   while [ ! -f logger-ready ] && [ "$ticks" -lt 100 ]; do
     kill -0 "$logger" || exit 42
     sleep 0.01; ticks=$((ticks + 1))
   done
   test -f logger-ready && kill -0 "$logger" || exit 42
 fi
 touch "$6"; sleep 0.1
 if [ "$INTERRUPT" = true ]; then kill -TERM "$PPID"; fi
 exit "$COMMAND_EXIT"
fi`,
    );
    fs.mkdirSync(path.join(cwd, 'scripts/replays'), { recursive: true });
    fs.symlinkSync(
      path.resolve('scripts/replays/android-manual.sh'),
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
    let result = { exitCode: 0, stderr: '' };
    for (const command of script
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line && !line.startsWith('#'))) {
      result = runCmdSync('sh', ['-c', command], {
        cwd,
        allowFailure: true,
        timeoutMs: 10_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          AGENT_DEVICE_STATE_DIR: path.join(cwd, 'state'),
          COMMAND_EXIT: String(commandExit),
          INTERRUPT: String(interrupt),
          LOGCAT_FAILURE: String(logcatExit),
        },
      });
      if (result.exitCode !== 0) break;
    }
    expect(result.exitCode, result.stderr).toBe(expectedExit);
    expect(fs.existsSync(path.join(cwd, 'begun'))).toBe(!diagnostic);
    expect(fs.existsSync(path.join(cwd, 'summarized'))).toBe(!diagnostic);
    if (diagnostic) {
      expect(fs.existsSync(path.join(cwd, 'logger-stopped'))).toBe(logcatExit === 0);
      expect(fs.readFileSync(path.join(cwd, 'trace-stopped'), 'utf8')).toBe(
        '-s emulator-7000 shell atrace --async_stop\n',
      );
      const dir = path.join(cwd, 'test/artifacts/readiness-experiment/android-diagnostic');
      expect(
        fs.readFileSync(path.join(dir, 'native-logcat-end.txt'), 'utf8').trim().split(' ')[1],
      ).toBe(String(logcatExit));
      expect(fs.readdirSync(dir).some((file) => file.startsWith('atrace-owned-'))).toBe(false);
      expect(fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8')).not.toContain(
        'gate replay-android',
      );
    } else {
      expect(fs.existsSync(path.join(cwd, 'trace-stopped'))).toBe(false);
      expect(fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8')).toContain(
        'replay-android --serial emulator-7000 --debug --retries 0',
      );
    }
  },
);
