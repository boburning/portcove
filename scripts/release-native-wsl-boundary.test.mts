import assert from "node:assert/strict";
import test from "node:test";
import { nativeWslBootstrap } from "./release-native-wsl-bootstrap.mts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
void test(
  "fixed Windows registration reader parses without executing any registry or host observation",
  { skip: process.platform !== "win32" },
  () => {
    const filename = fileURLToPath(new URL("./read-native-wsl-host.ps1", import.meta.url));
    assert.equal(
      execFileSync(
        path.join(String(process.env.SystemRoot), "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${filename.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);if($errors.Count -gt 0){throw ($errors.Message -join '; ')}`,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
      ),
      "",
    );
  },
);
import {
  inspectNativeWslRegistration,
  inspectNativeWslGuestHost,
} from "./release-native-wsl-host.mts";
import {
  inspectNativeWslBoundary,
  nativeWslInvocationCommands,
} from "./release-native-wsl-boundary.mts";
function fixture() {
  const account = {
    kind: "windows-wsl-uid",
    broker: "S-1-5-21-1-2-3-1001",
    qualification: "1002",
    distribution: {
      name: "Ubuntu",
      registration_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      wsl_version: 2,
    },
  };
  const linux_root = "/home/portcove-native/portcove-native",
    controller = String.raw`E:\Portcove\controller`,
    capture = String.raw`E:\Portcove\native-capture`;
  const paths = {
    bwrap: "/usr/bin/bwrap",
    git: "/usr/bin/git",
    python: "/usr/bin/python3",
    systemctl: "/usr/bin/systemctl",
    systemd_run: "/usr/bin/systemd-run",
    xvfb: "/usr/bin/Xvfb",
    webkit_driver: "/usr/bin/WebKitWebDriver",
    node: `${linux_root}/tools/node`,
    tauri_driver: `${linux_root}/tools/tauri-driver`,
    wsl: String.raw`C:\Windows\System32\wsl.exe`,
  };
  return {
    account,
    controller,
    capture,
    value: {
      schema_version: 1,
      broker_sid: account.broker,
      distribution: account.distribution,
      qualification_uid: account.qualification,
      qualification_gid: "1002",
      qualification_user: "portcove-native",
      controller_root: controller,
      capture_root: capture,
      linux_root,
      supervisor_sha256: "a".repeat(64),
      tools: Object.fromEntries(
        Object.entries(paths).map(([name, path]) => [name, { path, sha256: "b".repeat(64) }]),
      ),
    },
  };
}
void test("fixed registration and root-owned guest observations keep actual identity, minimum kernel and Ubuntu scope distinct", () => {
  const f = fixture(),
    boundary = inspectNativeWslBoundary(f.value, f.account, f.controller, f.capture),
    invocation = "a".repeat(64);
  const registration = {
    registration_id: boundary.distribution.registration_id,
    name: boundary.distribution.name,
    wsl_version: 2,
    default_uid: 1000,
  };
  const raw = {
    schema_version: 1,
    broker_sid: boundary.broker_sid,
    reader_pid: 20,
    parent_pid: 10,
    observed_at: "2026-10-21T00:00:00.000Z",
    before: registration,
    after: { ...registration },
    mutations: "none",
  };
  assert.equal(inspectNativeWslRegistration(raw, boundary, 10).authority, "none");
  for (const change of [
    { broker_sid: "S-1-5-21-0-0-0-1000" },
    { parent_pid: 11 },
    { after: { ...registration, wsl_version: 1 } },
    {
      before: { ...registration, registration_id: "f".repeat(36) },
      after: { ...registration, registration_id: "f".repeat(36) },
    },
  ])
    assert.throws(() => inspectNativeWslRegistration({ ...raw, ...change }, boundary, 10));
  const guest = {
      schema_version: 1,
      invocation_id: invocation,
      qualification_uid: 1002,
      qualification_gid: 1002,
      machine_id_sha256: "b".repeat(64),
      os_release: 'ID=ubuntu\nVERSION_ID="24.04"\n',
      kernel_release: "6.8.0-60-generic",
      architecture: "x86_64",
      authority: "none",
    },
    expected = { machine_id_sha256: "b".repeat(64), minimum_os_version: "6.8" };
  assert.equal(inspectNativeWslGuestHost(guest, boundary, invocation, expected).authority, "none");
  for (const change of [
    { qualification_uid: 0 },
    { machine_id_sha256: "c".repeat(64) },
    { os_release: 'ID=ubuntu\nVERSION_ID="25.04"\n' },
    { kernel_release: "6.6.87.2-microsoft-standard-WSL2" },
    { architecture: "aarch64" },
  ])
    assert.throws(() =>
      inspectNativeWslGuestHost({ ...guest, ...change }, boundary, invocation, expected),
    );
});
void test("WSL boundary keeps Windows broker, guest UID/distro and fixed read-only tool routes separate", () => {
  const f = fixture(),
    actual = inspectNativeWslBoundary(f.value, f.account, f.controller, f.capture);
  assert.equal(actual.authority, "none");
  for (const changed of [
    { ...f.value, qualification_uid: "0" },
    { ...f.value, broker_sid: "1000" },
    { ...f.value, qualification_gid: "0" },
    { ...f.value, qualification_user: "1002" },
    { ...f.value, qualification_user: "root" },
    {
      ...f.value,
      distribution: {
        ...f.account.distribution,
        registration_id: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
    },
    { ...f.value, linux_root: "/mnt/e/Portcove" },
    { ...f.value, linux_root: "/tmp/portcove-native" },
    { ...f.value, tools: { ...f.value.tools, wsl: { path: "wsl.exe", sha256: "b".repeat(64) } } },
    { ...f.value, supervisor_sha256: "unknown" },
    { ...f.value, accepted: true },
  ])
    assert.throws(() => inspectNativeWslBoundary(changed, f.account, f.controller, f.capture));
  assert.throws(() =>
    inspectNativeWslBoundary(
      f.value,
      { kind: "linux-uid", broker: "1000", qualification: "1002" },
      f.controller,
      f.capture,
    ),
  );
  f.account.qualification = "1003";
  f.value.tools.wsl!.path = "foreign.exe";
  assert.equal(actual.account.qualification, "1002");
  assert.equal(actual.tools.wsl!.path, String.raw`C:\Windows\System32\wsl.exe`);
});
void test("fixed Python bootstrap checks source before import and executes captured verified bytes after clean source read", () => {
  const harness = String.raw`
import hashlib,json,os,stat,subprocess,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
code=json.loads(sys.stdin.read())
root='/home/qualification/portcove-native'
source=root+'/controller/scripts/native-qualification-linux-transfer.py'
with tempfile.TemporaryDirectory() as directory:
 files={name:Path(directory)/str(index) for index,name in enumerate(('/usr/bin/python3','/proc/self/exe','/usr/bin/git',source))}
 for name,p in files.items(): p.write_bytes(b'python' if name in ('/usr/bin/python3','/proc/self/exe') else b'git' if name=='/usr/bin/git' else b"raise RuntimeError('verified inert entry reached')")
 digest=lambda data:hashlib.sha256(data).hexdigest()
 actual_open=os.open;actual_stat=os.fstat
 def opened(name,flags): return actual_open(files[name],flags & ~getattr(os,'O_NOFOLLOW',0))
 def stated(fd):
  s=actual_stat(fd)
  return SimpleNamespace(st_mode=stat.S_IFREG|0o400,st_uid=0,st_dev=s.st_dev,st_ino=s.st_ino,st_size=s.st_size,st_mtime_ns=s.st_mtime_ns,st_ctime_ns=s.st_ctime_ns)
 for mode in ('changed-source','dirty-tree','captured-bytes'):
  calls=[]
  files[source].write_bytes(b"raise RuntimeError('verified inert entry reached')")
  source_sha=digest(files[source].read_bytes()) if mode!='changed-source' else 'f'*64
  argv=['-c',code,root,'1002','1002','transfer',source_sha,digest(b'python'),digest(b'git'),'a'*40,'b'*40,'--mode','capture','--invocation','c'*64]
  def run(args,**kwargs):
   calls.append(args)
   result=b'a'*40 if args[-1]=='HEAD' else b'b'*40 if args[-1]=='HEAD^{tree}' else b' M changed' if mode=='dirty-tree' else b''
   files[source].write_bytes(b"raise RuntimeError('substituted source ran')")
   return SimpleNamespace(returncode=0,stdout=result,stderr=b'')
  with patch.object(sys,'argv',argv),patch.object(os,'getuid',lambda:1002,create=True),patch.object(os,'getgid',lambda:1002,create=True),patch.object(os.path,'realpath',lambda p:p),patch.object(os,'O_NOFOLLOW',getattr(os,'O_NOFOLLOW',0),create=True),patch.object(os,'O_NONBLOCK',getattr(os,'O_NONBLOCK',0),create=True),patch.object(os,'open',opened),patch.object(os,'fstat',stated),patch.object(subprocess,'run',run):
   try: exec(compile(code,'<fixed-bootstrap>','exec'),{})
   except RuntimeError as error:
    expected={'changed-source':'fixed guest entry source differs before execution','dirty-tree':'fixed controller source/tree is not clean','captured-bytes':'verified inert entry reached'}[mode]
    assert str(error)==expected,(mode,str(error))
   else: raise AssertionError('bootstrap did not refuse/execute inert fixture')
  assert len(calls)==(0 if mode=='changed-source' else 3)
`;
  assert.equal(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-S", "-B", "-c", harness],
      {
        input: JSON.stringify(nativeWslBootstrap),
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 65536,
      },
    ),
    "",
  );
});
void test("prepared WSL lifecycle commands bind exact guest user, supervisor, original invocation and shared unit without claiming host acceptance", () => {
  const f = fixture(),
    boundary = inspectNativeWslBoundary(f.value, f.account, f.controller, f.capture),
    invocation = "c".repeat(64),
    requestSha = "d".repeat(64);
  const pins = {
    supervisor_sha256: boundary.supervisor_sha256,
    transfer_sha256: "e".repeat(64),
    controller_revision: "f".repeat(40),
    controller_tree: "1".repeat(40),
  };
  const plan = nativeWslInvocationCommands(boundary, invocation, requestSha, pins);
  assert.ok(
    plan.run.arguments.join(" ").length < 30000,
    "fixed bootstrap fits Windows command-line bound",
  );
  assert.equal(plan.tasks_max, 64);
  assert.equal(plan.timeout_seconds, 1800);
  assert.equal(plan.authority, "none");
  for (const [mode, command] of Object.entries({
    run: plan.run,
    readback: plan.readback,
    settle: plan.settle,
  })) {
    assert.deepEqual(command.arguments, [
      "--distribution",
      "Ubuntu",
      "--user",
      "portcove-native",
      "--exec",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-B",
      "-c",
      nativeWslBootstrap,
      nativeWslBootstrap,
      boundary.linux_root,
      "1002",
      "1002",
      "outer",
      pins.supervisor_sha256,
      "b".repeat(64),
      "b".repeat(64),
      pins.controller_revision,
      pins.controller_tree,
      "--mode",
      mode,
      "--invocation",
      invocation,
      "--request-sha256",
      requestSha,
    ]);
    assert.equal(command.credential_input, "none");
  }
  const stage = plan.stage("plan", 4, "f".repeat(64));
  const header: unknown = JSON.parse(stage.header);
  assert.ok(header && typeof header === "object" && "entry" in header);
  assert.equal(header.entry, "plan");
  assert.ok(stage.arguments.includes(pins.transfer_sha256));
  assert.equal(stage.arguments.at(-2), "--header-sha256");
  assert.throws(() => plan.stage("application", 512 * 1024 * 1024 + 1, "f".repeat(64)));
  assert.deepEqual(plan.required_candidate_absence, [
    "/init",
    "/mnt",
    "/run/WSL",
    "/run/user",
    "WSL_INTEROP",
  ]);
  assert.throws(() => nativeWslInvocationCommands(boundary, "current", requestSha, pins));
  assert.throws(() => nativeWslInvocationCommands(boundary, invocation, "unknown", pins));
});
