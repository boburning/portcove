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
import select
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


def require_setup_readback(setup, broker_uid):
    need(setup["completed"] is True and setup["failure"] is None,
         "fixed account setup refused; retain original stage and partial readback")
    need(type(setup["uid"]) is int and type(setup["gid"]) is int
         and 0 < setup["uid"] <= 4294967294 and 0 < setup["gid"] <= 4294967294,
         "actual setup identity must be nonroot")
    need("readback_error" not in setup, "positive setup readback unavailable")
    need(setup["readback"]["account"] == {
        "uid": str(setup["uid"]), "gid": str(setup["gid"]),
        "home": "/home/portcove-native", "shell": "/usr/sbin/nologin",
    }, "actual setup account readback differs")
    for filename in ("/home/portcove-native", str(GUEST)):
        observed = setup["readback"]["paths"][filename]
        need(observed["directory"] and observed["uid"] == setup["uid"]
             and observed["gid"] == setup["gid"] and int(observed["mode"], 8) & 0o077 == 0,
             "actual private setup path differs")
    observed = setup["readback"]["paths"][str(INSTALLED)]
    need(observed["directory"] and observed["uid"] == 0 and int(observed["mode"], 8) & 0o022 == 0,
         "actual installed source custody differs")
    need(setup["uid"] != broker_uid, "broker and qualification identities coincide")
    profile = setup.get("profile", {})
    need(profile.get("completed") is True and profile.get("source_sha256") ==
         "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
         and profile.get("after") == profile.get("final_state")
         and profile.get("after", {}).get("labels") == ["bwrap (enforce)", "unpriv_bwrap (enforce)"]
         and "readback_error" not in profile, "actual profile setup/readback differs")


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
import fnmatch,hashlib,json,os,pwd,re,signal,stat,subprocess,sys,time
from pathlib import Path
src=Path(sys.argv[1]); wanted=json.loads(sys.argv[2]); context=json.loads(sys.argv[3]); target=Path('/opt/portcove-native-readiness')
result={'stage':'source-validation','completed':False,'failure':None,'source_sha256':wanted,'readback':None,'automatic_retry':False}
deadline=time.monotonic()+60
def run(arguments,seconds,maximum=8192):
 remaining=min(seconds,deadline-time.monotonic()); assert remaining>0
 child=subprocess.Popen(arguments,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:
  stdout,stderr=child.communicate(timeout=remaining)
 except subprocess.TimeoutExpired as original:
  # The original child has not been reaped, so its session/group identity
  # cannot have been reused. Terminate only that fixed root command's group.
  result['command_timeout']={'executable':arguments[0],'seconds':remaining,'group_kill_sent':False,'child_reaped':False}
  try:
   os.killpg(child.pid,signal.SIGKILL)
   result['command_timeout']['group_kill_sent']=True
   child.communicate(timeout=2)
   result['command_timeout']['child_reaped']=True
  except Exception as error: result['command_timeout']['settlement_error']=type(error).__name__
  raise original
 assert len(stdout)<=maximum and len(stderr)<=8192 and child.returncode==0, 'fixed setup command refused'
 assert time.monotonic()<deadline, 'original setup deadline expired'
 return stdout
def bounded(filename,maximum=131072):
 with Path(filename).open('rb') as f: data=f.read(maximum+1)
 assert len(data)<=maximum, 'profile input exceeds bound'
 return data
def digest(data): return hashlib.sha256(data).hexdigest()
def exclusive(filename,data):
 with Path(filename).open('xb') as f: f.write(data)
 Path(filename).chmod(0o444)
def attachment_clear(pattern):
 # Conservative superset of AARE: fnmatch's star also crosses '/', so it can
 # refuse extra patterns but cannot admit an overlapping supported glob.
 assert pattern and pattern!='<unknown>', 'kernel attachment unavailable'
 patterns=[pattern]
 while any('{' in value for value in patterns):
  expanded=[]
  for value in patterns:
   if '{' not in value: expanded.append(value); continue
   match=re.search(r'\{([^{}]*)\}',value); assert match, 'unsupported attachment alternation'
   expanded.extend(value[:match.start()]+part+value[match.end():] for part in match[1].split(','))
  assert len(expanded)<=32, 'attachment alternation exceeds bound'
  patterns=expanded
 for value in patterns:
  assert not any(char in value for char in ('[',']','\\','@','}')), 'unsupported kernel attachment'
  assert not fnmatch.fnmatchcase('/usr/bin/bwrap',value), 'existing bwrap attachment'
def profile_refusal(entry,value,attachments,labels):
 # Public kernel metadata only. Preserve the original refusal even when its
 # optional diagnostic reads fail or the original deadline has elapsed.
 def summary(text):
  return {'text':text[:256],'utf8_bytes':len(text.encode()),'sha256':digest(text.encode()),'truncated':len(text)>256}
 record={'entry':summary(entry.name),'attachment':summary(value),'kernel_release':os.uname().release[:256],
         'attachments_sha256':digest(json.dumps(attachments,sort_keys=True).encode()),
         'labels_sha256':digest(json.dumps(labels,sort_keys=True).encode())}
 result['profile_refusal']=record
 for field in ('name','mode','sha256'):
  try:
   assert time.monotonic()<deadline, 'original deadline expired'
   record[field]=summary(bounded(entry/field,4096).decode().strip())
  except Exception as error: record[field]={'error':type(error).__name__}

def profile_state(check_collision=False):
 labels=bounded('/sys/kernel/security/apparmor/profiles',131072).decode().splitlines()
 assert len(labels)<=4096
 entries=list(Path('/sys/kernel/security/apparmor/policy/profiles').iterdir()); assert len(entries)<=4096
 attachments={}; total=0
 for entry in sorted(entries):
  assert time.monotonic()<deadline
  attachments[entry.name]=bounded(entry/'attach',4096).decode().strip()
  total+=len(entry.name.encode())+len(attachments[entry.name].encode()); assert total<=131072
 if check_collision:
  assert not any(re.search(r'(^|//|&)(bwrap|unpriv_bwrap)(?= |$|//|&)',line) for line in labels), 'existing profile label'
  for name,value in attachments.items():
   try: attachment_clear(value)
   except AssertionError:
    try: profile_refusal(Path('/sys/kernel/security/apparmor/policy/profiles')/name,value,attachments,labels)
    except Exception as error: result['profile_refusal']={'observation_error':type(error).__name__}
    raise
 return {'labels':labels,'attachments':attachments}
def profile_summary(state):
 return {'sha256':digest(json.dumps(state,sort_keys=True).encode()),'labels':sorted(line for line in state['labels'] if re.search(r'(^|//|&)(bwrap|unpriv_bwrap)(?= |$|//|&)',line))}
def features():
 root=Path('/sys/kernel/security/apparmor/features'); records={}; total=0
 for directory,dirs,files in os.walk(root,followlinks=False):
  assert len(dirs)+len(files)<=256 and time.monotonic()<deadline
  for name in dirs: assert stat.S_ISDIR((Path(directory)/name).lstat().st_mode)
  for name in sorted(files):
   p=Path(directory)/name; assert stat.S_ISREG(p.lstat().st_mode)
   data=bounded(p,8192); total+=len(data); assert total<=131072 and len(records)<256
   records[str(p.relative_to(root))]=data.decode('ascii')
 assert records, 'kernel feature observation unavailable'
 return records
def setup_profile():
 result['stage']='profile-preflight'
 profile=src.parent/'work/hosted-linux-package-evidence/bwrap-userns-restrict.apparmor'
 data=bounded(profile,1936)
 assert len(data)==1936 and digest(data)=='11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9'
 policy=Path('/etc/apparmor.d/portcove-native-readiness-bwrap')
 assert not os.path.lexists(policy)
 for name in ('bwrap-userns-restrict','unpriv_bwrap'):
  assert not os.path.lexists('/etc/apparmor.d/local/'+name), 'local profile override refuses preparation'
 assert bounded('/proc/sys/kernel/apparmor_restrict_unprivileged_userns',16).strip()==b'1'
 parser=Path('/usr/sbin/apparmor_parser'); info=parser.lstat()
 assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022
 parser_sha=digest(bounded(parser,16777216))
 before=profile_state(True); kernel=features(); abi=bounded('/etc/apparmor.d/abi/4.0')
 result['profile']={'source_sha256':digest(data),'parser_sha256':parser_sha,'baseline_sha256':digest(json.dumps(before,sort_keys=True).encode()),'load_attempted':False}
 intent=json.dumps({'context':context,'source_sha256':wanted,'profile':result['profile'],'before':before,'operation':'add-only; disposable diagnostic host only','automatic_retry':False}).encode(); assert len(intent)<=524288
 exclusive(target/'profile-intent.json',intent)
 # Freeze expanded includes and ABI; parse no site config and read/write no
 # parser cache. Compile once without loading, then add that exact binary.
 exclusive(target/'profile.abi',abi)
 exclusive(policy,data)
 expanded=run([str(parser),'--config-file=/dev/null','--skip-cache','--preprocess',str(policy)],5,131072)
 assert not any(re.match(r'\s*alias\s',line) for line in expanded.decode().splitlines()), 'site alias refuses fixed attachment'
 exclusive(target/'profile.expanded',expanded)
 names=run([str(parser),'--config-file=/dev/null','--skip-cache','--names',str(target/'profile.expanded')],5).decode().splitlines()
 assert sorted(names)==['bwrap','unpriv_bwrap'], 'compiled profile labels differ'
 binary=run([str(parser),'--config-file=/dev/null','--skip-cache','--jobs=1','--stdout','--override-policy-abi',str(target/'profile.abi'),str(target/'profile.expanded')],15,1048576)
 assert binary
 exclusive(target/'profile.binary',binary)
 evidence={'source':data.decode(),'expanded':expanded.decode(),'abi':abi.decode(),'kernel_features':kernel,'before':before,'parser_sha256':parser_sha,'parser_version':run([str(parser),'--version'],3).decode(),'kernel_release':os.uname().release,'compiled_sha256':digest(binary),'compiled_bytes':len(binary)}
 encoded=json.dumps(evidence).encode(); assert len(encoded)<=524288
 exclusive(target/'profile-evidence.json',encoded)
 assert profile_state(True)==before and features()==kernel and digest(bounded(parser,16777216))==parser_sha
 assert bounded(target/'profile.binary',1048576)==binary
 assert bounded('/proc/sys/kernel/apparmor_restrict_unprivileged_userns',16).strip()==b'1'
 result['stage']='profile-add'; result['profile'].update(load_attempted=True,compiled_sha256=digest(binary),evidence_sha256=digest(encoded))
 exclusive(target/'profile-add-intent.json',json.dumps({'context':context,'compiled_sha256':digest(binary),'operation':'add-only','automatic_retry':False}).encode())
 run([str(parser),'--config-file=/dev/null','--skip-cache','--add','--binary',str(target/'profile.binary')],5)
 after=profile_state(); result['profile']['after']=profile_summary(after)
 assert 'bwrap (enforce)' in after['labels'] and 'unpriv_bwrap (enforce)' in after['labels'], 'profile enforcement readback differs'
 assert set(after['labels'])==set(before['labels'])|{'bwrap (enforce)','unpriv_bwrap (enforce)'}, 'unrelated kernel profile changed'
 added=set(after['attachments'])-set(before['attachments'])
 assert len(added)==2 and sorted(after['attachments'][name] for name in added)==['/usr/bin/bwrap','unpriv_bwrap'], 'new profile attachments differ'
 assert all(after['attachments'].get(name)==value for name,value in before['attachments'].items()), 'prior profile attachment changed'
 assert bounded('/proc/sys/kernel/apparmor_restrict_unprivileged_userns',16).strip()==b'1'
 result['profile']['completed']=True
try:
 assert os.getuid()==0 and not target.exists() and not Path('/home/portcove-native').exists()
 try: pwd.getpwnam('portcove-native')
 except KeyError: pass
 else: raise RuntimeError('preexisting qualification account refuses setup')
 for name,expected_digest in wanted.items():
  p=src/name; info=p.lstat(); assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=1048576
  assert hashlib.sha256(p.read_bytes()).hexdigest()==expected_digest
 result['stage']='useradd'
 run(['/usr/sbin/useradd','--no-log-init','--no-create-home','--user-group','--shell','/usr/sbin/nologin','portcove-native'],30)
 user=pwd.getpwnam('portcove-native'); assert user.pw_uid>0 and user.pw_gid>0 and user.pw_shell=='/usr/sbin/nologin' and user.pw_dir=='/home/portcove-native'
 result['stage']='locked-account-readback'
 assert run(['/usr/bin/passwd','-S','portcove-native'],5).split()[1]==b'L'
 result['stage']='private-home-creation'
 Path(user.pw_dir).mkdir(mode=0o700)
 os.chown(user.pw_dir,user.pw_uid,user.pw_gid)
 result['stage']='source-install'
 target.mkdir(mode=0o755)
 for name,expected_digest in wanted.items():
  data=(src/name).read_bytes(); assert hashlib.sha256(data).hexdigest()==expected_digest
  p=target/name
  with p.open('xb') as f: f.write(data)
  p.chmod(0o444)
 root=Path('/home/portcove-native/portcove-native'); root.mkdir(mode=0o700); os.chown(root,user.pw_uid,user.pw_gid)
 setup_profile()
 result['stage']='user-manager'
 run(['/usr/bin/loginctl','enable-linger','portcove-native'],10)
 run(['/usr/bin/systemctl','start',f'user@{user.pw_uid}.service'],15)
 assert time.monotonic()<deadline
 result.update(completed=True,uid=user.pw_uid,gid=user.pw_gid,shell=user.pw_shell)
except Exception as error:
 result['failure']=type(error).__name__+': '+str(error)[:2048]
finally:
 try:
  # Local public files only; avoid another potentially blocking NSS lookup.
  data=Path('/etc/passwd').read_bytes(); assert len(data)<=131072
  rows=[line.split(':') for line in data.decode().splitlines() if line.startswith('portcove-native:')]
  account=None if not rows else {'uid':rows[0][2],'gid':rows[0][3],'home':rows[0][5],'shell':rows[0][6]}
  paths={}
  for name in ('/home/portcove-native','/home/portcove-native/portcove-native','/opt/portcove-native-readiness'):
   p=Path(name)
   try:
    info=p.lstat(); paths[name]={'uid':info.st_uid,'gid':info.st_gid,'mode':oct(info.st_mode),'directory':stat.S_ISDIR(info.st_mode)}
   except FileNotFoundError: paths[name]=None
  result['readback']={'account':account,'paths':paths}
 except Exception as error: result['readback_error']=type(error).__name__
 if result.get('profile'):
  try: result['profile']['final_state']=profile_summary(profile_state())
  except Exception as error: result['profile']['readback_error']=type(error).__name__
 if time.monotonic()>=deadline:
  result['completed']=False
  result['failure']=result['failure'] or 'original setup readback deadline expired'
 print(json.dumps(result))
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
status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
policy={'apparmor':Path('/proc/self/attr/current').read_text().strip(),'NoNewPrivs':status['NoNewPrivs'].strip(),
        'capabilities':{name:status[name].strip() for name in ('CapEff','CapPrm','CapInh','CapAmb','CapBnd')},
        'userns_restriction':Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').read_text().strip()}
partial=ready.with_suffix('.partial')
with partial.open('xb') as f:
 f.write(json.dumps({'pid':os.getpid(),'child_pid':child.pid,'uid':os.getuid(),'gid':os.getgid(),'cgroup':Path('/proc/self/cgroup').read_text().strip(),'writable_bytes':size.f_blocks*size.f_frsize,'policy':policy}).encode())
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


def public_policy():
    # Fixed public kernel context, never credentials or arbitrary paths. These
    # observations identify policy state; they do not establish denial cause.
    result = {}
    for name in ("/proc/self/attr/current", "/proc/self/uid_map", "/proc/self/gid_map",
                 "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
                 "/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces"):
        try:
            with open(name, "rb") as source:
                data = source.read(4097)
            need(len(data) <= 4096, "fixed public policy exceeds bound")
            result[name] = data.decode("ascii").strip()
        except OSError as error:
            result[name] = {"unavailable_errno": error.errno}
    with open("/proc/self/status", "rb") as source:
        data = source.read(16385)
    need(len(data) <= 16384, "fixed process status exceeds bound")
    result["status"] = {key: value.strip() for line in data.decode("ascii").splitlines()
                        for key, separator, value in [line.partition(":")]
                        if separator and key in ("Uid", "Gid", "CapInh", "CapPrm", "CapEff", "CapBnd",
                                                 "CapAmb", "NoNewPrivs", "Seccomp", "Seccomp_filters")}
    return result


def wait_release(descriptor, deadline):
    data = b""
    while b"\n" not in data:
        remaining = deadline - time.monotonic()
        need(remaining > 0 and select.select([descriptor], [], [], remaining)[0], "inert entry release expired")
        part = os.read(descriptor, 2049 - len(data))
        need(part, "inert entry release closed")
        data += part
        need(len(data) <= 2048, "inert entry release exceeds bound")
    need(data.endswith(b"\n") and data.count(b"\n") == 1, "inert entry release framing differs")
    need(time.monotonic() < deadline, "original inert entry release deadline expired")
    return data[:-1]


def load_supervisor():
    filename = INSTALLED / "native-qualification-linux-supervisor.py"
    for source in (Path(__file__), filename):
        info = source.lstat()
        need(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_mode & 0o222 == 0,
             "installed diagnostic code custody differs")
    supervisor = {"__name__": "hosted_readiness_supervisor", "__file__": str(filename)}
    exec(compile(filename.read_bytes(), str(filename), "exec"), supervisor)
    return supervisor


def release_binding(supervisor, unit, generation, group, entry, invocation, deadline):
    properties = supervisor["unit_properties"](unit)
    supervisor["inspect_unit_properties"](properties)
    supervisor["inspect_unit_identity"](properties, unit, generation)
    pid = int(properties["MainPID"])
    need(entry["invocation_id"] == invocation and entry["pid"] == pid
         and entry["creation"] == supervisor["observe_root_creation"](pid)
         and str(pid) in group.read("cgroup.procs").splitlines(), "inert entry process generation differs")
    need(time.monotonic() < deadline, "original inert entry admission deadline expired")
    return {"invocation_id": invocation, "unit_invocation_id": generation,
            "pid": pid, "creation": entry["creation"], "deadline_monotonic": deadline}


def check_release(packet, expected, generation, pid, creation, deadline):
    need(packet == expected and set(packet) == {"invocation_id", "unit_invocation_id", "pid", "creation", "deadline_monotonic"}
         and packet["unit_invocation_id"] == generation and packet["pid"] == pid
         and packet["creation"] == creation, "inert entry release identity differs")
    bound = packet["deadline_monotonic"]
    need(type(bound) in (int, float) and 0 < bound <= deadline and time.monotonic() < bound,
         "original inert entry execution deadline expired")


def denial_observation(probe_result, started, ended):
    pid = probe_result.get("entry_pid")
    need(type(pid) is int and 0 < pid <= 4294967294
         and probe_result["entry"]["pid"] == pid
         and probe_result["entry"]["creation"]["pid"] == pid, "kernel observation process identity unavailable")
    need(type(started) is int and type(ended) is int and 0 < started <= ended <= started + 90,
         "kernel observation interval differs")
    # Read only matching AppArmor denials from this boot/time/PID window. No
    # whole-host journal is exported, no policy is changed and no retry occurs.
    reply = subprocess.run([
        "/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "--kill-after=2s", "8s",
        "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "/usr/bin/journalctl",
        "--dmesg", "--boot", "--no-pager", "--quiet", "--output=cat", "--lines=16",
        "--since=@" + str(started), "--until=@" + str(ended),
        '--grep=apparmor="DENIED".*[ \t]pid=' + str(pid) + r'(?=[ \t]|$).*[ \t]comm="bwrap"(?=[ \t]|$)',
    ], env=ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=12, check=False)
    need(len(reply.stdout) <= 8192 and len(reply.stderr) <= 2048, "filtered kernel evidence exceeds bound")
    return {"scope": "matching kernel messages, not independent process-creation attestation",
            "pid": pid, "creation": probe_result["entry"]["creation"], "started_unix": started,
            "ended_unix": ended, "exit": reply.returncode,
            "messages": reply.stdout.decode("utf-8", "replace").splitlines(),
            "stderr": reply.stderr.decode("utf-8", "replace"), "automatic_retry": False}


def check_namespace_policy(policy):
    need(policy["apparmor"] == "bwrap//&unpriv_bwrap (enforce)"
         and policy["NoNewPrivs"] == "1" and policy["userns_restriction"] == "1"
         and all(value == "0000000000000000" for value in policy["capabilities"].values())
         and set(policy["capabilities"]) == {"CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"},
         "actual namespace profile or privilege boundary differs")


def inert_entry(invocation):
    import pwd

    need(re.fullmatch(r"[a-f0-9]{64}", invocation), "fixed inert invocation differs")
    user = pwd.getpwnam(USER)
    need(os.getuid() == user.pw_uid > 0 and os.getgid() == user.pw_gid, "inert entry identity differs")
    deadline = time.monotonic() + 15
    supervisor = load_supervisor()
    attempt = GUEST / "invocations" / invocation
    home, ready = attempt / "work/home", attempt / "capture/ready.json"
    creation = supervisor["observe_root_creation"](os.getpid())
    supervisor["create_file"](attempt / "capture/entry.json", encode({"invocation_id": invocation, "pid": os.getpid(),
           "creation": creation, "policy": public_policy(), "authority": "none"}))
    # The trusted parent holds the actual unit generation/cgroup before release.
    # EOF, a wrong token or a late token never launches bubblewrap.
    packet = supervisor["decode"](wait_release(0, deadline))
    expected = supervisor["decode"](supervisor["read_regular"](attempt / "capture/release.json", 2048))
    need(packet["invocation_id"] == invocation, "inert entry invocation differs")
    check_release(packet, expected, os.environ.get("INVOCATION_ID"), os.getpid(),
                  supervisor["observe_root_creation"](os.getpid()), deadline)
    os.execve("/usr/bin/bwrap", [
        "/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-user",
        "--uid", str(user.pw_uid), "--gid", str(user.pw_gid), "--cap-drop", "ALL",
        "--bind", "/", "/", "--size", "536870912", "--tmpfs", str(home), "--chdir", str(home),
        "--setenv", "HOME", str(home), "--setenv", "TMPDIR", str(home), "--",
        "/usr/bin/python3", "-I", "-S", "-B", "-c", CHILD, str(home), str(ready),
    ], ENV)


def probe():
    import pwd

    user = pwd.getpwnam(USER)
    need(os.getuid() == user.pw_uid > 0 and os.getgid() == user.pw_gid, "separate qualification identity required")
    # Reuse the actual supervisor's resource and held-kernel-object checks.
    supervisor = load_supervisor()
    invocation = os.urandom(32).hex()
    attempt = GUEST / "invocations" / invocation
    for directory in (GUEST / "invocations", attempt, attempt / "work", attempt / "work/home", attempt / "capture"):
        directory.mkdir(mode=0o700)
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
            "--property=RestrictSUIDSGID=yes", "--", "/usr/bin/python3", "-I", "-S", "-B",
            str(INSTALLED / "qualify-hosted-native-linux.py"), "--entry", invocation,
        ], env=control, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
                      entry_pid=int(properties["MainPID"]),
                      cgroup={"device": group.identity[0], "inode": group.identity[1], "path": str(group.path)})
        while time.monotonic() < deadline and not (attempt / "capture/entry.json").exists() and process.poll() is None:
            time.sleep(0.05)
        entry = supervisor["read_marker"](attempt / "capture/entry.json", 8192)
        result["entry"] = entry
        binding = release_binding(supervisor, unit, generation, group, entry, invocation, deadline)
        retain(attempt / "capture/release.json", binding)
        need(time.monotonic() < readiness_deadline, "original inert entry admission deadline expired")
        process.stdin.write(encode(binding) + b"\n")
        process.stdin.flush()
        process.stdin.close()
        process.stdin = None
        while time.monotonic() < deadline and not ready.exists() and process.poll() is None:
            time.sleep(0.05)
        need(ready.exists(), "actual bubblewrap child did not report readiness")
        raw = ready.read_bytes()
        need(len(raw) <= 4096, "inert readiness exceeds bound")
        observed = json.loads(raw)
        need(observed["uid"] == user.pw_uid and observed["gid"] == user.pw_gid,
             "actual namespace account differs")
        check_namespace_policy(observed["policy"])
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
        if process is not None and process.stdin is not None:
            try:
                process.stdin.close()
            except OSError as error:
                result["entry_channel_close_failure"] = str(error)
            finally:
                process.stdin = None
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
        try:
            policy = attempt / "capture/entry.json"
            with policy.open("rb") as source:
                data = source.read(8193)
            need(len(data) <= 8192, "inert entry observation exceeds bound")
            observed_entry = json.loads(data)
            need(observed_entry == result.get("entry") and observed_entry["invocation_id"] == invocation
                 and observed_entry["pid"] == result.get("entry_pid"), "inert entry generation differs")
        except Exception as error:
            result["entry_readback_failure"] = str(error)
        result["passed"] = (result["failure"] is None and result["cgroup_empty"]
                            and result["unit_settled"] and "recovery_failure" not in result
                            and "cgroup_close_failure" not in result
                            and "entry_readback_failure" not in result
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
    context["profile_sha256"] = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
    context["profile_scope"] = "two add-only Ubuntu bwrap labels; global bwrap attachment on this disposable diagnostic host only"
    directory = begin_attempt(root, context, pins, git("rev-parse", "HEAD^{tree}"))
    result = {"stage": "tool-observation", "failure": None, "setup": None, "probe": None}
    try:
        for tool in ("/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/bin/sudo", "/usr/sbin/apparmor_parser"):
            need(Path(tool).is_file(), "required hosted primitive missing: " + tool)
        need(file_hash(root / "work/hosted-linux-package-evidence/bwrap-userns-restrict.apparmor") == context["profile_sha256"],
             "reviewed Ubuntu profile bytes differ")
        result["stage"] = "fixed-account-setup"
        result["setup"] = json.loads(command([
            "/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "--kill-after=2s", "70s",
            "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "/usr/bin/python3", "-I", "-S", "-B", "-c",
            ROOT_SETUP, str(root / "scripts"), json.dumps(pins), json.dumps(context),
        ], timeout=75))
        require_setup_readback(result["setup"], os.getuid())
        result["stage"] = "inert-boundary-probe"
        probe_started = int(time.time())
        reply = subprocess.run([
            "/usr/bin/sudo", "-n", "-H", "-u", USER, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin",
            "LANG=C.UTF-8", "HOME=/home/portcove-native", "/usr/bin/python3", "-I", "-S", "-B",
            str(INSTALLED / "qualify-hosted-native-linux.py"), "--probe",
        ], env=ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=75, check=False)
        need(len(reply.stdout) <= 65536 and len(reply.stderr) <= 8192, "probe output exceeds bound")
        result["probe_exit"] = reply.returncode
        result["probe_stderr"] = reply.stderr.decode("utf-8", "replace")
        result["probe"] = json.loads(reply.stdout)
        if reply.returncode != 0 and result["probe"].get("entry_pid") is not None:
            try:
                result["kernel_denials"] = denial_observation(result["probe"], probe_started, int(time.time()) + 1)
            except Exception as error:
                result["kernel_denial_readback_failure"] = str(error)
        need(reply.returncode == 0 and result["probe"]["passed"], "actual hosted primitive diagnostic failed")
        result["stage"] = "bounded-primitives-observed"
    except Exception as error:
        result["failure"] = str(error)
    finally:
        try:
            intent_path = INSTALLED / "profile-intent.json"
            complete_profile = bool(result.get("setup") and result["setup"].get("profile", {}).get("completed"))
            need(intent_path.exists() or not complete_profile, "completed root profile intent unavailable")
            if intent_path.exists():
                def read_profile_file(filename, maximum):
                    info = filename.lstat()
                    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                         and info.st_mode & 0o222 == 0 and info.st_size <= maximum, "root profile evidence custody differs")
                    with filename.open("rb") as source:
                        data = source.read(maximum + 1)
                    need(len(data) <= maximum, "root profile evidence exceeds bound")
                    return data
                intent = json.loads(read_profile_file(intent_path, 524288))
                need(intent["context"] == context and intent["source_sha256"] == pins,
                     "root profile evidence belongs to another attempt")
                result["profile_files"] = {}
                for name, maximum in (("profile-intent.json", 524288), ("profile-add-intent.json", 4096),
                                      ("profile-evidence.json", 524288), ("profile.expanded", 131072),
                                      ("profile.abi", 131072), ("profile.binary", 1048576)):
                    filename = INSTALLED / name
                    if filename.exists():
                        data = read_profile_file(filename, maximum)
                        with (directory / name).open("xb") as output:
                            output.write(data)
                        result["profile_files"][name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                if complete_profile:
                    need(len(result["profile_files"]) == 6
                         and result["profile_files"]["profile.binary"]["sha256"] == result["setup"]["profile"]["compiled_sha256"]
                         and result["profile_files"]["profile-evidence.json"]["sha256"] == result["setup"]["profile"]["evidence_sha256"],
                         "completed root profile evidence/hash readback differs")
        except Exception as error:
            result["profile_evidence_failure"] = str(error)
            result["failure"] = result["failure"] or "root profile evidence unavailable"
        result.update(authority="none", native_acceptance="not-established", production="held", automatic_retry=False)
        retain(directory / "result.json", result)
        print(json.dumps(result))
    return 0 if result["failure"] is None else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--entry":
        inert_entry(sys.argv[2])
    else:
        need(sys.argv[1:] in (["--prepare"], ["--probe"]), "fixed diagnostic operation required")
        sys.exit(probe() if sys.argv[1] == "--probe" else prepare())
