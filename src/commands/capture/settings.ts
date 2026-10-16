import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { SettingsUpdateOptions } from '@agent-device/contracts/client';
import { resolveSettingsRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import {
  parseSettingsMutation,
  settingsHelpLines,
  SETTINGS_USAGE_OVERRIDE,
} from '@agent-device/contracts/settings';
import {
  PERMISSION_MODES,
  settingDefinition,
  SETTING_NAMES,
  type SettingName,
} from '@agent-device/contracts/settings-catalog';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { readLocationCoordinate } from '@agent-device/kernel/location-coordinates';
import { compactRecord } from '../input-readers.ts';
import { enumField, numberField, requiredField, stringField } from '../command-input.ts';
import { optionalString, request, selectionOptionsFromFlags } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';

const SETTINGS_COMMAND_NAME = 'settings';
const settingsCommandDescription =
  'Read or change supported operating-system settings, animation scales, appearance, or app permissions on the selected target. Platform support depends on the setting and the action.';

const settingsCommandMetadata = defineFieldCommandMetadata(
  SETTINGS_COMMAND_NAME,
  settingsCommandDescription,
  {
    setting: requiredField(enumField(SETTING_NAMES)),
    // A readable setting answers with no state; the parse decides per setting.
    state: stringField(),
    app: stringField(
      'The app that the change targets, by bundle id, package name, or app name. It is the app that `clear-app-state` clears, or the app that a `permission` change (or an iOS-simulator `location on|off` privacy change) applies to. A name resolves to the installed app in the same way as `open` resolves it. An iOS simulator matches display names and accepts only an installed bundle id. Android accepts only an installed package, and refuses a name that resolves to an intent with `setting_app_not_package`. A Limrun iOS session resolves only the `settings` alias. If the app resolves to nothing, the command refuses it with `app_not_installed` before anything changes. The app does not have to be running. Without it, the command uses the session app. A device-wide change (`location set` on any target, the Android `location on|off` toggle, `mobile-data`, macOS permissions) refuses an app with `setting_app_not_consumed`. The CLI reads it only from this invocation, never from `AGENT_DEVICE_TARGET_APP` or config `targetApp`.',
    ),
    latitude: numberField(),
    longitude: numberField(),
    permission: stringField(),
    mode: enumField([...PERMISSION_MODES]),
  },
);

const settingsCliSchema = {
  usageOverride: SETTINGS_USAGE_OVERRIDE,
  listUsageOverride: 'settings [area] [options]',
  positionalArgs: ['setting', 'state?', 'target?', 'mode?'],
  allowedFlags: ['targetApp'],
  // A mutation must never be redirected by an env or config default app.
  explicitOnlyFlags: ['targetApp'],
} as const satisfies CommandSchemaOverride;

export const settingsCliReader: CliReader = (positionals, flags) => {
  const base = selectionOptionsFromFlags(flags);
  const plan = resolveSettingsRuntimePlan(positionals);
  if (plan.kind === 'read') return { ...base, setting: plan.setting };
  const mutation = parseSettingsMutation(positionals);
  const app =
    settingDefinition(mutation.setting)?.app === 'positional'
      ? readPositionalApp(mutation.setting, mutation.app, flags)
      : flags.targetApp;
  return {
    ...base,
    setting: mutation.setting,
    state: mutation.state,
    ...(mutation.permission === undefined ? {} : { permission: mutation.permission }),
    ...(mutation.mode === undefined ? {} : { mode: mutation.mode }),
    ...(mutation.latitude === undefined
      ? {}
      : {
          latitude: readLocationCoordinate(mutation.latitude, 'latitude'),
          longitude: readLocationCoordinate(mutation.longitude, 'longitude'),
        }),
    ...(app === undefined ? {} : { app }),
  } as SettingsUpdateOptions;
};

export const settingsDaemonWriter: DaemonWriter = (input) => {
  const options = input as SettingsUpdateOptions;
  const settingsInput = compactRecord({ app: settingsInputApp(options) });
  return request(
    PUBLIC_COMMANDS.settings,
    settingsPositionals(options),
    input,
    Object.keys(settingsInput).length === 0 ? undefined : settingsInput,
  );
};

/** An app with no positional slot crosses the daemon boundary as request input. */
function settingsInputApp(input: SettingsUpdateOptions): string | undefined {
  return settingDefinition(input.setting)?.app === 'input' && 'app' in input
    ? input.app
    : undefined;
}

export const settingsCommandFacet = defineCommandFacet({
  name: SETTINGS_COMMAND_NAME,
  text: {
    summary: 'Change OS settings and app permissions',
    cliDetail: [
      'A readable setting without a state reads the value that the target holds. If a target does not serve a setting, it refuses the setting with UNSUPPORTED_OPERATION before anything changes.',
      '',
      'Settings:',
      ...settingsHelpLines().map((line) => `  ${line}`),
    ].join('\n'),
  },
  metadata: settingsCommandMetadata,
  run: (client, input) => client.settings.update(input as SettingsUpdateOptions),
  cliSchema: settingsCliSchema,
  cliReader: settingsCliReader,
  daemonWriter: settingsDaemonWriter,
  // Android permission revokes append a relaunch warning (#1796); render it for humans too.
  cliOutputFormatter: messageOutput,
});

/** The positional app, or `--app` when no positional names one; two different apps are refused. */
function readPositionalApp(
  setting: SettingName,
  positionalApp: string | undefined,
  flags: CliFlags,
): string | undefined {
  const flagApp = flags.targetApp;
  if (positionalApp !== undefined && flagApp !== undefined && positionalApp !== flagApp) {
    throw new AppError(
      'INVALID_ARGS',
      `settings ${setting} names two apps: ${positionalApp} and ${flagApp}. Name one.`,
    );
  }
  return positionalApp ?? flagApp;
}

function settingsPositionals(input: SettingsUpdateOptions): string[] {
  if (settingDefinition(input.setting)?.app === 'positional') {
    return [input.setting, ...optionalString('app' in input ? input.app : undefined)];
  }
  if (input.state === undefined) return [input.setting];
  if ('latitude' in input) {
    return [input.setting, input.state, String(input.latitude), String(input.longitude)];
  }
  if ('permission' in input) {
    return [input.setting, input.state, input.permission, ...optionalString(input.mode)];
  }
  return [input.setting, input.state];
}
