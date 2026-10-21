/** Fixed Task Scheduler setup proposals. Rendering grants no setup or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const truth =
  "automatic only while the existing ordinary broker desktop session is available; offline/logoff holds; logon resumes; no per-attempt target sign-in";
function sid(value: string) {
  assert.match(value, /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u);
  return value;
}
function windows(value: string) {
  assert.ok(typeof value === "string" && /^[A-Za-z]:\\/u.test(value));
  for (let index = 0; index < value.length; index++)
    assert.ok(value.charCodeAt(index) >= 32 && value.charCodeAt(index) !== 127);
  assert.ok(!/[%"<>|&]/u.test(value));
  assert.ok(!value.slice(2).includes(":"));
  assert.ok(!value.split(/[\\/]/u).some((part) => part === "." || part === ".."));
  assert.equal(path.win32.normalize(value), value);
  assert.ok(!value.endsWith("\\") && value.length <= 512);
  return value;
}
function linux(value: string) {
  assert.match(value, /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/u);
  assert.ok(!value.split("/").some((part) => part === "." || part === ".."));
  return value;
}
function sha(value: string) {
  assert.match(value, /^[a-f0-9]{64}$/u);
  return value;
}
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export interface NativeWorkerTaskInput {
  platform: "windows-x86_64" | "linux-x86_64";
  broker_sid: string;
  node: string;
  controller: string;
  descriptor: string;
  descriptor_sha256: string;
  start_utc: string;
}
interface FixedTask {
  name: "NativeQualification" | "NativeQualificationLinux" | "SemanticReview";
  broker: string;
  action: { path: string; arguments: string; working_directory: string };
  start: string;
  ceiling: "PT35M" | "PT47M";
}
function render(task: FixedTask) {
  assert.match(task.start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/u);
  assert.equal(new Date(task.start).toISOString(), task.start);
  const taskPath = `\\Portcove\\${task.name}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><URI>${taskPath}</URI></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${task.broker}</UserId><Delay>PT30S</Delay></LogonTrigger><CalendarTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${task.start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
<Principals><Principal id="Broker"><UserId>${task.broker}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>false</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>${task.ceiling}</ExecutionTimeLimit><Priority>7</Priority></Settings>
<Actions Context="Broker"><Exec><Command>${escape(task.action.path)}</Command><Arguments>${escape(task.action.arguments)}</Arguments><WorkingDirectory>${escape(task.action.working_directory)}</WorkingDirectory></Exec></Actions>
</Task>
`;
  const xmlSha = createHash("sha256").update(xml, "utf8").digest("hex");
  const sddl = `O:${task.broker}G:${task.broker}D:P(A;;GA;;;${task.broker})(A;;GA;;;SY)(A;;GA;;;BA)`;
  // This is a proposal only. Its fixed COM operations are never called by this module.
  const common = `param([Parameter(Mandatory)][string]$XmlPath,[Parameter(Mandatory)][string]$EvidencePath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if($owner.User.Value -cne ${ps(task.broker)} -or ([Security.Principal.WindowsPrincipal]::new($owner)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Exact ordinary broker required'}
$xmlInput=[IO.File]::Open($XmlPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{
 if($xmlInput.Length -lt 1 -or $xmlInput.Length -gt 16384){throw 'Fixed rendered XML size differs'}
 $buffer=[byte[]]::new(16385);$length=0
 while($length -lt $buffer.Length){$count=$xmlInput.Read($buffer,$length,$buffer.Length-$length);if($count -eq 0){break};$length+=$count}
 if($length -lt 1 -or $length -gt 16384 -or $length -ne $xmlInput.Length){throw 'Fixed rendered XML read differs'}
 [byte[]]$bytes=$buffer[0..($length-1)]
}finally{$xmlInput.Dispose()}
if( [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne ${ps(xmlSha)}){throw 'Fixed rendered XML bytes differ'}
$xml=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
[xml]$parsed=$xml
$service=New-Object -ComObject Schedule.Service;$service.Connect()
function Inspect-FixedTask($task,[bool]$expectedEnabled){
 $d=$task.Definition;$a=@($d.Actions)
 if($a.Count -ne 1 -or $a[0].Type -ne 0 -or $a[0].Path -cne ${ps(task.action.path)} -or $a[0].Arguments -cne ${ps(task.action.arguments)} -or $a[0].WorkingDirectory -cne ${ps(task.action.working_directory)} -or $d.Principal.UserId -cne ${ps(task.broker)} -or $d.Principal.LogonType -ne 3 -or $d.Principal.RunLevel -ne 0 -or $d.Settings.MultipleInstances -ne 2 -or $d.Settings.ExecutionTimeLimit -cne ${ps(task.ceiling)}){throw 'Task action/principal/limits differ'}
 $triggers=@($d.Triggers)
 if($triggers.Count -ne 2 -or $triggers[0].Type -ne 9 -or $triggers[0].UserId -cne ${ps(task.broker)} -or $triggers[0].Delay -cne 'PT30S' -or -not $triggers[0].Enabled -or $triggers[1].Type -ne 2 -or $triggers[1].DaysInterval -ne 1 -or $triggers[1].Repetition.Interval -cne 'PT5M' -or $triggers[1].Repetition.Duration -ne '' -or $triggers[1].Repetition.StopAtDurationEnd -or -not $triggers[1].Enabled -or [DateTimeOffset]::Parse($triggers[1].StartBoundary) -ne [DateTimeOffset]::Parse(${ps(task.start)})){throw 'Fixed automatic triggers differ'}
 if($task.Enabled -ne $expectedEnabled -or -not $d.Settings.StartWhenAvailable -or -not $d.Settings.AllowHardTerminate -or $d.Settings.RunOnlyIfIdle -or $d.Settings.RunOnlyIfNetworkAvailable -or $d.Settings.WakeToRun){throw 'Fixed automatic settings differ'}
 $security=[string]$task.GetSecurityDescriptor(7)
 $sd=[Security.AccessControl.RawSecurityDescriptor]::new($security)
 if($sd.Owner.Value -cne ${ps(task.broker)} -or $null -eq $sd.DiscretionaryAcl){throw 'Task owner differs'}
 foreach($ace in $sd.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.SecurityIdentifier.Value -notin @(${ps(task.broker)},'S-1-5-18','S-1-5-32-544')){throw 'Task DACL differs'}}
 # Provider canonical XML/SDDL are retained, then independently pinned in installation.
 return [ordered]@{task_path=${ps(taskPath)};xml=[string]$task.Xml;sddl=$security;authority='none'}
}
function Read-FixedTask($task,[bool]$expectedEnabled){
 $record=Inspect-FixedTask $task $expectedEnabled
 $stream=[IO.File]::Open($EvidencePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$data=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress));$stream.Write($data);$stream.Flush($true)}finally{$stream.Dispose()}
}
`;
  return Object.freeze({
    schema_version: 1,
    authority: "none" as const,
    task_path: taskPath,
    xml,
    xml_sha256: xmlSha,
    sddl,
    action: Object.freeze(task.action),
    principal: { user_id: task.broker, logon_type: 3, run_level: 0 },
    settings: { execution_time_limit: task.ceiling, multiple_instances: 2 },
    availability: truth,
    registration_proposal:
      common +
      `# Initial setup only: create-only; never replace or run a task.\n$root=$service.GetFolder('\\')\ntry{$folder=$root.GetFolder('Portcove')}catch [Runtime.InteropServices.COMException]{if($_.Exception.HResult -ne -2147024894){throw};$folder=$root.CreateFolder('Portcove',${ps(sddl)})}\n$task=$folder.RegisterTask(${ps(task.name)},$xml,2,${ps(task.broker)},$null,3,${ps(sddl)})\nRead-FixedTask $task $false\n`,
    recovery_readback_proposal:
      common +
      `# GET-only after lost acknowledgement; missing/changed is HOLD, never absence-as-no-effect.\n$task=$service.GetFolder('\\Portcove').GetTask(${ps(task.name)})\nRead-FixedTask $task $false\n`,
    activation_proposal:
      common +
      `# Final separately granted setup step only, after all protected custody/installation pins are complete.\n$task=$service.GetFolder('\\Portcove').GetTask(${ps(task.name)})\n$null=Inspect-FixedTask $task $false\n$task.Enabled=$true\nRead-FixedTask $task $true\n`,
    activation_readback_proposal:
      common +
      `# GET-only after ambiguous enable; never blindly repeat activation.\n$task=$service.GetFolder('\\Portcove').GetTask(${ps(task.name)})\nRead-FixedTask $task $true\n`,
    initial_enabled: false,
    prerequisites: [
      "explicit consolidated setup grant",
      "PowerShell7 for proposal script (not the scheduled worker)",
      "protected source/tools/configuration and initialized custody anchor",
      "existing ordinary broker interactive session",
      "independent actual scheduler/protected-path readback before execution",
      "create disabled, finish protected setup, enable last, retain provider canonical XML/SDDL and pin final installation; early activation still meets existing parent HOLD guards",
    ],
  });
}
export function renderNativeWorkerTask(input: NativeWorkerTaskInput) {
  assert.equal(
    Object.keys(input).sort().join(","),
    "broker_sid,controller,descriptor,descriptor_sha256,node,platform,start_utc",
  );
  assert.ok(input.platform === "windows-x86_64" || input.platform === "linux-x86_64");
  const controller = windows(input.controller),
    node = windows(input.node),
    descriptor = windows(input.descriptor);
  assert.equal(path.win32.basename(node).toLowerCase(), "node.exe");
  return render({
    name: input.platform === "windows-x86_64" ? "NativeQualification" : "NativeQualificationLinux",
    broker: sid(input.broker_sid),
    start: input.start_utc,
    ceiling: "PT35M",
    action: {
      path: node,
      arguments: `"${path.win32.join(controller, "scripts/release-native-worker.mts")}" "${descriptor}" ${sha(input.descriptor_sha256)}`,
      working_directory: controller,
    },
  });
}
/** WSL starts the existing bounded oneshot, never an unbounded direct Node fallback. */
export async function renderSemanticWslWorkerTask(input: {
  broker_sid: string;
  system_root: string;
  distribution: string;
  username: string;
  controller: string;
  configuration: string;
  configuration_sha256: string;
  configuration_json: string;
  start_utc: string;
}) {
  assert.equal(
    Object.keys(input).sort().join(","),
    "broker_sid,configuration,configuration_json,configuration_sha256,controller,distribution,start_utc,system_root,username",
  );
  assert.match(input.distribution, /^Ubuntu(?:-[0-9]{2}\.[0-9]{2})?$/u);
  assert.match(input.username, /^[a-z_][a-z0-9_-]{0,31}$/u);
  assert.notEqual(input.username, "root");
  const controller = linux(input.controller),
    configuration = linux(input.configuration);
  assert.ok(Buffer.byteLength(input.configuration_json, "utf8") <= 32768);
  assert.equal(
    createHash("sha256").update(input.configuration_json).digest("hex"),
    sha(input.configuration_sha256),
  );
  const { renderSemanticWorkerUnits } = await import("./release-semantic-worker.mts");
  const units = renderSemanticWorkerUnits(
    JSON.parse(input.configuration_json),
    configuration,
    input.configuration_sha256,
    controller,
  );
  const serviceSha = createHash("sha256").update(units.service).digest("hex");
  const task = render({
    name: "SemanticReview",
    broker: sid(input.broker_sid),
    start: input.start_utc,
    ceiling: "PT47M",
    action: {
      path: path.win32.join(windows(input.system_root), "System32/wsl.exe"),
      arguments: `--distribution ${input.distribution} --user ${input.username} --exec /usr/bin/systemctl --user start --wait portcove-semantic-worker.service`,
      working_directory: windows(input.system_root),
    },
  });
  const prefix = ["--distribution", input.distribution, "--user", input.username, "--exec"];
  return Object.freeze({
    ...task,
    linux_service: units.service,
    linux_service_sha256: serviceSha,
    linux_initial_state: units.initial_state,
    timer_enabled: false,
    // These fixed GET-only argv proposals neither install nor start the unit.
    unit_readback: {
      path: task.action.path,
      arguments: [
        ...prefix,
        "/usr/bin/systemctl",
        "--user",
        "show",
        "portcove-semantic-worker.service",
        "--property=LoadState,FragmentPath,DropInPaths,Type,RemainAfterExit,TimeoutStartUSec,TimeoutStopUSec,KillMode,Restart,MainPID,ControlGroup,ActiveState",
      ],
      required: {
        LoadState: "loaded",
        DropInPaths: "",
        Type: "oneshot",
        RemainAfterExit: "no",
        TimeoutStartUSec: "45min",
        TimeoutStopUSec: "30s",
        KillMode: "control-group",
        Restart: "no",
      },
      exact_service_bytes: units.service,
      required_fragment_path: `/home/${input.username}/.config/systemd/user/portcove-semantic-worker.service`,
      exact_service_sha256: serviceSha,
      fragment_read: [
        ...prefix,
        "/usr/bin/sha256sum",
        `/home/${input.username}/.config/systemd/user/portcove-semantic-worker.service`,
      ],
      timer_read: [
        ...prefix,
        "/usr/bin/systemctl",
        "--user",
        "is-enabled",
        "portcove-semantic-worker.timer",
      ],
      required_timer_state: "disabled or absent; never enable both schedulers",
    },
    prerequisites: [
      ...task.prerequisites,
      "install/hash/read back exact existing oneshot and initial state before Task activation",
      "existing WSL systemd user bus/rootless capability; timer disabled",
      "47min Windows supervisor includes original45min guest+30s stop+90s observation margin",
    ],
    settlement:
      "wsl.exe exit/timeout is not guest closure; Unknown remains HOLD until original Linux group recovery proves settlement",
    direct_node_route:
      "not selected: Windows client timeout alone does not bound the Linux worker tree",
  });
}

function exactObject(value: unknown, keys: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.equal(Object.keys(value).sort().join(","), keys);
}
function text(value: unknown) {
  assert.ok(typeof value === "string");
  return value;
}
async function noLinks(filename: string) {
  for (let cursor = filename; ; cursor = path.dirname(cursor)) {
    const info = await lstat(cursor);
    assert.ok(!info.isSymbolicLink(), "setup path has linked ancestry");
    if (path.dirname(cursor) === cursor) break;
  }
}
function fileIdentity(info: Awaited<ReturnType<typeof lstat>>) {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}
async function heldSetupInput(filename: string, expected: string) {
  assert.ok(path.isAbsolute(filename));
  await noLinks(filename);
  const before = await lstat(filename);
  assert.ok(
    before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 65536,
    "setup plan size/type differs",
  );
  const handle = await open(
    filename,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  const read = async () => {
    assert.equal(fileIdentity(await handle.stat()), fileIdentity(before));
    const buffer = Buffer.alloc(65537);
    let total = 0;
    for (;;) {
      const count = await handle.read(buffer, total, buffer.length - total, total);
      if (!count.bytesRead) break;
      total += count.bytesRead;
      assert.ok(total <= 65536, "setup plan grew beyond bound");
    }
    assert.equal(total, before.size);
    assert.equal(fileIdentity(await handle.stat()), fileIdentity(before));
    assert.equal(fileIdentity(await lstat(filename)), fileIdentity(before));
    await noLinks(filename);
    const bytes = buffer.subarray(0, total);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      "setup plan hash differs",
    );
    return bytes;
  };
  try {
    return { bytes: await read(), recheck: read, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
/** Maintained data-only preparation entry: never invokes any generated action. */
export async function prepareLocalWorkerTasks(
  planPath: string,
  planSha256: string,
  output: string,
) {
  sha(planSha256);
  const input = await heldSetupInput(planPath, planSha256);
  try {
    const plan: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
    exactObject(
      plan,
      "broker_sid,candidate_roots,native_linux,native_windows,schema_version,semantic_wsl,start_utc",
    );
    assert.equal(plan.schema_version, 1);
    const broker = sid(text(plan.broker_sid)),
      start = text(plan.start_utc);
    assert.ok(
      Array.isArray(plan.candidate_roots) &&
        plan.candidate_roots.length > 0 &&
        plan.candidate_roots.length <= 8,
    );
    const roots = plan.candidate_roots.map((value: unknown) => windows(text(value)));
    assert.ok(
      path.isAbsolute(output) && path.resolve(output) === output,
      "setup output must be a canonical absolute new directory",
    );
    // On Windows these declared roots come from the final protected boundary
    // plan. They are restrictions, not evidence of observed account ACLs.
    for (const root of roots) {
      const relative = path.win32.relative(root, output);
      assert.ok(
        relative && (relative.startsWith("..\\") || path.win32.isAbsolute(relative)),
        "setup output overlaps candidate storage",
      );
      const reverse = path.win32.relative(output, root);
      assert.ok(
        reverse && (reverse.startsWith("..\\") || path.win32.isAbsolute(reverse)),
        "setup output contains candidate storage",
      );
    }
    const native = (raw: unknown, platform: NativeWorkerTaskInput["platform"]) => {
      exactObject(raw, "controller,descriptor,descriptor_sha256,node");
      return renderNativeWorkerTask({
        platform,
        broker_sid: broker,
        start_utc: start,
        controller: text(raw.controller),
        descriptor: text(raw.descriptor),
        descriptor_sha256: text(raw.descriptor_sha256),
        node: text(raw.node),
      });
    };
    exactObject(
      plan.semantic_wsl,
      "configuration,configuration_json,configuration_sha256,controller,distribution,system_root,username",
    );
    const wsl = plan.semantic_wsl;
    const tasks = [
      native(plan.native_windows, "windows-x86_64"),
      native(plan.native_linux, "linux-x86_64"),
      await renderSemanticWslWorkerTask({
        broker_sid: broker,
        start_utc: start,
        system_root: text(wsl.system_root),
        distribution: text(wsl.distribution),
        username: text(wsl.username),
        controller: text(wsl.controller),
        configuration: text(wsl.configuration),
        configuration_sha256: text(wsl.configuration_sha256),
        configuration_json: text(wsl.configuration_json),
      }),
    ];
    await input.recheck();
    await noLinks(path.dirname(output));
    await mkdir(output, { mode: 0o700 }); // No recursive reuse/overwrite; partial output remains on failure.
    const files: { path: string; bytes: number; sha256: string }[] = [];
    const retain = async (name: string, content: string) => {
      assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
      const bytes = Buffer.from(content);
      assert.ok(bytes.length <= 65536);
      const handle = await open(path.join(output, name), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      files.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    };
    for (const task of tasks) {
      const name = task.task_path.split("\\").at(-1)!;
      await retain(`${name}.xml`, task.xml);
      await retain(`${name}.register.ps1`, task.registration_proposal);
      await retain(`${name}.registration-readback.ps1`, task.recovery_readback_proposal);
      await retain(`${name}.enable.ps1`, task.activation_proposal);
      await retain(`${name}.enabled-readback.ps1`, task.activation_readback_proposal);
    }
    const semantic = tasks[2]!;
    assert.ok(
      "linux_service" in semantic &&
        "linux_initial_state" in semantic &&
        "unit_readback" in semantic,
    );
    await retain("portcove-semantic-worker.service", text(semantic.linux_service));
    await retain("worker-state.json", JSON.stringify(semantic.linux_initial_state, null, 2) + "\n");
    await retain(
      "semantic-unit-readback.json",
      JSON.stringify(semantic.unit_readback, null, 2) + "\n",
    );
    await input.recheck();
    const source = fileURLToPath(import.meta.url),
      sourceInput = await open(source, "r");
    let sourceSha: string;
    try {
      const info = await sourceInput.stat();
      assert.ok(info.isFile() && info.size <= 65536);
      const bytes = Buffer.alloc(65537);
      let length = 0;
      for (;;) {
        const part = await sourceInput.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
        assert.ok(length <= 65536);
      }
      assert.equal(length, info.size);
      assert.equal(fileIdentity(await sourceInput.stat()), fileIdentity(info));
      assert.equal(fileIdentity(await lstat(source)), fileIdentity(info));
      sourceSha = createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
    } finally {
      await sourceInput.close();
    }
    const manifest = {
      schema_version: 1,
      authority: "none",
      plan_sha256: planSha256,
      source_sha256: sourceSha,
      source_entry: "scripts/release-local-worker-tasks.mts",
      files,
      availability: truth,
      activation_sequence: [
        "create Tasks disabled and retain registration readback",
        "install/hash/readback existing semantic oneshot and worker-state; keep its timer disabled",
        "finish all protected accounts/configs/custody/installation pins and setup grant checks",
        "enable each fixed Task last; ambiguous enable uses GET-only enabled readback, never blind replay",
        "pin actual enabled provider-canonical XML/SDDL in installed descriptor; existing runtime guards HOLD until pins match",
      ],
      scope:
        "setup proposals only; no credentials, tasks, services, accounts or execution activated; Windows output ACL privacy requires setup readback",
    };
    await retain("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    await input.recheck();
    return {
      directory: output,
      manifest_sha256: files.at(-1)!.sha256,
      authority: "none" as const,
      files: files.length,
    };
  } finally {
    await input.close();
  }
}
if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "release-local-worker-tasks.mts" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, plan, expected, output, ...extra] = process.argv.slice(2);
  if (mode !== "prepare" || !plan || !expected || !output || extra.length)
    throw new Error(
      "usage: release-local-worker-tasks.mts prepare PLAN.json PLAN_SHA256 NEW_OUTPUT_DIR",
    );
  void prepareLocalWorkerTasks(plan, expected, output).then(
    (result) => console.log(JSON.stringify(result)),
    () => {
      console.error("setup preparation refused; preserve any partial output");
      process.exitCode = 1;
    },
  );
}
