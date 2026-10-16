import type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import {
  booleanField,
  enumField,
  integerField,
  jsonSchemaField,
  operatorField,
  requiredField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import {
  METRO_PREPARE_FLAGS,
  METRO_RELOAD_FLAGS,
} from '@agent-device/command-registry/flag-groups';
import { metroCliOutputFormatters } from './output.ts';
import { readMetroPrepareKind } from './prepare-kind.ts';

const METRO_COMMAND_NAME = 'metro';
const METRO_ACTION_VALUES = ['prepare', 'reload'] as const;

const metroCommandDescription =
  'Prepare a React Native development server, or ask connected apps to reload. The command uses the development server that this session is bound to. Give explicit runtime inputs only to override that binding for one call.';

export const metroCommandMetadata = defineFieldCommandMetadata(
  METRO_COMMAND_NAME,
  metroCommandDescription,
  {
    action: requiredField(enumField(METRO_ACTION_VALUES)),
    projectRoot: stringField(),
    kind: jsonSchemaField<MetroPrepareOptions['kind']>(stringSchema()),
    publicBaseUrl: stringField(),
    // Operator-owned: the endpoint a bearer token is sent to, and the token
    // itself. Both stay CLI/Node inputs; no model-facing tool schema offers them.
    proxyBaseUrl: operatorField(stringField(), {
      operatorPath:
        'Configure the remote proxy in the remote-config profile or operator config for the process serving these tools.',
    }),
    bearerToken: operatorField(stringField(), {
      envFlagKeys: ['metroBearerToken', 'daemonAuthToken'],
    }),
    bridgeScope: jsonSchemaField<MetroPrepareOptions['bridgeScope']>({
      type: 'object',
      additionalProperties: true,
    }),
    launchUrl: stringField(),
    port: integerField(),
    listenHost: stringField(),
    statusHost: stringField(),
    startupTimeoutMs: integerField(),
    probeTimeoutMs: integerField(),
    reuseExisting: booleanField(),
    installDependenciesIfNeeded: booleanField(),
    runtimeFilePath: stringField(),
    logPath: stringField(),
    metroHost: stringField(),
    metroPort: integerField(),
    bundleUrl: stringField(),
    timeoutMs: integerField(),
  },
);

type MetroInput = { action: 'prepare' | 'reload' } & MetroPrepareOptions & MetroReloadOptions;

const metroCliSchema = {
  usageOverride:
    'metro prepare (--public-base-url <url> | --proxy-base-url <url>) [--project-root <path>] [--port <port>] [--kind auto|react-native|expo|repack]\n  agent-device metro reload [--metro-host <host>] [--metro-port <port>] [--bundle-url <url>]',
  usageFlags: [],
  listUsageOverride: 'metro',
  positionalArgs: ['prepare|reload'],
  allowedFlags: [...METRO_RELOAD_FLAGS, ...METRO_PREPARE_FLAGS],
} as const satisfies CommandSchemaOverride;

export const metroCliReader: CliReader = (positionals, flags) => {
  const action = (positionals[0] ?? '').toLowerCase();
  if (action !== 'prepare' && action !== 'reload') {
    throw new AppError('INVALID_ARGS', 'metro requires a subcommand: prepare or reload');
  }
  if (action === 'reload') {
    return {
      action,
      metroHost: flags.metroHost,
      metroPort: flags.metroPort,
      bundleUrl: flags.bundleUrl,
      timeoutMs: flags.metroProbeTimeoutMs,
    };
  }
  if (!flags.metroPublicBaseUrl && !flags.metroProxyBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'metro prepare requires --public-base-url <url> or --proxy-base-url <url>.',
    );
  }
  return {
    action,
    projectRoot: flags.metroProjectRoot,
    kind: readMetroPrepareKind(flags.kind ?? flags.metroKind),
    port: flags.metroPreparePort,
    listenHost: flags.metroListenHost,
    statusHost: flags.metroStatusHost,
    publicBaseUrl: flags.metroPublicBaseUrl,
    proxyBaseUrl: flags.metroProxyBaseUrl,
    bearerToken: flags.metroBearerToken,
    bridgeScope:
      flags.tenant && flags.runId && flags.leaseId
        ? {
            tenantId: flags.tenant,
            runId: flags.runId,
            leaseId: flags.leaseId,
          }
        : undefined,
    startupTimeoutMs: flags.metroStartupTimeoutMs,
    probeTimeoutMs: flags.metroProbeTimeoutMs,
    reuseExisting: flags.metroNoReuseExisting ? false : undefined,
    installDependenciesIfNeeded: flags.metroNoInstallDeps ? false : undefined,
    runtimeFilePath: flags.metroRuntimeFile,
  };
};

export const metroCommandFacet = defineCommandFacet({
  name: METRO_COMMAND_NAME,
  text: {
    summary: 'Prepare the dev server or reload apps',
    cliDetail:
      'Without --metro-host/--metro-port/--bundle-url, reload resolves against the dev server that this session last bound through metro prepare or the metro hint flags of open. Thus, reload never silently reloads the server of a different project on the default port. Without explicit flags or a session binding, reload falls back to localhost:8081. To override the session hint for one call, pass an explicit flag. After prepare, reload uses the local server address, independently of the public or proxy address that the device received. A fresh open keeps that address only when its client-config runtime points to the prepared device server. Explicit reload flags override it. For open or an explicit bundle URL, reload removes a .bundle/.jsbundle/.js entry filename and keeps the remaining path as the server mount. When the server has no HTTP /reload route (Expo), reload broadcasts the reload over its /message websocket, and does not trust the app-page fallback. The binding is cleared when the session closes. A fresh open without hint flags also clears any leftover binding from a previous same-name session. --kind expo (detected or forced) requests the virtual-entry bundle URL (.expo/.virtual-metro-entry.bundle) instead of index.bundle, because index.bundle returns 404 or 500 from Expo dev servers in monorepos. The dependency install detects the package manager from the nearest yarn.lock/pnpm-lock.yaml/bun.lock/bun.lockb/package-lock.json. It searches up from --project-root and stops at the repo root. Thus, Yarn or pnpm workspace monorepos with the lockfile at the repo root do not incorrectly use npm install, which fails on workspace: dependency specifiers. If the install still fails and the dependencies are already installed (for example, through a monorepo root install), pass --no-install-deps.',
    mcpDetail:
      'The binding is cleared when the session closes. A fresh open without runtime hints also clears any leftover binding from a previous same-name session.',
  },
  metadata: metroCommandMetadata,
  run: async (client, input): Promise<MetroPrepareResult | MetroReloadResult> =>
    input.action === 'prepare'
      ? await client.metro.prepare(toMetroPrepareOptions(input))
      : await client.metro.reload(toMetroReloadOptions(input)),
  cliSchema: metroCliSchema,
  cliReader: metroCliReader,
  cliOutputFormatter: metroCliOutputFormatters.metro,
});

export const metroCommandFamily = defineCommandFamilyFromFacets({
  name: 'metro',
  commands: [metroCommandFacet],
});

function toMetroPrepareOptions(input: MetroInput): MetroPrepareOptions {
  return {
    projectRoot: input.projectRoot,
    kind: input.kind,
    publicBaseUrl: input.publicBaseUrl,
    proxyBaseUrl: input.proxyBaseUrl,
    bearerToken: input.bearerToken,
    bridgeScope: input.bridgeScope ?? metroBridgeScopeFromInput(input),
    port: input.port,
    listenHost: input.listenHost,
    statusHost: input.statusHost,
    startupTimeoutMs: input.startupTimeoutMs,
    probeTimeoutMs: input.probeTimeoutMs,
    reuseExisting: input.reuseExisting,
    installDependenciesIfNeeded: input.installDependenciesIfNeeded,
    runtimeFilePath: input.runtimeFilePath,
  };
}

function metroBridgeScopeFromInput(
  input: MetroInput & {
    tenant?: string;
    runId?: string;
    leaseId?: string;
  },
): MetroPrepareOptions['bridgeScope'] {
  return input.tenant && input.runId && input.leaseId
    ? { tenantId: input.tenant, runId: input.runId, leaseId: input.leaseId }
    : undefined;
}

function toMetroReloadOptions(input: MetroInput): MetroReloadOptions {
  return {
    metroHost: input.metroHost,
    metroPort: input.metroPort,
    bundleUrl: input.bundleUrl,
    timeoutMs: input.timeoutMs,
  };
}
