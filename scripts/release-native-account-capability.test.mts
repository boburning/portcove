import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  NativeAccountClient,
  type NativeAccountTransport,
} from "./native-qualification-account-client.mts";
import {
  readNativeCapturedStream,
  hashNativeCapturedFile,
} from "./release-native-capture-files.mts";
import {
  accountCapabilityCustodyScript,
  accountCapabilityFailureCauses,
  accountCapabilityObservationArguments,
  readAccountCapabilityResult,
  capabilitySources,
  createAccountCapabilityIntent,
  exerciseAccountCapability,
  inspectAccountCapabilityBoundary,
  inspectAccountCapabilityConfiguration,
} from "./release-native-account-capability.mts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(
  options: {
    wrongSid?: boolean;
    noHive?: boolean;
    loseStop?: boolean;
    wrongWindow?: boolean;
    registry?: Record<string, unknown>;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inert-account-capability-"));
  const runtime = path.join(directory, "pinned-inert-powershell.exe");
  await writeFile(runtime, "inert; never executed");
  const binding = {
    invocation_id: "a".repeat(64),
    configuration_sha256: "b".repeat(64),
    helper_sha256: "c".repeat(64),
    broker_pid: 901,
    broker_created_filetime: "134000000000000001",
    capture_root: directory,
    powershell: { path: runtime, sha256: sha("inert; never executed") },
  };
  const identity = { pid: 1001, path: runtime, started_filetime: "134000000000000002" },
    child = { pid: 1002, path: runtime, started_filetime: "134000000000000003" };
  const accountSid = "S-1-5-21-1-2-3-1003",
    profile = path.join(directory, "qualification-profile");
  const teardown = {
    root_pid: identity.pid,
    root_created_filetime: identity.started_filetime,
    exit_code: 1,
    root_exited: true,
    job_empty: true,
    remaining_pids: [],
    observed_at: "2026-10-21T12:00:00Z",
  };
  const state = {
    schema_version: 1,
    authority: "none",
    invocation_id: binding.invocation_id,
    configuration_sha256: binding.configuration_sha256,
    broker_pid: binding.broker_pid,
    broker_created_filetime: binding.broker_created_filetime,
    sequence: 0,
    phase: "prepared",
    roots: [] as unknown[],
    group_remaining_pids: [] as number[],
  };
  const save = () =>
    writeFileSync(path.join(directory, "bridge-state.json"), JSON.stringify(state));
  save();
  const calls: { operation: string; sequence: number; launch: unknown }[] = [];
  const transport: NativeAccountTransport = (command, args, requestOptions) => {
    assert.equal(command, runtime);
    assert.equal(requestOptions.windowsHide, true);
    assert.ok(
      !Object.keys(requestOptions.env ?? {}).some((name) =>
        /TOKEN|SECRET|PASSWORD|SIGNING/iu.test(name),
      ),
    );
    const request = JSON.parse(
      Buffer.from(String(args[args.indexOf("-RequestBase64") + 1]), "base64").toString("utf8"),
    ) as {
      sequence: number;
      operation: string;
      launch: { arguments: string[]; nsis: boolean } | null;
      target: unknown;
    };
    assert.equal(request.sequence, state.sequence + 1);
    state.sequence = request.sequence;
    calls.push({
      operation: request.operation,
      sequence: request.sequence,
      launch: request.launch,
    });
    let value: unknown;
    switch (request.operation) {
      case "start": {
        assert.ok(request.launch);
        assert.deepEqual(request.launch.arguments, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(directory, "fixed-probe.ps1"),
          "-Invocation",
          binding.invocation_id,
        ]);
        assert.equal(request.launch.nsis, false);
        state.phase = "running";
        state.roots = [
          {
            id: "inert-capability",
            pid: identity.pid,
            created_filetime: identity.started_filetime,
            path: runtime,
            sha256: binding.powershell.sha256,
            teardown: null,
          },
        ];
        state.group_remaining_pids = [identity.pid, child.pid];
        writeFileSync(
          path.join(directory, "inert-capability.stdout.bin"),
          JSON.stringify({
            schema_version: 1,
            invocation: binding.invocation_id,
            fixture: "inert-account-gui-profile-and-descendants",
            pid: identity.pid,
            account_sid: options.wrongSid ? "S-1-5-21-1-2-3-9999" : accountSid,
            profile,
            child_pid: child.pid,
            authority: "none",
            registry: {
              schema_version: 1,
              invocation: binding.invocation_id,
              pid: identity.pid,
              account_sid: accountSid,
              profile,
              hive_present: !options.noHive,
              provenance: "target-account-HKCU",
              authority: "none",
              uninstall: [],
              webview: [],
              ...options.registry,
            },
          }),
        );
        writeFileSync(path.join(directory, "inert-capability.stderr.bin"), Buffer.alloc(0));
        value = identity;
        break;
      }
      case "observe":
        value = {
          exited: false,
          exit_code: null,
          processes: [identity, child],
          responding: true,
          window_title: "controlled",
          window_handle: "22",
        };
        break;
      case "window":
        assert.deepEqual(request.target, {
          pid: identity.pid,
          started_filetime: identity.started_filetime,
        });
        value = {
          title: options.wrongWindow
            ? "foreign"
            : `Portcove inert account ${binding.invocation_id.slice(0, 12)}`,
        };
        break;
      case "close":
        value = { accepted: true };
        break;
      case "stop":
        state.roots = [
          {
            id: "inert-capability",
            pid: identity.pid,
            created_filetime: identity.started_filetime,
            path: runtime,
            teardown,
          },
        ];
        state.group_remaining_pids = [];
        value = teardown;
        break;
      case "readback":
        value = teardown;
        break;
      case "finish":
        state.phase = "settled";
        state.group_remaining_pids = [];
        value = { group_empty: true, roots: state.roots.length };
        break;
      default:
        throw new Error("unexpected operation");
    }
    save();
    if (options.loseStop && request.operation === "stop")
      return {
        pid: 12,
        output: [],
        status: 1,
        signal: null,
        stdout: "",
        stderr: "controlled lost stop response after effect",
      };
    return {
      pid: 12,
      output: [],
      status: 0,
      signal: null,
      stderr: "",
      stdout: JSON.stringify({
        schema_version: 1,
        invocation_id: binding.invocation_id,
        sequence: request.sequence,
        broker_pid: binding.broker_pid,
        value,
      }),
    };
  };
  const client = new NativeAccountClient(binding, transport);
  const input = {
    invocation: binding.invocation_id,
    account_sid: accountSid,
    profile_root: profile,
    runtime: binding.powershell,
    fixture: { path: path.join(directory, "fixed-probe.ps1"), sha256: "d".repeat(64) },
    directory,
    environment: { SystemRoot: "C:\\Windows" },
  };
  const observations = {
    stdout: () => readNativeCapturedStream(directory, "inert-capability.stdout.bin"),
    checkBroker: async () => {
      assert.equal(state.broker_pid, binding.broker_pid);
    },
    pause: async () => {
      throw new Error("controlled unavailable GUI; no sleep/host operation");
    },
  };
  return {
    directory,
    client,
    input,
    observations,
    calls,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

void test("fixed capability protocol joins actual client framing, retained fixture bytes, owned GUI and full teardown", async () => {
  const f = await fixture();
  try {
    const result = await exerciseAccountCapability(
      f.client,
      f.input,
      performance.now() + 60000,
      f.observations,
    );
    assert.equal(result.authority, "none");
    assert.equal(result.native_acceptance, "not-established");
    assert.deepEqual(
      f.calls.map((call) => call.operation),
      ["start", "observe", "window", "close", "stop", "readback", "finish"],
    );
    assert.equal(result.descendant.pid, 1002);
    assert.equal(result.hive.hive_present, true);
    assert.equal(result.hive.pid, result.launch.pid);
    assert.equal(result.hive.provenance, "target-account-HKCU");
    assert.equal(f.client.readState().phase, "settled");
    assert.equal(
      (await readNativeCapturedStream(f.directory, "inert-capability.stderr.bin")).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});
void test("GUI SID JSON requires matching loaded own-HKCU data and a private-owned window", async () => {
  for (const options of [{ wrongSid: true }, { noHive: true }, { wrongWindow: true }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(
        exerciseAccountCapability(f.client, f.input, performance.now() + 60000, f.observations),
        /capability refused/u,
      );
      assert.equal(f.calls.filter((call) => call.operation === "start").length, 1);
      assert.equal(f.calls.filter((call) => call.operation === "stop").length, 0);
      assert.equal(f.calls.filter((call) => call.operation === "finish").length, 1);
      assert.ok((await readFile(path.join(f.directory, "inert-capability.stdout.bin"))).length > 0);
    } finally {
      await f.dispose();
    }
  }
});
void test("own-HKCU projection must belong to the exact held GUI root and appointed profile", async () => {
  for (const registry of [
    { pid: 1002 },
    { invocation: "b".repeat(64) },
    { account_sid: "S-1-5-21-1-2-3-9999" },
    { profile: path.resolve("foreign-profile") },
    { hive_present: false },
    { provenance: "broker-HKU" },
    { authority: "accepted" },
    { schema_version: 2 },
    { uninstall: {} },
    { webview: Array.from({ length: 129 }, () => ({})) },
    { hive_present: undefined },
    { padding: "x".repeat(128 * 1024) },
  ]) {
    const f = await fixture({ registry });
    try {
      await assert.rejects(
        exerciseAccountCapability(f.client, f.input, performance.now() + 60000, f.observations),
        /capability refused/u,
      );
      assert.deepEqual(
        f.calls.map((entry) => entry.operation),
        ["start", "observe", "finish"],
      );
    } finally {
      await f.dispose();
    }
  }
  assert.doesNotMatch(accountCapabilityCustodyScript, /HKEY_USERS|Registry::|hive_present/u);
  assert.ok(capabilitySources.includes("scripts/native-qualification-account-registry.ps1"));
});
void test(
  "actual GUI registry assignment invokes the fixed sibling reader in-process with original invocation",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "capability-registry-fixture-"));
    try {
      await mkdir(path.join(directory, "fixtures"));
      const source = fileURLToPath(
        new URL("./fixtures/native-account-gui-probe.ps1", import.meta.url),
      );
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const invocation = "a".repeat(64);
      await writeFile(
        path.join(directory, "native-qualification-account-registry.ps1"),
        `param([string]$Invocation) [ordered]@{invocation=$Invocation;pid=$PID;hive_present=$true;provenance='target-account-HKCU';authority='none'} | ConvertTo-Json -Compress`,
      );
      const output = path.join(directory, "fixtures", "assignment.ps1");
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      $ErrorActionPreference='Stop';$tokens=$null;$errors=$null;
      $tree=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Fixture parse failed'};
      $assignment=$tree.Find({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$registry'},$true);
      if(-not $assignment){throw 'Actual registry source assignment absent'};
      [IO.File]::WriteAllText(${quote(output)}, ('param([string]$Invocation)' + [Environment]::NewLine + $assignment.Extent.Text + [Environment]::NewLine + '$registry | ConvertTo-Json -Compress'));
      $observed=& ${quote(output)} -Invocation '${invocation}' | ConvertFrom-Json;
      if($observed.pid -ne $PID -or $observed.invocation -cne '${invocation}' -or $observed.provenance -cne 'target-account-HKCU'){throw 'Reader launched separately or invocation changed'};
      'fixed-reader-assignment-passed'
    `,
        ],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "fixed-reader-assignment-passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
void test("lost stop remains ambiguous with no repeated stop or launch; only fixed finish recovery", async () => {
  const f = await fixture({ loseStop: true });
  try {
    await assert.rejects(
      exerciseAccountCapability(f.client, f.input, performance.now() + 60000, f.observations),
      /capability refused/u,
    );
    assert.equal(f.calls.filter((call) => call.operation === "stop").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "finish").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "start").length, 1);
    assert.equal(f.client.failures.length, 1);
    assert.equal(f.client.failures[0]!.operation, "stop");
  } finally {
    await f.dispose();
  }
});
void test("expired original clock makes zero client calls and cannot mint a successful probe", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      exerciseAccountCapability(f.client, f.input, performance.now() - 1, f.observations),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.dispose();
  }
});
void test("per-appointed-SID CreateNew intent refuses config/nonce changes without replacing retained evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capability-claim-"));
  try {
    const sid = "S-1-5-21-1-2-3-1003";
    await createAccountCapabilityIntent(directory, sid, "a".repeat(64), "b".repeat(64));
    const marker = path.join(directory, `setup-capability-${sha(sid)}.json`),
      before = await readFile(marker);
    await assert.rejects(
      createAccountCapabilityIntent(directory, sid, "c".repeat(64), "d".repeat(64)),
      /EEXIST/u,
    );
    assert.deepEqual(await readFile(marker), before);
    await createAccountCapabilityIntent(
      directory,
      "S-1-5-21-1-2-3-1004",
      "c".repeat(64),
      "d".repeat(64),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("strict setup config/boundaries cannot import issuers, candidate selectors or another credential purpose", () => {
  const tool = { path: path.resolve("inert.exe"), sha256: "a".repeat(64) };
  const raw = {
    schema_version: 1,
    kind: "native-account-setup-capability",
    boundary: tool,
    controller: { root: path.resolve("."), revision: "b".repeat(40), tree: "c".repeat(40) },
    tools: { node: tool, powershell: tool, fixture_powershell: tool, git: tool },
    source_sha256: Object.fromEntries(capabilitySources.map((name) => [name, "d".repeat(64)])),
  };
  assert.equal(inspectAccountCapabilityConfiguration(raw).kind, raw.kind);
  for (const field of ["issuer", "token", "signing_key", "candidate", "harness"])
    assert.throws(() => inspectAccountCapabilityConfiguration({ ...raw, [field]: "forbidden" }));
  const boundary = {
    schema_version: 1,
    broker_sid: "S-1-5-21-1-2-3-1001",
    account_sid: "S-1-5-21-1-2-3-1003",
    account_name: "PortcoveNativeQual",
    profile_root: path.resolve("profile"),
    work_root: path.resolve("work"),
    capture_root: path.resolve("capture"),
    helper_sha256: "a".repeat(64),
    controller_root: path.resolve("controller"),
  };
  assert.equal(inspectAccountCapabilityBoundary(boundary).schema_version, 1);
  assert.equal(
    inspectAccountCapabilityBoundary({
      ...boundary,
      schema_version: 2,
      purpose: "ordinary-public-proof",
      account_name: "PortcovePublicProof",
    }).schema_version,
    2,
  );
  assert.throws(() =>
    inspectAccountCapabilityBoundary({ ...boundary, purpose: "ordinary-public-proof" }),
  );
  assert.throws(() =>
    inspectAccountCapabilityBoundary({
      ...boundary,
      schema_version: 2,
      purpose: "semantic-review",
    }),
  );
});
void test(
  "fixed owner observation and inert GUI payload parse without executing either",
  { skip: process.platform !== "win32" },
  () => {
    const fixtureFile = fileURLToPath(
      new URL("./fixtures/native-account-gui-probe.ps1", import.meta.url),
    );
    const script = `$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PORTCOVE_TEST_FIXED_SCRIPT)),[ref]$tokens,[ref]$errors);if($errors.Count){throw $errors[0]};[void][Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_TEST_FIXED_FIXTURE,[ref]$tokens,[ref]$errors);if($errors.Count){throw $errors[0]};Write-Output 'parsed-only'`;
    const parsed = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: {
        ...process.env,
        PORTCOVE_TEST_FIXED_SCRIPT: Buffer.from(accountCapabilityCustodyScript).toString("base64"),
        PORTCOVE_TEST_FIXED_FIXTURE: fixtureFile,
      },
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout.trim(), "parsed-only");
  },
);

void test("completed setup readback rehashes exact retained streams; ambiguous claim cannot be relaunched", async () => {
  const f = await fixture(),
    capture = await mkdtemp(path.join(os.tmpdir(), "capability-retained-"));
  try {
    const expected = "e".repeat(64),
      deadline = performance.now() + 60000;
    const marker = await createAccountCapabilityIntent(
      capture,
      f.input.account_sid,
      expected,
      f.input.invocation,
    );
    await assert.rejects(
      readAccountCapabilityResult(capture, f.input.account_sid, expected, deadline),
      /ENOENT/u,
    );
    await assert.rejects(
      createAccountCapabilityIntent(capture, f.input.account_sid, expected, "f".repeat(64)),
      /EEXIST/u,
    );
    const result = await exerciseAccountCapability(f.client, f.input, deadline, f.observations);
    await mkdir(marker.directory);
    const derived = {
      schema_version: 1,
      broker_sid: "S-1-5-21-1-2-3-1001",
      account_sid: f.input.account_sid,
      account_name: "PortcoveNativeQual",
      profile_root: f.input.profile_root,
      work_root: path.join(capture, "work"),
      capture_root: marker.directory,
      helper_sha256: "a".repeat(64),
      controller_root: path.resolve("controller"),
    };
    const derivedBytes = JSON.stringify(derived);
    const state = JSON.parse(
      await readFile(path.join(f.directory, "bridge-state.json"), "utf8"),
    ) as Record<string, unknown>;
    state.configuration_sha256 = sha(derivedBytes);
    await writeFile(path.join(marker.directory, "bridge-state.json"), JSON.stringify(state));
    await writeFile(path.join(marker.directory, "bridge-configuration.json"), derivedBytes);
    for (const name of ["inert-capability.stdout.bin", "inert-capability.stderr.bin"])
      await writeFile(
        path.join(marker.directory, name),
        await readFile(path.join(f.directory, name)),
      );
    for (const name of ["broker.stdout.bin", "broker.stderr.bin"])
      await writeFile(path.join(marker.directory, name), Buffer.alloc(0));
    const files = [];
    for (const name of [
      "bridge-state.json",
      "bridge-configuration.json",
      "inert-capability.stdout.bin",
      "inert-capability.stderr.bin",
      "broker.stdout.bin",
      "broker.stderr.bin",
    ])
      files.push(await hashNativeCapturedFile(marker.directory, name, 4 * 1024 * 1024, deadline));
    await writeFile(
      path.join(marker.directory, "capability-result.json"),
      JSON.stringify({
        schema_version: 1,
        outcome: "observed",
        authority: "none",
        native_acceptance: "not-established",
        configuration_sha256: expected,
        account_sid: f.input.account_sid,
        invocation_id: f.input.invocation,
        result,
        files,
      }),
    );
    const retained = await readAccountCapabilityResult(
      capture,
      f.input.account_sid,
      expected,
      deadline,
    );
    assert.equal(retained.outcome, "already-observed");
    assert.equal(retained.native_acceptance, "not-established");
    await assert.rejects(
      readAccountCapabilityResult(capture, f.input.account_sid, "f".repeat(64), deadline),
    );
    await writeFile(path.join(marker.directory, "broker.stderr.bin"), "changed retained bytes");
    await assert.rejects(
      readAccountCapabilityResult(capture, f.input.account_sid, expected, deadline),
    );
  } finally {
    await f.dispose();
    await rm(capture, { recursive: true, force: true });
  }
});
void test(
  "production observation argv delivers only base64 data to its fixed script block",
  { skip: process.platform !== "win32" },
  () => {
    const payload = { paths: ["C:\\a' ; $env:FORBIDDEN=1 #"], leaf: null, pid: null, sid: null };
    const args = accountCapabilityObservationArguments(payload);
    assert.equal(args.length, 5);
    assert.equal(args[3], "-Command");
    const command = args[4]!.replace(
      accountCapabilityCustodyScript,
      `Write-Output ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])))`,
    );
    const observed = spawnSync("pwsh", [...args.slice(0, 4), command], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    assert.equal(observed.status, 0, observed.stderr);
    assert.deepEqual(JSON.parse(observed.stdout), payload);
  },
);
void test("failure wrappers retain bounded original HKU AccessDenied diagnostics", () => {
  const denied = new Error("Registry::HKEY_USERS\\S-1-5-21-1-2-3-1002: AccessDenied");
  const wrapped = new Error("Account capability refused", { cause: denied });
  assert.deepEqual(accountCapabilityFailureCauses(wrapped), [
    { name: "Error", message: wrapped.message },
    { name: "Error", message: denied.message },
  ]);
  denied.cause = wrapped;
  assert.equal(accountCapabilityFailureCauses(wrapped).length, 2);
  assert.equal(
    accountCapabilityFailureCauses(new Error("x".repeat(100000)))[0]!.message.length,
    65536,
  );
});
void test(
  "actual fixed principal guard refuses elevated before custody effects",
  { skip: process.platform !== "win32" },
  () => {
    const guard = accountCapabilityCustodyScript
      .split("\n")
      .find((line) => line.startsWith("if($principal.IsInRole("));
    assert.ok(guard);
    assert.ok(
      accountCapabilityCustodyScript.indexOf(guard) <
        accountCapabilityCustodyScript.indexOf("foreach($file"),
    );
    for (const elevated of [false, true]) {
      const script: string = `class ControlledPrincipal { [bool]$Elevated; [bool]IsInRole([object]$role){return $this.Elevated} }; $principal=[ControlledPrincipal]::new(); $principal.Elevated=$${elevated}; ${guard}; Write-Output 'ordinary'`;
      const observed = spawnSync(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      if (elevated) {
        assert.notEqual(observed.status, 0);
        assert.match(observed.stderr, /Elevated broker refused/u);
      } else {
        assert.equal(observed.status, 0, observed.stderr);
        assert.equal(observed.stdout.trim(), "ordinary");
      }
    }
  },
);
