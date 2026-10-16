/**
 * Every `settings` setting, declared once: its accepted forms, where its app comes from, whether
 * naming an app can mean anything on each target family, and its help. Usage, parsing, app scope,
 * and help are derived from this table. Which target serves a setting is not declared here: each
 * runtime owner states that in its own settings facts, because owners that share a device shape
 * (a local iOS simulator and a Limrun iOS session) serve different settings.
 *
 * This module has no runtime imports, so the public client types can name it.
 */

export const PERMISSION_ACTIONS = ['grant', 'deny', 'reset'] as const;
export const PERMISSION_MODES = ['full', 'limited'] as const;

/** The app-scoped targets, the only ones `parsePermissionTarget` accepts. */
export const MOBILE_PERMISSION_TARGETS = [
  'all',
  'camera',
  'microphone',
  'photos',
  'contacts',
  'contacts-limited',
  'notifications',
  'calendar',
  'location',
  'location-always',
  'media-library',
  'motion',
  'reminders',
  'siri',
] as const;

export const MACOS_PERMISSION_TARGETS = [
  'accessibility',
  'screen-recording',
  'input-monitoring',
] as const;

export const TEXT_SIZE_CATEGORIES = [
  'extra-small',
  'small',
  'medium',
  'large',
  'extra-large',
  'extra-extra-large',
  'extra-extra-extra-large',
  'accessibility-medium',
  'accessibility-large',
  'accessibility-extra-large',
  'accessibility-extra-extra-large',
  'accessibility-extra-extra-extra-large',
] as const;

export const APPEARANCE_ACTIONS = ['light', 'dark', 'toggle'] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type MobilePermissionTarget = (typeof MOBILE_PERMISSION_TARGETS)[number];
export type TextSizeCategory = (typeof TEXT_SIZE_CATEGORIES)[number];
export type AppearanceAction = (typeof APPEARANCE_ACTIONS)[number];

/**
 * `app-scoped`: the change lands on a bundle id or package. `device-level`: the same command
 * changes the whole device, so a named app is refused. `unknown`: not settled here; the owner's
 * own facts answer for a setting it does not serve.
 */
export type SettingsAppScope = 'app-scoped' | 'device-level' | 'unknown';

/** The macOS host, the rest of the Apple family, and every other target (Android, HarmonyOS, …). */
export type SettingsTargetFamily = 'apple' | 'mobile' | 'macos-host';

type FamilyAppScope = Readonly<Partial<Record<SettingsTargetFamily, SettingsAppScope>>>;

export type SettingForm = Readonly<
  | { kind: 'on-off'; appScope?: FamilyAppScope }
  | { kind: 'choice'; states: readonly string[] }
  | { kind: 'coordinates'; appScope?: FamilyAppScope }
  | {
      kind: 'permission';
      actions: readonly PermissionAction[];
      targets: readonly string[];
      modes?: readonly PermissionMode[];
    }
  | { kind: 'app-id' }
>;

export type SettingDefinition = Readonly<{
  forms: readonly SettingForm[];
  /** A bare `settings <setting>` reads the value the target holds. */
  readable?: true;
  /** `input`: a named app rides the request input. `positional`: it is the setting's own argument. */
  app?: 'input' | 'positional';
  /** A write is refused before dispatch when neither the request nor the session names an app. */
  appRequired?: true;
  /** Applies to every form; a form's own `appScope` overrides it. */
  appScope?: FamilyAppScope;
  help: string;
}>;

export const SETTINGS = {
  wifi: {
    forms: [{ kind: 'on-off' }],
    help: 'Android switches Wi-Fi with svc wifi. An Apple simulator overrides only its status bar.',
  },
  airplane: {
    forms: [{ kind: 'on-off' }],
    help: 'Android applies it through the connectivity service (Android 11+) and reports the airplaneMode that the service holds. Older builds fail and change nothing. An Apple simulator overrides only its status bar.',
  },
  'mobile-data': {
    forms: [{ kind: 'on-off' }],
    app: 'input',
    appScope: { mobile: 'device-level' },
    help: 'Android only. It runs svc data and reports the stored mobileData state, or fails with mobile-data-not-applied or mobile-data-unreadable. Multi-SIM read-back is not covered at this time, and --app is refused.',
  },
  location: {
    forms: [
      { kind: 'on-off', appScope: { apple: 'app-scoped', mobile: 'device-level' } },
      { kind: 'coordinates', appScope: { apple: 'device-level', mobile: 'device-level' } },
    ],
    app: 'input',
    help: 'On Android, on|off writes the device-wide location_mode. On an Apple simulator, on|off grants or revokes the location permission of the app. set <lat> <lon> moves the coordinates of the device itself on Apple simulators and Android emulators.',
  },
  animations: {
    forms: [{ kind: 'on-off' }],
    help: 'Android sets its window, transition, and animator duration scales to 1 or 0.',
  },
  appearance: {
    forms: [{ kind: 'choice', states: APPEARANCE_ACTIONS }],
    help: 'Switches to light or dark mode, or toggles it, on Android, Apple simulators, and the macOS host.',
  },
  'text-size': {
    forms: [{ kind: 'choice', states: TEXT_SIZE_CATEGORIES }],
    readable: true,
    help: 'Without a category, it reads the preferred text size. With a category, it applies that size. This works on iPhone and iPad simulators (simctl content size) and Android (system font_scale). Android has no ladder of its own, so a read names the nearest rung and reports the multiplier as platformValue. A running app uses a new size at its next configuration change, so relaunch the app.',
  },
  faceid: {
    forms: [{ kind: 'choice', states: ['match', 'nonmatch', 'enroll', 'unenroll'] }],
    help: 'Simulates Face ID on iPhone and iPad simulators.',
  },
  touchid: {
    forms: [{ kind: 'choice', states: ['match', 'nonmatch', 'enroll', 'unenroll'] }],
    help: 'Simulates Touch ID on iPhone and iPad simulators.',
  },
  fingerprint: {
    forms: [{ kind: 'choice', states: ['match', 'nonmatch'] }],
    help: 'Simulates a fingerprint touch on Android emulators, and on devices that expose cmd fingerprint.',
  },
  'clear-app-state': {
    forms: [{ kind: 'app-id' }],
    app: 'positional',
    appRequired: true,
    appScope: { apple: 'app-scoped', mobile: 'app-scoped' },
    help: 'Clears the data of the positional app, the --app app, or the session app, and refuses two different apps. It does not change the keychain. An app with no data container, such as a simulator system app, refuses with app-no-data-container.',
  },
  'reset-keychain': {
    forms: [{ kind: 'choice', states: ['clear'] }],
    help: 'Resets the whole iOS simulator keychain for all apps on it, because simctl has no per-app reset. A fresh-install reset needs this setting and clear-app-state. To see the app signed out, relaunch it after the reset.',
  },
  permission: {
    forms: [
      {
        kind: 'permission',
        actions: PERMISSION_ACTIONS,
        targets: MOBILE_PERMISSION_TARGETS,
        modes: PERMISSION_MODES,
      },
      { kind: 'permission', actions: ['grant', 'reset'], targets: MACOS_PERMISSION_TARGETS },
    ],
    app: 'input',
    appScope: { apple: 'app-scoped', mobile: 'app-scoped', 'macos-host': 'device-level' },
    help: 'Changes a permission of the --app app or the session app. An iOS simulator resolves --app to an installed bundle id or display name. Android resolves it to an installed package. A Limrun iOS session resolves it only through the settings alias. On Android, deny|reset of a held permission kills a running app. The response reports priorGrantState and a warning, and open <app> --relaunch restores the app. Android needs a resolvable foreground user, and without one it changes nothing. On the macOS host, grant|reset change the host TCC grants for the three desktop targets and take no --app.',
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingName = keyof typeof SETTINGS;

export const SETTING_NAMES = Object.keys(SETTINGS) as readonly SettingName[];

/** The settings whose definition is `readable`. */
export type ReadableSetting = {
  [Name in SettingName]: (typeof SETTINGS)[Name] extends { readable: true } ? Name : never;
}[SettingName];

/** The definition of a setting name in any casing or padding, or `undefined` outside the catalog. */
export function settingDefinition(name: string | undefined): SettingDefinition | undefined {
  const normalized = name?.trim().toLowerCase();
  return normalized !== undefined && Object.hasOwn(SETTINGS, normalized)
    ? SETTINGS[normalized as SettingName]
    : undefined;
}
