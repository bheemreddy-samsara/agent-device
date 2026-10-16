export const WAIT_FAILURE_CONTRACT = `Wait failure contract:
  Read --json error.details.reason.
  wait_target_absent: readable capture, no match.
  wait_target_present: absence timeout; details.matches/firstMatch.
  predicate_failed: no valid absence capture; observation/diagnostic kept.
  wait_capture_stalled: no readable capture by deadline -- retriable.
  wait_deadline_exceeded: later capture exhausted budget after a readable one.
  wait_readiness_exhausted: readiness deadline; details.readinessPhase -- retriable.
  wait_runner_restart_exhausted: restart deadline -- retriable.
  wait_landmark_identity_mismatch: replay guard: selector matched, recorded identity differed.
  wait_stable_timeout: no stable UI -- not absence.
`;

export const manualQaHelpTopics = {
  'manual-qa': {
    summary: 'Follow manual test scripts with exact interactions and verification',
    body: `agent-device help manual-qa

Use this topic when the task asks you to follow a manual QA script, test case, checklist, acceptance flow, or user-provided instructions.

Contract:
  Execute the script. Do not explore unrelated screens, read app source, invent missing requirements, or broaden scope.
  If a required target or expected result is not visible after the documented recovery steps, stop and report the ambiguity.

Loop:
  1. Open the requested app. Use --relaunch only when the script needs fresh state.
  2. Run snapshot -i to get current refs for the next step.
  3. For each mutating step, run press/fill/click/longpress <ref-or-selector> --settle.
  4. Treat a settled:true diff as the next observation. If the diff already shows the next target or expected result, do not add wait stable or another snapshot.
  5. If --settle prints not settled, follow its hint before the next ref-based action.
  6. Verify named expectations with wait text/selector/absent, get, is, find, or the settled diff. A bare screenshot/snapshot is not verification for a named expectation.
  7. When the script ends, close the session.

Command shapes:
  agent-device open com.example.app --relaunch
  agent-device open https://example.com/deep-link
  agent-device snapshot -i
  agent-device press @e12 --settle
  agent-device press 'label="Follow"' --settle
  agent-device fill @e13 "qa@example.com" --settle
  agent-device wait text "Order placed" 3000
  agent-device wait absent 'label="Loading..."' 3000
  agent-device close
  --relaunch forces fresh app state. A deep link or URL open does not need it. A label with an apostrophe or a quote (label="Don't leave") is a shell-quoting hazard. For such a label, prefer the @ref from the latest snapshot or settle output to a quoted literal label.

Targets:
  Prefer refs from the latest snapshot -i or settled diff. If you know the label or id, use durable selectors: label="Search", id="submit", role=button label="Follow". If the label text matches both a field and its caption, target the field with label="Email" editable=true.
  For a text field, use fill <target> <text> --settle to replace the field value. Use type only to append to an already-focused field.
  Do not use placeholders such as @ref, @eN, <button>, or <selector> in a final command plan. If the ref is unknown, first run snapshot -i.
  Use coordinates only as a fallback, after refs and selectors fail or accessibility omits the target. To choose a visible center point, use screenshot or snapshot -i --json.

Recovery:
  Network or typeahead result missing: use wait text "Expected result" or wait <selector>.
  Target that should disappear: use wait absent <selector>. wait exists ... is rejected; use the plain selector wait instead.
  Keyboard visible over the next target: if a measured or derived keyboard frame covers the dispatched tap point of an app target, the command refuses the element with tap_keyboard_occludes_target. The reason is that the touch would activate a key instead of the target. First, end the edit: use the app's own Done/Cancel control, or keyboard enter if you want to submit. Then retry. Missing keyboard nodes never prove that the keyboard is absent. A visibility-only probe cannot establish the covered area. If the dispatched tap point of an app target stays above the keys, the target passes this keyboard check. A raw coordinate behind the keyboard taps anyway and reports the reason in warning.
  Target covered by other visible UI: the command refuses the target with target_covered. If the occlusion scan identified the covering element, error.details.coveredBy and the hint name it (role, label, rect), so you know what to dismiss. The covering element is for diagnosis only. Never target its ref. Dismiss or close it, or scroll the target clear, then retry.
  Sparse or recovered accessibility snapshot: use screenshot as visual truth. If necessary, leave the bad screen. Then retry snapshot -i.
  Non-hittable success hint: verify with the settled diff or a snapshot. If the UI did not change, retarget with a better ref or selector.

${WAIT_FAILURE_CONTRACT}`,
  },
} as const;

export const debuggingHelpTopics = {
  debugging: {
    summary: 'Targeted failure evidence without dumping stale context',
    body: `agent-device help debugging

Use this topic when behavior fails, hangs, times out, or throws alerts, or when you need runtime evidence.

Logs:
  Keep log windows small. Prefer this sequence: clear, mark, reproduce, then path.
    agent-device logs clear --restart
    agent-device logs mark "before diagnostics retry"
    agent-device press 'id="load-diagnostics"'
    agent-device logs path
  Do not cat a full stale log into the agent context. When necessary, open or grep only the relevant window.
  logs clear --restart is the compact command that clears old logs and starts a fresh capture. Do not split it into logs stop, logs clear, logs start.
  On iOS simulators, logs scope by bundle id and resolved app executable. Use logs instead of raw simctl log stream predicates.
  On iOS physical devices, logs clear --restart relaunches the session app through devicectl process launch --console, so that it can capture stdout/stderr.
  To capture launch-time stdout/stderr on an iOS simulator, use --launch-console on the direct app launch:
    agent-device open MyApp --platform ios --relaunch --launch-console ./artifacts/app.console.log
  --launch-console is only for direct iOS simulator app launches, not URL opens.

Events:
  Use events for a compact session timeline. events does not dump the full app logs.
    agent-device events
    agent-device events 50 100
  Events keep command names, status, durations, bounded device/app inventory previews, lifecycle outcomes, artifact basenames, and structural action details. Structural action details include scroll distance/direction, safe refs, and coordinates. Events omit the following values, or replace them with content-free placeholders: user-entered text, clipboard contents, push/event payloads, selector values, free-form flags/messages/paths, and raw unknown command arguments. --no-record suppresses action.recorded entries. Request start/finish entries still record the command, status, and timing.

Network:
  Use network dump to get recent session HTTP traffic, parsed from app logs.
    agent-device network dump --include headers
    agent-device network dump 20 --include all
  If the question is about request/response metadata, use network dump instead of logs path.
  network log is a supported alias. network dump --include headers is the clearest plan form. Do not write network log headers.

Audio:
  Use audio probe to find whether a browser page, macOS session, iOS simulator, or Android emulator produced audible output during a short observation window.
    agent-device audio probe start 10 1000 --platform web
    agent-device audio probe status --platform web
    agent-device audio probe stop --platform web
    agent-device audio probe start 10 1000 --platform macos
    agent-device audio probe start 10 1000 --platform ios
    agent-device audio probe start 10 1000 --platform android
  audio probe start uses duration seconds first, then bucket milliseconds. The results are compact rmsDbfs and peakDbfs arrays. Use them to correlate audible moments with screenshots, actions, network entries, or frame samples.
  On web, audio probe samples HTML media elements. While the probe observes, it may route URL-backed media through the probe AudioContext.
  On macOS hosts, audio probe samples host system audio through ScreenCaptureKit for macOS sessions, iOS simulators, and Android emulators. It requires Screen Recording permission. It is system-audio evidence, not app-instrumented audio. Physical iOS and Android devices are not supported.

Crash symbolication:
  Crash routing:
    Use logs when you need the lead-up timeline before a failure.
    Use debug symbols when you have crash.ips/crash.log plus a matching dSYM/build directory, and you need the failing frame.
    Use Xcode/LLDB when you need live state, breakpoints, variables, memory, or stepping.
  If you already have an Apple crash artifact and local dSYMs, and you need the failing code path instead of a full log dump, use debug symbols:
    agent-device debug symbols --artifact crash.log --dsym MyApp.dSYM --out crash-symbolicated.log
    agent-device debug symbols --artifact crash.ips --search-path ./build --out crash-symbolicated.ips
  debug is intentionally narrow. Do not use it for logs, network/audio evidence, performance samples, recordings, traces, or React Native internals.
  On Apple, debug symbols matches the UUIDs in crash Binary Images / IPS usedImages against dwarfdump --uuid output from .dSYM bundles. Then it writes a symbolicated artifact path and a compact crash report: app/thread, exception or termination, top symbolicated frames, and first-frame finding. This is better than a pasted crash log: it keeps the agent context small, and the artifact stays on disk for examination.
  Android Java/R8 mapping.txt and native ndk-stack/addr2line symbolication are not in this first debug symbols workflow. For now, capture crash evidence with logs and use the Android toolchain outside agent-device.

Alerts:
  Native and platform dialogs:
    agent-device alert wait 3000
    agent-device alert accept
    agent-device alert dismiss
  Android support is snapshot-derived for runtime permission prompts and native app dialogs. iOS support is runner-derived for XCTest alerts, app-owned modal popups with native blocking markers, and blocking system dialogs. For an immediate check, use alert get, which is cheap. Use alert wait <short-ms> only if a prompt may appear after async work.
  If alert reports no alert but a sheet is visible on screen, treat the sheet as app-owned UI:
    agent-device snapshot -i
    agent-device press 'label="Allow"'
  Do not use settings permission to answer a dialog already on screen. Use settings permission only to set up or reset the permission state before a flow.

Diagnostics and traces:
  Use --debug for CLI/daemon diagnostic ids and log paths.
  Use AGENT_DEVICE_EXEC_TRACE=1 when you need host-tool spawn timing without full debug streaming. On a successful request that spawns host tools, it flushes the full request diagnostics file.
  The open output includes Session state. The JSON output also includes runnerLogPath and requestLogPath.
  To get the open timing under --debug, run open --debug --json and find the open_timing event in requestLogPath.
  The session file requests/<request-id>.ndjson holds daemon request diagnostics. The session file runner.log holds Apple runner/xcodebuild output.
  With a remote daemon, the Diagnostics Log path is always local. The CLI fetches the record of the failing request to <state-dir>/remote-diagnostics/. If the fetch fails, the line reads "unavailable" with the reason, not a daemon-host path.
  daemon.log is global daemon lifecycle evidence, not the primary per-run log.
  Use trace for low-level session diagnostics around one repro:
    agent-device trace start ./traces/diagnostics.trace
    agent-device press 'id="load-diagnostics"'
    agent-device trace stop ./traces/diagnostics.trace
  The trace path is positional. Do not use --path for trace start or trace stop.
  Use perf xctrace only for Apple native CPU/profile or Animation Hitches artifacts:
    agent-device perf cpu profile start --kind xctrace --template "Time Profiler" --out ./artifacts/app.trace
    agent-device perf cpu profile stop --kind xctrace --out ./artifacts/app.trace
    agent-device perf cpu profile report --kind xctrace --out ./artifacts/app-profile.json
    agent-device perf trace start --kind xctrace --template "Animation Hitches" --out ./artifacts/hitches.trace
    agent-device perf trace stop --kind xctrace --out ./artifacts/hitches.trace
  perf xctrace keeps the .trace artifact on disk. The CPU report returns a bounded, weighted top-function summary. Do not dump .trace contents into the context.
  For Android native CPU/trace evidence, use perf artifacts instead of raw adb/simpleperf/perfetto output:
    agent-device perf cpu profile start --kind simpleperf --out /tmp/cpu.perf.data
    agent-device perf cpu profile stop --kind simpleperf
    agent-device perf cpu profile report --kind simpleperf --out /tmp/cpu-report.json
    agent-device perf trace start --kind perfetto --out /tmp/app.perfetto-trace
    agent-device perf trace stop --kind perfetto
  Treat native perf output as the agent evidence: for example, state=stopped, outPath=/tmp/app.perfetto-trace, sizeBytes=5392410, method=adb-shell-perfetto. The 5.3 MB raw trace stays in the artifact.
  CPU reports return at most ten top functions in structured data, and print five in default CLI output.
  Use the explicit perf frames, perf memory, perf cpu, or perf trace forms. Aggregate perf was removed in 0.21: bare perf, perf sample, perf metrics, and metrics fail with exact replacements.
  The startup duration is part of the startup result of the open command. Read it there.

Memory diagnostics:
  If you suspect a leak, growth, or OOM, and you need agent-readable evidence, use perf memory.
    agent-device perf memory sample --json
    agent-device perf memory snapshot --kind android-hprof --out ./artifacts/app.hprof
    agent-device perf memory snapshot --kind memgraph --out ./artifacts/app.memgraph
  Example sample shape:
    {"metrics":{"memory":{"available":true,"totalPssKb":562958,"totalRssKb":570304,"topConsumers":[{"name":"Dalvik Heap","pssKb":213456}]}}}
  Example default snapshot output:
    Memory artifact (android-hprof): /tmp/app.hprof (42MB)
  Prefer perf memory sample over raw dumpsys/leaks output for first-pass agent diagnosis. It keeps arrays bounded and returns only relevant memory evidence.
  Prefer perf memory snapshot over printed heap/memgraph data. A snapshot returns the path, size, kind, method, and support metadata. The large artifact stays on disk for external examination.
  Unsupported platforms return artifact.available=false with reason/hint. Do not claim that a heap or memgraph was captured.

Stabilizers:
  Android animation-sensitive flows:
    agent-device settings animations off
    agent-device snapshot
    agent-device settings animations on
  Before you finish, re-enable the settings that you changed.

Text-entry quirks:
  iOS Allow Paste cannot be exercised under XCUITest. Instead, prefill with clipboard write "some text" and test the system prompt manually.
  Android Gboard handwriting/stylus UI can capture text in an IME-owned input instead of the app field. If fill reports that the keyboard/IME captured the input, do these steps before you retry:
    1. Read the diagnostic targetInput/actualInput details.
    2. If necessary, examine keyboard status or get.
    3. Switch or disable handwriting outside the command plan.
  Do not keep retrying fill/type against the same field while the IME owns focus. If the exact target changes but app-owned formatting prevents raw equality, fill succeeds with verification: "unconfirmed" plus target-bound requested/before/after evidence. Examine that evidence. Do not retry the same mutation.
  iOS accessibility-driven fill types the replacement once. It never clears and retypes a read-back mismatch. Exact settled text confirms the entry.
    A value that contains only characters, in order, from the post-clear value plus the request fails with TEXT_ENTRY_MISMATCH. This includes plain dropped characters and unchanged values. Legitimate trimming or masks can also hit this limit ("5" into "$0.00" displaying "$0.05").
    Other settled values return verification: "unconfirmed" with requested/before/after/target evidence. Examples are grouping ("00 062 91 77" for "000629177"), currency ("$10.00" for "1000"), and OTP summaries. Missing, reordered, duplicated, or stale text can also be unconfirmed. Before you continue, assert the expected value with a value selector, get/is, or the resulting screen.
    Exception: for single-line fills that end in a submit key, any non-matching value observed on the same target succeeds unverified, including partial or cleared text. This exception skips dropped-character checks because the submit may change the field. Assert the resulting screen.
    Multiline fields compare newlines as content. Unreadable or removed fields remain unverified. The coordinate-driven fill route still requires an exact match.
    Retry fill with --delay-ms 80 only after TEXT_ENTRY_MISMATCH, and only if examination shows that the field needs correction.

React Native internals:
  If the question is about React component props, state, hooks, the component tree, performance, render causes, slow components, or rerenders, use help react-devtools. Do not infer the answer from screenshots or logs.`,
  },
} as const;

export const qaReportHelpTopics = {
  dogfood: {
    summary: 'Exploratory QA workflow with reproducible evidence',
    body: `agent-device help dogfood

Use this when asked to dogfood, exploratory test, bug hunt, QA, or find issues in an app.

Goal:
  Find user-visible issues from runtime behavior. Do not read app source or invent findings from code.
  Produce a concise report with severity, repro commands, expected/actual behavior, and evidence paths.

Loop:
  1. Identify target app/platform; ask only if missing.
  2. Create output dirs and open the app. If auth or OTP is required, sign in or ask the user for the code.
  3. Capture baseline snapshot -i and screenshot.
  4. Map top-level navigation, then exercise primary flows and edge states.
  5. For each issue, capture evidence and write the finding immediately, then continue.
  6. Close the session and reconcile the report summary.
  Keep stateful commands serial within the same session. Parallel runs can pollute text fields, focus, alerts, and navigation state.

Coverage:
  Navigation, forms, empty/error/loading states, offline or retry behavior, permissions, settings, accessibility labels, orientation/keyboard, and obvious performance stalls.
  React Native warning/error overlays can be real findings or test blockers. Capture them, use react-native dismiss-overlay if unrelated, re-snapshot, and report them.
  Expo Go/dev-client shells: use the provided exp:// or dev-client URL and record whether the shell, project load, or app UI is being tested. On iOS dogfood, prefer agent-device open "Expo Go" <url> when Expo Go is the known shell, then snapshot -i to confirm the project UI rather than the runner splash.
  Android RN/Expo/Re.Pack dev server: direct Android localhost URL opens with a port auto-configure host reachability.
  Categories: visual, functional, UX, content, performance, diagnostics, permissions, accessibility.
  Severity: critical blocks a core flow/data/crashes; high breaks a major feature; medium has friction or workaround; low is polish.

Evidence commands:
  mkdir -p ./dogfood-output/screenshots ./dogfood-output/videos ./dogfood-output/traces
  agent-device open <app> --platform ios
  agent-device snapshot -i
  agent-device screenshot ./dogfood-output/screenshots/initial.png
  agent-device screenshot ./dogfood-output/screenshots/issue-001.png --overlay-refs
  agent-device logs clear --restart
  agent-device logs mark "issue-001 repro"
  agent-device logs path
  agent-device record start ./dogfood-output/videos/issue-001.mp4
  agent-device record start ./dogfood-output/videos/benchmark.mp4 --hide-touches
  agent-device record stop
  agent-device close

Evidence rules:
  Interactive/behavioral issues need step screenshots and usually a repro video.
  Static/on-load issues can use one screenshot; set repro video to N/A.
  Use screenshot --overlay-refs when showing the tappable target or broken state helps repro.

Report shape:
  ./dogfood-output/report.md
  Include date, platform, target app, session, scope, severity counts, and issues.
  For each finding: ID, severity, category, title, affected flow/screen, repro commands, expected, actual, evidence files, notes.
  Target 5-10 well-evidenced issues when available. If no issues are found, report coverage completed and residual risk instead of claiming the app is bug-free.

Rules:
  Findings must come from observed runtime behavior, not source reads.
  After each mutation, use the --settle diff as evidence when available; otherwise re-snapshot.
  Wait timeouts are integer milliseconds in the trailing positional: agent-device wait 'role=tab' 10000. Do not write duration suffixes such as 10s.
  scroll takes a selector-less direction+amount form: agent-device scroll down 0.8. One gesture cannot travel further than 0.8 of the viewport axis, so a larger amount saturates rather than covering more ground; to cross several screens use agent-device scroll down --until <selector> or scroll bottom. Use --settle to wait for the UI to go quiet and get the settled diff.
  Keep commands in the report reproducible; use selectors or refs from fresh snapshots, not guessed coordinates.
  Prefer refs for exploration and selectors for deterministic replay.
  Use logs, network, screenshot --overlay-refs, trace, perf frames, perf memory, native profiles, or react-devtools only when they add evidence to a specific issue.
  Never delete screenshots, videos, traces, or report artifacts during a session.
  Escalate to help debugging or help react-devtools when runtime symptoms require those tools.`,
  },
  validate: {
    summary: 'Engineering self-validation with device evidence and cleanup',
    body: `agent-device help validate

Use this when validating a code change, release candidate, performance fix, visual behavior, logging path, replay, or device-facing regression.

Contract:
  Prove the changed behavior through public agent-device surfaces. Do not validate against stale dist output, a retained stale daemon, or a runner built before the change.
  Keep evidence reproducible: exact commands, target device/app, observed output, artifact paths, and cleanup status.

Required freshness gate before device verification:
  For a TypeScript runtime or CLI output change, start with pnpm build. For non-Android device verification, run pnpm clean:daemon next.
  Before local Android verification, run pnpm build:android before pnpm clean:daemon so the bundled helpers match current source.
  For an Apple runner change, run pnpm build:xcuitest and avoid inherited retained runners from older source. Do not build the Apple runner for TypeScript-only changes.
  Use open --relaunch when startup state matters. Use a purpose-specific --session for multi-step validation.
  CI may cache ~/.agent-device/apple-runner/derived with an exact key that includes the agent-device package and Xcode version. Runner reuse is authorized only by the cache metadata's content manifest, so a restore that fails validation rebuilds; prepare ios-runner already recovers one retryable non-connecting runner launch.

Loop:
  1. Build or prepare the changed surface with the repo command that owns it.
  2. Open the target app/device state explicitly.
  3. Use snapshot -i and press/fill/click/longpress --settle for UI-driving steps.
  4. Use the settled diff as evidence when it shows the changed behavior; otherwise verify with wait/get/is/find, screenshot, logs, network, perf, or trace based on the claim.
  5. Record timings, token/output size, screenshots/videos, logs, or perf artifacts only when they answer the validation question.
  6. Close sessions and release leases before finishing.

Evidence:
  CLI/runtime freshness: pnpm build, pnpm clean:daemon, then agent-device --version or the command under test.
  Apple runner freshness: pnpm build:xcuitest, then a live agent-device command on the target simulator/device.
  Visual claim: screenshot, optionally screenshot --overlay-refs when target mapping matters.
  Runtime/logging claim: logs clear --restart, logs mark, reproduce, logs path.
  Network claim: network dump --include headers when headers are relevant.
  Performance claim: perf frames, perf memory sample, native profile reports, or trace artifacts with bounded output.
  Replay/regression claim: replay or test through the public command path.

Report:
  Summarize what changed, exact validation commands, pass/fail observations, artifact paths, and residual risk.
  If live validation is blocked, state the blocker, device/session, and exact next command needed.`,
  },
} as const;
