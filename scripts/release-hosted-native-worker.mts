/** Fixed job-local supervision only. The original bootstrap owns all native,
 * admission and proof authority; public lifecycle records cannot supply it. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareFixedHostedLinuxLaunch,
  claimPreparedHostedLinuxLaunch,
} from "./release-hosted-native-launcher.mts";
import { readActualHostedLinuxBootstrapScope } from "./release-hosted-native-bootstrap.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import {
  nativeRuntimeSupport,
  inspectNativeRuntimeSupport,
  preparedNativeSupportDependencies,
} from "./release-native-runtime-support.mts";
import { rustSupportInputIdentity } from "./rust-support-cache.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests, inspectLinuxSupervisor } from "./run-rust-tests.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { retainReleaseRoutingMarker } from "./release-routing-marker.mts";
import { isRecord, errorCode } from "./runtime-values.mts";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const streamLimit = 1024 * 1024;
type Plan = Awaited<ReturnType<typeof prepareFixedHostedLinuxLaunch>>;
type Context = Awaited<ReturnType<typeof claimPreparedHostedLinuxLaunch>>;
async function retain(file: string, value: unknown, maximum = 16384) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length <= maximum);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function readOwned(file: string, maximum: number) {
  assert.ok(
    Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      maximum <= nativeRuntimeSupport.maximumBinaryBytes,
  );
  const original = inspectNativeRuntimeCustody([file]);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = () => {
    const s = fstatSync(fd, { bigint: true });
    return [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  };
  try {
    assert.equal(identity(), original.get(file));
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    assert.ok(used <= maximum, "native supervision input exceeds bound");
    assert.equal(identity(), original.get(file));
    recheckNativeRuntimeCustody([file], original);
    return Buffer.from(bytes.subarray(0, used));
  } finally {
    closeSync(fd);
  }
}
function retainSync(file: string, bytes: Buffer) {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function runStage(plan: Plan, context: Context, deadline: number) {
  context.recheck();
  const root = plan.temporary,
    operation = plan.operation;
  await retain(path.join(root, `${operation}-supervision-started.json`), {
    schema_version: 1,
    binding: plan.binding,
    operation,
    pid: process.pid,
    identity: readProcessIdentity(process.pid),
    authority: "none",
  });
  let stopped: string | null = null,
    registration = false,
    cleanup = false,
    status: number | null = null,
    settled = false;
  const signal = new EventEmitter();
  const refuse = (reason: string) => {
    stopped ??= reason;
    context.refuse();
    signal.emit("SIGTERM");
  };
  const active = () => {
    context.recheck();
    assert.ok(
      !stopped && performance.now() < deadline,
      "original native supervisor expired or refused",
    );
  };
  const timer = setTimeout(
    () => refuse("original-deadline"),
    Math.max(1, deadline - performance.now()),
  );
  const forward = () => refuse("operator-or-runner-cancellation");
  process.once("SIGTERM", forward);
  process.once("SIGINT", forward);
  const streams = {
    stdout: { fd: -1, bytes: 0, retained: 0 },
    stderr: { fd: -1, bytes: 0, retained: 0 },
  };
  try {
    for (const side of ["stdout", "stderr"] as const)
      streams[side].fd = openSync(path.join(root, `${operation}-worker.${side}.bin`), "wx", 0o600);
    const sourceFile = path.join(context.tools_root, nativeRuntimeSupport.source);
    const source = await readControllerToolFile(sourceFile, 65536);
    const binary = await readControllerToolFile(
      path.join(context.tools_root, nativeRuntimeSupport.binary),
      nativeRuntimeSupport.maximumBinaryBytes,
    );
    const metadata = inspectNativeRuntimeSupport(
      JSON.parse(
        (
          await readControllerToolFile(
            path.join(context.tools_root, nativeRuntimeSupport.metadata),
            65536,
          )
        ).toString("utf8"),
      ),
      source,
      binary,
    );
    assert.equal(
      rustSupportInputIdentity({
        product: nativeRuntimeSupport.product,
        source: sourceFile,
        compiler: metadata.compiler,
        rustcArgs: nativeRuntimeSupport.arguments,
        platform: "linux",
        architecture: "x64",
      }).fingerprint,
      metadata.input_fingerprint,
    );
    active();
    const support = preparedNativeSupportDependencies(
      {
        caller_root: sourceRoot,
        output_parent: root,
        source_file: sourceFile,
        source,
        binary,
        metadata,
      },
      active,
      () => refuse("prepared-support-refusal"),
    );
    status = await runResourceCommand("analysis", plan.command, [...plan.arguments], {
      cwd: sourceRoot,
      environment: { ...process.env, RUNNER_TEMP: root, TMPDIR: root, TEMP: root, TMP: root },
      queueDeadline: deadline,
      supervise: async (args, options) =>
        runRustTests(args, {
          ...options,
          ...support,
          tempRoot: root,
          signalTarget: signal,
          executionTimeoutMilliseconds: Math.max(1, Math.floor(deadline - performance.now())),
          onExecutionTimeout: () => refuse("execution-deadline"),
          spawn: (command, args, options) => {
            active();
            assert.equal(path.dirname(path.dirname(command)), root);
            assert.match(
              path.basename(path.dirname(command)),
              /^portcove-host-tool-fixture-[A-Za-z0-9]{6}$/u,
            );
            assert.equal(path.basename(command), "portcove-linux-process-tree-reaper");
            inspectNativeRuntimeCustody([command]);
            assert.equal(
              hash(readOwned(command, nativeRuntimeSupport.maximumBinaryBytes)),
              metadata.output.sha256,
            );
            assert.equal(args.length, 10);
            assert.equal(args[5], process.execPath);
            assert.equal(args[6], path.join(sourceRoot, "scripts/rust-test-tree-supervisor.mts"));
            assert.equal(args[7], plan.command);
            assert.equal(args[8], plan.arguments[0]);
            assert.equal(args[9], operation);
            const fixed = [...args];
            fixed[5] = plan.command;
            fixed[6] = path.join(context.tools_root, "scripts/rust-test-tree-supervisor.mts");
            active();
            const child = spawn(command, fixed, { ...options, stdio: ["pipe", "pipe", "pipe"] });
            for (const side of ["stdout", "stderr"] as const)
              child[side].on("data", (bytes: Buffer) => {
                try {
                  const stream = streams[side],
                    piece = bytes.subarray(0, Math.max(0, streamLimit - stream.retained));
                  for (let offset = 0; offset < piece.length;) {
                    const count = writeSync(stream.fd, piece, offset);
                    assert.ok(count > 0);
                    offset += count;
                  }
                  stream.retained += piece.length;
                  stream.bytes += bytes.length;
                  if (stream.bytes > streamLimit) refuse("worker-output-bound");
                } catch {
                  refuse("worker-output-retention");
                }
              });
            return child;
          },
          readLinuxSupervisor: (file, child) => {
            active();
            const bytes = readOwned(file, 8192);
            const value: unknown = JSON.parse(bytes.toString("utf8"));
            const result = inspectLinuxSupervisor(value, child.pid);
            retainSync(
              path.join(root, `${operation}-reaper-registration.json`),
              Buffer.from(
                JSON.stringify({
                  schema_version: 1,
                  reaper_pid: child.pid,
                  registration: value,
                  authority: "none",
                }),
              ),
            );
            registration = true;
            active();
            return result;
          },
          readCleanupReceipt: (file) => {
            assert.equal(path.dirname(path.dirname(file)), root);
            assert.equal(path.basename(file), "containment-cleanup.json");
            const bytes = readOwned(file, 1024),
              value: unknown = JSON.parse(bytes.toString("utf8"));
            if (!cleanup) retainSync(path.join(root, `${operation}-tree-cleanup.json`), bytes);
            cleanup = isRecord(value) && value.outcome === "quiescent";
            return value;
          },
        }),
    });
    settled = true;
    active();
    assert.ok(
      status === 0 && registration && cleanup,
      "fixed native worker failed or tree closure unproven",
    );
  } catch {
    stopped ??= "worker-refused-or-ambiguous";
    context.refuse();
  } finally {
    try {
      let flushFailed = false;
      for (const side of ["stdout", "stderr"] as const)
        if (streams[side].fd !== -1) {
          try {
            fsyncSync(streams[side].fd);
          } catch {
            flushFailed = true;
          } finally {
            try {
              closeSync(streams[side].fd);
            } catch {
              flushFailed = true;
            }
          }
        }
      assert.ok(!flushFailed, "native worker stream flush failed");
      await retain(path.join(root, `${operation}-supervision-settlement.json`), {
        schema_version: 1,
        operation,
        binding: plan.binding,
        exit_code: stopped ? 1 : 0,
        worker_status: status,
        supervisor_settled: settled,
        registration_observed: registration,
        tree_quiescent_observed: cleanup,
        reason: stopped,
        streams: Object.fromEntries(
          Object.entries(streams).map(([side, value]) => [
            side,
            {
              observed_bytes: value.bytes,
              retained_bytes: value.retained,
              truncated: value.bytes > value.retained,
            },
          ]),
        ),
        recovery_required: stopped !== null,
        automatic_retry: false,
        authority: "none",
        native_acceptance: "not-established",
      });
      active();
    } catch {
      stopped ??= "late-or-failed-settlement";
      context.refuse();
      await retain(
        path.join(root, `${operation}-supervision-refusal.json`),
        {
          schema_version: 1,
          reason: stopped,
          recovery_required: true,
          automatic_retry: false,
          partial_settlement: "retained; original row is not replaced",
          authority: "none",
        },
        4096,
      );
    } finally {
      clearTimeout(timer);
      process.off("SIGTERM", forward);
      process.off("SIGINT", forward);
    }
  }
  assert.equal(
    stopped,
    null,
    "fixed native worker refused; retain original effects; explicit recovery required",
  );
}

/** One original supervisor retains actual tools while both fixed children run.
 * The post-start signal is sequencing only; post-sign admits its own actual
 * source/coordinator/predecessors, and cannot retry a retained stage. */
export async function superviseFixedHostedLinuxNativeStages() {
  const pre = await prepareFixedHostedLinuxLaunch("pre-sign");
  const original = await claimPreparedHostedLinuxLaunch(pre);
  let phase = "pre-sign",
    preComplete = false,
    postComplete = false,
    failed = false;
  let failure: unknown;
  await retain(
    path.join(pre.temporary, "native-supervision-started.json"),
    {
      schema_version: 1,
      binding: pre.binding,
      pid: process.pid,
      identity: readProcessIdentity(process.pid),
      authority: "none",
    },
    4096,
  );
  try {
    await runStage(pre, original, original.deadline);
    preComplete = true;
    phase = "pre-sign-handoff";
    await retainReleaseRoutingMarker(
      path.join(pre.temporary, "native-pre-sign-handoff-ready.json"),
      {
        schema_version: 1,
        authority: "none",
        binding: pre.binding,
      },
    );
    original.recheck();
    phase = "waiting-for-post-start";
    const signalFile = path.join(pre.temporary, "native-post-start.json");
    while (true) {
      original.recheck();
      try {
        const bytes = await readControllerToolFile(signalFile, 4096);
        inspectNativeRuntimeCustody([signalFile]);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        assert.ok(
          isRecord(value) &&
            Object.keys(value).sort().join(",") ===
              "authority,binding,pre_launch_sha256,schema_version",
        );
        assert.equal(value.schema_version, 1);
        assert.equal(value.authority, "none");
        assert.equal(value.binding, pre.binding);
        assert.equal(
          value.pre_launch_sha256,
          hash(
            await readControllerToolFile(path.join(pre.temporary, "pre-sign-launch.json"), 4096),
          ),
        );
        original.recheck();
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          original.refuse();
          throw error;
        }
      }
      await delay(Math.min(100, Math.max(1, original.deadline - performance.now())));
    }
    const post = await prepareFixedHostedLinuxLaunch("post-sign");
    const current = await claimPreparedHostedLinuxLaunch(post);
    assert.equal(post.binding, pre.binding);
    assert.equal(post.command, pre.command);
    assert.equal(post.temporary, pre.temporary);
    original.recheck();
    phase = "post-sign";
    await runStage(post, current, Math.min(original.deadline, current.deadline));
    postComplete = true;
    phase = "complete";
  } catch (error) {
    failed = true;
    original.refuse();
    failure = error;
  }
  await retain(
    path.join(pre.temporary, "native-supervision-settlement.json"),
    {
      schema_version: 1,
      binding: pre.binding,
      phase,
      pre_sign_complete: preComplete,
      post_sign_complete: postComplete,
      exit_code: failed ? 1 : 0,
      recovery_required: failed,
      automatic_retry: false,
      remote_effects: "not-inferred; original stage/coordinator readback required",
      authority: "none",
      native_acceptance: "not-established",
    },
    4096,
  );
  if (!failed)
    try {
      original.recheck();
      assert.ok(performance.now() < original.deadline);
    } catch {
      original.refuse();
      await retain(
        path.join(pre.temporary, "native-supervision-refusal.json"),
        {
          schema_version: 1,
          reason: "late-final-supervisor-settlement",
          recovery_required: true,
          automatic_retry: false,
          partial_settlement: "retained; original row is not replaced",
          authority: "none",
        },
        4096,
      );
      throw new Error("original native clock expired during final supervisor settlement");
    }
  if (failed) throw failure;
}

/** Fixed trusted composite signal, never execution or native acceptance. */
export async function signalFixedHostedLinuxPostStart() {
  const scope = await readActualHostedLinuxBootstrapScope("post-sign");
  assert.ok(process.env.HOME && path.isAbsolute(process.env.HOME));
  const root = path.join(
    process.env.HOME,
    `.portcove-native-${scope.identity.run_id}-${scope.identity.run_attempt}-${scope.identity.controller_revision}`,
  );
  const preFile = path.join(root, "pre-sign-launch.json"),
    settlementFile = path.join(root, "pre-sign-supervision-settlement.json"),
    startedFile = path.join(root, "native-supervision-started.json");
  const clockFile = path.join(root, "portcove-native-job-clock.json");
  inspectNativeRuntimeCustody([preFile, settlementFile, startedFile, clockFile]);
  const clock: unknown = JSON.parse(
    (await readControllerToolFile(clockFile, 4096)).toString("utf8"),
  );
  assert.ok(
    isRecord(clock) &&
      Object.keys(clock).sort().join(",") ===
        "authority,binding,deadline_ns,schema_version,started_ns" &&
      clock.schema_version === 1 &&
      clock.authority === "none" &&
      clock.binding === scope.binding &&
      typeof clock.started_ns === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(clock.started_ns) &&
      typeof clock.deadline_ns === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(clock.deadline_ns),
  );
  const started = BigInt(clock.started_ns),
    end = BigInt(clock.deadline_ns);
  const active = () => {
    scope.unchanged();
    const now = process.hrtime.bigint();
    assert.ok(
      started <= now && end > now && end - started <= 570000000000n,
      "original native post-start clock expired or differs",
    );
  };
  active();
  const supervisorStarted: unknown = JSON.parse(
    (await readControllerToolFile(startedFile, 4096)).toString("utf8"),
  );
  assert.ok(
    isRecord(supervisorStarted) &&
      supervisorStarted.binding === scope.binding &&
      typeof supervisorStarted.pid === "number" &&
      Number.isSafeInteger(supervisorStarted.pid) &&
      supervisorStarted.pid > 1 &&
      typeof supervisorStarted.identity === "string" &&
      readProcessIdentity(supervisorStarted.pid) === supervisorStarted.identity,
    "original native supervisor is unavailable",
  );
  const supervisorPid = supervisorStarted.pid,
    supervisorIdentity = supervisorStarted.identity;
  const supervisorActive = () => {
    active();
    assert.equal(
      readProcessIdentity(supervisorPid),
      supervisorIdentity,
      "original native supervisor is unavailable",
    );
  };
  const settlement: unknown = JSON.parse(
    (await readControllerToolFile(settlementFile, 16384)).toString("utf8"),
  );
  assert.ok(
    isRecord(settlement) &&
      settlement.exit_code === 0 &&
      settlement.binding === scope.binding &&
      settlement.supervisor_settled === true &&
      settlement.tree_quiescent_observed === true &&
      settlement.recovery_required === false,
  );
  supervisorActive();
  await retain(
    path.join(root, "native-post-start.json"),
    {
      schema_version: 1,
      binding: scope.binding,
      pre_launch_sha256: hash(await readControllerToolFile(preFile, 4096)),
      authority: "none",
    },
    4096,
  );
  supervisorActive();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv.length === 3 ? process.argv[2] : null;
  const running =
    operation === "run"
      ? superviseFixedHostedLinuxNativeStages()
      : operation === "post-start"
        ? signalFixedHostedLinuxPostStart()
        : Promise.reject(new Error("fixed hosted native worker operation required"));
  running.catch(() => {
    console.error(
      "fixed hosted native supervision refused; retain original stage state and effects; no automatic retry",
    );
    process.exitCode = 2;
  });
}
