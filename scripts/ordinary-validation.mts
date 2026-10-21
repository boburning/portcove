import { normalizeRepositoryPath as normalizePath } from "./repository-path.mts";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from "node:child_process";
import type { ValidationChangeInput, ValidationPlan } from "./validation-plan.mts";
import { isRecord } from "./runtime-values.mts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationPlan, validationOwnershipForPath } from "./validation-plan.mts";
import { selectWorkspaceRustImpact } from "./rust-test-impact.mts";
import { hasNextestEquivalence } from "./nextest-equivalence.mts";
import {
  nativeHelperDependencies,
  nativeHelperRegistryPath,
} from "./native-helper-dependencies.mts";
import { ordinaryOwnershipForPath } from "./validation-plan.mts";
import { spawnCommand } from "./dev-storage.mts";
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
  lintToolFixtures: Set<string>;
  unknown: Set<string>;
  shellFiles: Set<string>;
  pythonFiles: Set<string>;
  rustChanges: (LocalChange & { packageName: string })[];
  rustfmt: boolean;
  workspaceRust: boolean;
  workspaceRustTests: boolean;
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
  doctestPackages?: ReadonlySet<string>;
}
type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => Pick<SpawnSyncReturns<Buffer>, "error" | "status">;
type MetadataRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Partial<Pick<SpawnSyncReturns<string>, "error" | "status" | "signal" | "stdout" | "stderr">>;
interface MetadataObservation {
  reason: string;
  code: string | null;
  status: number | null;
  signal: string | null;
  elapsed_ms: number;
  observe_only: true;
  offline: true;
  locked: true;
  timeout_ms: number;
  capture_complete: boolean;
  stdout: { bytes: number; sha256: string } | null;
  stderr: { bytes: number; sha256: string } | null;
}

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
const durationReporter = "./scripts/test-duration-reporter.mts";

const packagePrefixes = new Map([
  ["crates/portcove-core/", "portcove-core"],
  ["crates/portcove-cli/", "portcove-cli"],
  ["crates/portcove-release-tools/", "portcove-release-tools"],
  ["apps/desktop/src-tauri/", "portcove-desktop"],
]);

export function packagesWithDoctests(metadata: unknown): Set<string> {
  if (!isRecord(metadata) || !Array.isArray(metadata.packages))
    throw new Error("cargo metadata did not return a package inventory");
  const packages: unknown[] = metadata.packages;
  const names = new Set<string>();
  for (const pkg of packages) {
    if (!isRecord(pkg) || typeof pkg.name !== "string" || !Array.isArray(pkg.targets)) continue;
    const targets: unknown[] = pkg.targets;
    if (targets.some((target) => isRecord(target) && target.doctest === true)) names.add(pkg.name);
  }
  return names;
}

const metadataObservations = new WeakMap<object, MetadataObservation>();
const metadataErrorCode = (error: unknown): string | null => {
  try {
    const code = isRecord(error) ? error.code : undefined;
    return ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "E2BIG", "EIO"].some(
      (known) => known === code,
    )
      ? String(code)
      : code === undefined
        ? null
        : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
};
export function readDoctestPackages(
  options: { spawn?: MetadataRunner; observeOnly?: boolean } = {},
): Set<string> {
  const started = performance.now();
  const result = (options.spawn ?? spawnSync)(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      ...(options.observeOnly ? ["--offline", "--locked"] : []),
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.observeOnly ? 15_000 : undefined,
      env: options.observeOnly
        ? { ...process.env, RUSTUP_AUTO_INSTALL: "0", CARGO_NET_OFFLINE: "true" }
        : process.env,
    },
  );
  const refuse = (reason: string, error: unknown): never => {
    try {
      if (
        options.observeOnly &&
        ((typeof error === "object" && error !== null) || typeof error === "function")
      ) {
        const fingerprint = (value: unknown) =>
          typeof value === "string"
            ? {
                bytes: Buffer.byteLength(value),
                sha256: createHash("sha256").update(value).digest("hex"),
              }
            : null;
        metadataObservations.set(error, {
          reason,
          code: metadataErrorCode(error),
          status:
            typeof result.status === "number" && Number.isInteger(result.status)
              ? result.status
              : null,
          signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"].some(
            (signal) => signal === result.signal,
          )
            ? String(result.signal)
            : result.signal == null
              ? null
              : "UNKNOWN",
          elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
          observe_only: true,
          offline: true,
          locked: true,
          timeout_ms: 15_000,
          capture_complete:
            !result.error && Number.isInteger(result.status) && result.signal == null,
          stdout: fingerprint(result.stdout),
          stderr: fingerprint(result.stderr),
        });
      }
    } catch {
      /* Diagnostic failure must preserve the original planning error. */
    }
    throw error;
  };
  if (result.error) refuse("spawn-error", result.error);
  if (result.status !== 0)
    refuse("cargo-exit", new Error(`cargo metadata failed: ${String(result.stderr ?? "").trim()}`));
  let metadata: unknown;
  try {
    metadata = JSON.parse(String(result.stdout));
  } catch (error) {
    refuse("metadata-json", error);
  }
  try {
    return packagesWithDoctests(metadata);
  } catch (error) {
    return refuse("package-inventory", error);
  }
}

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

const explicitNodeTests = new Map<string, readonly string[]>([
  ...[
    "release-controller-configuration",
    "release-controller-job",
    "release-controller-job-bootstrap",
    "release-controller-job-output",
    "release-aggregate-locator",
    "release-coordinator-namespace",
  ].map((name): [string, string[]] => [
    `scripts/${name}.mts`,
    ["scripts/release-tuf-controller.test.mts", "scripts/release-controller-tools.test.mts"],
  ]),
  [
    ".github/actions/release-controller-job/action.yml",
    ["scripts/release-controller-tools.test.mts"],
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
  ["scripts/release-coordinator-deadline.mts", ["scripts/release-coordinator-deadline.test.mts"]],
  ...["worker", "worker-recovery", "request-pipeline"].map((name): [string, string[]] => [
    `scripts/release-semantic-${name}.mts`,
    ["scripts/release-semantic-worker.test.mts"],
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
  ["scripts/release-publication-inventory.mts", ["scripts/acquire-release-admission.test.mts"]],
  ["scripts/release-published-source.mts", ["scripts/release-published-source.test.mts"]],
  ["scripts/release-semantic-disposition.mts", ["scripts/release-semantic-disposition.test.mts"]],
  [
    "scripts/release-semantic-disposition-reader.mts",
    ["scripts/release-semantic-disposition-reader.test.mts"],
  ],
  [
    "scripts/release-authority-configuration.mts",
    [
      "scripts/production-controller-admission.test.mts",
      "scripts/release-bootstrap-preparation.test.mts",
    ],
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
  ["scripts/release-controller-diagnostics.mts", ["scripts/release-controller-transport.test.mts"]],
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
    "scripts/release-native-pre-sign-report.mts",
    ["scripts/release-native-pre-sign-report.test.mts"],
  ],
  ["scripts/release-native-check-broker.mts", ["scripts/release-native-check-broker.test.mts"]],
  [
    "scripts/release-native-worker.mts",
    [
      "scripts/release-native-windows-driver.test.mts",
      "scripts/release-native-public-attempt-contract.test.mts",
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
  ["scripts/release-tuf-publication.mts", ["scripts/release-tuf-signing.test.mts"]],
  [
    "scripts/release-native-publication-admission.mts",
    ["scripts/release-native-admission.test.mts"],
  ],
  ["scripts/release-controller-wake.mts", ["scripts/release-controller-wake.test.mts"]],
  ["scripts/release-publication-result.mts", ["scripts/release-publication-result.test.mts"]],
  [
    "scripts/release-publication-result-artifact.mts",
    ["scripts/release-publication-result-artifact.test.mts"],
  ],
  [
    "scripts/release-signing-context-artifact.mts",
    ["scripts/release-signing-context-artifact.test.mts"],
  ],
  [
    "scripts/release-authority-configuration.mts",
    [
      "scripts/production-controller-admission.test.mts",
      "scripts/release-bootstrap-preparation.test.mts",
    ],
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
  ...[...Object.keys(nativeHelperDependencies), nativeHelperRegistryPath].map(
    (file): [string, string[]] => [
      file,
      [
        "scripts/native-helper-dependencies.test.mts",
        "scripts/native-confirmation.test.mts",
        "scripts/desktop-execution-plan.test.mts",
        "scripts/windows-helper-checks.test.mts",
      ],
    ],
  ),
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
  ...[
    "scripts/desktop-execution-plan.mts",
    "scripts/desktop-scenarios.mts",
    "scripts/desktop-verify.mts",
    "scripts/testdata/desktop-execution-baseline.json",
    "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
  ].map((file): [string, string[]] => [
    file,
    [
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-verify.test.mts",
      "scripts/frontend-command-preflight.test.mts",
      "scripts/native-helper-dependencies.test.mts",
      "scripts/windows-helper-checks.test.mts",
    ],
  ]),
  ...[
    "apps/desktop/scripts/desktop-application-update-journey.mts",
    "apps/desktop/scripts/desktop-installed-update-harness.mts",
    "apps/desktop/scripts/desktop-windows-public-update.mts",
    "apps/desktop/scripts/desktop-windows-public-update-files.mts",
  ].map((file): [string, string[]] => [file, ["scripts/desktop-scenarios.test.mts"]]),
  ...[
    "scripts/validation-plan.mts",
    "scripts/validation-plan.test.mts",
    "scripts/local-validation.mts",
    "scripts/ordinary-validation.mts",
    "scripts/local-validation.test.mts",
  ].map((file): [string, string[]] => [file, selectionContractTests]),
  ["AGENTS.md", ["scripts/repository-settings.test.mts", "scripts/repository-skills.test.mts"]],
  [
    "scripts/node-test-inventory.mts",
    [
      "scripts/node-test-inventory.test.mts",
      "scripts/ci-workflow.test.mts",
      "scripts/precommit-check.test.mts",
    ],
  ],
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
    "scripts/local-validation.mts",
    [...selectionContractTests, "scripts/repository-settings.test.mts"],
  ],
  [
    ".config/rust-test-impact.json",
    ["scripts/rust-test-impact.test.mts", "scripts/local-validation.test.mts"],
  ],
  [
    "scripts/ci-baseline.mts",
    ["scripts/ci-baseline.test.mts", "scripts/local-validation.test.mts"],
  ],
  ["scripts/rust-test-impact.mts", ["scripts/rust-test-impact.test.mts"]],
  [
    "scripts/desktop-linux-x11.mts",
    [
      "scripts/desktop-linux-native-session.test.mts",
      "scripts/native-session-lock.test.mts",
      "scripts/resource-command.test.mts",
    ],
  ],
  ["scripts/ui-test-selection.mts", ["scripts/ui-test-selection.test.mts"]],
  ["scripts/run-ui-tests.mts", ["scripts/ui-test-selection.test.mts"]],
  ["scripts/run-viteplus.mts", ["scripts/frontend-command-preflight.test.mts"]],
  ["scripts/pr-delivery.mts", ["scripts/repository-skills.test.mts"]],
  ["scripts/package-local.ps1", ["scripts/repository-skills.test.mts"]],
  ["scripts/release-preflight.ps1", ["scripts/repository-skills.test.mts"]],
  [
    "scripts/roadmap.mts",
    ["scripts/repository-skills.test.mts", "scripts/discovery-intake.test.mts"],
  ],
  ["scripts/upstream-observer.mts", ["scripts/discovery-checkpoint.test.mts"]],
  ["scripts/observe-configured-upstream.mts", ["scripts/discovery-checkpoint.test.mts"]],
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
  [
    "crates/portcove-core/catalog/catalog-current-authoring.json",
    ["scripts/generate-catalog.test.mts"],
  ],
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
    ["scripts/generate-catalog.test.mts", "scripts/repository-skills.test.mts"],
  ],
  ["crates/portcove-core/src/catalog.rs", ["scripts/repository-skills.test.mts"]],
  [
    "apps/desktop/scripts/desktop-test.mts",
    [
      "scripts/desktop-execution-plan.test.mts",
      "scripts/desktop-scenarios.test.mts",
      "scripts/desktop-verify.test.mts",
      "scripts/frontend-command-preflight.test.mts",
      "scripts/native-helper-dependencies.test.mts",
      "scripts/windows-helper-checks.test.mts",
      "scripts/development-evidence.test.mts",
      "scripts/native-session-lock.test.mts",
    ],
  ],
  ["apps/desktop/scripts/desktop-preparation-test.mts", ["scripts/desktop-scenarios.test.mts"]],
  [
    "apps/desktop/scripts/desktop-listener-lifetime-test.mts",
    ["scripts/desktop-listener-probe.test.mts"],
  ],
  ["apps/desktop/scripts/desktop-default-cover-test.mts", ["scripts/desktop-scenarios.test.mts"]],
  ["apps/desktop/scripts/desktop-source-dialog-test.mts", ["scripts/desktop-scenarios.test.mts"]],
  [
    ".github/quality-tools.json",
    ["scripts/quality-tools.test.mts", "scripts/dependency-automation.test.mts"],
  ],
  [".node-version", ["scripts/dependency-automation.test.mts"]],
  ["Cargo.toml", ["scripts/dependency-automation.test.mts"]],
  ["rust-toolchain.toml", ["scripts/dependency-automation.test.mts"]],
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
  [".github/roadmap.json", ["scripts/roadmap.test.mts"]],
  [".github/pr-conventions.json", ["scripts/pr-conventions.test.mts"]],
  [".github/upstream-health-accounting.json", ["scripts/upstream-observer.test.mts"]],
  [
    ".github/linux-beta-risk-706.json",
    ["scripts/linux-beta-risk-706.test.mts", "scripts/validation-plan.test.mts"],
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
    "scripts/ordinary-validation.mts",
    [...selectionContractTests, "scripts/validation-evidence.test.mts"],
  ],
]);

const workflowTests = new Map([
  ["controller-tool-build-fixture.yml", ["scripts/release-controller-tools.test.mts"]],
  [
    "application-update-production.yml",
    ["scripts/production-controller-admission.test.mts", "scripts/release-production-dag.test.mts"],
  ],
  [
    "application-update-wake.yml",
    ["scripts/release-controller-wake.test.mts", "scripts/release-production-dag.test.mts"],
  ],
  ["release.yml", ["scripts/release-workflow.test.mts"]],
  ["qualification.yml", ["scripts/qualification-coverage.test.mts"]],
  ["configured-upstream-observer.yml", ["scripts/upstream-observer.test.mts"]],
  ["upstream-health.yml", ["scripts/upstream-observer.test.mts"]],
  [
    "updater-artifact-rehearsal.yml",
    ["scripts/updater-artifact-inventory.test.mts", "scripts/release-payload-signing.test.mts"],
  ],
  ["pr-conventions.yml", ["scripts/pr-conventions.test.mts"]],
]);

const releaseContractTests = Object.freeze([
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
  "scripts/release-native-linux-driver.test.mts",
  "scripts/native-qualification-linux-supervisor.test.mts",
  "scripts/native-qualification-linux-transfer.test.mts",
  "scripts/release-native-wsl-capture.test.mts",
  "scripts/release-native-candidate.test.mts",
  "scripts/release-native-attempt.test.mts",
  "scripts/release-native-windows-driver.test.mts",
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
  "scripts/release-coordinator-state.test.mts",
  "scripts/release-prepared-transport.test.mts",
  "scripts/release-run-evidence.test.mts",
  "scripts/reconstruct-application-update-records.test.mts",
  "scripts/release-workflow.test.mts",
  "scripts/windows-qualification-session.test.mts",
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
  // These contracts formerly ran through imports; keep them in focused routes
  // now that each suite has its own explicit execution entry point.
  if (normalized === "scripts/desktop-scenarios.test.mts")
    selection.nodeTests.add("scripts/native-compatibility.test.mts");
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
    file.startsWith("docs/") &&
    /\.ya?ml$/u.test(file) &&
    validationOwnershipForPath(file).areas.includes("release-security")
  ) {
    selection.scopes.add("release-tooling");
    for (const testFile of releaseContractTests) addNodeTest(selection, testFile);
    recognized = true;
  }
  if (
    file.startsWith("apps/desktop/src/browser/") ||
    file.startsWith("apps/desktop/src/components/ui/") ||
    file.startsWith("apps/desktop/src/styles/") ||
    file.endsWith(".module.css") ||
    [
      "apps/desktop/scripts/browser-runtime.mts",
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
    (file === ".config/nextest.toml" && !options.nextestUnchanged)
  ) {
    selection.workspaceRust = true;
    if (file !== "Cargo.lock" || options.isDeletion) selection.workspaceRustTests = true;
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
      "scripts/viteplus-cli.mts",
      "scripts/frontend-tests.ts",
      "scripts/run-ui-tests.mts",
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
    if (file === "scripts/lint-tools.integration.mts") {
      for (const fixture of [
        "actionlint",
        "oxfmt",
        "oxlint",
        "psscriptanalyzer",
        "ruff",
        "shellcheck",
        "stylelint",
      ])
        selection.lintToolFixtures.add(fixture);
    }
    if (validationOwnershipForPath(file).areas.includes("release-security")) {
      selection.scopes.add("release-tooling");
      for (const testFile of releaseContractTests) addNodeTest(selection, testFile);
      addNodeTest(selection, "scripts/ci-workflow.test.mts");
    }
  }

  if (file === "crates/portcove-core/src/testdata/host_tool_probe.rs.txt") {
    selection.scopes.add("tooling");
    recognized = true;
    addNodeTest(selection, "scripts/run-rust-tests.test.mts");
    addNodeTest(selection, "scripts/rust-support-cache.test.mts");
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
    if (file.endsWith("new-port.yml")) addNodeTest(selection, "scripts/roadmap.test.mts");
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
    selection.lintToolFixtures.add("oxlint");
    selection.scopes.add("ui");
    addNodeTest(selection, "scripts/ci-workflow.test.mts");
    recognized = true;
  }

  if (file === ".oxfmtrc.json") {
    selection.ui = true;
    selection.uiFullTests = true;
    selection.lintToolFixtures.add("oxfmt");
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

function packageForPath(input: string) {
  const file = normalizePath(input);
  for (const [prefix, packageName] of packagePrefixes)
    if (file.startsWith(prefix)) return packageName;
  return null;
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
    lintToolFixtures: new Set(),
    unknown: new Set(),
    rustfmt: false,
    workspaceRust: false,
    workspaceRustTests: false,
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
    rustChanges: [],
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
    const currentPackage = packageForPath(change.path);
    if (currentPackage) selection.rustChanges.push({ ...change, packageName: currentPackage });
    const previousPackage = change.previousPath ? packageForPath(change.previousPath) : null;
    if (change.previousPath && previousPackage && previousPackage !== currentPackage)
      selection.rustChanges.push({
        status: change.status,
        path: change.previousPath,
        previousPath: change.path,
        packageName: previousPackage,
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
      "--test-timeout=30000",
      `--test-reporter=${durationReporter}`,
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
  if (selection.rustfmt || broad)
    commands.push(
      command("rustfmt", "Rust formatting", "cargo", ["fmt", "--all", "--", "--check"]),
    );
  for (const file of sorted(selection.nodeSyntax))
    if (existsSync(path.join(projectRoot, file)))
      commands.push(
        command(`node-syntax:${file}`, "changed script syntax", process.execPath, [
          ...(/\.[cm]?ts$/u.test(file)
            ? ["scripts/check-node-source.mts", file]
            : ["--check", file]),
        ]),
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
      commands.push(
        frontendTask("ui-tests", "complete frontend Node project", "frontend:unit"),
        frontendTask("ui-browser-tests", "complete real DOM project", "frontend:browser"),
      );
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
