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
let native = URL(fileURLWithPath: "evidence/desktop-verify/openttd-macos/native").standardizedFileURL
func write(_ name: String, _ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try require(data.count <= 2 * 1024 * 1024, "Evidence JSON exceeds bound")
    try data.write(to: native.appendingPathComponent("\(dataset)-\(name).json"), options: .atomic)
}
func digest(_ file: URL) throws -> String {
    let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    try require(values.isRegularFile == true && values.isSymbolicLink != true && (values.fileSize ?? Int.max) <= 64 * 1024 * 1024, "Expected a bounded regular file")
    return SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined()
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
let input: [String: Any] = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "openttd-macos-input.json"))) as! [String: Any]
let root = URL(fileURLWithPath: input["root"] as! String)
let player = URL(fileURLWithPath: input["player"] as! String)
let cli = URL(fileURLWithPath: input["cli"] as! String)
let profile = root.appendingPathComponent("\(dataset)/profile")
let library = root.appendingPathComponent("\(dataset)/library")
let port = "transport-tycoon-deluxe-openttd-upstream"
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
    for (index, root) in roots.enumerated() {
        if try root.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
            result["\(index)/\(root.lastPathComponent)"] = try digest(root)
            continue
        }
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey]) else { throw ProbeFailure(message: "External snapshot root is absent") }
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
            try require(values.isSymbolicLink != true, "External snapshot contains a link")
            if values.isRegularFile == true {
                try require(result.count < 5000, "External inventory exceeds bound")
                result["\(index)/\(file.path.dropFirst(root.path.count + 1))"] = try digest(file)
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
    try require(["fresh", "replay"].contains(dataset), "Unknown fixed dataset")
    try require(CGPreflightScreenCaptureAccess() && AXIsProcessTrusted(), "Actual driver lacks capture or accessibility access; no permission requested")
    try require(try digest(cli) == input["cli_sha256"] as? String && digest(player) == input["player_sha256"] as? String, "Executed input identity differs")
    try fm.createDirectory(at: profile.appendingPathComponent("baseset"), withIntermediateDirectories: true)
    try fm.createDirectory(at: library, withIntermediateDirectories: true)
    try fm.copyItem(at: root.appendingPathComponent("inputs/graphics/opengfx-8.0.tar"), to: profile.appendingPathComponent("baseset/opengfx-8.0.tar"))
    let config = profile.appendingPathComponent("openttd.cfg")
    try "[game_creation]\nmap_x = 6\nmap_y = 6\nstarting_year = 1950\n[gui]\nautosave_on_exit = true\nautosave_interval = 0\n[network]\nparticipate_survey = no\nclient_name = Player\n".write(to: config, atomically: true, encoding: .utf8)
    var args = ["-c", config.path, "-r", "960x640", "-s", "null", "-m", "null"]
    var originalSave: URL?
    var copiedSave: URL?
    var saveHash: String?
    if dataset == "fresh" { args += ["-G", "12345", "-g"] }
    else {
        let save = root.appendingPathComponent("fresh/profile/save/autosave/exit.sav")
        let first = try JSONSerialization.jsonObject(with: Data(contentsOf: native.appendingPathComponent("fresh-result.json"))) as! [String: Any]
        guard let recordedHash = first["save_sha256"] as? String,
              let recordedBytes = first["save_bytes"] as? NSNumber else { throw ProbeFailure(message: "First native save receipt is absent") }
        try require(try digest(save) == recordedHash && save.resourceValues(forKeys: [.fileSizeKey]).fileSize == recordedBytes.intValue, "First native save identity changed before replay")
        saveHash = recordedHash
        let copy = profile.appendingPathComponent("input.sav")
        try fm.copyItem(at: save, to: copy)
        try require(try digest(copy) == saveHash, "Save copy differs")
        originalSave = save; copiedSave = copy
        args += ["-g", copy.path]
    }
    var selected = [port, player.path, "--working-directory", profile.path]
    selected += args.map { "--arg=\($0)" }
    let preview = try cliJSON("select-preview", ["external", "select-preview"] + selected)
    guard let previewHash = preview["preview_sha256"] as? String else { throw ProbeFailure(message: "Selection preview identity absent") }
    _ = try cliJSON("select", ["external", "select"] + selected + ["--expected-preview", previewHash, "--yes"])
    let package = root.appendingPathComponent("inputs/player")
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
    try capture("map", game)
    NSRunningApplication(processIdentifier: game.pid)?.activate(options: [.activateIgnoringOtherApps])
    Thread.sleep(forTimeInterval: 0.5)
    try key(12, .maskCommand, game, owner) // macOS Command-Q.
    Thread.sleep(forTimeInterval: 2)
    let gameStillLive = try !gone(game)
    if process.isRunning && gameStillLive {
        try capture("quit-confirmation", game)
        try key(36, [], game, owner) // Return, only to the same live child.
    }
    try require(wait(process, 20), "Owned player did not complete after normal quit")
    let final = try cliJSON("final-launch", ["launch", "show", request])
    let gameExited = try gone(game)
    try require(process.terminationStatus == 0 && final["outcome"] as? String == "succeeded" && (final["exit_code"] as? NSNumber)?.intValue == 0 && gameExited, "Normal native exit was not established")
    let save = profile.appendingPathComponent("save/autosave/exit.sav")
    let saveSize = try save.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    try require(saveSize >= 1024 && saveSize <= 16 * 1024 * 1024, "No bounded native exit save was produced")
    let privateConfig = try String(contentsOf: profile.appendingPathComponent("private.cfg"), encoding: .utf8)
    try require(privateConfig.range(of: "(?m)^participate_survey\\s*=\\s*no\\s*$", options: .regularExpression) != nil && privateConfig.range(of: "(?m)^client_name\\s*=\\s*Player\\s*$", options: .regularExpression) != nil, "Native private settings differ")
    if let originalSave, let copiedSave, let saveHash {
        try require(try digest(originalSave) == saveHash && digest(copiedSave) == saveHash, "Save replay modified an input")
    }
    try require(try snapshot([package]) == packageBefore, "Player modified publisher package bytes")
    let globals = (input["initially_absent_global_paths"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }.filter { fm.fileExists(atPath: $0.path) }
    let externalRoots = [package, profile] + globals
    let before = try snapshot(externalRoots)
    try write("external-before-removal", before)
    let removal = try cliJSON("removal-preview", ["external", "removal-preview", port])
    guard let removalHash = removal["preview_sha256"] as? String else { throw ProbeFailure(message: "Removal preview identity absent") }
    _ = try cliJSON("remove", ["external", "remove", port, "--expected-preview", removalHash, "--yes"])
    let status = try cliJSON("removed-status", ["status", port])
    let after = try snapshot(externalRoots)
    try write("external-after-removal", after)
    try require(before == after && (status["external_runtime"] == nil || status["external_runtime"] is NSNull), "Registration removal changed external bytes or retained registration")
    try write("result", ["phase": "complete-pending-image-inspection", "native_exit": 0, "save_bytes": saveSize, "save_sha256": try digest(save), "input_save_sha256": saveHash as Any? ?? NSNull(), "preserved_files": before.count, "scope": "Real generated-map save/reopen in separate private profiles; screenshots require inspection; no economic progress, audio, physical controls, Tauri or managed maintenance claim"])
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
