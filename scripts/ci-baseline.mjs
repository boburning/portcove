import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyChanges, buildPlan, executePlan } from "./local-validation.mjs";
import { validateValidationPlan } from "./validation-plan.mjs";
import { spawnCommand } from "./dev-storage.mjs";
import { createCiMetrics } from "./ci-metrics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export function baselineBootstrapTests(plan) {
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
  return infrastructure ? ["scripts/rust-support-cache.test.mjs"] : [];
}
export function baselineSelection(plan, options = {}) {
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
    })),
    options,
  );
}

export function baselineContractTests(plan, options) {
  const selection = baselineSelection(plan, options);
  const tests = new Set(selection.nodeTests);
  for (const file of [
    "scripts/validation-plan.test.mjs",
    "scripts/select-ci-plan.test.mjs",
    "scripts/ci-result-gate.test.mjs",
    "scripts/qualification-coverage.test.mjs",
    "scripts/ci-baseline.test.mjs",
    "scripts/rust-test-impact.test.mjs",
  ])
    tests.add(file);
  // Stateful packaged and live compiler/export contracts retain full qualification ownership.
  for (const file of [
    "scripts/windows-qualification-session.integration.test.mjs",
    "scripts/check-transport-contract.integration.test.mjs",
    "scripts/transport-types.test.mjs",
  ])
    tests.delete(file);
  if (plan.fallback || !plan.changes.length) {
    for (const file of [
      "scripts/repository-settings.test.mjs",
      "scripts/repository-skills.test.mjs",
      "scripts/generate-catalog.test.mjs",
      "scripts/check-transport-contract.test.mjs",
      "scripts/check-child-process-policy.test.mjs",
    ])
      tests.add(file);
  }
  return [...tests].sort();
}

// Run the cheap production checkers against the actual checkout when their
// contracts are selected. Fixture-based unit tests alone cannot prove integrity.
export function baselineIntegrityCommands(plan, options) {
  const tests = new Set(baselineContractTests(plan, options));
  const checks = [
    ["scripts/qualification-coverage.test.mjs", ["scripts/qualification-coverage.mjs"]],
    ["scripts/quality-tools.test.mjs", ["scripts/quality-tools.mjs", "--validate"]],
    ["scripts/repository-settings.test.mjs", ["scripts/repository-settings.mjs", "--validate"]],
    ["scripts/roadmap.test.mjs", ["scripts/roadmap.mjs", "check"]],
    ["scripts/check-release-metadata.test.mjs", ["scripts/check-release-metadata.mjs"]],
    ["scripts/generate-catalog.test.mjs", ["scripts/generate-catalog.mjs", "--check"]],
    ["scripts/generate-catalog.test.mjs", ["scripts/check-retcomm-upstreams.mjs", "--offline"]],
  ];
  return checks.filter(([test]) => tests.has(test)).map(([, args]) => args);
}

export function baselineFrontendPlan(plan, options) {
  const selection = baselineSelection(plan, options);
  if (!plan.groups.includes("frontend")) throw new Error("Plan omitted frontend execution");
  // A missing graph input or shared/unknown input executes the complete unit suite.
  selection.ui = true;
  selection.uiFullTests ||= Boolean(plan.fallback) || !selection.uiRelatedFiles.size;
  return buildPlan(selection, { validationPlan: plan }).filter((entry) =>
    [
      "ui-transport-types",
      "ui-ipc-exposure",
      "ui-build",
      "ui-tests",
      "ui-related-tests",
      "ui-related-durations",
    ].includes(entry.id),
  );
}

function main() {
  const metrics = createCiMetrics();
  const plan = validateValidationPlan(JSON.parse(process.env.PORTCOVE_PLAN_JSON ?? ""));
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (checkout !== plan.identities.checkout) throw new Error("Baseline plan checkout mismatch");
  if (process.argv[2] === "bootstrap") {
    const tests = baselineBootstrapTests(plan);
    if (!tests.length) return;
    const result = metrics.measure("bootstrap-regressions", () =>
      spawnSync(process.execPath, ["--test", "--test-timeout=30000", ...tests], {
        cwd: root,
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
              "--test-timeout=30000",
              "--test-skip-pattern=pnpm uses|direct just recipes",
              "--test-reporter=./scripts/test-duration-reporter.mjs",
              ...batch,
            ],
            { cwd: root, stdio: "inherit", windowsHide: true },
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
  } else if (process.argv[2] === "frontend") {
    const commands = baselineFrontendPlan(plan);
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
  } else throw new Error("Expected bootstrap, frontend or contracts");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
