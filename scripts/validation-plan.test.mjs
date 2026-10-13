import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidationPlan,
  digestValidationPlan,
  fastGroups,
  qualificationPlatforms,
  validateValidationPlan,
  validateQualificationBinding,
} from "./validation-plan.mjs";
import { discoverCiPlan } from "./select-ci-plan.mjs";
const sha = (c) => c.repeat(40);
const change = (file, values = {}) => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  oldPath: file,
  newPath: file,
  ...values,
});
const plan = (changes, values = {}) =>
  buildValidationPlan({
    changes,
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
    ...values,
  });
const redigest = (p) => ({ ...p, digest: digestValidationPlan(p) });

test("ordinary layers select the minimum baseline and union mixed changes", () => {
  for (const [file, groups] of [
    ["apps/desktop/src/App.tsx", ["frontend", "rust-quality"]],
    ["crates/portcove-core/src/lib.rs", ["rust", "rust-quality"]],
    ["Cargo.lock", ["dependency-review", "rust", "rust-quality"]],
    ["apps/desktop/package.json", ["dependency-review", "frontend", "rust-quality"]],
    ["docs/QUALITY.md", ["catalog", "rust-quality"]],
    [".github/workflows/ci.yml", ["catalog", "rust-quality"]],
    ["scripts/validation-plan.mjs", ["catalog", "rust-quality"]],
  ]) {
    const p = plan([change(file)]);
    assert.equal(p.mode, "fast");
    assert.deepEqual(p.groups, groups);
    assert.deepEqual(p.platforms, ["primary-host"]);
    validateValidationPlan(p);
  }
  assert.deepEqual(plan([change("Cargo.lock"), change("apps/desktop/src/App.tsx")]).groups, [
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
  ]);
});
test("docs and captures ignore schema/catalog/platform topic words", () => {
  for (const file of [
    "docs/SIGNED-CATALOG.md",
    "docs/UPDATER-TRUST.md",
    "docs/media/windows-ipc-catalog.png",
    "AGENTS.md",
    ".agents/skills/portcove-release-validation/SKILL.md",
  ])
    assert.deepEqual(plan([change(file)]).groups, ["catalog", "rust-quality"]);
  assert.equal(plan([change("docs/README.md")]).mode, "prose");
});
test("shared toolchain and safe unknown inputs select the entire Windows baseline", () => {
  for (const file of [".node-version", ".github/quality-tools.json", "future/new-script.xyz"]) {
    const p = plan([change(file)]);
    assert.deepEqual(p.groups, fastGroups);
    assert.equal(p.mode, "fast");
    validateValidationPlan(p);
  }
  const p = plan([change("future/new-script.xyz")]);
  assert.deepEqual(p.fallback, { kind: "all-fast-groups", paths: ["future/new-script.xyz"] });
});
test("native/platform and release implementation edits stay ordinary; full coverage is explicit", () => {
  for (const file of [
    "apps/desktop/src-tauri/src/application_update_windows.rs",
    "scripts/test-linux-package-ownership.sh",
    "scripts/sign-catalog.mjs",
  ]) {
    const p = plan([change(file)]);
    assert.equal(p.mode, "fast");
    assert.equal(p.qualification_required, false);
    assert.deepEqual(p.platforms, ["primary-host"]);
    validateValidationPlan(p);
  }
  const p = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("d"),
    forceQualification: true,
  });
  assert.equal(p.mode, "qualification");
  assert.deepEqual(p.groups, fastGroups);
  assert.deepEqual(p.platforms, qualificationPlatforms);
  validateQualificationBinding({ plan: p, digest: p.digest, checkout: sha("d") });
  assert.throws(() =>
    validateQualificationBinding({ plan: p, digest: p.digest, checkout: sha("c") }),
  );
});
test("both rename sides and deletions preserve explicit change identity", () => {
  const changes = [
    change("crates/portcove-core/src/source_report.rs", {
      status: "R",
      newPath: "docs/old-rust.md",
    }),
    change("apps/desktop/src/old.tsx", { status: "D", newMode: "000000" }),
  ];
  const p = plan(changes);
  assert.equal(p.changes.length, 2);
  assert.ok(p.groups.includes("rust"));
  assert.ok(p.groups.includes("frontend"));
  assert.ok(p.changed_files.includes("docs/old-rust.md"));
  validateValidationPlan(p);
});
test("incomplete discovery and unsafe modes/statuses block; unsafe paths reject", () => {
  for (const input of [
    plan([]),
    plan([change("AGENTS.md", { newMode: "120000" })]),
    plan([change("x", { status: "C" })]),
    plan([], { discovery: "failed", blockedReason: "missing-base" }),
  ]) {
    assert.equal(input.mode, "blocked");
    assert.deepEqual(input.groups, []);
    validateValidationPlan(input);
  }
  for (const file of ["../secret", "/absolute", "bad\\path", "bad\0path"])
    assert.throws(() => plan([change(file)]));
});
test("digest and structural tampering cannot authorize missing or stale lanes", () => {
  const p = plan([change("crates/portcove-core/src/lib.rs")]);
  assert.throws(() => validateValidationPlan({ ...p, groups: [] }));
  for (const mutate of [
    (q) => q.groups.pop(),
    (q) => (q.changes = []),
    (q) => (q.identities.head = "short"),
    (q) => (q.paths = []),
    (q) => (q.discovery = "failed"),
    (q) => (q.platforms = []),
  ]) {
    const q = structuredClone(p);
    mutate(q);
    assert.throws(() => validateValidationPlan(redigest(q)));
  }
  const q = plan([change("unknown.bin")]);
  q.fallback = null;
  assert.throws(() => validateValidationPlan(redigest(q)));
});

test("generated transport snapshots and declaration inputs retain real Rust drift validation", () => {
  for (const file of [
    "apps/desktop/src/transport-host-output.generated.json",
    "apps/desktop/src/transport-types.generated.d.ts",
    "scripts/check-transport-contract.mjs",
    "apps/desktop/scripts/generate-transport-types.mjs",
  ]) {
    const selected = plan([change(file)]);
    validateValidationPlan(selected);
    assert.ok(selected.groups.includes("rust"), file);
    assert.ok(selected.groups.includes("frontend"), file);
    assert.ok(selected.groups.includes("catalog"), file);
  }
});
