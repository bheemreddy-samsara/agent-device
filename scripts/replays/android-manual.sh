#!/bin/sh
set -eu

READINESS_MODE="$1"
FIXTURE_APK="$2"
FIXTURE_APP_ID="$3"
ANDROID_SETUP_SECONDS="$4"
ANDROID_DIAGNOSTIC="${5:-false}"
ANDROID_SERIAL="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
test -n "$ANDROID_SERIAL"
BOOT_FINISHED_AT="$(date +%s)"
pnpm gate build
pnpm clean:daemon

if [ "$READINESS_MODE" != normal ]; then
  LOGCAT_PID=
  LOGCAT_EXIT=0
  stop_native_diagnostics() {
    if [ -n "$LOGCAT_PID" ]; then
      kill "$LOGCAT_PID" 2>/dev/null || :
      wait "$LOGCAT_PID" 2>/dev/null || LOGCAT_EXIT=$?
      printf '%s %s\n' "$(date -u +%FT%TZ)" "$LOGCAT_EXIT" > "$NATIVE_DIR/native-logcat-end.txt"
      LOGCAT_PID=
    fi
    if [ -n "${ATRACE_MARKER:-}" ] && [ -f "$ATRACE_MARKER" ]; then
      TRACE_STOP_EXIT=0
      timeout --kill-after=2 15 adb -s "$ANDROID_SERIAL" shell atrace --async_stop > "$NATIVE_DIR/atrace-shell-stop.stdout.txt" 2> "$NATIVE_DIR/atrace-shell-stop.stderr.txt" || TRACE_STOP_EXIT=$?
      printf '%s\n' "$TRACE_STOP_EXIT" > "$NATIVE_DIR/atrace-shell-stop.exit.txt"
      if [ "$TRACE_STOP_EXIT" -eq 0 ]; then rm "$ATRACE_MARKER"; fi
    fi
  }
  trap stop_native_diagnostics 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ "$ANDROID_DIAGNOSTIC" = true ]; then
    NATIVE_DIR=test/artifacts/readiness-experiment/android-diagnostic
    mkdir -p "$NATIVE_DIR"
    ATRACE_MARKER="$NATIVE_DIR/atrace-owned-$$"
    (ulimit -f 8192; exec timeout --kill-after=2 --signal=TERM 300 adb -s "$ANDROID_SERIAL" logcat -v threadtime -T 1 ActivityTaskManager:I ActivityManager:I AndroidRuntime:E WindowManager:I InputMethodManagerService:V InputMethodManager:V UiAutomationConnection:V '*:S') > "$NATIVE_DIR/native-logcat.stdout.txt" 2> "$NATIVE_DIR/native-logcat.stderr.txt" &
    LOGCAT_PID=$!
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$LOGCAT_PID" > "$NATIVE_DIR/native-logcat-start.txt"
  fi
  if [ "$ANDROID_DIAGNOSTIC" = true ]; then
    DIAGNOSTIC_EXIT=0
    node --experimental-strip-types scripts/replays/android-search-diagnostic.ts "$ANDROID_SERIAL" "$NATIVE_DIR" "$AGENT_DEVICE_STATE_DIR" "$ATRACE_MARKER" || DIAGNOSTIC_EXIT=$?
    stop_native_diagnostics
    exit "$DIAGNOSTIC_EXIT"
  fi
  node --experimental-strip-types scripts/replays/readiness-experiment.ts begin android
  REPLAY_EXIT=0
  pnpm gate replay-android --serial "$ANDROID_SERIAL" --debug --retries 0 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml || REPLAY_EXIT=$?
  SUMMARY_EXIT=0
  node --experimental-strip-types scripts/replays/readiness-experiment.ts summarize android "$AGENT_DEVICE_STATE_DIR" test/artifacts/replays-android.junit.xml || SUMMARY_EXIT=$?
  if [ "$REPLAY_EXIT" -ne 0 ]; then exit "$REPLAY_EXIT"; fi
  exit "$SUMMARY_EXIT"
fi

adb -s "$ANDROID_SERIAL" install -r "$FIXTURE_APK"
node --experimental-strip-types src/bin.ts replay examples/test-app/replays/drag-android.ad --platform android --serial "$ANDROID_SERIAL" --session nightly-android-target-drag --json
pnpm clean:daemon
FULL_STARTED_AT="$(date +%s)"
AGENT_DEVICE_ANDROID_E2E=1 AGENT_DEVICE_ANDROID_E2E_TIER=full AGENT_DEVICE_ANDROID_SERIAL="$ANDROID_SERIAL" AGENT_DEVICE_FIXTURE_APP_PATH="$FIXTURE_APK" AGENT_DEVICE_FIXTURE_APP_ID="$FIXTURE_APP_ID" node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-android-emulator.test.ts
FULL_FINISHED_AT="$(date +%s)"
echo "Android setup before emulator: $((BOOT_FINISHED_AT - ANDROID_SETUP_SECONDS))s"
echo "Android full scenario wall time: $((FULL_FINISHED_AT - FULL_STARTED_AT))s"
pnpm gate replay-android --retries 2 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml
