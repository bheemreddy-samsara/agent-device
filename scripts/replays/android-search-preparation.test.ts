import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  runSearchFixture,
  provider,
  packageState,
  defaultState,
  history,
  type Scenario,
} from './fixtures/android-search-native.ts';

test('natural transition preserves default and disabled observations without GUI', async () => {
  const { result, summary, calls, output } = await runSearchFixture({ transition: true }, false);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    summary.observations.map(
      (observation: { state: { disabled: string[] } }) => observation.state.disabled.length,
    ),
  ).toEqual([0, 2]);
  expect(summary.observations[1].killRecords.map((record: { id: string }) => record.id)).toEqual([
    '6b135e3',
    '1f473ba',
  ]);
  expect(summary.observations[1].deliveries).toEqual([
    { record: 'a820e6e', index: 98, state: 'FAILURE' },
  ]);
  expect(summary.complete).toBe(true);
  expect(summary.satisfied).toBe(true);
  expect(summary.serial).toBe('emulator-own');
  expect(summary.provider).toBe(provider);
  expect(summary.uid).toBe(10145);
  expect(summary.fingerprint).toContain('emu64xa:16/');
  expect(summary.finishedAt - summary.startedAt).toBeLessThanOrEqual(40_000);
  expect(
    summary.commands.every(
      (command: { timeoutMs: number }) => command.timeoutMs > 0 && command.timeoutMs <= 15_000,
    ),
  ).toBe(true);
  expect(
    calls
      .split('\n')
      .filter(Boolean)
      .every((line) => line.startsWith('-s emulator-own ')),
  ).toBe(true);
  expect(calls).not.toMatch(
    /shell (?:am start|input|ime |pm (?:enable|disable)|cmd package (?:enable|disable|set-))/,
  );
  expect(calls).not.toContain('REPLAY');
  expect(calls).not.toContain('atrace');
  expect(fs.readFileSync(path.join(output, 'prep-0-package.stdout.txt'), 'utf8')).toBe(
    defaultState,
  );
  expect(fs.readFileSync(path.join(output, 'prep-1-broadcasts.stdout.txt'), 'utf8')).toBe(history);
});

test.each([
  ['default state', { state: defaultState }],
  [
    'not installed for user 0',
    { state: packageState.replace('installed=true', 'installed=false') },
  ],
  ['wrong user state', { state: packageState.replace('User 0:', 'User 10:') }],
  [
    'missing component state',
    {
      state: packageState.replace(
        `${provider}.modules.battery.impl.usage.PeriodicJobReceiver`,
        'other.Receiver',
      ),
    },
  ],
  ['no package callback', { history: history.replaceAll('PACKAGE_CHANGED', 'PACKAGE_ADDED') }],
  [
    'non-killing callback',
    { history: history.replaceAll('DONT_KILL_APP=false', 'DONT_KILL_APP=true') },
  ],
  [
    'replacement callback',
    {
      history: history.replaceAll(
        'DONT_KILL_APP=false',
        'DONT_KILL_APP=false, android.intent.extra.REPLACING=true',
      ),
    },
  ],
  ['wrong callback user', { history: history.replaceAll('/u0} to user 0', '/u10} to user 10') }],
  ['wrong affected UID', { history: history.replaceAll('extra.UID=10145', 'extra.UID=1000') }],
  [
    'wrong component callback',
    {
      history: history.replaceAll(
        'changed_component_name_list=[com.google.android.settings.intelligence.modules.battery.impl.usage.PeriodicJobReceiver]',
        'changed_component_name_list=[other.Receiver]',
      ),
    },
  ],
  [
    'ongoing BOOT delivery',
    { history: history.replace('FAILURE scheduled', 'SCHEDULED scheduled') },
  ],
  [
    'wrong BOOT receiver',
    {
      history: history.replace(
        '\n          name=com.google.android.settings.intelligence.modules.battery.impl.usage.BootBroadcastReceiver',
        '\n          name=other.BootBroadcastReceiver',
      ),
    },
  ],
  ['state reverted during recheck', { recheck: defaultState }],
  ['unsupported image', { identity: 'other/image' }],
  ['unsupported provider', { resolvedProvider: 'other.provider' }],
  ['failed getter', { packageExit: 3 }],
  ['preflight consumes preparation budget', { preflightCost: 40_000 }],
] satisfies [string, Scenario][])(
  'native preparation refuses %s without invoking GUI',
  async (_name, scenario) => {
    const { result, summary, calls } = await runSearchFixture(scenario, false);
    expect(result.exitCode, result.stderr).toBe(2);
    expect(summary.complete).toBe(false);
    expect(summary.satisfied).toBe(false);
    expect(summary.replayExit).toBeUndefined();
    expect(calls).not.toContain('REPLAY');
    expect(calls).not.toContain('atrace');
    expect(summary.error).toBeTruthy();
    const prepCommands = summary.commands.filter((command: { name: string }) =>
      command.name.startsWith('prep-'),
    );
    expect(
      prepCommands.every(
        (command: { startedAt: number; timeoutMs: number }) =>
          command.startedAt + command.timeoutMs <= summary.startedAt + 40_000,
      ),
    ).toBe(true);
  },
);
