import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compactListingCarrier,
  compactListingDecodedMaximum,
  compactListingDeliveryTarget,
  encodeCompactListing,
  listingDeliveryMaximum,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import {
  compactActivationFormat,
  enrichmentFixture,
  fixtureVerifier,
  rehearseCompactActivation,
  restrictionsNotExpressibleToLegacy,
  writePriorRepository,
} from "./listing-compact-activation-rehearsal.mts";
import {
  classifyCoreInspectionFailure,
  CoreInspectionRefusal,
  isolateValidEnrichment,
  legacyHoldSuccessor,
  prepareObservationBundle,
  projectListingDelivery,
  publishedAbove,
  reviewedLegacySuccessor,
} from "./listing-observation-delivery.mts";
import { writeStubCli } from "./fixtures/listing-prepare-fixture.mts";
import { acquireCatalogReleasedReader } from "./catalog-released-reader.mts";
import { fixtureReleasedReaderSources } from "./fixtures/released-reader-fixture.mts";

const reason = "Fresh acquisition remains held for the documented permissions.";
const restriction = {
  id: "download",
  effect: "hold",
  operations: ["download"],
  reason: "bundled-game-data",
  explanation: reason,
  tracking_issue: 1,
};
type Row = { id: string } & Record<string, unknown>;
const row = (id: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  name: id,
  summary: "Fixture listing.",
  project_url: `https://github.com/owner/${id}`,
  availability: "unknown",
  platforms: ["windows-x86-64"],
  ...extra,
});
const canonical = {
  format_version: 15,
  listings: [
    row("held-operational", { download_block_reason: reason, restrictions: [restriction] }),
    row("open-operational"),
    row("held-discovery", { download_block_reason: reason, restrictions: [restriction] }),
    row("open-discovery"),
  ],
};
/** The stub CLI's format-11 export, matching Core for these fixture rows. */
const legacyExport = (directory: { listings: Row[] }) => ({
  format_version: 11,
  listings: directory.listings.map((listing) => {
    const legacy = { ...listing };
    delete legacy.restrictions;
    return legacy;
  }),
});
const operationalIds = new Set(["held-operational", "open-operational"]);
const wire = (value: unknown) => Buffer.from(JSON.stringify(value));
const document = (bytes: Buffer) =>
  JSON.parse(bytes.toString()) as {
    revision: number;
    withdrawn_ids: string[];
    directory: { format_version: number; listings: Row[] };
  };

function fixtureWorkspace(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "portcove-compact-rehearsal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle");
  mkdirSync(path.join(bundle, "definitions"), { recursive: true });
  writeFileSync(path.join(bundle, "definitions/index.json"), "{}");
  const write = (name: string, value: unknown) => {
    const file = path.join(root, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const tools = path.join(root, "tools");
  mkdirSync(tools);
  return {
    root,
    bundle,
    canonical: write("listings.json", canonical),
    catalog: write("catalog.json", {
      ports: [...operationalIds].map((id) => ({ id })),
    }),
    cli: writeStubCli(path.join(tools, "portcove")),
    tools: fixtureVerifier(path.join(tools, "verify-definition-repository")),
    rootFile: write("root.json", {}),
    offlineTargets: write("offline-targets.json", {}),
    write,
  };
}

void test("the rehearsal drives every activation step through preparation", async (t) => {
  const fixture = fixtureWorkspace(t);
  const report = await rehearseCompactActivation({
    cli: fixture.cli,
    bundle: fixture.bundle,
    canonical: fixture.canonical,
    catalog: fixture.catalog,
    workspace: path.join(fixture.root, "rehearsal"),
  });
  assert.equal(report.activation_format, 15);
  assert.match(report.reader_gate.refused.without_compact_carrier, /listing format 15/u);
  assert.match(report.reader_gate.refused.without_candidate_format, /listing format 15/u);
  assert.match(report.reader_gate.refused.wrong_reader_digest, /SHA-256 differs/u);
  const automatic = report.reader_gate.automatic_unverified ?? {};
  assert.deepEqual(Object.keys(automatic), [
    "withdrawn",
    "lacks_candidate_format",
    "substituted_archive",
    "unattested_tag",
    "off_protected_main",
  ]);
  for (const entry of Object.values(automatic)) assert.equal(entry.legacy_only_unchanged, true);
  assert.match(automatic.withdrawn!.reason, /withdrawn/u);
  assert.match(automatic.lacks_candidate_format!.reason, /listing format 15/u);
  assert.match(automatic.substituted_archive!.reason, /attested identity/u);
  assert.match(automatic.unattested_tag!.reason, /attestation subject differs/u);
  assert.match(automatic.off_protected_main!.reason, /protected main/u);
  assert.equal((report.activation.released_reader_source as { tag: string }).tag, "v0.1.0");
  assert.equal(report.activation.legacy_revision, 1);
  assert.equal(report.activation.compact_revision, 2);
  assert.equal(report.activation.compact_rows, 4);
  assert.equal(report.activation.legacy_rows, 2);
  assert.equal(report.activation.legacy_target_retained, true);
  assert.deepEqual(report.not_expressible_to_format_11.summary, { reason: 2, tracking_issue: 2 });
  assert.deepEqual(report.new_hold_after_activation, {
    delivered_row: "open-operational",
    bundled_row: "open-discovery",
    automatic_legacy_holds: ["open-operational"],
    automatic_legacy_rows: ["open-discovery"],
    legacy_revision: 3,
    compact_revision: 4,
    legacy_holds_match_compact: true,
    added_rows_equal_core_export: true,
    other_legacy_rows_unchanged: true,
    released_catalog_hold_kept: true,
  });
  assert.deepEqual(report.enrichment, {
    compact_excluded: ["rehearsal-invalid-observation"],
    compact_valid_observed: true,
    compact_invalid_keeps_prior_observation: true,
    legacy_fallback_diagnostic:
      "observer candidates failed Core validation; retaining prior applicable observations",
    legacy_publishes_neither_candidate: true,
  });
  assert.equal(report.rollback.return_revision, 3);
  assert.equal(report.rollback.return_format, 11);
  assert.equal(report.rollback.compact_target_removed, true);
  assert.equal(report.rollback.withdrawals_kept, true);
  assert.match(report.rollback.legacy_only_prior_refused, /current authenticated compact/u);
});

void test("legacy preparation keeps main's all-or-nothing enrichment fallback byte for byte", async (t) => {
  const fixture = fixtureWorkspace(t);
  const enrichment = enrichmentFixture();
  const enriched = { ...canonical, listings: [...canonical.listings, ...enrichment.rows] };
  const canonicalFile = fixture.write("enriched.json", enriched);
  const prepare = async (
    name: string,
    prior: string | null,
    input: typeof enrichment.validInput,
  ) => {
    const output = path.join(fixture.root, name);
    await prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: canonicalFile,
      catalog: fixture.catalog,
      prior,
      output,
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      readObservation: () => Promise.resolve(input),
    });
    return {
      legacy: readFileSync(path.join(output, "bundle", listingDeliveryTarget)),
      report: JSON.parse(readFileSync(path.join(output, "report.json"), "utf8")) as Record<
        string,
        unknown
      >,
    };
  };
  // Main's legacy algorithm on the same inputs: project the candidates; when
  // Core refuses them, publish the projection without any candidate.
  const expected = (candidates: Record<string, unknown>[], previous: Buffer | null) =>
    projectListingDelivery(
      enriched,
      candidates,
      previous,
      0,
      listingDeliveryMaximum,
      legacyExport(enriched),
      operationalIds,
    ).bytes;
  const mixed = await prepare("mixed", null, enrichment.mixedInput);
  assert.deepEqual(mixed.legacy, expected([], null));
  assert.ok(
    (mixed.report.diagnostics as string[]).includes(
      "observer candidates failed Core validation; retaining prior applicable observations",
    ),
  );
  assert.equal("excluded_candidates" in mixed.report, false);
  const ids = (bytes: Buffer) => document(bytes).directory.listings.map((listing) => listing.id);
  assert.deepEqual(ids(mixed.legacy), ["held-operational", "open-operational"]);

  // With valid candidates both observations publish.
  const valid = await prepare("valid", null, enrichment.validInput);
  const updates = enrichment.policies.map((policy) => policy.listing_update);
  assert.deepEqual(valid.legacy, expected(updates, null));
  assert.deepEqual(
    ids(valid.legacy).filter((id) => id.startsWith("rehearsal")),
    [enrichment.invalid, enrichment.valid],
  );

  // An invalid later candidate keeps every prior observation: the prior signed
  // target is republished unchanged, as on main.
  const prior = writePriorRepository(path.join(fixture.root, "prior"), {
    [listingDeliveryTarget]: valid.legacy,
  });
  const retained = await prepare("retained", prior, enrichment.mixedInput);
  assert.deepEqual(retained.legacy, valid.legacy);
  assert.equal(retained.report.changed, false);
});

void test("compact preparation fails on a projection error instead of excluding candidates", async (t) => {
  const fixture = fixtureWorkspace(t);
  const enrichment = enrichmentFixture();
  const legacy = projectListingDelivery(
    canonical,
    [],
    null,
    0,
    listingDeliveryMaximum,
    legacyExport(canonical),
    operationalIds,
  ).bytes;
  // The prior compact target delivers a row the canonical directory lost
  // without a withdrawal; projection refuses it whatever the candidates are.
  const compactDecoded = wire({
    ...document(legacy),
    revision: 2,
    directory: { format_version: 15, listings: [...canonical.listings, row("vanished")] },
  });
  const { encodeCompactListing } = await import("./listing-directory-carrier.mts");
  const prior = writePriorRepository(path.join(fixture.root, "prior"), {
    [listingDeliveryTarget]: legacy,
    [compactListingDeliveryTarget]: encodeCompactListing(compactDecoded),
  });
  await assert.rejects(
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: fixture.write("enriched.json", {
        ...canonical,
        listings: [...canonical.listings, ...enrichment.rows],
      }),
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, "out"),
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      readObservation: () => Promise.resolve(enrichment.mixedInput),
    }),
    /missing from the canonical directory without an explicit withdrawal/u,
  );
});

void test("a reviewed legacy input with an arbitrary hold fails preparation", async (t) => {
  const fixture = fixtureWorkspace(t);
  const legacy = projectListingDelivery(
    canonical,
    [],
    null,
    0,
    listingDeliveryMaximum,
    legacyExport(canonical),
    operationalIds,
  ).bytes;
  const { encodeCompactListing } = await import("./listing-directory-carrier.mts");
  const compact = wire({
    ...document(legacy),
    revision: 2,
    directory: { format_version: 15, listings: canonical.listings },
  });
  const prior = writePriorRepository(path.join(fixture.root, "prior"), {
    [listingDeliveryTarget]: legacy,
    [compactListingDeliveryTarget]: encodeCompactListing(compact),
  });
  const authored = (listings: Row[]) => {
    const file = path.join(fixture.bundle, listingDeliveryTarget);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      wire({ ...document(legacy), revision: 3, directory: { format_version: 11, listings } }),
    );
  };
  const base = document(legacy).directory.listings;
  const run = (name: string) =>
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: fixture.canonical,
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, name),
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      observe: false,
    });
  authored(
    base.map((listing) =>
      listing.id === "open-operational"
        ? { ...listing, download_block_reason: "Arbitrary" }
        : listing,
    ),
  );
  await assert.rejects(run("arbitrary"), /hold differs from Core's format-11 listing/u);
  authored([...base, { ...row("invented"), download_block_reason: reason }]);
  await assert.rejects(run("invented"), /no unwithdrawn compact row/u);
  // The exact Core row of the held discovery listing is admitted.
  authored(
    [...base, legacyExport(canonical).listings[2]!].sort((a, b) => a.id.localeCompare(b.id, "en")),
  );
  await run("exact");
  const output = document(
    readFileSync(path.join(fixture.root, "exact", "bundle", listingDeliveryTarget)),
  );
  assert.equal(output.revision, 3);
  assert.deepEqual(
    output.directory.listings.map((listing) => listing.id),
    ["held-discovery", "held-operational", "open-operational"],
  );
});

void test("committed catalog holds all reach format-11 readers as their legacy string", () => {
  const listings = JSON.parse(
    readFileSync(new URL("../crates/portcove-core/catalog/listings.json", import.meta.url), "utf8"),
  ) as { format_version: number; listings: Row[] };
  assert.equal(listings.format_version, compactActivationFormat);
  const result = restrictionsNotExpressibleToLegacy(listings);
  // Only descriptive typed detail is lost, except the reviewed exact-file
  // permits (#8538). A format-11 reader drops each permit and keeps the whole
  // first hold, so it stays held on every download: stricter, never looser.
  const permitted = [
    "chameleon-twist-recompiled",
    "grand-theft-auto-san-andreas-unity",
    "linewars-ii-sdl3",
  ];
  assert.deepEqual(result.hold_semantics_lost, permitted);
  for (const entry of result.entries.filter((entry) => permitted.includes(entry.listing))) {
    const semantic = entry.lost.filter(
      (field) => field.startsWith("effect:") || field.startsWith("operation:"),
    );
    assert.deepEqual(semantic, semantic.length ? ["effect:permit"] : [], entry.listing);
  }
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

void test("a reviewed legacy successor binds every hold to Core's format-11 listing", () => {
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
  const absent = {
    id: "absent",
    name: "Absent",
    summary: "S",
    project_url: "https://example.invalid/absent",
    download_block_reason: "Absent hold",
    download_asset_hints: { "windows-x86-64": ["win"] },
    original_game: { id: "g", source_editions: [{ id: "e" }] },
    media: [{ id: "logo", role: "logo", sha256: "0" }],
  };
  const binding = {
    legacy: {
      format_version: 11,
      listings: [
        { id: "held", download_block_reason: "Revised", a: 1 },
        { id: "open", a: 2, download_block_reason: "New" },
        absent,
      ],
    },
    compactWithdrawn: [] as string[],
  };
  const base = document(prior);
  const next = (listings: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    wire({ ...base, revision: 9, ...extra, directory: { ...base.directory, listings } });
  const [heldRow, openRow] = base.directory.listings as [Row, Row];
  const accept = (proposal: Buffer, bound = binding) =>
    reviewedLegacySuccessor(prior, proposal, 7, bound);
  accept(next([heldRow, { ...openRow, download_block_reason: "New" }]));
  accept(next([{ ...heldRow, download_block_reason: "Revised" }, openRow]));
  accept(next([absent, heldRow, openRow]));
  accept(next([heldRow], { withdrawn_ids: ["open"] }));
  const changed = (field: string, value: unknown) =>
    next([{ ...absent, [field]: value }, heldRow, openRow]);
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
    // Arbitrary hold text, on a delivered row or as a retold hold.
    [next([heldRow, { ...openRow, download_block_reason: "Arbitrary" }]), /hold differs/u],
    [next([{ ...heldRow, download_block_reason: "Arbitrary" }, openRow]), /hold differs/u],
    // A new id, and every changed fact on an added row.
    [
      next([heldRow, openRow, { id: "invented", name: "x", download_block_reason: "Held" }]),
      /no unwithdrawn compact row/u,
    ],
    [changed("project_url", "https://attacker.invalid/"), /added row differs/u],
    [changed("name", "Renamed"), /added row differs/u],
    [changed("summary", "Replaced"), /added row differs/u],
    [changed("media", []), /added row differs/u],
    [changed("original_game", { id: "g", source_editions: [{ id: "x" }] }), /added row differs/u],
    [changed("download_asset_hints", { "windows-x86-64": ["evil"] }), /added row differs/u],
    [changed("download_block_reason", "Arbitrary"), /added row differs/u],
    [changed("upstream_observation", { provider: "github" }), /added row differs/u],
  ];
  for (const [proposal, expected] of refusals) assert.throws(() => accept(proposal), expected);
  // Duplicate identities are refused, not collapsed.
  assert.throws(
    () => accept(next([heldRow, openRow, openRow])),
    /unique canonical identities|repeats/u,
  );
  // A compact withdrawal leaves no row to bind a hold or an added row to.
  for (const proposal of [
    next([absent, heldRow, openRow]),
    next([heldRow, { ...openRow, download_block_reason: "New" }]),
  ])
    assert.throws(
      () => accept(proposal, { ...binding, compactWithdrawn: ["absent", "open"] }),
      /no unwithdrawn compact row/u,
    );
  const withdrawn = wire({ ...base, withdrawn_ids: ["gone"] });
  assert.throws(
    () => reviewedLegacySuccessor(withdrawn, next([heldRow, openRow]), 7, binding),
    /removed a safety withdrawal/u,
  );

  // The automatic successor retells delivered holds, adds a row only for a
  // hold that is new since the active compact publication, and never drops one.
  const active = { listings: [{ id: "absent", download_block_reason: "Older hold" }] };
  const automatic = legacyHoldSuccessor(prior, binding, 8, active);
  assert.ok(automatic);
  assert.deepEqual(automatic.held, ["held", "open"]);
  assert.deepEqual(automatic.added, ["absent"]);
  assert.deepEqual(document(automatic.bytes).directory.listings, [
    absent,
    { ...heldRow, download_block_reason: "Revised" },
    { ...openRow, download_block_reason: "New" },
  ]);
  reviewedLegacySuccessor(prior, automatic.bytes, 7, binding);
  // A hold that predates the active compact publication stays bundled.
  const unchanged = legacyHoldSuccessor(prior, binding, 8, { listings: [absent] });
  assert.deepEqual(unchanged?.added, []);
  // Withdrawn identities are left to the withdrawal route.
  assert.deepEqual(
    legacyHoldSuccessor(prior, { ...binding, compactWithdrawn: ["absent", "open"] }, 8, active)
      ?.held,
    ["held"],
  );
  assert.equal(
    legacyHoldSuccessor(
      prior,
      { legacy: { format_version: 11, listings: [heldRow] }, compactWithdrawn: [] },
      8,
      active,
    ),
    null,
  );
});

void test("optional enrichment isolation excludes only failing candidates within its budget", async () => {
  const accepts = (bad: Set<number>) => (subset: readonly number[]) =>
    subset.every((value) => !bad.has(value));
  const values = Array.from({ length: 16 }, (_, index) => index);
  assert.deepEqual(await isolateValidEnrichment(values, accepts(new Set())), {
    admitted: values,
    excluded: [],
    validations: 1,
  });
  const isolated = await isolateValidEnrichment(values, accepts(new Set([3, 11])));
  assert.deepEqual(
    isolated.excluded.sort((a, b) => a - b),
    [3, 11],
  );
  assert.equal(isolated.admitted.length, 14);
  assert.ok(isolated.validations <= 24);
  const exhausted = await isolateValidEnrichment(values, accepts(new Set([3, 11])), 2);
  assert.ok(exhausted.validations <= 3);
  assert.ok(exhausted.excluded.includes(3) && exhausted.excluded.includes(11));
  // An interaction failure is never published: the admitted set is revalidated.
  const pairwise = await isolateValidEnrichment([1, 2], (subset) => subset.length < 2);
  assert.deepEqual(pairwise, { admitted: [1], excluded: [2], validations: 4 });
  assert.deepEqual(await isolateValidEnrichment([1], () => false), {
    admitted: [],
    excluded: [1],
    validations: 1,
  });
});

void test("a carrier that must follow a signed revision is republished above it", () => {
  const envelope = (revision: number) =>
    wire({
      listing_delivery_schema: 1,
      revision,
      withdrawn_ids: [],
      directory: { format_version: 11, listings: [] },
    });
  const result = { bytes: envelope(3), revision: 3, changed: false };
  assert.equal(publishedAbove(result, 2), result);
  const raised = publishedAbove(result, 5);
  assert.equal(raised.revision, 6);
  assert.equal(raised.changed, true);
  assert.equal(document(raised.bytes).revision, 6);
});

/** An active compact prior over `listings`, as the signer would have accepted it. */
function compactPrior(root: string, listings: Row[]) {
  const legacy = projectListingDelivery(
    canonical,
    [],
    null,
    0,
    listingDeliveryMaximum,
    legacyExport(canonical),
    operationalIds,
  ).bytes;
  const decoded = wire({
    ...document(legacy),
    revision: 2,
    directory: { format_version: 15, listings },
  });
  return {
    decoded,
    prior: writePriorRepository(path.join(root, "prior"), {
      [listingDeliveryTarget]: legacy,
      [compactListingDeliveryTarget]: encodeCompactListing(decoded),
    }),
  };
}

/** Delegates to the stub CLI, except that publication inspection of a
 * candidate carrying the refused observation field behaves as `behavior`. */
function misbehavingCli(file: string, stub: string, behavior: string) {
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[2] === "inspect-definition-publication") {
  const compact = path.join(args[3], ${JSON.stringify(compactListingDeliveryTarget)});
  if (fs.existsSync(compact)) {
    const wire = JSON.parse(fs.readFileSync(compact, "utf8"));
    const text = zlib.gunzipSync(Buffer.from(wire.gzip_base64, "base64")).toString("utf8");
    if (text.includes("unexpected_field")) { ${behavior} }
  }
}
try { process.stdout.write(execFileSync(${JSON.stringify(stub)}, args)); }
catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }
`,
  );
  chmodSync(file, 0o755);
  return file;
}

void test("only Core's refusal of a staged candidate excludes compact enrichment", async (t) => {
  const fixture = fixtureWorkspace(t);
  const enrichment = enrichmentFixture();
  const listings = [...canonical.listings, ...enrichment.rows];
  const canonicalFile = fixture.write("enriched.json", { ...canonical, listings });
  const { prior } = compactPrior(fixture.root, listings);
  const prepare = (name: string, cli: string, cliTimeoutMs?: number) =>
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: canonicalFile,
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, name),
      cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      readObservation: () => Promise.resolve(enrichment.mixedInput),
      ...(cliTimeoutMs ? { cliTimeoutMs } : {}),
    });
  // Core's refusal envelope: the refused candidate alone is excluded.
  const refused = await prepare("refused", fixture.cli);
  assert.deepEqual(refused.excluded_candidates, [enrichment.invalid]);
  const cli = (name: string, behavior: string) =>
    misbehavingCli(path.join(fixture.root, `${name}-cli`), fixture.cli, behavior);
  // A crash without Core's envelope fails preparation.
  await assert.rejects(
    prepare("crash", cli("crash", "process.exit(101);")),
    /inspection failed without a candidate refusal \(exit 101\)/u,
  );
  // A Core error that is not an input refusal fails preparation.
  await assert.rejects(
    prepare(
      "state",
      cli(
        "state",
        'process.stdout.write(JSON.stringify({ ok: false, command: "catalog.inspect-definition-publication", error: { code: "state", message: "disk" } })); process.exit(13);',
      ),
    ),
    /without a candidate refusal \(exit 13, state\)/u,
  );
  // A refusal envelope whose exit code disagrees is not a refusal.
  await assert.rejects(
    prepare(
      "mismatch",
      cli(
        "mismatch",
        'process.stdout.write(JSON.stringify({ ok: false, error: { code: "verification", message: "x" } })); process.exit(1);',
      ),
    ),
    /without a candidate refusal \(exit 1, verification\)/u,
  );
  // A timeout fails preparation.
  await assert.rejects(
    prepare("timeout", cli("timeout", "setTimeout(() => process.exit(0), 20000); return;"), 1500),
    /did not complete \(ETIMEDOUT\)/u,
  );
});

void test("compact capacity overflow fails preparation instead of trimming candidates", async (t) => {
  const fixture = fixtureWorkspace(t);
  const enrichment = enrichmentFixture();
  const candidates = enrichment.policies.map((policy) => policy.listing_update);
  // Incompressible filler: base64 of a hash stream.
  const stream: Buffer[] = [];
  for (let index = 0; stream.length * 32 < 6_400_000; index++)
    stream.push(createHash("sha256").update(String(index)).digest());
  const entropy = Buffer.concat(stream).toString("base64");
  const listingsWith = (length: number) => [
    ...canonical.listings,
    ...enrichment.rows,
    row("capacity-filler", { summary: entropy.slice(0, length) }),
  ];
  const wireBytes = (decoded: Buffer) =>
    Buffer.byteLength(
      JSON.stringify({
        carrier: compactListingCarrier,
        decoded_bytes: decoded.length,
        decoded_sha256: "0".repeat(64),
        gzip_base64: gzipSync(decoded).toString("base64"),
      }),
    );
  const projected = (length: number, observations: Record<string, unknown>[]) => {
    const listings = listingsWith(length);
    const previous = wire({
      listing_delivery_schema: 1,
      revision: 2,
      withdrawn_ids: [],
      directory: { format_version: 15, listings },
    });
    return publishedAbove(
      projectListingDelivery(
        { format_version: 15, listings },
        observations,
        previous,
        0,
        compactListingDecodedMaximum,
        { format_version: 15, listings },
        operationalIds,
        Date.now(),
        [],
        true,
      ),
      0,
    ).bytes;
  };
  // The smallest filler whose candidate projection exceeds the wire bound.
  // Each candidate adds hundreds of compressed bytes; 64-byte precision keeps
  // the candidate-free projection inside the bound.
  // The wire grows linearly with incompressible filler: interpolate, then
  // bisect a narrow window.
  const start = 8_100_000;
  const slope =
    (wireBytes(projected(start + 100_000, candidates)) - wireBytes(projected(start, candidates))) /
    100_000;
  const estimate = Math.round(
    start + (listingDeliveryMaximum - wireBytes(projected(start, candidates))) / slope,
  );
  let low = estimate - 4096;
  let high = estimate + 4096;
  assert.ok(wireBytes(projected(low, candidates)) <= listingDeliveryMaximum);
  assert.ok(wireBytes(projected(high, candidates)) > listingDeliveryMaximum);
  while (high - low > 64) {
    const middle = Math.floor((low + high) / 2);
    if (wireBytes(projected(middle, candidates)) > listingDeliveryMaximum) high = middle;
    else low = middle;
  }
  const listings = listingsWith(high);
  const canonicalFile = fixture.write("capacity.json", { ...canonical, listings });
  // The prior compact target without the candidates fits; with them it does not.
  const { prior } = compactPrior(fixture.root, listings);
  await assert.rejects(
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: canonicalFile,
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, "out"),
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      readObservation: () => Promise.resolve(enrichment.validInput),
    }),
    /exceeds its transport byte bound/u,
  );
});

void test("Core inspection failures are classified by process outcome and envelope", () => {
  const envelope = (code: string) =>
    JSON.stringify({
      ok: false,
      command: "catalog.inspect-definition-publication",
      error: { code, message: "m" },
    });
  for (const [code, status] of [
    ["verification", 11],
    ["source_invalid", 5],
    ["unsupported", 3],
  ] as const)
    assert.ok(
      classifyCoreInspectionFailure({ status, stdout: envelope(code) }) instanceof
        CoreInspectionRefusal,
    );
  for (const failure of [
    { status: 13, stdout: envelope("state") },
    { status: 2, stdout: envelope("usage") },
    { status: 11, stdout: "not json" },
    { status: 101, stdout: "" },
    { status: null, signal: "SIGKILL", stdout: envelope("verification") },
    { code: "ETIMEDOUT", status: null, stdout: envelope("verification") },
    { code: "ENOBUFS", status: 11, stdout: envelope("verification") },
    { code: "ENOENT" },
  ])
    assert.equal(
      classifyCoreInspectionFailure(failure) instanceof CoreInspectionRefusal,
      false,
      JSON.stringify(failure),
    );
});

void test("automatic reader selection activates, advances or renews exact carriers", async (t) => {
  const fixture = fixtureWorkspace(t);
  const stub = readFileSync(fixture.cli);
  const legacy = projectListingDelivery(
    canonical,
    [],
    null,
    0,
    listingDeliveryMaximum,
    legacyExport(canonical),
    operationalIds,
  ).bytes;
  const legacyPrior = writePriorRepository(path.join(fixture.root, "legacy-prior"), {
    [listingDeliveryTarget]: legacy,
  });
  // An active compact target one format behind the candidate (format 14).
  const compact14 = encodeCompactListing(
    wire({
      ...document(legacy),
      revision: 2,
      directory: {
        format_version: 14,
        listings: canonical.listings.map((listing) => {
          const older: Row = { ...listing };
          delete older.restrictions;
          return older;
        }),
      },
    }),
  );
  const compactPrior = writePriorRepository(path.join(fixture.root, "compact-prior"), {
    [listingDeliveryTarget]: legacy,
    [compactListingDeliveryTarget]: compact14,
  });
  const current = compactPrior15(fixture.root);
  let acquisitions = 0;
  const prepare = (
    name: string,
    prior: string,
    official: Parameters<typeof fixtureReleasedReaderSources>[0] | null,
    extra: Record<string, unknown> = {},
  ) =>
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: fixture.canonical,
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, name),
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      observe: false,
      officialReleasedReader: true,
      acquireReleasedReader: (root: string) => {
        acquisitions++;
        if (!official) return Promise.reject(new Error("no official release reachable"));
        return acquireCatalogReleasedReader(root, fixtureReleasedReaderSources(official).sources);
      },
      ...extra,
    });
  const read = (name: string, target: string) => {
    const file = path.join(fixture.root, name, "bundle", target);
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  };
  // First activation from a current legacy target.
  const activated = await prepare("activate", legacyPrior, { binary: stub, version: "0.1.0" });
  assert.equal(activated.listing_format, 15);
  assert.deepEqual(read("activate", listingDeliveryTarget), legacy);
  assert.ok(read("activate", compactListingDeliveryTarget));
  assert.deepEqual(activated.released_reader_activation, { version: "0.1.0", tag: "v0.1.0" });
  assert.equal(
    (activated.released_reader as { sha256: string }).sha256,
    createHash("sha256").update(stub).digest("hex"),
  );
  // Without a verified reader, legacy-only publication is byte-identical to
  // preparation without automatic selection.
  const plain = await prepareObservationBundle({
    bundle: fixture.bundle,
    canonical: fixture.canonical,
    catalog: fixture.catalog,
    prior: legacyPrior,
    output: path.join(fixture.root, "plain"),
    cli: fixture.cli,
    tools: fixture.tools,
    root: fixture.rootFile,
    offlineTargets: fixture.offlineTargets,
    observe: false,
  });
  const unverified: [string, Parameters<typeof fixtureReleasedReaderSources>[0] | null][] = [
    ["unreachable", null],
    ["withdrawn", { binary: stub, version: "0.1.0", withdrawn: ["0.1.0"] }],
    ["version", { binary: stub, version: "0.1.1" }],
    ["rate-limited", { binary: stub, version: "0.1.0", rateLimited: true }],
  ];
  for (const [name, official] of unverified) {
    const result = await prepare(`legacy-${name}`, legacyPrior, official);
    assert.equal(result.listing_format, 11, name);
    assert.equal(read(`legacy-${name}`, compactListingDeliveryTarget), null);
    assert.deepEqual(
      read(`legacy-${name}`, listingDeliveryTarget),
      read("plain", listingDeliveryTarget),
    );
    assert.equal(result.revision, plain.revision);
    assert.ok(result.released_reader_unavailable, name);
  }
  // A compact format increase with a verified reader advances the format.
  const advanced = await prepare("advance", compactPrior, { binary: stub, version: "0.1.0" });
  assert.equal(advanced.listing_format, 15);
  assert.deepEqual(read("advance", listingDeliveryTarget), legacy);
  // Without one, both exact authenticated carriers are renewed unchanged.
  const renewed = await prepare("renew", compactPrior, {
    binary: stub,
    version: "0.1.0",
    withdrawn: ["0.1.0"],
  });
  assert.equal(renewed.listing_format, 14);
  assert.equal(renewed.changed, false);
  assert.match(String(renewed.released_reader_unavailable), /withdrawn/u);
  assert.deepEqual(read("renew", listingDeliveryTarget), legacy);
  assert.deepEqual(read("renew", compactListingDeliveryTarget), compact14);
  // An anonymous API refusal (rate limit or outage) renews them the same way.
  const limited = await prepare("renew-rate-limited", compactPrior, {
    binary: stub,
    version: "0.1.0",
    rateLimited: true,
  });
  assert.equal(limited.listing_format, 14);
  assert.equal(limited.changed, false);
  assert.match(String(limited.released_reader_unavailable), /unavailable \(403\)/u);
  assert.deepEqual(read("renew-rate-limited", listingDeliveryTarget), legacy);
  assert.deepEqual(read("renew-rate-limited", compactListingDeliveryTarget), compact14);
  // A current compact target needs no reader: nothing is acquired.
  const before = acquisitions;
  const steady = await prepare("steady", current, null);
  assert.equal(acquisitions, before);
  assert.equal(steady.listing_format, 15);
  assert.equal(steady.released_reader_unavailable, undefined);
  // Automatic selection decides activation itself.
  for (const extra of [
    { compact: true },
    { returnToLegacy: true },
    { releasedReader: { cli: fixture.cli, sha256: "0".repeat(64) } },
  ])
    await assert.rejects(
      prepare(`conflict-${Object.keys(extra)[0]}`, legacyPrior, null, extra),
      /decides activation itself/u,
    );
});

/** An active format-15 compact prior over the fixture canonical directory. */
function compactPrior15(root: string) {
  return compactPrior(path.join(root, "current"), canonical.listings).prior;
}
