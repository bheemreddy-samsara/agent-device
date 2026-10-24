# ADR 0037: Network Capture Sources — One Armed Source per Session

## Status

Accepted (2026-10-24). The React Native/Metro source ships here. A provider-native source (Limrun)
and a local Apple probe answer through the same seam and are owned by their own workers.

## Rules at a glance

1. `network start` chooses exactly one source and arms it; the choice is recorded in session state.
   `network dump` reads only that source and reports it as `source`. A dump never installs
   instrumentation and never switches sources.
2. With no capture armed, `network dump` keeps the daemon's session app-log parse and labels it
   `source: app-log`. Only `network start` can install anything.
3. Source selection order: provider-native (when a provider reports its own capture), then the
   React Native/Metro source when the session's dev-server binding applies, then the local Apple
   probe. When nothing applies, start refuses with `UNSUPPORTED_OPERATION` and a typed reason.
4. `requiresRelaunch` is reported, never performed. A capture never relaunches an app silently.

## The decision

The React Native capture runs client-side, in the CLI process, beside `react-devtools`, against the
app's Metro (or Expo/Re.Pack) dev server. `network start` probes the runtime's CDP `Network`
domain. A runtime that answers it (React Native 0.83 and newer) takes the `metro-cdp` source, which
sees every request the app makes through the platform's network stack. A runtime that refuses the
method — an older React Native — falls back to `metro-js-hook`, an in-app fetch/XHR hook installed
over `Runtime.evaluate`, which reports `requiresRelaunch: true` because it sees no earlier request.
Any other probe failure fails closed.

The CDP source needs one persistent debugger connection, so a detached holder process owns it. The
holder reads its binding from the session's capture state, answers `drain`/`stats`/`stop` over a
unix socket, records `ended` with its reason when the bound runtime goes away, and then exits — so
a stale pid can never read as a live capture. The hook source needs no holder: its buffer lives in
the app runtime, and each dump connects and drains it over a fresh debugger connection.

Start records `logicalDeviceId` plus the app id. Every later read must hit that same target. A new
target id for the same app and device is a JavaScript reload, which the capture follows exactly
once and reports as a note; a second reload, a different app, or a gone runtime fails closed with
`metro-runtime-gone` or `metro-runtime-replaced`. Several runtimes on one dev server with nothing
narrowing them refuse with `metro-runtime-ambiguous`; `--device` (and `--app`) narrow it.

Bodies are opt-in and decided at start; headers are always kept, redacted. A capture failure never
rejects the app's own fetch.

## Reason

The debugger socket an RN app exposes is reachable from the machine that runs Metro, not from the
device's host in general — a remote daemon or a companion-tunnel device is exactly the case where
the daemon cannot reach it. Running the capture where `react-devtools` already runs makes remote
daemons and tunnels work without new transport. One armed source keeps a dump honest: what it
reports is what was watching, and a gap (startup traffic, a reload window) is a note, never a
silent source swap.

## Rejected alternatives

- **Daemon-side platform transport (simctl/devicectl/adb identity probes).** Rejected: it ties the
  RN capture to platforms the dev server already disambiguates, and it cannot reach a companion
  tunnel's debugger socket. Identity comes from the dev server's own target list.
- **Installing instrumentation inside the session app (proxy, config change).** Rejected: `network
  dump` must work on an app nobody armed, and a dump that installs something cannot report what it
  observed unchanged.
- **A daemon- resident capture holder.** Rejected: the daemon may run on another host than the dev
  server. The holder lives where the socket is, and the unix-socket protocol keeps the CLI side
  host-independent.
- **Polling the dev server for the bound target's liveness.** Rejected: the holder learns of a
  detach from the connection itself and records why it ended.

## Consequences and gaps

- A capture survives only while its holder process lives; a host reboot ends it and the state reads
  as lost (`network-capture-lost`), never as empty traffic.
- The hook source cannot see native-only traffic or requests made before it was installed.
- Request bodies over CDP are read with a byte bound; an oversized body is reported as truncated.
- The provider-native and Apple-probe sources land behind the same `network start` seam; this ADR
  pins the seam's rules, their ADRs own their internals.
