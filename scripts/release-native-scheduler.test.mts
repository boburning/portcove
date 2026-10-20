import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  inspectNativeSchedulerObservation,
  requireActualNativeSchedulerObservation,
  nativeSchedulerNodeMaximumBytes,
  readNativeSchedulerToolDigest,
} from "./release-native-scheduler.mts";

void test("the actual selected Node executable fits the finite native scheduler runtime bound", async () => {
  const identity = await stat(process.execPath);
  assert.ok(identity.size <= nativeSchedulerNodeMaximumBytes);
  assert.match(
    await readNativeSchedulerToolDigest(process.execPath, nativeSchedulerNodeMaximumBytes),
    /^[a-f0-9]{64}$/u,
  );
  if (identity.size > 64 * 1024 * 1024)
    await assert.rejects(
      readNativeSchedulerToolDigest(process.execPath, 64 * 1024 * 1024),
      /file differs/,
    );
});

function fixture() {
  const broker = "S-1-5-21-1-2-3-1001";
  const action = {
    path: "C:\\Portcove\\node.exe",
    arguments:
      "C:\\Portcove\\controller\\scripts\\native-parent.mts C:\\Portcove\\descriptor.json " +
      "a".repeat(64),
    working_directory: "C:\\Portcove\\controller",
  };
  const paths = {
    authorities: "C:\\Portcove\\authorities.json",
    boundary: "C:\\Portcove\\boundary.json",
    capture: "C:\\Portcove\\capture",
    controller: "C:\\Portcove\\controller",
    descriptor: "C:\\Portcove\\descriptor.json",
    installation: "C:\\Portcove\\installation.json",
    native_issuer: "C:\\Portcove\\credentials\\native.pem",
    source_reader: "C:\\Portcove\\credentials\\read.token",
    source_tool: "C:\\Portcove\\tools\\gh.exe",
  };
  const expected = {
    task_path: "\\PortcoveNative",
    task_xml_sha256: "a".repeat(64),
    task_security_descriptor_sha256: "e".repeat(64),
    action,
    action_sha256: "b".repeat(64),
    broker_sid: broker,
    helper_sha256: "c".repeat(64),
    powershell: { path: "C:\\PowerShell\\pwsh.exe", sha256: "d".repeat(64) },
    protected_paths: paths,
  };
  const processIdentity = (
    pid: number,
    parent: number,
    created: string,
    image: string,
    command: string,
    owner = broker,
  ) => ({
    pid,
    parent_pid: parent,
    created_filetime: created,
    image,
    command_line: command,
    owner_sid: owner,
  });
  const observed = {
    schema_version: 1,
    current_sid: broker,
    elevated: false,
    observed_at: "2026-10-20T22:00:00.0000000Z",
    task: {
      path: expected.task_path,
      xml_sha256: expected.task_xml_sha256,
      security_descriptor_sha256: expected.task_security_descriptor_sha256,
      security_owner_sid: broker,
      enabled: true,
      state: 4,
      principal: { user_id: broker, logon_type: 3, run_level: 0 },
      action: { ...action },
      settings: { multiple_instances: 2, execution_time_limit: "PT35M" },
      instance: {
        guid: "{11111111-2222-3333-4444-555555555555}",
        engine_pid: 100,
        state: 4,
        current_action: "portcove-native-parent",
      },
    },
    reader: processIdentity(
      300,
      200,
      "130000000000000003",
      expected.powershell.path,
      "read-helper",
    ),
    chain: [
      processIdentity(
        200,
        100,
        "130000000000000002",
        action.path,
        `"${action.path}" ${action.arguments}`,
      ),
      processIdentity(
        100,
        50,
        "130000000000000001",
        "C:\\Windows\\System32\\taskeng.exe",
        "task-engine",
      ),
    ],
    custody: Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [
        key,
        {
          path,
          owner_sid: broker,
          directory: key === "capture" || key === "controller",
          protected: true,
          private: key === "native_issuer" || key === "source_reader",
        },
      ]),
    ),
  };
  return { expected, observed };
}
void test("scheduler integrity joins fixed task/action/SID to creation-ordered actual-parent ancestry but mints no actual receipt", () => {
  const f = fixture();
  const result = inspectNativeSchedulerObservation(f.expected, f.observed, 200);
  assert.equal(result.authority, "none");
  assert.equal(result.scope, "scheduler-observation-only");
  assert.throws(() => requireActualNativeSchedulerObservation(result), /provenance/);
  assert.throws(
    () => requireActualNativeSchedulerObservation(structuredClone(result)),
    /provenance/,
  );
  f.observed.task.action.arguments = "changed";
  assert.notEqual(result.task.action, f.observed.task.action);
  assert.throws(
    () => inspectNativeSchedulerObservation(f.expected, f.observed, 200),
    /task\/action/,
  );
});
void test("scheduler refuses wrong instance, elevated/foreign principal, replaced ancestors, changed custody and imported dynamic claims", () => {
  const f = fixture();
  const changes: ((raw: typeof f.observed) => void)[] = [
    (raw) => {
      raw.elevated = true;
    },
    (raw) => {
      raw.task.xml_sha256 = "9".repeat(64);
    },
    (raw) => {
      raw.task.security_descriptor_sha256 = "9".repeat(64);
    },
    (raw) => {
      raw.task.security_owner_sid = "S-1-5-18";
    },
    (raw) => {
      raw.task.principal.user_id = "S-1-5-18";
    },
    (raw) => {
      raw.task.principal.run_level = 1;
    },
    (raw) => {
      raw.task.principal.logon_type = 5;
    },
    (raw) => {
      raw.task.settings.multiple_instances = 0;
    },
    (raw) => {
      raw.task.settings.execution_time_limit = "PT0S";
    },
    (raw) => {
      raw.task.instance.guid = "{not-a-guid}";
    },
    (raw) => {
      raw.task.instance.engine_pid = 999;
    },
    (raw) => {
      raw.chain[0]!.pid = 299;
    },
    (raw) => {
      raw.chain[0]!.command_line += " --unreviewed";
    },
    (raw) => {
      raw.chain[0]!.parent_pid = 999;
    },
    (raw) => {
      raw.chain[1]!.created_filetime = "130000000000000009";
    },
    (raw) => {
      raw.chain[1]!.pid = 200;
    },
    (raw) => {
      raw.reader.parent_pid = 999;
    },
    (raw) => {
      raw.custody.controller!.protected = false;
    },
    (raw) => {
      raw.custody.descriptor!.path = "C:\\unrelated\\descriptor.json";
    },
    (raw) => {
      raw.custody.boundary!.owner_sid = "S-1-5-18";
    },
    (raw) => {
      raw.custody.native_issuer!.private = false;
    },
    (raw) => {
      raw.custody.source_tool!.owner_sid = "S-1-5-18";
    },
  ];
  for (const change of changes) {
    const raw = structuredClone(f.observed);
    change(raw);
    assert.throws(() => inspectNativeSchedulerObservation(f.expected, raw, 200));
  }
  assert.throws(() =>
    inspectNativeSchedulerObservation({ ...f.expected, accepted: true }, f.observed, 200),
  );
});

void test(
  "actual fixed PowerShell task reader parses OS security descriptors and refuses foreign task writers",
  { skip: process.platform !== "win32" },
  () => {
    const script = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_SCHEDULER_READER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixed scheduler reader syntax differs'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-TaskState'},$true)
. ([ScriptBlock]::Create($function.Extent.Text))
$guard=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-OwnerPath'},$true)
. ([ScriptBlock]::Create($guard.Extent.Text))
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$instance=[pscustomobject]@{InstanceGuid='{11111111-2222-3333-4444-555555555555}';EnginePID=100;State=4;CurrentAction='fixed-action'}
$instance|Add-Member ScriptMethod Refresh {}
$task=[pscustomobject]@{Xml='<fixed-inert-task/>';Path='\Portcove\NativeQualification';Enabled=$true;State=4;_instance=$instance;_sddl=('O:'+$owner+'G:BAD:(A;;FA;;;'+$owner+')(A;;FR;;;WD)');Definition=[pscustomobject]@{Actions=@([pscustomobject]@{Type=0;Path='C:\node.exe';Arguments='fixed';WorkingDirectory='C:\controller'});Principal=[pscustomobject]@{UserId=$owner;LogonType=3;RunLevel=0};Settings=[pscustomobject]@{MultipleInstances=2;ExecutionTimeLimit='PT35M'}}}
$task|Add-Member ScriptMethod GetInstances {param($flags);@($this._instance)}
$task|Add-Member ScriptMethod GetSecurityDescriptor {param($flags);$this._sddl}
$state=Read-TaskState $task
if($state.security_owner_sid -cne $owner -or $state.security_descriptor_sha256.Length -ne 64){throw 'Read-only task security capture absent'}
$task._sddl=('O:'+$owner+'G:BAD:(A;;FA;;;'+$owner+')(A;;FA;;;WD)')
$refused=$false
try{Read-TaskState $task|Out-Null}catch{if($_.Exception.Message -notmatch 'foreign identity'){throw};$refused=$true}
if(-not $refused){throw 'Foreign task writer accepted'}
$temporary=[IO.Path]::GetTempFileName()
try {
  $sid=[Security.Principal.SecurityIdentifier]::new($owner)
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
  Set-Acl -LiteralPath $temporary -AclObject $acl
  $privateRefused=$false
  try{Assert-OwnerPath $temporary $false $false $true|Out-Null}catch{if($_.Exception.Message -notmatch 'foreign reader'){throw};$privateRefused=$true}
  if(-not $privateRefused){throw 'Foreign credential reader accepted'}
}finally{Remove-Item -LiteralPath $temporary -Force}
[ordered]@{parsed_actual_raw_security_descriptor=$true;foreign_task_write_refused=$true;foreign_credential_read_refused=$true;scope='inert COM projection and disposable owned-file ACL; no task mutation or installed scheduler proof'}|ConvertTo-Json -Compress
`;
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 128 * 1024,
        env: {
          ...process.env,
          PORTCOVE_TEST_SCHEDULER_READER: fileURLToPath(
            new URL("./read-native-scheduler.ps1", import.meta.url),
          ),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const observed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(observed, {
      parsed_actual_raw_security_descriptor: true,
      foreign_task_write_refused: true,
      foreign_credential_read_refused: true,
      scope:
        "inert COM projection and disposable owned-file ACL; no task mutation or installed scheduler proof",
    });
  },
);
