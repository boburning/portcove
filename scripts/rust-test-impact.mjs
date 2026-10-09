import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationPlan } from "./validation-plan.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const rustTestImpactPath = path.join(projectRoot, ".config", "rust-test-impact.json");

function normalizePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe Rust test-impact path: ${value}`);
  return normalized;
}

export function validateRustTestImpactMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Rust test-impact map must be an object");
  if (value.schema_version !== 1) throw new Error("unsupported Rust test-impact schema version");
  if (!value.packages || typeof value.packages !== "object" || Array.isArray(value.packages))
    throw new Error("Rust test-impact map packages must be an object");

  for (const [packageName, config] of Object.entries(value.packages)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName))
      throw new Error(`invalid Rust test-impact package name: ${packageName}`);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error(`Rust test-impact package ${packageName} must be an object`);
    const prefix = normalizePath(config.path_prefix);
    if (!prefix.endsWith("/"))
      throw new Error(`Rust test-impact package ${packageName} path_prefix must end in /`);
    if (typeof config.broad_reason !== "string" || !config.broad_reason.trim())
      throw new Error(`Rust test-impact package ${packageName} broad_reason is missing`);
    if (!Array.isArray(config.groups) || config.groups.length === 0)
      throw new Error(`Rust test-impact package ${packageName} groups are missing`);

    const groupIds = new Set();
    const ownedPaths = new Set();
    for (const group of config.groups) {
      if (!group || typeof group !== "object" || Array.isArray(group))
        throw new Error(`Rust test-impact package ${packageName} has an invalid group`);
      if (typeof group.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id))
        throw new Error(`Rust test-impact package ${packageName} has an invalid group id`);
      if (groupIds.has(group.id))
        throw new Error(`duplicate Rust test-impact group: ${packageName}:${group.id}`);
      groupIds.add(group.id);
      if (typeof group.reason !== "string" || !group.reason.trim())
        throw new Error(`Rust test-impact group ${packageName}:${group.id} reason is missing`);
      if (typeof group.filter !== "string" || !group.filter.trim() || /[\r\n\0]/.test(group.filter))
        throw new Error(`Rust test-impact group ${packageName}:${group.id} filter is invalid`);
      if (!Array.isArray(group.paths) || group.paths.length === 0)
        throw new Error(`Rust test-impact group ${packageName}:${group.id} paths are missing`);
      for (const input of group.paths) {
        const file = normalizePath(input);
        if (!file.startsWith(prefix))
          throw new Error(`Rust test-impact path ${file} is outside ${packageName}`);
        if (ownedPaths.has(file)) throw new Error(`duplicate Rust test-impact path: ${file}`);
        ownedPaths.add(file);
      }
    }
  }
  return value;
}

export function readRustTestImpactMap(file = rustTestImpactPath) {
  return validateRustTestImpactMap(JSON.parse(readFileSync(file, "utf8")));
}

function broad(config, reasons) {
  return {
    mode: "broad",
    reason: `${config.broad_reason}; ${[...new Set(reasons)].join("; ")}`,
    groups: [],
  };
}

export function selectRustTestImpact(map, packageName, changes) {
  if (!map || typeof map !== "object" || !map.packages || typeof map.packages !== "object")
    return {
      mode: "broad",
      reason: `Rust test-impact contract is unavailable; run the complete ${packageName} test inventory`,
      groups: [],
    };
  const config = map.packages[packageName];
  if (!config)
    return {
      mode: "broad",
      reason: `package ${packageName} has no focused Rust test-impact contract`,
      groups: [],
    };

  const groupsByPath = new Map();
  for (const group of config.groups)
    for (const file of group.paths) groupsByPath.set(normalizePath(file), group);

  const selected = new Map();
  const broadReasons = [];
  for (const change of changes) {
    const file = normalizePath(change.path);
    const status = String(change.status ?? "");
    const group = groupsByPath.get(file);
    if (change.previousPath || !["A", "M"].includes(status)) {
      broadReasons.push(
        `${status || "unknown"} change ${file} is not an added or modified mapped file`,
      );
      continue;
    }
    if (!group) {
      broadReasons.push(`${file} is outside the explicit focused map`);
      continue;
    }
    selected.set(group.id, group);
  }

  if (broadReasons.length) return broad(config, broadReasons);
  if (selected.size === 0) return broad(config, ["no complete mapped Rust change was discovered"]);
  return {
    mode: "focused",
    reason: "every added or modified Rust path has explicit test-impact ownership",
    groups: [...selected.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function runnableImpactTests(inventory, packageName) {
  if (
    !inventory ||
    !Number.isSafeInteger(inventory["test-count"]) ||
    inventory["test-count"] < 0 ||
    !inventory["rust-suites"] ||
    typeof inventory["rust-suites"] !== "object" ||
    Array.isArray(inventory["rust-suites"])
  )
    throw new Error("Incomplete nextest impact inventory");
  const matched = new Set();
  let total = 0;
  for (const [binaryId, suite] of Object.entries(inventory["rust-suites"])) {
    if (
      suite?.["package-name"] !== packageName ||
      suite["binary-id"] !== binaryId ||
      suite.status !== "listed" ||
      !suite.testcases ||
      typeof suite.testcases !== "object" ||
      Array.isArray(suite.testcases)
    )
      throw new Error("Unexpected nextest impact suite identity or coverage");
    for (const [name, detail] of Object.entries(suite.testcases)) {
      total++;
      const status = detail?.["filter-match"]?.status;
      if (
        !name ||
        typeof detail?.ignored !== "boolean" ||
        !["matches", "mismatch"].includes(status)
      )
        throw new Error("Invalid nextest impact test record");
      if (status === "matches" && !detail.ignored) matched.add(JSON.stringify([binaryId, name]));
    }
  }
  if (total !== inventory["test-count"]) throw new Error("Truncated nextest impact inventory");
  return matched;
}

export function runRustImpactUnion(packageName, groupIds, dependencies = {}) {
  const map = dependencies.map ?? readRustTestImpactMap();
  const config = map.packages[packageName];
  if (!config || groupIds.length < 2 || new Set(groupIds).size !== groupIds.length)
    throw new Error("Impact union requires distinct owned groups in one package");
  const groups = groupIds.map((id) => {
    const group = config.groups.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Unknown Rust impact group: ${packageName}:${id}`);
    return group;
  });
  const run = dependencies.spawnSync ?? spawnSync;
  const report = dependencies.report ?? console.log;
  const inventory = (filter) => {
    const result = run(
      "cargo-nextest",
      ["nextest", "list", "--locked", "-p", packageName, "-E", filter, "--message-format", "json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Nextest impact inventory failed: ${result.stderr}`);
    return runnableImpactTests(JSON.parse(result.stdout), packageName);
  };
  const expected = new Set();
  for (const group of groups) {
    const matches = inventory(group.filter);
    if (!matches.size) throw new Error(`Rust impact group ${group.id} has no runnable tests`);
    for (const identity of matches) expected.add(identity);
    report(`[rust-impact] ${group.id}: ${matches.size} runnable tests; ${group.reason}`);
  }
  const filter = groups.map((group) => `(${group.filter})`).join(" | ");
  const union = inventory(filter);
  if (union.size !== expected.size || [...expected].some((identity) => !union.has(identity)))
    throw new Error("Nextest impact union differs from the complete selected group inventories");
  report(`[rust-impact] union: ${union.size} distinct runnable tests`);
  const result = run(
    "cargo-nextest",
    ["nextest", "run", "--locked", "-p", packageName, "-E", filter],
    { cwd: projectRoot, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export const rustPackagePrefixes = new Map([
  ["crates/portcove-core/", "portcove-core"],
  ["crates/portcove-cli/", "portcove-cli"],
  ["crates/portcove-release-tools/", "portcove-release-tools"],
  ["apps/desktop/src-tauri/", "portcove-desktop"],
]);

export function selectWorkspaceRustImpact(plan, map = readRustTestImpactMap()) {
  validateValidationPlan(plan);
  if (plan.mode === "blocked" || !plan.groups.includes("rust"))
    throw new Error("The plan does not authorize Rust execution");
  const shared =
    plan.fallback ||
    !plan.changes.length ||
    plan.changed_files.some(
      (file) =>
        [
          "Cargo.toml",
          "Cargo.lock",
          "rust-toolchain.toml",
          "deny.toml",
          ".config/nextest.toml",
          ".config/rust-test-impact.json",
        ].includes(file) ||
        (plan.paths.find((entry) => entry.path === file)?.areas.includes("dependency") &&
          ![...rustPackagePrefixes.keys()].some((prefix) => file.startsWith(prefix))),
    );
  if (shared)
    return [
      {
        id: "workspace",
        filter: "all()",
        reason: "shared or unknown inputs require the complete workspace",
      },
    ];
  const changesByPackage = new Map();
  for (const change of plan.changes) {
    for (const [prefix, packageName] of rustPackagePrefixes) {
      if (![change.oldPath, change.newPath].some((file) => file.startsWith(prefix))) continue;
      const changes = changesByPackage.get(packageName) ?? [];
      changes.push({
        status: change.status,
        path: change.newPath.startsWith(prefix) ? change.newPath : change.oldPath,
        ...(change.oldPath !== change.newPath ? { previousPath: change.oldPath } : {}),
      });
      changesByPackage.set(packageName, changes);
    }
  }
  // No package may become an empty successful Rust lane (including newly added crates).
  if (
    !changesByPackage.size ||
    plan.changed_files.some(
      (file) =>
        (file.startsWith("crates/") || file.startsWith("apps/desktop/src-tauri/")) &&
        ![...rustPackagePrefixes.keys()].some((prefix) => file.startsWith(prefix)),
    )
  )
    return [{ id: "workspace", filter: "all()", reason: "Rust package ownership is uncertain" }];
  const selected = [];
  for (const [packageName, changes] of [...changesByPackage].sort()) {
    const impact = selectRustTestImpact(map, packageName, changes);
    if (impact.mode === "broad")
      selected.push({
        id: packageName,
        packageName,
        filter: `package(=${packageName})`,
        reason: impact.reason,
      });
    else
      for (const group of impact.groups)
        selected.push({
          id: `${packageName}:${group.id}`,
          packageName,
          filter: `package(=${packageName}) & (${group.filter})`,
          reason: group.reason,
        });
  }
  // Preserve the explicitly maintained public artwork consumer, rather than inventing a dependency graph.
  if (
    plan.changed_files.some((file) =>
      [
        "crates/portcove-core/src/artwork.rs",
        "crates/portcove-core/catalog/catalog.json",
        "crates/portcove-core/catalog/catalog-current-authoring.json",
      ].includes(file),
    ) &&
    !selected.some((group) => group.packageName === "portcove-cli")
  ) {
    const group = map?.packages?.["portcove-cli"]?.groups.find(
      (entry) => entry.id === "artwork-fixtures",
    );
    const certain =
      group &&
      plan.changes.every(
        (change) => change.oldPath === change.newPath && ["A", "M"].includes(change.status),
      );
    selected.push({
      id: "portcove-cli:artwork-consumer",
      packageName: "portcove-cli",
      filter: certain ? `package(=portcove-cli) & (${group.filter})` : "package(=portcove-cli)",
      reason: "public CLI artwork consumer",
    });
  }
  return selected;
}

export function runnableWorkspaceImpactTests(inventory, { allowSkipped = false } = {}) {
  if (
    !Number.isSafeInteger(inventory?.["test-count"]) ||
    inventory["test-count"] < 0 ||
    !inventory["rust-suites"] ||
    typeof inventory["rust-suites"] !== "object" ||
    Array.isArray(inventory["rust-suites"])
  )
    throw new Error("Incomplete nextest workspace inventory");
  let total = 0;
  const matched = new Set();
  for (const [binaryId, suite] of Object.entries(inventory["rust-suites"])) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/u.test(suite?.["package-name"] ?? "") ||
      suite["binary-id"] !== binaryId ||
      !["listed", ...(allowSkipped ? ["skipped"] : [])].includes(suite.status) ||
      !suite.testcases ||
      typeof suite.testcases !== "object" ||
      Array.isArray(suite.testcases)
    )
      throw new Error("Unexpected nextest workspace suite identity or coverage");
    if (suite.status === "skipped" && Object.keys(suite.testcases).length)
      throw new Error("Skipped nextest suite contained test records");
    for (const [name, detail] of Object.entries(suite.testcases)) {
      total++;
      const status = detail?.["filter-match"]?.status;
      if (
        !name ||
        typeof detail?.ignored !== "boolean" ||
        !["matches", "mismatch"].includes(status)
      )
        throw new Error("Invalid nextest workspace test record");
      if (status === "matches" && !detail.ignored)
        matched.add(JSON.stringify([suite["package-name"], binaryId, name]));
    }
  }
  if (total !== inventory["test-count"]) throw new Error("Truncated nextest workspace inventory");
  return matched;
}

export function runWorkspaceRustImpact(plan, dependencies = {}) {
  let map;
  try {
    map = dependencies.map ?? readRustTestImpactMap();
  } catch {
    map = null;
  } // A missing focused map never waives package coverage.
  const groups = selectWorkspaceRustImpact(plan, map);
  const run = dependencies.spawnSync ?? spawnSync;
  const report = dependencies.report ?? console.log;
  const scope = ["--locked", "--workspace", "--all-targets"];
  const list = (filter) => {
    const result = run(
      "cargo-nextest",
      ["nextest", "list", ...scope, "-E", filter, "--message-format", "json"],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Nextest workspace inventory failed: ${result.stderr}`);
    return runnableWorkspaceImpactTests(JSON.parse(result.stdout), {
      allowSkipped: filter !== "all()",
    });
  };
  const complete = list("all()");
  if (!complete.size) throw new Error("The complete workspace has no runnable tests");
  const expected = new Set();
  for (const group of groups) {
    const matches = group.filter === "all()" ? complete : list(group.filter);
    if (!matches.size) throw new Error(`Rust impact group ${group.id} has no runnable tests`);
    for (const identity of matches) {
      if (
        !complete.has(identity) ||
        (group.packageName && JSON.parse(identity)[0] !== group.packageName)
      )
        throw new Error("Rust impact group escaped its complete workspace/package inventory");
      expected.add(identity);
    }
    report(`[rust-impact] ${group.id}: ${matches.size} runnable tests; ${group.reason}`);
  }
  const filter = groups.map((group) => `(${group.filter})`).join(" | ");
  const union = groups.length === 1 && groups[0].filter === "all()" ? complete : list(filter);
  if (union.size !== expected.size || [...expected].some((identity) => !union.has(identity)))
    throw new Error("Nextest workspace union differs from the complete selected group inventories");
  report(
    `[rust-impact] union: ${union.size} of ${complete.size} runnable workspace tests; Windows baseline`,
  );
  const result = run("cargo-nextest", ["nextest", "run", ...scope, "-E", filter], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  // This stays inside the caller's heavyweight reservation. Cargo reuses the
  // workspace build; compare live Rust serialization with committed snapshots.
  const contract = run(process.execPath, ["scripts/check-transport-contract.mjs"], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (contract.error) throw contract.error;
  return contract.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--workspace-run") {
      const plan = JSON.parse(
        process.env.PORTCOVE_PLAN_JSON ?? readFileSync(process.argv[3], "utf8"),
      );
      const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim();
      if (checkout !== plan.identities.checkout)
        throw new Error("Rust impact plan checkout mismatch");
      process.exitCode = runWorkspaceRustImpact(plan);
    } else {
      if (process.argv[2] !== "--run")
        throw new Error("Use the guarded Rust runner for impact unions");
      process.exitCode = runRustImpactUnion(process.argv[3], process.argv.slice(4));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
