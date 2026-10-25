import { errorMessage, isRecord } from "./runtime-values.mts";
import type { SpawnSyncOptions } from "node:child_process";
import type { ValidationPlan, ValidationChangeInput } from "./validation-plan.mts";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateValidationPlan, readValidationPlanInput } from "./validation-plan.mts";
import { createCiMetrics } from "./ci-metrics.mts";
import {
  nextestOutcomeSelection,
  runNextestWithOutcomes,
  runnableNextestTests,
} from "./nextest-outcomes.mts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const rustTestImpactPath = path.join(projectRoot, ".config", "rust-test-impact.json");
export interface RustImpactGroup {
  id: string;
  reason: string;
  filter: string;
  paths: string[];
}
interface RustImpactPackage {
  path_prefix: string;
  broad_reason: string;
  groups: RustImpactGroup[];
}
export interface RustImpactMap {
  schema_version: 1;
  packages: Record<string, RustImpactPackage>;
}
interface RustImpactChange extends Pick<ValidationChangeInput, "status" | "previousPath"> {
  path: string;
}
interface ImpactSelection {
  mode: "broad" | "focused";
  reason: string;
  groups: RustImpactGroup[];
}
export interface WorkspaceImpactGroup {
  id: string;
  filter: string;
  reason: string;
  packageName?: string;
}
type ImpactRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => {
  status?: number | null;
  error?: Error;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};
interface ImpactDependencies {
  map?: RustImpactMap | null;
  spawnSync?: ImpactRunner;
  report?: (message: string) => void;
  metrics?: ReturnType<typeof createCiMetrics>;
  inventoryTempRoot?: string;
}

/** Official metadata is private to one guarded invocation, never a reusable cache. */
function withInventoryMetadata(
  scope: string[],
  run: ImpactRunner,
  metrics: ReturnType<typeof createCiMetrics>,
  maxBuffer: number,
  action: (argumentsForList: () => string[], verify: () => void) => number,
  tempRoot = tmpdir(),
) {
  const directory = mkdtempSync(path.join(tempRoot, "portcove-nextest-inventory-"));
  let failure: { error: unknown } | undefined;
  let status = 1;
  try {
    const snapshots: { file: string; bytes: Buffer }[] = [];
    const capture = (name: string, command: string, args: string[]) => {
      const result = run(command, args, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`Nextest ${name} preparation failed: ${String(result.stderr)}`);
      const bytes = Buffer.from(result.stdout ?? "");
      if (!bytes.length || bytes.length > maxBuffer)
        throw new Error(`Invalid or oversized nextest ${name} metadata`);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(value)) throw new Error(`Invalid nextest ${name} metadata`);
      const file = path.join(directory, `${name}.json`);
      writeFileSync(file, bytes, { flag: "wx" });
      snapshots.push({ file, bytes });
      return { file, value };
    };
    const argumentsForList = metrics.measure("rust-inventory-metadata", () => {
      const binaries = capture("binaries", "cargo-nextest", [
        "nextest",
        "list",
        ...scope,
        "--list-type",
        "binaries-only",
        "--message-format",
        "json",
      ]);
      if (
        !isRecord(binaries.value["rust-build-meta"]) ||
        !isRecord(binaries.value["rust-binaries"]) ||
        !Object.keys(binaries.value["rust-binaries"]).length
      )
        throw new Error("Incomplete nextest binaries metadata");
      for (const [id, binary] of Object.entries(binaries.value["rust-binaries"]))
        if (
          !isRecord(binary) ||
          binary["binary-id"] !== id ||
          typeof binary["binary-path"] !== "string" ||
          !path.isAbsolute(binary["binary-path"])
        )
          throw new Error("Invalid nextest binary metadata identity");
      const cargo = capture("cargo", "cargo", ["metadata", "--locked", "--format-version", "1"]);
      if (
        !Array.isArray(cargo.value.packages) ||
        !cargo.value.packages.length ||
        !Array.isArray(cargo.value.workspace_members) ||
        !cargo.value.workspace_members.length ||
        !isRecord(cargo.value.resolve)
      )
        throw new Error("Incomplete Cargo metadata for nextest inventory");
      return ["--binaries-metadata", binaries.file, "--cargo-metadata", cargo.file];
    });
    const verify = () => {
      for (const { file, bytes } of snapshots) {
        const stat = lstatSync(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size !== bytes.length ||
          !readFileSync(file).equals(bytes)
        )
          throw new Error("Nextest inventory metadata changed during its invocation");
      }
    };
    status = action(() => {
      verify();
      return [...argumentsForList];
    }, verify);
  } catch (error) {
    failure = { error };
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    const primary = failure
      ? failure.error
      : status !== 0
        ? new Error(`Rust impact failed with status ${status}`)
        : undefined;
    if (failure || primary)
      throw new AggregateError(
        [primary, error],
        "Rust impact failed and inventory cleanup also failed",
        { cause: primary },
      );
    throw error;
  }
  if (failure) throw failure.error;
  return status;
}

function normalizePath(value: unknown) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../"))
    throw new Error(`unsafe Rust test-impact path: ${String(value)}`);
  return normalized;
}

function assertRustTestImpactMap(value: unknown): asserts value is RustImpactMap {
  if (!isRecord(value)) throw new Error("Rust test-impact map must be an object");
  if (value.schema_version !== 1) throw new Error("unsupported Rust test-impact schema version");
  if (!isRecord(value.packages)) throw new Error("Rust test-impact map packages must be an object");

  for (const [packageName, config] of Object.entries(value.packages)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName))
      throw new Error(`invalid Rust test-impact package name: ${packageName}`);
    if (!isRecord(config))
      throw new Error(`Rust test-impact package ${packageName} must be an object`);
    if (typeof config.path_prefix !== "string")
      throw new Error(`Rust test-impact package ${packageName} path_prefix must be a string`);
    const prefix = normalizePath(config.path_prefix);
    if (!prefix.endsWith("/"))
      throw new Error(`Rust test-impact package ${packageName} path_prefix must end in /`);
    if (typeof config.broad_reason !== "string" || !config.broad_reason.trim())
      throw new Error(`Rust test-impact package ${packageName} broad_reason is missing`);
    if (!Array.isArray(config.groups) || config.groups.length === 0)
      throw new Error(`Rust test-impact package ${packageName} groups are missing`);

    const groupIds = new Set<string>();
    const ownedPaths = new Set<string>();
    const groups: unknown[] = config.groups;
    for (const group of groups) {
      if (!isRecord(group))
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
      const inputs: unknown[] = group.paths;
      for (const input of inputs) {
        if (typeof input !== "string")
          throw new Error(
            `Rust test-impact group ${packageName}:${group.id} path must be a string`,
          );
        const file = normalizePath(input);
        if (!file.startsWith(prefix))
          throw new Error(`Rust test-impact path ${file} is outside ${packageName}`);
        if (ownedPaths.has(file)) throw new Error(`duplicate Rust test-impact path: ${file}`);
        ownedPaths.add(file);
      }
    }
  }
}
export function validateRustTestImpactMap(value: unknown): RustImpactMap {
  assertRustTestImpactMap(value);
  return value;
}

export function readRustTestImpactMap(file = rustTestImpactPath) {
  return validateRustTestImpactMap(JSON.parse(readFileSync(file, "utf8")));
}

function broad(config: RustImpactPackage, reasons: string[]): ImpactSelection {
  return {
    mode: "broad",
    reason: `${config.broad_reason}; ${[...new Set(reasons)].join("; ")}`,
    groups: [],
  };
}

export function selectRustTestImpact(
  map: RustImpactMap | null,
  packageName: string,
  changes: readonly RustImpactChange[],
): ImpactSelection {
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

  const groupsByPath = new Map<string, RustImpactGroup>();
  for (const group of config.groups)
    for (const file of group.paths) groupsByPath.set(normalizePath(file), group);

  const selected = new Map<string, RustImpactGroup>();
  const broadReasons: string[] = [];
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

export function runnableImpactTests(inventory: unknown, packageName: string) {
  if (
    !isRecord(inventory) ||
    typeof inventory["test-count"] !== "number" ||
    !Number.isSafeInteger(inventory["test-count"]) ||
    inventory["test-count"] < 0 ||
    !isRecord(inventory["rust-suites"])
  )
    throw new Error("Incomplete nextest impact inventory");
  const matched = new Set<string>();
  let total = 0;
  for (const [binaryId, suite] of Object.entries(inventory["rust-suites"])) {
    if (
      !isRecord(suite) ||
      suite["package-name"] !== packageName ||
      suite["binary-id"] !== binaryId ||
      suite.status !== "listed" ||
      !isRecord(suite.testcases)
    )
      throw new Error("Unexpected nextest impact suite identity or coverage");
    for (const [name, detail] of Object.entries(suite.testcases)) {
      total++;
      const status =
        isRecord(detail) && isRecord(detail["filter-match"])
          ? detail["filter-match"].status
          : undefined;
      if (
        !name ||
        !isRecord(detail) ||
        typeof detail.ignored !== "boolean" ||
        (status !== "matches" && status !== "mismatch")
      )
        throw new Error("Invalid nextest impact test record");
      if (status === "matches" && !detail.ignored) matched.add(JSON.stringify([binaryId, name]));
    }
  }
  if (total !== inventory["test-count"]) throw new Error("Truncated nextest impact inventory");
  return matched;
}

export function runRustImpactUnion(
  packageName: string,
  groupIds: string[],
  dependencies: ImpactDependencies = {},
) {
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
  return withInventoryMetadata(
    ["--locked", "-p", packageName],
    run,
    dependencies.metrics ?? createCiMetrics(),
    16 * 1024 * 1024,
    (argumentsForList, verify) => {
      let outcomeInventory: unknown;
      const inventory = (filter: string) => {
        const result = run(
          "cargo-nextest",
          ["nextest", "list", ...argumentsForList(), "-E", filter, "--message-format", "json"],
          {
            cwd: projectRoot,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
        );
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`Nextest impact inventory failed: ${String(result.stderr)}`);
        verify();
        const parsed: unknown = JSON.parse(String(result.stdout));
        const tests = runnableImpactTests(parsed, packageName);
        outcomeInventory = parsed;
        return tests;
      };
      const expected = new Set<string>();
      for (const group of groups) {
        const matches = inventory(group.filter);
        if (!matches.size) throw new Error(`Rust impact group ${group.id} has no runnable tests`);
        for (const identity of matches) expected.add(identity);
        report(`[rust-impact] ${group.id}: ${matches.size} runnable tests; ${group.reason}`);
      }
      const filter = groups.map((group) => `(${group.filter})`).join(" | ");
      const union = inventory(filter);
      if (union.size !== expected.size || [...expected].some((identity) => !union.has(identity)))
        throw new Error(
          "Nextest impact union differs from the complete selected group inventories",
        );
      report(`[rust-impact] union: ${union.size} distinct runnable tests`);
      verify();
      return runNextestWithOutcomes(
        ["--locked", "-p", packageName, "-E", filter],
        nextestOutcomeSelection(
          outcomeInventory,
          new Set(
            [...union].map((identity) => {
              const [binary, name] = JSON.parse(identity) as [string, string];
              return JSON.stringify([packageName, binary, name]);
            }),
          ),
        ),
        { spawnSync: run, report },
      );
    },
    dependencies.inventoryTempRoot,
  );
}

export const rustPackagePrefixes = new Map([
  ["crates/portcove-core/", "portcove-core"],
  ["crates/portcove-cli/", "portcove-cli"],
  ["crates/portcove-diagnostics/", "portcove-diagnostics"],
  ["crates/portcove-release-tools/", "portcove-release-tools"],
  ["apps/desktop/src-tauri/", "portcove-desktop"],
]);

export function selectWorkspaceRustImpact(
  plan: ValidationPlan,
  map: RustImpactMap | null = readRustTestImpactMap(),
): WorkspaceImpactGroup[] {
  validateValidationPlan(plan);
  if (plan.mode === "blocked" || !plan.groups.includes("rust"))
    throw new Error("The plan does not authorize Rust execution");
  const shared =
    plan.fallback ||
    !plan.changes.length ||
    plan.changed_files.some(
      (file: string) =>
        // Both executable adapters consume this host-owned policy and worker.
        file.startsWith("crates/portcove-diagnostics/") ||
        ([
          "Cargo.toml",
          "Cargo.lock",
          "rust-toolchain.toml",
          "deny.toml",
          ".config/nextest.toml",
          ".config/rust-test-impact.json",
          ".config/rust-test-timing-hints.json",
          "scripts/windows-rust-tests.mts",
        ].includes(file) &&
          !plan.paths
            .find((entry) => entry.path === file)
            ?.reasons.includes("effective-nextest-configuration-unchanged")) ||
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
  const changesByPackage = new Map<string, RustImpactChange[]>();
  for (const change of plan.changes) {
    for (const [prefix, packageName] of rustPackagePrefixes) {
      if (![change.oldPath, change.newPath].some((file: string) => file.startsWith(prefix)))
        continue;
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
      (file: string) =>
        (file.startsWith("crates/") || file.startsWith("apps/desktop/src-tauri/")) &&
        ![...rustPackagePrefixes.keys()].some((prefix) => file.startsWith(prefix)),
    )
  )
    return [{ id: "workspace", filter: "all()", reason: "Rust package ownership is uncertain" }];
  const selected: WorkspaceImpactGroup[] = [];
  // Valid package keys use [a-z0-9-], preserving the old tuple sort's UTF-16 order.
  for (const [packageName, changes] of [...changesByPackage].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
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
    !selected.some(
      (group) => group.packageName === "portcove-cli" && group.filter === "package(=portcove-cli)",
    )
  ) {
    const group = map?.packages?.["portcove-cli"]?.groups.find(
      (entry) => entry.id === "artwork-fixtures",
    );
    const certain =
      group &&
      !selected.some((entry) => entry.filter === "package(=portcove-core)") &&
      plan.changes.every(
        (change) => change.oldPath === change.newPath && ["A", "M"].includes(change.status),
      );
    if (!certain || !selected.some((entry) => entry.id === "portcove-cli:artwork-fixtures"))
      selected.push({
        id: "portcove-cli:artwork-consumer",
        packageName: "portcove-cli",
        filter: certain ? `package(=portcove-cli) & (${group.filter})` : "package(=portcove-cli)",
        reason: "public CLI artwork consumer",
      });
  }
  // The CLI fixtures exercise shared host policy and the exact Desktop startup
  // functions without Tauri. Preserve these consumers across boundary changes.
  const diagnosticsInputs = new Set([
    "apps/desktop/src-tauri/src/diagnostics.rs",
    "apps/desktop/src-tauri/src/host_startup.rs",
    "apps/desktop/src-tauri/src/diagnostics_writer.rs",
    "apps/desktop/src-tauri/src/diagnostics_writer_tests.rs",
    "apps/desktop/src-tauri/src/diagnostics_events.rs",
    "apps/desktop/src-tauri/src/diagnostics_events_tests.rs",
    "apps/desktop/src-tauri/src/frontend_diagnostics.rs",
    "crates/portcove-core/src/runtime_diagnostics.rs",
    "crates/portcove-core/src/host_preferences.rs",
    "crates/portcove-core/src/database.rs",
    "crates/portcove-core/src/support_bundle_export.rs",
    "crates/portcove-core/src/support_bundle.rs",
    "crates/portcove-core/src/operation.rs",
    "crates/portcove-core/src/service.rs",
    "crates/portcove-core/src/preparation_execution.rs",
    "crates/portcove-core/src/tool_process.rs",
  ]);
  if (
    plan.changes.some((change) =>
      [change.oldPath, change.newPath].some((file) => diagnosticsInputs.has(file)),
    ) &&
    !selected.some(
      (group) =>
        group.packageName === "portcove-cli" &&
        (group.filter === "package(=portcove-cli)" ||
          group.id === "portcove-cli:runtime-diagnostics"),
    )
  ) {
    const group = map?.packages?.["portcove-cli"]?.groups.find(
      (entry) => entry.id === "runtime-diagnostics",
    );
    const certain =
      group &&
      plan.changes.every(
        (change) => change.oldPath === change.newPath && ["A", "M"].includes(change.status),
      );
    selected.push({
      id: "portcove-cli:runtime-diagnostics-consumer",
      packageName: "portcove-cli",
      filter: certain ? `package(=portcove-cli) & (${group.filter})` : "package(=portcove-cli)",
      reason: "complete typed runtime diagnostics, frontend report and Core/CLI outcome fixture",
    });
  }
  // Capability inventory and API schema changes retain their compiled CLI consumer.
  if (
    plan.changes.some((change) =>
      [change.oldPath, change.newPath].some((file) =>
        [
          "crates/portcove-core/src/definition_capabilities.rs",
          "crates/portcove-core/src/types.rs",
          "crates/portcove-core/src/lib.rs",
        ].includes(file),
      ),
    ) &&
    !selected.some(
      (group) => group.packageName === "portcove-cli" && group.filter === "package(=portcove-cli)",
    )
  ) {
    const group = map?.packages?.["portcove-cli"]?.groups.find(
      (entry) => entry.id === "definition-capability-fixtures",
    );
    const certain =
      group &&
      !selected.some((entry) => entry.filter === "package(=portcove-core)") &&
      plan.changes.every(
        (change) => change.oldPath === change.newPath && ["A", "M"].includes(change.status),
      );
    if (
      !certain ||
      !selected.some((entry) => entry.id === "portcove-cli:definition-capability-fixtures")
    )
      selected.push({
        id: "portcove-cli:definition-capability-consumer",
        packageName: "portcove-cli",
        filter: certain ? `package(=portcove-cli) & (${group.filter})` : "package(=portcove-cli)",
        reason: "compiled CLI advertised capability inventory, negotiation and API schema consumer",
      });
  }
  return selected;
}

export function runnableWorkspaceImpactTests(inventory: unknown, { allowSkipped = false } = {}) {
  return runnableNextestTests(inventory, { allowSkipped });
}

export function runWorkspaceRustImpact(
  plan: ValidationPlan,
  dependencies: ImpactDependencies = {},
) {
  let map: RustImpactMap | null;
  try {
    map = dependencies.map ?? readRustTestImpactMap();
  } catch {
    map = null;
  } // A missing focused map never waives package coverage.
  const groups = selectWorkspaceRustImpact(plan, map);
  const run = dependencies.spawnSync ?? spawnSync;
  const report = dependencies.report ?? console.log;
  const metrics = dependencies.metrics ?? createCiMetrics();
  let initialInventory = true;
  const scope = ["--locked", "--workspace", "--all-targets"];
  const execute = (argumentsForList: () => string[], verify: () => void) => {
    let outcomeInventory: unknown;
    const list = (filter: string) => {
      const result = metrics.measure(
        initialInventory ? "workspace-build-and-initial-inventory" : "filter-inventory",
        () =>
          run(
            "cargo-nextest",
            ["nextest", "list", ...argumentsForList(), "-E", filter, "--message-format", "json"],
            { cwd: projectRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
          ),
      );
      initialInventory = false;
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`Nextest workspace inventory failed: ${String(result.stderr)}`);
      verify();
      const parsed: unknown = JSON.parse(String(result.stdout));
      const tests = runnableWorkspaceImpactTests(parsed, {
        allowSkipped: filter !== "all()",
      });
      outcomeInventory = parsed;
      return tests;
    };
    const complete = list("all()");
    if (!complete.size) throw new Error("The complete workspace has no runnable tests");
    const expected = new Set<string>();
    for (const group of groups) {
      const matches = group.filter === "all()" ? complete : list(group.filter);
      if (!matches.size) throw new Error(`Rust impact group ${group.id} has no runnable tests`);
      for (const identity of matches) {
        if (!complete.has(identity))
          throw new Error("Rust impact group escaped its complete workspace/package inventory");
        if (group.packageName) {
          const decoded: unknown = JSON.parse(identity);
          if (!Array.isArray(decoded) || decoded[0] !== group.packageName)
            throw new Error("Rust impact group escaped its complete workspace/package inventory");
        }
        expected.add(identity);
      }
      report(`[rust-impact] ${group.id}: ${matches.size} runnable tests; ${group.reason}`);
    }
    const filter = groups.map((group) => `(${group.filter})`).join(" | ");
    const union = groups.length === 1 && groups[0]?.filter === "all()" ? complete : list(filter);
    if (union.size !== expected.size || [...expected].some((identity) => !union.has(identity)))
      throw new Error(
        "Nextest workspace union differs from the complete selected group inventories",
      );
    report(
      `[rust-impact] union: ${union.size} of ${complete.size} runnable workspace tests; Windows baseline`,
    );
    metrics.record("rust-selection", {
      selected_tests: union.size,
      complete_tests: complete.size,
      groups: groups.map((group) => group.id),
    });
    verify();
    const result = metrics.measure("selected-rust-tests", () => ({
      status: runNextestWithOutcomes(
        [...scope, "-E", filter],
        nextestOutcomeSelection(outcomeInventory, union),
        {
          spawnSync: run,
          report,
        },
      ),
    }));
    if (result.status !== 0) return result.status;
    // This stays inside the caller's heavyweight reservation. Cargo reuses the
    // workspace build; compare live Rust serialization with committed snapshots.
    const contract = metrics.measure("live-transport-contracts", () =>
      run(process.execPath, ["scripts/check-transport-contract.mts"], {
        cwd: projectRoot,
        stdio: "inherit",
        windowsHide: true,
      }),
    );
    if (contract.error) throw contract.error;
    return contract.status ?? 1;
  };
  return groups.length < 2
    ? execute(
        () => scope,
        () => {},
      )
    : withInventoryMetadata(
        scope,
        run,
        metrics,
        32 * 1024 * 1024,
        execute,
        dependencies.inventoryTempRoot,
      );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!["--workspace-run", "--run"].includes(process.argv[2] ?? ""))
      throw new Error("Use the guarded Rust runner for impact unions");
    const { resourceEntrypoint } = await import("./resource-command.mts");
    process.exitCode = await resourceEntrypoint("rust", async () => {
      if (process.argv[2] === "--workspace-run") {
        const planFile = process.argv[3];
        const planInput: unknown =
          process.env.PORTCOVE_PLAN_GZIP_BASE64 !== undefined ||
          process.env.PORTCOVE_PLAN_JSON !== undefined
            ? readValidationPlanInput()
            : JSON.parse(planFile ? readFileSync(planFile, "utf8") : "");
        const plan = validateValidationPlan(planInput);
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
        const packageName = process.argv[3];
        if (!packageName) throw new Error("Rust impact union requires a package name");
        process.exitCode = runRustImpactUnion(packageName, process.argv.slice(4));
      }
      return process.exitCode ?? 0;
    });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
