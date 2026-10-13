import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTest } from '@agent-device/test-kit/tmp-dir';
import { captureReplayCommand } from './replay-command-evidence.ts';

test('command evidence retains both producer pipes and nonzero status', async () => {
  const outputDir = await mkdtempForTest('replay-command-evidence-');
  const captured = await captureReplayCommand({
    name: 'native',
    executable: process.execPath,
    args: [
      '-e',
      String.raw`process.stdout.write("raw stdout\nλ"); process.stderr.write("raw stderr\n"); process.exitCode = 7`,
    ],
    outputDir,
    timeoutMs: 2000,
  });
  expect(captured.result.exitCode).toBe(7);
  expect(fs.readFileSync(path.join(outputDir, 'native.stdout.txt'), 'utf8')).toBe('raw stdout\nλ');
  expect(fs.readFileSync(path.join(outputDir, 'native.stderr.txt'), 'utf8')).toBe('raw stderr\n');
  expect(captured.record).toMatchObject({
    exitCode: 7,
    executable: process.execPath,
    timeoutMs: 2000,
    failure: undefined,
  });
  expect(captured.record.finishedAt).toBeGreaterThanOrEqual(captured.record.startedAt);
});

test('command launch failure retains normalized details and evidence status', async () => {
  const outputDir = await mkdtempForTest('replay-command-evidence-');
  const executable = path.join(outputDir, 'not-installed');
  const captured = await captureReplayCommand({
    name: 'native',
    executable,
    args: ['raw-argument'],
    outputDir,
    timeoutMs: 2000,
  });
  expect(captured.record).toMatchObject({
    exitCode: -1,
    args: ['raw-argument'],
    failure: { code: 'TOOL_MISSING', details: { cmd: executable } },
  });
  expect(fs.readFileSync(path.join(outputDir, 'native.stdout.txt'), 'utf8')).toBe('');
  expect(fs.readFileSync(path.join(outputDir, 'native.stderr.txt'), 'utf8')).toContain(executable);
});

test('a timed-out producer retains its partial pipes and typed timeout details', async () => {
  const outputDir = await mkdtempForTest('replay-command-timeout-');
  const captured = await captureReplayCommand({
    name: 'native',
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("before timeout"); process.stderr.write("producer stalled"); setInterval(() => {}, 1000)',
    ],
    outputDir,
    timeoutMs: 200,
  });
  expect(captured.record.failure).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { timeoutMs: 200 },
  });
  expect(fs.readFileSync(path.join(outputDir, 'native.stdout.txt'), 'utf8')).toBe('before timeout');
  expect(fs.readFileSync(path.join(outputDir, 'native.stderr.txt'), 'utf8')).toBe(
    'producer stalled',
  );
});
