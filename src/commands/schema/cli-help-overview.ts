import { SELECTOR_KEY_NAMES } from '@agent-device/selectors';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';

/**
 * The root help is the no-skill agent's decision card, not the command reference.
 * Keep situational detail in `help workflow` and the derived catalog in `help commands`.
 */
export function renderCliHelpOverview(): string {
  return `agent-device <command> [args] [--json]

Automates iOS, Android, macOS, TV, and web apps for AI agents.
All ${listCliCommandNames().length} commands: agent-device help commands

Start:
  When you start a task with a known app, first run:
    agent-device open <app> --foreground
  This command starts the session and returns the initial interactive snapshot with @refs.
  Do not probe first with devices, apps, appstate, snapshot, or screenshot.
  If the app id is unknown, run devices, then apps, then open <discovered-id>. Never invent ids.
  If you resume an existing session, continue from its current state. Do not reopen it.

Loop:
  press|click|fill|longpress <target> ... --settle
  hover <target> --settle (web only; shows hover-gated UI)
  scroll <direction|top|bottom> [amount] --settle; back --settle
    Each command acts, waits until the UI is quiet, and prints the UI diff. Continue from it.
    Run snapshot -i only if the diff does not show the next target, or the UI did not settle.
  Verify a named expectation with the diff, wait text "...", wait <selector>, wait absent <selector>,
    is, get, or find. A bare screenshot is not verification.
  End with: agent-device close

Targets:
  Copy refs exactly: @e12, @e12~s4. Keep the @ and any ~sN pin.
    A mutation makes refs stale. A literal @handle is label="@handle", not a bare ref.
  Prefer refs, then id/label/role selectors. Selector keys: ${SELECTOR_KEY_NAMES.join(' ')}.
  Coordinates are the last resort. Use them only if snapshot -i shows no semantic target,
    or a sparse/AX-unavailable warning says that its refs and selectors are invalid.
    Then run screenshot and press <x> <y>, and take a new snapshot of the changed screen.

Rules:
  Use --settle only with press/click/fill/longpress/hover/scroll/back.
    Never use it with open, snapshot, or close. type never accepts --settle.
  fill <target> <text> --settle replaces the text. type <text> appends to the focused field.
  If a network or debounce result comes late, use wait text "Expected". Do not poll with snapshot.
  Write full agent-device commands. Do not use pipes, grep, jq, or pseudo-commands.
  Stop when the requested end state is visible. Mutations run serially.

More commands (exact shapes: agent-device help <command>):
  open install devices apps boot close       app and device lifecycle
  screenshot record logs network perf trace  evidence and diagnostics
  replay test batch session                   scripted flows
  alert keyboard clipboard settings gesture  system and input

Guides (agent-device help <topic>):
  workflow    full refs, selectors, waits, recovery, and platform limits
  manual-qa / dogfood / validate / debugging / scripting / gestures
  react-native / react-devtools / cdp / tv / web / macos / remote
  physical-device / ios-system-ui / maestro
  foldable    iPhone Duo panels, the fold command, and why a pose change makes refs stale
`;
}
