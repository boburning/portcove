/** Original hosted parent only. JSON installation records grant no execution,
 * issuer, candidate or acceptance authority. Existing partial state never retries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { hostedNativeSupportDependencies } from "./release-hosted-native-runtime.mts";
import { retainReleaseRoutingMarker } from "./release-routing-marker.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectNativeDependencyWorkspace } from "./release-pnpm-runtime.mts";

const workspace = "/home/runner/work/portcove/portcove";
const attempts = new WeakSet<object>();
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export async function prepareActualHostedLinuxInstallation(
  parentReceipt: object,
  toolsReceipt: object,
  runtimeReceipt: object,
) {
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  assert.ok(
    parent.configuration.purpose === "application" &&
      parent.platform_label === "linux-x86_64" &&
      parent.stage === "payload-signing",
  );
  assert.ok(process.platform === "linux" && process.arch === "x64" && process.getuid?.());
  assert.equal(process.env.GITHUB_WORKSPACE, workspace);
  assert.ok(!attempts.has(parentReceipt), "one installation attempt; explicit recovery required");
  attempts.add(parentReceipt);
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  parent.recheck();
  assert.equal(tools.identity.controller_revision, parent.producer.controller_revision);
  assert.equal(tools.identity.controller_ref, parent.producer.controller_ref);
  assert.equal(String(tools.identity.run_id), String(parent.producer.run_id));
  assert.equal(tools.identity.run_attempt, parent.producer.run_attempt);
  const selected = parent.configuration.hosted_native["linux-x86_64"].producer;
  const nativeSource = path.join(workspace, "native-source");
  const harness = path.join(nativeSource, selected.harness.path);
  let sourceCustody: ReturnType<typeof inspectNativeRuntimeCustody> | undefined;
  const files = [
    tools.node,
    tools.nativeDriver,
    path.join(tools.root, "scripts/qualify-hosted-native-linux.py"),
    path.join(tools.root, "scripts/prepare-hosted-native-linux-installation.py"),
    path.join(tools.root, "scripts/native-qualification-linux-supervisor.py"),
    tools.pnpm,
  ];
  const custody = inspectNativeRuntimeCustody(files);
  const primitivePins = Object.fromEntries(
    await Promise.all(
      [files[2]!, files[4]!].map(
        async (filename) =>
          [path.basename(filename), hash(await readControllerToolFile(filename, 65536))] as const,
      ),
    ),
  );
  recheckNativeRuntimeCustody(files, custody);
  const context = {
    GITHUB_SHA: parent.producer.controller_revision,
    GITHUB_RUN_ID: String(parent.producer.run_id),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/application-update-production.yml@${parent.producer.controller_ref}`,
  };
  const binding = hash(Buffer.from(JSON.stringify({ producer: parent.producer, selected })));
  const directory = parent.directory;
  const lifetime = (maximum: number) => {
    const remaining = Math.floor(Math.min(maximum, parent.deadline - performance.now() - 210000));
    assert.ok(remaining > 0, "installation must preserve the existing capture/recovery reserve");
    return {
      broker_uid: process.getuid!(),
      broker_pid: process.pid,
      broker_identity: readProcessIdentity(process.pid, { platform: "linux" }),
      deadline_ns: String(process.hrtime.bigint() + BigInt(remaining) * 1_000_000n),
    };
  };
  const active = () => {
    parent.recheck();
    recheckNativeRuntimeCustody(files, custody);
    if (sourceCustody) recheckNativeRuntimeCustody([harness], sourceCustody);
    assert.ok(
      performance.now() < parent.deadline,
      "original installation issuer/job clock exhausted",
    );
  };
  const run = async (
    name: string,
    executable: string,
    args: string[],
    boundary: ReturnType<typeof lifetime>,
  ) => {
    active();
    const remaining = Number((BigInt(boundary.deadline_ns) - process.hrtime.bigint()) / 1_000_000n);
    assert.ok(remaining > 0, "installation must preserve the existing capture/recovery reserve");
    const deadline = performance.now() + remaining;
    const stdout = openSync(path.join(directory, `${name}.stdout.json`), "wx", 0o600);
    let stderr: number;
    try {
      stderr = openSync(path.join(directory, `${name}.stderr.bin`), "wx", 0o600);
    } catch (error) {
      closeSync(stdout);
      throw error;
    }
    let status: number;
    const signal = new EventEmitter();
    let outputFailure: Error | undefined;
    // Starts before queue admission. No launch can renew this absolute allowance.
    const timer = setTimeout(() => signal.emit("SIGTERM"), remaining);
    try {
      status = await runResourceCommand("analysis", executable, args, {
        cwd: workspace,
        environment: {
          PATH: "/usr/bin:/bin",
          HOME: "/home/runner",
          LANG: "C.UTF-8",
          GITHUB_ACTIONS: "true",
          RUNNER_TEMP: directory,
        },
        output: { stdout, stderr },
        queueDeadline: deadline,
        executionTimeoutMilliseconds: remaining,
        supervise: async (arguments_, options) => {
          const support = await hostedNativeSupportDependencies(
            runtimeReceipt,
            parentReceipt,
            directory,
          );
          active();
          assert.ok(performance.now() < deadline, "original installation preparation expired");
          return runRustTests(arguments_, {
            ...options,
            ...support,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              assert.ok(options.acquireLock);
              const lease = await options.acquireLock(metadata, admission);
              try {
                active();
                assert.ok(performance.now() < deadline, "original installation admission expired");
                return lease;
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
            spawn: (command, commandArgs, options_) => {
              active();
              assert.ok(performance.now() < deadline, "original installation launch expired");
              const child = spawn(command, [...commandArgs], {
                ...options_,
                stdio: ["pipe", "pipe", "pipe"],
              });
              for (const [stream, descriptor, maximum] of [
                [child.stdout, stdout, 65536],
                [child.stderr, stderr, 8192],
              ] as const) {
                let retained = 0;
                stream.on("data", (bytes: Buffer) => {
                  try {
                    const available = Math.max(0, maximum - retained);
                    if (available) writeSync(descriptor, bytes.subarray(0, available));
                    retained += bytes.length;
                    assert.ok(retained <= maximum, "installation output exceeded retained bound");
                  } catch (error) {
                    outputFailure ??= error instanceof Error ? error : new Error(String(error));
                    signal.emit("SIGTERM");
                  }
                });
              }
              return child;
            },
          });
        },
      });
    } finally {
      clearTimeout(timer);
      closeSync(stdout);
      closeSync(stderr);
    }
    active();
    assert.equal(outputFailure, undefined);
    assert.ok(performance.now() < deadline, "original installation operation expired");
    const bytes = await readControllerToolFile(path.join(directory, `${name}.stdout.json`), 65536);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assert.equal(
      status,
      0,
      "installation refused; retain partial state and use coordinator recovery",
    );
    assert.ok(isRecord(value));
    active();
    return value;
  };
  await retainReleaseRoutingMarker(path.join(directory, "hosted-installation-started.json"), {
    schema_version: 1,
    binding,
    automatic_retry: false,
    authority: "none",
  });
  active();
  const identities = await Promise.all(
    [tools.node, tools.nativeDriver, tools.pnpm].map(async (filename) => {
      const bytes = await readControllerToolFile(filename);
      active();
      return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
    }),
  );
  const sourceLifetime = lifetime(90000);
  const sourcePlan = {
    schema_version: 1,
    binding,
    source_commit: selected.source_commit,
    source_tree: selected.source_tree,
    harness_sha256: selected.harness.sha256,
    ...sourceLifetime,
    tools: { node: identities[0], driver: identities[1] },
    context,
  };
  const acquired = await run(
    "hosted-source-acquisition",
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import json,runpy,sys; module=runpy.run_path(sys.argv[1]); print(json.dumps(module['acquire_source'](module['inspect_plan'](json.loads(sys.argv[2])))))",
      files[3]!,
      JSON.stringify(sourcePlan),
    ],
    sourceLifetime,
  );
  assert.equal(acquired.binding, binding);
  assert.equal(acquired.source_commit, selected.source_commit);
  assert.equal(acquired.source_tree, selected.source_tree);
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.dependencies_prepared, false);
  sourceCustody = inspectNativeRuntimeCustody([harness]);
  assert.equal(hash(await readControllerToolFile(harness, 1024 ** 2)), selected.harness.sha256);
  active();
  const dependencyWorkspace = inspectNativeDependencyWorkspace(
    await readControllerToolFile(path.join(nativeSource, "pnpm-workspace.yaml"), 65536),
  );
  const dependencyLifetime = lifetime(90000);
  const dependencyReadback = await run(
    "hosted-dependency-preflight",
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import json,runpy,sys; module=runpy.run_path(sys.argv[1]); print(json.dumps(module['prepare_source_dependencies'](module['inspect_plan'](json.loads(sys.argv[2])),json.loads(sys.argv[3]))))",
      files[3]!,
      JSON.stringify({ ...sourcePlan, ...dependencyLifetime }),
      JSON.stringify({
        pnpm: identities[2],
        workspace_sha256: dependencyWorkspace.sha256,
        patches: dependencyWorkspace.patches,
      }),
    ],
    dependencyLifetime,
  );
  assert.equal(dependencyReadback.binding, binding);
  assert.equal(dependencyReadback.dependencies_prepared, true);
  active();
  // The module is attested controller code. Native source is data, never root code.
  const helper = await readControllerToolFile(files[3]!, 65536);
  const runtimeLifetime = lifetime(90000);
  const runtimeInputs = await run(
    "hosted-runtime-inputs",
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-B",
      "-c",
      helper.toString("utf8"),
      "--runtime-packages",
      JSON.stringify({ schema_version: 1, binding, ...runtimeLifetime, context }),
    ],
    runtimeLifetime,
  );
  assert.equal(runtimeInputs.binding, binding);
  assert.equal(runtimeInputs.prepared, true);
  active();
  const setupLifetime = lifetime(150000);
  const setup = await run(
    "hosted-primitives",
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import json,runpy,sys; module=runpy.run_path(sys.argv[1]); sys.exit(module['prepare_for_original_hosted_parent'](sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]),json.loads(sys.argv[5])))",
      files[2]!,
      workspace,
      JSON.stringify(context),
      JSON.stringify(setupLifetime),
      JSON.stringify(primitivePins),
    ],
    setupLifetime,
  );
  assert.equal(setup.failure, null);
  assert.equal(setup.stage, "bounded-primitives-observed");
  assert.ok(isRecord(setup.probe) && setup.probe.passed === true);
  assert.ok(isRecord(setup.setup) && setup.setup.completed === true);
  active();
  const materializationLifetime = lifetime(120000);
  const plan = {
    schema_version: 1,
    binding,
    source_commit: selected.source_commit,
    source_tree: selected.source_tree,
    harness_sha256: selected.harness.sha256,
    ...materializationLifetime,
    tools: { node: identities[0], driver: identities[1] },
    context,
  };
  active();
  const installed = await run(
    "hosted-materialization",
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-B",
      "-c",
      helper.toString("utf8"),
      JSON.stringify(plan),
    ],
    materializationLifetime,
  );
  assert.equal(installed.binding, binding);
  assert.equal(installed.source_commit, selected.source_commit);
  assert.equal(installed.source_tree, selected.source_tree);
  assert.equal(installed.installed, true);
  assert.equal(installed.children_settled, true);
  assert.ok(isRecord(setup.setup) && isRecord(setup.setup.profile));
  const finalLifetime = lifetime(20000);
  const finalReadback = await run(
    "hosted-profile-readback",
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import json,runpy,sys; module=runpy.run_path(sys.argv[1]); sys.exit(module['readback_for_original_hosted_parent'](sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]),json.loads(sys.argv[5]),json.loads(sys.argv[6])))",
      files[2]!,
      workspace,
      JSON.stringify(context),
      JSON.stringify(finalLifetime),
      JSON.stringify(setup.setup.profile.final_state),
      JSON.stringify(primitivePins),
    ],
    finalLifetime,
  );
  assert.equal(finalReadback.readback, true);
  active();
  await verifiedControllerToolPaths(toolsReceipt);
  active();
  return Object.freeze({
    kind: "original-hosted-linux-materialization",
    binding,
    native_acceptance: "not-established",
    authority: "none",
  });
}
