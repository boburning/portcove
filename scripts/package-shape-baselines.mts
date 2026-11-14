// Generated reviewed package-shape baselines (#5359 phase 1).
//
// Core derives a package shape from an extracted managed package and compares
// it with the shape of an artifact the catalog already marks as reviewed:
// a source-contract applicability row with an artifact SHA-256 or a
// managed-acquisition hold's `reviewed_artifacts`. This tool owns the embedded
// table of those reviewed shapes. Nobody hand-writes a shape:
//
// - `--check` (offline, CI): verifies the committed table's canonical bytes,
//   digest, derivation version, and that every entry still names a managed
//   portable route, one of its platforms, a reviewed catalog artifact and the
//   catalog facts its shape was derived from.
// - `--prune` (offline): repairs what catalog edits made stale without any
//   download: drops entries whose route, platform or reviewed digest is gone
//   or whose derivation inputs changed, adopts the catalog's reviewed version
//   label and review source, and rewrites the canonical table. A dropped entry is only a missing
//   baseline (`unknown`); `--candidates` lists it for an explicit refresh.
// - `--candidates` (offline): lists reviewed artifacts with no table entry.
// - `--record --archive PATH --port ID --platform P --size N --sha256 H
//   [--asset-name NAME] [--cli PORTCOVE]`: derives one entry through
//   `portcove --json catalog inspect-package-shape` (Core extraction, nothing
//   executed) and rewrites the table. The archive is obtained separately; the
//   caller verifies and deletes it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const tablePath = join(root, "crates/portcove-core/catalog/package-shapes.generated.json");
const catalogPath = join(root, "crates/portcove-core/catalog/catalog.json");
const derivationSource = join(root, "crates/portcove-core/src/package_shape.rs");
export const GENERATOR = "scripts/package-shape-baselines.mts";
export const TABLE_FORMAT = 1;
export const SHAPE_COMPONENTS = [
  "programs",
  "top_directories",
  "persistent_parent_children",
  "persistent_overlap",
  "config_files",
  "missing_persistent_parents",
] as const;
/** Adapters whose managed routes Core treats as portable packages. */
export const MANAGED_PORTABLE_ADAPTERS = new Set([
  "native-portable",
  "staged-source-portable",
  "n64-recomp-portable",
  "libultraship-portable",
  "psx-recomp-managed",
  "generated-cache",
]);
const MAXIMUM_SHAPE_PATHS = 16_384;

export type Shape = Record<(typeof SHAPE_COMPONENTS)[number], string[]>;
export interface ShapeEntry {
  port_id: string;
  platform: string;
  version: string;
  sha256: string;
  derivation_inputs_sha256: string;
  size: number;
  asset_name: string;
  reviewed_by: string;
  shape: Shape;
}
export interface ShapeTable {
  format: number;
  generator: string;
  shape_version: number;
  entries: ShapeEntry[];
  entries_sha256: string;
}
export interface ReviewedArtifact {
  port_id: string;
  version: string;
  sha256: string;
  reviewed_by: string;
}

/** The derivation version Core compiles in; a table from another version is stale. */
export function coreShapeVersion(source = readFileSync(derivationSource, "utf8")) {
  const match = /pub\(crate\) const SHAPE_VERSION: u32 = (\d+);/u.exec(source);
  if (!match) throw new Error("Core package_shape.rs declares no SHAPE_VERSION");
  return Number(match[1]);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? (value[key] ?? null) : null;
}

/**
 * The catalog facts Core's shape derivation reads for one route platform
 * (`roots`, `derive` and `anchors` in package_shape.rs). The Core table
 * currency test mirrors this; a changed input means the recorded shape may
 * no longer be what Core would derive.
 */
export function derivationInputs(port: unknown, platform: string) {
  const subdirectory = field(field(port, "runtime_subdirectory_by_platform"), platform);
  return {
    adapter: field(port, "adapter"),
    executable_hints: field(field(port, "executable_hints"), platform),
    external_profile_policy: field(port, "external_profile_policy"),
    grant_declared_executable: field(field(port, "release"), "grant_declared_executable"),
    ignore_verified_macos_libraries: field(
      field(field(port, "reviewed_package_layouts"), platform),
      "ignore_verified_macos_libraries",
    ),
    launch_from_install_root: field(port, "launch_from_install_root"),
    managed_shared_preferences: field(port, "managed_shared_preferences"),
    n64_runtime_at_executable_parent: field(port, "n64_runtime_at_executable_parent"),
    persistent_file_patterns: field(port, "persistent_file_patterns"),
    persistent_paths: field(port, "persistent_paths"),
    runtime_subdirectory: subdirectory ?? field(port, "runtime_subdirectory"),
    tar_xz_platforms: field(field(port, "release"), "tar_xz_platforms"),
  };
}

export function derivationInputsDigest(port: unknown, platform: string) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(derivationInputs(port, platform))))
    .digest("hex");
}

function catalogPorts(catalog: unknown) {
  return new Map(
    array(isRecord(catalog) ? catalog.ports : undefined)
      .filter(isRecord)
      .map((port) => [String(port.id), port]),
  );
}

/** Reviewed artifacts in catalog order: applicability rows first, then holds. */
export function reviewedArtifacts(catalog: unknown): ReviewedArtifact[] {
  if (!isRecord(catalog)) throw new Error("catalog must be an object");
  const ports = new Map(
    array(catalog.ports)
      .filter(isRecord)
      .map((port) => [String(port.id), port]),
  );
  const managed = (id: string) => {
    const port = ports.get(id);
    return port !== undefined && MANAGED_PORTABLE_ADAPTERS.has(String(port.adapter));
  };
  const reviewed: ReviewedArtifact[] = [];
  const sourceCatalog = isRecord(catalog.source_catalog) ? catalog.source_catalog : {};
  for (const contract of array(sourceCatalog.contracts).filter(isRecord)) {
    const portId = String(contract.port_id);
    if (!managed(portId)) continue;
    for (const row of array(contract.applicability).filter(isRecord)) {
      if (typeof row.artifact_sha256 !== "string") continue;
      reviewed.push({
        port_id: portId,
        version: String(row.upstream_ref),
        sha256: row.artifact_sha256.toLowerCase(),
        reviewed_by: `applicability:${String(contract.id)}`,
      });
    }
  }
  for (const [portId, port] of ports) {
    if (!managed(portId) || !isRecord(port.managed_acquisition_hold)) continue;
    for (const artifact of array(port.managed_acquisition_hold.reviewed_artifacts).filter(
      isRecord,
    )) {
      reviewed.push({
        port_id: portId,
        version: String(artifact.version),
        sha256: String(artifact.sha256).toLowerCase(),
        reviewed_by: "hold",
      });
    }
  }
  return reviewed;
}

function reviewedKey(artifact: { port_id: string; sha256: string; reviewed_by: string }) {
  return `${artifact.port_id}\u0000${artifact.sha256}\u0000${artifact.reviewed_by}`;
}

function validRelative(path: string) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[A-Z]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function shapeProblems(shape: unknown): string[] {
  if (!isRecord(shape)) return ["shape is not an object"];
  const problems: string[] = [];
  const extra = Object.keys(shape).filter(
    (key) => !(SHAPE_COMPONENTS as readonly string[]).includes(key),
  );
  if (extra.length) problems.push(`unknown shape parts ${extra.join(", ")}`);
  let total = 0;
  for (const component of SHAPE_COMPONENTS) {
    const paths = shape[component];
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
      problems.push(`${component} is missing; a generated shape knows every part`);
      continue;
    }
    total += paths.length;
    if (!paths.every(validRelative)) problems.push(`${component} has a noncanonical path`);
    if (paths.some((path, index) => index > 0 && !(String(paths[index - 1]) < path)))
      problems.push(`${component} is not strictly sorted`);
  }
  if (total > MAXIMUM_SHAPE_PATHS) problems.push("shape exceeds its path bound");
  return problems;
}

export function entriesDigest(entries: readonly ShapeEntry[]) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Canonical entry order: route, platform, then catalog review order (newest last). */
export function sortEntries(entries: readonly ShapeEntry[], reviewed: readonly ReviewedArtifact[]) {
  const position = new Map(reviewed.map((artifact, index) => [reviewedKey(artifact), index]));
  const order = (entry: ShapeEntry) => position.get(reviewedKey(entry)) ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort(
    (left, right) =>
      left.port_id.localeCompare(right.port_id, "en") ||
      left.platform.localeCompare(right.platform, "en") ||
      order(left) - order(right),
  );
}

export function serializeTable(
  entries: readonly ShapeEntry[],
  shapeVersion: number,
  reviewed: readonly ReviewedArtifact[],
) {
  const sorted = sortEntries(entries, reviewed).map((entry) => ({
    port_id: entry.port_id,
    platform: entry.platform,
    version: entry.version,
    sha256: entry.sha256,
    derivation_inputs_sha256: entry.derivation_inputs_sha256,
    size: entry.size,
    asset_name: entry.asset_name,
    reviewed_by: entry.reviewed_by,
    shape: Object.fromEntries(
      SHAPE_COMPONENTS.map((component) => [component, entry.shape[component]]),
    ),
  })) as ShapeEntry[];
  const table: ShapeTable = {
    format: TABLE_FORMAT,
    generator: GENERATOR,
    shape_version: shapeVersion,
    entries: sorted,
    entries_sha256: entriesDigest(sorted),
  };
  return `${JSON.stringify(table, null, 2)}\n`;
}

/** Every reason the committed table is not current for this catalog and Core. */
export function checkShapeTable(text: string, catalog: unknown, shapeVersion: number): string[] {
  let table: unknown;
  try {
    table = JSON.parse(text);
  } catch {
    return ["package shape table is not JSON"];
  }
  if (!isRecord(table)) return ["package shape table is not an object"];
  const problems: string[] = [];
  if (table.format !== TABLE_FORMAT) problems.push(`format must be ${TABLE_FORMAT}`);
  if (table.generator !== GENERATOR) problems.push(`generator must be ${GENERATOR}`);
  if (table.shape_version !== shapeVersion)
    problems.push(
      `shape_version ${String(table.shape_version)} differs from Core's ${shapeVersion}; re-derive every entry`,
    );
  if (!Array.isArray(table.entries)) return [...problems, "entries must be an array"];
  if (!isRecord(catalog)) return [...problems, "catalog must be an object"];
  const ports = new Map(
    array(catalog.ports)
      .filter(isRecord)
      .map((port) => [String(port.id), port]),
  );
  const reviewed = reviewedArtifacts(catalog);
  const reviewedKeys = new Map(reviewed.map((artifact) => [reviewedKey(artifact), artifact]));
  const seen = new Set<string>();
  const entries: ShapeEntry[] = [];
  for (const [index, value] of table.entries.entries()) {
    const label = `entries[${index}]`;
    if (!isRecord(value)) {
      problems.push(`${label} is not an object`);
      continue;
    }
    const entry = value as unknown as ShapeEntry;
    const name = `${label} ${String(entry.port_id)} ${String(entry.platform)} ${String(entry.sha256)}`;
    entries.push(entry);
    const port = ports.get(String(entry.port_id));
    if (!port) {
      problems.push(`${name}: the route is no longer in the catalog`);
      continue;
    }
    if (!MANAGED_PORTABLE_ADAPTERS.has(String(port.adapter)))
      problems.push(`${name}: the route is no longer a managed portable adapter`);
    if (!array(port.platforms).includes(entry.platform))
      problems.push(`${name}: the route no longer offers this platform`);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256))
      problems.push(`${name}: sha256 must be 64 lowercase hex digits`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0)
      problems.push(`${name}: size must be a positive integer`);
    if (typeof entry.asset_name !== "string" || basename(entry.asset_name) !== entry.asset_name)
      problems.push(`${name}: asset_name must be a file name`);
    const artifact = reviewedKeys.get(reviewedKey(entry));
    if (!artifact)
      problems.push(
        `${name}: ${String(entry.reviewed_by)} no longer marks this digest as reviewed`,
      );
    else if (artifact.version !== entry.version)
      problems.push(
        `${name}: reviewed version is ${artifact.version}, not ${String(entry.version)}`,
      );
    if (entry.derivation_inputs_sha256 !== derivationInputsDigest(port, String(entry.platform)))
      problems.push(
        `${name}: catalog facts the shape derivation reads changed since it was recorded`,
      );
    const key = `${String(entry.port_id)}\u0000${String(entry.platform)}\u0000${String(entry.sha256)}`;
    if (seen.has(key)) problems.push(`${name}: duplicate entry`);
    seen.add(key);
    problems.push(...shapeProblems(entry.shape).map((problem) => `${name}: ${problem}`));
  }
  if (table.entries_sha256 !== entriesDigest(table.entries as ShapeEntry[]))
    problems.push("entries_sha256 does not match the entries; regenerate, never hand-edit");
  if (problems.length === 0 && text !== serializeTable(entries, shapeVersion, reviewed))
    problems.push("table bytes are not canonical; regenerate with --record");
  return problems;
}

export function candidates(text: string, catalog: unknown) {
  const table = JSON.parse(text) as ShapeTable;
  const recorded = new Set(table.entries.map((entry) => reviewedKey(entry)));
  return reviewedArtifacts(catalog).filter((artifact) => !recorded.has(reviewedKey(artifact)));
}

/**
 * Offline repair after catalog edits: keep only entries that still name a
 * managed portable route, one of its platforms, a reviewed digest and the
 * derivation inputs they were recorded with; adopt the catalog's version
 * label. Nothing is re-derived, so no kept shape changes.
 */
export function pruneTable(text: string, catalog: unknown, shapeVersion: number) {
  const table = JSON.parse(text) as ShapeTable;
  const reviewed = reviewedArtifacts(catalog);
  const ports = catalogPorts(catalog);
  const removed: string[] = [];
  const kept: ShapeEntry[] = [];
  const seen = new Set<string>();
  for (const entry of table.shape_version === shapeVersion ? table.entries : []) {
    const port = ports.get(entry.port_id);
    const artifact =
      reviewed.find((candidate) => reviewedKey(candidate) === reviewedKey(entry)) ??
      reviewed.find(
        (candidate) => candidate.port_id === entry.port_id && candidate.sha256 === entry.sha256,
      );
    const key = `${entry.port_id}\u0000${entry.platform}\u0000${entry.sha256}`;
    const reason = !port
      ? "route removed"
      : !MANAGED_PORTABLE_ADAPTERS.has(String(port.adapter))
        ? "route is no longer a managed portable adapter"
        : !array(port.platforms).includes(entry.platform)
          ? "platform removed"
          : !artifact
            ? "digest no longer reviewed"
            : entry.derivation_inputs_sha256 !== derivationInputsDigest(port, entry.platform)
              ? "derivation inputs changed"
              : shapeProblems(entry.shape).length
                ? "shape is invalid"
                : seen.has(key)
                  ? "duplicate"
                  : undefined;
    seen.add(key);
    if (reason || !artifact) {
      removed.push(
        `${entry.port_id} ${entry.platform} ${entry.version} ${entry.sha256}: ${reason}`,
      );
      continue;
    }
    kept.push({ ...entry, version: artifact.version, reviewed_by: artifact.reviewed_by });
  }
  if (table.shape_version !== shapeVersion)
    removed.push(
      ...table.entries.map(
        (entry) =>
          `${entry.port_id} ${entry.platform} ${entry.version} ${entry.sha256}: derivation version changed`,
      ),
    );
  return { text: serializeTable(kept, shapeVersion, reviewed), removed };
}

/**
 * Insert or replace one derived entry and return the new canonical table.
 * `derivation_inputs_sha256` is the digest Core reported for the catalog it
 * derived with; it must equal the digest of the catalog being recorded
 * against, so a CLI built before a catalog edit cannot stamp a stale shape.
 */
export function recordEntry(
  text: string,
  catalog: unknown,
  shapeVersion: number,
  entry: Omit<ShapeEntry, "version" | "reviewed_by">,
) {
  const table = JSON.parse(text) as ShapeTable;
  const reviewed = reviewedArtifacts(catalog);
  const matches = reviewed.filter(
    (artifact) => artifact.port_id === entry.port_id && artifact.sha256 === entry.sha256,
  );
  const artifact = matches[0];
  if (!artifact)
    throw new Error(
      `${entry.port_id} ${entry.sha256} is not a reviewed catalog artifact (applicability row or hold)`,
    );
  const expected = derivationInputsDigest(catalogPorts(catalog).get(entry.port_id), entry.platform);
  if (entry.derivation_inputs_sha256 !== expected)
    throw new Error(
      `the inspecting CLI derived ${entry.port_id} ${entry.platform} from different catalog facts (${String(entry.derivation_inputs_sha256)}) than catalog.json (${expected}); rebuild the CLI from this checkout (cargo build -p portcove-cli) or pass --cli, then record again`,
    );
  const problems = shapeProblems(entry.shape);
  if (problems.length) throw new Error(`derived shape is invalid: ${problems.join("; ")}`);
  const kept = (table.shape_version === shapeVersion ? table.entries : []).filter(
    (existing) =>
      !(
        existing.port_id === entry.port_id &&
        existing.platform === entry.platform &&
        existing.sha256 === entry.sha256
      ),
  );
  kept.push({
    ...entry,
    version: artifact.version,
    reviewed_by: artifact.reviewed_by,
  });
  return serializeTable(kept, shapeVersion, reviewed);
}

function option(argv: readonly string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function required(argv: readonly string[], name: string) {
  const value = option(argv, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function inspect(argv: readonly string[]) {
  const archive = resolve(required(argv, "--archive"));
  const cli = resolve(
    option(argv, "--cli") ?? process.env.PORTCOVE_CLI ?? join(root, "target/debug/portcove"),
  );
  const args = [
    "--json",
    "catalog",
    "inspect-package-shape",
    archive,
    "--port",
    required(argv, "--port"),
    "--platform",
    required(argv, "--platform"),
    "--size",
    required(argv, "--size"),
    "--sha256",
    required(argv, "--sha256").toLowerCase(),
  ];
  const result = spawnSync(cli, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`package shape inspection failed: ${result.stdout}${result.stderr}`.trim());
  const response: unknown = JSON.parse(result.stdout);
  if (!isRecord(response) || !isRecord(response.data))
    throw new Error("package shape inspection returned no data");
  return response.data;
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
  const text = readFileSync(tablePath, "utf8");
  const shapeVersion = coreShapeVersion();
  if (argv.length === 1 && argv[0] === "--check") {
    const problems = checkShapeTable(text, catalog, shapeVersion);
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      throw new Error(
        `package shape table is stale (${problems.length} problems). Run \`node ${GENERATOR} --prune\` (offline) to drop stale entries and adopt catalog versions; then \`node ${GENERATOR} --candidates\` lists reviewed artifacts to re-derive with --record.`,
      );
    }
    const entries = (JSON.parse(text) as ShapeTable).entries;
    console.log(
      `Package shape table is current: ${entries.length} reviewed shapes across ${new Set(entries.map((entry) => entry.port_id)).size} routes.`,
    );
  } else if (argv.length === 1 && argv[0] === "--prune") {
    const { text: pruned, removed } = pruneTable(text, catalog, shapeVersion);
    for (const line of removed) console.log(`Removed ${line}`);
    if (pruned !== text) writeFileSync(tablePath, pruned);
    const remaining = checkShapeTable(pruned, catalog, shapeVersion);
    if (remaining.length) {
      for (const problem of remaining) console.error(problem);
      throw new Error("package shape table still has problems after pruning");
    }
    console.log(
      `Package shape table pruned: ${removed.length} entries removed; ${(JSON.parse(pruned) as ShapeTable).entries.length} kept.`,
    );
  } else if (argv.length === 1 && argv[0] === "--candidates") {
    process.stdout.write(`${JSON.stringify(candidates(text, catalog), null, 2)}\n`);
  } else if (argv[0] === "--record") {
    const data = inspect(argv);
    const sha256 = required(argv, "--sha256").toLowerCase();
    if (data.sha256 !== sha256 || data.shape_version !== shapeVersion)
      throw new Error("inspection identity or derivation version differs from the request");
    const output = recordEntry(text, catalog, shapeVersion, {
      port_id: required(argv, "--port"),
      platform: required(argv, "--platform"),
      sha256,
      size: Number(required(argv, "--size")),
      asset_name: option(argv, "--asset-name") ?? basename(required(argv, "--archive")),
      derivation_inputs_sha256:
        typeof data.derivation_inputs_sha256 === "string"
          ? data.derivation_inputs_sha256
          : "absent",
      shape: data.shape as Shape,
    });
    writeFileSync(tablePath, output);
    console.log(`Recorded ${required(argv, "--port")} ${sha256}.`);
  } else {
    throw new Error("select --check, --prune, --candidates or --record");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
