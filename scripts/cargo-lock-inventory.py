"""Complete, inert Cargo.lock parsing for the existing dependency policy check."""
import json
import re
import sys
import tomllib


def inventory(text):
    document = tomllib.loads(text)
    if document.get("version") != 4 or set(document) - {"version", "package"}:
        raise ValueError("unsupported Cargo lock schema")
    packages = document.get("package")
    if not isinstance(packages, list) or len(packages) > 4096:
        raise ValueError("invalid or oversized Cargo inventory")
    seen = set()
    for package in packages:
        if not isinstance(package, dict) or set(package) - {
            "name", "version", "source", "checksum", "dependencies", "replace"
        }:
            raise ValueError("unsupported Cargo package record")
        name, version = package.get("name"), package.get("version")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError("invalid Cargo package name")
        if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?", version):
            raise ValueError("invalid Cargo package version")
        source = package.get("source")
        if source is not None and not isinstance(source, str):
            raise ValueError("invalid Cargo source")
        key = (name, version, source)
        if key in seen:
            raise ValueError("duplicate Cargo package identity")
        seen.add(key)
        if source == "registry+https://github.com/rust-lang/crates.io-index":
            checksum = package.get("checksum")
            if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
                raise ValueError("registry Cargo package lacks SHA256")
        dependencies = package.get("dependencies", [])
        if not isinstance(dependencies, list) or not all(isinstance(x, str) for x in dependencies):
            raise ValueError("invalid Cargo dependencies")
    return packages


if __name__ == "__main__":
    raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("Cargo lock exceeds byte bound")
    print(json.dumps(inventory(raw.decode("utf-8")), sort_keys=True))
