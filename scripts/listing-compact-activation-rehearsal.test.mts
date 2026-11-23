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
  enrichmentFixture,
  fixtureVerifier,
  rehearseCompactActivation,
  writePriorRepository,
} from "./listing-compact-activation-rehearsal.mts";
import {
  classifyCoreInspectionFailure,
  CoreInspectionRefusal,
  isolateValidEnrichment,
  minimumLiveListingReader,
  prepareObservationBundle,
  projectListingDelivery,
  publishedAbove,
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
/** The signed legacy target before cutover: the operational rows' format-11
 * export. Preparation republishes these exact bytes and never changes them. */
const legacyTarget = wire({
  listing_delivery_schema: 1,
  revision: 1,
  withdrawn_ids: [],
  directory: legacyExport({
    listings: canonical.listings.filter((listing) => operationalIds.has(listing.id)),
  }),
});
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
  assert.deepEqual(Object.keys(report.reader_gate), [
    "explicit_without_compact_carrier",
    "explicit_without_candidate_format",
    "explicit_wrong_reader_digest",
    "withdrawn",
    "lacks_candidate_format",
    "substituted_archive",
    "unattested_tag",
    "off_protected_main",
  ]);
  for (const entry of Object.values(report.reader_gate))
    assert.equal(entry.legacy_only_renewed, true);
  const gate = report.reader_gate;
  assert.match(gate.explicit_without_compact_carrier!.reason, /listing format 15/u);
  assert.match(gate.explicit_without_candidate_format!.reason, /listing format 15/u);
  assert.match(gate.explicit_wrong_reader_digest!.reason, /SHA-256 differs/u);
  assert.match(gate.withdrawn!.reason, /withdrawn/u);
  assert.match(gate.lacks_candidate_format!.reason, /listing format 15/u);
  assert.match(gate.substituted_archive!.reason, /attested identity/u);
  assert.match(gate.unattested_tag!.reason, /attestation subject differs/u);
  assert.match(gate.off_protected_main!.reason, /protected main/u);
  assert.equal((report.activation.released_reader_source as { tag: string }).tag, "v0.1.0");
  assert.equal(report.activation.legacy_revision, 1);
  assert.equal(report.activation.compact_revision, 2);
  assert.equal(report.activation.compact_rows, 4);
  assert.equal(report.activation.canonical_rows, 4);
  assert.equal(report.activation.legacy_rows, 2);
  assert.equal(report.activation.legacy_target_retained, true);
  assert.deepEqual(report.after_cutover, {
    held_row: "open-operational",
    compact_revision: 3,
    compact_hold_delivered: true,
    legacy_target_unchanged: true,
    steady_compact_unchanged: true,
  });
  assert.deepEqual(report.enrichment, {
    compact_excluded: ["rehearsal-invalid-observation"],
    compact_valid_observed: true,
    compact_invalid_keeps_prior_observation: true,
    legacy_target_unchanged: true,
  });
  assert.match(report.preconditions.without_prior, /requires the prior signed repository/u);
});

void test("a projection stop renews the exact prior carriers instead of excluding candidates", async (t) => {
  const fixture = fixtureWorkspace(t);
  const enrichment = enrichmentFixture();
  const legacy = legacyTarget;
  // The prior compact target delivers a row the canonical directory lost
  // without a withdrawal; projection refuses it whatever the candidates are.
  const compactDecoded = wire({
    ...document(legacy),
    revision: 2,
    directory: { format_version: 15, listings: [...canonical.listings, row("vanished")] },
  });
  const { encodeCompactListing } = await import("./listing-directory-carrier.mts");
  const priorCompact = encodeCompactListing(compactDecoded);
  const prior = writePriorRepository(path.join(fixture.root, "prior"), {
    [listingDeliveryTarget]: legacy,
    [compactListingDeliveryTarget]: priorCompact,
  });
  const report = await prepareObservationBundle({
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
  });
  assert.deepEqual(report.listing_publication_stopped, {
    code: "missing_without_withdrawal",
    reason:
      "Previously published listing missing from the canonical directory without an explicit withdrawal",
    figures: { missing_count: 1, missing_ids: ["vanished"] },
  });
  assertExactPriorRenewal(path.join(fixture.root, "out"), report, legacy, priorCompact);
});

/** The bundle carries exactly the prior targets and the report says so. */
function assertExactPriorRenewal(
  output: string,
  report: Record<string, unknown>,
  legacy: Buffer,
  compact: Buffer | null,
) {
  const read = (target: string) => {
    try {
      return readFileSync(path.join(output, "bundle", target));
    } catch {
      return null;
    }
  };
  assert.deepEqual(read(listingDeliveryTarget), legacy);
  assert.deepEqual(read(compactListingDeliveryTarget), compact);
  assert.equal(report.changed, false);
  assert.equal(report.carrier, compact ? "compact" : "legacy-renewal");
  assert.equal(report.released_reader_activation, undefined);
  assert.match(String(report.projection_scope), /Listing publication stopped/u);
  assert.ok(
    (report.diagnostics as string[]).some((line) => line.startsWith("listing publication stopped")),
  );
  if (compact) assert.equal(report.transport_changed, false);
}

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
  const legacy = legacyTarget;
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

void test("compact capacity overflow stops listing publication instead of trimming candidates", async (t) => {
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
      projectListingDelivery({ format_version: 15, listings }, observations, previous, {
        compatible: { format_version: 15, listings },
        byteLimit: compactListingDecodedMaximum,
      }),
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
  const { prior, decoded } = compactPrior(fixture.root, listings);
  const report = await prepareObservationBundle({
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
  });
  const stopped = report.listing_publication_stopped as {
    code: string;
    figures: Record<string, number>;
  };
  assert.equal(stopped.code, "transport_bound");
  assert.ok(stopped.figures.wire_bytes! > listingDeliveryMaximum);
  assert.equal(stopped.figures.wire_limit, listingDeliveryMaximum);
  assertExactPriorRenewal(
    path.join(fixture.root, "out"),
    report,
    legacyTarget,
    encodeCompactListing(decoded),
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
  const legacy = legacyTarget;
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
  // Without a verified reader (or with no reader source at all) the exact
  // legacy-only publication is renewed: no compact target, nothing changed.
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
  assert.match(String(plain.released_reader_unavailable), /No released reader source/u);
  const unverified: [string, Parameters<typeof fixtureReleasedReaderSources>[0] | null][] = [
    ["unreachable", null],
    ["withdrawn", { binary: stub, version: "0.1.0", withdrawn: ["0.1.0"] }],
    ["version", { binary: stub, version: "0.1.1" }],
    ["rate-limited", { binary: stub, version: "0.1.0", rateLimited: true }],
  ];
  for (const [name, official] of [...unverified, ["plain", null] as const]) {
    const result =
      name === "plain" ? plain : await prepare(`legacy-${name}`, legacyPrior, official);
    const output = name === "plain" ? "plain" : `legacy-${name}`;
    assert.equal(result.carrier, "legacy-renewal", name);
    assert.equal(result.listing_format, 11, name);
    assert.equal(result.changed, false, name);
    assert.equal(result.revision, 1, name);
    assert.equal(read(output, compactListingDeliveryTarget), null);
    assert.deepEqual(read(output, listingDeliveryTarget), legacy);
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
  // A canonical change after cutover reaches only the compact target.
  const changedCanonical = fixture.write("changed.json", {
    ...canonical,
    listings: canonical.listings.map((listing) =>
      listing.id === "open-discovery" ? { ...listing, summary: "Changed." } : listing,
    ),
  });
  const changed = await prepare("changed", current, null, { canonical: changedCanonical });
  assert.equal(changed.changed, true);
  assert.equal(changed.carrier, "compact");
  assert.deepEqual(read("changed", listingDeliveryTarget), legacy);
  assert.deepEqual(changed.legacy_target, {
    sha256: createHash("sha256").update(legacy).digest("hex"),
    bytes: legacy.length,
    revision: 1,
    unchanged: true,
  });
  // Automatic selection takes no explicit reader.
  await assert.rejects(
    prepare("conflict", legacyPrior, null, {
      releasedReader: { cli: fixture.cli, sha256: "0".repeat(64) },
    }),
    /takes no explicit reader/u,
  );
});

/** An active format-15 compact prior over the fixture canonical directory. */
function compactPrior15(root: string) {
  return compactPrior(path.join(root, "current"), canonical.listings).prior;
}

void test("preparation refuses a bundled listing target and a missing retained legacy target", async (t) => {
  const fixture = fixtureWorkspace(t);
  const prepare = (name: string, prior: string, bundle = fixture.bundle) =>
    prepareObservationBundle({
      bundle,
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
  const prior = compactPrior15(fixture.root);
  for (const target of [listingDeliveryTarget, compactListingDeliveryTarget]) {
    const bundle = path.join(fixture.root, `bundle-${path.basename(target)}`);
    mkdirSync(path.join(bundle, path.dirname(target)), { recursive: true });
    writeFileSync(path.join(bundle, "definitions-index.json"), "{}");
    writeFileSync(path.join(bundle, target), legacyTarget);
    await assert.rejects(
      prepare(`bundled-${path.basename(target)}`, prior, bundle),
      /come only from observation projection/u,
    );
  }
  // The signer accepts the compact target only beside the retained legacy one.
  const compactOnly = writePriorRepository(path.join(fixture.root, "compact-only"), {
    [compactListingDeliveryTarget]: encodeCompactListing(
      wire({ ...document(legacyTarget), revision: 2, directory: canonical }),
    ),
  });
  await assert.rejects(
    prepare("compact-only-output", compactOnly),
    /no retained legacy listing target/u,
  );
});

void test("the minimum supported preview for live listing updates is stated once and documented", async (t) => {
  assert.equal(minimumLiveListingReader, "0.1.0-preview.14");
  for (const doc of ["SIGNED-CATALOG.md", "RELEASING.md"]) {
    const text = readFileSync(new URL(`../docs/${doc}`, import.meta.url), "utf8");
    assert.ok(text.includes(`\`${minimumLiveListingReader}\``), doc);
    assert.match(
      text,
      /raised\s+when\s+a\s+later\s+reader\s+generation\s+replaces\s+the\s+compact\s+carrier/iu,
      doc,
    );
  }
  // Every preparation report carries it.
  const fixture = fixtureWorkspace(t);
  const report = await prepareObservationBundle({
    bundle: fixture.bundle,
    canonical: fixture.canonical,
    catalog: fixture.catalog,
    prior: compactPrior15(fixture.root),
    output: path.join(fixture.root, "minimum"),
    cli: fixture.cli,
    tools: fixture.tools,
    root: fixture.rootFile,
    offlineTargets: fixture.offlineTargets,
    observe: false,
  });
  assert.equal(report.minimum_live_listing_reader, minimumLiveListingReader);
});

/** A CLI whose publication inspection refuses (Core's verification envelope)
 * or crashes whenever the staged bundle carries the compact target. */
function compactInspectionCli(file: string, stub: string, behavior: "refuse" | "crash") {
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[2] === "inspect-definition-publication" &&
    fs.existsSync(path.join(args[3], ${JSON.stringify(compactListingDeliveryTarget)}))) {
  ${
    behavior === "refuse"
      ? `process.stdout.write(JSON.stringify({ ok: false, command: "catalog.inspect-definition-publication", error: { code: "verification", message: "listing record exceeds its byte bound" } })); process.exit(11);`
      : `process.exit(101);`
  }
}
try { process.stdout.write(execFileSync(${JSON.stringify(stub)}, args)); }
catch (error) { process.stdout.write(error.stdout ?? ""); process.exit(error.status ?? 1); }
`,
  );
  chmodSync(file, 0o755);
  return file;
}

void test("a first-cutover Core refusal renews the legacy-only publication and records the stop", async (t) => {
  const fixture = fixtureWorkspace(t);
  const legacyPrior = writePriorRepository(path.join(fixture.root, "legacy-prior"), {
    [listingDeliveryTarget]: legacyTarget,
  });
  const report = await prepareObservationBundle({
    bundle: fixture.bundle,
    canonical: fixture.canonical,
    catalog: fixture.catalog,
    prior: legacyPrior,
    output: path.join(fixture.root, "out"),
    cli: compactInspectionCli(path.join(fixture.root, "refusing-cli"), fixture.cli, "refuse"),
    tools: fixture.tools,
    root: fixture.rootFile,
    offlineTargets: fixture.offlineTargets,
    observe: false,
    // The gate passes: the reader itself supports the compact carrier.
    releasedReader: {
      cli: fixture.cli,
      sha256: createHash("sha256").update(readFileSync(fixture.cli)).digest("hex"),
    },
  });
  assert.ok(report.released_reader, "the released-reader gate passed");
  const stopped = report.listing_publication_stopped as { code: string; reason: string };
  assert.equal(stopped.code, "core_refusal");
  assert.match(stopped.reason, /Core refused the candidate publication \(verification\)/u);
  assert.equal(report.listing_format, 11);
  assert.equal(report.revision, 1);
  assertExactPriorRenewal(path.join(fixture.root, "out"), report, legacyTarget, null);
});

void test("a post-cutover decoded-bound breach renews the exact compact carrier", async (t) => {
  const fixture = fixtureWorkspace(t);
  // Compressible signed observations retained from the prior compact target
  // bring the decoded document just under 32 MiB; one new row crosses it.
  const filler = "x".repeat(8 * 1024 ** 2);
  const observed = canonical.listings.map((listing) => ({
    ...listing,
    upstream_observation: {
      provider: "github",
      repository: `owner/${listing.id}`,
      status: "complete",
      releases: [{ version: filler.slice(0, 8 * 1024 ** 2 - 4096) }],
    },
  }));
  const { prior, decoded } = compactPrior(fixture.root, observed);
  assert.ok(decoded.length <= compactListingDecodedMaximum);
  const grown = fixture.write("grown.json", {
    ...canonical,
    listings: [...canonical.listings, row("new-row", { summary: "y".repeat(64 * 1024) })],
  });
  const report = await prepareObservationBundle({
    bundle: fixture.bundle,
    canonical: grown,
    catalog: fixture.catalog,
    prior,
    output: path.join(fixture.root, "out"),
    cli: fixture.cli,
    tools: fixture.tools,
    root: fixture.rootFile,
    offlineTargets: fixture.offlineTargets,
    observe: false,
  });
  const stopped = report.listing_publication_stopped as {
    code: string;
    figures: Record<string, number>;
  };
  assert.equal(stopped.code, "decoded_bound");
  assert.ok(stopped.figures.decoded_bytes! > compactListingDecodedMaximum);
  assert.equal(stopped.figures.decoded_limit, compactListingDecodedMaximum);
  assert.equal(report.revision, 2);
  assertExactPriorRenewal(
    path.join(fixture.root, "out"),
    report,
    legacyTarget,
    encodeCompactListing(decoded),
  );
});

void test("canonical input changes and tool crashes stay fatal", async (t) => {
  const fixture = fixtureWorkspace(t);
  const prior = compactPrior15(fixture.root);
  const enrichment = enrichmentFixture();
  const canonicalFile = fixture.write("mutable.json", canonical);
  const prepare = (name: string, extra: Record<string, unknown>) =>
    prepareObservationBundle({
      bundle: fixture.bundle,
      canonical: canonicalFile,
      catalog: fixture.catalog,
      prior,
      output: path.join(fixture.root, name),
      cli: fixture.cli,
      tools: fixture.tools,
      root: fixture.rootFile,
      offlineTargets: fixture.offlineTargets,
      ...extra,
    });
  // The canonical directory changes while observations are read.
  await assert.rejects(
    prepare("canonical-changed", {
      readObservation: () => {
        writeFileSync(canonicalFile, JSON.stringify({ ...canonical, listings: [] }));
        return Promise.resolve(enrichment.validInput);
      },
    }),
    /Canonical inputs changed during observation projection/u,
  );
  writeFileSync(canonicalFile, JSON.stringify(canonical));
  // The withdrawal record changes while observations are read.
  const record = fixture.write("withdrawals.json", { schema_version: 1, withdrawals: [] });
  await assert.rejects(
    prepare("withdrawals-changed", {
      withdrawals: record,
      readObservation: () => {
        writeFileSync(
          record,
          JSON.stringify({
            schema_version: 1,
            withdrawals: [
              {
                id: "gone",
                reason: "Removed.",
                reference: "https://github.com/boburning/portcove/issues/1",
              },
            ],
          }),
        );
        return Promise.resolve(enrichment.validInput);
      },
    }),
    /Canonical inputs changed during observation projection/u,
  );
  // Core crashing on the final staged publication is not a refusal.
  await assert.rejects(
    prepare("final-crash", {
      observe: false,
      canonical: fixture.write("changed-final.json", {
        ...canonical,
        listings: canonical.listings.map((listing) =>
          listing.id === "open-discovery" ? { ...listing, summary: "Changed." } : listing,
        ),
      }),
      cli: compactInspectionCli(path.join(fixture.root, "crashing-cli"), fixture.cli, "crash"),
    }),
    /inspection failed without a candidate refusal \(exit 101\)/u,
  );
});

const withdrawal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  reason: "The upstream project asked to be removed.",
  reference: "https://github.com/boburning/portcove/issues/1422",
  ...extra,
});

void test("a committed withdrawal publishes a removed row as withdrawn; without one listing publication stops", async (t) => {
  const fixture = fixtureWorkspace(t);
  const { prior, decoded } = compactPrior(fixture.root, [...canonical.listings, row("retired")]);
  const prepare = (name: string, withdrawals?: unknown) =>
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
      ...(withdrawals === undefined
        ? {}
        : { withdrawals: fixture.write(`${name}-withdrawals.json`, withdrawals) }),
    });
  const withdrawn = await prepare("withdrawn", {
    schema_version: 1,
    withdrawals: [withdrawal("retired")],
  });
  assert.equal(withdrawn.listing_publication_stopped, undefined);
  assert.equal(withdrawn.changed, true);
  assert.equal(withdrawn.withdrawn_records, 1);
  assert.equal(withdrawn.delivered_records, 4);
  assert.equal((withdrawn.withdrawal_record as { withdrawals: number }).withdrawals, 1);
  const published = document(
    (await import("./listing-directory-carrier.mts")).decodeRetainedCompactListing(
      readFileSync(path.join(fixture.root, "withdrawn", "bundle", compactListingDeliveryTarget)),
    ),
  );
  assert.deepEqual(published.withdrawn_ids, ["retired"]);
  assert.equal(published.revision, 3);
  assert.ok(!published.directory.listings.some((listing) => listing.id === "retired"));
  assert.deepEqual(
    readFileSync(path.join(fixture.root, "withdrawn", "bundle", listingDeliveryTarget)),
    legacyTarget,
  );
  // Removed without a committed withdrawal: listing publication stops loudly
  // and the prior targets are renewed; the row is never silently dropped.
  for (const [name, record] of [
    ["unrecorded", { schema_version: 1, withdrawals: [] }],
    ["no-record", undefined],
  ] as const) {
    const report = await prepare(name, record);
    assert.equal(
      (report.listing_publication_stopped as { code: string }).code,
      "missing_without_withdrawal",
      name,
    );
    assertExactPriorRenewal(
      path.join(fixture.root, name),
      report,
      legacyTarget,
      encodeCompactListing(decoded),
    );
  }
  // An invalid record stops listing publication the same way.
  const invalid = await prepare("invalid", {
    schema_version: 1,
    withdrawals: [withdrawal("retired", { reference: "issue 1" })],
  });
  assert.equal((invalid.listing_publication_stopped as { code: string }).code, "withdrawal_input");
});

void test("the withdrawal record is reviewed, sorted, cumulative and never re-lists an identity", async () => {
  const { listingWithdrawals, ListingPublicationStop } =
    await import("./listing-observation-delivery.mts");
  const record = (...entries: unknown[]) => ({ schema_version: 1, withdrawals: entries });
  const none = new Set<string>();
  assert.deepEqual(listingWithdrawals(record(withdrawal("a"), withdrawal("b")), none), ["a", "b"]);
  assert.deepEqual(
    listingWithdrawals(
      record(withdrawal("a", { reference: "https://github.com/boburning/portcove/pull/8619" })),
      none,
    ),
    ["a"],
  );
  const refusals: [unknown, ReadonlySet<string>, string[], RegExp][] = [
    [{ schema_version: 2, withdrawals: [] }, none, [], /schema_version 1/u],
    [{ schema_version: 1, withdrawals: [], extra: 1 }, none, [], /schema_version 1/u],
    [record(withdrawal("b"), withdrawal("a")), none, [], /sorted by id/u],
    [record(withdrawal("a"), withdrawal("a")), none, [], /sorted by id/u],
    [record(withdrawal("A")), none, [], /listing id/u],
    [record(withdrawal("a", { reason: "" })), none, [], /a reason/u],
    [record(withdrawal("a", { reason: " padded " })), none, [], /a reason/u],
    [record({ id: "a", reason: "Removed." }), none, [], /reference/u],
    [
      record(withdrawal("a", { reference: "https://github.com/other/repo/issues/1" })),
      none,
      [],
      /reference/u,
    ],
    [record(withdrawal("a", { note: "x" })), none, [], /reference/u],
    // A withdrawn identity may not return to the canonical directory.
    [record(withdrawal("a")), new Set(["a"]), [], /still in the canonical directory/u],
    // A published withdrawal is never removed from the record.
    [record(withdrawal("a")), none, ["a", "b"], /never removed/u],
  ];
  for (const [value, ids, published, pattern] of refusals)
    assert.throws(
      () => listingWithdrawals(value, ids, published),
      (error: unknown) =>
        error instanceof ListingPublicationStop &&
        error.code === "withdrawal_input" &&
        pattern.test(error.message),
      JSON.stringify(value),
    );
});

void test("the committed withdrawal record is valid against the committed listings", async () => {
  const { listingWithdrawals, listingWithdrawalsInput } =
    await import("./listing-observation-delivery.mts");
  const repository = new URL("../", import.meta.url);
  const listings = JSON.parse(
    readFileSync(new URL("crates/portcove-core/catalog/listings.json", repository), "utf8"),
  ) as { listings: { id: string }[] };
  const record: unknown = JSON.parse(
    readFileSync(new URL(listingWithdrawalsInput, repository), "utf8"),
  );
  listingWithdrawals(record, new Set(listings.listings.map((listing) => listing.id)));
  const workflow = readFileSync(
    new URL(".github/workflows/catalog-publish.yml", repository),
    "utf8",
  );
  assert.ok(workflow.includes(`--withdrawals ${listingWithdrawalsInput}`));
});
