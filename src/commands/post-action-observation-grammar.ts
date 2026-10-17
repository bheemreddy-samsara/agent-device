import type { CliFlags } from '@agent-device/contracts/command';
import type { PostActionObservationSupportFor } from '@agent-device/command-registry/post-action-observation';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '@agent-device/command-registry/registry';
import { settleInputFromFlags } from './cli-grammar/common.ts';
import { SETTLE_FLAGS } from '@agent-device/command-registry/flag-groups';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import { booleanField, integerField } from './command-input.ts';

/**
 * The caller-facing surfaces a command's post-action observation trait
 * entitles it to (`--verify` / `--settle`, #1047/#1101): the metadata input
 * fields (Node SDK options + MCP tool schema), the CLI allowed flags, and the
 * CLI reader input (#1652). All are materialized from the descriptor registry
 * rather than hand-listed per command. This lives outside the interaction
 * family because the trait does too: `scroll` and `back` carry it on the
 * generic daemon route (#1638), and `back` is a system command.
 *
 * A descriptor gate (`post-action-observation.test.ts`) asserts, over every
 * descriptor, that both surfaces are present exactly when the trait is — so a
 * new settle-capable command cannot ship with a schema or grammar that hides
 * the flags.
 */

const verifyField = () =>
  booleanField(
    'Capture low-cost post-action evidence (AX digest, node counts, changedFromBefore) instead of a follow-up snapshot.',
  );

const settleFields = () => ({
  settle: booleanField(
    'After the action, wait until the UI is quiet. Then return the settled diff against the pre-action tree in the same response. This is best-effort and never fails the action.',
  ),
  settleQuietMs: integerField(
    'settle: quiet window in milliseconds. The default is 500. When the settled tree comes from the iOS simulator snapshot bridge, the default is 300. On iOS, a broad screen replacement, such as a modal dismissal, gets a confirmation of at least 1500ms for any requested window. This confirmation stays within the timeoutMs settle deadline. On iOS, a replacement can start from a screen that the pre-action capture read as presenting nothing, such as a tab switch. Such a replacement gets no 1500ms confirmation and keeps the requested window.',
    { min: 0 },
  ),
  timeoutMs: integerField('settle: wait deadline in milliseconds (default: 10000).', { min: 1 }),
});

type VerifyFieldMap = { verify: ReturnType<typeof verifyField> };
type SettleFieldMap = ReturnType<typeof settleFields>;

export type PostActionObservationFields<TName extends string> =
  PostActionObservationSupportFor<TName> extends 'settle-and-verify'
    ? VerifyFieldMap & SettleFieldMap
    : PostActionObservationSupportFor<TName> extends 'settle'
      ? SettleFieldMap
      : Record<never, never>;

export function postActionObservationFields<const TName extends string>(
  command: TName,
): PostActionObservationFields<TName> {
  return {
    ...(commandSupportsVerifyEvidence(command) ? { verify: verifyField() } : {}),
    ...(commandSupportsSettleObservation(command) ? settleFields() : {}),
  } as PostActionObservationFields<TName>;
}

export function postActionObservationCliFlags(command: string): readonly FlagKey[] {
  const flags: FlagKey[] = [];
  if (commandSupportsVerifyEvidence(command)) flags.push('verify');
  if (commandSupportsSettleObservation(command)) flags.push(...SETTLE_FLAGS);
  return flags;
}

/**
 * #1652: the settle triple a command's reader owes the daemon, merged at the
 * `readInputFromCli` seam so no reader can forget it (the pre-seam per-reader
 * spreads silently no-op'd when dropped). Non-settle commands get `{}` — and
 * their parsers refuse `--settle` anyway via `postActionObservationCliFlags`.
 */
export function settleInputForCommand(command: string, flags: CliFlags): Record<string, unknown> {
  if (!commandSupportsSettleObservation(command)) return {};
  return settleInputFromFlags(flags);
}
