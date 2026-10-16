import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { AppCloseOptions, AppOpenOptions } from '@agent-device/contracts/client';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { assertResolvedAppsFilter } from './app-inventory-contract.ts';
import {
  booleanField,
  booleanSchema,
  enumField,
  integerField,
  jsonSchemaField,
  optionField,
  stringArrayField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, CommandInput, DaemonWriter } from '../cli-grammar/types.ts';
import { METRO_RELOAD_FLAGS } from '@agent-device/command-registry/flag-groups';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { withCommandRuntimeHints } from '../runtime-hints.ts';
import { managementCliOutputFormatters } from './output.ts';

const appsCommandMetadata = defineFieldCommandMetadata(
  'apps',
  'List the apps installed on the selected device. Include system or OEM apps only when you need them as automation targets.',
  {
    appsFilter: enumField(
      ['user-installed', 'all'],
      'Limit the list to user-installed apps, or include system and OEM apps.',
    ),
  },
);

const openCommandMetadata = defineFieldCommandMetadata(
  'open',
  'If necessary, boot the selected device. Then open an app, deep link, or URL in a session. To choose what becomes the foreground automation target, use the app or URL inputs.',
  {
    app: stringField('App name, bundle id, package, or URL.'),
    url: stringField('Optional URL to give to an app shell.'),
    surface: enumField(
      SESSION_SURFACES,
      'macOS presentation surface to open: the app itself, the frontmost app, the desktop, or the menu bar.',
    ),
    activity: stringField('Android activity name.'),
    launchConsole: stringField('Launch console mode.'),
    launchArgs: stringArrayField(
      'Launch arguments that the command forwards verbatim to the platform launch command.',
    ),
    relaunch: booleanField('Force a relaunch.'),
    timeoutMs: integerField(
      'Startup budget in milliseconds. It limits the Simulator boot wait, so that a never-booted Simulator can finish its first-boot migration. For the default startup behavior, omit it.',
      { min: 1 },
    ),
    waitMs: optionField('waitMs'),
    foreground: optionField('foreground'),
    saveScript: jsonSchemaField<boolean | string>({
      oneOf: [booleanSchema(), stringSchema()],
    }),
    force: booleanField(
      'Overwrite an existing --save-script target instead of a refusal (alias: --overwrite).',
    ),
    testIme: booleanField(
      'Activate the headless Android test IME for deterministic Unicode text entry (default: on for emulators, opt-in on real devices).',
    ),
    noRecord: booleanField('Do not record this action.'),
    metroHost: stringField('Session-scoped Metro or debug host hint for the opened app.'),
    metroPort: integerField(
      'Session-scoped Metro or debug port hint for the opened app. On an emulator or simulator without --metro-host, the host defaults to the loopback alias (Android 10.0.2.2, iOS 127.0.0.1). Physical devices still require an explicit --metro-host.',
      {
        min: 1,
        max: 65535,
      },
    ),
    bundleUrl: stringField('Session-scoped bundle URL hint for the opened app.'),
    launchUrl: stringField(
      'Launch URL for the opened app. It does not select the server that metro reload uses.',
    ),
  },
);

const closeCommandMetadata = defineFieldCommandMetadata(
  'close',
  'Close the named app. If app is omitted, close the active session app. Use shutdown only when the selected simulator or emulator should also stop. Android ADB close fails with android-app-close-timeout if the app stays in the foreground, or its process stays running, after its 2s check window.',
  {
    app: stringField('Optional app to close.'),
    shutdown: booleanField('Shut down the session or device where this is supported.'),
    saveScript: jsonSchemaField<boolean | string>({
      oneOf: [booleanSchema(), stringSchema()],
    }),
    force: booleanField(
      'Overwrite an existing --save-script target instead of a refusal (alias: --overwrite).',
    ),
  },
);

// The flat metro hint flags fold into the `runtime` object open already accepts.
function toAppOpenOptions(
  input: AppOpenOptions & {
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
  },
): AppOpenOptions {
  return withCommandRuntimeHints(input);
}

const appsCliSchema = {
  allowedFlags: ['appsFilter'],
} as const satisfies CommandSchemaOverride;

const openCliSchema = {
  positionalArgs: ['appOrUrl?', 'url?'],
  allowedFlags: [
    'activity',
    'launchConsole',
    'launchArgs',
    'testIme',
    'saveScript',
    'force',
    'noRecord',
    'relaunch',
    'foreground',
    'timeoutMs',
    'waitMs',
    'surface',
    ...METRO_RELOAD_FLAGS,
    'launchUrl',
  ],
} as const satisfies CommandSchemaOverride;

const closeCliSchema = {
  positionalArgs: ['app?'],
  allowedFlags: ['saveScript', 'force', 'shutdown'],
} as const satisfies CommandSchemaOverride;

const appsCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  appsFilter: assertResolvedAppsFilter(flags.appsFilter),
});

const openCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  url: positionals[1],
  surface: flags.surface,
  activity: flags.activity,
  launchConsole: flags.launchConsole,
  launchArgs: flags.launchArgs,
  relaunch: flags.relaunch,
  foreground: flags.foreground,
  timeoutMs: flags.timeoutMs,
  waitMs: flags.waitMs,
  saveScript: flags.saveScript,
  force: flags.force,
  testIme: flags.testIme,
  noRecord: flags.noRecord,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
  bundleUrl: flags.bundleUrl,
  launchUrl: flags.launchUrl,
});

const closeCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  shutdown: flags.shutdown,
  saveScript: flags.saveScript,
  force: flags.force,
});

const appsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.apps);
const openDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.open, openPositionals);
const closeDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.close, (input) =>
  optionalString(input.app),
);

export const appsCommandFacet = defineCommandFacet({
  name: 'apps',
  text: {
    summary: 'List installed apps or deferred provider app assets',
    cliDetail:
      'Before provider allocation, the command lists uploaded app assets when the selected provider exposes a catalog. On a live device, it defaults to user-installed apps. To include system and OEM apps, use --all.',
  },
  metadata: appsCommandMetadata,
  run: (client, input) => client.apps.list(input),
  cliSchema: appsCliSchema,
  cliReader: appsCliReader,
  daemonWriter: appsDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.apps,
});

export const openCommandFacet = defineCommandFacet({
  name: 'open',
  text: {
    summary: 'Open an app, deep link, or URL, and save replays',
    cliDetail:
      'To bind URL or deep-link opens to the target platform, use --platform. For the initial stdout and stderr of an iOS simulator, put --launch-console <path> on this open command, for example agent-device open "Agent Device Tester" --platform ios --launch-console artifacts/launch-console.log. Expo Go and dev-client shells accept a host and a URL, for example agent-device open "Expo Go" exp://127.0.0.1:8081 --platform ios. macOS also supports --surface app|frontmost-app|desktop|menubar. --metro-host/--metro-port/--bundle-url choose the Metro server of the app and save that address for later metro reload calls in the same session. A fresh open without Metro hints clears an older same-name binding. close also clears it. --launch-url gives the launch URL of the app. It does not select the reload server. On an iOS simulator without --launch-url, open connects a detected Expo development client through its expo-development-client URL. The app must declare a single exp+<slug> scheme that no other installed app owns. If detection is inconclusive, the app opens normally. Bare React Native apps receive their server settings before launch. On an iOS simulator, --launch-url can show an "Open in <App>?" prompt that prevents open from seeing the app. If the URL scheme belongs to the session app, open accepts the prompt (data.launchConfirmation: "accepted"). If the scheme belongs to a different installed app, the prompt stays on the screen, and open fails with details.reason launch_confirmation_foreign_app. If no single installed app owns the scheme, the prompt stays on the screen, and open returns as usual. open reads the prompt whenever it cannot see the app afterwards. This includes a slow host where the target discovery of the app fails on its own deadline. If an accept leaves the app provably not running, open gives the same URL once more and reads again. If the app is still not running, open fails with details.reason launch_confirmation_unanswered. A recognized prompt that is still visible after a failed accept also fails with this reason, even if the app is running behind it. Answer the prompt with alert accept or alert dismiss. A simulator openurl that CoreSimulator never answers fails within 20s with details.reason ios-simulator-openurl-timeout. open recognizes only the English prompt title with Cancel and Open buttons. On a Simulator set to a different language, the prompt stays on the screen. open does not answer a prompt that appears after open has already seen the app. For that prompt, use alert accept. If another session holds the device, open refuses immediately. To block for the device up to a budget, add --wait <ms>. Only after that budget does open fail with DEVICE_IN_USE, which names the owning session.',
    mcpDetail:
      'metroHost, metroPort, and bundleUrl choose the Metro server of the app and save its address for later reloads. launchUrl selects the launch URL of the app. It does not select the reload server. A fresh open without Metro hints clears an older same-name binding. close also clears it.',
  },
  metadata: openCommandMetadata,
  run: (client, input) => client.apps.open(toAppOpenOptions(input)),
  cliSchema: openCliSchema,
  cliReader: openCliReader,
  daemonWriter: openDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.open,
});

export const closeCommandFacet = defineCommandFacet({
  name: 'close',
  text: {
    summary: 'Close an app or end the session',
  },
  metadata: closeCommandMetadata,
  run: (client, input) =>
    input.app ? client.apps.close(input) : client.sessions.close(withoutApp(input)),
  cliSchema: closeCliSchema,
  cliReader: closeCliReader,
  daemonWriter: closeDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.close,
});

function withoutApp(input: AppCloseOptions & { shutdown?: boolean }): {
  shutdown?: boolean;
} {
  const { app: _app, ...rest } = input;
  return rest;
}

function openPositionals(input: CommandInput): string[] {
  if (!input.app) return [];
  return input.url ? [input.app, input.url] : [input.app];
}
