#!/usr/bin/env python3
"""Fixed public client/runtime, publisher-listed originals, and an isolated native macOS library."""

from importlib import import_module
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import time
import zipfile


# Reuse the released Mac CLI verifier and managed-process identity checks.
mac = import_module("verify-macos-tux-lifecycle")

PORT = "bio-menace-reflectionhle"
GAME_REPOSITORY = "ReflectionHLE/ReflectionHLE"
GAME_SOURCE = "74f07efcc40142a5727caacebec848c48b141eca"
GAME_TAG = "release-20260606"
GAME_ASSET = "reflectionhle-macos-universal2-20260606.tar.xz"
GAME_SIZE = 4800280
GAME_DIGEST = "4169e031f3bce2712cc5d89b15af4697b2add8f371107db3e0dcfdb2e207e24e"
GAME_URL = f"https://github.com/{GAME_REPOSITORY}/releases/download/{GAME_TAG}/{GAME_ASSET}"
GAME_BINARY = Path("reflectionhle.app/Contents/MacOS/reflectionhle")
GAME_BINARY_DIGEST = "d03c2e5240aa8eb1b7e31ce08468a00096393217d533e28a387a425b4c254a6d"

# #2692 pins the complete publisher-listed Freeware v1.1 archive. Extract only
# the Episode 1 inputs expected by the exact version's upstream game definition.
FREEWARE_URL = "https://ftp.idtech.space/3drealms/freeware/bmfreew.zip"
FREEWARE_SIZE = 1624021
FREEWARE_DIGEST = "09a889331ef0bb259dd9b60ce58033fed8d2eef94d1ff21474c6a53c2fe86d6d"
EPISODE = "bm1v11f"
ORIGINALS = {
    "AUDIOHED.BM1": (580, 0x84DFC7B8),
    "AUDIOT.BM1": (205754, 0x920E8FAF),
    "BMENACE1.EXE": (90046, 0xD81D1F1F),
    "EGADICT.BM1": (1024, 0x629503DF),
    "EGAGRAPH.BM1": (501816, 0x2454D561),
    "EGAHEAD.BM1": (13866, 0x77C23274),
    "FILE_ID.DIZ": (442, 0xEF56DBBC),
    "MAPHEAD.BM1": (22200, 0xB8EDEDC7),
    "MAPTEMP.BM1": (165402, 0x2AEA356C),
}
SOURCE_REFERENCE = f"{EPISODE}.txt"
# A deliberately synthetic marker in the declared persistence folder. It is
# not an episode save and is never interpreted or passed as input to the game.
MARKER = Path(EPISODE) / "portcove-verification-marker.txt"
MARKER_BYTES = b"Portcove isolated Bio Menace persistence witness\n"


def verify_game_release():
    release = mac.api(f"{GAME_REPOSITORY}/releases/tags/{GAME_TAG}")
    mac.require(
        release["id"] == 335468586 and release["tag_name"] == GAME_TAG
        and release["draft"] is False and release["prerelease"] is False
        and mac.api(GAME_REPOSITORY)["id"] == 24228275
        and mac.api(f"{GAME_REPOSITORY}/commits/{GAME_TAG}")["sha"] == GAME_SOURCE,
        "Official ReflectionHLE release/source identity differs",
    )
    mac.report("game-release", {
        "source": GAME_SOURCE,
        **mac.verify_asset(release, 440437160, GAME_ASSET, GAME_SIZE, GAME_DIGEST),
    })


def prepare_originals(workspace, home, env):
    archive = workspace / "bmfreew.zip"
    mac.output([
        "/usr/bin/curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https",
        "--max-time", "45", "--max-filesize", str(FREEWARE_SIZE), "--output", str(archive), FREEWARE_URL,
    ], seconds=50, env=env)
    mac.require(archive.stat().st_size == FREEWARE_SIZE and mac.digest(archive) == FREEWARE_DIGEST,
                "Publisher freeware archive bytes differ from #2692")
    originals = home / "bio-menace-originals"
    originals.mkdir(mode=0o700)
    with zipfile.ZipFile(archive) as payload:
        entries = {entry.filename: entry for entry in payload.infolist()}
        mac.require(len(entries) == 38 and len(payload.infolist()) == len(entries),
                    "Publisher archive entry count differs")
        for name, signature in ORIGINALS.items():
            entry = entries[name]
            mac.require(not entry.is_dir() and (entry.file_size, entry.CRC) == signature,
                        "Episode 1 input differs from the reviewed upstream game definition")
            contents = payload.read(entry)  # zipfile checks the streamed CRC.
            with (originals / name).open("xb") as destination:
                destination.write(contents)
    archive.unlink()
    digests = {name: mac.digest(originals / name) for name in ORIGINALS}
    mac.report("publisher-freeware", {
        "receipt_issue": 2692, "sha256": FREEWARE_DIGEST, "archive_bytes": FREEWARE_SIZE,
        "episode": EPISODE, "local_files": len(digests), "storage": "isolated-runner-home",
    })
    return originals, digests


def request_normal_quit(helper, env, stage, pid, game, assert_owner):
    def control(action):
        return subprocess.run(
            [str(helper), action, str(pid), str(game)], env=env,
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5,
        )

    # NSRunningApplication registration and an on-screen layer-zero game window
    # are independent of the CLI's durable 'running' process receipt.
    deadline = time.monotonic() + 24
    while time.monotonic() < deadline:
        mac.require(assert_owner(), "Managed process identity changed while waiting for the native window")
        probe = control("window")
        if probe.returncode == 0:
            break
        mac.require(probe.returncode in (2, 3), "Could not inspect the owned macOS process or window")
        time.sleep(1)
    else:
        raise mac.VerificationError("Managed process lacked an observed on-screen macOS window")
    windows = int(probe.stdout.strip())
    mac.report("native-window", {"stage": stage, "owner_pid": pid, "visible_windows": windows})
    mac.require(assert_owner(), "Managed process identity changed before normal Cocoa quit")
    quit_request = control("quit")
    mac.require(quit_request.returncode == 0, "The app did not accept an addressed Cocoa quit request")
    return {"stage": stage, "quit_method": "NSRunningApplication.terminate", "native_windows": windows}


def main(workspace):
    runner = os.environ.get("MACOS_RUNNER")
    mac.require(platform.system() == "Darwin" and runner in mac.CLIENTS, "Expected an admitted macOS runner")
    arch, *client = mac.CLIENTS[runner]
    mac.require(platform.machine() == arch, "Runner architecture differs from its frozen client")
    platform_id = f"macos-{'x86-64' if arch == 'x86_64' else 'aarch64'}"
    mac.report("runner", {"runner": runner, "architecture": arch, "macos": mac.output(["/usr/bin/sw_vers"]).strip()})

    home, library = workspace / "home", workspace / "library"
    home.mkdir(mode=0o700)
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8", "HOME": str(home),
        "TMPDIR": str(workspace), "PORTCOVE_PREFERENCES": str(workspace / "preferences.json"),
    }
    base = mac.released_cli(workspace, env, arch, *client)
    verify_game_release()
    helper = workspace / "owned-app"
    mac.output([
        "/usr/bin/xcrun", "swiftc", "-module-cache-path", str(workspace / "swift-modules"),
        str(Path(__file__).with_name("verify-macos-owned-app.swift").resolve()), "-o", str(helper),
    ], seconds=75, env=env)

    def read(command, *args, **kwargs):
        return mac.command_json(base, env, command, *args, **kwargs)

    def install():
        mac.require(read("status", "status", PORT)["active"] is None, "Expected an empty active install slot")
        proposal = read("installation.plan", "installation", "plan", PORT)
        plan = proposal["plan"]
        selected = plan["release"]
        mac.require(
            plan["port_id"] == PORT and plan["platform"] == platform_id and plan["channel"] == "stable"
            and not plan["source_requirements"] and proposal["selected_install"] is None
            and selected["version"] == GAME_TAG and selected["asset"] == {
                "name": GAME_ASSET, "size": GAME_SIZE, "sha256": GAME_DIGEST, "url": GAME_URL,
            } and re.fullmatch("[a-f0-9]{64}", proposal["plan_sha256"]),
            "Released resolver selected a different artifact or source scope",
        )
        mac.report("plan", {"platform": platform_id, "plan_sha256": proposal["plan_sha256"],
                            "version": GAME_TAG, "asset_sha256": GAME_DIGEST})
        mac.install_reviewed(base, env, proposal["plan_sha256"], PORT, GAME_ASSET, GAME_SIZE)
        active = read("status", "status", PORT)["active"]
        mac.require(active and active["version"] == GAME_TAG and active["artifact"] == {
            "asset_name": GAME_ASSET, "size": GAME_SIZE, "sha256": GAME_DIGEST,
        }, "Installed artifact differs from the reviewed release")
        runtime = mac.local_path(library, active["path"])
        game = mac.local_path(runtime, runtime / GAME_BINARY)
        mac.require(mac.digest(game) == GAME_BINARY_DIGEST, "Installed ReflectionHLE executable bytes differ")
        architectures = mac.verify_macho_executable(game, mac.MACH_CPU_TYPES, "Installed ReflectionHLE")
        checked = read("verify", "verify", PORT)
        mac.require(checked["install_id"] == active["id"] and checked["valid"] is True
                    and checked["checked_files"] > 0, "Installed package verification failed")
        mac.report("installed", {"install_id": active["id"], "manifest_sha256": active["manifest_sha256"],
                                 "game_sha256": GAME_BINARY_DIGEST, "game_architectures": architectures,
                                 "verified_files": checked["checked_files"]})
        return active, runtime, game

    receipts = []

    def play(active, game, stage, *game_args):
        receipt = mac.supervised_play(
            base, env, active, game, workspace, port=PORT, game_args=game_args,
            normal_quit=lambda pid, executable, owner: request_normal_quit(
                helper, env, stage, pid, executable, owner,
            ),
        )
        receipts.append(receipt)

    active, runtime, game = install()
    play(active, game, "upstream-launcher")
    originals, source_digests = prepare_originals(workspace, home, env)

    # Exact format emitted by the upstream picker, bound to the isolated HOME.
    # A later launch uses the published client's ordinary caller arguments to
    # select this edition. No picker automation is used.
    reference = runtime / SOURCE_REFERENCE
    source_ref = f"home {originals.name}\n".encode("ascii")
    with reference.open("xb") as handle:
        handle.write(source_ref)
    marker = runtime / MARKER
    marker.parent.mkdir(exist_ok=True)
    with marker.open("xb") as handle:
        handle.write(MARKER_BYTES)
    play(active, game, "episode-1-startup", "-gamever", EPISODE)
    reopened = read("status", "status", PORT)
    mac.require(reopened["active"] == active and reopened["successful_launches"] == 2,
                "Reopened client did not retain the exact install and launch history")

    user = mac.local_path(library, library / "user" / PORT)
    backup = read("backup.create", "backup", "create", PORT)
    backup_path = mac.local_path(library, backup["path"])
    manifest = json.loads((backup_path / "backup.json").read_text(encoding="utf-8"))
    mac.require(manifest["id"] == backup["id"] and manifest["sha256"] == backup["sha256"],
                "Managed backup manifest differs")
    backup_marker = backup_path / "data" / MARKER
    mac.require(backup_marker.read_bytes() == MARKER_BYTES
                and (backup_path / "data" / SOURCE_REFERENCE).read_bytes() == source_ref,
                "Backup lacks the declared marker or source-location reference")
    mac.require(all(next(backup_path.rglob(name), None) is None for name in ORIGINALS),
                "Backup copied the original DOS content")
    for destination in (marker, user / MARKER):
        mac.require(mac.local_path(user if destination != marker else runtime, destination).read_bytes()
                    == MARKER_BYTES, "Canonical and runtime persistence did not converge")
        destination.write_bytes(b"New isolated probe, superseded by explicit restore\n")
    restored = read("backup.restore", "backup", "restore", PORT, backup["id"], "--yes")
    mac.require(restored["restored_backup"]["id"] == backup["id"] and restored["safety_backup"] is not None
                and (user / MARKER).read_bytes() == MARKER_BYTES,
                "Managed restore did not publish the exact backup and appropriate safety copy")
    play(active, game, "restored-episode-1-startup", "-gamever", EPISODE)
    mac.require(marker.read_bytes() == MARKER_BYTES, "Ordinary launch did not rehydrate restored bytes")
    mac.report("managed-restore", {"backup_id": backup["id"], "backup_sha256": backup["sha256"],
                                   "marker_sha256": mac.digest(backup_marker), "source_files_in_backup": False,
                                   "safety_backup_id": restored["safety_backup"]["id"]})

    preview = read("remove.preview", "remove-preview", PORT)
    mac.require(
        preview["port_id"] == PORT and [Path(path).resolve() for path in preview["managed_paths"]] == [runtime]
        and Path(preview["persistent_data_path"]).resolve() == user and preview["persistent_data_will_be_preserved"]
        and preview.get("unknown_file_count", 0) == 0 and re.fullmatch("[a-f0-9]{64}", preview["preview_sha256"]),
        "Removal preview did not match the one isolated runtime and preserved native data",
    )
    removed = read("remove", "remove", PORT, "--expected-preview", preview["preview_sha256"], "--yes")
    mac.require(len(removed["removed"]) == 1 and not runtime.exists()
                and (user / MARKER).read_bytes() == MARKER_BYTES
                and (user / SOURCE_REFERENCE).read_bytes() == source_ref,
                "Reviewed managed removal did not preserve canonical data")
    replacement, runtime, game = install()
    play(replacement, game, "reinstalled-episode-1-startup", "-gamever", EPISODE)
    mac.require((runtime / MARKER).read_bytes() == MARKER_BYTES
                and (runtime / SOURCE_REFERENCE).read_bytes() == source_ref
                and {name: mac.digest(originals / name) for name in ORIGINALS} == source_digests,
                "Reinstalled package did not recover the persisted witness and unmodified originals")
    mac.report("passed", {
        "port_id": PORT, "requests": receipts, "initial_install": active["id"],
        "recovered_install": replacement["id"], "recovery": "reviewed-removal-and-exact-reinstall",
        "observed": "native launcher and direct Episode 1 startup, normal Cocoa quit",
        "source_picker": "unobserved", "gameplay_and_real_save": "unobserved",
        "interrupted-install-recovery": "unobserved",
    })


if __name__ == "__main__":
    try:
        with tempfile.TemporaryDirectory(prefix="portcove-bio-menace-", dir=os.environ["RUNNER_TEMP"]) as workspace:
            main(Path(workspace).resolve())
    except mac.VerificationError as error:
        mac.report("failed", {"reason": str(error)})
        raise SystemExit(1) from None
    except Exception as error:
        mac.report("failed", {"error_type": type(error).__name__})
        raise SystemExit(1) from None
