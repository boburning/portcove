/** Fixed same-job Actions handoffs. Routing records never grant native authority. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
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
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { waitForNativePostSignReadiness } from "./release-native-postsign-readiness.mts";

type Stage = "pre-sign" | "post-sign";
type WorkflowPlatform = "linux-x86_64" | "windows-x86_64";
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
async function context(selected: Stage, platform: WorkflowPlatform = "linux-x86_64") {
  const windows = platform === "windows-x86_64";
  const bootstrap = windows ? await import("./release-hosted-native-bootstrap.mts") : undefined;
  if (windows)
    assert.ok(
      bootstrap?.hostedWindowsBootstrapExecutionAuthorized,
      "Windows workflow transport awaits separate bootstrap execution authority",
    );
  const scope = windows
    ? await bootstrap!.readActualHostedWindowsBootstrapScope(selected)
    : await readActualHostedLinuxBootstrapScope(selected);
  const home = windows ? homedir() : process.env.HOME;
  assert.ok(home && path.isAbsolute(home));
  const root = path.join(
    home,
    windows
      ? `.pcn-${scope.binding.slice(0, 32)}`
      : `.portcove-native-${scope.identity.run_id}-${scope.identity.run_attempt}-${scope.identity.controller_revision}`,
  );
  const deadline = currentNativeJobDeadline(
    platform,
    scope.identity,
    repository,
    performance.now() + 570000,
  );
  const prefix = windows ? "portcove-native-windows-workflow" : "portcove-native-workflow";
  const intent = path.join(scope.temporary, `${prefix}-start.json`);
  const started = path.join(scope.temporary, `${prefix}-started.json`);
  const active = () => {
    scope.unchanged();
    assert.ok(performance.now() < deadline, "original native workflow deadline exhausted");
  };
  active();
  return { scope, root, deadline, intent, started, active, platform, windows };
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
  if (c.windows)
    assert.equal(
      lstatSync(path.join(c.scope.temporary, "portcove-native-windows-workflow-refusal.json"), {
        throwIfNoEntry: false,
      }),
      undefined,
      "retained Windows workflow refusal requires recovery",
    );
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
  if (c.windows) {
    assert.equal(clock.platform, c.platform);
    assert.equal(intent.platform, c.platform);
    assert.ok(
      typeof intent.deadline_ns === "string" && /^[1-9][0-9]{0,19}$/u.test(intent.deadline_ns),
    );
    assert.ok(end <= BigInt(intent.deadline_ns), "Windows worker widened original workflow clock");
  }
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

async function completedRead<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw Object.assign(
        new Error("Completed routing data disappeared; preserve original attempt and corruption", {
          cause: error,
        }),
        { code: "EINTEGRITY" },
      );
    throw error;
  }
}
async function completedRoutingRecord(c: Context, file: string) {
  c.active();
  const marker = `${file}.complete.json`;
  const before = await readControllerToolFile(marker, 1024);
  return completedRead(async () => {
    const completion: unknown = JSON.parse(before.toString("utf8"));
    assert.ok(
      isRecord(completion) &&
        Object.keys(completion).sort().join(",") === "authority,bytes,record,schema_version,sha256",
    );
    assert.equal(completion.schema_version, 1);
    assert.equal(completion.authority, "none");
    assert.equal(completion.record, path.basename(file));
    assert.ok(
      Number.isSafeInteger(completion.bytes) &&
        Number(completion.bytes) > 0 &&
        Number(completion.bytes) <= 8192,
    );
    assert.ok(typeof completion.sha256 === "string" && /^[a-f0-9]{64}$/u.test(completion.sha256));
    const custody = inspectNativeRuntimeCustody([file]);
    const bytes = await readControllerToolFile(file, 8192);
    assert.equal(bytes.length, completion.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), completion.sha256);
    recheckNativeRuntimeCustody([file], custody);
    assert.ok(
      (await readControllerToolFile(marker, 1024)).equals(before),
      "routing completion changed during readback",
    );
    recheckNativeRuntimeCustody([file], custody);
    c.active();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    assert.ok(isRecord(value) && value.schema_version === 1 && value.authority === "none");
    return value;
  });
}

async function windowsStageDirectory(c: Context, selected: Stage, owner: Owner) {
  assert.ok(c.windows);
  const read = async (which: Stage) => {
    const route = await completedRoutingRecord(
      c,
      path.join(c.root, `windows-native-${which}-stage.json`),
    );
    assert.equal(
      Object.keys(route).sort().join(","),
      "authority,directory,owner_identity,owner_pid,platform,revision,run_attempt,run_id,schema_version,stage",
    );
    assert.equal(route.platform, c.platform);
    assert.equal(route.stage, which);
    assert.equal(route.run_id, c.scope.identity.run_id);
    assert.equal(route.run_attempt, 1);
    assert.equal(route.revision, c.scope.identity.controller_revision);
    assert.equal(route.owner_pid, owner.pid);
    assert.equal(route.owner_identity, owner.identity);
    assert.ok(typeof route.directory === "string");
    const phase = which === "pre-sign" ? "payload-signing" : "release-publication";
    assert.match(
      route.directory,
      new RegExp(`^hosted-native-parent-[A-Za-z0-9]{6}/windows-session/${phase}/capture$`, "u"),
    );
    return route.directory;
  };
  const relative = await read(selected);
  if (selected === "post-sign") {
    const previous = await read("pre-sign");
    assert.equal(
      relative.split("/").slice(0, 2).join("/"),
      previous.split("/").slice(0, 2).join("/"),
      "both Windows stages must retain the original session parent",
    );
  }
  fence(c, owner, selected === "pre-sign");
  return path.join(c.root, ...relative.split("/"));
}
function windowsStageRefusal(c: Context, directory: string) {
  if (c.windows)
    assert.equal(
      lstatSync(path.join(directory, "native-job-refusal.json"), { throwIfNoEntry: false }),
      undefined,
      "original Windows stage refused; preserve effects and recover",
    );
}

/** Claim before spawn. Existing intent, even without a PID record, cannot retry. */
export async function startHostedLinuxWorkflow() {
  return startWorkflow("linux-x86_64");
}
export async function startHostedWindowsWorkflow() {
  return startWorkflow("windows-x86_64");
}
async function startWorkflow(platform: WorkflowPlatform) {
  const c = await context("pre-sign", platform);
  const origin = process.hrtime.bigint(),
    remaining = Math.floor(c.deadline - performance.now());
  assert.ok(remaining > 0 && remaining <= 570000);
  await retain(c.intent, {
    schema_version: 1,
    binding: c.scope.binding,
    automatic_retry: false,
    authority: "none",
    ...(c.windows ? { platform, deadline_ns: String(origin + BigInt(remaining) * 1000000n) } : {}),
  });
  c.active();
  // Receive/authenticate the complete existing opaque closure before selecting
  // another executable. The shared setup-node pathname is never spawned here.
  const runtime = path.join(
    c.scope.temporary,
    c.windows ? "portcove-native-windows-workflow-runtime" : "portcove-native-workflow-runtime",
  );
  await mkdir(runtime, { mode: 0o700 });
  const receipt = await receiveControllerTools(runtime, c.scope.artifact, c.scope.bundle, {
    deadline: c.deadline,
  });
  const tools = await verifiedControllerToolPaths(receipt);
  const executable = tools.entries["release-hosted-native-worker"];
  assert.ok(executable);
  const paths = c.windows
    ? (await import("./release-controller-tools.mts")).controllerToolPlatformProfile(platform).paths
    : controllerToolPaths;
  if (c.windows) assert.equal(tools.platform, platform);
  const files = [
    ...paths.map((name) => path.join(tools.root, name)),
    path.join(tools.root, "manifest.json"),
  ];
  const custody = inspectNativeRuntimeCustody(files);
  await verifiedControllerToolPaths(receipt);
  recheckNativeRuntimeCustody(files, custody);
  c.active();
  const child = spawn(tools.node, [executable, c.windows ? "windows-run" : "run"], {
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
  recheckNativeRuntimeCustody(files, custody);
  await verifiedControllerToolPaths(receipt);
  c.active();
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
  return workflowUploadRequest(raw, "linux-x86_64");
}
export async function hostedWindowsWorkflowUploadRequest(raw: unknown) {
  return workflowUploadRequest(raw, "windows-x86_64");
}
async function workflowUploadRequest(raw: unknown, platform: WorkflowPlatform) {
  const selected = stage(raw),
    c = await context(selected, platform);
  const runner = await import("./release-hosted-native-runner.mts");
  for (;;) {
    c.active();
    refusalAbsent(c);
    try {
      // The existing producer publishes this routing marker atomically only
      // after its clock/start records are complete. Never read an in-flight
      // private record as though it were a completed, malformed claim.
      await readControllerToolFile(
        c.windows
          ? path.join(c.root, `windows-native-${selected}-stage.json.complete.json`)
          : path.join(
              c.root,
              `portcove-native-linux-${selected}`,
              "native-job-upload-request.json",
            ),
        4096,
      );
      const owner = c.windows ? await completedRead(() => original(c)) : await original(c);
      await refusal(c, selected);
      const directory = c.windows
        ? await completedRead(() => windowsStageDirectory(c, selected, owner))
        : path.join(c.root, `portcove-native-linux-${selected}`);
      windowsStageRefusal(c, directory);
      if (c.windows)
        await readControllerToolFile(path.join(directory, "native-job-upload-request.json"), 4096);
      const read = c.windows
        ? selected === "pre-sign"
          ? runner.readHostedWindowsNativeUploadRequest
          : runner.readHostedWindowsNativePostSignUploadRequest
        : selected === "pre-sign"
          ? runner.readHostedNativeUploadRequest
          : runner.readHostedNativePostSignUploadRequest;
      const request = c.windows
        ? await completedRead(() => read(directory))
        : await read(directory);
      assert.equal(
        request.name,
        `hosted-native-${selected === "pre-sign" ? "payload-signing" : "release-publication"}-${platform}-${c.scope.identity.run_id}-1`,
      );
      assert.ok(BigInt(request.deadline_ns) <= owner.end);
      const current = c.windows ? await completedRead(() => original(c)) : await original(c);
      await refusal(c, selected);
      fence(c, owner);
      fence(c, current);
      windowsStageRefusal(c, directory);
      return request;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      // Before first preparation, a missing clock/start row is not success.
      const started = await ownedJson(c.started);
      assert.equal(started.binding, c.scope.binding);
      assert.equal(
        readProcessIdentity(Number(started.pid)),
        started.identity,
        "worker exited before readiness; retain effects and recover",
      );
      refusalAbsent(c);
      c.active();
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
  return acknowledgeWorkflowUpload(raw, request, artifact, digest, "linux-x86_64");
}
export async function acknowledgeHostedWindowsWorkflowUpload(
  raw: unknown,
  request: string,
  artifact: string,
  digest: string,
) {
  return acknowledgeWorkflowUpload(raw, request, artifact, digest, "windows-x86_64");
}
async function acknowledgeWorkflowUpload(
  raw: unknown,
  request: string,
  artifact: string,
  digest: string,
  platform: WorkflowPlatform,
) {
  const selected = stage(raw),
    c = await context(selected, platform);
  const before = await original(c);
  await refusal(c, selected);
  assert.ok(/^[1-9][0-9]{0,15}$/u.test(artifact));
  const runner = await import("./release-hosted-native-runner.mts");
  const directory = c.windows
    ? await windowsStageDirectory(c, selected, before)
    : path.join(c.root, `portcove-native-linux-${selected}`);
  windowsStageRefusal(c, directory);
  const acknowledge = c.windows
    ? selected === "pre-sign"
      ? runner.acknowledgeHostedWindowsNativeUpload
      : runner.acknowledgeHostedWindowsNativePostSignUpload
    : selected === "pre-sign"
      ? runner.acknowledgeHostedNativeUpload
      : runner.acknowledgeHostedNativePostSignUpload;
  fence(c, before);
  await acknowledge(directory, request, Number(artifact), digest);
  const current = await original(c, selected === "pre-sign");
  await refusal(c, selected);
  fence(c, before, selected === "pre-sign");
  fence(c, current, selected === "pre-sign");
  windowsStageRefusal(c, directory);
  return { acknowledgement_retained: true, authority: "none" };
}
/** Wait for fixed same-run signer completion before signaling. These scheduling
 * observations cannot replace the producer's independent input authentication. */
export async function startHostedLinuxWorkflowPostSign() {
  const c = await context("post-sign");
  const before = await original(c);
  await refusal(c, "pre-sign");
  fence(c, before);
  // Keep this original worker/job alive while the separate signers finish.
  // A failed/ambiguous observation does not retry either signer or this attempt.
  const record = await open(path.join(c.root, "native-post-sign-prerequisites.jsonl"), "wx", 0o600);
  let retainedBytes = 0;
  let lastStatus: number | null = null;
  const retainObservation = async (value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    retainedBytes += bytes.length;
    assert.ok(retainedBytes <= 65536);
    await record.writeFile(bytes);
    await record.sync();
  };
  try {
    const active = () => fence(c, before);
    const api = new GitHubApiClient((args, input) => {
      active();
      const remaining = Math.min(
        c.deadline - performance.now(),
        Number(before.end - process.hrtime.bigint()) / 1e6,
      );
      assert.ok(remaining >= 1);
      return createGitHubRunner({
        cwd: repository,
        timeoutMs: Math.min(15000, Math.floor(remaining)),
        maxBuffer: 2 * 1024 ** 2,
      })([...args, "--hostname", "github.com"], input);
    });
    await waitForNativePostSignReadiness({
      run: c.scope.identity.run_id,
      revision: c.scope.identity.controller_revision,
      active,
      read: () => {
        const result = api.request(
          "GET",
          `repos/boburning/portcove/actions/runs/${c.scope.identity.run_id}/attempts/1/jobs?per_page=100`,
        );
        lastStatus = result.status ?? null;
        active();
        assert.equal(result.status, 200);
        assert.ok(
          !result.headers.get("link"),
          "native prerequisite inventory requires one complete page",
        );
        return result.body;
      },
      retain: retainObservation,
      pause: () => delay(5000),
    });
  } catch (error) {
    await retainObservation({
      outcome: "refused-or-ambiguous",
      last_http_status: lastStatus,
      recovery_required: true,
      authority: "none",
    });
    throw error;
  } finally {
    await record.close();
  }
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
    if (selected === "post-sign" && owner.live) {
      await delay(100);
      continue;
    }
    if (selected === "pre-sign") {
      // Atomic public sequencing hint only: the private settlement and original
      // live owner below still have to satisfy every independent assertion.
      try {
        const bytes = await readControllerToolFile(
          path.join(c.root, "native-pre-sign-handoff-ready.json"),
          4096,
        );
        const ready: unknown = JSON.parse(bytes.toString("utf8"));
        assert.ok(
          isRecord(ready) &&
            ready.schema_version === 1 &&
            ready.authority === "none" &&
            ready.binding === c.scope.binding,
        );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        fence(c, owner);
        await delay(100);
        continue;
      }
    }
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
/** Windows signers are awaited by the same original private runner. Public
 * stage rows only confirm its existing provider readback; final completion also
 * requires its terminal record and process death, never PID absence alone. */
export async function settleHostedWindowsWorkflowStage(raw: unknown) {
  const selected = stage(raw),
    c = await context(selected, "windows-x86_64");
  for (;;) {
    const owner = await original(c, selected === "pre-sign");
    const directory = await windowsStageDirectory(c, selected, owner);
    windowsStageRefusal(c, directory);
    try {
      const bytes = await readControllerToolFile(
        path.join(directory, "native-job-settlement.json"),
        4096,
      );
      const row: unknown = JSON.parse(bytes.toString("utf8"));
      assert.ok(isRecord(row));
      assert.equal(row.schema_version, 1);
      assert.equal(row.authority, "none");
      assert.equal(row.exit_code, 0);
      assert.equal(row.provider_bytes_match, true);
      assert.equal(row.native_acceptance, "not-established");
      if (selected === "post-sign") {
        const final = await completedRoutingRecord(
          c,
          path.join(c.root, "native-supervision-settlement.json"),
        );
        assert.equal(final.binding, c.scope.binding);
        assert.equal(final.platform, c.platform);
        assert.equal(final.exit_code, 0);
        assert.equal(final.recovery_required, false);
        assert.equal(final.phase, "complete");
        assert.equal(final.pre_sign_complete, true);
        assert.equal(final.post_sign_complete, true);
        assert.equal(final.native_acceptance, "not-established");
        assert.ok(
          typeof final.deadline_ns === "string" && /^[1-9][0-9]{0,19}$/u.test(final.deadline_ns),
        );
        assert.ok(
          BigInt(final.deadline_ns) <= owner.end &&
            process.hrtime.bigint() < BigInt(final.deadline_ns),
        );
        if (owner.live) {
          await delay(100);
          continue;
        }
      }
      const current = await original(c, selected === "pre-sign");
      windowsStageRefusal(c, directory);
      fence(c, owner, selected === "pre-sign", selected === "post-sign");
      fence(c, current, selected === "pre-sign", selected === "post-sign");
      return {
        stage: selected,
        process_settled: true,
        native_acceptance: "not-established",
        authority: "none",
      };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      assert.ok(
        owner.live,
        "Windows worker exited without matching terminal settlement; recovery required",
      );
      if (!fence(c, owner, selected === "pre-sign")) continue;
      await delay(100);
    }
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
  const rawOperation = process.argv[2],
    windows = rawOperation?.startsWith("windows-") === true,
    operation = windows ? rawOperation.slice("windows-".length) : rawOperation,
    selected = stage(process.argv[3]);
  if (operation === "start" && selected === "pre-sign" && process.argv.length === 4)
    return windows ? startHostedWindowsWorkflow() : startHostedLinuxWorkflow();
  if (!windows && operation === "start" && selected === "post-sign" && process.argv.length === 4)
    return startHostedLinuxWorkflowPostSign();
  if (operation === "request" && process.argv.length === 4) {
    const read = windows ? hostedWindowsWorkflowUploadRequest : hostedLinuxWorkflowUploadRequest;
    const result = await read(selected);
    await output({
      name: result.name,
      paths: result.files.join("\n"),
      request_sha256: result.request_sha256,
    });
    assert.deepEqual(await read(selected), result, "upload routing changed during output");
    return { ready: true, authority: "none" };
  }
  if (operation === "ack" && process.argv.length === 4)
    return (
      windows ? acknowledgeHostedWindowsWorkflowUpload : acknowledgeHostedLinuxWorkflowUpload
    )(
      selected,
      process.env.PORTCOVE_NATIVE_REQUEST_SHA256 ?? "",
      process.env.PORTCOVE_NATIVE_ARTIFACT_ID ?? "",
      process.env.PORTCOVE_NATIVE_ARTIFACT_SHA256 ?? "",
    );
  if (operation === "settle" && process.argv.length === 4)
    return windows
      ? settleHostedWindowsWorkflowStage(selected)
      : settleHostedLinuxWorkflowStage(selected);
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
