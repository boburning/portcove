import { mkdirSync, mkdtempSync, lstatSync, readFileSync, writeFileSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  assembleCatalogRecords,
  checkedAuthoredPort,
  readCatalogSource,
  reviewCompatibilityFixture,
  parseCatalogSource,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { coreProposalInspector } from "./catalog-authoring-inspector.mts";
import { collectPortFacts, githubRepository } from "./port-upstream-facts.mts";
import type { PortFactsOptions } from "./port-upstream-facts.mts";
import {
  prepareCatalogArtwork,
  createIgdbInspector,
  createCoreImageValidator,
  readArtworkJson,
  readArtworkInput,
} from "./inspect-igdb-artwork.mts";
import type {
  ArtworkCatalog,
  ArtworkPreparationOptions,
  ImageValidator,
} from "./inspect-igdb-artwork.mts";
import { observationHash } from "./upstream-observer.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import {
  assessUpstreamLineage,
  checkLineageChange,
  checkObservedRepository,
} from "./upstream-lineage.mts";

interface PrepareOptions {
  catalogRoot: string;
  outputDirectory: string;
  record?: unknown;
  projectUrl?: string | undefined;
  issue?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  summary?: string | undefined;
  route?: "listing" | "download";
  releaseTag?: string | undefined;
  identities?: unknown;
  validatorCli?: string | undefined;
  credentialsFile?: string | undefined;
  facts?: Pick<PortFactsOptions, "fetcher" | "now" | "token">;
  artwork?: Pick<ArtworkPreparationOptions, "inspectGame" | "inspectImage">;
}
const owner = { format_version: 1, tool: "portcove-prepare-port" };
type PackageFacts = Pick<
  Awaited<ReturnType<typeof collectPortFacts>>,
  "assets" | "assets_complete"
> &
  Partial<Pick<Awaited<ReturnType<typeof collectPortFacts>>, "release">>;

/** Authoring feedback only. Filename matches never establish executable or lifecycle fit. */
export function portablePreparationFeedback(record: AuthoredPort, facts: PackageFacts) {
  if (record.integration?.adapter !== "native-portable") return undefined;
  const release = record.integration.release;
  const hints = isRecord(release) && isRecord(release.asset_hints) ? release.asset_hints : {};
  const platforms = Array.isArray(record.integration.platforms)
    ? record.integration.platforms.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...packageHintFeedback(hints, platforms, facts, (name) =>
      /\.(?:zip|tar\.gz|tgz)$/iu.test(name),
    ),
    persistence: Array.isArray(record.integration.persistent_paths)
      ? record.integration.persistent_paths
      : [],
    manual_setup: {
      completion_record: record.integration.setup_marker ?? null,
      next: "For manual preparation before Play, use an upstream atomically published JSON completion record beneath already declared player data when that contract exists. Core checks bounded structural progress only; upstream still owns edition/content validation. Native capability 2 is required. Do not invent a marker, execute a discovered helper, or add a marker for a game's own first-Play picker.",
    },
    launch_identity: {
      original_game_title: record.listing.original_game_title ?? null,
      next: record.listing.original_game_title
        ? "Keep this underlying game title separate from its implementation and helper names."
        : "Supply listing.original_game_title from the canonical game identity; do not make players distinguish the player from compiler or converter helpers.",
    },
    launch_lifetime_review:
      "Verify that the selected process stays alive through edition dispatch and settings restarts, or uses a supported tracked handoff. A launcher that starts a successor and exits needs a non-owning route until its full lifetime is supported; do not bypass useful upstream setup to fit management.",
    data_review:
      "Review runtime writes as well as saves: original inputs, generated content, mods, logs and fallback locations. An empty contract needs evidence that ordinary data lives outside the runtime; disclose external backup limits. Self-replacement and version-dependent regeneration need another supported route. Generated executable caches need compatible producer identity or supported invalidation, not just a declared directory or ABI label.",
    scope:
      "Authoring observations only; Core retains package selection, trust and mutation authority.",
  };
}

/** Read-only authoring context; canonical prose never becomes operation authority. */
export function canonicalPreparationFeedback(
  record: AuthoredPort,
  facts: Pick<Awaited<ReturnType<typeof collectPortFacts>>, "observations">,
) {
  const number = record.listing.issue_number;
  if (number === undefined) return undefined;
  const endpoint = `https://api.github.com/repos/boburning/portcove/issues/${number}`;
  const observation = facts.observations.find(
    (fact) => fact.endpoint === endpoint && fact.status !== "unavailable",
  );
  const issue = isRecord(observation?.body) ? observation.body : undefined;
  const specification =
    issue && !issue.pull_request && typeof issue.body === "string" ? issue.body : undefined;
  return {
    issue_number: number,
    url: `https://github.com/boburning/portcove/issues/${number}`,
    specification: {
      status: specification === undefined ? "not-observed" : "observed",
      facts_endpoint: endpoint,
      observed_at: observation?.observed_at ?? null,
      body_sha256:
        specification === undefined
          ? null
          : createHash("sha256").update(specification, "utf8").digest("hex"),
      location: "files.upstream -> observations[facts_endpoint].body.body",
    },
    authored_acquisition_condition: record.listing.download_block_reason ?? null,
    next:
      specification === undefined
        ? "The canonical specification was not observed in this preparation. Read the owning Roadmap context or prepare with --issue before deciding route, lineage, acquisition conditions or deferrals."
        : "Read the complete retained canonical specification and relevant Roadmap context before deciding route, lineage, acquisition conditions or deferrals. An upstream README, published package, checksum or technical adapter fit does not resolve an existing named condition.",
    scope:
      "Authoring reminder only. No prose is classified into a hold, grant, support state or management right. Preserve reviewed authored conditions; Core remains the operation authority. No additional request or approval is introduced.",
  };
}

export function downloadPreparationFeedback(record: AuthoredPort, facts: PackageFacts) {
  const hints = record.listing.download_asset_hints;
  if (!hints || !Object.keys(hints).length) return undefined;
  return {
    ...packageHintFeedback(hints, Object.keys(hints), facts),
    scope:
      "Advisory self-service selection only; no package authentication, helper invocation or managed ownership is granted. An absent publisher hash remains explicitly unverified.",
  };
}

function packageHintFeedback(
  hints: Record<string, unknown>,
  platforms: readonly string[],
  facts: PackageFacts,
  eligibleName?: (name: string) => boolean,
) {
  const tag =
    isRecord(facts.release?.body) && typeof facts.release.body.tag_name === "string"
      ? facts.release.body.tag_name
      : null;
  const versions =
    tag && /\d+\.\d+/u.test(tag)
      ? [...new Set([tag.toLowerCase(), tag.replace(/^v(?=\d)/iu, "").toLowerCase()])]
      : [];
  return {
    assets_complete: facts.assets_complete,
    maintenance: {
      observed_release_tag: tag,
      observed_provider_prerelease:
        isRecord(facts.release?.body) && typeof facts.release.body.prerelease === "boolean"
          ? facts.release.body.prerelease
          : null,
      potential_version_restrictions: platforms.flatMap((platform) => {
        const values = hints[platform];
        const restricted = Array.isArray(values)
          ? values.filter(
              (value) =>
                typeof value === "string" &&
                versions.some((version) => value.toLowerCase().includes(version)),
            )
          : [];
        return restricted.length ? [{ platform, hints: restricted }] : [];
      }),
      next: "Keep ordinary compatible N/N+1 progression independent of definition edits: use stable project, platform, architecture and package-variant rules, then exercise the production resolver with unchanged rules. A real restriction needs a supported exact pin with its reason and reconsideration condition, never latest plus an old filename. Numeric ABI or engine-generation tokens can be deliberate; review applicability rather than stripping them blindly. Check Core’s channel classification against the release tag as well as the provider prerelease flag; a -alpha, -preview or -nightly tag can select Preview with that flag unset. These observations do not classify a channel or override a player’s saved choice.",
      scope:
        "Definition-authoring advice only; changing observed names, URLs, sizes and independent digests do not require routine definition edits or a new per-release approval.",
    },
    platforms: platforms.map((platform) => {
      const values = hints[platform];
      const needles = Array.isArray(values)
        ? values.filter((value): value is string => typeof value === "string" && Boolean(value))
        : [];
      const matches = facts.assets.filter(
        (asset): asset is Record<string, unknown> & { name: string } => {
          if (!isRecord(asset) || typeof asset.name !== "string" || !needles.length) return false;
          const name = asset.name.toLowerCase();
          return (
            (!eligibleName || eligibleName(name)) &&
            needles.every((hint) => name.includes(hint.toLowerCase()))
          );
        },
      );
      return {
        platform,
        hint_matches: matches.map((asset) => ({
          name: asset.name,
          published_sha256:
            typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(asset.digest),
        })),
        next: !facts.assets_complete
          ? "Resolve incomplete selected-release assets before assessing package uniqueness."
          : matches.length !== 1
            ? "Review discriminating package hints; the selected release does not have exactly one literal match."
            : "Review native headers, launch location, setup, update ownership and data compatibility; a filename match does not establish fit. Bind an independently expected digest before managed acquisition.",
      };
    }),
  };
}
function openCheckpoint(directory: string) {
  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "owner.json"), JSON.stringify(owner), { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = lstatSync(directory);
  const ownerInfo = lstatSync(join(directory, "owner.json"));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !ownerInfo.isFile() ||
    ownerInfo.isSymbolicLink() ||
    observationHash(readArtworkJson(join(directory, "owner.json"))) !== observationHash(owner)
  )
    throw new Error("Output directory is not a recognized preparation checkpoint.");
  mkdirSync(join(directory, "active.lock"));
}
function immutableJson(directory: string, name: string, value: unknown) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(directory, `${name}-${createHash("sha256").update(bytes).digest("hex")}.json`);
  try {
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== Buffer.byteLength(bytes) ||
      readFileSync(file, "utf8") !== bytes
    )
      throw new Error("An existing preparation artifact differs; retained it for reconciliation.");
  }
  return file;
}
function artworkCatalog(records: readonly AuthoredPort[]): ArtworkCatalog {
  return {
    ports: records.map(({ listing, integration }) => ({
      id: listing.id,
      name: listing.name,
      project_url: listing.project_url,
      ...(listing.original_game_title
        ? {
            underlying_game: {
              names: [listing.original_game_title],
              project_url: listing.project_url,
              evidence_url: listing.project_url,
            },
          }
        : {}),
      ...(integration?.source_profile ? { source_profile: integration.source_profile } : {}),
      presentation: { ...(listing.artwork ? { artwork: listing.artwork } : {}) },
    })),
  };
}
function cachedValue(directory: string, key: string, input: string): unknown {
  const file = join(directory, `${key}-${input}.json`);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Preparation receipt must be a regular file.");
    const value = readArtworkJson(file);
    if (
      !isRecord(value) ||
      value.input_sha256 !== input ||
      value.result_sha256 !== observationHash(value.result)
    )
      throw new Error("Preparation receipt identity mismatch.");
    return value.result;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}
function retainValue(directory: string, key: string, input: string, result: unknown) {
  writeFileSync(
    join(directory, `${key}-${input}.json`),
    JSON.stringify({ input_sha256: input, result_sha256: observationHash(result), result }),
    { flag: "wx", mode: 0o600 },
  );
}

type ArtworkOptions = Pick<
  PrepareOptions,
  "catalogRoot" | "outputDirectory" | "identities" | "validatorCli" | "credentialsFile" | "artwork"
>;

function artworkInspector(options: ArtworkOptions, root: string) {
  let imageValidator: ImageValidator | undefined;
  const validateImage: ImageValidator = (bytes) => {
    if (!options.validatorCli) throw new Error("Core image validation requires a compatible CLI.");
    imageValidator ??= createCoreImageValidator(options.validatorCli, join(root, "images"));
    return imageValidator(bytes);
  };
  return options.artwork ?? createIgdbInspector(options.credentialsFile, validateImage);
}

function preparationCosts(started: bigint) {
  return {
    clock: "process.hrtime.bigint",
    elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
    elapsed_boundary:
      "Function entry through proposal and receipt preparation; includes provider/subprocess waiting, excludes CLI parsing and final completion write.",
  };
}

function preparedRecordOutputs(
  options: ArtworkOptions,
  root: string,
  authored: ReturnType<typeof readCatalogSource>,
  records: readonly AuthoredPort[],
  artworkResult: unknown,
  artworkReused: boolean,
  validatorIdentity: string | null,
) {
  if (
    !isRecord(artworkResult) ||
    !isRecord(artworkResult.catalog) ||
    !Array.isArray(artworkResult.catalog.ports)
  )
    throw new Error("Malformed artwork preparation receipt.");
  const mapped = new Map(
    artworkResult.catalog.ports.filter(isRecord).map((port) => [port.id, port]),
  );
  const proposed = records.map((entry) => {
    const copy = structuredClone(entry);
    const presentation = mapped.get(copy.listing.id)?.presentation;
    if (isRecord(presentation) && presentation.artwork !== undefined)
      copy.listing.artwork = presentation.artwork;
    else delete copy.listing.artwork;
    return checkedAuthoredPort(copy);
  });
  const shared: Record<string, unknown> = structuredClone(authored.catalog);
  delete shared.ports;
  const assembled = assembleCatalogRecords(shared, proposed);
  const operationalChanged =
    observationHash(authored.catalog) !== observationHash(assembled.catalog);
  let inspector: ReturnType<typeof coreProposalInspector> | undefined;
  const inspect = (kind: "core" | "listings-core", document: unknown) => {
    if (!options.validatorCli)
      throw new Error("Core validation requires --validator-cli with the matching schema.");
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const key = observationHash({
      input: createHash("sha256").update(bytes).digest("hex"),
      validator: validatorIdentity,
    });
    let receipt = cachedValue(root, kind, key);
    if (receipt === undefined) {
      inspector ??= coreProposalInspector(
        options.validatorCli,
        mkdtempSync(join(root, "core-inspection-")),
      );
      receipt =
        kind === "core"
          ? inspector.inspect("proposal", bytes)
          : inspector.inspectListings("listings", bytes);
      if (!isRecord(receipt) || receipt.validator_artifact_sha256 !== validatorIdentity)
        throw new Error(
          "Validator changed during preparation; retry with a stable trusted artifact.",
        );
      retainValue(root, kind, key, receipt);
    }
    return receipt;
  };
  let validation: unknown = {
    status: "unchanged-operational-projection",
    scope: "Per-record listing structure checked; final Core catalog/listing CI still applies.",
  };
  if (operationalChanged) {
    if (!options.validatorCli)
      throw new Error("Operational changes require --validator-cli with the matching Core schema.");
    validation = inspect("core", assembled.catalog);
  }
  const listingValidation = options.validatorCli
    ? inspect("listings-core", assembled.directory)
    : {
        status: "core-inspection-pending",
        scope:
          "Listing structure checked locally; use --validator-cli or ordinary CI for Core validation.",
      };
  const compatibility = reviewCompatibilityFixture(
    assembled.catalog,
    readArtworkJson(join(options.catalogRoot, "catalog-schema1-fixture.json")),
    readFileSync(join(options.catalogRoot, "catalog-legacy-additions-fixture.json")),
  );
  const changed = assembled.records.filter(
    (entry) =>
      observationHash(entry) !==
      observationHash(authored.records.find((old) => old.listing.id === entry.listing.id) ?? null),
  );
  const files = {
    records: changed.map((entry) => ({
      id: entry.listing.id,
      path: immutableJson(root, entry.listing.id, entry),
    })),
    catalog: immutableJson(root, "catalog", assembled.catalog),
    listings: immutableJson(root, "listings", assembled.directory),
    artwork: immutableJson(root, "artwork-evidence", artworkResult),
  };
  return {
    accepted_catalog_sha256: observationHash(authored.catalog),
    accepted_listings_sha256: observationHash(authored.directory),
    changed_records: changed.map((entry) => entry.listing.id),
    record_changes: changed.map((entry) => {
      const before = authored.records.find((old) => old.listing.id === entry.listing.id);
      return {
        id: entry.listing.id,
        action: before ? "modified" : "added",
        before_sha256: before ? observationHash(before) : null,
        after_sha256: observationHash(entry),
        listing_fields: [
          ...new Set([...Object.keys(before?.listing ?? {}), ...Object.keys(entry.listing)]),
        ]
          .filter(
            (field) =>
              observationHash(before?.listing[field] ?? null) !==
              observationHash(entry.listing[field] ?? null),
          )
          .sort(),
        integration_changed:
          observationHash(before?.integration ?? null) !==
          observationHash(entry.integration ?? null),
      };
    }),
    operational_changed: operationalChanged,
    validation,
    listing_validation: listingValidation,
    compatibility,
    artwork_reused: artworkReused,
    files,
  };
}

/** Unsigned local proposal preparation. Authored records and accepted outputs are never edited. */
export async function preparePort(options: PrepareOptions) {
  const started = process.hrtime.bigint();
  const root = resolve(options.outputDirectory);
  const authored = readCatalogSource(options.catalogRoot);
  const explicit = options.record === undefined ? undefined : checkedAuthoredPort(options.record);
  const validatorIdentity = options.validatorCli
    ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
    : null;
  if (explicit && options.id && explicit.listing.id !== options.id)
    throw new Error("Record and selected stable ID differ.");
  const selected = authored.records.find((record) => record.listing.id === options.id);
  const resolveIdentity = (projectUrl: string, issuePortId?: string) => {
    const matching = authored.records.filter((record) => record.listing.project_url === projectUrl);
    if (!explicit && !options.id && !issuePortId && matching.length > 1)
      throw new Error("Several implementations share this upstream; select the stable ID.");
    const suggested = githubRepository(projectUrl)
      ?.split("/")[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
    const id =
      explicit?.listing.id ?? options.id ?? issuePortId ?? matching[0]?.listing.id ?? suggested;
    if (!id) throw new Error("Supply a stable --id for this project.");
    if (issuePortId && issuePortId !== id)
      throw new Error("Canonical issue and proposed stable ID differ.");
    const previous = authored.records.find((record) => record.listing.id === id);
    const base = explicit ?? previous;
    if (
      previous?.listing.download_block_reason !== undefined &&
      base?.listing.download_block_reason !== previous.listing.download_block_reason
    )
      throw new Error(
        "Preparation cannot remove or change an authored download restriction; resolve its canonical condition in a reviewed source edit.",
      );
    return { id, previous, base };
  };
  openCheckpoint(root);
  try {
    const facts = await collectPortFacts({
      ...options.facts,
      projectUrl:
        options.projectUrl ?? explicit?.listing.project_url ?? selected?.listing.project_url,
      issue: options.issue,
      route: options.route ?? "listing",
      releaseTag: options.releaseTag,
      resolveReleaseUrl: ({ projectUrl, issuePortId }) => {
        const { base } = resolveIdentity(projectUrl, issuePortId);
        if (!base?.integration) return base?.listing.release_url;
        const release = base.integration.release;
        return isRecord(release) &&
          (release.provider === undefined || release.provider === "github") &&
          typeof release.repository === "string"
          ? `https://github.com/${release.repository}`
          : null;
      },
      cacheDirectory: join(root, "facts"),
    });
    const { id, previous, base } = resolveIdentity(facts.project_url, facts.issue?.id);
    const metadata = isRecord(facts.project?.body) ? facts.project.body : {};
    let record = checkedAuthoredPort({
      ...(base ?? { format_version: 1 }),
      listing: {
        ...base?.listing,
        id,
        project_url: facts.project_url,
        name: options.name ?? base?.listing.name ?? facts.issue?.name ?? metadata.name,
        summary:
          options.summary ??
          base?.listing.summary ??
          (typeof metadata.description === "string" && metadata.description.trim()
            ? metadata.description
            : "Upstream project; setup requirements have not been reviewed."),
        ...(facts.issue ? { issue_number: facts.issue.number } : {}),
      },
    });
    if (previous) checkLineageChange(previous, record);
    checkObservedRepository(record, metadata.id);
    if (
      !record.integration &&
      !(
        record.listing.release_url &&
        /^\/[^/]+\/[^/]+\/releases\/?$/u.test(new URL(record.listing.release_url).pathname)
      ) &&
      facts.assets_complete &&
      facts.assets.length &&
      isRecord(facts.release?.body) &&
      typeof facts.release.body.html_url === "string"
    ) {
      // Asset presence alone cannot establish that a usable game package exists.
      // Keep availability/platform claims authored by the selected route's reviewer.
      // Managed release facts belong in the observation receipt, not an automatic
      // version-specific listing edit. Preserve an authored release feed too;
      // observing one release must not replace its deliberate ongoing route.
      record.listing.release_url = facts.release.body.html_url;
      record = checkedAuthoredPort(record);
    }
    const records = authored.records.filter((entry) => entry.listing.id !== id).concat(record);
    const acceptedArtwork = artworkCatalog(authored.records);
    const proposalArtwork = artworkCatalog(records);
    const identities = options.identities ?? {};
    const artworkKey = observationHash({
      acceptedArtwork,
      proposalArtwork,
      identities,
      validatorIdentity,
    });
    let artworkResult = cachedValue(root, "artwork", artworkKey);
    let artworkReused = artworkResult !== undefined;
    // Reuse successful preparation; a fallback remains independently retryable.
    if (
      isRecord(artworkResult) &&
      isRecord(artworkResult.metrics) &&
      Number(artworkResult.metrics.fallback) > 0
    ) {
      artworkResult = undefined;
      artworkReused = false;
    }
    if (artworkResult === undefined) {
      artworkResult = await prepareCatalogArtwork(proposalArtwork, {
        acceptedCatalog: acceptedArtwork,
        selectedPortIds: [id],
        identities,
        ...artworkInspector(options, root),
      });
      if (
        isRecord(artworkResult) &&
        isRecord(artworkResult.metrics) &&
        Number(artworkResult.metrics.fallback) === 0
      )
        retainValue(root, "artwork", artworkKey, artworkResult);
    }
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      records,
      artworkResult,
      artworkReused,
      validatorIdentity,
    );
    const report = {
      format_version: 1,
      port_id: id,
      route: record.integration ? "existing-integration" : (options.route ?? "listing"),
      lineage: assessUpstreamLineage(record),
      canonical_preparation: canonicalPreparationFeedback(record, facts),
      portable_preparation: portablePreparationFeedback(record, facts),
      download_preparation: downloadPreparationFeedback(record, facts),
      ...prepared,
      files: { ...prepared.files, upstream: immutableJson(root, "upstream", facts) },
      preparation_costs: preparationCosts(started),
      limits: facts.observations
        .filter((fact) => fact.status === "unavailable")
        .map(({ endpoint, reason, retry_after }) => ({ endpoint, reason, retry_after })),
      next:
        options.route === "download" && !facts.assets_complete
          ? "Select an exact release or resolve the incomplete asset observation before package selection."
          : "Review the proposed record files, copy accepted records into catalog/ports, regenerate, and complete the applicable review and delivery checks.",
      scope:
        "Prepared local records only; listing visibility, executable acceptance and published user delivery are separate outcomes. No download, engine execution, issue mutation, signing or publication.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

/** Cover-only work on existing authored identities; no upstream metadata collection. */
export async function prepareArtworkBatch(
  options: ArtworkOptions & {
    selectedPortIds: readonly string[];
    refreshPortIds?: readonly string[];
  },
) {
  const started = process.hrtime.bigint();
  const root = resolve(options.outputDirectory);
  const authored = readCatalogSource(options.catalogRoot);
  const known = new Set(authored.records.map((record) => record.listing.id));
  const selected = new Set(options.selectedPortIds);
  const refreshPortIds = options.refreshPortIds ?? [];
  if (
    !selected.size ||
    selected.size > 400 ||
    selected.size !== options.selectedPortIds.length ||
    [...selected].some((id) => !known.has(id))
  )
    throw new Error("Artwork batch requires 1 to 400 unique known stable IDs.");
  if (
    new Set(refreshPortIds).size !== refreshPortIds.length ||
    refreshPortIds.some((id) => !selected.has(id))
  )
    throw new Error("Artwork refresh requires unique IDs within the selected workset.");
  const validatorIdentity = options.validatorCli
    ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
    : null;
  const acceptedArtwork = artworkCatalog(authored.records);
  const identities = options.identities ?? {};
  const artworkKey = observationHash({
    acceptedArtwork,
    identities,
    validatorIdentity,
    selectedPortIds: [...selected],
    refreshPortIds,
  });
  openCheckpoint(root);
  try {
    let artworkResult = cachedValue(root, "artwork-batch", artworkKey);
    const artworkReused = artworkResult !== undefined;
    if (artworkResult === undefined) {
      const inspector = artworkInspector(options, root);
      const result = await prepareCatalogArtwork(acceptedArtwork, {
        acceptedCatalog: acceptedArtwork,
        selectedPortIds: [...selected],
        refreshPortIds,
        identities,
        ...inspector,
      });
      artworkResult = {
        ...result,
        ...("providerMetrics" in inspector ? { provider_metrics: inspector.providerMetrics } : {}),
      };
      if (result.metrics.fallback === 0)
        retainValue(root, "artwork-batch", artworkKey, artworkResult);
    }
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      authored.records,
      artworkResult,
      artworkReused,
      validatorIdentity,
    );
    if (!isRecord(artworkResult) || !Array.isArray(artworkResult.records))
      throw new Error("Malformed artwork batch receipt.");
    const pendingPortIds: string[] = [];
    for (const record of artworkResult.records) {
      if (!isRecord(record) || typeof record.port_id !== "string" || !known.has(record.port_id))
        throw new Error("Malformed artwork batch record identity.");
      if (record.mapping === null) pendingPortIds.push(record.port_id);
    }
    const report = {
      format_version: 1,
      route: "artwork-only",
      selected_port_ids: [...selected],
      refresh_port_ids: refreshPortIds,
      pending_port_ids: pendingPortIds,
      ...prepared,
      preparation_costs: preparationCosts(started),
      upstream_collection: "not-requested",
      next: "Review and copy the proposed per-ID records, regenerate, then retry only pending IDs. Use a new checkpoint for a fresh scheduled refresh of unchanged mappings.",
      scope:
        "Bounded cover proposals against the full authored catalog. Accepted sources, local artwork choices and delivery authority are unchanged; no upstream release investigation, download or execution.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--project",
    "--issue",
    "--id",
    "--name",
    "--summary",
    "--record",
    "--route",
    "--release-tag",
    "--identities",
    "--validator-cli",
    "--credentials-file",
    "--output-dir",
    "--artwork-ids",
    "--refresh-artwork",
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index]!;
    const value = process.argv[index + 1];
    if (!allowed.has(name) || values.has(name) || !value || value.startsWith("--"))
      throw new Error("Unknown, repeated or missing prepare-port option.");
    values.set(name, value);
  }
  const output = values.get("--output-dir");
  if (!output) throw new Error("--output-dir is required (a new or owned preparation checkpoint).");
  const artworkIds = values.get("--artwork-ids");
  const refreshIds = values.get("--refresh-artwork");
  if (
    artworkIds &&
    [...values.keys()].some(
      (name) =>
        ![
          "--artwork-ids",
          "--refresh-artwork",
          "--identities",
          "--validator-cli",
          "--credentials-file",
          "--output-dir",
        ].includes(name),
    )
  )
    throw new Error("Artwork-only batches cannot mix project, issue, record or release options.");
  if (refreshIds && !artworkIds) throw new Error("--refresh-artwork requires --artwork-ids.");
  const route = values.get("--route") ?? "listing";
  if (route !== "listing" && route !== "download")
    throw new Error("--route must be listing or download.");
  const input = values.get("--record");
  const identities = values.get("--identities");
  const common = {
    catalogRoot: join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      "crates",
      "portcove-core",
      "catalog",
    ),
    outputDirectory: output,
    ...(identities ? { identities: readArtworkJson(identities, 1024 * 1024) } : {}),
    validatorCli: values.get("--validator-cli"),
    credentialsFile: values.get("--credentials-file"),
  };
  const result = artworkIds
    ? await prepareArtworkBatch({
        ...common,
        selectedPortIds: artworkIds.split(","),
        ...(refreshIds ? { refreshPortIds: refreshIds.split(",") } : {}),
      })
    : await preparePort({
        ...common,
        projectUrl: values.get("--project"),
        issue: values.get("--issue"),
        id: values.get("--id"),
        name: values.get("--name"),
        summary: values.get("--summary"),
        ...(input
          ? {
              record: parseCatalogSource(
                readArtworkInput(input, 512 * 1024).bytes.toString("utf8"),
              ),
            }
          : {}),
        route,
        releaseTag: values.get("--release-tag"),
        facts: { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
      });
  process.stdout.write(
    `${JSON.stringify(
      {
        ...("port_id" in result.report
          ? { port_id: result.report.port_id }
          : { selected_port_ids: result.report.selected_port_ids }),
        report: result.path,
        files: result.report.files,
        next: result.report.next,
      },
      null,
      2,
    )}\n`,
  );
}
