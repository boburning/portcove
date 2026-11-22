/** Rehearse compact format-15 listing activation without signing or publishing.
 * Uses the production projection, gate and successor functions on fixtures or
 * the committed catalog. Nothing here reads a key, Pages or a release. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "./runtime-values.mts";
import {
  compactListingCarrier,
  compactListingDecodedMaximum,
  decodeRetainedCompactListing,
  encodeCompactListing,
  listingDeliveryMaximum,
} from "./listing-directory-carrier.mts";
import {
  isolateValidEnrichment,
  legacyHoldSuccessor,
  projectListingDelivery,
  publishedAbove,
  requireCompactListingReader,
  reviewedLegacySuccessor,
} from "./listing-observation-delivery.mts";

export const compactActivationFormat = 15;
const legacyFormat = 11;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Row = Record<string, unknown> & { id: string };
interface Directory {
  format_version: number;
  listings: Row[];
}
interface Delivery {
  revision: number;
  withdrawn_ids: string[];
  directory: Directory;
}
const read = (bytes: Buffer) => JSON.parse(bytes.toString("utf8")) as Delivery;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function refused(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return message(error);
  }
  throw new Error("Rehearsal expected a refusal");
}

/** First activation requires a reviewed released reader with the compact
 * carrier and exactly the format it will receive. */
export function requireCompactActivationReader(report: unknown, candidateFormat: number) {
  if (candidateFormat !== compactActivationFormat)
    throw new Error(
      `Compact activation is reviewed for listing format ${compactActivationFormat}; the candidate is format ${candidateFormat}`,
    );
  return requireCompactListingReader(report, compactActivationFormat);
}

/** Mirror of release-tools `listing_targets`: both carriers share one revision. */
export function listingCarrierPairAdmissible(legacy: Buffer, compactDecoded: Buffer) {
  const old = read(legacy);
  const next = read(compactDecoded);
  return (
    (next.revision > old.revision ||
      (next.revision === old.revision && hash(legacy) === hash(compactDecoded))) &&
    old.withdrawn_ids.every((id) => next.withdrawn_ids.includes(id))
  );
}

/** Mirror of Core `admit_listings`: a reader refuses a replay or equivocation. */
export function readerAdmits(floor: Buffer | null, candidate: Buffer) {
  if (!floor) return true;
  const old = read(floor);
  const next = read(candidate);
  return (
    next.revision > old.revision || (next.revision === old.revision && floor.equals(candidate))
  );
}

interface Restriction {
  id: string;
  effect: string;
  operations: string[];
  scope?: unknown;
  reason?: string;
  explanation?: string;
  reconsider_when?: unknown;
  tracking_issue?: number;
}

/** Typed restriction detail a format-11 reader cannot receive. The format-11
 * string is the first download hold's explanation and holds the whole row. */
export function restrictionsNotExpressibleToLegacy(canonical: Directory) {
  const entries: { listing: string; restriction: string; lost: string[] }[] = [];
  for (const row of canonical.listings) {
    if (!Array.isArray(row.restrictions)) continue;
    const restrictions = row.restrictions as Restriction[];
    const first = restrictions.find(
      (restriction) => restriction.effect === "hold" && restriction.operations.includes("download"),
    );
    for (const restriction of restrictions) {
      const lost: string[] = [];
      if (restriction.effect !== "hold") lost.push(`effect:${restriction.effect}`);
      for (const operation of restriction.operations)
        if (operation !== "download") lost.push(`operation:${operation}`);
      if (restriction.scope !== undefined) lost.push("scope (format 11 holds the whole listing)");
      if (restriction.effect === "hold" && restriction !== first)
        lost.push("explanation (only the first download hold's text is carried)");
      for (const field of ["reason", "reconsider_when", "tracking_issue"] as const)
        if (restriction[field] !== undefined) lost.push(field);
      if (lost.length) entries.push({ listing: row.id, restriction: restriction.id, lost });
    }
  }
  const summary: Record<string, number> = {};
  for (const entry of entries)
    for (const field of entry.lost) summary[field] = (summary[field] ?? 0) + 1;
  const holdLost = entries.filter((entry) =>
    entry.lost.some((field) => field.startsWith("effect:") || field.startsWith("operation:")),
  );
  return { entries, summary, hold_semantics_lost: holdLost.map((entry) => entry.listing) };
}

/** Which canonical download holds the fixed legacy target delivers. */
export function legacyHoldCoverage(legacyProjection: Directory, legacy: Buffer) {
  const document = read(legacy);
  const rows = new Map(document.directory.listings.map((row) => [row.id, row]));
  const withdrawn = new Set(document.withdrawn_ids);
  const coverage = {
    held_in_legacy_target: [] as string[],
    missing_from_legacy_row: [] as string[],
    bundled_fallback: [] as string[],
    withdrawn: [] as string[],
  };
  for (const row of legacyProjection.listings) {
    const reason = row.download_block_reason;
    if (typeof reason !== "string" || !reason.length) continue;
    const delivered = rows.get(row.id);
    if (withdrawn.has(row.id)) coverage.withdrawn.push(row.id);
    else if (!delivered) coverage.bundled_fallback.push(row.id);
    else if (delivered.download_block_reason === reason)
      coverage.held_in_legacy_target.push(row.id);
    else coverage.missing_from_legacy_row.push(row.id);
  }
  return coverage;
}

const capabilities = (formats: number[], carriers: string[]) => ({
  ok: true,
  command: "capabilities",
  data: {
    product: "Portcove",
    product_version: "rehearsal",
    listing_formats: formats,
    listing_delivery_carriers: carriers,
  },
});

function withHold(directory: Directory, id: string, reason: string, typed: boolean): Directory {
  return {
    ...directory,
    listings: directory.listings.map((row) =>
      row.id !== id
        ? row
        : {
            ...row,
            download_block_reason: reason,
            ...(typed
              ? {
                  restrictions: [
                    {
                      id: "rehearsal-hold",
                      effect: "hold",
                      operations: ["download"],
                      reason: "known-defective-artifact",
                      explanation: reason,
                      tracking_issue: 1422,
                    },
                  ],
                }
              : {}),
          },
    ),
  };
}

export interface RehearsalInput {
  /** Complete canonical directory at the compact activation format. */
  canonical: Directory;
  /** Core's format-11 export of the same canonical directory. */
  legacyProjection: Directory;
  operationalIds: ReadonlySet<string>;
  /** Last signed legacy target. A fresh legacy projection stands in when absent. */
  priorLegacy?: Buffer;
  /** An actual `--json capabilities` report to evaluate, when available. */
  releasedReader?: unknown;
  now?: number;
}

export function rehearseCompactActivation(input: RehearsalInput) {
  const now = input.now ?? Date.now();
  const { canonical, legacyProjection, operationalIds } = input;
  if (canonical.format_version !== compactActivationFormat)
    throw new Error(`Rehearsal requires the canonical format-${compactActivationFormat} directory`);
  if (legacyProjection.format_version !== legacyFormat)
    throw new Error("Rehearsal requires Core's format-11 projection");
  const blocking: string[] = [];

  // (1) Released-reader gate.
  const gate = {
    refused: {
      without_compact_carrier: refused(() =>
        requireCompactActivationReader(capabilities([13, 14, 15], ["json-v1"]), 15),
      ),
      format_14_reader: refused(() =>
        requireCompactActivationReader(capabilities([13, 14], [compactListingCarrier]), 15),
      ),
      format_16_candidate: refused(() =>
        requireCompactActivationReader(capabilities([15, 16], [compactListingCarrier]), 16),
      ),
    },
    accepted: requireCompactActivationReader(
      capabilities([13, 14, 15], [compactListingCarrier]),
      15,
    ),
    ...(input.releasedReader === undefined
      ? {}
      : (() => {
          try {
            return {
              released_reader: {
                accepted: true,
                version: requireCompactActivationReader(input.releasedReader, 15),
              },
            };
          } catch (error) {
            return { released_reader: { accepted: false, refusal: message(error) } };
          }
        })()),
  };

  // The last legacy publication before activation.
  const priorLegacy =
    input.priorLegacy ??
    projectListingDelivery(
      canonical,
      [],
      null,
      0,
      listingDeliveryMaximum,
      legacyProjection,
      operationalIds,
      now,
    ).bytes;
  const legacy = read(priorLegacy);
  if (legacy.directory.format_version !== legacyFormat)
    throw new Error("Rehearsal prior legacy target must be format 11");

  // (2) First compact publication bumps the shared revision.
  const project = (
    source: Directory,
    previous: Buffer,
    floor: number,
    withdrawals: readonly string[] = [],
    candidates: readonly Record<string, unknown>[] = [],
  ) =>
    publishedAbove(
      projectListingDelivery(
        source,
        candidates,
        previous,
        floor,
        compactListingDecodedMaximum,
        source,
        operationalIds,
        now,
        withdrawals,
        true,
      ),
      floor,
    );
  const activated = project(canonical, priorLegacy, 0);
  const compact = read(activated.bytes);
  if (compact.directory.format_version !== compactActivationFormat)
    throw new Error("Rehearsal compact activation format differs");
  if (!decodeRetainedCompactListing(encodeCompactListing(activated.bytes)).equals(activated.bytes))
    throw new Error("Rehearsal compact carrier does not round-trip");
  const sameRevision = Buffer.from(JSON.stringify({ ...compact, revision: legacy.revision }));
  if (
    compact.revision <= legacy.revision ||
    !listingCarrierPairAdmissible(priorLegacy, activated.bytes) ||
    listingCarrierPairAdmissible(priorLegacy, sameRevision)
  )
    throw new Error("Compact activation must publish above the legacy revision");
  const revision = {
    legacy: legacy.revision,
    compact: compact.revision,
    same_revision_refused: true,
    format_15_legacy_reader_admits: readerAdmits(priorLegacy, activated.bytes),
  };

  // (3) Legacy readers keep their exact target and every hold it carries.
  const legacyAfterActivation = priorLegacy;
  const coverage = legacyHoldCoverage(legacyProjection, legacyAfterActivation);
  if (coverage.missing_from_legacy_row.length)
    blocking.push(
      `The legacy target lacks the current hold for ${coverage.missing_from_legacy_row.join(", ")}; the first compact successor carries it`,
    );
  const notExpressible = restrictionsNotExpressibleToLegacy(canonical);
  if (notExpressible.hold_semantics_lost.length)
    blocking.push(
      `Format-11 readers cannot receive these holds: ${notExpressible.hold_semantics_lost.join(", ")}`,
    );

  // A new hold after activation reaches format-11 readers as its legacy string.
  const presentUnheld = legacy.directory.listings.find(
    (row) => typeof row.download_block_reason !== "string",
  );
  let newHold: Record<string, unknown> = {
    skipped: "every delivered legacy row already carries a hold",
  };
  if (presentUnheld) {
    const reason = "Rehearsal: fresh acquisition is held after compact activation.";
    const heldCanonical = withHold(canonical, presentUnheld.id, reason, true);
    const heldLegacy = withHold(legacyProjection, presentUnheld.id, reason, false);
    const successor = legacyHoldSuccessor(priorLegacy, heldLegacy, compact.revision + 1);
    if (!successor || !successor.held.includes(presentUnheld.id))
      throw new Error("A new hold did not reach the legacy target");
    const accepted = reviewedLegacySuccessor(priorLegacy, successor.bytes, compact.revision);
    const next = project(heldCanonical, activated.bytes, accepted.revision, accepted.withdrawn_ids);
    const delivered = read(successor.bytes).directory.listings.find(
      (row) => row.id === presentUnheld.id,
    );
    if (
      delivered?.download_block_reason !== reason ||
      !listingCarrierPairAdmissible(successor.bytes, next.bytes) ||
      !readerAdmits(priorLegacy, successor.bytes) ||
      !readerAdmits(activated.bytes, next.bytes)
    )
      throw new Error("A new legacy hold successor is not admissible");
    const nextRevision = read(next.bytes).revision;
    const loosened = Buffer.from(
      JSON.stringify({
        ...read(successor.bytes),
        revision: nextRevision + 1,
        directory: {
          ...accepted.directory,
          listings: accepted.directory.listings.map((row) => {
            if (row.id !== presentUnheld.id) return row;
            const { download_block_reason: _, ...rest } = row;
            return rest;
          }),
        },
      }),
    );
    const loosening = refused(() =>
      reviewedLegacySuccessor(successor.bytes, loosened, nextRevision),
    );
    if (!loosening.includes("may not clear a download hold"))
      throw new Error("A legacy hold was not protected: " + loosening);
    newHold = {
      listing: presentUnheld.id,
      legacy_revision: accepted.revision,
      compact_revision: nextRevision,
      legacy_row_held: true,
      other_legacy_rows_unchanged: true,
      loosening_refused: loosening,
      canonical_drop_keeps_legacy_hold:
        legacyHoldSuccessor(successor.bytes, legacyProjection, accepted.revision + 1) === null,
    };
  }
  const absent = coverage.bundled_fallback[0];
  const absentRow = absent ? legacyProjection.listings.find((row) => row.id === absent) : undefined;
  const absentHold = absentRow
    ? (() => {
        const added = Buffer.from(
          JSON.stringify({
            ...legacy,
            revision: compact.revision + 1,
            directory: {
              ...legacy.directory,
              listings: [...legacy.directory.listings, absentRow].sort((a, b) =>
                a.id.localeCompare(b.id, "en"),
              ),
            },
          }),
        );
        reviewedLegacySuccessor(priorLegacy, added, compact.revision);
        return {
          listing: absent,
          reviewed_held_row_addition_accepted: true,
          unheld_row_addition_refused: refused(() =>
            reviewedLegacySuccessor(
              priorLegacy,
              Buffer.from(
                JSON.stringify({
                  ...read(added),
                  directory: {
                    ...legacy.directory,
                    listings: [
                      ...legacy.directory.listings,
                      { ...absentRow, download_block_reason: undefined },
                    ],
                  },
                }),
              ),
              compact.revision,
            ),
          ),
        };
      })()
    : { skipped: "every held listing is delivered by the legacy target" };

  // (4) Bad optional enrichment cannot stall publication.
  const [goodRow, badRow] = canonical.listings;
  if (!goodRow || !badRow) throw new Error("Rehearsal needs at least two canonical listings");
  const observation = (repository: unknown) => ({
    provider: "github",
    repository,
    status: "complete",
    attempted_at: new Date(now - 1000).toISOString(),
    observed_at: new Date(now - 2000).toISOString(),
    fresh_until: new Date(now + 3_600_000).toISOString(),
    releases: [],
  });
  const candidates = [
    { ...goodRow, upstream_observation: observation("owner/good") },
    { ...badRow, upstream_observation: observation(42) },
  ];
  // Stands in for Core validation: a non-string repository is invalid.
  const valid = (bytes: Buffer) =>
    read(bytes).directory.listings.every(
      (row) =>
        !isRecord(row.upstream_observation) ||
        typeof row.upstream_observation.repository === "string",
    );
  const accepts = (subset: readonly Record<string, unknown>[]) =>
    valid(project(canonical, activated.bytes, 0, [], subset).bytes);
  const withoutFallback = valid(project(canonical, activated.bytes, 0, [], candidates).bytes);
  const isolated = isolateValidEnrichment(candidates, accepts);
  const published = project(canonical, activated.bytes, 0, [], isolated.admitted);
  if (
    withoutFallback ||
    !valid(published.bytes) ||
    isolated.excluded.map((row) => row.id).join() !== badRow.id ||
    isolated.admitted.map((row) => row.id).join() !== goodRow.id
  )
    throw new Error("Invalid optional enrichment was not isolated");
  const enrichment = {
    without_fallback: "the complete candidate set fails validation; the prepare step would stop",
    excluded: isolated.excluded.map((row) => row.id),
    admitted: isolated.admitted.map((row) => row.id),
    validations: isolated.validations,
    published_revision: published.revision,
  };

  // (5) Return to legacy-only delivery without losing reader freshness.
  const withdrawn = [...compact.withdrawn_ids];
  const returned = publishedAbove(
    projectListingDelivery(
      canonical,
      [],
      priorLegacy,
      compact.revision,
      listingDeliveryMaximum,
      legacyProjection,
      operationalIds,
      now,
      withdrawn,
    ),
    compact.revision,
  );
  const naive = publishedAbove(
    projectListingDelivery(
      canonical,
      [],
      priorLegacy,
      legacy.revision,
      listingDeliveryMaximum,
      legacyProjection,
      operationalIds,
      now,
      withdrawn,
    ),
    legacy.revision,
  );
  const returnedDocument = read(returned.bytes);
  const rollback = {
    compact_revision: compact.revision,
    legacy_revision: legacy.revision,
    return_revision: returnedDocument.revision,
    return_format: returnedDocument.directory.format_version,
    compact_reader_admits: readerAdmits(activated.bytes, returned.bytes),
    legacy_reader_admits: readerAdmits(priorLegacy, returned.bytes),
    withdrawals_kept: withdrawn.every((id) => returnedDocument.withdrawn_ids.includes(id)),
    return_at_legacy_revision_refused_by_compact_readers:
      naive.revision <= compact.revision && !readerAdmits(activated.bytes, naive.bytes),
    holds_after_return: legacyHoldCoverage(legacyProjection, returned.bytes),
  };
  if (
    !rollback.compact_reader_admits ||
    !rollback.legacy_reader_admits ||
    !rollback.withdrawals_kept ||
    !rollback.return_at_legacy_revision_refused_by_compact_readers ||
    rollback.return_format !== legacyFormat
  )
    throw new Error("Legacy-only return would lose reader freshness");
  blocking.push(
    "After history bootstrap the checkpoint still refuses a legacy-only return; recovery then needs a defined compact retirement",
  );

  return {
    scope: "rehearsal only; nothing is signed, published or activated",
    activation_format: compactActivationFormat,
    reader_gate: gate,
    revision,
    legacy_target: {
      byte_identical_across_activation: legacyAfterActivation.equals(priorLegacy),
      sha256: hash(priorLegacy),
      revision: legacy.revision,
      rows: legacy.directory.listings.length,
    },
    legacy_holds_at_activation: {
      held_in_legacy_target: coverage.held_in_legacy_target.length,
      bundled_fallback: coverage.bundled_fallback.length,
      withdrawn: coverage.withdrawn.length,
      missing_from_legacy_row: coverage.missing_from_legacy_row,
    },
    not_expressible_to_format_11: notExpressible,
    new_hold_after_activation: newHold,
    new_hold_on_absent_row: absentHold,
    enrichment,
    rollback: {
      ...rollback,
      holds_after_return: {
        held_in_legacy_target: rollback.holds_after_return.held_in_legacy_target.length,
        bundled_fallback: rollback.holds_after_return.bundled_fallback.length,
        missing_from_legacy_row: rollback.holds_after_return.missing_from_legacy_row,
      },
    },
    blocking,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      catalog: { type: "string", default: "crates/portcove-core/catalog" },
      "released-reader": { type: "string" },
    },
  });
  if (!values.cli) throw new Error("--cli PATH (a locally built portcove CLI) is required");
  const directory = path.resolve(values.catalog);
  const listings = path.join(directory, "listings.json");
  const run = (cli: string, args: string[]) =>
    JSON.parse(execFileSync(cli, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as {
      ok: boolean;
      data: unknown;
    };
  const exported = run(path.resolve(values.cli), [
    "--json",
    "catalog",
    "inspect-listings",
    "--path",
    listings,
    "--format-version",
    String(legacyFormat),
  ]);
  if (!exported.ok) throw new Error("Core could not export the format-11 projection");
  const catalog = JSON.parse(readFileSync(path.join(directory, "catalog.json"), "utf8")) as {
    ports: { id: string }[];
  };
  const report = rehearseCompactActivation({
    canonical: JSON.parse(readFileSync(listings, "utf8")) as Directory,
    legacyProjection: exported.data as Directory,
    operationalIds: new Set(catalog.ports.map((port) => port.id)),
    ...(values["released-reader"]
      ? {
          releasedReader: run(path.resolve(values["released-reader"]), ["--json", "capabilities"]),
        }
      : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}
