import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  advanceArtworkCheckpoint,
  coverDeclarationScope,
  readArtworkCheckpoint,
} from "./listing-artwork-checkpoint.mts";
import { applicableCoverHealth, readHostedCoverHealth } from "./listing-artwork-observation.mts";

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
