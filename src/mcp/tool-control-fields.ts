import type { JsonSchema } from '../commands/command-contract.ts';
import {
  operatorAudience,
  type InputAudience,
  type InputAudienceMap,
} from '../commands/input-audience.ts';

/**
 * The MCP surface's own tool arguments: transport and response-shaping controls
 * it adds on top of a command's input, consumes itself, and never forwards to
 * the command route. One row per key, so the advertised schema, the keys
 * stripped before dispatch, and the audience boundary read one declaration.
 *
 * Not `tool-input-config.ts`, which is the other half of the same call: that one
 * merges the operator's env and config-file defaults into a call's input.
 */
type McpToolConfigFieldSpec = {
  schema: JsonSchema;
  /** Who may write the key. Absent means the model — see `commands/input-audience.ts`. */
  audience?: InputAudience;
};

const MCP_TOOL_CONFIG_FIELDS = {
  stateDir: {
    schema: { type: 'string', description: 'Agent-device state directory.' },
    // Selects which daemon state directory (and therefore which daemon and
    // session namespace) a call resolves against: operator infrastructure, not
    // per-call work.
    audience: operatorAudience({ operatorConfig: true }),
  },
  mcpOutputFormat: {
    schema: {
      type: 'string',
      enum: ['optimized', 'json'],
      description:
        'MCP text content format. The default is optimized, which is text for agents. Use json for JSON text. The tool always returns structured content separately.',
    },
  },
  includeCost: {
    schema: {
      type: 'boolean',
      description:
        'Include the agent cost of the command (cost.wallClockMs, …) in structuredContent. The default is off. The default response shape does not change.',
    },
  },
  responseLevel: {
    schema: {
      type: 'string',
      enum: ['digest', 'default', 'full'],
      description:
        'Response verbosity: digest (low token cost), default (current behavior), or full. The default is default, which keeps the response shape unchanged.',
    },
  },
} as const satisfies Record<string, McpToolConfigFieldSpec>;

const MCP_TOOL_CONFIG_ROWS: ReadonlyArray<readonly [string, McpToolConfigFieldSpec]> =
  Object.entries(MCP_TOOL_CONFIG_FIELDS);

/** Tool arguments the MCP surface consumes itself and never forwards to the command route. */
export const MCP_TOOL_CONFIG_KEYS: ReadonlySet<string> = new Set(
  MCP_TOOL_CONFIG_ROWS.map(([key]) => key),
);

export const MCP_TOOL_CONFIG_AUDIENCE: InputAudienceMap = Object.fromEntries(
  MCP_TOOL_CONFIG_ROWS.flatMap(([key, field]) => (field.audience ? [[key, field.audience]] : [])),
);

export function mcpToolConfigProperties(): Record<string, JsonSchema> {
  return Object.fromEntries(MCP_TOOL_CONFIG_ROWS.map(([key, field]) => [key, field.schema]));
}
