import assert from "node:assert/strict";
import test from "node:test";

import {
  buildValidationPlan,
  fastGroups,
  validateValidationPlan,
  validationAreas,
} from "./validation-plan.mjs";

const sha = (character) => character.repeat(40);
const change = (path, overrides = {}) => ({
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  oldPath: path,
  newPath: path,
  ...overrides,
});
const plan = (changes, overrides = {}) =>
  buildValidationPlan({
    changes,
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
    ...overrides,
  });

test("routes every maintained area and unions mixed changes", () => {
  const fixtures = new Map([
    ["docs/QUALITY.md", "documentation"],
    ["apps/desktop/src/App.tsx", "frontend"],
    ["crates/portcove-core/src/lib.rs", "rust"],
    ["apps/desktop/src-tauri/src/main.rs", "native-ipc"],
    ["crates/portcove-core/catalog/catalog.json", "catalog"],
    ["Cargo.lock", "dependency"],
    ["scripts/test-linux-package-ownership.sh", "platform"],
    ["scripts/release-result-gate.mjs", "release-security"],
    [".github/workflows/ci.yml", "policy"],
  ]);
  for (const [path, area] of fixtures) {
    const result = plan([change(path)]);
    assert.ok(result.areas.includes(area), `${path} should map to ${area}`);
    validateValidationPlan(result);
  }
  const mixed = plan([change("apps/desktop/src/App.tsx"), change("Cargo.lock")]);
  assert.equal(mixed.mode, "qualification");
  assert.deepEqual(mixed.groups, fastGroups);
  assert.deepEqual(mixed.identities, {
    base: sha("a"),
    merge_base: sha("b"),
    head: sha("c"),
    checkout: sha("d"),
  });
});

test("frontend and primary Rust paths receive focused fast plans", () => {
  const frontend = plan([change("apps/desktop/src/App.tsx")]);
  assert.equal(frontend.mode, "fast");
  assert.deepEqual(frontend.groups, ["frontend", "rust-quality"]);
  assert.equal(frontend.qualification_required, false);

  const rust = plan([change("crates/portcove-core/src/service.rs")]);
  assert.equal(rust.mode, "fast");
  assert.deepEqual(rust.groups, ["rust", "rust-quality"]);
  assert.equal(rust.qualification_required, false);
});

test("recognized unknown paths use the explicit all-fast primary-host fallback", () => {
  const result = plan([change("new-root-contract.txt")]);
  assert.equal(result.mode, "fast");
  assert.deepEqual(result.groups, fastGroups);
  assert.deepEqual(result.platforms, ["primary-host"]);
  assert.deepEqual(result.fallback, {
    kind: "all-fast-groups",
    paths: ["new-root-contract.txt"],
  });
});

test("rename sides, deletion, and mode changes remain consequential", () => {
  const renamed = plan([
    change("apps/desktop/src/new.ts", {
      status: "R",
      oldPath: "docs/README.md",
      newPath: "apps/desktop/src/new.ts",
    }),
  ]);
  assert.deepEqual(renamed.changed_files, ["apps/desktop/src/new.ts", "docs/README.md"]);
  assert.ok(renamed.areas.includes("documentation"));
  assert.ok(renamed.areas.includes("frontend"));

  const deleted = plan([
    change("crates/portcove-core/src/lib.rs", { status: "D", newMode: "000000" }),
  ]);
  assert.ok(deleted.groups.includes("rust"));

  const mode = plan([change("docs/README.md", { oldMode: "100644", newMode: "100755" })]);
  assert.equal(mode.mode, "qualification");
});

test("failed or unexplained discovery authorizes no work", () => {
  for (const result of [
    plan([]),
    plan([], { discovery: "failed", blockedReason: "diff-discovery-failed:ENOENT" }),
  ]) {
    assert.equal(result.mode, "blocked");
    assert.deepEqual(result.groups, []);
    assert.equal(result.qualification_required, false);
    validateValidationPlan(result);
  }
});

test("main and explicit events select every fast group without a synthetic diff", () => {
  for (const eventName of ["push", "workflow_dispatch", "workflow_call"]) {
    const result = plan([], { eventName, base: null, mergeBase: null, head: null });
    assert.equal(result.mode, "fast");
    assert.deepEqual(result.groups, fastGroups);
    assert.deepEqual(result.areas, validationAreas);
  }
});

test("validation rejects stale digests, duplicate groups, and inconsistent authority", () => {
  const valid = plan([change("apps/desktop/src/App.tsx")]);
  assert.throws(() => validateValidationPlan({ ...valid, reason: "substituted" }), /digest/u);
  const duplicate = { ...valid, groups: ["frontend", "frontend"] };
  assert.throws(
    () => validateValidationPlan({ ...duplicate, digest: valid.digest }),
    /digest|duplicate/u,
  );
  const unauthorized = { ...valid, mode: "qualification", qualification_required: false };
  assert.throws(
    () => validateValidationPlan({ ...unauthorized, digest: valid.digest }),
    /digest|qualification/u,
  );
});
