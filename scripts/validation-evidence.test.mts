import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import type {
  RepositoryInventory,
  StageIdentity,
  ValidationDomain,
  SuccessfulStageReceipt,
} from "./validation-evidence.mts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  domainsForPath,
  isFingerprintRuntime,
  fingerprintStage,
  validationRuntime,
  receiptEnvelope,
  validateReceipt,
} from "./validation-evidence.mts";

void test("pnpm patch bytes belong to format, UI and release evidence", () => {
  const patch = "patches/@tauri-apps__api@2.12.4.patch";
  const selected = domainsForPath(patch);
  assert.equal(selected.ambiguous, false);
  assert.ok(selected.domains.has("format"));
  assert.ok(selected.domains.has("ui"));
  assert.ok(selected.domains.has("release"));
  assert.equal(domainsForPath("patches/unowned.txt").ambiguous, true);
  const runtime = validationRuntime(undefined, {
    domains: ["format", "ui", "release"],
    commandVersion: () => "fixture",
  });
  const inventory = (identity: string): Pick<RepositoryInventory, "objectFormat" | "files"> => ({
    objectFormat: "sha1",
    files: [
      {
        path: patch,
        kind: "file",
        headBlob: identity,
        headMode: "100644",
        indexBlob: identity,
        indexMode: "100644",
        worktreeMode: "100644",
        gitBlob: identity,
        sha256: identity,
        domains: [...selected.domains],
        ambiguous: selected.ambiguous,
        untracked: false,
      },
    ],
  });
  for (const domain of ["format", "ui", "release"] as const) {
    const stage = { id: "patch-consumer", recipe: "unchanged", domain };
    const before = fingerprintStage(stage, inventory("a".repeat(64)), runtime);
    assert.notEqual(before, fingerprintStage(stage, inventory("b".repeat(64)), runtime));
    assert.notEqual(before, fingerprintStage(stage, { objectFormat: "sha1", files: [] }, runtime));
  }
});

void test("selected runtime observes exactly the fields used by the existing domain fingerprint", () => {
  const observe = (domains: readonly ValidationDomain[] | undefined) => {
    const calls: string[] = [];
    const runtime = validationRuntime(undefined, {
      ...(domains === undefined ? {} : { domains }),
      commandVersion(command, args) {
        calls.push([command, ...args].join(" "));
        return `version:${command}:${args.join(" ")}`;
      },
    });
    return { calls, runtime };
  };
  const full = observe(undefined);
  for (const domain of [
    "repository",
    "development",
    "roadmap",
    "format",
    "ui",
    "rust",
    "rscheck",
    "lint",
    "release",
  ] as const) {
    const selected = observe([domain]);
    const stage: StageIdentity = { id: "control", recipe: "unchanged", domain };
    const inventory: Pick<RepositoryInventory, "objectFormat" | "files"> = {
      objectFormat: "sha1",
      files: [],
    };
    assert.equal(
      fingerprintStage(stage, inventory, selected.runtime),
      fingerprintStage(stage, inventory, full.runtime),
    );
    if (!["rust", "rscheck"].includes(domain))
      assert(!selected.calls.some((call) => /^(?:cargo|rustc|rscheck) /u.test(call)));
    if (domain !== "lint") assert(!selected.calls.some((call) => /^(?:aqua|pwsh) /u.test(call)));
  }
  assert.deepEqual(observe(["repository"]).calls, ["git --version", "just --version"]);
  assert.equal(full.calls.length, 10);
});

void test("ordinary hosted planning imports and executes without loading audit or receipt orchestration", () => {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(specifier, context, next) {
      if (/(?:audit|validation-evidence|local-validation)\\.mts$/u.test(specifier))
        throw new Error('ordinary route loaded orchestration: '+specifier);
      return next(specifier, context);
    }});
    const { classifyChanges, buildPlan } = await import('./scripts/ordinary-validation.mts');
    await import('./scripts/ci-baseline.mts');
    const selection = classifyChanges([{status:'M',path:'README.md'}]);
    const plan = buildPlan(selection);
    assert(plan.some(entry=>entry.id==='diff-check'));
    assert(!plan.some(entry=>entry.id.startsWith('rust-')));
  `,
    ],
    { cwd: new URL("../", import.meta.url), windowsHide: true, timeout: 10_000 },
  );
});

void test("successful receipt requires validated identity and preserves the original metadata", () => {
  const payload: SuccessfulStageReceipt = {
    format: 1,
    kind: "successful-stage",
    success: true,
    stageId: "owned-stage",
    fingerprint: "f".repeat(64),
    originatingHead: "a".repeat(40),
    completedAt: "2026-10-16T00:00:00Z",
  };
  const result = validateReceipt(receiptEnvelope(payload));
  assert(result.valid);
  assert.equal(result.payload, payload);
  for (const invalid of [
    { format: 1, kind: "successful-stage", success: true },
    { ...payload, stageId: [] },
    { ...payload, fingerprint: null },
    { ...payload, originatingHead: {} },
    { ...payload, completedAt: 123 },
    { ...payload, recipe: [] },
    { ...payload, durationMs: "100" },
    { ...payload, durationMs: Infinity },
    { ...payload, durationMs: -1 },
  ])
    assert.equal(validateReceipt(receiptEnvelope(invalid)).valid, false);
  assert.equal(
    validateReceipt(receiptEnvelope({ ...payload, durationMs: 0, recipe: "owned" })).valid,
    true,
  );
});

void test("runtime identity rejects malformed packageManager data before claiming a measurement", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pcv-validation-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { domains: ["ui"] as const, commandVersion: () => "fixture-version" };
  for (const manifest of [null, {}, { packageManager: 123 }]) {
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    assert.throws(() => validationRuntime(directory, options), /declared packageManager identity/u);
  }
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ packageManager: "pnpm@fixture" }),
  );
  assert.equal(validationRuntime(directory, options).packageManager, "pnpm@fixture");
});

void test("persisted fingerprint runtime rejects unsafe fields while retaining unavailable observations", () => {
  const runtime = {
    platform: "linux",
    architecture: "x64",
    osRelease: "fixture",
    node: "fixture",
    git: "fixture",
    just: "fixture",
    environment: { OPTIONAL: null, PRESENT: "value" },
    rustc: null,
    packageManager: "pnpm@fixture",
  };
  assert.equal(isFingerprintRuntime(runtime), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...runtime, node: 24 },
    { ...runtime, environment: [] },
    { ...runtime, environment: { UNSAFE: {} } },
    { ...runtime, cargo: false },
    { ...runtime, powershell: 123 },
  ]) {
    assert.equal(isFingerprintRuntime(invalid), false);
  }
  assert.equal(isFingerprintRuntime({ ...runtime, cargo: undefined }), true);
});

void test("behavioral script consumers invalidate optional audit fingerprints independently of format membership", () => {
  const cases: [string, ValidationDomain[]][] = [
    ...[
      "scripts/node-platform-skips.mts",
      "scripts/node-test-suites.mts",
      "scripts/node-test-suites.json",
    ].map((file): [string, ValidationDomain[]] => [
      file,
      [
        "repository",
        "development",
        "roadmap",
        "format",
        "ui",
        "rust",
        "rscheck",
        "lint",
        "release",
      ],
    ]),
    [
      "scripts/node-case-observations.mts",
      [
        "repository",
        "development",
        "roadmap",
        "format",
        "ui",
        "rust",
        "rscheck",
        "lint",
        "release",
      ],
    ],
    ["scripts/unclassified-helper.mts", ["development", "release", "repository"]],
    ["scripts/retained-package.mts", ["development", "release"]],
    ["scripts/retained-evidence.mts", ["development", "release"]],
    ["scripts/native-helper-dependencies.mts", ["development", "repository"]],
    ["scripts/github-api.mts", ["repository", "roadmap", "development", "release"]],
    ["scripts/runtime-values.mts", ["development", "release", "repository", "roadmap"]],
    ["scripts/release-semantic-reader-core.mts", ["release"]],
  ];
  const runtime = validationRuntime(undefined, { commandVersion: () => "fixture" });
  const inventory = (
    file: string,
    identity: string,
  ): Pick<RepositoryInventory, "objectFormat" | "files"> => ({
    objectFormat: "sha1",
    files: [
      {
        path: file,
        kind: "file",
        headBlob: identity,
        indexBlob: identity,
        headMode: "100644",
        indexMode: "100644",
        worktreeMode: "100644",
        gitBlob: identity,
        sha256: identity,
        domains: [...domainsForPath(file).domains],
        ambiguous: false,
        untracked: false,
      },
    ],
  });
  for (const [file, domains] of cases)
    for (const domain of domains) {
      const stage = { id: "actual-consumer", recipe: "unchanged", domain };
      const before = fingerprintStage(stage, inventory(file, "a".repeat(64)), runtime);
      assert.notEqual(
        before,
        fingerprintStage(stage, inventory(file, "b".repeat(64)), runtime),
        `${file}:${domain}`,
      );
      assert.notEqual(
        before,
        fingerprintStage(stage, { objectFormat: "sha1", files: [] }, runtime),
        `deleted ${file}:${domain}`,
      );
      assert.notEqual(
        before,
        fingerprintStage(stage, inventory("scripts/renamed-helper.mts", "a".repeat(64)), runtime),
        `renamed ${file}:${domain}`,
      );
    }
  const stage = { id: "unchanged-rust", recipe: "unchanged", domain: "rust" as const };
  assert.equal(
    fingerprintStage(stage, inventory("docs/README.md", "a".repeat(64)), runtime),
    fingerprintStage(stage, inventory("docs/README.md", "b".repeat(64)), runtime),
  );
});

void test("default nextest inventory retention dependencies invalidate Rust receipts", () => {
  for (const file of [
    "scripts/nextest-outcomes.mts",
    "scripts/nextest-outcomes-cli.mts",
    "scripts/report-summary.mts",
    "scripts/bounded-summary.mts",
    "scripts/fallow-summary.mts",
  ])
    assert.ok(domainsForPath(file).domains.has("rust"), file);
});
