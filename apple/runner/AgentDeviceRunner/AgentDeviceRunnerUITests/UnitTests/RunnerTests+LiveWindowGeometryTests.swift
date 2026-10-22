#if AGENT_DEVICE_RUNNER_UNIT_TESTS
import XCTest

/// #3899: the one vector that puts a live element read in the space a command point names. The shape
/// is the iPad Pro 11-inch (M5, iOS 27.0) Windowed Apps measurement: the app reads `(0,0,386,682)`,
/// a search field inside it reads `(74,39,296,44)`, and the window reads `(324,307,386,682)`, so the
/// field answers a tap dispatched at `(398,346)`.
final class RunnerLiveWindowGeometryTests: XCTestCase {
  func testAWindowedAppReadCarriesItsWindowOrigin() {
    let offset = RunnerLiveWindowGeometry.contentOffset(
      appBox: CGRect(x: 0, y: 0, width: 386, height: 682),
      windowScreenBox: CGRect(x: 324, y: 307, width: 386, height: 682)
    )
    XCTAssertEqual(offset, CGSize(width: 324, height: 307))
    XCTAssertEqual(
      RunnerLiveWindowGeometry.screenFrame(
        of: CGRect(x: 74, y: 39, width: 296, height: 44),
        contentOffset: offset
      ),
      CGRect(x: 398, y: 346, width: 296, height: 44)
    )
  }

  func testAFullScreenAppReadCarriesNoVector() {
    let screen = CGRect(x: 0, y: 0, width: 834, height: 1210)
    XCTAssertEqual(
      RunnerLiveWindowGeometry.contentOffset(appBox: screen, windowScreenBox: screen),
      .zero,
      "a window that fills the screen moves no live read"
    )
    let phone = CGRect(x: 0, y: 0, width: 402, height: 874)
    XCTAssertEqual(
      RunnerLiveWindowGeometry.contentOffset(appBox: phone, windowScreenBox: phone),
      .zero
    )
  }

  func testASystemWindowCarriesNoVector() {
    // The SpringBoard overlay under a windowed app reports the screen's own box: it is not the app's
    // window, so its numbers declare nothing about where the app's content starts.
    XCTAssertEqual(
      RunnerLiveWindowGeometry.contentOffset(
        appBox: CGRect(x: 0, y: 0, width: 834, height: 1210),
        windowScreenBox: CGRect(x: 324, y: 307, width: 386, height: 682)
      ),
      .zero
    )
  }
}
#endif
