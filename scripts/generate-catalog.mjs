import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareCatalogArtwork,
  createIgdbInspector,
  createCoreImageValidator,
  readArtworkJson,
  readArtworkInput,
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
    if (!Object.hasOwn(before, key)) changes.push({ path: `${path}.${key}`, after: after[key] });
    else if (!Object.hasOwn(after, key))
      changes.push({ path: `${path}.${key}`, before: before[key] });
    else changes.push(...differences(before[key], after[key], `${path}.${key}`));
  }
  return changes;
}

// This supplementary report follows named records, not their array positions.
// The complete positional diff remains the unfiltered catalog comparison.
function recordDifferences(before, after, path = "$") {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    (before === undefined && object(after) && Object.keys(after).length === 0) ||
    (after === undefined && object(before) && Object.keys(before).length === 0)
  )
    return differences(before, after, path);
  if (before === undefined && object(after)) before = {};
  if (after === undefined && object(before)) after = {};
  if (!object(before) || !object(after)) return differences(before, after, path);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .sort()
    .flatMap((key) =>
      recordDifferences(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined,
        `${path}.${key}`,
      ),
    );
}

function proposalChanges(before, after) {
  const ports = [];
  const sourceRecords = [];
  const orderChanges = [];
  const collections = [
    ["ports", before.ports, after.ports],
    ...["identities", "contracts", "validators", "evidence"].map((name) => [
      `source_catalog.${name}`,
      before.source_catalog?.[name] ?? [],
      after.source_catalog?.[name] ?? [],
    ]),
  ];
  const index = (records, collection) => {
    if (!Array.isArray(records)) throw new Error(`${collection} must be an array`);
    const result = new Map();
    for (const record of records) {
      if (typeof record?.id !== "string" || !record.id || result.has(record.id))
        throw new Error(`${collection} has a missing or duplicate record identity`);
      result.set(record.id, record);
    }
    return result;
  };
  for (const [collection, oldRecords, newRecords] of collections) {
    const oldIndex = index(oldRecords, collection);
    const newIndex = index(newRecords, collection);
    const oldOrder = [...oldIndex.keys()];
    const newOrder = [...newIndex.keys()];
    if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder))
      orderChanges.push({ collection, before: oldOrder, after: newOrder });
    for (const id of [...new Set([...oldOrder, ...newOrder])]) {
      const oldRecord = oldIndex.get(id);
      const newRecord = newIndex.get(id);
      const changes = recordDifferences(oldRecord ?? {}, newRecord ?? {});
      if (!changes.length) continue;
      const action = !oldRecord ? "added" : !newRecord ? "removed" : "modified";
      if (collection !== "ports") {
        sourceRecords.push({
          collection,
          id,
          action,
          label_before: oldRecord?.label ?? oldRecord?.name ?? null,
          label_after: newRecord?.label ?? newRecord?.name ?? null,
          differences: changes,
        });
        continue;
      }
      const grouped = { source: [], execution: [], persistence: [], other: [] };
      for (const change of changes) {
        const field = /^\$\.([^.[]+)/u.exec(change.path)?.[1];
        let group = "other";
        if (
          [
            "source_profile",
            "bios_source_profile",
            "source_environment",
            "runtime_source_filename",
            "runtime_source_materialization",
            "runtime_source_hashes",
            "runtime_source_set",
          ].includes(field) ||
          /^\$\.presentation\.source_requirements(?:$|[.[])/u.test(change.path) ||
          /^\$\.release\.user_prepared\.[^.]+\.source_argument_extension(?:$|[.[])/u.test(
            change.path,
          )
        )
          group = "source";
        else if (
          [
            "persistent_paths",
            "persistent_file_patterns",
            "runtime_mutable_paths",
            "runtime_mutable_file_patterns",
            "user_data_environment",
            "setup_output_paths",
          ].includes(field) ||
          /^\$\.presentation\.saves_and_settings(?:$|[.[])/u.test(change.path) ||
          /^\$\.release\.user_prepared\.[^.]+\.mutable_paths(?:$|[.[])/u.test(change.path)
        )
          group = "persistence";
        else if (
          [
            "adapter",
            "release",
            "bundled_runtime",
            "executable_hints",
            "launch_environment",
            "launch_arguments",
            "runtime_subdirectory",
            "launch_from_install_root",
            "setup_executable_hints",
            "setup_arguments",
            "setup_marker",
            "portable_marker",
          ].includes(field)
        )
          group = "execution";
        grouped[group].push(change);
      }
      ports.push({
        port_id: id,
        action,
        name_before: oldRecord?.name ?? null,
        name_after: newRecord?.name ?? null,
        changes: grouped,
      });
    }
  }
  return { ports, source_records: sourceRecords, order_changes: orderChanges };
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

function coreProposalInspector(cli, root) {
  const artifact = join(root, process.platform === "win32" ? "validator.exe" : "validator");
  copyFileSync(resolve(cli), artifact);
  chmodSync(artifact, 0o500);
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PORTCOVE_LIBRARY"),
  );
  const inspect = (name, bytes) => {
    const file = join(root, `${name}.json`);
    writeFileSync(file, bytes, { flag: "wx" });
    const child = spawnSync(
      artifact,
      [
        "--library",
        join(root, "unused-library"),
        "--json",
        "--non-interactive",
        "catalog",
        "inspect-proposal",
        file,
      ],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    writeFileSync(
      join(root, `${name}-process.json`),
      JSON.stringify(
        {
          validator_artifact_sha256: artifactSha256,
          status: child.status,
          signal: child.signal,
          error_code: child.error?.code ?? null,
          stdout_tail: child.stdout?.slice(-16384) ?? "",
          stderr_tail: child.stderr?.slice(-16384) ?? "",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        `Core refused ${name} catalog declarations; retained process receipt has the reason.`,
      );
    const report = JSON.parse(child.stdout).data;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      report?.format_version !== 1 ||
      report.input_sha256 !== sha256 ||
      report.input_bytes !== bytes.length ||
      !Array.isArray(report.ports)
    )
      throw new Error("Core proposal receipt does not identify the checked input.");
    return { ...report, validator_artifact_sha256: artifactSha256 };
  };
  return { artifact, inspect };
}

async function prepareArtworkProposal(fullProposal = false) {
  if (process.argv.includes("--check") || process.argv.includes("--compare-historical"))
    throw new Error("Proposal preparation cannot also check or compare historical data.");
  if (fullProposal && process.argv.includes("--prepare-artwork"))
    throw new Error("Cannot combine proposal preparation modes.");
  if (fullProposal) {
    const allowed = new Set([
      "--prepare-proposal",
      "--validator-cli",
      "--output-dir",
      "--identities",
      "--refresh-artwork",
      "--credentials-file",
    ]);
    const seen = new Set();
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      if (!allowed.has(name) || seen.has(name))
        throw new Error("Unknown or repeated proposal option.");
      seen.add(name);
      if (!args[index + 1] || args[index + 1].startsWith("--"))
        throw new Error(`${name} requires a value.`);
    }
  }
  const captured = readArtworkInput(
    option(fullProposal ? "--prepare-proposal" : "--prepare-artwork", true),
    fullProposal ? 4 * 1024 * 1024 : 8 * 1024 * 1024,
  );
  const input = captured.document;
  validateCurrentCatalog(input);
  const identitiesFile = option("--identities");
  const identities = identitiesFile ? readArtworkJson(identitiesFile, 1024 * 1024) : {};
  const refreshPortIds = option("--refresh-artwork")?.split(",") ?? [];
  const outputRoot = resolve(option("--output-dir", true));
  const cli = option("--validator-cli", fullProposal);
  // Refuse existing output rather than replacing an earlier proposal, recovery
  // receipt or private library. No catalog publication or source mutation.
  mkdirSync(outputRoot);
  let inspectProposal;
  let beforeChecks;
  if (fullProposal) {
    const validationRoot = join(outputRoot, "proposal-checks");
    mkdirSync(validationRoot);
    inspectProposal = coreProposalInspector(cli, validationRoot);
    beforeChecks = {
      accepted: inspectProposal.inspect("accepted", Buffer.from(JSON.stringify(current))),
      input: inspectProposal.inspect("input", captured.bytes),
    };
  }
  const validateImage = cli
    ? createCoreImageValidator(inspectProposal?.artifact ?? cli, join(outputRoot, "scratch"))
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
  const proposalBytes = Buffer.from(`${JSON.stringify(result.catalog, null, 2)}\n`);
  const proposalChecks = fullProposal
    ? { ...beforeChecks, output: inspectProposal.inspect("output", proposalBytes) }
    : undefined;
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
  writeFileSync(join(outputRoot, "catalog-proposal.json"), proposalBytes, { flag: "wx" });
  writeFileSync(
    join(outputRoot, "artwork-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  if (fullProposal)
    writeFileSync(
      join(outputRoot, "proposal-evidence.json"),
      `${JSON.stringify(
        {
          format_version: 1,
          accepted_catalog_sha256: digest(current),
          input_catalog_sha256: digest(input),
          proposed_catalog_sha256: digest(result.catalog),
          differences: differences(current, result.catalog),
          proposal_changes: proposalChanges(current, result.catalog),
          checks: proposalChecks,
          artwork_evidence: "artwork-evidence.json",
          scope:
            "Prepared catalog declarations only; protected acceptance/delivery, artifact/source/runtime observations remain separate.",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  process.stdout.write(`${JSON.stringify({ output_dir: outputRoot, metrics: result.metrics })}\n`);
}

const arguments_ = process.argv.slice(2);
const preparing =
  arguments_.includes("--prepare-proposal") || arguments_.includes("--prepare-artwork");
if (
  !preparing &&
  !(
    arguments_.length === 0 ||
    (arguments_.length === 1 && ["--check", "--compare-historical"].includes(arguments_[0]))
  )
) {
  throw new Error("Unknown or combined generator arguments; select one supported mode.");
}
if (preparing) {
  await prepareArtworkProposal(process.argv.includes("--prepare-proposal"));
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
        proposal_changes: proposalChanges(historical, current),
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
