import {
  originalGamePreparationFeedback,
  requireOriginalGameDecision,
} from "./catalog-game-review.mts";
import { listingDownloadBlockReason } from "./catalog-acquisition-restrictions.mts";
import {
  acceptPackagePlayerObservation,
  checkPackagePlayerObservationContinuity,
  packagePlayerProjection,
  packagePlayerProjectionKey,
} from "./package-player-observation.mts";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { runCheckedGit } from "./checked-git.mts";
import {
  assembleCatalogRecords,
  compactGbaArchive,
  catalogSourceNames,
  listingDownloadAssetHints,
  checkedAuthoredPort,
  readCatalogSource,
  reviewCompatibilityFixture,
  parseCatalogSource,
  projectAuthoredPort,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import {
  managedSetupReleaseAdvice,
  managedSetupReleaseAdviceText,
} from "./catalog-setup-release-advice.mts";
import { credentialFree } from "./catalog-released-reader.mts";
import type { AcquiredReleasedReader } from "./catalog-released-reader.mts";
import { coreProposalInspector } from "./catalog-authoring-inspector.mts";
import { listedRepositories } from "./catalog-generated-registration.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import { validArtworkMapping, validArtworkCollection } from "./catalog-cover-mapping.mts";
import {
  listingDeliveryMaximum,
  decodeRetainedCompactListing,
} from "./listing-directory-carrier.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { compactPsxManagedWindows } from "./catalog-psx-managed-windows.mts";
import { compactN64RecompPersistence } from "./catalog-n64-recomp-persistence.mts";
import {
  BoundRepositoryUnavailable,
  collectPortFacts,
  discoveryScopePolicy,
  githubRepository,
} from "./port-upstream-facts.mts";
import type { PortFactsOptions } from "./port-upstream-facts.mts";
import { compactReviewedFlatPackageLayout } from "./catalog-reviewed-flat-package-layout.mts";
import {
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
import {
  prepareArtworkWorkset,
  readKnownGoneArtwork,
  retainedCoverDigests,
} from "./artwork-preparation-progress.mts";
import { observationHash } from "./upstream-observer.mts";
import { listingDeclarationHash } from "./listing-upstream-observation.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import { collectSettingsSource, qualifySettingsObservation } from "./settings-qualification.mts";
import { prepareSettingsCandidate } from "./prepare-settings-candidate.mts";
import { reconcileDiscoverySnapshot } from "./discovery-reconciliation.mts";
import type { CanonicalDiscoveryIdentity } from "./discovery-reconciliation.mts";
import {
  assessUpstreamLineage,
  checkLineageChange,
  checkObservedRepository,
  identityUrl,
} from "./upstream-lineage.mts";

interface PrepareOptions {
  catalogRoot: string;
  outputDirectory: string;
  record?: unknown;
  packageObservation?: { receipt: unknown; reference: string };
  settingsNativeScope?: unknown;
  projectUrl?: string | undefined;
  expectedRepositoryId?: number | undefined;
  issue?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  originalGame?: unknown;
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
const repositoryCatalogPath = join("crates", "portcove-core", "catalog");
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
  const selection = packageHintFeedback(hints, platforms, facts, (name) =>
    /\.(?:zip|tar\.gz|tgz)$/iu.test(name),
  );
  const direct = isRecord(release) && release.provider === "direct-manifest";
  if (direct) {
    selection.maintenance = {
      ...selection.maintenance,
      observed_release_tag: null,
      observed_provider_prerelease: null,
      potential_version_restrictions: [],
      scope:
        "Exact declared pins; changing pinned version, URL, size or hash requires a reviewed declaration change and separate artifact/compatibility evidence. These observations establish no trust, qualification or publication.",
      next: "This exact Direct pin does not discover newer upstream releases. Verify its version, URL, size and independently expected SHA-256; a later pin is a separate artifact/compatibility decision. Independent Direct-native entries require capability version 3; a declared packaged-file Windows path policy additionally requires Native version 4. Declared pins and unrelated release observations establish no authentication or executable acceptance.",
    };
    selection.platforms = selection.platforms.map((platform) => ({
      ...platform,
      hint_matches: [],
      next: "Review the exact declared archive pin, native headers, working directory, process lifetime and data ownership. GitHub hint uniqueness does not apply to this Direct selection.",
    }));
  }
  const persistentPaths = record.integration.persistent_paths;
  return {
    ...selection,
    pinned_releases: direct
      ? platforms.map((platform) => ({
          platform,
          declaration: isRecord(release.direct) ? (release.direct[platform] ?? null) : null,
          scope:
            "Declared pin only; Core validation, independent authentication and native/lifecycle evidence remain required.",
        }))
      : [],
    persistence: Array.isArray(persistentPaths) ? persistentPaths : [],
    manual_setup: {
      completion_record: record.integration.setup_marker ?? null,
      next: "For manual preparation before Play, use an upstream atomically published JSON completion record beneath already declared player data when that contract exists. Core checks bounded structural progress only; upstream still owns edition/content validation. Native capability 2 is required. Do not invent a marker, execute a discovered helper, or add a marker for a game's own first-Play picker.",
    },
    player_copy_review:
      "Collect edition, package, platform and file-effect evidence first. Then write the browse summary and setup actions using docs/CONTENT-DESIGN.md. Put pre-action risks in warnings and preserve technical evidence in references.",
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

/** Advice only: distinctive declarations never follow from arbitrary guide prose. */
export function declarativePreparationFeedback(record: AuthoredPort) {
  const projections = [];
  if (record.reviewed_flat_package_layout_v1) {
    projections.push({
      field: "reviewed_flat_package_layout_v1",
      scope:
        "Independently reviewed archive layout with one executable in the root on the declared platforms.",
      next: "Review each exact package and keep the platform order, archive selector and executable explicit. Additional executable or directory facts need an explicit package layout.",
    });
  }
  if (record.route_facts_v1) {
    projections.push({
      field: "route_facts_v1",
      scope: record.route_facts_v1.managed_native
        ? "Prepared-player guide and managed NativePortable presentation."
        : "Prepared-player guide for the independent external route.",
      next: "Keep the reviewed executable, literal arguments and external data locations explicit. Preserve bespoke setup and warnings. Reuse applicable accepted package/player inspections via the paired package observation options and keep independent expected facts.",
    });
  }
  if (record.gba_staged_archive_v1) {
    projections.push({
      field: "gba_staged_archive_v1",
      scope: "Managed Windows GBA archive paths and versioned mod policy for the upstream picker.",
      next: "Check the exact package, original edition, picker lifetime and writer differences against the reviewed layout. Reuse matching staging, preservation and rollback evidence. Keep repository, release selectors, executable and external saves explicit.",
    });
  }
  if (record.psx_managed_windows_v1 === "technically-computers") {
    projections.push({
      field: "psx_managed_windows_v1",
      scope:
        "Reviewed TechnicallyComputers PSXRecomp persistence on Windows and both macOS architectures.",
      next: "Keep each kit selector, executable, source edition and qualification explicit. A different runtime root or writer uses explicit coordinates.",
    });
  } else if (record.psx_managed_windows_v1 === "technically-computers-input-files") {
    projections.push({
      field: "psx_managed_windows_v1",
      scope:
        "Reviewed TechnicallyComputers persistent settings and input files for kits that declare their runtime root and mutable files.",
      next: "Keep the runtime root, mutable files, kit selectors and disc identities explicit. A raw disc set keeps its runtime-discs source, materialization and launch arguments explicit.",
    });
  } else if (record.psx_managed_windows_v1) {
    projections.push({
      field: "psx_managed_windows_v1",
      scope: "Managed Windows PSXRecomp generated-player launch and reviewed local data layout.",
      next: "Check the exact kit and generated executable, owned disc, explicit BIOS choice, and the reviewed shared writer layout. Every retail form takes an explicit SCPH-1001, SCPH-5552 or SCPH-5500 profile; bundled OpenBIOS forms take none. Both split-mods layouts also require both x64 kit selectors. Reuse applicable PSX preparation and preservation evidence. Keep original-file identities, exact release-specific source evidence, external setup, and independent fixture expectations explicit.",
    });
  }
  if (record.n64_recomp_persistence_v1) {
    projections.push({
      field: "n64_recomp_persistence_v1",
      scope: "Managed N64Recomp player data and original-file paths in the installation root.",
      next: "Check the installed layout and its writes. Keep original edition, archive selection, executable and other runtime values explicit.",
    });
  }
  if (record.external_registration_v1) {
    projections.push({
      field: "external_registration_v1",
      scope: "Register a player-selected external runtime on the declared platforms.",
      next: "Keep original-file instructions and upstream or player ownership explicit. An exact prepared package or per-platform exception needs an explicit integration.",
    });
  }
  const releaseAdvice = managedSetupReleaseAdvice(
    projectAuthoredPort(record),
    record.listing.release_url,
  );
  return {
    status: projections.length > 0 ? "declared" : "undeclared",
    projections,
    ...(releaseAdvice.length > 0
      ? {
          managed_setup_release_literals: {
            steps: releaseAdvice,
            next: managedSetupReleaseAdviceText,
          },
        }
      : {}),
    next:
      projections.length > 0
        ? "Regenerate with generate-catalog.mts and review the concrete output. Use the Core proposal inspection for operational declarations."
        : "Review docs/CATALOG.md for an applicable authoring projection. Establish the required facts before adopting one; otherwise keep the explicit integration or guide. This report does not assess whether the runtime supports an operation.",
    original_files:
      "An absent Core source_profile does not establish that no originals are required. Keep upstream original-file preparation and its owner explicit.",
    release_progression:
      "Initial acceptance or a changed integration needs its own applicable evidence. Ordinary releases already covered by stable rules use existing resolution/integrity checks without new version/applicability rows, wrappers, guide edits or routine owner/agent approval.",
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
    authored_acquisition_condition: listingDownloadBlockReason(record.listing) ?? null,
    next:
      specification === undefined
        ? "The canonical specification was not observed in this preparation. Read the owning Roadmap context or prepare with --issue before deciding route, lineage, acquisition conditions or deferrals."
        : "Read the complete retained canonical specification and relevant Roadmap context before deciding route, lineage, acquisition conditions or deferrals. An upstream README, published package, checksum or technical adapter fit does not resolve an existing named condition.",
    scope:
      "Authoring reminder only. No prose is classified into a hold, grant, support state or management right. Preserve reviewed authored conditions; Core remains the operation authority. No additional request or approval is introduced.",
  };
}

export function downloadPreparationFeedback(record: AuthoredPort, facts: PackageFacts) {
  const hints = listingDownloadAssetHints(record);
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
                (versions.some((version) => value.toLowerCase().includes(version)) ||
                  // A delimited dotted release token remains suspicious even when
                  // the currently observed tag has moved on. ABI/CPU/generation
                  // integers (SDL2, x86_64, d3d11) are deliberately excluded.
                  /(?:^|[^a-z0-9])v?\d+\.\d+(?:\.\d+)*(?:[-+](?:alpha|beta|preview|rc)\.?\d*)?(?=$|[^a-z0-9])/iu.test(
                    value,
                  )),
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
  retainArtifact(file, bytes);
  return file;
}

function retainArtifact(file: string, bytes: string) {
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
}
function artworkCatalog(records: readonly AuthoredPort[]): ArtworkCatalog {
  return {
    ports: records.map(({ listing, integration, igdb_regional_cover }) => {
      const presentation = integration?.presentation;
      const companion = isRecord(presentation) ? presentation.companion_cover : undefined;
      return {
        id: listing.id,
        name: listing.name,
        project_url: listing.project_url,
        ...(igdb_regional_cover ? { igdb_regional_cover } : {}),
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
        presentation: {
          ...(listing.artwork ? { artwork: listing.artwork } : {}),
          ...(listing.collection_covers !== undefined
            ? { collection_covers: listing.collection_covers }
            : {}),
          ...(companion !== undefined ? { companion_cover: companion } : {}),
        },
      };
    }),
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

function artworkInspector(
  options: ArtworkOptions & { signal?: AbortSignal },
  root: string,
  validatorIdentity: string | null,
) {
  let imageValidator: ImageValidator | undefined;
  const validateImage: ImageValidator = (bytes) => {
    if (!options.validatorCli || !validatorIdentity)
      throw new Error("Core image validation requires a compatible CLI.");
    imageValidator ??= createCoreImageValidator(
      options.validatorCli,
      join(root, "images"),
      validatorIdentity,
    );
    return imageValidator(bytes);
  };
  return (
    options.artwork ??
    createIgdbInspector(
      options.credentialsFile,
      validateImage,
      undefined,
      options.signal ? { signal: options.signal } : {},
    )
  );
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
  sourceChange: "ordinary" | "listing-admission" | "cover-defaults" = "ordinary",
) {
  const preserveFacts = sourceChange !== "ordinary";
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
    if (isRecord(presentation) && presentation.collection_covers !== undefined)
      copy.listing.collection_covers = presentation.collection_covers;
    else delete copy.listing.collection_covers;
    const integrationPresentation = copy.integration?.presentation;
    if (isRecord(integrationPresentation)) {
      if (isRecord(presentation) && presentation.companion_cover !== undefined)
        integrationPresentation.companion_cover = presentation.companion_cover;
      else delete integrationPresentation.companion_cover;
    }
    return checkedAuthoredPort(copy);
  });
  const shared: Record<string, unknown> = structuredClone(authored.catalog);
  delete shared.ports;
  const assembled = assembleCatalogRecords(
    shared,
    proposed,
    preserveFacts ? authored.generation.facts : undefined,
  );
  if (sourceChange === "listing-admission") {
    const currentIds = new Set(authored.directory.listings.map(({ id }) => id));
    const retained = assembled.directory.listings.filter(({ id }) => currentIds.has(id));
    if (observationHash(retained) !== observationHash(authored.directory.listings))
      throw new Error("Discovery listing preparation changed an existing listing projection.");
  }
  const acceptedCatalogHash = observationHash(authored.catalog);
  const operationalChanged = acceptedCatalogHash !== observationHash(assembled.catalog);
  let inspector: ReturnType<typeof coreProposalInspector> | undefined;
  const inspect = (kind: "core" | "listings-core", document: unknown) => {
    if (!options.validatorCli)
      throw new Error("Core validation requires --validator-cli with the matching schema.");
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const key = observationHash({
      input: createHash("sha256").update(bytes).digest("hex"),
      validator: validatorIdentity,
      ...(kind === "core" ? { repositoryAuthoring: true } : {}),
    });
    let receipt = cachedValue(root, kind, key);
    if (receipt === undefined) {
      inspector ??= coreProposalInspector(
        options.validatorCli,
        mkdtempSync(join(root, "core-inspection-")),
      );
      receipt =
        kind === "core"
          ? inspector.inspect("proposal", bytes, true)
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
  const generatedIds = new Set(
    preserveFacts ? assembled.generation.enrollments.map(({ port_id }) => port_id) : [],
  );
  const compatibility = reviewCompatibilityFixture(
    {
      ...assembled.catalog,
      ports: assembled.catalog.ports.filter(({ id }) => !generatedIds.has(id)),
    },
    readArtworkJson(join(options.catalogRoot, "catalog-schema1-fixture.json")),
    readFileSync(join(options.catalogRoot, "catalog-legacy-additions-fixture.json")),
  );
  const currentRecords = preserveFacts ? authored.authored : authored.records;
  const proposedRecords = preserveFacts ? assembled.authored : assembled.records;
  const acceptedRecords = new Map(currentRecords.map((record) => [record.listing.id, record]));
  const changed = proposedRecords.flatMap((entry) => {
    const before = acceptedRecords.get(entry.listing.id);
    const beforeHash = before ? observationHash(before) : null;
    const afterHash = observationHash(entry);
    return beforeHash === afterHash ? [] : [{ entry, before, beforeHash, afterHash }];
  });
  const files = {
    records: changed.map(({ entry }) => ({
      id: entry.listing.id,
      path: immutableJson(root, entry.listing.id, entry),
    })),
    catalog: immutableJson(root, "catalog", assembled.catalog),
    listings: immutableJson(root, "listings", assembled.directory),
    artwork: immutableJson(root, "artwork-evidence", artworkResult),
  };
  return {
    accepted_catalog_sha256: acceptedCatalogHash,
    accepted_listings_sha256: observationHash(authored.directory),
    changed_records: changed.map(({ entry }) => entry.listing.id),
    record_changes: changed.map(({ entry, before, beforeHash, afterHash }) => {
      return {
        id: entry.listing.id,
        action: before ? "modified" : "added",
        before_sha256: beforeHash,
        after_sha256: afterHash,
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

function reviewedGameSelector(game: unknown) {
  if (!isRecord(game) || typeof game.id !== "string" || !Array.isArray(game.source_editions))
    throw new Error("An original-game input requires a stable game ID and reviewed evidence.");
  const editions = game.source_editions.map((edition: unknown) => {
    if (!isRecord(edition) || typeof edition.id !== "string")
      throw new Error("An original-game input requires stable source edition IDs.");
    return edition.id;
  });
  return { id: game.id, editions: editions.sort() };
}

function matchReviewedGame(
  matching: readonly AuthoredPort[],
  selector: ReturnType<typeof reviewedGameSelector>,
) {
  const sameGame = matching.flatMap((record) => {
    const game = record.listing.original_game;
    return game?.id === selector.id
      ? [{ record, editions: game.source_editions.map(({ id }) => id) }]
      : [];
  });
  const exact = sameGame.filter(
    ({ editions }) =>
      editions.length === selector.editions.length &&
      editions.every((id) => selector.editions.includes(id)),
  );
  if (exact.length === 1) return exact[0]?.record;
  if (exact.length > 1)
    throw new Error(
      "Several implementations share this reviewed game and editions; select the stable ID.",
    );
  if (matching.some(({ listing }) => listing.original_game === undefined))
    throw new Error(
      "Supply the existing stable --id to resolve unbound game identity at this project.",
    );
  if (
    sameGame.some(
      ({ editions }) =>
        editions.length === 0 ||
        selector.editions.length === 0 ||
        editions.some((id) => selector.editions.includes(id)),
    )
  )
    throw new Error("Review overlapping or unspecified source editions and select the stable ID.");
  return undefined;
}

/** Unsigned local proposal preparation. Authored records and accepted outputs are never edited. */
export async function preparePort(options: PrepareOptions) {
  const started = process.hrtime.bigint();
  const root = resolve(options.outputDirectory);
  const authored = readCatalogSource(options.catalogRoot);
  const explicit = options.record === undefined ? undefined : checkedAuthoredPort(options.record);
  const expectedRepositoryId = options.expectedRepositoryId;
  const bound = expectedRepositoryId !== undefined;
  if (bound && (!options.projectUrl || options.issue || explicit))
    throw new Error(
      "A bound discovery input requires an official project URL without an issue or record override.",
    );
  const originalGame = options.originalGame;
  if (originalGame !== undefined && (!options.projectUrl || options.issue))
    throw new Error("An original-game input starts preparation with an official project URL.");
  const gameSelector = originalGame === undefined ? undefined : reviewedGameSelector(originalGame);
  if (originalGame !== undefined && explicit) {
    if (identityUrl(explicit.listing.project_url) !== identityUrl(options.projectUrl!))
      throw new Error("The reviewed record belongs to another project URL.");
    if (
      explicit.listing.original_game &&
      observationHash(explicit.listing.original_game) !== observationHash(originalGame)
    )
      throw new Error("The reviewed record and supplied game or edition identity differ.");
  }
  const route = options.route ?? (!bound && originalGame === undefined ? "listing" : "download");
  const validatorIdentity = options.validatorCli
    ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
    : null;
  if (explicit && options.id && explicit.listing.id !== options.id)
    throw new Error("Record and selected stable ID differ.");
  const selected = authored.records.find((record) => record.listing.id === options.id);
  const resolveIdentity = (projectUrl: string, issuePortId?: string) => {
    const normalizeSource = bound || originalGame !== undefined;
    const sourceKey = normalizeSource ? identityUrl(projectUrl) : projectUrl;
    const sameProject = (url: string) => sourceKey === (normalizeSource ? identityUrl(url) : url);
    const matching = authored.records.filter((record) => sameProject(record.listing.project_url));
    const suppliedId = explicit?.listing.id ?? options.id ?? issuePortId;
    let matched: AuthoredPort | undefined;
    if (suppliedId === undefined) {
      if (gameSelector) matched = matchReviewedGame(matching, gameSelector);
      else {
        if (matching.length > 1)
          throw new Error("Several implementations share this upstream; select the stable ID.");
        matched = matching[0];
      }
    }
    const repository = githubRepository(projectUrl);
    const suggested = repository
      ?.split("/")[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
    let defaultId = suggested;
    if (gameSelector && suppliedId === undefined && !matched) {
      defaultId ??= gameSelector.id;
      const occupied = (id: string) => authored.records.some(({ listing }) => listing.id === id);
      if (matching.length > 0 || occupied(defaultId)) {
        const suffix = observationHash(
          matching.length > 0
            ? [sourceKey, gameSelector.id, gameSelector.editions]
            : [sourceKey, gameSelector.id],
        ).slice(0, 12);
        const stem = `${defaultId.slice(0, 115).replace(/-+$/u, "")}-${suffix}`;
        defaultId = stem;
        for (let ordinal = 2; occupied(defaultId); ordinal += 1) {
          const ordinalSuffix = `-${ordinal}`;
          defaultId = `${stem.slice(0, 128 - ordinalSuffix.length)}${ordinalSuffix}`;
        }
      }
    }
    const id = suppliedId ?? matched?.listing.id ?? defaultId;
    if (!id) throw new Error("Supply a stable --id for this project.");
    if (issuePortId && issuePortId !== id)
      throw new Error("Canonical issue and proposed stable ID differ.");
    const previous = authored.records.find((record) => record.listing.id === id);
    if (bound && previous && !sameProject(previous.listing.project_url))
      throw new Error("The stable implementation ID already belongs to another project.");
    if (bound && !previous && !gameSelector && matching.length > 0)
      throw new Error(
        "The same project already has a catalog identity. Resolve its game scope before adding another listing.",
      );
    if (bound && !previous && gameSelector && matchReviewedGame(matching, gameSelector))
      throw new Error(
        "The game and source editions already have a stable listing at this project.",
      );
    if (originalGame !== undefined && explicit) {
      if (!previous && explicit.listing.issue_number !== undefined)
        throw new Error("A new issue-free record cannot supply an unverified issue association.");
      const release = projectAuthoredPort(explicit)?.release;
      const retainedRelease = previous && projectAuthoredPort(previous)?.release;
      const provider = isRecord(release) ? (release.provider ?? "github") : null;
      const retainedProvider = isRecord(retainedRelease)
        ? (retainedRelease.provider ?? "github")
        : null;
      if (retainedProvider !== null && provider !== retainedProvider)
        throw new Error("Review changes to an existing release provider as a record edit.");
      const retainedRepository =
        isRecord(retainedRelease) &&
        retainedProvider === "github" &&
        typeof retainedRelease.repository === "string"
          ? retainedRelease.repository.toLowerCase()
          : undefined;
      if (
        isRecord(release) &&
        provider === "github" &&
        (typeof release.repository !== "string" ||
          release.repository.toLowerCase() !== (retainedRepository ?? repository?.toLowerCase()))
      )
        throw new Error("The reviewed GitHub route must use the official or retained repository.");
    }
    if (originalGame !== undefined && previous) {
      if (!sameProject(previous.listing.project_url))
        throw new Error("The stable implementation ID already belongs to another project.");
      if (
        explicit &&
        (explicit.listing.issue_number !== previous.listing.issue_number ||
          observationHash(explicit.upstream_lineage ?? null) !==
            observationHash(previous.upstream_lineage ?? null))
      )
        throw new Error(
          "Review changes to an existing issue association or lineage as a record edit.",
        );
      if (!options.id && !previous.listing.original_game)
        throw new Error("Supply the existing stable --id to bind its reviewed game identity.");
      if (
        previous.listing.original_game &&
        observationHash(previous.listing.original_game) !== observationHash(originalGame)
      )
        throw new Error(
          "Review a change to an existing game or edition identity as a record edit.",
        );
    }
    const base = explicit ?? previous;
    if (
      previous?.listing.restrictions !== undefined &&
      JSON.stringify(base?.listing.restrictions) !== JSON.stringify(previous.listing.restrictions)
    )
      throw new Error(
        "Preparation cannot remove or change an authored download restriction; resolve its canonical condition in a reviewed source edit.",
      );
    return { id, previous, base };
  };
  const boundIdentity = bound ? resolveIdentity(options.projectUrl!) : undefined;
  if (boundIdentity?.previous)
    checkObservedRepository(boundIdentity.previous, expectedRepositoryId);
  if (boundIdentity) {
    const source = identityUrl(options.projectUrl!);
    const repositoryId = String(expectedRepositoryId);
    const retainedConflict = authored.records.some((entry) => {
      const { current, history } = assessUpstreamLineage(entry);
      if (
        current.repository?.host === "github.com" &&
        current.repository.id === repositoryId &&
        identityUrl(current.project_url) === source
      )
        return false;
      return history.some((upstream) => {
        if (upstream.repository?.host !== "github.com") return false;
        const sameSource = identityUrl(upstream.project_url) === source;
        const sameRepository = upstream.repository.id === repositoryId;
        return sameRepository !== sameSource;
      });
    });
    if (retainedConflict)
      throw new Error("This repository already has a retained origin. Review its lineage move.");
  }
  openCheckpoint(root);
  try {
    const facts = await collectPortFacts({
      ...options.facts,
      expectedRepositoryId,
      projectUrl:
        options.projectUrl ?? explicit?.listing.project_url ?? selected?.listing.project_url,
      issue: options.issue,
      route:
        options.settingsNativeScope !== undefined && options.releaseTag !== undefined
          ? "download"
          : route,
      releaseTag: options.releaseTag,
      resolveReleaseUrl: ({ projectUrl, issuePortId }) => {
        const { base } = boundIdentity ?? resolveIdentity(projectUrl, issuePortId);
        if (!base?.integration) {
          const retainedUrl = base?.listing.release_url;
          return bound && retainedUrl && new URL(retainedUrl).hostname !== "github.com"
            ? null
            : retainedUrl;
        }
        const release = projectAuthoredPort(base)?.release;
        return isRecord(release) &&
          (release.provider === undefined || release.provider === "github") &&
          typeof release.repository === "string"
          ? `https://github.com/${release.repository}`
          : null;
      },
      cacheDirectory: join(root, "facts"),
    });
    const { id, previous, base } =
      boundIdentity ?? resolveIdentity(facts.project_url, facts.issue?.id);
    const metadata = isRecord(facts.project?.body) ? facts.project.body : {};
    if (
      !bound &&
      originalGame !== undefined &&
      facts.repository &&
      typeof metadata.full_name === "string" &&
      metadata.full_name.toLowerCase() !== facts.repository.toLowerCase()
    )
      throw new Error("The provider returned a different project name. Review its lineage move.");
    const upstreamDescription =
      typeof metadata.description === "string"
        ? metadata.description.replace(/\p{Cc}+/gu, " ").trim()
        : "";
    const recordedRepositoryId =
      facts.repository &&
      Number.isSafeInteger(metadata.id) &&
      Number(metadata.id) > 0 &&
      typeof metadata.full_name === "string" &&
      metadata.full_name.toLowerCase() === facts.repository.toLowerCase()
        ? String(metadata.id)
        : undefined;
    const reviewedRecord = explicit ?? (options.id === undefined ? previous : undefined);
    if (gameSelector && reviewedRecord?.upstream_lineage && recordedRepositoryId) {
      const { current } = assessUpstreamLineage(reviewedRecord);
      if (
        current.repository?.host === "github.com" &&
        current.repository.id !== recordedRepositoryId
      )
        throw new Error("The reviewed record and provider repository identities differ.");
    }
    if (
      !bound &&
      originalGame !== undefined &&
      !previous &&
      recordedRepositoryId &&
      authored.records.some((entry) => {
        const { current } = assessUpstreamLineage(entry);
        if (current.repository?.host !== "github.com") return false;
        const sameSource = identityUrl(current.project_url) === identityUrl(facts.project_url);
        return (
          (current.repository.id === recordedRepositoryId && !sameSource) ||
          (!explicit && !options.id && sameSource && current.repository.id !== recordedRepositoryId)
        );
      })
    )
      throw new Error("This repository already has a retained origin. Review its lineage move.");
    const existingListedAt = base?.listing.listed_at ?? previous?.listing.listed_at;
    let record = checkedAuthoredPort({
      ...(base ?? { format_version: 1 }),
      ...((bound || originalGame !== undefined) &&
      !previous &&
      !base?.upstream_lineage &&
      recordedRepositoryId
        ? {
            upstream_lineage: {
              format_version: 1,
              target_key: id,
              origin: {
                project_url: facts.project_url,
                repository: { host: "github.com", id: recordedRepositoryId },
              },
              decisions: [],
            },
          }
        : {}),
      listing: {
        ...base?.listing,
        id,
        project_url:
          (bound || originalGame !== undefined ? previous?.listing.project_url : undefined) ??
          facts.project_url,
        ...(bound && !previous && facts.repository
          ? { release_url: `https://github.com/${facts.repository}/releases` }
          : {}),
        name:
          options.name ??
          base?.listing.name ??
          facts.issue?.name ??
          metadata.name ??
          (isRecord(originalGame) &&
          Array.isArray(originalGame.source_editions) &&
          originalGame.source_editions.length === 1 &&
          isRecord(originalGame.source_editions[0])
            ? originalGame.source_editions[0].title
            : undefined),
        ...(originalGame === undefined ? {} : { original_game: originalGame }),
        summary:
          options.summary ??
          base?.listing.summary ??
          (upstreamDescription && Buffer.byteLength(upstreamDescription) <= 4096
            ? upstreamDescription
            : "Upstream project; setup requirements have not been reviewed."),
        ...(facts.issue ? { issue_number: facts.issue.number } : {}),
        // An existing date is always kept, even when the caller passes a record without it.
        // Only a listing with no base and no previous record is new and records today (UTC).
        ...(existingListedAt !== undefined
          ? { listed_at: existingListedAt }
          : !base && !previous
            ? {
                listed_at: new Date(options.facts?.now?.() ?? Date.now())
                  .toISOString()
                  .slice(0, 10),
              }
            : {}),
      },
    });
    if (previous) checkLineageChange(previous, record);
    if (previous?.package_observation_v1) {
      // An explicit record is a proposal, never a replacement history authority.
      if (record.package_observation_v1) {
        checkPackagePlayerObservationContinuity(
          previous.package_observation_v1,
          record.package_observation_v1,
        );
      } else {
        const listing = { ...record.listing };
        delete listing.platforms;
        record = checkedAuthoredPort({
          ...record,
          listing,
          package_observation_v1: previous.package_observation_v1,
        });
      }
    }
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
    let packageObservation: unknown;
    let settingsPackageObservation: unknown;
    if (options.packageObservation) {
      const receipt = options.packageObservation.receipt;
      const rows = isRecord(receipt) && Array.isArray(receipt.rows) ? receipt.rows : undefined;
      if (rows && rows.length > 128)
        throw new Error("Accepted package receipt exceeds its finite row bound.");
      const candidates: unknown[] = rows
        ? rows.filter((row) => isRecord(row) && row.id === id)
        : [receipt];
      if (candidates.length !== 1)
        throw new Error("Accepted package receipt needs one exact selected title row.");
      settingsPackageObservation = candidates[0];
      if (!record.settings_qualification_v1 || record.route_facts_v1?.prepared_player) {
        const observation = acceptPackagePlayerObservation(
          record,
          candidates[0],
          options.packageObservation.reference,
          previous?.package_observation_v1 ?? record.package_observation_v1,
        );
        const key = packagePlayerProjectionKey(record, observation);
        let projection = cachedValue(root, "package-player", key);
        const reused = projection !== undefined;
        if (projection === undefined) {
          projection = packagePlayerProjection(record, observation);
          retainValue(root, "package-player", key, projection);
        }
        const listing = { ...record.listing };
        delete listing.platforms;
        record = checkedAuthoredPort({ ...record, listing, package_observation_v1: observation });
        packageObservation = {
          reused,
          scope_sha256: observation.scope_sha256,
          cache_key: key,
          projection,
          scope:
            "Accepted exact package/player evidence projected descriptively; no fresh byte inspection, support or publication authority.",
        };
      }
    }
    let settingsQualification: unknown;
    let settingsSourceEvidence: string | undefined;
    if (record.settings_qualification_v1 && options.settingsNativeScope !== undefined) {
      try {
        if (!options.validatorCli)
          throw new Error("Settings qualification requires the captured capable Core client.");
        const result = await prepareSettingsCandidate({
          record,
          catalog: authored.catalog,
          facts,
          scope: options.settingsNativeScope,
          cli: options.validatorCli,
          checkpoint: root,
          releaseTag: options.releaseTag,
          sourceOptions: options.facts,
        });
        record = checkedAuthoredPort({ ...record, settings_observation_v1: result.observation });
        settingsQualification = result;
      } catch (error) {
        settingsQualification = {
          status: "settings-unqualified",
          reason:
            error instanceof Error ? error.message : "Settings qualification could not complete.",
          scope:
            "Only optional settings qualification failed; existing package availability and basic operations are unchanged.",
        };
      }
    } else if (record.settings_qualification_v1 && settingsPackageObservation !== undefined) {
      try {
        if (!options.validatorCli || !isRecord(facts.release?.body) || !facts.assets_complete)
          throw new Error(
            "Settings qualification needs a captured Core validator and complete selected release facts.",
          );
        const receipt = settingsPackageObservation;
        const officialAsset = isRecord(receipt) ? receipt.official_asset : undefined;
        if (
          !isRecord(receipt) ||
          !isRecord(officialAsset) ||
          typeof receipt.source_revision !== "string" ||
          typeof receipt.observed_archive_sha256 !== "string" ||
          typeof facts.release.body.tag_name !== "string" ||
          !facts.assets.some(
            (asset) =>
              isRecord(asset) &&
              ["id", "name", "size", "digest", "browser_download_url"].every(
                (field) => asset[field] === officialAsset[field],
              ),
          )
        )
          throw new Error(
            "Settings package observation differs from the selected provider package.",
          );
        const sources = await collectSettingsSource(record, receipt.source_revision, {
          ...options.facts,
          releaseTag: facts.release.body.tag_name,
        });
        settingsSourceEvidence = immutableJson(root, "settings-source", sources);
        const inspector = coreProposalInspector(
          options.validatorCli,
          mkdtempSync(join(root, "settings-core-")),
        );
        const observation = await qualifySettingsObservation(
          record,
          {
            version: facts.release.body.tag_name,
            platform: "windows-x86-64",
            archive_sha256: receipt.observed_archive_sha256,
            source_commit: receipt.source_revision,
          },
          receipt,
          sources,
          (bytes) => inspector.inspectSettings("settings-probe", bytes),
        );
        record = checkedAuthoredPort({ ...record, settings_observation_v1: observation });
        settingsQualification = {
          status: "qualified-proposal",
          observation,
          source_evidence: settingsSourceEvidence,
          scope:
            "Generated exact settings binding only; existing protected acceptance/publication and retained installation boundaries remain required.",
        };
      } catch (error) {
        settingsQualification = {
          status: "settings-unqualified",
          source_evidence: settingsSourceEvidence,
          reason:
            error instanceof Error ? error.message : "Settings qualification could not complete.",
          scope:
            "Only optional settings qualification failed; package availability and basic operations retain their existing assessments.",
        };
      }
    }
    const compact = compactReviewedFlatPackageLayout(
      compactN64RecompPersistence(compactGbaArchive(compactPsxManagedWindows(record))),
    );
    if (compact !== record) record = checkedAuthoredPort(compact);
    const records = authored.records.filter((entry) => entry.listing.id !== id).concat(record);
    const inspector = artworkInspector(options, root, validatorIdentity);
    const artwork = await prepareArtworkWorkset(artworkCatalog(records), {
      root,
      acceptedCatalog: artworkCatalog(authored.records),
      inspector,
      identities: options.identities ?? {},
      validatorIdentity,
      selectedPortIds: [id],
    });
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      records,
      {
        ...artwork,
        ...("providerMetrics" in inspector ? { provider_metrics: inspector.providerMetrics } : {}),
      },
      artwork.reused,
      validatorIdentity,
    );
    const report = {
      format_version: 1,
      port_id: id,
      route: record.integration ? "existing-integration" : route,
      lineage: assessUpstreamLineage(record),
      original_game_grouping: originalGamePreparationFeedback(record, authored.records),
      ...(packageObservation === undefined ? {} : { package_observation: packageObservation }),
      ...(settingsQualification === undefined
        ? {}
        : { settings_qualification: settingsQualification }),
      declarative_authoring: declarativePreparationFeedback(record),
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
        record.integration?.adapter === "native-portable" &&
        isRecord(record.integration.release) &&
        record.integration.release.provider === "direct-manifest"
          ? "Review the exact declared archive pin and independent artifact/native evidence; no hosted-release hint selection or newer-version discovery is offered. Complete Core validation, capability version 3 negotiation (version 4 when the packaged-file Windows path policy is declared) and ordinary delivery checks."
          : route === "download" && !facts.assets_complete
            ? "Select an exact release or resolve the incomplete asset observation before package selection."
            : prepared.files.records.length === 0
              ? "No authored record changes were proposed. Review the observed evidence and any limits for the intended operation."
              : "Review the proposed record files, copy accepted records into catalog/ports, regenerate, and complete the applicable review and delivery checks.",
      scope:
        "Prepared local records only; listing visibility, executable acceptance and published user delivery are separate outcomes. No download, engine execution, issue mutation, signing or publication.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

function discoveryAdmissionSelection(
  approval: unknown,
  binding: { handoff_sha256: string; source_sha256: string },
  candidateIds: ReadonlySet<string>,
) {
  if (
    !isRecord(approval) ||
    Object.keys(approval).length !== 5 ||
    approval.format !== "portcove-discovery-listing-approval" ||
    approval.format_version !== 1 ||
    approval.handoff_sha256 !== binding.handoff_sha256 ||
    approval.source_sha256 !== binding.source_sha256 ||
    !Array.isArray(approval.approved_ids)
  )
    throw new Error("Discovery approval does not match the handoff and catalog source.");
  const ids: unknown[] = approval.approved_ids;
  if (
    ids.length === 0 ||
    new Set(ids).size !== ids.length ||
    !ids.every((id): id is string => typeof id === "string" && candidateIds.has(id))
  )
    throw new Error("Discovery approval must name unique IDs from the exact handoff.");
  return new Set(ids);
}

function discoveryAdmissionPatch(additions: readonly AuthoredPort[]) {
  return additions
    .map((entry) => {
      const path = `crates/portcove-core/catalog/${catalogSourceNames.ports}/${entry.listing.id}.json`;
      const lines = JSON.stringify(entry, null, 2).split("\n");
      return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        "",
      ].join("\n");
    })
    .join("");
}

function checkDiscoveryStagingSource(repository: string, revision: string) {
  if (!/^[a-f0-9]{40}$/u.test(revision))
    throw new Error("Discovery staging requires a full reviewed Git revision.");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
  const options = { cwd: realpathSync(repository), env };
  const root = runCheckedGit(["rev-parse", "--show-toplevel"], options).trim();
  if (realpathSync(root) !== options.cwd)
    throw new Error("Discovery staging requires the root of the reviewed Git checkout.");
  const head = runCheckedGit(["rev-parse", "--verify", "HEAD"], options).trim();
  const changes = runCheckedGit(["status", "--porcelain=v1", "--untracked-files=all"], options);
  const ignored = runCheckedGit(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", repositoryCatalogPath],
    options,
  );
  const index = runCheckedGit(["ls-files", "-z", "-v"], { ...options, maxBuffer: 8 * 1024 * 1024 });
  if (head !== revision || changes || ignored || /(?:^|\0)[a-zS] /u.test(index))
    throw new Error("Discovery staging requires a clean checkout at the reviewed Git revision.");
  return options;
}

function acquireDiscoveryValidator(privateRoot: string): AcquiredReleasedReader {
  const environment = credentialFree(process.env);
  for (const name of Object.keys(environment))
    if (name.toUpperCase().startsWith("GIT_")) delete environment[name];
  const value: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./catalog-released-reader.mts", import.meta.url)),
        "acquire-scheduled",
        privateRoot,
      ],
      {
        cwd: privateRoot,
        env: environment,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    ),
  );
  if (
    !isRecord(value) ||
    typeof value.cli !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof value.version !== "string" ||
    !isRecord(value.receipt)
  )
    throw new Error("Malformed released Core receipt.");
  return { cli: value.cli, sha256: value.sha256, version: value.version, receipt: value.receipt };
}

/** Prepare one append-only authoring proposal from a batch of discovery selections. */
export async function prepareDiscoveryListingAdditions(
  options: Pick<ArtworkOptions, "catalogRoot" | "outputDirectory" | "validatorCli"> & {
    handoff: unknown;
    facts?: PrepareOptions["facts"];
    deadline?: number;
    approval?: { document: unknown };
    automaticScope?: boolean;
    acquireValidator?: (
      privateRoot: string,
    ) => AcquiredReleasedReader | Promise<AcquiredReleasedReader>;
    stage?: {
      repository: string;
      revision: string;
      expectedPatchSha256?: string;
      previewListedDate?: string;
    };
  },
) {
  const started = process.hrtime.bigint();
  const now = options.facts?.now ?? Date.now;
  if (options.deadline !== undefined && !Number.isSafeInteger(options.deadline))
    throw new Error("Discovery preparation deadline must be a finite epoch in milliseconds.");
  if (options.approval && !options.validatorCli)
    throw new Error("Discovery listing approval requires a trusted Core validator.");
  if (options.approval && options.automaticScope)
    throw new Error("Choose either reviewed approval or automatic discovery scope.");
  if (
    options.acquireValidator &&
    (!options.automaticScope || options.validatorCli || options.stage)
  )
    throw new Error(
      "Released discovery validation requires automatic scope without local staging.",
    );
  const stage = options.stage;
  const today = new Date(now()).toISOString().slice(0, 10);
  const automaticListedDate = options.automaticScope
    ? (stage?.previewListedDate ?? today)
    : undefined;
  if (stage) {
    if ((!options.approval && !options.automaticScope) || !options.validatorCli)
      throw new Error(
        "Discovery staging requires an approved catalog patch and trusted Core validator.",
      );
    if (
      (options.automaticScope || stage.expectedPatchSha256 !== undefined) &&
      !/^[a-f0-9]{64}$/u.test(stage.expectedPatchSha256 ?? "")
    )
      throw new Error("Automatic discovery staging requires the exact preview patch SHA-256.");
    if (options.automaticScope) {
      const date = stage.previewListedDate ?? "";
      const timestamp = Date.parse(date);
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== date ||
        date > today
      )
        throw new Error("Automatic discovery staging requires the preview listing date.");
    } else if (stage.previewListedDate !== undefined) {
      throw new Error("A preview listing date requires automatic discovery staging.");
    }
    if (
      realpathSync(options.catalogRoot) !==
      join(realpathSync(stage.repository), repositoryCatalogPath)
    )
      throw new Error("Discovery staging requires the catalog source from the same checkout.");
    checkDiscoveryStagingSource(stage.repository, stage.revision);
  }
  const handoff = options.handoff;
  if (
    !isRecord(handoff) ||
    handoff.format !== "portcove-discovery-listing-handoff" ||
    handoff.format_version !== 1 ||
    !Array.isArray(handoff.candidates) ||
    Object.keys(handoff).some((key) => !["format", "format_version", "candidates"].includes(key))
  )
    throw new Error("A versioned discovery listing handoff is required.");
  const candidates = (handoff.candidates as unknown[]).map((value) => {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !["id", "project_url", "repository_id", "evidence_sha256"].includes(key),
      ) ||
      typeof value.id !== "string" ||
      value.id.length > 128 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
      /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/iu.test(value.id) ||
      typeof value.project_url !== "string" ||
      typeof value.repository_id !== "number" ||
      !Number.isSafeInteger(value.repository_id) ||
      value.repository_id <= 0 ||
      typeof value.evidence_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.evidence_sha256)
    )
      throw new Error(
        "A discovery listing requires a stable ID, public repository and evidence digest.",
      );
    const repository = githubRepository(value.project_url);
    if (!repository || new URL(value.project_url).port)
      throw new Error("Discovery listing preparation requires a public GitHub repository root.");
    if (options.automaticScope && value.id !== `github-${value.repository_id}`)
      throw new Error("Automatic discovery keys must derive from the immutable repository ID.");
    return {
      key: value.id,
      kind: "implementation" as const,
      repository,
      repository_id: value.repository_id,
      evidence: value.evidence_sha256,
    };
  });
  if (new Set(candidates.map(({ key }) => key)).size !== candidates.length)
    throw new Error("Discovery listing handoff requires unique stable IDs.");

  const authored = readCatalogSource(options.catalogRoot);
  const admissionBinding = {
    handoff_sha256: observationHash(handoff),
    source_sha256: observationHash({
      authored: authored.authored,
      catalog: authored.catalog,
      listing_package_facts: authored.generation.facts,
    }),
  };
  const approved = options.approval
    ? discoveryAdmissionSelection(
        options.approval.document,
        admissionBinding,
        new Set(candidates.map(({ key }) => key)),
      )
    : undefined;
  const knownPorts = new Set(authored.records.map(({ listing }) => listing.id));
  const canonical: CanonicalDiscoveryIdentity[] = [];
  for (const record of authored.records) {
    const { current, history } = assessUpstreamLineage(record);
    const lineagePaths = new Set<string>();
    for (const upstream of history.length ? history : [current]) {
      const url = identityUrl(upstream.project_url);
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url)) continue;
      lineagePaths.add(url.toLowerCase());
      const repositoryId = Number(upstream.repository?.id);
      canonical.push({
        repository: url,
        catalog_id: record.listing.id,
        ...(upstream.repository?.host === "github.com" &&
        Number.isSafeInteger(repositoryId) &&
        repositoryId > 0
          ? { repository_id: repositoryId }
          : {}),
      });
    }
    for (const repository of listedRepositories(record.listing)) {
      const url = `https://github.com/${repository}`;
      if (!lineagePaths.has(url))
        canonical.push({ repository: url, catalog_id: record.listing.id });
    }
  }
  const reconciled = new Map(
    reconcileDiscoverySnapshot(candidates, canonical).map((result) => [result.key, result]),
  );
  const knownRepositoryIds = new Set(canonical.map(({ repository_id }) => repository_id));
  const repositoryUses = new Map<string | number, number>();
  for (const { repository, repository_id } of candidates)
    for (const value of [repository.toLowerCase(), repository_id])
      repositoryUses.set(value, (repositoryUses.get(value) ?? 0) + 1);
  const root = resolve(options.outputDirectory);
  openCheckpoint(root);
  try {
    const additions: AuthoredPort[] = [];
    const outcomes = [];
    let providerBackoff: BoundRepositoryUnavailable | undefined;
    for (const candidate of candidates) {
      const identity = reconciled.get(candidate.key)!;
      const reported = {
        id: candidate.key,
        repository_id: candidate.repository_id,
        evidence_sha256: candidate.evidence,
      };
      if (approved && !approved.has(candidate.key)) {
        outcomes.push({ ...reported, status: "unselected" });
        continue;
      }
      if (knownPorts.has(candidate.key) && !identity.catalog_ids?.includes(candidate.key)) {
        outcomes.push({
          ...reported,
          status: "held",
          reason: "The stable key belongs to a different accepted port.",
        });
        continue;
      }
      if (identity.disposition !== "New canonical intake") {
        outcomes.push({
          ...reported,
          ...identity,
          status:
            identity.disposition === "Existing canonical owner" &&
            knownRepositoryIds.has(candidate.repository_id)
              ? "already-cataloged"
              : "held",
        });
        continue;
      }
      if (
        repositoryUses.get(candidate.repository.toLowerCase()) !== 1 ||
        repositoryUses.get(candidate.repository_id) !== 1
      ) {
        outcomes.push({
          ...reported,
          status: "held",
          reason: "Resolve the overlapping stable key or repository scope.",
        });
        continue;
      }
      if (providerBackoff?.retryAfter && Date.parse(providerBackoff.retryAfter) > now()) {
        outcomes.push({
          ...reported,
          status: "deferred",
          reason: providerBackoff.reason,
          retry_after: providerBackoff.retryAfter,
        });
        continue;
      }
      if (options.deadline !== undefined && now() >= options.deadline) {
        outcomes.push({ ...reported, status: "deferred", reason: "Preparation deadline reached." });
        continue;
      }
      const projectUrl = `https://github.com/${candidate.repository}`;
      let facts: Awaited<ReturnType<typeof collectPortFacts>>;
      let entry: AuthoredPort;
      try {
        facts = await collectPortFacts({
          ...options.facts,
          projectUrl,
          expectedRepositoryId: candidate.repository_id,
          route: "listing",
          ...(options.automaticScope ? { discoveryScope: true } : {}),
          cacheDirectory: join(root, "facts"),
        });
        if (options.automaticScope && facts.discovery_scope?.state !== "eligible") {
          const assessment = facts.discovery_scope;
          if (!assessment) throw new Error("Discovery scope assessment is unavailable.");
          if ("retry_after" in assessment && assessment.retry_after) {
            providerBackoff = new BoundRepositoryUnavailable(
              assessment.reason,
              assessment.retry_after,
            );
          }
          outcomes.push({
            ...reported,
            status:
              "retry_after" in assessment && assessment.retry_after ? "deferred" : assessment.state,
            scope_assessment: assessment,
            upstream_receipt: immutableJson(root, `discovery-upstream-${candidate.key}`, facts),
          });
          continue;
        }
        const metadata = isRecord(facts.project?.body) ? facts.project.body : {};
        const summary =
          typeof metadata.description === "string"
            ? metadata.description.replace(/\p{Cc}+/gu, " ").trim()
            : "";
        entry = checkedAuthoredPort({
          format_version: 1,
          upstream_lineage: {
            format_version: 1,
            target_key: candidate.key,
            origin: {
              project_url: projectUrl,
              repository: { host: "github.com", id: String(candidate.repository_id) },
            },
            decisions: [],
          },
          original_game_review: {
            disposition: "unresolved",
            reason:
              "Repository evidence does not establish an exact original game or source edition.",
            evidence_urls:
              facts.discovery_scope?.state === "eligible"
                ? [
                    projectUrl,
                    `${projectUrl}/blob/${facts.discovery_scope.commit}/${facts.discovery_scope.manifest_path}`,
                  ]
                : [projectUrl],
          },
          listing: {
            id: candidate.key,
            name: candidate.repository.split("/")[1],
            project_url: projectUrl,
            listed_at: automaticListedDate ?? facts.project?.observed_at?.slice(0, 10),
            release_url: `${projectUrl}/releases`,
            summary:
              summary && Buffer.byteLength(summary) <= 4096
                ? summary
                : "Upstream project; setup requirements have not been reviewed.",
          },
        });
      } catch (error) {
        if (error instanceof BoundRepositoryUnavailable) {
          if (error.retryAfter) providerBackoff = error;
          outcomes.push({
            ...reported,
            status: error.retryAfter ? "deferred" : "unavailable",
            reason: error.reason,
            ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
          });
          continue;
        }
        outcomes.push({
          ...reported,
          status: "held",
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
        continue;
      }
      const receipt = immutableJson(root, `discovery-upstream-${candidate.key}`, facts);
      requireOriginalGameDecision(entry);
      additions.push(entry);
      outcomes.push({
        ...reported,
        status: "prepared",
        ...(facts.discovery_scope ? { scope_assessment: facts.discovery_scope } : {}),
        upstream_receipt: receipt,
      });
    }
    const validatorIdentity = options.validatorCli
      ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
      : null;
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      [...authored.authored, ...additions],
      { catalog: artworkCatalog(authored.authored) },
      true,
      validatorIdentity,
      "listing-admission",
    );
    if (
      prepared.operational_changed ||
      prepared.record_changes.length !== additions.length ||
      prepared.record_changes.some(
        ({ action, integration_changed }) => action !== "added" || integration_changed,
      )
    )
      throw new Error(
        "Discovery listing preparation changed an accepted catalog record or integration.",
      );
    let releasedValidation:
      | { status: "validated"; receipt: Record<string, unknown> }
      | { status: "deferred-unavailable" | "deferred-core-inspection" }
      | undefined;
    if (options.acquireValidator && additions.length > 0) {
      const privateRoot = mkdtempSync(join(root, "released-core-"));
      let reader: AcquiredReleasedReader | undefined;
      try {
        reader = await options.acquireValidator(privateRoot);
      } catch (error) {
        console.error("Released Core is unavailable for discovery validation:", error);
        releasedValidation = { status: "deferred-unavailable" };
      }
      if (reader) {
        try {
          const inspector = coreProposalInspector(reader.cli, privateRoot, {
            env: { PATH: process.env.PATH, HOME: privateRoot, TMPDIR: privateRoot },
            expectedSha256: reader.sha256,
          });
          const bytes = readFileSync(prepared.files.listings);
          const { listings, ...inspection } = inspector.inspectListings("listings", bytes);
          prepared.listing_validation = { ...inspection, listing_count: listings.length };
          releasedValidation = { status: "validated", receipt: reader.receipt };
        } catch (error) {
          console.error("Released Core could not validate the prepared listings:", error);
          releasedValidation = { status: "deferred-core-inspection" };
        }
      }
    }
    const canPreparePatch =
      (approved ||
        (options.automaticScope && options.validatorCli) ||
        releasedValidation?.status === "validated") &&
      additions.length > 0;
    const patch = canPreparePatch ? discoveryAdmissionPatch(additions) : null;
    const sha256 = patch === null ? null : createHash("sha256").update(patch).digest("hex");
    if (stage?.expectedPatchSha256 && stage.expectedPatchSha256 !== sha256)
      throw new Error("Rebuilt discovery patch differs from the preview. Prepare a fresh preview.");
    let admission: { path: string; sha256: string } | null = null;
    if (patch !== null && sha256 !== null) {
      const path = join(root, `discovery-listing-admission-${sha256}.patch`);
      retainArtifact(path, patch);
      admission = { path, sha256 };
      if (stage) {
        const gitOptions = checkDiscoveryStagingSource(stage.repository, stage.revision);
        immutableJson(root, "staging-intent", {
          format_version: 1,
          source_revision: stage.revision,
          patch: admission,
          approved_ids: prepared.changed_records,
        });
        runCheckedGit(["apply", "--index"], { ...gitOptions, input: Buffer.from(patch) });
      }
    }
    const report = {
      format_version: 1,
      route: "discovery-listings",
      ...(options.automaticScope
        ? {
            automatic_scope_policy: discoveryScopePolicy,
            automatic_listed_date: automaticListedDate,
          }
        : {}),
      selected_port_ids: candidates.map(({ key }) => key),
      handoff_semantic_sha256: admissionBinding.handoff_sha256,
      admission_binding: admissionBinding,
      admission,
      staged_source_revision: stage && admission ? stage.revision : null,
      outcomes,
      ...(releasedValidation ? { released_validation: releasedValidation } : {}),
      ...prepared,
      preparation_costs: preparationCosts(started),
      next:
        stage && admission
          ? "Regenerate the catalog and run normal validation on the staged additions."
          : admission
            ? "Apply the patch to the reviewed source revision, regenerate the catalog and run normal validation."
            : "Use the identity evidence to review eligible additions as a batch.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

/** Project retained descriptive observations through ordinary record preparation.
 * This neither collects provider facts nor accepts the proposed correction. */
export function prepareListingObservations(
  options: Pick<ArtworkOptions, "catalogRoot" | "outputDirectory" | "validatorCli"> & {
    handoff: unknown;
  },
) {
  const started = process.hrtime.bigint();
  const authored = readCatalogSource(options.catalogRoot);
  const handoff = options.handoff;
  if (!isRecord(handoff) || !Array.isArray(handoff.descriptive_listing_candidates))
    throw new Error("A retained descriptive listing observation handoff is required.");
  const candidates = handoff.descriptive_listing_candidates;
  if (candidates.length > authored.records.length)
    throw new Error("Observation candidates exceed the accepted authored inventory.");
  const currentListings = new Map(
    authored.directory.listings.map((listing) => [listing.id, listing]),
  );
  const observations = new Map<string, Record<string, unknown>>();
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !isRecord(candidate.upstream_observation)
    )
      throw new Error("Each descriptive candidate requires an exact stable ID and observation.");
    const current = currentListings.get(candidate.id);
    if (!current || observations.has(candidate.id))
      throw new Error("Descriptive candidates require unique existing authored identities.");
    if (listingDeclarationHash(candidate) !== listingDeclarationHash(current))
      throw new Error(
        "Listing declaration changed; reproject the retained observation before preparing it.",
      );
    const preimages = handoff.descriptive_listing_preimages;
    // Older handoffs are safe only before any observation has been accepted.
    // A later snapshot must not be overwritten by an earlier unsigned proposal.
    if (preimages !== undefined || current.upstream_observation != null) {
      if (
        !isRecord(preimages) ||
        preimages[candidate.id] !== observationHash(current.upstream_observation ?? null)
      )
        throw new Error(
          "Accepted listing observation changed; reproject against its current preimage.",
        );
    }
    observations.set(candidate.id, candidate.upstream_observation);
  }
  const records = authored.records.map((record) => {
    const observation = observations.get(record.listing.id);
    return observation
      ? checkedAuthoredPort({
          ...structuredClone(record),
          listing: {
            ...structuredClone(record.listing),
            upstream_observation: structuredClone(observation),
          },
        })
      : record;
  });
  const root = resolve(options.outputDirectory);
  const validatorIdentity = options.validatorCli
    ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
    : null;
  openCheckpoint(root);
  try {
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      records,
      { catalog: artworkCatalog(authored.records) },
      true,
      validatorIdentity,
    );
    if (
      prepared.operational_changed ||
      prepared.record_changes.some((change) => change.integration_changed)
    )
      throw new Error("Descriptive observation preparation cannot change an integration.");
    const report = {
      format_version: 1,
      route: "listing-observations",
      selected_port_ids: [...observations.keys()].sort(),
      handoff_semantic_sha256: observationHash(handoff),
      ...prepared,
      files: { ...prepared.files, handoff: immutableJson(root, "observation-handoff", handoff) },
      preparation_costs: preparationCosts(started),
      upstream_collection: "retained-handoff-only; no provider requests",
      next: "Review and deliver these prepared records through existing catalog acceptance and signed listing delivery. No authored facts need reconstruction from provider output.",
      scope:
        "Unsigned descriptive proposals only. Existing integrations, artwork mappings, restrictions, pin reasons and publication authority are preserved. Core inspection and normal delivery checks retain their existing roles.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

function sharedCoverScope(record: AuthoredPort) {
  if (record.igdb_regional_cover || usesScummvmEngine(record)) return undefined;
  const game = record.listing.original_game;
  const edition = game?.source_editions.length === 1 ? game.source_editions[0] : undefined;
  if (!game || !edition) return undefined;
  return { game_id: game.id, source_edition_id: edition.id };
}

async function readSharedCoverTarget(options: {
  cli: string;
  library: string;
  catalogRoot: string;
  target: string;
}) {
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const anchor = sha256(readFileSync(join(options.catalogRoot, "official-definition-root.json")));
  const status = () => {
    const output = spawnSync(
      resolve(options.cli),
      [
        "--library",
        resolve(options.library),
        "--non-interactive",
        "--json",
        "catalog",
        "listing-status",
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    if (output.status !== 0)
      throw new Error("Trusted Core could not read the verification library's listing status.");
    const response: unknown = JSON.parse(output.stdout);
    const data =
      isRecord(response) && response.ok === true && response.command === "catalog.listing-status"
        ? response.data
        : undefined;
    if (
      !isRecord(data) ||
      data.selected !== true ||
      data.fallback_reason !== null ||
      data.anchor_sha256 !== anchor ||
      !Number.isSafeInteger(data.revision) ||
      !Number.isSafeInteger(data.listing_count) ||
      typeof data.expires_at !== "string" ||
      !(Date.parse(data.expires_at) > Date.now()) ||
      typeof data.target_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(data.target_sha256) ||
      typeof data.transport_target_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(data.transport_target_sha256)
    )
      throw new Error(
        "Shared cover preparation requires a current official compact listing selection.",
      );
    return data;
  };
  const before = status();
  const wire = await readControllerToolFile(resolve(options.target), listingDeliveryMaximum);
  if (sha256(wire) !== before.transport_target_sha256)
    throw new Error("Shared cover target differs from the exact authenticated compact target.");
  const decoded = decodeRetainedCompactListing(wire);
  if (sha256(decoded) !== before.target_sha256)
    throw new Error("Shared cover target differs from the authenticated decoded listing document.");
  const document = parseCatalogSource(decoded.toString("utf8"));
  if (
    !isRecord(document) ||
    document.listing_delivery_schema !== 1 ||
    document.revision !== before.revision ||
    !isRecord(document.directory) ||
    !Array.isArray(document.directory.listings) ||
    document.directory.listings.length !== before.listing_count ||
    observationHash(status()) !== observationHash(before)
  )
    throw new Error("The complete authenticated listing selection changed or could not be read.");
  return { baseline: before, rows: document.directory.listings as unknown[] };
}

/** Prepare only exact cover reuse against the current authenticated listing target. */
export async function prepareSharedCoverBatch(
  options: Pick<
    ArtworkOptions,
    "catalogRoot" | "outputDirectory" | "validatorCli" | "identities"
  > & {
    target: string;
    library: string;
  },
) {
  const start = process.hrtime.bigint();
  if (!options.validatorCli)
    throw new Error("Shared cover preparation requires a trusted Core validator.");
  const { rows, baseline } = await readSharedCoverTarget({
    cli: options.validatorCli,
    library: options.library,
    catalogRoot: options.catalogRoot,
    target: options.target,
  });
  const live = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || live.has(row.id))
      throw new Error("Shared cover preparation requires unique signed listing IDs.");
    live.set(row.id, row);
  }

  const root = resolve(options.outputDirectory);
  const validator = createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex");
  openCheckpoint(root);
  try {
    const gone = readKnownGoneArtwork(root);
    const authored = readCatalogSource(options.catalogRoot);
    const checked = retainedCoverDigests(
      root,
      authored.authored.map(({ listing }) => listing.id),
      Date.now(),
    );
    const signedDigests = new Map<string, Set<string>>();
    for (const row of live.values()) {
      const covers = [
        ...(validArtworkMapping(row.artwork) ? [row.artwork] : []),
        ...(validArtworkCollection(row.collection_covers) ? row.collection_covers : []),
      ];
      for (const cover of covers) {
        const digests = signedDigests.get(cover.image_id) ?? new Set<string>();
        digests.add(cover.image_sha256);
        signedDigests.set(cover.image_id, digests);
      }
    }
    const exclusions = isRecord(options.identities) ? options.identities : {};
    const scoped = authored.authored.flatMap((record) => {
      if (Object.hasOwn(exclusions, record.listing.id)) return [];
      const scope = sharedCoverScope(record);
      return scope ? [{ record, scope, key: observationHash(scope) }] : [];
    });
    type CoverDonor = { id: string; artwork: IgdbArtwork };
    const donors = new Map<string, Map<string, CoverDonor>>();
    for (const { record, scope, key } of scoped) {
      const { id, artwork } = record.listing;
      const signed = live.get(id);
      const game = signed?.original_game;
      const newer = validArtworkMapping(artwork) ? checked.get(artwork.image_id) : undefined;
      if (
        !signed ||
        signed.project_url !== record.listing.project_url ||
        !isRecord(game) ||
        game.id !== scope.game_id ||
        !Array.isArray(game.source_editions) ||
        game.source_editions.length !== 1 ||
        !isRecord(game.source_editions[0]) ||
        game.source_editions[0].id !== scope.source_edition_id ||
        !validArtworkMapping(artwork) ||
        artwork.match_kind !== "underlying-game" ||
        gone.has(artwork.image_id) ||
        signedDigests.get(artwork.image_id)?.size !== 1 ||
        (newer !== undefined && newer.digest !== artwork.image_sha256) ||
        observationHash(signed.artwork ?? null) !== observationHash(artwork)
      )
        continue;
      const variants = donors.get(key) ?? new Map<string, CoverDonor>();
      const digest = observationHash(artwork);
      const existing = variants.get(digest);
      if (!existing || id < existing.id) variants.set(digest, { id, artwork });
      donors.set(key, variants);
    }

    const proposals = new Map<string, IgdbArtwork>();
    const outcomes = scoped.flatMap(({ record, scope, key }) => {
      const { id, artwork, collection_covers } = record.listing;
      const existing = live.get(id);
      if (artwork || collection_covers || existing?.artwork || existing?.collection_covers)
        return [];
      const choices = donors.get(key);
      const result = { id, ...scope };
      if (choices?.size !== 1)
        return [{ ...result, status: choices ? "ambiguous" : "no-accepted-donor" }];
      const donor = choices.values().next().value!;
      proposals.set(id, donor.artwork);
      return [{ ...result, status: "prepared", donor_port_id: donor.id, mapping: donor.artwork }];
    });

    const result = artworkCatalog(authored.authored);
    for (const port of result.ports) {
      if (proposals.has(port.id))
        port.presentation = { ...port.presentation, artwork: proposals.get(port.id) };
    }
    const prepared = preparedRecordOutputs(
      options,
      root,
      authored,
      authored.authored,
      { catalog: result, outcomes },
      true,
      validator,
      "cover-defaults",
    );
    if (
      prepared.record_changes.length !== proposals.size ||
      prepared.record_changes.some(
        ({ id, integration_changed, listing_fields }) =>
          !proposals.has(id) ||
          integration_changed ||
          listing_fields.length !== 1 ||
          listing_fields[0] !== "artwork",
      )
    )
      throw new Error("Shared cover preparation changed data outside its exact cover proposals.");
    const report = {
      format_version: 1,
      route: "shared-covers",
      signed_listing_baseline: baseline,
      selected_port_ids: [...proposals.keys()],
      outcomes,
      ...prepared,
      preparation_costs: preparationCosts(start),
      next: "Review and deliver the exact cover proposals through the existing catalog path.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

/** Cover-only work on existing authored identities; no upstream metadata collection. */
export async function prepareArtworkBatch(
  options: ArtworkOptions & {
    selectedPortIds?: readonly string[];
    refreshPortIds?: readonly string[];
    maintenance?: boolean;
    retainedCoverLimit?: number;
    now?: () => number;
    signal?: AbortSignal;
    onProgress?: (id: string) => void | Promise<void>;
  },
) {
  const started = process.hrtime.bigint();
  const root = resolve(options.outputDirectory);
  const authored = readCatalogSource(options.catalogRoot);
  const known = new Set(authored.records.map((record) => record.listing.id));
  const selected = new Set(options.selectedPortIds ?? []);
  const refreshPortIds = options.refreshPortIds ?? [];
  if (
    (!options.maintenance && !selected.size) ||
    (options.maintenance === true && options.selectedPortIds !== undefined) ||
    selected.size !== (options.selectedPortIds?.length ?? 0) ||
    [...selected].some((id) => !known.has(id))
  )
    throw new Error("Artwork batch requires unique known stable IDs or automatic due maintenance.");
  if (
    (options.maintenance === true && refreshPortIds.length > 0) ||
    new Set(refreshPortIds).size !== refreshPortIds.length ||
    refreshPortIds.some((id) => !selected.has(id))
  )
    throw new Error("Artwork refresh requires unique IDs within the selected workset.");
  const validatorIdentity = options.validatorCli
    ? createHash("sha256").update(readFileSync(options.validatorCli)).digest("hex")
    : null;
  const acceptedArtwork = artworkCatalog(authored.records);
  const identities = options.identities ?? {};
  openCheckpoint(root);
  try {
    // Old batch receipts have no per-ID live clock and cannot satisfy a refresh.
    let artworkResult;
    if (
      !options.maintenance &&
      refreshPortIds.length === 0 &&
      !existsSync(join(root, "artwork-gone.json")) &&
      readdirSync(root).some((name) => /^artwork-batch-[a-f0-9]{64}\.json$/u.test(name))
    ) {
      const legacyKey = observationHash({
        acceptedArtwork,
        identities,
        validatorIdentity,
        selectedPortIds: [...selected],
        refreshPortIds,
      });
      artworkResult = cachedValue(root, "artwork-batch", legacyKey);
    }
    let artworkReused = artworkResult !== undefined;
    if (
      isRecord(artworkResult) &&
      Array.isArray(artworkResult.records) &&
      artworkResult.records.some(
        (record: unknown) =>
          isRecord(record) &&
          record.reason === "accepted-mapping-retained-after-unavailable-refresh",
      )
    ) {
      artworkResult = undefined;
      artworkReused = false;
    }
    if (artworkResult === undefined) {
      const inspector = artworkInspector(options, root, validatorIdentity);
      const result = await prepareArtworkWorkset(acceptedArtwork, {
        root,
        inspector,
        identities,
        validatorIdentity,
        ...(options.selectedPortIds ? { selectedPortIds: options.selectedPortIds } : {}),
        refreshPortIds,
        ...(options.maintenance ? { maintenance: true } : {}),
        ...(options.retainedCoverLimit === undefined
          ? {}
          : { retainedCoverLimit: options.retainedCoverLimit }),
        ...(options.now ? { now: options.now } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
      artworkResult = {
        ...result,
        ...("providerMetrics" in inspector ? { provider_metrics: inspector.providerMetrics } : {}),
      };
      artworkReused = result.reused;
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
      if (
        record.mapping === null &&
        (!Array.isArray(record.collection) || record.collection.length === 0)
      )
        pendingPortIds.push(record.port_id);
    }
    if (
      isRecord(artworkResult.continuation) &&
      Array.isArray(artworkResult.continuation.pending_port_ids)
    ) {
      for (const id of artworkResult.continuation.pending_port_ids) {
        if (typeof id !== "string" || !known.has(id))
          throw new Error("Malformed artwork continuation scope");
        if (!pendingPortIds.includes(id)) pendingPortIds.push(id);
      }
    }
    const report = {
      format_version: 1,
      route: "artwork-only",
      selected_port_ids:
        isRecord(artworkResult.workset) && Array.isArray(artworkResult.workset.selected_port_ids)
          ? artworkResult.workset.selected_port_ids
          : [...selected],
      refresh_port_ids: options.maintenance ? "automatic-due-identities" : refreshPortIds,
      continuation: artworkResult.continuation ?? null,
      pending_port_ids: pendingPortIds,
      ...prepared,
      preparation_costs: preparationCosts(started),
      upstream_collection: "not-requested",
      next: "Review and deliver the prepared records through the existing catalog route. Reinvoke the same logical workset after interruption or provider recovery; completed identities remain checkpointed. Use --artwork-ids @due at the existing maintenance checkpoint for automatic due selection.",
      scope:
        "Bounded cover proposals against the full authored catalog. Accepted sources, local artwork choices and delivery authority are unchanged; no upstream release investigation, download or execution.",
    };
    return { report, path: immutableJson(root, "completion", report) };
  } finally {
    rmdirSync(join(root, "active.lock"));
  }
}

async function main() {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--project",
    "--expected-repository-id",
    "--issue",
    "--id",
    "--name",
    "--original-game",
    "--summary",
    "--record",
    "--route",
    "--release-tag",
    "--identities",
    "--validator-cli",
    "--credentials-file",
    "--output-dir",
    "--artwork-ids",
    "--accepted-shared-covers",
    "--verification-library",
    "--refresh-artwork",
    "--artwork-retained-limit",
    "--discovery-listings",
    "--discovery-listing-approval",
    "--discovery-automatic-scope",
    "--discovery-stage-source",
    "--discovery-expected-patch-sha256",
    "--discovery-preview-listed-date",
    "--discovery-released-validator",
    "--discovery-deadline-epoch-ms",
    "--listing-observations",
    "--package-observation",
    "--package-observation-reference",
    "--settings-native-scope",
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index]!;
    const value = process.argv[index + 1];
    if (!allowed.has(name) || values.has(name) || !value || value.startsWith("--"))
      throw new Error("Unknown, repeated or missing prepare-port option.");
    values.set(name, value);
  }
  if (values.has("--settings-native-scope")) {
    const { reenterResourceCommand } = await import("./resource-command.mts");
    await reenterResourceCommand("rust", import.meta.url, {
      executionTimeoutMilliseconds: 1_800_000,
    });
  }
  const output = values.get("--output-dir");
  if (!output) throw new Error("--output-dir is required (a new or owned preparation checkpoint).");
  const artworkIds = values.get("--artwork-ids");
  const sharedCoverSource = values.get("--accepted-shared-covers");
  const verificationLibrary = values.get("--verification-library");
  if (Boolean(sharedCoverSource) !== Boolean(verificationLibrary))
    throw new Error(
      "Shared cover preparation requires the approved target and verification library.",
    );
  if (
    sharedCoverSource &&
    [...values.keys()].some(
      (name) =>
        ![
          "--accepted-shared-covers",
          "--verification-library",
          "--validator-cli",
          "--output-dir",
          "--identities",
        ].includes(name),
    )
  )
    throw new Error("Shared cover reuse is an offline preparation route.");
  const refreshIds = values.get("--refresh-artwork");
  const retainedLimit = values.get("--artwork-retained-limit");
  if (
    retainedLimit !== undefined &&
    (artworkIds !== "@due" ||
      !/^[1-9][0-9]{0,2}$/u.test(retainedLimit) ||
      Number(retainedLimit) > 400)
  )
    throw new Error("--artwork-retained-limit requires @due and a count from 1 through 400");
  const observationHandoff = values.get("--listing-observations");
  const discoveryHandoff = values.get("--discovery-listings");
  const discoveryApproval = values.get("--discovery-listing-approval");
  const automaticDiscoveryScope = values.get("--discovery-automatic-scope");
  const discoveryStageSource = values.get("--discovery-stage-source");
  const discoveryExpectedPatch = values.get("--discovery-expected-patch-sha256");
  const discoveryPreviewListedDate = values.get("--discovery-preview-listed-date");
  const releasedDiscoveryValidator = values.get("--discovery-released-validator");
  if (
    releasedDiscoveryValidator !== undefined &&
    (releasedDiscoveryValidator !== "true" ||
      !automaticDiscoveryScope ||
      values.has("--validator-cli") ||
      discoveryStageSource)
  )
    throw new Error(
      "--discovery-released-validator takes true with automatic scope without local validation or staging.",
    );
  const discoveryDeadline = values.get("--discovery-deadline-epoch-ms");
  if (discoveryDeadline && !discoveryHandoff)
    throw new Error("--discovery-deadline-epoch-ms requires --discovery-listings.");
  if (discoveryApproval && (!discoveryHandoff || !values.get("--validator-cli")))
    throw new Error(
      "--discovery-listing-approval requires --discovery-listings and --validator-cli.",
    );
  if (
    automaticDiscoveryScope !== undefined &&
    (automaticDiscoveryScope !== "true" || !discoveryHandoff)
  )
    throw new Error("--discovery-automatic-scope takes true with --discovery-listings.");
  if (discoveryStageSource && !discoveryApproval && !automaticDiscoveryScope)
    throw new Error("--discovery-stage-source requires reviewed approval or automatic scope.");
  if (discoveryExpectedPatch && !discoveryStageSource)
    throw new Error("--discovery-expected-patch-sha256 requires --discovery-stage-source.");
  if (discoveryPreviewListedDate && (!discoveryStageSource || !automaticDiscoveryScope))
    throw new Error("--discovery-preview-listed-date requires automatic discovery staging.");
  if (
    discoveryHandoff &&
    [...values.keys()].some(
      (name) =>
        ![
          "--discovery-listings",
          "--discovery-listing-approval",
          "--discovery-automatic-scope",
          "--discovery-stage-source",
          "--discovery-expected-patch-sha256",
          "--discovery-preview-listed-date",
          "--discovery-released-validator",
          "--discovery-deadline-epoch-ms",
          "--validator-cli",
          "--output-dir",
        ].includes(name),
    )
  )
    throw new Error(
      "Discovery listing batches cannot mix issue, route, record or artwork options.",
    );
  if (
    observationHandoff &&
    [...values.keys()].some(
      (name) => !["--listing-observations", "--validator-cli", "--output-dir"].includes(name),
    )
  )
    throw new Error(
      "Listing observation batches cannot mix project, record, release or artwork options.",
    );
  if (
    artworkIds &&
    [...values.keys()].some(
      (name) =>
        ![
          "--artwork-ids",
          "--refresh-artwork",
          "--artwork-retained-limit",
          "--identities",
          "--validator-cli",
          "--credentials-file",
          "--output-dir",
        ].includes(name),
    )
  )
    throw new Error("Artwork-only batches cannot mix project, issue, record or release options.");
  if (refreshIds && !artworkIds) throw new Error("--refresh-artwork requires --artwork-ids.");
  const route = values.get("--route");
  if (route !== undefined && route !== "listing" && route !== "download")
    throw new Error("--route must be listing or download.");
  if (values.has("--package-observation") !== values.has("--package-observation-reference"))
    throw new Error("Package observations require their exact retained receipt reference.");
  const input = values.get("--record");
  const repositoryId = values.get("--expected-repository-id");
  if (repositoryId !== undefined && !/^[1-9][0-9]*$/u.test(repositoryId))
    throw new Error("--expected-repository-id must be a positive decimal repository ID.");
  const originalGame = values.get("--original-game");
  const identities = values.get("--identities");
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const common = {
    catalogRoot: join(repository, repositoryCatalogPath),
    outputDirectory: output,
    ...(identities ? { identities: readArtworkJson(identities, 1024 * 1024) } : {}),
    validatorCli: values.get("--validator-cli"),
    credentialsFile: values.get("--credentials-file"),
  };
  const handoffPath = discoveryHandoff ?? observationHandoff;
  const handoff = handoffPath
    ? parseCatalogSource(readArtworkInput(handoffPath, 16 * 1024 * 1024).bytes.toString("utf8"))
    : undefined;
  if (sharedCoverSource && verificationLibrary) {
    printPreparationResult(
      await prepareSharedCoverBatch({
        ...common,
        target: sharedCoverSource,
        library: verificationLibrary,
      }),
    );
    return;
  }
  const result = handoffPath
    ? discoveryHandoff
      ? await prepareDiscoveryListingAdditions({
          ...common,
          facts: { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
          ...(automaticDiscoveryScope ? { automaticScope: true } : {}),
          ...(releasedDiscoveryValidator
            ? {
                acquireValidator: acquireDiscoveryValidator,
              }
            : {}),
          ...(discoveryDeadline ? { deadline: Number(discoveryDeadline) } : {}),
          ...(discoveryStageSource
            ? {
                stage: {
                  repository,
                  revision: discoveryStageSource,
                  expectedPatchSha256: discoveryExpectedPatch,
                  previewListedDate: discoveryPreviewListedDate,
                },
              }
            : {}),
          ...(discoveryApproval
            ? {
                approval: {
                  document: parseCatalogSource(
                    readArtworkInput(discoveryApproval, 1024 * 1024).bytes.toString("utf8"),
                  ),
                },
              }
            : {}),
          handoff,
        })
      : prepareListingObservations({ ...common, handoff })
    : artworkIds
      ? await prepareArtworkBatch({
          ...common,
          ...(artworkIds === "@due"
            ? { maintenance: true }
            : { selectedPortIds: artworkIds.split(",") }),
          ...(refreshIds ? { refreshPortIds: refreshIds.split(",") } : {}),
          ...(retainedLimit ? { retainedCoverLimit: Number(retainedLimit) } : {}),
        })
      : await preparePort({
          ...common,
          projectUrl: values.get("--project"),
          expectedRepositoryId: repositoryId === undefined ? undefined : Number(repositoryId),
          issue: values.get("--issue"),
          id: values.get("--id"),
          name: values.get("--name"),
          ...(originalGame ? { originalGame: readArtworkJson(originalGame, 64 * 1024) } : {}),
          summary: values.get("--summary"),
          ...(input
            ? {
                record: parseCatalogSource(
                  readArtworkInput(input, 512 * 1024).bytes.toString("utf8"),
                ),
              }
            : {}),
          ...(values.get("--package-observation")
            ? {
                packageObservation: {
                  receipt: parseCatalogSource(
                    readArtworkInput(
                      values.get("--package-observation")!,
                      16 * 1024 * 1024,
                    ).bytes.toString("utf8"),
                  ),
                  reference: values.get("--package-observation-reference")!,
                },
              }
            : {}),
          ...(values.get("--settings-native-scope")
            ? {
                settingsNativeScope: parseCatalogSource(
                  readArtworkInput(values.get("--settings-native-scope")!, 8192).bytes.toString(
                    "utf8",
                  ),
                ),
              }
            : {}),
          ...(route === undefined ? {} : { route }),
          releaseTag: values.get("--release-tag"),
          facts: { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
        });
  printPreparationResult(result);
}

function printPreparationResult(result: {
  path: string;
  report: ({ port_id: string } | { selected_port_ids: readonly unknown[] }) & {
    files: unknown;
    next: string;
  };
}) {
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
