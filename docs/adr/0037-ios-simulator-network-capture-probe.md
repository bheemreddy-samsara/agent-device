# ADR 0037: iOS Simulator Network Capture Probe

## Status

Accepted (2026-10-23). Applies to iOS simulator app launches only.

## Rules at a glance

1. `open <app> --capture-network` on an iOS simulator injects `apple/network-capture/ADNetworkCapture.m`
   (built on demand, cached per content hash and toolchain) into the app process through
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`. Every other platform and every URL open refuse the flag.
2. The probe method-swizzles `-[NSURLSessionTask resume]`, observes each task to completion, and
   appends one JSON line per completed HTTP(S) task to the file named by
   `AGENT_DEVICE_NETWORK_CAPTURE_PATH` — the session's `network.jsonl`, one per session, replaced on
   every probe-injected launch. Each line carries the request's own URL, method, status, and
   duration, so a request that reused a keep-alive connection is named in full.
3. The capture launch always terminates a running instance first: injection happens at exec, so an
   already-running app would be activated without the probe.
4. A probe that cannot be built fails the open with `network-capture-probe-build-failed`. An open
   that asked for capture never silently launches without it.
5. `network dump` for a session with a capture window reads the probe file and reports
   `source: 'probe'`; a session opened without capture parses the app log and reports
   `source: 'app-log'`. These are the two modes, not a primary and a fallback. The dump states
   which source it used.
6. The probe file is host-side text an untrusted app wrote: reads are byte-bounded at the tail and
   pass through the operator's `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` before any response.

## Reason

CFNetwork logs a request URL only when a connection opens, so the app-log parser reports a
keep-alive request against its connection's origin with no path — the gap that forced the
`simctl log show` recovery pass and the unnamed-request notes. Observing each task inside the app
names every request the app itself made, without a proxy, without app changes, and without
entitlements; `simctl launch` forwards only `SIMCTL_CHILD_`-prefixed variables to the app, so
injection adds two variables and changes nothing else the app sees.

## Rejected alternatives

- **HTTP proxy (`simctl` supports none for the app's URLSession without app-side config).** A proxy
  needs per-app trust and proxy settings and does not cover certificate-pinned traffic.
- **Tuning `network dump` harder on Unified Logging.** The path is simply absent from the logs for a
  reused connection; no reader can recover it (ADR rationale already recorded in the parser notes).
- **Requiring the app to link a capture SDK.** This changes the artifact under test.
- **Launching without the probe when the build fails.** That silently answers the user's capture
  request with the weaker source; `AGENTS.md` forbids unapproved fallbacks.

## Consequences

- Capture covers URLSession only. A Flutter `dart:io` or other non-URLSession stack writes nothing;
  the dump's note says so.
- The probe binary builds with clang against `iphonesimulator` for both simulator architectures
  through the shared native-build cache, so a `DEVELOPER_DIR` switch rebuilds rather than serving a
  binary compiled against another SDK.
- `source` is a new field on the `network dump` response for Apple app-log dumps too, so a client
  can tell the modes apart without parsing notes.
