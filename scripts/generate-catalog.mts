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
} from "./inspect-igdb-artwork.mts";

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

// Relationships describe declarations, not the dependency graph of a check.
// Keep complete scoped records: matching an adapter or evidence ID never grants
// another port's qualification, maintenance authority or execution acceptance.
function declarationCases(before, after, checks) {
  const referencedEvidence = (value, found = new Set()) => {
    if (!value || typeof value !== "object") return found;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "evidence_ids" && Array.isArray(nested)) for (const id of nested) found.add(id);
      else referencedEvidence(nested, found);
    }
    return found;
  };
  const snapshot = (catalog, portId) => {
    const port = catalog.ports.find((item) => item.id === portId) ?? null;
    const source = catalog.source_catalog ?? {};
    const contracts = (source.contracts ?? []).filter((item) => item.port_id === portId);
    const profiles = new Set([
      port?.source_profile,
      port?.bios_source_profile,
      ...contracts.map((item) => item.profile_id),
    ]);
    const identities = (source.identities ?? []).filter((item) => profiles.has(item.id));
    const validatorIds = new Set(contracts.map((item) => item.validator_contract_id));
    const validators = (source.validators ?? []).filter((item) => validatorIds.has(item.id));
    const qualification = (source.qualification ?? []).filter(
      (item) => item.scope?.port_id === portId,
    );
    const evidenceIds = referencedEvidence([
      port,
      identities,
      contracts,
      validators,
      qualification,
    ]);
    const evidence = (source.evidence ?? []).filter((item) => evidenceIds.has(item.id));
    return { port, source_records: { identities, contracts, validators, evidence, qualification } };
  };
  const references = (snapshot, catalog) => ({
    identities: snapshot.source_records.identities.map((record) => record.id),
    contracts: snapshot.source_records.contracts.map((record) => record.id),
    qualification: snapshot.source_records.qualification.map((record) =>
      catalog.source_catalog.qualification.indexOf(record),
    ),
  });
  const cases = [...new Set([...before.ports, ...after.ports].map((port) => port.id))]
    .sort()
    .flatMap((portId) => {
      const old = snapshot(before, portId);
      const proposed = snapshot(after, portId);
      const reasons = [];
      if (differences(old.port, proposed.port).length) reasons.push("port-declaration");
      if (differences(old.source_records, proposed.source_records).length)
        reasons.push("source-record-relationship");
      if (!reasons.length) return [];
      const adapters = [...new Set([old.port?.adapter, proposed.port?.adapter])]
        .filter((adapter) => typeof adapter === "string")
        .sort();
      return [
        {
          port_id: portId,
          reasons,
          before: { port: old.port, source_record_refs: references(old, before) },
          after: { port: proposed.port, source_record_refs: references(proposed, after) },
          unchanged_port_fields: Object.keys(old.port ?? {})
            .filter(
              (key) =>
                proposed.port &&
                Object.hasOwn(proposed.port, key) &&
                differences(old.port[key], proposed.port[key]).length === 0,
            )
            .sort(),
          adapter_references: adapters,
          checks: Object.fromEntries(
            ["accepted", "input", "output"].map((name) => [
              name,
              checks[name].ports.find((port) => port.port_id === portId) ?? null,
            ]),
          ),
        },
      ];
    });
  return {
    cases,
    source_tables: { before: before.source_catalog ?? {}, after: after.source_catalog ?? {} },
    adapter_references: [...new Set(cases.flatMap((item) => item.adapter_references))]
      .sort()
      .map((adapter) => ({
        adapter,
        accepted_port_ids: before.ports
          .filter((port) => port.adapter === adapter)
          .map((port) => port.id)
          .sort(),
      })),
    preparation_costs: "#/preparation_costs",
    artwork_evidence: "artwork-evidence.json",
    unmeasured: [
      "new engineering",
      "application/harness changes",
      "interventions",
      "maintenance execution",
      "work eliminated",
      "comparative savings",
    ],
    scope:
      "Exact declaration relationships and executed inspector receipts only; not validation impact, capability fit or reusable qualification. Referenced evidence remains declared, not authenticated or executed by this preparation.",
  };
}

// Independently curated test expectations, never generated from a proposal.
// This checks identity bookkeeping only; Rust retains full frozen equality.
function compatibilityFixtureReview(catalog) {
  const legacy = readJson(join(catalogRoot, "catalog-schema1-fixture.json"));
  const additionsPath = join(catalogRoot, "catalog-legacy-additions-fixture.json");
  const additionsBytes = readFileSync(additionsPath);
  const additions = JSON.parse(additionsBytes);
  if (
    !additions ||
    typeof additions !== "object" ||
    Array.isArray(additions) ||
    JSON.stringify(Object.keys(additions).sort()) !== '["port_ids","source_profile_ids"]'
  )
    throw new Error("Malformed compatibility fixture; expected only explicit identity lists.");
  const checkedIds = (values, label) => {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((id) => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) ||
      new Set(values).size !== values.length
    )
      throw new Error(`Malformed compatibility fixture ${label}: nonempty unique IDs required.`);
    return values;
  };
  const collections = {};
  for (const [name, baseline, actual] of [
    [
      "source_profile_ids",
      legacy.source_profiles.map(({ id }) => id),
      catalog.source_catalog.identities.map(({ id }) => id),
    ],
    ["port_ids", legacy.ports.map(({ id }) => id), catalog.ports.map(({ id }) => id)],
  ]) {
    checkedIds(baseline, `frozen ${name}`);
    const reviewed = checkedIds(additions[name], name);
    if (reviewed.some((id) => baseline.includes(id)))
      throw new Error(`Malformed compatibility fixture ${name}: overlaps frozen legacy IDs.`);
    const expected = new Set([...baseline, ...reviewed]);
    const observed = new Set(actual);
    collections[name] = {
      expected_count: expected.size,
      unreviewed_ids: [...observed].filter((id) => !expected.has(id)).sort(),
      missing_expected_ids: [...expected].filter((id) => !observed.has(id)).sort(),
    };
  }
  return {
    status: Object.values(collections).every(
      ({ unreviewed_ids, missing_expected_ids }) =>
        !unreviewed_ids.length && !missing_expected_ids.length,
    )
      ? "matched"
      : "requires-review",
    fixture: "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
    fixture_sha256: createHash("sha256").update(additionsBytes).digest("hex"),
    collections,
    scope:
      "Identity bookkeeping only; manually review expectations. Full frozen equality, source contracts and qualification remain separate Rust checks.",
  };
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
    const processStarted = process.hrtime.bigint();
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
    const processElapsedMs = Number(process.hrtime.bigint() - processStarted) / 1e6;
    writeFileSync(
      join(root, `${name}-process.json`),
      JSON.stringify(
        {
          validator_artifact_sha256: artifactSha256,
          status: child.status,
          signal: child.signal,
          error_code: child.error?.code ?? null,
          elapsed_ms: processElapsedMs,
          elapsed_boundary: "monotonic wall elapsed around validator spawnSync, including waiting",
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
  const preparationStarted = process.hrtime.bigint();
  let phaseStarted = preparationStarted;
  const phases = [];
  const finishPhase = (phase) => {
    const finished = process.hrtime.bigint();
    phases.push({ phase, elapsed_ms: Number(finished - phaseStarted) / 1e6 });
    phaseStarted = finished;
  };
  let inspectProposal;
  let beforeChecks;
  if (fullProposal) {
    const validationRoot = join(outputRoot, "proposal-checks");
    mkdirSync(validationRoot);
    inspectProposal = coreProposalInspector(cli, validationRoot);
    finishPhase("validator_capture");
    const accepted = inspectProposal.inspect("accepted", Buffer.from(JSON.stringify(current)));
    finishPhase("accepted_declarations");
    const inputCheck = inspectProposal.inspect("input", captured.bytes);
    finishPhase("input_declarations");
    beforeChecks = {
      accepted,
      input: inputCheck,
    };
  }
  let imageValidator;
  let imageInitializationError;
  const validateImage = inspectProposal
    ? (bytes) => {
        if (imageInitializationError) throw imageInitializationError;
        if (!imageValidator) {
          try {
            imageValidator = createCoreImageValidator(
              inspectProposal.artifact,
              join(outputRoot, "scratch"),
            );
          } catch (error) {
            imageInitializationError = error;
            throw error;
          }
        }
        return imageValidator(bytes);
      }
    : cli
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
  finishPhase("artwork_preparation");
  validateCurrentCatalog(result.catalog);
  const proposalBytes = Buffer.from(`${JSON.stringify(result.catalog, null, 2)}\n`);
  const proposalChecks = fullProposal
    ? { ...beforeChecks, output: inspectProposal.inspect("output", proposalBytes) }
    : undefined;
  finishPhase("output_preparation_and_declarations");
  const compatibilityReview = fullProposal ? compatibilityFixtureReview(result.catalog) : undefined;
  finishPhase("compatibility_review");
  const preparationCosts = {
    clock: "process.hrtime.bigint",
    elapsed_ms: Number(phaseStarted - preparationStarted) / 1e6,
    elapsed_boundary:
      "New output directory through compatibility review; excludes input/options parsing, process startup and final output writes. Includes subprocess/provider waiting; not CPU time.",
    phases,
    artwork_metrics: "artwork-evidence.json#/metrics",
    provider_metrics: "artwork-evidence.json#/provider_metrics",
    unmeasured: [
      "authoring",
      "engineering",
      "interventions",
      "CPU",
      "comparative_baseline",
      "speedup",
    ],
    scope:
      "Observed preparation only; reuse counts do not establish time saved or delivery improvement.",
  };
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
          declaration_cases: declarationCases(current, result.catalog, proposalChecks),
          compatibility_fixture_review: compatibilityReview,
          preparation_costs: preparationCosts,
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
  const compatibility = compatibilityFixtureReview(current);
  if (compatibility.status !== "matched")
    throw new Error(
      `Review independent compatibility fixture before generation: ${JSON.stringify(compatibility.collections)}`,
    );
  const output = `${JSON.stringify(current, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(outputPath, "utf8") !== output) {
      throw new Error("embedded catalog is stale; run node scripts/generate-catalog.mts");
    }
  } else {
    writeFileSync(outputPath, output);
  }
}
