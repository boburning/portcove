import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compactListingCarrier } from "./listing-directory-carrier.mts";
import {
  compactActivationFormat,
  listingCarrierPairAdmissible,
  readerAdmits,
  rehearseCompactActivation,
  requireCompactActivationReader,
  restrictionsNotExpressibleToLegacy,
} from "./listing-compact-activation-rehearsal.mts";
import {
  isolateValidEnrichment,
  legacyHoldSuccessor,
  publishedAbove,
  reviewedLegacySuccessor,
} from "./listing-observation-delivery.mts";

const reason = "Fresh acquisition remains held for the documented permissions.";
const restriction = {
  id: "download",
  effect: "hold",
  operations: ["download"],
  reason: "bundled-game-data",
  explanation: reason,
  tracking_issue: 1,
};
const row = (
  id: string,
  extra: Record<string, unknown> = {},
): { id: string } & Record<string, unknown> => ({
  id,
  name: id,
  summary: "Fixture listing.",
  project_url: `https://github.com/owner/${id}`,
  availability: "unknown",
  platforms: ["windows-x86-64"],
  ...extra,
});
// Core exports the legacy string before its typed source; format 11 keeps only the string.
const canonical = {
  format_version: 15,
  listings: [
    row("held-operational", { download_block_reason: reason, restrictions: [restriction] }),
    row("open-operational"),
    row("held-discovery", { download_block_reason: reason, restrictions: [restriction] }),
  ],
};
const legacyProjection = {
  format_version: 11,
  listings: canonical.listings.map((listing) => {
    const legacy = { ...listing };
    delete legacy.restrictions;
    return legacy;
  }),
};
const operationalIds = new Set(["held-operational", "open-operational"]);
const wire = (value: unknown) => Buffer.from(JSON.stringify(value));
const document = (bytes: Buffer) =>
  JSON.parse(bytes.toString()) as {
    revision: number;
    withdrawn_ids: string[];
    directory: { format_version: number; listings: Record<string, unknown>[] };
  };

void test("compact activation rehearsal proves each activation property on fixtures", () => {
  const report = rehearseCompactActivation({
    canonical,
    legacyProjection,
    operationalIds,
    now: Date.parse("2026-11-22T00:00:00Z"),
  });
  assert.equal(report.activation_format, 15);
  assert.match(report.reader_gate.refused.format_14_reader, /listing format 15/u);
  assert.match(report.reader_gate.refused.without_compact_carrier, /gzip-base64-json-v1/u);
  assert.match(report.reader_gate.refused.format_16_candidate, /candidate is format 16/u);
  assert.deepEqual(report.revision, {
    legacy: 1,
    compact: 2,
    same_revision_refused: true,
    format_15_legacy_reader_admits: true,
  });
  assert.equal(report.legacy_target.byte_identical_across_activation, true);
  assert.deepEqual(report.legacy_holds_at_activation, {
    held_in_legacy_target: 1,
    bundled_fallback: 1,
    withdrawn: 0,
    missing_from_legacy_row: [],
  });
  assert.deepEqual(report.not_expressible_to_format_11.summary, { reason: 2, tracking_issue: 2 });
  assert.deepEqual(report.not_expressible_to_format_11.hold_semantics_lost, []);
  assert.equal(report.new_hold_after_activation.listing, "open-operational");
  assert.match(
    String(report.new_hold_after_activation.loosening_refused),
    /may not clear a download hold/u,
  );
  assert.equal(report.new_hold_after_activation.canonical_drop_keeps_legacy_hold, true);
  assert.ok("listing" in report.new_hold_on_absent_row);
  assert.equal(report.new_hold_on_absent_row.listing, "held-discovery");
  assert.deepEqual(report.enrichment.excluded, ["open-operational"]);
  assert.deepEqual(report.enrichment.admitted, ["held-operational"]);
  assert.equal(report.rollback.return_revision, 3);
  assert.equal(report.rollback.return_format, 11);
  assert.equal(report.rollback.compact_reader_admits, true);
  assert.equal(report.rollback.legacy_reader_admits, true);
  assert.equal(report.rollback.return_at_legacy_revision_refused_by_compact_readers, true);
  assert.match(report.blocking.join("\n"), /history bootstrap/u);
});

void test("the activation gate requires the compact carrier and exactly format 15", () => {
  const report = (formats: number[], carriers: string[]) => ({
    ok: true,
    command: "capabilities",
    data: {
      product: "Portcove",
      product_version: "fixture",
      listing_formats: formats,
      listing_delivery_carriers: carriers,
    },
  });
  assert.equal(compactActivationFormat, 15);
  assert.equal(
    requireCompactActivationReader(report([14, 15], [compactListingCarrier]), 15),
    "fixture",
  );
  for (const [reader, format] of [
    [report([13, 14], [compactListingCarrier]), 15],
    [report([15], ["json-v1"]), 15],
    [report([14, 15], [compactListingCarrier]), 14],
  ] as const)
    assert.throws(() => requireCompactActivationReader(reader, format));
});

void test("committed catalog holds all reach format-11 readers as their legacy string", () => {
  const listings = JSON.parse(
    readFileSync(new URL("../crates/portcove-core/catalog/listings.json", import.meta.url), "utf8"),
  ) as { format_version: number; listings: ({ id: string } & Record<string, unknown>)[] };
  assert.equal(listings.format_version, compactActivationFormat);
  const result = restrictionsNotExpressibleToLegacy(listings);
  // Only descriptive typed detail is lost; no hold semantics.
  assert.deepEqual(result.hold_semantics_lost, []);
  for (const listing of listings.listings) {
    if (!Array.isArray(listing.restrictions)) continue;
    const first = (listing.restrictions as { effect: string; operations: string[] }[]).find(
      (entry) => entry.effect === "hold" && entry.operations.includes("download"),
    ) as { explanation?: string } | undefined;
    assert.equal(listing.download_block_reason, first?.explanation, listing.id);
  }
  const permit = restrictionsNotExpressibleToLegacy({
    format_version: 15,
    listings: [
      {
        id: "scoped",
        restrictions: [
          { ...restriction, scope: { platforms: ["linux-x86-64"] } },
          { ...restriction, id: "second", explanation: "Second" },
          { id: "permit", effect: "permit", operations: ["download"] },
        ],
      },
    ],
  });
  assert.deepEqual(permit.hold_semantics_lost, ["scoped"]);
  assert.deepEqual(
    permit.entries.map((entry) => entry.lost),
    [
      ["scope (format 11 holds the whole listing)", "reason", "tracking_issue"],
      ["explanation (only the first download hold's text is carried)", "reason", "tracking_issue"],
      ["effect:permit"],
    ],
  );
});

void test("a reviewed legacy successor adds or keeps holds and never loosens one", () => {
  const prior = wire({
    listing_delivery_schema: 1,
    revision: 3,
    withdrawn_ids: [],
    directory: {
      format_version: 11,
      listings: [
        { id: "held", download_block_reason: "Held", a: 1 },
        { id: "open", a: 2 },
      ],
    },
  });
  const base = document(prior);
  const next = (listings: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    wire({ ...base, revision: 9, ...extra, directory: { ...base.directory, listings } });
  const [heldRow, openRow] = base.directory.listings as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  reviewedLegacySuccessor(prior, next([heldRow, { ...openRow, download_block_reason: "New" }]), 7);
  reviewedLegacySuccessor(
    prior,
    next([{ ...heldRow, download_block_reason: "Revised" }, openRow]),
    7,
  );
  reviewedLegacySuccessor(
    prior,
    next([heldRow, openRow, { id: "absent", download_block_reason: "Held" }]),
    7,
  );
  reviewedLegacySuccessor(prior, next([heldRow], { withdrawn_ids: ["open"] }), 7);
  const refusals: [Buffer, RegExp][] = [
    [next([{ ...heldRow, download_block_reason: undefined }, openRow]), /clear a download hold/u],
    [next([{ ...heldRow, download_block_reason: "" }, openRow]), /clear a download hold/u],
    [next([openRow]), /clear a download hold/u],
    [next([heldRow]), /without a safety withdrawal/u],
    [next([heldRow, { ...openRow, a: 3, download_block_reason: "New" }]), /other facts/u],
    [next([heldRow, openRow, { id: "absent" }]), /add only a held row/u],
    [next([heldRow, openRow]), /safety withdrawal or download hold/u],
    [
      next([heldRow, { ...openRow, download_block_reason: "New" }], { revision: 7 }),
      /advance the listing revision/u,
    ],
  ];
  for (const [proposal, expected] of refusals)
    assert.throws(() => reviewedLegacySuccessor(prior, proposal, 7), expected);
  const withdrawn = wire({ ...base, withdrawn_ids: ["gone"] });
  assert.throws(
    () => reviewedLegacySuccessor(withdrawn, next([heldRow, openRow]), 7),
    /removed a safety withdrawal/u,
  );

  // The automatic successor carries Core's current hold and keeps a dropped one.
  const held = legacyHoldSuccessor(
    prior,
    {
      format_version: 11,
      listings: [
        { id: "held", a: 1 },
        { id: "open", a: 2, download_block_reason: "New" },
      ],
    },
    8,
  );
  assert.ok(held);
  assert.deepEqual(held.held, ["open"]);
  assert.deepEqual(document(held.bytes).directory.listings, [
    heldRow,
    { ...openRow, download_block_reason: "New" },
  ]);
  reviewedLegacySuccessor(prior, held.bytes, 7);
  assert.equal(legacyHoldSuccessor(prior, { format_version: 11, listings: [heldRow] }, 8), null);
});

void test("optional enrichment isolation excludes only failing candidates within its budget", () => {
  const accepts = (bad: Set<number>) => (subset: readonly number[]) =>
    subset.every((value) => !bad.has(value));
  const values = Array.from({ length: 16 }, (_, index) => index);
  assert.deepEqual(isolateValidEnrichment(values, accepts(new Set())), {
    admitted: values,
    excluded: [],
    validations: 1,
  });
  const isolated = isolateValidEnrichment(values, accepts(new Set([3, 11])));
  assert.deepEqual(
    isolated.excluded.sort((a, b) => a - b),
    [3, 11],
  );
  assert.equal(isolated.admitted.length, 14);
  assert.ok(isolated.validations <= 24);
  const exhausted = isolateValidEnrichment(values, accepts(new Set([3, 11])), 2);
  assert.ok(exhausted.validations <= 3);
  assert.ok(exhausted.excluded.includes(3) && exhausted.excluded.includes(11));
  // An interaction failure is never published: the admitted set is revalidated.
  const pairwise = isolateValidEnrichment([1, 2], (subset) => subset.length < 2);
  assert.deepEqual(pairwise, { admitted: [1], excluded: [2], validations: 4 });
  assert.deepEqual(
    isolateValidEnrichment([1], () => false),
    { admitted: [], excluded: [1], validations: 1 },
  );
});

void test("carrier and reader admission mirror the shared revision floor", () => {
  const envelope = (revision: number, withdrawn: string[] = []) =>
    wire({
      listing_delivery_schema: 1,
      revision,
      withdrawn_ids: withdrawn,
      directory: { format_version: 11, listings: [] },
    });
  assert.equal(listingCarrierPairAdmissible(envelope(3), envelope(4)), true);
  assert.equal(listingCarrierPairAdmissible(envelope(3), envelope(3)), true);
  assert.equal(listingCarrierPairAdmissible(envelope(3, ["a"]), envelope(4)), false);
  assert.equal(listingCarrierPairAdmissible(envelope(4), envelope(3)), false);
  assert.equal(readerAdmits(envelope(4), envelope(4)), true);
  assert.equal(readerAdmits(envelope(4), envelope(3)), false);
  const result = { bytes: envelope(3), revision: 3, changed: false };
  assert.equal(publishedAbove(result, 2), result);
  const raised = publishedAbove(result, 5);
  assert.equal(raised.revision, 6);
  assert.equal(raised.changed, true);
  assert.equal(document(raised.bytes).revision, 6);
});
