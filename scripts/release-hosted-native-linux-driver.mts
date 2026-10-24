/** Credential-free fixed Linux capture driver. Its JSON plan is inert and its
 * output grants no native or admission authority. The original hosted parent
 * must retain source/request provenance and verify all observations separately. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openSync, writeSync, closeSync } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import {
  nativeWslBootstrapArguments,
  inspectNativeWslEntryPins,
} from "./release-native-wsl-bootstrap.mts";
import { inspectHostedNativeLinuxHost } from "./release-native-wsl-host.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import { readNativeSchedulerToolDigest } from "./release-native-scheduler.mts";
import {
  inspectNativeQualificationCandidate,
  inspectNativeQualificationJourney,
} from "./release-native-qualification-contract.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";

const mib = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  assert.ok(
    isRecord(raw) && Object.keys(raw).sort().join(",") === keys,
    "fixed hosted Linux driver schema differs",
  );
}
function digest(raw: unknown) {
  assert.ok(typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw));
  return raw;
}
function absolute(raw: unknown) {
  assert.ok(
    typeof raw === "string" &&
      raw.startsWith("/") &&
      path.posix.normalize(raw) === raw &&
      !/[\\\0\r\n]/u.test(raw),
  );
  return raw;
}
function uid(raw: unknown) {
  assert.ok(typeof raw === "string" && /^[1-9][0-9]{0,9}$/u.test(raw) && BigInt(raw) < 4294967295n);
  return raw;
}
export function inspectHostedLinuxDriverPlan(value: unknown) {
  const raw: unknown = structuredClone(value);
  exact(
    raw,
    "broker_uid,capture_directory,controller_root,deadline_utc,entry_pins,host_expected,invocation_id,node,packages,plan_sha256,qualification_gid,qualification_uid,request_sha256,schema_version,stage_request_sha256,tools",
  );
  assert.equal(raw.schema_version, 1);
  const broker = uid(raw.broker_uid),
    qualification = uid(raw.qualification_uid),
    gid = uid(raw.qualification_gid);
  assert.notEqual(broker, qualification, "broker and candidate identity must differ");
  const directory = absolute(raw.capture_directory),
    root = absolute(raw.controller_root);
  assert.ok(
    root !== directory && !directory.startsWith(root + "/") && !root.startsWith(directory + "/"),
    "capture must remain outside controller source",
  );
  const invocation = digest(raw.invocation_id);
  assert.ok(
    typeof raw.deadline_utc === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.deadline_utc) &&
      new Date(raw.deadline_utc).toISOString() === raw.deadline_utc,
  );
  const pins = inspectNativeWslEntryPins(raw.entry_pins);
  exact(raw.node, "path,sha256");
  const node = { path: absolute(raw.node.path), sha256: digest(raw.node.sha256) };
  exact(raw.tools, "git,python,sudo");
  const rawTools = raw.tools;
  const tools = Object.fromEntries(
    Object.entries({ git: "/usr/bin/git", python: "/usr/bin/python3", sudo: "/usr/bin/sudo" }).map(
      ([name, filename]) => {
        const tool = rawTools[name];
        exact(tool, "path,sha256");
        assert.equal(tool.path, filename);
        return [name, { path: filename, sha256: digest(tool.sha256) }];
      },
    ),
  );
  exact(raw.host_expected, "machine_id_sha256,minimum_os_version");
  assert.equal(typeof raw.host_expected.minimum_os_version, "string");
  assert.ok(Array.isArray(raw.packages) && raw.packages.length >= 1 && raw.packages.length <= 2);
  const entries = new Set<string>();
  const packages = raw.packages.map(
    (
      item,
    ): {
      entry: "application" | "candidate" | "predecessor";
      path: string;
      bytes: number;
      sha256: string;
    } => {
      exact(item, "bytes,entry,path,sha256");
      assert.ok(
        item.entry === "application" || item.entry === "candidate" || item.entry === "predecessor",
      );
      assert.ok(!entries.has(item.entry));
      entries.add(item.entry);
      assert.ok(
        Number.isSafeInteger(item.bytes) &&
          Number(item.bytes) >= 1 &&
          Number(item.bytes) <= 512 * mib,
      );
      assert.equal(
        item.path,
        path.posix.join(
          directory,
          item.entry === "predecessor" ? "predecessor.bin" : "package.bin",
        ),
      );
      return {
        entry: item.entry,
        path: String(item.path),
        bytes: Number(item.bytes),
        sha256: digest(item.sha256),
      };
    },
  );
  assert.ok(!(entries.has("application") && entries.has("candidate")));
  return Object.freeze({
    broker_uid: broker,
    qualification_uid: qualification,
    qualification_gid: gid,
    capture_directory: directory,
    controller_root: root,
    invocation_id: invocation,
    deadline_utc: raw.deadline_utc,
    entry_pins: pins,
    node,
    tools,
    host_expected: {
      machine_id_sha256: digest(raw.host_expected.machine_id_sha256),
      minimum_os_version: String(raw.host_expected.minimum_os_version),
    },
    request_sha256: digest(raw.request_sha256),
    plan_sha256: digest(raw.plan_sha256),
    stage_request_sha256: digest(raw.stage_request_sha256),
    packages,
    authority: "none" as const,
  });
}
type Prepared = ReturnType<typeof inspectHostedLinuxDriverPlan>;
export function hostedLinuxCaptureCommands(prepared: Prepared) {
  const invocation = digest(prepared.invocation_id),
    request = digest(prepared.request_sha256);
  const command = (kind: "outer" | "transfer", operation: readonly string[]) => ({
    executable: "/usr/bin/sudo",
    arguments: [
      "-n",
      "-H",
      "-u",
      "portcove-native",
      "--",
      "/usr/bin/python3",
      ...nativeWslBootstrapArguments(
        "/home/portcove-native/portcove-native",
        prepared.qualification_uid,
        prepared.qualification_gid,
        kind,
        prepared.entry_pins,
        prepared.tools.python!.sha256,
        prepared.tools.git!.sha256,
        operation,
      ),
    ],
  });
  const invoke = (mode: "run" | "readback" | "settle") =>
    command("outer", ["--mode", mode, "--invocation", invocation, "--request-sha256", request]);
  return {
    host: command("transfer", ["--mode", "host", "--invocation", invocation]),
    capture: command("transfer", ["--mode", "capture", "--invocation", invocation]),
    run: invoke("run"),
    readback: invoke("readback"),
    settle: invoke("settle"),
    stage(
      entry: "request" | "plan" | "application" | "candidate" | "predecessor",
      bytes: number,
      sha256: string,
    ) {
      assert.ok(["request", "plan", "application", "candidate", "predecessor"].includes(entry));
      assert.ok(
        Number.isSafeInteger(bytes) &&
          bytes >= 1 &&
          bytes <= (["request", "plan"].includes(entry) ? 128 * 1024 : 512 * mib),
      );
      const header = JSON.stringify({
        schema_version: 1,
        invocation_id: invocation,
        entry,
        bytes,
        sha256: digest(sha256),
      });
      return {
        ...command("transfer", [
          "--mode",
          "stage",
          "--invocation",
          invocation,
          "--header-sha256",
          sha(Buffer.from(header)),
        ]),
        header: header + "\n",
      };
    },
    authority: "none" as const,
  };
}

async function fixedOperation(
  prepared: Prepared,
  command: { executable: string; arguments: readonly string[] },
  name: string,
  input: AsyncIterable<Uint8Array> | null,
  maximum: number,
  timeout: number,
  budget: () => number,
  statuses: readonly number[] = [0],
  children = { settled: true },
) {
  assert.match(name, /^[a-z][a-z0-9-]{0,63}$/u);
  const directory = prepared.capture_directory;
  const admittedTimeout = Math.min(timeout, budget());
  const output = path.join(directory, `${name}.stdout.bin`);
  const stdout = openSync(output, "wx", 0o600);
  let stderr: number;
  try {
    stderr = openSync(path.join(directory, `${name}.stderr.bin`), "wx", 0o600);
  } catch (error) {
    closeSync(stdout);
    throw error;
  }
  let status: number | null = null,
    failure: unknown,
    outputBytes = 0,
    errorBytes = 0;
  const child = spawn(command.executable, command.arguments, {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory, TMPDIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false,
    exited = false;
  let escalation: ReturnType<typeof setTimeout> | undefined,
    drainage: ReturnType<typeof setTimeout> | undefined;
  let rejectDrain: (error: Error) => void = () => {};
  const forcedDrain = new Promise<never>((_resolve, reject) => {
    rejectDrain = reject;
  });
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    if (!exited && !closed) {
      try {
        child.kill(name);
      } catch {
        /* Original child outcome remains unknown. */
      }
    }
  };
  child.once("exit", () => {
    exited = true;
  });
  const fail = (error: unknown) => {
    failure ??= error;
    child.stdin.destroy();
    if (escalation || drainage) return;
    signal("SIGTERM");
    escalation = setTimeout(() => {
      signal("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
    drainage = setTimeout(() => {
      if (!closed) children.settled = false;
      rejectDrain(
        new Error("fixed Linux child closure/drain remains unknown; matching recovery required"),
      );
    }, 3000);
  };
  const retain = (fd: number, bytes: Buffer, remaining: number) => {
    const piece = bytes.subarray(0, Math.max(0, remaining));
    for (let offset = 0; offset < piece.length;) {
      const written = writeSync(fd, piece, offset);
      assert.ok(written > 0);
      offset += written;
    }
  };
  child.stdout.on("data", (bytes: Buffer) => {
    try {
      retain(stdout, bytes, maximum - outputBytes);
      outputBytes += bytes.length;
      if (outputBytes > maximum) fail(new Error("fixed Linux output exceeded retained bound"));
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", (bytes: Buffer) => {
    try {
      retain(stderr, bytes, 4 * mib - errorBytes);
      errorBytes += bytes.length;
      if (errorBytes > 4 * mib) fail(new Error("fixed Linux diagnostics exceeded retained bound"));
    } catch (error) {
      fail(error);
    }
  });
  const terminal = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      fail(error);
    });
    child.once("close", (code) => {
      status = code;
      closed = true;
      resolve();
    });
  });
  const timer = setTimeout(
    () => fail(new Error("fixed Linux operation deadline; remote effect remains ambiguous")),
    admittedTimeout,
  );
  child.stdin.on("error", fail);
  const feed = input
    ? pipeline(Readable.from(input), child.stdin).catch((error) => {
        fail(error);
      })
    : (child.stdin.end(), Promise.resolve());
  try {
    await Promise.race([Promise.all([terminal, feed]), forcedDrain]);
    if (failure) throw new Error(errorMessage(failure));
    assert.ok(
      status !== null && statuses.includes(status),
      "fixed Linux operation refused; retain streams and partial effects",
    );
    budget();
    return { status, output };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(drainage);
    if (!closed) {
      children.settled = false;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    closeSync(stdout);
    closeSync(stderr);
  }
}
async function* transferInput(header: string, input: Buffer | string) {
  yield Buffer.from(header);
  if (typeof input !== "string") yield input;
  else for await (const bytes of createReadStream(input)) yield bytes as Buffer;
}

/** Driver body is private. Only the resource-admitted CLI invokes it. */
async function runPreparedCapture(prepared: Prepared, origin: { wall: number; monotonic: number }) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(String(process.getuid?.()), prepared.broker_uid);
  const wall = Date.parse(prepared.deadline_utc) - origin.wall;
  assert.ok(wall > 60000 && wall <= 1900000, "original capture deadline cannot admit execution");
  const deadline = origin.monotonic + wall;
  const budget = () => {
    const left = Math.floor(
      Math.min(deadline - performance.now(), Date.parse(prepared.deadline_utc) - Date.now()),
    );
    assert.ok(left > 0, "original capture lifetime expired; no renewed deadline");
    return left;
  };
  const directory = prepared.capture_directory;
  assert.equal(await realpath(directory), directory);
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
  assert.equal(
    fileURLToPath(import.meta.url),
    path.join(prepared.controller_root, "scripts/release-hosted-native-linux-driver.mts"),
  );
  assert.equal(process.execPath, prepared.node.path);
  assert.equal(
    await readNativeSchedulerToolDigest(process.execPath, 128 * mib),
    prepared.node.sha256,
  );
  for (const tool of Object.values(prepared.tools)) {
    const resolved = await realpath(tool.path);
    for (let filename = resolved; ; filename = path.dirname(filename)) {
      const file = await lstat(filename);
      assert.ok(file.uid === 0 && (file.mode & 0o022) === 0 && !file.isSymbolicLink());
      if (filename === "/") break;
    }
    assert.equal(await readNativeSchedulerToolDigest(resolved, 128 * mib), tool.sha256);
  }
  const read = (name: string, maximum = 128 * 1024) =>
    readBoundedPublicBuildInputFile(directory, name, maximum);
  const requestBytes = await read("native-request.json"),
    planBytes = await read("native-plan.json");
  assert.equal(sha(requestBytes), prepared.request_sha256);
  assert.equal(sha(planBytes), prepared.plan_sha256);
  const request: unknown = JSON.parse(requestBytes.toString("utf8"));
  assert.ok(isRecord(request));
  assert.equal(request.invocation_id, prepared.invocation_id);
  assert.equal(request.stage_request_sha256, prepared.stage_request_sha256);
  assert.equal(request.qualification_uid, Number(prepared.qualification_uid));
  assert.equal(request.qualification_gid, Number(prepared.qualification_gid));
  assert.equal(request.plan_sha256, prepared.plan_sha256);
  // The unit does not exist yet. Validate the immutable staged recipe here;
  // the existing inner driver validates the actual observed unit after startup.
  const plan: unknown = JSON.parse(planBytes.toString("utf8"));
  assert.ok(isRecord(plan));
  exact(
    plan,
    plan.schema_version === 2
      ? "binding,invocation_id,predecessor,schema_version,stage,stage_request,stage_request_sha256"
      : "binding,invocation_id,schema_version,stage,stage_request_sha256",
  );
  assert.ok(plan.schema_version === 1 || plan.schema_version === 2);
  assert.equal(plan.invocation_id, prepared.invocation_id);
  assert.equal(plan.stage_request_sha256, prepared.stage_request_sha256);
  exact(
    plan.binding,
    "account,application,capture_root,controller,deadline_utc,home,invocation_id,linux_root,schema_version,tools",
  );
  const binding = plan.binding;
  const linuxRoot = "/home/portcove-native/portcove-native",
    attempt = `${linuxRoot}/invocations/${prepared.invocation_id}`;
  assert.equal(binding.schema_version, 1);
  assert.equal(binding.invocation_id, prepared.invocation_id);
  assert.equal(binding.linux_root, linuxRoot);
  assert.equal(binding.deadline_utc, prepared.deadline_utc);
  assert.equal(binding.capture_root, `${attempt}/capture`);
  assert.equal(binding.home, `${attempt}/work/home`);
  exact(binding.account, "gid,uid");
  assert.equal(binding.account.uid, Number(prepared.qualification_uid));
  assert.equal(binding.account.gid, Number(prepared.qualification_gid));
  exact(binding.controller, "init_sha256,root,source_commit,source_tree");
  assert.equal(binding.controller.root, `${linuxRoot}/controller`);
  assert.equal(binding.controller.source_commit, prepared.entry_pins.controller_revision);
  assert.equal(binding.controller.source_tree, prepared.entry_pins.controller_tree);
  digest(binding.controller.init_sha256);
  assert.deepEqual(request.controller, {
    source_commit: prepared.entry_pins.controller_revision,
    source_tree: prepared.entry_pins.controller_tree,
  });
  assert.equal(request.supervisor_sha256, prepared.entry_pins.supervisor_sha256);
  assert.equal(request.deadline_utc, prepared.deadline_utc);
  assert.ok(
    Number.isSafeInteger(request.timeout_seconds) &&
      Number(request.timeout_seconds) >= 1 &&
      Number(request.timeout_seconds) <= 1800,
  );
  exact(binding.application, "bytes,path,sha256");
  assert.equal(binding.application.path, `${attempt}/install/Portcove.AppImage`);
  const expectedPackages = new Map<string, { bytes: unknown; sha256: unknown }>();
  if (plan.schema_version === 1) {
    assert.equal(plan.stage, "payload-signing");
    expectedPackages.set("application", {
      bytes: binding.application.bytes,
      sha256: binding.application.sha256,
    });
  } else {
    assert.equal(plan.stage, "release-publication");
    assert.ok(isRecord(plan.stage_request));
    assert.equal(releaseCanonicalDigest(plan.stage_request), prepared.stage_request_sha256);
    assert.equal(plan.stage_request.invocation_id, prepared.invocation_id);
    assert.equal(plan.stage_request.platform_label, "linux-x86_64");
    assert.equal(plan.stage_request.stage, "release-publication");
    assert.equal(plan.stage_request.native_report_schema_version, 2);
    assert.equal(
      plan.stage_request.native_prepublication_profile,
      "signed-package-compatibility-v1",
    );
    const candidate = inspectNativeQualificationCandidate(plan.stage_request.candidate);
    assert.equal(candidate.package.bytes, binding.application.bytes);
    assert.equal(candidate.package.sha256, binding.application.sha256);
    const journey = inspectNativeQualificationJourney(
      plan.stage_request.journey,
      "release-publication",
      candidate,
      true,
    );
    assert.ok(journey);
    expectedPackages.set("candidate", candidate.package);
    if ("predecessor" in journey) {
      exact(plan.predecessor, "bytes,sha256,version");
      assert.equal(plan.predecessor.bytes, journey.predecessor.package.bytes);
      assert.equal(plan.predecessor.sha256, journey.predecessor.package.sha256);
      expectedPackages.set("predecessor", journey.predecessor.package);
    } else assert.equal(plan.predecessor, null);
  }
  assert.deepEqual(
    prepared.packages.map((item) => item.entry).sort(),
    [...expectedPackages.keys()].sort(),
  );
  for (const item of prepared.packages) {
    const expected = expectedPackages.get(item.entry);
    assert.ok(expected);
    assert.equal(item.bytes, expected.bytes);
    assert.equal(item.sha256, expected.sha256);
  }
  // CreateNew is the local attempt boundary even for a standalone driver. No
  // retained recipe can be repeated to launch the same unit again.
  await writeFile(
    path.join(directory, "hosted-linux-driver-attempt.json"),
    JSON.stringify({
      schema_version: 1,
      invocation_id: prepared.invocation_id,
      request_sha256: prepared.request_sha256,
      original_deadline_utc: prepared.deadline_utc,
      authority: "none",
      native_acceptance: "not-established",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const commands = hostedLinuxCaptureCommands(prepared);
  const children = { settled: true };
  const run = (
    command: { executable: string; arguments: readonly string[] },
    name: string,
    input: AsyncIterable<Uint8Array> | null,
    maximum: number,
    timeout: number,
    statuses?: readonly number[],
  ) => fixedOperation(prepared, command, name, input, maximum, timeout, budget, statuses, children);
  const hostBefore = await run(commands.host, "host-before", null, 65536, 20000);
  const before = await read(path.basename(hostBefore.output), 65536);
  inspectHostedNativeLinuxHost(
    JSON.parse(before.toString("utf8")),
    {
      account: { qualification: prepared.qualification_uid },
      qualification_gid: prepared.qualification_gid,
    },
    prepared.invocation_id,
    prepared.host_expected,
  );
  for (const [entry, bytes] of [
    ["request", requestBytes],
    ["plan", planBytes],
  ] as const) {
    const command = commands.stage(entry, bytes.length, sha(bytes));
    await run(command, `stage-${entry}`, transferInput(command.header, bytes), 65536, 60000);
  }
  for (const item of prepared.packages) {
    const identity = await hashNativeCapturedFile(
      directory,
      path.basename(item.path),
      512 * mib,
      deadline,
    );
    assert.equal(identity.bytes, item.bytes);
    assert.equal(identity.sha256, item.sha256);
    const command = commands.stage(item.entry, item.bytes, item.sha256);
    await run(
      command,
      `stage-${item.entry}`,
      transferInput(command.header, item.path),
      65536,
      180000,
    );
  }
  assert.ok(budget() > 150000, "native run lacks matching recovery reserve");
  let status: number | null = null,
    failure: string | null = null;
  try {
    status = (
      await run(
        commands.run,
        "native-run",
        null,
        65536,
        Math.min(1800000, budget() - 150000),
        [0, 1],
      )
    ).status;
  } catch (error) {
    failure = errorMessage(error);
  }
  // No second run. Read back once, settle the exact unit at most once, then
  // require positive closure before exporting any original capture wire.
  const readback = await run(commands.readback, "native-readback", null, 65536, 20000, [0, 1]);
  let observed: unknown = JSON.parse(
    (await read(path.basename(readback.output), 65536)).toString("utf8"),
  );
  const matching = (raw: unknown): raw is Record<string, unknown> =>
    isRecord(raw) &&
    raw.invocation_id === prepared.invocation_id &&
    raw.request_sha256 === prepared.request_sha256;
  assert.ok(matching(observed), "readback belongs to another native attempt");
  if (observed.cgroup_empty !== true || observed.unit_settled !== true) {
    const settled = await run(commands.settle, "native-settle", null, 65536, 30000, [0, 1]);
    observed = JSON.parse((await read(path.basename(settled.output), 65536)).toString("utf8"));
    assert.ok(matching(observed));
  }
  const hostAfter = await run(commands.host, "host-after", null, 65536, 20000);
  const after = await read(path.basename(hostAfter.output), 65536);
  assert.deepEqual(
    JSON.parse(after.toString("utf8")),
    JSON.parse(before.toString("utf8")),
    "actual Linux host changed across capture",
  );
  let wire: string | null = null;
  if (children.settled && observed.cgroup_empty === true && observed.unit_settled === true)
    wire = (await run(commands.capture, "native-capture", null, 272 * mib, 60000)).output;
  else failure ??= "original unit or child closure remains unknown; preserve all partial effects";
  await writeFile(
    path.join(directory, "hosted-linux-capture-summary.json"),
    JSON.stringify({
      schema_version: 1,
      invocation_id: prepared.invocation_id,
      request_sha256: prepared.request_sha256,
      stage_request_sha256: prepared.stage_request_sha256,
      status,
      failure,
      readback: observed,
      capture_wire: wire,
      operation_children_settled: children.settled,
      host_before_sha256: sha(before),
      host_after_sha256: sha(after),
      authority: "none",
      native_acceptance: "not-established",
    }),
    { flag: "wx", mode: 0o600 },
  );
  budget();
}
async function cli() {
  const origin = { wall: Date.now(), monotonic: performance.now() };
  const [flag, filename, expected, ...rest] = process.argv.slice(2);
  assert.ok(
    flag === "--driver" && filename && expected && !rest.length,
    "fixed hosted Linux driver arguments required",
  );
  const bytes = await readBoundedPublicBuildInputFile(
    path.dirname(filename),
    path.basename(filename),
    128 * 1024,
  );
  assert.equal(sha(bytes), digest(expected));
  const prepared = inspectHostedLinuxDriverPlan(JSON.parse(bytes.toString("utf8")));
  assert.equal(filename, path.join(prepared.capture_directory, "hosted-linux-driver-plan.json"));
  try {
    await runPreparedCapture(prepared, origin);
  } catch (error) {
    // A nonzero response never proves absence of remote effects. Preserve the
    // original streams and marker; matching readback/recovery remains required.
    throw new Error(
      `fixed hosted Linux driver refused; retain original attempt: ${errorMessage(error)}`,
    );
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void resourceEntrypoint("analysis", cli)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
