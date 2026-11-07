import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from pathlib import Path

# Archived crates.io index digests. The mirrors supply bytes, never versions or checksums.
CHECKSUMS = {
    "rscheck-cli": "a1e9a501a1889fb90c85a3f40feebdb38d3f221f3a85e46cfaad2b9cccb5f8ea",
    "rscheck": "002b60f004324f6ee5eaba36e76ec27e9dc0d16220a114aac5f927b27015f889",
    "rscheck-semantic": "065d827fed17d5409e3eae5d7209078d3920e2f4204ad046c8c96a6c84530fae",
}
INDEX = "registry+https://github.com/rust-lang/crates.io-index"


def checked_source(work, name, version, checksum):
    package = f"{name}-{version}"
    archive = work / f"{package}.crate"
    urls = (
        f"https://rsproxy.cn/api/v1/crates/{name}/{version}/download",
        f"https://mirror.sjtu.edu.cn/crates.io/crates/{name}/{package}.crate",
    )
    for url in urls:
        result = subprocess.run(
            [
                "curl",
                "--disable",
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-redirs",
                "2",
                "--connect-timeout",
                "8",
                "--max-time",
                "20",
                "--max-filesize",
                "131072",
                "--output",
                str(archive),
                url,
            ],
            check=False,
        )
        if result.returncode == 0:
            break
        archive.unlink(missing_ok=True)
    else:
        raise RuntimeError(f"No pinned archived crate origin responded: {name}")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise ValueError(f"Archived crate checksum differs: {name}")
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        paths = {Path(member.name) for member in members}
        if len(members) != len(paths) or len(members) > 1000:
            raise ValueError(f"Invalid archived crate inventory: {name}")
        if any(not path.is_relative_to(package) or ".." in path.parts for path in paths):
            raise ValueError(f"Archived crate path escapes its package: {name}")
        if any(not (member.isfile() or member.isdir()) for member in members):
            raise ValueError(f"Archived crate contains a special entry: {name}")
        if sum(member.size for member in members) > 8 * 1024 * 1024:
            raise ValueError(f"Expanded archived crate exceeds limit: {name}")
        source.extractall(work, members=members, filter="data")
    return work / package


def project_lock(lockfile, version):
    original = lockfile.read_text(encoding="utf-8")
    projected = original
    expected = tomllib.loads(original)
    for name in ("rscheck", "rscheck-semantic"):
        fields = f'name = "{name}"\nversion = "{version}"\nsource = "{INDEX}"\nchecksum = "{CHECKSUMS[name]}"\n'
        if projected.count(fields) != 1:
            raise ValueError(f"Original locked registry identity differs: {name}")
        projected = projected.replace(fields, f'name = "{name}"\nversion = "{version}"\n')
        [entry] = [entry for entry in expected["package"] if entry["name"] == name]
        del entry["source"]
        del entry["checksum"]
    if tomllib.loads(projected) != expected:
        raise ValueError("Projected Cargo lock changed an unrelated identity")
    lockfile.write_text(projected, encoding="utf-8", newline="\n")


def main():
    manifest, destination = map(Path, sys.argv[1:])
    [tool] = [tool for tool in json.loads(manifest.read_text())["tools"] if tool["id"] == "rscheck-cli"]
    version = tool["version"]
    rust = tomllib.loads((manifest.parent.parent / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    if tool["crate"] != "rscheck-cli" or version != "0.1.0":
        raise ValueError("Archived source custody applies only to the removed rscheck 0.1.0 family")
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("Install destination must be new")
    with tempfile.TemporaryDirectory(prefix=".rscheck-stage-", dir=destination.parent) as stage:
        staged = Path(stage) / "install"
        with tempfile.TemporaryDirectory(prefix="portcove-rscheck-") as temporary:
            work = Path(temporary)
            paths = {name: checked_source(work, name, version, checksum) for name, checksum in CHECKSUMS.items()}
            cli = paths["rscheck-cli"]
            project_lock(cli / "Cargo.lock", version)
            config = work / "recovery.toml"
            config.write_text(
                "[patch.crates-io]\n"
                + "".join(
                    f"{name} = {{ path = {json.dumps(str(paths[name]))} }}\n"
                    for name in ("rscheck", "rscheck-semantic")
                ),
                encoding="utf-8",
            )
            subprocess.run(
                [
                    "cargo",
                    f"+{rust}",
                    "--config",
                    str(config),
                    "install",
                    "--locked",
                    "--path",
                    str(cli),
                    "--root",
                    str(staged),
                ],
                cwd=work,
                check=True,
            )
        suffix = ".exe" if os.name == "nt" else ""
        for name in ("rscheck", "cargo-rscheck"):
            result = subprocess.check_output(
                [str(staged / "bin" / f"{name}{suffix}"), "--version"],
                text=True,
            ).strip()
            if result != f"rscheck {version}":
                raise ValueError(f"Unexpected installed {name} identity")
            print(f"{name}: {result}", flush=True)

        if destination.exists():
            raise ValueError("Install destination appeared during staging")
        staged.rename(destination)


if __name__ == "__main__":
    main()
