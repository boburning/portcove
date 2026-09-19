import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export const validationPlanVersion = 2;

export const fastGroups = Object.freeze([
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
]);

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
]);

export const proseOnlyAllowlist = Object.freeze([
  "docs/GUI-COMPETITIVE-REVIEW.md",
  "docs/README.md",
]);

export const qualificationPlatforms = Object.freeze([
  "linux-x86_64",
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
]);

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

const protectedPolicyFiles = new Set([
  ".config/nextest.toml",
  ".github/fast-host-policy.json",
  ".github/qualification-coverage.json",
  ".github/repository-ruleset.json",
  ".github/repository-security.json",
  "scripts/audit.mjs",
  "scripts/check-child-process-policy.mjs",
  "scripts/check-ci-prose.mjs",
  "scripts/ci-result-gate.mjs",
  "scripts/local-validation.mjs",
  "scripts/qualification-coverage.mjs",
  "scripts/repository-settings.mjs",
  "scripts/run-rust-tests.mjs",
  "scripts/select-ci-plan.mjs",
  "scripts/select-fast-host.mjs",
  "scripts/validation-plan.mjs",
  "scripts/workflow-provenance.mjs",
]);

const releaseSecurityFiles = new Set([
  ".github/release.yml",
  "scripts/check-release-metadata.mjs",
  "scripts/finalize-release-assets.mjs",
  "scripts/generate-release-downloads.mjs",
  "scripts/package-local.ps1",
  "scripts/reconcile-release-assets.mjs",
  "scripts/reconstruct-application-update-records.mjs",
  "scripts/release-result-gate.mjs",
  "scripts/release-coordinator.mjs",
  "scripts/release-preflight.ps1",
  "scripts/select-release-channel.mjs",
  "scripts/test-linux-package-ownership.sh",
  "scripts/test-windows-installer.ps1",
  "scripts/updater-artifact-inventory.mjs",
  "scripts/windows-qualification-session.ps1",
  "scripts/write-release-checksums.mjs",
]);

const ordinaryGithubFiles = new Set([
  ".github/dependabot.yml",
  ".github/pr-conventions.json",
  ".github/roadmap.json",
]);

function explicitPlatformOwnership(file) {
  const platforms = [];
  if (/(?:^|[/_.-])windows(?:[/_.-]|$)|\.msi$/u.test(file)) platforms.push("windows-x86_64");
  if (/(?:^|[/_.-])(?:linux|appimage|steam-deck)(?:[/_.-]|$)/u.test(file))
    platforms.push("linux-x86_64");
  if (/(?:^|[/_.-])macos(?:[/_.-]|$)|\.dmg$/u.test(file))
    platforms.push("macos-aarch64", "macos-x86_64");
  return platforms;
}

function normalizedPath(value) {
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

function add(target, ...values) {
  for (const value of values) target.add(value);
}

function classifyPath(file) {
  const areas = new Set();
  const groups = new Set();
  const platforms = new Set();
  const reasons = [];
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

  const match = (condition, area, selectedGroups, reason, selectedPlatforms = []) => {
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
      file.startsWith("apps/desktop/public/") ||
      /^apps\/desktop\/(?:index\.html|package\.json|pnpm-lock\.yaml|tsconfig.*\.json|vite\.config\.[cm]?ts|stylelint\.config\.mjs)$/u.test(
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
    file === "crates/portcove-core/catalog/catalog.json" ||
      file.startsWith("crates/portcove-core/catalog/") ||
      /(?:catalog|retcomm|source-provenance)/iu.test(file),
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
        ".prettierignore",
        ".rscheck.toml",
        "eslint.config.mjs",
        "hawk.toml",
        "prettier.config.mjs",
        "pyproject.toml",
        "semdup.toml",
        "taplo.toml",
        "apps/desktop/.fallowrc.json",
        "apps/desktop/eslint.config.mjs",
        "apps/desktop/stylelint.config.mjs",
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
    ["native-ipc", "platform", "dependency"].some((area) => areas.has(area)) &&
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
    areas: [...areas].sort(),
    groups: [...groups].sort(),
    platforms: [...platforms].sort(),
    qualificationRequired,
    reasons: [...new Set(reasons)].sort(),
    unknown: areas.size === 0,
  };
}

export function validationOwnershipForPath(input) {
  return classifyPath(normalizedPath(input));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestValidationPlan(plan) {
  const unsigned = { ...plan };
  delete unsigned.digest;
  return createHash("sha256").update(stableJson(unsigned)).digest("hex");
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
}) {
  if (!/^[a-f0-9]{40}$/u.test(checkout ?? ""))
    throw new Error("checkout SHA must be a full lowercase Git SHA");
  if (!Array.isArray(changes)) throw new Error("changes must be an array");

  const identities = { base, merge_base: mergeBase, head, checkout };
  if (
    blockedReason ||
    discovery !== "complete" ||
    (eventName === "pull_request" && !changes.length)
  ) {
    const plan = {
      format_version: validationPlanVersion,
      mode: "blocked",
      discovery,
      reason: blockedReason ?? "unexplained-empty-change-set",
      changed_files: [],
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

  if (eventName !== "pull_request") {
    const plan = {
      format_version: validationPlanVersion,
      mode: "fast",
      discovery,
      reason: "main-or-explicit-event-all-fast-groups",
      changed_files: [],
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
    .sort()
    .map(classifyPath);
  const changedFiles = paths.map((entry) => entry.path);
  const allProse = changedFiles.every((file) => proseOnlyAllowlist.includes(file));
  const regular = normalizedChanges.every(
    (change) =>
      ["A", "D", "M", "R", "?"].includes(String(change.status).charAt(0)) &&
      (!change.oldMode ||
        !change.newMode ||
        ((change.oldMode === "000000" || change.oldMode === "100644") &&
          (change.newMode === "000000" || change.newMode === "100644"))),
  );

  const areas = [
    ...new Set([...paths.flatMap((entry) => entry.areas), ...(!regular ? ["policy"] : [])]),
  ].sort();
  const unknown = paths.filter((entry) => entry.unknown).map((entry) => entry.path);
  const qualificationRequired = !regular || paths.some((entry) => entry.qualificationRequired);
  const groups = qualificationRequired
    ? fastGroups
    : unknown.length
      ? fastGroups
      : [...new Set(paths.flatMap((entry) => entry.groups))].sort();
  const selectedPlatforms = [...new Set(paths.flatMap((entry) => entry.platforms))].sort();
  const platforms = qualificationRequired
    ? qualificationPlatforms
    : unknown.length || selectedPlatforms.length === 0
      ? ["primary-host"]
      : selectedPlatforms;
  const mode = allProse && regular ? "prose" : qualificationRequired ? "qualification" : "fast";
  const plan = {
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

export function validateValidationPlan(plan) {
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
  for (const field of ["changed_files", "areas", "groups", "platforms", "paths"])
    if (!Array.isArray(plan[field])) throw new Error(`validation plan ${field} must be an array`);

  const assertUniqueSorted = (values, label) => {
    if (new Set(values).size !== values.length) throw new Error(`duplicate validation ${label}`);
    if (JSON.stringify(values) !== JSON.stringify([...values].sort()))
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

  const pathNames = [];
  for (const entry of plan.paths) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("validation path entry is malformed");
    pathNames.push(normalizedPath(entry.path));
    for (const field of ["areas", "groups", "platforms", "reasons"])
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
    for (const field of ["areas", "groups", "platforms", "reasons"])
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
  for (const field of ["base", "merge_base", "head", "checkout"])
    if (
      (field === "checkout" && !/^[a-f0-9]{40}$/u.test(plan.identities[field] ?? "")) ||
      (field !== "checkout" &&
        plan.identities[field] !== null &&
        !/^[a-f0-9]{40}$/u.test(plan.identities[field] ?? ""))
    )
      throw new Error(`validation identity ${field} is invalid`);
  if (
    plan.paths.length > 0 &&
    ["base", "merge_base", "head"].some(
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
  if (plan.mode === "blocked") {
    if (
      plan.changed_files.length ||
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
      JSON.stringify(plan.platforms) !== JSON.stringify(qualificationPlatforms))
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
      ["base", "merge_base", "head"].some((field) => plan.identities[field] !== null)
    )
      throw new Error("explicit-event validation plan is inconsistent");
  } else if (["fast", "prose"].includes(plan.mode)) {
    const expectedAreas = [...new Set(plan.paths.flatMap((entry) => entry.areas))].sort();
    const expectedGroups = [...new Set(plan.paths.flatMap((entry) => entry.groups))].sort();
    const routedPlatforms = [...new Set(plan.paths.flatMap((entry) => entry.platforms))].sort();
    const expectedPlatforms = routedPlatforms.length > 0 ? routedPlatforms : ["primary-host"];
    if (
      JSON.stringify(plan.areas) !== JSON.stringify(expectedAreas) ||
      JSON.stringify(plan.groups) !== JSON.stringify(expectedGroups) ||
      JSON.stringify(plan.platforms) !== JSON.stringify(expectedPlatforms)
    )
      throw new Error("routed validation plan does not match its path inventory");
    if (
      plan.paths.some((entry) => entry.qualificationRequired) ||
      (plan.mode === "prose" &&
        plan.changed_files.some((file) => !proseOnlyAllowlist.includes(file)))
    )
      throw new Error("routed validation mode does not match its path authority");
  }
  return plan;
}

export function validateQualificationBinding({ plan, digest, checkout }) {
  validateValidationPlan(plan);
  if (plan.mode !== "qualification" || !plan.qualification_required)
    throw new Error("reusable result is not a qualification plan");
  if (plan.digest !== digest) throw new Error("reusable qualification digest mismatch");
  if (plan.identities?.checkout !== checkout || !/^[a-f0-9]{40}$/u.test(checkout ?? ""))
    throw new Error("reusable qualification checkout mismatch");
  if (JSON.stringify([...plan.groups].sort()) !== JSON.stringify([...fastGroups].sort()))
    throw new Error("reusable qualification omitted a protected group");
  if (
    JSON.stringify([...plan.platforms].sort()) !==
    JSON.stringify([...qualificationPlatforms].sort())
  )
    throw new Error("reusable qualification omitted a platform");
  return plan;
}

function main() {
  let plan;
  try {
    plan = JSON.parse(process.env.PORTCOVE_PLAN_JSON ?? "");
  } catch {
    throw new Error("PORTCOVE_PLAN_JSON must contain the reusable qualification plan");
  }
  validateQualificationBinding({
    plan,
    digest: process.env.PORTCOVE_PLAN_DIGEST,
    checkout: process.env.PORTCOVE_EXPECTED_CHECKOUT,
  });
  console.log(`Reusable qualification ${plan.digest} is bound to ${plan.identities.checkout}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
