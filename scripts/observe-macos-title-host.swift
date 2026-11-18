// Read-only observation of this Swift process. No permission request, input,
// application launch, screenshot, signing, account or persistent-state change.
import Foundation
import CoreGraphics
import ApplicationServices

let environment = ProcessInfo.processInfo.environment
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]]
#if arch(arm64)
let architecture = "arm64"
#elseif arch(x86_64)
let architecture = "x86_64"
#else
let architecture = "unknown"
#endif
let observation: [String: Any] = [
    "format_version": 1,
    "mode": "read-only-host-observation",
    "controller": environment["GITHUB_SHA"] ?? "unknown",
    "run": environment["GITHUB_RUN_ID"] ?? "unknown",
    "attempt": environment["GITHUB_RUN_ATTEMPT"] ?? "unknown",
    "runner": environment["OBSERVED_RUNNER"] ?? "unknown",
    "os": ProcessInfo.processInfo.operatingSystemVersionString,
    "architecture": architecture,
    "screen_capture_preflight": CGPreflightScreenCaptureAccess(),
    "accessibility_trusted": AXIsProcessTrusted(),
    "on_console": session["kCGSessionOnConsoleKey"] ?? NSNull(),
    "login_done": session["kCGSessionLoginDoneKey"] ?? NSNull(),
    "main_display_pixels": [CGDisplayPixelsWide(CGMainDisplayID()), CGDisplayPixelsHigh(CGMainDisplayID())],
    "visible_window_records": windows.map { $0.count } as Any? ?? NSNull(),
    "product_executed": false,
    "boundary": "Observer API values only; no title, Tauri, signing, permission grant or other application acceptance."
]
let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
guard data.count <= 8192 else { fatalError("Observation exceeds bound") }
print(String(decoding: data, as: UTF8.self))
