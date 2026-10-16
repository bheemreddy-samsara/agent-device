import XCTest

@testable import AgentDeviceMacOSHelper

private struct Candidate: Equatable {
  let id: Int
  let area: Double
}

/// An app screenshot captures the front window or refuses; it never substitutes another window.
final class AppWindowScreenshotTests: XCTestCase {
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
