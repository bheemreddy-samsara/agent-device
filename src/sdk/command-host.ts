import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { withCommandHost } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** Released SDK defaults capture the process once per entry call until #3759 supplies a host API. */
export function withSdkCommandHost<T>(
  task: (host: HostEnvironment) => T,
  host = captureHostEnvironment(process),
): T {
  return withCommandHost({ host, requestEnv: undefined }, () => task(host));
}
