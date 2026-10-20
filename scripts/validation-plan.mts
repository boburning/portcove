import { gzipSync, gunzipSync } from "node:zlib";
import type { NextestProof } from "./nextest-equivalence.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasNextestEquivalence, isNextestProof } from "./nextest-equivalence.mts";

const scriptPath = fileURLToPath(import.meta.url);

export const validationPlanVersion = 3;

export const fastGroups = Object.freeze([
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
] as const);

export const validationAreas = Object.freeze([
  "catalog",
  "dependency",
  "documentation",
  "frontend",
  "native-ipc",
  "platform",
  "policy",
  "release-security",
  "rust",
] as const);

export type ValidationGroup = (typeof fastGroups)[number];
export type ValidationArea = (typeof validationAreas)[number];
export type ValidationPlatform = "primary-host" | (typeof qualificationPlatforms)[number];
export type ReleaseQualificationProfile = "full" | "initial-beta-win-linux";
export interface ValidationChange {
  status: string;
  oldMode: string | null;
  newMode: string | null;
  oldPath: string;
  newPath: string;
  nextest_equivalence?: NextestProof;
}
export interface ValidationChangeInput {
  status: string;
  oldMode?: string | null;
  newMode?: string | null;
  oldPath?: string | null;
  newPath?: string | null;
  path?: string;
  // Raw local change discovery retains this property with undefined for non-renames.
  previousPath?: string | undefined;
  nextest_equivalence?: NextestProof;
}
export interface PathOwnership {
  path: string;
  areas: ValidationArea[];
  groups: ValidationGroup[];
  platforms: ValidationPlatform[];
  qualificationRequired: boolean;
  reasons: string[];
  unknown: boolean;
}
export interface ValidationPlan {
  format_version: 3;
  mode: "blocked" | "fast" | "prose" | "qualification";
  discovery: "complete" | "failed";
  reason: string;
  changed_files: string[];
  changes: ValidationChange[];
  areas: readonly ValidationArea[];
  groups: readonly ValidationGroup[];
  platforms: readonly ValidationPlatform[];
  qualification_required: boolean;
  release_profile?: "initial-beta-win-linux";
  fallback: { kind: "all-fast-groups"; paths: string[] } | null;
  identities: {
    base: string | null;
    merge_base: string | null;
    head: string | null;
    checkout: string;
  };
  paths: PathOwnership[];
  digest: string;
}
interface ValidationPlanInput {
  changes: ValidationChangeInput[];
  eventName: string;
  base?: string | null;
  mergeBase?: string | null;
  head?: string | null;
  checkout: string;
  discovery?: "complete" | "failed";
  blockedReason?: string | null;
}

// Documentation selection is about consumers, not a list of approved prose pages.
// Policy and executable examples retain their ordinary contract selection.
export function isInformationalPath(file: string) {
  return (
    (/\.md$/u.test(file) &&
      !protectedPolicyDocuments.has(file) &&
      !file.startsWith(".agents/") &&
      !file.startsWith("docs/agents/") &&
      !releaseSecurityFiles.has(file)) ||
    /^docs\/media\/.+\.(?:png|jpe?g|webp|gif|svg)$/u.test(file)
  );
}

export function isSharedFrontendInput(file: string) {
  return (
    [
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
      "pnpm-workspace.yaml",
      ".node-version",
      ".oxlintrc.json",
      ".oxfmtrc.json",
    ].includes(file) ||
    /^apps\/desktop\/(?:vitest(?:\.browser)?\.config\.ts|i18next(?:\.invalid)?\.config\.ts|\.fallowrc\.json)$/u.test(
      file,
    )
  );
}

export const qualificationPlatforms = Object.freeze([
  "linux-x86_64",
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
] as const);

export function qualificationPlatformsForProfile(profile: string = "full") {
  if (profile === "full") return qualificationPlatforms;
  if (profile === "initial-beta-win-linux")
    return Object.freeze(["linux-x86_64", "windows-x86_64"] as const);
  throw new Error("unknown release qualification profile");
}

function withNodeTestCompanions(files: readonly string[]) {
  return new Set(
    files.flatMap((file: string) =>
      /\.[cm]?[jt]s$/u.test(file) && !/\.test\.[cm]?[jt]s$/u.test(file)
        ? [
            file,
            file.replace(/\.[cm]?[jt]s$/u, /\.[cm]?ts$/u.test(file) ? ".test.mts" : ".test.mjs"),
          ]
        : [file],
    ),
  );
}

const protectedPolicyDocuments = new Set([
  "AGENTS.md",
  "SECURITY.md",
  "docs/CONTRIBUTION-CONVENTIONS.md",
  "docs/DEVELOPMENT-TOOLS.md",
  "docs/PROJECT-GOVERNANCE.md",
  "docs/QUALITY.md",
  "docs/REPOSITORY-SETTINGS.md",
  "docs/RELEASING.md",
  "docs/DELIVERY.md",
  "docs/UPDATER-TRUST.md",
]);

const protectedPolicyFiles = withNodeTestCompanions([
  ".config/nextest.toml",
  ".github/qualification-coverage.json",
  ".github/repository-ruleset.json",
  ".github/repository-security.json",
  "scripts/audit.mts",
  "scripts/linux-beta-risk-706.mts",
  "scripts/dependency-security.mts",
  "scripts/roadmap.mts",
  "scripts/audit-evidence.mts",
  "scripts/audit-archive.mts",
  "scripts/audit-reuse.mts",
  "scripts/check-child-process-policy.mts",
  "scripts/check-ci-prose.mts",
  "scripts/ci-result-gate.mts",
  "scripts/local-validation.mts",
  "scripts/ordinary-validation.mts",
  "scripts/validation-evidence.mts",
  "scripts/checked-git.mts",
  "scripts/resource-status.mts",
  "scripts/resource-capacity.mts",
  "scripts/resource-paths.mts",
  "scripts/resource-command.mts",
  "scripts/native-build.mts",

  "scripts/report-summary.mts",
  "scripts/qualification-coverage.mts",
  "scripts/repository-settings.mts",
  "scripts/run-rust-tests.mts",
  "scripts/rust-test-tree-supervisor.mts",
  "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  "scripts/select-ci-plan.mts",
  "scripts/validation-plan.mts",
  "scripts/workflow-provenance.mts",
]);

// Maintained qualification consumers, not Rust/product/catalog inputs. Their
// Node/context and Vitest contracts run in frontend CI; actual native acceptance
// is separate. A reviewed test path does not grant ownership to its implementation.
// New or renamed harness files stay unknown until their ownership is reviewed.
const nativeScenarioFiles = new Set([
  "apps/desktop/scripts/desktop-artwork-observations.mts",
  "apps/desktop/scripts/desktop-artwork-observations.native.test.mts",
  "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
  "apps/desktop/scripts/desktop-artwork-correction-test.mts",
  "apps/desktop/scripts/desktop-default-cover-test.mts",
  "apps/desktop/scripts/desktop-install-fixture.test.mts",
  "apps/desktop/scripts/desktop-install-fixture.native.test.mts",
  "apps/desktop/scripts/cli-command-shell.native.test.mts",
  "apps/desktop/scripts/desktop-preparation-test.mts",
  "apps/desktop/scripts/desktop-source-dialog-test.mts",
  "apps/desktop/scripts/desktop-test.mts",
  "apps/desktop/scripts/testdata/catalog-artwork-blue.jpg",
  "apps/desktop/scripts/testdata/catalog-artwork-red.jpg",
  "scripts/desktop-scenarios.mts",
  "scripts/desktop-scenarios.test.mts",
  "scripts/desktop-execution-plan.mts",
  "scripts/desktop-execution-plan.test.mts",
  "scripts/testdata/desktop-execution-baseline.json",
]);

// This is the maintained inventory of executable release, packaging, signing,
// qualification, and updater authorities. Node contract tests are protected
// with their implementations so a gate cannot weaken its own required proof.
const releaseSecurityFiles = withNodeTestCompanions([
  ".github/release.yml",
  ".agents/skills/portcove-port-qualification/SKILL.md",
  ".agents/skills/portcove-release-validation/SKILL.md",
  "apps/desktop/scripts/prepare-release-version.mts",
  "apps/desktop/scripts/release-version-policy.mts",
  "crates/portcove-core/src/catalog_store.rs",
  "crates/portcove-core/src/catalog_update.rs",
  "crates/portcove-core/src/signed_catalog.rs",
  "crates/portcove-core/src/signed_catalog_tests.rs",
  "docs/DEFINITION-DELIVERY.md",
  "docs/SIGNED-CATALOG.md",
  "docs/UPGRADING.md",
  "docs/qualification/application-update-production.aggregate.yml",
  "docs/qualification/application-update-production.payload-signing.yml",
  "docs/qualification/slice4-production-authorization-packet-2026-10-18.md",
  "scripts/check-release-metadata.mts",
  "scripts/controller-canary.mts",
  "scripts/production-controller-admission.mts",
  "scripts/release-site-composer.mts",
  "scripts/assembler-job-identity.mts",
  "scripts/release-control-inputs.mts",
  "scripts/release-capacity.mts",
  "scripts/release-canonical.mts",
  "scripts/release-metadata-contract.mts",
  "scripts/fixtures/release-metadata-canonical.json",
  "scripts/fixtures/release-metadata-fixture.mts",
  "scripts/release-semantic-review.mts",
  "scripts/release-semantic-inputs.mts",
  "scripts/release-semantic-runtime.mts",
  "scripts/release-semantic-reader.mts",
  "scripts/release-semantic-reader-core.mts",
  "scripts/release-semantic-reader-server.mts",
  "scripts/release-semantic-broker.mts",
  "scripts/semantic-review-sandbox.ps1",
  "scripts/semantic-review-linux-supervisor.py",
  "scripts/semantic-review-linux-supervisor.test.py",
  "scripts/semantic-review-linux-supervisor.test.mts",
  "scripts/qualify-semantic-linux.mts",
  "scripts/fixtures/semantic-review-appcontainer.cs.txt",
  "scripts/release-capacity-operation.mts",
  "scripts/release-input-protections.mts",
  "scripts/release-reviewed-inputs.mts",
  "docs/qualification/release-reviewed-inputs.held.yml",
  "scripts/trusted-aggregate-attestation.mts",
  "scripts/production-aggregate-steps.mts",
  "scripts/acquire-release-admission.mts",
  "scripts/release-coordinator-errors.mts",
  "scripts/release-candidate-qualification.mts",
  "scripts/release-immutable-publication.mts",
  "scripts/finalize-release-assets.mts",
  "scripts/trusted-release-assembly.mts",
  "scripts/release-artifact-archive.mts",
  "scripts/release-artifact-assembly.mts",
  "scripts/release-public-build-inputs.mts",
  "scripts/release-public-build-provenance.mts",
  "scripts/release-control-handshake.mts",
  "scripts/release-controller-tool-build.mts",
  "scripts/qualify-controller-tool-build.mts",
  ".github/workflows/controller-tool-build-fixture.yml",
  "scripts/release-controller-tool-bootstrap.mts",
  "scripts/release-controller-tools.mts",
  "scripts/release-controller-tool-admission.mts",
  "scripts/github-controller-attestation.mts",
  "docs/qualification/application-update-production.controller-tools.yml",
  "scripts/release-control-phases.mts",
  "scripts/release-handshake-hosted-fixture.mts",
  ".github/workflows/release-handshake-fixture.yml",
  "scripts/release-control-ready.mts",
  "scripts/release-live-control-admission.mts",
  "apps/desktop/src-tauri/tauri.release-public.conf.json",
  "scripts/bounded-zip.mts",
  "scripts/github-binary.mts",
  "scripts/generate-release-downloads.mts",
  "scripts/package-cli.ps1",
  "scripts/package-local.ps1",
  "scripts/qualification-report.mts",
  "scripts/reconcile-release-assets.mts",
  "scripts/reconstruct-application-update-records.mts",
  "scripts/rehearse-updater-artifacts.ps1",
  "scripts/release-package-policy.mts",
  "scripts/release-path-safety.mts",
  "scripts/release-result-gate.mts",
  "scripts/linux-beta-risk-706.mts",
  "scripts/dependency-security.mts",
  "scripts/roadmap.mts",
  "scripts/release-coordinator.mts",
  "scripts/release-coordinator-state.mts",
  "scripts/release-coordinator-remote.mts",
  "scripts/release-prepared-transport.mts",
  "scripts/release-coordinator-recovery.mts",
  "scripts/release-run-evidence.mts",
  "scripts/release-source-changes.mts",
  "scripts/release-preflight.ps1",
  "scripts/release-workflow.test.mts",
  "scripts/run-windows-qualification.ps1",
  "scripts/select-release-channel.mts",
  "scripts/sign-catalog.mts",
  "scripts/smoke-test-cli-archive.ps1",
  "scripts/source-provenance-audit.mts",
  "scripts/test-linux-package-ownership.sh",
  "scripts/test-windows-installer.ps1",
  "scripts/updater-artifact-inventory.mts",
  "scripts/release-payload-signing.mts",
  "scripts/release-payload-preparation.mts",
  "scripts/verify-macos-release.ps1",
  "scripts/windows-qualification-session.ps1",
  "scripts/windows-qualification-session.integration.test.mts",
  "scripts/windows-qualification-session.test.mts",
  "scripts/write-release-checksums.mts",
  "scripts/write-windows-qualification-build.mts",
]);

const ordinaryGithubFiles = new Set([
  ".github/dependabot.yml",
  ".github/pr-conventions.json",
  ".github/roadmap.json",
]);

function explicitPlatformOwnership(file: string) {
  const platforms: ValidationPlatform[] = [];
  if (/(?:^|[/_.-])windows(?:[/_.-]|$)|\.msi$/u.test(file)) platforms.push("windows-x86_64");
  if (/(?:^|[/_.-])(?:linux|appimage|steam-deck)(?:[/_.-]|$)/u.test(file))
    platforms.push("linux-x86_64");
  if (/(?:^|[/_.-])macos(?:[/_.-]|$)|\.dmg$/u.test(file))
    platforms.push("macos-aarch64", "macos-x86_64");
  return platforms;
}

function normalizedPath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`unsafe changed path: ${JSON.stringify(value)}`);
  }
  return value;
}

function add<Value>(target: Set<Value>, ...values: readonly Value[]) {
  for (const value of values) target.add(value);
}

function classifyPath(file: string): PathOwnership {
  const areas = new Set<ValidationArea>();
  const groups = new Set<ValidationGroup>();
  const platforms = new Set<ValidationPlatform>();
  const reasons: string[] = [];
  let qualificationRequired = false;

  const platformMatches = explicitPlatformOwnership(file);
  const hasPlatformSignal = platformMatches.length > 0;
  const inertGithubFile =
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file === ".github/PULL_REQUEST_TEMPLATE.md" ||
    file === ".github/CODEOWNERS";
  const protectedGithubAutomation =
    file.startsWith(".github/workflows/") || file.startsWith(".github/actions/");
  const protectedPolicy =
    protectedPolicyDocuments.has(file) ||
    protectedPolicyFiles.has(file) ||
    protectedGithubAutomation ||
    (file.startsWith(".github/") &&
      !inertGithubFile &&
      !ordinaryGithubFiles.has(file) &&
      !releaseSecurityFiles.has(file));
  const releaseSecurity =
    file.startsWith("release/") ||
    file.startsWith("release-metadata/") ||
    releaseSecurityFiles.has(file) ||
    file.startsWith("crates/portcove-release-tools/") ||
    file.startsWith("apps/desktop/src-tauri/src/application_update_");
  // Documentation captures are not consumed by the catalog or application.
  // Keep their documentation checks without interpreting a pictured topic as
  // executable catalog/source authority. Other formats and locations retain
  // their existing routes; file modes and rename sides are checked separately.

  const match = (
    condition: boolean,
    area: ValidationArea,
    selectedGroups: readonly ValidationGroup[],
    reason: string,
  ) => {
    if (!condition) return;
    areas.add(area);
    add(groups, ...selectedGroups);
    reasons.push(reason);
  };
  const documentation =
    (file.endsWith(".md") || file.startsWith("docs/") || inertGithubFile) &&
    !(releaseSecurity && /\.ya?ml$/u.test(file));
  const rust = file.startsWith("crates/") || file.startsWith("apps/desktop/src-tauri/");
  const rootRust = [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "deny.toml",
    ".config/nextest.toml",
    ".config/rust-test-impact.json",
  ].includes(file);
  match(documentation, "documentation", ["catalog", "rust-quality"], "documentation-contract");
  // Prose and captures are inert even when their topic names a platform or schema.
  if (!documentation) {
    match(
      isSharedFrontendInput(file) ||
        file.startsWith("apps/desktop/src/") ||
        [
          "scripts/browser-traces.ts",
          "scripts/viteplus-cli.mts",
          "scripts/frontend-tests.ts",
          "scripts/run-ui-tests.mts",
          "scripts/run-viteplus.mts",
          "scripts/ui-test-selection.mts",
        ].includes(file) ||
        file.startsWith("apps/desktop/public/") ||
        nativeScenarioFiles.has(file) ||
        /^apps\/desktop\/(?:index\.html|package\.json|tsconfig.*\.json|vite\.config\.[cm]?ts|stylelint\.config\.[cm]?[jt]s)$/u.test(
          file,
        ),
      "frontend",
      ["frontend", "rust-quality"],
      "frontend-input",
    );
    match(rust || rootRust, "rust", ["rust", "rust-quality"], "rust-workspace-input");
    match(
      /^apps\/desktop\/src\/transport-[^/]+\.generated\.(?:json|d\.ts)$/u.test(file) ||
        [
          "scripts/check-transport-contract.mts",
          "scripts/transport-schemas.mts",
          "apps/desktop/scripts/generate-transport-types.mts",
        ].includes(file),
      "native-ipc",
      ["catalog", "frontend", "rust", "rust-quality"],
      "generated-transport-input",
    );
    match(
      file.startsWith("apps/desktop/src-tauri/") ||
        (!/catalog/iu.test(file) &&
          /(?:transport|schema|ipc)/iu.test(file) &&
          (rust || file.startsWith("scripts/"))),
      "native-ipc",
      ["catalog", "frontend", "rust-quality", ...(rust ? ["rust" as const] : [])],
      "native-or-ipc-contract",
    );
    match(
      file.startsWith("crates/portcove-core/catalog/"),
      "catalog",
      ["catalog", "rust", "rust-quality"],
      "catalog-contract",
    );
    match(
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u.test(file),
      "dependency",
      ["dependency-review", "frontend", "rust-quality"],
      "frontend-dependency-input",
    );
    match(
      /(?:^|\/)(?:Cargo\.toml|Cargo\.lock)$/u.test(file),
      "dependency",
      ["dependency-review", "rust", "rust-quality"],
      "rust-dependency-input",
    );
    match(
      [
        ".node-version",
        ".aqua-version",
        "aqua.yaml",
        "aqua-checksums.json",
        "renovate.json",
        ".github/quality-tools.json",
        ".config/tool-bootstrap.json",
        ".config/powershell-resources.psd1",
      ].includes(file),
      "dependency",
      fastGroups,
      "shared-toolchain-or-dependency-policy",
    );
    match(
      releaseSecurity,
      "release-security",
      ["catalog", "rust-quality", ...(rust ? ["rust" as const] : [])],
      "release-or-security-contract",
    );
    match(
      hasPlatformSignal && !nativeScenarioFiles.has(file),
      "platform",
      ["catalog", "rust-quality", ...(rust ? ["rust" as const] : [])],
      "platform-contract",
    );
    match(
      file.startsWith("scripts/") ||
        file === ".fallow-tooling.json" ||
        file.startsWith(".vite-hooks/") ||
        file === "lint-staged.config.mjs" ||
        file.startsWith("integrations/") ||
        ordinaryGithubFiles.has(file) ||
        file.startsWith(".vscode/"),
      "policy",
      ["catalog", "rust-quality"],
      "tooling-contract",
    );
    match(
      protectedPolicy ||
        [
          ".editorconfig",
          ".gitattributes",
          ".gitignore",
          ".oxfmtrc.json",
          ".oxlintrc.json",
          "vite.config.ts",
          "tsconfig.json",
          "tsconfig.base.json",
          ".prettierignore",
          ".rscheck.toml",
          "eslint.config.mjs",
          "prettier.config.mjs",
          "pyproject.toml",
          "justfile",
        ].includes(file),
      "policy",
      ["catalog", "rust-quality"],
      "policy-contract",
    );
  }
  if (areas.size === 0) {
    add(groups, ...fastGroups);
    reasons.push("recognized-unknown-path-all-fast-fallback");
  }
  platforms.add("primary-host");

  return {
    path: file,
    areas: [...areas].sort(compareStrings),
    groups: [...groups].sort(compareStrings),
    platforms: [...platforms].sort(compareStrings),
    qualificationRequired,
    reasons: [...new Set(reasons)].sort(compareStrings),
    unknown: areas.size === 0,
  };
}

// Audit receipt domains retain their conservative input ownership independently
// of ordinary CI scheduling. Changing the PR budget must not admit stale audit receipts.
function classifyAuditPath(file: string): PathOwnership {
  const areas = new Set<ValidationArea>();
  const groups = new Set<ValidationGroup>();
  const platforms = new Set<ValidationPlatform>();
  const reasons: string[] = [];
  let qualificationRequired = false;

  const platformMatches = explicitPlatformOwnership(file);
  const hasPlatformSignal = platformMatches.length > 0;
  const affectedPlatforms = platformMatches.length > 0 ? platformMatches : qualificationPlatforms;
  const inertGithubFile =
    file.startsWith(".github/ISSUE_TEMPLATE/") ||
    file === ".github/PULL_REQUEST_TEMPLATE.md" ||
    file === ".github/CODEOWNERS";
  const protectedGithubAutomation =
    file.startsWith(".github/workflows/") || file.startsWith(".github/actions/");
  const protectedPolicy =
    protectedPolicyDocuments.has(file) ||
    protectedPolicyFiles.has(file) ||
    protectedGithubAutomation ||
    (file.startsWith(".github/") &&
      !inertGithubFile &&
      !ordinaryGithubFiles.has(file) &&
      !releaseSecurityFiles.has(file));
  const releaseSecurity =
    file.startsWith("release/") ||
    file.startsWith("release-metadata/") ||
    releaseSecurityFiles.has(file) ||
    file.startsWith("crates/portcove-release-tools/") ||
    file.startsWith("apps/desktop/src-tauri/src/application_update_");
  // Documentation captures are not consumed by the catalog or application.
  // Keep their documentation checks without interpreting a pictured topic as
  // executable catalog/source authority. Other formats and locations retain
  // their existing routes; file modes and rename sides are checked separately.
  const documentationRaster = /^docs\/media\/.+\.(?:png|jpg|jpeg|webp)$/u.test(file);

  const match = (
    condition: boolean,
    area: ValidationArea,
    selectedGroups: readonly ValidationGroup[],
    reason: string,
    selectedPlatforms: readonly ValidationPlatform[] = [],
  ) => {
    if (!condition) return;
    areas.add(area);
    add(groups, ...selectedGroups);
    add(platforms, ...selectedPlatforms);
    reasons.push(reason);
  };

  match(
    file.startsWith("docs/") || /^(?:README|CONTRIBUTING|SECURITY|AGENTS)\.md$/u.test(file),
    "documentation",
    ["catalog", "rust-quality"],
    "documentation-contract",
  );
  match(
    inertGithubFile,
    "documentation",
    ["catalog", "rust-quality"],
    "inert-github-document-or-template",
  );
  match(
    ordinaryGithubFiles.has(file),
    file === ".github/dependabot.yml" ? "dependency" : "documentation",
    file === ".github/dependabot.yml"
      ? ["dependency-review", "rust-quality"]
      : ["catalog", "rust-quality"],
    "ordinary-github-maintenance-contract",
  );
  match(
    file.startsWith("apps/desktop/src/") ||
      [
        "scripts/browser-traces.ts",
        "scripts/viteplus-cli.mts",
        "scripts/frontend-tests.ts",
        "scripts/run-ui-tests.mts",
        "scripts/run-viteplus.mts",
        "scripts/ui-test-selection.mts",
      ].includes(file) ||
      nativeScenarioFiles.has(file) ||
      file.startsWith("apps/desktop/public/") ||
      /^apps\/desktop\/(?:index\.html|package\.json|tsconfig.*\.json|vite\.config\.[cm]?ts|stylelint\.config\.[cm]?[jt]s)$/u.test(
        file,
      ),
    "frontend",
    ["frontend", "rust-quality"],
    "frontend-input",
  );
  match(
    file.startsWith("crates/") ||
      [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "deny.toml",
        ".config/nextest.toml",
      ].includes(file),
    "rust",
    ["rust", "rust-quality"],
    "rust-workspace-input",
  );
  match(
    file.startsWith("apps/desktop/src-tauri/") ||
      (!/catalog/iu.test(file) && /(?:transport|schema|ipc)/iu.test(file)) ||
      file.startsWith("integrations/"),
    "native-ipc",
    ["frontend", "rust", "rust-quality"],
    "native-or-ipc-boundary",
    hasPlatformSignal ? affectedPlatforms : qualificationPlatforms,
  );
  match(
    !nativeScenarioFiles.has(file) &&
      !documentationRaster &&
      (file === "crates/portcove-core/catalog/catalog.json" ||
        file.startsWith("crates/portcove-core/catalog/") ||
        /(?:catalog|retcomm|source-provenance)/iu.test(file)),
    "catalog",
    ["catalog", "rust", "rust-quality"],
    "catalog-or-source-contract",
  );
  match(
    /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/u.test(file),
    "dependency",
    ["dependency-review", "frontend", "rust-quality"],
    "frontend-dependency-input",
  );
  match(
    /(?:^|\/)(?:Cargo\.toml|Cargo\.lock)$/u.test(file),
    "dependency",
    ["dependency-review", "rust", "rust-quality"],
    "rust-dependency-input",
  );
  match(
    /(?:^|\/)(?:pnpm-workspace\.yaml|rust-toolchain\.toml|renovate\.json|aqua\.yaml|aqua-checksums\.json|quality-tools\.json|tool-bootstrap\.json)$/u.test(
      file,
    ) || [".node-version", ".aqua-version", ".config/powershell-resources.psd1"].includes(file),
    "dependency",
    fastGroups,
    "shared-toolchain-or-dependency-policy",
    qualificationPlatforms,
  );
  match(
    hasPlatformSignal,
    "platform",
    ["rust", "rust-quality"],
    "platform-specific-input",
    affectedPlatforms,
  );
  match(
    releaseSecurity,
    "release-security",
    fastGroups,
    "release-or-security-boundary",
    qualificationPlatforms,
  );
  match(
    protectedPolicy ||
      [
        ".editorconfig",
        ".gitattributes",
        ".oxfmtrc.json",
        ".oxlintrc.json",
        "vite.config.ts",
        "tsconfig.json",
        "tsconfig.base.json",
        ".prettierignore",
        ".rscheck.toml",
        "eslint.config.mjs",
        "prettier.config.mjs",
        "pyproject.toml",
        "apps/desktop/.fallowrc.json",
        ".fallow-tooling.json",
        "apps/desktop/eslint.config.mjs",
        "apps/desktop/stylelint.config.mjs",
        "apps/desktop/scripts/stylelint-config.mts",
      ].includes(file) ||
      file === "justfile",
    "policy",
    fastGroups,
    "protected-policy-or-automation",
    qualificationPlatforms,
  );

  if ([...areas].some((area) => ["release-security", "policy"].includes(area))) {
    qualificationRequired = true;
  }
  if (
    (["native-ipc", "platform", "dependency"] as const).some((area) => areas.has(area)) &&
    qualificationPlatforms.every((platform) => platforms.has(platform))
  )
    qualificationRequired = true;

  if (areas.size === 0) {
    add(groups, ...fastGroups);
    platforms.add("primary-host");
    reasons.push("recognized-unknown-path-all-fast-fallback");
  }

  return {
    path: file,
    areas: [...areas].sort(compareStrings),
    groups: [...groups].sort(compareStrings),
    platforms: [...platforms].sort(compareStrings),
    qualificationRequired,
    reasons: [...new Set(reasons)].sort(compareStrings),
    unknown: areas.size === 0,
  };
}

export function ordinaryOwnershipForPath(input: string) {
  return classifyPath(normalizedPath(input));
}

export function validationOwnershipForPath(input: string) {
  return classifyAuditPath(normalizedPath(input));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestValidationPlan(plan: object) {
  const unsigned = Object.fromEntries(Object.entries(plan));
  delete unsigned.digest;
  return createHash("sha256")
    .update(stableJson(unsigned) ?? "")
    .digest("hex");
}

function isRegularValidationChange(
  change: Pick<ValidationChangeInput, "status" | "oldMode" | "newMode">,
) {
  const status = String(change.status).charAt(0);
  const regular = (mode: string | null | undefined) =>
    ["100644", "100755"].some((valid) => valid === mode);
  if (["A", "?"].includes(status)) return change.oldMode === "000000" && regular(change.newMode);
  if (status === "D") return regular(change.oldMode) && change.newMode === "000000";
  return ["M", "R"].includes(status) && regular(change.oldMode) && regular(change.newMode);
}

export function buildValidationPlan({
  changes,
  eventName,
  base = null,
  mergeBase = null,
  head = null,
  checkout,
  discovery = "complete",
  blockedReason = null,
}: ValidationPlanInput): ValidationPlan {
  if (!/^[a-f0-9]{40}$/u.test(checkout ?? ""))
    throw new Error("checkout SHA must be a full lowercase Git SHA");
  if (!Array.isArray(changes)) throw new Error("changes must be an array");

  const identities = { base, merge_base: mergeBase, head, checkout };
  if (
    blockedReason ||
    discovery !== "complete" ||
    (eventName === "pull_request" && !changes.length)
  ) {
    const plan: Omit<ValidationPlan, "digest"> = {
      format_version: validationPlanVersion,
      mode: "blocked",
      discovery,
      reason: blockedReason ?? "unexplained-empty-change-set",
      changed_files: [],
      changes: [],
      areas: [],
      groups: [],
      platforms: [],
      qualification_required: false,
      fallback: null,
      identities,
      paths: [],
    };
    return { ...plan, digest: digestValidationPlan(plan) };
  }

  if (changes.length === 0) {
    const plan: Omit<ValidationPlan, "digest"> = {
      format_version: validationPlanVersion,
      mode: "fast",
      discovery,
      reason: "main-or-explicit-event-all-fast-groups",
      changed_files: [],
      changes: [],
      areas: validationAreas,
      groups: fastGroups,
      platforms: ["primary-host"],
      qualification_required: false,
      fallback: null,
      identities,
      paths: [],
    };
    return { ...plan, digest: digestValidationPlan(plan) };
  }

  const normalizedChanges = changes.map((change) => ({
    ...change,
    oldPath: normalizedPath(change.oldPath ?? change.previousPath ?? change.path),
    newPath: normalizedPath(change.newPath ?? change.path),
  }));
  const paths = [
    ...new Set(normalizedChanges.flatMap((change) => [change.oldPath, change.newPath])),
  ]
    .sort(compareStrings)
    .map((file): PathOwnership => {
      const owned = classifyPath(file);
      if (
        file === ".config/nextest.toml" &&
        normalizedChanges
          .filter((c) => c.oldPath === file || c.newPath === file)
          .every(hasNextestEquivalence)
      )
        return {
          ...owned,
          areas: ["policy"],
          groups: ["catalog", "rust-quality"],
          reasons: ["effective-nextest-configuration-unchanged"],
        };
      return owned;
    });
  const changedFiles = paths.map((entry) => entry.path);
  const allProse = changedFiles.every(isInformationalPath);
  const regular = normalizedChanges.every(isRegularValidationChange);

  if (!regular)
    return buildValidationPlan({
      changes: [],
      eventName,
      checkout,
      base,
      mergeBase,
      head,
      discovery: "failed",
      blockedReason: "unsafe-file-type-or-change-status",
    });
  const areas = [...new Set(paths.flatMap((entry) => entry.areas))].sort(compareStrings);
  const unknown = paths.filter((entry) => entry.unknown).map((entry) => entry.path);
  const qualificationRequired = paths.some((entry) => entry.qualificationRequired);
  const groups = qualificationRequired
    ? fastGroups
    : unknown.length
      ? fastGroups
      : [...new Set(paths.flatMap((entry) => entry.groups))].sort(compareStrings);
  const selectedPlatforms = [...new Set(paths.flatMap((entry) => entry.platforms))].sort(
    compareStrings,
  );
  const platforms: readonly ValidationPlatform[] = qualificationRequired
    ? qualificationPlatforms
    : unknown.length || selectedPlatforms.length === 0
      ? ["primary-host"]
      : selectedPlatforms;
  const mode = allProse ? "prose" : qualificationRequired ? "qualification" : "fast";
  const plan: Omit<ValidationPlan, "digest"> = {
    format_version: validationPlanVersion,
    mode,
    discovery,
    reason:
      mode === "prose"
        ? "reviewed-informational-prose-only"
        : unknown.length
          ? "recognized-unknown-path-all-fast-fallback"
          : qualificationRequired
            ? "high-risk-area-requires-qualification"
            : "area-routed-fast-validation",
    changed_files: changedFiles,
    changes: normalizedChanges.map(
      ({ status, oldMode, newMode, oldPath, newPath, nextest_equivalence }) => ({
        status,
        oldMode: oldMode ?? null,
        newMode: newMode ?? null,
        oldPath,
        newPath,
        ...(nextest_equivalence ? { nextest_equivalence } : {}),
      }),
    ),
    areas,
    groups,
    platforms,
    qualification_required: qualificationRequired,
    fallback: unknown.length ? { kind: "all-fast-groups", paths: unknown } : null,
    identities,
    paths,
  };
  return { ...plan, digest: digestValidationPlan(plan) };
}

function assertStringArray<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): asserts value is Value[] {
  if (!Array.isArray(value)) throw new Error(`validation ${label} must be an array`);
  for (const item of value) {
    if (
      typeof item !== "string" ||
      (allowed.length > 0 && !allowed.some((entry) => entry === item))
    )
      throw new Error(`unknown validation ${label}: ${JSON.stringify(item)}`);
  }
}

function assertPathOwnership(entry: unknown): asserts entry is PathOwnership {
  if (!isRecord(entry)) throw new Error("validation path entry is malformed");
  normalizedPath(entry.path);
  assertStringArray(entry.areas, validationAreas, "path area");
  assertStringArray(entry.groups, fastGroups, "path group");
  assertStringArray(entry.platforms, ["primary-host", ...qualificationPlatforms], "path platform");
  assertStringArray(entry.reasons, [], "path reason");
  if (typeof entry.qualificationRequired !== "boolean" || typeof entry.unknown !== "boolean")
    throw new Error("validation path authority is malformed");
}

// Narrow the untrusted wire shape before semantic/digest checks. Both stages
// inspect the original object; no projection can discard retained identities.
function assertPlanShape(plan: unknown): asserts plan is ValidationPlan {
  if (!isRecord(plan)) throw new Error("validation plan must be an object");
  if (plan.format_version !== validationPlanVersion) throw new Error("unsupported plan version");
  if (typeof plan.digest !== "string") throw new Error("validation plan digest mismatch");
  if (!["blocked", "fast", "prose", "qualification"].some((mode) => mode === plan.mode))
    throw new Error("invalid validation plan mode");
  if (plan.discovery !== "complete" && plan.discovery !== "failed")
    throw new Error("invalid validation plan discovery state");
  if (typeof plan.reason !== "string" || !plan.reason)
    throw new Error("validation plan reason is missing");
  if (typeof plan.qualification_required !== "boolean")
    throw new Error("validation qualification authority is invalid");
  if (Object.hasOwn(plan, "release_profile") && plan.release_profile !== "initial-beta-win-linux")
    throw new Error("invalid release qualification profile");
  assertStringArray(plan.changed_files, [], "changed_files");
  assertStringArray(plan.areas, validationAreas, "area");
  assertStringArray(plan.groups, fastGroups, "group");
  assertStringArray(plan.platforms, ["primary-host", ...qualificationPlatforms], "platform");
  if (!Array.isArray(plan.changes)) throw new Error("validation plan changes must be an array");
  for (const change of plan.changes) {
    if (!isRecord(change) || typeof change.status !== "string")
      throw new Error("invalid validation change status");
    normalizedPath(change.oldPath);
    normalizedPath(change.newPath);
    if (
      (change.oldMode !== null && typeof change.oldMode !== "string") ||
      (change.newMode !== null && typeof change.newMode !== "string")
    )
      throw new Error("unsafe or missing validation file mode");
    if (change.nextest_equivalence !== undefined && !isNextestProof(change.nextest_equivalence))
      throw new Error("invalid nextest equivalence proof");
  }
  if (!Array.isArray(plan.paths)) throw new Error("validation plan paths must be an array");
  for (const entry of plan.paths) assertPathOwnership(entry);
  if (!isRecord(plan.identities)) throw new Error("validation identities are missing");
  for (const field of ["base", "merge_base", "head", "checkout"] as const) {
    const value = plan.identities[field];
    if ((field === "checkout" || value !== null) && typeof value !== "string")
      throw new Error(`validation identity ${field} is invalid`);
  }
  if (plan.fallback !== null) {
    if (!isRecord(plan.fallback) || plan.fallback.kind !== "all-fast-groups")
      throw new Error("validation fallback is malformed");
    assertStringArray(plan.fallback.paths, [], "fallback path");
  }
}

export function validateValidationPlan(input: unknown): ValidationPlan {
  assertPlanShape(input);
  return validatePlanSemantics(input);
}

function validatePlanSemantics(plan: ValidationPlan): ValidationPlan {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new Error("validation plan must be an object");
  if (plan.format_version !== validationPlanVersion) throw new Error("unsupported plan version");
  if (!/^[a-f0-9]{64}$/u.test(plan.digest ?? "") || digestValidationPlan(plan) !== plan.digest)
    throw new Error("validation plan digest mismatch");
  if (!["blocked", "fast", "prose", "qualification"].includes(plan.mode))
    throw new Error("invalid validation plan mode");
  if (!["complete", "failed"].includes(plan.discovery))
    throw new Error("invalid validation plan discovery state");
  if (typeof plan.reason !== "string" || plan.reason.length === 0)
    throw new Error("validation plan reason is missing");
  if (typeof plan.qualification_required !== "boolean")
    throw new Error("validation qualification authority is invalid");
  for (const field of [
    "changed_files",
    "changes",
    "areas",
    "groups",
    "platforms",
    "paths",
  ] as const)
    if (!Array.isArray(plan[field])) throw new Error(`validation plan ${field} must be an array`);

  const assertUniqueSorted = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`duplicate validation ${label}`);
    if (JSON.stringify(values) !== JSON.stringify([...values].sort(compareStrings)))
      throw new Error(`validation ${label} must be sorted`);
  };
  for (const file of plan.changed_files) normalizedPath(file);
  assertUniqueSorted(plan.changed_files, "changed file");
  for (const area of plan.areas)
    if (!validationAreas.includes(area)) throw new Error(`unknown validation area: ${area}`);
  assertUniqueSorted(plan.areas, "area");
  for (const group of plan.groups)
    if (!fastGroups.includes(group)) throw new Error(`unknown validation group: ${group}`);
  assertUniqueSorted(plan.groups, "group");
  for (const platform of plan.platforms)
    if (!["primary-host", ...qualificationPlatforms].includes(platform))
      throw new Error(`unknown validation platform: ${platform}`);
  assertUniqueSorted(plan.platforms, "platform");

  const changePaths = [];
  for (const change of plan.changes) {
    if (!change || !["A", "D", "M", "R", "?"].includes(String(change.status).charAt(0)))
      throw new Error("invalid validation change status");
    changePaths.push(normalizedPath(change.oldPath), normalizedPath(change.newPath));
    if (!isRegularValidationChange(change))
      throw new Error("unsafe or missing validation file mode");
  }
  if (
    JSON.stringify([...new Set(changePaths)].sort(compareStrings)) !==
    JSON.stringify(plan.changed_files)
  )
    throw new Error("validation changes do not match changed files");
  const pathNames = [];
  for (const entry of plan.paths) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("validation path entry is malformed");
    pathNames.push(normalizedPath(entry.path));
    for (const field of ["areas", "groups", "platforms", "reasons"] as const)
      if (!Array.isArray(entry[field]))
        throw new Error(`validation path ${field} must be an array`);
    for (const area of entry.areas)
      if (!validationAreas.includes(area)) throw new Error(`unknown path validation area: ${area}`);
    for (const group of entry.groups)
      if (!fastGroups.includes(group)) throw new Error(`unknown path validation group: ${group}`);
    for (const platform of entry.platforms)
      if (!["primary-host", ...qualificationPlatforms].includes(platform))
        throw new Error(`unknown path validation platform: ${platform}`);
    if (
      entry.reasons.length === 0 ||
      entry.reasons.some((reason) => typeof reason !== "string" || reason.length === 0)
    )
      throw new Error("validation path reason is malformed");
    for (const field of ["areas", "groups", "platforms", "reasons"] as const)
      assertUniqueSorted(entry[field], `path ${field.slice(0, -1)}`);
    if (typeof entry.qualificationRequired !== "boolean" || typeof entry.unknown !== "boolean")
      throw new Error("validation path authority is malformed");
    if ((entry.unknown && entry.areas.length > 0) || (!entry.unknown && entry.areas.length === 0))
      throw new Error("validation path unknown state is inconsistent");
  }
  assertUniqueSorted(pathNames, "path");
  if (JSON.stringify(pathNames) !== JSON.stringify(plan.changed_files))
    throw new Error("validation path inventory does not match changed files");

  if (!plan.identities || typeof plan.identities !== "object" || Array.isArray(plan.identities))
    throw new Error("validation identities are missing");
  for (const field of ["base", "merge_base", "head", "checkout"] as const)
    if (
      (field === "checkout" && !/^[a-f0-9]{40}$/u.test(plan.identities[field] ?? "")) ||
      (field !== "checkout" &&
        plan.identities[field] !== null &&
        !/^[a-f0-9]{40}$/u.test(plan.identities[field] ?? ""))
    )
      throw new Error(`validation identity ${field} is invalid`);
  if (
    plan.paths.length > 0 &&
    (["base", "merge_base", "head"] as const).some(
      (field) => !/^[a-f0-9]{40}$/u.test(plan.identities[field] ?? ""),
    )
  )
    throw new Error("pull-request validation identities must be exact");

  const unknownPaths = plan.paths.filter((entry) => entry.unknown).map((entry) => entry.path);
  if (
    plan.fallback !== null &&
    (plan.fallback?.kind !== "all-fast-groups" ||
      !Array.isArray(plan.fallback.paths) ||
      plan.fallback.paths.length === 0)
  )
    throw new Error("validation fallback is malformed");
  if (plan.fallback) {
    for (const file of plan.fallback.paths) normalizedPath(file);
    assertUniqueSorted(plan.fallback.paths, "fallback path");
    if (JSON.stringify(plan.fallback.paths) !== JSON.stringify(unknownPaths))
      throw new Error("validation fallback does not match unknown paths");
  } else if (unknownPaths.length > 0) {
    throw new Error("validation fallback is missing for unknown paths");
  }

  if (plan.discovery === "failed" && plan.mode !== "blocked")
    throw new Error("failed discovery cannot authorize validation");
  if (plan.mode !== "blocked" && plan.discovery !== "complete")
    throw new Error("active validation requires complete discovery");
  if (
    plan.release_profile !== undefined &&
    (plan.mode !== "qualification" ||
      plan.reason !== "explicit-reusable-qualification" ||
      plan.paths.length !== 0)
  )
    throw new Error("release profile requires explicit reusable qualification");
  if (plan.mode === "blocked") {
    if (
      plan.changed_files.length ||
      plan.changes.length ||
      plan.areas.length ||
      plan.groups.length ||
      plan.platforms.length ||
      plan.paths.length ||
      plan.fallback !== null ||
      plan.qualification_required
    )
      throw new Error("blocked plans cannot authorize work");
    return plan;
  }
  if (plan.groups.length === 0) throw new Error("active validation plan must select a group");
  if (plan.mode === "qualification" && !plan.qualification_required)
    throw new Error("qualification mode must require qualification");
  if (plan.mode !== "qualification" && plan.qualification_required)
    throw new Error("only qualification mode may require qualification");
  if (
    plan.mode === "qualification" &&
    (JSON.stringify(plan.groups) !== JSON.stringify(fastGroups) ||
      JSON.stringify(plan.platforms) !==
        JSON.stringify(qualificationPlatformsForProfile(plan.release_profile)))
  )
    throw new Error("qualification plan must include every protected group and platform");
  if (plan.platforms.length === 0) throw new Error("active validation plan must select a platform");

  if (plan.paths.length === 0) {
    if (plan.mode === "prose") throw new Error("prose validation requires changed paths");
    if (
      plan.changed_files.length ||
      JSON.stringify(plan.areas) !== JSON.stringify(validationAreas) ||
      JSON.stringify(plan.groups) !== JSON.stringify(fastGroups) ||
      (plan.mode === "fast" &&
        JSON.stringify(plan.platforms) !== JSON.stringify(["primary-host"])) ||
      plan.fallback !== null ||
      (["base", "merge_base", "head"] as const).some((field) => plan.identities[field] !== null)
    )
      throw new Error("explicit-event validation plan is inconsistent");
  } else if (["fast", "prose"].includes(plan.mode)) {
    const expectedAreas = [...new Set(plan.paths.flatMap((entry) => entry.areas))].sort(
      compareStrings,
    );
    const expectedGroups = [...new Set(plan.paths.flatMap((entry) => entry.groups))].sort(
      compareStrings,
    );
    const routedPlatforms = [...new Set(plan.paths.flatMap((entry) => entry.platforms))].sort(
      compareStrings,
    );
    const expectedPlatforms = routedPlatforms.length > 0 ? routedPlatforms : ["primary-host"];
    if (
      JSON.stringify(plan.areas) !== JSON.stringify(expectedAreas) ||
      JSON.stringify(plan.groups) !== JSON.stringify(expectedGroups) ||
      JSON.stringify(plan.platforms) !== JSON.stringify(expectedPlatforms)
    )
      throw new Error("routed validation plan does not match its path inventory");
    if (
      plan.paths.some((entry) => entry.qualificationRequired) ||
      (plan.mode === "prose" && plan.changed_files.some((file) => !isInformationalPath(file)))
    )
      throw new Error("routed validation mode does not match its path authority");
  }
  return plan;
}

// GitHub outputs may hold the complete plan, but Linux cannot exec a child
// with a single environment string above MAX_ARG_STRLEN. Bound both transport
// and inflation; compression never replaces plan/digest/source validation.
const planJsonByteLimit = 1024 * 1024;
const planEnvironmentByteLimit = 64 * 1024;
export function encodeValidationPlanEnvironment(plan: ValidationPlan): string {
  validateValidationPlan(plan);
  const json = JSON.stringify(plan);
  if (Buffer.byteLength(json) > planJsonByteLimit)
    throw new Error("Validation plan exceeds JSON byte limit");
  const encoded = gzipSync(json).toString("base64");
  if (encoded.length > planEnvironmentByteLimit)
    throw new Error("Validation plan exceeds environment transport limit");
  return encoded;
}
export function readValidationPlanInput(environment: NodeJS.ProcessEnv = process.env): unknown {
  const encoded = environment.PORTCOVE_PLAN_GZIP_BASE64;
  const legacy = environment.PORTCOVE_PLAN_JSON;
  if (encoded !== undefined && legacy !== undefined)
    throw new Error("Validation plan has ambiguous environment transports");
  let text: string;
  if (encoded !== undefined) {
    if (
      !encoded.length ||
      encoded.length > planEnvironmentByteLimit ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
    )
      throw new Error("Invalid validation plan base64 transport");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("Noncanonical validation plan base64 transport");
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      gunzipSync(bytes, { maxOutputLength: planJsonByteLimit }),
    );
  } else {
    text = legacy ?? "";
    if (Buffer.byteLength(text) > planJsonByteLimit)
      throw new Error("Validation plan exceeds JSON byte limit");
  }
  const value: unknown = JSON.parse(text);
  return value;
}

export function validateQualificationBinding({
  plan: input,
  digest,
  checkout,
  releaseProfile = "full",
}: {
  plan: unknown;
  digest: string | undefined;
  checkout: string | undefined;
  releaseProfile?: string;
}) {
  const plan = validateValidationPlan(input);
  const expectedPlatforms = qualificationPlatformsForProfile(releaseProfile);
  if ((plan.release_profile ?? "full") !== releaseProfile)
    throw new Error("reusable qualification release profile mismatch");
  if (plan.mode !== "qualification" || !plan.qualification_required)
    throw new Error("reusable result is not a qualification plan");
  if (plan.digest !== digest) throw new Error("reusable qualification digest mismatch");
  if (plan.identities?.checkout !== checkout || !/^[a-f0-9]{40}$/u.test(checkout ?? ""))
    throw new Error("reusable qualification checkout mismatch");
  if (
    JSON.stringify([...plan.groups].sort(compareStrings)) !==
    JSON.stringify([...fastGroups].sort(compareStrings))
  )
    throw new Error("reusable qualification omitted a protected group");
  if (
    JSON.stringify([...plan.platforms].sort(compareStrings)) !==
    JSON.stringify([...expectedPlatforms].sort(compareStrings))
  )
    throw new Error("reusable qualification omitted a platform");
  return plan;
}

function main() {
  let input: unknown;
  try {
    input = readValidationPlanInput();
  } catch {
    throw new Error("Validation plan environment must contain the reusable qualification plan");
  }
  const plan = validateQualificationBinding({
    plan: input,
    digest: process.env.PORTCOVE_PLAN_DIGEST,
    checkout: process.env.PORTCOVE_EXPECTED_CHECKOUT,
    releaseProfile: process.env.PORTCOVE_RELEASE_PROFILE ?? "full",
  });
  console.log(`Reusable qualification ${plan.digest} is bound to ${plan.identities.checkout}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
