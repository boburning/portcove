import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const renovateLogins = new Set(["renovate[bot]", "app/renovate"]);
const requiredPolicy = Object.freeze({
  automerge: false,
  internalChecksFilter: "strict",
  minimumReleaseAge: "3 days",
  minimumReleaseAgeBehaviour: "timestamp-required",
});
const cargoPolicyPaths = [
  /^Cargo\.lock$/u,
  /(?:^|\/)Cargo\.toml$/u,
  /^deny\.toml$/u,
  /^rust-toolchain\.toml$/u,
];
const npmPolicyPaths = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /^apps\/desktop\/package\.json$/u,
  /^\.node-version$/u,
];
const sharedPolicyPaths = [
  /^renovate\.json$/u,
  /^\.github\/(?:actions|workflows)\//u,
  /^\.github\/(?:qualification-coverage|repository-ruleset)\.json$/u,
  /^scripts\/(?:ci-result-gate|select-ci-plan|validation-plan)\.mjs$/u,
  /^scripts\/(?:pr-delivery|renovate-fast-lane)\.mjs$/u,
];

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate identity: ${value}`);
    seen.add(value);
  }
  return [...seen];
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function markdownLabel(value) {
  return /^\[([^\]]+)\]\([^)]+\)$/u.exec(value)?.[1] ?? value;
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function versionChangeMatches(updateType, current, next) {
  if (current.major !== next.major) return false;
  if (updateType === "patch") return current.minor === next.minor && next.patch > current.patch;
  return updateType === "minor" && next.minor > current.minor;
}

export function parseRenovateUpdates(body) {
  const lines = String(body ?? "").split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => /^\|\s*Package\s*\|/iu.test(line));
  if (headerIndex < 0 || !lines[headerIndex + 1]?.match(/^\|(?:\s*:?-+:?\s*\|)+$/u)) return [];
  const headers = tableCells(lines[headerIndex]).map((cell) => cell.toLowerCase());
  const packageIndex = headers.indexOf("package");
  const updateIndex = headers.indexOf("update");
  const changeIndex = headers.indexOf("change");
  const typeIndex = headers.indexOf("type");
  if ([packageIndex, updateIndex, changeIndex].some((index) => index < 0)) return [];
  const updates = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = tableCells(line);
    const change = /`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/u.exec(cells[changeIndex] ?? "");
    if (!change) return [];
    updates.push({
      packageName: markdownLabel(cells[packageIndex] ?? ""),
      dependencyType: typeIndex < 0 ? null : cells[typeIndex],
      updateType: cells[updateIndex]?.toLowerCase() ?? "",
      currentVersion: change[1],
      newVersion: change[2],
    });
  }
  return updates;
}

function packagePatternMatches(pattern, packageName) {
  if (typeof pattern !== "string" || !pattern) return true;
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const end = pattern.lastIndexOf("/");
    try {
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(packageName);
    } catch {
      return true;
    }
  }
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`, "iu").test(packageName);
  }
  return pattern.toLowerCase() === packageName.toLowerCase();
}

function groupedPackage(config, packageName) {
  return (config.packageRules ?? [])
    .filter((rule) => typeof rule.groupName === "string" && rule.groupName)
    .some((rule) =>
      (rule.matchPackageNames ?? []).some((pattern) => packagePatternMatches(pattern, packageName)),
    );
}

export function fastLanePolicyErrors(config) {
  return Object.entries(requiredPolicy)
    .filter(([key, expected]) => config?.[key] !== expected)
    .map(([key, expected]) => `${key} must remain ${JSON.stringify(expected)}`);
}

function renovateIdentity(value) {
  return renovateLogins.has(String(value ?? "").toLowerCase());
}

function changedFileKind(files) {
  const paths = unique(
    files.map((file) => file.filename),
    "pull request files",
  );
  const cargoManifests = paths.filter((file) => /(?:^|\/)Cargo\.toml$/u.test(file));
  if (
    paths.length === 2 &&
    paths.includes("Cargo.lock") &&
    cargoManifests.length === 1 &&
    paths.every((file) => file === "Cargo.lock" || /(?:^|\/)Cargo\.toml$/u.test(file))
  ) {
    return { manager: "cargo", paths };
  }
  const npmPaths = ["apps/desktop/package.json", "pnpm-lock.yaml"];
  if (paths.length === npmPaths.length && npmPaths.every((file) => paths.includes(file)))
    return { manager: "npm", paths };
  return { manager: null, paths };
}

function targetPathRisk(manager, pullPaths, targetPaths, targetDependencyPaths = []) {
  const pullSet = new Set(pullPaths);
  const directOverlap = targetPaths.filter((file) => pullSet.has(file));
  const ecosystemPatterns = manager === "cargo" ? cargoPolicyPaths : npmPolicyPaths;
  const policyOverlap = targetPaths.filter((file) =>
    [...ecosystemPatterns, ...sharedPolicyPaths].some((pattern) => pattern.test(file)),
  );
  return [...new Set([...directOverlap, ...policyOverlap, ...targetDependencyPaths])];
}

function verdict(verdictName, reason, evidence = {}) {
  return { verdict: verdictName, reason, evidence };
}

export function classifyRenovateSnapshot({
  pull,
  commits,
  files,
  contexts,
  statuses,
  config,
  expectedHead,
  baseEvidence,
}) {
  const policyErrors = fastLanePolicyErrors(config);
  if (policyErrors.length)
    return verdict("manual-review-required", "fast-lane policy invariants changed", {
      policy_errors: policyErrors,
    });
  if (pull.head?.sha !== expectedHead)
    return verdict("reject", `pull request head changed to ${pull.head?.sha ?? "unknown"}`, {
      expected_head: expectedHead,
      observed_head: pull.head?.sha ?? null,
    });
  if (pull.state !== "open" || pull.merged === true)
    return verdict("reject", "pull request is no longer an open candidate");
  if (pull.base?.ref !== "main")
    return verdict(
      "reject",
      `pull request targets ${pull.base?.ref ?? "an unknown branch"}, not main`,
    );
  if (!renovateIdentity(pull.user?.login))
    return verdict("reject", "pull request is not authored by Renovate");
  if (!commits.length || commits.some((commit) => !renovateIdentity(commit.author?.login)))
    return verdict("manual-review-required", "pull request contains a non-Renovate commit");
  if (files.some((file) => file.status !== "modified"))
    return verdict("manual-review-required", "fast-lane files must be existing modified files");

  const updates = parseRenovateUpdates(pull.body);
  if (updates.length !== 1)
    return verdict(
      "manual-review-required",
      updates.length
        ? "grouped dependency updates stay outside the fast lane"
        : "Renovate update metadata is missing or malformed",
    );
  const [update] = updates;
  if (!new Set(["patch", "minor"]).has(update.updateType))
    return verdict(
      "manual-review-required",
      `${update.updateType || "unknown"} updates stay outside the fast lane`,
    );
  const currentVersion = parseVersion(update.currentVersion);
  const newVersion = parseVersion(update.newVersion);
  if (!currentVersion || !newVersion || currentVersion.major < 1)
    return verdict(
      "manual-review-required",
      "pre-1.0 or non-semver updates stay outside the fast lane",
    );
  if (!versionChangeMatches(update.updateType, currentVersion, newVersion))
    return verdict(
      "manual-review-required",
      "Renovate update metadata does not describe one forward patch or minor change",
    );
  if (groupedPackage(config, update.packageName))
    return verdict(
      "manual-review-required",
      `${update.packageName} belongs to a reviewed update group`,
    );
  const firstSection = String(pull.body ?? "").split(/^---$/mu, 1)[0];
  const labels = (pull.labels ?? []).map((label) => String(label.name ?? "").toLowerCase());
  if (
    labels.some((label) => label.includes("security")) ||
    /\[security\]/iu.test(String(pull.title ?? "")) ||
    /(?:^|[/-])security(?:[/-]|$)/iu.test(String(pull.head?.ref ?? "")) ||
    /\b(?:security update|vulnerability alert)\b/iu.test(firstSection)
  ) {
    return verdict("manual-review-required", "security-driven updates stay outside the fast lane");
  }

  const fileKind = changedFileKind(files);
  if (!fileKind.manager)
    return verdict(
      "manual-review-required",
      "changed files are not one expected Cargo or npm manifest/lock pair",
      {
        paths: fileKind.paths,
      },
    );
  if (
    fileKind.manager === "npm" &&
    update.dependencyType !== null &&
    !new Set(["dependencies", "devDependencies"]).has(update.dependencyType)
  ) {
    return verdict(
      "manual-review-required",
      `${update.dependencyType} is not an eligible npm dependency type`,
    );
  }

  if (pull.draft) return verdict("waiting", "pull request is still a draft");
  if (pull.mergeable === null) return verdict("waiting", "GitHub has not determined mergeability");
  if (pull.mergeable !== true)
    return verdict("manual-review-required", "pull request is not conflict-free against main");

  const riskyTargetPaths = targetPathRisk(
    fileKind.manager,
    fileKind.paths,
    baseEvidence.targetPaths,
    baseEvidence.targetDependencyPaths,
  );
  if (riskyTargetPaths.length)
    return verdict("manual-review-required", "current main has relevant intervening changes", {
      target_paths: riskyTargetPaths,
    });

  const failedContexts = contexts.filter((context) => context.outcome === "failure");
  if (failedContexts.length)
    return verdict("manual-review-required", "one or more required checks failed", {
      checks: failedContexts.map(({ context, conclusion }) => ({ context, conclusion })),
    });
  const pendingContexts = contexts.filter((context) => context.outcome !== "success");
  if (pendingContexts.length)
    return verdict("waiting", "required exact-head checks are still pending", {
      checks: pendingContexts.map(({ context, conclusion }) => ({ context, conclusion })),
    });
  const stability = statuses.filter((status) => status.context === "renovate/stability-days");
  if (stability.length !== 1)
    return verdict("manual-review-required", "release-age status is missing or ambiguous");
  if (stability[0].state === "pending")
    return verdict("waiting", "minimum release age is still pending", {
      release_age: { state: stability[0].state, description: stability[0].description ?? null },
    });
  if (stability[0].state !== "success")
    return verdict("manual-review-required", `minimum release age reported ${stability[0].state}`);

  return verdict("metadata-required", "remote fast-lane gates are ready", {
    manager: fileKind.manager,
    package: update.packageName,
    update_type: update.updateType,
    current_version: update.currentVersion,
    new_version: update.newVersion,
    paths: fileKind.paths,
    original_base: pull.base.sha,
    current_target: baseEvidence.currentTarget,
    current_merge_base: baseEvidence.currentMergeBase,
    release_age: {
      state: stability[0].state,
      description: stability[0].description ?? null,
    },
  });
}

export function metadataPlan(manager) {
  if (manager === "cargo")
    return [
      {
        id: "cargo-metadata",
        executable: "cargo",
        args: ["metadata", "--locked", "--format-version", "1", "--no-deps"],
      },
      {
        id: "dependency-policy",
        executable: "cargo",
        args: ["deny", "check", "--hide-inclusion-graph", "-W", "unmaintained"],
      },
    ];
  if (manager === "npm")
    return [
      {
        id: "pnpm-lockfile",
        executable: "corepack",
        args: [
          "pnpm",
          "--dir",
          "apps/desktop",
          "install",
          "--lockfile-only",
          "--frozen-lockfile",
          "--ignore-scripts",
        ],
      },
    ];
  throw new Error(`unsupported fast-lane manager: ${manager}`);
}

function runCommand(command, cwd) {
  const started = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000);
    throw new Error(
      `${command.id} failed with exit code ${result.status}${output ? `: ${output}` : ""}`,
    );
  }
  return {
    id: command.id,
    elapsed_seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    stdout: String(result.stdout ?? ""),
  };
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

function parseZeroPaths(buffer) {
  return unique(buffer.toString("utf8").split("\0").filter(Boolean), "Git changed paths");
}

function gitRegex(value) {
  return value.replace(/[\\.^$*+?()[\]{}|]/gu, "\\$&");
}

export function inspectCurrentBase({
  projectRoot,
  number,
  expectedHead,
  currentTarget,
  interactionTerms = [],
}) {
  git(projectRoot, ["fetch", "--no-tags", "origin", `pull/${number}/head`]);
  const fetchHead = git(projectRoot, ["rev-parse", "FETCH_HEAD"]).trim();
  if (fetchHead !== expectedHead)
    return {
      changedHead: fetchHead,
      currentTarget,
      currentMergeBase: null,
      targetPaths: [],
      targetDependencyPaths: [],
    };
  try {
    git(projectRoot, ["cat-file", "-e", `${currentTarget}^{commit}`]);
  } catch {
    git(projectRoot, ["fetch", "--no-tags", "origin", currentTarget]);
  }
  const currentMergeBase = git(projectRoot, ["merge-base", expectedHead, currentTarget]).trim();
  const targetPaths = parseZeroPaths(
    git(projectRoot, ["diff", "--name-only", "-z", currentMergeBase, currentTarget], {
      encoding: "buffer",
    }),
  );
  const terms = [...new Set(interactionTerms.filter(Boolean))];
  const targetDependencyPaths = terms.length
    ? parseZeroPaths(
        git(
          projectRoot,
          [
            "diff",
            "--name-only",
            "-z",
            `-G(${terms.map(gitRegex).join("|")})`,
            currentMergeBase,
            currentTarget,
          ],
          { encoding: "buffer" },
        ),
      )
    : [];
  return {
    changedHead: null,
    currentTarget,
    currentMergeBase,
    targetPaths,
    targetDependencyPaths,
  };
}

export function validateCargoAuthority(metadataOutput, packageName) {
  let metadata;
  try {
    metadata = JSON.parse(metadataOutput);
  } catch {
    throw new Error("cargo metadata did not return valid JSON");
  }
  const matches = (metadata.packages ?? []).flatMap((pkg) =>
    (pkg.dependencies ?? []).filter((dependency) => dependency.name === packageName),
  );
  if (!matches.length) throw new Error(`cargo metadata did not find dependency ${packageName}`);
  if (matches.some((dependency) => !String(dependency.source ?? "").startsWith("registry+")))
    throw new Error(`${packageName} is not exclusively registry-backed`);
}

export function validateNpmAuthority(manifest, packageName) {
  const values = [
    manifest.dependencies?.[packageName],
    manifest.devDependencies?.[packageName],
  ].filter((value) => typeof value === "string");
  if (values.length !== 1 || !/^(?:[~^=])?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/u.test(values[0]))
    throw new Error(`${packageName} is not one ordinary registry-backed npm dependency`);
}

function exactVersion(value) {
  const match = /^(?:[~^=])?(\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?)$/u.exec(value.trim());
  return match?.[1] ?? null;
}

function cargoManifestVersion(manifest, packageName) {
  const escaped = gitRegex(packageName);
  const pattern = new RegExp(
    `^\\s*(?:"${escaped}"|${escaped})\\s*=\\s*(?:"([^"]+)"|\\{[^}\\r\\n]*\\bversion\\s*=\\s*"([^"]+)")`,
    "gmu",
  );
  const matches = [...manifest.matchAll(pattern)].map((match) =>
    exactVersion(match[1] ?? match[2]),
  );
  if (matches.length !== 1 || !matches[0])
    throw new Error(`${packageName} does not have one supported Cargo manifest version`);
  return matches[0];
}

function cargoLockVersions(lockfile, packageName) {
  const versions = new Set();
  for (const block of lockfile.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"\s*$/mu.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"\s*$/mu.exec(block)?.[1];
    if (name === packageName && version) versions.add(version);
  }
  return versions;
}

function npmManifestVersion(manifestText, packageName) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("npm manifest is not valid JSON");
  }
  const values = [
    manifest.dependencies?.[packageName],
    manifest.devDependencies?.[packageName],
  ].filter((value) => typeof value === "string");
  if (values.length !== 1 || !exactVersion(values[0]))
    throw new Error(`${packageName} does not have one supported npm manifest version`);
  return exactVersion(values[0]);
}

function manifestWithoutClaimedVersion(manager, manifest, packageName) {
  if (manager === "npm") {
    let document;
    try {
      document = JSON.parse(manifest);
    } catch {
      throw new Error("npm manifest is not valid JSON");
    }
    const owners = ["dependencies", "devDependencies"].filter(
      (section) => typeof document[section]?.[packageName] === "string",
    );
    if (owners.length !== 1)
      throw new Error(`${packageName} does not have one replaceable manifest declaration`);
    document[owners[0]][packageName] = "<PORTCOVE_RENOVATE_VERSION>";
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalize(nested)]),
        );
      return value;
    };
    return JSON.stringify(normalize(document));
  }
  const escaped = gitRegex(packageName);
  const pattern = new RegExp(
    `^\\s*(?:"${escaped}"|${escaped})\\s*=\\s*(?:"([^"]+)"|\\{[^}\\r\\n]*\\bversion\\s*=\\s*"([^"]+)")`,
    "gmu",
  );
  const matches = [...manifest.matchAll(pattern)];
  if (matches.length !== 1)
    throw new Error(`${packageName} does not have one replaceable manifest declaration`);
  const match = matches[0];
  const version = match[1] ?? match[2];
  const offset = match[0].lastIndexOf(version);
  if (offset < 0) throw new Error(`${packageName} manifest version could not be isolated`);
  const start = match.index + offset;
  return `${manifest.slice(0, start)}<PORTCOVE_RENOVATE_VERSION>${manifest.slice(start + version.length)}`;
}

function pnpmLockVersions(lockfile, packageName) {
  const escaped = gitRegex(packageName);
  const pattern = new RegExp(`^  ['"]?${escaped}@([^:'"()\\s]+)`, "gmu");
  return new Set([...lockfile.matchAll(pattern)].map((match) => match[1]));
}

function assertVersionTransition({
  manager,
  packageName,
  currentVersion,
  newVersion,
  baseManifest,
  headManifest,
  baseLock,
  headLock,
}) {
  const manifestVersion = manager === "cargo" ? cargoManifestVersion : npmManifestVersion;
  const lockVersions = manager === "cargo" ? cargoLockVersions : pnpmLockVersions;
  const observedBase = manifestVersion(baseManifest, packageName);
  const observedHead = manifestVersion(headManifest, packageName);
  if (observedBase !== currentVersion || observedHead !== newVersion)
    throw new Error(
      `${packageName} manifest delta is ${observedBase} -> ${observedHead}, not ${currentVersion} -> ${newVersion}`,
    );
  if (
    manifestWithoutClaimedVersion(manager, baseManifest, packageName) !==
    manifestWithoutClaimedVersion(manager, headManifest, packageName)
  ) {
    throw new Error(`${packageName} is not the only manifest change`);
  }
  const before = lockVersions(baseLock, packageName);
  const after = lockVersions(headLock, packageName);
  const removed = [...before].filter((version) => !after.has(version));
  const added = [...after].filter((version) => !before.has(version));
  if (
    removed.length !== 1 ||
    removed[0] !== currentVersion ||
    added.length !== 1 ||
    added[0] !== newVersion
  ) {
    throw new Error(
      `${packageName} lock delta does not exclusively replace ${currentVersion} with ${newVersion}`,
    );
  }
}

export function validateDependencyDelta({
  manager,
  packageName,
  currentVersion,
  newVersion,
  baseManifest,
  headManifest,
  baseLock,
  headLock,
}) {
  if (!new Set(["cargo", "npm"]).has(manager))
    throw new Error(`unsupported fast-lane manager: ${manager}`);
  assertVersionTransition({
    manager,
    packageName,
    currentVersion,
    newVersion,
    baseManifest,
    headManifest,
    baseLock,
    headLock,
  });
}

async function validateNpmCheckoutAuthority(checkout, packageName) {
  const manifest = JSON.parse(
    await readFile(path.join(checkout, "apps", "desktop", "package.json"), "utf8"),
  );
  validateNpmAuthority(manifest, packageName);
}

export async function runMetadataValidation({
  projectRoot,
  base,
  head,
  manager,
  packageName,
  currentVersion,
  newVersion,
  paths,
  commandRunner = runCommand,
}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-renovate-check-"));
  const checkout = path.join(temporaryRoot, "checkout");
  let registered = false;
  try {
    const manifestPath = paths.find(
      (file) => file.endsWith("package.json") || file.endsWith("Cargo.toml"),
    );
    const lockPath = manager === "cargo" ? "Cargo.lock" : "pnpm-lock.yaml";
    if (!manifestPath || !paths.includes(lockPath))
      throw new Error("dependency delta paths do not match the selected manager");
    validateDependencyDelta({
      manager,
      packageName,
      currentVersion,
      newVersion,
      baseManifest: git(projectRoot, ["show", `${base}:${manifestPath}`]),
      headManifest: git(projectRoot, ["show", `${head}:${manifestPath}`]),
      baseLock: git(projectRoot, ["show", `${base}:${lockPath}`]),
      headLock: git(projectRoot, ["show", `${head}:${lockPath}`]),
    });
    git(projectRoot, ["worktree", "add", "--detach", checkout, head]);
    registered = true;
    const before = git(checkout, ["status", "--porcelain", "--untracked-files=no"]);
    if (before.trim()) throw new Error("temporary exact-head checkout is not clean");
    const results = [];
    for (const command of metadataPlan(manager)) results.push(commandRunner(command, checkout));
    if (manager === "cargo")
      validateCargoAuthority(
        results.find((result) => result.id === "cargo-metadata")?.stdout,
        packageName,
      );
    else await validateNpmCheckoutAuthority(checkout, packageName);
    const after = git(checkout, ["status", "--porcelain", "--untracked-files=no"]);
    if (after.trim()) throw new Error("metadata validation modified tracked files");
    return results.map(({ id, elapsed_seconds }) => ({ id, elapsed_seconds }));
  } finally {
    let safeToDelete = !registered;
    if (registered) {
      try {
        git(projectRoot, ["worktree", "remove", "--force", checkout]);
        safeToDelete = true;
      } catch {
        // Keep the exact temporary path for Git's own diagnostic instead of deleting it behind Git.
      }
    }
    const resolvedRoot = path.resolve(temporaryRoot);
    const resolvedTemp = path.resolve(os.tmpdir());
    if (safeToDelete && resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`))
      await rm(resolvedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function fastLaneSummary(result) {
  return `${result.verdict}: ${result.reason}`;
}
