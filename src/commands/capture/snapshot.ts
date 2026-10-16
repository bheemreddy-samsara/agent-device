import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { SNAPSHOT_BACKEND_CAPABILITIES } from '@agent-device/capture-kit/snapshot-quality-backend-capabilities';
import {
  SNAPSHOT_COMMAND_OPTION_KEYS,
  snapshotOptionsFromFlags,
} from '@agent-device/kernel/snapshot';
import { SNAPSHOT_FLAGS } from '@agent-device/command-registry/flag-groups';
import { booleanField, integerField, optionField, stringField } from '../command-input.ts';
import {
  commonInputFromFlags,
  direct,
  observationRecordInputFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { captureCliOutputFormatters } from './output.ts';

const SNAPSHOT_COMMAND_NAME = 'snapshot';

const snapshotCommandDescription =
  'Capture the accessibility tree or compare it with the previous session baseline. Use the returned refs for later semantic interactions. To confirm UI changes, use the diff option.';

const snapshotBackendCapabilityHelp = Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
  .map(([backend, capability]) => {
    const gaps = capability.knownGaps.map((gap) => `known gap ${gap}`);
    return `${backend}: hittable=${capability.hittable}, regular-depth=${capability.regularDepth}, deep-extension=${capability.deepExtension}, depth-ladder=${capability.depthLadder}${gaps.length > 0 ? `, ${gaps.join(', ')}` : ''}`;
  })
  .join('; ');

const snapshotCommandMetadata = defineFieldCommandMetadata(
  SNAPSHOT_COMMAND_NAME,
  snapshotCommandDescription,
  {
    interactiveOnly: booleanField(),
    depth: integerField(),
    scope: stringField(),
    raw: booleanField(),
    customActions: optionField('snapshotCustomActions'),
    observeOnly: optionField('snapshotObserveOnly'),
    forceFull: booleanField(),
    timeoutMs: integerField('Maximum wall-clock time for the snapshot command.'),
    // #1271 stage 2: `snapshot` is observation-only, so a repair-armed heal
    // excludes an out-of-band one by default (ADR 0012 amendment). Exposed
    // here so the Node SDK's typed options and the MCP tool schema can set
    // both flags, mirroring `--no-record`/`--record` on the CLI.
    noRecord: booleanField('Do not record this action.'),
    record: booleanField(
      'Always record this out-of-band observation into a repair-armed heal (mutually exclusive with noRecord). Authored replay steps are recorded automatically and never need this field.',
    ),
  },
);

const snapshotCliSchema = {
  allowedFlags: [
    'snapshotDiff',
    ...SNAPSHOT_FLAGS,
    'snapshotCustomActions',
    'snapshotObserveOnly',
    'snapshotForceFull',
    'timeoutMs',
    'record',
  ],
} as const;

export const snapshotCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...observationRecordInputFromFlags(flags),
  ...snapshotOptionsFromFlags(flags, SNAPSHOT_COMMAND_OPTION_KEYS),
  timeoutMs: flags.timeoutMs,
});

const snapshotDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.snapshot);

export const snapshotCommandFacet = defineCommandFacet({
  name: SNAPSHOT_COMMAND_NAME,
  text: {
    summary: 'Capture or diff the accessibility tree',
    cliDetail: `--observe-only is for local iOS snapshots only. An already-ready compatible runner reads the session app without activation or foreground repair. It refuses unavailable observation, and it reports the XCUIApplication state, not verified foreground ownership (#2696). Regular targetActivation disclosure does not change (#2682, #2694). Repeated equivalent unfiltered Android snapshots return a compact unchanged acknowledgement. To return the full tree again, use --force-full. --json and --raw keep the full output. Android Appium JSON snapshots publish a display viewport only when the measurements before and after the tree agree. This is independent of the tree extent and of keyboard content resizing. On Android, the JSON value carries field content, not static labels. Saved selectors and replay scripts that use value= for static labels must use label= instead. A reported showing hint means that value is empty. If the hint state is unknown, text equal to the placeholder is kept. For an iOS raw-coordinate fallback after a no-op ref press, examine the rects with snapshot -i --json and press the rect center. Then confirm with diff snapshot -i or snapshot --diff. iOS backend capability contract: ${snapshotBackendCapabilityHelp}.`,
  },
  metadata: snapshotCommandMetadata,
  run: (client, input) => client.capture.snapshot(input),
  cliSchema: snapshotCliSchema,
  cliReader: snapshotCliReader,
  daemonWriter: snapshotDaemonWriter,
  cliOutputFormatter: captureCliOutputFormatters.snapshot,
});
