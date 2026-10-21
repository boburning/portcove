/** One-time fixed inert account capability capture. No release/Check authority. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { lstat, open, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { errorMessage } from "./runtime-values.mts";
import {
  NativeAccountClient,
  type NativeAccountBinding,
  type NativeAccountTransport,
} from "./native-qualification-account-client.mts";
import { resourceEntrypoint, runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import {
  hashNativeCapturedFile,
  readNativeCapturedStream,
} from "./release-native-capture-files.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const own = fileURLToPath(import.meta.url);
const captureRoot = "C:\\ProgramData\\PortcoveNativeQualification\\capture";
export const capabilitySources = Object.freeze([
  "scripts/release-native-account-capability.mts",
  "scripts/native-qualification-account-client.mts",
  "scripts/native-qualification-account-client.ps1",
  "scripts/native-qualification-account-bridge.ps1",
  "scripts/native-qualification-account.cs.txt",
  "scripts/fixtures/native-account-gui-probe.ps1",
]);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "unexpected capability fields");
}
function hash(value: unknown): asserts value is string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}
function text(value: unknown): asserts value is string {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length < 1024 &&
      !value.split("").some((character) => character.charCodeAt(0) < 32),
  );
}
interface Tool {
  path: string;
  sha256: string;
}
interface Configuration {
  schema_version: 1;
  kind: "native-account-setup-capability";
  boundary: Tool;
  controller: { root: string; revision: string; tree: string };
  tools: { node: Tool; powershell: Tool; fixture_powershell: Tool; git: Tool };
  source_sha256: Record<string, string>;
}
export function inspectAccountCapabilityConfiguration(value: unknown): Configuration {
  const raw = object(value);
  exact(raw, ["schema_version", "kind", "boundary", "controller", "tools", "source_sha256"]);
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "native-account-setup-capability");
  const controller = object(raw.controller);
  exact(controller, ["root", "revision", "tree"]);
  text(controller.root);
  assert.ok(path.isAbsolute(controller.root) && !controller.root.startsWith("\\\\"));
  for (const key of ["revision", "tree"]) assert.match(String(controller[key]), /^[a-f0-9]{40}$/u);
  const tools = object(raw.tools);
  exact(tools, ["node", "powershell", "fixture_powershell", "git"]);
  for (const candidate of [raw.boundary, ...Object.values(tools)]) {
    const tool = object(candidate);
    exact(tool, ["path", "sha256"]);
    text(tool.path);
    hash(tool.sha256);
    assert.ok(path.isAbsolute(tool.path) && !tool.path.startsWith("\\\\"));
  }
  const sources = object(raw.source_sha256);
  exact(sources, capabilitySources);
  for (const digest of Object.values(sources)) hash(digest);
  return structuredClone(raw) as unknown as Configuration;
}
interface Boundary {
  schema_version: 1 | 2;
  purpose?: "ordinary-public-proof";
  broker_sid: string;
  account_sid: string;
  account_name: string;
  profile_root: string;
  work_root: string;
  capture_root: string;
  helper_sha256: string;
  controller_root: string;
}
export function inspectAccountCapabilityBoundary(value: unknown): Boundary {
  const raw = object(value);
  const publicAccount = raw.schema_version === 2;
  exact(raw, [
    "schema_version",
    "broker_sid",
    "account_sid",
    "account_name",
    "profile_root",
    "work_root",
    "capture_root",
    "helper_sha256",
    "controller_root",
    ...(publicAccount ? ["purpose"] : []),
  ]);
  assert.ok(publicAccount || raw.schema_version === 1);
  if (publicAccount) assert.equal(raw.purpose, "ordinary-public-proof");
  for (const key of ["broker_sid", "account_sid"])
    assert.match(String(raw[key]), /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/u);
  assert.notEqual(raw.account_sid, raw.broker_sid);
  assert.equal(raw.account_name, publicAccount ? "PortcovePublicProof" : "PortcoveNativeQual");
  for (const name of ["profile_root", "work_root", "capture_root", "controller_root"]) {
    text(raw[name]);
    assert.ok(path.isAbsolute(raw[name]) && !raw[name].startsWith("\\\\"));
  }
  for (const name of ["work_root", "profile_root", "controller_root"]) {
    const a = path.resolve(String(raw[name])).toLowerCase(),
      b = path.resolve(String(raw.capture_root)).toLowerCase();
    assert.ok(
      a !== b && !a.startsWith(b + path.sep) && !b.startsWith(a + path.sep),
      "capture must remain separate from candidate/source roots",
    );
  }
  const work = path.resolve(String(raw.work_root)).toLowerCase(),
    controller = path.resolve(String(raw.controller_root)).toLowerCase();
  assert.ok(
    work !== controller &&
      !work.startsWith(controller + path.sep) &&
      !controller.startsWith(work + path.sep),
  );
  hash(raw.helper_sha256);
  return structuredClone(raw) as unknown as Boundary;
}
function active(deadline: number) {
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(
    Number.isFinite(deadline) && remaining > 0,
    "original account capability deadline exhausted",
  );
  return remaining;
}
async function bounded(file: string, maximum: number, deadline: number) {
  active(deadline);
  const before = await lstat(file);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= maximum,
  );
  const handle = await open(file, "r");
  try {
    const held = await handle.stat();
    assert.equal(held.ino, before.ino);
    assert.equal(held.dev, before.dev);
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset <= before.size) {
      active(deadline);
      const got = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!got.bytesRead) break;
      offset += got.bytesRead;
    }
    assert.equal(offset, before.size);
    const after = await lstat(file),
      final = await handle.stat();
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"] as const) {
      assert.equal(after[key], before[key]);
      assert.equal(final[key], before[key]);
    }
    active(deadline);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function writeNew(filename: string, bytes: string | Uint8Array) {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Inert CreateNew setup ownership claim; does not appoint an account or grant execution. */
export async function createAccountCapabilityIntent(
  capture: string,
  accountSid: string,
  configurationSha256: string,
  invocation: string,
) {
  assert.match(accountSid, /^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$/u);
  hash(configurationSha256);
  hash(invocation);
  const directory = path.join(capture, `setup-capability-${invocation}`);
  const marker = {
    schema_version: 1,
    kind: "one-time-account-capability-intent",
    account_sid: accountSid,
    configuration_sha256: configurationSha256,
    invocation_id: invocation,
    directory,
    authority: "none",
  };
  await writeNew(
    path.join(capture, `setup-capability-${sha(accountSid)}.json`),
    JSON.stringify(marker),
  );
  return marker;
}
function samePath(a: string, b: string) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
function identity(value: unknown) {
  const raw = object(value);
  assert.ok(Number.isSafeInteger(raw.pid) && Number(raw.pid) > 0);
  assert.match(String(raw.started_filetime), /^[1-9][0-9]+$/u);
  text(raw.path);
  return { pid: Number(raw.pid), started_filetime: String(raw.started_filetime), path: raw.path };
}
interface ProtocolClient {
  invoke: NativeAccountClient["invoke"];
  readState: NativeAccountClient["readState"];
}
interface ProtocolInputs {
  invocation: string;
  account_sid: string;
  profile_root: string;
  runtime: Tool;
  fixture: Tool;
  directory: string;
  environment: Record<string, string>;
}
/** Data/protocol exercise only. Actual CLI owns default client/source/process custody. */
export async function exerciseAccountCapability(
  client: ProtocolClient,
  input: ProtocolInputs,
  deadline: number,
  observation: {
    stdout: () => Promise<Buffer>;
    hive: () => Promise<unknown>;
    pause?: () => Promise<void>;
  },
) {
  let started = false,
    stopSent = false,
    finishSent = false;
  const events: { operation: string; value: unknown }[] = [];
  let retainedEventBytes = 0;
  const call = (
    operation: Parameters<NativeAccountClient["invoke"]>[0],
    ...rest: [string, ...unknown[]]
  ) => {
    active(deadline);
    const value = client.invoke(
      operation,
      rest[0],
      (rest[1] ?? null) as Parameters<NativeAccountClient["invoke"]>[2],
      (rest[2] ?? null) as Parameters<NativeAccountClient["invoke"]>[3],
    );
    retainedEventBytes += Buffer.byteLength(JSON.stringify(value));
    assert.ok(
      events.length < 64 && retainedEventBytes <= 1024 * 1024,
      "inert capability protocol capture bound",
    );
    events.push({ operation, value });
    active(deadline);
    return value;
  };
  try {
    started = true;
    const launch = identity(
      call("start", "inert-capability", {
        executable: input.runtime.path,
        sha256: input.runtime.sha256,
        arguments: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          input.fixture.path,
          "-Invocation",
          input.invocation,
        ],
        directory: input.directory,
        environment: input.environment,
        nsis: false,
      }),
    );
    assert.ok(samePath(launch.path, input.runtime.path));
    let fixture: Record<string, unknown> | undefined,
      visible: Record<string, unknown> | undefined,
      child: ReturnType<typeof identity> | undefined;
    const observationDeadline = Math.min(deadline - 15000, performance.now() + 25000);
    while (performance.now() < observationDeadline) {
      const view = object(call("observe", "inert-capability"));
      assert.equal(view.exited, false);
      const members = (view.processes as unknown[]).map(identity);
      assert.equal(
        members.filter(
          (member) =>
            member.pid === launch.pid &&
            member.started_filetime === launch.started_filetime &&
            samePath(member.path, launch.path),
        ).length,
        1,
      );
      const bytes = await observation.stdout();
      active(deadline);
      if (bytes.length) {
        fixture = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        exact(fixture, [
          "schema_version",
          "invocation",
          "fixture",
          "pid",
          "account_sid",
          "profile",
          "child_pid",
          "authority",
        ]);
        assert.equal(fixture.schema_version, 1);
        assert.equal(fixture.invocation, input.invocation);
        assert.equal(fixture.authority, "none");
        assert.equal(fixture.fixture, "inert-account-gui-profile-and-descendants");
        assert.equal(fixture.pid, launch.pid);
        assert.equal(fixture.account_sid, input.account_sid);
        assert.ok(samePath(String(fixture.profile), input.profile_root));
        const children = members.filter(
          (member) =>
            member.pid === fixture!.child_pid &&
            member.pid !== launch.pid &&
            samePath(member.path, input.runtime.path),
        );
        if (children.length === 1) {
          child = children[0];
          const window = object(
            call("window", "inert-capability", null, {
              pid: launch.pid,
              started_filetime: launch.started_filetime,
            }),
          );
          if (
            window.title === `Portcove inert account ${input.invocation.slice(0, 12)}` &&
            view.responding === true &&
            /^[1-9][0-9]*$/u.test(String(view.window_handle))
          ) {
            visible = view;
            break;
          }
        }
      }
      await (observation.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 100))))();
    }
    assert.ok(fixture && visible && child, "inert GUI/profile/descendant observation unavailable");
    const hive = object(await observation.hive());
    assert.equal(hive.account_sid, input.account_sid);
    assert.equal(hive.present, true);
    active(deadline);
    const close = object(
      call("close", "inert-capability", null, {
        pid: launch.pid,
        started_filetime: launch.started_filetime,
      }),
    );
    assert.equal(close.accepted, true);
    stopSent = true;
    const stopped = object(call("stop", "inert-capability"));
    const readback = object(call("readback", "inert-capability"));
    for (const value of [stopped, readback]) {
      assert.equal(value.root_pid, launch.pid);
      assert.equal(value.root_created_filetime, launch.started_filetime);
      assert.equal(value.root_exited, true);
      assert.equal(value.job_empty, true);
      assert.deepEqual(value.remaining_pids, []);
      assert.ok(Number.isSafeInteger(value.exit_code));
    }
    finishSent = true;
    const finished = object(call("finish", "inert-capability"));
    assert.equal(finished.group_empty, true);
    assert.equal(finished.roots, 1);
    const state = client.readState();
    assert.equal(state.phase, "settled");
    assert.deepEqual(state.group_remaining_pids, []);
    const roots = state.roots as unknown[];
    assert.ok(Array.isArray(roots) && roots.length === 1);
    const retainedRoot = object(roots[0]);
    assert.equal(retainedRoot.pid, launch.pid);
    assert.equal(retainedRoot.created_filetime, launch.started_filetime);
    assert.ok(samePath(String(retainedRoot.path), launch.path));
    const teardown = object(retainedRoot.teardown);
    assert.equal(teardown.root_exited, true);
    assert.equal(teardown.job_empty, true);
    assert.deepEqual(teardown.remaining_pids, []);
    active(deadline);
    return {
      authority: "none",
      native_acceptance: "not-established",
      scope: "one-time-inert-account-capability",
      launch,
      descendant: child,
      fixture,
      window: visible,
      hive,
      stopped,
      readback,
      finished,
      events,
    };
  } catch (error) {
    // Exactly one cleanup effect per kind. An ambiguous stop is never resent.
    // Existing client permits finish after ambiguity; bridge owns group cleanup.
    if (started && !finishSent) {
      finishSent = true;
      try {
        call("finish", "inert-capability");
      } catch {
        /* retained by actual client + outer supervisor */
      }
    }
    throw Object.assign(
      new Error("inert account capability refused; retain original capture", { cause: error }),
      { events, stop_sent: stopSent, finish_sent: finishSent },
    );
  }
}

// Fixed owner-only observation/protection; the payload is data, never PS source.
export const accountCapabilityCustodyScript = String.raw`
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Broker requires pinned PowerShell7'}
$inputValue=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))|ConvertFrom-Json
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Elevated broker refused; capability requires ordinary broker token'}
foreach($file in $inputValue.paths){
 $cursor=[IO.Path]::GetFullPath($file);$first=$true;$depth=0
 while($cursor){
  if(++$depth -gt 64){throw 'Custody ancestry bound'}
  $item=Get-Item -LiteralPath $cursor -Force
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Custody link refused'}
  $acl=Get-Acl -LiteralPath $cursor;$trusted=@($owner,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Custody owner differs'}
  if($first -and [string]::Equals([IO.Path]::GetFullPath($file),'C:\ProgramData\PortcoveNativeQualification\capture',[StringComparison]::OrdinalIgnoreCase)) {
   if(-not $acl.AreAccessRulesProtected){throw 'Private capture inheritance unavailable'}
   foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted){throw 'Private capture permits another identity'}}
  }
  $rights=if($first){[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'}else{[Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $rights) -and $rule.IdentityReference.Value -notin $trusted){throw 'Custody replacement allowed'}
  }
  $first=$false;$next=[IO.Path]::GetDirectoryName($cursor);if(-not $next -or $next -eq $cursor){break};$cursor=$next
 }
}
if($inputValue.leaf){
 $null=New-Item -ItemType Directory -Path $inputValue.leaf -ErrorAction Stop
 $acl=Get-Acl -LiteralPath $inputValue.leaf;$acl.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $inputValue.leaf -AclObject $acl
 if(-not (Get-Acl -LiteralPath $inputValue.leaf).AreAccessRulesProtected){throw 'Fresh capture protection unavailable'}
}
$created=$null
if($inputValue.pid){$created=(Get-Process -Id $inputValue.pid -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()}
[ordered]@{broker_sid=$owner;created_filetime=$created;hive_present=$(if($inputValue.sid){Test-Path -LiteralPath ('Registry::HKEY_USERS\'+$inputValue.sid)}else{$false});powershell_major=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress
`;
function closedEnvironment(temp: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.SystemRoot,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    TEMP: temp,
    TMP: temp,
  };
}
function sync(
  runtime: Tool,
  args: string[],
  deadline: number,
  temp: string,
  extra: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
) {
  const value = spawnSync(runtime.path, args, {
    ...extra,
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.min(10000, active(deadline)),
    maxBuffer: 128 * 1024,
    env: closedEnvironment(temp),
  });
  assert.equal(value.error, undefined, value.error?.message);
  assert.equal(value.status, 0, value.stderr);
  active(deadline);
  return String(value.stdout);
}
/** Bounded original refusal diagnostics; a wrapper must not erase HKU AccessDenied. */
export function accountCapabilityFailureCauses(failure: unknown) {
  const causes: { name: string; message: string }[] = [];
  const seen = new Set<unknown>();
  let remaining = 65536;
  while (failure instanceof Error && !seen.has(failure) && causes.length < 6 && remaining > 0) {
    seen.add(failure);
    const message = failure.message.slice(0, remaining);
    remaining -= message.length;
    causes.push({ name: failure.name.slice(0, 128), message });
    failure = failure.cause;
  }
  return causes;
}
export function accountCapabilityObservationArguments(payload: object) {
  const bytes = Buffer.from(JSON.stringify(payload));
  assert.ok(bytes.length <= 65536);
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `& {${accountCapabilityCustodyScript}} '${bytes.toString("base64")}'`,
  ];
}
function observe(runtime: Tool, payload: object, deadline: number, temp: string) {
  return object(
    JSON.parse(sync(runtime, accountCapabilityObservationArguments(payload), deadline, temp)),
  );
}
const capabilityFiles = [
  "bridge-state.json",
  "bridge-configuration.json",
  "inert-capability.stdout.bin",
  "inert-capability.stderr.bin",
  "broker.stdout.bin",
  "broker.stderr.bin",
] as const;
/** Historical retained bytes only. No new token/profile/window observation or native grant. */
export async function readAccountCapabilityResult(
  capture: string,
  accountSid: string,
  configurationSha256: string,
  deadline: number,
) {
  const marker = object(
    JSON.parse(
      (
        await bounded(
          path.join(capture, `setup-capability-${sha(accountSid)}.json`),
          32768,
          deadline,
        )
      ).toString("utf8"),
    ),
  );
  exact(marker, [
    "schema_version",
    "kind",
    "account_sid",
    "configuration_sha256",
    "invocation_id",
    "directory",
    "authority",
  ]);
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.kind, "one-time-account-capability-intent");
  assert.equal(marker.authority, "none");
  assert.equal(marker.account_sid, accountSid);
  assert.equal(marker.configuration_sha256, configurationSha256);
  hash(marker.invocation_id);
  const directory = path.join(capture, `setup-capability-${marker.invocation_id}`);
  assert.equal(marker.directory, directory);
  const report = object(
    JSON.parse(
      (
        await bounded(path.join(directory, "capability-result.json"), 2 * 1024 * 1024, deadline)
      ).toString("utf8"),
    ),
  );
  exact(report, [
    "schema_version",
    "outcome",
    "authority",
    "native_acceptance",
    "configuration_sha256",
    "account_sid",
    "invocation_id",
    "result",
    "files",
  ]);
  assert.equal(report.schema_version, 1);
  assert.equal(report.outcome, "observed");
  assert.equal(report.authority, "none");
  assert.equal(report.native_acceptance, "not-established");
  assert.equal(report.configuration_sha256, configurationSha256);
  assert.equal(report.account_sid, accountSid);
  assert.equal(report.invocation_id, marker.invocation_id);
  assert.ok(Array.isArray(report.files) && report.files.length === capabilityFiles.length);
  const names = new Set<string>();
  for (const value of report.files) {
    const entry = object(value);
    exact(entry, ["path", "bytes", "sha256"]);
    text(entry.path);
    hash(entry.sha256);
    assert.ok(
      capabilityFiles.includes(entry.path as (typeof capabilityFiles)[number]) &&
        !names.has(entry.path),
    );
    names.add(entry.path);
    const actual = await hashNativeCapturedFile(directory, entry.path, 4 * 1024 * 1024, deadline);
    assert.deepEqual(actual, entry);
  }
  const state = object(
    JSON.parse(
      (await bounded(path.join(directory, "bridge-state.json"), 65536, deadline)).toString("utf8"),
    ),
  );
  assert.equal(state.phase, "settled");
  assert.equal(state.invocation_id, marker.invocation_id);
  assert.deepEqual(state.group_remaining_pids, []);
  const derivedBytes = await bounded(
    path.join(directory, "bridge-configuration.json"),
    32768,
    deadline,
  );
  assert.equal(state.configuration_sha256, sha(derivedBytes));
  const derived = inspectAccountCapabilityBoundary(JSON.parse(derivedBytes.toString("utf8")));
  assert.equal(derived.account_sid, accountSid);
  assert.equal(derived.capture_root, directory);
  active(deadline);
  return {
    directory,
    outcome: "already-observed",
    authority: "none",
    native_acceptance: "not-established",
    scope: "retained-one-time-capability-readback",
    report,
  };
}
async function actualCapability(file: string, expected: string, deadline: number) {
  assert.equal(process.platform, "win32");
  hash(expected);
  const original = await bounded(file, 32768, deadline);
  assert.equal(sha(original), expected);
  const config = inspectAccountCapabilityConfiguration(JSON.parse(original.toString("utf8")));
  assert.ok(
    samePath(config.controller.root, root) &&
      samePath(path.join(root, "scripts/release-native-account-capability.mts"), own),
  );
  assert.ok(samePath(config.tools.node.path, process.execPath));
  const boundaryBytes = await bounded(config.boundary.path, 32768, deadline);
  assert.equal(sha(boundaryBytes), config.boundary.sha256);
  const boundary = inspectAccountCapabilityBoundary(JSON.parse(boundaryBytes.toString("utf8")));
  assert.ok(
    samePath(boundary.controller_root, root) && samePath(boundary.capture_root, captureRoot),
  );
  assert.equal(
    boundary.helper_sha256,
    config.source_sha256["scripts/native-qualification-account.cs.txt"],
  );
  assert.ok(
    samePath(
      config.tools.fixture_powershell.path,
      path.join(String(process.env.SystemRoot), "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ),
  );
  const pins = async () => {
    assert.equal(sha(await bounded(file, 32768, deadline)), expected);
    assert.equal(sha(await bounded(config.boundary.path, 32768, deadline)), config.boundary.sha256);
    for (const name of capabilitySources)
      assert.equal(
        sha(await bounded(path.join(root, name), 4 * 1024 * 1024, deadline)),
        config.source_sha256[name],
      );
    for (const [name, tool] of Object.entries(config.tools))
      assert.equal(
        sha(
          await bounded(
            tool.path,
            name === "node" || name === "git" ? 128 * 1024 * 1024 : 64 * 1024 * 1024,
            deadline,
          ),
        ),
        tool.sha256,
      );
    const environment = {
      ...closedEnvironment(boundary.capture_root),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (args: string[]) => {
      const result = spawnSync(
        config.tools.git.path,
        [
          "--no-optional-locks",
          "-C",
          root,
          "-c",
          "core.hooksPath=NUL",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: environment,
          timeout: Math.min(5000, active(deadline)),
          maxBuffer: 65536,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return String(result.stdout).trim();
    };
    assert.equal(git(["rev-parse", "HEAD"]), config.controller.revision);
    assert.equal(git(["rev-parse", "HEAD^{tree}"]), config.controller.tree);
    assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
    assert.deepEqual(
      git(["ls-files", "--error-unmatch", "--", ...capabilitySources])
        .split(/\r?\n/u)
        .sort(),
      [...capabilitySources].sort(),
    );
    active(deadline);
  };
  await pins();
  assert.match(
    sync(
      config.tools.fixture_powershell,
      ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      deadline,
      boundary.capture_root,
    ).trim(),
    /^5[.]1[.][0-9]+[.][0-9]+$/u,
  );
  const custodyPaths = [
    file,
    config.boundary.path,
    root,
    boundary.capture_root,
    ...capabilitySources.map((name) => path.join(root, name)),
    ...Object.values(config.tools).map((tool) => tool.path),
  ];
  const before = observe(
    config.tools.powershell,
    { paths: custodyPaths, leaf: null, pid: null, sid: null },
    deadline,
    boundary.capture_root,
  );
  assert.equal(before.broker_sid, boundary.broker_sid);
  const invocation = randomBytes(32).toString("hex");
  let claim: Awaited<ReturnType<typeof createAccountCapabilityIntent>>;
  try {
    claim = await createAccountCapabilityIntent(
      boundary.capture_root,
      boundary.account_sid,
      expected,
      invocation,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const retained = await readAccountCapabilityResult(
        boundary.capture_root,
        boundary.account_sid,
        expected,
        deadline,
      );
      await pins();
      return retained;
    }
    throw error;
  }
  const directory = claim.directory;
  observe(
    config.tools.powershell,
    { paths: custodyPaths, leaf: directory, pid: null, sid: null },
    deadline,
    boundary.capture_root,
  );
  const derived = { ...boundary, capture_root: directory },
    derivedBytes = Buffer.from(JSON.stringify(derived)),
    configuration = path.join(directory, "bridge-configuration.json");
  await writeNew(configuration, derivedBytes);
  const work = path.join(boundary.work_root, `setup-capability-${invocation}`);
  await mkdir(work);
  const command = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    path.join(root, "scripts/native-qualification-account-bridge.ps1"),
    "-Configuration",
    configuration,
    "-ExpectedConfigurationSha256",
    sha(derivedBytes),
    "-InvocationId",
    invocation,
  ];
  await pins();
  const bridge = spawn(config.tools.powershell.path, command, {
    cwd: root,
    windowsHide: true,
    env: closedEnvironment(directory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const streams = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let streamError: unknown;
  for (const name of ["stdout", "stderr"] as const)
    bridge[name].on("data", (bytes: Buffer) => {
      if (streams[name].length + bytes.length > 4 * 1024 * 1024) {
        streamError = new Error("broker stream limit exceeded");
        bridge.kill();
      } else streams[name] = Buffer.concat([streams[name], bytes]);
    });
  const exited = new Promise<number | null>((resolve, reject) => {
    bridge.once("error", reject);
    bridge.once("close", resolve);
  });
  void exited.catch(() => undefined);
  let result: unknown, failure: unknown;
  const savedStreams = new Set<string>();
  const saveStreams = async () => {
    for (const name of ["stdout", "stderr"] as const) {
      if (savedStreams.has(name)) continue;
      savedStreams.add(name);
      await writeNew(path.join(directory, `broker.${name}.bin`), streams[name]);
    }
  };
  try {
    const brokerPid = bridge.pid;
    assert.ok(brokerPid);
    const broker = observe(
      config.tools.powershell,
      { paths: custodyPaths, leaf: null, pid: brokerPid, sid: null },
      deadline,
      directory,
    );
    assert.equal(broker.broker_sid, boundary.broker_sid);
    assert.match(String(broker.created_filetime), /^[1-9][0-9]+$/u);
    const binding: NativeAccountBinding = {
      invocation_id: invocation,
      configuration_sha256: sha(derivedBytes),
      helper_sha256: boundary.helper_sha256,
      broker_pid: brokerPid,
      broker_created_filetime: String(broker.created_filetime),
      capture_root: directory,
      powershell: config.tools.powershell,
    };
    const transport: NativeAccountTransport = (executable, args, options) => {
      active(deadline);
      assert.equal(executable, config.tools.powershell.path);
      return spawnSync(executable, [...args], {
        ...options,
        timeout: Math.min(options.timeout ?? 30000, active(deadline)),
        env: closedEnvironment(directory),
      });
    };
    const client = new NativeAccountClient(binding, transport);
    while (true) {
      active(deadline);
      try {
        client.readState();
        break;
      } catch (error) {
        if (bridge.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const drive = path.parse(boundary.profile_root).root;
    const fixtureSha = config.source_sha256["scripts/fixtures/native-account-gui-probe.ps1"];
    hash(fixtureSha);
    result = await exerciseAccountCapability(
      client,
      {
        invocation,
        account_sid: boundary.account_sid,
        profile_root: boundary.profile_root,
        runtime: config.tools.fixture_powershell,
        fixture: {
          path: path.join(root, "scripts/fixtures/native-account-gui-probe.ps1"),
          sha256: fixtureSha,
        },
        directory: work,
        environment: {
          SystemRoot: String(process.env.SystemRoot),
          WINDIR: String(process.env.SystemRoot),
          PATH: path.join(String(process.env.SystemRoot), "System32"),
          USERPROFILE: boundary.profile_root,
          HOMEDRIVE: drive.replace(/\\$/u, ""),
          HOMEPATH: boundary.profile_root.slice(drive.length - 1),
          APPDATA: path.join(work, "APPDATA"),
          LOCALAPPDATA: path.join(work, "LOCALAPPDATA"),
          TEMP: work,
          TMP: work,
        },
      },
      deadline,
      {
        stdout: () => readNativeCapturedStream(directory, "inert-capability.stdout.bin"),
        hive: async () => {
          const value = observe(
            config.tools.powershell,
            { paths: custodyPaths, leaf: null, pid: brokerPid, sid: boundary.account_sid },
            deadline,
            directory,
          );
          assert.equal(value.created_filetime, binding.broker_created_filetime);
          return { account_sid: boundary.account_sid, present: value.hive_present };
        },
      },
    );
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let status: number | null;
    try {
      status = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(
            () => reject(new Error("broker exit original deadline")),
            active(deadline),
          );
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
    assert.equal(status, 0);
    assert.equal(streamError, undefined);
    await pins();
    await saveStreams();
    const files = [];
    for (const name of capabilityFiles)
      files.push(await hashNativeCapturedFile(directory, name, 4 * 1024 * 1024, deadline));
    const reportBytes = JSON.stringify({
      schema_version: 1,
      outcome: "observed",
      authority: "none",
      native_acceptance: "not-established",
      configuration_sha256: expected,
      account_sid: boundary.account_sid,
      invocation_id: invocation,
      result,
      files,
    });
    assert.ok(Buffer.byteLength(reportBytes) <= 2 * 1024 * 1024);
    await writeNew(path.join(directory, "capability-result.json"), reportBytes);
    return {
      directory,
      outcome: "observed",
      authority: "none",
      native_acceptance: "not-established",
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await saveStreams();
    } catch {
      /* preserve original partial file without retry */
    }
    if (failure)
      await writeNew(
        path.join(directory, "capability-failure.json"),
        JSON.stringify({
          authority: "none",
          outcome: "refused-or-ambiguous",
          message: errorMessage(failure),
          causes: accountCapabilityFailureCauses(failure),
          invocation_id: invocation,
        }),
      );
    // The admitted outer process supervisor owns all descendants on interruption.
    // A local broker exit or kill is never substituted for native group readback.
  }
}
async function main() {
  const guarded = process.argv[2] === "--account-capability-guarded";
  assert.equal(
    process.argv.length,
    guarded ? 5 : 4,
    "usage: release-native-account-capability.mts CONFIG_PATH SHA256",
  );
  const fileArgument = process.argv[guarded ? 3 : 2];
  assert.ok(fileArgument);
  const file = path.resolve(fileArgument),
    expected = process.argv[guarded ? 4 : 3];
  hash(expected);
  const inherited = process.env.PORTCOVE_ACCOUNT_CAPABILITY_DEADLINE;
  if (guarded) {
    assert.ok(inherited, "Guarded entry requires original outer deadline");
    assert.ok(
      process.env.PORTCOVE_RESOURCE_RESERVATION,
      "Guarded entry requires verified outer capacity",
    );
  }
  const milliseconds = inherited ? Math.min(60000, Date.parse(inherited) - Date.now()) : 60000;
  assert.ok(Number.isFinite(milliseconds) && milliseconds > 0);
  const deadline = performance.now() + milliseconds;
  if (guarded) {
    process.exitCode = await resourceEntrypoint("analysis", async () => {
      console.log(JSON.stringify(await actualCapability(file, expected, deadline)));
      return 0;
    });
    return;
  }
  const deadlineUtc = new Date(Date.now() + milliseconds).toISOString(),
    signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Always own a finite descendant supervisor, including under an inherited broader lease.
    process.exitCode = await runResourceCommand(
      "analysis",
      process.execPath,
      [own, "--account-capability-guarded", file, expected],
      {
        environment: {
          ...closedEnvironment(process.env.TEMP ?? root),
          PORTCOVE_ACCOUNT_CAPABILITY_DEADLINE: deadlineUtc,
        },
        queueDeadline: deadline,
        exclusive: ["native-account:one-time-setup-capability"],
        supervise: async (args, options) =>
          runRustTests(args, {
            ...options,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              assert.ok(options.acquireLock);
              const lease = await options.acquireLock(metadata, admission);
              try {
                timer = setTimeout(() => signal.emit("SIGTERM"), active(deadline));
                return lease;
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
          }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === own)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
