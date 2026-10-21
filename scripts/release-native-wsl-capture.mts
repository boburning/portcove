/** Actual Windows parent -> fixed non-admin guest custody. Raw transferred
 * observations never themselves appoint a native Check or platform result. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openSync, writeSync, closeSync } from "node:fs";
import { writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireActualNativeInvocation } from "./release-native-attempt.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import {
  inspectNativeWslBoundary,
  nativeWslInvocationCommands,
} from "./release-native-wsl-boundary.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { inspectNativeWslEntryPins } from "./release-native-wsl-bootstrap.mts";
import {
  retainNativeCaptureWire,
  hashRetainedNativeCaptureFile,
} from "./release-native-wsl-wire.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { readNativeSchedulerToolDigest } from "./release-native-scheduler.mts";
import {
  observeActualNativeWslRegistration,
  inspectNativeWslGuestHost,
} from "./release-native-wsl-host.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const captures = new WeakMap<
  object,
  {
    claim: object;
    directory: string;
    requestSha: string;
    status: number | null;
    summarySha: string;
    wireSha: string | null;
    retained: Awaited<ReturnType<typeof retainNativeCaptureWire>> | null;
    registration_sha256: string;
    registration_files: readonly { name: string; sha256: string }[];
  }
>();
export function boundedNativeWslOperationTimeout(requested: number, available: number) {
  assert.ok(
    Number.isFinite(requested) && Number.isFinite(available) && requested >= 1 && available >= 1,
    "original guest operation budget exhausted before any effect",
  );
  return Math.floor(Math.min(requested, available));
}

async function sourcePin(root: string, filename: string) {
  const bytes = await readBoundedPublicBuildInputFile(root, filename, 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(!text.includes("\0") && !text.startsWith("\ufeff"));
  // The Linux checkout uses canonical Git LF bytes. The private controller is
  // independently clean at its exact tree; only this known text closure uses
  // the same CRLF -> LF checkout transform, never candidate package bytes.
  return sha(Buffer.from(text.replaceAll("\r\n", "\n")));
}

async function runFixedWsl(
  command: { executable: string; arguments: readonly string[] },
  input: AsyncIterable<Uint8Array> | null,
  directory: string,
  name: string,
  maximum: number,
  timeout: number,
  acceptableStatuses: readonly number[] = [0],
) {
  const admittedTimeout = boundedNativeWslOperationTimeout(timeout, remainingNativeParentBudget());
  assert.match(name, /^[a-z][a-z0-9-]{0,63}$/u);
  assert.ok(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 272 * 1024 * 1024);
  const output = openSync(path.join(directory, `${name}.stdout.bin`), "wx", 0o600),
    errorOutput = openSync(path.join(directory, `${name}.stderr.bin`), "wx", 0o600);
  let total = 0,
    errorTotal = 0,
    failure: unknown,
    status: number | null = null;
  const child = spawn(command.executable, command.arguments, {
    windowsHide: true,
    cwd: directory,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
      PATH: path.join(String(process.env.SystemRoot), "System32"),
      TEMP: directory,
      TMP: directory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const fail = (error: unknown) => {
    failure ??= error;
    child.stdin.destroy();
    child.kill();
  };
  const retain = (fd: number, data: Buffer, left: number) => {
    const bytes = data.subarray(0, Math.max(0, left));
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset);
      assert.ok(written > 0);
      offset += written;
    }
  };
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      retain(output, bytes, maximum - total);
      total += bytes.length;
      if (total > maximum) fail(new Error("guest output exceeded retained bound"));
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", (bytes: Buffer) => {
    try {
      retain(errorOutput, bytes, 4 * 1024 * 1024 - errorTotal);
      errorTotal += bytes.length;
      if (errorTotal > 4 * 1024 * 1024)
        fail(new Error("guest diagnostics exceeded retained bound"));
    } catch (error) {
      fail(error);
    }
  });
  const terminal = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      status = code;
      resolve();
    });
  });
  const timer = setTimeout(
    () =>
      fail(
        new Error(
          "fixed guest operation exceeded original parent lifetime; remote effect remains ambiguous",
        ),
      ),
    admittedTimeout,
  );
  const feed = input
    ? pipeline(Readable.from(input), child.stdin).catch((error) => {
        failure ??= error;
        child.kill();
      })
    : (child.stdin.end(), Promise.resolve());
  try {
    await Promise.all([terminal, feed]);
    if (failure) throw new Error(errorMessage(failure));
    assert.ok(
      status !== null && acceptableStatuses.includes(status),
      "fixed guest operation failed; retain original streams and reconcile",
    );
    return { status, output: path.join(directory, `${name}.stdout.bin`) };
  } finally {
    clearTimeout(timer);
    closeSync(output);
    closeSync(errorOutput);
  }
}
async function* bytesInput(header: string, bytes: Uint8Array) {
  yield Buffer.from(header);
  yield bytes;
}
async function* packageInput(header: string, filename: string) {
  yield Buffer.from(header);
  for await (const bytes of createReadStream(filename)) yield bytes as Buffer;
}

export function inspectWslNativeDriverPlan(value: unknown) {
  const raw: unknown = structuredClone(value);
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        (raw.schema_version === 2
          ? "account,boundary_configuration,capture_directory,capture_root,controller_root,entry_pins,host_expected,invocation_id,node,package,parent_deadline_utc,plan_sha256,predecessor,request_sha256,schema_version,stage_request_sha256"
          : "account,boundary_configuration,capture_directory,capture_root,controller_root,entry_pins,host_expected,invocation_id,node,package,parent_deadline_utc,plan_sha256,request_sha256,schema_version,stage_request_sha256") &&
      (raw.schema_version === 1 || raw.schema_version === 2),
  );
  for (const key of ["invocation_id", "request_sha256", "plan_sha256", "stage_request_sha256"])
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{64}$/u.test(raw[key]));
  assert.ok(
    typeof raw.controller_root === "string" &&
      path.win32.isAbsolute(raw.controller_root) &&
      typeof raw.capture_root === "string" &&
      path.win32.isAbsolute(raw.capture_root),
  );
  assert.equal(
    raw.capture_directory,
    path.win32.join(raw.capture_root, `native-attempt-${String(raw.invocation_id)}`),
  );
  assert.ok(
    isRecord(raw.package) &&
      Object.keys(raw.package).sort().join(",") === "bytes,path,sha256" &&
      typeof raw.package.path === "string" &&
      path.win32.isAbsolute(raw.package.path) &&
      Number.isSafeInteger(raw.package.bytes) &&
      Number(raw.package.bytes) > 0 &&
      Number(raw.package.bytes) <= 512 * 1024 * 1024 &&
      typeof raw.package.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.package.sha256),
  );
  const relative = path.win32.relative(raw.capture_root, raw.package.path);
  assert.ok(relative && !relative.startsWith("..") && !path.win32.isAbsolute(relative));
  let predecessor: { path: string; bytes: number; sha256: string } | null = null;
  if (raw.schema_version === 2 && raw.predecessor !== null) {
    const value = raw.predecessor;
    assert.ok(
      isRecord(value) &&
        Object.keys(value).sort().join(",") === "bytes,path,sha256" &&
        typeof value.path === "string" &&
        path.win32.isAbsolute(value.path) &&
        Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) > 0 &&
        Number(value.bytes) <= 512 * 1024 * 1024 &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sha256),
    );
    const relative = path.win32.relative(raw.capture_root, value.path);
    assert.ok(relative && !relative.startsWith("..") && !path.win32.isAbsolute(relative));
    assert.notEqual(value.sha256, raw.package.sha256);
    predecessor = { path: value.path, bytes: Number(value.bytes), sha256: value.sha256 };
  }
  assert.ok(
    isRecord(raw.node) &&
      Object.keys(raw.node).sort().join(",") === "path,sha256" &&
      typeof raw.node.path === "string" &&
      path.win32.isAbsolute(raw.node.path) &&
      typeof raw.node.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.node.sha256),
  );
  assert.ok(
    typeof raw.parent_deadline_utc === "string" &&
      Number.isFinite(Date.parse(raw.parent_deadline_utc)) &&
      new Date(raw.parent_deadline_utc).toISOString() === raw.parent_deadline_utc,
  );
  const boundary = inspectNativeWslBoundary(
    raw.boundary_configuration,
    raw.account,
    raw.controller_root,
    raw.capture_root,
  );
  const entry_pins = inspectNativeWslEntryPins(raw.entry_pins);
  assert.ok(
    isRecord(raw.host_expected) &&
      Object.keys(raw.host_expected).sort().join(",") === "machine_id_sha256,minimum_os_version" &&
      typeof raw.host_expected.machine_id_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.host_expected.machine_id_sha256) &&
      typeof raw.host_expected.minimum_os_version === "string" &&
      /^[0-9]+(?:\.[0-9]+){1,3}$/u.test(raw.host_expected.minimum_os_version),
  );
  assert.equal(entry_pins.supervisor_sha256, boundary.supervisor_sha256);
  return {
    entry_pins,
    host_expected: {
      machine_id_sha256: raw.host_expected.machine_id_sha256,
      minimum_os_version: raw.host_expected.minimum_os_version,
    },
    schema_version: raw.schema_version === 2 ? (2 as const) : (1 as const),
    invocation_id: String(raw.invocation_id),
    request_sha256: String(raw.request_sha256),
    plan_sha256: String(raw.plan_sha256),
    stage_request_sha256: String(raw.stage_request_sha256),
    controller_root: raw.controller_root,
    capture_root: raw.capture_root,
    capture_directory: String(raw.capture_directory),
    package: {
      path: raw.package.path,
      bytes: Number(raw.package.bytes),
      sha256: raw.package.sha256,
    },
    predecessor,
    node: { path: raw.node.path, sha256: raw.node.sha256 },
    parent_deadline_utc: raw.parent_deadline_utc,
    boundary,
    authority: "none" as const,
  };
}
async function runPreparedWslDriver(raw: unknown) {
  assert.equal(process.platform, "win32");
  const prepared = inspectWslNativeDriverPlan(raw),
    boundary = prepared.boundary,
    invocation = prepared.invocation_id,
    directory = prepared.capture_directory;
  assert.equal(
    fileURLToPath(import.meta.url),
    path.join(prepared.controller_root, "scripts/release-native-wsl-capture.mts"),
  );
  assert.equal(process.execPath, prepared.node.path);
  assert.equal(
    await readNativeSchedulerToolDigest(process.execPath, 128 * 1024 * 1024),
    prepared.node.sha256,
  );
  assert.equal(
    await readNativeSchedulerToolDigest(boundary.tools.wsl!.path, 128 * 1024 * 1024),
    boundary.tools.wsl!.sha256,
  );
  const budget = () => {
    const left = Math.floor(Date.parse(prepared.parent_deadline_utc) - Date.now());
    assert.ok(left > 0, "original installed task lifetime expired");
    return left;
  };
  budget();
  const requestBytes = await readBoundedPublicBuildInputFile(
      directory,
      "wsl-request.json",
      128 * 1024,
    ),
    planBytes = await readBoundedPublicBuildInputFile(directory, "wsl-plan.json", 128 * 1024);
  assert.equal(sha(requestBytes), prepared.request_sha256);
  assert.equal(sha(planBytes), prepared.plan_sha256);
  const commands = nativeWslInvocationCommands(
    boundary,
    invocation,
    prepared.request_sha256,
    prepared.entry_pins,
  );
  const hostBefore = await runFixedWsl(
    commands.host,
    null,
    directory,
    "guest-host-before",
    65536,
    Math.min(20000, budget()),
  );
  const hostBeforeBytes = await readBoundedPublicBuildInputFile(
    directory,
    path.basename(hostBefore.output),
    65536,
  );
  inspectNativeWslGuestHost(
    JSON.parse(hostBeforeBytes.toString("utf8")),
    boundary,
    invocation,
    prepared.host_expected,
  );
  for (const [entry, bytes] of [
    ["request", requestBytes],
    ["plan", planBytes],
  ] as const) {
    const command = commands.stage(entry, bytes.byteLength, sha(bytes));
    await runFixedWsl(
      command,
      bytesInput(command.header, bytes),
      directory,
      `stage-${entry}`,
      65536,
      Math.min(60000, budget()),
    );
  }
  for (const [entry, identity] of [
    [prepared.schema_version === 2 ? "candidate" : "application", prepared.package],
    ...(prepared.predecessor ? [["predecessor", prepared.predecessor] as const] : []),
  ] as const) {
    const packageInfo = await lstat(identity.path);
    assert.ok(
      packageInfo.isFile() &&
        !packageInfo.isSymbolicLink() &&
        packageInfo.nlink === 1 &&
        packageInfo.size === identity.bytes,
    );
    const command = commands.stage(entry, identity.bytes, identity.sha256);
    await runFixedWsl(
      command,
      packageInput(command.header, identity.path),
      directory,
      `stage-${entry}`,
      65536,
      Math.min(180000, budget()),
    );
  }
  let status: number | null = null,
    failure: string | null = null;
  try {
    status = (
      await runFixedWsl(
        commands.run,
        null,
        directory,
        "guest-run",
        65536,
        Math.min(1800000, budget() - 30000),
        [0, 1],
      )
    ).status;
  } catch (error) {
    failure = errorMessage(error);
  }
  // One matching GET/readback and bounded settlement, never a repeated run.
  // If this cannot prove original-unit closure the retained claim remains HOLD.
  const readback = await runFixedWsl(
    commands.readback,
    null,
    directory,
    "guest-readback",
    65536,
    Math.min(20000, budget()),
    [0, 1],
  );
  let observed: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(directory, path.basename(readback.output), 65536)
    ).toString("utf8"),
  );
  assert.ok(
    isRecord(observed) &&
      observed.invocation_id === invocation &&
      observed.request_sha256 === sha(requestBytes),
  );
  if (observed.cgroup_empty !== true || observed.unit_settled !== true) {
    const settlement = await runFixedWsl(
      commands.settle,
      null,
      directory,
      "guest-settle",
      65536,
      Math.min(30000, budget()),
      [0, 1],
    );
    observed = JSON.parse(
      (
        await readBoundedPublicBuildInputFile(directory, path.basename(settlement.output), 65536)
      ).toString("utf8"),
    ) as unknown;
    assert.ok(
      isRecord(observed) &&
        observed.invocation_id === invocation &&
        observed.request_sha256 === sha(requestBytes),
    );
  }
  let capture_wire: string | null = null;
  const hostAfter = await runFixedWsl(
    commands.host,
    null,
    directory,
    "guest-host-after",
    65536,
    Math.min(20000, budget()),
  );
  const hostAfterBytes = await readBoundedPublicBuildInputFile(
    directory,
    path.basename(hostAfter.output),
    65536,
  );
  assert.deepEqual(
    JSON.parse(hostAfterBytes.toString("utf8")),
    JSON.parse(hostBeforeBytes.toString("utf8")),
    "actual guest host changed across invocation",
  );
  if (observed.cgroup_empty === true && observed.unit_settled === true) {
    capture_wire = (
      await runFixedWsl(
        commands.capture,
        null,
        directory,
        "guest-capture",
        272 * 1024 * 1024,
        Math.min(60000, budget()),
      )
    ).output;
  } else {
    failure ??=
      "original guest group settlement remains unknown; preserve claim and all partial effects";
  }
  await writeFile(
    path.join(directory, "wsl-capture-summary.json"),
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      request_sha256: sha(requestBytes),
      stage_request_sha256: prepared.stage_request_sha256,
      status,
      failure,
      readback: observed,
      capture_wire,
      host_before_sha256: sha(hostBeforeBytes),
      host_after_sha256: sha(hostAfterBytes),
      authority: "none",
      native_acceptance: "not-established",
    }),
    { flag: "wx", mode: 0o600 },
  );
}

export async function captureActualWslNativeInvocation(claim: object) {
  const selected = await requireActualNativeInvocation(claim),
    parent = selected.parent,
    request = selected.request.request;
  assert.equal(process.platform, "win32");
  assert.equal(parent.descriptor.platform_label, "linux-x86_64");
  const postSign = request.stage === "release-publication";
  if (postSign) {
    assert.equal(request.native_report_schema_version, 2);
    assert.equal(request.native_prepublication_profile, "signed-package-compatibility-v1");
    assert.ok(request.journey && selected.payload_cryptography);
    assert.equal(Boolean(selected.predecessor), "predecessor" in request.journey);
  } else assert.equal(request.stage, "payload-signing");
  const account = parent.authority_configuration.native["linux-x86_64"].host.account;
  const boundary = inspectNativeWslBoundary(
    parent.boundary_configuration,
    account,
    parent.controller_root,
    parent.descriptor.capture_root,
  );
  const directory = selected.capture_directory,
    invocation = request.invocation_id;
  const guest = `${boundary.linux_root}/invocations/${invocation}`;
  const registrationBefore = await observeActualNativeWslRegistration(claim);
  const registrationBeforeBytes = Buffer.from(JSON.stringify(registrationBefore));
  await writeFile(path.join(directory, "wsl-registration-before.json"), registrationBeforeBytes, {
    flag: "wx",
    mode: 0o600,
  });
  assert.equal(
    await readNativeSchedulerToolDigest(boundary.tools.wsl!.path, 128 * 1024 * 1024),
    boundary.tools.wsl!.sha256,
  );
  const [supervisor, support, driver, init, transfer] = await Promise.all(
    [
      "scripts/native-qualification-linux-supervisor.py",
      "scripts/semantic-review-linux-supervisor.py",
      "scripts/release-native-linux-driver.mts",
      "apps/desktop/scripts/native-linux-isolated-init.py",
      "scripts/native-qualification-linux-transfer.py",
    ].map((filename) => sourcePin(parent.controller_root, filename)),
  );
  assert.equal(supervisor, boundary.supervisor_sha256, "appointed guest supervisor source differs");
  const available = remainingNativeParentBudget() - 60000;
  assert.ok(available > 0);
  const deadline_utc = new Date(Date.now() + Math.min(1800000, available)).toISOString();
  const guestTools: Record<string, { path: string; sha256: string }> = {};
  for (const name of ["bwrap", "git", "node", "python", "webkit_driver", "xvfb", "driver"]) {
    const tool = boundary.tools[name === "driver" ? "tauri_driver" : name];
    assert.ok(tool);
    guestTools[name] = { ...tool };
  }
  const binding = {
    schema_version: 1,
    invocation_id: invocation,
    linux_root: boundary.linux_root,
    account: {
      uid: Number(boundary.account.qualification),
      gid: Number(boundary.qualification_gid),
    },
    application: {
      path: `${guest}/install/Portcove.AppImage`,
      bytes: request.candidate.package.bytes,
      sha256: request.candidate.package.sha256,
    },
    controller: {
      root: `${boundary.linux_root}/controller`,
      source_commit: parent.descriptor.controller_revision,
      source_tree: parent.controller_tree,
      init_sha256: init,
    },
    tools: guestTools,
    capture_root: `${guest}/capture`,
    home: `${guest}/work/home`,
    deadline_utc,
  };
  const planBytes = Buffer.from(
    JSON.stringify({
      schema_version: postSign ? 2 : 1,
      invocation_id: invocation,
      stage_request_sha256: selected.request.request_sha256,
      stage: request.stage,
      binding,
      ...(postSign
        ? {
            stage_request: request,
            predecessor: selected.predecessor
              ? {
                  bytes: selected.predecessor.bytes,
                  sha256: selected.predecessor.sha256,
                  version: selected.predecessor.version,
                }
              : null,
          }
        : {}),
    }),
  );
  const requestBytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      stage_request_sha256: selected.request.request_sha256,
      qualification_uid: binding.account.uid,
      qualification_gid: binding.account.gid,
      controller: {
        source_commit: parent.descriptor.controller_revision,
        source_tree: parent.controller_tree,
      },
      plan_sha256: sha(planBytes),
      supervisor_sha256: supervisor,
      support_sha256: support,
      driver_sha256: driver,
      tools_sha256: Object.fromEntries(
        ["python", "bwrap", "systemd_run", "systemctl", "node", "git"].map((name) => [
          name,
          boundary.tools[name]!.sha256,
        ]),
      ),
      timeout_seconds: Math.max(1, Math.floor(Math.min(1800000, available) / 1000)),
      deadline_utc,
    }),
  );
  await writeFile(path.join(directory, "wsl-request.json"), requestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(directory, "wsl-plan.json"), planBytes, { flag: "wx", mode: 0o600 });
  await parent.recheck();
  const driverPlan = {
    host_expected: {
      machine_id_sha256:
        parent.authority_configuration.native["linux-x86_64"].host.machine_id_sha256,
      minimum_os_version:
        parent.authority_configuration.native["linux-x86_64"].compatibility.minimum_os_version,
    },
    entry_pins: {
      supervisor_sha256: supervisor,
      transfer_sha256: transfer,
      controller_revision: parent.descriptor.controller_revision,
      controller_tree: parent.controller_tree,
    },
    schema_version: postSign ? 2 : 1,
    ...(postSign
      ? {
          predecessor: selected.predecessor
            ? {
                path: selected.predecessor.path,
                bytes: selected.predecessor.bytes,
                sha256: selected.predecessor.sha256,
              }
            : null,
        }
      : {}),
    invocation_id: invocation,
    request_sha256: sha(requestBytes),
    plan_sha256: sha(planBytes),
    stage_request_sha256: selected.request.request_sha256,
    controller_root: parent.controller_root,
    capture_root: parent.descriptor.capture_root,
    capture_directory: directory,
    boundary_configuration: parent.boundary_configuration,
    account,
    package: {
      path: selected.package_path,
      bytes: request.candidate.package.bytes,
      sha256: request.candidate.package.sha256,
    },
    node: {
      path: process.execPath,
      sha256: await readNativeSchedulerToolDigest(process.execPath, 128 * 1024 * 1024),
    },
    parent_deadline_utc: new Date(Date.now() + remainingNativeParentBudget()).toISOString(),
  };
  const driverBytes = Buffer.from(JSON.stringify(driverPlan));
  const driverPath = path.join(directory, "wsl-driver-plan.json");
  await writeFile(driverPath, driverBytes, { flag: "wx", mode: 0o600 });
  const signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number;
  try {
    status = await runResourceCommand(
      "analysis",
      process.execPath,
      [fileURLToPath(import.meta.url), "--driver", driverPath, sha(driverBytes)],
      {
        cwd: parent.controller_root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.SystemRoot,
          USERPROFILE: process.env.USERPROFILE,
          PATH: path.join(String(process.env.SystemRoot), "System32"),
          TEMP: directory,
          TMP: directory,
        },
        exclusive: [`native-wsl:${boundary.account.qualification}`],
        supervise: (args, options) =>
          runRustTests(args, {
            ...options,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              assert.ok(options.acquireLock);
              const lease = await options.acquireLock(metadata, admission);
              try {
                await requireActualNativeInvocation(claim);
                timer = setTimeout(() => signal.emit("SIGTERM"), remainingNativeParentBudget());
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
  await parent.recheck();
  const retainedSummary = await readBoundedPublicBuildInputFile(
    directory,
    "wsl-capture-summary.json",
    128 * 1024,
  );
  const registrationAfter = await observeActualNativeWslRegistration(claim);
  assert.equal(
    digest(registrationAfter.observed.registration),
    digest(registrationBefore.observed.registration),
    "appointed Windows WSL registration changed during invocation",
  );
  const registrationAfterBytes = Buffer.from(JSON.stringify(registrationAfter));
  await writeFile(path.join(directory, "wsl-registration-after.json"), registrationAfterBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const summary: unknown = JSON.parse(retainedSummary.toString("utf8"));
  assert.ok(
    isRecord(summary) &&
      summary.invocation_id === invocation &&
      summary.request_sha256 === sha(requestBytes) &&
      summary.stage_request_sha256 === selected.request.request_sha256,
  );
  const guestHostFiles = ["guest-host-before.stdout.bin", "guest-host-after.stdout.bin"];
  const configuredHost = parent.authority_configuration.native["linux-x86_64"];
  assert.ok(
    typeof configuredHost.host.machine_id_sha256 === "string" &&
      typeof configuredHost.compatibility.minimum_os_version === "string",
  );
  for (const name of guestHostFiles) {
    const rawHost = await readBoundedPublicBuildInputFile(directory, name, 65536);
    assert.equal(
      sha(rawHost),
      summary[name.includes("before") ? "host_before_sha256" : "host_after_sha256"],
    );
    inspectNativeWslGuestHost(JSON.parse(rawHost.toString("utf8")), boundary, invocation, {
      machine_id_sha256: configuredHost.host.machine_id_sha256,
      minimum_os_version: configuredHost.compatibility.minimum_os_version,
    });
  }
  let wireSha: string | null = null;
  let retained: Awaited<ReturnType<typeof retainNativeCaptureWire>> | null = null;
  if (summary.capture_wire !== null) {
    assert.equal(summary.capture_wire, path.join(directory, "guest-capture.stdout.bin"));
    wireSha = await hashRetainedNativeCaptureFile(
      directory,
      "guest-capture.stdout.bin",
      272 * 1024 * 1024,
    );
    retained = await retainNativeCaptureWire(
      summary.capture_wire,
      path.join(directory, "guest-capture"),
      invocation,
      wireSha,
    );
  }
  const receipt = Object.freeze({
    kind: "actual-wsl-native-capture",
    authority: "none",
    native_acceptance: "not-established",
  });
  captures.set(receipt, {
    claim,
    directory,
    requestSha: sha(requestBytes),
    status,
    summarySha: sha(retainedSummary),
    wireSha,
    retained,
    registration_sha256: digest(registrationAfter.observed.registration),
    registration_files: [
      { name: "wsl-registration-before.json", sha256: sha(registrationBeforeBytes) },
      { name: "wsl-registration-after.json", sha256: sha(registrationAfterBytes) },
      ...guestHostFiles.map((name) => ({
        name,
        sha256: String(
          summary[name.includes("before") ? "host_before_sha256" : "host_after_sha256"],
        ),
      })),
    ],
  });
  return receipt;
}
export async function requireActualWslNativeCapture(raw: object) {
  const value = captures.get(raw);
  if (!value) throw new Error("actual installed parent guest capture provenance required");
  const selected = await requireActualNativeInvocation(value.claim);
  const registration = await observeActualNativeWslRegistration(value.claim);
  assert.equal(
    digest(registration.observed.registration),
    value.registration_sha256,
    "appointed Windows WSL registration changed",
  );
  for (const file of value.registration_files)
    assert.equal(
      sha(await readBoundedPublicBuildInputFile(value.directory, file.name, 65536)),
      file.sha256,
    );
  const summary = await readBoundedPublicBuildInputFile(
    value.directory,
    "wsl-capture-summary.json",
    128 * 1024,
  );
  assert.equal(sha(summary), value.summarySha, "original guest capture summary changed");
  if (value.wireSha !== null)
    assert.equal(
      await hashRetainedNativeCaptureFile(
        value.directory,
        "guest-capture.stdout.bin",
        272 * 1024 * 1024,
      ),
      value.wireSha,
      "original guest capture wire changed",
    );
  if (value.retained)
    for (const entry of value.retained.entries) {
      assert.equal(
        await hashRetainedNativeCaptureFile(
          value.retained.directory,
          entry.path,
          32 * 1024 * 1024,
          entry.bytes,
        ),
        entry.sha256,
        "retained guest observation changed",
      );
    }
  return {
    ...selected,
    selected,
    directory: value.directory,
    summary: JSON.parse(summary.toString("utf8")) as unknown,
    resource_status: value.status,
    capture_wire_sha256: value.wireSha,
    retained_capture: value.retained,
    authority: "none" as const,
  };
}

async function cli() {
  const [flag, filename, expected, ...rest] = process.argv.slice(2);
  assert.ok(
    flag === "--driver" && filename && expected && !rest.length && /^[a-f0-9]{64}$/u.test(expected),
  );
  const bytes = await readBoundedPublicBuildInputFile(
    path.dirname(filename),
    path.basename(filename),
    128 * 1024,
  );
  assert.equal(sha(bytes), expected);
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  const prepared = inspectWslNativeDriverPlan(raw);
  assert.equal(filename, path.join(prepared.capture_directory, "wsl-driver-plan.json"));
  await runPreparedWslDriver(raw);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli();
