import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { runNetworkCaptureHolderProcess } from './network-capture-holder-process.ts';

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
