import { isRecord } from "./runtime-values.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  retainNativeCaptureWire,
  hashRetainedNativeCaptureFile,
} from "./release-native-wsl-wire.mts";
import {
  inspectWslNativeDriverPlan,
  boundedNativeWslOperationTimeout,
  requireActualWslNativeCapture,
} from "./release-native-wsl-capture.mts";
void test("a retained hash cannot return usable bytes after its original clock expires during a read", async (context) => {
  const directory = disposableDirectory(
    context,
    path.join(os.tmpdir(), "native-capture-hash-clock-"),
  );
  await writeFile(path.join(directory, "retained.bin"), Buffer.alloc(65536, 1));
  let now = 0;
  const clock = context.mock.method(performance, "now", () => (now += 100));
  try {
    await assert.rejects(
      hashRetainedNativeCaptureFile(directory, "retained.bin", 65536, 65536, 250),
      /original capture hash budget exhausted/u,
    );
    assert.ok(now >= 300);
  } finally {
    clock.mock.restore();
  }
});
void test("parked capture parsing refuses an exhausted original clock before opening or creating paths", async () => {
  await assert.rejects(
    retainNativeCaptureWire(
      "missing-original.wire",
      "must-not-create",
      "a".repeat(64),
      "b".repeat(64),
      performance.now() - 1,
    ),
    /original capture read budget exhausted/u,
  );
  await assert.rejects(
    retainNativeCaptureWire(
      "missing-original.wire",
      "must-not-create",
      "a".repeat(64),
      "b".repeat(64),
      Number.NaN,
    ),
    /original capture read budget exhausted/u,
  );
});
function fixture() {
  const id = "a".repeat(64),
    root = String.raw`E:\Portcove\controller`,
    capture = String.raw`E:\Portcove\native-capture`,
    linux = "/home/qualification/portcove-native";
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
  const paths = {
    bwrap: "/usr/bin/bwrap",
    git: "/usr/bin/git",
    python: "/usr/bin/python3",
    systemctl: "/usr/bin/systemctl",
    systemd_run: "/usr/bin/systemd-run",
    xvfb: "/usr/bin/Xvfb",
    webkit_driver: "/usr/bin/WebKitWebDriver",
    node: `${linux}/tools/node`,
    tauri_driver: `${linux}/tools/tauri-driver`,
    wsl: String.raw`C:\Windows\System32\wsl.exe`,
  };
  return {
    schema_version: 1,
    host_expected: { machine_id_sha256: "a".repeat(64), minimum_os_version: "6.8" },
    entry_pins: {
      supervisor_sha256: "e".repeat(64),
      transfer_sha256: "3".repeat(64),
      controller_revision: "4".repeat(40),
      controller_tree: "5".repeat(40),
    },
    invocation_id: id,
    request_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
    stage_request_sha256: "d".repeat(64),
    controller_root: root,
    capture_root: capture,
    capture_directory: capture + `\\native-attempt-${id}`,
    boundary_configuration: {
      schema_version: 1,
      broker_sid: account.broker,
      distribution: account.distribution,
      qualification_uid: "1002",
      qualification_gid: "1002",
      qualification_user: "qualification",
      controller_root: root,
      capture_root: capture,
      linux_root: linux,
      supervisor_sha256: "e".repeat(64),
      tools: Object.fromEntries(
        Object.entries(paths).map(([key, path]) => [key, { path, sha256: "f".repeat(64) }]),
      ),
    },
    account,
    package: {
      path: capture + String.raw`\native-source-frozen\Portcove.AppImage`,
      bytes: 1234,
      sha256: "1".repeat(64),
    },
    node: { path: String.raw`C:\Portcove\node.exe`, sha256: "2".repeat(64) },
    parent_deadline_utc: "2026-11-01T00:00:00.000Z",
  };
}
void test("post-sign transport package preparation permits only a distinct bounded retained predecessor", () => {
  const old = fixture();
  const next = {
    ...old,
    schema_version: 2,
    predecessor: {
      ...old.package,
      path: old.package.path.replace("Portcove.AppImage", "Predecessor.AppImage"),
      sha256: "9".repeat(64),
    },
  };
  assert.equal(inspectWslNativeDriverPlan(next).predecessor?.sha256, next.predecessor.sha256);
  for (const wrong of [
    { ...next, schema_version: 1 },
    { ...next, predecessor: { ...next.predecessor, sha256: old.package.sha256 } },
    {
      ...next,
      predecessor: { ...next.predecessor, path: String.raw`E:\other\Predecessor.AppImage` },
    },
    { ...next, predecessor: { ...next.predecessor, bytes: 512 * 1024 * 1024 + 1 } },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(wrong));
  assert.equal(inspectWslNativeDriverPlan(old).predecessor, null);
});
void test("bounded guest wire retains complete raw observations and refuses oversized metadata, wrong digest and incomplete closure", async (context) => {
  const root = disposableDirectory(context, path.join(os.tmpdir(), "native-wire-")),
    invocation = "a".repeat(64),
    sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  const payload = Buffer.alloc(65537, 0xff);
  const header = (name: string, bytes: number, digest: string) =>
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        invocation_id: invocation,
        path: name,
        bytes,
        sha256: digest,
      }) + "\n",
    );
  const complete = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      complete: true,
      count: 2,
      authority: "none",
    }) + "\n",
  );
  const valid = Buffer.concat([
    header(".outer-json-" + "b".repeat(32), 0, sha(Buffer.alloc(0))),
    header("desktop/output.bin", payload.length, sha(payload)),
    payload,
    complete,
  ]);
  const wire = path.join(root, "valid.bin");
  await writeFile(wire, valid);
  const result = await retainNativeCaptureWire(
    wire,
    path.join(root, "retained"),
    invocation,
    sha(valid),
  );
  assert.equal(result.authority, "none");
  assert.equal(result.entries.length, 2);
  assert.equal(
    await hashRetainedNativeCaptureFile(
      result.directory,
      result.entries[0]!.path,
      32 * 1024 * 1024,
      0,
    ),
    sha(Buffer.alloc(0)),
  );
  assert.deepEqual(await readFile(path.join(result.directory, "desktop/output.bin")), payload);
  await assert.rejects(
    retainNativeCaptureWire(wire, result.directory, invocation, sha(valid)),
    /EEXIST/u,
  );
  const invalid = [
    Buffer.alloc(2049, 65),
    header("huge.bin", 32 * 1024 * 1024 + 1, "b".repeat(64)),
    header("../escape", 1, "b".repeat(64)),
    header("NUL.bin", 1, "b".repeat(64)),
    Buffer.concat([header("wrong.bin", 1, "b".repeat(64)), Buffer.from("x")]),
    valid.subarray(0, valid.length - 2),
    Buffer.concat([valid, Buffer.from("x")]),
  ];
  for (const [index, bytes] of invalid.entries()) {
    const input = path.join(root, `invalid-${index}.bin`),
      output = path.join(root, `partial-${index}`);
    await writeFile(input, bytes);
    await assert.rejects(retainNativeCaptureWire(input, output, invocation, sha(bytes)));
    if (index < 4)
      assert.deepEqual(await readdir(output), [], "raw header refused before any file write");
  }
});
void test("fixed data-only guest driver plan binds original Windows/guest source and capture domains", () => {
  const raw = fixture(),
    selected = inspectWslNativeDriverPlan(raw);
  assert.equal(selected.authority, "none");
  assert.equal(selected.boundary.account.qualification, "1002");
  raw.package.path = "C:\\other.exe";
  assert.ok(selected.package.path.endsWith("Portcove.AppImage"));
  assert.throws(() => inspectWslNativeDriverPlan(raw));
  for (const change of [
    (v: ReturnType<typeof fixture>) => {
      v.capture_directory += "-other";
    },
    (v: ReturnType<typeof fixture>) => {
      v.boundary_configuration.qualification_uid = "0";
    },
    (v: ReturnType<typeof fixture>) => {
      v.package.bytes = 512 * 1024 * 1024 + 1;
    },
    (v: ReturnType<typeof fixture>) => {
      v.node.sha256 = "unknown";
    },
    (v: ReturnType<typeof fixture>) => {
      v.parent_deadline_utc = "2026-02-30T00:00:00.000Z";
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => inspectWslNativeDriverPlan(value));
  }
});
void test("no caller JSON or successful-driver descriptor can mint actual parent capture provenance", async () => {
  await assert.rejects(
    requireActualWslNativeCapture({
      kind: "actual-wsl-native-capture",
      authority: "none",
      native_acceptance: "accepted",
      status: 0,
    }),
    /actual installed parent/u,
  );
});
void test("guest operation budget intersects the original clock before any effect", () => {
  assert.equal(boundedNativeWslOperationTimeout(30000, 123), 123);
  for (const pair of [
    [1, 0],
    [0, 5000],
    [-1, 5000],
    [Infinity, 5000],
    [1, NaN],
  ])
    assert.throws(() => boundedNativeWslOperationTimeout(pair[0]!, pair[1]!));
});

void test("ordinary public Windows-to-guest transport stages distinct V0 and V1 without native predecessor reinterpretation", () => {
  const old = fixture();
  const publicPlan = {
    ...old,
    schema_version: 3,
    candidate: {
      ...old.package,
      path: old.package.path.replace("Portcove.AppImage", "Candidate.AppImage"),
      sha256: "9".repeat(64),
    },
  };
  const parsed = inspectWslNativeDriverPlan(publicPlan);
  assert.equal(parsed.schema_version, 3);
  assert.equal(parsed.package.sha256, old.package.sha256);
  assert.equal(parsed.public_candidate?.sha256, publicPlan.candidate.sha256);
  assert.equal(parsed.predecessor, null);
  assert.equal(parsed.authority, "none");
  for (const wrong of [
    { ...publicPlan, schema_version: 1 },
    { ...publicPlan, candidate: null },
    { ...publicPlan, predecessor: publicPlan.candidate },
    { ...publicPlan, candidate: { ...publicPlan.candidate, sha256: old.package.sha256 } },
    {
      ...publicPlan,
      candidate: { ...publicPlan.candidate, path: String.raw`E:\other\Candidate.AppImage` },
    },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(wrong));
});
void test("continuation capsule is a bounded fixed original capture input and cannot reinterpret schema3", () => {
  const raw = fixture();
  const input = {
    ...raw,
    schema_version: 4,
    candidate: { ...raw.package, sha256: "8".repeat(64) },
    parked_capture: {
      path: raw.capture_root + String.raw`\native-attempt-original\public-capture.stdout.bin`,
      bytes: 123,
      sha256: "7".repeat(64),
    },
  };
  const parsed = inspectWslNativeDriverPlan(input);
  assert.equal(parsed.schema_version, 4);
  assert.equal(parsed.parked_capture?.bytes, 123);
  for (const changed of [
    { ...input, schema_version: 3 },
    { ...input, parked_capture: null },
    { ...input, parked_capture: { ...input.parked_capture, bytes: 272 * 1024 * 1024 + 1 } },
    {
      ...input,
      parked_capture: { ...input.parked_capture, path: raw.capture_root + String.raw`\other.bin` },
    },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(changed));
});

void test("hosted Linux capture routes are fixed noninteractive source-before-import operations", async () => {
  const { inspectHostedLinuxDriverPlan, hostedLinuxCaptureCommands } =
    await import("./release-hosted-native-linux-driver.mts");
  const raw = hostedDriverFixture("/private/capture", "/private/controller");
  const prepared = inspectHostedLinuxDriverPlan(raw),
    commands = hostedLinuxCaptureCommands(prepared);
  for (const command of [
    commands.host,
    commands.run,
    commands.readback,
    commands.settle,
    commands.capture,
  ]) {
    assert.equal(command.executable, "/usr/bin/sudo");
    assert.deepEqual(command.arguments.slice(0, 6), [
      "-n",
      "-H",
      "-u",
      "portcove-native",
      "--",
      "/usr/bin/python3",
    ]);
    assert.ok(command.arguments.includes("-I") && command.arguments.includes("-S"));
    assert.ok(command.arguments.includes(prepared.entry_pins.controller_revision));
    assert.equal(command.arguments.includes("bash"), false);
  }
  const stage = commands.stage("application", 3, "b".repeat(64));
  assert.equal(
    stage.arguments.at(-1),
    createHash("sha256").update(stage.header.slice(0, -1)).digest("hex"),
  );
  const header: unknown = JSON.parse(stage.header);
  assert.ok(isRecord(header));
  assert.equal(header.entry, "application");
  for (const changes of [
    { broker_uid: raw.qualification_uid },
    { qualification_uid: "0" },
    { capture_directory: "/private/controller/capture" },
    { tools: { ...raw.tools, sudo: { path: "/tmp/sudo", sha256: "e".repeat(64) } } },
    { packages: [{ ...raw.packages[0], path: "/private/capture/auth.json" }] },
    { packages: [raw.packages[0], raw.packages[0]] },
    { extra: "caller authority" },
  ])
    assert.throws(() => inspectHostedLinuxDriverPlan({ ...raw, ...changes }));
});
function hostedDriverFixture(directory: string, root: string) {
  const hash = "e".repeat(64);
  return {
    schema_version: 1,
    broker_uid: "1000",
    qualification_uid: "2001",
    qualification_gid: "2001",
    capture_directory: directory,
    controller_root: root,
    invocation_id: "a".repeat(64),
    deadline_utc: new Date(Date.now() + 900000).toISOString(),
    entry_pins: {
      supervisor_sha256: hash,
      transfer_sha256: hash,
      controller_revision: "c".repeat(40),
      controller_tree: "d".repeat(40),
    },
    node: { path: "/usr/bin/node", sha256: hash },
    tools: Object.fromEntries(
      ["sudo", "python", "git"].map((name) => [
        name,
        { path: `/usr/bin/${name === "python" ? "python3" : name}`, sha256: hash },
      ]),
    ),
    host_expected: { machine_id_sha256: "f".repeat(64), minimum_os_version: "24.04" },
    request_sha256: hash,
    plan_sha256: hash,
    stage_request_sha256: hash,
    packages: [{ entry: "application", path: `${directory}/package.bin`, bytes: 3, sha256: hash }],
  };
}

void test(
  "hosted Linux driver stages actual fixture bytes once, retains ambiguity and requires matching closure before export",
  { skip: process.platform !== "linux" },
  async (t) => {
    // Actual Linux filesystem/stream/CLI composition; account, tool measurement,
    // process and supervisor outputs are controlled. No sudo or candidate runs.
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");
    const { fileURLToPath } = await import("node:url");
    const { releaseCanonicalDigest } = await import("./release-canonical.mts");
    const { nativeEmptyRecordsSha256 } =
      await import("./release-native-qualification-contract.mts");
    const resource = await import("./resource-command.mts");
    const scheduler = await import("./release-native-scheduler.mts");
    const childProcess = await import("node:child_process");
    const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
    const driver = fileURLToPath(
      new URL("./release-hosted-native-linux-driver.mts", import.meta.url),
    );
    const beforeArgs = process.argv,
      beforeExit = process.exitCode;
    type State = {
      invocation: string;
      requestSha: string;
      fault: string;
      calls: string[];
      host: object;
      task: Promise<number> | null;
      headers: string[];
      signals: string[];
      expired: boolean;
    };
    let state: State;
    const originalNow = performance.now.bind(performance);
    t.mock.method(performance, "now", () => originalNow() + (state?.expired ? 2000000 : 0));
    const filesystem = await import("node:fs/promises");
    t.mock.module("node:fs/promises", {
      namedExports: {
        ...filesystem,
        writeFile: async (...args: Parameters<typeof filesystem.writeFile>) => {
          await filesystem.writeFile(...args);
          if (
            state?.fault === "late-summary" &&
            typeof args[0] === "string" &&
            args[0].endsWith("/hosted-linux-capture-summary.json")
          )
            state.expired = true;
        },
      },
    });
    t.mock.module("./release-native-scheduler.mts", {
      namedExports: {
        ...scheduler,
        readNativeSchedulerToolDigest: async () => {
          if (state?.fault === "preflight-expiry") state.expired = true;
          return "e".repeat(64);
        },
      },
    });
    t.mock.module("./resource-command.mts", {
      namedExports: {
        ...resource,
        resourceEntrypoint: (_profile: string, action: () => Promise<number>) => {
          state.task = action();
          return state.task;
        },
      },
    });
    t.mock.module("node:child_process", {
      namedExports: {
        ...childProcess,
        spawn: (executable: string, args: string[], options: { env: Record<string, string> }) => {
          assert.equal(executable, "/usr/bin/sudo");
          assert.deepEqual(args.slice(0, 6), [
            "-n",
            "-H",
            "-u",
            "portcove-native",
            "--",
            "/usr/bin/python3",
          ]);
          assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
          const mode = args[args.lastIndexOf("--mode") + 1]!;
          state.calls.push(mode);
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: (signal?: string) => {
              state.signals.push(signal ?? "SIGTERM");
              return true;
            },
          });
          const chunks: Buffer[] = [];
          child.stdin.on("data", (bytes: Buffer) => chunks.push(Buffer.from(bytes)));
          child.stdin.once("finish", () => {
            setImmediate(() => {
              let result: unknown = {};
              if (mode === "host") result = state.host;
              else if (mode === "stage") {
                const data = Buffer.concat(chunks),
                  split = data.indexOf(10);
                assert.ok(split > 0);
                const headerBytes = data.subarray(0, split),
                  payload = data.subarray(split + 1);
                const header: unknown = JSON.parse(headerBytes.toString("utf8"));
                assert.ok(isRecord(header) && typeof header.entry === "string");
                assert.equal(createHash("sha256").update(headerBytes).digest("hex"), args.at(-1));
                assert.equal(payload.length, header.bytes);
                assert.equal(createHash("sha256").update(payload).digest("hex"), header.sha256);
                state.headers.push(header.entry);
                if (state.fault === "stage-refusal" && header.entry === "application") {
                  child.stderr.end("fixture capacity refusal after partial staging");
                  child.stdout.end();
                  child.emit("close", 1);
                  return;
                }
              } else if (mode === "run" && state.fault === "nonclosing") {
                child.stdout.write(Buffer.alloc(65537));
                child.stderr.write("inert fixture keeps pipes open");
                return;
              } else if (mode === "run" && state.fault === "ambiguous") {
                child.stdout.end("fixture run response ambiguous");
                child.stderr.end();
                child.emit("error", new Error("fixture ambiguous remote effect"));
                child.emit("close", null);
                return;
              } else if (mode === "readback" || mode === "settle") {
                const closed =
                  state.fault !== "unknown-settlement" &&
                  (mode === "settle" || !["ambiguous", "nonclosing"].includes(state.fault));
                result = {
                  invocation_id:
                    state.fault === "wrong-readback" ? "b".repeat(64) : state.invocation,
                  request_sha256: state.requestSha,
                  cgroup_empty: closed,
                  unit_settled: closed,
                };
              } else if (mode === "capture") {
                child.stdout.end("retained inert wire fixture");
                child.stderr.end();
                child.emit("close", 0);
                return;
              }
              child.stdout.end(JSON.stringify(result));
              child.stderr.end();
              child.emit("close", 0);
            });
          });
          return child;
        },
      },
    });
    t.mock.method(console, "error", () => {});
    try {
      let index = 0;
      for (const kind of [
        "pre-sign",
        "initial",
        "ordinary",
        "stage-refusal",
        "ambiguous",
        "unknown-settlement",
        "wrong-readback",
        "nonclosing",
        "late-summary",
        "preflight-expiry",
      ])
        await t.test(kind, { timeout: 20000 }, async (context) => {
          const directory = disposableDirectory(
            context,
            path.join(os.tmpdir(), "hosted-linux-driver-"),
          );
          const original = Buffer.from("inert-package"),
            prior = Buffer.from("inert-predecessor");
          await writeFile(path.join(directory, "package.bin"), original, { mode: 0o600 });
          const raw = hostedDriverFixture(directory, root);
          raw.broker_uid = String(process.getuid!());
          raw.qualification_uid = String(process.getuid!() + 5000);
          raw.qualification_gid = raw.qualification_uid;
          raw.node.path = process.execPath;
          const invocation = raw.invocation_id,
            linux = "/home/portcove-native/portcove-native",
            attempt = `${linux}/invocations/${invocation}`;
          const binding = {
            schema_version: 1,
            invocation_id: invocation,
            linux_root: linux,
            account: { uid: Number(raw.qualification_uid), gid: Number(raw.qualification_gid) },
            application: {
              path: `${attempt}/install/Portcove.AppImage`,
              bytes: original.length,
              sha256: createHash("sha256").update(original).digest("hex"),
            },
            controller: {
              root: `${linux}/controller`,
              source_commit: raw.entry_pins.controller_revision,
              source_tree: raw.entry_pins.controller_tree,
              init_sha256: "e".repeat(64),
            },
            tools: Object.fromEntries(
              Object.entries({
                bwrap: "/usr/bin/bwrap",
                driver: `${linux}/tools/tauri-driver`,
                git: "/usr/bin/git",
                node: `${linux}/tools/node`,
                python: "/usr/bin/python3",
                webkit_driver: "/usr/bin/WebKitWebDriver",
                xvfb: "/usr/bin/Xvfb",
              }).map(([name, path]) => [name, { path, sha256: "e".repeat(64) }]),
            ),
            capture_root: `${attempt}/capture`,
            home: `${attempt}/work/home`,
            deadline_utc: raw.deadline_utc,
          };
          const candidate = {
            source_commit: "1".repeat(40),
            source_tree: "2".repeat(40),
            run_id: "123",
            run_attempt: 1,
            artifact_id: 456,
            package: {
              filename: "Portcove.AppImage",
              bytes: original.length,
              sha256: binding.application.sha256,
            },
          };
          const priorCandidate = {
            ...candidate,
            artifact_id: 455,
            package: {
              ...candidate.package,
              bytes: prior.length,
              sha256: createHash("sha256").update(prior).digest("hex"),
            },
          };
          const postSign = kind === "initial" || kind === "ordinary";
          const stageRequest = {
            native_report_schema_version: 2,
            native_prepublication_profile: "signed-package-compatibility-v1",
            invocation_id: invocation,
            stage: "release-publication",
            platform_label: "linux-x86_64",
            candidate,
            journey:
              kind === "ordinary"
                ? {
                    predecessor: priorCandidate,
                    signed_context_sha256: "8".repeat(64),
                    signatures_sha256: "7".repeat(64),
                  }
                : {
                    kind: "initial-empty-feed",
                    empty_records_sha256: nativeEmptyRecordsSha256,
                    initial_site_preimage_sha256: "6".repeat(64),
                    metadata_bootstrap_sha256: "5".repeat(64),
                    setup_plan_sha256: "4".repeat(64),
                    signed_context_sha256: "8".repeat(64),
                    signatures_sha256: "7".repeat(64),
                  },
          };
          const plan = {
            schema_version: postSign ? 2 : 1,
            invocation_id: invocation,
            stage: postSign ? "release-publication" : "payload-signing",
            stage_request_sha256: postSign
              ? releaseCanonicalDigest(stageRequest)
              : raw.stage_request_sha256,
            binding,
            ...(postSign
              ? {
                  stage_request: stageRequest,
                  predecessor:
                    kind === "ordinary"
                      ? {
                          bytes: prior.length,
                          sha256: priorCandidate.package.sha256,
                          version: "0.4.0-beta.1",
                        }
                      : null,
                }
              : {}),
          };
          raw.stage_request_sha256 = plan.stage_request_sha256;
          const planBytes = Buffer.from(JSON.stringify(plan));
          raw.plan_sha256 = createHash("sha256").update(planBytes).digest("hex");
          const requestBytes = Buffer.from(
            JSON.stringify({
              schema_version: 1,
              invocation_id: invocation,
              stage_request_sha256: raw.stage_request_sha256,
              qualification_uid: Number(raw.qualification_uid),
              qualification_gid: Number(raw.qualification_gid),
              controller: {
                source_commit: raw.entry_pins.controller_revision,
                source_tree: raw.entry_pins.controller_tree,
              },
              plan_sha256: raw.plan_sha256,
              supervisor_sha256: raw.entry_pins.supervisor_sha256,
              deadline_utc: raw.deadline_utc,
              timeout_seconds: 600,
            }),
          );
          raw.request_sha256 = createHash("sha256").update(requestBytes).digest("hex");
          raw.packages = [
            {
              entry: postSign ? "candidate" : "application",
              path: path.join(directory, "package.bin"),
              bytes: original.length,
              sha256: binding.application.sha256,
            },
          ];
          if (kind === "ordinary") {
            await writeFile(path.join(directory, "predecessor.bin"), prior, { mode: 0o600 });
            raw.packages.push({
              entry: "predecessor",
              path: path.join(directory, "predecessor.bin"),
              bytes: prior.length,
              sha256: priorCandidate.package.sha256,
            });
          }
          await writeFile(path.join(directory, "native-request.json"), requestBytes, {
            mode: 0o600,
          });
          await writeFile(path.join(directory, "native-plan.json"), planBytes, { mode: 0o600 });
          const bytes = Buffer.from(JSON.stringify(raw)),
            filename = path.join(directory, "hosted-linux-driver-plan.json");
          await writeFile(filename, bytes, { mode: 0o600 });
          state = {
            invocation,
            requestSha: raw.request_sha256,
            fault: kind,
            calls: [],
            headers: [],
            signals: [],
            expired: false,
            task: null,
            host: {
              schema_version: 1,
              invocation_id: invocation,
              qualification_uid: Number(raw.qualification_uid),
              qualification_gid: Number(raw.qualification_gid),
              machine_id_sha256: raw.host_expected.machine_id_sha256,
              os_release: 'ID=ubuntu\nVERSION_ID="24.04"\n',
              kernel_release: "6.8.0-azure",
              architecture: "x86_64",
              authority: "none",
            },
          };
          const run = async () => {
            process.argv = [
              process.execPath,
              driver,
              "--driver",
              filename,
              createHash("sha256").update(bytes).digest("hex"),
            ];
            await import(
              new URL(
                `./release-hosted-native-linux-driver.mts?fixture=${index++}`,
                import.meta.url,
              ).href
            );
            assert.ok(state.task);
            await state.task;
          };
          if (
            ["stage-refusal", "wrong-readback", "late-summary", "preflight-expiry"].includes(kind)
          ) {
            await assert.rejects(
              run(),
              kind === "stage-refusal"
                ? /fixed Linux operation refused/
                : kind === "wrong-readback"
                  ? /readback belongs to another native attempt/
                  : /original capture lifetime expired/,
            );
            if (kind === "stage-refusal") {
              assert.deepEqual(state.headers, ["request", "plan", "application"]);
              assert.match(
                await readFile(path.join(directory, "stage-application.stderr.bin"), "utf8"),
                /capacity refusal after partial staging/,
              );
            }
            if (kind === "wrong-readback") {
              assert.ok(state.calls.includes("readback"));
              assert.equal(state.calls.includes("settle"), false);
            }
            if (kind === "preflight-expiry") assert.deepEqual(state.calls, []);
            if (kind === "late-summary")
              assert.ok((await readdir(directory)).includes("hosted-linux-capture-summary.json"));
            assert.ok((await readdir(directory)).includes("hosted-linux-driver-attempt.json"));
            assert.equal(state.calls.includes("capture"), kind === "late-summary");
            assert.equal(
              state.calls.filter((x) => x === "run").length,
              ["stage-refusal", "preflight-expiry"].includes(kind) ? 0 : 1,
            );
          } else {
            await run();
            const summary: unknown = JSON.parse(
              await readFile(path.join(directory, "hosted-linux-capture-summary.json"), "utf8"),
            );
            assert.ok(isRecord(summary));
            assert.equal(summary.native_acceptance, "not-established");
            assert.equal(summary.authority, "none");
            assert.equal(state.calls.filter((x) => x === "run").length, 1);
            assert.equal(
              state.calls.filter((x) => x === "settle").length,
              ["ambiguous", "unknown-settlement", "nonclosing"].includes(kind) ? 1 : 0,
            );
            if (kind === "nonclosing") {
              assert.equal(summary.status, null);
              assert.equal(summary.operation_children_settled, false);
              assert.equal(summary.capture_wire, null);
              assert.match(String(summary.failure), /closure.*unknown/);
              assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
            } else if (kind === "ambiguous") {
              assert.equal(summary.status, null);
              assert.match(String(summary.failure), /ambiguous/);
              assert.ok(summary.capture_wire);
            } else if (kind === "unknown-settlement") {
              assert.equal(summary.capture_wire, null);
              assert.match(String(summary.failure), /closure remains unknown/);
            } else {
              assert.equal(summary.failure, null);
              assert.ok(summary.capture_wire);
            }
            assert.deepEqual(state.headers, [
              "request",
              "plan",
              ...raw.packages.map((item) => item.entry),
            ]);
          }
          const originalCalls = [...state.calls];
          await assert.rejects(run(), /EEXIST|already exists/);
          assert.deepEqual(state.calls, originalCalls);
          await new Promise((resolve) => setImmediate(resolve));
          process.exitCode = beforeExit;
        });
    } finally {
      process.argv = beforeArgs;
      process.exitCode = beforeExit;
    }
  },
);
