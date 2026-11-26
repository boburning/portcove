import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCatalogSource, readCatalogSource } from "./catalog-authoring.mts";
import {
  bounded,
  digest,
  exact,
  fixedId,
  mapping,
  readApprovedCoverJournal,
  replacement,
  type Approval,
  type ApprovedCoverJournal,
  type Mapping,
} from "./catalog-cover-approval-journal.mts";
export { readApprovedCoverJournal } from "./catalog-cover-approval-journal.mts";
import {
  createCoreImageValidator,
  createIgdbInspector,
  isConfirmedIgdbImageGone,
} from "./inspect-igdb-artwork.mts";
import {
  coverDeclarationScope,
  legacyCoverDeclarationScope,
} from "./listing-artwork-checkpoint.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

const maxInput = 60 * 1024;
const sha = /^[a-f0-9]{64}$/u;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const originalGameUrl = (slug: string) => `https://www.igdb.com/games/${slug}`;

function matches(row: Record<string, unknown> | undefined, entry: Approval) {
  return row && entry.scope === coverDeclarationScope(row, entry.authored);
}

export function projectApprovedCovers<T extends { listings: Record<string, unknown>[] }>(
  directory: T,
  approvals: ApprovedCoverJournal,
  canonical = directory.listings,
): T {
  if (!approvals.approvals.length) return directory;
  const originals = new Map(canonical.map((listing) => [listing.id, listing]));
  const active = new Map(approvals.approvals.map((row) => [row.id, row]));
  return {
    ...directory,
    listings: directory.listings.map((listing) => {
      const entry = typeof listing.id === "string" ? active.get(listing.id) : undefined;
      return entry && matches(originals.get(listing.id), entry)
        ? { ...listing, artwork: entry.candidate }
        : listing;
    }),
  };
}

interface CoverApprovalInput {
  packet: string;
  digest: string;
  preimages: string;
  run: string;
}

export function protectedCoverApproval(
  environment: NodeJS.ProcessEnv,
): CoverApprovalInput | undefined {
  const packet = environment.PORTCOVE_COVER_REVIEW_PACKET ?? "";
  const digest = environment.PORTCOVE_COVER_REVIEW_SHA256 ?? "";
  const preimages = environment.PORTCOVE_COVER_REVIEW_PREIMAGES ?? "";
  if (!packet && !digest && !preimages) return undefined;
  const run = environment.GITHUB_RUN_ID;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_REPOSITORY_ID !== "1354613114" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_WORKFLOW_REF !==
      "boburning/portcove/.github/workflows/catalog-publish.yml@refs/heads/main" ||
    environment.GITHUB_ACTOR_ID !== "43177418" ||
    environment.PORTCOVE_TRIGGERING_ACTOR !== "boburning" ||
    typeof run !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(run) ||
    !bounded(Buffer.byteLength(packet), maxInput) ||
    !sha.test(digest) ||
    hash(packet) !== digest ||
    !bounded(Buffer.byteLength(preimages), 8 * 1024)
  )
    throw new Error("Cover replacement requires exact owner-approved publisher inputs");
  return { packet, digest, preimages, run };
}

export async function acceptApprovedCovers(options: {
  input: CoverApprovalInput;
  prior: ApprovedCoverJournal;
  canonical: { listings: Record<string, unknown>[] };
  compatibleCanonical: { listings: Record<string, unknown>[] };
  authenticatedPriorSha: string;
  previous: { listings: Record<string, unknown>[] };
  priorWasWithdrawn: (row: Record<string, unknown>, artwork: Mapping) => boolean;
  canonicalSha: string;
  catalogSha: string;
  canonicalPath: string;
  cli: string;
  scratch: string;
  inspectImage?: (image: string, byteLimit: number) => Promise<unknown>;
}) {
  const { input, prior } = options;
  if (prior.consumed_packets.includes(input.digest))
    throw new Error("Cover replacement packet has already been consumed");
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.dirname(options.canonicalPath),
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4096,
  }).trim();
  const packet = parseCatalogSource(input.packet);
  const preimages = parseCatalogSource(input.preimages);
  if (
    !isRecord(packet) ||
    packet.format_version !== 1 ||
    packet.rule !== "same-original-game-cover-review-v1" ||
    packet.authority !== "none" ||
    packet.state !== "pending-independent-review" ||
    packet.source_commit !== source ||
    packet.authored_catalog_sha256 !== options.catalogSha ||
    packet.authored_listings_sha256 !== options.canonicalSha ||
    !digest(packet.signed_prior_repository_sha256) ||
    packet.signed_prior_repository_sha256 !== options.authenticatedPriorSha ||
    !Array.isArray(packet.selected_port_ids) ||
    !Array.isArray(packet.replacements) ||
    !bounded(packet.selected_port_ids.length, 32) ||
    !bounded(packet.replacements.length, 32) ||
    !isRecord(preimages) ||
    Object.keys(preimages).length !== packet.replacements.length
  )
    throw new Error("Cover replacement packet differs from the current CI-green source");
  const selected = new Set<unknown>(packet.selected_port_ids);
  if (selected.size !== packet.selected_port_ids.length || [...selected].some((id) => !fixedId(id)))
    throw new Error("Invalid duplicate cover replacement subjects");
  const authored = new Map(
    readCatalogSource(path.dirname(options.canonicalPath)).records.map((row) => [
      row.listing.id,
      row,
    ]),
  );
  const sourceRows = new Map(options.canonical.listings.map((row) => [row.id, row]));
  const compatibleRows = new Map(options.compatibleCanonical.listings.map((row) => [row.id, row]));
  const previousRows = new Map(options.previous.listings.map((row) => [row.id, row]));
  const entries = new Map(prior.approvals.map((row) => [row.id, row]));
  const seen = new Set<string>();
  let inspect = options.inspectImage;
  let totalBytes = 0;
  for (const value of packet.replacements as unknown[]) {
    if (
      !isRecord(value) ||
      !exact(
        value,
        "accepted_prior,candidate,content,port_id,prior,prior_record_sha256,proposed_record_sha256,role,source",
      ) ||
      !fixedId(value.port_id) ||
      !selected.has(value.port_id) ||
      seen.has(value.port_id) ||
      value.role !== "cover" ||
      !mapping(value.prior) ||
      !mapping(value.accepted_prior) ||
      !mapping(value.candidate) ||
      (!isDeepStrictEqual(value.prior, value.candidate) &&
        !replacement(value.prior, value.candidate)) ||
      value.source !== originalGameUrl(value.prior.game_slug) ||
      !isRecord(value.content) ||
      !exact(value.content, "bytes,format,height,sha256,width") ||
      value.content.sha256 !== value.candidate.image_sha256 ||
      value.content.format !== "jpeg" ||
      !bounded(value.content.bytes, 16 * 1024 * 1024) ||
      !bounded(value.content.width, 8192) ||
      !bounded(value.content.height, 8192) ||
      value.content.width * value.content.height > 8 * 1024 * 1024
    )
      throw new Error("Malformed or duplicate cover replacement candidate");
    const row = sourceRows.get(value.port_id);
    const record = authored.get(value.port_id);
    const compatible = compatibleRows.get(value.port_id);
    const old = previousRows.get(value.port_id);
    const former = entries.get(value.port_id);
    const active = former && matches(compatible, former) ? former : undefined;
    const approvedPrior = active?.candidate ?? value.prior;
    const authoredAnchor = active?.authored ?? value.prior;
    if (
      !row ||
      !old ||
      old.collection_covers !== undefined ||
      !compatible ||
      coverDeclarationScope({ ...old, artwork: value.prior }, value.prior) !==
        coverDeclarationScope(compatible, value.prior) ||
      !record ||
      !Object.hasOwn(preimages, value.port_id) ||
      !isDeepStrictEqual(row.artwork, value.prior) ||
      !isDeepStrictEqual(record.listing.artwork, value.prior) ||
      typeof record.listing.original_game_title !== "string" ||
      !record.listing.original_game_title.trim() ||
      row.collection_covers !== undefined ||
      record.listing.collection_covers !== undefined ||
      record.igdb_regional_cover !== undefined ||
      (isRecord(record.integration?.presentation) &&
        record.integration.presentation.companion_cover !== undefined) ||
      observationHash(record) !== value.prior_record_sha256 ||
      observationHash({ ...record, listing: { ...record.listing, artwork: value.candidate } }) !==
        value.proposed_record_sha256 ||
      !isDeepStrictEqual(value.accepted_prior, approvedPrior) ||
      preimages[value.port_id] !== approvedPrior.image_sha256 ||
      !isDeepStrictEqual(
        old.artwork,
        options.priorWasWithdrawn(compatible, approvedPrior) ? undefined : approvedPrior,
      ) ||
      !replacement(approvedPrior, value.candidate) ||
      !replacement(authoredAnchor, value.candidate)
    )
      throw new Error(
        "Cover replacement differs from the authenticated preimage or authored subject",
      );
    seen.add(value.port_id);
    totalBytes += value.content.bytes;
    if (totalBytes > 48 * 1024 * 1024)
      throw new Error("Cover replacement batch exceeds image byte bound");
    if (!inspect) {
      const images = createIgdbInspector(
        null,
        createCoreImageValidator(options.cli, options.scratch),
      );
      inspect = (id, size) => images.inspectImage(id, size);
    }
    const content = await inspect(value.candidate.image_id, value.content.bytes);
    if (
      !isRecord(content) ||
      content.sha256 !== value.content.sha256 ||
      content.bytes !== value.content.bytes ||
      content.width !== value.content.width ||
      content.height !== value.content.height ||
      content.format !== "jpeg"
    )
      throw new Error("Reviewed cover differs from the verified CDN bytes");
    entries.set(value.port_id, {
      id: value.port_id,
      scope: coverDeclarationScope(compatible, authoredAnchor),
      authored: authoredAnchor,
      prior: approvedPrior,
      role: "cover",
      candidate: value.candidate,
      bytes: content.bytes,
      packet: input.digest,
      source,
      run: input.run,
    });
  }
  return readApprovedCoverJournal({
    format_version: 1,
    approvals: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
    consumed_packets: [...prior.consumed_packets, input.digest],
  });
}

export function activeApprovedCovers(
  journal: ApprovedCoverJournal,
  canonical: { listings: Record<string, unknown>[] },
) {
  const rows = new Map(canonical.listings.map((listing) => [listing.id, listing]));
  return journal.approvals.filter((entry) => matches(rows.get(entry.id), entry));
}

/** Check only effective approved covers. A provider can report Gone or prove the
 * already-pinned bytes returned, never propose different bytes here. */
export async function observeApprovedCoverHealth(options: {
  journal: ApprovedCoverJournal;
  compatible: { listings: Record<string, unknown>[] };
  now: number;
  cli: string;
  scratch: string;
  inspectImage?: (image: string, byteLimit: number) => Promise<unknown>;
}) {
  const compatible = new Map(options.compatible.listings.map((listing) => [listing.id, listing]));
  const active = activeApprovedCovers(options.journal, options.compatible);
  const batchSize = 8;
  const slots = Math.ceil(active.length / batchSize);
  const cursor = slots ? Math.floor(options.now / (12 * 60 * 60 * 1000)) % slots : 0;
  const selected = active.slice(cursor * batchSize, (cursor + 1) * batchSize);
  const observations = [];
  let inspect = options.inspectImage;
  let remaining = 48 * 1024 * 1024;
  const observedAt = new Date(options.now).toISOString();
  for (const entry of selected) {
    const declaration = compatible.get(entry.id);
    if (!declaration || entry.bytes > remaining) continue;
    remaining -= entry.bytes;
    const artwork = entry.candidate;
    if (!inspect) {
      const images = createIgdbInspector(
        null,
        createCoreImageValidator(options.cli, options.scratch),
      );
      inspect = (id, size) => images.inspectImage(id, size);
    }
    let status: "verified_accepted_bytes" | "propose_fallback";
    try {
      const bytes = await inspect(artwork.image_id, entry.bytes);
      if (!isRecord(bytes) || bytes.sha256 !== artwork.image_sha256 || bytes.bytes !== entry.bytes)
        continue;
      status = "verified_accepted_bytes";
    } catch (error) {
      if (!isConfirmedIgdbImageGone(error, artwork.image_id)) continue;
      status = "propose_fallback";
    }
    const scope = coverDeclarationScope(declaration, artwork);
    const receipt = observationHash({
      format: "protected-approved-cover-health-v1",
      subject: entry.id,
      scope,
      approved_packet: entry.packet,
      image: artwork,
      bytes: entry.bytes,
      observed_at: observedAt,
      status,
    });
    observations.push({
      id: entry.id,
      artwork,
      scope,
      legacy_scopes: [legacyCoverDeclarationScope(declaration, artwork)],
      observed_at: observedAt,
      status,
      report: `sha256:${receipt}`,
    });
  }
  return { observations };
}
