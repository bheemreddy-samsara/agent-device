import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import { NETWORK_CAPTURE_TYPED_REASONS } from '@agent-device/contracts/network-capture';
import { networkCaptureSocketPath, type NetworkCaptureScope } from './network-capture-state.ts';

/** One line a reader sends the holder, and the one line it answers with. */
export type NetworkCaptureRequest = Readonly<{
  action: 'drain' | 'stats' | 'stop';
  limit?: number;
}>;

export type NetworkCaptureReply = Readonly<{
  ok: boolean;
  reason?: string;
  message?: string;
  entries?: readonly unknown[];
  dropped?: number;
  buffered?: number;
  notes?: readonly string[];
  capturing?: boolean;
}>;

/**
 * One request-response line to the holder's socket, and nothing more.
 *
 * A holder that cannot be reached is a lost capture rather than a silent empty window: the capture
 * only lives while the holder runs, so a reader that cannot reach it cannot answer for the window.
 */
export function askNetworkCaptureHolder<T extends NetworkCaptureReply = NetworkCaptureReply>(
  scope: NetworkCaptureScope,
  request: NetworkCaptureRequest,
  timeoutMs = 10_000,
): Promise<T> {
  const socketPath = networkCaptureSocketPath(scope);
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      fail(lost('timeout'));
    }, timeoutMs);
    timer.unref?.();
    const fail = (error: AppError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const lost = (detail: string) =>
      new AppError(
        'UNSUPPORTED_OPERATION',
        `The network capture holder for this session did not answer (${detail}), so this read cannot answer for the window it covered.`,
        { reason: NETWORK_CAPTURE_TYPED_REASONS.captureLost },
      );
    socket.on('error', (error) => fail(lost(error.message)));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let reply: NetworkCaptureReply;
      try {
        reply = JSON.parse(buffer.slice(0, newline)) as NetworkCaptureReply;
      } catch {
        fail(lost('unparseable reply'));
        return;
      }
      if (!reply.ok) {
        fail(
          new AppError(
            'UNSUPPORTED_OPERATION',
            reply.message ?? 'The network capture holder refused this read.',
            { reason: reply.reason ?? NETWORK_CAPTURE_TYPED_REASONS.captureLost },
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(reply as T);
    });
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
