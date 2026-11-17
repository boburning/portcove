"""Disposable native source-build probe; no GUI or gameplay claim."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess


def run(*args, timeout=180):
    print("RUN", json.dumps(args), flush=True)
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=timeout)
    print(p.stdout, flush=True)
    p.check_returncode()
    return p.stdout.strip()


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


root = Path(os.environ["RUNNER_TEMP"]) / "sdl3-source-probe-owned"
root.mkdir()  # Never reuse another attempt's inputs or outputs.
print(json.dumps({"controller": os.environ["GITHUB_SHA"],
                  "run": os.environ["GITHUB_RUN_ID"],
                  "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                  "machine": platform.machine(), "os": platform.platform(),
                  "image": os.environ.get("ImageVersion"),
                  "scope": "native source build only; no player execution"}), flush=True)
run("sw_vers")
run("clang", "--version")
run("cmake", "--version")
sdk_image = root / "SDL3-3.4.2.dmg"
run("curl", "--fail", "--location", "--max-time", "120", "--max-filesize", "30000000",
    "--output", str(sdk_image),
    "https://github.com/libsdl-org/SDL/releases/download/release-3.4.2/SDL3-3.4.2.dmg")
if digest(sdk_image) != "383da24667fcd5216b78ace9adf63b795b980e877911272fb0a615755869d87b":
    raise RuntimeError("SDL3 differs from publisher digest")
mount, sdk = root / "sdk-mount", root / "sdk"
sdk.mkdir()
run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(sdk_image))
try:
    run("ditto", str(mount / "SDL3.xcframework/macos-arm64_x86_64/SDL3.framework"),
        str(sdk / "SDL3.framework"))
finally:
    run("hdiutil", "detach", str(mount))
run("lipo", "-archs", str(sdk / "SDL3.framework/SDL3"))
results = []
for source, commit, subdir, target, option in [
    ("street", "0e5598e4fb45735b7c611a41b3595c91f16c3fa8", "srport", "srport", "SR_LAUNCHER"),
    ("jetstrike", "5f3017dd7bd8c054fb010153e2983893bb471c67", "jsport", "jsport", "JS_LAUNCHER"),
]:
    if run("git", "-C", source, "rev-parse", "HEAD") != commit:
        raise RuntimeError("Source differs")
    if run("git", "-C", source, "status", "--porcelain"):
        raise RuntimeError("Upstream source is dirty")
    build = root / (source + "-build")
    run("cmake", "-S", str(Path(source).resolve() / subdir), "-B", str(build),
        "-DCMAKE_BUILD_TYPE=Release", "-D" + option + "=OFF",
        "-DSDL3_DIR=" + str(sdk / "SDL3.framework/Resources/CMake"),
        "-DCMAKE_BUILD_RPATH=" + str(sdk))
    run("cmake", "--build", str(build), "--target", target, "--parallel", "2", timeout=600)
    binary = build / target
    machine = run("file", str(binary))
    archs = run("lipo", "-archs", str(binary)).split()
    if archs != [platform.machine()]:
        raise RuntimeError("Output is not native to this host")
    deps = run("otool", "-L", str(binary))
    results.append({"source": source, "commit": commit, "binary_sha256": digest(binary),
                    "machine": machine, "dependencies": deps, "scope": "source build only"})
    if run("git", "-C", source, "status", "--porcelain"):
        raise RuntimeError("Build changed upstream source")
print("SOURCE_PROBE_RESULT " + json.dumps(results), flush=True)
