/** Fixed same-job Actions handoffs. Routing records never grant native authority. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { readActualHostedLinuxBootstrapScope } from "./release-hosted-native-bootstrap.mts";
import { signalFixedHostedLinuxPostStart } from "./release-hosted-native-worker.mts";
import { currentNativeJobDeadline } from "./release-signing-job-budget.mts";
import { controllerToolPaths, readControllerToolFile } from "./release-controller-tools.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import type { NativeRuntimeCustody } from "./release-native-runtime-custody.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { errorCode, isRecord } from "./runtime-values.mts";

type Stage = "pre-sign" | "post-sign";
const repository = fileURLToPath(new URL("../", import.meta.url));
async function retain(file: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length <= 8192);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function stage(value: unknown): Stage {
  assert.ok(value === "pre-sign" || value === "post-sign");
  return value;
}
async function ownedJson(file: string) {
  const custody = inspectNativeRuntimeCustody([file]);
  const bytes = await readControllerToolFile(file, 8192);
  recheckNativeRuntimeCustody([file], custody);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(isRecord(value) && value.authority === "none" && value.schema_version === 1);
  return value;
}
async function optional(file: string) {
  try {
    return await ownedJson(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return undefined;
  }
}
async function context(selected: Stage) {
  const scope = await readActualHostedLinuxBootstrapScope(selected);
  assert.ok(process.env.HOME && path.isAbsolute(process.env.HOME));
  const root = path.join(
    process.env.HOME,
    `.portcove-native-${scope.identity.run_id}-${scope.identity.run_attempt}-${scope.identity.controller_revision}`,
  );
  const deadline = currentNativeJobDeadline(
    "linux-x86_64",
    scope.identity,
    repository,
    performance.now() + 570000,
  );
  const intent = path.join(scope.temporary, "portcove-native-workflow-start.json");
  const started = path.join(scope.temporary, "portcove-native-workflow-started.json");
  const active = () => {
    scope.unchanged();
    assert.ok(performance.now() < deadline, "original native workflow deadline exhausted");
  };
  active();
  return { scope, root, deadline, intent, started, active };
}
type Context = Awaited<ReturnType<typeof context>>;
type Owner = {
  pid: number;
  identity: string;
  end: bigint;
  live: boolean;
  files: string[];
  custody: NativeRuntimeCustody;
};
function refusalAbsent(c: Context) {
  for (const name of [
    "pre-sign-supervision-refusal.json",
    "post-sign-supervision-refusal.json",
    "native-supervision-refusal.json",
  ])
    assert.equal(
      lstatSync(path.join(c.root, name), { throwIfNoEntry: false }),
      undefined,
      "retained native refusal requires recovery",
    );
}
function fence(c: Context, owner: Owner, requireLive = true, requireDead = false) {
  c.active();
  recheckNativeRuntimeCustody(owner.files, owner.custody);
  assert.ok(process.hrtime.bigint() < owner.end, "original shared native clock exhausted");
  const observed = readProcessIdentity(owner.pid);
  assert.ok(
    observed === null || observed === owner.identity,
    "original native worker PID was reused",
  );
  if (requireLive)
    assert.equal(
      observed,
      owner.identity,
      "original native worker unavailable after readback; recovery required",
    );
  if (requireDead) assert.equal(observed, null, "original native worker remains alive");
  refusalAbsent(c);
  c.active();
  assert.ok(process.hrtime.bigint() < owner.end, "original shared native clock exhausted");
  return observed === owner.identity;
}
async function original(c: Context, requireLive = true): Promise<Owner> {
  c.active();
  const files = [
    c.intent,
    c.started,
    path.join(c.root, "native-supervision-started.json"),
    path.join(c.root, "portcove-native-job-clock.json"),
  ];
  const custody = inspectNativeRuntimeCustody(files);
  const intent = await ownedJson(c.intent),
    started = await ownedJson(c.started);
  assert.equal(intent.binding, c.scope.binding);
  assert.equal(started.binding, c.scope.binding);
  assert.ok(
    Number.isSafeInteger(started.pid) &&
      Number(started.pid) > 1 &&
      typeof started.identity === "string",
  );
  const pid = Number(started.pid),
    identity = String(started.identity);
  const actual = readProcessIdentity(pid);
  // A reused PID is never the original worker and is never signaled.
  assert.ok(actual === null || actual === identity, "original native worker PID was reused");
  if (requireLive)
    assert.equal(
      actual,
      identity,
      "original native worker unavailable; readback/recovery required",
    );
  const worker = await ownedJson(path.join(c.root, "native-supervision-started.json"));
  assert.equal(worker.binding, c.scope.binding);
  assert.equal(worker.pid, pid);
  assert.equal(worker.identity, identity);
  const clock = await ownedJson(path.join(c.root, "portcove-native-job-clock.json"));
  assert.equal(clock.binding, c.scope.binding);
  assert.ok(typeof clock.started_ns === "string" && /^[1-9][0-9]{0,19}$/u.test(clock.started_ns));
  assert.ok(typeof clock.deadline_ns === "string" && /^[1-9][0-9]{0,19}$/u.test(clock.deadline_ns));
  const begin = BigInt(clock.started_ns),
    end = BigInt(clock.deadline_ns),
    now = process.hrtime.bigint();
  assert.ok(begin <= now && now < end && end > begin && end - begin <= 570000000000n);
  const owner = { pid, identity, end, live: false, files, custody };
  owner.live = fence(c, owner, requireLive);
  return owner;
}
async function refusal(c: Context, selected: Stage) {
  for (const name of [`${selected}-supervision-refusal.json`, "native-supervision-refusal.json"])
    assert.equal(
      await optional(path.join(c.root, name)),
      undefined,
      "retained native refusal requires recovery",
    );
}

/** Claim before spawn. Existing intent, even without a PID record, cannot retry. */
export async function startHostedLinuxWorkflow() {
  const c = await context("pre-sign");
  await retain(c.intent, {
    schema_version: 1,
    binding: c.scope.binding,
    automatic_retry: false,
    authority: "none",
  });
  c.active();
  // Receive/authenticate the complete existing opaque closure before selecting
  // another executable. The shared setup-node pathname is never spawned here.
  const runtime = path.join(c.scope.temporary, "portcove-native-workflow-runtime");
  await mkdir(runtime, { mode: 0o700 });
  const receipt = await receiveControllerTools(runtime, c.scope.artifact, c.scope.bundle, {
    deadline: c.deadline,
  });
  const tools = await verifiedControllerToolPaths(receipt);
  const executable = tools.entries["release-hosted-native-worker"];
  assert.ok(executable);
  const files = [
    ...controllerToolPaths.map((name) => path.join(tools.root, name)),
    path.join(tools.root, "manifest.json"),
  ];
  const custody = inspectNativeRuntimeCustody(files);
  await verifiedControllerToolPaths(receipt);
  recheckNativeRuntimeCustody(files, custody);
  c.active();
  const child = spawn(tools.node, [executable, "run"], {
    cwd: repository,
    env: { ...process.env },
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  assert.ok(child.pid && child.pid > 1);
  const identity = readProcessIdentity(child.pid);
  assert.ok(identity, "native worker exited during startup; retain intent and reconcile");
  await retain(c.started, {
    schema_version: 1,
    binding: c.scope.binding,
    pid: child.pid,
    identity,
    authority: "none",
  });
  c.active();
  refusalAbsent(c);
  assert.equal(
    readProcessIdentity(child.pid),
    identity,
    "native worker exited during startup persistence; recovery required",
  );
  c.active();
  return { started: true, authority: "none" };
}

/** Reads only the original worker's four bounded public proof files. */
export async function hostedLinuxWorkflowUploadRequest(raw: unknown) {
  const selected = stage(raw),
    c = await context(selected);
  const runner = await import("./release-hosted-native-runner.mts");
  for (;;) {
    c.active();
    try {
      const owner = await original(c);
      await refusal(c, selected);
      const read =
        selected === "pre-sign"
          ? runner.readHostedNativeUploadRequest
          : runner.readHostedNativePostSignUploadRequest;
      const request = await read(path.join(c.root, `portcove-native-linux-${selected}`));
      assert.equal(
        request.name,
        `hosted-native-${selected === "pre-sign" ? "payload-signing" : "release-publication"}-linux-x86_64-${c.scope.identity.run_id}-1`,
      );
      assert.ok(BigInt(request.deadline_ns) <= owner.end);
      const current = await original(c);
      await refusal(c, selected);
      fence(c, owner);
      fence(c, current);
      return request;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      // Before first preparation, a missing clock/start row is not success.
      const started = await ownedJson(c.started);
      assert.equal(
        readProcessIdentity(Number(started.pid)),
        started.identity,
        "worker exited before readiness; retain effects and recover",
      );
      await delay(100);
    }
  }
}
export async function acknowledgeHostedLinuxWorkflowUpload(
  raw: unknown,
  request: string,
  artifact: string,
  digest: string,
) {
  const selected = stage(raw),
    c = await context(selected);
  const before = await original(c);
  await refusal(c, selected);
  assert.ok(/^[1-9][0-9]{0,15}$/u.test(artifact));
  const runner = await import("./release-hosted-native-runner.mts");
  const acknowledge =
    selected === "pre-sign"
      ? runner.acknowledgeHostedNativeUpload
      : runner.acknowledgeHostedNativePostSignUpload;
  fence(c, before);
  await acknowledge(
    path.join(c.root, `portcove-native-linux-${selected}`),
    request,
    Number(artifact),
    digest,
  );
  const current = await original(c, selected === "pre-sign");
  await refusal(c, selected);
  fence(c, before, selected === "pre-sign");
  fence(c, current, selected === "pre-sign");
  return { acknowledgement_retained: true, authority: "none" };
}
/** Called only after the fixed same-job caller has established post prerequisites.
 * The native producer still independently authenticates every prerequisite. */
export async function startHostedLinuxWorkflowPostSign() {
  const c = await context("post-sign");
  const before = await original(c);
  await refusal(c, "pre-sign");
  fence(c, before);
  await signalFixedHostedLinuxPostStart();
  fence(c, await original(c));
  fence(c, before);
  return { signaled: true, authority: "none" };
}
export async function settleHostedLinuxWorkflowStage(raw: unknown) {
  const selected = stage(raw),
    c = await context(selected);
  for (;;) {
    const owner = await original(c, selected === "pre-sign");
    await refusal(c, selected);
    const row = await optional(path.join(c.root, `${selected}-supervision-settlement.json`));
    if (row) {
      assert.equal(row.binding, c.scope.binding);
      assert.equal(row.operation, selected);
      assert.equal(row.exit_code, 0);
      assert.equal(row.recovery_required, false);
      assert.equal(row.supervisor_settled, true);
      assert.equal(row.registration_observed, true);
      assert.equal(row.tree_quiescent_observed, true);
      assert.equal(row.native_acceptance, "not-established");
      if (selected === "post-sign") {
        const final = await optional(path.join(c.root, "native-supervision-settlement.json"));
        if (!final)
          assert.ok(owner.live, "worker exited without final settlement; recovery required");
        if (!final || owner.live) {
          await delay(100);
          continue;
        }
        assert.equal(final.binding, c.scope.binding);
        assert.equal(final.exit_code, 0);
        assert.equal(final.recovery_required, false);
        assert.equal(final.phase, "complete");
        assert.equal(final.pre_sign_complete, true);
        assert.equal(final.post_sign_complete, true);
      }
      const current = await original(c, selected === "pre-sign");
      await refusal(c, selected);
      fence(c, owner, selected === "pre-sign");
      fence(c, current, selected === "pre-sign", selected === "post-sign");
      return {
        stage: selected,
        process_settled: true,
        native_acceptance: "not-established",
        authority: "none",
      };
    }
    assert.ok(owner.live, "original worker exited without matching settlement; recovery required");
    await delay(100);
  }
}
async function output(values: Record<string, string>) {
  assert.ok(process.env.GITHUB_OUTPUT && path.isAbsolute(process.env.GITHUB_OUTPUT));
  for (const [key, value] of Object.entries(values)) {
    const separator = `native_${randomBytes(16).toString("hex")}`;
    assert.ok(Buffer.byteLength(value) <= 16384 && !value.includes(separator));
    await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${separator}\n${value}\n${separator}\n`);
  }
}
async function main() {
  const operation = process.argv[2],
    selected = stage(process.argv[3]);
  if (operation === "start" && selected === "pre-sign" && process.argv.length === 4)
    return startHostedLinuxWorkflow();
  if (operation === "start" && selected === "post-sign" && process.argv.length === 4)
    return startHostedLinuxWorkflowPostSign();
  if (operation === "request" && process.argv.length === 4) {
    const result = await hostedLinuxWorkflowUploadRequest(selected);
    await output({
      name: result.name,
      paths: result.files.join("\n"),
      request_sha256: result.request_sha256,
    });
    assert.deepEqual(
      await hostedLinuxWorkflowUploadRequest(selected),
      result,
      "upload routing changed during output",
    );
    return { ready: true, authority: "none" };
  }
  if (operation === "ack" && process.argv.length === 4)
    return acknowledgeHostedLinuxWorkflowUpload(
      selected,
      process.env.PORTCOVE_NATIVE_REQUEST_SHA256 ?? "",
      process.env.PORTCOVE_NATIVE_ARTIFACT_ID ?? "",
      process.env.PORTCOVE_NATIVE_ARTIFACT_SHA256 ?? "",
    );
  if (operation === "settle" && process.argv.length === 4)
    return settleHostedLinuxWorkflowStage(selected);
  throw new Error("fixed native workflow operation required");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .then((value) => console.log(JSON.stringify(value)))
    .catch(() => {
      console.error(
        "native workflow refused; preserve original attempt/effects and use coordinator readback/recovery; no retry",
      );
      process.exitCode = 2;
    });
