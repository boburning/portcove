import { errorMessage } from "./runtime-values.mts";
import type { ClassifyOptions } from "./ordinary-validation.mts";
import type { ValidationPlan } from "./validation-plan.mts";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyChanges,
  buildPlan,
  executePlan,
  pythonContractTests,
} from "./ordinary-validation.mts";
import { validateValidationPlan, readValidationPlanInput } from "./validation-plan.mts";
import { spawnCommand } from "./dev-storage.mts";
import { createCiMetrics } from "./ci-metrics.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export function baselineBootstrapTests(plan: ValidationPlan) {
  validateValidationPlan(plan);
  const infrastructure = plan.changes.some((change) =>
    [change.oldPath, change.newPath].some(
      (file) =>
        /^\.github\/(?:workflows\/ci\.yml|actions\/setup-rust\/|quality-tools\.json)/u.test(file) ||
        /^(?:rust-toolchain\.toml|scripts\/(?:rust-support-cache|run-rust-tests|ci-baseline|ci-metrics|heavy-rust-test-lock|process-lock))(?:\.|\/|$)/u.test(
          file,
        ),
    ),
  );
  return infrastructure ? ["scripts/rust-support-cache.test.mts"] : [];
}
export function baselineSelection(plan: ValidationPlan, options: ClassifyOptions = {}) {
  validateValidationPlan(plan);
  if (!["fast", "prose"].includes(plan.mode))
    throw new Error("Expected an ordinary hosted baseline");
  return classifyChanges(
    plan.changes.map((change) => ({
      status: change.status,
      path: change.newPath,
      ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
      oldMode: change.oldMode,
      newMode: change.newMode,
      ...(change.nextest_equivalence ? { nextest_equivalence: change.nextest_equivalence } : {}),
    })),
    options,
  );
}

export function baselineContractTests(plan: ValidationPlan, options: ClassifyOptions = {}) {
  const selection = baselineSelection(plan, options);
  const tests = new Set(selection.nodeTests);
  for (const file of [
    "scripts/validation-plan.test.mts",
    "scripts/select-ci-plan.test.mts",
    "scripts/ci-result-gate.test.mts",
    "scripts/ci-baseline.test.mts",
  ])
    tests.add(file);
  if (
    plan.fallback ||
    plan.changes.some((c) =>
      [c.oldPath, c.newPath].some((f) =>
        /(?:validation-plan|select-ci-plan|ci-baseline|ci-result-gate|qualification-coverage|rust-test-impact|windows-rust-tests|rust-test-timing-hints|ci\.yml)/u.test(
          f,
        ),
      ),
    )
  )
    for (const file of [
      "scripts/qualification-coverage.test.mts",
      "scripts/rust-test-impact.test.mts",
    ])
      tests.add(file);
  // Stateful packaged and live compiler/export contracts retain full qualification ownership.
  for (const file of [
    "scripts/windows-qualification-session.integration.test.mts",
    "scripts/check-transport-contract.integration.test.mts",
    "scripts/transport-types.test.mts",
  ])
    tests.delete(file);
  if (plan.fallback || !plan.changes.length) {
    for (const file of [
      "scripts/repository-settings.test.mts",
      "scripts/repository-skills.test.mts",
      "scripts/generate-catalog.test.mts",
      "scripts/check-transport-contract.test.mts",
      "scripts/check-child-process-policy.test.mts",
    ])
      tests.add(file);
  }
  return [...tests].sort();
}

// Tests that actually invoke Cargo metadata or native compiler/runner controls.
export function baselineRequiresRust(plan: ValidationPlan) {
  if (plan.mode === "qualification") return true;
  if (plan.mode === "blocked" || plan.mode === "prose") return false;
  return baselineContractTests(plan).some((file) =>
    [
      "scripts/run-rust-tests.test.mts",
      "scripts/rust-support-cache.test.mts",
      "scripts/rust-test-tree-supervisor.test.mts",
      "scripts/development-capabilities.test.mts",
      "scripts/dev-storage.test.mts",
    ].includes(file),
  );
}

export function baselineRequiresPython(plan: ValidationPlan) {
  if (plan.mode === "qualification") return true;
  if (!["fast", "prose"].includes(plan.mode)) return false;
  return baselineContractTests(plan).some((file) =>
    [
      "scripts/nextest-equivalence.test.mts",
      "scripts/ci-workflow.test.mts",
      ...pythonContractTests,
    ].includes(file),
  );
}

export function baselineRequiresDesktopDependencies(plan: ValidationPlan) {
  if (plan.mode === "qualification") return true;
  if (plan.mode !== "fast") return false;
  // The actual native-source consumer imports the desktop-owned SemVer policy
  // even when its source declarations changed outside release-security paths.
  return (
    plan.areas.includes("release-security") ||
    baselineContractTests(plan).includes("scripts/release-native-source-contract.test.mts")
  );
}

// Run the cheap production checkers against the actual checkout when their
// contracts are selected. Fixture-based unit tests alone cannot prove integrity.
export function baselineIntegrityCommands(plan: ValidationPlan, options: ClassifyOptions = {}) {
  const tests = new Set(baselineContractTests(plan, options));
  const checks: [test: string, args: string[]][] = [
    ["scripts/qualification-coverage.test.mts", ["scripts/qualification-coverage.mts"]],
    ["scripts/quality-tools.test.mts", ["scripts/quality-tools.mts", "--validate"]],
    ["scripts/repository-settings.test.mts", ["scripts/repository-settings.mts", "--validate"]],
    ["scripts/roadmap.test.mts", ["scripts/roadmap.mts", "check"]],
    ["scripts/check-release-metadata.test.mts", ["scripts/check-release-metadata.mts"]],
    ["scripts/generate-catalog.test.mts", ["scripts/generate-catalog.mts", "--check"]],
    ["scripts/generate-catalog.test.mts", ["scripts/check-retcomm-upstreams.mts", "--offline"]],
    ["scripts/native-helper-dependencies.test.mts", ["scripts/native-helper-dependencies.mts"]],
  ];
  return checks.filter(([test]) => tests.has(test)).map(([, args]) => args);
}

export function baselineFrontendPlan(plan: ValidationPlan, options: ClassifyOptions = {}) {
  const selection = baselineSelection(plan, options);
  if (!plan.groups.includes("frontend")) throw new Error("Plan omitted frontend execution");
  // A missing graph input or shared/unknown input executes the complete unit suite.
  selection.ui = true;
  selection.uiFullTests ||= Boolean(plan.fallback) || !selection.uiRelatedFiles.size;
  return buildPlan(selection, { validationPlan: plan }).filter((entry) =>
    [
      "ui-content",
      "ui-check",
      "ui-build",
      "ui-tests",
      "ui-browser-tests",
      "ui-related-tests",
    ].includes(entry.id),
  );
}

export function baselineLintPlan(plan: ValidationPlan, options: ClassifyOptions = {}) {
  if (!plan.groups.includes("rust-quality")) throw new Error("Plan omitted repository quality");
  const selection = baselineSelection(plan, options);
  return buildPlan(selection, { validationPlan: plan }).filter((entry) =>
    ["repository-lint", "oxfmt", "actionlint", "shell-lint", "python-lint"].includes(entry.id),
  );
}

// Fixture execution must not publish synthetic timings under the hosted job identity.
export function baselineTestEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const isolated = { ...environment };
  delete isolated.PORTCOVE_CI_METRICS_DIR;
  return isolated;
}

function main() {
  const metrics = createCiMetrics();
  const plan = validateValidationPlan(readValidationPlanInput());
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (checkout !== plan.identities.checkout) throw new Error("Baseline plan checkout mismatch");
  if (process.argv[2] === "bootstrap") {
    const tests = baselineBootstrapTests(plan);
    if (!tests.length) return;
    const result = metrics.measure("bootstrap-regressions", () =>
      spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...tests], {
        cwd: root,
        env: baselineTestEnvironment(),
        stdio: "inherit",
        windowsHide: true,
      }),
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else if (process.argv[2] === "contracts") {
    if (!plan.groups.includes("catalog")) throw new Error("Plan omitted repository contracts");
    const bootstrap = baselineBootstrapTests(plan);
    const selected = baselineContractTests(plan);
    const early = bootstrap.filter((file) => selected.includes(file));
    const remaining = selected.filter((file) => !early.includes(file));
    const batches = [early, remaining].filter((files) => files.length);
    const tests = selected;
    console.log(`[ci-baseline] ${tests.length} relevant repository contract files`);
    for (const batch of batches) {
      const result = metrics.measure(
        batch === early ? "bootstrap-regressions" : "repository-contract-tests",
        () =>
          spawnSync(
            process.execPath,
            [
              "--test",
              "--test-timeout=60000",
              "--test-skip-pattern=pnpm uses|direct just recipes",
              "--test-reporter=./scripts/test-duration-reporter.mts",
              ...batch,
            ],
            { cwd: root, env: baselineTestEnvironment(), stdio: "inherit", windowsHide: true },
          ),
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        return;
      }
    }
    for (const args of baselineIntegrityCommands(plan)) {
      const check = metrics.measure(`integrity:${args[0]}`, () =>
        spawnSync(process.execPath, args, {
          cwd: root,
          stdio: "inherit",
          windowsHide: true,
        }),
      );
      if (check.error) throw check.error;
      if (check.status !== 0) {
        process.exitCode = check.status ?? 1;
        return;
      }
    }
  } else if (process.argv[2] === "frontend" || process.argv[2] === "lint") {
    const commands =
      process.argv[2] === "lint" ? baselineLintPlan(plan) : baselineFrontendPlan(plan);
    executePlan(commands, {
      spawn: (executable, args, options) => {
        const entry = commands.find(
          (command) => command.executable === executable && command.args === args,
        );
        return metrics.measure(entry?.id ?? "frontend-command", () =>
          spawnCommand(executable, args, options),
        );
      },
    });
  } else throw new Error("Expected bootstrap, frontend, lint or contracts");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
