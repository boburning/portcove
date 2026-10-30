"""One task-owned, headless QEMU guest. Never reboot or administer the host."""

import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from common import hosted_context, verified_admission

workspace, root = hosted_context()
admission_path = root / "launch-inputs.json"
assert len(sys.argv) == 2 and len(sys.argv[1]) == 64 and all(c in "0123456789abcdef" for c in sys.argv[1])
admission = verified_admission(admission_path.read_bytes(), sys.argv[1])
assert (
    admission["controller_source"] == os.environ["GITHUB_SHA"]
    and admission["run"] == os.environ["GITHUB_RUN_ID"]
    and admission["attempt"] == os.environ["GITHUB_RUN_ATTEMPT"]
)
for row in admission["files"]:
    p = Path(row["path"])
    assert p.is_file() and not p.is_symlink() and p.stat().st_size == row["bytes"]
    with p.open("rb") as f:
        assert hashlib.file_digest(f, "sha256").hexdigest() == row["sha256"]
run = root / "guest-run"
assert not run.exists() and os.geteuid() != 0
run.mkdir(mode=0o700)


def digest(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def publish(name, value):
    with (run / name).open("x") as f:
        json.dump(value, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


def command(label, args, env=None, timeout=60):
    result = None
    error = None
    try:
        with (run / (label + ".stdout")).open("xb") as out, (run / (label + ".stderr")).open("xb") as err:
            result = subprocess.run(args, env=env, stdout=out, stderr=err, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        error = e
    publish(
        label + ".status.json",
        {
            "arguments": args,
            "code": None if result is None else result.returncode,
            "error": None if error is None else str(error),
        },
    )
    if error:
        raise error
    assert result.returncode == 0, label


# The dedicated hosted job installs its own Ubuntu24 prerequisites. The final
# source-bound manifest rehashes actual tools/libraries/firmware before execution.
runtime_record = json.loads((root / "runtime.json").read_bytes())
runtime = runtime_record["files"]
qemu = runtime_record["tools"]["qemu-system-x86_64"]
img = runtime_record["tools"]["qemu-img"]
bios = runtime_record["bios"]
assert all(Path(p).is_absolute() and Path(p).resolve() == Path(p) for p in [qemu, img, bios])
assert runtime_record["data"] == "/usr/share/qemu"
(run / "private-home").mkdir(mode=0o700)
(run / "private-tmp").mkdir(mode=0o700)
env = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "HOME": str(run / "private-home"),
    "TMPDIR": str(run / "private-tmp"),
}
command("qemu-version", [qemu, "--version"], env)
command("qemu-img-version", [img, "--version"], env)
image_receipt = json.loads((root / "image/image-receipt.json").read_bytes())
assert image_receipt["phase"] == "signed-checksum-verified-cloud-image-retained"
image = root / "image/ubuntu-26.04-server-cloudimg-amd64.img"
assert image.stat().st_size == image_receipt["image"]["bytes"] and digest(image) == image_receipt["image"]["sha256"]
inputs = root / "public-inputs"
manifest = json.loads((inputs / "inputs.json").read_bytes())
assert (
    manifest["source"] == "38cc869f1f1db165351d65a9b490d8d35c71dd56"
    and manifest["run"] == 40934887557
    and manifest["attempt"] == 1
    and manifest["artifact"] == 12926701381
    and manifest["archive_sha256"] == "cfc5f19d45839d45bdecc1ff36944f48c59d91d51744af4d5f362503bb3e8478"
)
for row in manifest["files"]:
    p = inputs / row["path"]
    assert p.is_file() and not p.is_symlink() and p.stat().st_size == row["bytes"] and digest(p) == row["sha256"]
reports = run / "reports"
reports.mkdir(mode=0o777)
reports.chmod(0o777)
overlay = run / "owned-guest.qcow2"
command("create-disk", [img, "create", "-f", "qcow2", "-F", "qcow2", "-b", str(image), str(overlay), "12G"], env)
nonce = uuid.uuid4().hex


# Explicit NoCloud documents only; no host directory traversal or listing.
class Seed(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        value = documents.get(self.path)
        if value is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(value)))
        self.end_headers()
        self.wfile.write(value)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Seed)
port = server.server_address[1]
# These commands execute only INSIDE the dedicated guest via cloud-init/systemd.
setup = r"""#!/bin/bash
set -euo pipefail
# Before the cell is admitted, settle a failed disposable setup and retain its serial cause.
trap 'setup_status=$?; if [ "$setup_status" -ne 0 ]; then echo "PORTCOVE_GUEST_SETUP_FAILED exit=$setup_status" >&2; sync; systemctl poweroff --no-block || :; fi' EXIT
export DEBIAN_FRONTEND=noninteractive
# Guest-only setup fixes explicit ordinary caller identity before any app execution.
if test "$(id -g portcove)" != 1001; then groupmod --gid 1001 portcove; usermod --gid 1001 portcove; fi
apt-get update
apt-get install -y --no-install-recommends libwebkit2gtk-4.1-0 libgtk-3-0t64 libfuse2t64 fuse3 python3 ca-certificates
modprobe fuse
chmod 0666 /dev/fuse
mkdir -p /mnt/public-inputs /mnt/qualification-output
mount -t 9p -o trans=virtio,version=9p2000.L,ro public-inputs /mnt/public-inputs
mkdir -p /home/portcove/{inputs,tools,Applications,qualification}
python3 /usr/local/lib/portcove-provision.py
chown -R 1001:1001 /home/portcove
chmod 0755 /home/portcove/Applications/*.AppImage /home/portcove/inputs/*.AppImage /home/portcove/tools/prepare_installed_update
systemctl enable portcove-reboot-cell.service
systemctl start --no-block portcove-reboot-cell.service
# The queued cell takes ownership after this successful setup/cloud-final completes.
trap - EXIT
"""
provision = r"""from pathlib import Path
import json,hashlib,shutil
s=Path('/mnt/public-inputs');m=json.loads((s/'inputs.json').read_bytes())
for row in m['files']:
 p=s/row['path']
 with p.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==row['sha256']
 assert p.stat().st_size==row['bytes']
base='updater-rehearsal/'
for row in m['files']:
 name=row['path']
 if '/repository/positive/' in name:
  relative=name.split('/repository/positive/',1)[1]
  out=Path('/home/runner/work/portcove/portcove/work/updater-rehearsal/linux-appimage-qualification/repository/positive')/relative
  out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(s/name,out)
for name,dest in [
 (base+'qualified-0.1.0-bundles/appimage/Portcove_0.1.0_amd64.AppImage','Applications/Portcove Public beta β.AppImage'),
 (base+'0.3.0-linux-x86_64/Portcove_0.3.0_amd64.AppImage','inputs/Portcove_0.3.0_amd64.AppImage'),
 ('prepare_installed_update','tools/prepare_installed_update'),('guest-reboot-case.py','tools/guest-reboot-case.py'),('configuration.json','configuration.json')]:
 shutil.copyfile(s/name,Path('/home/portcove')/dest)
"""
cell = r"""#!/bin/bash
set -euo pipefail
mkdir -p /mnt/qualification-output
mountpoint -q /mnt/qualification-output || mount -t 9p -o trans=virtio,version=9p2000.L qualification-output /mnt/qualification-output
touch /run/portcove-owned-reboot-guest
modprobe fuse
chmod 0666 /dev/fuse
phase=checkpoint
if test -f /home/portcove/qualification/checkpoint.json; then phase=recover; fi
set +e
runuser -u portcove -- python3 /home/portcove/tools/guest-reboot-case.py "$phase" /home/portcove/configuration.json > "/mnt/qualification-output/$phase.stdout" 2> "/mnt/qualification-output/$phase.stderr"
status=$?
set -e
python3 /usr/local/lib/portcove-retain.py "$phase" "$status"
sync
if test "$status" != 0; then systemctl poweroff --no-block; exit "$status"; fi
if test "$phase" = checkpoint; then systemctl reboot --no-block; else systemctl poweroff --no-block; fi
"""
retain = r"""from pathlib import Path
import os,shutil,json,sys
root=Path('/home/portcove/qualification');out=Path('/mnt/qualification-output')/sys.argv[1];out.mkdir()
for p in root.iterdir():
 if p.is_file() and not p.is_symlink() and p.suffix in ('.json','.txt') and p.stat().st_size<=1048576:shutil.copyfile(p,out/p.name)
for name in ['apply.json','staging.json']:
 p=root/'update-state'/name
 if p.is_file() and not p.is_symlink() and p.stat().st_size<=1048576:shutil.copyfile(p,out/('update-state-'+name))
(out/'os-release.txt').write_bytes(Path('/etc/os-release').read_bytes())
(out/'boot-id.txt').write_bytes(Path('/proc/sys/kernel/random/boot_id').read_bytes())
import subprocess
for label,args in [('packages',['dpkg-query','-W','libwebkit2gtk-4.1-0','libgtk-3-0t64','libfuse2t64','fuse3','libglib2.0-0t64']),('kernel',['uname','-a']),('mounts',['findmnt','-J','--target','/home/portcove','--output','TARGET,SOURCE,FSTYPE,OPTIONS'])]:
 result=subprocess.run(args,capture_output=True,timeout=20)
 (out/(label+'.stdout')).write_bytes(result.stdout[:1048576])
 (out/(label+'.stderr')).write_bytes(result.stderr[:1048576])
 (out/(label+'.status.json')).write_text(json.dumps({'code':result.returncode}))
with (out/'phase-status.json').open('x') as f:json.dump({'phase':sys.argv[1],'code':int(sys.argv[2])},f);f.flush();os.fsync(f.fileno())
"""
unit = """[Unit]\nDescription=Owned Portcove reboot recovery observation\nAfter=network-online.target cloud-final.service\n[Service]\nType=oneshot\nExecStart=/usr/local/lib/portcove-cell.sh\nTimeoutStartSec=15min\n[Install]\nWantedBy=multi-user.target\n"""
files = [
    ("/usr/local/lib/portcove-setup.sh", setup, "0755"),
    ("/usr/local/lib/portcove-provision.py", provision, "0644"),
    ("/usr/local/lib/portcove-cell.sh", cell, "0755"),
    ("/usr/local/lib/portcove-retain.py", retain, "0644"),
    ("/etc/systemd/system/portcove-reboot-cell.service", unit, "0644"),
]
config = {
    "users": [
        {
            "name": "portcove",
            "uid": 1001,
            "primary_group": "portcove",
            "groups": ["portcove"],
            "lock_passwd": True,
            "shell": "/bin/bash",
        }
    ],
    "write_files": [{"path": p, "content": c, "permissions": m} for p, c, m in files],
    "runcmd": [["bash", "/usr/local/lib/portcove-setup.sh"]],
}
documents = {
    f"/{nonce}/user-data": ("#cloud-config\n" + json.dumps(config)).encode(),
    f"/{nonce}/meta-data": json.dumps(
        {"instance-id": "portcove-" + nonce, "local-hostname": "portcove-owned-reboot"}
    ).encode(),
    f"/{nonce}/vendor-data": b"",
    f"/{nonce}/network-config": b'version: 2\nethernets:\n  enp0s2:\n    match:\n      name: "en*"\n    dhcp4: true\n',
}
for name, data in documents.items():
    (run / ("seed-" + name.rsplit("/", 1)[1])).write_bytes(data)
publish(
    "seed-manifest.json",
    {
        "documents": [
            {"request_path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in documents.items()
        ],
        "scope": "Four retained explicit public NoCloud documents; controller template externally pinned",
    },
)
threading.Thread(target=server.serve_forever, daemon=True).start()
args = [
    qemu,
    "-machine",
    "q35,accel=tcg",
    "-cpu",
    "max",
    "-smp",
    "2",
    "-m",
    "3072",
    "-display",
    "none",
    "-vga",
    "none",
    "-monitor",
    "none",
    "-L",
    runtime_record["data"],
    "-bios",
    bios,
    "-nodefaults",
    "-serial",
    "file:" + str(run / "serial.log"),
    "-drive",
    f"file={overlay},if=virtio,format=qcow2",
    "-netdev",
    "user,id=net0",
    "-device",
    "virtio-net-pci,netdev=net0,romfile=",
    "-fsdev",
    f"local,id=inputs,path={inputs},security_model=none,readonly=on",
    "-device",
    "virtio-9p-pci,fsdev=inputs,mount_tag=public-inputs",
    "-fsdev",
    f"local,id=outputs,path={reports},security_model=none",
    "-device",
    "virtio-9p-pci,fsdev=outputs,mount_tag=qualification-output",
    "-smbios",
    f"type=1,serial=ds=nocloud;s=http://10.0.2.2:{port}/{nonce}/",
]
q = None
error = None
before = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
start = time.monotonic()
try:
    with (run / "qemu.stdout").open("xb") as out, (run / "qemu.stderr").open("xb") as err:
        q = subprocess.Popen(args, env=env, stdout=out, stderr=err)
        publish(
            "qemu-start.json",
            {
                "pid": q.pid,
                "start_identity": Path(f"/proc/{q.pid}/stat").read_text(),
                "host_boot_id": before,
                "arguments": args,
                "runtime_files": runtime,
                "image": image_receipt["image"],
                "scope": "Single process/same writable overlay; normal guest reboot only; no reset, reseed, snapshot, host reboot or GPU claim",
            },
        )
        q.wait(timeout=5400)
except (OSError, subprocess.TimeoutExpired) as e:
    error = e
    if q is not None and q.poll() is None:
        q.terminate()
        try:
            q.wait(timeout=30)
        except subprocess.TimeoutExpired:
            q.kill()
            q.wait(timeout=10)
finally:
    server.shutdown()
    server.server_close()
    publish(
        "qemu-outcome.json",
        {
            "code": None if q is None else q.returncode,
            "error": None if error is None else str(error),
            "seconds": time.monotonic() - start,
            "host_boot_id_before": before,
            "host_boot_id_after": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        },
    )
if error:
    raise error
assert q.returncode == 0
for phase in ["checkpoint", "recover"]:
    status = json.loads((reports / phase / "phase-status.json").read_bytes())
    assert status == {"phase": phase, "code": 0}
result = json.loads((reports / "recover/reboot-recovery.json").read_bytes())
assert (
    result["phase"] == "complete"
    and result["before"]["boot_id"] != result["after"]["boot_id"]
    and result["before"]["machine_id"] == result["after"]["machine_id"]
)
assert before == Path("/proc/sys/kernel/random/boot_id").read_text().strip()
publish(
    "result.json",
    {
        "phase": "complete",
        "recovery": result,
        "source": manifest["source"],
        "controller_source": admission["controller_source"],
        "run": admission["run"],
        "attempt": admission["attempt"],
        "image": image_receipt["image"],
        "qemu_pid": q.pid,
        "scope": "One ordinary guest UID1001 normal OS reboot, interrupted replacement recovery and synthetic witnesses; existing GUI/real-game acceptance remains separate",
    },
)
print("Owned guest reboot and existing recovery completed")
