import type { JsonSchema } from '../commands/command-contract.ts';
import {
  buildUsageText,
  helpTopicIds,
  resolveHelpTargetUsageText,
} from '../commands/schema/cli-help.ts';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { listMcpExposedCommandNames } from '@agent-device/command-registry/registry';
import type { ToolResult } from './command-tools.ts';

/**
 * Server instructions: the workflow card an MCP client injects into the model's context
 * at session start (Claude Code, Codex CLI). It is paid every session and Claude Code
 * truncates it at 2 KB, so it holds only what changes the first few calls: start with
 * `open`, act → settled diff → verify → `close`, ref fidelity, sparse-AX recovery, follow
 * error hints. Everything situational lives behind the `help` tool.
 */
export const MCP_SERVER_INSTRUCTIONS = `agent-device drives iOS, Android, tvOS, Android TV, macOS, Linux, and web apps. Each tool mirrors the CLI command of the same name. CLI flags are camelCase properties (--settle -> settle: true).

Start: if the app is known, call open {app, foreground: true} immediately. Do not probe first with devices, apps, appstate, snapshot, or screenshot. open returns the initial interactive snapshot with @refs. If the app id is unknown, call devices, then apps, then open the discovered id. Never invent ids. If a session exists, continue from its state. Do not reopen it.

Loop: call press/click/fill/longpress/hover/scroll/back with settle: true. The response is the settled UI diff. Continue from it. To reach an off-screen target, call scroll {direction, until: "<selector>"}. It scrolls in one call until the target is on screen. scroll {direction: "bottom"} scrolls to the end of the content. Repeated bare scrolls are the slow way to find a target. Call snapshot {interactiveOnly: true} only if the diff does not show the next target, or the UI did not settle. Verify with wait {kind: "text", text}, wait {selector}, wait {absent: selector}, is, get, or find. A bare screenshot is not verification. End with close.

Targets: copy refs byte-for-byte (@e12, @e12~s4; keep the @ and any ~sN). A mutation makes refs stale. Prefer refs, then id/label/role selectors. Use coordinates last. If a sparse/AX-unavailable warning appears, its refs and selectors are invalid. Then call screenshot, read the image, call press {x, y}, and take a snapshot of the changed screen.

Errors carry hints. Follow the hint instead of re-planning. Call help only for specialized work (gestures, scripting, TV, macOS, web, remote, debugging) or an unclear command shape. Never call help at startup.`;

export const HELP_TOOL_NAME = 'help';

/**
 * CLI commands with no MCP tool (`web setup`, `daemon stop`, `connect`, …): the guides
 * mention them as `agent-device <command>` lines, and an MCP-only client must know those
 * are shell steps, not tools. Derived from the two registries rather than scanned out of
 * each guide's prose: `device` and `web` are ordinary words there, so a mention detector
 * would be a heuristic; the registry difference is exact and holds for every guide.
 */
export function terminalOnlyCommandNames(): string[] {
  const exposed = new Set<string>(listMcpExposedCommandNames());
  return listCliCommandNames().filter((name) => !exposed.has(name));
}

/**
 * MCP-only discovery tool. Not a command descriptor: it drives no device, so it carries
 * none of the routing/timeout/batch traits descriptors exist to declare, and adding it
 * there would also mint a redundant CLI command next to `agent-device help`.
 */
export const HELP_TOOL: { name: string; description: string; inputSchema: JsonSchema } = {
  name: HELP_TOOL_NAME,
  description: `Usage guides. Without a topic, it returns the full workflow card. Set topic to one of ${helpTopicIds().join(', ')} for that guide, or to a tool name for its complete flag reference. Use it only for specialized work or an unclear command shape. It is not a startup step. It is not necessary after an error that carries a hint.`,
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'A guide topic or a tool name. Omit it to get the card.',
      },
    },
    additionalProperties: false,
  },
};

// The guides are the CLI's own text: rewriting their prose per surface would fork one
// source of truth into two. One line up front states the mapping and its exceptions.
const GUIDE_PREAMBLE = `CLI syntax over MCP: \`agent-device <command> <positionals> --flag\` = tool <command>. Positionals are named properties (target, text, direction). Flags are camelCase properties (--settle -> settle: true, -i -> interactiveOnly: true). Terminal-only (no MCP tool; run these in a shell): ${terminalOnlyCommandNames().join(', ')}.\n\n`;

export function callHelpTool(input: Record<string, unknown>): ToolResult {
  const topic = input.topic;
  if (topic !== undefined && typeof topic !== 'string') {
    return textResult('Expected topic to be a string.', true);
  }
  const text = topic ? resolveHelpTargetUsageText(topic) : buildUsageText();
  if (text === null) {
    return textResult(`Unknown help topic: ${topic}. ${HELP_TOOL.description}`, true);
  }
  return textResult(GUIDE_PREAMBLE + text);
}

function textResult(text: string, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text }] };
}
