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

    let frontID = onScreenWindows(pid: 42, windowInfo: windows).first?.number
    let selected = frontCaptureWindow([7, 8], frontWindowID: frontID, windowID: { $0 })

    // Scroll and the click actionWindow fallback both consume frontWindowFrame.
    XCTAssertEqual(
      frontWindowFrame(pid: 42, windowInfo: windows),
      CGRect(x: 10, y: 10, width: 20, height: 20))
    XCTAssertEqual(frontID, 7)
    XCTAssertEqual(try selected.get(), 7)
  }

  func testRefusesWhenOnlyInvisibleOrEmptyWindowsRemain() {
    let windows = [
      windowInfo(id: 1, onScreen: false),
      windowInfo(id: 2, alpha: 0),
      windowInfo(id: 3, width: 0),
      windowInfo(id: 4, height: 0),
    ]
    let frontID = onScreenWindows(pid: 42, windowInfo: windows).first?.number
    let selected = frontCaptureWindow([5], frontWindowID: frontID, windowID: { $0 })

    XCTAssertNil(frontWindowFrame(pid: 42, windowInfo: windows))
    XCTAssertNil(frontID)
    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .windowNotFound)
    }
  }

  func testSelectsTheFrontWindowEvenWhenAnotherIsLarger() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 3, area: 100)]

    let selected = frontCaptureWindow(candidates, frontWindowID: 3, windowID: \.id)

    XCTAssertEqual(try selected.get(), Candidate(id: 3, area: 100))
  }

  func testRefusesWhenTheFrontWindowIsNotShareable() {
    let candidates = [Candidate(id: 7, area: 10_000), Candidate(id: 8, area: 100)]

    let selected = frontCaptureWindow(candidates, frontWindowID: 3, windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .frontWindowNotShareable)
    }
  }

  func testRefusesWhenTheAppHasNoOnScreenWindow() {
    let selected = frontCaptureWindow(
      [Candidate(id: 7, area: 10_000)], frontWindowID: nil, windowID: \.id)

    XCTAssertThrowsError(try selected.get()) { error in
      XCTAssertEqual(error as? AppWindowScreenshotRefusal, .windowNotFound)
    }
  }
}

private func windowInfo(
  id: Int, pid: Int32 = 42, layer: Int = 0, onScreen: Bool = true,
  alpha: Double = 1, width: Double = 100, height: Double = 100
) -> [String: Any] {
  [
    kCGWindowNumber as String: id,
    kCGWindowOwnerPID as String: pid,
    kCGWindowLayer as String: layer,
    kCGWindowIsOnscreen as String: onScreen,
    kCGWindowAlpha as String: alpha,
    kCGWindowBounds as String: CGRect(x: 10, y: 10, width: width, height: height).dictionaryRepresentation,
  ]
}
