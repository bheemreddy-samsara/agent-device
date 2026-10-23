import fs from 'node:fs';
import type {
  AppLogProcessMarkerReadOutcome,
  AppLogSessionArtifacts,
} from '@agent-device/contracts/app-log-runtime';
import type {
  NetworkAppLogRead,
  NetworkCaptureRead,
  NetworkRuntimeHost,
  NetworkTransport,
} from '@agent-device/contracts/network-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { openVerifiedFileForRead } from '@agent-device/host-kit/file';
import { resolveSessionNetworkCapturePath } from '@agent-device/daemon-contracts/session-artifact-paths';
import { appLogRedactionPatterns } from './platform-runtime-app-log-output.ts';

type ProcessMarkerReader = Readonly<{
  readMarker(pathname: string): Promise<AppLogProcessMarkerReadOutcome>;
}>;

/** Upper bound on one capture-probe read, so a long-running session cannot make a dump unbounded. */
const NETWORK_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;

export function createNetworkRuntimeHost(
  options: Readonly<{
    sessionsDir: string;
    env: NodeJS.ProcessEnv;
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    processes: ProcessMarkerReader;
    resolveTransport(device: DeviceInfo): Promise<NetworkTransport>;
  }>,
): Pick<NetworkRuntimeHost, 'appLogs' | 'captureProbe' | 'networkTransports'> {
  return Object.freeze({
    appLogs: Object.freeze({
      resolveSession: options.resolveSessionArtifacts,
      readRecent: async (sessionId: string, maxScanLines: number) => {
        const { outputPath } = options.resolveSessionArtifacts(sessionId);
        return readRecentAppLogLines(outputPath, maxScanLines);
      },
      readProcessMarker: async (sessionId: string) => {
        const { pidPath } = options.resolveSessionArtifacts(sessionId);
        return await options.processes.readMarker(pidPath);
      },
    }),
    captureProbe: Object.freeze({
      readRecent: async (sessionId: string, maxScanLines: number) =>
        readRecentNetworkCaptureLines({
          pathname: resolveSessionNetworkCapturePath(options.sessionsDir, sessionId),
          maxScanLines,
          redactionPatterns: appLogRedactionPatterns(options.env),
        }),
    }),
    networkTransports: Object.freeze({ resolve: options.resolveTransport }),
  });
}

export function readRecentAppLogLines(pathname: string, maxScanLines: number): NetworkAppLogRead {
  if (!Number.isInteger(maxScanLines) || maxScanLines < 1 || maxScanLines > 20_000) {
    throw new TypeError('Network app-log scan lines must be between 1 and 20000');
  }
  const descriptor = openVerifiedFileForRead(pathname);
  if (descriptor === undefined) {
    return Object.freeze({ path: pathname, exists: false, text: '', skippedLines: 0 });
  }
  try {
    const text = fs.readFileSync(descriptor, 'utf8');
    const recent = selectRecentLines(text, maxScanLines);
    return Object.freeze({
      path: pathname,
      exists: true,
      ...recent,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function selectRecentLines(
  text: string,
  maxScanLines: number,
): Readonly<{ text: string; skippedLines: number }> {
  const lines = text.split('\n');
  const skippedLines = Math.max(0, lines.length - maxScanLines);
  return Object.freeze({
    text: lines.slice(skippedLines).join('\n'),
    skippedLines,
  });
}

/**
 * Reads the tail of the capture probe's JSON-lines file for one session. The read is bounded in
 * bytes before it is bounded in lines: a probe file only grows while a session runs, and a dump must
 * stay a bounded read of the newest window. The operator's app-log redaction patterns are applied
 * here, so an entry whose header carries a secret reaches the response already masked.
 */
export function readRecentNetworkCaptureLines(
  input: Readonly<{
    pathname: string;
    maxScanLines: number;
    redactionPatterns: readonly RegExp[];
  }>,
): NetworkCaptureRead {
  if (!Number.isInteger(input.maxScanLines) || input.maxScanLines < 1) {
    throw new TypeError('Network capture scan lines must be a positive integer');
  }
  const descriptor = openVerifiedFileForRead(input.pathname);
  if (descriptor === undefined) {
    return Object.freeze({ path: input.pathname, exists: false, text: '', skippedLines: 0 });
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, NETWORK_CAPTURE_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    const recent = selectRecentLines(buffer.toString('utf8'), input.maxScanLines);
    return Object.freeze({
      path: input.pathname,
      exists: true,
      text: redactCaptureText(recent.text, input.redactionPatterns),
      skippedLines: recent.skippedLines,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function redactCaptureText(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((output, pattern) => output.replace(pattern, '[REDACTED]'), text);
}
