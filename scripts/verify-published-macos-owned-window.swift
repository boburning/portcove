import AppKit
import CoreGraphics
import Foundation

struct NativeWitnessError: Error {
    let reason: String
}

func require(_ condition: Bool, _ reason: String) throws {
    guard condition else { throw NativeWitnessError(reason: reason) }
}

func ownedWindows(_ pid: pid_t) -> Int {
    let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    return listed.filter { window in
        (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
            (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 &&
            ((window[kCGWindowBounds as String] as? [String: NSNumber])?["Width"]?.intValue ?? 0) > 128 &&
            ((window[kCGWindowBounds as String] as? [String: NSNumber])?["Height"]?.intValue ?? 0) > 128
    }.count
}

@main
struct NativeWitness {
    @MainActor
    static func main() async {
        var report: [String: Any] = ["launch_method": "NSWorkspace.openApplication"]
        var launchedApp: NSRunningApplication?
        var exactBundle = false
        var normalQuitRequested = false
        var outcome: Int32 = 0
        do {
            let arguments = CommandLine.arguments
            try require(arguments.count == 3, "invalid_arguments")
            let bundle = URL(fileURLWithPath: arguments[1]).resolvingSymlinksInPath()
            let executable = bundle.appendingPathComponent("Contents/MacOS/portcove-desktop").resolvingSymlinksInPath()
            guard let expectedCPU = Int(arguments[2]) else { throw NativeWitnessError(reason: "invalid_cpu") }

            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            config.createsNewApplicationInstance = true
            config.allowsRunningApplicationSubstitution = false
            config.addsToRecentItems = false
            config.promptsUserIfNeeded = false
            let privateKeys = [
                "CFFIXED_USER_HOME", "PORTCOVE_LIBRARY", "PORTCOVE_PREFERENCES",
                "PORTCOVE_APPLICATION_UPDATE_PREFERENCES", "PORTCOVE_APPLICATION_RUNTIME_LOCK",
            ]
            let environment = ProcessInfo.processInfo.environment
            config.environment = Dictionary(uniqueKeysWithValues: privateKeys.compactMap { key in
                environment[key].map { (key, $0) }
            })
            try require(config.environment.count == privateKeys.count, "isolated_environment_missing")

            let app = try await NSWorkspace.shared.openApplication(at: bundle, configuration: config)
            launchedApp = app
            let pid = app.processIdentifier
            let bundleMatches = app.bundleURL?.resolvingSymlinksInPath().path == bundle.path
            let executableMatches = app.executableURL?.resolvingSymlinksInPath().path == executable.path
            let identifierMatches = app.bundleIdentifier == "io.github.portcove.portcove"
            let cpu = app.executableArchitecture
            exactBundle = pid > 1 && bundleMatches && executableMatches && identifierMatches
            report["pid"] = Int(pid)
            report["bundle_matches"] = bundleMatches
            report["executable_matches"] = executableMatches
            report["identifier_matches"] = identifierMatches
            report["expected_native_cpu"] = expectedCPU
            report["actual_cpu"] = cpu
            report["live_after_launch"] = !app.isTerminated
            report["cocoa_launch_date"] = app.launchDate?.timeIntervalSince1970
            try require(pid > 1, "invalid_returned_pid")
            try require(bundleMatches, "unexpected_bundle_path")
            try require(executableMatches, "unexpected_executable_path")
            try require(identifierMatches, "unexpected_bundle_identifier")
            try require(cpu == expectedCPU, "unexpected_executing_architecture")
            try require(!app.isTerminated, "application_exited_during_launch")

            let windowDeadline = DispatchTime.now().uptimeNanoseconds + 40_000_000_000
            var count = 0
            while !app.isTerminated && DispatchTime.now().uptimeNanoseconds < windowDeadline {
                count = ownedWindows(pid)
                if count > 0 { break }
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            report["owned_windows"] = count
            try require(count > 0, "no_visible_owned_window")
            try require(!app.isTerminated, "application_exited_before_quit")
            try require(app.terminate(), "normal_quit_request_failed")
            normalQuitRequested = true
            report["quit"] = "NSRunningApplication.terminate"
            let quitDeadline = DispatchTime.now().uptimeNanoseconds + 20_000_000_000
            while !app.isTerminated && DispatchTime.now().uptimeNanoseconds < quitDeadline {
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            report["terminated"] = app.isTerminated
            try require(app.isTerminated, "same_application_did_not_terminate")
        } catch let error as NativeWitnessError {
            report["reason"] = error.reason
            outcome = 1
        } catch {
            let detail = error as NSError
            report["reason"] = "native_launch_or_wait_failed"
            report["error_domain"] = detail.domain
            report["error_code"] = detail.code
            outcome = 1
        }
        if outcome != 0, exactBundle, let app = launchedApp, !app.isTerminated, !normalQuitRequested {
            report["failure_cleanup_requested"] = app.terminate()
        }
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        } else {
            outcome = 1
        }
        exit(outcome)
    }
}
