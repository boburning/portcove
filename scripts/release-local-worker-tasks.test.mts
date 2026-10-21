import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  renderNativeWorkerTask,
  renderSemanticWslWorkerTask,
} from "./release-local-worker-tasks.mts";
const base = {
  platform: "windows-x86_64" as const,
  broker_sid: "S-1-5-21-11-22-33-1001",
  node: "C:\\Portcove Controller\\tools\\node.exe",
  controller: "C:\\Portcove Controller",
  descriptor: "C:\\Portcove Private\\native.json",
  descriptor_sha256: "a".repeat(64),
  start_utc: "2026-10-21T12:00:00.000Z",
};
function configuration() {
  return {
    schema_version: 1,
    kind: "portcove-fixed-semantic-worker",
    worker_revision: "a".repeat(40),
    setup_grant_sha256: "1".repeat(64),
    namespace: "portcove-worker-fixture",
    output_parent: "/unprovisioned/output",
    source_repository: "/unprovisioned/source",
    source_git_sha256: "d".repeat(64),
    source_read_token: "/unprovisioned/credentials/source-read",
    auth_cache: "/unprovisioned/reviewer/auth.json",
    runtime: {
      schema_version: 1,
      output_parent: "/unprovisioned/output",
      node_executable: "/unprovisioned/node",
      codex_executable: "/unprovisioned/codex",
      node_sha256: "2".repeat(64),
      codex_sha256: "3".repeat(64),
      supervisor_sha256: "4".repeat(64),
      tools_sha256: {
        python: "5".repeat(64),
        bwrap: "6".repeat(64),
        systemd_run: "7".repeat(64),
        systemctl: "8".repeat(64),
      },
    },
    issuer: {
      issuer: { app_id: 123, installation_id: 456, writer_app_id: 789 },
      private_key: "/unprovisioned/issuer/private.pem",
      public_key_sha256: "9".repeat(64),
      node_sha256: "2".repeat(64),
      http_modules_sha256: {
        "release-semantic-issuer-http.mts": "a".repeat(64),
        "release-canonical.mts": "b".repeat(64),
        "runtime-values.mts": "c".repeat(64),
      },
    },
  };
}

const configuration_json = JSON.stringify(configuration());
const semantic = {
  broker_sid: base.broker_sid,
  system_root: "C:\\Windows",
  distribution: "Ubuntu-24.04",
  username: "portcove-review",
  controller: "/home/portcove-review/controller",
  configuration: "/home/portcove-review/private/semantic.json",
  configuration_json,
  configuration_sha256: createHash("sha256").update(configuration_json).digest("hex"),
  start_utc: base.start_utc,
};
void test("fixed native tasks match the maintained worker argv and ordinary scheduler limits", () => {
  for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
    const task = renderNativeWorkerTask({ ...base, platform });
    assert.equal(
      task.task_path,
      platform === "windows-x86_64"
        ? "\\Portcove\\NativeQualification"
        : "\\Portcove\\NativeQualificationLinux",
    );
    assert.deepEqual(task.action, {
      path: base.node,
      arguments: `"${base.controller}\\scripts\\release-native-worker.mts" "${base.descriptor}" ${base.descriptor_sha256}`,
      working_directory: base.controller,
    });
    assert.deepEqual(task.principal, { user_id: base.broker_sid, logon_type: 3, run_level: 0 });
    assert.deepEqual(task.settings, { execution_time_limit: "PT35M", multiple_instances: 2 });
    assert.match(task.availability, /offline\/logoff holds/u);
    assert.match(
      task.registration_proposal,
      /RegisterTask\('NativeQualification(?:Linux)?',\$xml,2,/u,
    );
    assert.doesNotMatch(task.registration_proposal, /\.Run\(|Register-ScheduledTask|-Force/u);
    assert.doesNotMatch(task.recovery_readback_proposal, /RegisterTask\(|CreateFolder\(/u);
    assert.match(task.recovery_readback_proposal, /GetTask\(/u);
    assert.match(task.registration_proposal, /FileMode\]::CreateNew/u);
  }
});
void test("semantic WSL task starts only the existing bounded oneshot, with no direct Node fallback", async () => {
  const task = await renderSemanticWslWorkerTask(semantic);
  assert.equal(task.task_path, "\\Portcove\\SemanticReview");
  assert.equal(task.action.path, "C:\\Windows\\System32\\wsl.exe");
  assert.equal(
    task.action.arguments,
    "--distribution Ubuntu-24.04 --user portcove-review --exec /usr/bin/systemctl --user start --wait portcove-semantic-worker.service",
  );
  assert.equal(task.settings.execution_time_limit, "PT47M");
  assert.doesNotMatch(task.action.arguments, /bash|--shell|--user root/u);
  assert.match(task.xml, /<Interval>PT5M<\/Interval>/u);
  assert.match(
    task.linux_service,
    /TimeoutStartSec=2700\nTimeoutStopSec=30\nKillMode=control-group/,
  );
  assert.equal(task.timer_enabled, false);
  assert.equal(
    createHash("sha256").update(task.linux_service).digest("hex"),
    task.linux_service_sha256,
  );
  assert.match(task.linux_service, /scripts\/release-semantic-worker.mts/);
  assert.doesNotMatch(task.linux_service, /RemainAfterExit=yes/);
  assert.match(task.settlement, /not guest closure/);
  await assert.rejects(
    renderSemanticWslWorkerTask({ ...semantic, unit: "other.service" } as typeof semantic),
  );
});
void test("task proposals refuse path/argument injection, unknown selectors and invalid fixed source identities", async () => {
  for (const node of [
    "C:\\tools\\cmd.exe",
    "C:\\tools:alias\\node.exe",
    "C:\\tools\\node.exe%PATH%",
    "C:\\tools\\..\\node.exe",
    "\\\\server\\node.exe",
    'C:\\tools\\node.exe" --eval x',
  ])
    assert.throws(() => renderNativeWorkerTask({ ...base, node }));
  assert.throws(() => renderNativeWorkerTask({ ...base, descriptor_sha256: "bad" }));
  assert.throws(() => renderNativeWorkerTask({ ...base, start_utc: "2026-99-21T12:00:00.000Z" }));
  assert.throws(() => renderNativeWorkerTask({ ...base, action: "arbitrary" } as typeof base));
  for (const change of [
    { username: "root" },
    { username: "user --exec sh" },
    { distribution: "Debian" },
    { distribution: "Ubuntu --exec sh" },
    { configuration_sha256: "bad" },
    { controller: "/home/u/../other" },
    { configuration: "/home/u/a b.json" },
  ])
    await assert.rejects(renderSemanticWslWorkerTask({ ...semantic, ...change }));
});
void test(
  "actual XML parser reads both fixed triggers/actions and PowerShell parses proposal commands without running COM",
  { skip: process.platform !== "win32" },
  async () => {
    for (const task of [
      renderNativeWorkerTask(base),
      renderNativeWorkerTask({ ...base, platform: "linux-x86_64" }),
      await renderSemanticWslWorkerTask(semantic),
    ]) {
      const script = `
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false,$true)
[xml]$x=$utf8.GetString([Convert]::FromBase64String($env:TEST_TASK_XML))
$ns=[Xml.XmlNamespaceManager]::new($x.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
function ReadValue([string]$path){$x.SelectSingleNode($path,$ns).InnerText}
if(@($x.SelectNodes('/t:Task/t:Triggers/*',$ns)).Count -ne 2){throw 'trigger count'}
if((ReadValue '/t:Task/t:Triggers/t:LogonTrigger/t:UserId') -cne $env:TEST_BROKER){throw 'logon SID'}
if((ReadValue '/t:Task/t:Triggers/t:CalendarTrigger/t:Repetition/t:Interval') -cne 'PT5M'){throw 'repetition'}
if((ReadValue '/t:Task/t:Principals/t:Principal/t:LogonType') -cne 'InteractiveToken'){throw 'principal'}
if((ReadValue '/t:Task/t:Settings/t:MultipleInstancesPolicy') -cne 'IgnoreNew'){throw 'instances'}
if((ReadValue '/t:Task/t:Actions/t:Exec/t:Arguments') -cne $env:TEST_ARGUMENTS){throw 'argv XML roundtrip'}
foreach($name in @('TEST_REGISTER','TEST_RECOVERY')){$tokens=$null;$errors=$null;$code=$utf8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable($name)));$null=[Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}}
Write-Output 'xml-and-proposal-parse-pass'
`;
      const result = spawnSync(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
          env: {
            ...process.env,
            TEST_TASK_XML: Buffer.from(task.xml).toString("base64"),
            TEST_REGISTER: Buffer.from(task.registration_proposal).toString("base64"),
            TEST_RECOVERY: Buffer.from(task.recovery_readback_proposal).toString("base64"),
            TEST_BROKER: base.broker_sid,
            TEST_ARGUMENTS: task.action.arguments,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /xml-and-proposal-parse-pass/u);
    }
  },
);
