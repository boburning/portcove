import { createHash } from "node:crypto";

export const validationPlanVersion = 2;

export const fastGroups = Object.freeze([
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
]);

export const validationAreas = Object.freeze([
  "documentation",
  "frontend",
  "rust",
  "native-ipc",
  "catalog",
  "dependency",
  "platform",
  "release-security",
  "policy",
]);

export const proseOnlyAllowlist = Object.freeze([
  "docs/GUI-COMPETITIVE-REVIEW.md",
  "docs/README.md",
]);

const platformNames = Object.freeze([
  "linux-x86_64",
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
]);

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
    ["rust-quality"],
    "documentation-contract",
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
      /(?:transport|schema|ipc)/iu.test(file) ||
      file.startsWith("integrations/"),
    "native-ipc",
    ["frontend", "rust", "rust-quality"],
    "native-or-ipc-boundary",
    platformNames,
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
    /(?:^|\/)(?:Cargo\.lock|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|dependabot\.yml|renovate\.json|aqua\.yaml|aqua-checksums\.json|quality-tools\.json|tool-bootstrap\.json)$/u.test(
      file,
    ) || file === ".node-version",
    "dependency",
    fastGroups,
    "dependency-or-toolchain-input",
    platformNames,
  );
  match(
    /(?:windows|linux|macos|appimage|dmg|msi|steam-deck|platform)/iu.test(file),
    "platform",
    ["rust", "rust-quality"],
    "platform-specific-input",
    platformNames,
  );
  match(
    file.startsWith("release/") ||
      /(?:release|updater|package|installer|qualification|checksum|channel|provenance|attest|sbom|security)/iu.test(
        file,
      ),
    "release-security",
    fastGroups,
    "release-or-security-boundary",
    platformNames,
  );
  match(
    file.startsWith(".github/workflows/") ||
      file.startsWith(".github/actions/") ||
      file === ".github/repository-ruleset.json" ||
      file === ".github/repository-security.json" ||
      file === ".github/roadmap.json" ||
      file === "justfile" ||
      file === "AGENTS.md",
    "policy",
    fastGroups,
    "protected-policy-or-automation",
    platformNames,
  );

  if (
    [...areas].some((area) =>
      ["native-ipc", "catalog", "dependency", "platform", "release-security", "policy"].includes(
        area,
      ),
    )
  ) {
    qualificationRequired = true;
  }

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
  const groups = unknown.length
    ? fastGroups
    : [...new Set(paths.flatMap((entry) => entry.groups))].sort();
  const platforms = unknown.length
    ? ["primary-host"]
    : [...new Set(paths.flatMap((entry) => entry.platforms))].sort();
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
  if (plan?.format_version !== validationPlanVersion) throw new Error("unsupported plan version");
  if (!/^[a-f0-9]{64}$/u.test(plan.digest ?? "") || digestValidationPlan(plan) !== plan.digest)
    throw new Error("validation plan digest mismatch");
  if (!["blocked", "fast", "prose", "qualification"].includes(plan.mode))
    throw new Error("invalid validation plan mode");
  for (const group of plan.groups ?? [])
    if (!fastGroups.includes(group)) throw new Error(`unknown validation group: ${group}`);
  if (new Set(plan.groups ?? []).size !== (plan.groups ?? []).length)
    throw new Error("duplicate validation group");
  if (plan.mode === "blocked" && (plan.groups.length || plan.qualification_required))
    throw new Error("blocked plans cannot authorize work");
  if (plan.mode === "qualification" && !plan.qualification_required)
    throw new Error("qualification mode must require qualification");
  if (plan.mode !== "qualification" && plan.qualification_required)
    throw new Error("only qualification mode may require qualification");
  return plan;
}
