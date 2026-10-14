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
      timeoutMs: 30,
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
    timeoutMs: 100,
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
