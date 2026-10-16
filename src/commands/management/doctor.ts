import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import { DEVICE_TARGETS } from '@agent-device/kernel/device';
import {
  booleanField,
  enumSchema,
  looseObjectSchema,
  numberSchema,
  objectSchema,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { JsonSchema } from '../command-contract.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

/**
 * This family's advertised MCP `outputSchema`, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`.
 */
export const DOCTOR_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/doctor.ts
  doctor: objectSchema(
    {
      status: enumSchema(['pass', 'warn', 'fail', 'info']),
      summary: stringSchema(),
      kind: enumSchema(['auto', 'react-native', 'expo', 'repack']),
      platform: stringSchema(),
      target: enumSchema(DEVICE_TARGETS),
      targetApp: stringSchema(),
      metro: objectSchema({ host: stringSchema(), port: numberSchema() }, ['host', 'port']),
      checks: {
        type: 'array',
        items: objectSchema(
          {
            id: stringSchema(),
            status: enumSchema(['pass', 'warn', 'fail', 'info']),
            summary: stringSchema(),
            hint: stringSchema(),
            command: stringSchema(),
            evidence: looseObjectSchema(),
          },
          ['id', 'status', 'summary'],
        ),
      },
    },
    ['status', 'summary', 'kind', 'checks'],
  ),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'doctor'>;

const doctorCommandMetadata = defineFieldCommandMetadata(
  'doctor',
  'Diagnose device, app, development-server, and React Native or Expo readiness issues. It returns compact evidence for local inventory, sessions, optional app discovery, toolchains, and server reachability.',
  {
    targetApp: stringField(
      'Installed app package, bundle id, or app name to confirm without opening a session.',
    ),
    remote: booleanField(
      'Examine the remote connection setup instead of the local device inventory.',
    ),
  },
);

const doctorCliSchema = {
  usageOverride: 'doctor [--platform ios|android|harmonyos|vega|macos|linux|web|apple]',
  allowedFlags: ['targetApp', 'remote'],
} as const satisfies CommandSchemaOverride;

const doctorCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  targetApp: flags.targetApp,
  remote: flags.remote,
});

const doctorDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.doctor);

export const doctorCommandFacet = defineCommandFacet({
  name: 'doctor',
  text: {
    summary: 'Diagnose device, app, dev-server, and RN/Expo readiness',
    cliDetail:
      'The command infers Metro reachability from cwd and runtime. On iOS simulators, if the XCTest runner build cache is missing, the command also prepares it in the background. To confirm a target app on the one matching booted device without opening a session, pass --app. To examine the remote connection setup without a probe of local devices, use --remote. The default output is compact. For full checks and evidence, use --json.',
    mcpDetail:
      'On iOS simulators, if the XCTest runner build cache is missing, this command also prepares it in the background. Thus, run it before the first Apple snapshot or interaction of a session.',
  },
  metadata: doctorCommandMetadata,
  run: (client, input) => client.command.doctor(input),
  cliSchema: doctorCliSchema,
  cliReader: doctorCliReader,
  daemonWriter: doctorDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.doctor,
});
