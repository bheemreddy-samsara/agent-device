import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { CaptureScreenshotOptions } from '@agent-device/contracts/client';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import {
  RETIRED_SCREENSHOT_MAX_SIZE,
  SCREENSHOT_COMMAND_FLAG_KEYS,
  SCREENSHOT_SCALE_LIMITS,
  screenshotFlagsFromPublicOptions,
  screenshotOptionsFromFlags,
  validateNoRetiredScreenshotMaxSize,
  validateScreenshotScale,
} from '@agent-device/contracts/capture';
import {
  booleanField,
  enumField,
  integerField,
  numberField,
  retiredField,
  stringField,
} from '../command-input.ts';
import { commonInputFromFlags, optionalString, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const SCREENSHOT_COMMAND_NAME = 'screenshot';

const screenshotCommandDescription =
  'Capture a screenshot of the active app or web session. If necessary, choose the capture scope, density, size, or annotations through the related input fields.';

const screenshotCommandMetadata = defineFieldCommandMetadata(
  SCREENSHOT_COMMAND_NAME,
  screenshotCommandDescription,
  {
    path: stringField('Output path.'),
    cropOn: stringField(
      'Selector expression. The command crops the capture to the frame that the selector resolves on the same screen.',
    ),
    overlayRefs: booleanField(),
    pixelDensity: integerField('Output screenshot pixel density in pixels per logical point.', {
      min: 1,
    }),
    fullscreen: booleanField(),
    scale: numberField('Screenshot scale factor.', SCREENSHOT_SCALE_LIMITS),
    maxSize: retiredField(RETIRED_SCREENSHOT_MAX_SIZE.migration.screenshot),
    stabilize: booleanField(),
    normalizeStatusBar: booleanField(),
    surface: enumField(SESSION_SURFACES),
  },
);

const screenshotCliSchema = {
  positionalArgs: ['path?'],
  allowedFlags: SCREENSHOT_COMMAND_FLAG_KEYS,
} as const;

export const screenshotCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  path: positionals[0] ?? flags.out,
  ...screenshotOptionsFromFlags(flags),
});

export const screenshotDaemonWriter: DaemonWriter = (input) => {
  validateNoRetiredScreenshotMaxSize('screenshot', input);
  validateScreenshotScale(input as CaptureScreenshotOptions);
  return request(PUBLIC_COMMANDS.screenshot, optionalString(input.path), {
    ...input,
    ...screenshotFlagsFromPublicOptions(input as CaptureScreenshotOptions),
  });
};

export const screenshotCommandFacet = defineCommandFacet({
  name: SCREENSHOT_COMMAND_NAME,
  text: {
    summary: 'Capture a screenshot',
    cliDetail:
      'Web defaults to the viewport. For the entire page, use --fullscreen, --full, or -f. iOS simulators default to 1x logical-point output. To request a different screenshot density, use --pixel-density. macOS app sessions default to the app window. Use --fullscreen for the full desktop, --scale to downscale, --crop-on <selector> to crop the capture to the frame that the selector resolves on the same screen (at this time, iOS simulators and Android emulators), --overlay-refs to annotate the current refs, --normalize-status-bar for deterministic iOS simulator chrome, or --no-stabilize for low-latency Android capture loops. On macOS, any --surface other than app (desktop, menubar, frontmost-app) always captures the main display and refuses an explicit --fullscreen. On single-display iOS simulators and Android devices, the result reports displayRotation when the device returns a reading in time. displayRotation is the rotation in which the display rendered the capture. Without a reading in time, the field is absent.',
  },
  metadata: screenshotCommandMetadata,
  run: (client, input) => client.capture.screenshot(input),
  cliSchema: screenshotCliSchema,
  cliReader: screenshotCliReader,
  daemonWriter: screenshotDaemonWriter,
});
