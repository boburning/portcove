import {
  writeAcceptancePreflight,
  completeAcceptancePacket,
  reusableAcceptanceScenarios,
} from "./acceptance-packet.mjs";
import { runInNewContext } from "node:vm";
import {
  observeGamepadCapability,
  capabilityRequirement,
  captureSettledVisual,
  observeVisibleTarget,
} from "./native-readiness.mjs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
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
import { writeEvidence, evidenceOutcome, fileIdentity } from "./development-evidence.mjs";
import {
  retainEvidenceInput,
  verifyConsumedInputs,
  validateEvidenceStore,
  executionAdmission,
  retainedExecutableCanLaunch,
  readPrelaunchCustody,
} from "./retained-evidence.mjs";

test("prelaunch custody accepts native equivalent absolute path separators", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-prelaunch-path-"));
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
      pre_import_for: "apps/desktop/scripts/desktop-test.mjs",
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

test("retention rejects absent and untagged cleanup roots before creating them", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-cleanup-boundary-"));
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

test("matching product metadata cannot authorize relocation of a path-sensitive executable", () => {
  const drivers = { driver: "/trusted/tauri-driver", nativeDriver: "/trusted/native-driver" };
  for (const role of ["app", "preparation-cli", "preparation-tool"]) {
    assert.equal(
      retainedExecutableCanLaunch(
        {
          role,
          path: "/unrelated/product",
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

test("capture/read/verification expiry refuses every later launch", async () => {
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

test("retained input is published without overwrite, deduplicated and bound before consumption", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-"));
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

test("a retained executable is actually consumed through its retained path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-launch-"));
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

test("corrupt published evidence and interrupted publication preserve partial failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-failure-"));
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
  assert(partials.some((name) => name.endsWith(".partial")));
  assert(partials.some((name) => name.endsWith(".failure.json")));
});

test("retained evidence refuses disposable ancestry and unavailable capacity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-capacity-"));
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

test("cancellation joins the blocked publication worker and preserves staging without publication", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source");
  await writeFile(file, "original");
  const controller = new AbortController();
  let entered, release;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let finished = false,
    partial,
    published;
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
  assert.equal(await readFile(partial, "utf8"), "original");
  release();
  await rejected;
  await assert.rejects(stat(published), { code: "ENOENT" });
  assert.equal(await readFile(partial, "utf8"), "original");
});

test("late cancellation preserves already admitted evidence publication", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-retained-late-cancel-"));
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

test("partial and failed evidence cannot become a pass", () => {
  assert.equal(evidenceOutcome([]), "not-run");
  assert.equal(
    evidenceOutcome([
      { scenario: "a", outcome: "passed" },
      { scenario: "b", outcome: "not-run" },
    ]),
    "incomplete",
  );
  assert.equal(evidenceOutcome([{ scenario: "a", outcome: "failed" }]), "failed");
  assert.throws(() => evidenceOutcome([{ scenario: "a", outcome: "maybe" }]));
});

test("a vanished executable can retain its initial identity and failure evidence", async () => {
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
test("version two evidence separates selected scenarios, setup, gaps, and phases", async () => {
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
    assert.equal(report.phases[0].phase, "build");
    assert.equal(report.harness_deadline_ms, 180_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("evidence hashes bytes and never replaces prior observations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-evidence-"));
  try {
    const executable = path.join(directory, "fixture");
    await writeFile(executable, "abc");
    const input = {
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

test("native capability distinguishes API absence, restriction, exposed absence and scoped observations", () => {
  const observe = (navigator) =>
    runInNewContext(`(${observeGamepadCapability.toString()})()`, { navigator });
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

test("serialized visual target observation rejects absent, loading and offscreen targets", () => {
  const observe = (rect, loading = 0) =>
    runInNewContext(`(${observeVisibleTarget.toString()})("#target")`, {
      document: {
        readyState: "complete",
        querySelectorAll: (selector) =>
          selector === "#target"
            ? rect
              ? [{ getBoundingClientRect: () => rect, closest: () => null }]
              : []
            : Array(loading).fill({}),
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
    });
  assert.equal(observe(null).visible, false);
  assert.equal(
    observe({ x: 900, y: 0, left: 900, top: 0, right: 950, bottom: 20, width: 50, height: 20 })
      .visible,
    false,
  );
  assert.equal(
    observe({ x: 0, y: 0, left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20 }, 1)
      .application_state.loading,
    1,
  );
});

test("settled visual binds retained image to semantic state and preserves negative diagnostics", async (t) => {
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
  const run = (name, readiness = async () => ({ ready: true, phase: "review" })) =>
    captureSettledVisual({
      browser,
      output: directory,
      name,
      scenario: "owned-review",
      target: "#review",
      readiness,
      timeoutMs: 200,
    });
  const captured = await run("positive");
  assert.deepEqual(await fileIdentity(captured.image.path), captured.image);
  assert.equal(JSON.parse(await readFile(captured.receipt, "utf8")).scenario, "owned-review");
  await assert.rejects(
    run("loading", async () => ({ ready: false })),
    /timed out/u,
  );
  state.visible = false;
  await assert.rejects(run("offscreen"), /timed out/u);
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
      JSON.parse(await readFile(path.join(directory, `${name}-capture-failure.json`), "utf8"))
        .acceptance,
      false,
    );
    await assert.rejects(stat(path.join(directory, `${name}-capture.json`)), { code: "ENOENT" });
  }
});

test("settled capture waits for the actual target geometry without accepting a moving target", async (t) => {
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
    JSON.parse(await readFile(path.join(directory, "moving-capture-failure.json"), "utf8"))
      .acceptance,
    false,
  );
});

test("timed-out capture joins the blocked filesystem worker without publishing a completed receipt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-capture-join-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let enter, release, aborted;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const cancellation = new Promise((resolve) => {
    aborted = resolve;
  });
  let settled = false;
  const operation = captureSettledVisual({
    browser: {
      executeScript: async () => ({
        visible: true,
        viewport: { width: 800, height: 600 },
        application_state: { document_ready: "complete", loading: 0 },
      }),
      takeScreenshot: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    },
    output: directory,
    name: "blocked",
    scenario: "owned-review",
    target: "#review",
    readiness: async () => ({ ready: true }),
    timeoutMs: 1000,
    write: async (file, bytes, options) => {
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
    JSON.parse(await readFile(path.join(directory, "blocked-capture-failure.json"), "utf8"))
      .acceptance,
    false,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "blocked-capture.partial"), "utf8")).outcome,
    "captured",
  );
});

async function packetFixture(t) {
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
  const bindings = {
    source_head: head,
    current_target: target,
    composed_tree: tree,
    build_inputs: { build_input_fingerprint: "d".repeat(64), inventory_complete: false },
    product_artifacts: [{ ...identity, role: "app" }],
    harness_inputs: [{ ...identity, role: "harness-fixture" }],
    execution_qualification: {
      runtime_conditions: { platform: "fixture", display: "virtual" },
      fixture_identities: [],
      initial_state: { isolated: true },
      requirements: [{ id: "finite-fixture", required_scenarios: ["review"] }],
      scenarios: ["review"],
      acceptance_criteria: [
        { id: "readable-review", scenarios: ["review"], required_images: ["review.png"] },
      ],
    },
  };
  const source_review = {
    reviewer: "separate-fixture-source-reviewer",
    reference: "isolated fixture source record",
    source_head: head,
    outcome: "passed",
  };
  const create = (name, extra = {}) =>
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
      scenario: "review",
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
  const artifacts = await Promise.all([image, capture, closure].map(fileIdentity));
  const evidenceFile = path.join(directory, "evidence.json");
  await writeFile(
    evidenceFile,
    JSON.stringify({
      format_version: 3,
      revision: head,
      outcome: "passed",
      selected_scenarios: ["review"],
      setup_checks: [{ scenario: "setup", outcome: "passed" }],
      acceptance_preflight: preflight.identity,
      execution_binding: {
        product_artifacts: bindings.product_artifacts,
        harness_inputs: bindings.harness_inputs,
        build_inputs: bindings.build_inputs,
        execution_qualification: bindings.execution_qualification,
      },
      checks: [{ scenario: "review", outcome: "passed" }],
      artifacts,
    }),
  );
  const completion = {
    evidence_identity: await fileIdentity(evidenceFile),
    outcomes: [{ scenario: "review", outcome: "passed" }],
    retained_artifacts: artifacts,
    process_closure: { outcome: "passed", positive_exit: true, artifacts: [artifacts[2]] },
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
  const rebindEvidence = async (nextPreflight, changes = {}) => {
    const receipt = JSON.parse(await readFile(evidenceFile, "utf8"));
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

test("preflight freezes prospective bindings without requiring final screenshots or a completed placeholder", async (t) => {
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
      image_inspections: [{ ...fixture.completion.image_inspections[0], sha256: "f".repeat(64) }],
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

test("changed retained image, placeholder source review and unreviewed composition cannot complete", async (t) => {
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
  await writeFile(fixture.completion.image_inspections[0].path, "mutated image");
  await assert.rejects(
    completeAcceptancePacket(fixture.preflight.identity, fixture.completion),
    /artifact bytes changed/u,
  );
});

test("reuse keeps source provenance separate and conservatively invalidates effective observations", async (t) => {
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
  for (const mutate of [
    (value) => (value.bindings.product_artifacts[0].sha256 = "f".repeat(64)),
    (value) => (value.harness_identity = "f".repeat(64)),
    (value) => (value.bindings.harness_inputs[0].sha256 = "f".repeat(64)),
    (value) => (value.bindings.execution_qualification.runtime_conditions.display = "physical"),
    (value) => (value.bindings.execution_qualification.initial_state.isolated = false),
    (value) =>
      (value.bindings.execution_qualification.fixture_identities = [
        { ...fixture.bindings.product_artifacts[0], role: "new-fixture" },
      ]),
    (value) =>
      (value.bindings.execution_qualification.acceptance_criteria[0].id = "changed-criteria"),
    (value) => (value.bindings.execution_qualification.requirements[0].id = "changed-requirement"),
  ]) {
    const changed = structuredClone(next);
    mutate(changed);
    assert.deepEqual(reusableAcceptanceScenarios(previous, changed).rerun, ["review"]);
  }
  assert.deepEqual(reusableAcceptanceScenarios({}, next).rerun, ["review"]);
});

test("bound prior completed evidence may be reused without backdating original execution", async (t) => {
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

test("required gaps and distinct failed/skipped/unsupported outcomes do not waive acceptance", async (t) => {
  const fixture = await packetFixture(t);
  const gap = await fixture.create("gap", {
    known_gaps: [{ id: "required-closure-gap", required: true }],
  });
  assert.equal(
    (await completeAcceptancePacket(gap.identity, await fixture.rebindEvidence(gap))).packet
      .qualification_complete,
    false,
  );
  for (const outcome of ["failed", "skipped", "unsupported"]) {
    const preflight = await fixture.create(outcome);
    const completion = await fixture.rebindEvidence(preflight, {
      outcome,
      checks: [{ scenario: "review", outcome }],
    });
    const completed = await completeAcceptancePacket(preflight.identity, {
      ...completion,
      outcomes: [{ scenario: "review", outcome }],
    });
    assert.equal(completed.packet.outcomes[0].outcome, outcome);
    assert.equal(completed.packet.qualification_complete, false);
  }
});

test("same-head completion refuses unbound or changed execution dependencies", async (t) => {
  const fixture = await packetFixture(t);
  const original = JSON.parse(await readFile(fixture.completion.evidence_identity.path, "utf8"));
  for (const mutate of [
    (value) => delete value.acceptance_preflight,
    (value) => delete value.execution_binding,
    (value) => (value.execution_binding.product_artifacts[0].sha256 = "e".repeat(64)),
    (value) => (value.execution_binding.harness_inputs[0].sha256 = "e".repeat(64)),
    (value) => (value.execution_binding.build_inputs.build_input_fingerprint = "e".repeat(64)),
    (value) =>
      (value.execution_binding.execution_qualification.runtime_conditions.display = "other"),
    (value) =>
      value.execution_binding.execution_qualification.fixture_identities.push({
        ...fixture.bindings.product_artifacts[0],
        role: "different-fixture",
      }),
  ]) {
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

test("arbitrary retained artifacts cannot assert positive process closure", async (t) => {
  const fixture = await packetFixture(t);
  const completed = await completeAcceptancePacket(fixture.preflight.identity, {
    ...fixture.completion,
    process_closure: {
      outcome: "passed",
      positive_exit: true,
      artifacts: [fixture.completion.retained_artifacts[0]],
    },
  });
  assert.equal(completed.packet.qualification_complete, false);
});

test("Windows closure binds production consumed app paths and captured process identities", async (t) => {
  const fixture = await packetFixture(t);
  const snapshotPath = path.join(fixture.directory, "exit-inventory.json");
  const driverPath = path.join(fixture.directory, "driver.exe");
  const driver = { pid: 42, path: driverPath, started_filetime: "123" };
  const app = {
    pid: 43,
    path: fixture.bindings.product_artifacts[0].path,
    started_filetime: "124",
  };
  await writeFile(
    snapshotPath,
    JSON.stringify({ captured_at: new Date().toISOString(), driver, processes: [driver, app] }),
  );
  const closure = fixture.completion.retained_artifacts[2];
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
  const product = fixture.bindings.product_artifacts[0];
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
        process_closure: { outcome: "passed", positive_exit: true, artifacts: [artifacts[2]] },
      })
    ).packet.qualification_complete,
    true,
  );
});

test("a required image must belong to its criterion's scenario", async (t) => {
  const fixture = await packetFixture(t);
  const bindings = structuredClone(fixture.bindings);
  bindings.execution_qualification.scenarios.push("other-selected");
  const preflight = await fixture.create("wrong-scenario", { bindings });
  const capture = fixture.completion.retained_artifacts[1];
  const record = JSON.parse(await readFile(capture.path, "utf8"));
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

test("retained metadata read binds validated bytes even after the original file changes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pcv-metadata-read-"));
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
      pre_import_for: "apps/desktop/scripts/desktop-test.mjs",
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
  assert.equal(JSON.parse(await readFile(input.retained.path, "utf8")).criteria, "original");
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
