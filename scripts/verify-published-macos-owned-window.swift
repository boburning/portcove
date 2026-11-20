import AppKit
import CoreGraphics

let arguments = CommandLine.arguments
guard arguments.count == 7,
      let pid = Int32(arguments[2]), pid > 1,
      let architecture = Int(arguments[4]),
      let started = TimeInterval(arguments[5]),
      let app = NSRunningApplication(processIdentifier: pid),
      !app.isTerminated,
      app.executableURL?.resolvingSymlinksInPath().path == arguments[3],
      app.bundleIdentifier == "io.github.portcove.portcove",
      app.executableArchitecture == architecture,
      let launched = app.launchDate?.timeIntervalSince1970,
      launched >= started - 2,
      launched <= started + 10
else { exit(2) }

let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
let owned = listed.filter { window in
    (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
        (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 &&
        ((window[kCGWindowBounds as String] as? [String: NSNumber])?["Width"]?.intValue ?? 0) > 128 &&
        ((window[kCGWindowBounds as String] as? [String: NSNumber])?["Height"]?.intValue ?? 0) > 128
}
guard !owned.isEmpty else { exit(3) }

switch arguments[1] {
case "window":
    break
case "quit":
    guard arguments[6] == String(launched), app.terminate() else { exit(4) }
default:
    exit(5)
}
print("\(owned.count) \(app.executableArchitecture) \(launched)")
