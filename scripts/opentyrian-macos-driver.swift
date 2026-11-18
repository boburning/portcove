// Fixed fresh-profile probe. Process identity uses the same BSD start clock as
// Core. Input is sent only to the exact recorded child; no permission is asked.
import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import CryptoKit
import Darwin

struct ProbeFailure: Error { let message: String }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeFailure(message: message) }
}
let fm = FileManager.default
let dataset = CommandLine.arguments.last!
let native = URL(fileURLWithPath: "evidence/desktop-verify/opentyrian-macos/native").standardizedFileURL
func write(_ name: String, _ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try require(data.count <= 2 * 1024 * 1024, "Evidence JSON exceeds bound")
    try data.write(to: native.appendingPathComponent("\(dataset)-\(name).json"), options: .atomic)
}
func digest(_ file: URL, maxBytes: Int = 64 * 1024 * 1024) throws -> String {
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    try require(values.isRegularFile == true && values.isSymbolicLink != true && (values.fileSize ?? Int.max) <= maxBytes, "Expected bounded regular file: \(file.lastPathComponent), bytes=\(values.fileSize ?? -1), limit=\(maxBytes)")
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hasher = SHA256()
    var total = 0
    while let chunk = try handle.read(upToCount: 65536), !chunk.isEmpty {
        total += chunk.count
        try require(total <= maxBytes, "Input grew beyond its identity bound")
        hasher.update(data: chunk)
    }
    try require(total == values.fileSize, "Input size changed during identity check")
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
struct OwnedProcess {
    let pid: Int32
    let identity: String
    let path: String
    let parent: Int32
    let uid: UInt32
    let bsdFlags: UInt32
}
var commands: [(Process, OwnedProcess?)] = []
func inspect(_ pid: Int32) throws -> OwnedProcess? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    errno = 0
    let count = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, size) }
    if count == 0 && errno == ESRCH { return nil }
    try require(count == size, "Incomplete kernel process identity")
    if info.pbi_status == 5 { return nil } // BSD zombie: no executing child remains.
    var bytes = [CChar](repeating: 0, count: 4096)
    let length = bytes.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    try require(length > 0 && length < 4096, "Executable path unavailable")
    let path = URL(fileURLWithPath: String(cString: bytes)).resolvingSymlinksInPath().path
    return OwnedProcess(pid: pid, identity: "macos-start-time:\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)", path: path, parent: Int32(info.pbi_ppid), uid: info.pbi_uid, bsdFlags: info.pbi_flags)
}
func live(_ process: OwnedProcess) throws {
    guard let now = try inspect(process.pid) else { throw ProbeFailure(message: "Owned process has exited") }
    try require(now.identity == process.identity && now.path == process.path && now.uid == process.uid && now.parent == process.parent, "Owned process identity or ancestry changed")
}
func gone(_ process: OwnedProcess?) throws -> Bool {
    guard let process else { return true }
    guard let now = try inspect(process.pid) else { return true }
    return now.identity != process.identity
}
func plainCommand(_ executable: String, _ args: [String], _ output: URL, _ error: URL) throws -> Process {
    fm.createFile(atPath: output.path, contents: nil)
    fm.createFile(atPath: error.path, contents: nil)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    process.standardOutput = try FileHandle(forWritingTo: output)
    process.standardError = try FileHandle(forWritingTo: error)
    try process.run()
    commands.append((process, try? inspect(process.processIdentifier)))
    return process
}
func wait(_ process: Process, _ seconds: Double) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while process.isRunning && Date() < end { Thread.sleep(forTimeInterval: 0.1) }
    if !process.isRunning { process.waitUntilExit(); return true }
    return false
}
let input: [String: Any] = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "opentyrian-macos-input.json"))) as! [String: Any]
let root = URL(fileURLWithPath: input["root"] as! String)
let player = URL(fileURLWithPath: input["player"] as! String)
let cli = URL(fileURLWithPath: input["cli"] as! String)
let profile = URL(fileURLWithPath: input["profile_root"] as! String)
let library = root.appendingPathComponent("\(dataset)/library")
let port = "andyvand-opentyrian2000"
func cliJSON(_ name: String, _ args: [String]) throws -> [String: Any] {
    let output = native.appendingPathComponent("\(dataset)-\(name).json")
    let error = native.appendingPathComponent("\(dataset)-\(name).stderr.log")
    let process = try plainCommand(cli.path, ["--library", library.path] + args + ["--json"], output, error)
    try require(wait(process, 20), "CLI command did not complete within its observation budget")
    try require(process.terminationStatus == 0, "CLI command failed: \(name)")
    let data = try Data(contentsOf: output)
    try require(data.count < 1024 * 1024, "CLI JSON exceeds bound")
    let envelope = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    try require(envelope["ok"] as? Bool == true, "CLI did not report success")
    return envelope["data"] as? [String: Any] ?? [:]
}
struct Window {
    let id: UInt32
    let title: String
    let width: Double
    let height: Double
}
func ownedWindow(_ process: OwnedProcess) throws -> Window? {
    try live(process)
    let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var matches: [Window] = []
    for window in all {
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == process.pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = window[kCGWindowNumber as String] as? NSNumber,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber else { continue }
        if width.doubleValue >= 100 && height.doubleValue >= 80 && width.doubleValue <= 2560 && height.doubleValue <= 1600 {
            matches.append(Window(id: number.uint32Value, title: window[kCGWindowName as String] as? String ?? "", width: width.doubleValue, height: height.doubleValue))
        }
    }
    return matches.max { $0.width * $0.height < $1.width * $1.height }
}
func capture(_ name: String, _ process: OwnedProcess) throws {
    guard let window = try ownedWindow(process) else { throw ProbeFailure(message: "Owned visible window is absent") }
    let output = native.appendingPathComponent("\(dataset)-\(name).png")
    let command = try plainCommand("/usr/sbin/screencapture", ["-x", "-l", String(window.id), output.path], native.appendingPathComponent("\(dataset)-capture.stdout.log"), native.appendingPathComponent("\(dataset)-capture.stderr.log"))
    try require(wait(command, 10) && command.terminationStatus == 0, "Owned window capture failed")
    let image = try Data(contentsOf: output)
    try require(image.count < 4 * 1024 * 1024 && image.starts(with: [137,80,78,71,13,10,26,10]), "Window capture is not a bounded PNG")
    try write("\(name)-window", ["pid": process.pid, "identity": process.identity, "bsd_flags": process.bsdFlags, "runtime_cpu_type": NSNull(), "window": window.id, "title": window.title, "width": window.width, "height": window.height, "screenshot_sha256": try digest(output)])
}
func key(_ code: CGKeyCode, _ flags: CGEventFlags, _ process: OwnedProcess, _ supervisor: OwnedProcess) throws {
    try live(supervisor)
    try live(process)
    guard try ownedWindow(process) != nil else { throw ProbeFailure(message: "No owned input window") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw ProbeFailure(message: "Cannot create bounded input events") }
    // Only event-local flags; no modifier-down or global keyboard state changes.
    down.flags = flags
    up.flags = []
    down.postToPid(process.pid)
    up.postToPid(process.pid)
}
func snapshot(_ roots: [URL]) throws -> [String: String] {
    var result: [String: String] = [:]
    let package = URL(fileURLWithPath: input["package"] as! String)
    for (index, root) in roots.enumerated() {
        let initial = try root.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        try require(initial.isSymbolicLink != true, "Snapshot root is a link")
        if initial.isRegularFile == true {
            result["\(index)/\(root.lastPathComponent)"] = try digest(root)
            continue
        }
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey]) else { throw ProbeFailure(message: "External snapshot root is absent") }
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
            let key = "\(index)/\(file.path.dropFirst(root.path.count + 1))"
            try require(result.count < 8000, "External inventory exceeds bound")
            if values.isSymbolicLink == true {
                let target = try fm.destinationOfSymbolicLink(atPath: file.path)
                try require(target.utf8.count <= 4096, "Link target exceeds observation bound")
                if root == package {
                    try require(file.resolvingSymlinksInPath().path.hasPrefix(package.path + "/") && !target.hasPrefix("/"), "Link escapes the publisher package")
                } else {
                    // macOS creates links to shared user folders in sandbox
                    // homes. Observe their text only; never inspect their data.
                    try require(root == profile.deletingLastPathComponent(), "Unexpected external profile link")
                }
                result[key] = "symlink:" + target
                enumerator.skipDescendants()
            } else if values.isRegularFile == true {
                result[key] = try digest(file)
            }
        }
    }
    return result
}
var supervisor: OwnedProcess?
var child: OwnedProcess?
var execution: Process?
var forced = false
var failed: Error?
do {
    try require(dataset == "menu", "Unknown fixed dataset")
    try require(CGPreflightScreenCaptureAccess() && AXIsProcessTrusted(), "Actual driver lacks capture or accessibility access; no permission requested")
    try require(try digest(cli, maxBytes: 512 * 1024 * 1024) == input["cli_sha256"] as? String && digest(player) == input["player_sha256"] as? String, "Executed input identity differs")
    try require(!fm.fileExists(atPath: profile.deletingLastPathComponent().path), "Publisher sandbox container appeared after input preparation")
    try fm.createDirectory(at: library, withIntermediateDirectories: true)
    let args = ["--no-sound", "--no-joystick", "--no-xmas"]
    var selected = [port, player.path, "--working-directory", input["working_directory"] as! String]
    selected += args.map { "--arg=\($0)" }
    let preview = try cliJSON("select-preview", ["external", "select-preview"] + selected)
    guard let previewHash = preview["preview_sha256"] as? String else { throw ProbeFailure(message: "Selection preview identity absent") }
    _ = try cliJSON("select", ["external", "select"] + selected + ["--expected-preview", previewHash, "--yes"])
    let package = URL(fileURLWithPath: input["package"] as! String)
    let packageBefore = try snapshot([package])
    let request = UUID().uuidString
    let process = try plainCommand(cli.path, ["--library", library.path, "exec", "--request-id", request, port], native.appendingPathComponent("\(dataset)-player.stdout.log"), native.appendingPathComponent("\(dataset)-player.stderr.log"))
    execution = process
    supervisor = try inspect(process.processIdentifier)
    guard let owner = supervisor else { throw ProbeFailure(message: "Supervisor identity absent") }
    try require(owner.path == cli.path && owner.uid == getuid(), "Unexpected supervisor identity")
    let deadline = Date().addingTimeInterval(65)
    while Date() < deadline && process.isRunning {
        let record = try cliJSON("live-launch", ["launch", "show", request])
        if let pid = record["child_pid"] as? NSNumber, let observed = try inspect(pid.int32Value) {
            try require(observed.path == player.path && observed.parent == owner.pid && observed.uid == owner.uid, "Player ancestry/path differs")
            try require(record["supervisor_identity"] as? String == owner.identity && record["child_identity"] as? String == observed.identity && (record["supervisor_pid"] as? NSNumber)?.int32Value == owner.pid, "Core/kernel process identities differ")
            child = observed
            if try ownedWindow(observed) != nil { break }
        }
        Thread.sleep(forTimeInterval: 0.5)
    }
    guard let game = child else { throw ProbeFailure(message: "Recorded native child was not established") }
    try live(owner); try live(game)
    Thread.sleep(forTimeInterval: 8)
    try capture("intro", game)
    // The publisher's two intro logos precede its menu; observe finite extra
    // time without injecting keys or changing the game's own deadlines.
    Thread.sleep(forTimeInterval: 12)
    try capture("menu", game)
    NSRunningApplication(processIdentifier: game.pid)?.activate(options: [.activateIgnoringOtherApps])
    Thread.sleep(forTimeInterval: 0.5)
    try key(12, .maskCommand, game, owner)
    if !wait(process, 20) {
        try? capture("quit-pending", game)
        throw ProbeFailure(message: "Owned player did not complete after normal quit")
    }
    let final = try cliJSON("final-launch", ["launch", "show", request])
    let gameExited = try gone(game)
    try require(process.terminationStatus == 0 && final["outcome"] as? String == "succeeded" && (final["exit_code"] as? NSNumber)?.intValue == 0 && gameExited, "Normal native exit was not established")
    let settings = profile.appendingPathComponent("opentyrian.cfg")
    let settingsSize = try settings.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try require(settingsSize > 0 && settingsSize <= 1024 * 1024, "No bounded native settings file was produced")
    try require(try snapshot([package]) == packageBefore, "Player modified publisher package bytes")
    let globals = (input["initially_absent_global_paths"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }.filter { fm.fileExists(atPath: $0.path) }
    let externalRoots = [package] + globals
    let before = try snapshot(externalRoots)
    try write("external-before-removal", before)
    let removal = try cliJSON("removal-preview", ["external", "removal-preview", port])
    guard let removalHash = removal["preview_sha256"] as? String else { throw ProbeFailure(message: "Removal preview identity absent") }
    _ = try cliJSON("remove", ["external", "remove", port, "--expected-preview", removalHash, "--yes"])
    let status = try cliJSON("removed-status", ["status", port])
    let after = try snapshot(externalRoots)
    try write("external-after-removal", after)
    try require(before == after && (status["external_runtime"] == nil || status["external_runtime"] is NSNull), "Registration removal changed external bytes or retained registration")
    try write("result", ["phase": "complete-pending-image-inspection", "native_exit": 0, "profile_root": profile.path, "settings_bytes": settingsSize, "settings_sha256": try digest(settings), "preserved_entries": before.count, "external_link_contents": "not traversed or inspected", "scope": "Publisher universal Mac package menu, normal exit and fresh settings creation; screenshots require inspection; no mission gameplay, populated-save restoration, audio, physical controls, Tauri or managed maintenance claim"])


} catch {
    failed = error
    try? write("failure", ["message": String(describing: error), "phase": "failed"])
}
if let process = execution, process.isRunning {
    // Cleanup is confined to retained kernel identities. It is not acceptance.
    if let game = child, (try? live(game)) != nil {
        forced = true
        _ = kill(game.pid, SIGTERM)
        _ = wait(process, 5)
    }
    if process.isRunning, let owner = supervisor, (try? live(owner)) != nil {
        forced = true
        process.terminate()
        _ = wait(process, 5)
    }
}
for (command, identity) in commands where command.isRunning {
    if let identity, (try? live(identity)) != nil {
        forced = true
        command.terminate()
        _ = wait(command, 5)
    }
}
let nativeClosed = execution == nil || (child != nil && (try? gone(child)) == true)
let allExited = commands.allSatisfy { !$0.0.isRunning } && nativeClosed
try? write("cleanup", ["all_owned_processes_exited": allExited, "forced_cleanup": forced, "root_exited": execution == nil || execution?.isRunning == false, "child_exited": (try? gone(child)) == true, "input_scope": "event-local key flags only; no modifier-down state", "acceptance": failed == nil && !forced && allExited])
exit(failed == nil && !forced && allExited ? 0 : 1)
