/** Original hosted-parent -> fixed credential-free Linux capture. Detached
 * recipes and imported wire data never acquire this module's private brand. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { requireActualHostedNativeLinuxRequest } from "./release-hosted-native-linux-request.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { inspectHostedLinuxDriverPlan } from "./release-hosted-native-linux-driver.mts";
import { readNativeSchedulerToolDigest } from "./release-native-scheduler.mts";
import { inspectHostedNativeLinuxHost } from "./release-native-wsl-host.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  hashRetainedNativeCaptureFile,
  retainNativeCaptureWire,
} from "./release-native-wsl-wire.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { isRecord } from "./runtime-values.mts";
import {
  requireHostedNativeRuntime,
  hostedNativeSupportDependencies,
} from "./release-hosted-native-runtime.mts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const guest = "/home/portcove-native/portcove-native";
const mib = 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const attempted = new WeakSet<object>();
type ActualRequest = Awaited<ReturnType<typeof requireActualHostedNativeLinuxRequest>>;
type Parent = Awaited<ReturnType<typeof requireActualHostedNativeParentSource>>;
type Capture = {
  request: object;
  runtime?: object;
  snapshot: string;
  files: Map<string, { bytes: number; sha256: string }>;
  resource_status: number;
  retained: Awaited<ReturnType<typeof retainNativeCaptureWire>> | null;
  wire_sha256: string | null;
  stopped: boolean;
};
const captures = new WeakMap<object, Capture>();

// Trusted parent source, never imported from the installed or candidate tree.
// Only a fixed, bounded inventory is exposed across the private-home boundary.
export const hostedLinuxInventorySource = String.raw`
import hashlib,json,os,re,stat,subprocess,sys,selectors,signal,time
from pathlib import Path
root=Path('/home/portcove-native/portcove-native');uid,gid,commit,tree,harness,harness_sha=sys.argv[1:]
deadline=time.monotonic()+15
def need(ok,message):
 if not ok: raise RuntimeError(message)
need(re.fullmatch(r'[1-9][0-9]{0,9}',uid) and re.fullmatch(r'[1-9][0-9]{0,9}',gid) and os.getuid()==int(uid) and os.getgid()==int(gid),'fixed inventory identity differs')
need(all(re.fullmatch(r'[a-f0-9]{40}',v) for v in (commit,tree)) and re.fullmatch(r'[a-f0-9]{64}',harness_sha),'fixed native source pins differ')
need(harness=='apps/desktop/scripts/desktop-test.mts','fixed native harness path differs')
def read(filename,maximum,owners):
 actual=filename.resolve(strict=True)
 need(actual==filename or str(filename).startswith('/usr/bin/'),'fixed inventory path resolves outside supported tools')
 for item in (actual,*actual.parents):
  info=item.lstat();need(not stat.S_ISLNK(info.st_mode) and info.st_uid in owners and not info.st_mode&0o022,'fixed inventory ancestry differs')
 fd=os.open(actual,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=maximum,'fixed inventory file bound differs')
  data=b''
  while len(data)<=maximum:
   need(time.monotonic()<deadline,'fixed inventory deadline expired')
   part=os.read(fd,min(65536,maximum+1-len(data)))
   if not part: break
   data+=part
  after=os.fstat(fd);again=actual.lstat()
  identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_uid,s.st_mode,s.st_nlink)
  need(len(data)==before.st_size and identity(before)==identity(after)==identity(again),'fixed inventory file changed')
  need(filename.resolve(strict=True)==actual,'fixed inventory symlink changed')
  return data
 finally: os.close(fd)
env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(root),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0'}
def git(args,maximum=65536):
 until=min(deadline,time.monotonic()+5);need(until>time.monotonic(),'fixed inventory deadline expired')
 p=subprocess.Popen(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',str(root/'controller'),*args],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 selector=selectors.DefaultSelector();data={'stdout':bytearray(),'stderr':bytearray()};settled=False
 try:
  for name in data:
   stream=getattr(p,name);os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,name)
  while selector.get_map():
   need(time.monotonic()<until,'fixed inventory Git deadline expired')
   for event,_ in selector.select(min(0.1,max(0,until-time.monotonic()))):
    chunk=os.read(event.fd,65536)
    if not chunk: selector.unregister(event.fileobj);continue
    limit=maximum if event.data=='stdout' else 4096
    need(len(data[event.data])+len(chunk)<=limit,'fixed native inventory Git output exceeded bound')
    data[event.data].extend(chunk)
  code=p.wait(timeout=max(0.01,until-time.monotonic()));settled=True
  need(code==0 and time.monotonic()<until,'fixed native inventory Git read refused');return bytes(data['stdout'])
 finally:
  selector.close()
  if not settled:
   # Original direct child is still unreaped, so its group cannot be reused.
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   p.wait(timeout=1)
  p.stdout.close();p.stderr.close()
need(git(['rev-parse','HEAD']).decode().strip()==commit and git(['rev-parse','HEAD^{tree}']).decode().strip()==tree and not git(['status','--porcelain','--untracked-files=all']),'installed native source/tree is not clean')
names={'supervisor':'scripts/native-qualification-linux-supervisor.py','support':'scripts/semantic-review-linux-supervisor.py','driver':'scripts/release-native-linux-driver.mts','transfer':'scripts/native-qualification-linux-transfer.py','init':'apps/desktop/scripts/native-linux-isolated-init.py','harness':harness}
pins={}
for name,filename in names.items():
 data=read(root/'controller'/filename,1024*1024,(0,int(uid)))
 need(data==git(['show',commit+':'+filename],1024*1024),'installed native source bytes differ from Git blob')
 pins[name]=hashlib.sha256(data).hexdigest()
need(pins['harness']==harness_sha,'independently configured native harness differs')
paths={'python':'/usr/bin/python3','git':'/usr/bin/git','bwrap':'/usr/bin/bwrap','systemd_run':'/usr/bin/systemd-run','systemctl':'/usr/bin/systemctl','node':str(root/'tools/node'),'driver':str(root/'tools/tauri-driver'),'webkit_driver':'/usr/bin/WebKitWebDriver','xvfb':'/usr/bin/Xvfb'}
tools={name:{'path':filename,'sha256':hashlib.sha256(read(Path(filename),256*1024*1024,(0,int(uid)) if filename.startswith(str(root)+'/') else (0,))).hexdigest()} for name,filename in paths.items()}
need(git(['rev-parse','HEAD']).decode().strip()==commit and git(['rev-parse','HEAD^{tree}']).decode().strip()==tree and not git(['status','--porcelain','--untracked-files=all']),'installed native source changed during inventory')
need(time.monotonic()<deadline,'fixed inventory deadline expired')
print(json.dumps({'schema_version':1,'source_commit':commit,'source_tree':tree,'uid':int(uid),'gid':int(gid),'source_pins':pins,'tools':tools,'children_settled':True,'authority':'none'},separators=(',',':')))
`;

async function observeInventory(actual: ActualRequest, parent: Parent, arguments_: string[]) {
  const stdout = openSync(
    path.join(actual.directory, "hosted-linux-inventory.stdout.bin"),
    "wx",
    0o600,
  );
  let stderr: number;
  try {
    stderr = openSync(
      path.join(actual.directory, "hosted-linux-inventory.stderr.bin"),
      "wx",
      0o600,
    );
  } catch (error) {
    closeSync(stdout);
    throw error;
  }
  const streams = { stdout, stderr };
  let failure: string | null = null,
    closed = false,
    finished = false,
    status: number | null = null;
  const totals = { stdout: 0, stderr: 0 };
  let escalation: ReturnType<typeof setTimeout> | undefined,
    drainage: ReturnType<typeof setTimeout> | undefined;
  let rejectDrain: (error: Error) => void = () => {};
  const forced = new Promise<never>((_resolve, reject) => {
    rejectDrain = reject;
  });
  let child;
  try {
    child = spawn("/usr/bin/sudo", arguments_, {
      cwd: actual.directory,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: actual.directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    closeSync(stdout);
    closeSync(stderr);
    throw error;
  }
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (!closed) {
      try {
        child.kill(signal);
      } catch {
        /* Original child closure stays unknown. */
      }
    }
  };
  const refuse = (reason: string) => {
    if (finished) return;
    failure ??= reason;
    if (escalation || drainage) return;
    kill("SIGTERM");
    escalation = setTimeout(() => {
      kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
    drainage = setTimeout(
      () => rejectDrain(new Error("fixed inventory child closure remains unknown")),
      3000,
    );
  };
  for (const side of ["stdout", "stderr"] as const)
    child[side].on("data", (bytes: Buffer) => {
      if (finished) return;
      try {
        const piece = bytes.subarray(0, Math.max(0, 65536 - totals[side]));
        for (let offset = 0; offset < piece.length;) {
          const written = writeSync(streams[side], piece, offset);
          assert.ok(written > 0);
          offset += written;
        }
        totals[side] += bytes.length;
        if (totals[side] > 65536) refuse("fixed inventory output exceeded bound");
      } catch {
        refuse("fixed inventory retention failed");
      }
    });
  const terminal = new Promise<void>((resolve) => {
    child.once("error", () => refuse("fixed inventory process refused"));
    child.once("close", (code) => {
      status = code;
      closed = true;
      resolve();
    });
  });
  const timer = setTimeout(
    () => refuse("original fixed inventory deadline expired"),
    Math.max(1, Math.floor(Math.min(20000, parent.deadline - performance.now() - 3000))),
  );
  try {
    await Promise.race([terminal, forced]);
    parent.recheck();
    assert.ok(closed && status === 0 && failure === null, "fixed inventory refused or not settled");
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(drainage);
    child.stdout.destroy();
    child.stderr.destroy();
    for (const descriptor of Object.values(streams)) closeSync(descriptor);
    await writeFile(
      path.join(actual.directory, "hosted-linux-inventory-settlement.json"),
      JSON.stringify({
        status,
        closed,
        failure,
        totals,
        automatic_retry: false,
        authority: "none",
        child_tree:
          closed && status === 0 && failure === null
            ? "require fixed probe joined-child assertion"
            : "unknown",
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  return readBoundedPublicBuildInputFile(
    actual.directory,
    "hosted-linux-inventory.stdout.bin",
    65536,
  );
}

/** Pure lifetime calculation only. Admission waiting consumes this original
 * deadline; neither the child nor a later readback can renew it. */
export function hostedLinuxCaptureLifetime(original: number, now: number, wall: number) {
  assert.ok([original, now, wall].every(Number.isFinite));
  const available = Math.floor(original - now - 30000);
  assert.ok(
    available > 210000 && available <= 1900000,
    "original native lifetime lacks recovery reserve",
  );
  return {
    deadline_utc: new Date(wall + available).toISOString(),
    timeout_seconds: Math.floor(Math.min(1800000, available - 150000) / 1000),
  };
}

async function tool(filename: string, owners: readonly number[], active: () => void) {
  active();
  const resolved = await realpath(filename);
  for (let current = resolved; ; current = path.posix.dirname(current)) {
    const info = await lstat(current);
    assert.ok(
      !info.isSymbolicLink() && owners.includes(info.uid) && (info.mode & 0o022) === 0,
      "fixed Linux tool custody differs",
    );
    if (current === "/") break;
  }
  const sha256 = await readNativeSchedulerToolDigest(resolved, 256 * mib);
  active();
  return { path: filename, sha256 };
}

/** Serialization helper is intentionally not exported. Its inputs come only
 * from the same-process original request and observed fixed host/tool paths. */
async function prepare(actual: ActualRequest, parent: Parent, controllerRoot = root) {
  assert.ok(parent.configuration.purpose === "application");
  const request = actual.prepared.request;
  assert.equal(request.stage, "payload-signing");
  assert.equal(request.platform_label, "linux-x86_64");
  const selected = request.expected.producer;
  hostedLinuxCaptureLifetime(parent.deadline, performance.now(), Date.now());
  const uid = Number(actual.host.projection.account.qualification),
    gid = Number(actual.host.observed.qualification_gid);
  const hostTools = Object.fromEntries(
    await Promise.all(
      Object.entries({
        python: "/usr/bin/python3",
        git: "/usr/bin/git",
        sudo: "/usr/bin/sudo",
      }).map(
        async ([name, filename]) => [name, await tool(filename, [0], parent.recheck)] as const,
      ),
    ),
  );
  const node = await tool(process.execPath, [0, process.getuid!()], parent.recheck);
  const inventory = await observeInventory(actual, parent, [
    "-n",
    "-H",
    "-u",
    "portcove-native",
    "--",
    "/usr/bin/python3",
    "-I",
    "-S",
    "-B",
    "-c",
    hostedLinuxInventorySource,
    String(uid),
    String(gid),
    selected.source_commit,
    selected.source_tree,
    selected.harness.path,
    selected.harness.sha256,
  ]);
  parent.recheck();
  const observed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inventory));
  assert.ok(
    isRecord(observed) &&
      observed.schema_version === 1 &&
      observed.authority === "none" &&
      observed.children_settled === true &&
      observed.source_commit === selected.source_commit &&
      observed.source_tree === selected.source_tree &&
      observed.uid === uid &&
      observed.gid === gid &&
      isRecord(observed.source_pins) &&
      isRecord(observed.tools),
  );
  const pins = observed.source_pins;
  assert.equal(
    Object.keys(pins).sort().join(","),
    "driver,harness,init,supervisor,support,transfer",
  );
  for (const value of Object.values(pins)) assert.match(String(value), /^[a-f0-9]{64}$/u);
  assert.equal(pins.harness, selected.harness.sha256);
  const tools = observed.tools as Record<string, { path: string; sha256: string }>;
  assert.equal(
    Object.keys(tools).sort().join(","),
    "bwrap,driver,git,node,python,systemctl,systemd_run,webkit_driver,xvfb",
  );
  for (const [name, value] of Object.entries(hostTools))
    if (name !== "sudo") assert.deepEqual(tools[name], value);
  tools.sudo = hostTools.sudo!;
  const lifetime = hostedLinuxCaptureLifetime(parent.deadline, performance.now(), Date.now());
  const invocation = request.invocation_id,
    attempt = `${guest}/invocations/${invocation}`;
  const binding = {
    schema_version: 1,
    invocation_id: invocation,
    linux_root: guest,
    account: { uid, gid },
    application: { path: `${attempt}/install/Portcove.AppImage`, ...request.candidate.package },
    controller: {
      root: `${guest}/controller`,
      source_commit: selected.source_commit,
      source_tree: selected.source_tree,
      init_sha256: pins.init,
    },
    tools: Object.fromEntries(
      ["python", "git", "bwrap", "node", "driver", "webkit_driver", "xvfb"].map((name) => [
        name,
        tools[name],
      ]),
    ),
    capture_root: `${attempt}/capture`,
    home: `${attempt}/work/home`,
    deadline_utc: lifetime.deadline_utc,
  };
  // Package filenames are transport identity, not fields of the installed binding.
  const application = {
    path: binding.application.path,
    bytes: request.candidate.package.bytes,
    sha256: request.candidate.package.sha256,
  };
  const plan = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      stage: "payload-signing",
      stage_request_sha256: actual.prepared.request_sha256,
      binding: { ...binding, application },
    }),
  );
  const outer = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      stage_request_sha256: actual.prepared.request_sha256,
      qualification_uid: uid,
      qualification_gid: gid,
      controller: { source_commit: selected.source_commit, source_tree: selected.source_tree },
      plan_sha256: hash(plan),
      supervisor_sha256: pins.supervisor,
      support_sha256: pins.support,
      driver_sha256: pins.driver,
      tools_sha256: Object.fromEntries(
        ["python", "bwrap", "systemd_run", "systemctl", "node", "git"].map((name) => [
          name,
          tools[name]!.sha256,
        ]),
      ),
      ...lifetime,
    }),
  );
  const driver = {
    schema_version: 1,
    broker_uid: actual.host.projection.account.broker,
    qualification_uid: String(uid),
    qualification_gid: String(gid),
    capture_directory: actual.directory,
    controller_root: controllerRoot,
    invocation_id: invocation,
    deadline_utc: lifetime.deadline_utc,
    entry_pins: {
      supervisor_sha256: pins.supervisor,
      transfer_sha256: pins.transfer,
      controller_revision: selected.source_commit,
      controller_tree: selected.source_tree,
    },
    node,
    tools: Object.fromEntries(["python", "git", "sudo"].map((name) => [name, tools[name]])),
    host_expected: {
      machine_id_sha256: actual.host.observed.machine_id_sha256,
      minimum_os_version:
        parent.configuration.hosted_native["linux-x86_64"].compatibility.minimum_os_version,
    },
    request_sha256: hash(outer),
    plan_sha256: hash(plan),
    stage_request_sha256: actual.prepared.request_sha256,
    packages: [
      {
        entry: "application",
        path: actual.package_path,
        bytes: application.bytes,
        sha256: application.sha256,
      },
    ],
  };
  inspectHostedLinuxDriverPlan(driver);
  return {
    outer,
    plan,
    driver: Buffer.from(JSON.stringify(driver)),
    observation: Buffer.from(
      JSON.stringify({
        tools,
        node,
        source_pins: pins,
        authority: "none",
        native_acceptance: "not-established",
      }),
    ),
  };
}

export async function captureActualHostedNativeLinuxInvocation(
  requestReceipt: object,
  runtimeReceipt?: object,
) {
  assert.ok(
    !attempted.has(requestReceipt),
    "one original Linux capture; explicit recovery required",
  );
  attempted.add(requestReceipt);
  let actual = await requireActualHostedNativeLinuxRequest(requestReceipt);
  const parent = await requireActualHostedNativeParentSource(actual.parent_source);
  const runtime =
    runtimeReceipt === undefined
      ? undefined
      : await requireHostedNativeRuntime(runtimeReceipt, actual.parent_source);
  const controllerRoot = runtime?.root ?? root;
  assert.ok(parent.configuration.purpose === "application");
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(String(process.getuid?.()), actual.host.projection.account.broker);
  assert.equal(parent.platform_label, "linux-x86_64");
  assert.equal(parent.stage, "payload-signing");
  const files = new Map<string, { bytes: number; sha256: string }>();
  const put = async (name: string, bytes: Buffer) => {
    assert.ok(bytes.length > 0 && bytes.length <= 128 * 1024);
    parent.recheck();
    await writeFile(path.join(actual.directory, name), bytes, { flag: "wx", mode: 0o600 });
    files.set(name, { bytes: bytes.length, sha256: hash(bytes) });
    parent.recheck();
  };
  let phase = "fixed-tools-and-source";
  try {
    const prepared = await prepare(actual, parent, controllerRoot);
    await put("native-request.json", prepared.outer);
    await put("native-plan.json", prepared.plan);
    await put("hosted-linux-driver-plan.json", prepared.driver);
    await put("hosted-linux-tool-observation.json", prepared.observation);
    const inventorySettlement = await readBoundedPublicBuildInputFile(
      actual.directory,
      "hosted-linux-inventory-settlement.json",
      8192,
    );
    files.set("hosted-linux-inventory-settlement.json", {
      bytes: inventorySettlement.length,
      sha256: hash(inventorySettlement),
    });
    for (const side of ["stdout", "stderr"]) {
      const name = `hosted-linux-inventory.${side}.bin`;
      const info = await lstat(path.join(actual.directory, name));
      const sha256 = await hashRetainedNativeCaptureFile(
        actual.directory,
        name,
        65536,
        info.size,
        parent.deadline,
      );
      files.set(name, { bytes: info.size, sha256 });
    }
    actual = await requireActualHostedNativeLinuxRequest(requestReceipt);
    phase = "resource-admission-and-capture";
    const signal = new EventEmitter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number;
    try {
      status = await runResourceCommand(
        "analysis",
        process.execPath,
        [
          path.join(controllerRoot, "scripts/release-hosted-native-linux-driver.mts"),
          "--driver",
          path.join(actual.directory, "hosted-linux-driver-plan.json"),
          hash(prepared.driver),
        ],
        {
          cwd: controllerRoot,
          environment: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: actual.directory,
            TMPDIR: actual.directory,
            ...(runtime ? { GITHUB_ACTIONS: "true", RUNNER_TEMP: actual.directory } : {}),
          },
          exclusive: [`native-linux:${actual.host.projection.account.qualification}`],
          queueDeadline: parent.deadline - 210000,
          supervise: async (args, options) => {
            const support =
              runtimeReceipt === undefined
                ? {}
                : await hostedNativeSupportDependencies(
                    runtimeReceipt,
                    actual.parent_source,
                    actual.directory,
                  );
            return runRustTests(args, {
              ...options,
              ...support,
              tempRoot: actual.directory,
              signalTarget: signal,
              acquireLock: async (metadata, admission) => {
                assert.ok(options.acquireLock);
                const lease = await options.acquireLock(metadata, admission);
                try {
                  await requireActualHostedNativeLinuxRequest(requestReceipt);
                  if (runtimeReceipt !== undefined)
                    await requireHostedNativeRuntime(runtimeReceipt, actual.parent_source);
                  parent.recheck();
                  timer = setTimeout(
                    () => signal.emit("SIGTERM"),
                    Math.max(1, parent.deadline - performance.now()),
                  );
                  return lease;
                } catch (error) {
                  await lease.release();
                  throw error;
                }
              },
            });
          },
        },
      );
    } finally {
      clearTimeout(timer);
    }
    phase = "original-capture-readback";
    if (runtimeReceipt !== undefined)
      await requireHostedNativeRuntime(runtimeReceipt, actual.parent_source);
    actual = await requireActualHostedNativeLinuxRequest(requestReceipt);
    const summaryBytes = await readBoundedPublicBuildInputFile(
      actual.directory,
      "hosted-linux-capture-summary.json",
      128 * 1024,
    );
    const summary: unknown = JSON.parse(summaryBytes.toString("utf8"));
    assert.ok(isRecord(summary));
    assert.equal(summary.invocation_id, actual.prepared.request.invocation_id);
    assert.equal(summary.request_sha256, hash(prepared.outer));
    assert.equal(summary.stage_request_sha256, actual.prepared.request_sha256);
    assert.ok(
      summary.operation_children_settled === true &&
        isRecord(summary.readback) &&
        summary.readback.invocation_id === actual.prepared.request.invocation_id &&
        summary.readback.request_sha256 === hash(prepared.outer) &&
        summary.readback.cgroup_empty === true &&
        summary.readback.unit_settled === true,
      "original Linux closure remains unknown; preserve attempt without branding",
    );
    files.set("hosted-linux-capture-summary.json", {
      bytes: summaryBytes.length,
      sha256: hash(summaryBytes),
    });
    for (const side of ["before", "after"]) {
      const name = `host-${side}.stdout.bin`;
      const bytes = await readBoundedPublicBuildInputFile(actual.directory, name, 65536);
      assert.equal(hash(bytes), summary[`host_${side}_sha256`]);
      inspectHostedNativeLinuxHost(
        JSON.parse(bytes.toString("utf8")),
        {
          account: { qualification: actual.host.projection.account.qualification },
          qualification_gid: String(actual.host.observed.qualification_gid),
        },
        actual.prepared.request.invocation_id,
        {
          machine_id_sha256: actual.host.observed.machine_id_sha256,
          minimum_os_version:
            parent.configuration.hosted_native["linux-x86_64"].compatibility.minimum_os_version,
        },
      );
      files.set(name, { bytes: bytes.length, sha256: hash(bytes) });
    }
    assert.equal(summary.capture_wire, path.join(actual.directory, "native-capture.stdout.bin"));
    const wire = await hashRetainedNativeCaptureFile(
      actual.directory,
      "native-capture.stdout.bin",
      272 * mib,
      undefined,
      parent.deadline,
    );
    const retained = await retainNativeCaptureWire(
      String(summary.capture_wire),
      path.join(actual.directory, "native-capture"),
      actual.prepared.request.invocation_id,
      wire,
      parent.deadline,
    );
    await requireActualHostedNativeLinuxRequest(requestReceipt);
    parent.recheck();
    const receipt = Object.freeze({
      kind: "actual-hosted-linux-capture",
      authority: "none",
      native_acceptance: "not-established",
    });
    captures.set(receipt, {
      request: requestReceipt,
      runtime: runtimeReceipt,
      snapshot: JSON.stringify(receipt),
      files,
      resource_status: status,
      retained,
      wire_sha256: wire,
      stopped: false,
    });
    return receipt;
  } catch (error) {
    await writeFile(
      path.join(actual.directory, "hosted-linux-capture-refusal.json"),
      JSON.stringify({
        phase,
        automatic_retry: false,
        effects: "retain and use original readback/recovery; response is not absence of effects",
        authority: "none",
        native_acceptance: "not-established",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted Linux capture refused at ${phase}; retain ${actual.directory}`, {
      cause: error,
    });
  }
}

export async function requireActualHostedNativeLinuxCapture(receipt: object) {
  const retained = captures.get(receipt);
  if (!retained || retained.stopped || retained.snapshot !== JSON.stringify(receipt))
    throw new Error("original active hosted Linux capture required");
  try {
    const actual = await requireActualHostedNativeLinuxRequest(retained.request);
    const parent = await requireActualHostedNativeParentSource(actual.parent_source);
    if (retained.runtime !== undefined)
      await requireHostedNativeRuntime(retained.runtime, actual.parent_source);
    for (const [name, identity] of retained.files)
      assert.equal(
        await hashRetainedNativeCaptureFile(
          actual.directory,
          name,
          128 * 1024,
          identity.bytes,
          parent.deadline,
        ),
        identity.sha256,
        "original capture bytes changed",
      );
    if (retained.wire_sha256 !== null)
      assert.equal(
        await hashRetainedNativeCaptureFile(
          actual.directory,
          "native-capture.stdout.bin",
          272 * mib,
          undefined,
          parent.deadline,
        ),
        retained.wire_sha256,
      );
    if (retained.retained)
      for (const entry of retained.retained.entries)
        assert.equal(
          await hashRetainedNativeCaptureFile(
            retained.retained.directory,
            entry.path,
            32 * mib,
            entry.bytes,
            parent.deadline,
          ),
          entry.sha256,
        );
    const summary = await readBoundedPublicBuildInputFile(
      actual.directory,
      "hosted-linux-capture-summary.json",
      128 * 1024,
    );
    assert.equal(hash(summary), retained.files.get("hosted-linux-capture-summary.json")!.sha256);
    await requireActualHostedNativeLinuxRequest(retained.request);
    parent.recheck();
    return Object.freeze({
      actual,
      directory: actual.directory,
      prepared: actual.prepared,
      summary: JSON.parse(summary.toString("utf8")) as unknown,
      resource_status: retained.resource_status,
      retained_capture: retained.retained,
      capture_wire_sha256: retained.wire_sha256,
      authority: "none" as const,
      native_acceptance: "not-established" as const,
    });
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}
