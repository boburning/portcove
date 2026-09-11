import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeEvidence, evidenceOutcome, fileIdentity } from "./development-evidence.mjs";

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
