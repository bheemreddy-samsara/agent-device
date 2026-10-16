import type { CommandName } from '../command-metadata.ts';
import { listCommandFamilyCliSchemas } from '../family/registry.ts';
import type { LocalCliCommandName } from '@agent-device/command-registry/catalog';
import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import {
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  METRO_PREPARE_FLAGS,
} from '@agent-device/command-registry/flag-groups';

type SchemaOnlyCliCommandName = Exclude<LocalCliCommandName, CommandName>;

const SCHEMA_ONLY_CLI_COMMAND_SCHEMAS = {
  plugins: {
    text: {
      summary: 'Manage installed provider plugins',
      description:
        'Install, list, update, or remove npm provider plugins in AGENT_DEVICE_HOME (default: ~/.agent-device). Changes take effect after a restart of the local daemon. For structured results, use --json.',
    },
    usageOverride: 'plugins list|add <package[@version]>|update <package>|remove <package>',
    listUsageOverride: 'plugins',
    positionalArgs: ['list|add|update|remove', 'package?'],
    supportedFlags: [],
  },
  cdp: {
    text: {
      summary: 'Inspect CDP targets, JS heap, and leaks',
      description:
        'Run CDP commands for React Native diagnostics, JS heap usage, heap snapshots, and leak analysis',
    },
    usageOverride: 'cdp [...args]',
    listUsageOverride: 'cdp',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  auth: {
    text: {
      summary: 'Manage cloud login state',
      description: 'Manage the cloud login state for remote daemon and cloud device workflows.',
    },
    usageOverride: 'auth status|login|logout',
    listUsageOverride: 'auth',
    positionalArgs: ['status|login|logout'],
    supportedFlags: ['remoteConfig', 'stateDir'],
  },
  daemon: {
    text: {
      summary: 'Stop a local daemon and remove its retained resources',
      description:
        'Stop a local daemon after the command confirms its PID and start-time identity. To remove retained Apple runner processes and leases that the daemon owns, use --clean.',
    },
    usageOverride: 'daemon stop [--state-dir <path>]',
    listUsageOverride: 'daemon stop',
    positionalArgs: ['stop'],
    allowedFlags: ['clean'],
    supportedFlags: ['stateDir'],
  },
  device: {
    text: {
      summary: 'Examine and recover enforced local device ownership without a daemon',
      description:
        'Examine enforced host-local device ownership claims. The command does not start or contact a daemon. status --stale examines only proven-stale claims. release --stale settles a provably dead owner through exact-owner resource reconciliation, and clears its claim last. Live and uncertain owners always fail closed. Automatic reclamation still occurs during open and daemon startup.',
    },
    usageOverride:
      'device status|release [--platform <platform>] [--udid <udid>] [--serial <serial>]',
    listUsageOverride: 'device status',
    positionalArgs: ['status|release'],
    allowedFlags: ['stale'],
    supportedFlags: ['platform', 'device', 'udid', 'serial'],
  },
  connect: {
    text: {
      summary: 'Configure remote or provider state',
      description:
        'Configure remote access without a device allocation. Direct providers validate credentials and resources before they save state. They also print the exact device and app preparation that open needs. AGENT_DEVICE_CLOUD_BASE_URL is the bridge or control-plane API origin. For CI or service-token automation, use AGENT_DEVICE_DAEMON_AUTH_TOKEN=adc_live_...',
    },
    usageOverride:
      'connect [provider] [--remote-config <path>] [--daemon-base-url <url>] [--tenant <id>] [--run-id <id>] [--lease-id <id>] [--lease-backend <backend>] [--force] [--no-login]',
    usageFlags: [],
    listUsageOverride: 'connect',
    positionalArgs: ['provider?'],
    allowedFlags: [
      'remoteConfig',
      'daemonBaseUrl',
      'tenant',
      'runId',
      'leaseId',
      'leaseBackend',
      'providerApp',
      'providerOsVersion',
      'providerDeviceType',
      'providerProject',
      'providerBuild',
      'providerSessionName',
      'providerDeviceOrientation',
      'providerGeoLocation',
      'providerTimezone',
      'providerAppiumVersion',
      'providerLanguage',
      'providerLocale',
      'providerNetworkProfile',
      'providerCustomNetwork',
      'providerNoResignApp',
      'awsProjectArn',
      'awsDeviceArn',
      'awsAppArn',
      'awsRegion',
      'awsInteractionMode',
      'force',
      'noLogin',
    ],
    supportedFlags: [
      'stateDir',
      'daemonAuthToken',
      'session',
      'platform',
      'device',
      ...METRO_PREPARE_FLAGS,
      'launchUrl',
    ],
  },
  connection: {
    text: {
      summary: 'Examine the saved remote connection',
      description: 'Examine the active remote connection state',
    },
    usageOverride: 'connection status',
    listUsageOverride: 'connection',
    positionalArgs: ['status'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  disconnect: {
    text: {
      summary: 'Clear remote connection state and release leases',
      description:
        'Disconnect the remote daemon state, stop the owned Metro companion, and release the lease',
    },
    listUsageOverride: 'disconnect',
    allowedFlags: ['shutdown'],
    supportedFlags: ['remoteConfig', 'stateDir', 'session'],
  },
  mcp: {
    text: {
      summary: 'Start the MCP server',
      description:
        'Start the official stdio MCP server. It exposes structured command tools that use the agent-device client.',
    },
  },
  proxy: {
    text: {
      summary: 'Expose a local daemon through an HTTP tunnel',
      description:
        'Expose the local daemon HTTP contract through a tunnel-friendly reverse proxy.\n\nDo the steps that follow:\n  1. Run this command on the host that has access to simulators and devices.\n  2. Expose the printed local proxy URL through a tunnel.\n  3. On a different machine, run connect proxy with the tunnel URL.\n\nThe proxy starts or reuses a local HTTP daemon. It accepts /health, /rpc, /upload and resumable /upload/* routes, and /artifacts plus /artifacts/*. It also accepts the same routes under /agent-device/*. Health is unauthenticated for reachability probes. Other routes require the generated bearer token that the proxy prints at startup, or the explicit --daemon-auth-token value when you give one. The proxy rewrites authorized client requests to the upstream daemon token, and does not expose the local daemon token.\n\nWhen you connect through cloudflared, ngrok, or a different shared origin, use the /agent-device base path. Keep the bearer token secret, because anyone with it can control the proxied daemon. This direct proxy flow does not use agent-device auth.\n\nExamples:\n  agent-device proxy --port 4310\n  cloudflared tunnel --url http://127.0.0.1:4310\n  agent-device connect proxy --daemon-base-url https://example.trycloudflare.com/agent-device --daemon-auth-token <token>',
    },
    listUsageOverride: 'proxy',
    allowedFlags: ['proxyHost', 'proxyPort', 'daemonAuthToken', 'stateDir'],
  },
  takeover: {
    text: {
      summary: 'Pause agent interactions while a person controls a device',
      description:
        'Temporarily give control of the active remote lease device to a person. The foreground command pauses state-changing agent commands, renews the hold until Ctrl+C, and then releases the hold. Read-only diagnostics stay available. The command uses the active connection and --session, with normal tenant and lease admission. status lists the holds on that device. release removes a hold that the admitted lease owns. The host-only /admin/human-control/holds API uses the separate local daemon token. Holds are lost when the daemon restarts. Local takeover without a remote device lease is not supported.',
    },
    usageOverride: 'takeover [status | release <hold-id>] [--session <name>]',
    listUsageOverride: 'takeover [status|release]',
    positionalArgs: ['status|release?', 'hold-id?'],
    supportedFlags: [
      'stateDir',
      'session',
      'remoteConfig',
      'daemonBaseUrl',
      'daemonAuthToken',
      'daemonTransport',
      'tenant',
      'runId',
      'leaseId',
      'leaseBackend',
      'sessionIsolation',
    ],
  },
  'react-devtools': {
    text: {
      summary: 'React Native components, props/state/hooks, and render profiling',
      description:
        'Examine React Native components and profile their renders through the Metro dev server',
    },
    usageOverride:
      'react-devtools tree [@ref|Name]|find <Name>|inspect <@ref|Name>|errors|profile start|stop|report [Component]|commit [N]',
    listUsageOverride: 'react-devtools',
    positionalArgs: ['args?'],
    allowsExtraPositionals: true,
    supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  },
  web: {
    text: {
      summary: 'Manage the web automation backend',
      description:
        'Install and examine the managed web automation backend that --platform web uses.\n\nFirst-run flow:\n  agent-device web setup\n  agent-device open "https://example.com" --platform web\n  agent-device snapshot -i --platform web\n  agent-device close --platform web\n\nRuntime web commands do not install the backend implicitly. If the managed backend is missing, run agent-device web setup. The backend resolves only from the managed install in the effective agent-device state dir.\n\nTo install or reuse the pinned backend, use web setup. After setup, use web doctor to confirm the health of the browser backend.',
    },
    usageOverride: 'web setup | web doctor',
    listUsageOverride: 'web setup|doctor',
    positionalArgs: ['setup|doctor'],
    supportedFlags: ['stateDir'],
  },
} as const satisfies Record<SchemaOnlyCliCommandName, CommandSchema>;

// Facet schemas are complete: `defineCommandFacet` attaches the resolved text to every one.
const CLI_COMMAND_OVERRIDES = listCommandFamilyCliSchemas() as Partial<
  Record<CommandName, CommandSchema>
>;

export function getSchemaOnlyCliCommandSchema(command: string): CommandSchema | undefined {
  return Object.hasOwn(SCHEMA_ONLY_CLI_COMMAND_SCHEMAS, command)
    ? SCHEMA_ONLY_CLI_COMMAND_SCHEMAS[command as keyof typeof SCHEMA_ONLY_CLI_COMMAND_SCHEMAS]
    : undefined;
}

export function getCliCommandOverride(command: string): CommandSchema | undefined {
  return Object.hasOwn(CLI_COMMAND_OVERRIDES, command)
    ? CLI_COMMAND_OVERRIDES[command as keyof typeof CLI_COMMAND_OVERRIDES]
    : undefined;
}
