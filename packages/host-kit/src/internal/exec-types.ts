import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  binaryStdout?: boolean;
  stdin?: string | Buffer;
  timeoutMs?: number;
  detached?: boolean;
  signal?: AbortSignal;
  /** Max stdout/stderr bytes for synchronous runs (default Node ~1MB). */
  maxBuffer?: number;
  /**
   * How a deadline or a cancelled request stops the child. Without this it is SIGKILL at
   * once. A child that has to undo something before it dies — the macOS helper releasing a
   * mouse button it is holding — is sent `signal` first, and SIGKILL only once `graceMs`
   * pass without it exiting.
   */
  kill?: { readonly signal: NodeJS.Signals; readonly graceMs: number };
};

export type ExecDetachedExit = {
  pid: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: string;
};

export type ExecDetachedProcess = {
  pid: number;
  exited: Promise<ExecDetachedExit>;
};

export type CommandExecutorOverride = (
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult> | undefined;

export type CommandHostScope = Readonly<{
  host: HostEnvironment;
  requestEnv: EnvMap | undefined;
}>;
