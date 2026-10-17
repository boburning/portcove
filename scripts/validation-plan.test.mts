import assert from "node:assert/strict";
import test from "node:test";
import {
  buildValidationPlan,
  digestValidationPlan,
  fastGroups,
  qualificationPlatforms,
  validateValidationPlan,
  validateQualificationBinding,
  validationOwnershipForPath,
} from "./validation-plan.mts";
import { discoverCiPlan } from "./select-ci-plan.mts";
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

test("regular executable modes route by ownership while nonregular inputs block", () => {
  for (const modes of [
    { oldMode: "100755", newMode: "100755" },
    { status: "A", oldMode: "000000", newMode: "100755" },
    { status: "D", oldMode: "100755", newMode: "000000" },
    { oldMode: "100644", newMode: "100755" },
    { oldMode: "100755", newMode: "100644" },
  ]) {
    const selected = plan([change("scripts/bootstrap-quality-tools.sh", modes)]);
    assert.equal(selected.mode, "fast");
    assert.deepEqual(selected.platforms, ["primary-host"]);
    validateValidationPlan(selected);
  }
  for (const mode of ["120000", "160000"]) {
    const blocked = plan([change("scripts/input", { oldMode: mode, newMode: mode })]);
    assert.equal(blocked.mode, "blocked");
    validateValidationPlan(blocked);
  }
});

test("shared browser trace runtime selects required frontend coverage", () => {
  const file = "scripts/browser-traces.ts";
  const ownership = validationOwnershipForPath(file);
  assert.ok(ownership.groups.includes("frontend"));
  assert.ok(plan([change(file)]).groups.includes("frontend"));
});

test("shared frontend compiler policy selects the same required checks as the root compiler config", () => {
  const shared = validationOwnershipForPath("tsconfig.base.json");
  const root = validationOwnershipForPath("tsconfig.json");
  assert.deepEqual({ ...shared, path: root.path }, root);
});

test("scoped beta matcher and Roadmap release consumer retain protected qualification ownership", () => {
  for (const file of [
    "scripts/linux-beta-risk-706.mts",
    "scripts/linux-beta-risk-706.test.mts",
    "scripts/roadmap.mts",
    "scripts/roadmap.test.mts",
  ]) {
    const ownership = validationOwnershipForPath(file);
    assert.equal(ownership.qualificationRequired, true);
    assert.ok(ownership.areas.includes("policy"));
    assert.ok(ownership.areas.includes("release-security"));
    assert.deepEqual(ownership.platforms, qualificationPlatforms);
  }
});

test("ordinary layers select the minimum baseline and union mixed changes", () => {
  for (const [file, groups] of [
    ["apps/desktop/src/App.tsx", ["frontend", "rust-quality"]],
    ["crates/portcove-core/src/lib.rs", ["rust", "rust-quality"]],
    ["Cargo.lock", ["dependency-review", "rust", "rust-quality"]],
    ["apps/desktop/package.json", ["dependency-review", "frontend", "rust-quality"]],
    ["docs/QUALITY.md", ["catalog", "rust-quality"]],
    [".github/workflows/ci.yml", ["catalog", "rust-quality"]],
    ["scripts/validation-plan.mts", ["catalog", "rust-quality"]],
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
    "scripts/sign-catalog.mts",
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
    "scripts/check-transport-contract.mts",
    "apps/desktop/scripts/generate-transport-types.mts",
  ]) {
    const selected = plan([change(file)]);
    validateValidationPlan(selected);
    assert.ok(selected.groups.includes("rust"), file);
    assert.ok(selected.groups.includes("frontend"), file);
    assert.ok(selected.groups.includes("catalog"), file);
  }
});

test("actual Stylelint loader and typed policy retain protected audit qualification", () => {
  for (const file of [
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/scripts/stylelint-config.mts",
  ]) {
    const ownership = validationOwnershipForPath(file);
    assert.ok(ownership.areas.includes("policy"), file);
    assert.equal(ownership.qualificationRequired, true, file);
    assert.deepEqual(ownership.platforms, [...qualificationPlatforms].sort(), file);
  }
});
