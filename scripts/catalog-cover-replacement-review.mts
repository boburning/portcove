import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  checkedAuthoredPort,
  parseCatalogSource,
  readCatalogSource,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { positiveId, validArtworkMapping } from "./catalog-cover-mapping.mts";
import { hashCoreImageValidatorFile, readArtworkInput } from "./inspect-igdb-artwork.mts";
import { readAuthenticatedCoverPreimages } from "./listing-observation-delivery.mts";
import { prepareArtworkBatch } from "./prepare-port.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

const rule = "same-original-game-cover-review-v1";
const maximumRows = 32;
const maximumProduct = 16 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function coveredSubjects(records: readonly AuthoredPort[], ids: readonly string[]) {
  if (!ids.length || ids.length > maximumRows || new Set(ids).size !== ids.length)
    throw new Error("Cover replacement review requires 1 to 32 unique existing subjects.");
  const current = new Map(records.map((record) => [record.listing.id, record]));
  return ids.map((id) => {
    const record = current.get(id);
    const listing = record?.listing;
    const prior = listing?.artwork;
    const name = listing?.original_game_title;
    const presentation = record?.integration?.presentation;
    if (
      !record ||
      !listing ||
      !validArtworkMapping(prior) ||
      prior.match_kind !== "underlying-game" ||
      typeof name !== "string" ||
      !name.trim() ||
      listing.collection_covers !== undefined ||
      record.igdb_regional_cover !== undefined ||
      (isRecord(presentation) && presentation.companion_cover !== undefined)
    )
      throw new Error(
        `Cover replacement review requires an existing general original-game cover: ${id}`,
      );
    return { id, record, prior, name };
  });
}

/** Review data remains separate from the protected approval authority. */
export function reviewCoverReplacementBatch(
  current: readonly AuthoredPort[],
  proposed: readonly AuthoredPort[],
  selectedIds: readonly string[],
  observations: readonly unknown[],
  validatorSha: string,
  effectiveCovers: ReadonlyMap<string, unknown> = new Map(),
) {
  const subjects = coveredSubjects(current, selectedIds);
  const results = new Map<string, Record<string, unknown>>();
  const selected = new Set(selectedIds);
  for (const entry of observations) {
    if (!isRecord(entry) || typeof entry.port_id !== "string" || !selected.has(entry.port_id))
      continue;
    if (results.has(entry.port_id)) throw new Error("Duplicate selected cover observation.");
    results.set(entry.port_id, entry);
  }
  const replacements = new Map<string, AuthoredPort>();
  for (const entry of proposed) {
    if (!selected.has(entry.listing.id) || replacements.has(entry.listing.id))
      throw new Error("Cover proposal changed an unselected or duplicate subject.");
    replacements.set(entry.listing.id, entry);
  }
  return subjects.flatMap(({ id, record, prior }) => {
    const effective = effectiveCovers.get(id) ?? prior;
    if (
      !validArtworkMapping(effective) ||
      effective.game_id !== prior.game_id ||
      effective.game_slug !== prior.game_slug ||
      effective.match_kind !== prior.match_kind
    )
      throw new Error(`Signed effective cover differs from its authored identity: ${id}`);
    const observation = results.get(id);
    const replacement = replacements.get(id);
    const proposedMapping = replacement?.listing.artwork ?? prior;
    const checks = observation?.checks;
    const identity = isRecord(checks) ? checks.identity : undefined;
    const content = isRecord(checks) ? checks.content : undefined;
    if (
      observation?.role !== "cover" ||
      observation.reason !== "exact-original-game-cover" ||
      !validArtworkMapping(proposedMapping) ||
      !isDeepStrictEqual(observation.mapping, proposedMapping) ||
      proposedMapping.game_id !== prior.game_id ||
      proposedMapping.game_slug !== prior.game_slug ||
      proposedMapping.match_kind !== prior.match_kind ||
      !isRecord(identity) ||
      identity.kind !== "underlying-game" ||
      identity.game_id !== prior.game_id ||
      identity.slug !== prior.game_slug ||
      identity.evidence_url !== `https://www.igdb.com/games/${prior.game_slug}` ||
      !isRecord(content) ||
      content.validator !== "portcove-core" ||
      content.validator_artifact_sha256 !== validatorSha ||
      content.sha256 !== proposedMapping.image_sha256 ||
      content.format !== "jpeg" ||
      !positiveId(content.bytes) ||
      content.bytes > 16 * 1024 * 1024 ||
      !positiveId(content.width) ||
      !positiveId(content.height) ||
      content.width > 8192 ||
      content.height > 8192 ||
      content.width * content.height > 8 * 1024 * 1024
    )
      throw new Error(
        `Cover observation is incomplete or differs from the accepted subject: ${id}`,
      );
    if (!replacement) return [];
    const withPriorCover = { ...replacement, listing: { ...replacement.listing, artwork: prior } };
    if (!isDeepStrictEqual(withPriorCover, record))
      throw new Error("Cover proposal changed facts outside the replacement mapping: " + id);
    if (isDeepStrictEqual(proposedMapping, effective)) return [];
    if (
      proposedMapping.cover_id === effective.cover_id ||
      proposedMapping.image_id === effective.image_id ||
      proposedMapping.image_sha256 === effective.image_sha256
    )
      throw new Error(`Changed effective cover bytes need independent source evidence: ${id}`);
    if (proposedMapping.cover_id === prior.cover_id || proposedMapping.image_id === prior.image_id)
      throw new Error(`Changed cover bytes need independent source evidence: ${id}`);
    return [
      {
        port_id: id,
        role: "cover",
        source: identity.evidence_url,
        prior_record_sha256: observationHash(record),
        proposed_record_sha256: observationHash(replacement),
        prior,
        accepted_prior: effective,
        candidate: proposedMapping,
        content: {
          sha256: content.sha256,
          bytes: content.bytes,
          width: content.width,
          height: content.height,
          format: content.format,
        },
      },
    ];
  });
}

function git(directory: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function preparedArtifact(file: string, name: string) {
  const { bytes } = readArtworkInput(file, maximumProduct);
  const identity = sha(bytes);
  if (path.basename(file) !== name + "-" + identity + ".json")
    throw new Error("Prepared cover artifact changed: " + name);
  return { bytes, identity };
}

type ArtworkBatch = Awaited<ReturnType<typeof prepareArtworkBatch>>;

export function readCoverPreparation(result: {
  path: string;
  report: Pick<ArtworkBatch["report"], "files" | "record_changes">;
}) {
  const { report } = result;
  const completion = preparedArtifact(result.path, "completion");
  if (completion.identity !== sha(Buffer.from(JSON.stringify(report, null, 2) + "\n")))
    throw new Error("Cover preparation manifest changed");
  const artwork = preparedArtifact(report.files.artwork, "artwork-evidence");
  const evidence = parseCatalogSource(artwork.bytes.toString("utf8"));
  if (!isRecord(evidence) || !Array.isArray(evidence.records))
    throw new Error("Cover replacement observation receipt is malformed.");
  const changes = new Map(report.record_changes.map((change) => [change.id, change]));
  if (changes.size !== report.record_changes.length || changes.size !== report.files.records.length)
    throw new Error("Cover preparation inventories differ");
  const prepared = report.files.records.map(({ id, path: file }) => {
    const entry = changes.get(id);
    const record = checkedAuthoredPort(
      parseCatalogSource(preparedArtifact(file, id).bytes.toString("utf8")),
      id,
    );
    if (!entry || observationHash(record) !== entry.after_sha256)
      throw new Error("Cover preparation record differs from its manifest: " + id);
    changes.delete(id);
    return record;
  });
  const listings = preparedArtifact(report.files.listings, "listings");
  return {
    prepared,
    records: evidence.records as unknown[],
    completionSha: completion.identity,
    evidenceSha: artwork.identity,
    catalogSha: preparedArtifact(report.files.catalog, "catalog").identity,
    listingsSha: listings.identity,
    listings: parseCatalogSource(listings.bytes.toString("utf8")),
  };
}

export function requireReviewedListingCovers(
  listings: unknown,
  replacements: ReturnType<typeof reviewCoverReplacementBatch>,
) {
  if (!isRecord(listings) || !Array.isArray(listings.listings))
    throw new Error("Prepared listing coverage is malformed");
  const entries = new Map<string, unknown>();
  for (const row of listings.listings as unknown[]) {
    if (!isRecord(row) || typeof row.id !== "string" || entries.has(row.id))
      throw new Error("Prepared listing coverage contains an invalid identity");
    entries.set(row.id, row.artwork);
  }
  for (const { port_id, candidate } of replacements)
    if (!isDeepStrictEqual(entries.get(port_id), candidate))
      throw new Error("Reviewed candidate differs from the Core-validated listing: " + port_id);
}

async function prepareReplacementReview(input: {
  root: string;
  source: string;
  selected: readonly string[];
  validatorCli: string;
  output: string;
  repository: string;
  history: string;
  releaseTools: string;
}) {
  const requireSource = () => {
    if (
      git(input.root, ["rev-parse", "HEAD"]) !== input.source ||
      git(input.root, ["status", "--porcelain", "--untracked-files=normal"])
    )
      throw new Error("Cover replacement review requires the exact clean source checkout.");
  };
  requireSource();
  const catalogRoot = path.join(input.root, "crates", "portcove-core", "catalog");
  const authored = readCatalogSource(catalogRoot);
  const subjects = coveredSubjects(authored.records, input.selected);
  const validatorSha = hashCoreImageValidatorFile(input.validatorCli);
  mkdirSync(input.output, { mode: 0o700 });
  const workspace = path.join(input.output, "signed-predecessor");
  mkdirSync(workspace, { mode: 0o700 });
  const effective = await readAuthenticatedCoverPreimages(
    {
      repository: input.repository,
      history: input.history,
      workspace,
      tools: input.releaseTools,
      root: path.join(catalogRoot, "official-definition-root.json"),
      offlineTargets: path.join(
        input.root,
        "release/bootstrap-public-inputs/catalog/offline-targets.json",
      ),
    },
    authored.directory,
    input.selected,
  );
  const identities = Object.fromEntries(
    subjects.map(({ id, prior, name }) => [
      id,
      {
        underlying_game: {
          game_id: prior.game_id,
          slug: prior.game_slug,
          names: [name],
          evidence_url: "https://www.igdb.com/games/" + prior.game_slug,
        },
      },
    ]),
  );
  const result = await prepareArtworkBatch({
    catalogRoot,
    outputDirectory: path.join(input.output, "preparation"),
    validatorCli: input.validatorCli,
    identities,
    selectedPortIds: input.selected,
    refreshPortIds: input.selected,
    revalidateAccepted: true,
  });
  requireSource();
  if (hashCoreImageValidatorFile(input.validatorCli) !== validatorSha)
    throw new Error("Core image validator changed during cover replacement review.");
  const { report } = result;
  if (report.pending_port_ids.length)
    throw new Error("Cover replacement evidence is incomplete; preparation evidence is retained.");
  if (!isDeepStrictEqual(report.selected_port_ids, input.selected))
    throw new Error("Cover preparation no longer matches the exact selected identities.");
  const preparation = readCoverPreparation(result);
  const replacements = reviewCoverReplacementBatch(
    authored.records,
    preparation.prepared,
    input.selected,
    preparation.records,
    validatorSha,
    effective.preimages,
  );
  if (!replacements.length) throw new Error("No changed covers qualified for independent review.");
  requireReviewedListingCovers(preparation.listings, replacements);
  function requireInspection(receipt: unknown, expectedSha: string) {
    if (
      !isRecord(receipt) ||
      receipt.validator_artifact_sha256 !== validatorSha ||
      receipt.input_sha256 !== expectedSha
    )
      throw new Error("Cover replacement Core validation differs from the exact proposal.");
  }
  requireInspection(report.listing_validation, preparation.listingsSha);
  if (report.operational_changed) requireInspection(report.validation, preparation.catalogSha);
  const packet = {
    format_version: 1,
    rule,
    authority: "none",
    state: "pending-independent-review",
    source_commit: input.source,
    validator_sha256: validatorSha,
    selected_port_ids: input.selected,
    signed_prior_repository_sha256: effective.identity,
    authored_catalog_sha256: report.accepted_catalog_sha256,
    authored_listings_sha256: report.accepted_listings_sha256,
    preparation_sha256: preparation.completionSha,
    artwork_evidence_sha256: preparation.evidenceSha,
    proposed_catalog_sha256: preparation.catalogSha,
    proposed_listings_sha256: preparation.listingsSha,
    replacements,
  };
  const bytes = Buffer.from(JSON.stringify(packet, null, 2) + "\n");
  if (bytes.length > 60 * 1024)
    throw new Error("Cover replacement review packet exceeds its byte bound.");
  const file = path.join(input.output, "cover-replacement-review-" + sha(bytes) + ".json");
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      "source-commit": { type: "string" },
      "artwork-ids": { type: "string" },
      "validator-cli": { type: "string" },
      "output-dir": { type: "string" },
      "prior-repository": { type: "string" },
      "prior-history": { type: "string" },
      "release-tools": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/catalog-cover-replacement-review.mts --source-commit SHA --artwork-ids ID[,ID] --validator-cli ABS --output-dir NEW_ABS --prior-repository ABS --prior-history ABS --release-tools ABS",
    );
  } else {
    const source = values["source-commit"];
    const ids = values["artwork-ids"];
    const validatorCli = values["validator-cli"];
    const output = values["output-dir"];
    const repository = values["prior-repository"];
    const history = values["prior-history"];
    const releaseTools = values["release-tools"];
    if (
      !source ||
      !/^[a-f0-9]{40}$/u.test(source) ||
      !ids ||
      !validatorCli ||
      !output ||
      !repository ||
      !history ||
      !releaseTools ||
      ![validatorCli, output, repository, history, releaseTools].every(path.isAbsolute)
    )
      throw new Error(
        "Cover replacement review requires exact source and absolute input paths. Use --help.",
      );
    console.log(
      await prepareReplacementReview({
        root: fileURLToPath(new URL("../", import.meta.url)),
        source,
        selected: ids.split(","),
        validatorCli,
        output,
        repository,
        history,
        releaseTools,
      }),
    );
  }
}
