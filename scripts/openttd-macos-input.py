"""Fixed publisher packages for a fresh, non-owning Mac qualification copy."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import urllib.request
import zipfile

evidence = Path("evidence/desktop-verify/openttd-macos/native")
evidence.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix="portcove-openttd-mac-", dir=Path(os.environ["RUNNER_TEMP"]).resolve()))
inputs = root / "inputs"
inputs.mkdir()
records = []
for name, url, digest, size in [
    ("player", "https://cdn.openttd.org/openttd-releases/15.3/openttd-15.3-macos-universal.zip", "c2ac22ab3ac9ac1e82a8d9029b7e4ab069e425904420076605d860e64460f579", 15540074),
    ("graphics", "https://cdn.openttd.org/opengfx-releases/8.0/opengfx-8.0-all.zip", "43a0c1dabf39cb865394f3a6cc36d4da5c10ecfaaf55652043104806810903be", 3583152),
]:
    archive = inputs / (name + ".zip")
    with urllib.request.urlopen(url, timeout=90) as response, archive.open("xb") as out:
        total = 0
        while chunk := response.read(65536):
            total += len(chunk)
            assert total <= size, "Publisher response exceeds reviewed size"
            out.write(chunk)
    assert archive.stat().st_size == size
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest
    target = inputs / name
    target.mkdir()
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        assert len(entries) < 5000 and sum(e.file_size for e in entries) < 150000000
        seen = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            assert not path.is_absolute() and ".." not in path.parts
            assert "\\" not in entry.filename and ":" not in entry.filename
            assert not (entry.flag_bits & 1) and not stat.S_ISLNK(mode)
            assert entry.file_size < 64000000 and entry.filename.casefold() not in seen
            seen.add(entry.filename.casefold())
            if name == "player":
                assert path.parts[0] == "OpenTTD.app"
            if entry.is_dir():
                (target / path).mkdir(parents=True, exist_ok=True)
                continue
            destination = target / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            with z.open(entry) as src, destination.open("xb") as dst:
                shutil.copyfileobj(src, dst, length=65536)
            destination.chmod((mode & 0o777) or 0o644)
        if name == "graphics":
            assert z.namelist() == ["opengfx-8.0.tar"]
    records.append({"name": name, "url": url, "publisher_sha256": digest, "bytes": size})
player = inputs / "player/OpenTTD.app/Contents/MacOS/openttd"
assert hashlib.sha256(player.read_bytes()).hexdigest() == "591d1eefb15f3d7a31bd893df8c12eb5f0422e8123d3a9c0b8cb875ca0cf2ccf"
assert player.stat().st_mode & stat.S_IXUSR
cli = (Path("product/target/debug/portcove")).resolve(strict=True)
report = {"archives": records, "root": str(root), "player": str(player), "player_sha256": hashlib.sha256(player.read_bytes()).hexdigest(), "cli": str(cli), "cli_sha256": hashlib.sha256(cli.read_bytes()).hexdigest(), "product_source": "27b0a6e994545e622d67b3bea016d32665224192", "controller_source": os.environ["GITHUB_SHA"], "run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "scope": "Official universal Mac player and free OpenGFX; no retail originals, save upload, signing or runtime injection"}
Path("openttd-macos-input.json").write_text(json.dumps(report, indent=2))
(evidence / "inputs.json").write_text(json.dumps(report, indent=2))
