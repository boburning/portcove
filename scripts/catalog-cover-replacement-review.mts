import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  checkedAuthoredPort,
  parseCatalogSource,
  readCatalogSource,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { positiveId, validArtworkMapping } from "./catalog-cover-mapping.mts";
import { readArtworkInput, readArtworkJson } from "./inspect-igdb-artwork.mts";
import { readAuthenticatedCoverPreimages } from "./listing-observation-delivery.mts";
import { acquireCheckpointProcessLock } from "./process-lock.mts";
import { prepareArtworkBatch } from "./prepare-port.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
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
    if (!replacement || isDeepStrictEqual(proposedMapping, effective)) return [];
    if (
      proposedMapping.cover_id === effective.cover_id ||
      proposedMapping.image_id === effective.image_id ||
      proposedMapping.image_sha256 === effective.image_sha256
    )
      throw new Error(`Changed effective cover bytes need independent source evidence: ${id}`);
    if (proposedMapping.cover_id === prior.cover_id || proposedMapping.image_id === prior.image_id)
      throw new Error(`Changed cover bytes need independent source evidence: ${id}`);
    const withPriorCover = { ...replacement, listing: { ...replacement.listing, artwork: prior } };
    if (!isDeepStrictEqual(withPriorCover, record) || isDeepStrictEqual(proposedMapping, prior))
      throw new Error(`Cover proposal changed facts outside the replacement mapping: ${id}`);
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

export async function withCoverReviewCheckpoint<T>(
  output: string,
  scope: object,
  run: (workset: string, lockScope: string) => Promise<T>,
): Promise<T> {
  const binding = path.join(output, "review-scope.json");
  if (!existsSync(output)) {
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(binding, `${JSON.stringify(scope)}\n`, { flag: "wx", mode: 0o600 });
  }
  const info = lstatSync(output);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Cover replacement checkpoint is not an owned directory.");
  if (
    !existsSync(binding) ||
    !lstatSync(binding).isFile() ||
    !isDeepStrictEqual(readArtworkJson(binding), scope)
  )
    throw new Error("Cover replacement checkpoint is foreign, stale, or already completed.");
  const locks = path.join(output, "review-locks");
  if (!existsSync(locks)) mkdirSync(locks, { recursive: true, mode: 0o700 });
  if (!lstatSync(locks).isDirectory())
    throw new Error("Cover replacement checkpoint lock directory is invalid.");
  const lockScope = observationHash(scope);
  const lock = await acquireCheckpointProcessLock(path.join(locks, "active.lock"), lockScope);
  try {
    const workset = path.join(output, "preparation");
    if (
      !existsSync(binding) ||
      !lstatSync(binding).isFile() ||
      !isDeepStrictEqual(readArtworkJson(binding), scope) ||
      readdirSync(output).some(
        (entry) => !["review-scope.json", "review-locks", "preparation"].includes(entry),
      )
    )
      throw new Error("Cover replacement checkpoint is foreign, stale, or already completed.");
    if (existsSync(workset) && !lstatSync(workset).isDirectory())
      throw new Error("Cover replacement preparation is not an owned directory.");
    return await run(workset, lockScope);
  } finally {
    await lock.release();
  }
}

async function prepare(
  root: string,
  source: string,
  ids: string[],
  validatorCli: string,
  output: string,
  signedPrior?: { repository: string; releaseTools: string },
) {
  function requireSource() {
    if (
      git(root, ["rev-parse", "HEAD"]) !== source ||
      git(root, ["status", "--porcelain", "--untracked-files=normal"])
    )
      throw new Error("Cover replacement review requires the exact clean source checkout.");
  }
  requireSource();
  const catalogRoot = path.join(root, "crates", "portcove-core", "catalog");
  const authored = readCatalogSource(catalogRoot);
  const subjects = coveredSubjects(authored.records, ids);
  const validatorSha = sha(await readControllerToolFile(validatorCli, 256 * 1024 * 1024));
  const identities = Object.fromEntries(
    subjects.map(({ id, prior, name }) => [
      id,
      {
        underlying_game: {
          game_id: prior.game_id,
          slug: prior.game_slug,
          names: [name],
          evidence_url: `https://www.igdb.com/games/${prior.game_slug}`,
        },
      },
    ]),
  );
  let effective: Awaited<ReturnType<typeof readAuthenticatedCoverPreimages>> | undefined;
  if (signedPrior) {
    const workspace = mkdtempSync(path.join(tmpdir(), "cover-review-prior-"));
    try {
      effective = await readAuthenticatedCoverPreimages(
        {
          site: signedPrior.repository,
          tools: signedPrior.releaseTools,
          root: path.join(catalogRoot, "official-definition-root.json"),
          offlineTargets: path.join(
            root,
            "release/bootstrap-public-inputs/catalog/offline-targets.json",
          ),
          workspace,
        },
        authored.directory,
        ids,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  const scope = {
    rule,
    source_commit: source,
    validator_sha256: validatorSha,
    subjects: subjects.map(({ id, record, prior }) => ({
      id,
      sha256: observationHash(record),
      effective: observationHash(effective?.preimages.get(id) ?? prior),
    })),
  };
  await withCoverReviewCheckpoint(output, scope, async (workset, lockScope) => {
    const result = await prepareArtworkBatch({
      catalogRoot,
      outputDirectory: workset,
      recoverableCheckpointScope: lockScope,
      validatorCli,
      identities,
      selectedPortIds: ids,
      refreshPortIds: ids,
    });
    requireSource();
    const { report } = result;
    if (report.pending_port_ids.length)
      throw new Error(
        "Cover replacement evidence is incomplete; the ordinary preparation receipt was kept.",
      );
    const evidenceBytes = readArtworkInput(report.files.artwork, maximumProduct).bytes;
    const evidence = parseCatalogSource(evidenceBytes.toString("utf8"));
    if (!isRecord(evidence) || !Array.isArray(evidence.records))
      throw new Error("Cover replacement observation receipt is malformed.");
    const preparedRecords = report.files.records.map(({ path: file }) =>
      checkedAuthoredPort(readArtworkJson(file)),
    );
    const replacements = reviewCoverReplacementBatch(
      authored.records,
      preparedRecords,
      ids,
      evidence.records,
      validatorSha,
      effective?.preimages,
    );
    const catalogSha = sha(readArtworkInput(report.files.catalog, maximumProduct).bytes);
    const listingsSha = sha(readArtworkInput(report.files.listings, maximumProduct).bytes);
    function requireInspection(receipt: unknown, expectedSha: string) {
      if (
        !isRecord(receipt) ||
        receipt.validator_artifact_sha256 !== validatorSha ||
        receipt.input_sha256 !== expectedSha
      )
        throw new Error("Cover replacement Core validation differs from its bounded proposal.");
    }
    requireInspection(report.listing_validation, listingsSha);
    if (report.operational_changed) requireInspection(report.validation, catalogSha);
    const packet = {
      format_version: 1,
      rule,
      authority: "none",
      state: "pending-independent-review",
      source_commit: source,
      validator_sha256: validatorSha,
      selected_port_ids: ids,
      ...(effective ? { signed_prior_repository_sha256: effective.identity } : {}),
      authored_catalog_sha256: report.accepted_catalog_sha256,
      authored_listings_sha256: report.accepted_listings_sha256,
      preparation_sha256: sha(readArtworkInput(result.path, maximumProduct).bytes),
      artwork_evidence_sha256: sha(evidenceBytes),
      proposed_catalog_sha256: catalogSha,
      proposed_listings_sha256: listingsSha,
      replacements,
    };
    const bytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`);
    if (bytes.length > 1024 * 1024)
      throw new Error("Cover replacement review packet exceeds its byte bound.");
    requireSource();
    const file = path.join(output, `cover-replacement-review-${sha(bytes)}.json`);
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    console.log(file);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "source-commit": { type: "string" },
      "artwork-ids": { type: "string" },
      "validator-cli": { type: "string" },
      "output-dir": { type: "string" },
      "prior-repository": { type: "string" },
      "release-tools": { type: "string" },
    },
  });
  const source = values["source-commit"];
  const ids = values["artwork-ids"];
  const validator = values["validator-cli"];
  const output = values["output-dir"];
  if (!source || !/^[a-f0-9]{40}$/u.test(source) || !ids || !validator || !output)
    throw new Error(
      "Expected --source-commit SHA --artwork-ids ID[,ID] --validator-cli CLI --output-dir CHECKPOINT.",
    );
  const repository = values["prior-repository"];
  const tools = values["release-tools"];
  if (Boolean(repository) !== Boolean(tools))
    throw new Error("--prior-repository and --release-tools must be supplied together.");
  await prepare(
    fileURLToPath(new URL("../", import.meta.url)),
    source,
    ids.split(","),
    path.resolve(validator),
    path.resolve(output),
    repository && tools
      ? { repository: path.resolve(repository), releaseTools: path.resolve(tools) }
      : undefined,
  );
}
