// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The npm package ships this directory without Tests/, so the test targets are declared only
// where their sources exist; a packed tree still builds the helper.
var targets: [Target] = [
  .target(
    name: "AgentDeviceMacOSInput"
  ),
  .executableTarget(
    name: "AgentDeviceMacOSHelper",
    dependencies: ["AgentDeviceMacOSInput"]
  ),
]
let fileManager = FileManager.default
if fileManager.fileExists(atPath: "Tests/AgentDeviceMacOSInputTests") {
  targets.append(
    .testTarget(
      name: "AgentDeviceMacOSInputTests",
      dependencies: ["AgentDeviceMacOSInput"]
    ))
}
if fileManager.fileExists(atPath: "Tests/AgentDeviceMacOSHelperTests") {
  targets.append(
    .testTarget(
      name: "AgentDeviceMacOSHelperTests",
      dependencies: ["AgentDeviceMacOSHelper"]
    ))
}

let package = Package(
  name: "agent-device-macos-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(
      name: "agent-device-macos-helper",
      targets: ["AgentDeviceMacOSHelper"]
    ),
  ],
  targets: targets
)
