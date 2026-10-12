import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';

test.each([
  [0, 0, true, '786432', 0],
  [7, 0, true, '786432', 7],
  [0, 3, true, '786432', 2],
  [0, 0, false, '786432', 2],
  [0, 0, true, '0', 2],
] as const)(
  'actor diagnostic separates replay=%i probe=%i category support=%s mask=%s',
  async (replayExit, probeExit, categories, mask, status) => {
    const cwd = await mkdtempForTest('android-search-actor-');
    fs.mkdirSync(path.join(cwd, 'bin'));
    fs.writeFileSync(
      path.join(cwd, 'bin/adb'),
      String.raw`#!/bin/sh
printf '%s\n' "$*" >> calls.log
case "$*" in
 *--list_categories) printf 'pm - Package Manager\n'; if [ "$CATEGORIES" = true ]; then echo 'ss - System Server'; fi;;
 *resolve-activity*) echo 'com.google.android.settings.intelligence/.search.SearchActivity';;
 *debug.atrace.tags.enableflags) echo "$MASK";;
 *--async_stop) echo 'trace_event_clock_sync: realtime_ts=1000'; echo 'broadcastPackageChanged; cpnft=caller.raw';;
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
    fs.writeFileSync(
      path.join(corpusDir, '04-text-input-keyboard.ad'),
      'context platform=android\n',
    );
    fs.writeFileSync(path.join(corpusDir, '01-settings.ad'), 'snapshot\n');
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
          REPLAY_EXIT: String(replayExit),
          PROBE_EXIT: String(probeExit),
          CATEGORIES: String(categories),
          MASK: mask,
        },
      },
    );
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
    const calls = fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8');
    const replayReached = categories && mask !== '0';
    expect(result.exitCode, result.stderr).toBe(status);
    expect(summary.traceProbeComplete).toBe(replayReached && probeExit === 0);
    expect(summary.diagnosticOnly).toBe(true);
    expect(summary.validForDecision).toBe(false);
    expect(summary.variant.head).toBe('source-variant');
    expect(summary.corpus).toHaveLength(2);
    expect(fs.existsSync(marker)).toBe(false);
    expect(calls.includes('REPLAY')).toBe(replayReached);
    expect(calls.includes('--async_stop')).toBe(categories);
    expect(
      summary.commands.every(
        (command: { timeoutMs: number }) => command.timeoutMs > 0 && command.timeoutMs <= 180_000,
      ),
    ).toBe(true);
    if (replayReached) {
      expect(calls.indexOf('--async_start')).toBeLessThan(calls.indexOf('REPLAY'));
      expect(calls.indexOf('--async_stop')).toBeGreaterThan(calls.indexOf('REPLAY'));
      expect(calls).toContain(
        'test/integration/replays/android/emulator/04-text-input-keyboard.ad',
      );
      expect(calls).toContain('"--serial","emulator-own"');
      expect(summary.replayExit).toBe(replayExit);
      expect(fs.readFileSync(path.join(output, 'atrace-stop.stdout.txt'), 'utf8')).toContain(
        'cpnft=caller.raw',
      );
      expect(fs.readFileSync(path.join(output, 'measured-end-ime.stdout.txt'), 'utf8')).toBe(
        'native producer: -s emulator-own shell dumpsys input_method\n',
      );
    }
  },
);
