#!/usr/bin/env python3
"""One fixed released-CLI lifecycle in a disposable GitHub-hosted macOS home."""

import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import struct
import subprocess
import tarfile
import tempfile
import time
import uuid


PORT = "tux-racer-sdl2-port"
CLIENT_SOURCE = "f4256f25615d75acc081afb984ab4195288db881"
CLIENT_TAG = "nightly-0.1.0-preview.9"
TUX_SOURCE = "ec4b547d23245a6a1afc6ae7758657f931af9bc1"
TUX_TAG = "v0.61-sdl2"
TUX_NAME = "TuxRacer-0.61-sdl2-macOS.zip"
TUX_DIGEST = "6dffea22867b0bafb34c488a9c868c107c38375f7598f4a82f0ed3d4174426d6"
TUX_URL = f"https://github.com/labbej27/tuxracer/releases/download/{TUX_TAG}/{TUX_NAME}"
TUX_EXE = Path("Tux Racer.app/Contents/MacOS/Tux Racer")
TUX_EXE_DIGEST = "9652c8d0d232edef1da980355cddbab082e8bd91db47fb27c9eada6e4dd249c2"
TUX_COURSE = Path("Tux Racer.app/Contents/Resources/data/courses/frozen_river/course.tcl")
TUX_COURSE_DIGEST = "050728f592b12a9d43c527eef7cd6d7f37790ba9979cf4816674a9301c5b6793"
CLIENTS = {
    "macos-15": (
        "arm64", "aarch64", 768235817, 18880974,
        "69c8d2c30129aa82a61bfe64bcb0bf8af94b98630b9a5421143f985a9a7e07cc",
        "d91a97b8089d5aad9993f327060559041f985ae3c44a7da5ccfa4eda95b3afed",
    ),
    "macos-15-intel": (
        "x86_64", "x86_64", 768235918, 19988873,
        "05ebf14f2ba2492e9f64d819b857d6df1a3282bd2469db42eee577d9ee42bdad",
        "5140566730af9ab394005161f98a8755e81f5bb13682ce8cd550fc7c3d6de393",
    ),
}
MACH_CPU_TYPES = {"x86_64": 0x01000007, "arm64": 0x0100000C}
CLI_ERROR_CODES = {
    2: "usage", 3: "unsupported", 4: "not_found", 5: "source_invalid",
    10: "network", 11: "verification", 12: "install", 13: "state",
    14: "conflict", 125: "launch", 130: "cancelled",
}
INSTALL_ERROR_REASONS = {
    "download size does not match release metadata": "download_size_mismatch",
    "download exceeded its declared release size": "download_size_mismatch",
    "downloaded asset failed SHA-256 verification": "download_sha256_mismatch",
    "archive paths must be ASCII to avoid cross-platform Unicode aliases": "archive_path_encoding",
    "ZIP contains an unsupported entry type": "archive_unsupported_entry_type",
    "ZIP links and special files are not allowed": "archive_unsupported_entry_type",
    "archive links and special files are not allowed": "archive_unsupported_entry_type",
    "none of the declared executable hints for MacosX86_64 were found": "declared_executable_missing",
    "none of the declared executable hints for MacosAarch64 were found": "declared_executable_missing",
    "the Mac bundle executable has no matching Mach-O architecture": "executable_architecture_mismatch",
    "installation inputs changed; review installation again": "reviewed_plan_changed",
}


class VerificationError(RuntimeError):
    """A controlled failure message suitable for the public receipt."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def output(args, *, seconds=30, env=None):
    tool = Path(args[0]).name
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=seconds, env=env)
    except subprocess.TimeoutExpired:
        raise VerificationError(f"{tool} exceeded its command deadline") from None
    require(result.returncode == 0, f"{tool} returned {result.returncode}")
    return result.stdout


def digest(path):
    with path.open("rb") as payload:
        return hashlib.file_digest(payload, "sha256").hexdigest()


def verify_macho_executable(path, expected, subject):
    """Read the bounded Mach-O headers of the already digest-verified input."""
    reason = f"{subject} has an unexpected Mach-O executable architecture"

    def header_at(payload, offset):
        payload.seek(offset)
        header = payload.read(32)
        require(len(header) == 32, reason)
        return header

    def executable_cpu(header):
        require(header[:4] == b"\xcf\xfa\xed\xfe", reason)
        cpu, _, file_type = struct.unpack_from("<III", header, 4)
        require(file_type == 2, reason)  # MH_EXECUTE
        return cpu

    with path.open("rb") as payload:
        header = header_at(payload, 0)
        cpus = set()
        if header[:4] == b"\xca\xfe\xba\xbe":
            count = struct.unpack_from(">I", header, 4)[0]
            require(1 <= count <= len(MACH_CPU_TYPES), reason)
            table_end = 8 + count * 20
            payload.seek(8)
            table = payload.read(count * 20)
            require(len(table) == count * 20, reason)
            file_size = os.fstat(payload.fileno()).st_size
            ranges = []
            for cpu, _, offset, size, _ in struct.iter_unpack(">IIIII", table):
                end = offset + size
                require(table_end <= offset and size >= 32 and end <= file_size and cpu not in cpus, reason)
                require(all(end <= start or offset >= stop for start, stop in ranges), reason)
                require(executable_cpu(header_at(payload, offset)) == cpu, reason)
                ranges.append((offset, end))
                cpus.add(cpu)
        else:
            cpus.add(executable_cpu(header))
    require(cpus == {MACH_CPU_TYPES[arch] for arch in expected}, reason)
    return sorted(expected)


def api(resource):
    return json.loads(output(["gh", "api", f"repos/{resource}"]))


def verify_asset(release, identifier, name, size, sha):
    matches = [asset for asset in release["assets"] if asset["id"] == identifier]
    require(len(matches) == 1, f"Expected exactly one published asset {identifier}")
    asset = matches[0]
    require(
        (asset["name"], asset["size"], asset["digest"]) == (name, size, f"sha256:{sha}"),
        f"Published asset {identifier} differs from the fixed input",
    )
    return {key: asset[key] for key in ("id", "name", "size", "digest")}


def local_path(root, value):
    resolved = Path(value).resolve(strict=True)
    require(resolved.is_relative_to(root), "Recorded path leaves the isolated test scope")
    return resolved


def report(phase, value):
    print(json.dumps({"phase": phase, "evidence": value}, sort_keys=True), flush=True)


def command_json(base, env, command, *args, seconds=30):
    result = json.loads(output([*base, "--json", *args], env=env, seconds=seconds))
    require(result.get("ok") is True and result.get("command") == command, f"Unexpected {command} result")
    return result["data"]


def install_evidence(transcript, exit_status):
    """Retain only fixed identifiers from Preview.9's result and progress schemas."""
    evidence = {"command": "installation.run", "exit_status": exit_status, "last_progress_phase": None}
    if len(transcript) > 256 * 1024:
        return False, {**evidence, "reason": "cli_transcript_limit"}
    try:
        events = [json.loads(line) for line in transcript.splitlines() if line.strip()]
    except (UnicodeDecodeError, ValueError):
        return False, {**evidence, "reason": "invalid_cli_transcript"}
    if not events or not all(isinstance(event, dict) for event in events):
        return False, {**evidence, "reason": "invalid_cli_transcript"}
    saw_started = False
    for event in events[:-1]:
        if (event.get("schema_version"), event.get("operation"), event.get("target")) != (
            3, "install", {"kind": "port", "id": PORT},
        ):
            continue
        if event.get("type") == "started":
            saw_started = True
        if event.get("type") == "message" and event.get("level") == "info" and event.get("message") == f"Download checksum matches: {TUX_NAME}":
            evidence["selected_asset_checksum_verified"] = True
        if event.get("type") == "finished" and event.get("result") in ("failed", "cancelled", "succeeded"):
            evidence["operation_result"] = event["result"]
        if event.get("type") == "progress" and event.get("phase_id") == "download":
            evidence["last_progress_phase"] = "download"
            count = event.get("completed")
            if type(count) is int and 0 <= count <= 11843880:
                evidence["download_bytes_observed"] = count
    evidence["operation_started"] = saw_started
    result = events[-1]
    if (result.get("schema_version"), result.get("type"), result.get("command")) != (100, "result", "installation.run"):
        return False, {**evidence, "reason": "missing_install_result"}
    if exit_status == 0 and result.get("ok") is True and isinstance(result.get("data"), dict):
        return True, evidence
    error = result.get("error")
    code = CLI_ERROR_CODES.get(exit_status)
    if code is None or result.get("ok") is not False or not isinstance(error, dict) or error.get("code") != code:
        return False, {**evidence, "reason": "invalid_install_error"}
    evidence["code"] = code
    message = error.get("message")
    evidence["reason"] = INSTALL_ERROR_REASONS.get(message, "unclassified_cli_error") if isinstance(message, str) else "unclassified_cli_error"
    presentation = error.get("presentation")
    if isinstance(presentation, dict):
        state = presentation.get("mutation_state")
        if state in ("not_started", "no_changes", "committed", "recovery_required", "unknown"):
            evidence["mutation_state"] = state
        phase = presentation.get("phase")
        if phase in ("preparation.review", "preparation.copy", "preparation.extract", "preparation.setup",
                     "preparation.verify", "preparation.publish", "preparation.cleanup", "preparation.cleanup.review",
                     "preparation.interrupted"):
            evidence["failure_phase"] = phase
    return False, evidence


def install_reviewed(base, env, plan_sha256):
    with tempfile.TemporaryFile() as transcript:
        try:
            result = subprocess.run([
                *base, "--jsonl", "installation", "run", PORT, "--expected-plan", plan_sha256, "--yes",
            ], env=env, stdin=subprocess.DEVNULL, stdout=transcript, stderr=subprocess.DEVNULL, timeout=150)
        except subprocess.TimeoutExpired:
            report("install-failed", {"command": "installation.run", "reason": "command_deadline"})
            raise VerificationError("Reviewed installation exceeded its command deadline") from None
        transcript.seek(0)
        success, evidence = install_evidence(transcript.read(256 * 1024 + 1), result.returncode)
    report("install-result" if success else "install-failed", evidence)
    require(success, "Reviewed installation did not succeed")


def public_launch(session):
    return {key: session[key] for key in (
        "id", "port_id", "install_id", "owner_kind", "phase", "supervisor_pid", "child_pid",
        "started_at", "finished_at", "outcome", "exit_code",
    )}


class ProcBsdInfo(ctypes.Structure):
    """Darwin proc_bsdinfo layout, using the same fields as Core's launch identity."""

    _fields_ = [
        ("flags_status_and_pid", ctypes.c_uint32 * 4),
        ("parent_pid", ctypes.c_uint32),
        ("credentials", ctypes.c_uint32 * 7),
        ("command_and_name", ctypes.c_char * (16 + 32)),
        ("file_group_terminal_and_priority", ctypes.c_uint32 * 6),
        ("start_seconds", ctypes.c_uint64),
        ("start_microseconds", ctypes.c_uint64),
    ]


def owned_game_identity(pid, supervisor_pid, game, durable_identity):
    process = output([
        "/bin/ps", "-ww", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm=",
    ], seconds=5).strip().split(None, 6)
    require(len(process) == 7 and process[0] == str(supervisor_pid), "Managed child has a different native parent")
    executable = Path(process[6])
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    except OSError:
        libproc = None
    proc_pidpath = getattr(libproc, "proc_pidpath", None)
    if proc_pidpath is not None:
        proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc_pidpath.restype = ctypes.c_int
        path_buffer = ctypes.create_string_buffer(4096)
        require(proc_pidpath(pid, path_buffer, len(path_buffer)) > 0, "macOS did not resolve the native executable")
        executable = Path(os.fsdecode(path_buffer.value))
    require(executable.is_absolute() and executable.resolve(strict=True) == game,
            "macOS process does not match the absolute managed executable")
    proc_pidinfo = getattr(libproc, "proc_pidinfo", None)
    if proc_pidinfo is not None:
        proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        proc_pidinfo.restype = ctypes.c_int
        info = ProcBsdInfo()
        size = ctypes.sizeof(info)
        require(proc_pidinfo(pid, 3, 0, ctypes.byref(info), size) == size, "macOS did not resolve the native start time")
        birth = f"macos-start-time:{info.start_seconds}:{info.start_microseconds}"
        require(info.parent_pid == supervisor_pid and birth == durable_identity, "Native process differs from the recorded launch identity")
    return tuple(process[:6])


def supervised_play(base, env, active, game, cwd):
    request = str(uuid.uuid4())
    out = cwd / f"{request}.stdout"
    err = cwd / f"{request}.stderr"
    with out.open("x") as stdout, err.open("x") as stderr:
        supervisor = subprocess.Popen(
            [*base, "exec", PORT, "--request-id", request],
            env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
        )
        running = None
        identity = None

        def current_launch():
            return command_json(base, env, "launch.show", "launch", "show", request, seconds=5)

        def owned_before_signal():
            current = current_launch()
            if current is None or identity is None or supervisor.poll() is not None:
                return False
            return (
                all(current[key] == running[key] for key in (
                    "id", "install_id", "owner_kind", "supervisor_pid", "supervisor_identity", "child_pid", "child_identity",
                ))
                and current["phase"] == "running" and current["finished_at"] is None
                and owned_game_identity(running["child_pid"], supervisor.pid, game, running["child_identity"]) == identity
                and supervisor.poll() is None
            )

        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and supervisor.poll() is None:
                running = current_launch()
                if running and running["phase"] == "running" and running["finished_at"] is None:
                    break
                time.sleep(1)
            else:
                raise VerificationError("Released client did not record a live managed game")
            require(
                running["id"] == request and running["owner_kind"] == "managed"
                and running["port_id"] == PORT and running["install_id"] == active["id"]
                and running["supervisor_pid"] == supervisor.pid
                and Path(running["install_root"]).resolve() == Path(active["path"]).resolve(),
                "Recorded launch differs from the isolated managed selection",
            )
            child = running["child_pid"]
            require(isinstance(child, int) and child > 1 and running["child_identity"]
                    and running["supervisor_identity"], "Missing durable process identity")
            identity = owned_game_identity(child, supervisor.pid, game, running["child_identity"])
            report("running", public_launch(running))
            time.sleep(4)
            require(owned_before_signal(), "Native process identity changed before the requested stop")
            supervisor.send_signal(signal.SIGTERM)
            result = supervisor.wait(timeout=20)
            finished = current_launch()
            require(
                finished and finished["id"] == request and finished["child_pid"] == child
                and finished["child_identity"] == running["child_identity"]
                and finished["finished_at"] is not None and finished["outcome"] is not None,
                "Managed launch lacks a terminal receipt",
            )
            report("stopped", {"controller_signal": "SIGTERM", "supervisor_exit": result, "request": public_launch(finished)})
            still_running = subprocess.run(["/bin/ps", "-p", str(child), "-o", "pid="], capture_output=True, timeout=5)
            require(still_running.returncode == 1 and not still_running.stdout.strip(), "Managed child did not positively exit")
            require(result == 0 and finished["outcome"] == "succeeded", "Requested stop did not produce a clean game exit")
            return request
        finally:
            if supervisor.poll() is None:
                try:
                    safe_to_stop = owned_before_signal()
                except (VerificationError, OSError, ValueError):
                    safe_to_stop = False
                if safe_to_stop:
                    supervisor.send_signal(signal.SIGINT)
                    try:
                        supervisor.wait(timeout=12)
                    except subprocess.TimeoutExpired:
                        pass
                if supervisor.poll() is None:
                    report("cleanup-incomplete", {"request": request, "supervisor_pid": supervisor.pid})
            for label, file in (("stdout", out), ("stderr", err)):
                report(f"game-{label}", {"bytes": file.stat().st_size, "sha256": digest(file)})


def main():
    runner = os.environ.get("MACOS_RUNNER")
    require(platform.system() == "Darwin" and runner in CLIENTS, "Expected the admitted hosted macOS runner")
    arch, target, asset_id, archive_size, archive_sha, executable_sha = CLIENTS[runner]
    require(platform.machine() == arch, "Runner architecture differs from its reviewed asset")
    platform_id = f"macos-{'x86-64' if arch == 'x86_64' else 'aarch64'}"
    report("runner", {"runner": runner, "architecture": arch, "macos": output(["sw_vers"]).strip()})

    archive_name = f"portcove-cli-0.1.0-preview.9-macos-{target}.tar.gz"
    client_release = api(f"boburning/portcove/releases/tags/{CLIENT_TAG}")
    require(
        client_release["id"] == 451546466 and client_release["tag_name"] == CLIENT_TAG
        and client_release["target_commitish"] == CLIENT_SOURCE and client_release["draft"] is False,
        "Frozen Portcove publication differs",
    )
    report("client-release", {"source": CLIENT_SOURCE, **verify_asset(client_release, asset_id, archive_name, archive_size, archive_sha)})
    tux = api("labbej27/tuxracer/releases/latest")
    require(
        tux["id"] == 441626947 and tux["tag_name"] == TUX_TAG and not tux["draft"] and not tux["prerelease"]
        and api("labbej27/tuxracer")["id"] == 1453913628
        and api(f"labbej27/tuxracer/commits/{TUX_TAG}")["sha"] == TUX_SOURCE,
        "Current official Tux Racer source or release differs",
    )
    report("game-release", {"source": TUX_SOURCE, **verify_asset(tux, 735473279, TUX_NAME, 11843880, TUX_DIGEST)})

    workspace = Path(tempfile.mkdtemp(prefix="portcove-tux-", dir=os.environ["RUNNER_TEMP"])).resolve()
    home, library = workspace / "home", workspace / "library"
    profile = home / ".tuxracer"
    profile.mkdir(parents=True)
    preferences = workspace / "preferences.json"
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "HOME": str(home),
        "TMPDIR": str(workspace), "PORTCOVE_PREFERENCES": str(preferences),
    }
    archive = workspace / archive_name
    url = f"https://github.com/boburning/portcove/releases/download/{CLIENT_TAG}/{archive_name}"
    output(["curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--max-time", "90",
            "--max-filesize", str(archive_size), "--output", str(archive), url], seconds=95)
    require(archive.stat().st_size == archive_size and digest(archive) == archive_sha, "Mac CLI archive digest differs")
    cli = workspace / "portcove"
    with tarfile.open(archive, "r:gz") as payload:
        members = payload.getmembers()
        require(len(members) == 1 and members[0].name == "portcove" and members[0].isfile()
                and 0 < members[0].size <= 120 * 1024 ** 2, "Unexpected Mac CLI archive members")
        with payload.extractfile(members[0]) as binary, cli.open("xb") as target_file:
            shutil.copyfileobj(binary, target_file)
    require(digest(cli) == executable_sha, "Extracted Mac CLI bytes differ")
    cli.chmod(0o700)
    architectures = verify_macho_executable(cli, [arch], "Published Portcove CLI")
    report("client-executable", {"architectures": architectures, "sha256": executable_sha})
    base = [str(cli), "--library", str(library), "--non-interactive"]
    read = lambda command, *args, **kwargs: command_json(base, env, command, *args, **kwargs)
    require(read("about", "about")["version"] == "0.1.0-preview.9", "Released CLI About version differs")
    report("client-about", {"sha256": executable_sha, "version": "0.1.0-preview.9"})
    require(read("status", "status", PORT)["active"] is None, "Isolated scope already contains an installation")
    proposal = read("installation.plan", "installation", "plan", PORT)
    reviewed = proposal["plan"]
    selected = reviewed["release"]
    asset = selected["asset"]
    require(
        reviewed["port_id"] == PORT and reviewed["platform"] == platform_id and reviewed["channel"] == "stable"
        and not reviewed["source_requirements"] and proposal["selected_install"] is None
        and selected["version"] == TUX_TAG
        and asset == {"name": TUX_NAME, "size": 11843880, "sha256": TUX_DIGEST, "url": TUX_URL}
        and re.fullmatch("[a-f0-9]{64}", proposal["plan_sha256"]),
        "Released resolver selected a different managed artifact or source scope",
    )
    report("plan", {"platform": platform_id, "plan_sha256": proposal["plan_sha256"],
                    "version": TUX_TAG, "asset_sha256": TUX_DIGEST})
    install_reviewed(base, env, proposal["plan_sha256"])
    active = read("status", "status", PORT)["active"]
    require(active and active["version"] == TUX_TAG and active["artifact"] == {
        "asset_name": TUX_NAME, "size": 11843880, "sha256": TUX_DIGEST,
    }, "Installed receipt differs from the reviewed artifact")
    runtime = local_path(library.resolve(), active["path"])
    game = local_path(runtime, runtime / TUX_EXE)
    course = local_path(runtime, runtime / TUX_COURSE)
    require(digest(game) == TUX_EXE_DIGEST and digest(course) == TUX_COURSE_DIGEST,
            "Installed executable or included course differs")
    architectures = verify_macho_executable(game, MACH_CPU_TYPES, "Installed Tux Racer")
    report("installed", {"install_id": active["id"], "manifest": active["manifest_sha256"],
                         "game_sha256": TUX_EXE_DIGEST, "course_sha256": TUX_COURSE_DIGEST,
                         "game_architectures": architectures})

    first = supervised_play(base, env, active, game, workspace)
    profile_probe = profile / "portcove-verification-marker.txt"
    with profile_probe.open("x", encoding="utf-8") as marker:
        marker.write("Fixture marker for the external profile\n")
    profile_sha = digest(profile_probe)
    capture = game.parent / "tux_sshot_991.ppm"
    with capture.open("xb") as local_data:
        local_data.write(b"P6\n1 1\n255\n\x00\x00\x00")
    capture_sha = digest(capture)
    second = supervised_play(base, env, active, game, workspace)
    reopened = read("status", "status", PORT)
    require(reopened["active"] == active and reopened["successful_launches"] == 2, "Reopened client did not retain the exact install and launch history")
    checked = read("verify", "verify", PORT)
    require(checked["install_id"] == active["id"] and checked["valid"] is True, "Reopened manifest verification failed")
    require(digest(profile_probe) == profile_sha and digest(capture) == capture_sha, "Reopen changed isolated persistence bytes")
    backup = read("backup.create", "backup", "create", PORT)
    backup_path = local_path(library.resolve(), backup["path"])
    backup_manifest = json.loads((backup_path / "backup.json").read_text(encoding="utf-8"))
    require(backup_manifest["id"] == backup["id"] and backup_manifest["sha256"] == backup["sha256"], "Managed backup manifest differs")
    require(digest(backup_path / "data" / capture.name) == capture_sha, "Backup lacks the exact managed capture marker")
    require(next(backup_path.rglob(profile_probe.name), None) is None, "Managed backup included the separate external profile")
    options = profile / "options"
    receipt = {
        "port_id": PORT, "install_id": active["id"], "request_ids": [first, second],
        "verified_files": checked["checked_files"], "managed_capture_marker_sha256": capture_sha,
        "managed_capture_marker_path": str(capture.relative_to(runtime)),
        "external_profile_marker_sha256": profile_sha,
        "managed_backup_id": backup["id"], "managed_backup_sha256": backup["sha256"],
        "external_profile_marker_in_backup": False, "gameplay": "unobserved", "adapter": "published-cli",
    }
    if options.is_file():
        receipt["game_options_sha256"] = digest(local_path(profile, options))
    report("passed", receipt)


if __name__ == "__main__":
    try:
        main()
    except VerificationError as error:
        report("failed", {"reason": str(error)})
        raise SystemExit(1) from None
    except Exception as error:
        report("failed", {"error_type": type(error).__name__})
        raise SystemExit(1) from None
