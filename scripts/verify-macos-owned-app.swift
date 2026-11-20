import AppKit
import CoreGraphics

let arguments = CommandLine.arguments
guard arguments.count == 4,
      let pid = Int32(arguments[2]), pid > 1,
      let app = NSRunningApplication(processIdentifier: pid),
      !app.isTerminated,
      app.executableURL?.resolvingSymlinksInPath().path == arguments[3]
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
    print(owned.count)
case "quit":
    guard app.terminate() else { exit(4) }
    print(owned.count)
default:
    exit(5)
}
