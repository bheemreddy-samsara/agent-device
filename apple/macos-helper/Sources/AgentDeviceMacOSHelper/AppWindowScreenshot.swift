import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Captures the session app's front window by itself: windows above it, the ghost cursor, and
/// the rest of the desktop are not in the image, so the app may sit behind the user's work.
func captureAppWindowScreenshot(app: NSRunningApplication, outPath: String) throws {
  guard #available(macOS 14.0, *) else {
    throw HelperError.commandFailed("app window screenshots require macOS 14 or newer")
  }
  let pid = app.processIdentifier
  let windowInfo = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let frontWindowID = frontCaptureWindowNumber(windowInfo, pid: pid)
  let content = try awaitShareableContent()
  let candidates = content.windows.filter {
    $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 0
      && $0.frame.height > 0
  }
  let window: SCWindow
  let selection = frontCaptureWindow(
    candidates, frontWindowID: frontWindowID, windowID: { Int($0.windowID) })
  switch selection {
  case .success(let front):
    window = front
  case .failure(let refusal):
    throw screenshotRefusal(refusal, app: app, frontWindowID: frontWindowID)
  }

  let filter = SCContentFilter(desktopIndependentWindow: window)
  let configuration = SCStreamConfiguration()
  let scale = CGFloat(filter.pointPixelScale)
  configuration.width = Int(filter.contentRect.width * scale)
  configuration.height = Int(filter.contentRect.height * scale)
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true

  let semaphore = DispatchSemaphore(value: 0)
  var capturedImage: CGImage?
  var capturedError: Error?
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
    capturedImage = image
    capturedError = error
    semaphore.signal()
  }
  semaphore.wait()
  if let error = capturedError as NSError? {
    throw screenshotFailure(error, surface: "app")
  }
  guard let capturedImage else {
    throw HelperError.commandFailed("screenshot failed")
  }
  try writePNG(capturedImage, to: outPath)
}

/// WindowServer returns windows front to back. Invisible and empty windows cannot be capture targets.
func frontCaptureWindowNumber(_ windowInfo: [[String: Any]], pid: pid_t) -> Int? {
  for entry in windowInfo {
    guard (entry[kCGWindowOwnerPID as String] as? Int32) == pid,
      (entry[kCGWindowLayer as String] as? Int) == 0,
      (entry[kCGWindowIsOnscreen as String] as? Bool) == true,
      let alpha = entry[kCGWindowAlpha as String] as? Double, alpha > 0,
      let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
      bounds.width > 0, bounds.height > 0,
      let number = entry[kCGWindowNumber as String] as? Int
    else { continue }
    return number
  }
  return nil
}

/// Why an app screenshot refuses. The capture is the app's front window or nothing: another
/// window of the app would show state the user is not looking at. Pinned with the host by
/// `contracts/fixtures/macos-native-helper-outcomes.json`.
enum AppWindowScreenshotRefusal: String, CaseIterable, Error {
  case windowNotFound = "window-not-found"
  case frontWindowNotShareable = "front-window-not-shareable"
}

/// The shareable candidate whose WindowServer ID is the app's front window.
func frontCaptureWindow<Window>(
  _ candidates: [Window],
  frontWindowID: Int?,
  windowID: (Window) -> Int
) -> Result<Window, AppWindowScreenshotRefusal> {
  guard let frontWindowID else { return .failure(.windowNotFound) }
  guard let front = candidates.first(where: { windowID($0) == frontWindowID }) else {
    return .failure(.frontWindowNotShareable)
  }
  return .success(front)
}

private func screenshotRefusal(
  _ refusal: AppWindowScreenshotRefusal,
  app: NSRunningApplication,
  frontWindowID: Int?
) -> HelperError {
  var details = ["reason": refusal.rawValue, "bundleId": app.bundleIdentifier ?? ""]
  switch refusal {
  case .windowNotFound:
    return .commandFailed("screenshot could not find an on-screen window for the app", details: details)
  case .frontWindowNotShareable:
    details["frontWindowId"] = frontWindowID.map(String.init) ?? ""
    return .commandFailed(
      "screenshot could not capture the app's front window: ScreenCaptureKit does not offer it",
      details: details
    )
  }
}

@available(macOS 14.0, *)
private func awaitShareableContent() throws -> SCShareableContent {
  let semaphore = DispatchSemaphore(value: 0)
  var shareable: SCShareableContent?
  var failure: Error?
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
    shareable = content
    failure = error
    semaphore.signal()
  }
  semaphore.wait()
  if let error = failure as NSError? {
    throw screenshotFailure(error, surface: "app")
  }
  guard let shareable else {
    throw HelperError.commandFailed("screenshot could not list shareable windows")
  }
  return shareable
}
