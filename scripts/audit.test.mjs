import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIT_STAGES,
  RELEASE_AUDIT_STAGE_IDS,
  TRANSITION_AUDIT_STAGE_IDS,
  selectTransitionAudit,
  auditStagesForProfile,
  assertNoSplitIndex,
  domainsForPath,
  executeAudit,
  fingerprintStage,
  parseIndex,
  planAudit,
  repositoryInventory,
  canonicalTextBlob,
  validateReceipt,
} from "./audit.mjs";
import { buildValidationPlan, digestValidationPlan } from "./validation-plan.mjs";

test("release audit profile delegates source and platform coverage without going empty", () => {
  const stages = auditStagesForProfile("release");
  assert.ok(stages.length > 0);
  assert.deepEqual(
    stages.map((stage) => stage.id),
    RELEASE_AUDIT_STAGE_IDS,
  );
  assert.throws(() => auditStagesForProfile("unknown"), /unknown audit profile/u);
});

const runtime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  osRelease: "test",
  node: "v-test",
  git: "git test",
  just: "just test",
  rustc: "rustc test",
  cargo: "cargo test",
  cargoNextest: "cargo-nextest test",
  cargoShear: "cargo-shear test",
  rscheck: "rscheck test",
  aqua: "aqua test",
  powershell: "PowerShell test",
  packageManager: "pnpm@test",
  packageManagerVersion: "test",
  environment: { CI: null },
});

function file(pathname, contents, extra = {}) {
  const ownership = domainsForPath(pathname);
  const gitBlob = createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0${contents}`)
    .digest("hex");
  return {
    path: pathname,
    headBlob: extra.headBlob === undefined ? gitBlob : extra.headBlob,
    headMode: extra.headMode ?? "100644",
    indexBlob: extra.indexBlob === undefined ? gitBlob : extra.indexBlob,
    indexMode: extra.indexMode ?? "100644",
    kind: "file",
    worktreeMode: extra.worktreeMode ?? "100644",
    gitBlob,
    sha256: createHash("sha256").update(contents).digest("hex"),
    domains: [...ownership.domains].sort(),
    ambiguous: ownership.ambiguous,
    untracked: extra.untracked ?? false,
  };
}

function inventory(head, entries) {
  return { head, files: entries };
}

function transitionContext(paths, overrides = {}) {
  const head = "a".repeat(40);
  const changes = paths.map((pathname) => ({
    status: "M",
    oldMode: "100644",
    newMode: "100644",
    oldPath: pathname,
    newPath: pathname,
  }));
  return {
    inventory: inventory(
      head,
      paths.map((pathname) => file(pathname, "fixture")),
    ),
    validationPlan: buildValidationPlan({
      changes,
      eventName: "pull_request",
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
      head,
      checkout: head,
      fastValidationEnabled: true,
      proseOnlyEnabled: true,
    }),
    changes,
    workingTreeStatus: "",
    ...overrides,
  };
}

test("standalone resource and impact changes retain full local coverage under real hosted routing", () => {
  for (const pathname of [
    "scripts/dev-storage.mjs",
    "scripts/dev-storage.test.mjs",
    "scripts/rust-test-impact.mjs",
    "scripts/rust-test-impact.test.mjs",
    ".config/rust-test-impact.json",
    "docs/DEVELOPMENT-STORAGE.md",
  ]) {
    const context = transitionContext([pathname]);
    assert.equal(context.validationPlan.qualification_required, false, pathname);
    const selected = selectTransitionAudit(context);
    assert.equal(selected.profile, "complete", pathname);
    assert.deepEqual(selected.stages, AUDIT_STAGES, pathname);
  }
});

test("real rename and copy path unions retain the complete audit instead of failing discovery", () => {
  for (const status of ["R", "C"]) {
    const context = transitionContext(["scripts/local-validation.mjs", "docs/QUALITY.md"]);
    context.changes[0] = {
      ...context.changes[0],
      status,
      newPath: "scripts/renamed-local-validation.mjs",
    };
    context.validationPlan = buildValidationPlan({
      changes: context.changes,
      eventName: "pull_request",
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
      head: context.inventory.head,
      checkout: context.inventory.head,
    });
    context.inventory.files.push(file("scripts/renamed-local-validation.mjs", "fixture"));
    assert.equal(selectTransitionAudit(context).profile, "complete", status);
    assert.equal(context.validationPlan.changed_files.length, 3);
  }
});

test("a clean local-policy transition keeps fresh contracts and complete hosted qualification", () => {
  const context = transitionContext(["scripts/local-validation.mjs", "docs/QUALITY.md"]);
  const selected = selectTransitionAudit(context);
  assert.equal(selected.profile, "transition");
  assert.deepEqual(
    selected.stages.map((stage) => stage.id),
    TRANSITION_AUDIT_STAGE_IDS,
  );
  assert.ok(
    !selected.stages.some((stage) => ["rust", "ui", "windows-qualification"].includes(stage.id)),
  );
  assert.equal(context.validationPlan.qualification_required, true);
});

test("maintained hosted routing delegates unchanged suites only with exhaustive qualification", () => {
  for (const pathname of [
    "scripts/validation-plan.mjs",
    "scripts/validation-plan.test.mjs",
    "scripts/select-ci-plan.mjs",
    "scripts/select-ci-plan.test.mjs",
    "scripts/ci-workflow.test.mjs",
    ".github/workflows/ci.yml",
  ]) {
    const context = transitionContext([pathname, "docs/QUALITY.md"]);
    assert.equal(context.validationPlan.qualification_required, true);
    assert.equal(selectTransitionAudit(context).profile, "transition");
    const incomplete = structuredClone(context);
    incomplete.validationPlan.groups = ["frontend"];
    delete incomplete.validationPlan.digest;
    incomplete.validationPlan.digest = digestValidationPlan(incomplete.validationPlan);
    assert.throws(() => selectTransitionAudit(incomplete));
    const fast = transitionContext([pathname]);
    fast.validationPlan = transitionContext(["apps/desktop/src/App.tsx"]).validationPlan;
    assert.throws(() => selectTransitionAudit(fast), /inventory/);
  }
});

test("mixed, unknown and audit authority changes retain the complete transition gate", () => {
  for (const pathname of [
    "scripts/audit.mjs",
    "scripts/audit.test.mjs",
    "justfile",
    "Cargo.lock",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/src/App.tsx",
    ".github/workflows/qualification.yml",
    ".github/workflows/release.yml",
    "scripts/ci-result-gate.mjs",
    "scripts/qualification-coverage.mjs",
    "scripts/qualification-coverage.test.mjs",
    ".github/qualification-coverage.json",
    "unknown.txt",
  ]) {
    assert.equal(
      selectTransitionAudit(transitionContext(["docs/QUALITY.md", pathname])).profile,
      "complete",
      pathname,
    );
  }
  for (const status of ["A", "D", "R", "C", "T"]) {
    const context = transitionContext(["scripts/local-validation.mjs"]);
    context.changes[0].status = status;
    assert.equal(selectTransitionAudit(context).profile, "complete", status);
  }
  for (const extra of [
    { workingTreeStatus: " M docs/QUALITY.md" },
    { workingTreeStatus: "?? extra.txt" },
  ]) {
    assert.equal(
      selectTransitionAudit(transitionContext(["docs/QUALITY.md"], extra)).profile,
      "complete",
    );
  }
});

test("candidate coverage constants cannot authorize their own reduced transition", (t) => {
  const root = temporaryDirectory(t);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  for (const filename of [
    "scripts/audit.mjs",
    "scripts/select-ci-plan.mjs",
    "scripts/validation-plan.mjs",
    "scripts/qualification-coverage.mjs",
    ".github/qualification-coverage.json",
    ".github/workflows/ci.yml",
  ]) {
    let contents = readFileSync(new URL(`../${filename}`, import.meta.url), "utf8");
    if (filename === "scripts/validation-plan.mjs") {
      contents = contents.replace('  "rust",\n', "").replace('  "windows-x86_64",\n', "");
    }
    writeFileSync(path.join(root, filename), contents);
  }
  const runner = `
    import assert from 'node:assert/strict';
    import {buildValidationPlan, validateQualificationBinding} from './scripts/validation-plan.mjs';
    import {selectTransitionAudit} from './scripts/audit.mjs';
    const context=JSON.parse(process.env.TRANSITION_FIXTURE);
    context.validationPlan=buildValidationPlan({changes:context.changes,eventName:'pull_request',
      base:'b'.repeat(40),mergeBase:'b'.repeat(40),head:context.inventory.head,checkout:context.inventory.head});
    assert.equal(context.validationPlan.groups.includes('rust'),false);
    assert.equal(context.validationPlan.platforms.includes('windows-x86_64'),false);
    validateQualificationBinding({plan:context.validationPlan,digest:context.validationPlan.digest,checkout:context.inventory.head});
    assert.throws(()=>selectTransitionAudit(context),/preserved qualification coverage/);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      TRANSITION_FIXTURE: JSON.stringify(transitionContext(["scripts/validation-plan.mjs"])),
    },
  });
});

test("incomplete transition discovery cannot authorize a shorter audit", () => {
  const context = transitionContext(["docs/QUALITY.md"]);
  assert.throws(
    () => selectTransitionAudit({ ...context, changes: [] }),
    /exact complete source diff/,
  );
  const emptyPlan = buildValidationPlan({
    changes: [],
    eventName: "pull_request",
    base: "b".repeat(40),
    mergeBase: "b".repeat(40),
    head: context.inventory.head,
    checkout: context.inventory.head,
    fastValidationEnabled: true,
    proseOnlyEnabled: true,
  });
  assert.equal(emptyPlan.mode, "blocked");
  assert.equal(emptyPlan.discovery, "complete");
  assert.throws(
    () => selectTransitionAudit({ ...context, changes: [], validationPlan: emptyPlan }),
    /exact complete source diff/,
  );
  assert.throws(
    () =>
      selectTransitionAudit({
        ...context,
        inventory: { ...context.inventory, files: [file("README.md", "other")] },
      }),
    /missing a changed file/,
  );
  assert.throws(
    () => selectTransitionAudit({ ...context, workingTreeStatus: undefined }),
    /Git worktree status/,
  );
  assert.throws(() =>
    selectTransitionAudit({
      ...context,
      validationPlan: { ...context.validationPlan, qualification_required: false },
    }),
  );
  assert.throws(() =>
    selectTransitionAudit({
      ...context,
      inventory: { ...context.inventory, head: "c".repeat(40) },
    }),
  );
});

test("partial audit profiles cannot overwrite the complete audit report", (t) => {
  const root = temporaryDirectory(t);
  const receiptRoot = path.join(root, "receipts");
  const head = "a".repeat(40);
  const full = planAudit({
    root,
    receiptRoot,
    inventory: inventory(head, []),
    runtime,
    stages: smallStages,
    fresh: true,
  });
  executeAudit(full, { execute: () => ({ status: 0 }) });
  const fullPath = path.join(receiptRoot, "audits", `${head}.json`);
  const fullBytes = readFileSync(fullPath, "utf8");
  for (const profile of ["transition", "release"]) {
    const partial = planAudit({
      root,
      receiptRoot,
      inventory: inventory(head, []),
      runtime,
      stages: [smallStages[0]],
      fresh: true,
      profile,
    });
    const result = executeAudit(partial, { execute: () => ({ status: 0 }) });
    assert.equal(result.report.profile, profile);
    assert.ok(existsSync(path.join(receiptRoot, "audits", `${head}.${profile}.json`)));
    assert.equal(readFileSync(fullPath, "utf8"), fullBytes);
  }
});

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-audit-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const smallStages = Object.freeze([
  { id: "rust", recipe: "check-rust", domain: "rust", reusable: true },
  { id: "ui", recipe: "check-ui", domain: "ui", reusable: true },
  { id: "release", recipe: "release-check", domain: "release", reusable: true },
]);

test("repository inventory binds tracked Git blobs to current content", () => {
  const current = repositoryInventory(fileURLToPath(new URL("../", import.meta.url)));
  const cargo = current.files.find((entry) => entry.path === "Cargo.toml");
  assert.ok(cargo);
  assert.equal(cargo.headBlob, cargo.indexBlob);
  assert.equal(cargo.headBlob, cargo.gitBlob);
  assert.equal(cargo.kind, "file");
  assert.ok(cargo.sha256);
  assert.ok(cargo.domains.includes("rust"));
});

test("canonical text identity permits only explicit UTF-8 LF conversion without filters", () => {
  const attributes = {
    text: "auto",
    eol: "lf",
    filter: "unspecified",
    "working-tree-encoding": "unspecified",
  };
  const contents = Buffer.from("first\r\nsecond\r\n");
  const expected = file("docs/QUALITY.md", "first\nsecond\n").gitBlob;
  assert.equal(canonicalTextBlob(contents, "sha1", attributes), expected);
  for (const override of [
    { text: "unset" },
    { eol: "crlf" },
    { eol: "unspecified" },
    { filter: "custom" },
    { "working-tree-encoding": "UTF-16" },
  ])
    assert.equal(canonicalTextBlob(contents, "sha1", { ...attributes, ...override }), null);
  for (const bytes of [Buffer.from([255, 13, 10]), Buffer.from("binary\0\r\n")])
    assert.equal(canonicalTextBlob(bytes, "sha1", attributes), null);
  assert.notEqual(canonicalTextBlob(Buffer.from("changed\r\n"), "sha1", attributes), expected);
});

test("actual clean Git LF-text checkout qualifies while raw fingerprints remain distinct", (t) => {
  const root = temporaryDirectory(t);
  const run = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  run("init", "-q");
  run("config", "user.name", "Audit fixture");
  run("config", "user.email", "audit@portcove.invalid");
  run("config", "core.autocrlf", "false");
  writeFileSync(path.join(root, ".gitattributes"), "*.md text eol=lf\n");
  writeFileSync(path.join(root, "example.md"), "same\ntext\n");
  run("add", ".");
  run("commit", "-qm", "LF fixture");
  const lf = repositoryInventory(root);
  writeFileSync(path.join(root, "example.md"), "same\r\ntext\r\n");
  run("add", "example.md");
  assert.equal(run("status", "--porcelain").trim(), "");
  const crlf = repositoryInventory(root);
  const entry = crlf.files.find((item) => item.path === "example.md");
  assert.notEqual(entry.gitBlob, entry.indexBlob);
  assert.equal(entry.canonicalTextBlob, entry.indexBlob);
  assert.notEqual(entry.sha256, lf.files.find((item) => item.path === "example.md").sha256);
  const context = transitionContext(["docs/QUALITY.md"]);
  context.inventory.files.push(entry);
  assert.equal(selectTransitionAudit(context).profile, "transition");
  entry.canonicalTextBlob = "0".repeat(40);
  assert.equal(selectTransitionAudit(context).profile, "complete");
});

test("domain inventories retain unrelated documentation rebases and invalidate Rust changes", () => {
  const stage = smallStages[0];
  const original = inventory("head-a", [
    file("crates/portcove-core/src/lib.rs", "rust-a"),
    file("docs/README.md", "docs-a"),
  ]);
  const unrelatedRebase = inventory("head-b", [
    file("crates/portcove-core/src/lib.rs", "rust-a"),
    file("docs/README.md", "docs-b"),
  ]);
  const relevantRebase = inventory("head-c", [
    file("crates/portcove-core/src/lib.rs", "rust-b"),
    file("docs/README.md", "docs-b"),
  ]);
  assert.equal(
    fingerprintStage(stage, original, runtime),
    fingerprintStage(stage, unrelatedRebase, runtime),
  );
  assert.notEqual(
    fingerprintStage(stage, original, runtime),
    fingerprintStage(stage, relevantRebase, runtime),
  );
});

test("release handbook edits invalidate their consumers without expiring unchanged product receipts", () => {
  const handbook = file("docs/RELEASING.md", "selected predecessor and candidate");
  assert.deepEqual(handbook.domains, ["format", "release", "repository"]);
  const before = inventory("before", [handbook]);
  const after = inventory("after", [file("docs/RELEASING.md", "corrected selected versions")]);
  for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable)) {
    const changed = handbook.domains.includes(stage.domain);
    assert.equal(
      fingerprintStage(stage, before, runtime) !== fingerprintStage(stage, after, runtime),
      changed,
      stage.id,
    );
  }
  for (const protectedInput of ["docs/QUALITY.md", "scripts/audit.mjs", "unknown-release.bin"])
    for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable))
      assert.ok(file(protectedInput, "changed policy").domains.includes(stage.domain), stage.id);
  const rust = AUDIT_STAGES.find((entry) => entry.id === "rust");
  assert.notEqual(
    fingerprintStage(
      rust,
      inventory("a", [handbook, file("crates/portcove-core/src/lib.rs", "a")]),
      runtime,
    ),
    fingerprintStage(
      rust,
      inventory("b", [handbook, file("crates/portcove-core/src/lib.rs", "b")]),
      runtime,
    ),
  );
});

test("formatting and transport inputs invalidate every stage that actually reads them", () => {
  const documentation = file("docs/README.md", "docs");
  assert.ok(documentation.domains.includes("format"));
  assert.ok(documentation.domains.includes("repository"));
  assert.ok(!documentation.domains.includes("ui"));
  assert.ok(!documentation.domains.includes("rust"));

  const policy = file("docs/QUALITY.md", "policy");
  for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable))
    assert.ok(policy.domains.includes(stage.domain), stage.id);

  const transport = file("apps/desktop/src/transport-schemas.generated.json", "schema");
  assert.ok(transport.domains.includes("format") === false);
  assert.ok(transport.domains.includes("ui"));
  assert.ok(transport.domains.includes("rust"));

  const frontendLock = file("pnpm-lock.yaml", "lockfile");
  assert.ok(frontendLock.domains.includes("format"));
  assert.ok(frontendLock.domains.includes("ui"));
  assert.ok(frontendLock.domains.includes("release"));

  assert.ok(file(".editorconfig", "config").domains.includes("format"));
  assert.ok(file("pyproject.toml", "config").domains.includes("lint"));
  for (const gitInput of [".gitattributes", ".gitignore"])
    for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable))
      assert.ok(file(gitInput, "config").domains.includes(stage.domain));

  const formatStage = AUDIT_STAGES.find((stage) => stage.id === "format");
  const uiStage = AUDIT_STAGES.find((stage) => stage.id === "ui");
  const before = inventory("before", [documentation]);
  const after = inventory("after", [file("docs/README.md", "changed docs")]);
  assert.notEqual(
    fingerprintStage(formatStage, before, runtime),
    fingerprintStage(formatStage, after, runtime),
  );
  assert.equal(
    fingerprintStage(uiStage, before, runtime),
    fingerprintStage(uiStage, after, runtime),
  );
});

test("committing identical working content does not invalidate a content-based stage", () => {
  const stage = smallStages[0];
  const working = file("crates/portcove-core/src/lib.rs", "same", {
    untracked: true,
    headBlob: null,
    indexBlob: null,
  });
  const committed = {
    ...working,
    untracked: false,
    headBlob: working.gitBlob,
    indexBlob: working.gitBlob,
  };
  assert.equal(
    fingerprintStage(stage, inventory("before", [working]), runtime),
    fingerprintStage(stage, inventory("after", [committed]), runtime),
  );
});

test("staged content and modes participate even when working content is unchanged", () => {
  const stage = smallStages[0];
  const original = file("crates/portcove-core/src/lib.rs", "working");
  const stagedBlob = createHash("sha1").update("staged").digest("hex");
  const stagedContent = { ...original, indexBlob: stagedBlob };
  const stagedMode = { ...original, indexMode: "100755" };
  assert.notEqual(
    fingerprintStage(stage, inventory("head", [original]), runtime),
    fingerprintStage(stage, inventory("head", [stagedContent]), runtime),
  );
  assert.notEqual(
    fingerprintStage(stage, inventory("head", [original]), runtime),
    fingerprintStage(stage, inventory("head", [stagedMode]), runtime),
  );
});

test("unresolved index entries fail closed", () => {
  assert.throws(
    () => parseIndex("100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2\tnew-file.txt\0"),
    /cannot audit unresolved index path: new-file\.txt/,
  );
});

test("partially staged paths fail closed while disjoint changes remain auditable", () => {
  assert.doesNotThrow(() => assertNoSplitIndex(["staged.txt"], ["unstaged.txt"]));
  assert.throws(
    () => assertNoSplitIndex(["split.txt", "other.txt"], ["split.txt"]),
    /cannot audit partially staged paths: split\.txt/,
  );
});

test("untracked and ambiguously classified inputs conservatively invalidate every reusable domain", () => {
  const unknown = file("new-subsystem/input.bin", "first", {
    untracked: true,
    headBlob: null,
    indexBlob: null,
  });
  assert.equal(unknown.ambiguous, true);
  for (const domain of [
    "format",
    "rust",
    "ui",
    "lint",
    "repository",
    "roadmap",
    "development",
    "release",
    "rscheck",
  ])
    assert.ok(unknown.domains.includes(domain));
  const changed = { ...unknown, sha256: createHash("sha256").update("second").digest("hex") };
  for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable)) {
    assert.notEqual(
      fingerprintStage(stage, inventory("one", [unknown]), runtime),
      fingerprintStage(stage, inventory("two", [changed]), runtime),
    );
  }
});

test("runtime tool and behavior-environment drift invalidates a matching content inventory", () => {
  const source = inventory("head", [file("crates/portcove-core/src/lib.rs", "same")]);
  const stage = smallStages[0];
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, rustc: "rustc changed" }),
  );
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, cargoNextest: "nextest changed" }),
  );
  const uiStage = smallStages[1];
  const uiSource = inventory("head", [file("apps/desktop/src/App.tsx", "same")]);
  assert.equal(
    fingerprintStage(uiStage, uiSource, runtime),
    fingerprintStage(uiStage, uiSource, { ...runtime, rustc: "irrelevant Rust drift" }),
  );
  assert.notEqual(
    fingerprintStage(uiStage, uiSource, runtime),
    fingerprintStage(uiStage, uiSource, { ...runtime, packageManagerVersion: "changed" }),
  );
  const lintStage = AUDIT_STAGES.find((entry) => entry.id === "script-lint");
  const lintSource = inventory("head", [file("scripts/check.sh", "same")]);
  assert.notEqual(
    fingerprintStage(lintStage, lintSource, runtime),
    fingerprintStage(lintStage, lintSource, { ...runtime, powershell: "PowerShell changed" }),
  );
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, environment: { CI: "true" } }),
  );
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, architecture: "arm64" }),
  );
});

test("a late failure records successful independent stages and resumes only the failed stage", (t) => {
  const receiptRoot = temporaryDirectory(t);
  const source = inventory("first-head", [
    file("crates/portcove-core/src/lib.rs", "rust"),
    file("apps/desktop/src/App.tsx", "ui"),
    file("release/version.json", "release"),
  ]);
  const first = planAudit({
    stages: smallStages,
    inventory: source,
    runtime,
    receiptRoot,
    fresh: true,
  });
  const seen = [];
  const firstResult = executeAudit(first, {
    execute(stage) {
      seen.push(stage.id);
      return { status: stage.id === "ui" ? 7 : 0 };
    },
    clock: (() => {
      let time = 0;
      return () => (time += 10);
    })(),
  });
  assert.equal(firstResult.success, false);
  assert.deepEqual(seen, ["rust", "ui", "release"]);

  const resumed = planAudit({
    stages: smallStages,
    inventory: { ...source, head: "repaired-head" },
    runtime,
    receiptRoot,
  });
  assert.deepEqual(
    resumed.stages.map(({ id, action }) => [id, action]),
    [
      ["rust", "reuse"],
      ["ui", "run"],
      ["release", "reuse"],
    ],
  );
  const secondSeen = [];
  const secondResult = executeAudit(resumed, {
    execute(stage) {
      secondSeen.push(stage.id);
      return { status: 0 };
    },
  });
  assert.equal(secondResult.success, true);
  assert.deepEqual(secondSeen, ["ui"]);
  assert.deepEqual(
    secondResult.report.stages.map((stage) => stage.status),
    ["reused", "passed", "reused"],
  );
});

test("tampered and interrupted receipts are rejected and never reused", (t) => {
  const receiptRoot = temporaryDirectory(t);
  const source = inventory("head", [file("crates/portcove-core/src/lib.rs", "rust")]);
  const stages = [smallStages[0]];
  const initial = planAudit({ stages, inventory: source, runtime, receiptRoot, fresh: true });
  executeAudit(initial, { execute: () => ({ status: 0 }) });
  const receiptFile = path.join(
    receiptRoot,
    "stages",
    "rust",
    `${initial.stages[0].fingerprint}.json`,
  );
  const tampered = JSON.parse(readFileSync(receiptFile, "utf8"));
  tampered.payload.durationMs += 1;
  writeFileSync(receiptFile, JSON.stringify(tampered));
  const rejected = planAudit({ stages, inventory: source, runtime, receiptRoot });
  assert.equal(rejected.stages[0].action, "run");
  assert.match(rejected.stages[0].rationale, /integrity mismatch/u);

  const interrupted = executeAudit(rejected, {
    execute: () => ({ status: null, error: new Error("interrupted") }),
  });
  assert.equal(interrupted.success, false);
  assert.equal(existsSync(receiptFile), false);
  assert.equal(validateReceipt(null).valid, false);
});

test("fresh mode executes all stages while stateful observations always run", (t) => {
  const receiptRoot = temporaryDirectory(t);
  const source = inventory("head", [
    file("crates/portcove-core/src/lib.rs", "rust"),
    file("release/version.json", "release"),
  ]);
  const stages = [
    smallStages[0],
    {
      id: "dependency-policy",
      recipe: "deny",
      domain: "rust",
      reusable: false,
      reason: "external state",
    },
    {
      id: "windows-qualification",
      recipe: "windows-qualification-check",
      domain: "release",
      reusable: false,
      platforms: ["win32"],
      reason: "machine state",
    },
  ];
  const first = planAudit({ stages, inventory: source, runtime, receiptRoot, fresh: true });
  assert.ok(first.stages.every((stage) => stage.action === "run"));
  executeAudit(first, { execute: () => ({ status: 0 }) });
  const warm = planAudit({ stages, inventory: source, runtime, receiptRoot });
  assert.deepEqual(
    warm.stages.map((stage) => stage.action),
    ["reuse", "run", "run"],
  );
  const fresh = planAudit({ stages, inventory: source, runtime, receiptRoot, fresh: true });
  assert.ok(fresh.stages.every((stage) => stage.action === "run"));
});

test("plan construction is side-effect free when no receipt directory exists", (t) => {
  const root = temporaryDirectory(t);
  const receiptRoot = path.join(root, "not-created");
  const plan = planAudit({
    stages: [smallStages[0]],
    inventory: inventory("head", [file("crates/portcove-core/src/lib.rs", "rust")]),
    runtime,
    receiptRoot,
  });
  assert.equal(plan.stages[0].action, "run");
  assert.equal(existsSync(receiptRoot), false);
});
