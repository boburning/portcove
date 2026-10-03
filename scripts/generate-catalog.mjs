import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareCatalogArtwork,
  createIgdbInspector,
  createCoreImageValidator,
  readArtworkJson,
} from "./inspect-igdb-artwork.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");
const sourcePath = join(catalogRoot, "catalog-current-authoring.json");
const outputPath = join(catalogRoot, "catalog.json");
const historicalPath = join(catalogRoot, "catalog-schema2-migration-fixture.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function differences(before, after, path = "$") {
  if (Object.is(before, after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    return [{ path, before, after }];
  }

  if (Array.isArray(before)) {
    const changes = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= before.length) changes.push({ path: `${path}[${index}]`, after: after[index] });
      else if (index >= after.length)
        changes.push({ path: `${path}[${index}]`, before: before[index] });
      else changes.push(...differences(before[index], after[index], `${path}[${index}]`));
    }
    return changes;
  }

  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (!(key in before)) changes.push({ path: `${path}.${key}`, after: after[key] });
    else if (!(key in after)) changes.push({ path: `${path}.${key}`, before: before[key] });
    else changes.push(...differences(before[key], after[key], `${path}.${key}`));
  }
  return changes;
}

function validateCurrentCatalog(catalog) {
  if (catalog.schema_version !== 2) throw new Error("current catalog source is not schema 2");
  if ("source_profiles" in catalog) {
    throw new Error("current catalog source must not contain a schema-1 source_profiles authority");
  }
  for (const [name, value] of [
    ["ports", catalog.ports],
    ["source_catalog.identities", catalog.source_catalog?.identities],
    ["source_catalog.contracts", catalog.source_catalog?.contracts],
    ["source_catalog.evidence", catalog.source_catalog?.evidence],
    ["source_catalog.qualification", catalog.source_catalog?.qualification],
  ]) {
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  }

  for (const [name, records] of [
    ["ports", catalog.ports],
    ["source_catalog.identities", catalog.source_catalog.identities],
    ["source_catalog.contracts", catalog.source_catalog.contracts],
    ["source_catalog.evidence", catalog.source_catalog.evidence],
  ]) {
    const ids = records.map((record) => record.id);
    if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new Error(`${name} contains a missing id`);
    }
    if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate ids`);
  }
}

const current = readJson(sourcePath);
validateCurrentCatalog(current);

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if ((index >= 0 && (!value || value.startsWith("--"))) || (required && !value))
    throw new Error(`${name} requires a value.`);
  return value;
}

async function prepareArtworkProposal() {
  if (process.argv.includes("--check") || process.argv.includes("--compare-historical"))
    throw new Error("Artwork preparation cannot also check or compare historical data.");
  const input = readArtworkJson(option("--prepare-artwork", true));
  validateCurrentCatalog(input);
  const identitiesFile = option("--identities");
  const identities = identitiesFile ? readArtworkJson(identitiesFile, 1024 * 1024) : {};
  const refreshPortIds = option("--refresh-artwork")?.split(",") ?? [];
  const outputRoot = resolve(option("--output-dir", true));
  // Refuse existing output rather than replacing an earlier proposal, recovery
  // receipt or private library. No catalog publication or source mutation.
  mkdirSync(outputRoot);
  const cli = option("--validator-cli");
  const validateImage = cli
    ? createCoreImageValidator(cli, join(outputRoot, "scratch"))
    : () => {
        throw new Error("Core image validation requires a selected compatible CLI.");
      };
  const inspector = createIgdbInspector(option("--credentials-file"), validateImage);
  const result = await prepareCatalogArtwork(input, {
    ...inspector,
    acceptedCatalog: current,
    identities,
    refreshPortIds,
  });
  validateCurrentCatalog(result.catalog);
  const evidence = {
    format_version: 1,
    input_sha256: digest(input),
    accepted_catalog_sha256: digest(current),
    proposed_catalog_sha256: digest(result.catalog),
    differences: differences(input, result.catalog),
    records: result.records,
    metrics: result.metrics,
    provider_metrics: inspector.providerMetrics,
    scope:
      "Maintainer cover proposal; no admission, signature, publication, runtime or user-choice mutation.",
  };
  writeFileSync(
    join(outputRoot, "catalog-proposal.json"),
    `${JSON.stringify(result.catalog, null, 2)}\n`,
    { flag: "wx" },
  );
  writeFileSync(
    join(outputRoot, "artwork-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({ output_dir: outputRoot, metrics: result.metrics })}\n`);
}

if (process.argv.includes("--prepare-artwork")) {
  await prepareArtworkProposal();
} else if (process.argv.includes("--compare-historical")) {
  const historical = readJson(historicalPath);
  const changes = differences(historical, current);
  process.stdout.write(
    `${JSON.stringify(
      {
        equal: changes.length === 0,
        historical_sha256: digest(historical),
        current_sha256: digest(current),
        differences: changes,
      },
      null,
      2,
    )}\n`,
  );
} else {
  const output = `${JSON.stringify(current, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(outputPath, "utf8") !== output) {
      throw new Error("embedded catalog is stale; run node scripts/generate-catalog.mjs");
    }
  } else {
    writeFileSync(outputPath, output);
  }
}
