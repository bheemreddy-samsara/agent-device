import CoreGraphics
import XCTest

@testable import AgentDeviceMacOSHelper

private struct Candidate: Equatable {
  let id: Int
  let area: Double
}

/// An app screenshot captures the front window or refuses; it never substitutes another window.
final class AppWindowScreenshotTests: XCTestCase {
  func testCaptureIdentityAndScrollAndClickFallbackFrameSelectTheSameEligibleFrontWindow() {
    let windows = [
      windowInfo(id: 1, pid: 99),
      windowInfo(id: 2, layer: 1),
      windowInfo(id: 3, onScreen: false),
      windowInfo(id: 4, alpha: 0),
      windowInfo(id: 5, width: 0),
      windowInfo(id: 6, height: 0),
      windowInfo(id: 7, alpha: 0.5, width: 20, height: 20),
      windowInfo(id: 8),
    ]

    let frontID = frontWindow(pid: 42, windowInfo: windows)?.number
    let selected = frontCaptureWindow([7, 8], frontWindowID: frontID, sharingState: 1, windowID: { $0 })

    // Scroll and the click actionWindow fallback both consume frontWindowFrame.
    XCTAssertEqual(
      frontWindowFrame(pid: 42, windowInfo: windows),
      CGRect(x: 10, y: 10, width: 20, height: 20))
    XCTAssertEqual(frontID, 7)
    XCTAssertEqual(try selected.get(), 7)
  }

  func testSkipsAppModalAlertInFrontOfNormalLayerWindow() throws {
    let windows = [windowInfo(id: 8, layer: 8), windowInfo(id: 3)]
    let front = frontWindow(pid: 42, windowInfo: windows)
    let selected = frontCaptureWindow(
      [8, 3], frontWindowID: front?.number, sharingState: front?.sharingState, windowID: { $0 })

    XCTAssertEqual(front?.number, 3)
    XCTAssertEqual(try selected.get(), 3)
    XCTAssertEqual(frontWindowFrame(pid: 42, windowInfo: windows), front?.bounds)
  }

  func testRefusesWhenOnlyInvisibleOrEmptyWindowsRemain() {
    let windows = [
      windowInfo(id: 1, onScreen: false),
      windowInfo(id: 2, alpha: 0),
      windowInfo(id: 3, width: 0),
      windowInfo(id: 4, height: 0),
    ]
    let frontID = frontWindow(pid: 42, windowInfo: windows)?.number
    let selected = frontCaptureWindow([5], frontWindowID: frontID, sharingState: 1, windowID: { $0 })

    XCTAssertNil(frontWindowFrame(pid: 42, windowInfo: windows))
    XCTAssertNil(frontID)
    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .windowNotFound)
    }
  }

  func testSelectsTheFrontWindowEvenWhenAnotherIsLarger() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 3, area: 100)]

    let selected = frontCaptureWindow(candidates, frontWindowID: 3, sharingState: 1, windowID: \.id)

    XCTAssertEqual(try selected.get(), Candidate(id: 3, area: 100))
  }

  func testRefusesWhenTheFrontWindowIsNotShareable() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 8, area: 100)]

    let selected = frontCaptureWindow(candidates, frontWindowID: 3, sharingState: 1, windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .frontWindowNotShareable)
    }
  }

  func testCaptureExclusionSurvivesWindowSelectionAndNeverSubstitutesAnotherWindow() {
    let windows = [windowInfo(id: 3, sharingState: 0), windowInfo(id: 7)]
    let front = frontWindow(pid: 42, windowInfo: windows)
    XCTAssertEqual(front?.number, 3)
    XCTAssertEqual(front?.sharingState, 0)

    for candidates in [[3, 7], [7]] {
      let selected = frontCaptureWindow(
        candidates, frontWindowID: front?.number, sharingState: front?.sharingState, windowID: { $0 })
      XCTAssertThrowsError(try selected.get()) { error in
        XCTAssertEqual(error as? AppWindowScreenshotRefusal, .frontWindowCaptureExcluded)
      }
    }

    var entry = windowInfo(id: 3)
    entry.removeValue(forKey: kCGWindowSharingState as String)
    let unknown = frontWindow(pid: 42, windowInfo: [entry])
    let selected = frontCaptureWindow(
      [3], frontWindowID: unknown?.number, sharingState: unknown?.sharingState, windowID: { $0 })
    XCTAssertEqual(try selected.get(), 3)
  }

  func testRefusesWhenTheAppHasNoOnScreenWindow() {
    let selected = frontCaptureWindow(
      [Candidate(id: 7, area: 10_000)], frontWindowID: nil, sharingState: nil, windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .windowNotFound)
    }
  }
}

private func windowInfo(
  id: Int, pid: Int32 = 42, layer: Int = 0, onScreen: Bool = true,
  alpha: Double = 1, sharingState: Int = 1, width: Double = 100, height: Double = 100
) -> [String: Any] {
  [
    kCGWindowNumber as String: id,
    kCGWindowOwnerPID as String: pid,
    kCGWindowLayer as String: layer,
    kCGWindowIsOnscreen as String: onScreen,
    kCGWindowAlpha as String: alpha,
    kCGWindowSharingState as String: sharingState,
    kCGWindowBounds as String: CGRect(x: 10, y: 10, width: width, height: height).dictionaryRepresentation,
  ]
}
