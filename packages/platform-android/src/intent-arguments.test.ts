import { expect, test } from 'vitest';
import fc from 'fast-check';
import { buildAndroidIntentArgs } from './intent-arguments.ts';

const ACTION_ARGS = ['-a', 'android.settings.SETTINGS'];

test.each([
  {
    name: 'attached short values and extras resembling launch options',
    args: ['-R2', '-ncom.example/.Main', '-ekey', '--display', '-P-S', '--esn', '-S', '-S'],
    intentArgs: ['-ncom.example/.Main', '-ekey', '--display', '--esn', '-S'],
  },
  {
    name: 'selector arguments',
    args: ['-S', '--selector', '-a', 'com.example.VIEW', '--display', '0', '-p', 'com.example'],
    intentArgs: ['--selector', '-a', 'com.example.VIEW', '-p', 'com.example'],
  },
  {
    name: 'positional component and unparsed trailing tokens',
    args: ['-S', 'com.example/.Main', '--display', '0'],
    intentArgs: ['com.example/.Main', '--display', '0'],
  },
  {
    name: 'explicit end of options',
    args: ['-S', '--', 'com.example/.Main', '-R', '2'],
    intentArgs: ['--', 'com.example/.Main', '-R', '2'],
  },
])('intent arguments preserve AOSP token boundaries for $name', ({ args, intentArgs }) => {
  expect(buildAndroidIntentArgs('android.settings.SETTINGS', args)).toEqual({
    launchArgs: [...ACTION_ARGS, ...args],
    resolutionArgs: [...ACTION_ARGS, ...intentArgs],
  });
});

test.each([
  ['--future-option', '-p', 'com.other'],
  ['--display=1'],
  ['-R'],
  ['--es', 'key'],
  ['-Sattached'],
  ['intent:#Intent;scheme=content;end'],
])('unprojectable launch arguments retain unknown ownership: %j', (...args) => {
  expect(buildAndroidIntentArgs('android.settings.SETTINGS', args)).toEqual({
    launchArgs: [...ACTION_ARGS, ...args],
    resolutionArgs: undefined,
  });
});

type ArgumentGroup = { role: 'intent' | 'launch'; tokens: string[] };

const flagLikeValueArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom('-S', '-R', '--display', '--user', '--selector', '--', ''),
);
const argumentGroupArb: fc.Arbitrary<ArgumentGroup> = fc.oneof(
  fc
    .tuple(fc.constantFrom('-a', '-d', '-t', '-i', '-c', '-p'), flagLikeValueArb)
    .map<ArgumentGroup>((tokens) => ({ role: 'intent', tokens })),
  fc
    .tuple(fc.constantFrom('-e', '--es', '--esa', '--esal'), flagLikeValueArb, flagLikeValueArb)
    .map<ArgumentGroup>((tokens) => ({ role: 'intent', tokens })),
  flagLikeValueArb.map<ArgumentGroup>((key) => ({ role: 'intent', tokens: ['--esn', key] })),
  fc
    .constantFrom('-S', '-W', '-D', '--task-overlay')
    .map<ArgumentGroup>((flag) => ({ role: 'launch', tokens: [flag] })),
  fc
    .tuple(fc.constantFrom('-P', '--attach-agent'), flagLikeValueArb)
    .map<ArgumentGroup>((tokens) => ({ role: 'launch', tokens })),
  fc
    .tuple(fc.constantFrom('-R', '--display'), fc.nat({ max: 20 }))
    .map<ArgumentGroup>(([flag, value]) => ({ role: 'launch', tokens: [flag, String(value)] })),
);

test('intent projection preserves whole argument groups while launch preserves the original stream', () => {
  fc.assert(
    fc.property(fc.array(argumentGroupArb, { maxLength: 25 }), (groups) => {
      const args = ['-t', 'application/test', ...groups.flatMap((group) => group.tokens)];
      const intentArgs = [
        '-t',
        'application/test',
        ...groups.filter((group) => group.role === 'intent').flatMap((group) => group.tokens),
      ];
      expect(buildAndroidIntentArgs('android.settings.SETTINGS', args)).toEqual({
        launchArgs: [...ACTION_ARGS, ...args],
        resolutionArgs: [...ACTION_ARGS, ...intentArgs],
      });
    }),
  );
});
