import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

test.each([0, 7])(
  'native diagnostic retains producer evidence and refuses failed probe %i',
  async (probeExit) => {
    const cwd = await mkdtempForTest('android-search-native-');
    fs.mkdirSync(path.join(cwd, 'bin'));
    fs.writeFileSync(
      path.join(cwd, 'bin/adb'),
      String.raw`#!/bin/sh
printf '%s\n' "$*" >> calls.log
case "$*" in *resolve-activity*) echo 'com.google.android.settings.intelligence/.search.SearchActivity';; *) echo "native producer: $*";; esac
case "$*" in *input_method) exit "$PROBE_EXIT";; esac
`,
      { mode: 0o755 },
    );
    const output = path.join(cwd, 'artifacts');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'native-logcat-end.txt'), '2026-10-12T20:00:00Z 143\n');
    const result = runCmdSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve('scripts/replays/android-search-diagnostic.ts'),
        'emulator-own',
        output,
      ],
      {
        cwd,
        allowFailure: true,
        timeoutMs: 10_000,
        env: { PATH: `${cwd}/bin:${process.env.PATH}`, PROBE_EXIT: String(probeExit) },
      },
    );
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
    expect(result.exitCode, result.stderr).toBe(probeExit === 0 ? 0 : 2);
    expect(summary.complete).toBe(probeExit === 0);
    expect(summary.diagnosticOnly).toBe(true);
    expect(summary.loggerExit).toBe(143);
    expect(
      summary.commands.every(
        (command: { args: string[] }) =>
          command.args[0] === '-s' && command.args[1] === 'emulator-own',
      ),
    ).toBe(true);
    expect(fs.readFileSync(path.join(output, 'measured-end-ime.stdout.txt'), 'utf8')).toBe(
      'native producer: -s emulator-own shell dumpsys input_method\n',
    );
    expect(fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8')).toContain(
      'shell dumpsys activity exit-info com.google.android.settings.intelligence',
    );
    expect(fs.existsSync(path.join(output, 'measured-end-ime.stderr.txt'))).toBe(true);
  },
);
