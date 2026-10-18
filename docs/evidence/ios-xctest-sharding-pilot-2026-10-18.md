# iOS XCTest sharding pilot

The iOS runner PR lane executed 124 methods in 1,120.27 seconds of test-case time in
[this CI run](https://github.com/callstack/agent-device/actions/runs/39151402218/job/117745626510).
The complete XCTest step took 21 minutes 40 seconds.
The run failed on the existing [snapshot prerequisite blocker](https://github.com/callstack/agent-device/issues/3800).
These durations are timing evidence, not passing validation.

## Local comparison

The pilot used source `9beae21eaf1f041ddcff053cdbf0782f6133e023`, which contains the
separate text-entry test fix in [PR #3802](https://github.com/callstack/agent-device/pull/3802).
It used Xcode 26.2 (`17C52`), iOS 26.2, and two disposable iPhone 17 Pro simulators.
The host had 12 CPU cores and 48 GiB of memory.

Both modes used the same compiled artifacts, tests, assertions, and timeouts.
Both simulators were booted before measurement.
Measurements include XCTest process startup and result writing, but exclude simulator boot.
Sequential execution used one process. Parallel execution used two independent processes,
with nested Xcode parallelism disabled and distinct simulator UDIDs and result bundles.

| Run order | Mode | Wall time | Passed | Failed/skipped | Exact selected IDs |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Sequential | 223.434 s | 12 | 0 | Yes |
| 2 | Two processes | 128.093 s | 12 | 0 | Yes |
| 3 | Two processes | 118.726 s | 12 | 0 | Yes |
| 4 | Sequential | 196.802 s | 12 | 0 | Yes |

The first pair had falling host load after fresh simulator boots.
The reverse-order pair started at one-minute loads of 5.47 and 7.16, respectively.
That pair reduced wall time by 39.7%.
Two runs per mode are a pilot, not a stable estimate for hosted CI or the full suite.

## Unchanged pilot selection

The 12 slowest methods from the cited CI run were divided into two groups using that run's durations.
Each group contained six methods. All use `AgentDeviceRunnerUITests/RunnerTests/`.

| Process 0 | Process 1 |
| --- | --- |
| `testAlertAcceptDoesNotActivateAReplacementWithASharedButton` | `testAlertCannotProveAnIdenticalReplacementAndDoesNotActivateIt` |
| `testSynthesizedReplacementLeavesAMaskedFieldUnverified` | `testSynthesizedReplacementClearsPastDroppedSelectAlls` |
| `testAlertActivationConfirmsBeforeDeadlineWithANotificationBanner` | `testBareTypeUsesTappedInputWhenSoftwareKeyboardIsHidden` |
| `testAbandonedTreeCaptureSkipsQuerySweepAndHonorsWarmupExemption` | `testAlertActivationDoesNotConsultInterruptionHandlingWithANotificationBanner` |
| `testBareDelayedTypeFailsWhenTappedInputDisappearsMidCommand` | `testFillIntoAutoSubmittingDigitCountFieldReportsNoEvidenceFromItsSuccessor` |
| `testPenalizedCoordinateFillAtAPointWithNoTextInputRefusesBeforeItsTapAndKeepsTheFocusedField` | `testSynthesizedReplacementPacesAnAppOwnedFieldAtItsAcknowledgeWindow` |

## CI experiment

The workflow experiment retains the complete generated PR selection.
It assigns alternating sorted identifiers to two processes; it stores no timing baseline or test-name allowlist.
Both workers must finish before the existing replay and daemon steps start.
Each worker has its own simulator, log, exit status, and result bundle.
The execution check rejects missing, unexpected, or repeated identifiers, including equally sized incorrect runs.
Failed and skipped outcomes remain separate from method coverage.

Full-suite hosted timing, the extra simulator boot cost, and failure behavior still need CI evidence.
The local pilot does not justify relaxing the existing snapshot blocker or other assertions.

## Execution checks

The experiment branch starts from main `3d9190107e`, whose generated selection now contains 125 methods.
The new reporter accepts the 124 completed records from a successful historical CI run against
that run's source selection at `0fb25c474a`.
Replacing one record with a duplicate keeps the count at 124 but fails the identity check.
Replaying the old log against current source also fails because the new alert-title method is missing.

Fault injection into the actual workflow shell confirms these outcomes:

| Child outcomes | Workflow exit | Both children finish |
| --- | ---: | --- |
| Both succeed with complete execution | 0 | Yes |
| First child exits 17 | 17 | Yes |
| Second child exits 23 | 23 | Yes |
| Both exit 0 but omit one selected method | 1 | Yes |

The second-simulator creation and cleanup commands also ran on a disposable local seed simulator.
They used its actual runtime and device type and deleted only the newly created simulator.
