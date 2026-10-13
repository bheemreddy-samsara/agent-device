import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { normalizeError } from '@agent-device/kernel/errors';

export async function captureReplayCommand({
  name,
  executable,
  args,
  outputDir,
  timeoutMs,
}: {
  name: string;
  executable: string;
  args: string[];
  outputDir: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let result;
  let failure;
  try {
    result = await runCmd(executable, args, {
      allowFailure: true,
      timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    failure = normalizeError(error);
    result = {
      exitCode: -1,
      stdout: typeof failure.details?.stdout === 'string' ? failure.details.stdout : '',
      stderr: typeof failure.details?.stderr === 'string' ? failure.details.stderr : String(error),
    };
  }
  fs.writeFileSync(path.join(outputDir, `${name}.stdout.txt`), result.stdout);
  fs.writeFileSync(path.join(outputDir, `${name}.stderr.txt`), result.stderr);
  return {
    result,
    record: {
      name,
      executable,
      args,
      exitCode: result.exitCode,
      failure,
      startedAt,
      finishedAt: Date.now(),
      timeoutMs,
    },
  };
}
