import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runSearchFixture } from './fixtures/android-search-native.ts';

test.each([
  [0, 0, true, '786432', 0],
  [7, 0, true, '786432', 7],
  [0, 3, true, '786432', 2],
  [0, 0, false, '786432', 2],
  [0, 0, true, '0', 2],
] as const)(
  'actor diagnostic separates replay=%i probe=%i category support=%s mask=%s',
  async (replayExit, probeExit, categories, mask, status) => {
    const { result, summary, calls, output, marker } = await runSearchFixture({
      replayExit,
      probeExit,
      categories,
      mask,
    });

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

test('refused preparation retains resolved provider evidence without replay', async () => {
  const { result, summary, calls, output } = await runSearchFixture({ fingerprintExit: 3 });
  expect(result.exitCode, result.stderr).toBe(2);
  expect(summary.preparation.satisfied).toBe(false);
  expect(summary.preparation.provider).toBe('com.google.android.settings.intelligence');
  expect(summary.replayExit).toBeUndefined();
  expect(calls).not.toContain('REPLAY');
  expect(summary.traceProbeComplete).toBe(false);
  expect(fs.readFileSync(path.join(output, 'provider-after.stdout.txt'), 'utf8')).toContain(
    'appId=10145',
  );
  expect(fs.readFileSync(path.join(output, 'search-exit-info.stdout.txt'), 'utf8')).toBe(
    'native producer: -s emulator-own shell dumpsys activity exit-info com.google.android.settings.intelligence\n',
  );
});

test('diagnostic refuses a native transition after45s within its original40s preparation', async () => {
  const { result, summary, calls } = await runSearchFixture({ readyAfterMs: 45_000 });
  expect(result.exitCode, result.stderr).toBe(2);
  expect(summary.preparation.satisfied).toBe(false);
  expect(summary.preparation.budgetMs).toBe(40_000);
  expect(summary.replayExit).toBeUndefined();
  expect(summary.traceProbeComplete).toBe(false);
  expect(calls).not.toContain('REPLAY');
  expect(calls).toContain('--async_stop');
});
