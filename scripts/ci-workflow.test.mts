import assert from "node:assert/strict";

import { requireNodeTestInventory } from "./node-test-inventory.mts";

import { isRecord } from "./runtime-values.mts";

import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { parseDocument } from "yaml";

import {
  requiredFixture,
  workflow,
  workflowJob,
  workflowStep,
  executableLines,
  qualificationWorkflow,
  qualificationCoreArchive,
  desktopScripts,
  windowsQualificationRunner,
  classify,
  provenance,
  proseChecks,
  fastRust,
  fastPlatform,
  fastRustQuality,
  fastFrontend,
  fastCatalog,
  rustTests,
  rustWorkspaceTests,
  rustClippy,
  windowsStorage,
  nativeRust,
  intelBuild,
  intelTests,
  rustDocs,
  rust,
  rustQuality,
  rustQualityGate,
  frontend,
  frontendGate,
  catalog,
  catalogGate,
  fastDependencyReview,
  dependencyReviewGate,
} from "./ci-workflow-fixture.mts";

void test("test reports inherit the candidate source separately from the executed checkout", () => {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.env));
  assert.equal(
    settings.env.PORTCOVE_HEAD_SHA,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(settings.env.PORTCOVE_CHECKOUT_SHA, "${{ github.sha }}");
});

void test("every CI job has a finite envelope above its declared step limits", () => {
  const settings: unknown = parseDocument(workflow, { uniqueKeys: true }).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  for (const [name, job] of Object.entries(settings.jobs)) {
    assert.ok(isRecord(job), name);
    const budget = job["timeout-minutes"];
    assert.ok(
      typeof budget === "number" && Number.isInteger(budget) && budget > 0 && budget <= 120,
      name,
    );
    if (Array.isArray(job.steps))
      for (const step of job.steps) {
        assert.ok(isRecord(step));
        const limit = step["timeout-minutes"];
        if (limit !== undefined)
          assert.ok(
            typeof limit === "number" && limit < budget,
            `${name}: leave time for cleanup and uploads`,
          );
      }
  }
});

void test("dependency lanes run actual security review without a custom age audit", () => {
  for (const name of ["fast_dependency_review", "dependency_review_full"]) {
    const block = requiredFixture(
      requiredFixture(workflow.split("  " + name + ":")[1]).split(/\n  [a-zA-Z][a-zA-Z_-]*:/u)[0],
    );
    assert.match(block, /actions\/dependency-review-action@/u);
    assert.match(block, /fail-on-severity: high/u);
    assert.doesNotMatch(
      block,
      /dependency-release-age|dependency-age|continue-on-error|minimumReleaseAge/u,
    );
  }
});

void test("every Node test file is included in required CI and the local quality workflow", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const files = (await readdir(new URL(".", import.meta.url))).filter((name: string) =>
    /\.test\.[cm]?[jt]s$/u.test(name),
  );
  requireNodeTestInventory(
    files.map((file) => `scripts/${file}`),
    workflow,
    recipes,
    windowsQualificationRunner,
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
});

void test("application release records run after the maintained SemVer dependency is installed", () => {
  const installation = frontend.indexOf("args: [--frozen-lockfile]");
  const selection = frontend.indexOf("scripts/select-release-channel.test.mts");
  const coordinator = frontend.indexOf("scripts/release-coordinator.test.mts");
  const reconstruction = frontend.indexOf(
    "scripts/reconstruct-application-update-records.test.mts",
  );
  assert.ok(installation >= 0 && selection > installation);
  assert.ok(coordinator > installation);
  assert.ok(reconstruction > installation);
  assert.ok(!catalog.includes("scripts/select-release-channel.test.mts"));
  assert.ok(!catalog.includes("scripts/release-coordinator.test.mts"));
  assert.ok(!catalog.includes("scripts/reconstruct-application-update-records.test.mts"));
});

void test("selected contracts install their desktop-owned dependencies before fast contract execution", () => {
  const block = requiredFixture(
    requiredFixture(workflow.split("  fast_catalog:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  const setup = block.indexOf(
    "pnpm --filter portcove-desktop-ui install --frozen-lockfile --ignore-scripts",
  );
  const execution = block.indexOf("run: node scripts/ci-baseline.mts contracts");
  assert.ok(setup >= 0 && execution > setup);
  assert.match(block, /if: needs\.classify\.outputs\.contract_desktop == 'true'/u);
  assert.match(workflow, /contract_desktop: \$\{\{ steps\.plan\.outputs\.contract_desktop \}\}/u);
});

void test("full repository contracts run the bounded release evidence collector controls", () => {
  assert.deepEqual(
    executableLines(workflowStep("catalog_full", "Test bounded release run evidence").run),
    [
      "node --test --test-timeout=30000 --test-reporter=./scripts/required-node-test-reporter.mts scripts/release-run-evidence.test.mts",
    ],
  );
});

void test("required CI keeps its cancellation and least-privilege contracts", () => {
  const document = parseDocument(workflow);
  assert.deepEqual(document.errors, []);
  const settings: unknown = document.toJS();
  assert.ok(isRecord(settings));
  assert.deepEqual(settings.permissions, { contents: "read" });
  assert.deepEqual(settings.concurrency, {
    group:
      "ci-${{ inputs.force_qualification && format('qualification-{0}', github.ref) || github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ !inputs.force_qualification }}",
  });
  for (const section of [
    rustTests,
    qualificationCoreArchive,
    rustWorkspaceTests,
    rustClippy,
    windowsStorage,
    nativeRust,
    intelBuild,
    intelTests,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ]) {
    assert.notEqual(section, "");
    assert.match(
      section,
      section === rustTests
        ? /^ {4}needs: \[classify, qualification_core_archive\]$/m
        : /^ {4}needs: (?:classify|\[classify, intel_build\])$/m,
    );
    assert.match(
      section,
      /^ {4}if: .*classify\.outputs\.mode == 'qualification'(?: && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-x86_64'\))?$/m,
    );
  }
  assert.match(classify, /fetch-depth: 0/);
  assert.match(classify, /node scripts\/select-ci-plan\.mts/);
  assert.match(classify, /PORTCOVE_PROSE_POLICY_ACTIVATED: "true"/);
  assert.match(classify, /PORTCOVE_FAST_VALIDATION_ACTIVATED: "true"/);
  assert.match(provenance, /node scripts\/workflow-provenance\.mts/);
  assert.match(provenance, /--observed-toolchains node/);
  assert.doesNotMatch(provenance, /pnpm\/action-setup|\.\/\.github\/actions\/setup-rust/);
  assert.match(
    provenance,
    /workflow-provenance-\$\{\{ inputs\.provenance_scope \|\| 'ci' \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(provenance, /retention-days: 7/);
  assert.match(
    rustQualityGate,
    /\[classify, provenance, prose_checks, fast_rust_quality, rust_quality_full\]/,
  );
  assert.match(rustQualityGate, /PORTCOVE_ALWAYS_RESULTS: '\{"provenance"/);
  assert.match(proseChecks, /^ {4}if: needs\.classify\.outputs\.mode == 'prose'$/m);
  assert.match(proseChecks, /actions\/setup-node@/);
  const prerequisites = proseChecks.indexOf("node scripts/check-ci-prose.mts --prerequisites");
  const install = proseChecks.indexOf("uses: voidzero-dev/setup-vp@");
  const checks = proseChecks.indexOf("node --test --test-timeout=30000");
  assert.ok(prerequisites >= 0 && install > prerequisites && checks > install);
  assert.match(
    proseChecks,
    /if: steps\.prose-prerequisites\.outputs\.frontend_dependencies == 'true'/u,
  );
  assert.match(
    proseChecks,
    /args: \[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/u,
  );
  assert.doesNotMatch(
    proseChecks,
    /browser:bootstrap|setup-rust|playwright install|continue-on-error/u,
  );
  assert.match(fastCatalog, /run: node scripts\/check-ci-prose\.integration\.mts/u);
  assert.match(fastCatalog, /path: work\/prose-ci-integration\//u);
  assert.match(proseChecks, /scripts\/repository-settings\.test\.mts/);
  assert.match(proseChecks, /scripts\/repository-skills\.test\.mts/);
  assert.match(proseChecks, /node scripts\/check-ci-prose\.mts/);
  for (const gate of [rust, rustQualityGate, frontendGate, catalogGate, dependencyReviewGate]) {
    assert.match(gate, /node scripts\/ci-result-gate\.mts/);
    assert.match(gate, /PORTCOVE_CLASSIFIER_RESULT/);
    assert.match(gate, /PORTCOVE_PROSE_RESULT/);
    assert.match(gate, /PORTCOVE_PLAN_GZIP_BASE64/);
    assert.match(gate, /PORTCOVE_FAST_RESULTS/);
    assert.match(gate, /PORTCOVE_TARGETED_RESULTS/);
    assert.match(gate, /PORTCOVE_QUALIFICATION_RESULTS/);
  }
  for (const fast of [fastRustQuality, fastFrontend, fastCatalog]) {
    assert.match(fast, /mode == 'fast'/);
    assert.match(fast, /runs-on: ubuntu-22\.04/);
  }
  assert.match(fastRust, /runs-on: windows-latest/);
  assert.match(fastRust, /windows-rust-tests\.mts build/);
  assert.equal(fastPlatform, "");
  assert.match(fastRustQuality, /voidzero-dev\/setup-vp@/);
  assert.match(fastRustQuality, /frontend_workspace == 'true'/);
  assert.match(fastRustQuality, /\[--frozen-lockfile\]/);
  assert.match(
    fastRustQuality,
    /\[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/,
  );
  assert.match(
    fastCatalog,
    /args: \[--filter, portcove-repository, --frozen-lockfile, --ignore-scripts\]/,
  );
  assert.equal(desktopScripts["format:check"], "vp -C ../.. fmt --check");
  assert.match(fastRustQuality, /frontend_tools == 'true'/);
  assert.match(fastRust, /key: fast-rust-tests-/);
  assert.doesNotMatch(fastRustQuality, /cargo clippy/);
  assert.ok(isRecord(settings.jobs));
  const qualityJob = settings.jobs.fast_rust_quality;
  assert.ok(isRecord(qualityJob) && Array.isArray(qualityJob.steps));
  const qualityCaches = qualityJob.steps.filter(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("Swatinem/rust-cache@"),
  );
  assert.deepEqual(qualityCaches, [
    {
      uses: "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0",
      if: "contains(fromJSON(needs.classify.outputs.groups_json), 'rust')",
      with: {
        "cache-on-failure": true,
        key: "runtime-diagnostics-linux-${{ hashFiles('Cargo.toml') }}",
      },
    },
  ]);
  assert.match(fastDependencyReview, /actions\/dependency-review-action@/);
  assert.match(fastDependencyReview, /base-ref:/);
  assert.match(fastDependencyReview, /head-ref:/);
});

void test("reusable qualification is read-only, daily, and coalesces without cancelling", async () => {
  assert.match(qualificationWorkflow, /^ {2}workflow_call:\r?$/m);
  assert.match(qualificationWorkflow, /^ {2}workflow_dispatch:\r?$/m);
  assert.match(qualificationWorkflow, /cron: "17 5 \* \* \*"/);
  assert.match(qualificationWorkflow, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(
    qualificationWorkflow,
    /^concurrency:\r?\n {2}group: portcove-qualification-.*\r?\n {2}cancel-in-progress: false$/m,
  );
  assert.match(qualificationWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(qualificationWorkflow, /force_qualification: true/);
  const classification = workflow.split("\n  classify:")[1];
  assert.ok(classification);
  const classifier = classification.split("\n    name:")[0];
  assert.ok(classifier);
  const requested = [...classifier.matchAll(/^ {6}([\w-]+): (read|write)$/gm)];
  assert.equal(requested.length, 3);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  for (const [source, job] of [
    [qualificationWorkflow, "qualify"],
    [release, "qualification"],
  ] as const) {
    const callJob = source.split(`\n  ${job}:`)[1];
    assert.ok(callJob);
    const caller = callJob.split("\n    uses:")[0];
    assert.ok(caller);
    for (const [, scope, access] of requested) {
      assert.equal(access, "read");
      assert.match(caller, new RegExp(`^ {6}${scope}: ${access}$`, "m"));
    }
    assert.doesNotMatch(caller, /: write/);
  }
  assert.match(qualificationWorkflow, /jobs\.qualify\.outputs\.plan_digest/);
  assert.match(qualificationWorkflow, /provenance_scope:/);
  assert.doesNotMatch(qualificationWorkflow, /secrets:|pull_request_target|contents: write/);
  assert.match(workflow, /^ {2}workflow_call:\r?$/m);
});

void test("full repository contracts install the complete workspace dependency closure before execution", () => {
  const job = workflowJob("catalog_full");
  assert.ok(Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const installation = steps.findIndex(
    (step) => isRecord(step) && typeof step.run === "string" && /^pnpm\s+install\b/u.test(step.run),
  );
  const execution = steps.findIndex(
    (step) => isRecord(step) && step.name === "Verify repository and release contracts",
  );
  assert.ok(installation >= 0 && execution > installation);
  const step = steps[installation];
  assert.ok(isRecord(step) && typeof step.run === "string");
  const args = step.run.trim().split(/\s+/u);
  assert.deepEqual(args.slice(0, 2), ["pnpm", "install"]);
  assert.deepEqual(new Set(args.slice(2)), new Set(["--frozen-lockfile", "--ignore-scripts"]));
});

void test("ordinary tooling contracts select the workflow contract and full CI retains its inventory", async () => {
  const { baselineContractTests } = await import("./ci-baseline.mts");
  const { buildValidationPlan } = await import("./validation-plan.mts");
  const file = ".github/workflows/ci.yml";
  const p = buildValidationPlan({
    changes: [{ status: "M", oldMode: "100644", newMode: "100644", oldPath: file, newPath: file }],
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  assert.ok(baselineContractTests(p).includes("scripts/ci-workflow.test.mts"));
  assert.match(requiredFixture(workflow.split("  catalog_full:")[1]), /ci-workflow\.test\.mts/);
});

void test("native repository contracts provision pinned Rust before metadata or containment execution", () => {
  for (const section of [fastCatalog, catalog]) {
    assert.ok(section.indexOf("./.github/actions/setup-rust") >= 0);
    const contract = section.includes("scripts/ci-baseline.mts contracts")
      ? section.indexOf("scripts/ci-baseline.mts contracts")
      : section.indexOf("Verify repository and release contracts");
    assert.ok(contract > section.indexOf("./.github/actions/setup-rust"));
  }
});

void test("extracted validation evidence suite remains in hosted and repository full inventories", async () => {
  const just = await readFile(new URL("../justfile", import.meta.url), "utf8");
  assert.match(
    requiredFixture(requiredFixture(just.split("development-tools:")[1]).split("\n\n")[0]),
    /scripts\/validation-evidence\.test\.mts/u,
  );
  assert.match(
    requiredFixture(workflow.split("  catalog_full:")[1]),
    /scripts\/validation-evidence\.test\.mts/u,
  );
  assert.match(
    workflowStep("windows_storage", "Test development diagnostics and evidence").run,
    /scripts\/validation-evidence\.test\.mts/u,
  );
});

void test("hosted plans use bounded transport before checkout and retain the same qualification outputs", async () => {
  assert.doesNotMatch(workflow, /PORTCOVE_PLAN_JSON:/);
  assert.match(workflow, /plan_gzip_base64: \$\{\{ steps\.plan\.outputs\.plan_gzip_base64 \}\}/);
  assert.match(qualificationWorkflow, /jobs\.qualify\.outputs\.plan_gzip_base64/);
  const release = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    release,
    /PORTCOVE_PLAN_GZIP_BASE64: \$\{\{ needs\.qualification\.outputs\.plan_gzip_base64 \}\}/,
  );
  assert.doesNotMatch(release, /PORTCOVE_PLAN_JSON:/);
});
