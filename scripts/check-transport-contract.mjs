import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = spawnSync(
  "cargo",
  ["run", "--quiet", "-p", "portcove-cli", "--", "--json", "schema", "export"],
  { cwd: root, encoding: "utf8" },
);
if (command.status !== 0) {
  process.stderr.write(command.stderr || command.stdout);
  process.exit(command.status ?? 1);
}

const envelope = JSON.parse(command.stdout.trim());
if (!envelope.ok || envelope.command !== "schema.export") {
  throw new Error("portcove schema export returned an invalid envelope");
}
const schemas = envelope.data;
const typesOption = process.argv.indexOf("--types");
const typesPath = typesOption >= 0
  ? path.resolve(process.argv[typesOption + 1])
  : path.join(root, "apps", "desktop", "src", "types.ts");
const sourceText = fs.readFileSync(typesPath, "utf8");

function interfaceFields(name) {
  const declaration = sourceText.search(new RegExp(`export\\s+interface\\s+${name}\\s*\\{`));
  if (declaration < 0) return undefined;
  const open = sourceText.indexOf("{", declaration);
  const fields = [];
  let depth = 1;
  for (const line of sourceText.slice(open + 1).split(/\r?\n/)) {
    if (depth === 1) {
      const field = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/);
      if (field) fields.push(field[1]);
    }
    for (const character of line) {
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
    }
    if (depth === 0) break;
  }
  return fields;
}

const aliases = new Map(
  [...sourceText.matchAll(/export type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)]
    .map((match) => [match[1], match[2].trim()]),
);

const failures = [];
const interfaceSchemas = new Map([
  ["catalog", "CatalogDocument"],
  ["catalog_status", "CatalogStatus"],
  ["catalog_provenance", "CatalogProvenance"],
  ["catalog_trust_key", "CatalogTrustKey"],
  ["catalog_update_plan", "CatalogUpdatePlan"],

  ["port", "PortDefinition"],
  ["status", "PortStatus"],
  ["update_check", "UpdateCheck"],
  ["update_snapshot", "UpdateSnapshot"],
  ["reconcile_result", "ReconcileResult"],
  ["source", "SourceRecord"],
  ["source_relink_plan", "SourceRelinkPlan"],
  ["library_metadata_file", "LibraryMetadataFile"],
  ["library_metadata", "LibraryMetadata"],
  ["library_move_plan", "LibraryMovePlan"],
  ["library_move_result", "LibraryMoveResult"],
  ["library_import_plan", "LibraryImportPlan"],
  ["library_import_result", "LibraryImportResult"],
  ["library_selection", "LibrarySelection"],
  ["source_discovery_request", "SourceDiscoveryRequest"],
  ["source_discovery_limits", "SourceDiscoveryLimits"],
  ["source_discovery_report", "SourceDiscoveryReport"],
  ["source_discovery_issue", "SourceDiscoveryIssue"],
  ["source_removal_preview", "SourceRemovalPreview"],
  ["source_verification", "SourceVerification"],
  ["activity", "ActivityRecord"],
  ["cancellation_state", "CancellationState"],
  ["backup", "BackupRecord"],
  ["adoption_preview", "AdoptionPreview"],
  ["restore_result", "RestoreResult"],
  ["storage", "StorageSummary"],
  ["doctor", "DoctorReport"],
  ["install_plan", "InstallPlan"],
  ["operation_event", "OperationEvent"],
  ["github_auth_status", "GithubAuthStatus"],
  ["github_device_login", "GithubDeviceLogin"],
  ["github_device_login_result", "GithubDeviceLoginResult"],
]);

for (const [schemaName, interfaceName] of interfaceSchemas) {
  const fields = interfaceFields(interfaceName);
  const schema = schemas[schemaName];
  if (!fields || !schema?.properties) {
    failures.push(`${schemaName} is missing its ${interfaceName} contract`);
    continue;
  }
  const rust = [...new Set([
    ...Object.keys(schema.properties),
    ...(schema.oneOf ?? []).flatMap((variant) => Object.keys(variant.properties ?? {})),
  ])].sort();
  const frontend = fields.sort();
  if (JSON.stringify(rust) !== JSON.stringify(frontend)) {
    failures.push(`${interfaceName} fields differ: Rust=${rust.join(",")} TypeScript=${frontend.join(",")}`);
  }
}

const enumSchemas = new Map();
for (const schema of Object.values(schemas)) {
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    if (!Array.isArray(definition.enum) || !definition.enum.every((value) => typeof value === "string")) continue;
    const values = [...definition.enum].sort();
    const existing = enumSchemas.get(name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(values)) {
      failures.push(`Rust schemas disagree about ${name}`);
    }
    enumSchemas.set(name, values);
  }
}

const checkedEnums = [
  "ActivityOperation",
  "SourceDiscoveryLimit",
  "ActivityStatus",
  "CancellationPhase",
  "ActivityTargetKind",
  "AdapterKind",
  "ErrorCode",
  "GithubAuthSource",
  "HostToolSource",
  "HostToolState",
  "InstallPlanAction",
  "LibrarySelectionSource",
  "Platform",
  "ReconcileAction",
  "ReleaseChannel",
  "ReleaseSource",
  "RuntimeSourceMaterialization",
  "SourceKind",
  "SourceHealth",
  "SupportTier",
  "UpdatePolicy",
  "UpstreamStatus",
  "OperationResult",
];

function stringLiterals(alias, seen = new Set()) {
  const reference = alias.match(/^[A-Za-z_$][\w$]*$/)?.[0];
  if (reference) {
    if (seen.has(reference)) return [];
    const target = aliases.get(reference);
    return target ? stringLiterals(target, new Set([...seen, reference])) : [];
  }
  return [...alias.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

const operationEventTypes = (schemas.operation_event.oneOf ?? [])
  .map((variant) => variant.properties?.type?.const)
  .filter((value) => typeof value === "string")
  .sort();
const frontendEventTypes = stringLiterals(aliases.get("OperationEventType") ?? "").sort();
if (JSON.stringify(operationEventTypes) !== JSON.stringify(frontendEventTypes)) {
  failures.push(`OperationEventType values differ: Rust=${operationEventTypes.join(",")} TypeScript=${frontendEventTypes.join(",")}`);
}

for (const name of checkedEnums) {
  const expected = enumSchemas.get(name);
  const alias = aliases.get(name);
  if (!expected || !alias) {
    failures.push(`${name} is missing from ${expected ? "TypeScript" : "Rust schema"}`);
    continue;
  }
  const actual = stringLiterals(alias).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    failures.push(`${name} values differ: Rust=${expected.join(",")} TypeScript=${actual.join(",")}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Transport contract drift:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write("Rust and TypeScript transport contracts match.\n");
