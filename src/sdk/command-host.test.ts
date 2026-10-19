import assert from 'node:assert/strict';
import { test } from 'vitest';
import { commandHostEnvironment } from '@agent-device/host-kit/command';
import { withSdkCommandHost } from './command-host.ts';

test('SDK scopes keep synchronous return values and exceptions synchronous', () => {
  const host = { env: { SDK_HOST: 'owned' }, cwd: '/sdk' };
  assert.equal(
    withSdkCommandHost(() => commandHostEnvironment().env.SDK_HOST, host),
    'owned',
  );
  const failure = new Error('construction failed');
  assert.throws(
    () =>
      withSdkCommandHost(() => {
        throw failure;
      }, host),
    (error) => error === failure,
  );
  assert.throws(() => commandHostEnvironment(), {
    details: { reason: 'host_environment_unscoped' },
  });
});
