import { operationCoverage, readCoverageInput } from "./operation-coverage.mts";
import { runInNewContext as runBrowserProbe } from "node:vm";
import { isRecord } from "./runtime-values.mts";
import {
  writeAcceptancePreflight,
  completeAcceptancePacket,
  reusableAcceptanceScenarios,
  compatibleAcceptanceScenarios,
  revalidateAcceptancePacket,
  parseAcceptancePreflightContext,
} from "./acceptance-packet.mts";
import { runTypeScriptInNewContext as runInNewContext } from "./test-source.mts";
import {
  capabilityRequirement,
  captureSettledVisual,
  observePreparationCompletion,
} from "./native-readiness.mts";
import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  rm,
  readdir,
  readFile,
  utimes,
  stat,
  mkdir,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeEvidence, evidenceOutcome, fileIdentity } from "./development-evidence.mts";
import {
  retainEvidenceInput,
  verifyConsumedInputs,
  validateEvidenceStore,
  executionAdmission,
  retainedExecutableCanLaunch,
  readPrelaunchCustody,
} from "./retained-evidence.mts";

import type { TestContext } from "node:test";
import type { EvidenceOptions } from "./development-evidence.mts";
import type {
  AcceptancePreflightContext,
  AcceptanceCompletionContext,
} from "./acceptance-packet.mts";
import type { PreparationObservation } from "./native-readiness.mts";
type PreparationInput = Parameters<
  typeof observePreparationCompletion<{ readiness: { launchable: boolean } }>
>[0];
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function jsonObject(text: string): Record<string, unknown> {
  return object(JSON.parse(text));
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function deferred() {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => required(complete)() };
}

// Load through the actual native runtime before serializing. The Node-only test
// project does not import DOM implementations, and this VM has no host helpers.
function serializedBrowserProbe(name: "observeGamepadCapability" | "observeVisibleTarget"): string {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const probes = await import(process.argv[1]);
    console.log(JSON.stringify({source: probes[process.argv[2]].toString()}));
  `,
      new URL("../apps/desktop/scripts/browser-readiness.mts", import.meta.url).href,
      name,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const value: unknown = JSON.parse(child.stdout);
  assert(isRecord(value) && typeof value.source === "string");
  return value.source;
}

// Retained-store controls must live outside disposable checkout temp roots,
// including when dev-storage redirects TMP/TEMP for the test process.
async function retainedFixture(prefix: string) {
  const parent = path.join(os.homedir(), ".portcove-test-fixtures");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(parent, prefix));
}

function preparationObservation(overrides: Partial<PreparationInput> = {}): PreparationInput {
  return {
    portId: "owned-port",
    priorPreparationIds: new Set(["previous"]),
    observation: {} satisfies PreparationObservation,
    readActivities: async () => ({
      records: [{ id: "new", operation: "prepare", target_id: "owned-port", status: "succeeded" }],
    }),
    readStatus: async () => ({ readiness: { launchable: true } }),
    isReviewClosed: async () => true,
    ...overrides,
  };
}

void test("preparation polling avoids full status hydration before new terminal success", async () => {
  const input = preparationObservation({
    readActivities: async () => ({
      records: [
        { id: "previous", operation: "prepare", target_id: "owned-port", status: "succeeded" },
        { id: "other", operation: "prepare", target_id: "other-port", status: "succeeded" },
        { id: "new", operation: "prepare", target_id: "owned-port", status: "running" },
      ],
    }),
    readStatus: async () => assert.fail("No full status work during preparation"),
    isReviewClosed: async () => assert.fail("No premature UI completion observation"),
  });
  assert.equal(await observePreparationCompletion(input), false);
  assert.equal(input.observation.activity_reads, 1);
  assert.equal(input.observation.status_reads, undefined);
  assert.equal(required(input.observation.last).new_activity_count, 1);
  assert.equal(required(input.observation.last).readiness, "not-read-before-terminal");
});

void test("Core success still requires authoritative readiness and actual review closure", async () => {
  let launchable = false;
  let closed = false;
  const input = preparationObservation({
    readStatus: async () => ({ readiness: { launchable } }),
    isReviewClosed: async () => closed,
  });
  assert.equal(await observePreparationCompletion(input), false);
  assert.equal(required(input.observation.last).review_closed, "not-read-before-readiness");
  launchable = true;
  assert.equal(await observePreparationCompletion(input), false);
  assert.equal(required(input.observation.last).review_closed, false);
  closed = true;
  const actual = await observePreparationCompletion(input);
  assert.ok(actual);
  assert.equal(actual.activity.id, "new");
  assert.equal(actual.status.readiness.launchable, true);
  assert.equal(input.observation.samples, 3);
  assert.equal(input.observation.status_reads, 3);
  assert.equal(input.observation.review_reads, 2);
  assert.equal(required(input.observation.last).phase, "complete");
});

void test("preparation observation refuses duplicate new operations", async () => {
  const input = preparationObservation({
    readActivities: async () => ({
      records: ["first", "second"].map((id) => ({
        id,
        operation: "prepare",
        target_id: "owned-port",
        status: "succeeded",
      })),
    }),
  });
  await assert.rejects(observePreparationCompletion(input), /exactly one new operation/);
  assert.equal(required(input.observation.last).new_activity_count, 2);
});

void test("failed preparation reads retain bounded diagnostic phase and propagate failure", async () => {
  for (const [phase, callback] of [
    ["activity", "readActivities"],
    ["status", "readStatus"],
    ["review", "isReviewClosed"],
  ] as const) {
    const failure = new Error("owned observation failed");
    const input = preparationObservation({
      [callback]: async () => {
        throw failure;
      },
    });
    await assert.rejects(observePreparationCompletion(input), (error) => error === failure);
    assert.equal(required(input.observation.last).phase, phase);
    assert.equal(Number.isFinite(required(input.observation.last)[`${phase}_ms`]), true);
  }
});

void test("bounded evidence streams hash and retain the complete multi-buffer tail", async (t) => {
  const directory = await retainedFixture("pcv-stream-tail-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 7);
  bytes[bytes.length - 1] = 29;
  await writeFile(file, bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal((await fileIdentity(file)).sha256, expected);
  await assert.rejects(fileIdentity(file, { maxBytes: bytes.length - 1 }), /grew/u);
  const input = await retainEvidenceInput({ root: path.join(directory, "evidence"), file });
  assert.equal(input.retained.sha256, expected);
  assert.deepEqual(await readFile(input.retained.path), bytes);
  const before = await stat(file);
  bytes[bytes.length - 1] = 30;
  await writeFile(file, bytes);
  await utimes(file, before.atime, before.mtime);
  await assert.rejects(verifyConsumedInputs([input]), /changed after capture/u);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fileIdentity(file, { signal: controller.signal }), /abort/iu);
  const abortedRoot = path.join(directory, "aborted");
  await assert.rejects(
    retainEvidenceInput({ root: abortedRoot, file, signal: controller.signal }),
    /abort/iu,
  );
  assert.ok(
    (await readdir(path.join(abortedRoot, "staging"))).some((name: string) =>
      name.endsWith(".failure.json"),
    ),
  );
});

void test("bootstrap verifies late mutation after manifest preparation before importing target bytes", async (t) => {
  const directory = await retainedFixture("pcv-bootstrap-guard-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  const input = await retainEvidenceInput({ root: path.join(directory, "retained"), file });
  const source = await readFile(new URL("./desktop-test-cli.mts", import.meta.url), "utf8");
  const start = source.indexOf("for (const input of inputs.filter");
  const target = 'await import("../apps/desktop/scripts/desktop-test.mts");';
  const end = source.indexOf(target, start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end + target.length).replace(target, "await importTarget();");
  let imported = false;
  const before = await stat(file);
  await assert.rejects(
    async () =>
      await runInNewContext(`(async()=>{${block}})()`, {
        assert,
        inputs: [{ ...input, role: "app", kind: "executable" }],
        values: { app: file },
        captureOutput: directory,
        revision: "a".repeat(40),
        root: directory,
        selection: { selected_scenarios: ["test"] },
        retainedMetadata: false,
        executionStarted: new Date(),
        captureSignal: AbortSignal.timeout(10_000),
        lock: { owner: { token: "fixture-only" } },
        process: { argv: ["node", "runner"], env: {} },
        path,
        writeFile: async (...args: Parameters<typeof writeFile>) => {
          await writeFile(...args);
          await writeFile(file, "modified");
          await utimes(file, before.atime, before.mtime);
        },
        verifyConsumedInputs,
        importTarget: () => {
          imported = true;
        },
      }),
    /changed after capture/u,
  );
  assert.equal(imported, false);
  assert.ok((await stat(path.join(directory, "prelaunch.json"))).isFile());
});

void test("prelaunch custody accepts native equivalent absolute path separators", async (t) => {
  const directory = await retainedFixture("pcv-prelaunch-path-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "product");
  await writeFile(file, "product bytes");
  const captured = await retainEvidenceInput({ root: path.join(directory, "evidence"), file });
  const manifest = path.join(directory, "manifest.json");
  const timestamp = new Date().toISOString();
  await writeFile(
    manifest,
    JSON.stringify({
      format_version: 1,
      root: directory,
      revision: "a".repeat(40),
      pre_import_for: "apps/desktop/scripts/desktop-test.mts",
      selected_scenarios: [],
      execution_started_at: timestamp,
      created_at: timestamp,
      inputs: [{ ...captured, role: "app", kind: "executable" }],
    }),
  );
  await readPrelaunchCustody(manifest, {
    root: directory,
    revision: "a".repeat(40),
    plan: { receiptInputs: [{ kind: "executable", name: "app" }] },
    values: { app: file.replaceAll("\\", "/") },
    selectedScenarios: [],
    deadlineMs: 60_000,
  });
});

void test("retention rejects absent and untagged cleanup roots before creating them", async (t) => {
  const directory = await retainedFixture("pcv-cleanup-boundary-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const suffix of [
    "target/evidence",
    "target/debug/incremental/evidence",
    "node_modules/evidence",
  ]) {
    const candidate = path.join(directory, suffix);
    await assert.rejects(validateEvidenceStore(candidate), /cleanup roots/u);
    await assert.rejects(stat(candidate), { code: "ENOENT" });
    await mkdir(candidate, { recursive: true });
    await assert.rejects(validateEvidenceStore(candidate), /cleanup roots/u);
  }
});

void test("matching product metadata cannot authorize relocation of a path-sensitive executable", () => {
  const drivers = { driver: "/trusted/tauri-driver", nativeDriver: "/trusted/native-driver" };
  for (const role of ["app", "preparation-cli", "preparation-tool"]) {
    assert.equal(
      retainedExecutableCanLaunch(
        {
          role,
          path: "/unrelated/product",
          // @ts-expect-error Extra product metadata must not confer executable relocation authority.
          verification_build: { compiled_source_revision: "a".repeat(40) },
          source_state: { clean: true },
        },
        drivers,
      ),
      false,
    );
  }
  assert.equal(
    retainedExecutableCanLaunch({ role: "driver", path: drivers.driver }, drivers),
    true,
  );
  assert.equal(
    retainedExecutableCanLaunch({ role: "driver", path: "/unrelated/driver" }, drivers),
    false,
  );
});

void test("capture/read/verification expiry refuses every later launch", async () => {
  let launches = 0;
  for (const elapsed of [100, 101]) {
    const admission = executionAdmission(new Date(0).toISOString(), 100, () => elapsed);
    await assert.rejects(async () => {
      await admission.verify([]);
      admission.assertReady();
      launches++;
    }, /deadline/u);
  }
  let clock = 0;
  const admission = executionAdmission(new Date(0).toISOString(), 100, () => clock);
  const verification = admission.verify([]);
  clock = 100;
  await assert.rejects(verification, /deadline/u);
  assert.throws(() => {
    admission.assertReady();
    launches++;
  }, /deadline/u);
  assert.equal(launches, 0);
});

void test("retained input is published without overwrite, deduplicated and bound before consumption", async (t) => {
  const directory = await retainedFixture("pcv-retained-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  const root = path.join(directory, "evidence");
  await writeFile(file, "original");
  const copies = await Promise.all([
    retainEvidenceInput({ root, file }),
    retainEvidenceInput({ root, file }),
  ]);
  assert.equal(copies[0].retained.path, copies[1].retained.path);
  assert.equal(copies.filter((input) => input.deduplicated).length, 1);
  await verifyConsumedInputs(copies);
  const metadata = await stat(file);
  await writeFile(file, "modified");
  await utimes(file, metadata.atime, metadata.mtime);
  assert.equal((await stat(file)).size, metadata.size);
  assert.equal((await stat(file)).mtime.getTime(), metadata.mtime.getTime());
  await assert.rejects(verifyConsumedInputs(copies), /changed after capture/);
  await verifyConsumedInputs(copies, { livePaths: false });
});

void test("a retained executable is actually consumed through its retained path", async (t) => {
  const directory = await retainedFixture("pcv-retained-launch-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captured = await retainEvidenceInput({
    root: path.join(directory, "evidence"),
    file: process.execPath,
    executable: true,
  });
  await verifyConsumedInputs([captured]);
  const child = spawnSync(
    captured.retained.path,
    ["-e", "process.stdout.write(process.execPath)"],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(path.resolve(child.stdout).toLowerCase(), captured.retained.path.toLowerCase());
  await verifyConsumedInputs([captured]);
});

void test("corrupt published evidence and interrupted publication preserve partial failures", async (t) => {
  const directory = await retainedFixture("pcv-retained-failure-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  const root = path.join(directory, "evidence");
  await writeFile(file, "original");
  const captured = await retainEvidenceInput({ root, file });
  await chmod(captured.retained.path, 0o600);
  await writeFile(captured.retained.path, "modified");
  await assert.rejects(retainEvidenceInput({ root, file }), /corrupt; refusing overwrite/);
  assert.equal(await readFile(captured.retained.path, "utf8"), "modified");
  assert.equal(await readFile(file, "utf8"), "original");
  await assert.rejects(
    retainEvidenceInput({
      root: path.join(directory, "interrupted"),
      file,
      beforePublish: async () => {
        throw new Error("interrupted before publication");
      },
    }),
    /interrupted before publication/,
  );
  const partials = await readdir(path.join(directory, "interrupted/staging"));
  assert(partials.some((name: string) => name.endsWith(".partial")));
  assert(partials.some((name: string) => name.endsWith(".failure.json")));
});

void test("deduplication never republishes a discarded copy after published custody changes", async (t) => {
  const directory = await retainedFixture("pcv-dedup-race-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  for (const mutation of ["remove", "corrupt"]) {
    const root = path.join(directory, mutation);
    const captured = await retainEvidenceInput({ root, file });
    await assert.rejects(
      retainEvidenceInput({
        root,
        file,
        beforePublish: async ({ published }) => {
          assert.equal(published, captured.retained.path);
          if (mutation === "remove") await rm(published);
          else {
            await chmod(published, 0o600);
            await writeFile(published, "modified");
          }
        },
      }),
      /ENOENT|corrupt; refusing overwrite/,
    );
    if (mutation === "remove") await assert.rejects(stat(captured.retained.path), /ENOENT/);
    else assert.equal(await readFile(captured.retained.path, "utf8"), "modified");
    const partials = await readdir(path.join(root, "staging"));
    assert(partials.some((name: string) => name.endsWith(".partial")));
    assert(partials.some((name: string) => name.endsWith(".failure.json")));
  }
});

void test("retained evidence refuses disposable ancestry and unavailable capacity", async (t) => {
  const directory = await retainedFixture("pcv-retained-capacity-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  await assert.rejects(
    retainEvidenceInput({
      root: path.join(directory, "evidence"),
      file,
      capacity: async () => ({ bavail: 0, bsize: 4096 }),
    }),
    /capacity/,
  );
  const cache = path.join(directory, "cache");
  await mkdir(cache);
  await writeFile(path.join(cache, "CACHEDIR.TAG"), "disposable");
  await assert.rejects(validateEvidenceStore(path.join(cache, "nested")), /disposable/);
});

void test("cancellation joins the blocked publication worker and preserves staging without publication", async (t) => {
  const directory = await retainedFixture("pcv-retained-cancel-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  const controller = new AbortController();
  const { promise: reached, resolve: entered } = deferred();
  const { promise: blocked, resolve: release } = deferred();
  let finished = false;
  let partial: string | undefined, published: string | undefined;
  const operation = retainEvidenceInput({
    root: path.join(directory, "evidence"),
    file,
    signal: controller.signal,
    beforePublish: async (state) => {
      partial = state.partial;
      published = state.published;
      entered();
      await blocked;
    },
  });
  const rejected = assert.rejects(operation, /abort|cancel/iu).finally(() => {
    finished = true;
  });
  await reached;
  controller.abort(new Error("cancel requested"));
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(await readFile(required(partial), "utf8"), "original");
  release();
  await rejected;
  await assert.rejects(stat(required(published)), { code: "ENOENT" });
  assert.equal(await readFile(required(partial), "utf8"), "original");
});

void test("late cancellation preserves already admitted evidence publication", async (t) => {
  const directory = await retainedFixture("pcv-retained-late-cancel-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  const controller = new AbortController();
  const captured = await retainEvidenceInput({
    root: path.join(directory, "evidence"),
    file,
    signal: controller.signal,
    afterPublish: async () => {
      controller.abort(new Error("late cancellation"));
    },
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(await readFile(captured.retained.path, "utf8"), "original");
  await verifyConsumedInputs([captured]);
});

void test("partial and failed evidence cannot become a pass", () => {
  assert.equal(evidenceOutcome([]), "not-run");
  assert.equal(
    evidenceOutcome([
      { scenario: "a", outcome: "passed" },
      { scenario: "b", outcome: "not-run" },
    ]),
    "incomplete",
  );
  assert.equal(evidenceOutcome([{ scenario: "a", outcome: "failed" }]), "failed");
  assert.throws(() =>
    evidenceOutcome([
      // @ts-expect-error Keep the malformed runtime outcome rejection test.
      { scenario: "a", outcome: "maybe" },
    ]),
  );
});

void test("a vanished executable can retain its initial identity and failure evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-evidence-"));
  try {
    const executable = path.join(directory, "fixture");
    await writeFile(executable, "abc");
    const capturedExecutable = await fileIdentity(executable);
    await rm(executable);
    const report = await writeEvidence(directory, {
      revision: "a".repeat(40),
      executable,
      capturedExecutable,
      checks: [{ scenario: "executable-identity", outcome: "failed" }],
      method: "isolated-fixture",
    });
    assert.equal(report.format_version, 2);
    assert.equal(report.outcome, "failed");
    assert.deepEqual(report.executable, capturedExecutable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("version two evidence separates selected scenarios, setup, gaps, and phases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-evidence-"));
  try {
    const executable = path.join(directory, "fixture");
    await writeFile(executable, "abc");
    const report = await writeEvidence(directory, {
      revision: "b".repeat(40),
      executable,
      checks: [{ scenario: "selected", outcome: "passed" }],
      setupChecks: [{ scenario: "setup", outcome: "passed" }],
      method: "native-desktop-focused",
      context: {
        selected_scenarios: ["selected"],
        setup_scenarios: ["setup"],
        excluded_scenarios: ["other"],
        known_gaps: [{ scenario: "gap", reason: "fixture absent" }],
        phases: [{ phase: "build", duration_ms: 12, status: 0 }],
        harness_deadline_ms: 180_000,
        source_state: { revision: "b".repeat(40), clean: true },
      },
    });
    assert.equal(report.outcome, "passed");
    assert.equal(report.qualification_complete, false);
    assert.deepEqual(report.setup_checks, [{ scenario: "setup", outcome: "passed" }]);
    assert.deepEqual(report.selected_scenarios, ["selected"]);
    assert.deepEqual(report.excluded_scenarios, ["other"]);
    assert.equal(object(required(report.phases[0])).phase, "build");
    assert.equal(report.harness_deadline_ms, 180_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test("evidence hashes bytes and never replaces prior observations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-evidence-"));
  try {
    const executable = path.join(directory, "fixture");
    await writeFile(executable, "abc");
    const input: EvidenceOptions = {
      revision: "a".repeat(40),
      executable,
      checks: [{ scenario: "fixture", outcome: "passed" }],
      method: "isolated-fixture",
    };
    const report = await writeEvidence(directory, input);
    assert.equal(
      report.executable.sha256,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await assert.rejects(writeEvidence(directory, input), { code: "EEXIST" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("native capability distinguishes API absence, restriction, exposed absence and scoped observations", () => {
  const observe = (navigator: unknown) =>
    object(
      runBrowserProbe(`(${serializedBrowserProbe("observeGamepadCapability")})()`, { navigator }),
    );
  assert.equal(observe({}).outcome, "api-absent");
  assert.equal(
    observe({
      get getGamepads() {
        throw Error("restricted lookup");
      },
    }).outcome,
    "api-access-failed-or-restricted",
  );
  assert.equal(
    observe({
      getGamepads: () => {
        throw Error("restricted");
      },
    }).outcome,
    "api-access-failed-or-restricted",
  );
  assert.equal(observe({ getGamepads: () => [null] }).outcome, "no-exposed-device");
  assert.equal(observe({ getGamepads: () => [{}] }).outcome, "devices-exposed");
  assert.equal(
    capabilityRequirement({ outcome: "api-absent" }, "declared-api-fallback").outcome,
    "passed",
  );
  assert.equal(
    capabilityRequirement({ outcome: "api-absent" }, "injected-controller").outcome,
    "unsupported",
  );
  assert.equal(
    capabilityRequirement({ outcome: "devices-exposed" }, "physical-controller").outcome,
    "unsupported",
  );
});

void test("serialized visual target observation rejects absent, loading and offscreen targets", () => {
  const observe = (rect: unknown, loading = 0) =>
    object(
      runBrowserProbe(`(${serializedBrowserProbe("observeVisibleTarget")})("#target")`, {
        document: {
          readyState: "complete",
          querySelectorAll: (selector: string) =>
            selector === "#target"
              ? rect
                ? [{ getBoundingClientRect: () => rect, closest: () => null }]
                : []
              : Array.from({ length: loading }, () => ({})),
        },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        innerWidth: 800,
        innerHeight: 600,
        devicePixelRatio: 1,
      }),
    );
  assert.equal(observe(null).visible, false);
  assert.equal(
    observe({ x: 900, y: 0, left: 900, top: 0, right: 950, bottom: 20, width: 50, height: 20 })
      .visible,
    false,
  );
  assert.equal(
    object(
      observe({ x: 0, y: 0, left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20 }, 1)
        .application_state,
    ).loading,
    1,
  );
});

void test("settled visual binds retained image to semantic state and preserves negative diagnostics", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-settled-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = {
    visible: true,
    viewport: { width: 800, height: 600 },
    application_state: { document_ready: "complete", loading: 0 },
    target: "#review",
  };
  const browser = {
    executeScript: async () => structuredClone(state),
    takeScreenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
  };
  // Successful publication performs real filesystem writes. Keep short deadlines
  // only for the controls that explicitly exercise expiry.
  const run = (
    name: string,
    readiness: () => Promise<{ ready: boolean; phase?: string }> = async () => ({
      ready: true,
      phase: "review",
    }),
    timeoutMs = 5000,
  ) =>
    captureSettledVisual({
      browser,
      observeTarget: () => browser.executeScript(),
      output: directory,
      name,
      scenario: "owned-review",
      target: "#review",
      readiness,
      timeoutMs,
    });
  const captured = await run("positive");
  assert.deepEqual(await fileIdentity(captured.image.path), captured.image);
  assert.equal(jsonObject(await readFile(captured.receipt, "utf8")).scenario, "owned-review");
  await assert.rejects(
    run("loading", async () => ({ ready: false }), 30),
    /timed out/u,
  );
  state.visible = false;
  await assert.rejects(run("offscreen", undefined, 30), /timed out/u);
  state.visible = true;
  browser.takeScreenshot = async () => {
    throw Error("screen failure");
  };
  await assert.rejects(run("failed"), /screen failure/u);
  browser.takeScreenshot = async () => {
    state.application_state.loading = 1;
    return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  };
  await assert.rejects(run("changed"), /changed during capture/u);
  for (const name of ["loading", "offscreen", "failed", "changed"]) {
    assert.equal(
      jsonObject(await readFile(path.join(directory, `${name}-capture-failure.json`), "utf8"))
        .acceptance,
      false,
    );
    await assert.rejects(stat(path.join(directory, `${name}-capture.json`)), { code: "ENOENT" });
  }
});

void test("settled capture waits for the actual target geometry without accepting a moving target", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-capture-layout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let observations = 0,
    screenshots = 0;
  const browser = {
    executeScript: async () => ({
      visible: true,
      viewport: { width: 960, height: 640 },
      application_state: { document_ready: "complete", loading: 0 },
      rect: { height: [436, 410, 383][Math.min(observations++, 2)] },
    }),
    takeScreenshot: async () => {
      assert.ok(observations >= 4, "Do not photograph transitional geometry");
      screenshots++;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    },
  };
  const options = {
    browser,
    observeTarget: () => browser.executeScript(),
    output: directory,
    scenario: "owned-return",
    target: "#queue",
    readiness: async () => ({ ready: true, phase: "returned" }),
    timeoutMs: 1000,
  };
  const result = await captureSettledVisual({ ...options, name: "settled" });
  assert.equal(result.observation.state.rect.height, 383);
  assert.equal(screenshots, 1);
  browser.executeScript = async () => ({
    visible: true,
    viewport: { width: 960, height: 640 },
    application_state: { document_ready: "complete", loading: 0 },
    rect: { height: observations++ },
  });
  await assert.rejects(
    captureSettledVisual({ ...options, name: "moving", timeoutMs: 150 }),
    /timed out/u,
  );
  assert.equal(screenshots, 1, "A moving target never produces an acceptance candidate");
  assert.equal(
    jsonObject(await readFile(path.join(directory, "moving-capture-failure.json"), "utf8"))
      .acceptance,
    false,
  );
});

void test("timed-out capture joins the blocked filesystem worker without publishing a completed receipt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-capture-join-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { promise: entered, resolve: enter } = deferred();
  const { promise: blocked, resolve: release } = deferred();
  const { promise: cancellation, resolve: aborted } = deferred();
  let settled = false;
  const browser = {
    executeScript: async () => ({
      visible: true,
      viewport: { width: 800, height: 600 },
      application_state: { document_ready: "complete", loading: 0 },
    }),
    takeScreenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
  };
  const operation = captureSettledVisual({
    browser,
    output: directory,
    observeTarget: async () => ({
      visible: true,
      viewport: { width: 800, height: 600 },
      application_state: { document_ready: "complete", loading: 0 },
    }),
    name: "blocked",
    scenario: "owned-review",
    target: "#review",
    readiness: async () => ({ ready: true }),
    timeoutMs: 1000,
    write: async (file: string, bytes, options) => {
      if (file.endsWith(".partial")) {
        options.signal.addEventListener("abort", () => aborted(), { once: true });
        enter();
        await blocked;
      }
      // Deliberately uncancellable worker: its eventual bytes must stay partial.
      await writeFile(file, bytes, { flag: "wx" });
    },
  });
  const rejection = assert.rejects(operation, /timed out/u).finally(() => {
    settled = true;
  });
  await entered;
  await cancellation;
  assert.equal(settled, false);
  await assert.rejects(stat(path.join(directory, "blocked-capture-failure.json")), {
    code: "ENOENT",
  });
  release();
  await rejection;
  await assert.rejects(stat(path.join(directory, "blocked-capture.json")), { code: "ENOENT" });
  assert.equal(
    jsonObject(await readFile(path.join(directory, "blocked-capture-failure.json"), "utf8"))
      .acceptance,
    false,
  );
  assert.equal(
    jsonObject(await readFile(path.join(directory, "blocked-capture.partial"), "utf8")).outcome,
    "captured",
  );
});

async function packetFixture(
  t: TestContext,
  scenario = "review",
  operation?: Record<string, unknown>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-packet-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await mkdir(source);
  const product = path.join(directory, "product");
  await writeFile(product, "product");
  const identity = await fileIdentity(product);
  const head = "a".repeat(40),
    target = "b".repeat(40),
    tree = "c".repeat(40);
  const bindings: AcceptancePreflightContext["bindings"] = {
    source_head: head,
    current_target: target,
    composed_tree: tree,
    build_inputs: { build_input_fingerprint: "d".repeat(64), inventory_complete: false },
    product_artifacts: [{ ...identity, role: "app" }],
    harness_inputs: [{ ...identity, role: "harness-fixture" }],
    execution_qualification: {
      runtime_conditions: {
        platform: operation?.platform ?? "fixture",
        display: "virtual",
        ...(operation ? { observation_kind: operation.evidence_kind } : {}),
      },
      fixture_identities: [],
      initial_state: { isolated: true, ...(operation ? { offered_operation: operation } : {}) },
      requirements: [{ id: "finite-fixture", required_scenarios: [scenario] }],
      scenarios: [scenario],
      acceptance_criteria: [
        { id: "readable-review", scenarios: [scenario], required_images: ["review.png"] },
      ],
    },
  };
  const source_review = {
    reviewer: "separate-fixture-source-reviewer",
    reference: "isolated fixture source record",
    source_head: head,
    outcome: "passed",
  };
  const create = (name: string, extra: Partial<AcceptancePreflightContext> = {}) =>
    writeAcceptancePreflight(path.join(directory, name), {
      root: source,
      bindings,
      prerequisites: [],
      known_gaps: [],
      source_review,
      author: "fixture-author",
      ...extra,
    });
  const preflight = await create("first");
  const image = path.join(directory, "review.png");
  await writeFile(image, "isolated image identity fixture; no native inspection claim");
  const imageIdentity = await fileIdentity(image);
  const capture = path.join(directory, "review-capture.json");
  await writeFile(
    capture,
    JSON.stringify({
      outcome: "captured",
      scenario: scenario,
      image: imageIdentity,
      observation: {
        semantic: { ready: true },
        state: { visible: true, application_state: { loading: 0 } },
      },
    }),
  );
  const closure = path.join(directory, "closure.json");
  const nonce = "12345678-1234-1234-1234-123456789abc";
  await writeFile(
    closure,
    JSON.stringify({
      method: "private-pid-namespace-init-normal-unshare-join",
      nonce,
      quiesced: true,
      exit: { code: 0, signal: null, observed_at: new Date().toISOString() },
      ready: { kind: "namespace-ready", pid: 1 },
      events: [{ kind: "driver-started", nonce, pid: 2 }],
      unshare_sha256: "1".repeat(64),
      init_sha256: "2".repeat(64),
      node_sha256: "3".repeat(64),
    }),
  );
  const artifacts = await Promise.all([image, capture, closure].map((file) => fileIdentity(file)));
  const evidenceFile = path.join(directory, "evidence.json");
  await writeFile(
    evidenceFile,
    JSON.stringify({
      format_version: 3,
      captured_at: new Date().toISOString(),
      revision: head,
      outcome: "passed",
      selected_scenarios: [scenario],
      setup_checks: [{ scenario: "setup", outcome: "passed" }],
      acceptance_preflight: preflight.identity,
      execution_binding: {
        product_artifacts: bindings.product_artifacts,
        harness_inputs: bindings.harness_inputs,
        build_inputs: bindings.build_inputs,
        execution_qualification: bindings.execution_qualification,
      },
      checks: [{ scenario: scenario, outcome: "passed" }],
      artifacts,
    }),
  );
  const completion: AcceptanceCompletionContext = {
    evidence_identity: await fileIdentity(evidenceFile),
    outcomes: [{ scenario: scenario, outcome: "passed" }],
    retained_artifacts: artifacts,
    process_closure: {
      outcome: "passed",
      positive_exit: true,
      artifacts: [required(artifacts[2])],
    },
    image_inspections: [
      {
        ...imageIdentity,
        reviewer: "fixture-inspector",
        inspected_at: new Date().toISOString(),
        findings: "identity fixture only, no native/human qualification",
      },
    ],
    outcome_review: {
      reviewer: "separate-fixture-outcome-reviewer",
      reference: "isolated fixture record",
      source_head: head,
      outcome: "passed",
    },
    final_delivery: {
      source_head: head,
      current_target: target,
      composed_tree: tree,
      review_reference: "isolated fixture delivery record",
    },
  };
  const rebindEvidence = async (
    nextPreflight: Awaited<ReturnType<typeof writeAcceptancePreflight>>,
    changes: Record<string, unknown> = {},
  ) => {
    const receipt = jsonObject(await readFile(evidenceFile, "utf8"));
    Object.assign(receipt, { acceptance_preflight: nextPreflight.identity }, changes);
    await writeFile(evidenceFile, JSON.stringify(receipt));
    return { ...completion, evidence_identity: await fileIdentity(evidenceFile) };
  };
  return {
    directory,
    source,
    bindings,
    source_review,
    preflight,
    create,
    completion,
    rebindEvidence,
  };
}

void test("preflight rejects malformed known criterion IDs before publication", async (t) => {
  const fixture = await packetFixture(t);
  for (const id of [42, null, { id: "nested" }]) {
    const bindings = structuredClone(fixture.bindings);
    // Deliberately corrupt this typed fixture at the external-data boundary.
    Reflect.set(required(bindings.execution_qualification.acceptance_criteria[0]), "id", id);
    const context = {
      root: fixture.source,
      bindings,
      prerequisites: [],
      source_review: fixture.source_review,
      author: "fixture-author",
    };
    assert.throws(() => parseAcceptancePreflightContext(context), /qualification dependencies/u);
    await assert.rejects(
      writeAcceptancePreflight(path.join(fixture.directory, "malformed-criterion"), context),
      /qualification dependencies/u,
    );
    await assert.rejects(stat(path.join(fixture.directory, "malformed-criterion")), {
      code: "ENOENT",
    });
  }
});

void test("preflight freezes prospective bindings without requiring final screenshots or a completed placeholder", async (t) => {
  const fixture = await packetFixture(t);
  assert.equal(fixture.preflight.packet.stage, "preflight");
  await assert.rejects(stat(path.join(fixture.directory, "first/completed.json")), {
    code: "ENOENT",
  });
  await assert.rejects(
    writeAcceptancePreflight(path.join(fixture.source, "packet"), {
      root: fixture.source,
      bindings: fixture.bindings,
      prerequisites: [],
      known_gaps: [],
      source_review: fixture.source_review,
      author: "fixture",
    }),
    /outside/u,
  );
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, {
      ...fixture.completion,
      image_inspections: [],
    }),
    /actual inspection/u,
  );
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, {
      ...fixture.completion,
      image_inspections: [
        { ...required(fixture.completion.image_inspections[0]), sha256: "f".repeat(64) },
      ],
    }),
    /exact retained image/u,
  );
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, {
      ...fixture.completion,
      outcome_review: { ...fixture.completion.outcome_review, reviewer: "fixture-author" },
    }),
    /Independent/u,
  );
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, {
      ...fixture.completion,
      final_delivery: { ...fixture.completion.final_delivery, source_head: "e".repeat(40) },
    }),
    /binding\/source/u,
  );
  const completed = await completeAcceptancePacket(fixture.preflight.identity, fixture.completion);
  assert.equal(completed.packet.stage, "completed");
  assert.equal(completed.packet.qualification_complete, true);
  assert.equal(completed.packet.interpretation.includes("no acceptance"), true);
  await assert.rejects(completeAcceptancePacket(fixture.preflight.identity, fixture.completion), {
    code: "EEXIST",
  });
});

void test("changed retained image, placeholder source review and unreviewed composition cannot complete", async (t) => {
  const fixture = await packetFixture(t);
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, {
      ...fixture.completion,
      final_delivery: { ...fixture.completion.final_delivery, current_target: "f".repeat(40) },
    }),
    /reviewed qualification/u,
  );
  const placeholder = await fixture.create("placeholder", {
    source_review: { outcome: "not-run" },
  });
  await assert.rejects(
    completeAcceptancePacket(placeholder.identity, fixture.completion),
    /placeholder source review/u,
  );
  await writeFile(required(fixture.completion.image_inspections[0]).path, "mutated image");
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, fixture.completion),
    /artifact bytes changed/u,
  );
});

void test("reuse keeps source provenance separate and conservatively invalidates effective observations", async (t) => {
  const fixture = await packetFixture(t);
  const previous = (await completeAcceptancePacket(fixture.preflight.identity, fixture.completion))
    .packet;
  const next = structuredClone(fixture.preflight.packet);
  next.bindings.source_head = "e".repeat(40);
  assert.deepEqual(
    reusableAcceptanceScenarios(previous, next).reusable,
    ["review"],
    "documentation-only source change can retain bound observations",
  );
  const mutations: ((value: typeof next) => unknown)[] = [
    (value) => (required(value.bindings.product_artifacts[0]).sha256 = "f".repeat(64)),
    (value) => (value.harness_identity = "f".repeat(64)),
    (value) => (required(value.bindings.harness_inputs[0]).sha256 = "f".repeat(64)),
    (value) => (value.bindings.execution_qualification.runtime_conditions.display = "physical"),
    (value) => (value.bindings.execution_qualification.initial_state.isolated = false),
    (value) =>
      (value.bindings.execution_qualification.fixture_identities = [
        { ...required(fixture.bindings.product_artifacts[0]), role: "new-fixture" },
      ]),
    (value) =>
      (required(value.bindings.execution_qualification.acceptance_criteria[0]).id =
        "changed-criteria"),
    (value) =>
      (required(value.bindings.execution_qualification.requirements[0]).id = "changed-requirement"),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(next);
    mutate(changed);
    assert.deepEqual(reusableAcceptanceScenarios(previous, changed).rerun, ["review"]);
  }
  assert.deepEqual(reusableAcceptanceScenarios({}, next).rerun, ["review"]);
});

void test("bound prior completed evidence may be reused without backdating original execution", async (t) => {
  const fixture = await packetFixture(t);
  const previous = await completeAcceptancePacket(fixture.preflight.identity, fixture.completion);
  const head = "e".repeat(40);
  const next = await fixture.create("reused", {
    bindings: { ...fixture.bindings, source_head: head },
    source_review: { ...fixture.source_review, source_head: head },
    reusable_evidence: [
      { evidence: fixture.completion.evidence_identity, packet: previous.identity },
    ],
  });
  const completion = {
    ...fixture.completion,
    outcome_review: { ...fixture.completion.outcome_review, source_head: head },
    final_delivery: { ...fixture.completion.final_delivery, source_head: head },
  };
  const complete = await completeAcceptancePacket(next.identity, completion);
  assert.equal(complete.packet.qualification_complete, true);
  assert.equal(complete.packet.execution_observation_source_head, fixture.bindings.source_head);
  assert.equal(complete.packet.bindings.source_head, head);
  const ambiguous = await fixture.create("ambiguous", {
    bindings: { ...fixture.bindings, source_head: head },
    source_review: { ...fixture.source_review, source_head: head },
  });
  await assert.rejects(
    completeAcceptancePacket(ambiguous.identity, completion),
    /bound reusable evidence/u,
  );
});

void test("completed packets refuse malformed declared fields even with unchanged composition", async (t) => {
  const fixture = await packetFixture(t);
  const mutations: ((context: AcceptanceCompletionContext) => void)[] = [
    (context) => {
      Reflect.set(context.final_delivery, "review_reference", { reference: "opaque" });
    },
    (context) => {
      Reflect.set(context.process_closure, "positive_exit", "true");
    },
    (context) => {
      context.composition_decision = {
        reviewer: "reviewer",
        evidence: "proof",
        outcome: "unchanged-effective-dependencies",
      };
      Reflect.set(context.composition_decision, "reviewer", {});
    },
    (context) => {
      context.composition_decision = {
        reviewer: "reviewer",
        evidence: "proof",
        outcome: "unchanged-effective-dependencies",
      };
      Reflect.set(context.composition_decision, "outcome", "unreviewed");
    },
  ];
  for (const mutate of mutations) {
    const completion = structuredClone(fixture.completion);
    mutate(completion);
    await assert.rejects(completeAcceptancePacket(fixture.preflight.identity, completion));
    await assert.rejects(stat(path.join(fixture.directory, "first", "completed.json")), {
      code: "ENOENT",
    });
  }
});

void test("reuse requires boolean qualification proof from the retained prior packet", async (t) => {
  const fixture = await packetFixture(t);
  const previous = await completeAcceptancePacket(fixture.preflight.identity, fixture.completion);
  const prior = jsonObject(await readFile(previous.identity.path, "utf8"));
  prior.qualification_complete = "true";
  await writeFile(previous.identity.path, JSON.stringify(prior));
  const head = "e".repeat(40);
  const next = await fixture.create("invalid-prior-proof", {
    bindings: { ...fixture.bindings, source_head: head },
    source_review: { ...fixture.source_review, source_head: head },
    reusable_evidence: [
      {
        evidence: fixture.completion.evidence_identity,
        packet: await fileIdentity(previous.identity.path),
      },
    ],
  });
  await assert.rejects(
    completeAcceptancePacket(next.identity, {
      ...fixture.completion,
      outcome_review: { ...fixture.completion.outcome_review, source_head: head },
      final_delivery: { ...fixture.completion.final_delivery, source_head: head },
    }),
    /Effective dependencies require requalification/u,
  );
  await assert.rejects(
    stat(path.join(fixture.directory, "invalid-prior-proof", "completed.json")),
    { code: "ENOENT" },
  );
});

void test("required gaps and distinct failed/skipped/unsupported outcomes do not waive acceptance", async (t) => {
  const fixture = await packetFixture(t);
  const gap = await fixture.create("gap", {
    known_gaps: [{ id: "required-closure-gap", required: true }],
  });
  assert.equal(
    (await completeAcceptancePacket(gap.identity, await fixture.rebindEvidence(gap))).packet
      .qualification_complete,
    false,
  );
  for (const outcome of ["failed", "skipped", "unsupported"] as const) {
    const preflight = await fixture.create(outcome);
    const completion = await fixture.rebindEvidence(preflight, {
      outcome,
      checks: [{ scenario: "review", outcome }],
    });
    const completed = await completeAcceptancePacket(preflight.identity, {
      ...completion,
      outcomes: [{ scenario: "review", outcome }],
    });
    assert.equal(required(completed.packet.outcomes[0]).outcome, outcome);
    assert.equal(completed.packet.qualification_complete, false);
  }
});

void test("same-head completion refuses unbound or changed execution dependencies", async (t) => {
  const fixture = await packetFixture(t);
  const original = jsonObject(await readFile(fixture.completion.evidence_identity.path, "utf8"));
  const mutations: ((value: Record<string, unknown>) => unknown)[] = [
    (value) => delete value.acceptance_preflight,
    (value) => delete value.execution_binding,
    (value) =>
      (object(array(object(value.execution_binding).product_artifacts)[0]).sha256 = "e".repeat(64)),
    (value) =>
      (object(array(object(value.execution_binding).harness_inputs)[0]).sha256 = "e".repeat(64)),
    (value) =>
      (object(object(value.execution_binding).build_inputs).build_input_fingerprint = "e".repeat(
        64,
      )),
    (value) =>
      (object(
        object(object(value.execution_binding).execution_qualification).runtime_conditions,
      ).display = "other"),
    (value) =>
      array(
        object(object(value.execution_binding).execution_qualification).fixture_identities,
      ).push({
        ...required(fixture.bindings.product_artifacts[0]),
        role: "different-fixture",
      }),
  ];
  for (const mutate of mutations) {
    const receipt = structuredClone(original);
    mutate(receipt);
    await writeFile(fixture.completion.evidence_identity.path, JSON.stringify(receipt));
    await assert.rejects(
      completeAcceptancePacket(fixture.preflight.identity, {
        ...fixture.completion,
        evidence_identity: await fileIdentity(fixture.completion.evidence_identity.path),
      }),
      /Canonical execution/u,
    );
  }
  const completion = await fixture.rebindEvidence(fixture.preflight, {
    ...original,
    setup_checks: [{ scenario: "mandatory-setup", outcome: "failed" }],
  });
  assert.equal(
    (await completeAcceptancePacket(fixture.preflight.identity, completion)).packet
      .qualification_complete,
    false,
  );
});

void test("arbitrary retained artifacts cannot assert positive process closure", async (t) => {
  const fixture = await packetFixture(t);
  const completed = await completeAcceptancePacket(fixture.preflight.identity, {
    ...fixture.completion,
    process_closure: {
      outcome: "passed",
      positive_exit: true,
      artifacts: [required(fixture.completion.retained_artifacts[0])],
    },
  });
  assert.equal(completed.packet.qualification_complete, false);
});

void test("Windows closure binds production consumed app paths and captured process identities", async (t) => {
  const fixture = await packetFixture(t);
  const snapshotPath = path.join(fixture.directory, "exit-inventory.json");
  const driverPath = path.join(fixture.directory, "driver.exe");
  const driver = { pid: 42, path: driverPath, started_filetime: "123" };
  const app = {
    pid: 43,
    path: required(fixture.bindings.product_artifacts[0]).path,
    started_filetime: "124",
  };
  await writeFile(
    snapshotPath,
    JSON.stringify({ captured_at: new Date().toISOString(), driver, processes: [driver, app] }),
  );
  const closure = required(fixture.completion.retained_artifacts[2]);
  await writeFile(
    closure.path,
    JSON.stringify({
      snapshot: snapshotPath,
      exited: { observed_processes: 2, exited_at: new Date().toISOString(), wait_ms: 100 },
    }),
  );
  const artifacts = [
    ...fixture.completion.retained_artifacts.slice(0, 2),
    await fileIdentity(closure.path),
    await fileIdentity(snapshotPath),
  ];
  const product = required(fixture.bindings.product_artifacts[0]);
  const completion = await fixture.rebindEvidence(fixture.preflight, {
    artifacts,
    execution_binding: {
      product_artifacts: [
        {
          role: "app",
          consumed_path: product.path,
          sha256: product.sha256,
          bytes: product.bytes,
          binding: "live-path-checked-cooperative",
          retained: product,
        },
      ],
      runtime_tools: [
        { role: "driver", path: driverPath, binding: "live-path-checked-cooperative" },
      ],
      harness_inputs: fixture.bindings.harness_inputs,
      build_inputs: fixture.bindings.build_inputs,
      execution_qualification: fixture.bindings.execution_qualification,
    },
  });
  assert.equal(
    (
      await completeAcceptancePacket(fixture.preflight.identity, {
        ...completion,
        retained_artifacts: artifacts,
        process_closure: {
          outcome: "passed",
          positive_exit: true,
          artifacts: [required(artifacts[2])],
        },
      })
    ).packet.qualification_complete,
    true,
  );
});

void test("a required image must belong to its criterion's scenario", async (t) => {
  const fixture = await packetFixture(t);
  const bindings = structuredClone(fixture.bindings);
  bindings.execution_qualification.scenarios.push("other-selected");
  const preflight = await fixture.create("wrong-scenario", { bindings });
  const capture = required(fixture.completion.retained_artifacts[1]);
  const record = jsonObject(await readFile(capture.path, "utf8"));
  record.scenario = "other-selected";
  await writeFile(capture.path, JSON.stringify(record));
  const artifacts = [...fixture.completion.retained_artifacts];
  artifacts[1] = await fileIdentity(capture.path);
  const completion = await fixture.rebindEvidence(preflight, {
    selected_scenarios: bindings.execution_qualification.scenarios,
    execution_binding: {
      product_artifacts: bindings.product_artifacts,
      harness_inputs: bindings.harness_inputs,
      build_inputs: bindings.build_inputs,
      execution_qualification: bindings.execution_qualification,
    },
    checks: [
      { scenario: "review", outcome: "passed" },
      { scenario: "other-selected", outcome: "passed" },
    ],
    artifacts,
  });
  await assert.rejects(
    completeAcceptancePacket(preflight.identity, {
      ...completion,
      retained_artifacts: artifacts,
      outcomes: [
        { scenario: "review", outcome: "passed" },
        { scenario: "other-selected", outcome: "passed" },
      ],
    }),
    /another scenario\/state/u,
  );
});

void test("retained metadata read binds validated bytes even after the original file changes", async (t) => {
  const directory = await retainedFixture("pcv-metadata-read-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, "original.json");
  await writeFile(original, JSON.stringify({ criteria: "original" }));
  const input = await retainEvidenceInput({
    root: path.join(directory, "evidence"),
    file: original,
  });
  const timestamp = new Date().toISOString(),
    manifest = path.join(directory, "prelaunch.json");
  await writeFile(
    manifest,
    JSON.stringify({
      format_version: 1,
      root: directory,
      revision: "a".repeat(40),
      pre_import_for: "apps/desktop/scripts/desktop-test.mts",
      selected_scenarios: [],
      execution_started_at: timestamp,
      created_at: timestamp,
      inputs: [
        {
          ...input,
          role: "run-metadata",
          kind: "argument-file",
          binding: "retained-metadata-read",
        },
      ],
    }),
  );
  await writeFile(original, JSON.stringify({ criteria: "mutated" }));
  await readPrelaunchCustody(manifest, {
    root: directory,
    revision: "a".repeat(40),
    plan: { receiptInputs: [{ kind: "argument-file", name: "run-metadata" }] },
    values: { "run-metadata": input.retained.path },
    selectedScenarios: [],
    deadlineMs: 60_000,
  });
  assert.equal(jsonObject(await readFile(input.retained.path, "utf8")).criteria, "original");
  assert.equal(
    retainedExecutableCanLaunch(
      { role: "native-driver", path: "/private/WebKitWebDriver" },
      { nativeDriver: "/private/WebKitWebDriver" },
      "linux",
    ),
    false,
    "Private Linux native drivers cannot be assumed relocatable",
  );
});

void test("completed packet readback revalidates artifacts and refuses a forged aggregate", async (t) => {
  const fixture = await packetFixture(t);
  const completed = await completeAcceptancePacket(fixture.preflight.identity, fixture.completion);
  const { observation_captured_at, ...revalidated } = await revalidateAcceptancePacket(
    completed.identity,
  );
  assert.equal(typeof observation_captured_at, "string");
  assert.deepEqual(revalidated, completed.packet);
  await writeFile(
    completed.identity.path,
    JSON.stringify({ ...completed.packet, qualification_complete: false }),
  );
  await assert.rejects(
    revalidateAcceptancePacket(await fileIdentity(completed.identity.path)),
    /differs from revalidated evidence/,
  );
  await writeFile(completed.identity.path, JSON.stringify(completed.packet));
  await writeFile(fixture.completion.retained_artifacts[0]!.path, "changed retained image");
  await assert.rejects(
    revalidateAcceptancePacket(await fileIdentity(completed.identity.path)),
    /retained artifact bytes changed|bound/,
  );
});

void test("offered-operation coverage preserves missing identities and Core holds without inventing routes", async () => {
  const report = {
    report_format: 1,
    captured_at: "2026-10-27T00:00:00Z",
    cli_sha256: "a".repeat(64),
    evidence: {
      doctor: { ok: true, data: { platform: "linux-x86_64" } },
      status: {
        ok: true,
        data: [
          {
            port_id: "new-port",
            active: null,
            port_actions: [
              { action: "install", availability: "held", reason: "definition_ineligible" },
              { action: "launch", availability: "not_offered", reason: "not_installed" },
              { action: "future_action", availability: "waiting", reason: "assessment_incomplete" },
            ],
          },
        ],
      },
    },
  };
  const coverage = await operationCoverage(report);
  assert.equal(coverage.rows.length, 2);
  assert.equal(coverage.rows[0]!.availability, "held");
  assert.equal(coverage.rows[0]!.package.installed_platform, null);
  assert.equal(coverage.rows[0]!.missing_identity, true);
  assert.equal(coverage.rows[1]!.missing_producer, true);
  assert(
    coverage.rows.every((row) => row.latest_compatible_receipt === null && row.missing_observation),
  );
  assert.equal(coverage.observations_complete, false);
  const status = report.evidence.status.data[0]!;
  await assert.rejects(
    operationCoverage({
      ...report,
      evidence: { ...report.evidence, status: { ok: true, data: [{ port_id: status.port_id }] } },
    }),
    /inventory is missing/,
  );
  await assert.rejects(
    operationCoverage({
      ...report,
      evidence: { ...report.evidence, status: { ok: true, data: [status, status] } },
    }),
    /Duplicate Core port/,
  );
});

void test("operation receipts retain the latest failure and separate fixture, harness and installed observations", async (t) => {
  const scenario = "native-reviewed-backup-restore-and-delete";
  const scope = {
    port_id: "fixture-port",
    operation: "backup_create",
    runtime_kind: "managed",
    record_id: "install-1",
    availability: "allowed",
    reason: "available",
    platform: "linux-x86_64",
    package_sha256: createHash("sha256").update("product").digest("hex"),
    producer: scenario,
    evidence_kind: "real-installed-execution",
  };
  const qualified = await packetFixture(t, scenario, scope);
  const passed = await completeAcceptancePacket(qualified.preflight.identity, qualified.completion);
  const broken = await packetFixture(t, scenario, scope);
  const failure = await broken.rebindEvidence(broken.preflight, {
    outcome: "failed",
    checks: [{ scenario, outcome: "failed" }],
  });
  const failed = await completeAcceptancePacket(broken.preflight.identity, {
    ...failure,
    outcomes: [{ scenario, outcome: "failed" }],
    outcome_review: { ...failure.outcome_review, outcome: "failed" },
  });
  assert.equal(failed.packet.qualification_complete, false);
  const fixtureReceipts = [];
  const fixtureContexts = [];
  for (const evidence_kind of ["browser-fixture", "native-harness-contract"]) {
    const fixture = await packetFixture(t, scenario, { ...scope, evidence_kind });
    fixtureContexts.push(fixture.preflight.packet);
    fixtureReceipts.push(
      (await completeAcceptancePacket(fixture.preflight.identity, fixture.completion)).identity,
    );
  }
  const report = {
    report_format: 1,
    captured_at: "2026-10-27T00:00:00Z",
    cli_sha256: scope.package_sha256,
    evidence: {
      catalog: { ok: true, data: { ports: [{ id: scope.port_id }] } },
      doctor: { ok: true, data: { platform: scope.platform } },
      status: {
        ok: true,
        data: [
          {
            port_id: scope.port_id,
            active: { id: scope.record_id, artifact: { sha256: scope.package_sha256 } },
            port_actions: [
              { action: scope.operation, availability: scope.availability, reason: scope.reason },
            ],
          },
        ],
      },
    },
  };
  await writeFile(
    passed.identity.path,
    JSON.stringify({ ...passed.packet, completed_at: "2099-01-01T00:00:00Z" }),
  );
  passed.identity = await fileIdentity(passed.identity.path);
  const greenOnly = await operationCoverage(
    report,
    [passed.identity],
    [qualified.preflight.packet],
  );
  assert.equal(greenOnly.observations_complete, true);
  for (const current of [
    {
      ...qualified.preflight.packet,
      source_review: { ...qualified.source_review, outcome: "failed" },
    },
    {
      ...qualified.preflight.packet,
      known_gaps: [{ id: "mandatory-observation", required: true }],
    },
  ]) {
    const blocked = await operationCoverage(report, [passed.identity], [current]);
    assert.equal(blocked.rows[0]!.mandatory_observation, "recorded");
    assert.equal(blocked.requested_preflights[0]!.clear, false);
    assert.equal(blocked.observations_complete, false);
  }
  const truncated = structuredClone(report);
  truncated.evidence.status.data = [];
  const incomplete = await operationCoverage(truncated, [], []);
  assert.equal(incomplete.inventory_complete, false);
  assert.equal(incomplete.observations_complete, false);
  const noAssessments = structuredClone(report);
  noAssessments.evidence.status.data[0]!.port_actions = [];
  assert.equal((await operationCoverage(noAssessments)).inventory_complete, false);
  const empty = await operationCoverage({
    ...report,
    evidence: {
      ...report.evidence,
      catalog: { ok: true, data: { ports: [] } },
      status: { ok: true, data: [] },
    },
  });
  assert.equal(empty.coverage_state, "empty");
  assert.equal(empty.observations_complete, false);
  const coverage = await operationCoverage(
    report,
    [failed.identity, passed.identity, ...fixtureReceipts],
    [qualified.preflight.packet],
  );
  assert.equal(coverage.receipt_validation_errors.length, 0);
  assert.equal(coverage.rows[0]!.latest_compatible_receipt!.receipt.sha256, failed.identity.sha256);
  assert.equal(coverage.rows[0]!.mandatory_observation, "failed");
  assert.equal(coverage.observations_complete, false);
  assert.equal(coverage.supplied_receipts.length, 4);
  const allKinds = await operationCoverage(
    report,
    [passed.identity, ...fixtureReceipts],
    [qualified.preflight.packet, ...fixtureContexts],
  );
  assert.deepEqual(Object.keys(allKinds.rows[0]!.observations_by_kind).sort(), [
    "browser-fixture",
    "native-harness-contract",
    "real-installed-execution",
  ]);
  await assert.rejects(
    operationCoverage(
      report,
      [passed.identity],
      [qualified.preflight.packet, qualified.preflight.packet],
    ),
    /Duplicate requested operation scope/,
  );

  assert.equal(coverage.supplied_receipts[2]!.compatible_scenarios.length, 0);
  assert.deepEqual(
    compatibleAcceptanceScenarios(failed.packet, qualified.preflight.packet).compatible,
    [scenario],
  );
  assert.equal(
    reusableAcceptanceScenarios(failed.packet, qualified.preflight.packet).reusable.length,
    0,
  );
  const differentPlatform = structuredClone(report);
  differentPlatform.evidence.doctor.data.platform = "windows-x86_64";
  assert.equal(
    (await operationCoverage(differentPlatform, [passed.identity], [qualified.preflight.packet]))
      .rows[0]!.mandatory_observation,
    "missing",
  );
  const differentPackage = structuredClone(report);
  differentPackage.evidence.status.data[0]!.active.artifact.sha256 = "e".repeat(64);
  assert.equal(
    (await operationCoverage(differentPackage, [passed.identity], [qualified.preflight.packet]))
      .rows[0]!.mandatory_observation,
    "missing",
  );
  const undated = await packetFixture(t, scenario, scope);
  const undatedContext = await undated.rebindEvidence(undated.preflight, { captured_at: null });
  const undatedReceipt = await completeAcceptancePacket(undated.preflight.identity, undatedContext);
  const ambiguous = await operationCoverage(
    report,
    [passed.identity, undatedReceipt.identity],
    [qualified.preflight.packet],
  );
  assert.equal(ambiguous.rows[0]!.mandatory_observation, "incomplete");
  assert.equal(ambiguous.rows[0]!.latest_compatible_receipt, null);
  const noNative = await operationCoverage(report, fixtureReceipts, [qualified.preflight.packet]);
  assert.equal(noNative.rows[0]!.mandatory_observation, "missing");
  await writeFile(
    path.join(qualified.directory, "nearby-green.json"),
    JSON.stringify({
      stage: "completed",
      qualification_complete: true,
      completed_at: new Date().toISOString(),
    }),
  );
  const green = await readCoverageInput(path.join(qualified.directory, "nearby-green.json"));
  const refused = await operationCoverage(report, [green.identity], [qualified.preflight.packet]);
  assert.equal(refused.receipt_validation_errors.length, 1);
  assert.equal(refused.rows[0]!.mandatory_observation, "missing");
});

void test(
  "bounded evidence metadata reads pin one ordinary handle across growth and replacement",
  { timeout: 15000 },
  async (t) => {
    const { readBoundedEvidenceFile } = await import("./development-evidence.mts");
    const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-bounded-read-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "metadata.json");
    await writeFile(file, "{}");
    const result = await readBoundedEvidenceFile(file, 2);
    assert.equal(result.bytes.toString(), "{}");
    assert.deepEqual(result.identity, await fileIdentity(file));
    await assert.rejects(readBoundedEvidenceFile(file, 1), /bounded/);
    await assert.rejects(readBoundedEvidenceFile(file, 0), /finite byte bound/);
    await assert.rejects(readBoundedEvidenceFile(directory, 16), /regular file/);
    const moduleUrl = new URL("./development-evidence.mts", import.meta.url).href;
    const child = `
    import {mock} from 'node:test';
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    const real=await import('node:fs/promises');
    const {default:ignored,...named}=real;
    const file=${JSON.stringify(file)};
    for(const mode of ['growth',...(process.platform==='linux'?['fifo']:[])]) {
      await real.writeFile(file,'{}');
      const control=mock.module('node:fs/promises',{namedExports:{...named,open:async(...args)=>{
        if(mode==='growth') await real.appendFile(file,'x');
        else { await real.unlink(file); const made=spawnSync('mkfifo',[file]); assert.equal(made.status,0); }
        return real.open(...args);
      }}});
      try {
        const {readBoundedEvidenceFile}=await import(${JSON.stringify(moduleUrl)}+'?bounded-control='+mode);
        await assert.rejects(readBoundedEvidenceFile(file,16),/physical identity changed/);
      } finally { control.restore(); await real.unlink(file); }
    }
    console.log('PASS bounded growth and ordinary-file replacement controls');
  `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const observed = spawnSync(
      process.execPath,
      ["--experimental-test-module-mocks", "--input-type=module", "--eval", child],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 0, observed.stderr);
    assert.match(observed.stdout, /PASS bounded growth/);
  },
);
