import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMap, parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";

// Read-only source fixtures shared by workflow policy contracts; no test registration.
export function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture or source section is missing");
  return value;
}
export const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

export function workflowJob(job: string) {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  const owner = settings.jobs[job];
  assert.ok(isRecord(owner) && Array.isArray(owner.steps));
  return owner;
}
export function workflowStep(job: string, name: string) {
  const owner = workflowJob(job);
  assert.ok(Array.isArray(owner.steps));
  const steps: unknown[] = owner.steps;
  const step = steps.find((value) => isRecord(value) && value.name === name);
  assert.ok(
    isRecord(step) && typeof step.run === "string",
    `Missing executable step: ${job}/${name}`,
  );
  return { ...step, run: step.run };
}
export function executableLines(run: string) {
  return run
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** Inspect executable step fields so test filenames cannot impersonate setup. */
export function assertNoDuplicateRustSetup(job: unknown) {
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  for (const step of job.steps) {
    assert.ok(isRecord(step));
    if (typeof step.uses === "string") assert.doesNotMatch(step.uses, /rust-toolchain|rust-cache/u);
    if (typeof step.run === "string")
      for (const command of executableLines(step.run))
        assert.doesNotMatch(command, /\bcargo(?:\.exe)?(?=["'\s;&|<>()]|$)/u);
  }
}

export const qualificationWorkflow = await readFile(
  new URL("../.github/workflows/qualification.yml", import.meta.url),
  "utf8",
);
export const nativeDesignCompatibilityWorkflow = await readFile(
  new URL("../.github/workflows/native-design-compatibility.yml", import.meta.url),
  "utf8",
);

export const nativeCompatibilityRunner = await readFile(
  new URL("../apps/desktop/test/native-compatibility.mts", import.meta.url),
  "utf8",
);

export const desktopPackage: unknown = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
assert.ok(isRecord(desktopPackage) && isRecord(desktopPackage.scripts));
export const desktopScripts = desktopPackage.scripts;
export const qualityGuide = await readFile(new URL("../docs/QUALITY.md", import.meta.url), "utf8");
export const windowsQualificationRunner = await readFile(
  new URL("./run-windows-qualification.ps1", import.meta.url),
  "utf8",
);

export function workflowJobSource(source: string, name: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  assert.equal(document.errors.length, 0, "workflow YAML must parse without errors");
  assert.ok(isMap(document.get("jobs", true)), "workflow jobs must be a mapping");
  const job = document.getIn(["jobs", name], true);
  if (job === undefined) return "";
  assert.ok(isMap(job) && job.range, `workflow job must be a mapping: ${name}`);
  const [start, end] = job.range;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  return source.slice(/^\s*$/u.test(prefix) ? lineStart : start, end);
}

export function jobSection(name: string) {
  return workflowJobSource(workflow, name);
}

export const classify = jobSection("classify");
export const provenance = jobSection("provenance");
export const proseChecks = jobSection("prose_checks");
export const fastRust = jobSection("fast_rust");
export const fastRustTests = jobSection("fast_rust_tests");
export const fastPlatform = jobSection("fast_platform");
export const fastRustQuality = jobSection("fast_rust_quality");
export const fastFrontend = jobSection("fast_frontend");
export const fastCatalog = jobSection("fast_catalog");
export const qualificationCoreArchive = jobSection("qualification_core_archive");
export const rustTests = jobSection("rust_tests");
export const rustWorkspaceTests = jobSection("rust_workspace_tests");
export const rustClippy = jobSection("rust_clippy");
export const windowsStorage = jobSection("windows_storage");

export const nativeRust = jobSection("native_rust");
export const intelBuild = jobSection("intel_build");
export const intelTests = jobSection("intel_tests");
export const rustDocs = jobSection("rust_docs");
export const rust = jobSection("rust");
export const rustQuality = jobSection("rust_quality_full");
export const rustQualityGate = jobSection("rust-quality");
export const frontend = jobSection("frontend_full");
export const frontendGate = jobSection("frontend");
export const catalog = jobSection("catalog_full");
export const catalogGate = jobSection("catalog");
export const fastDependencyReview = jobSection("fast_dependency_review");
export const dependencyReview = jobSection("dependency_review_full");
export const dependencyReviewGate = jobSection("dependency-review");

// Inert repository-health controls for the tool invoked by the live upstream workflow.
