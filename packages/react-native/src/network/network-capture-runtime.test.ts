import { test } from 'vitest';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  NETWORK_CAPTURE_HEADER_CHARS,
  NETWORK_CAPTURE_MAX_ENTRIES,
  NETWORK_CAPTURE_RUNTIME_SOURCE,
  NETWORK_CAPTURE_RUNTIME_VERSION,
} from './network-capture-runtime.ts';

/**
 * The runtime source is injected as a string into the app's JavaScript runtime, so nothing else
 * proves it parses, patches what it claims, and honors the body opt-in. These run it as written
 * against a minimal fetch/XHR stand-in.
 */
function installRuntime(context: Record<string, unknown>, captureBodies: boolean): void {
  const source = `(${NETWORK_CAPTURE_RUNTIME_SOURCE})("test", ${NETWORK_CAPTURE_MAX_ENTRIES}, 2048, ${NETWORK_CAPTURE_HEADER_CHARS}, ${captureBodies ? 'true' : 'false'})`;
  vm.runInNewContext(source, context);
}

function responseFixture(): unknown {
  return {
    status: 201,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    // No stream and no clone: the metadata path is the point, the body path is separate.
    body: undefined,
    text: async () => '{"hello":"world"}',
  };
}

test('the hook records a fetch with its metadata and never changes the app response', async () => {
  const context: Record<string, unknown> = {
    fetch: async () => responseFixture(),
    XMLHttpRequest: undefined,
    URLSearchParams,
    TextDecoder,
  };
  installRuntime(context, false);

  const callFetch = context.fetch as (input: string) => Promise<unknown>;
  const response = (await callFetch('https://api.test/a')) as { status: number };
  assert.equal(response.status, 201, 'the app receives the response it asked for');

  const state = context as { __AGENT_DEVICE_NETWORK__?: { drain: (n: number) => string } };
  const drained = JSON.parse(state.__AGENT_DEVICE_NETWORK__!.drain(10)) as {
    entries: Array<Record<string, unknown>>;
  };
  assert.equal(drained.entries.length, 1);
  assert.equal(drained.entries[0]?.url, 'https://api.test/a');
  assert.equal(drained.entries[0]?.status, 201);
  assert.equal(drained.entries[0]?.transport, 'fetch');
});

test('a hook installed without the body opt-in never records a body', async () => {
  const context: Record<string, unknown> = {
    fetch: async () => responseFixture(),
    XMLHttpRequest: undefined,
    URLSearchParams,
    TextDecoder,
  };
  installRuntime(context, false);

  const callFetch = context.fetch as (input: string, init?: unknown) => Promise<unknown>;
  await callFetch('https://api.test/a', { method: 'POST', body: 'secret-payload' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = context as { __AGENT_DEVICE_NETWORK__?: { drain: (n: number) => string } };
  const drained = JSON.parse(state.__AGENT_DEVICE_NETWORK__!.drain(10)) as {
    entries: Array<Record<string, unknown>>;
  };
  assert.equal(drained.entries.length, 1);
  assert.equal('requestBody' in (drained.entries[0] ?? {}), false);
  assert.equal('responseBody' in (drained.entries[0] ?? {}), false);
});

test('the second install of the same hook keeps the one buffer and reports ready', () => {
  const context: Record<string, unknown> = {
    fetch: async () => responseFixture(),
    XMLHttpRequest: undefined,
    URLSearchParams,
    TextDecoder,
  };
  assert.equal(runInstall(context, true), 'installed');
  assert.equal(runInstall(context, true), 'ready');

  function runInstall(target: Record<string, unknown>, bodies: boolean): string {
    const source = `(${NETWORK_CAPTURE_RUNTIME_SOURCE})(${JSON.stringify(NETWORK_CAPTURE_RUNTIME_VERSION)}, ${NETWORK_CAPTURE_MAX_ENTRIES}, 2048, ${NETWORK_CAPTURE_HEADER_CHARS}, ${bodies ? 'true' : 'false'})`;
    return vm.runInNewContext(source, target) as string;
  }
});
