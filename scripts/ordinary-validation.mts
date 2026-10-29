import { normalizeRepositoryPath as normalizePath } from "./repository-path.mts";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import type { ValidationChangeInput, ValidationPlan } from "./validation-plan.mts";
import { existsSync, readFileSync } from "node:fs";
import { nodeTestPath, parseNodeTestSuites } from "./node-test-suites.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationPlan, validationOwnershipForPath } from "./validation-plan.mts";
import { selectWorkspaceRustImpact } from "./rust-test-impact.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";
import { hasNextestEquivalence } from "./nextest-equivalence.mts";
import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
  nativeHelperFiles,
} from "./native-helper-dependencies.mts";
import { ordinaryOwnershipForPath } from "./validation-plan.mts";
import { spawnCommand } from "./dev-storage.mts";
import { stagedFileBatches } from "./viteplus-cli.mts";
export interface LocalChange extends ValidationChangeInput {
  path: string;
}
export interface ValidationSelection {
  scopes: Set<string>;
  packages: Set<string>;
  nodeTests: Set<string>;
  nodeSyntax: Set<string>;
  oxfmtFiles: Set<string>;
  uiRelatedFiles: Set<string>;
  unknown: Set<string>;
  shellFiles: Set<string>;
  pythonFiles: Set<string>;
  rustfmt: boolean;
  workspaceRust: boolean;
  ui: boolean;
  browser: boolean;
  uiFullTests: boolean;
  oxlint: boolean;
  repositoryLint: boolean;
  stylelint: boolean;
  actionsLint: boolean;
  powershellLint: boolean;
  shellLint: boolean;
  pythonLint: boolean;
  playnite: boolean;
  transport: boolean;
}
export interface ClassifyOptions {
  fileExists?: (file: string) => boolean;
}
interface PathClassifyOptions {
  includeFileChecks?: boolean;
  isDeletion?: boolean;
  nextestUnchanged?: boolean;
}
export interface ValidationCommand {
  id: string;
  reason: string;
  executable: string;
  args: string[];
  cwd: string;
  obligation?: string;
  rustCoverage?: string[];
}
interface RetainedCommand extends ValidationCommand {
  selectedIds: string[];
}
interface CommandOptions {
  cwd?: string;
  obligation?: string;
}
interface PlanningContext {
  validationPlan?: ValidationPlan;
  mergeBase?: string;
}
type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<Buffer>, "error" | "status">;
export function isRepositoryLintInput(file: string) {
  return (
    /^(?:scripts|integrations\/playnite|apps\/desktop\/(?:scripts|src|test|public))\/.*\.(?:[cm]?[jt]sx?)$/u.test(
      file,
    ) ||
    /^(?:scripts|integrations\/playnite)\/(?:.*\/)?tsconfig[^/]*\.json$/u.test(file) ||
    /^apps\/desktop\/src\/.*\.css$/u.test(file) ||
    /^apps\/desktop\/(?:vite\.config\.ts|(?:.*\/)?tsconfig[^/]*\.json|stylelint\.config\.[cm]?[jt]s)$/u.test(
      file,
    ) ||
    /^(?:apps\/desktop\/)?(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/u.test(
      file,
    ) ||
    [
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      ".gitignore",
      ".node-version",
    ].includes(file)
  );
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const requiredReporter = "./scripts/required-node-test-reporter.mts";

const packagePrefixes = new Map([
  ["crates/portcove-core/", "portcove-core"],
  ["crates/portcove-cli/", "portcove-cli"],
  ["crates/portcove-diagnostics/", "portcove-diagnostics"],
  ["crates/portcove-release-tools/", "portcove-release-tools"],
  ["apps/desktop/src-tauri/", "portcove-desktop"],
]);

const oxfmtExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".cts",
  ".ts",
  ".tsx",
  ".toml",
  ".yaml",
  ".yml",
]);

// Exact containment inputs share admission, registration, source-cache and
// descendant-closure consumers. Helper-only edits must exercise those contracts.
const containmentContractTests = [
  "scripts/heavy-rust-test-lock.test.mts",
  "scripts/resource-capacity.test.mts",
  "scripts/resource-command.test.mts",
  "scripts/native-session-lock.test.mts",
  "scripts/process-lock.test.mts",
  "scripts/run-rust-tests.test.mts",
  "scripts/rust-support-cache.test.mts",
  "scripts/rust-test-tree-supervisor.test.mts",
];
const containmentInputs = new Set([
  "scripts/rust-test-impact.mts",
  "scripts/windows-rust-tests.mts",
  "scripts/nextest-outcomes.mts",
  "scripts/nextest-outcomes-cli.mts",
  "scripts/desktop-linux-x11.mts",
  "scripts/resource-paths.mts",
  "scripts/native-build.mts",
  "scripts/container-host.mts",
  "scripts/fallow-source.mts",
  ...containmentContractTests,
  ...containmentContractTests.map((file) => file.replace(/\.test\.([cm]?[jt]s)$/u, ".$1")),
  "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
]);
const selectionContractTests = [
  "scripts/validation-plan.test.mts",
  "scripts/local-validation.test.mts",
  "scripts/audit.test.mts",
  "scripts/select-ci-plan.test.mts",
];

const roadmapFeatureTests = [
  "scripts/roadmap-authoring.test.mts",
  "scripts/roadmap-report.test.mts",
  "scripts/roadmap-publish.test.mts",
  "scripts/roadmap-execution.test.mts",
  "scripts/roadmap-intake.test.mts",
  "scripts/roadmap-views.test.mts",
  "scripts/roadmap-readiness.test.mts",
  "scripts/roadmap-mutations.test.mts",
  "scripts/roadmap-qualification.test.mts",
  "scripts/roadmap-provider-inventory.test.mts",
];
const roadmapContractTests = ["scripts/roadmap.test.mts", ...roadmapFeatureTests];

const catalogGeneratorFeatureTests = [
  "scripts/catalog-source-authoring.test.mts",
  "scripts/catalog-proposal-comparison.test.mts",
  "scripts/catalog-artwork-dispatch.test.mts",
  "scripts/catalog-artwork-batches.test.mts",
  "scripts/catalog-artwork-provider.test.mts",
  "scripts/catalog-artwork-lifecycle.test.mts",
  "scripts/catalog-artwork-backoff.test.mts",
];
export const catalogGeneratorContractTests = [
  "scripts/generate-catalog.test.mts",
  ...catalogGeneratorFeatureTests,
];
const catalogAuthoringContractTests = [
  "scripts/generate-catalog.test.mts",
  "scripts/catalog-source-authoring.test.mts",
  "scripts/catalog-proposal-comparison.test.mts",
  "scripts/catalog-artwork-dispatch.test.mts",
];

const upstreamHealthObservationTests = [
  "scripts/upstream-health-providers.test.mts",
  "scripts/upstream-health-planning.test.mts",
  "scripts/upstream-health-accounting.test.mts",
  "scripts/upstream-health-source-archives.test.mts",
];

const upstreamHealthContractTests = [
  ...upstreamHealthObservationTests,
  "scripts/upstream-observer.test.mts",
  "scripts/catalog-upstream-observer.test.mts",
  "scripts/upstream-health.test.mts",
  "scripts/upstream-health-plan.test.mts",
  "scripts/upstream-health-monitor.test.mts",
];

export const pythonContractTests = [
  "scripts/python-test-results.test.mts",
  "scripts/native-linux-isolated-init.test.mts",
  "scripts/native-qualification-linux-supervisor.test.mts",
  "scripts/native-qualification-linux-transfer.test.mts",
  "scripts/native-linux-public-fuse.test.mts",
  "scripts/native-linux-public-network.test.mts",
  "scripts/native-linux-public-services.test.mts",
  "scripts/semantic-review-linux-supervisor.test.mts",
  "scripts/release-semantic-source.test.mts",
];
const rustWorkflowContractTests = [
  "scripts/ci-rust-workflow.test.mts",
  "scripts/rust-validation-setup.test.mts",
  "scripts/ci-workflow-fixture.test.mts",
  "scripts/qualification-coverage.test.mts",
  "scripts/windows-rust-tests.test.mts",
  "scripts/select-ci-plan.test.mts",
];
const workflowFeatureTests = [
  "scripts/ci-frontend-workflow.test.mts",
  "scripts/ci-native-workflow.test.mts",
  "scripts/ci-release-workflow.test.mts",
  ...rustWorkflowContractTests,
  "scripts/nextest-equivalence.test.mts",
  "scripts/native-backup-evidence.test.mts",
  "scripts/rust-toolchain-reader.test.mts",
];
const workflowContractTests = ["scripts/ci-workflow.test.mts", ...workflowFeatureTests];
export const nodeTestOwnership = parseNodeTestSuites(
  readFileSync(new URL("./node-test-suites.json", import.meta.url), "utf8"),
);
const platformSkipConsumers = [
  "scripts/node-platform-skips.test.mts",
  "scripts/required-node-test-reporter.test.mts",
  "scripts/python-test-results.test.mts",
  "scripts/node-test-inventory.test.mts",
  "scripts/precommit-check.test.mts",
  "scripts/windows-helper-checks.test.mts",
  "scripts/ui-test-selection.test.mts",
  "scripts/validation-evidence.test.mts",
  "scripts/audit.test.mts",
  ...Object.keys(nodeTestOwnership.platformSkips ?? {}).filter((file) => nodeTestPath.test(file)),
];
const explicitNodeTests = new Map<string, readonly string[]>();
for (const [file, tests] of [
  [
    "scripts/local-validation.mts",
    [...selectionContractTests, "scripts/repository-settings.test.mts"],
  ],
  [
    "scripts/ordinary-validation.mts",
    [...selectionContractTests, "scripts/validation-evidence.test.mts"],
  ],
  ["scripts/node-platform-skips.mts", platformSkipConsumers],
  [
    "scripts/repository-path.mts",
    [...selectionContractTests, "scripts/validation-evidence.test.mts"],
  ],
  ["scripts/fixtures/rscheck-portability-baseline.json", ["scripts/run-rscheck.test.mts"]],
  [
    "scripts/fixtures/rscheck-qualification-regression-literals.json",
    ["scripts/run-rscheck.test.mts"],
  ],
  ["scripts/ci-job-timeout-probe.mts", ["scripts/ci-job-timeout-probe.test.mts"]],
  [".github/workflows/job-timeout-rehearsal.yml", ["scripts/ci-job-timeout-probe.test.mts"]],
  ...[
    ".github/actions/retain-browser-diagnostics/action.yml",
    ".github/workflows/browser-artifact-custody.yml",
    "scripts/fixtures/browser-upload-baseline.json",
    "apps/desktop/scripts/browser-screenshot-custody.mts",
  ].map((file): [string, string[]] => [file, ["scripts/ci-frontend-workflow.test.mts"]]),
  ["scripts/rust-coverage.mts", ["scripts/rust-coverage.test.mts"]],
  [".config/rust-coverage.json", ["scripts/rust-coverage.test.mts"]],
  ["scripts/ci-workflow.test.mts", workflowContractTests],
  ["scripts/ci-workflow-fixture.mts", workflowContractTests],
  ...workflowFeatureTests.map((file): [string, string[]] => [
    file,
    ["scripts/ci-workflow.test.mts"],
  ]),
  [
    "scripts/node-case-observations.mts",
    ["scripts/test-duration-reporter.test.mts", "scripts/required-node-test-reporter.test.mts"],
  ],
  [
    "scripts/required-node-test-reporter.mts",
    [
      ...platformSkipConsumers,
      "scripts/ci-baseline.test.mts",
      "scripts/node-test-inventory.test.mts",
    ],
  ],
  [
    "scripts/test-duration-reporter.mts",
    ["scripts/test-duration-reporter.test.mts", "scripts/required-node-test-reporter.test.mts"],
  ],
  ...["scripts/python-test-results.py", "scripts/python-test-results.mts"].map(
    (file): [string, readonly string[]] => [file, pythonContractTests],
  ),
  [
    "apps/desktop/scripts/desktop-webview-boundary.mts",
    [
      "scripts/desktop-boundary-wiring.test.mts",
      "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
    ],
  ],
  [
    "apps/desktop/scripts/desktop-boundary-invoke.mts",
    [
      "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
      "scripts/native-helper-dependencies.test.mts",
    ],
  ],
  [
    "scripts/fixtures/desktop-module-fixture.mts",
    [
      "apps/desktop/scripts/desktop-catalog-update.native.test.mts",
      "apps/desktop/scripts/desktop-default-cover.native.test.mts",
      "apps/desktop/scripts/desktop-reload.native.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-boundary-wiring.test.mts",
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-real-runtime.test.mts",
      "apps/desktop/scripts/desktop-remainder-scenarios.native.test.mts",
      "apps/desktop/scripts/desktop-artwork-correction.native.test.mts",
      "scripts/capture-target.test.mts",
    ],
  ],
  [
    "apps/desktop/scripts/desktop-windows-embedded-session.mts",
    [
      "apps/desktop/scripts/desktop-native-observations.native.test.mts",
      "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
    ],
  ],
  [
    "apps/desktop/scripts/browser-script.mts",
    [
      "apps/desktop/scripts/desktop-webview-boundary.native.test.mts",
      "apps/desktop/scripts/desktop-main-webview-boundary.native.test.mts",
      "scripts/native-helper-dependencies.test.mts",
    ],
  ],
  ["apps/desktop/scripts/native-enlargement.mts", ["scripts/desktop-execution-plan.test.mts"]],
  [
    "apps/desktop/scripts/desktop-capture-target.mts",
    ["scripts/capture-target.test.mts", "scripts/native-helper-dependencies.test.mts"],
  ],
  ["scripts/prepare-port.mts", ["scripts/prepare-port.test.mts"]],
  ["scripts/catalog-capacity.mts", ["scripts/sign-catalog.test.mts"]],
  [
    "scripts/artwork-preparation-progress.mts",
    ["scripts/prepare-port.test.mts", "scripts/catalog-artwork-batches.test.mts"],
  ],
  ["scripts/port-upstream-facts.mts", ["scripts/prepare-port.test.mts"]],
  [
    "scripts/catalog-authoring-inspector.mts",
    ["scripts/prepare-port.test.mts", ...catalogGeneratorContractTests],
  ],
  [
    "scripts/catalog-authoring.mts",
    [
      "scripts/prepare-port.test.mts",
      ...catalogAuthoringContractTests,
      "scripts/catalog-staged-check.test.mts",
    ],
  ],
  ...[
    "release-controller-configuration",
    "release-controller-job",
    "release-controller-job-bootstrap",
    "release-controller-job-output",
    "release-aggregate-locator",
    "release-coordinator-namespace",
  ].map((name): [string, string[]] => [
    `scripts/${name}.mts`,
    [
      "scripts/release-tuf-controller.test.mts",
      "scripts/release-controller-tools.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ]),
  [
    ".github/actions/release-controller-job/action.yml",
    [
      "scripts/release-controller-tools.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ],
  ...[
    "release-control-phases",
    "release-input-protections",
    "release-control-ready",
    "release-reviewed-inputs",
    "release-controller-tool-bootstrap",
  ].map((name): [string, string[]] => [
    `scripts/${name}.mts`,
    [
      "scripts/release-control-inputs.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ]),
  [
    "scripts/production-controller-admission.mts",
    [
      "scripts/production-controller-admission.test.mts",
      "scripts/release-catalog-authorities.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ],
  ["scripts/read-native-wsl-host.ps1", ["scripts/release-native-wsl-boundary.test.mts"]],
  [
    "scripts/native-qualification-linux-transfer.py",
    ["scripts/native-qualification-linux-transfer.test.mts"],
  ],
  [
    "scripts/native-qualification-linux-transfer.test.py",
    ["scripts/native-qualification-linux-transfer.test.mts"],
  ],
  [
    "apps/desktop/scripts/native-linux-isolated-plan.mts",
    ["scripts/native-linux-isolated-plan.test.mts"],
  ],
  [
    "apps/desktop/scripts/native-linux-isolated-session.mts",
    ["scripts/native-linux-isolated-plan.test.mts", "scripts/desktop-linux-stop.test.mts"],
  ],
  [
    "scripts/native-qualification-linux-supervisor.py",
    ["scripts/native-qualification-linux-supervisor.test.mts"],
  ],
  [
    "scripts/native-qualification-linux-supervisor.test.py",
    ["scripts/native-qualification-linux-supervisor.test.mts"],
  ],
  [
    "apps/desktop/scripts/native-linux-isolated-init.py",
    ["scripts/native-linux-isolated-init.test.mts"],
  ],
  ["scripts/native-linux-isolated-init.test.py", ["scripts/native-linux-isolated-init.test.mts"]],
  ...["release-tuf-controller", "release-tuf-launch", "release-signing-job-budget"].map(
    (name): [string, string[]] => [
      `scripts/${name}.mts`,
      ["scripts/release-tuf-controller.test.mts"],
    ],
  ),
  ...[
    "release-metadata-signing-contract",
    "release-metadata-signing-context",
    "release-metadata-signing-controller",
  ].map((name): [string, string[]] => [
    `scripts/${name}.mts`,
    ["scripts/release-metadata-signing-context.test.mts"],
  ]),
  [
    "scripts/release-metadata-context-recovery.mts",
    ["scripts/release-metadata-context-recovery.test.mts"],
  ],
  [
    "scripts/release-candidate-signing-recovery.mts",
    ["scripts/release-candidate-signing-recovery.test.mts"],
  ],
  [
    "scripts/release-pending-release-recovery.mts",
    ["scripts/release-pending-release-recovery.test.mts"],
  ],
  ["scripts/release-effect-contract.mts", ["scripts/release-pending-release-recovery.test.mts"]],
  [
    "scripts/release-pending-result-recovery.mts",
    ["scripts/release-pending-result-recovery.test.mts"],
  ],
  [
    "scripts/release-report-repair-contract.mts",
    ["scripts/release-report-repair-contract.test.mts"],
  ],
  [
    "scripts/release-report-repair-identity.mts",
    ["scripts/release-report-repair-identity.test.mts"],
  ],
  [
    "scripts/release-run-artifact-inventory.mts",
    ["scripts/release-run-artifact-inventory.test.mts"],
  ],
  [
    "scripts/release-metadata-site-controller.mts",
    ["scripts/release-metadata-site-controller.test.mts"],
  ],
  ...["worker", "worker-recovery", "request-pipeline"].map((name): [string, string[]] => [
    `scripts/release-semantic-${name}.mts`,
    [
      "scripts/release-semantic-worker.test.mts",
      ...(name === "request-pipeline"
        ? []
        : ["scripts/release-catalog-review-maintenance.test.mts"]),
    ],
  ]),
  ...[
    "scripts/release-semantic-source.mts",
    "scripts/semantic-source-git.py",
    "scripts/semantic-source-git.test.py",
    "scripts/qualify-semantic-source.mts",
  ].map((name): [string, string[]] => [name, ["scripts/release-semantic-source.test.mts"]]),
  [
    "scripts/release-classification-request.mts",
    ["scripts/release-classification-request.test.mts"],
  ],
  ["scripts/release-preparation-source.mts", ["scripts/release-preparation-source.test.mts"]],
  ["scripts/release-coordinator-driver.mts", ["scripts/release-coordinator-driver.test.mts"]],
  ["scripts/release-coordinator-deadline.mts", ["scripts/release-coordinator-deadline.test.mts"]],
  ["scripts/release-review-request.mts", ["scripts/release-review-request.test.mts"]],
  ["scripts/release-candidate-dispatch.mts", ["scripts/release-candidate-dispatch.test.mts"]],
  ["scripts/release-candidate-progress.mts", ["scripts/release-candidate-progress.test.mts"]],
  [
    "scripts/release-admitted-aggregate-controller.mts",
    ["scripts/release-admitted-aggregate-controller.test.mts"],
  ],
  [
    "scripts/release-aggregate-contract.mts",
    ["scripts/release-admitted-aggregate-controller.test.mts"],
  ],
  [
    "scripts/release-aggregate-upload.mts",
    ["scripts/release-admitted-aggregate-controller.test.mts"],
  ],
  [
    "scripts/release-readonly-child-environment.mts",
    ["scripts/release-admitted-aggregate-controller.test.mts"],
  ],

  [
    "scripts/release-candidate-progress-contract.mts",
    ["scripts/release-candidate-progress-contract.test.mts"],
  ],
  ["scripts/release-published-source.mts", ["scripts/release-published-source.test.mts"]],
  ["scripts/release-semantic-disposition.mts", ["scripts/release-semantic-disposition.test.mts"]],
  [
    "scripts/release-semantic-disposition-reader.mts",
    ["scripts/release-semantic-disposition-reader.test.mts"],
  ],
  [
    "scripts/fixtures/release-semantic-disposition-fixture.mts",
    [
      "scripts/release-semantic-disposition.test.mts",
      "scripts/release-semantic-disposition-reader.test.mts",
    ],
  ],
  [
    "scripts/release-coordinator-journal-api.mts",
    ["scripts/release-coordinator-journal-api.test.mts"],
  ],
  ["scripts/release-site-deployment.mts", ["scripts/release-site-deployment.test.mts"]],
  ["scripts/release-site-controller.mts", ["scripts/release-site-controller.test.mts"]],
  ["scripts/release-site-launch.mts", ["scripts/release-site-controller.test.mts"]],
  ["scripts/release-control-step-bridge.mts", ["scripts/release-control-step-bridge.test.mts"]],
  ["scripts/release-controller-transport.mts", ["scripts/release-controller-transport.test.mts"]],
  [
    "scripts/release-controller-diagnostics.mts",
    [
      "scripts/release-controller-transport.test.mts",
      "scripts/release-hosted-native-runner.test.mts",
    ],
  ],
  [
    "docs/qualification/application-update-production.complete.yml",
    ["scripts/release-production-dag.test.mts"],
  ],
  [
    ".github/actions/release-control-observer/action.yml",
    ["scripts/release-production-dag.test.mts"],
  ],
  [
    ".github/actions/release-controller-transport/action.yml",
    ["scripts/release-controller-transport.test.mts"],
  ],
  ["scripts/release-site-job-budget.mts", ["scripts/release-site-controller.test.mts"]],

  ["scripts/release-site-readback.mts", ["scripts/release-site-readback.test.mts"]],
  [
    "scripts/release-site-generation.mts",
    ["scripts/release-site-composer.test.mts", "scripts/release-site-readback.test.mts"],
  ],
  ["scripts/release-catalog-inspection.mts", ["scripts/release-catalog-inspection.test.mts"]],
  ["scripts/release-catalog-semantic.mts", ["scripts/release-catalog-semantic.test.mts"]],
  [
    "scripts/release-catalog-signing.mts",
    [
      "scripts/release-catalog-signing.test.mts",
      "scripts/release-catalog-recovery.test.mts",
      "scripts/release-catalog-context-boundary.test.mts",
    ],
  ],
  [
    "scripts/release-catalog-signing-context.mts",
    [
      "scripts/release-catalog-signing.test.mts",
      "scripts/release-catalog-context-boundary.test.mts",
    ],
  ],
  ["scripts/release-catalog-signing-contract.mts", ["scripts/release-catalog-signing.test.mts"]],
  [
    "scripts/release-catalog-source.mts",
    ["scripts/release-catalog-source.test.mts", "scripts/release-catalog-coordinator.test.mts"],
  ],
  [
    "scripts/release-catalog-review-request.mts",
    [
      "scripts/release-catalog-review-maintenance.test.mts",
      "scripts/release-catalog-review-request.test.mts",
      "scripts/release-catalog-review-disposition.test.mts",
      "scripts/release-catalog-coordinator.test.mts",
    ],
  ],
  [
    "scripts/release-catalog-review-disposition.mts",
    [
      "scripts/release-catalog-review-disposition.test.mts",
      "scripts/release-catalog-coordinator.test.mts",
    ],
  ],
  ["scripts/release-catalog-coordinator.mts", ["scripts/release-catalog-coordinator.test.mts"]],
  [
    "scripts/release-catalog-recovery.mts",
    ["scripts/release-catalog-continuation.test.mts", "scripts/release-catalog-recovery.test.mts"],
  ],
  [
    "scripts/release-catalog-site-controller.mts",
    ["scripts/release-catalog-site-controller.test.mts"],
  ],
  [
    "scripts/release-catalog-publication-contract.mts",
    ["scripts/release-capacity-operation.test.mts"],
  ],
  [
    "scripts/fixtures/release-catalog-publication-fixture.mts",
    ["scripts/release-capacity-operation.test.mts"],
  ],
  [
    "scripts/release-catalog-metadata-contract.mts",
    [
      "scripts/release-catalog-metadata-contract.test.mts",
      "scripts/release-capacity-operation.test.mts",
    ],
  ],
  ["scripts/release-metadata-renewal.mts", ["scripts/release-metadata-renewal.test.mts"]],
  ["scripts/release-bootstrap-preparation.mts", ["scripts/release-bootstrap-preparation.test.mts"]],
  [
    "scripts/release-bootstrap-public-inputs.mts",
    ["scripts/release-bootstrap-preparation.test.mts"],
  ],
  [
    "scripts/release-compiler-source-closure.mts",
    ["scripts/release-compiler-source.test.mts", "scripts/release-controller-tools.test.mts"],
  ],
  [
    "scripts/release-compiler-source-admission.mts",
    [
      "scripts/release-compiler-source-admission.test.mts",
      "scripts/release-compiler-evidence.test.mts",
    ],
  ],
  [
    "scripts/release-source-attestation.mts",
    ["scripts/release-source-attestation.test.mts", "scripts/release-compiler-evidence.test.mts"],
  ],
  [
    "scripts/release-compiler-source.mts",
    [
      "scripts/release-compiler-source.test.mts",
      "scripts/release-compiler-source-admission.test.mts",
    ],
  ],
  [
    "scripts/release-compiler-evidence.mts",
    ["scripts/release-compiler-evidence.test.mts", "scripts/acquire-release-admission.test.mts"],
  ],
  [
    "scripts/release-compiler-outputs.mts",
    ["scripts/release-compiler-outputs.test.mts", "scripts/release-compiler-evidence.test.mts"],
  ],
  [
    "scripts/release-compiler-desktop.mts",
    [
      "scripts/release-compiler-outputs.test.mts",
      "scripts/release-compiler-capture.test.mts",
      "scripts/release-compiler-evidence.test.mts",
    ],
  ],
  ["scripts/release-publication-inventory.mts", ["scripts/acquire-release-admission.test.mts"]],
  ["scripts/release-site-composer.mts", ["scripts/release-site-composer.test.mts"]],
  ["scripts/release-pages-provider.mts", ["scripts/release-pages-provider.test.mts"]],
  ["scripts/release-pages-recovery.mts", ["scripts/release-pages-recovery.test.mts"]],
  [
    "scripts/release-pages-metadata-recovery.mts",
    ["scripts/release-pages-metadata-recovery.test.mts"],
  ],
  ["scripts/release-capacity-executor.mts", ["scripts/release-capacity-executor.test.mts"]],
  [
    "scripts/release-native-admission.mts",
    [
      "scripts/release-native-admission.test.mts",
      "scripts/release-native-check-discovery.test.mts",
    ],
  ],
  [
    "scripts/release-native-check-discovery.mts",
    ["scripts/release-native-check-discovery.test.mts"],
  ],
  ["scripts/release-native-stage-capture.mts", ["scripts/release-native-stage-capture.test.mts"]],
  ["scripts/release-native-scheduler.mts", ["scripts/release-native-scheduler.test.mts"]],
  ["scripts/release-local-native-setup.mts", ["scripts/release-local-native-setup.test.mts"]],
  ["scripts/release-local-worker-tasks.mts", ["scripts/release-local-worker-tasks.test.mts"]],
  ["scripts/release-local-worker-accounts.ps1", ["scripts/release-local-worker-accounts.test.mts"]],
  ["scripts/resume-local-worker-profile.ps1", ["scripts/release-local-worker-accounts.test.mts"]],
  [
    "scripts/recover-local-worker-empty-setup.ps1",
    ["scripts/recover-local-worker-empty-setup.test.mts"],
  ],
  [
    "scripts/release-native-account-capability.mts",
    ["scripts/release-native-account-capability.test.mts"],
  ],
  ["scripts/release-native-parent.mts", ["scripts/release-native-parent.test.mts"]],
  ["scripts/release-native-wsl-boundary.mts", ["scripts/release-native-wsl-boundary.test.mts"]],
  [
    "apps/desktop/scripts/native-linux-driver-http.mts",
    ["scripts/native-linux-driver-http.test.mts"],
  ],
  [
    "scripts/release-native-candidate.mts",
    ["scripts/release-native-candidate.test.mts", "scripts/release-native-attempt.test.mts"],
  ],
  ["scripts/release-native-keyless-assembly.mts", ["scripts/release-native-candidate.test.mts"]],
  [
    "scripts/release-native-linux-public-capture.mts",
    ["scripts/release-native-linux-public-capture.test.mts"],
  ],
  [
    "scripts/release-native-attempt.mts",
    [
      "scripts/release-native-attempt.test.mts",
      "scripts/release-native-public-attempt-contract.test.mts",
    ],
  ],
  ...["pair", "compiler", "signature", "attempt-contract"].map(
    (name): [string, readonly string[]] => [
      `scripts/release-native-public-${name}.mts`,
      [`scripts/release-native-public-${name}.test.mts`],
    ],
  ),
  [
    "scripts/release-compiler-report-archive.mts",
    [
      "scripts/release-compiler-evidence.test.mts",
      "scripts/release-native-public-compiler.test.mts",
    ],
  ],
  [
    "scripts/release-native-source-contract.mts",
    ["scripts/release-native-source-contract.test.mts"],
  ],
  [
    "scripts/release-native-source-provider.mts",
    [
      "scripts/release-native-source-provider.test.mts",
      "scripts/release-native-source-contract.test.mts",
    ],
  ],
  [
    "scripts/release-native-linux-report.mts",
    [
      "scripts/release-hosted-native-linux-report.test.mts",
      "scripts/release-native-pre-sign-report.test.mts",
    ],
  ],
  ["scripts/release-hosted-native-job.mts", ["scripts/release-hosted-native-job.test.mts"]],
  [
    "scripts/release-hosted-native-installation.mts",
    ["scripts/release-hosted-native-installation.test.mts"],
  ],
  [
    "scripts/release-pnpm-runtime.mts",
    [
      "scripts/release-pnpm-runtime.test.mts",
      "scripts/release-hosted-native-installation.test.mts",
    ],
  ],
  [
    "scripts/prepare-hosted-native-linux-installation.py",
    ["scripts/release-hosted-native-installation.test.mts"],
  ],
  [
    "scripts/prepare-hosted-native-linux-installation.test.py",
    ["scripts/release-hosted-native-installation.test.mts"],
  ],
  [
    "scripts/release-hosted-native-postsign-inputs.mts",
    ["scripts/release-hosted-native-job.test.mts", "scripts/release-controller-tools.test.mts"],
  ],
  [
    "scripts/qualify-controller-tools-windows.mts",
    [
      "scripts/release-hosted-native-windows-dependency-files.test.mts",
      "scripts/release-controller-tools.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-windows-dependency-files.mts",
    [
      "scripts/release-hosted-native-windows-dependency-files.test.mts",
      "scripts/release-hosted-native-windows-source.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-windows-installation.mts",
    [
      "scripts/release-hosted-native-windows-installation.test.mts",
      "scripts/release-hosted-native-windows-source.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-windows-source.mts",
    [
      "scripts/release-hosted-native-windows-source.test.mts",
      "scripts/release-hosted-native-windows-dependency-files.test.mts",
      "scripts/release-hosted-native-windows-installation.test.mts",
      "scripts/release-hosted-native-windows-bootstrap.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-runner.mts",
    [
      "scripts/release-hosted-native-runner.test.mts",
      "scripts/release-hosted-native-job.test.mts",
      "scripts/release-hosted-native-windows-bootstrap.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-bootstrap.mts",
    [
      "scripts/release-hosted-native-runner.test.mts",
      "scripts/release-hosted-native-job.test.mts",
      "scripts/release-hosted-native-windows-bootstrap.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-launcher.mts",
    ["scripts/release-hosted-native-runner.test.mts", "scripts/release-hosted-native-job.test.mts"],
  ],
  [
    "scripts/release-hosted-native-worker.mts",
    ["scripts/release-hosted-native-runner.test.mts", "scripts/release-hosted-native-job.test.mts"],
  ],
  [
    "scripts/release-hosted-native-workflow.mts",
    ["scripts/release-hosted-native-runner.test.mts", "scripts/release-hosted-native-job.test.mts"],
  ],
  [
    "scripts/release-native-presign-readiness.mts",
    ["scripts/release-native-presign-readiness.test.mts"],
  ],
  [
    "scripts/release-native-postsign-readiness.mts",
    ["scripts/release-hosted-native-runner.test.mts", "scripts/release-hosted-native-job.test.mts"],
  ],
  [
    ".github/actions/release-native-linux/action.yml",
    ["scripts/release-hosted-native-runner.test.mts"],
  ],
  ...[
    "scripts/release-hosted-native-runtime.mts",
    "scripts/release-native-runtime-support.mts",
  ].map((file): [string, string[]] => [
    file,
    ["scripts/release-hosted-native-runner.test.mts", "scripts/release-controller-tools.test.mts"],
  ]),
  [
    "scripts/release-native-runtime-custody.mts",
    [
      "scripts/release-hosted-native-runner.test.mts",
      "scripts/release-controller-tools.test.mts",
      "scripts/release-native-runtime-custody.test.mts",
      "scripts/release-hosted-native-windows-source.test.mts",
    ],
  ],
  [
    "scripts/release-routing-marker.mts",
    [
      "scripts/release-routing-marker.test.mts",
      "scripts/release-controller-transport.test.mts",
      "scripts/release-hosted-native-runner.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-proof-producer.mts",
    [
      "scripts/release-hosted-native-proof-producer.test.mts",
      "scripts/release-hosted-native-proof.test.mts",
      "scripts/release-hosted-native-job.test.mts",
    ],
  ],
  [
    "scripts/release-hosted-native-windows-host.mts",
    [
      "scripts/release-hosted-native-windows-host.test.mts",
      "scripts/release-native-pre-sign-report.test.mts",
      "scripts/release-hosted-native-proof.test.mts",
    ],
  ],
  [
    "scripts/release-owned-windows-proof-store.mts",
    ["scripts/release-owned-windows-proof-store.test.mts"],
  ],
  [
    "scripts/release-owned-capture-store.mts",
    [
      "scripts/release-checkpoint-store.test.mts",
      "scripts/release-coordinator-checkpoint-signing.test.mts",
      "scripts/release-semantic-broker.test.mts",
      "scripts/release-hosted-native-proof-producer.test.mts",
    ],
  ],
  [
    "scripts/fixtures/native-linux-report-fixture.mts",
    [
      "scripts/release-hosted-native-linux-report.test.mts",
      "scripts/release-native-pre-sign-report.test.mts",
    ],
  ],
  [
    "scripts/release-native-pre-sign-report.mts",
    ["scripts/release-native-pre-sign-report.test.mts"],
  ],
  ["scripts/release-native-check-broker.mts", ["scripts/release-native-check-broker.test.mts"]],
  [
    "scripts/release-native-worker.mts",
    [
      "scripts/release-native-windows-driver.test.mts",
      "scripts/release-native-public-attempt-contract.test.mts",
      "scripts/release-native-linux-public-capture.test.mts",
    ],
  ],
  [
    "scripts/release-native-windows-capture.mts",
    [
      "scripts/release-native-windows-driver.test.mts",
      "scripts/release-native-public-attempt-contract.test.mts",
      "scripts/release-native-public-signature.test.mts",
    ],
  ],
  ["scripts/release-native-windows-driver.ps1", ["scripts/release-native-windows-driver.test.mts"]],
  [
    "scripts/native-qualification-runtime-observation.psm1",
    ["scripts/release-native-windows-driver.test.mts"],
  ],
  [
    "scripts/release-native-windows-public-continuation.mts",
    [
      "scripts/release-native-windows-public-continuation.test.mts",
      "scripts/release-native-windows-driver.test.mts",
    ],
  ],
  [
    "scripts/fixtures/native-authority-configuration-fixture.mts",
    ["scripts/release-native-parent.test.mts"],
  ],
  ["scripts/read-native-scheduler.ps1", ["scripts/release-native-scheduler.test.mts"]],
  ["scripts/release-signing-handoff.mts", ["scripts/release-signing-handoff.test.mts"]],
  ["scripts/release-tuf-role-artifact.mts", ["scripts/release-tuf-role-artifact.test.mts"]],
  [
    "scripts/fixtures/tuf-worker-fixture.mts",
    ["scripts/release-tuf-signing.test.mts", "scripts/release-connected-fixture.test.mts"],
  ],
  ["scripts/release-tuf-signing.mts", ["scripts/release-tuf-signing.test.mts"]],
  ["scripts/release-signing-context.mts", ["scripts/release-signing-context.test.mts"]],
  [
    "scripts/release-preview-withdrawals.mts",
    [
      "scripts/release-preview-withdrawals.test.mts",
      "scripts/reconstruct-application-update-records.test.mts",
    ],
  ],
  [
    "release-preview-withdrawals.json",
    [
      "scripts/release-preview-withdrawals.test.mts",
      "scripts/reconstruct-application-update-records.test.mts",
    ],
  ],
  [
    "scripts/release-publication-controller.mts",
    ["scripts/release-publication-controller.test.mts"],
  ],
  ["scripts/release-publication-handoff.mts", ["scripts/release-publication-controller.test.mts"]],
  ["scripts/release-publication-inputs.mts", ["scripts/release-publication-inputs.test.mts"]],
  ["scripts/release-publication-source.mts", ["scripts/release-publication-source.test.mts"]],
  [
    "scripts/linux-beta-risk-706-preparation.mts",
    ["scripts/linux-beta-risk-706.test.mts", "scripts/release-publication-source.test.mts"],
  ],
  [
    "scripts/linux-beta-risk-706-profile.mts",
    ["scripts/linux-beta-risk-706-controller.test.mts", "scripts/linux-beta-risk-706.test.mts"],
  ],
  [
    "scripts/linux-beta-risk-706-controller.mts",
    [
      "scripts/linux-beta-risk-706-controller.test.mts",
      "scripts/release-compiler-evidence.test.mts",
      "scripts/release-immutable-publication.test.mts",
      "scripts/release-site-deployment.test.mts",
    ],
  ],
  ["scripts/release-tuf-publication.mts", ["scripts/release-tuf-signing.test.mts"]],
  [
    "scripts/release-native-publication-admission.mts",
    ["scripts/release-native-admission.test.mts", "scripts/release-hosted-native-history.test.mts"],
  ],
  [
    "scripts/release-hosted-native-history.mts",
    [
      "scripts/release-hosted-native-history.test.mts",
      "scripts/release-native-checkpoint-custody.test.mts",
    ],
  ],
  [
    "scripts/release-controller-wake.mts",
    [
      "scripts/release-catalog-review-maintenance.test.mts",
      "scripts/release-controller-wake.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ],
  ["scripts/release-publication-result.mts", ["scripts/release-publication-result.test.mts"]],
  [
    "scripts/release-publication-result-artifact.mts",
    [
      "scripts/release-publication-result-artifact.test.mts",
      "scripts/release-controller-transport.test.mts",
    ],
  ],
  [
    "scripts/release-signing-context-artifact.mts",
    [
      "scripts/release-signing-context-artifact.test.mts",
      "scripts/release-controller-transport.test.mts",
    ],
  ],
  [
    "scripts/release-authority-configuration.mts",
    [
      "scripts/production-controller-admission.test.mts",
      "scripts/release-bootstrap-preparation.test.mts",
      "scripts/release-catalog-authorities.test.mts",
    ],
  ],
  ...["fuse", "services"].flatMap((name): [string, string[]][] => [
    [
      `apps/desktop/scripts/native-linux-public-${name}.py`,
      [`scripts/native-linux-public-${name}.test.mts`],
    ],
    [
      `apps/desktop/scripts/native-linux-public-${name}.test.py`,
      [`scripts/native-linux-public-${name}.test.mts`],
    ],
  ]),
  [
    "apps/desktop/scripts/native-linux-public-plan.mts",
    ["scripts/native-linux-public-plan.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-public-update-state.mts",
    [
      "apps/desktop/scripts/desktop-public-update-state.native.test.mts",
      "apps/desktop/scripts/desktop-windows-public-update.native.test.mts",
    ],
  ],
  [
    "apps/desktop/scripts/desktop-public-update-files.mts",
    [
      "apps/desktop/scripts/desktop-linux-public-update.native.test.mts",
      "apps/desktop/scripts/desktop-windows-public-update.native.test.mts",
    ],
  ],
  [
    "apps/desktop/scripts/desktop-linux-public-update.mts",
    ["apps/desktop/scripts/desktop-linux-public-update.native.test.mts"],
  ],
  ...[
    "apps/desktop/scripts/native-linux-public-network.py",
    "apps/desktop/scripts/native-linux-public-network.test.py",
  ].map((name): [string, string[]] => [name, ["scripts/native-linux-public-network.test.mts"]]),
  ...[
    "scripts/semantic-review-linux-supervisor.py",
    "scripts/semantic-review-linux-supervisor.test.py",
    "scripts/qualify-semantic-linux.mts",
  ].map((name): [string, string[]] => [
    name,
    [
      "scripts/semantic-review-linux-supervisor.test.mts",
      "scripts/release-semantic-broker.test.mts",
      "scripts/release-semantic-worker.test.mts",
    ],
  ]),
  ...[
    "inputs",
    "proposal",
    "issuer",
    "issuer-http",
    "runtime",
    "reader",
    "reader-core",
    "reader-server",
    "broker",
  ].map((name): [string, string[]] => [
    `scripts/release-semantic-${name}.mts`,
    ["scripts/release-semantic-broker.test.mts"],
  ]),
  [".github/workflows/native-design-compatibility.yml", ["scripts/workflow-provenance.test.mts"]],
  [
    "scripts/validation-evidence.mts",
    [...selectionContractTests, "scripts/validation-evidence.test.mts", "scripts/audit.test.mts"],
  ],
  [".fallow-tooling.json", ["scripts/fallow-scope.test.mts", "scripts/run-fallow.test.mts"]],
  ...[
    "scripts/container-host.mts",
    "scripts/container-build.mts",
    "scripts/container-build-entry.mts",
    "scripts/container-build-policy.mts",
    "tools/containers/build/Dockerfile",
  ].map((file): [string, string[]] => [
    file,
    ["scripts/container-browser.test.mts", "scripts/container-build.test.mts"],
  ]),
  ...[
    "scripts/container-browser.mts",
    "scripts/container-entry.mts",
    "scripts/container-source.mts",
    "tools/containers/browser/Dockerfile",
  ].map((file): [string, string[]] => [file, ["scripts/container-browser.test.mts"]]),
  ...[
    "scripts/frontend-command-preflight.mts",
    "apps/desktop/scripts/build-frontend.mts",
    "scripts/viteplus-cli.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/frontend-command-preflight.test.mts",
      "scripts/desktop-verify.test.mts",
      "scripts/desktop-execution-plan.test.mts",
      "scripts/windows-helper-checks.test.mts",
    ],
  ]),
  [
    "scripts/desktop-execution-plan.test.mts",
    ["scripts/desktop-scenarios.test.mts", "scripts/desktop-verify.test.mts"],
  ],
  ...["scripts/desktop-execution-baseline.mts", "scripts/desktop-execution-baseline.test.mts"].map(
    (file): [string, string[]] => [file, ["scripts/desktop-execution-plan.test.mts"]],
  ),
  ...[
    "scripts/desktop-execution-plan.mts",
    "scripts/desktop-scenarios.mts",
    "scripts/desktop-verify.mts",
    "scripts/operation-coverage.mts",
    "scripts/testdata/desktop-execution-baseline.json",
    "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-verify.test.mts",
      "scripts/frontend-command-preflight.test.mts",
      "scripts/development-evidence.test.mts",
      "scripts/native-helper-dependencies.test.mts",
      "scripts/windows-helper-checks.test.mts",
    ],
  ]),
  ...[
    "apps/desktop/scripts/desktop-application-update-journey.mts",
    "apps/desktop/scripts/desktop-windows-public-update.mts",
    "apps/desktop/scripts/desktop-windows-public-update-files.mts",
  ].map((file): [string, string[]] => [file, ["scripts/desktop-scenarios.test.mts"]]),
  ...[
    "scripts/validation-plan.mts",
    "scripts/validation-plan.test.mts",
    "scripts/local-validation.test.mts",
  ].map((file): [string, string[]] => [file, selectionContractTests]),
  ...[
    "apps/desktop/scripts/desktop-installed-update-harness.mts",
    "apps/desktop/scripts/desktop-windows-update-test.mts",
    "apps/desktop/scripts/desktop-macos-installed-update-test.mts",
  ].map((file): [string, string[]] => [
    file,
    ["scripts/desktop-scenarios.test.mts", "scripts/desktop-boundary-wiring.test.mts"],
  ]),
  [
    "apps/desktop/scripts/desktop-qualification-history-test.mts",
    ["scripts/desktop-scenarios.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-host-publication-test.mts",
    [
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-boundary-wiring.test.mts",
    ],
  ],
  ["AGENTS.md", ["scripts/repository-settings.test.mts", "scripts/repository-skills.test.mts"]],
  [
    "scripts/fixtures/disposable-directory.mts",
    [
      "scripts/desktop-boundary-wiring.test.mts",
      "scripts/catalog-proposal-costs.test.mts",
      "scripts/fixture-module-closure.test.mts",
      "scripts/node-platform-skips.test.mts",
      "scripts/node-test-inventory.test.mts",
      "scripts/precommit-check.test.mts",
      "scripts/python-test-results.test.mts",
      "scripts/release-catalog-review-request.test.mts",
      "scripts/release-control-inputs.test.mts",
      "scripts/release-hosted-native-history.test.mts",
      "scripts/release-hosted-native-linux-capture.test.mts",
      "scripts/release-hosted-native-linux-report.test.mts",
      "scripts/release-native-pre-sign-report.test.mts",
      "scripts/release-native-source-provider.test.mts",
      "scripts/release-hosted-native-proof-producer.test.mts",
      "scripts/release-native-wsl-capture.test.mts",
      "scripts/release-hosted-native-job.test.mts",
      "scripts/release-hosted-native-runner.test.mts",
      "scripts/release-hosted-native-windows-bootstrap.test.mts",
      "scripts/release-hosted-native-windows-capture.test.mts",
      "scripts/release-hosted-native-windows-runner.test.mts",
      "scripts/release-hosted-native-windows-source.test.mts",
      "scripts/release-hosted-native-windows-workflow.test.mts",
      "scripts/release-hosted-native-windows-dependency-files.test.mts",
      "scripts/native-qualification-account.test.mts",
      "scripts/release-owned-windows-proof-store.test.mts",
      "scripts/release-windows-webview-driver.test.mts",
      "scripts/release-routing-marker.test.mts",
      "scripts/release-run-evidence.test.mts",
      "scripts/required-node-test-reporter.test.mts",
      "scripts/test-duration-reporter.test.mts",
      "scripts/ui-test-selection.test.mts",
      "scripts/windows-historical-bootstrap.test.mts",
    ],
  ],
  [
    "scripts/fixtures/module-closure.mts",
    [
      "scripts/desktop-boundary-wiring.test.mts",
      "scripts/fixture-module-closure.test.mts",
      "scripts/precommit-check.test.mts",
      "scripts/daily-discovery.test.mts",
    ],
  ],
  [
    "scripts/node-test-inventory.mts",
    [
      "scripts/node-test-inventory.test.mts",
      "scripts/ci-workflow.test.mts",
      "scripts/precommit-check.test.mts",
    ],
  ],
  ...["scripts/node-test-suites.mts", "scripts/node-test-suites.json"].map(
    (file): [string, string[]] => [
      file,
      [
        ...platformSkipConsumers,
        "scripts/ci-workflow.test.mts",
        "scripts/ci-baseline.test.mts",
        "scripts/local-validation.test.mts",
      ],
    ],
  ),
  [
    "CONTRIBUTING.md",
    ["scripts/repository-settings.test.mts", "scripts/repository-skills.test.mts"],
  ],
  ["docs/README.md", ["scripts/repository-skills.test.mts"]],
  [
    "docs/CONTRIBUTION-CONVENTIONS.md",
    ["scripts/repository-settings.test.mts", "scripts/repository-skills.test.mts"],
  ],
  [
    "docs/DEVELOPMENT-TOOLS.md",
    ["scripts/repository-settings.test.mts", "scripts/repository-skills.test.mts"],
  ],
  ["docs/PROJECT-GOVERNANCE.md", ["scripts/repository-settings.test.mts"]],
  ["docs/QUALITY.md", ["scripts/repository-settings.test.mts"]],
  ["docs/REPOSITORY-SETTINGS.md", ["scripts/repository-settings.test.mts"]],
  [
    ".config/rust-test-impact.json",
    [
      "scripts/rust-test-impact.test.mts",
      "scripts/local-validation.test.mts",
      "scripts/nextest-outcomes.test.mts",
      "scripts/qualification-nextest.test.mts",
    ],
  ],
  ...[
    "scripts/windows-rust-tests.mts",
    "scripts/windows-qualification-rust.mts",
    "scripts/fixtures/windows-qualification-selection.json",
    ".config/rust-test-timing-hints.json",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/windows-rust-tests.test.mts",
      "scripts/qualification-coverage.test.mts",
      ...rustWorkflowContractTests,
      "scripts/nextest-equivalence.test.mts",
      "scripts/ci-workflow.test.mts",
      "scripts/ci-result-gate.test.mts",
      "scripts/ci-baseline.test.mts",
      "scripts/rust-test-impact.test.mts",
    ],
  ]),
  [
    "scripts/ci-baseline.mts",
    ["scripts/ci-baseline.test.mts", "scripts/local-validation.test.mts"],
  ],
  ["scripts/ci-baseline.test.mts", ["scripts/ci-baseline-execution.test.mts"]],
  ...["scripts/ci-metrics.mts", "scripts/ci-metrics.test.mts"].map((file): [string, string[]] => [
    file,
    ["scripts/ci-baseline-execution.test.mts"],
  ]),
  [
    "scripts/rust-test-impact.mts",
    ["scripts/rust-test-impact.test.mts", "scripts/nextest-outcomes.test.mts"],
  ],
  [
    "scripts/qualification-nextest.mts",
    [
      "scripts/qualification-nextest.test.mts",
      "scripts/nextest-outcomes.test.mts",
      ...rustWorkflowContractTests,
      "scripts/nextest-equivalence.test.mts",
      "scripts/qualification-coverage.test.mts",
      "scripts/audit.test.mts",
      "scripts/precommit-check.test.mts",
    ],
  ],
  [".config/nextest.toml", [...rustWorkflowContractTests, "scripts/nextest-equivalence.test.mts"]],
  [
    "scripts/desktop-test-cli.mts",
    [
      "scripts/development-evidence.test.mts",
      "scripts/development-cli-help.test.mts",
      "scripts/retained-package.test.mts",
    ],
  ],
  ...[
    "scripts/qualification-rustdoc.mts",
    "scripts/rustdoc-outcomes.mts",
    "scripts/standalone-rust-tests.mts",
    "scripts/development-evidence.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/qualification-rustdoc.test.mts",
      "scripts/development-evidence.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/validation-evidence.test.mts",
      "scripts/workflow-provenance.test.mts",
      "scripts/qualification-coverage.test.mts",
      ...rustWorkflowContractTests,
      "scripts/nextest-equivalence.test.mts",
      "scripts/dev-storage.test.mts",
      "scripts/audit.test.mts",
      "scripts/precommit-check.test.mts",
      "scripts/local-validation.test.mts",
      "scripts/node-test-inventory.test.mts",
    ],
  ]),
  ...["merged", "failed", "standalone"].map((name): [string, string[]] => [
    "scripts/fixtures/rustdoc-outcomes/" + name + ".jsonl",
    ["scripts/qualification-rustdoc.test.mts"],
  ]),
  [
    "scripts/fixtures/nextest-inventory-baseline.json",
    ["scripts/nextest-outcomes.test.mts", "scripts/qualification-nextest.test.mts"],
  ],
  ...["scripts/nextest-outcomes.mts", "scripts/nextest-skip-routes.mts"].map(
    (file): [string, string[]] => [
      file,
      [
        "scripts/run-rust-tests.test.mts",
        "scripts/nextest-outcomes.test.mts",
        "scripts/qualification-nextest.test.mts",
        "scripts/rust-test-impact.test.mts",
        ...rustWorkflowContractTests,
        "scripts/nextest-equivalence.test.mts",
        "scripts/ci-workflow.test.mts",
        "scripts/audit.test.mts",
        "scripts/precommit-check.test.mts",
        "scripts/validation-evidence.test.mts",
        "scripts/workflow-provenance.test.mts",
      ],
    ],
  ),
  ...["passed.jsonl", "failing.jsonl", "ignored.jsonl", "inventory.json", "provenance.json"].map(
    (file): [string, string[]] => [
      `scripts/fixtures/nextest-outcomes/${file}`,
      ["scripts/nextest-outcomes.test.mts"],
    ],
  ),
  [
    "scripts/desktop-linux-x11.mts",
    [
      "scripts/desktop-linux-native-session.test.mts",
      "scripts/native-session-lock.test.mts",
      "scripts/resource-command.test.mts",
    ],
  ],
  ["scripts/ui-test-selection.mts", ["scripts/ui-test-selection.test.mts"]],
  ["apps/desktop/src/browser/failure-probe-contract.ts", ["scripts/ui-test-selection.test.mts"]],
  ["scripts/run-ui-tests.mts", ["scripts/ui-test-selection.test.mts"]],
  ...[
    "test-coverage",
    "test-coverage-config",
    "coverage-node-reporter",
    "coverage-node-loader",
    "coverage-maps",
  ].map((name): [string, string[]] => [
    `scripts/${name}.mts`,
    ["scripts/ui-test-selection.test.mts"],
  ]),
  ["scripts/run-viteplus.mts", ["scripts/frontend-command-preflight.test.mts"]],
  [
    "scripts/pr-delivery.mts",
    [
      "scripts/repository-skills.test.mts",
      "scripts/pr-delivery.test.mts",
      "scripts/pr-delivery-snapshot.test.mts",
    ],
  ],
  [
    "scripts/pr-delivery-snapshot.mts",
    ["scripts/pr-delivery.test.mts", "scripts/pr-delivery-snapshot.test.mts"],
  ],
  [
    "scripts/rehearse-updater-artifacts.ps1",
    ["scripts/hosted-native-continuity.test.mts", "scripts/updater-artifact-inventory.test.mts"],
  ],
  ["scripts/package-local.ps1", ["scripts/repository-skills.test.mts"]],
  ["scripts/release-preflight.ps1", ["scripts/repository-skills.test.mts"]],
  [
    "scripts/roadmap.mts",
    [
      ...roadmapContractTests,
      "scripts/repository-skills.test.mts",
      "scripts/discovery-intake.test.mts",
    ],
  ],
  [
    "scripts/upstream-observer.mts",
    [...upstreamHealthContractTests, "scripts/discovery-checkpoint.test.mts"],
  ],
  ["scripts/catalog-upstream-observer.mts", upstreamHealthContractTests],
  ["scripts/observe-catalog-upstreams.mts", upstreamHealthContractTests],
  ["scripts/check-catalog-repositories.mts", upstreamHealthContractTests],
  ["scripts/upstream-health-inputs.mts", upstreamHealthContractTests],
  [
    "scripts/upstream-health-plan.mts",
    ["scripts/upstream-health-plan.test.mts", "scripts/upstream-health-planning.test.mts"],
  ],
  ["scripts/upstream-health-monitor.mts", ["scripts/upstream-health-monitor.test.mts"]],
  [
    "scripts/observe-configured-upstream.mts",
    [...upstreamHealthContractTests, "scripts/discovery-checkpoint.test.mts"],
  ],
  ...[
    "scripts/fixtures/upstream-observation-fixtures.mts",
    "scripts/fixtures/upstream-health-accounting-cases.json",
    "scripts/fixtures/upstream-health-pins.json",
    "scripts/fixtures/upstream-health-fade-to-black.json",
    "release/upstream-observer.json",
  ].map((file): [string, string[]] => [file, upstreamHealthContractTests]),
  [
    "scripts/fixtures/upstream-health-retained-artifacts.json",
    ["scripts/upstream-observer.test.mts"],
  ],
  [
    "scripts/test-windows-installer.ps1",
    [
      "scripts/repository-skills.test.mts",
      "scripts/native-qualification-account-adapter.test.mts",
      "scripts/desktop-scenarios.test.mts",
    ],
  ],
  [
    "scripts/native-qualification-account.cs.txt",
    ["scripts/native-qualification-account.test.mts"],
  ],
  [
    "scripts/native-qualification-account-bridge.ps1",
    [
      "scripts/native-qualification-account.test.mts",
      "scripts/native-qualification-account-adapter.test.mts",
    ],
  ],
  [
    "scripts/native-qualification-account-client.ps1",
    [
      "scripts/native-qualification-account.test.mts",
      "scripts/native-qualification-account-client.test.mts",
    ],
  ],
  [
    "scripts/native-qualification-account-client.mts",
    [
      "scripts/native-qualification-account-client.test.mts",
      "scripts/desktop-native-account-session.test.mts",
    ],
  ],
  [
    "scripts/native-qualification-account-adapter.psm1",
    ["scripts/native-qualification-account-adapter.test.mts"],
  ],
  [
    "scripts/native-qualification-account-registry.ps1",
    [
      "scripts/native-qualification-account-adapter.test.mts",
      "scripts/release-native-account-capability.test.mts",
    ],
  ],
  [
    "scripts/fixtures/native-account-gui-probe.ps1",
    ["scripts/native-qualification-account.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-native-account-session.mts",
    [
      "scripts/desktop-native-account-session.test.mts",
      "scripts/native-helper-dependencies.test.mts",
    ],
  ],
  ["scripts/windows-qualification-session.ps1", ["scripts/repository-skills.test.mts"]],
  ["crates/portcove-core/catalog/catalog-current-authoring.json", catalogGeneratorContractTests],
  [
    "crates/portcove-core/catalog/catalog-schema1-fixture.json",
    ["scripts/migrate-catalog-schema2.test.mts"],
  ],
  [
    "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
    ["scripts/migrate-catalog-schema2.test.mts"],
  ],
  [
    "crates/portcove-core/catalog/catalog.json",
    [...catalogGeneratorContractTests, "scripts/repository-skills.test.mts"],
  ],
  ["crates/portcove-core/src/catalog.rs", ["scripts/repository-skills.test.mts"]],
  [
    "scripts/fixtures/desktop-input-observation-baseline.json",
    ["scripts/desktop-input-observation.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-test.mts",
    [
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-input-observation.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-verify.test.mts",
      "scripts/frontend-command-preflight.test.mts",
      "scripts/native-helper-dependencies.test.mts",
      "scripts/windows-helper-checks.test.mts",
      "scripts/development-evidence.test.mts",
      "scripts/native-session-lock.test.mts",
    ],
  ],
  ...[
    "apps/desktop/scripts/desktop-preparation-test.mts",
    "apps/desktop/scripts/desktop-artwork-correction-test.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-boundary-wiring.test.mts",
      ...(file === "apps/desktop/scripts/desktop-preparation-test.mts"
        ? ["scripts/capture-target.test.mts"]
        : []),
    ],
  ]),
  [
    "apps/desktop/scripts/desktop-scenario-outcomes.mts",
    ["scripts/desktop-scenarios.test.mts", "scripts/native-helper-dependencies.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-listener-lifetime-test.mts",
    ["scripts/desktop-listener-probe.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-listener-lifetime-probe.mts",
    ["scripts/desktop-listener-probe.test.mts", "scripts/desktop-execution-plan.test.mts"],
  ],
  ...[
    "apps/desktop/scripts/desktop-default-cover-test.mts",
    "apps/desktop/scripts/desktop-cover-observations.mts",
    "apps/desktop/scripts/desktop-catalog-update-test.mts",
  ].map((file): [string, string[]] => [
    file,
    ["scripts/desktop-scenarios.test.mts", "scripts/fixture-module-closure.test.mts"],
  ]),
  [
    "apps/desktop/scripts/desktop-source-dialog-test.mts",
    ["scripts/desktop-scenarios.test.mts", "scripts/desktop-boundary-wiring.test.mts"],
  ],
  ...[
    "apps/desktop/scripts/desktop-review-controls.mts",
    "apps/desktop/scripts/desktop-review-presentation.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-execution-plan.test.mts",
      "scripts/fixture-module-closure.test.mts",
    ],
  ]),
  [
    ".github/quality-tools.json",
    [
      "scripts/quality-tools.test.mts",
      "scripts/dependency-automation.test.mts",
      "scripts/qualification-nextest.test.mts",
    ],
  ],
  [
    ".node-version",
    [
      "scripts/dependency-automation.test.mts",
      "scripts/ci-baseline-execution.test.mts",
      "scripts/qualification-nextest.test.mts",
      "scripts/qualification-rustdoc.test.mts",
    ],
  ],
  ["Cargo.toml", ["scripts/dependency-automation.test.mts"]],
  [
    "rust-toolchain.toml",
    ["scripts/dependency-automation.test.mts", "scripts/qualification-rustdoc.test.mts"],
  ],
  [
    "package.json",
    [
      "scripts/ci-workflow.test.mts",
      "scripts/dependency-automation.test.mts",
      "scripts/dev-storage.test.mts",
      "scripts/local-validation.test.mts",
    ],
  ],
  ["pnpm-lock.yaml", ["scripts/dependency-automation.test.mts"]],
  ["pnpm-workspace.yaml", ["scripts/dependency-automation.test.mts"]],
  ["apps/desktop/pnpm-lock.yaml", ["scripts/dependency-automation.test.mts"]],
  ["apps/desktop/pnpm-workspace.yaml", ["scripts/dependency-automation.test.mts"]],
  [
    "apps/desktop/package.json",
    ["scripts/ci-workflow.test.mts", "scripts/local-validation.test.mts"],
  ],
  [".github/dependabot.yml", ["scripts/dependency-automation.test.mts"]],
  [
    ".config/tool-bootstrap.json",
    [
      "scripts/tool-cache.test.mts",
      "scripts/quality-tools.test.mts",
      "scripts/dev-doctor.test.mts",
    ],
  ],
  [".config/recovery-tools/aqua.yaml", ["scripts/recovery-tools.test.mts"]],
  [".config/recovery-tools/aqua-checksums.json", ["scripts/recovery-tools.test.mts"]],
  [
    "scripts/roadmap-issue.mts",
    [
      ...roadmapContractTests,
      "scripts/roadmap-scoped.test.mts",
      "scripts/source-provenance-audit.test.mts",
      "scripts/discovery-reconciliation.test.mts",
      "scripts/discovery-intake.test.mts",
      "scripts/roadmap-authoring.test.mts",
    ],
  ],
  [".github/roadmap.json", roadmapContractTests],
  ["scripts/fixtures/roadmap-fixtures.mts", roadmapContractTests],
  ["scripts/repository-issue-inventory.fixture.mts", roadmapContractTests],
  ...[
    "scripts/github-api.mts",
    "scripts/repository-issue-inventory.mts",
    "scripts/roadmap-inventory.mts",
    "scripts/roadmap-scoped.mts",
    "scripts/roadmap-qualification.mts",
    "scripts/roadmap-execution.mts",
    "scripts/roadmap-readiness.mts",
    "scripts/linux-beta-risk-706.mts",
    "deny.toml",
  ].map((file): [string, string[]] => [file, roadmapContractTests]),
  [".github/pr-conventions.json", ["scripts/pr-conventions.test.mts"]],
  [
    ".github/upstream-health-accounting.json",
    [
      "scripts/check-catalog-repositories.test.mts",
      "scripts/upstream-observer.test.mts",
      "scripts/upstream-health.test.mts",
      "scripts/upstream-health-monitor.test.mts",
    ],
  ],
  [
    ".github/linux-beta-risk-706.json",
    [
      "scripts/linux-beta-risk-706.test.mts",
      "scripts/validation-plan.test.mts",
      ...roadmapContractTests,
    ],
  ],
  [
    ".github/qualification-coverage.json",
    ["scripts/qualification-coverage.test.mts", "scripts/ci-workflow.test.mts"],
  ],
  [
    "justfile",
    [
      "scripts/local-validation.test.mts",
      "scripts/dev-storage.test.mts",
      "scripts/ci-workflow.test.mts",
      "scripts/dependency-automation.test.mts",
      "scripts/repository-settings.test.mts",
    ],
  ],
  [".oxfmtrc.json", ["scripts/local-validation.test.mts", "scripts/ci-workflow.test.mts"]],
  [
    "scripts/release-capacity-operation.mts",
    ["scripts/release-catalog-review-maintenance.test.mts"],
  ],
  [
    "scripts/release-coordinator-state.mts",
    ["scripts/release-catalog-review-maintenance.test.mts"],
  ],
  ["scripts/release-coordinator.mts", ["scripts/release-catalog-review-maintenance.test.mts"]],
  [
    "scripts/release-metadata-contract.mts",
    ["scripts/release-catalog-review-maintenance.test.mts"],
  ],
] satisfies [string, readonly string[]][]) {
  if (explicitNodeTests.has(file)) throw new Error(`Duplicate Node test input owner: ${file}`);
  explicitNodeTests.set(file, tests);
}

// Shared custody consumers supplement each helper's feature-owned tests.
for (const file of [...Object.keys(nativeHelperDependencies), nativeHelperRegistryPath])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/native-helper-dependencies.test.mts",
    "scripts/native-confirmation.test.mts",
    "scripts/desktop-execution-plan.test.mts",
    "scripts/windows-helper-checks.test.mts",
    ...(file === nativeHelperRegistryPath ? ["scripts/desktop-input-observation.test.mts"] : []),
  ]);

// Source declarations are consumed by a cheap Node contract even when no release
// script changes. Keep the consumer's own input inventory authoritative.
for (const file of [
  ".node-version",
  "scripts/runtime-values.mts",
  "scripts/resource-command.mts",
  "scripts/heavy-rust-test-lock.mts",
])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/ci-job-timeout-probe.test.mts",
  ]);
for (const file of nativeCompatibilitySourcePaths)
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/release-native-source-contract.test.mts",
  ]);

explicitNodeTests.set("scripts/nextest-outcomes-cli.mts", [
  ...(explicitNodeTests.get("scripts/nextest-outcomes.mts") ?? []),
]);
for (const file of [
  "apps/desktop/scripts/release-version-policy.mts",
  "apps/desktop/scripts/release-version-runtime.mts",
  "apps/desktop/scripts/release-version-bundled-runtime.mts",
  "scripts/release-controller-tool-build.mts",
])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/production-aggregate-steps.test.mts",
    "scripts/release-controller-tools.test.mts",
  ]);
for (const file of [
  "scripts/release-windows-webview-driver.mts",
  "scripts/windows-webview-driver-policy.psm1",
  "scripts/bounded-zip.mts",
  "scripts/bootstrap-quality-tools.ps1",
  "scripts/release-controller-tool-build.mts",
  "scripts/release-controller-tools.mts",
  "scripts/release-controller-tool-admission.mts",
  "scripts/qualify-controller-tools-windows.mts",
])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/release-windows-webview-driver.test.mts",
    "scripts/release-controller-tools.test.mts",
    "scripts/quality-tools.test.mts",
  ]);
explicitNodeTests.set("scripts/fixtures/module-closure.mts", [
  ...(explicitNodeTests.get("scripts/fixtures/module-closure.mts") ?? []),
  "scripts/production-aggregate-steps.test.mts",
  "scripts/renovate-engine-probe.test.mts",
]);
for (const file of [
  "scripts/report-summary.mts",
  "scripts/bounded-summary.mts",
  "scripts/fallow-summary.mts",
])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/report-summary.test.mts",
    "scripts/fallow-summary.test.mts",
    ...(explicitNodeTests.get("scripts/nextest-outcomes.mts") ?? []),
  ]);
explicitNodeTests.set("scripts/run-rust-tests.mts", [
  ...(explicitNodeTests.get("scripts/run-rust-tests.mts") ?? []),
  "scripts/run-rust-tests.test.mts",
  "scripts/nextest-outcomes.test.mts",
]);

for (const file of ["scripts/release-resource-observation.mts", "scripts/release-capacity.mts"])
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/release-resource-observation.test.mts",
  ]);
const workflowTests = new Map([
  [
    "hosted-native-continuity.yml",
    ["scripts/hosted-native-continuity.test.mts", "scripts/updater-artifact-inventory.test.mts"],
  ],
  ["controller-tool-build-fixture.yml", ["scripts/release-controller-tools.test.mts"]],
  [
    "application-update-production.yml",
    [
      "scripts/production-controller-admission.test.mts",
      "scripts/release-production-dag.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ],
  [
    "application-update-wake.yml",
    [
      "scripts/release-controller-wake.test.mts",
      "scripts/release-production-dag.test.mts",
      "scripts/release-controller-catalog-routing.test.mts",
    ],
  ],
  ["release.yml", ["scripts/release-workflow.test.mts"]],
  ["qualification.yml", ["scripts/qualification-coverage.test.mts"]],
  [
    "configured-upstream-observer.yml",
    ["scripts/upstream-observer.test.mts", "scripts/catalog-upstream-observer.test.mts"],
  ],
  [
    "upstream-health.yml",
    ["scripts/upstream-health-plan.test.mts", "scripts/upstream-health-monitor.test.mts"],
  ],
  [
    "updater-artifact-rehearsal.yml",
    ["scripts/updater-artifact-inventory.test.mts", "scripts/release-payload-signing.test.mts"],
  ],
  ["pr-conventions.yml", ["scripts/pr-conventions.test.mts"]],
]);

for (const file of [
  "scripts/generate-catalog.mts",
  "scripts/inspect-igdb-artwork.mts",
  "scripts/upstream-lineage.mts",
  "scripts/maintainer-config.mts",
  "scripts/runtime-values.mts",
  "scripts/fixtures/catalog-generator-fixtures.mts",
  "crates/portcove-core/catalog/catalog-schema1-fixture.json",
  "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
  "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
]) {
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    ...catalogGeneratorContractTests,
  ]);
}

explicitNodeTests.set("scripts/fixtures/coordinator-fixture-phases.mts", [
  "scripts/release-coordinator-state.test.mts",
]);

const coordinatorStateContractTests = [
  "scripts/release-coordinator-state.test.mts",
  "scripts/release-coordinator-recovery.test.mts",
  "scripts/release-coordinator-remote.test.mts",
  "scripts/release-coordinator-checkpoint-evidence.test.mts",
  "scripts/release-coordinator-capacity-effects.test.mts",
  "scripts/release-coordinator-metadata.test.mts",
  "scripts/release-coordinator-signing-exchange.test.mts",
  "scripts/release-coordinator-owned-executor.test.mts",
];
const coordinatorSigningContractTests = [
  "scripts/release-coordinator-state.test.mts",
  "scripts/release-coordinator-signing-exchange.test.mts",
  "scripts/release-coordinator-owned-executor.test.mts",
];
for (const file of [
  "scripts/fixtures/coordinator-state-fixtures.mts",
  "scripts/fixtures/release-capacity-fixture.mts",
  "scripts/release-capacity.mts",
  "scripts/release-capacity-operation.mts",
  "scripts/fixtures/release-metadata-fixture.mts",
  "scripts/runtime-values.mts",
  "apps/desktop/scripts/prepare-release-version.mts",
  "scripts/release-coordinator-state.mts",
  "scripts/release-coordinator-remote.mts",
  "scripts/release-coordinator-checkpoint-evidence.mts",
  "scripts/production-controller-admission.mts",
  "scripts/github-api.mts",
  "scripts/fixtures/assembler-identity-fixture.mts",
  "scripts/fixtures/release-catalog-publication-fixture.mts",
  "scripts/fixtures/checkpoint-proof-fixture.mts",
  ".github/workflows/application-update-production.yml",
  "scripts/release-coordinator-state.test.mts",
  "scripts/release-coordinator-recovery.test.mts",
  "scripts/release-coordinator-remote.test.mts",
  "scripts/release-coordinator-checkpoint-evidence.test.mts",
  "scripts/release-coordinator-capacity-effects.test.mts",
  "scripts/release-coordinator-metadata.test.mts",
  "scripts/release-coordinator-signing-exchange.test.mts",
  "scripts/release-coordinator-owned-executor.test.mts",
]) {
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    ...coordinatorStateContractTests,
  ]);
}

for (const file of [
  "scripts/test-coverage-config.mts",
  "scripts/quality-tools.mts",
  "scripts/resource-command.mts",
  "scripts/resource-capacity.mts",
  "scripts/prepared-file-replacement.mts",
  "scripts/runtime-values.mts",
]) {
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/rust-coverage.test.mts",
  ]);
}
for (const file of [
  "scripts/fixtures/native-desktop-observer.cs.txt",
  "scripts/release-hosted-native-windows-setup.ps1",
  "scripts/release-hosted-native-windows-setup.cs.txt",
  "scripts/release-hosted-native-windows-audit.cs.txt",
  "scripts/release-hosted-native-windows-observation.mts",
  "scripts/qualify-controller-tools-windows.mts",
]) {
  explicitNodeTests.set(file, [
    ...(explicitNodeTests.get(file) ?? []),
    "scripts/release-hosted-native-windows-setup.test.mts",
  ]);
}
explicitNodeTests.set("scripts/runtime-values.mts", [
  ...roadmapContractTests,
  ...(explicitNodeTests.get("scripts/runtime-values.mts") ?? []),
  "scripts/qualification-nextest.test.mts",
  "scripts/qualification-rustdoc.test.mts",
  "scripts/nextest-outcomes.test.mts",
  "scripts/qualification-coverage.test.mts",
  "scripts/audit.test.mts",
  "scripts/precommit-check.test.mts",
]);

for (const workflow of [
  "release.yml",
  "application-update-production.yml",
  "application-update-wake.yml",
])
  workflowTests.set(workflow, [
    ...(workflowTests.get(workflow) ?? []),
    "scripts/release-resource-observation.test.mts",
  ]);
const releaseContractTests = Object.freeze([
  "scripts/release-hosted-native-windows-capture.test.mts",
  "scripts/release-hosted-native-windows-runner.test.mts",
  "scripts/release-hosted-native-windows-session.test.mts",
  "scripts/release-hosted-native-windows-worker-contract.test.mts",
  "scripts/release-hosted-native-runtime.test.mts",
  "scripts/release-resource-observation.test.mts",
  "scripts/release-hosted-native-windows-setup.test.mts",
  "scripts/release-native-runtime-custody.test.mts",
  "scripts/hosted-native-continuity.test.mts",
  "scripts/recover-local-worker-empty-setup.test.mts",
  "scripts/release-native-account-capability.test.mts",
  "scripts/release-local-worker-accounts.test.mts",
  "scripts/release-local-worker-tasks.test.mts",
  "scripts/release-native-public-pair.test.mts",
  "scripts/release-native-public-compiler.test.mts",
  "scripts/release-native-public-signature.test.mts",
  "scripts/release-native-public-attempt-contract.test.mts",
  "scripts/production-controller-admission.test.mts",
  "scripts/controller-canary.test.mts",
  "scripts/check-release-metadata.test.mts",
  "scripts/release-package-policy.test.mts",
  "scripts/release-public-build-inputs.test.mts",
  "scripts/release-public-build-provenance.test.mts",
  "scripts/release-handshake-hosted-fixture.test.mts",
  "scripts/release-controller-tools.test.mts",
  "scripts/release-compiler-source.test.mts",
  "scripts/release-native-qualification-contract.test.mts",
  "scripts/release-native-stage-capture.test.mts",
  "scripts/release-native-scheduler.test.mts",
  "scripts/release-native-parent.test.mts",
  "scripts/release-native-wsl-boundary.test.mts",
  "scripts/native-linux-driver-http.test.mts",
  "scripts/native-linux-isolated-init.test.mts",
  "scripts/native-linux-isolated-plan.test.mts",
  "scripts/native-linux-public-fuse.test.mts",
  "scripts/native-linux-public-services.test.mts",
  "scripts/native-linux-public-plan.test.mts",

  "scripts/release-native-linux-driver.test.mts",
  "scripts/native-qualification-linux-supervisor.test.mts",
  "scripts/native-qualification-linux-transfer.test.mts",
  "scripts/release-native-wsl-capture.test.mts",
  "scripts/release-hosted-native-linux-capture.test.mts",
  "scripts/release-hosted-native-linux-report.test.mts",
  "scripts/release-hosted-native-proof-producer.test.mts",
  "scripts/release-hosted-native-job.test.mts",
  "scripts/release-hosted-native-history.test.mts",
  "scripts/release-native-source-provider.test.mts",
  "scripts/release-native-candidate.test.mts",
  "scripts/release-native-public-pair.test.mts",
  "scripts/release-native-public-attempt-contract.test.mts",
  "scripts/release-native-linux-public-capture.test.mts",
  "scripts/release-native-public-compiler.test.mts",
  "scripts/release-native-attempt.test.mts",
  "scripts/release-native-windows-driver.test.mts",
  "scripts/release-native-windows-public-continuation.test.mts",
  "scripts/release-native-source-contract.test.mts",
  "scripts/release-native-pre-sign-report.test.mts",
  "scripts/release-native-check-broker.test.mts",
  "scripts/release-local-native-setup.test.mts",
  "scripts/release-native-acceptance.test.mts",
  "scripts/release-native-admission.test.mts",
  "scripts/release-native-check-discovery.test.mts",
  "scripts/release-bootstrap-preparation.test.mts",
  "scripts/release-role-key-channel.test.mts",
  "scripts/release-control-handshake.test.mts",
  "scripts/release-live-control-admission.test.mts",
  "scripts/write-release-checksums.test.mts",
  "scripts/updater-artifact-inventory.test.mts",
  "scripts/release-payload-signing.test.mts",
  "scripts/release-payload-preparation.test.mts",
  "scripts/release-signing-handoff.test.mts",
  "scripts/release-tuf-role-artifact.test.mts",
  "scripts/release-tuf-signing.test.mts",
  "scripts/release-connected-fixture.test.mts",
  "scripts/release-tuf-controller.test.mts",
  "scripts/release-metadata-signing-context.test.mts",
  "scripts/release-metadata-context-recovery.test.mts",
  "scripts/release-candidate-signing-recovery.test.mts",
  "scripts/release-pending-release-recovery.test.mts",
  "scripts/release-pending-result-recovery.test.mts",
  "scripts/release-report-repair-contract.test.mts",
  "scripts/release-report-repair-identity.test.mts",
  "scripts/release-run-artifact-inventory.test.mts",
  "scripts/release-metadata-site-controller.test.mts",
  "scripts/release-signing-context.test.mts",
  "scripts/release-preview-withdrawals.test.mts",
  "scripts/release-signing-context-artifact.test.mts",
  "scripts/release-publication-controller.test.mts",
  "scripts/release-publication-inputs.test.mts",
  "scripts/release-publication-source.test.mts",
  "scripts/release-controller-wake.test.mts",
  "scripts/release-publication-result.test.mts",
  "scripts/release-publication-result-artifact.test.mts",
  "scripts/reconcile-release-assets.test.mts",
  "scripts/release-candidate-qualification.test.mts",
  "scripts/release-immutable-publication.test.mts",
  "scripts/finalize-release-assets.test.mts",
  "scripts/generate-release-downloads.test.mts",
  "scripts/select-release-channel.test.mts",
  "scripts/release-coordinator.test.mts",
  ...coordinatorStateContractTests,
  "scripts/release-coordinator-checkpoint-authentication.test.mts",
  "scripts/release-coordinator-checkpoint-signing.test.mts",
  "scripts/release-prepared-transport.test.mts",
  "scripts/release-run-evidence.test.mts",
  "scripts/reconstruct-application-update-records.test.mts",
  "scripts/release-workflow.test.mts",
  "scripts/windows-qualification-session.test.mts",
  "scripts/qualification-preparation.test.mts",
]);

// Native lifecycle consumers also use helper dependencies without changing their entrypoint.
for (const [file, tests] of [
  [
    "apps/desktop/scripts/native-linux-isolated-session.mts",
    [...releaseContractTests, "apps/desktop/scripts/desktop-linux-public-update.native.test.mts"],
  ],
  [
    "apps/desktop/scripts/desktop-native-account-session.mts",
    [
      ...releaseContractTests,
      "scripts/desktop-scenarios.test.mts",
      "apps/desktop/scripts/desktop-windows-public-update.native.test.mts",
    ],
  ],
] satisfies [string, string[]][])
  explicitNodeTests.set(file, [...(explicitNodeTests.get(file) ?? []), ...tests]);
for (const root of Object.keys(nativeHelperDependencies)) {
  const consumers = explicitNodeTests.get(root) ?? [];
  for (const input of nativeHelperFiles([root]))
    explicitNodeTests.set(input, [
      ...new Set([...(explicitNodeTests.get(input) ?? []), ...consumers]),
    ]);
}
explicitNodeTests.set(nativeHelperRegistryPath, [
  ...new Set([
    ...(explicitNodeTests.get(nativeHelperRegistryPath) ?? []),
    ...Object.keys(nativeHelperDependencies).flatMap((file) => explicitNodeTests.get(file) ?? []),
  ]),
]);

export function command(
  id: string,
  reason: string,
  executable: string,
  args: string[],
  options: CommandOptions = {},
): ValidationCommand {
  return {
    id,
    reason,
    executable,
    args,
    cwd: options.cwd ?? projectRoot,
    obligation: options.obligation ?? id,
  };
}

function commandIdentity(entry: ValidationCommand) {
  return JSON.stringify([entry.cwd, entry.executable, entry.args]);
}

export function deduplicateCommands(commands: readonly ValidationCommand[]): RetainedCommand[] {
  const unique: RetainedCommand[] = [];
  const byId = new Map<
    string,
    { identity: string; obligation: string; retained: RetainedCommand }
  >();
  const byObligation = new Map<string, RetainedCommand>();
  for (const entry of commands) {
    const identity = commandIdentity(entry);
    const obligation = entry.obligation ?? entry.id;
    const existingId = byId.get(entry.id);
    if (existingId) {
      if (existingId.identity !== identity || existingId.obligation !== obligation)
        throw new Error(
          `validation stage ${entry.id} selected conflicting commands or obligations`,
        );
      existingId.retained.reason = `${existingId.retained.reason}; also selected as ${entry.id}: ${entry.reason}`;
      continue;
    }

    const obligationIdentity = JSON.stringify([obligation, identity]);
    const existing = byObligation.get(obligationIdentity);
    if (existing) {
      existing.selectedIds.push(entry.id);
      existing.reason = `${existing.reason}; also selected as ${entry.id}: ${entry.reason}`;
      byId.set(entry.id, { identity, obligation, retained: existing });
      continue;
    }
    const retained = { ...entry, selectedIds: [entry.id] };
    unique.push(retained);
    byObligation.set(obligationIdentity, retained);
    byId.set(entry.id, { identity, obligation, retained });
  }
  return unique;
}

function frontendTask(id: string, reason: string, task: string) {
  return command(id, reason, process.execPath, ["scripts/run-viteplus.mts", "run", task], {
    cwd: projectRoot,
  });
}

function addNodeTest(selection: ValidationSelection, file: string) {
  const normalized = normalizePath(file);
  selection.nodeTests.add(normalized);
  if (normalized === "scripts/roadmap.test.mts")
    for (const companion of roadmapFeatureTests) selection.nodeTests.add(companion);
  if (normalized === "scripts/upstream-observer.test.mts")
    for (const companion of upstreamHealthObservationTests) selection.nodeTests.add(companion);
  if (normalized === "scripts/ci-baseline.test.mts")
    selection.nodeTests.add("scripts/ci-baseline-execution.test.mts");
  // Preserve every former workflow-suite consumer after responsibility-based colocation.
  if (normalized === "scripts/ci-workflow.test.mts")
    for (const companion of [
      ...workflowFeatureTests,
      "scripts/check-catalog-repositories.test.mts",
      "scripts/check-retcomm-upstreams.test.mts",
      "scripts/deep-audit-summary.test.mts",
    ])
      selection.nodeTests.add(companion);
  // These contracts formerly ran through imports; keep them in focused routes
  // now that each suite has its own explicit execution entry point.
  if (normalized === "scripts/desktop-scenarios.test.mts")
    selection.nodeTests.add("scripts/native-compatibility.test.mts");
  if (normalized === "scripts/desktop-execution-plan.test.mts") {
    selection.nodeTests.add("scripts/desktop-execution-baseline.test.mts");
    selection.nodeTests.add("scripts/native-qualification-inventory.test.mts");
  }
  if (normalized === "scripts/release-workflow.test.mts")
    selection.nodeTests.add("scripts/sign-catalog.test.mts");
}

function existingSiblingTest(file: string, fileExists: (file: string) => boolean) {
  if (!/\.(?:[cm]?[jt]s)$/.test(file) || /\.test\.[cm]?[jt]s$/u.test(file)) return null;
  const sibling = file.replace(
    /\.[cm]?[jt]s$/u,
    /\.[cm]?ts$/u.test(file) ? ".test.mts" : ".test.mjs",
  );
  return fileExists(sibling) ? sibling : null;
}

function releaseContractTestsForPath(file: string) {
  return file === "scripts/release-coordinator-signing-exchange.mts"
    ? releaseContractTests.filter(
        (testFile) =>
          !coordinatorStateContractTests.includes(testFile) ||
          coordinatorSigningContractTests.includes(testFile),
      )
    : releaseContractTests;
}

function classifyOnePath(
  selection: ValidationSelection,
  input: string,
  fileExists: (file: string) => boolean,
  options: PathClassifyOptions = {},
) {
  const file = normalizePath(input);
  if (isRepositoryLintInput(file)) selection.repositoryLint = true;
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === ".sh") {
    selection.shellLint = true;
    if (options.includeFileChecks ?? true) selection.shellFiles.add(file);
  }
  if (extension === ".py") {
    selection.pythonLint = true;
    if (options.includeFileChecks ?? true) selection.pythonFiles.add(file);
  }
  const includeFileChecks = options.includeFileChecks ?? true;
  let recognized = false;
  if (
    /^apps\/desktop\/scripts\/[^/]+\.native\.test\.mts$/u.test(file) ||
    file === "vite.config.ts" ||
    file === ".github/workflows/ci.yml"
  )
    addNodeTest(selection, "scripts/node-test-inventory.test.mts");

  if (
    file.startsWith("docs/") &&
    /\.ya?ml$/u.test(file) &&
    validationOwnershipForPath(file).areas.includes("release-security")
  ) {
    selection.scopes.add("release-tooling");
    for (const testFile of releaseContractTestsForPath(file)) addNodeTest(selection, testFile);
    recognized = true;
  }
  if (
    file.startsWith("apps/desktop/src/browser/") ||
    file.startsWith("apps/desktop/src/components/ui/") ||
    file.startsWith("apps/desktop/src/styles/") ||
    file.endsWith(".module.css") ||
    [
      "apps/desktop/scripts/browser-runtime.mts",
      // Deleted config aliases still require browser coverage in historical diffs.
      "apps/desktop/vitest.config.ts",
      "apps/desktop/vitest.browser.config.ts",
      "apps/desktop/vite.config.ts",
      "apps/desktop/package.json",
      "pnpm-lock.yaml",
      "apps/desktop/src/components/AdoptionModal.tsx",
      "apps/desktop/src/components/ui.tsx",
      "apps/desktop/src/features/installation/use-installation-planning.ts",
      "apps/desktop/src/shared/concurrency-state.ts",
      "apps/desktop/src/api.ts",
      "apps/desktop/src/styles/index.css",
      "apps/desktop/src/test-fixtures.ts",
      "apps/desktop/src/view-model.ts",
    ].includes(file)
  )
    selection.browser = true;

  if (includeFileChecks && oxfmtExtensions.has(extension)) {
    selection.oxfmtFiles.add(file);
  }
  if (options.isDeletion && extension === ".toml" && !file.includes("/")) {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/local-validation.test.mts");
    addNodeTest(selection, "scripts/validation-plan.test.mts");
    recognized = true;
  }

  if (options.isDeletion && file.startsWith(".github/") && extension === ".json") {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    addNodeTest(selection, "scripts/validation-plan.test.mts");
    addNodeTest(selection, "scripts/repository-settings.test.mts");
    recognized = true;
  }

  for (const [prefix, packageName] of packagePrefixes) {
    if (file.startsWith(prefix)) {
      selection.packages.add(packageName);
      selection.scopes.add("rust");
      selection.rustfmt = true;
      recognized = true;
      break;
    }
  }

  if (
    file === "Cargo.toml" ||
    file === "Cargo.lock" ||
    file === "rust-toolchain.toml" ||
    file === "deny.toml" ||
    file === ".config/rust-test-timing-hints.json" ||
    file === "scripts/windows-rust-tests.mts" ||
    file === "scripts/windows-qualification-rust.mts" ||
    file === "scripts/fixtures/windows-qualification-selection.json" ||
    file === "scripts/nextest-outcomes.mts" ||
    (file === ".config/nextest.toml" && !options.nextestUnchanged)
  ) {
    selection.workspaceRust = true;
    selection.rustfmt = true;
    selection.scopes.add("rust-workspace");
    recognized = true;
  }

  if (
    file.startsWith("apps/desktop/src/") ||
    file.startsWith("apps/desktop/scripts/") ||
    file.startsWith("apps/desktop/test/") ||
    file.startsWith("apps/desktop/assets/") ||
    file.startsWith("apps/desktop/public/") ||
    file === "apps/desktop/.fallowrc.json" ||
    // Keep deleted Vitest aliases recognized when either side of a rename mentions them.
    /^apps\/desktop\/(?:(?:index|scenarios)\.html|(?:components|package)\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|vitest(?:\.browser)?\.config\.ts|i18next(?:\.invalid)?\.config\.ts|eslint\.config\.mjs|stylelint\.config\.mjs)$/.test(
      file,
    )
  ) {
    selection.ui = true;
    selection.scopes.add("ui");
    recognized = true;
    if (
      file.startsWith("apps/desktop/src/") ||
      file.startsWith("apps/desktop/scripts/") ||
      file.startsWith("apps/desktop/test/")
    ) {
      if (options.isDeletion || !/\.(?:[cm]?[jt]sx?|css)$/u.test(file))
        selection.uiFullTests = true;
      else selection.uiRelatedFiles.add(file);
    } else {
      selection.uiFullTests = true;
    }
    if (extension === ".css") selection.stylelint = true;
    if (file === "apps/desktop/.fallowrc.json") {
      addNodeTest(selection, "scripts/check-fallow-report.test.mts");
    }
  }

  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      "apps/desktop/pnpm-workspace.yaml",
      "scripts/browser-traces.ts",
      "scripts/frontend-case-observations.ts",
      "scripts/ui-test-selection.mts",
      "apps/desktop/src/browser/failure-probe-contract.ts",
      "scripts/viteplus-cli.mts",
      "scripts/frontend-tests.ts",
      "scripts/run-ui-tests.mts",
      "scripts/test-coverage-config.mts",
      "scripts/coverage-maps.mts",
      "scripts/run-viteplus.mts",
    ].includes(file) ||
    /^patches\/[^/]+\.patch$/u.test(file)
  ) {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    recognized = true;
    if (["package.json", "pnpm-lock.yaml"].includes(file)) {
      addNodeTest(selection, "scripts/check-fallow-report.test.mts");
    }
  }

  if (file.startsWith("scripts/")) {
    selection.scopes.add("tooling");
    recognized = true;
    if (/\.(?:[cm]?[jt]s)$/.test(file)) {
      selection.oxlint = true;
      if (/\.test\.[cm]?[jt]s$/u.test(file)) {
        if (includeFileChecks) addNodeTest(selection, file);
      } else {
        if (includeFileChecks) selection.nodeSyntax.add(file);
        const sibling = existingSiblingTest(file, fileExists);
        if (sibling) addNodeTest(selection, sibling);
      }
    }
    if (extension === ".ps1") selection.powershellLint = true;
    if (extension === ".sh") selection.shellLint = true;
    if (containmentInputs.has(file))
      for (const testFile of containmentContractTests) addNodeTest(selection, testFile);
    if (validationOwnershipForPath(file).areas.includes("release-security")) {
      selection.scopes.add("release-tooling");
      for (const testFile of releaseContractTestsForPath(file)) addNodeTest(selection, testFile);
      addNodeTest(selection, "scripts/ci-workflow.test.mts");
    }
  }

  if (file === "crates/portcove-core/src/testdata/host_tool_probe.rs.txt") {
    selection.scopes.add("tooling");
    recognized = true;
    addNodeTest(selection, "scripts/run-rust-tests.test.mts");
    addNodeTest(selection, "scripts/rust-support-cache.test.mts");
  }

  if (file === "scripts/fixtures/disposable-directory.mts") {
    selection.ui = true;
    selection.scopes.add("ui");
    selection.uiRelatedFiles.add("apps/desktop/scripts/desktop-listener-lifetime.test.mts");
  }

  if (file.startsWith(".github/workflows/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    addNodeTest(selection, "scripts/dependency-automation.test.mts");
    for (const testFile of workflowTests.get(path.posix.basename(file)) ?? [])
      addNodeTest(selection, testFile);
    recognized = true;
  }

  if (file.startsWith(".github/actions/")) {
    selection.scopes.add("workflow");
    selection.actionsLint = true;
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    addNodeTest(selection, "scripts/dependency-automation.test.mts");
    recognized = true;
  }

  if (file.startsWith(".github/ISSUE_TEMPLATE/")) {
    selection.scopes.add("repository-config");
    if (file.endsWith("new-port.yml")) addNodeTest(selection, "scripts/roadmap-intake.test.mts");
    recognized = true;
  }

  if (file === ".github/dependabot.yml") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    recognized = true;
  }

  if (file === "renovate.json") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/dependency-automation.test.mts");
    recognized = true;
  }

  if (file === ".github/release.yml") {
    selection.scopes.add("release-tooling");
    addNodeTest(selection, "scripts/release-workflow.test.mts");
    addNodeTest(selection, "scripts/release-package-policy.test.mts");
    recognized = true;
  }

  if (file === ".github/repository-ruleset.json" || file === ".github/repository-security.json") {
    selection.scopes.add("repository-config");
    addNodeTest(selection, "scripts/repository-settings.test.mts");
    recognized = true;
  }

  for (const testFile of explicitNodeTests.get(file) ?? []) {
    selection.scopes.add("tooling");
    addNodeTest(selection, testFile);
    recognized = true;
  }

  if (
    file.startsWith("crates/portcove-core/catalog/ports/") ||
    file === "crates/portcove-core/catalog/catalog-shared.json" ||
    file === "crates/portcove-core/catalog/listings.json"
  ) {
    selection.scopes.add("tooling");
    for (const testFile of catalogGeneratorContractTests) addNodeTest(selection, testFile);
    addNodeTest(selection, "scripts/catalog-staged-check.test.mts");
    recognized = true;
  }

  if (file === ".config/nextest.toml" && options.nextestUnchanged) {
    recognized = true;
    addNodeTest(selection, "scripts/nextest-equivalence.test.mts");
  }

  if (
    file.startsWith(".vite-hooks/") ||
    file === "vite.config.ts" ||
    file === "scripts/hooks-install.mts" ||
    file === "scripts/viteplus-cli.mts" ||
    file === "scripts/precommit.mts"
  ) {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/precommit-check.test.mts");
    recognized = true;
  }

  if (
    file === "aqua.yaml" ||
    file === "aqua-checksums.json" ||
    file === ".aqua-version" ||
    file === ".config/tool-bootstrap.json" ||
    file === ".config/powershell-resources.psd1"
  ) {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/quality-tools.test.mts");
    recognized = true;
  }

  if (
    ["aqua.yaml", "aqua-checksums.json", ".aqua-version", ".config/tool-bootstrap.json"].includes(
      file,
    )
  ) {
    selection.scopes.add("script-toolchain");
    selection.pythonLint = true;
    selection.pythonFiles.add("apps/desktop/assets/brand/models/v2");
  }

  if (
    file === ".editorconfig" ||
    file === ".oxfmtrc.json" ||
    file === ".oxlintrc.json" ||
    file === ".prettierignore" ||
    file === "prettier.config.mjs" ||
    file === "eslint.config.mjs" ||
    file === ".gitignore" ||
    file === ".gitattributes" ||
    file === ".git-blame-ignore-revs" ||
    file === ".node-version" ||
    file === ".rscheck.toml"
  ) {
    selection.scopes.add("repository-config");
    recognized = true;
  }

  if (file.startsWith(".vscode/")) {
    selection.scopes.add("repository-config");
    recognized = true;
  }

  if (file === ".oxlintrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    recognized = true;
  }

  if (file === ".oxfmtrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.scopes.add("ui");
    recognized = true;
  }

  if (file === "pyproject.toml") {
    selection.scopes.add("tooling");
    selection.pythonLint = true;
    recognized = true;
  }

  if (
    file.startsWith("docs/") ||
    extension === ".md" ||
    file === "LICENSE-APACHE" ||
    file === "LICENSE-MIT" ||
    file === "SECURITY.md" ||
    file === "CONTRIBUTING.md" ||
    file === "AGENTS.md"
  ) {
    selection.scopes.add("documentation");
    if (file.startsWith("docs/") || extension === ".md") {
      selection.scopes.add("tooling");
      addNodeTest(selection, "scripts/repository-skills.test.mts");
    }
    recognized = true;
  }

  if (file.startsWith(".agents/skills/") && file.endsWith("/SKILL.md")) {
    selection.scopes.add("tooling");
    addNodeTest(selection, "scripts/repository-skills.test.mts");
    recognized = true;
  }

  if (file.startsWith("integrations/playnite/")) {
    addNodeTest(selection, "integrations/playnite/lifecycle-check.test.mts");
    selection.scopes.add("playnite");
    selection.playnite = true;
    recognized = true;
  }

  if (file.startsWith("release/")) {
    selection.scopes.add("release-tooling");
    addNodeTest(selection, "scripts/release-package-policy.test.mts");
    addNodeTest(selection, "scripts/check-release-metadata.test.mts");
    recognized = true;
  }

  if (
    /(?:transport|schema)/i.test(file) &&
    (file.startsWith("crates/") || file.startsWith("apps/desktop/") || file.startsWith("scripts/"))
  ) {
    selection.scopes.add("transport");
    selection.transport = true;
    addNodeTest(selection, "scripts/check-transport-contract.test.mts");
    addNodeTest(selection, "scripts/check-transport-contract.integration.test.mts");
    addNodeTest(selection, "scripts/transport-types.test.mts");
    recognized = true;
  }

  if (!recognized) selection.unknown.add(file);
}

export function classifyChanges(
  changes: readonly LocalChange[],
  options: ClassifyOptions = {},
): ValidationSelection {
  const fileExists = options.fileExists ?? ((file) => existsSync(path.join(projectRoot, file)));
  const selection: ValidationSelection = {
    scopes: new Set(),
    packages: new Set(),
    nodeTests: new Set(),
    nodeSyntax: new Set(),
    oxfmtFiles: new Set(),
    uiRelatedFiles: new Set(),
    unknown: new Set(),
    rustfmt: false,
    workspaceRust: false,
    ui: false,
    browser: false,
    uiFullTests: false,
    oxlint: false,
    repositoryLint: false,
    stylelint: false,
    actionsLint: false,
    powershellLint: false,
    shellLint: false,
    pythonLint: false,
    playnite: false,
    transport: false,
    shellFiles: new Set(),
    pythonFiles: new Set(),
  };
  for (const change of changes) {
    classifyOnePath(selection, change.path, fileExists, {
      includeFileChecks: change.status !== "D",
      isDeletion: change.status === "D",
      nextestUnchanged: hasNextestEquivalence({
        ...change,
        oldPath: change.previousPath ?? change.path,
        newPath: change.path,
      }),
    });
    if (change.previousPath)
      classifyOnePath(selection, change.previousPath, fileExists, {
        includeFileChecks: false,
        isDeletion: true,
      });
  }
  for (const change of changes) {
    for (const file of [change.path, change.previousPath].filter(
      (file): file is string => typeof file === "string" && file.length > 0,
    )) {
      const owned = ordinaryOwnershipForPath(file);
      if (owned.groups.includes("frontend") && !selection.ui) {
        selection.ui = true;
        selection.uiFullTests = true;
      }
    }
  }
  // A removed/renamed family member cannot be executed, but all surviving
  // workflow contracts still run through the old integration consumer route.
  for (const change of changes) {
    const removed = change.status === "D" ? change.path : change.previousPath;
    if (removed && workflowContractTests.includes(removed) && !fileExists(removed))
      selection.nodeTests.delete(removed);
  }
  return selection;
}

function sorted(set: ReadonlySet<string>) {
  return [...set].sort((left, right) => left.localeCompare(right));
}

export function nodeTestCommand(files: string[]) {
  const serialWindowsQualification = [
    "scripts/updater-artifact-inventory.test.mts",
    "scripts/release-payload-signing.test.mts",
    "scripts/release-payload-preparation.test.mts",
    "scripts/windows-qualification-session.integration.test.mts",
  ].every((file) => files.includes(file));
  return command(
    "node-tests",
    serialWindowsQualification
      ? "exact repository-tool contract tests selected from changed paths; serialize competing Windows package lifecycle fixtures"
      : "exact repository-tool contract tests selected from changed paths",
    process.execPath,
    [
      "--test",
      "--test-timeout=60000",
      "--experimental-test-module-mocks",
      `--test-reporter=${requiredReporter}`,
      ...(serialWindowsQualification ? ["--test-concurrency=1"] : []),
      ...files,
    ],
  );
}

export function uiRelatedCommand(files: string[]) {
  return command(
    "ui-related-tests",
    "bundled Vitest import-graph tests across maintained projects",
    process.execPath,
    [
      "scripts/run-ui-tests.mts",
      "related",
      ...files.map((file) => path.resolve(projectRoot, file)),
    ],
    { cwd: projectRoot },
  );
}

export function buildPlan(
  selection: ValidationSelection,
  context: PlanningContext = {},
): RetainedCommand[] {
  const validation = context.validationPlan;
  if (validation) validateValidationPlan(validation);
  if (validation?.mode === "blocked")
    throw new Error(`Local plan is blocked: ${validation.reason}`);
  if (selection.unknown.size && (!validation?.fallback || validation.discovery !== "complete"))
    throw new Error("Unknown ownership requires a complete bound baseline plan");
  const broad = selection.unknown.size > 0;
  const commands = [
    command("diff-check", "complete candidate whitespace", "git", [
      "diff",
      "--check",
      context.mergeBase ?? "<merge-base>",
    ]),
  ];
  const fullStatic =
    selection.repositoryLint || broad || validation?.fallback || validation?.changes.length === 0;
  if (fullStatic)
    commands.push(
      frontendTask(
        "repository-lint",
        "integrated repository static checks",
        selection.ui || broad ? "frontend:static" : "repository:static",
      ),
    );
  const files = sorted(selection.oxfmtFiles).filter((file) =>
    existsSync(path.join(projectRoot, file)),
  );
  if (!fullStatic && files.length)
    commands.push(
      command("oxfmt", "supported-file formatting", process.execPath, [
        "scripts/run-viteplus.mts",
        "fmt",
        "--check",
        ...(broad || files.includes("vite.config.ts") ? [] : ["--no-error-on-unmatched-pattern"]),
        ...(broad || files.includes("vite.config.ts")
          ? []
          : files.map((file) => path.join(projectRoot, file))),
      ]),
    );
  if (selection.actionsLint)
    commands.push(
      command("actionlint", "workflow and embedded shell contracts", process.execPath, [
        "scripts/run-actionlint.mts",
      ]),
    );
  if (selection.shellLint && selection.shellFiles.size)
    commands.push(
      command("shell-lint", "owned shell script lint", "aqua", [
        "exec",
        "--",
        "shellcheck",
        "--severity=warning",
        ...sorted(selection.shellFiles),
      ]),
    );
  if (selection.pythonLint && selection.pythonFiles.size)
    commands.push(
      command("python-lint", "owned Python script lint", "aqua", [
        "exec",
        "--",
        "ruff",
        "check",
        ...sorted(selection.pythonFiles),
      ]),
    );
  if (selection.scopes.has("script-toolchain"))
    commands.push(
      command(
        "lint-tool-fixtures",
        "script toolchain positive and negative controls",
        process.execPath,
        ["scripts/lint-tools.integration.mts", "ruff", "shellcheck", "actionlint"],
      ),
    );
  if (selection.rustfmt || broad)
    commands.push(
      command("rustfmt", "Rust formatting", "cargo", ["fmt", "--all", "--", "--check"]),
    );
  const syntaxFiles = sorted(selection.nodeSyntax).filter((file) =>
    existsSync(path.join(projectRoot, file)),
  );
  const typescript = syntaxFiles.filter((file) => /\.[cm]?ts$/u.test(file));
  for (const [index, batch] of stagedFileBatches(typescript).entries())
    commands.push(
      command(
        `node-syntax:${typescript.length === 1 ? typescript[0] : `typescript:${index + 1}`}`,
        "changed native TypeScript syntax",
        process.execPath,
        ["scripts/check-node-source.mts", ...batch],
      ),
    );
  for (const file of syntaxFiles.filter((file) => !/\.[cm]?ts$/u.test(file)))
    commands.push(
      command(`node-syntax:${file}`, "changed script syntax", process.execPath, ["--check", file]),
    );
  if (selection.nodeTests.size) commands.push(nodeTestCommand(sorted(selection.nodeTests)));
  if (
    selection.packages.size ||
    selection.workspaceRust ||
    broad ||
    validation?.groups.includes("rust")
  ) {
    if (!validation) throw new Error("Rust feedback requires a complete validation plan");
    commands.push({
      rustCoverage: selectWorkspaceRustImpact(validation).map((group) => group.filter),
      ...command(
        "rust-workspace-tests",
        "compile workspace test targets and execute selected maintained families",
        process.execPath,
        [
          "scripts/run-rust-tests.mts",
          "--guard-command",
          process.execPath,
          "scripts/rust-test-impact.mts",
          "--workspace-run",
          "work/local-validation-plan.json",
        ],
      ),
    });
  }
  if (selection.ui || broad) {
    commands.push(
      ...(!fullStatic
        ? [frontendTask("ui-check", "frontend static checks", "frontend:static")]
        : []),
      frontendTask("ui-content", "frontend content policy", "frontend:content"),
      frontendTask("ui-build", "frontend production build", "frontend:build"),
    );
    if (selection.uiFullTests || broad || !selection.uiRelatedFiles.size)
      commands.push(frontendTask("ui-tests", "complete frontend test projects", "frontend:tests"));
    else commands.push(uiRelatedCommand(sorted(selection.uiRelatedFiles)));
  }
  return deduplicateCommands(commands);
}

function quote(value: string) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

export function formatCommand(entry: ValidationCommand) {
  return [entry.executable, ...entry.args].map(quote).join(" ");
}

// Portable review inventory only; these records are never accepted as shell input.
export function selectedPlanInventory(plan: readonly ValidationCommand[]) {
  const relative = (value: string) =>
    typeof value === "string" && value.startsWith(projectRoot)
      ? `$SOURCE/${value.slice(projectRoot.length).replaceAll("\\", "/")}`
      : value;
  return plan.map(({ id, executable, args, cwd }) => ({
    id,
    executable: executable === process.execPath ? "$NODE" : relative(executable),
    args: args.map(relative),
    cwd: relative(cwd),
  }));
}

export function executePlan(
  plan: readonly ValidationCommand[],
  options: { spawn?: CommandRunner; env?: NodeJS.ProcessEnv } = {},
) {
  const spawn = options.spawn ?? spawnCommand;
  const started = Date.now();
  const timings = [];
  for (const entry of plan) {
    console.log(`\n[local-check] ${entry.id}: ${entry.reason}`);
    const stageStarted = Date.now();
    const result = spawn(entry.executable, entry.args, {
      cwd: entry.cwd,
      stdio: "inherit",
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const elapsedMs = Date.now() - stageStarted;
    timings.push({ id: entry.id, elapsedMs });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${entry.id} failed with exit code ${result.status ?? "unknown"}`);
    console.log(`[local-check] ${entry.id} passed in ${(elapsedMs / 1000).toFixed(1)}s`);
  }
  return { elapsedMs: Date.now() - started, timings };
}
