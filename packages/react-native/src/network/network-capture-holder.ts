import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { runNetworkCaptureHolderProcess } from './network-capture-holder-process.ts';

// Everything this process writes — its socket, its status file — describes one person's captured
// traffic. Pinning the umask at the entry makes owner-only the mode everything is born with.
process.umask(0o077);

void runNetworkCaptureHolderProcess(captureHostEnvironment(process).env, {
  pid: process.pid,
  exit: (code) => {
    process.exitCode = code;
    process.exit(code);
  },
  report: (message) => {
    process.stderr.write(message);
  },
  onTerminate: (shutdown) => {
    process.on('SIGTERM', shutdown);
  },
}).catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
