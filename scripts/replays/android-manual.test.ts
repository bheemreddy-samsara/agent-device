import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

test.each([
  [false, 7, false, 7],
  [true, 2, false, 2],
  [true, 7, false, 7],
  [true, 0, true, 143],
] as const)(
  'manual diagnostic=%s exit=%i interruption=%s cleans only owned collectors',
  async (diagnostic, commandExit, interrupt, expectedExit) => {
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
 *logcat*) printf '%s\n' "$*"; trap 'touch logger-stopped; exit 0' TERM; for tick in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; done;;
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
 read stamp logger < "$4/native-logcat-start.txt"; kill -0 "$logger" || exit 42
 touch "$6"; sleep 0.1
 if [ "$INTERRUPT" = true ]; then kill -TERM "$PPID"; fi
 exit "$COMMAND_EXIT"
fi`,
    );
    const result = runCmdSync(
      'sh',
      [
        path.resolve('scripts/replays/android-manual.sh'),
        'enabled',
        '',
        '',
        '0',
        String(diagnostic),
      ],
      {
        cwd,
        allowFailure: true,
        timeoutMs: 10_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          AGENT_DEVICE_STATE_DIR: path.join(cwd, 'state'),
          COMMAND_EXIT: String(commandExit),
          INTERRUPT: String(interrupt),
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(expectedExit);
    expect(fs.existsSync(path.join(cwd, 'begun'))).toBe(!diagnostic);
    expect(fs.existsSync(path.join(cwd, 'summarized'))).toBe(!diagnostic);
    if (diagnostic) {
      expect(fs.existsSync(path.join(cwd, 'logger-stopped'))).toBe(true);
      expect(fs.readFileSync(path.join(cwd, 'trace-stopped'), 'utf8')).toBe(
        '-s emulator-7000 shell atrace --async_stop\n',
      );
      const dir = path.join(cwd, 'test/artifacts/readiness-experiment/android-diagnostic');
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
