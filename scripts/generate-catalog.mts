import {
  requireOriginalGameDecision,
  checkOriginalGameConsistency,
} from "./catalog-game-review.mts";
import { renderRetainedPreparedTests } from "./catalog-retained-prepared.mts";
import { acceptedPlayerRouteExpectations } from "./package-player-observation.mts";
import { routeEnrollment, renderRouteTests } from "./catalog-route-facts.mts";
import {
  enrollmentTable,
  factsTablePath,
  gateGeneration,
  readGateBaseline,
  serializeEnrollmentTable,
} from "./catalog-generated-registration.mts";
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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareCatalogArtwork,
  prepareCatalogGameMedia,
  createIgdbInspector,
  createCoreImageValidator,
  readArtworkJson,
  readArtworkInput,
  gameMediaImageTarget,
  catalogGameMediaRoles,
} from "./inspect-igdb-artwork.mts";
import type { ArtworkCatalog, ImageValidator } from "./inspect-igdb-artwork.mts";
import {
  prepareCoverArtworkInOperations,
  prepareGameMediaInOperations,
  sceneCoverage,
} from "./artwork-operations.mts";
import {
  managedSetupReleaseAdvice,
  managedSetupReleaseAdviceText,
} from "./catalog-setup-release-advice.mts";
import { isRecord } from "./runtime-values.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import {
  directoryOnlyMedia,
  landscapeCoverListingFormat,
  landscapeCoverMedia,
  originalEditionMediaKey,
} from "./shared-original-media.mts";
import { previewReviewedOriginalMedia } from "./reviewed-original-media.mts";
import { isDeepStrictEqual } from "node:util";

interface Difference {
  path: string;
  before?: unknown;
  after?: unknown;
}
type ProposalChecks = Record<"accepted" | "input" | "output", ProposalReceipt>;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogRoot = join(root, "crates", "portcove-core", "catalog");
const outputPath = join(catalogRoot, "catalog.json");
const listingsPath = join(catalogRoot, catalogSourceNames.listings);
const managedSetupReviewPath = join(
  root,
  "apps",
  "desktop",
  "src",
  "managed-setup-review.generated.json",
);
const enrollmentPath = join(catalogRoot, "route-enrollment.generated.json");
const generatedRegistrationPath = join(catalogRoot, catalogSourceNames.generatedRegistration);
const routeTestRoot = join(root, "crates", "portcove-core", "src", "testdata");
const routeTestPaths = {
  prepared: join(routeTestRoot, "prepared-route-tests.generated.rs"),
  managed: join(routeTestRoot, "managed-route-tests.generated.rs"),
  retained: join(routeTestRoot, "retained-prepared-tests.generated.rs"),
};
const acceptedRouteExpectationsPath = join(
  routeTestRoot,
  "accepted-route-expectations.generated.json",
);
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
            "windows_shipwright_persistence",
            "mod_package_policy",
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
            "launch_disc_choice",
            "windows_tracked_handoff",
            "runtime_subdirectory",
            "n64_runtime_at_executable_parent",
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
    return {
      port,
      source_records: {
        identities,
        contracts,
        validators,
        evidence,
        qualification,
      },
    };
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
          before: {
            port: old.port,
            source_record_refs: references(old, before),
          },
          after: {
            port: proposed.port,
            source_record_refs: references(proposed, after),
          },
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
    source_tables: {
      before: before.source_catalog ?? {},
      after: after.source_catalog ?? {},
    },
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

// Generated registration routes are bookkept by their generated, delta-gated
// table instead of the independently curated additions fixture.
function compatibilityFixtureReview(catalog: CurrentCatalog) {
  const generated = new Set(authored.generation.enrollments.map(({ port_id }) => port_id));
  return reviewCompatibilityFixture(
    { ...catalog, ports: catalog.ports.filter(({ id }) => !generated.has(id)) },
    readJson(join(catalogRoot, "catalog-schema1-fixture.json")),
    readFileSync(join(catalogRoot, "catalog-legacy-additions-fixture.json")),
  );
}
const authored = readCatalogSource(catalogRoot);
// Repository completeness is an authoring/review gate, never a legacy runtime requirement.
if (process.argv.includes("--check")) {
  for (const record of authored.records) requireOriginalGameDecision(record, authored.records);
  checkOriginalGameConsistency(authored.records, true);
}
const current = authored.catalog;
// Listing-only entries can already own reviewed covers before gaining an
// integration. Supply those accepted facts only to artwork preparation; Core's
// accepted operational baseline and compatibility checks remain unchanged.
const regionalCovers = new Map(
  authored.records.flatMap(({ listing, igdb_regional_cover }) =>
    igdb_regional_cover ? [[listing.id, igdb_regional_cover] as const] : [],
  ),
);
const acceptedArtwork = {
  ...current,
  ports: [
    ...current.ports.map((port) => {
      const selection = regionalCovers.get(port.id);
      return selection ? { ...port, igdb_regional_cover: selection } : port;
    }),
    ...authored.records
      .filter(({ integration }) => !integration)
      .map(({ listing, igdb_regional_cover }) => ({
        id: listing.id,
        ...(igdb_regional_cover ? { igdb_regional_cover } : {}),
        name: listing.name,
        project_url: listing.project_url,
        presentation: {
          artwork: listing.artwork,
          collection_covers: listing.collection_covers,
          original_game: listing.original_game,
          media: listing.media,
        },
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

function validateArtworkProposalArguments(fullProposal: boolean) {
  if (process.argv.includes("--check") || process.argv.includes("--compare-historical"))
    throw new Error("Proposal preparation cannot also check or compare historical data.");
  if (fullProposal && process.argv.includes("--prepare-artwork"))
    throw new Error("Cannot combine proposal preparation modes.");
  if (!fullProposal) return;
  const allowed = new Set([
    "--prepare-proposal",
    "--validator-cli",
    "--output-dir",
    "--identities",
    "--refresh-artwork",
    "--credentials-file",
    "--artwork-ids",
    "--hero-media",
    "--media-checkpoint",
    "--media-due-limit",
    "--media-image-budget-mib",
    "--media-provider-checkpoint",
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

function proposalImageValidator(
  inspectProposal: ReturnType<typeof coreProposalInspector> | undefined,
  cli: string | null,
  outputRoot: string,
): ImageValidator {
  let imageValidator: ImageValidator | undefined;
  let imageInitializationError: Error | undefined;
  const capturedInspector = inspectProposal;
  return capturedInspector
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
                : new Error("Core image initialization failed.", {
                    cause: error,
                  });
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
}

function originalSceneScope(game: unknown, subject: Record<string, unknown>) {
  if (
    !isRecord(game) ||
    typeof game.id !== "string" ||
    game.id !== subject.game_id ||
    !Array.isArray(game.source_editions)
  )
    return undefined;
  const edition = (game.source_editions as unknown[]).find(
    (value) => isRecord(value) && value.id === subject.source_edition_id,
  );
  return originalEditionMediaKey(game.id, edition);
}

function splitListingSceneProposal(
  catalog: ArtworkCatalog,
  beforePreparation: CurrentCatalog,
  goneTargets: readonly string[],
  excluded: ReadonlySet<string>,
  directoryOnly: ReadonlySet<string>,
) {
  const accepted = new Map(authored.directory.listings.map((listing) => [listing.id, listing]));
  const baseline = new Map(
    beforePreparation.ports.map(({ id, presentation }) => [id, presentation]),
  );
  const staged = new Map<
    string,
    { legacy: unknown[]; additions: Record<string, unknown>[]; game: unknown }
  >();
  const pending: { port_id: string; asset: Record<string, unknown> }[] = [];
  const gone = new Set(goneTargets);
  const withdrawn = (asset: unknown) => {
    if (!isRecord(asset) || !isRecord(asset.igdb) || typeof asset.igdb.image_id !== "string")
      return false;
    const role = catalogGameMediaRoles.find((role) => role === asset.role);
    return role !== undefined && gone.has(gameMediaImageTarget(role, asset.igdb.image_id));
  };
  const ports = catalog.ports.flatMap((port) => {
    const presentation = port.presentation;
    const listingOnly = directoryOnly.has(port.id);
    if (excluded.has(port.id) || !isRecord(presentation) || !Array.isArray(presentation.media))
      return listingOnly ? [] : [port];
    const media: unknown[] = presentation.media;
    const scenes = media
      .filter(isRecord)
      .filter((asset) => listingOnly || directoryOnlyMedia(asset));
    const legacy = listingOnly ? [] : media.filter((asset) => !directoryOnlyMedia(asset));
    const listing = accepted.get(port.id);
    const acceptedMedia: unknown[] = Array.isArray(listing?.media) ? listing.media : [];
    const acceptedLegacy = acceptedMedia.filter((asset) => !directoryOnlyMedia(asset));
    const matchingProject = listing?.project_url === port.project_url;
    const prior = baseline.get(port.id);
    const priorMedia = isRecord(prior) ? prior.media : undefined;
    const canAlign =
      matchingProject &&
      (listingOnly ||
        priorMedia === undefined ||
        (Array.isArray(priorMedia) &&
          priorMedia.length > 0 &&
          isDeepStrictEqual(priorMedia, acceptedLegacy)));
    const prepared = scenes.filter((asset) => {
      const subject = isRecord(asset.subject) ? asset.subject : null;
      if (listing && canAlign && subject) {
        if (subject.kind === "port" && subject.port_id === port.id) return true;
        const scope = originalSceneScope(listing.original_game, subject);
        if (
          subject.kind === "original" &&
          scope &&
          scope === originalSceneScope(presentation.original_game, subject)
        )
          return true;
      }
      pending.push({ port_id: port.id, asset });
      return false;
    });
    if (
      canAlign &&
      (prepared.length ||
        (legacy.length &&
          acceptedMedia.some(directoryOnlyMedia) &&
          !isDeepStrictEqual(legacy, priorMedia) &&
          !isDeepStrictEqual(legacy, acceptedLegacy)))
    )
      staged.set(port.id, { legacy, additions: prepared, game: presentation.original_game });
    if (listingOnly) return [];
    if (!scenes.length) return port;
    const strictPresentation = { ...presentation };
    if (legacy.length) strictPresentation.media = legacy;
    else delete strictPresentation.media;
    return { ...port, presentation: strictPresentation };
  });
  const listings = authored.directory.listings.flatMap((listing) => {
    if (excluded.has(listing.id)) return [];
    const stage = staged.get(listing.id);
    const media: unknown[] = Array.isArray(listing.media) ? listing.media : [];
    const currentScenes = media.filter(isRecord).filter(directoryOnlyMedia);
    const retained = currentScenes.filter((asset) => {
      if (withdrawn(asset)) return false;
      if (stage && isRecord(asset.subject) && asset.subject.kind === "original") {
        const scope = originalSceneScope(listing.original_game, asset.subject);
        if (!scope || scope !== originalSceneScope(stage.game, asset.subject)) return false;
      }
      return !stage?.additions.some(
        (next) =>
          next.id === asset.id ||
          ((next.role === "header" || next.role === "landscape_cover") &&
            asset.role === next.role &&
            isDeepStrictEqual(next.subject, asset.subject)),
      );
    });
    const legacy = stage?.legacy.length
      ? stage.legacy
      : media.filter(
          (asset) =>
            !directoryOnlyMedia(asset) &&
            (!directoryOnly.has(listing.id) || !withdrawn(asset)) &&
            (!isRecord(asset) || !stage?.additions.some((next) => next.id === asset.id)),
        );
    const nextMedia = [...legacy, ...retained, ...(stage?.additions ?? [])];
    if (!stage && nextMedia.length === media.length) return [];
    const updated = { ...listing };
    if (nextMedia.length) updated.media = nextMedia;
    else delete updated.media;
    return [updated];
  });
  return {
    catalog: { ...catalog, ports },
    directory: {
      format_version: Math.max(
        listings.some(({ media }) => Array.isArray(media) && media.some(landscapeCoverMedia))
          ? landscapeCoverListingFormat
          : 13,
        authored.directory.format_version,
      ),
      listings,
    },
    pending,
  };
}

async function prepareArtworkProposal(fullProposal = false) {
  validateArtworkProposalArguments(fullProposal);
  const checkpoint = option("--media-checkpoint");
  const limit = option("--media-due-limit");
  const imageBudget = option("--media-image-budget-mib");
  const providerCheckpoint = option("--media-provider-checkpoint");
  if (checkpoint === null && limit === null && imageBudget === null && providerCheckpoint === null)
    return prepareArtworkProposalRun(fullProposal);
  if (
    !fullProposal ||
    !checkpoint ||
    !limit ||
    !/^[1-9]\d{0,2}$/u.test(limit) ||
    Number(limit) > 400 ||
    (imageBudget !== null && (!/^[1-9]\d{0,2}$/u.test(imageBudget) || Number(imageBudget) > 512)) ||
    option("--hero-media") !== "igdb" ||
    option("--artwork-ids") !== null ||
    option("--refresh-artwork") !== null
  )
    throw new Error(
      "Game media maintenance requires --prepare-proposal, --hero-media igdb, --media-checkpoint and --media-due-limit 1 through 400",
    );
  const root = resolve(checkpoint);
  const providerRoot = providerCheckpoint === null ? root : resolve(providerCheckpoint);
  const progress = await import("./artwork-preparation-progress.mts");
  progress.openArtworkCheckpoint(root);
  try {
    if (providerRoot !== root) progress.openArtworkCheckpoint(providerRoot);
    try {
      return await prepareArtworkProposalRun(fullProposal, {
        root,
        providerRoot,
        limit: Number(limit),
        progress,
        ...(imageBudget !== null ? { imageBytes: Number(imageBudget) * 1024 * 1024 } : {}),
      });
    } finally {
      if (providerRoot !== root) rmdirSync(join(providerRoot, "active.lock"));
    }
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

async function prepareArtworkProposalRun(
  fullProposal: boolean,
  mediaDue?: {
    root: string;
    providerRoot: string;
    limit: number;
    imageBytes?: number;
    progress: typeof import("./artwork-preparation-progress.mts");
  },
) {
  const captured = readArtworkInput(
    option(fullProposal ? "--prepare-proposal" : "--prepare-artwork", true),
    fullProposal ? 16 * 1024 * 1024 : 8 * 1024 * 1024,
  );
  const input = captured.document;
  validateCurrentCatalog(input);
  if (mediaDue && !isDeepStrictEqual(input, current))
    throw new Error("Game media maintenance requires the current generated operational catalog");
  if (input.ports.some((port) => Object.hasOwn(port, "igdb_regional_cover")))
    throw new Error("IGDB regional cover selections belong in authored port records.");
  const identitiesFile = option("--identities");
  const identities = identitiesFile ? readArtworkJson(identitiesFile, 1024 * 1024) : {};
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
    const inputCheck = inspectProposal.inspect("input", captured.bytes, true);
    finishPhase("input_declarations");
    beforeChecks = {
      accepted,
      input: inputCheck,
    };
  }
  const validateImage = proposalImageValidator(inspectProposal, cli, outputRoot);
  const heroMedia = option("--hero-media");
  if (heroMedia !== null && heroMedia !== "igdb") throw new Error("--hero-media requires igdb.");
  const excludedMedia = new Set(
    heroMedia || authored.reviewedOriginalMedia.size
      ? authored.records.filter(usesScummvmEngine).map(({ listing }) => listing.id)
      : [],
  );
  const acceptedMedia = {
    // A descriptive listing can carry typed media independently of the strict catalog.
    ports: heroMedia
      ? authored.directory.listings.map(({ id, name, project_url, original_game, media }) => ({
          id,
          name,
          project_url,
          presentation: { original_game, media },
        }))
      : [],
  };
  let mediaPlan:
    | ReturnType<(typeof import("./artwork-preparation-progress.mts"))["planDueGameMedia"]>
    | undefined;
  if (mediaDue) {
    const validator = beforeChecks?.input.validator_artifact_sha256;
    if (!validator) throw new Error("Game media maintenance requires a captured Core validator");
    const { acceptedHeroMediaMatches } = await import("./inspect-igdb-artwork.mts");
    const inherited = acceptedHeroMediaMatches(acceptedMedia, excludedMedia);
    const coverPolicy = new Map(
      authored.records.map((record) => [
        record.listing.id,
        [record.igdb_no_shared_cover, record.igdb_regional_cover],
      ]),
    );
    mediaPlan = mediaDue.progress.planDueGameMedia(
      mediaDue.root,
      authored.directory.listings
        .filter(({ id }) => !excludedMedia.has(id))
        .map((listing) => {
          const original = listing.original_game;
          const bindings = original?.source_editions.map((edition) => {
            const scope = originalEditionMediaKey(original.id, edition);
            return scope
              ? {
                  reviewed: authored.reviewedOriginalMedia.get(scope),
                  accepted: inherited.get(scope),
                }
              : undefined;
          });
          const supplied = isRecord(identities) ? identities[listing.id] : undefined;
          return {
            id: listing.id,
            input_sha256: digest({
              version: "game-media-due/4",
              validator,
              id: listing.id,
              name: listing.name,
              project_url: listing.project_url,
              original,
              media: listing.media,
              artwork: listing.artwork,
              collection_covers: listing.collection_covers,
              cover_scope: coverPolicy.get(listing.id),
              bindings,
              supplied,
            }),
          };
        }),
      mediaDue.limit,
    );
  }
  const selectedPortIds = mediaPlan?.selected ?? option("--artwork-ids")?.split(",");
  const refreshPortIds = mediaPlan?.selected ?? option("--refresh-artwork")?.split(",") ?? [];
  // A listing-only subject is selected explicitly in a bounded proposal. It
  // uses its accepted descriptive identity and can never enter the strict file.
  const strictIds = new Set(input.ports.map(({ id }) => id));
  const integrated = new Set(current.ports.map(({ id }) => id));
  const directoryOnly = new Set(
    fullProposal
      ? acceptedMedia.ports
          .filter(({ id }) => !strictIds.has(id) && !integrated.has(id))
          .map(({ id }) => id)
      : [],
  );
  const selected = selectedPortIds && new Set(selectedPortIds);
  const directoryOnlyPorts = selected
    ? acceptedMedia.ports.filter(({ id }) => selected.has(id) && directoryOnly.has(id))
    : [];
  if (
    selected &&
    selectedPortIds &&
    directoryOnlyPorts.length &&
    (selected.size !== selectedPortIds.length ||
      selectedPortIds.some((id) => !strictIds.has(id) && !directoryOnly.has(id)) ||
      refreshPortIds.some((id) => !selected.has(id)))
  )
    throw new Error(
      "Game media worksets require selected catalog identities and matching refresh ids.",
    );
  const scheduledCoverTools =
    mediaDue && mediaPlan && mediaDue.limit <= 48
      ? await import("./listing-scheduled-cover.mts")
      : undefined;
  const coverBudget =
    scheduledCoverTools && mediaDue ? Math.floor((mediaDue.imageBytes ?? 32 * 1024 * 1024) / 4) : 0;
  const coverPreparation =
    scheduledCoverTools && mediaDue && mediaPlan
      ? await (async () => {
          const inspector = createIgdbInspector(
            option("--credentials-file"),
            validateImage,
            undefined,
            {
              onBackoff: (status) =>
                mediaDue.progress.retainArtworkProviderBackoff(mediaDue.providerRoot, status),
              maximumOperationImageBytes: coverBudget,
              signal: AbortSignal.timeout(45_000),
            },
          );
          mediaDue.progress.restoreArtworkProviderBackoff(mediaDue.providerRoot, inspector);
          const selected = await scheduledCoverTools.prepareScheduledCovers(
            authored.records,
            new Set(mediaPlan.selected),
            authored.reviewedOriginalMedia,
            inspector,
          );
          return { ...selected, provider: inspector.providerMetrics };
        })()
      : undefined;
  const inspector = createIgdbInspector(
    option("--credentials-file"),
    validateImage,
    undefined,
    mediaDue && {
      onBackoff: (status) =>
        mediaDue.progress.retainArtworkProviderBackoff(mediaDue.providerRoot, status),
      ...(mediaDue.imageBytes === undefined && !coverPreparation?.provider.image_bytes
        ? {}
        : {
            maximumOperationImageBytes: Math.max(
              0,
              (mediaDue.imageBytes ?? 32 * 1024 * 1024) -
                (coverPreparation?.provider.image_bytes ?? 0),
            ),
          }),
    },
  );
  if (mediaDue) mediaDue.progress.restoreArtworkProviderBackoff(mediaDue.providerRoot, inspector);
  const covers = await prepareCoverArtworkInOperations(
    input,
    mediaPlan ? [] : selectedPortIds?.filter((id) => !directoryOnly.has(id)),
    mediaPlan ? [] : refreshPortIds.filter((id) => !directoryOnly.has(id)),
    (ids, refresh, gone) =>
      prepareCatalogArtwork(input, {
        ...inspector,
        acceptedCatalog: acceptedArtwork,
        identities,
        reviewedOriginalMedia: authored.reviewedOriginalMedia,
        reviewedOriginalMediaExclusions: excludedMedia,
        refreshPortIds: refresh,
        ...(ids ? { selectedPortIds: ids } : {}),
        ...(gone.length ? { knownGoneImageIds: gone } : {}),
      }),
  );
  const gameMedia =
    heroMedia === "igdb"
      ? await prepareGameMediaInOperations(
          {
            ...covers.catalog,
            ports: [
              ...covers.catalog.ports,
              ...directoryOnlyPorts.map(({ presentation: { original_game, media }, ...port }) => ({
                ...port,
                presentation: {
                  original_game,
                  // Other existing media is read from the accepted directory.
                  ...(Array.isArray(media) && media.length === 0 ? { media: [] } : {}),
                },
              })),
            ],
          },
          selectedPortIds,
          (ids, catalog, gone, cleared, held) =>
            prepareCatalogGameMedia(catalog, {
              inspector,
              identities,
              acceptedCatalog: acceptedMedia,
              reviewedOriginalMedia: authored.reviewedOriginalMedia,
              excludedPortIds: excludedMedia,
              explicitClearPortIds: cleared,
              knownGoneMediaTargets: gone,
              knownHeldMediaTargets: held,
              refreshPortIds: ids
                ? refreshPortIds.filter((id) => ids.includes(id))
                : refreshPortIds,
              ...(ids ? { selectedPortIds: ids } : {}),
            }),
        )
      : undefined;
  const result = { ...covers, catalog: gameMedia?.catalog ?? covers.catalog };
  finishPhase("artwork_preparation");
  const sceneProposal =
    fullProposal && gameMedia
      ? splitListingSceneProposal(
          result.catalog,
          input,
          gameMedia.gone_media_targets,
          excludedMedia,
          directoryOnly,
        )
      : null;
  const proposedCatalog = sceneProposal?.catalog ?? result.catalog;
  validateCurrentCatalog(proposedCatalog);
  const proposalBytes = Buffer.from(`${JSON.stringify(proposedCatalog, null, 2)}\n`);
  const proposalChecks =
    inspectProposal && beforeChecks
      ? {
          ...beforeChecks,
          output: inspectProposal.inspect("output", proposalBytes, true),
        }
      : undefined;
  const listingProposal = sceneProposal?.directory.listings.length
    ? Buffer.from(`${JSON.stringify(sceneProposal.directory, null, 2)}\n`)
    : null;
  const listingCheck = listingProposal
    ? inspectProposal?.inspectListings("listing-media", listingProposal)
    : null;
  finishPhase("output_preparation_and_declarations");
  const compatibilityReview = fullProposal
    ? compatibilityFixtureReview(proposedCatalog)
    : undefined;
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
    ...(coverPreparation ? { scheduled_covers: coverPreparation } : {}),
    input_sha256: digest(input),
    accepted_catalog_sha256: digest(current),
    accepted_artwork_context_sha256: digest(acceptedArtwork),
    proposed_catalog_sha256: digest(proposedCatalog),
    differences: differences(input, proposedCatalog),
    records: result.records,
    metrics: result.metrics,
    gone_image_ids: result.gone_image_ids,
    provider_metrics: inspector.providerMetrics,
    ...(gameMedia
      ? {
          game_media: {
            accepted_media_context_sha256: digest(acceptedMedia),
            ...(authored.reviewedOriginalMedia.size
              ? {
                  reviewed_original_media: previewReviewedOriginalMedia(
                    authored.reviewedOriginalMedia,
                    authored.directory.listings,
                    excludedMedia,
                  ),
                }
              : {}),
            ...(listingCheck
              ? {
                  validated_listing_proposal: "listing-media-proposal.json",
                  listing_check: listingCheck,
                }
              : {}),
            ...(sceneProposal?.pending.length ? { unbound_scenes: sceneProposal.pending } : {}),
            records: gameMedia.records,
            gone_media_targets: gameMedia.gone_media_targets,
            ...(gameMedia.held_media_targets?.length
              ? { held_media_targets: gameMedia.held_media_targets }
              : {}),
            coverage: sceneCoverage(acceptedMedia, gameMedia, selectedPortIds),
          },
        }
      : {}),
    scope: gameMedia
      ? "Maintainer cover and remote game-media proposal; no admission, signature, publication, image-payload redistribution, runtime or user-choice mutation."
      : "Maintainer cover proposal; no admission, signature, publication, runtime or user-choice mutation.",
  };
  writeFileSync(join(outputRoot, "catalog-proposal.json"), proposalBytes, {
    flag: "wx",
  });
  if (listingProposal && listingCheck)
    writeFileSync(join(outputRoot, "listing-media-proposal.json"), listingProposal, { flag: "wx" });
  if (mediaDue && mediaPlan && gameMedia && mediaDue.limit <= 48) {
    const { scheduledGameMediaFile, scheduledGameMediaProposal } =
      await import("./listing-scheduled-game-media.mts");
    const data = scheduledGameMediaProposal(gameMedia, mediaPlan.selected);
    if (data.additions.length || coverPreparation?.covers.length)
      writeFileSync(
        join(outputRoot, scheduledGameMediaFile),
        JSON.stringify({
          ...data,
          ...(coverPreparation?.covers.length ? { covers: coverPreparation.covers } : {}),
        }),
        { flag: "wx" },
      );
  }
  const artworkEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(outputRoot, "artwork-evidence.json"), artworkEvidence, { flag: "wx" });
  if (fullProposal) {
    if (!proposalChecks) throw new Error("Proposal checks are unavailable.");
    writeFileSync(
      join(outputRoot, "proposal-evidence.json"),
      `${JSON.stringify(
        {
          format_version: 1,
          accepted_catalog_sha256: digest(current),
          input_catalog_sha256: digest(input),
          proposed_catalog_sha256: digest(proposedCatalog),
          differences: differences(current, proposedCatalog),
          proposal_changes: proposalChanges(current, proposedCatalog),
          declaration_cases: declarationCases(current, proposedCatalog, proposalChecks),
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
  const queue =
    mediaDue && mediaPlan && gameMedia
      ? (() => {
          const provider = inspector.batchStatus();
          mediaDue.progress.retainArtworkProviderBackoff(mediaDue.providerRoot, provider);
          const attempt = mediaPlan.finish(
            [...gameMedia.records, ...(coverPreparation?.progress ?? [])],
            provider.retry_at,
            `sha256:${createHash("sha256").update(artworkEvidence).digest("hex")}`,
          );
          return {
            due: mediaPlan.due,
            selected: mediaPlan.selected.length,
            ...attempt,
            state: attempt.deferred
              ? attempt.attempted
                ? "partial"
                : "deferred"
              : attempt.attempted
                ? "attempted"
                : mediaPlan.selected.length
                  ? "unchanged"
                  : "idle",
          };
        })()
      : undefined;
  process.stdout.write(
    `${JSON.stringify({ output_dir: outputRoot, metrics: result.metrics, ...(queue ? { media_due: queue } : {}) })}\n`,
  );
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
  const releaseUrls = new Map(
    authored.records.map(({ listing }) => [listing.id, listing.release_url]),
  );
  for (const port of current.ports) {
    for (const finding of managedSetupReleaseAdvice(port, releaseUrls.get(port.id))) {
      const { step, kind, literal } = finding;
      process.stderr.write(
        `Catalog authoring advice for ${port.id}, setup step ${step}: ${kind} ${JSON.stringify(literal)}. ${managedSetupReleaseAdviceText}\n`,
      );
    }
  }
  const output = serializeCurrentCatalog(current);
  const listingsOutput = `${JSON.stringify(authored.directory, null, 2)}\n`;
  const managedSetupReview = Object.fromEntries(
    authored.records.flatMap((record) => {
      const { integration, listing, route_facts_v1, managed_setup_platform_warnings } = record;
      const presentation = integration?.presentation;
      const guide =
        isRecord(presentation) && isRecord(presentation.manual_setup)
          ? presentation.manual_setup
          : undefined;
      const managedNative = route_facts_v1?.managed_native;
      if (!guide && !managedNative) return [];
      const step: unknown = Array.isArray(guide?.steps)
        ? guide.steps[0]
        : managedNative?.preparation;
      if (!isRecord(step) || typeof step.instruction !== "string")
        throw new Error(`${listing.id} has no authored managed setup step.`);
      return [
        [
          listing.id,
          managed_setup_platform_warnings
            ? {
                note: step.instruction,
                warnings: guide?.warnings ?? [],
                platform_warnings: managed_setup_platform_warnings,
              }
            : step.instruction,
        ],
      ];
    }),
  );
  const managedSetupReviewOutput = `${JSON.stringify(managedSetupReview, null, 2)}\n`;
  const enrollmentOutput = `${JSON.stringify(routeEnrollment(authored.records), null, 2)}\n`;
  const routeTests = renderRouteTests(authored.records);
  const retainedTests = renderRetainedPreparedTests(routeTestRoot);
  const acceptedRouteExpectationsOutput = `${JSON.stringify(acceptedPlayerRouteExpectations(authored.records), null, 2)}\n`;
  const generatedRegistrationOutput = serializeEnrollmentTable(
    enrollmentTable(authored.generation),
  );
  // The gate's baseline is the committed table at the merge base (pull
  // requests) or the previous commit (pushes), never the working tree, so
  // repeated runs and hand edits cannot widen one change beyond the bounds.
  const gitRunner = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : undefined;
  };
  const gateDelta = gateGeneration(
    readGateBaseline(process.env, gitRunner),
    authored.generation,
    readGateBaseline(process.env, gitRunner, factsTablePath),
  );
  if (process.argv.includes("--check")) {
    if (
      !existsSync(generatedRegistrationPath) ||
      readFileSync(generatedRegistrationPath, "utf8") !== generatedRegistrationOutput ||
      readFileSync(acceptedRouteExpectationsPath, "utf8") !== acceptedRouteExpectationsOutput ||
      readFileSync(routeTestPaths.prepared, "utf8") !== routeTests.prepared ||
      readFileSync(routeTestPaths.managed, "utf8") !== routeTests.managed ||
      readFileSync(routeTestPaths.retained, "utf8") !== retainedTests ||
      readFileSync(enrollmentPath, "utf8") !== enrollmentOutput ||
      readFileSync(outputPath, "utf8") !== output ||
      readFileSync(listingsPath, "utf8") !== listingsOutput ||
      readFileSync(managedSetupReviewPath, "utf8") !== managedSetupReviewOutput
    ) {
      throw new Error("embedded catalog is stale; run node scripts/generate-catalog.mts");
    }
  } else {
    const changed = gateDelta.added.length + gateDelta.withdrawn.length + gateDelta.changed.length;
    if (changed)
      process.stderr.write(
        `Generated registration delta against the gate baseline: ${JSON.stringify(gateDelta)}\n`,
      );
    writeFileSync(generatedRegistrationPath, generatedRegistrationOutput);
    mkdirSync(routeTestRoot, { recursive: true });
    writeFileSync(acceptedRouteExpectationsPath, acceptedRouteExpectationsOutput);
    writeFileSync(routeTestPaths.prepared, routeTests.prepared);
    writeFileSync(routeTestPaths.managed, routeTests.managed);
    writeFileSync(routeTestPaths.retained, retainedTests);
    writeFileSync(enrollmentPath, enrollmentOutput);
    writeFileSync(outputPath, output);
    writeFileSync(listingsPath, listingsOutput);
    writeFileSync(managedSetupReviewPath, managedSetupReviewOutput);
  }
}
