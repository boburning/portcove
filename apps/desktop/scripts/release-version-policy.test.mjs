import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyApplicationVersion, proposeApplicationVersion, selectApplicationRelease } from "./release-version-policy.mjs";

const released = (version, overrides = {}) => ({ tag_name: `v${version}`, draft: false, prerelease: true, published_at: "2026-09-01T12:00:00Z", ...overrides });
const approved = (version, overrides = {}) => ({ version, preview_eligible: true, production_eligible: true, targets: ["windows-x86_64"], ...overrides });

test("0.x stays Preview even without a suffix and production eligibility is explicit", () => {
  for (const version of ["0.1.0-alpha.2", "0.1.0", "0.3.0", "1.0.0-rc.1"]) {
    assert.deepEqual(classifyApplicationVersion(version).channels, ["preview"]);
    assert.equal(classifyApplicationVersion(version).github_prerelease, true);
    assert.throws(() => classifyApplicationVersion(version, true), /cannot be production eligible/);
  }
  assert.equal(classifyApplicationVersion("1.0.0").github_prerelease, true);
  assert.deepEqual(classifyApplicationVersion("1.0.0", true).channels, ["preview", "stable"]);
  assert.equal(classifyApplicationVersion("1.0.0", true).github_prerelease, false);
});

test("maintained SemVer rejects noncanonical values and compares numeric prerelease identifiers", () => {
  for (const version of ["v1.0.0", " 1.0.0", "1.0", "01.0.0", "1.0.0-beta.01"]) {
    assert.throws(() => classifyApplicationVersion(version), /version/);
  }
  const candidates = [released("0.2.0-beta.9", { published_at: "2026-09-09T12:00:00Z" }), released("0.2.0-beta.10")];
  assert.equal(selectApplicationRelease(candidates, "preview").tag_name, "v0.2.0-beta.10");
});

test("late maintenance cannot replace a higher preview and drafts stay excluded", () => {
  const candidates = [released("0.1.9", { published_at: "2026-09-09T12:00:00Z" }), released("0.3.0-beta.1"), released("0.4.0", { draft: true })];
  assert.equal(selectApplicationRelease(candidates, "preview").tag_name, "v0.3.0-beta.1");
  assert.equal(selectApplicationRelease([released("0.3.0", { prerelease: false })], "stable"), null);
  assert.equal(selectApplicationRelease([released("0.3.0", { prerelease: false })], "preview").tag_name, "v0.3.0");
});

test("Stable requires separate production evidence and Preview includes eligible finals", () => {
  const release = released("1.0.0", { prerelease: false, production_eligible: true });
  assert.equal(selectApplicationRelease([release], "stable"), null);
  assert.equal(selectApplicationRelease([release], "preview"), null);
  const options = { eligibility: { "v1.0.0": approved("1.0.0") } };
  assert.equal(selectApplicationRelease([release], "stable", options), release);
  assert.equal(selectApplicationRelease([release], "preview", options), release);
  assert.equal(selectApplicationRelease([{ ...release, prerelease: true }], "stable", options), null);
});

test("Preview-to-Stable waits, equal versions do not reinstall and RC-to-final selects the new artifact", () => {
  const rc = released("1.0.0-rc.1", { artifact_sha256: "a".repeat(64) });
  const final = released("1.0.0", { prerelease: false, artifact_sha256: "b".repeat(64) });
  const options = { currentVersion: "1.0.0-rc.1", eligibility: { "v1.0.0": approved("1.0.0") } };
  assert.equal(selectApplicationRelease([rc], "stable", options), null);
  assert.equal(selectApplicationRelease([rc, final], "stable", options).artifact_sha256, final.artifact_sha256);
  assert.equal(selectApplicationRelease([final], "stable", { ...options, currentVersion: "1.0.0" }), null);
  assert.equal(selectApplicationRelease([final], "stable", { ...options, currentVersion: "1.1.0-beta.1" }), null);
  assert.equal(selectApplicationRelease([released("0.3.0+build.2")], "preview", { currentVersion: "0.3.0+build.1" }), null);
  assert.throws(() => selectApplicationRelease([released("0.3.0+one"), released("0.3.0+two")], "preview"), /equal SemVer precedence/);
});

test("target mismatch, withdrawal and holds cannot manufacture an eligible update", () => {
  const release = released("1.0.0", { prerelease: false });
  const options = { target: "linux-x86_64", eligibility: { "v1.0.0": approved("1.0.0") } };
  assert.equal(selectApplicationRelease([release], "stable", options), null);
  for (const evidence of [approved("1.0.0", { held: true }), approved("1.0.0", { withdrawn: true })]) {
    assert.equal(selectApplicationRelease([release], "stable", { eligibility: { "v1.0.0": evidence } }), null);
  }
  assert.throws(() => selectApplicationRelease([release], "stable", { eligibility: { "v1.0.0": approved("1.1.0") } }), /invalid release eligibility/);
  assert.throws(() => selectApplicationRelease([release], "stable", { eligibility: { "v1.0.0": approved("1.0.0", { held: "true" }) } }), /inconsistent release eligibility/);
});

const commit = "a".repeat(40);
const classification = (base, change, overrides = {}) => ({ source_commit: commit, reviewed_commit: commit, base_version: base, change, compatibility: "compatible", ...overrides });

test("reviewed frozen classifications produce deterministic initial-development versions", () => {
  for (const [base, change, expected] of [["0.1.0", "patch", "0.1.1"], ["0.1.0", "minor", "0.2.0"], ["0.1.0-alpha.2", "prerelease", "0.1.0-alpha.3"], ["0.1.0-alpha.2", "finalize", "0.1.0"]]) {
    const result = proposeApplicationVersion(classification(base, change), [base]);
    assert.equal(result.version, expected);
    assert.deepEqual(result.channels, ["preview"]);
    assert.deepEqual(proposeApplicationVersion(classification(base, change), [base]), result);
  }
});

test("classification rejects stale review/history, silent compatibility breaks and implicit finalization", () => {
  assert.throws(() => proposeApplicationVersion(classification("0.1.0", "patch", { reviewed_commit: "b".repeat(40) }), ["0.1.0"]), /review does not match/);
  assert.throws(() => proposeApplicationVersion(classification("0.1.0", "patch"), ["0.1.0", "0.2.0"]), /behind published history/);
  assert.throws(() => proposeApplicationVersion(classification("0.1.0", "patch"), []), /absent from published history/);
  assert.throws(() => proposeApplicationVersion(classification("0.1.0-alpha.2", "patch"), ["0.1.0-alpha.2"]), /explicitly finalize/);
  assert.throws(() => proposeApplicationVersion(classification("0.1.0", "minor", { compatibility: "breaking" }), ["0.1.0"]), /migration notes/);
  assert.throws(() => proposeApplicationVersion(classification("1.0.0", "minor", { compatibility: "breaking", migration_notes: "Migrate the documented API" }), ["1.0.0"]), /cannot carry/);
  assert.equal(proposeApplicationVersion(classification("0.1.0", "minor", { compatibility: "breaking", migration_notes: "Preserve and migrate data" }), ["0.1.0"]).version, "0.2.0");
  assert.throws(() => proposeApplicationVersion(classification("1.1.0-rc.1", "prerelease", { compatibility: "breaking", migration_notes: "Migrate the API" }), ["1.0.0", "1.1.0-rc.1"]), /public major version/);
  assert.throws(() => proposeApplicationVersion(classification("0.1.0+one", "patch"), ["0.1.0+one", "0.1.0+two"]), /duplicate version precedence/);
});
