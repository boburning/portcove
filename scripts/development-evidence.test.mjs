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
} from "./retained-evidence.mjs";

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
