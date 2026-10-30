"""Retain one official signed Ubuntu cloud image; never boot or inspect QCOW here."""

import datetime
import hashlib
import json
import os
import re
import resource
import stat
import subprocess
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

from common import hosted_context

root = hosted_context()[1]
base = "https://cloud-images.ubuntu.com/releases/resolute/release-20261016/"
name = "ubuntu-26.04-server-cloudimg-amd64.img"
output = root / "image"
assert not output.exists() and not root.is_symlink() and os.geteuid() != 0
output.mkdir(mode=0o700)
home = output / "gnupg"
home.mkdir(mode=0o700)
tools = json.loads((root / "keyring-package-receipt.json").read_bytes())
assert tools["phase"] == "installed-keyring-package-retained"
package = next(row for row in tools["packages"] if row["Package"] == "ubuntu-keyring")
keyring = Path(package["extracted"]) / "usr/share/keyrings/ubuntu-cloudimage-keyring.gpg"
assert keyring.is_file() and not keyring.is_symlink()
with Path(package["deb"]).open("rb") as stream:
    assert hashlib.file_digest(stream, "sha256").hexdigest() == package["SHA256"]

# Authenticate the actual key material, not just a mutable extraction path.
# Only this already SHA-pinned Ubuntu package is decompressed; cap its raw tar
# before allowing tarfile to interpret any headers. No tar member is extracted.
tar_path = output / "authenticated-keyring-package.tar"
result = None
failure = None


def keyring_tar_bound():
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024**2, 8 * 1024**2))


try:
    with tar_path.open("xb") as out, (output / "keyring-package.stderr.txt").open("xb") as err:
        result = subprocess.run(
            ["dpkg-deb", "--fsys-tarfile", package["deb"]],
            stdout=out,
            stderr=err,
            timeout=30,
            preexec_fn=keyring_tar_bound,
        )
except (subprocess.TimeoutExpired, OSError) as error:
    failure = error
with (output / "keyring-package.status.json").open("x") as receipt:
    json.dump(
        {
            "code": None if result is None else result.returncode,
            "timed_out": isinstance(failure, subprocess.TimeoutExpired),
            "error": None if failure is None else str(failure),
        },
        receipt,
    )
if failure is not None:
    raise failure
assert result.returncode == 0 and 0 < tar_path.stat().st_size <= 8 * 1024**2
key_bytes = None
count = 0
with tarfile.open(tar_path, "r:") as archive:
    for member in archive:
        count += 1
        assert count <= 256 and len(member.name.encode()) <= 1024
        if member.name in (
            "./usr/share/keyrings/ubuntu-cloudimage-keyring.gpg",
            "usr/share/keyrings/ubuntu-cloudimage-keyring.gpg",
        ):
            assert key_bytes is None and member.isfile() and 0 < member.size <= 65536
            with archive.extractfile(member) as content:
                key_bytes = content.read(65537)
            assert len(key_bytes) == member.size
assert key_bytes is not None and keyring.stat().st_size == len(key_bytes) and keyring.read_bytes() == key_bytes
keyring = home / "authenticated-ubuntu-cloudimage-keyring.gpg"
with keyring.open("xb") as destination:
    destination.write(key_bytes)
    destination.flush()
    os.fsync(destination.fileno())
keyring.chmod(0o400)
keyring_sha = hashlib.sha256(key_bytes).hexdigest()
assert hashlib.sha256(keyring.read_bytes()).hexdigest() == keyring_sha


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise urllib.error.HTTPError(request.full_url, code, "Guest image redirects are refused", headers, fp)


def retain(leaf, maximum):
    url = base + leaf
    digest = hashlib.sha256()
    total = 0
    with (
        urllib.request.build_opener(NoRedirect).open(url, timeout=30) as response,
        (output / leaf).open("xb") as target,
    ):
        assert response.status == 200 and response.geturl() == url
        while block := response.read(1024 * 1024):
            total += len(block)
            assert total <= maximum, "Download bound exceeded; preserve partial, never execute"
            target.write(block)
            digest.update(block)
        target.flush()
        os.fsync(target.fileno())
    return {"url": url, "bytes": total, "sha256": digest.hexdigest()}


metadata = [retain("SHA256SUMS", 1024 * 1024), retain("SHA256SUMS.gpg", 65536)]
result = None
failure = None
try:
    with (output / "gpgv.stdout.txt").open("xb") as out, (output / "gpgv.stderr.txt").open("xb") as err:
        result = subprocess.run(
            [
                "gpgv",
                "--homedir",
                str(home),
                "--status-fd",
                "1",
                "--keyring",
                str(keyring),
                str(output / "SHA256SUMS.gpg"),
                str(output / "SHA256SUMS"),
            ],
            stdout=out,
            stderr=err,
            timeout=30,
        )
except (subprocess.TimeoutExpired, OSError) as error:
    failure = error
with (output / "gpgv.status.json").open("x") as receipt:
    json.dump(
        {
            "code": None if result is None else result.returncode,
            "timed_out": isinstance(failure, subprocess.TimeoutExpired),
            "error": None if failure is None else str(failure),
        },
        receipt,
    )
if failure is not None:
    raise failure
assert result.returncode == 0 and "[GNUPG:] VALIDSIG " in (output / "gpgv.stdout.txt").read_text()
matching = [
    match.group(1)
    for line in (output / "SHA256SUMS").read_text().splitlines()
    if (match := re.fullmatch(r"([0-9a-f]{64}) [ *]" + re.escape(name), line))
]
assert len(matching) == 1, "No unique signed selected-image digest"
image = retain(name, 1024**3)
assert (
    image["bytes"] == 859090944
    and image["sha256"] == "5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5"
)
assert image["sha256"] == matching[0], "Image disagrees with signed checksum; never execute"
assert stat.S_ISREG((output / name).lstat().st_mode)
record = {
    "recorded_at": datetime.datetime.now(datetime.UTC).isoformat(),
    "phase": "signed-checksum-verified-cloud-image-retained",
    "image": image,
    "metadata": metadata,
    "keyring_package": package,
    "keyring": {
        "path": str(keyring),
        "bytes": len(key_bytes),
        "sha256": keyring_sha,
        "binding": "Exact regular member of SHA-pinned Ubuntu .deb; extracted bytes match and private GPG-home copy rehashed",
    },
    "scope": "Official dated Ubuntu26.04 x86-64 cloud image authenticated with task-local Ubuntu keyring; no QCOW inspection, global key import, guest launch or host mutation",
}
with (output / "image-receipt.json").open("x") as receipt:
    json.dump(record, receipt, indent=2)
    receipt.write("\n")
print("Signed Ubuntu image retained; no guest execution")
