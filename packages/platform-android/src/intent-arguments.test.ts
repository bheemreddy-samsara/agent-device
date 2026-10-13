import { expect, test } from 'vitest';
import fc from 'fast-check';
import { buildAndroidIntentArgs } from './intent-arguments.ts';

const ACTION_ARGS = ['-a', 'android.settings.SETTINGS'];
const PROPERTY_RUNS = 100;

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
    name: 'MIME type retained by AOSP across a selector',
    args: ['-t', 'text/plain', '--selector', '-d', 'content://example/item', '-S'],
    intentArgs: ['-t', 'text/plain', '--selector', '-d', 'content://example/item'],
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
  ['--display', 'not-a-number'],
  ['-R--display'],
  ['-d', 'content://example/item', '--selector', '-t', 'text/plain'],
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
const integerLaunchFlagArb = fc.constantFrom(
  '--sampling',
  '--profiler-output-version',
  '-R',
  '--display',
  '--task-display-area-feature-id',
  '--windowingMode',
  '--activityType',
  '--task',
  '--allow-fgs-start-reason',
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
    .tuple(
      integerLaunchFlagArb,
      fc.oneof(
        fc.integer({ min: -2147483648, max: 2147483647 }).map(String),
        fc.constantFrom('+0', '-0', '0001', '2147483647', '-2147483648', '٠١', '０２'),
      ),
      fc.boolean(),
    )
    .map<ArgumentGroup>(([flag, value, attached]) => ({
      role: 'launch',
      tokens: flag === '-R' && attached ? [flag + value] : [flag, value],
    })),
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
    { numRuns: PROPERTY_RUNS },
  );
});

test('invalid native integer launch controls keep ownership unknown, including in selectors', () => {
  fc.assert(
    fc.property(
      integerLaunchFlagArb,
      fc.constantFrom('', '+', '--display', '1.0', '0x10', ' 1', '2147483648', '-2147483649', '𝟙'),
      fc.array(argumentGroupArb, { maxLength: 10 }),
      (flag, value, groups) => {
        const args = [...groups.flatMap((group) => group.tokens), '--selector', flag, value];
        expect(buildAndroidIntentArgs('android.settings.SETTINGS', args)).toEqual({
          launchArgs: [...ACTION_ARGS, ...args],
          resolutionArgs: undefined,
        });
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});
