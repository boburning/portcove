import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    if (change.previousPath || status !== "M") {
      broadReasons.push(`${status || "unknown"} change ${file} is not a modified mapped file`);
      continue;
    }
    const group = groupsByPath.get(file);
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
    reason: "every modified Rust path has explicit test-impact ownership",
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "--run")
      throw new Error("Use the guarded Rust runner for impact unions");
    process.exitCode = runRustImpactUnion(process.argv[3], process.argv.slice(4));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
