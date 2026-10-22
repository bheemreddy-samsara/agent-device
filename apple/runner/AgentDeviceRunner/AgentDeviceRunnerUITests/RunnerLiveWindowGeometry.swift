import CoreGraphics
import AgentDeviceSnapshotPresentation

// The one conversion that puts a live element read in the space a command point names (#3899).
//
// Measured on iPad Pro 11-inch (M5, iOS 27.0) with Windowed Apps on and a Calendar window at screen
// (324,307,386x682): the app's own `XCUIApplication.frame` reads `(0,0,386,682)`, a search field
// inside it reads `(74,39,296,44)`, and `XCUIApplication.windows[0].frame` reads
// `(324,307,386,682)`. So an `XCUIElement` read shares the app's own reported space while a window
// read reports the screen's space — the same split the capture's tree publishes, and the reason a
// live read that answers a caller's screen-space point has to cross the vector once.
//
// The rule is the capture's: `SnapshotContentTranslation` reads the app's box against the box its
// window reports and names the window's origin, or nothing. A full-screen window, an iPhone, and
// each foldable panel of ADR 0025 report an app box that starts at the origin of the box their
// window reports, so the vector is `.zero` there and every live read answers exactly as before.
//
// This is a pure rule on purpose — no `XCUIApplication` — so the decision is proven here, and the
// runner's callers only hand it the two frames they already read.
enum RunnerLiveWindowGeometry {
  /// The vector from the app's own reported box to the screen space its window sits in, or `.zero`
  /// when the app's box declares no offset. Read once per command, then applied to each live frame
  /// that answers a screen-space point.
  static func contentOffset(appBox: CGRect, windowScreenBox: CGRect) -> CGSize {
    SnapshotContentTranslation.offset(reportedBox: appBox, viewportBox: windowScreenBox) ?? .zero
  }

  /// `liveFrame` in the space a command point names. Dispatch already lands a screen-space point at
  /// the screen, so a frame read this way addresses the control the screenshot draws.
  static func screenFrame(of liveFrame: CGRect, contentOffset: CGSize) -> CGRect {
    liveFrame.offsetBy(dx: contentOffset.width, dy: contentOffset.height)
  }
}
