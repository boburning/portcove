import { isRecord } from "./runtime-values.mts";
import type { TestContext } from "node:test";
import type { InventoryFile, RepositoryInventory } from "./validation-evidence.mts";
import type { AuditStage } from "./audit.mts";
import type { ValidationPlan, ValidationChange } from "./validation-plan.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
} from "./audit.mts";
import {
  buildValidationPlan,
  digestValidationPlan,
  fastGroups,
  qualificationPlatforms,
} from "./validation-plan.mts";

void test("release audit profile delegates source and platform coverage without going empty", () => {
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

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function file(
  pathname: string,
  contents: string,
  extra: Partial<InventoryFile> = {},
): InventoryFile {
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

function inventory(head: string, entries: InventoryFile[]): RepositoryInventory {
  return { head, objectFormat: "sha1", files: entries };
}

function qualifyAuditFixture(plan: ValidationPlan): ValidationPlan {
  if (plan.mode === "blocked") return plan;
  const { digest: _digest, ...unsigned } = plan;
  const qualified = {
    ...unsigned,
    mode: "qualification" as const,
    reason: "explicit-test-qualification",
    groups: fastGroups,
    platforms: qualificationPlatforms,
    qualification_required: true,
  };
  return { ...qualified, digest: digestValidationPlan(qualified) };
}
function transitionContext(paths: string[], overrides: { workingTreeStatus?: string } = {}) {
  const head = "a".repeat(40);
  const changes: ValidationChange[] = paths.map((pathname) => ({
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
    validationPlan: qualifyAuditFixture(
      buildValidationPlan({
        changes,
        eventName: "pull_request",
        base: "b".repeat(40),
        mergeBase: "b".repeat(40),
        head,
        checkout: head,
      }),
    ),
    changes,
    workingTreeStatus: "",
    ...overrides,
  };
}

void test("standalone resource and impact changes retain full local coverage under real hosted routing", () => {
  for (const pathname of [
    "scripts/dev-storage.mts",
    "scripts/dev-storage.test.mts",
    "scripts/rust-test-impact.mts",
    "scripts/rust-test-impact.test.mts",
    ".config/rust-test-impact.json",
    "docs/DEVELOPMENT-STORAGE.md",
  ]) {
    const context = transitionContext([pathname]);
    const ordinary = buildValidationPlan({
      changes: context.changes,
      eventName: "pull_request",
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
      head: context.inventory.head,
      checkout: context.inventory.head,
    });
    context.validationPlan = ordinary;
    assert.equal(ordinary.qualification_required, false, pathname);
    const selected = selectTransitionAudit(context);
    assert.equal(selected.profile, "complete", pathname);
    assert.deepEqual(selected.stages, AUDIT_STAGES, pathname);
  }
});

void test("renames retain complete audit coverage and unsupported copies block discovery", () => {
  for (const status of ["R", "C"]) {
    const context = transitionContext(["scripts/local-validation.mts", "docs/QUALITY.md"]);
    context.changes[0] = {
      ...requiredFixture(context.changes[0]),
      status,
      newPath: "scripts/renamed-local-validation.mts",
    };
    context.validationPlan = buildValidationPlan({
      changes: context.changes,
      eventName: "pull_request",
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
      head: context.inventory.head,
      checkout: context.inventory.head,
    });
    context.inventory.files.push(file("scripts/renamed-local-validation.mts", "fixture"));
    if (status === "C")
      assert.throws(() => selectTransitionAudit(context), /exact complete source diff/);
    else assert.equal(selectTransitionAudit(context).profile, "complete", status);
    assert.equal(context.validationPlan.changed_files.length, status === "C" ? 0 : 3);
  }
});

void test("a clean local-policy transition keeps fresh contracts and complete hosted qualification", () => {
  const context = transitionContext(["scripts/local-validation.mts", "docs/QUALITY.md"]);
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

void test("maintained hosted routing delegates unchanged suites only with exhaustive qualification", () => {
  for (const pathname of [
    "scripts/validation-plan.mts",
    "scripts/validation-plan.test.mts",
    "scripts/select-ci-plan.mts",
    "scripts/select-ci-plan.test.mts",
    "scripts/ci-workflow.test.mts",
    ".github/workflows/ci.yml",
  ]) {
    const context = transitionContext([pathname, "docs/QUALITY.md"]);
    assert.equal(context.validationPlan.qualification_required, true);
    assert.equal(selectTransitionAudit(context).profile, "transition");
    const incomplete = structuredClone(context);
    incomplete.validationPlan.groups = ["frontend"];
    incomplete.validationPlan.digest = digestValidationPlan(incomplete.validationPlan);
    assert.throws(() => selectTransitionAudit(incomplete));
    const fast = transitionContext([pathname]);
    fast.validationPlan = transitionContext(["apps/desktop/src/App.tsx"]).validationPlan;
    assert.throws(() => selectTransitionAudit(fast), /inventory/);
  }
});

void test("mixed, unknown and audit authority changes retain the complete transition gate", () => {
  for (const pathname of [
    "scripts/audit.mts",
    "scripts/validation-evidence.mts",
    "scripts/audit.test.mts",
    "justfile",
    "Cargo.lock",
    "crates/portcove-core/src/lib.rs",
    "apps/desktop/src/App.tsx",
    ".github/workflows/qualification.yml",
    ".github/workflows/release.yml",
    "scripts/ci-result-gate.mts",
    "scripts/qualification-coverage.mts",
    "scripts/qualification-rustdoc.mts",
    "scripts/rustdoc-outcomes.mts",
    "scripts/qualification-coverage.test.mts",
    "scripts/validation-platforms.mts",
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
    const context = transitionContext(["scripts/local-validation.mts"]);
    requiredFixture(context.changes[0]).status = status;
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

void test("candidate coverage constants cannot authorize their own reduced transition", (t) => {
  const root = temporaryDirectory(t);
  cpSync(
    path.dirname(fileURLToPath(import.meta.resolve("yaml/package.json"))),
    path.join(root, "node_modules/yaml"),
    { recursive: true },
  );
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  for (const filename of [
    "scripts/audit.mts",
    "scripts/audit-contract.mts",
    "scripts/validation-evidence.mts",
    "scripts/repository-path.mts",
    "scripts/runtime-values.mts",
    "scripts/select-ci-plan.mts",
    "scripts/nextest-equivalence.mts",
    "scripts/validation-platforms.mts",
    "scripts/postmerge-ci.mts",
    "scripts/workflow-provenance.mts",
    "scripts/validation-plan.mts",
    "scripts/release-native-source-contract.mts",
    "scripts/windows-helper-checks.mts",
    "scripts/native-helper-dependencies.mts",
    "scripts/development-evidence.mts",
    "scripts/retained-evidence.mts",
    "scripts/qualification-coverage.mts",
    "scripts/qualification-rustdoc.mts",
    "scripts/rustdoc-outcomes.mts",
    "scripts/qualification-nextest.mts",
    "scripts/nextest-outcomes.mts",
    "scripts/nextest-skip-routes.mts",
    "scripts/report-summary.mts",
    "scripts/bounded-summary.mts",
    "scripts/fallow-summary.mts",
    ".github/qualification-coverage.json",
    ".github/workflows/ci.yml",
  ]) {
    let contents = readFileSync(new URL(`../${filename}`, import.meta.url), "utf8");
    if (filename === "scripts/validation-plan.mts") {
      contents = contents.replace(/  "rust",\r?\n/u, "").replace(/  "windows-x86_64",\r?\n/u, "");
    }
    writeFileSync(path.join(root, filename), contents);
  }
  const runner = `
    import assert from 'node:assert/strict';
    import {buildValidationPlan, digestValidationPlan, fastGroups, qualificationPlatforms, validateQualificationBinding} from './scripts/validation-plan.mts';
    import {selectTransitionAudit} from './scripts/audit.mts';
    const context=JSON.parse(process.env.TRANSITION_FIXTURE);
    context.validationPlan=buildValidationPlan({changes:context.changes,eventName:'pull_request',
      base:'b'.repeat(40),mergeBase:'b'.repeat(40),head:context.inventory.head,checkout:context.inventory.head});
    Object.assign(context.validationPlan,{mode:'qualification',groups:fastGroups,platforms:qualificationPlatforms,qualification_required:true});
    delete context.validationPlan.digest;context.validationPlan.digest=digestValidationPlan(context.validationPlan);
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
      TRANSITION_FIXTURE: JSON.stringify(transitionContext(["scripts/validation-plan.mts"])),
    },
  });
});

void test("incomplete transition discovery cannot authorize a shorter audit", () => {
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

void test("partial audit profiles cannot overwrite the complete audit report", (t) => {
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
      stages: [requiredFixture(smallStages[0])],
      fresh: true,
      profile,
    });
    const result = executeAudit(partial, { execute: () => ({ status: 0 }) });
    assert.equal(result.report.profile, profile);
    assert.ok(existsSync(path.join(receiptRoot, "audits", `${head}.${profile}.json`)));
    assert.equal(readFileSync(fullPath, "utf8"), fullBytes);
  }
});

function temporaryDirectory(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-audit-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const smallStages: readonly AuditStage[] = Object.freeze([
  { id: "rust", recipe: "check-rust", domain: "rust", reusable: true },
  { id: "ui", recipe: "check-ui", domain: "ui", reusable: true },
  { id: "release", recipe: "release-check", domain: "release", reusable: true },
]);

void test("repository inventory binds tracked Git blobs to current content", () => {
  const current = repositoryInventory(fileURLToPath(new URL("../", import.meta.url)));
  const cargo = requiredFixture(current.files.find((entry) => entry.path === "Cargo.toml"));
  assert.ok(cargo);
  assert.equal(cargo.headBlob, cargo.indexBlob);
  assert.equal(cargo.headBlob, cargo.gitBlob);
  assert.equal(cargo.kind, "file");
  assert.ok(cargo.sha256);
  assert.ok(cargo.domains.includes("rust"));
});

void test("canonical text identity permits only explicit UTF-8 LF conversion without filters", () => {
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

void test("actual clean Git LF-text checkout qualifies while raw fingerprints remain distinct", (t) => {
  const root = temporaryDirectory(t);
  const run = (...args: string[]) =>
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
  const entry = requiredFixture(crlf.files.find((item) => item.path === "example.md"));
  assert.notEqual(entry.gitBlob, entry.indexBlob);
  assert.equal(entry.canonicalTextBlob, entry.indexBlob);
  assert.notEqual(
    entry.sha256,
    requiredFixture(lf.files.find((item) => item.path === "example.md")).sha256,
  );
  const context = transitionContext(["docs/QUALITY.md"]);
  context.inventory.files.push(entry);
  assert.equal(selectTransitionAudit(context).profile, "transition");
  entry.canonicalTextBlob = "0".repeat(40);
  assert.equal(selectTransitionAudit(context).profile, "complete");
});

void test("domain inventories retain unrelated documentation rebases and invalidate Rust changes", () => {
  const stage = requiredFixture(smallStages[0]);
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

void test("release handbook edits invalidate their consumers without expiring unchanged product receipts", () => {
  const handbook = file("docs/RELEASING.md", "selected predecessor and candidate");
  assert.deepEqual(handbook.domains, ["format", "release", "repository", "roadmap"]);
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
  for (const protectedInput of ["docs/QUALITY.md", "scripts/audit.mts", "unknown-release.bin"])
    for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable))
      assert.ok(file(protectedInput, "changed policy").domains.includes(stage.domain), stage.id);
  const rust = requiredFixture(AUDIT_STAGES.find((entry) => entry.id === "rust"));
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

for (const pathname of ["scripts/desktop-scenarios.mts", "scripts/desktop-scenarios.test.mts"]) {
  void test(`desktop scenario consumer ${pathname} invalidates only consumed receipts`, (t) => {
    const stages = AUDIT_STAGES.filter((stage) => stage.reusable);
    const receiptRoot = temporaryDirectory(t);
    const before = inventory("before", [file(pathname, "original scenario contract")]);
    const after = inventory("after", [file(pathname, "changed scenario contract")]);
    const initial = planAudit({ stages, inventory: before, runtime, receiptRoot, fresh: true });
    assert.equal(executeAudit(initial, { execute: () => ({ status: 0 }) }).success, true);
    const unchanged = planAudit({ stages, inventory: before, runtime, receiptRoot });
    assert.ok(
      unchanged.stages.every((stage) => stage.action === "reuse"),
      pathname,
    );
    const changed = planAudit({ stages, inventory: after, runtime, receiptRoot });
    for (const stage of changed.stages) {
      const consumes = ["format", "development-tools"].includes(stage.id);
      assert.equal(stage.action, consumes ? "run" : "reuse", `${pathname}: ${stage.id}`);
      assert.equal(
        stage.fingerprint !==
          requiredFixture(initial.stages.find((entry) => entry.id === stage.id)).fingerprint,
        consumes,
        `${pathname}: ${stage.id} fingerprint`,
      );
    }
  });
}

void test("formatting and transport inputs invalidate every stage that actually reads them", () => {
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

  const formatStage = requiredFixture(AUDIT_STAGES.find((stage) => stage.id === "frontend-static"));
  const uiStage = requiredFixture(AUDIT_STAGES.find((stage) => stage.id === "ui"));
  assert.equal(formatStage.reusable, false);
  assert.equal(uiStage.reusable, false);
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

void test("committing identical working content does not invalidate a content-based stage", () => {
  const stage = requiredFixture(smallStages[0]);
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

void test("staged content and modes participate even when working content is unchanged", () => {
  const stage = requiredFixture(smallStages[0]);
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

void test("unresolved index entries fail closed", () => {
  assert.throws(
    () => parseIndex("100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2\tnew-file.txt\0"),
    /cannot audit unresolved index path: new-file\.txt/,
  );
});

void test("partially staged paths fail closed while disjoint changes remain auditable", () => {
  assert.doesNotThrow(() => assertNoSplitIndex(["staged.txt"], ["unstaged.txt"]));
  assert.throws(
    () => assertNoSplitIndex(["split.txt", "other.txt"], ["split.txt"]),
    /cannot audit partially staged paths: split\.txt/,
  );
});

void test("untracked and ambiguously classified inputs conservatively invalidate every reusable domain", () => {
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
  ] as const)
    assert.ok(unknown.domains.includes(domain));
  const changed = { ...unknown, sha256: createHash("sha256").update("second").digest("hex") };
  for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable)) {
    assert.notEqual(
      fingerprintStage(stage, inventory("one", [unknown]), runtime),
      fingerprintStage(stage, inventory("two", [changed]), runtime),
    );
  }
});

void test("runtime tool and behavior-environment drift invalidates a matching content inventory", () => {
  const source = inventory("head", [file("crates/portcove-core/src/lib.rs", "same")]);
  const stage = requiredFixture(smallStages[0]);
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, rustc: "rustc changed" }),
  );
  assert.notEqual(
    fingerprintStage(stage, source, runtime),
    fingerprintStage(stage, source, { ...runtime, cargoNextest: "nextest changed" }),
  );
  const uiStage = requiredFixture(smallStages[1]);
  const uiSource = inventory("head", [file("apps/desktop/src/App.tsx", "same")]);
  assert.equal(
    fingerprintStage(uiStage, uiSource, runtime),
    fingerprintStage(uiStage, uiSource, { ...runtime, rustc: "irrelevant Rust drift" }),
  );
  assert.notEqual(
    fingerprintStage(uiStage, uiSource, runtime),
    fingerprintStage(uiStage, uiSource, { ...runtime, packageManagerVersion: "changed" }),
  );
  const lintStage = requiredFixture(AUDIT_STAGES.find((entry) => entry.id === "script-lint"));
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

void test("a late failure records successful independent stages and resumes only the failed stage", (t) => {
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
  const seen: string[] = [];
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
  const secondSeen: string[] = [];
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

void test("tampered and interrupted receipts are rejected and never reused", (t) => {
  const receiptRoot = temporaryDirectory(t);
  const source = inventory("head", [file("crates/portcove-core/src/lib.rs", "rust")]);
  const stages = [requiredFixture(smallStages[0])];
  const initial = planAudit({ stages, inventory: source, runtime, receiptRoot, fresh: true });
  executeAudit(initial, { execute: () => ({ status: 0 }) });
  const receiptFile = path.join(
    receiptRoot,
    "stages",
    "rust",
    `${requiredFixture(initial.stages[0]).fingerprint}.json`,
  );
  const tampered: unknown = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.ok(
    isRecord(tampered) &&
      isRecord(tampered.payload) &&
      typeof tampered.payload.durationMs === "number",
  );
  tampered.payload.durationMs += 1;
  writeFileSync(receiptFile, JSON.stringify(tampered));
  const rejected = planAudit({ stages, inventory: source, runtime, receiptRoot });
  assert.equal(requiredFixture(rejected.stages[0]).action, "run");
  assert.match(
    requiredFixture(requiredFixture(rejected.stages[0]).rationale),
    /integrity mismatch/u,
  );

  const interrupted = executeAudit(rejected, {
    execute: () => ({ status: null, error: new Error("interrupted") }),
  });
  assert.equal(interrupted.success, false);
  assert.equal(existsSync(receiptFile), false);
  assert.equal(validateReceipt(null).valid, false);
});

void test("fresh mode executes all stages while stateful observations always run", (t) => {
  const receiptRoot = temporaryDirectory(t);
  const source = inventory("head", [
    file("crates/portcove-core/src/lib.rs", "rust"),
    file("release/version.json", "release"),
  ]);
  const stages: AuditStage[] = [
    requiredFixture(smallStages[0]),
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

void test("plan construction is side-effect free when no receipt directory exists", (t) => {
  const root = temporaryDirectory(t);
  const receiptRoot = path.join(root, "not-created");
  const plan = planAudit({
    stages: [requiredFixture(smallStages[0])],
    inventory: inventory("head", [file("crates/portcove-core/src/lib.rs", "rust")]),
    runtime,
    receiptRoot,
  });
  assert.equal(requiredFixture(plan.stages[0]).action, "run");
  assert.equal(existsSync(receiptRoot), false);
});

void test("containment authorities invalidate every reusable audit receipt domain", () => {
  const paths = [
    "scripts/rust-test-tree-supervisor.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
    "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  ];
  for (const pathname of paths) {
    const before = inventory("before", [file(pathname, "original containment")]);
    const after = inventory("after", [file(pathname, "changed containment")]);
    const removed = inventory("after", []);
    const renamed = inventory("after", [
      file("new-subsystem/future-supervisor.mjs", "original containment"),
    ]);
    for (const stage of AUDIT_STAGES.filter((entry) => entry.reusable)) {
      assert.ok(domainsForPath(pathname).domains.has(stage.domain), `${pathname} -> ${stage.id}`);
      for (const next of [after, removed, renamed])
        assert.notEqual(
          fingerprintStage(stage, before, runtime),
          fingerprintStage(stage, next, runtime),
          `${pathname} -> ${stage.id}`,
        );
    }
    const context = transitionContext([pathname]);
    assert.equal(context.validationPlan.qualification_required, true);
    assert.equal(selectTransitionAudit(context).profile, "complete");
  }
});

void test("optional audit receipts reject changed helper inputs at their real stage consumers", (t) => {
  const stages = AUDIT_STAGES.filter((stage) =>
    ["development-tools", "repository-tooling", "release-unit", "rust"].includes(stage.id),
  );
  for (const [pathname, consumers] of [
    ["scripts/retained-package.mts", ["development-tools", "release-unit"]],
    ["scripts/retained-evidence.mts", ["development-tools", "release-unit"]],
    ["scripts/native-helper-dependencies.mts", ["development-tools"]],
    ["scripts/github-api.mts", ["repository-tooling", "release-unit", "development-tools"]],
    [
      "scripts/runtime-values.mts",
      ["repository-tooling", "release-unit", "development-tools", "rust"],
    ],
    ["scripts/release-semantic-reader-core.mts", ["release-unit"]],
    [
      "scripts/unclassified-behavior.mts",
      ["repository-tooling", "release-unit", "development-tools", "rust"],
    ],
  ] as const) {
    const receiptRoot = temporaryDirectory(t);
    const before = inventory("a".repeat(40), [file(pathname, "old implementation")]);
    executeAudit(planAudit({ stages, inventory: before, runtime, receiptRoot }), {
      execute: () => ({ status: 0 }),
    });
    assert.ok(
      planAudit({ stages, inventory: before, runtime, receiptRoot }).stages.every(
        (stage) => stage.action === "reuse",
      ),
    );
    for (const entries of [
      [file(pathname, "changed implementation")],
      [],
      [file("scripts/moved-helper.mts", "old implementation")],
    ]) {
      const plan = planAudit({
        stages,
        inventory: inventory("b".repeat(40), entries),
        runtime,
        receiptRoot,
      });
      for (const id of consumers)
        assert.equal(
          plan.stages.find((stage) => stage.id === id)?.action,
          "run",
          `${pathname}:${id}`,
        );
    }
    if (pathname === "scripts/release-semantic-reader-core.mts") {
      const plan = planAudit({
        stages,
        inventory: inventory("c".repeat(40), [file(pathname, "changed implementation")]),
        runtime,
        receiptRoot,
      });
      assert.equal(plan.stages.find((stage) => stage.id === "rust")?.action, "reuse");
    }
  }
});
