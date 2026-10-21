/** Fixed Task Scheduler setup proposals. Rendering grants no setup or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

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
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>${task.ceiling}</ExecutionTimeLimit><Priority>7</Priority></Settings>
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
$bytes=[IO.File]::ReadAllBytes($XmlPath)
if($bytes.Length -gt 16384 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne ${ps(xmlSha)}){throw 'Fixed rendered XML bytes differ'}
$xml=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
[xml]$parsed=$xml
$service=New-Object -ComObject Schedule.Service;$service.Connect()
function Read-FixedTask($task){
 $d=$task.Definition;$a=@($d.Actions)
 if($a.Count -ne 1 -or $a[0].Type -ne 0 -or $a[0].Path -cne ${ps(task.action.path)} -or $a[0].Arguments -cne ${ps(task.action.arguments)} -or $a[0].WorkingDirectory -cne ${ps(task.action.working_directory)} -or $d.Principal.UserId -cne ${ps(task.broker)} -or $d.Principal.LogonType -ne 3 -or $d.Principal.RunLevel -ne 0 -or $d.Settings.MultipleInstances -ne 2 -or $d.Settings.ExecutionTimeLimit -cne ${ps(task.ceiling)}){throw 'Task action/principal/limits differ'}
 $triggers=@($d.Triggers)
 if($triggers.Count -ne 2 -or $triggers[0].Type -ne 9 -or $triggers[0].UserId -cne ${ps(task.broker)} -or $triggers[0].Delay -cne 'PT30S' -or -not $triggers[0].Enabled -or $triggers[1].Type -ne 2 -or $triggers[1].DaysInterval -ne 1 -or $triggers[1].Repetition.Interval -cne 'PT5M' -or $triggers[1].Repetition.Duration -ne '' -or $triggers[1].Repetition.StopAtDurationEnd -or -not $triggers[1].Enabled -or [DateTimeOffset]::Parse($triggers[1].StartBoundary) -ne [DateTimeOffset]::Parse(${ps(task.start)})){throw 'Fixed automatic triggers differ'}
 if(-not $task.Enabled -or -not $d.Settings.StartWhenAvailable -or -not $d.Settings.AllowHardTerminate -or $d.Settings.RunOnlyIfIdle -or $d.Settings.RunOnlyIfNetworkAvailable -or $d.Settings.WakeToRun){throw 'Fixed automatic settings differ'}
 $security=[string]$task.GetSecurityDescriptor(7)
 $sd=[Security.AccessControl.RawSecurityDescriptor]::new($security)
 if($sd.Owner.Value -cne ${ps(task.broker)} -or $null -eq $sd.DiscretionaryAcl){throw 'Task owner differs'}
 foreach($ace in $sd.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.SecurityIdentifier.Value -notin @(${ps(task.broker)},'S-1-5-18','S-1-5-32-544')){throw 'Task DACL differs'}}
 # Provider canonical XML/SDDL are retained, then independently pinned in installation.
 $record=[ordered]@{task_path=${ps(taskPath)};xml=[string]$task.Xml;sddl=$security;authority='none'}
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
      `# Initial setup only: create-only; never replace or run a task.\n$root=$service.GetFolder('\\')\ntry{$folder=$root.GetFolder('Portcove')}catch [Runtime.InteropServices.COMException]{if($_.Exception.HResult -ne -2147024894){throw};$folder=$root.CreateFolder('Portcove',${ps(sddl)})}\n$task=$folder.RegisterTask(${ps(task.name)},$xml,2,${ps(task.broker)},$null,3,${ps(sddl)})\nRead-FixedTask $task\n`,
    recovery_readback_proposal:
      common +
      `# GET-only after lost acknowledgement; missing/changed is HOLD, never absence-as-no-effect.\n$task=$service.GetFolder('\\Portcove').GetTask(${ps(task.name)})\nRead-FixedTask $task\n`,
    prerequisites: [
      "explicit consolidated setup grant",
      "PowerShell7 for proposal script (not the scheduled worker)",
      "protected source/tools/configuration and initialized custody anchor",
      "existing ordinary broker interactive session",
      "independent actual scheduler/protected-path readback before execution",
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
