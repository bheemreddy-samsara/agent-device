import assert from 'node:assert/strict';
import { test } from 'vitest';
import { usage, usageForCommand } from '../../cli/parser/args.ts';
import { helpTopicIds } from './cli-help.ts';

// Agents often read only the first screen of a help text, and the help benchmark caps the root
// help at 30 lines (`--help:first30`). Each entry pins the rules that keep an agent safe on that
// screen: prerequisites, refusals, verification steps, and recovery. A new topic must declare its
// own entry.
const FIRST_SCREEN_LINES = 30;
const ROOT_HELP = '--help';

const FIRST_SCREEN_RULES: Record<string, readonly string[]> = {
  [ROOT_HELP]: [
    'agent-device open <app> --foreground',
    'Do not probe first with devices, apps, appstate, snapshot, or screenshot',
    'Never invent ids',
    'A bare screenshot is not verification',
    'End with: agent-device close',
  ],
  commands: ['Use agent-device help <command> for exact flags and behavior', 'Commands:'],
  'manual-qa': [
    'Do not explore unrelated screens',
    'stop and report the ambiguity',
    'Use --relaunch only when the script needs fresh state',
    'If --settle prints not settled, follow its hint',
    'A bare screenshot/snapshot is not verification',
  ],
  maestro: [
    'replay <flow.yaml> --maestro',
    'there is no silent all: allow default',
    'do not place secrets in diagnostic identifiers',
    'not a security sandbox',
    'Unsupported syntax fails with an explicit error',
  ],
  workflow: [
    'never a placeholder (@ref, @eN, @Label_Name)',
    'every platform rejects a stale pinned ref',
    'Never open artifact paths or invent package ids',
    'help tv (Android TV, tvOS, Vega VVD remote)',
    'Matches in distinct subtrees fail with AMBIGUOUS_MATCH',
  ],
  scripting: [
    'scroll down --until <selector>',
    'add an explicit landmark wait',
    '--record-as PASSWORD',
    'contain only ${PASSWORD}',
    'refuses a terminal, empty input, invalid UTF-8',
  ],
  gestures: [
    'Use coordinates only as a fallback',
    'Do not assume that requested values map exactly to recognizer output',
    'then run diff snapshot -i',
    'Coordinates are fallback-only. Document why you used them.',
  ],
  tv: [
    'Move focus with remote/D-pad buttons, then activate the focused control',
    'not ADB',
    'Physical Fire TV devices remain unsupported',
    'The VVD never boots implicitly',
    'remain unsupported until their Vega backends are implemented',
  ],
  debugging: [
    'Do not cat a full stale log into the agent context',
    'Do not split it into logs stop, logs clear, logs start',
    '--launch-console is only for direct iOS simulator app launches, not URL opens',
    'Do not write network log headers',
  ],
  'react-devtools': [
    'React Native 0.74 or newer',
    'After either event, run find again',
    'fail with tree-unavailable',
    'Run profile start immediately before the interaction',
  ],
  cdp: [
    'Do not use it as the default React Native',
    'adb reverse tcp:8081 tcp:8081',
    'agent-device cdp target select <target-id>',
    'cdp memory snapshot leak-triplet',
  ],
  'react-native': [
    'Do not run doctor as routine QA/dogfood prep',
    'prefer open --relaunch before the first snapshot',
    'Do not use agent-device reload',
    'the sandbox probe is not authoritative',
    'Do not invent app ids or URLs; ask instead',
  ],
  'physical-device': [
    'have Developer Mode enabled',
    'must be signed before commands can run on a physical device',
    'devtools_security_developer_mode_disabled is the DevToolsSecurity setting of the Mac, not the Developer Mode of the device',
    'device_developer_mode_disabled is read from the device before the runner builds',
    'The two device reasons are never inferred from tool output or from each other',
    'Enable USB debugging',
  ],
  'ios-system-ui': [
    'agent-device open com.apple.springboard --platform ios',
    'Do not rely on the literal strings',
    'This is the one deliberate coordinate step',
    'Do not hard-code Edit/Done/Add Widget',
    'Reopen the app bundle under test',
  ],
  foldable: [
    'Do not add a screen flag to the normal loop',
    'Never carry coordinates or refs across a pose change',
    'After every fold, take a new snapshot',
    'fold-pose-unverified',
    'Report which poses the run covered',
  ],
  remote: [
    'connect -> install/open -> commands -> close -> disconnect',
    'not the app artifact name, ARN, or lt:// id',
    'run its printed reconnect command before open',
    'Do not run devices as a pre-open catalog probe for direct providers',
    'It does not expose connect/disconnect',
  ],
  macos: [
    'Do not write inspect as a command',
    '--button secondary',
    'Do not let iOS simulator-set scoping hide macOS desktop targets',
    'Do not guess coordinates',
    'does not raise the app',
  ],
  web: [
    'Use --platform web only for the minimal browser command loop',
    'agent-device web doctor',
    'Web automation requires Node 24+',
    'write only agent-device command lines',
  ],
  dogfood: [
    'Do not read app source or invent findings from code',
    'Ask only if one of them is missing',
    'Keep stateful commands serial within the same session',
    'use react-native dismiss-overlay',
  ],
  validate: [
    'Do not validate against stale dist output',
    'start with pnpm build',
    'run pnpm build:android before pnpm clean:daemon',
    'Do not build the Apple runner for TypeScript-only changes',
    'Close sessions and release leases before you finish',
  ],
};

async function renderHelp(id: string): Promise<string> {
  if (id === ROOT_HELP) return await usage();
  const text = await usageForCommand(id);
  if (text === null) throw new Error(`Expected help text for topic ${id}`);
  return text;
}

test('every help topic and the root help declare first-screen rules', () => {
  assert.deepEqual(Object.keys(FIRST_SCREEN_RULES).sort(), [ROOT_HELP, ...helpTopicIds()].sort());
});

test.each(Object.entries(FIRST_SCREEN_RULES))(
  'help %s keeps its key rules in the first 30 lines',
  async (id, rules) => {
    const lines = (await renderHelp(id)).split('\n');
    const firstScreen = lines.slice(0, FIRST_SCREEN_LINES).join('\n');
    for (const rule of rules) {
      const line = lines.findIndex((text) => text.includes(rule)) + 1;
      assert.ok(
        firstScreen.includes(rule),
        line > 0
          ? `"${rule}" is on line ${line}, below the first ${FIRST_SCREEN_LINES} lines of help ${id}`
          : `"${rule}" is missing from help ${id}`,
      );
    }
  },
);
