#!/usr/bin/env python3
"""One credential-free hosted prerequisite observation, never native acceptance.

No candidate is executed. The fixed inert child exercises the native driver's
user-manager/cgroup/tmpfs primitives. Existing accounts, attempts and receipts
are never reused. Only the ephemeral standard public CI machine is mutated.
"""

import hashlib
import json
import os
import platform
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

USER = "portcove-native"
INSTALLED = Path("/opt/portcove-native-readiness")
GUEST = Path("/home/portcove-native/portcove-native")
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/"}


def need(value, message):
    if not value:
        raise RuntimeError(message)


def encode(value):
    return json.dumps(value, separators=(",", ":")).encode()


def retain(filename, value):
    with filename.open("xb") as output:
        os.chmod(filename, 0o600)
        output.write(encode(value))


def begin_attempt(root, context, pins, tree):
    directory = root / "work/hosted-linux-runtime-evidence"
    # A normal clean checkout has no ignored work directory. Create only that
    # parent; the attempt itself remains exclusive and cannot be reused.
    directory.parent.mkdir(mode=0o700, exist_ok=True)
    directory.mkdir(mode=0o700)
    retain(directory / "intent.json", {**context, "tree": tree, "pins": pins,
           "scope": "one credential-free primitive diagnostic", "production": "held", "automatic_retry": False})
    return directory


def command(arguments, timeout=15, environment=None):
    reply = subprocess.run(
        arguments, env=environment or ENV, stdin=subprocess.DEVNULL,
        capture_output=True, timeout=timeout, check=False,
    )
    need(len(reply.stdout) <= 65536 and len(reply.stderr) <= 8192, "fixed diagnostic output exceeds bound")
    need(reply.returncode == 0, "fixed diagnostic command refused: " + reply.stderr.decode("utf-8", "replace")[:2048])
    return reply.stdout


def file_hash(filename):
    info = filename.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024,
         "fixed diagnostic source kind/bound differs")
    data = filename.read_bytes()
    after = filename.lstat()
    need(all(getattr(info, name) == getattr(after, name) for name in
             ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_uid", "st_mode", "st_nlink")),
         "fixed diagnostic source changed")
    return hashlib.sha256(data).hexdigest()


def hosted_context(environment):
    need(platform.system() == "Linux" and platform.machine() == "x86_64", "Ubuntu x86_64 diagnostic required")
    need(environment.get("GITHUB_ACTIONS") == "true"
         and environment.get("GITHUB_REPOSITORY") == "boburning/portcove"
         and environment.get("RUNNER_ENVIRONMENT") == "github-hosted"
         and environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
         and environment.get("GITHUB_RUN_ATTEMPT") == "1"
         and re.fullmatch(r"[1-9][0-9]+", environment.get("GITHUB_RUN_ID", ""))
         and re.fullmatch(r"[a-f0-9]{40}", environment.get("GITHUB_SHA", ""))
         and re.fullmatch(r"boburning/portcove/\.github/workflows/hosted-native-linux-readiness.yml@refs/heads/(main|feature/534-[a-z0-9-]+)",
                          environment.get("GITHUB_WORKFLOW_REF", "")),
         "only the fixed standard hosted diagnostic may prepare this runtime")
    # Environment guards constrain this helper; they do not attest a provider or
    # grant any release authority. This workflow carries no such credentials.
    return {name: environment[name] for name in
            ("GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW_REF")}


ROOT_SETUP = r'''
import hashlib,json,os,pwd,shutil,stat,subprocess,sys
from pathlib import Path
src=Path(sys.argv[1]); wanted=json.loads(sys.argv[2]); target=Path('/opt/portcove-native-readiness')
assert os.getuid()==0 and not target.exists() and not Path('/home/portcove-native').exists()
try: pwd.getpwnam('portcove-native')
except KeyError: pass
else: raise RuntimeError('preexisting qualification account refuses setup')
for name,digest in wanted.items():
 p=src/name; info=p.lstat(); assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=1048576
 assert hashlib.sha256(p.read_bytes()).hexdigest()==digest
subprocess.run(['/usr/sbin/useradd','--create-home','--user-group','--shell','/usr/sbin/nologin','portcove-native'],check=True,timeout=10)
user=pwd.getpwnam('portcove-native'); assert user.pw_uid>0 and user.pw_shell=='/usr/sbin/nologin'
assert subprocess.run(['/usr/bin/passwd','-S','portcove-native'],check=True,capture_output=True,timeout=5).stdout.split()[1]==b'L'
Path(user.pw_dir).chmod(0o700)
target.mkdir(mode=0o755)
for name,digest in wanted.items():
 data=(src/name).read_bytes(); assert hashlib.sha256(data).hexdigest()==digest
 p=target/name
 with p.open('xb') as f: f.write(data)
 p.chmod(0o444)
root=Path('/home/portcove-native/portcove-native'); root.mkdir(mode=0o700); os.chown(root,user.pw_uid,user.pw_gid)
subprocess.run(['/usr/bin/loginctl','enable-linger','portcove-native'],check=True,timeout=10)
subprocess.run(['/usr/bin/systemctl','start',f'user@{user.pw_uid}.service'],check=True,timeout=15)
print(json.dumps({'uid':user.pw_uid,'gid':user.pw_gid,'shell':user.pw_shell,'source_sha256':wanted}))
'''

CHILD = r'''
import json,os,subprocess,sys,time
from pathlib import Path
os.umask(0o077)
home,ready=map(Path,sys.argv[1:]); size=os.statvfs(home)
assert 0<size.f_blocks*size.f_frsize<=512*1024*1024
mounts=[line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
matches=[parts[parts.index('-')+1] for parts in mounts if parts[4]==str(home)]
assert matches==['tmpfs']
child=subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import time;time.sleep(120)'],env={'PATH':'/usr/bin:/bin'},stdin=subprocess.DEVNULL)
partial=ready.with_suffix('.partial')
with partial.open('xb') as f:
 f.write(json.dumps({'pid':os.getpid(),'child_pid':child.pid,'uid':os.getuid(),'gid':os.getgid(),'cgroup':Path('/proc/self/cgroup').read_text().strip(),'writable_bytes':size.f_blocks*size.f_frsize}).encode())
# Publish a complete record atomically, refusing an existing destination. Keep
# the matching partial inode as diagnostic evidence rather than deleting it.
os.link(partial,ready)
time.sleep(120)
'''


def settle_observed(supervisor, unit, generation, group):
    # Set the existing supervisor's command deadline before its first blocking
    # read. No command can obtain its ordinary ten-second default in recovery.
    deadline = time.monotonic() + 8
    previous = supervisor.get("COMMAND_DEADLINE")
    supervisor["COMMAND_DEADLINE"] = min(deadline, previous) if previous is not None else deadline
    deadline = supervisor["COMMAND_DEADLINE"]
    try:
        properties = supervisor["unit_properties"](unit)
        if not (group.empty() and supervisor["settled_unit"](properties)):
            supervisor["inspect_unit_identity"](properties, unit, generation)
            # Only the observed generation can receive deliberate teardown.
            # A response alone cannot establish that an effect did/didn't occur.
            supervisor["systemctl"]("kill", "--signal=KILL", "--kill-whom=all", unit)
            properties = supervisor["unit_properties"](unit)
            while time.monotonic() < deadline and not (group.empty() and supervisor["settled_unit"](properties)):
                time.sleep(0.05)
                properties = supervisor["unit_properties"](unit)
        empty = group.empty()
        need(time.monotonic() < deadline, "original recovery readback deadline expired; settlement remains unknown")
        return {"cgroup_empty": empty, "cgroup_settlement": group.last_observation,
                "unit_settled": supervisor["settled_unit"](properties)}
    finally:
        supervisor["COMMAND_DEADLINE"] = previous


def probe():
    import pwd

    user = pwd.getpwnam(USER)
    need(os.getuid() == user.pw_uid > 0 and os.getgid() == user.pw_gid, "separate qualification identity required")
    filename = INSTALLED / "native-qualification-linux-supervisor.py"
    for source in (Path(__file__), filename):
        info = source.lstat()
        need(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_mode & 0o222 == 0,
             "installed diagnostic code custody differs")
    # Reuse the actual supervisor's resource and held-kernel-object checks.
    source = filename.read_bytes()
    supervisor = {"__name__": "hosted_readiness_supervisor", "__file__": str(filename)}
    exec(compile(source, str(filename), "exec"), supervisor)
    invocation = os.urandom(32).hex()
    attempt = GUEST / "invocations" / invocation
    for directory in (GUEST / "invocations", attempt, attempt / "work", attempt / "work/home", attempt / "capture"):
        directory.mkdir(mode=0o700)
    home = attempt / "work/home"
    ready = attempt / "capture/ready.json"
    unit = "portcove-native-" + invocation + ".service"
    result = {"scope": "inert hosted primitive observation only", "authority": "none",
              "native_acceptance": "not-established", "unit": unit, "invocation_id": invocation,
              "stage": "user-manager", "failure": None, "cgroup_empty": False,
              "unit_settled": False, "automatic_retry": False}
    process = group = generation = None
    control = supervisor["control_environment"]()
    readiness_deadline = time.monotonic() + 15
    supervisor["COMMAND_DEADLINE"] = readiness_deadline
    try:
        need(supervisor["unit_properties"](unit).get("LoadState") == "not-found", "diagnostic unit already exists")
        result["stage"] = "unit-start"
        process = subprocess.Popen([
            "/usr/bin/systemd-run", "--user", "--quiet", "--pipe", "--wait", "--service-type=exec",
            "--unit=" + unit, "--property=MemoryMax=1073741824", "--property=MemorySwapMax=0",
            "--property=TasksMax=64", "--property=KillMode=control-group", "--property=TimeoutStopSec=5s",
            "--property=RuntimeMaxSec=35s", "--property=NoNewPrivileges=yes", "--property=UMask=0077",
            "--property=RestrictSUIDSGID=yes", "--", "/usr/bin/bwrap", "--die-with-parent", "--new-session",
            "--unshare-user", "--uid", str(user.pw_uid), "--gid", str(user.pw_gid), "--cap-drop", "ALL",
            "--bind", "/", "/", "--size", "536870912", "--tmpfs", str(home), "--chdir", str(home),
            "--setenv", "HOME", str(home), "--setenv", "TMPDIR", str(home), "--",
            "/usr/bin/python3", "-I", "-S", "-B", "-c", CHILD, str(home), str(ready),
        ], env=control, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = readiness_deadline
        while time.monotonic() < deadline and process.poll() is None:
            properties = supervisor["unit_properties"](unit)
            if properties.get("ActiveState") == "active" and properties.get("MainPID", "0") != "0":
                supervisor["inspect_unit_properties"](properties)
                generation = properties["InvocationID"]
                supervisor["inspect_unit_identity"](properties, unit, generation)
                group = supervisor["HeldCgroup"](unit, int(properties["MainPID"]))
                break
            time.sleep(0.05)
        need(group is not None, "actual bounded user unit never became observable")
        result.update(stage="namespace-readiness", unit_invocation_id=generation,
                      cgroup={"device": group.identity[0], "inode": group.identity[1], "path": str(group.path)})
        while time.monotonic() < deadline and not ready.exists() and process.poll() is None:
            time.sleep(0.05)
        need(ready.exists(), "actual bubblewrap child did not report readiness")
        raw = ready.read_bytes()
        need(len(raw) <= 4096, "inert readiness exceeds bound")
        observed = json.loads(raw)
        need(observed["uid"] == user.pw_uid and observed["gid"] == user.pw_gid,
             "actual namespace account differs")
        need(observed["cgroup"] == "0::" + str(group.path).removeprefix("/sys/fs/cgroup"),
             "actual namespace cgroup differs")
        need(str(observed["pid"]) in group.read("cgroup.procs").splitlines()
             and str(observed["child_pid"]) in group.read("cgroup.procs").splitlines(),
             "inert process tree is outside the held cgroup")
        need(time.monotonic() < readiness_deadline, "original inert readiness deadline expired")
        result.update(stage="inert-tree-observed", observed=observed)
    except Exception as error:
        result["failure"] = str(error)
    finally:
        # Recovery has its own fixed eight-second allowance within the probe's
        # outer lifetime, never the expired readiness command budget.
        supervisor["COMMAND_DEADLINE"] = None
        if generation is not None and group is not None:
            try:
                result.update(settle_observed(supervisor, unit, generation, group))
            except Exception as error:
                result["recovery_failure"] = str(error)
            try:
                group.close()
            except Exception as error:
                result["cgroup_close_failure"] = str(error)
        if process is not None:
            try:
                _stdout, stderr = process.communicate(timeout=10)
                result["unit_launcher_exit"] = process.returncode
                result["unit_stderr"] = stderr[:8192].decode("utf-8", "replace")
            except subprocess.TimeoutExpired:
                # RuntimeMaxSec remains the provider-independent unit backstop.
                # A response timeout is not proof that any descendant stopped.
                result["launcher_settlement"] = "unknown"
        result["passed"] = (result["failure"] is None and result["cgroup_empty"]
                            and result["unit_settled"] and "recovery_failure" not in result
                            and "cgroup_close_failure" not in result
                            and result.get("launcher_settlement") != "unknown")
        retain(attempt / "capture/probe.json", result)
        print(json.dumps(result))
    return 0 if result["passed"] else 1


def prepare():
    context = hosted_context(os.environ)
    need(os.getuid() > 0, "ordinary hosted broker required")
    root = Path(__file__).resolve().parent.parent
    env = {**ENV, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"}
    def git(*arguments):
        return command(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                        "-C", str(root), *arguments], environment=env).decode().strip()
    need(git("rev-parse", "HEAD") == context["GITHUB_SHA"] and not git("status", "--porcelain", "--untracked-files=no"),
         "exact clean diagnostic source required")
    need('ID=ubuntu' in Path("/etc/os-release").read_text()
         and 'VERSION_ID="24.04"' in Path("/etc/os-release").read_text(), "actual Ubuntu24.04 required")
    pins = {name: file_hash(root / "scripts" / name) for name in
            ("qualify-hosted-native-linux.py", "native-qualification-linux-supervisor.py")}
    directory = begin_attempt(root, context, pins, git("rev-parse", "HEAD^{tree}"))
    result = {"stage": "tool-observation", "failure": None, "setup": None, "probe": None}
    try:
        for tool in ("/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/sudo"):
            need(Path(tool).is_file(), "required hosted primitive missing: " + tool)
        result["stage"] = "fixed-account-setup"
        result["setup"] = json.loads(command([
            "/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "--kill-after=2s", "45s",
            "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "/usr/bin/python3", "-I", "-S", "-B", "-c",
            ROOT_SETUP, str(root / "scripts"), json.dumps(pins),
        ], timeout=50))
        need(result["setup"]["uid"] != os.getuid(), "broker and qualification identities coincide")
        result["stage"] = "inert-boundary-probe"
        reply = subprocess.run([
            "/usr/bin/sudo", "-n", "-H", "-u", USER, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin",
            "LANG=C.UTF-8", "HOME=/home/portcove-native", "/usr/bin/python3", "-I", "-S", "-B",
            str(INSTALLED / "qualify-hosted-native-linux.py"), "--probe",
        ], env=ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=75, check=False)
        need(len(reply.stdout) <= 65536 and len(reply.stderr) <= 8192, "probe output exceeds bound")
        result["probe_exit"] = reply.returncode
        result["probe_stderr"] = reply.stderr.decode("utf-8", "replace")
        result["probe"] = json.loads(reply.stdout)
        need(reply.returncode == 0 and result["probe"]["passed"], "actual hosted primitive diagnostic failed")
        result["stage"] = "bounded-primitives-observed"
    except Exception as error:
        result["failure"] = str(error)
    finally:
        result.update(authority="none", native_acceptance="not-established", production="held", automatic_retry=False)
        retain(directory / "result.json", result)
        print(json.dumps(result))
    return 0 if result["failure"] is None else 1


if __name__ == "__main__":
    need(sys.argv[1:] in (["--prepare"], ["--probe"]), "fixed diagnostic operation required")
    sys.exit(probe() if sys.argv[1] == "--probe" else prepare())
