# Review a change

Keep reviewed source read-only.
If checks can modify it, run them in an isolated checkout.
For mutations or base comparisons, use [isolated experiments](test-experiments.md).

## Reviewing

- Read linked dependencies.
  For each relevant ADR, read its Status and "Rules at a glance" first.
  Read other sections only for the rules that the change touches.
  Resolve prerequisite conflicts first.
  Update or supersede conflicting decisions explicitly.
- Trace routing and surface changes through daemon and backend.
  Helper tests that bypass the router do not prove dispatch.
  Check affected surfaces:
  - CLI.
  - Node.
  - Daemon.
  - MCP.
  - Help.
  - Docs.
- Trace typed errors from producers through normalization, transport, and sibling consumers.
  Do not replace lost reason codes with text matching.
- Classify interaction paths in `packages/contracts/src/interaction-guarantees.ts`.
  Verify each claim against native code.
  Error-path delegation does not prove success-path parity.
  Before you compare performance, prove both paths are reachable.
- A platform-family claim covers every backend, including Appium and ADB, or names the covered backends.
- Keep snapshot-wide metadata at response level.
  Append warnings through the shared builder. Never replace prior warnings.
  Check compact defaults, bounded arrays, and artifact paths for large evidence.
- Before you retain compatibility, run `git tag --contains <commit>`.
  Unreleased shapes have no external compatibility obligation.
- Require each new test to detect a credible production failure.
  Test doubles must fail at the same seam as production.
- Find these problems:
  - Dead code.
  - Redundant guards.
  - Casts.
  - Comments that repeat the code.
  - Competing owners.
  Fix the owning rule, not only named sites.

Use CI Size evidence.
At about 700 net production lines or 3 kB npm growth, require an independent reviewer to assess a smaller design.
Also assess each new:

- Abstraction.
- Dependency.
- Seam.
- Ownership rule.

For moves, weigh gross churn. Explain justified growth.

## Report findings

Report only triggering scenarios.
Include:

- `file:line`.
- Severity.
- What breaks.
- The fix.

If there are no findings, say so. Reject incorrect findings with evidence.
Prove claims such as "one reader", "pure move", or "no shim left" with search or `git diff -M90%`.
Encode repeated findings as types, structure, checks, or tests.
Once enforced, remove prose reminders of the rule.
