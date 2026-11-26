import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sameStaticPublicationTargets } from "./catalog-publish.mts";
import { readApprovedCoverJournal } from "./catalog-cover-approval-journal.mts";
import {
  exactCoverReaderPair,
  recheckReleasedCoverPublication,
  requireExactReleasedCoverInspection,
} from "./listing-cover-reader-proof.mts";
import {
  compactListingDeliveryTarget,
  encodeCompactListing,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { catalogPublicationInventory } from "./release-catalog-publication-contract.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { fixtureListing, fixturePolicy } from "./fixtures/listing-observation-delivery-fixture.mts";
import {
  advanceArtworkCheckpoint,
  artworkCheckpointTarget,
  coverDeclarationScope,
  readArtworkCheckpoint,
} from "./listing-artwork-checkpoint.mts";
import { applicableCoverHealth, readHostedCoverHealth } from "./listing-artwork-observation.mts";
import { projectListingDelivery } from "./listing-observation-delivery.mts";

const artwork = {
  game_id: 100,
  cover_id: 1,
  game_slug: "original",
  match_kind: "underlying-game",
  image_id: "cosample",
  image_sha256: "a".repeat(64),
} as const;
const listing = {
  id: "fixture-port",
  project_url: "https://github.com/example/fixture-port",
  original_game_title: "Original",
  original_game: { id: "original" },
  artwork,
};
const observedAt = "2026-11-26T12:00:00.000Z";
const newerAt = "2026-11-26T13:00:00.000Z";
const report = "sha256:" + "b".repeat(64);
const wire = (row: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ revision: 1, listings: [row] }));
const gone = {
  id: listing.id,
  artwork,
  scope: coverDeclarationScope(listing, artwork),
  report,
  status: "propose_fallback",
  observed_at: observedAt,
};

void test("exact scoped withdrawal survives a quiet renewal and only later accepted bytes restore it", () => {
  const initial = advanceArtworkCheckpoint(null, [gone]);
  const stripped = initial.apply(listing);
  assert.ok(!Object.hasOwn(stripped, "artwork"));
  const strippedListing = wire(stripped);
  const checkpoint = initial.finish(strippedListing);
  assert.ok(checkpoint);
  const prior = { bytes: checkpoint, listing: strippedListing };
  const reread = advanceArtworkCheckpoint(prior, []);
  assert.deepEqual(reread.apply(listing), stripped);
  assert.deepEqual(reread.finish(strippedListing), checkpoint);
  assert.throws(() => readArtworkCheckpoint(checkpoint, wire(listing)), /unbound/u);

  const stale = { ...gone, status: "verified_accepted_bytes" };
  const changed = { ...gone, observed_at: newerAt, status: "hold_changed_bytes" };
  const attempted = advanceArtworkCheckpoint(prior, [stale, changed]);
  assert.deepEqual(attempted.apply(listing), stripped);
  assert.deepEqual(attempted.finish(strippedListing), checkpoint);
  const restored = advanceArtworkCheckpoint(prior, [{ ...stale, observed_at: newerAt }]);
  assert.deepEqual(restored.apply(listing), listing);
  const next = restored.finish(wire(listing));
  assert.ok(next);
  const decoded = readArtworkCheckpoint(next, wire(listing));
  assert.equal(decoded.entries[0]?.state, "restored");
  assert.ok(decoded.prior_checkpoint_sha256);
});

void test("cover declarations and collection members do not borrow previous authority", () => {
  const initial = advanceArtworkCheckpoint(null, [gone]);
  const replacement = { ...listing, artwork: { ...artwork, image_sha256: "c".repeat(64) } };
  const edition = { ...listing, original_game: { id: "other" } };
  const project = { ...listing, project_url: "https://github.com/example/successor" };
  for (const changed of [replacement, edition, project])
    assert.deepEqual(initial.apply(changed), changed);

  const alternate = {
    ...artwork,
    image_id: "coalternate",
    image_sha256: "d".repeat(64),
    game_id: 101,
    cover_id: 2,
  };
  const { artwork: _artwork, ...base } = listing;
  const collection = { ...base, collection_covers: [artwork, alternate] };
  assert.deepEqual(initial.apply(collection), collection);
  const cover = advanceArtworkCheckpoint(null, [
    { ...gone, scope: coverDeclarationScope(collection, artwork) },
  ]);
  assert.deepEqual(cover.apply(collection).collection_covers, [alternate]);
});

void test("completed observations can only affect their exact current authored declaration", () => {
  const facts = new Map<string, unknown>([
    [
      `port:${listing.id}@${artwork.image_id}`,
      {
        id: listing.id,
        artwork,
        status: "gone",
        observed_at: observedAt,
      },
    ],
  ]);
  const evidence = {
    producerDirectory: { listings: [listing] },
    facts,
    artifact: report,
    producer: { workflow: "fixture", run: "1", attempt: "1", revision: "a".repeat(40) },
    revision: "fixture",
    rows: 1,
    expected: 1,
    complete: true,
    gaps: [],
    counts: { unchanged: 0, mismatch: 0, gone: 1, unavailable: 0, deferred: 0 },
  };
  assert.deepEqual(applicableCoverHealth({ listings: [listing] }, evidence), [gone]);
  assert.deepEqual(
    applicableCoverHealth(
      { listings: [{ ...listing, original_game_title: "Remaster" }] },
      evidence,
    ),
    [],
  );
  facts.set(`port:${listing.id}@${artwork.image_id}`, {
    id: listing.id,
    artwork: { ...artwork, cover_id: 9 },
    status: "gone",
    observed_at: observedAt,
  });
  assert.deepEqual(applicableCoverHealth({ listings: [listing] }, evidence), []);
});

void test("a completed schedule without successful collection supplies no publication transition", async () => {
  const result = await readHostedCoverHealth(
    () => {
      throw new Error("failed schedule cannot supply prior declarations");
    },
    {
      now: Date.parse("2026-11-26T15:00:00Z"),
      transport: {
        read: async () => {
          return {
            workflow_runs: [
              {
                id: 45839944185,
                run_attempt: 1,
                path: ".github/workflows/maintenance-inventory.yml",
                event: "schedule",
                head_branch: "main",
                status: "completed",
                conclusion: "failure",
                head_repository: { id: 1354613114, full_name: "boburning/portcove" },
                head_sha: "e5d6160e1c3f8ffd970e1ef8df9f4d7611b2e4ff",
                run_started_at: "2026-11-26T14:20:00Z",
                updated_at: "2026-11-26T14:38:49Z",
              },
            ],
          };
        },
        download: async () => {
          throw new Error("failed schedule cannot supply artifact");
        },
      },
    },
  );
  assert.equal(result, null);
});

void test("a full checkpoint still accepts a newer result for an admitted scope", () => {
  const cover = { ...artwork, image_id: "e".repeat(128) };
  const prefix = { ...listing, id: "a-priority-fixture", artwork: cover };
  const first = {
    ...gone,
    id: prefix.id,
    artwork: cover,
    scope: coverDeclarationScope(prefix, cover),
  };
  const rows = Array.from({ length: 3072 }, (_, index) => {
    const row = { ...prefix, id: "z-fixture-" + index.toString().padStart(4, "0") };
    return { ...first, id: row.id, scope: coverDeclarationScope(row, cover) };
  });
  const initial = advanceArtworkCheckpoint(null, [first, ...rows]);
  assert.ok(initial.deferred > 0);
  const active = wire(initial.apply(prefix));
  const checkpoint = initial.finish(active);
  assert.ok(checkpoint);
  const restored = advanceArtworkCheckpoint({ bytes: checkpoint, listing: active }, [
    { ...first, status: "verified_accepted_bytes", observed_at: newerAt },
  ]);
  assert.deepEqual(restored.apply(prefix), prefix);
  assert.ok(restored.finish(wire(prefix)));
});

void test("the appointed report archive admits an exact cover receipt and skips inert report HTML", async () => {
  const runId = 123;
  const attempt = 1;
  const revision = "a".repeat(40);
  const repository = "boburning/portcove";
  const workflow = ".github/workflows/maintenance-inventory.yml";
  const repositoryId = 1354613114;
  const source = wire(listing);
  const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const receipt = JSON.stringify({
    format: 1,
    authority: "none",
    listings_sha256: hash(source),
    cli_sha256: "c".repeat(64),
    observed_at: observedAt,
    producer: {
      workflow: repository + "/" + workflow + "@refs/heads/main",
      run: String(runId),
      attempt: String(attempt),
      revision,
    },
    images: [{ image_id: artwork.image_id, status: "gone" }],
  });
  const evidence = JSON.stringify({
    format: "portcove-maintenance-hosted-evidence",
    format_version: 1,
    purpose: "schedule",
    run: { id: runId, attempt, head_sha: revision, event: "schedule" },
    outcomes: { collect: "success", report: "success" },
    files: {
      "maintenance-report/cover-artwork-health.json": {
        bytes: Buffer.byteLength(receipt),
        sha256: hash(receipt),
      },
    },
    sources: [
      {
        source: "cover-artwork-health",
        source_revision: `scheduled-artwork-health:${runId}-${attempt}@${revision}#sha256:${hash(receipt)}`,
        coverage: "complete",
      },
    ],
  });
  const siblings = [
    ["cover-artwork-health.json", receipt],
    ["evidence.json", evidence],
    ["ci-throughput.json", "{}"],
    ["report/inventory.json", "{}"],
    ["report/index.html", "<!doctype html><title>Maintenance</title>"],
    ["digest/digest.json", "{}"],
    ["digest/digest.md", "# Digest"],
  ] as const;
  const run = {
    id: runId,
    run_attempt: attempt,
    path: workflow,
    event: "schedule",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_repository: { id: repositoryId, full_name: repository },
    head_sha: revision,
    run_started_at: "2026-11-26T11:59:00Z",
    updated_at: "2026-11-26T12:30:00Z",
  };
  const read = (archive: Buffer) =>
    readHostedCoverHealth(
      (actualRevision, file) => {
        assert.equal(actualRevision, revision);
        assert.equal(file, "crates/portcove-core/catalog/listings.json");
        return source;
      },
      {
        now: Date.parse(newerAt),
        transport: {
          read: async (endpoint) =>
            endpoint.includes("/workflows/")
              ? { workflow_runs: [run] }
              : {
                  total_count: 1,
                  artifacts: [
                    {
                      id: 191,
                      name: `maintenance-report-${runId}-${attempt}`,
                      size_in_bytes: archive.length,
                      expired: false,
                      digest: "sha256:" + hash(archive),
                      workflow_run: {
                        id: runId,
                        repository_id: repositoryId,
                        head_repository_id: repositoryId,
                        head_branch: "main",
                        head_sha: revision,
                      },
                    },
                  ],
                },
          download: async (id, bytes) => {
            assert.equal(id, 191);
            assert.equal(bytes, archive.length);
            return archive;
          },
        },
      },
    );
  const admitted = await read(createAuditZip(siblings));
  assert.equal(
    admitted?.facts.get(`port:${listing.id}@${artwork.image_id}`) instanceof Object,
    true,
  );
  assert.equal(admitted?.counts.gone, 1);
  await assert.rejects(
    read(createAuditZip([...siblings, ["digest/extra.html", "unexpected"]])),
    /path/u,
  );
  const priorEvidence: unknown = JSON.parse(evidence);
  assert.ok(priorEvidence && typeof priorEvidence === "object");
  const priorOnly = {
    ...priorEvidence,
    sources: [
      {
        source: "cover-artwork-health",
        source_revision: "scheduled-artwork-health:older-generation",
        coverage: "partial",
      },
    ],
  };
  const withoutAdmission = siblings.map(
    ([name, bytes]) =>
      [name, name === "evidence.json" ? JSON.stringify(priorOnly) : bytes] as const,
  );
  assert.equal(await read(createAuditZip(withoutAdmission)), null);
  const withoutReceipt = withoutAdmission
    .filter(([name]) => name !== "cover-artwork-health.json")
    .map(
      ([name, bytes]) =>
        [
          name,
          name === "evidence.json" ? JSON.stringify({ ...priorOnly, files: {} }) : bytes,
        ] as const,
    );
  assert.equal(await read(createAuditZip(withoutReceipt)), null);
  await assert.rejects(
    read(createAuditZip(siblings.filter(([name]) => name !== "cover-artwork-health.json"))),
    /omitted referenced observation/u,
  );
});

void test("compact projection retains release activity through exact cover withdrawal, renewal and restoration", () => {
  const row = { ...fixtureListing, artwork };
  const canonical = { format_version: 15, listings: [row] };
  const observed = {
    ...gone,
    id: row.id,
    scope: coverDeclarationScope(row, artwork),
  };
  const original = projectListingDelivery(canonical, [fixturePolicy(row).listing_update], null);
  const read = (bytes: Buffer) => {
    const decoded = JSON.parse(bytes.toString("utf8")) as {
      directory: { listings: Record<string, unknown>[] };
    };
    const projected = decoded.directory.listings[0];
    assert.ok(projected);
    return projected;
  };
  const activity = read(original.bytes).upstream_observation;
  assert.ok(activity);
  const withdraw = advanceArtworkCheckpoint(null, [observed]);
  const removed = projectListingDelivery(canonical, [], original.bytes, {
    coverCheckpoint: withdraw,
  });
  assert.equal(removed.revision, original.revision + 1);
  assert.equal(read(removed.bytes).artwork, undefined);
  assert.deepEqual(read(removed.bytes).upstream_observation, activity);
  const checkpoint = withdraw.finish(removed.bytes);
  assert.ok(checkpoint);

  const prior = { bytes: checkpoint, listing: removed.bytes };
  const renew = advanceArtworkCheckpoint(prior, []);
  const unchanged = projectListingDelivery(canonical, [], removed.bytes, {
    coverCheckpoint: renew,
  });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.bytes, removed.bytes);
  assert.deepEqual(renew.finish(unchanged.bytes), checkpoint);

  const restore = advanceArtworkCheckpoint(prior, [
    { ...observed, status: "verified_accepted_bytes", observed_at: newerAt },
  ]);
  const restored = projectListingDelivery(canonical, [], removed.bytes, {
    coverCheckpoint: restore,
  });
  assert.equal(restored.revision, removed.revision + 1);
  assert.deepEqual(read(restored.bytes).artwork, artwork);
  assert.deepEqual(read(restored.bytes).upstream_observation, activity);

  const changed = projectListingDelivery(
    {
      ...canonical,
      listings: [{ ...row, release_url: "https://github.com/owner/replacement/releases" }],
    },
    [],
    removed.bytes,
    { coverCheckpoint: renew },
  );
  assert.equal(read(changed.bytes).upstream_observation, undefined);
});

void test("an approved replacement keeps release activity across Gone, renewal, and restoration", () => {
  const row = { ...fixtureListing, artwork };
  const authored = { format_version: 15, listings: [row] };
  const original = projectListingDelivery(authored, [fixturePolicy(row).listing_update], null);
  const candidate = {
    ...artwork,
    cover_id: 2,
    image_id: "coreviewed",
    image_sha256: "c".repeat(64),
  };
  const packet = "d".repeat(64);
  const journal = readApprovedCoverJournal({
    format_version: 1,
    approvals: [
      {
        id: row.id,
        scope: coverDeclarationScope(row, artwork),
        role: "cover",
        authored: artwork,
        prior: artwork,
        candidate,
        packet,
        source: "e".repeat(40),
        run: "1",
        bytes: 100,
      },
    ],
    consumed_packets: [packet],
  });
  const selected = projectListingDelivery(authored, [], original.bytes, {
    coverApprovals: journal,
  });
  const project = (
    previous: Buffer,
    coverCheckpoint: ReturnType<typeof advanceArtworkCheckpoint>,
  ) =>
    projectListingDelivery(authored, [], previous, {
      coverApprovals: journal,
      coverCheckpoint,
    });
  const read = (bytes: Buffer) => {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      directory: { listings: Record<string, unknown>[] };
    };
    return parsed.directory.listings[0]!;
  };
  const activity = read(original.bytes).upstream_observation;
  assert.ok(activity);
  assert.deepEqual(read(selected.bytes).artwork, candidate);
  const changedAuthoredCover = {
    ...artwork,
    cover_id: 7,
    image_id: "coahead",
    image_sha256: "f".repeat(64),
  };
  const unauthenticatedChange = projectListingDelivery(
    { ...authored, listings: [{ ...row, artwork: changedAuthoredCover }] },
    [],
    selected.bytes,
    { coverApprovals: journal },
  );
  assert.equal(unauthenticatedChange.changed, false);
  assert.deepEqual(read(unauthenticatedChange.bytes).artwork, candidate);
  assert.deepEqual(read(selected.bytes).upstream_observation, activity);
  const exactGone = {
    ...gone,
    id: row.id,
    artwork: candidate,
    scope: coverDeclarationScope(row, candidate),
  };
  const withdraw = advanceArtworkCheckpoint(null, [exactGone]);
  const removed = project(selected.bytes, withdraw);
  assert.equal(read(removed.bytes).artwork, undefined);
  assert.deepEqual(read(removed.bytes).upstream_observation, activity);
  const checkpoint = withdraw.finish(removed.bytes);
  assert.ok(checkpoint);
  const prior = { bytes: checkpoint, listing: removed.bytes };
  const renewal = project(removed.bytes, advanceArtworkCheckpoint(prior, []));
  assert.equal(renewal.changed, false);
  const restored = project(
    removed.bytes,
    advanceArtworkCheckpoint(prior, [
      {
        ...exactGone,
        status: "verified_accepted_bytes",
        observed_at: newerAt,
      },
    ]),
  );
  assert.deepEqual(read(restored.bytes).artwork, candidate);
  assert.deepEqual(read(restored.bytes).upstream_observation, activity);
});

function coverReaderFixture() {
  const row = { ...fixtureListing, artwork };
  const decisions = advanceArtworkCheckpoint(null, [
    {
      ...gone,
      id: row.id,
      scope: coverDeclarationScope(row, artwork),
    },
  ]);
  const baseline = projectListingDelivery({ format_version: 15, listings: [row] }, [], null);
  const projected = projectListingDelivery(
    { format_version: 15, listings: [row] },
    [],
    baseline.bytes,
    { coverCheckpoint: decisions },
  );
  const checkpoint = decisions.finish(projected.bytes);
  assert.ok(checkpoint);
  const compact = encodeCompactListing(projected.bytes);
  const files = new Map<string, Buffer>([
    ["definitions/index.json", Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}')],
    [listingDeliveryTarget, baseline.bytes],
    [compactListingDeliveryTarget, compact],
    [artworkCheckpointTarget, checkpoint],
  ]);
  return { baseline, files };
}

void test("the released cover inspection must match exact staged bytes and the compact decoded identity", () => {
  const { baseline, files } = coverReaderFixture();
  const pair = exactCoverReaderPair(files);
  const data = {
    publication_schema: 3,
    authority: "none",
    scope: "inert-catalog-publication-inspection",
    index_sha256: pair.index_sha256,
    files: catalogPublicationInventory(files),
    listings: { target: compactListingDeliveryTarget, sha256: pair.listing_wire_sha256 },
    cover_checkpoint: {
      target: artworkCheckpointTarget,
      sha256: pair.checkpoint_sha256,
      listing_decoded_sha256: pair.listing_decoded_sha256,
    },
  };
  const envelope = (data: unknown) =>
    JSON.stringify({
      schema_version: 100,
      ok: true,
      error: null,
      command: "catalog.inspect-definition-publication",
      data,
    });
  assert.deepEqual(requireExactReleasedCoverInspection(envelope(data), "", files), pair);
  assert.throws(
    () =>
      requireExactReleasedCoverInspection(envelope({ ...data, publication_schema: 2 }), "", files),
    /exact staged bundle/u,
  );
  assert.throws(
    () =>
      requireExactReleasedCoverInspection(
        envelope({
          ...data,
          files: data.files.filter((file) => file.target !== listingDeliveryTarget),
        }),
        "",
        files,
      ),
    /exact staged bundle/u,
  );
  assert.throws(
    () =>
      requireExactReleasedCoverInspection(
        envelope({
          ...data,
          cover_checkpoint: {
            ...data.cover_checkpoint,
            listing_decoded_sha256: pair.listing_wire_sha256,
          },
        }),
        "",
        files,
      ),
    /active compact directory/u,
  );
  const missingLegacy = new Map(files);
  missingLegacy.delete(listingDeliveryTarget);
  assert.throws(() => exactCoverReaderPair(missingLegacy), /complete staged compact publication/u);
  const replacedLegacy = new Map(files);
  replacedLegacy.set(listingDeliveryTarget, Buffer.from("different frozen legacy bytes"));
  const otherPair = exactCoverReaderPair(replacedLegacy);
  assert.equal(otherPair.checkpoint_sha256, pair.checkpoint_sha256);
  assert.equal(otherPair.listing_decoded_sha256, pair.listing_decoded_sha256);
  assert.notEqual(otherPair.bundle_sha256, pair.bundle_sha256);
  assert.throws(
    () => requireExactReleasedCoverInspection(envelope(data), "", replacedLegacy),
    /exact staged bundle/u,
  );
  const changed = new Map(files);
  changed.set(compactListingDeliveryTarget, encodeCompactListing(baseline.bytes));
  assert.throws(() => requireExactReleasedCoverInspection(envelope(data), "", changed), /unbound/u);
});

void test("the Pages guard binds cover activation to the signed bundle and still-selected immutable reader", async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "cover-publication-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const site = path.join(work, "site");
  const { files } = coverReaderFixture();
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const write = (name: string, bytes: Buffer | string) => {
    const file = path.join(work, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const publishFixture = (root: string, logicalFiles: ReadonlyMap<string, Buffer>) => {
    const timestamp = JSON.stringify({
      signed: { version: 1, meta: { "snapshot.json": { version: 1 } } },
    });
    write(`${root}/metadata/timestamp.json`, timestamp);
    write(
      `${root}/metadata/1.snapshot.json`,
      JSON.stringify({
        signed: {
          meta: {
            "official-definitions.json": { version: 1 },
            "official-policy.json": { version: 1 },
          },
        },
      }),
    );
    const inventory = [
      {
        target: "metadata/timestamp.json",
        bytes: Buffer.byteLength(timestamp),
        sha256: sha(timestamp),
      },
    ];
    for (const role of ["official-definitions", "official-policy"]) {
      const targets: Record<string, { hashes: { sha256: string } }> = {};
      for (const [name, bytes] of logicalFiles) {
        if (name.startsWith("policy/") !== (role === "official-policy")) continue;
        const digest = sha(bytes);
        targets[name] = { hashes: { sha256: digest } };
        const target = `targets/${digest}.${name}`;
        write(`${root}/${target}`, bytes);
        inventory.push({ target, bytes: bytes.length, sha256: digest });
      }
      write(`${root}/metadata/1.${role}.json`, JSON.stringify({ signed: { targets } }));
    }
    if (root === "repository") {
      write(
        "assembly-report.json",
        JSON.stringify({
          schema_version: 1,
          authority: "none",
          files: inventory,
          timestamp_sha256: sha(timestamp),
          repository_sha256: sha(JSON.stringify(inventory)),
        }),
      );
    }
  };
  const baseline = new Map(files);
  baseline.delete(artworkCheckpointTarget);
  publishFixture("prior", baseline);
  publishFixture("repository", files);
  write("observation-projection.json", "{}");
  await assert.rejects(
    recheckReleasedCoverPublication(work, site),
    /exact staged released-reader proof/u,
  );

  const version = "1.0.0-preview.1";
  const tag = `v${version}`;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: site, stdio: "pipe" });
  write(
    "site/updates/preview/latest.json",
    JSON.stringify({
      version,
      platforms: {
        "linux-x86_64": {
          url: `https://github.com/boburning/portcove/releases/download/${tag}/Portcove_${version}_amd64.AppImage`,
        },
      },
    }),
  );
  git("init");
  const commit = () => {
    git("add", "updates");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Update fixture",
    );
  };
  commit();
  const release = {
    version,
    tag,
    feed_commit: "a".repeat(40),
    source: "b".repeat(40),
    tag_object: "c".repeat(40),
    release_id: 1,
    archive_bytes: 10,
    archive_sha256: "d".repeat(64),
    checksum_sha256: "e".repeat(64),
    reader_sha256: "a".repeat(64),
  };
  write(
    "observation-projection.json",
    JSON.stringify({
      released_cover_proof: { ...release, ...exactCoverReaderPair(files) },
    }),
  );
  await recheckReleasedCoverPublication(work, site);

  const changed = new Map(files);
  changed.set(listingDeliveryTarget, Buffer.from("different retained legacy bytes"));
  publishFixture("repository", changed);
  await assert.rejects(recheckReleasedCoverPublication(work, site), /different signed bundle/u);

  publishFixture("repository", files);
  write("site/updates/withdrawn.json", JSON.stringify([version]));
  commit();
  await assert.rejects(
    recheckReleasedCoverPublication(work, site),
    /Official Preview is withdrawn/u,
  );

  publishFixture("prior", files);
  await recheckReleasedCoverPublication(work, site);
  publishFixture("repository", baseline);
  await assert.rejects(
    recheckReleasedCoverPublication(work, site),
    /omitted the retained cover checkpoint/u,
  );
});

void test("derived cover proof does not mark unchanged authored publication input dirty", () => {
  const authored = { "definitions/index.json": "same" };
  const published = {
    ...authored,
    [compactListingDeliveryTarget]: "compact",
    [artworkCheckpointTarget]: "checkpoint",
  };
  assert.equal(sameStaticPublicationTargets(authored, published), true);
  assert.equal(
    sameStaticPublicationTargets({ ...authored, [artworkCheckpointTarget]: "changed" }, published),
    false,
  );
  assert.equal(
    sameStaticPublicationTargets({ "definitions/index.json": "changed" }, published),
    false,
  );
});
