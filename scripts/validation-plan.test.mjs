import assert from "node:assert/strict";
import test from "node:test";

import {
  buildValidationPlan,
  digestValidationPlan,
  fastGroups,
  qualificationPlatforms,
  validateQualificationBinding,
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
const redigest = (input) => {
  const candidate = structuredClone(input);
  delete candidate.digest;
  return { ...candidate, digest: digestValidationPlan(candidate) };
};

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
  assert.equal(mixed.mode, "fast");
  assert.deepEqual(mixed.groups, ["dependency-review", "frontend", "rust", "rust-quality"]);
  assert.deepEqual(mixed.platforms, ["primary-host"]);
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
  assert.deepEqual(frontend.platforms, ["primary-host"]);
  assert.equal(frontend.qualification_required, false);

  const rust = plan([change("crates/portcove-core/src/service.rs")]);
  assert.equal(rust.mode, "fast");
  assert.deepEqual(rust.groups, ["rust", "rust-quality"]);
  assert.deepEqual(rust.platforms, ["primary-host"]);
  assert.equal(rust.qualification_required, false);
});

test("maintained native scenario consumers retain contracts without unrelated Rust tests", () => {
  const files = [
    "apps/desktop/scripts/desktop-artwork-correction-test.mjs",
    "apps/desktop/scripts/desktop-default-cover-test.mjs",
    "apps/desktop/scripts/desktop-install-fixture.test.mjs",
    "apps/desktop/scripts/desktop-preparation-test.mjs",
    "apps/desktop/scripts/desktop-test.mjs",
    "apps/desktop/scripts/testdata/catalog-artwork-blue.jpg",
    "apps/desktop/scripts/testdata/catalog-artwork-red.jpg",
    "scripts/desktop-scenarios.mjs",
    "scripts/desktop-scenarios.test.mjs",
  ];
  const result = plan(files.map((file) => change(file)));
  assert.equal(result.mode, "fast");
  assert.deepEqual(result.groups, ["frontend", "rust-quality"]);
  assert.equal(result.fallback, null);
  validateValidationPlan(result);
  for (const file of files) {
    for (const status of ["A", "M", "D"]) {
      const selected = plan([
        change(file, {
          status,
          oldMode: status === "A" ? "000000" : "100644",
          newMode: status === "D" ? "000000" : "100644",
        }),
      ]);
      assert.deepEqual(selected.groups, ["frontend", "rust-quality"]);
      validateValidationPlan(selected);
    }
  }
  assert.ok(
    plan([change(files[0]), change("crates/portcove-core/src/artwork.rs")]).groups.includes("rust"),
  );
  assert.equal(
    plan([change(files[0]), change("apps/desktop/src-tauri/src/lib.rs")]).mode,
    "qualification",
  );
  assert.equal(plan([change(files[0]), change("scripts/sign-catalog.mjs")]).mode, "qualification");
  assert.equal(
    plan([change(files[0]), change("scripts/validation-plan.mjs")]).mode,
    "qualification",
  );
  const unknown = plan([change(files[0]), change("apps/desktop/scripts/future-scenario.mjs")]);
  assert.ok(unknown.groups.includes("rust"));
  const renamed = plan([
    change(files[0], { status: "R", newPath: "apps/desktop/scripts/new-scenario.mjs" }),
  ]);
  assert.ok(renamed.groups.includes("rust"));
  assert.equal(plan([change(files[0], { newMode: "120000" })]).mode, "qualification");
});

test("default-cover harness ownership preserves unknown, renamed, product and policy fallback", () => {
  const cover = "apps/desktop/scripts/desktop-default-cover-test.mjs";
  const unknown = "apps/desktop/scripts/future-cover-test.mjs";
  for (const changes of [
    [change(cover), change(unknown)],
    [change(cover, { status: "R", newPath: unknown })],
    [change(unknown, { status: "R", newPath: cover })],
  ]) {
    const selected = plan(changes);
    assert.deepEqual(selected.groups, fastGroups);
    assert.ok(selected.fallback.paths.includes(unknown));
  }
  const product = plan([change(cover), change("crates/portcove-core/src/artwork.rs")]);
  assert.deepEqual(product.groups, ["frontend", "rust", "rust-quality"]);
  for (const protectedFile of ["apps/desktop/src-tauri/src/lib.rs", "scripts/validation-plan.mjs"])
    assert.equal(plan([change(cover), change(protectedFile)]).mode, "qualification");
  assert.equal(plan([change(cover, { newMode: "120000" })]).mode, "qualification");
});

test("install fixture test ownership does not narrow its executable consumers", () => {
  const assertion = "apps/desktop/scripts/desktop-install-fixture.test.mjs";
  for (const executable of [
    "apps/desktop/scripts/desktop-install-fixture.mjs",
    "apps/desktop/scripts/desktop-install-test.mjs",
  ]) {
    const result = plan([change(assertion), change(executable)]);
    assert.deepEqual(result.groups, fastGroups, executable);
    assert.ok(result.fallback.paths.includes(executable), executable);
  }
  const lifecycle = plan([change(assertion), change("integrations/playnite/lifecycle-check.mjs")]);
  assert.ok(lifecycle.groups.includes("rust"));
  assert.deepEqual(lifecycle.platforms, qualificationPlatforms);
  const unknownTest = "apps/desktop/scripts/future-install-fixture.test.mjs";
  const renamed = plan([change(assertion, { status: "R", newPath: unknownTest })]);
  assert.deepEqual(renamed.groups, fastGroups);
  assert.ok(renamed.fallback.paths.includes(unknownTest));
});

test("validation authorities and GitHub policy always require qualification", () => {
  for (const path of [
    "scripts/validation-plan.mjs",
    "scripts/select-ci-plan.mjs",
    "scripts/ci-result-gate.mjs",
    "scripts/local-validation.mjs",
    "scripts/check-ci-prose.mjs",
    "scripts/workflow-provenance.mjs",
    "scripts/run-rust-tests.mjs",
    ".oxlintrc.json",
  ]) {
    const result = plan([change(path)]);
    assert.equal(result.mode, "qualification", path);
    assert.ok(result.areas.includes("policy"), path);
    assert.deepEqual(result.groups, fastGroups, path);
    assert.deepEqual(result.platforms, qualificationPlatforms, path);
  }
});

test("ordinary repository tools and new unlisted paths retain explicit fast fallback", () => {
  const ordinaryTool = plan([change("scripts/dev-doctor.mjs")]);
  assert.equal(ordinaryTool.mode, "fast");
  assert.deepEqual(ordinaryTool.groups, fastGroups);
  assert.deepEqual(ordinaryTool.platforms, ["primary-host"]);
  assert.deepEqual(ordinaryTool.fallback, {
    kind: "all-fast-groups",
    paths: ["scripts/dev-doctor.mjs"],
  });

  const unlisted = plan([change("scripts/unlisted-new-check.mjs")]);
  assert.equal(unlisted.mode, "fast");
  assert.deepEqual(unlisted.fallback, {
    kind: "all-fast-groups",
    paths: ["scripts/unlisted-new-check.mjs"],
  });

  const catalogMigration = plan([change("scripts/migrate-catalog-schema2.mjs")]);
  assert.equal(catalogMigration.mode, "fast");
  assert.ok(catalogMigration.groups.includes("catalog"));
  assert.deepEqual(catalogMigration.platforms, ["primary-host"]);

  const currentCatalog = plan([change("scripts/generate-catalog.mjs")]);
  assert.equal(currentCatalog.mode, "fast");
  assert.ok(currentCatalog.groups.includes("catalog"));
  assert.deepEqual(currentCatalog.platforms, ["primary-host"]);
});

test("routine dependency manifests stay ecosystem-focused while shared toolchains qualify", () => {
  for (const [path, groups] of [
    ["Cargo.toml", ["dependency-review", "rust", "rust-quality"]],
    ["crates/portcove-core/Cargo.toml", ["dependency-review", "rust", "rust-quality"]],
    ["Cargo.lock", ["dependency-review", "rust", "rust-quality"]],
    ["package.json", ["dependency-review", "frontend", "rust-quality"]],
    ["pnpm-lock.yaml", ["dependency-review", "frontend", "rust-quality"]],
    ["apps/desktop/package.json", ["dependency-review", "frontend", "rust-quality"]],
  ]) {
    const result = plan([change(path)]);
    assert.equal(result.mode, "fast", path);
    assert.ok(result.areas.includes("dependency"), path);
    assert.deepEqual(result.groups, groups, path);
    assert.deepEqual(result.platforms, ["primary-host"], path);
  }

  for (const path of [
    "rust-toolchain.toml",
    ".node-version",
    ".aqua-version",
    "pnpm-workspace.yaml",
  ]) {
    const result = plan([change(path)]);
    assert.equal(result.mode, "qualification", path);
    assert.ok(result.areas.includes("dependency"), path);
    assert.deepEqual(result.platforms, qualificationPlatforms, path);
  }
});

test("catalog changes stay focused and platform-specific native changes add only affected hosts", () => {
  const catalog = plan([change("crates/portcove-core/catalog/catalog.json")]);
  assert.equal(catalog.mode, "fast");
  assert.deepEqual(catalog.groups, ["catalog", "rust", "rust-quality"]);
  assert.deepEqual(catalog.platforms, ["primary-host"]);

  const windows = plan([change("apps/desktop/src-tauri/src/window_windows.rs")]);
  assert.equal(windows.mode, "fast");
  assert.deepEqual(windows.groups, ["frontend", "rust", "rust-quality"]);
  assert.deepEqual(windows.platforms, ["windows-x86_64"]);
  assert.equal(windows.qualification_required, false);

  const updaterTrust = plan([change("apps/desktop/src-tauri/src/application_update_windows.rs")]);
  assert.equal(updaterTrust.mode, "qualification");

  const macos = plan([change("crates/portcove-core/src/macos_launch.rs")]);
  assert.equal(macos.mode, "fast");
  assert.deepEqual(macos.platforms, ["macos-aarch64", "macos-x86_64"]);

  const sharedNative = plan([change("apps/desktop/src-tauri/src/main.rs")]);
  assert.equal(sharedNative.mode, "qualification");
  assert.deepEqual(sharedNative.platforms, qualificationPlatforms);
});

test("normative workflow policy qualifies while inert documentation and templates stay cheap", () => {
  const result = plan([change("docs/QUALITY.md")]);
  assert.equal(result.mode, "qualification");
  assert.ok(result.areas.includes("policy"));

  for (const path of [
    "docs/GUI-COMPETITIVE-REVIEW.md",
    ".github/ISSUE_TEMPLATE/engineering-work.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    const inert = plan([change(path)]);
    assert.notEqual(inert.mode, "qualification", path);
    assert.deepEqual(inert.platforms, ["primary-host"], path);
  }
});

test("explicit ownership ignores misleading words and protects real trust boundaries", () => {
  const misleading = plan([change("docs/design-channel-release-notes.md")]);
  assert.equal(misleading.mode, "fast");
  assert.equal(misleading.areas.includes("release-security"), false);

  const ordinaryGithub = plan([change(".github/pr-conventions.json")]);
  assert.equal(ordinaryGithub.mode, "fast");

  for (const path of [
    "scripts/validation-plan.mjs",
    "scripts/check-release-metadata.mjs",
    "scripts/check-release-metadata.test.mjs",
    "scripts/release-package-policy.mjs",
    "scripts/package-cli.ps1",
    "scripts/rehearse-updater-artifacts.ps1",
    "scripts/sign-catalog.mjs",
    "scripts/source-provenance-audit.test.mjs",
    "apps/desktop/scripts/release-version-policy.mjs",
    "docs/SIGNED-CATALOG.md",
    "docs/DEFINITION-DELIVERY.md",
    "docs/UPGRADING.md",
    ".agents/skills/portcove-port-qualification/SKILL.md",
    ".agents/skills/portcove-release-validation/SKILL.md",
    "crates/portcove-core/src/signed_catalog.rs",
    "docs/UPDATER-TRUST.md",
    ".github/workflows/ci.yml",
    ".github/unrecognized-authority.yml",
  ]) {
    const protectedPlan = plan([change(path), change("docs/README.md")]);
    assert.equal(protectedPlan.mode, "qualification", path);
    assert.deepEqual(protectedPlan.groups, fastGroups, path);
    assert.deepEqual(protectedPlan.platforms, qualificationPlatforms, path);
  }
});

test("documentation raster media retains docs checks without catalog Rust tests", () => {
  for (const file of [
    "docs/media/first-play/catalog.png",
    "docs/media/catalog-cover.jpg",
    "docs/media/source-provenance.jpeg",
    "docs/media/retcomm.webp",
  ]) {
    const result = plan([change(file)]);
    assert.equal(result.mode, "fast", file);
    assert.deepEqual(result.groups, ["catalog", "rust-quality"], file);
    assert.deepEqual(result.areas, ["documentation"], file);
  }

  const journey = plan([
    change("README.md"),
    change("docs/DOWNLOADS.md"),
    change("docs/media/first-play/README.md"),
    change("docs/media/first-play/catalog.png"),
    change("docs/media/first-play/source-check.png"),
    change("docs/media/first-play/first-launch.jpg"),
  ]);
  assert.equal(journey.mode, "fast");
  assert.deepEqual(journey.groups, ["catalog", "rust-quality"]);
});

test("documentation-media routing preserves consequential inputs and both rename sides", () => {
  for (const file of [
    "docs/catalog.md",
    "docs/media/catalog.json",
    "docs/media/catalog.svg",
    "docs/media/catalog.png.mjs",
    "docs/media/catalog.PNG",
    "docs/other/catalog.png",
    "catalog.png",
    "apps/desktop/public/catalog.png",
    "crates/portcove-core/catalog/catalog.png",
  ]) {
    assert.ok(plan([change(file)]).groups.includes("rust"), file);
  }
  const mixed = plan([change("docs/media/catalog.png"), change("crates/portcove-core/src/lib.rs")]);
  assert.ok(mixed.groups.includes("rust"));
  const rename = plan([
    change("apps/desktop/public/catalog.png", {
      status: "R",
      oldPath: "docs/media/catalog.png",
      newPath: "apps/desktop/public/catalog.png",
    }),
  ]);
  assert.ok(rename.groups.includes("frontend"));
  assert.ok(rename.groups.includes("rust"));
  const schema = plan([change("docs/media/schema.png")]);
  assert.equal(schema.mode, "qualification");
  assert.ok(schema.groups.includes("rust"));
  const windows = plan([change("docs/media/windows/catalog.png")]);
  assert.ok(windows.groups.includes("rust"));
  assert.ok(windows.platforms.includes("windows-x86_64"));
  for (const changes of [
    [change("docs/media/catalog.png", { newMode: "100755" })],
    [change("docs/media/catalog.png", { newMode: "120000" })],
    [change("docs/media/catalog.png"), change("scripts/validation-plan.mjs")],
  ]) {
    const result = plan(changes);
    assert.equal(result.mode, "qualification");
    assert.deepEqual(result.groups, fastGroups);
    assert.deepEqual(result.platforms, qualificationPlatforms);
  }
  assert.deepEqual(plan([change("unrecognized-media.bin")]).groups, fastGroups);
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
  assert.deepEqual(mode.groups, fastGroups);
  assert.deepEqual(mode.platforms, qualificationPlatforms);
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

test("validation rejects correctly digested malformed structures and identities", () => {
  const valid = plan([change("apps/desktop/src/App.tsx")]);
  const missingPaths = structuredClone(valid);
  delete missingPaths.paths;
  assert.throws(() => validateValidationPlan(redigest(missingPaths)), /paths must be an array/u);

  assert.throws(
    () =>
      validateValidationPlan(
        redigest({ ...valid, identities: { ...valid.identities, head: "short" } }),
      ),
    /identity head/u,
  );

  const unknown = plan([change("new-root-contract.txt")]);
  assert.throws(
    () => validateValidationPlan(redigest({ ...unknown, fallback: null })),
    /fallback is missing/u,
  );

  const qualification = plan([change(".github/workflows/ci.yml")]);
  assert.throws(
    () => validateValidationPlan(redigest({ ...qualification, groups: ["rust"] })),
    /every protected group/u,
  );

  assert.throws(
    () => validateValidationPlan(redigest({ ...valid, groups: [] })),
    /select a group/u,
  );
  assert.throws(
    () => validateValidationPlan(redigest({ ...valid, groups: ["rust"] })),
    /path inventory/u,
  );
  assert.throws(
    () => validateValidationPlan(redigest({ ...valid, discovery: "failed" })),
    /failed discovery/u,
  );

  const explicit = plan([], { eventName: "push", base: null, mergeBase: null, head: null });
  assert.throws(
    () => validateValidationPlan(redigest({ ...explicit, platforms: ["windows-x86_64"] })),
    /explicit-event/u,
  );

  const blocked = plan([]);
  assert.throws(
    () => validateValidationPlan(redigest({ ...blocked, platforms: ["primary-host"] })),
    /blocked plans/u,
  );
});

test("release binding accepts only the exact complete reusable qualification", () => {
  const result = plan([], {
    eventName: "workflow_call",
    base: null,
    mergeBase: null,
    head: null,
  });
  const qualification = {
    ...result,
    mode: "qualification",
    qualification_required: true,
    platforms: ["linux-x86_64", "macos-aarch64", "macos-x86_64", "windows-x86_64"],
  };
  delete qualification.digest;
  qualification.digest = digestValidationPlan(qualification);
  assert.equal(
    validateQualificationBinding({
      plan: qualification,
      digest: qualification.digest,
      checkout: sha("d"),
    }),
    qualification,
  );
  assert.throws(
    () =>
      validateQualificationBinding({
        plan: qualification,
        digest: qualification.digest,
        checkout: sha("e"),
      }),
    /checkout mismatch/u,
  );
});
