import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIT_STAGES,
  assertNoSplitIndex,
  domainsForPath,
  executeAudit,
  fingerprintStage,
  parseIndex,
  planAudit,
  repositoryInventory,
  validateReceipt,
} from "./audit.mjs";

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

test("domain inventories retain unrelated documentation rebases and invalidate Rust changes", () => {
  const stage = smallStages[0];
  const original = inventory("head-a", [
    file("crates/portcove-core/src/lib.rs", "rust-a"),
    file("docs/QUALITY.md", "docs-a"),
  ]);
  const unrelatedRebase = inventory("head-b", [
    file("crates/portcove-core/src/lib.rs", "rust-a"),
    file("docs/QUALITY.md", "docs-b"),
  ]);
  const relevantRebase = inventory("head-c", [
    file("crates/portcove-core/src/lib.rs", "rust-b"),
    file("docs/QUALITY.md", "docs-b"),
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

test("formatting and transport inputs invalidate every stage that actually reads them", () => {
  const documentation = file("docs/QUALITY.md", "docs");
  assert.ok(documentation.domains.includes("format"));
  assert.ok(documentation.domains.includes("repository"));
  assert.ok(!documentation.domains.includes("ui"));
  assert.ok(!documentation.domains.includes("rust"));

  const transport = file("apps/desktop/src/transport-schemas.generated.json", "schema");
  assert.ok(transport.domains.includes("format") === false);
  assert.ok(transport.domains.includes("ui"));
  assert.ok(transport.domains.includes("rust"));

  const frontendLock = file("apps/desktop/pnpm-lock.yaml", "lockfile");
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
  const after = inventory("after", [file("docs/QUALITY.md", "changed docs")]);
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
