import { coreProposalInspector } from "./catalog-authoring-inspector.mts";
import type { ProposalReceipt } from "./catalog-authoring-inspector.mts";
import {
  namedRecords,
  validateCurrentCatalog,
  reviewCompatibilityFixture,
  serializeCurrentCatalog,
  readCatalogSource,
  catalogSourceNames,
} from "./catalog-authoring.mts";
import type { CurrentCatalog, NamedRecord } from "./catalog-authoring.mts";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareCatalogArtwork,
  createIgdbInspector,
  createCoreImageValidator,
  readArtworkJson,
  readArtworkInput,
} from "./inspect-igdb-artwork.mts";
import type { ImageValidator } from "./inspect-igdb-artwork.mts";
import { isRecord } from "./runtime-values.mts";

interface Difference {
  path: string;
  before?: unknown;
  after?: unknown;
}
type ProposalChecks = Record<"accepted" | "input" | "output", ProposalReceipt>;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");
const sourcePath = join(catalogRoot, catalogSourceNames.operational);
const outputPath = join(catalogRoot, "catalog.json");
const listingsPath = join(catalogRoot, catalogSourceNames.listings);
const historicalPath = join(catalogRoot, "catalog-schema2-migration-fixture.json");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function differences(before: unknown, after: unknown, path = "$"): Difference[] {
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

  if (Array.isArray(before) && Array.isArray(after)) {
    const oldValues: unknown[] = before;
    const newValues: unknown[] = after;
    const changes: Difference[] = [];
    const length = Math.max(oldValues.length, newValues.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= oldValues.length)
        changes.push({ path: `${path}[${index}]`, after: newValues[index] });
      else if (index >= newValues.length)
        changes.push({ path: `${path}[${index}]`, before: oldValues[index] });
      else changes.push(...differences(oldValues[index], newValues[index], `${path}[${index}]`));
    }
    return changes;
  }

  if (!isRecord(before) || !isRecord(after)) return [{ path, before, after }];
  const changes: Difference[] = [];
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
function recordDifferences(before: unknown, after: unknown, path = "$"): Difference[] {
  const object = isRecord;
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

function proposalChanges(before: CurrentCatalog, after: CurrentCatalog) {
  const ports = [];
  const sourceRecords = [];
  const orderChanges = [];
  const collections: [string, unknown, unknown][] = [
    ["ports", before.ports, after.ports],
    ...(["identities", "contracts", "validators", "evidence"] as const).map(
      (name): [string, unknown, unknown] => [
        `source_catalog.${name}`,
        before.source_catalog?.[name] ?? [],
        after.source_catalog?.[name] ?? [],
      ],
    ),
  ];
  const index = (records: unknown, collection: string) => {
    const result = new Map<string, NamedRecord>();
    for (const record of namedRecords(
      records,
      collection,
      `${collection} has a missing or duplicate record identity`,
    ))
      result.set(record.id, record);
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
      const grouped: Record<"source" | "execution" | "persistence" | "other", Difference[]> = {
        source: [],
        execution: [],
        persistence: [],
        other: [],
      };
      for (const change of changes) {
        const field = /^\$\.([^.[]+)/u.exec(change.path)?.[1];
        let group: keyof typeof grouped = "other";
        if (
          [
            "source_profile",
            "bios_source_profile",
            "source_environment",
            "runtime_source_filename",
            "runtime_source_materialization",
            "runtime_source_hashes",
            "runtime_source_set",
          ].includes(field ?? "") ||
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
          ].includes(field ?? "") ||
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
          ].includes(field ?? "")
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
function declarationCases(before: CurrentCatalog, after: CurrentCatalog, checks: ProposalChecks) {
  const referencedEvidence = (value: unknown, found = new Set<unknown>()): Set<unknown> => {
    if (!value || typeof value !== "object") return found;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "evidence_ids" && Array.isArray(nested)) {
        const ids: unknown[] = nested;
        for (const id of ids) found.add(id);
      } else referencedEvidence(nested, found);
    }
    return found;
  };
  const snapshot = (catalog: CurrentCatalog, portId: string) => {
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
      (item) => isRecord(item.scope) && item.scope.port_id === portId,
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
  const references = (observed: ReturnType<typeof snapshot>, catalog: CurrentCatalog) => ({
    identities: observed.source_records.identities.map((record) => record.id),
    contracts: observed.source_records.contracts.map((record) => record.id),
    qualification: observed.source_records.qualification.map((record) =>
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
                differences(old.port?.[key], proposed.port[key]).length === 0,
            )
            .sort(),
          adapter_references: adapters,
          checks: Object.fromEntries(
            (["accepted", "input", "output"] as const).map((name) => [
              name,
              checks[name].ports.find((port) => isRecord(port) && port.port_id === portId) ?? null,
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

function compatibilityFixtureReview(catalog: CurrentCatalog) {
  return reviewCompatibilityFixture(
    catalog,
    readJson(join(catalogRoot, "catalog-schema1-fixture.json")),
    readFileSync(join(catalogRoot, "catalog-legacy-additions-fixture.json")),
  );
}
const authored = readCatalogSource(catalogRoot);
const current = authored.catalog;
// Listing-only entries can already own reviewed covers before gaining an
// integration. Supply those accepted facts only to artwork preparation; Core's
// accepted operational baseline and compatibility checks remain unchanged.
const acceptedArtwork = {
  ...current,
  ports: [
    ...current.ports,
    ...authored.records
      .filter(({ integration }) => !integration)
      .map(({ listing }) => ({
        id: listing.id,
        name: listing.name,
        project_url: listing.project_url,
        presentation: { artwork: listing.artwork },
      })),
  ],
};

function option(name: string, required: true): string;
function option(name: string, required?: boolean): string | null;
function option(name: string, required = false): string | null {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if ((index >= 0 && (!value || value.startsWith("--"))) || (required && !value))
    throw new Error(`${name} requires a value.`);
  return value ?? null;
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
      "--artwork-ids",
    ]);
    const seen = new Set();
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      if (!name || !allowed.has(name) || seen.has(name))
        throw new Error("Unknown or repeated proposal option.");
      seen.add(name);
      if (!args[index + 1] || args[index + 1]?.startsWith("--"))
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
  const selectedPortIds = option("--artwork-ids")?.split(",");
  const outputRoot = resolve(option("--output-dir", true));
  const cli = option("--validator-cli", fullProposal);
  // Refuse existing output rather than replacing an earlier proposal, recovery
  // receipt or private library. No catalog publication or source mutation.
  mkdirSync(outputRoot);
  const preparationStarted = process.hrtime.bigint();
  let phaseStarted = preparationStarted;
  const phases: { phase: string; elapsed_ms: number }[] = [];
  const finishPhase = (phase: string) => {
    const finished = process.hrtime.bigint();
    phases.push({ phase, elapsed_ms: Number(finished - phaseStarted) / 1e6 });
    phaseStarted = finished;
  };
  let inspectProposal: ReturnType<typeof coreProposalInspector> | undefined;
  let beforeChecks: Pick<ProposalChecks, "accepted" | "input"> | undefined;
  if (fullProposal) {
    const validationRoot = join(outputRoot, "proposal-checks");
    mkdirSync(validationRoot);
    if (!cli) throw new Error("--validator-cli requires a value.");
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
  let imageValidator: ImageValidator | undefined;
  let imageInitializationError: Error | undefined;
  const capturedInspector = inspectProposal;
  const validateImage = capturedInspector
    ? (bytes: Buffer) => {
        if (imageInitializationError) throw imageInitializationError;
        if (!imageValidator) {
          try {
            imageValidator = createCoreImageValidator(
              capturedInspector.artifact,
              join(outputRoot, "scratch"),
            );
          } catch (error) {
            imageInitializationError =
              error instanceof Error
                ? error
                : new Error("Core image initialization failed.", { cause: error });
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
    acceptedCatalog: acceptedArtwork,
    identities,
    refreshPortIds,
    ...(selectedPortIds ? { selectedPortIds } : {}),
  });
  finishPhase("artwork_preparation");
  validateCurrentCatalog(result.catalog);
  const proposalBytes = Buffer.from(`${JSON.stringify(result.catalog, null, 2)}\n`);
  const proposalChecks =
    inspectProposal && beforeChecks
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
    accepted_artwork_context_sha256: digest(acceptedArtwork),
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
  if (fullProposal) {
    if (!proposalChecks) throw new Error("Proposal checks are unavailable.");
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
  }
  process.stdout.write(`${JSON.stringify({ output_dir: outputRoot, metrics: result.metrics })}\n`);
}

const arguments_ = process.argv.slice(2);
const preparing =
  arguments_.includes("--prepare-proposal") || arguments_.includes("--prepare-artwork");
if (
  !preparing &&
  !(
    arguments_.length === 0 ||
    (arguments_.length === 1 && ["--check", "--compare-historical"].includes(arguments_[0] ?? ""))
  )
) {
  throw new Error("Unknown or combined generator arguments; select one supported mode.");
}
if (preparing) {
  await prepareArtworkProposal(process.argv.includes("--prepare-proposal"));
} else if (process.argv.includes("--compare-historical")) {
  const historical = readJson(historicalPath);
  validateCurrentCatalog(historical);
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
  const output = serializeCurrentCatalog(current);
  const listingsOutput = `${JSON.stringify(authored.directory, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (
      readFileSync(outputPath, "utf8") !== output ||
      readFileSync(sourcePath, "utf8") !== output ||
      readFileSync(listingsPath, "utf8") !== listingsOutput
    ) {
      throw new Error("embedded catalog is stale; run node scripts/generate-catalog.mts");
    }
  } else {
    writeFileSync(sourcePath, output);
    writeFileSync(outputPath, output);
    writeFileSync(listingsPath, listingsOutput);
  }
}
