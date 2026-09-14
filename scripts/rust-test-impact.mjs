import { readFileSync } from "node:fs";
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
