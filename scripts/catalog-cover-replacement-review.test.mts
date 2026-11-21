import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireCheckpointProcessLock } from "./process-lock.mts";
import { fileURLToPath } from "node:url";
import { readCatalogSource } from "./catalog-authoring.mts";
import { observationHash } from "./upstream-observer.mts";
import {
  acceptApprovedCovers,
  observeApprovedCoverHealth,
  projectApprovedCovers,
  protectedCoverApproval,
  readApprovedCoverJournal,
} from "./catalog-cover-approval.mts";
import { validArtworkMapping } from "./catalog-cover-mapping.mts";
import { advanceArtworkCheckpoint } from "./listing-artwork-checkpoint.mts";
import { createIgdbInspector } from "./inspect-igdb-artwork.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import {
  reviewCoverReplacementBatch,
  withCoverReviewCheckpoint,
} from "./catalog-cover-replacement-review.mts";

const validator = "a".repeat(64);
const prior = {
  game_id: 1622,
  game_slug: "mortal-kombat-4",
  match_kind: "underlying-game" as const,
  cover_id: 237769,
  image_id: "co53gp",
  image_sha256: "b".repeat(64),
};
const next = { ...prior, cover_id: 619943, image_id: "codacn", image_sha256: "c".repeat(64) };
const subject = {
  format_version: 1,
  listing: { id: "example", original_game_title: "Mortal Kombat 4", artwork: prior },
} as AuthoredPort;
const replacement = { ...subject, listing: { ...subject.listing, artwork: next } };
const record = {
  port_id: "example",
  role: "cover",
  reason: "exact-original-game-cover",
  mapping: next,
  checks: {
    identity: {
      kind: "underlying-game",
      game_id: 1622,
      slug: "mortal-kombat-4",
      evidence_url: "https://www.igdb.com/games/mortal-kombat-4",
    },
    content: {
      validator: "portcove-core",
      validator_artifact_sha256: validator,
      format: "jpeg",
      sha256: next.image_sha256,
      bytes: 20593,
      width: 264,
      height: 352,
    },
  },
};
const prepare = (
  proposed: readonly AuthoredPort[] = [replacement],
  observed: readonly unknown[] = [record],
) => reviewCoverReplacementBatch([subject], proposed, ["example"], observed, validator);

void test("same-game cover changes bind the old and new complete record to review", () => {
  const [row] = prepare();
  assert.equal(row?.role, "cover");
  assert.deepEqual(row?.prior, prior);
  assert.deepEqual(row?.candidate, next);
  assert.notEqual(row?.prior_record_sha256, row?.proposed_record_sha256);
  assert.deepEqual(
    prepare(
      [],
      [
        {
          ...record,
          mapping: prior,
          checks: {
            ...record.checks,
            content: { ...record.checks.content, sha256: prior.image_sha256 },
          },
        },
      ],
    ),
    [],
  );
});

void test("cover review refuses stale, unrelated, duplicate or incomplete proposals", () => {
  assert.throws(() => prepare([replacement, replacement]), /duplicate subject/u);
  assert.throws(() => prepare([replacement], [record, record]), /Duplicate selected/u);
  assert.throws(
    () =>
      prepare(
        [replacement],
        [{ ...record, reason: "accepted-mapping-retained-after-unavailable-refresh" }],
      ),
    /incomplete/u,
  );
  assert.throws(
    () =>
      prepare(
        [replacement],
        [
          {
            ...record,
            checks: {
              ...record.checks,
              content: { ...record.checks.content, validator_artifact_sha256: "f".repeat(64) },
            },
          },
        ],
      ),
    /incomplete/u,
  );
  assert.throws(
    () =>
      prepare([
        {
          ...replacement,
          listing: { ...replacement.listing, original_game_title: "Different original" },
        },
      ]),
    /outside the replacement/u,
  );
  assert.throws(
    () => prepare([{ ...replacement, listing: { ...replacement.listing, id: "different" } }]),
    /unselected/u,
  );
  assert.throws(
    () =>
      prepare([
        { ...replacement, listing: { ...replacement.listing, artwork: { ...next, game_id: 123 } } },
      ]),
    /differs/u,
  );
  assert.throws(
    () =>
      reviewCoverReplacementBatch(
        [subject],
        [replacement],
        ["example", "example"],
        [record],
        validator,
      ),
    /unique/u,
  );
});

void test("cover review refuses a digest-only change under the existing IGDB identities", () => {
  const mapping = { ...prior, image_sha256: next.image_sha256 };
  assert.throws(
    () =>
      prepare(
        [{ ...replacement, listing: { ...replacement.listing, artwork: mapping } }],
        [{ ...record, mapping }],
      ),
    /independent source evidence/u,
  );
});

void test("resume keeps the same workset and refuses stale, foreign or completed checkpoints", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cover-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpoint = path.join(root, "batch");
  const scope = { source_commit: "source", validator_sha256: validator, subjects: ["example"] };
  await assert.rejects(
    withCoverReviewCheckpoint(checkpoint, scope, async () => {
      throw new Error("temporary provider failure");
    }),
    /temporary provider/u,
  );
  for (const different of [
    { ...scope, source_commit: "stale" },
    { ...scope, validator_sha256: "other" },
    { ...scope, subjects: ["foreign"] },
  ]) {
    await assert.rejects(
      withCoverReviewCheckpoint(checkpoint, different, async () => assert.fail()),
      /foreign, stale/u,
    );
  }
  await withCoverReviewCheckpoint(checkpoint, scope, async (workset) => {
    assert.equal(workset, path.join(checkpoint, "preparation"));
    writeFileSync(path.join(checkpoint, "cover-replacement-review-completed.json"), "{}");
  });
  await assert.rejects(
    withCoverReviewCheckpoint(checkpoint, scope, async () => assert.fail()),
    /already completed/u,
  );
  await assert.rejects(
    withCoverReviewCheckpoint(root, scope, async () => assert.fail()),
    /foreign/u,
  );
});

void test(
  "resume reclaims both checkpoint locks after forced process death",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "cover-review-killed-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, "batch");
    const scope = { source_commit: "source", validator_sha256: validator, subjects: ["example"] };
    const program = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { withCoverReviewCheckpoint } from ${JSON.stringify(new URL("./catalog-cover-replacement-review.mts", import.meta.url).href)};
    import { acquireCheckpointProcessLock } from ${JSON.stringify(new URL("./process-lock.mts", import.meta.url).href)};
    await withCoverReviewCheckpoint(process.argv[1], JSON.parse(process.argv[2]), async (workset, lockScope) => {
      mkdirSync(workset);
      await acquireCheckpointProcessLock(path.join(workset, "active.lock"), lockScope);
      writeFileSync(path.join(workset, "retained-test-observation.json"), "{}");
      console.log("ready");
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      program,
      output,
      JSON.stringify(scope),
    ]);
    const closed = once(child, "close");
    t.after(() => child.kill("SIGKILL"));
    const ready = await Promise.race([
      new Promise<unknown>((resolve) => child.stdout.once("data", resolve)),
      closed.then(([code, signal]) =>
        assert.fail(`Preparation child exited before checkpoint: ${code ?? signal}`),
      ),
    ]);
    assert.equal(String(ready).trim(), "ready");
    await assert.rejects(
      withCoverReviewCheckpoint(output, scope, async () => assert.fail()),
      /already owned/u,
    );
    assert.equal(child.kill("SIGKILL"), true);
    await closed;
    await withCoverReviewCheckpoint(output, scope, async (workset, lockScope) => {
      const active = path.join(workset, "active.lock");
      const ownerFile = path.join(active, "owner.json");
      const validOwner = readFileSync(ownerFile, "utf8");
      const malformedOwner = validOwner.replace(/:[1-9][0-9]*"(?=,?\s*\})/u, ':invalid"');
      assert.notEqual(malformedOwner, validOwner);
      writeFileSync(ownerFile, malformedOwner);
      await assert.rejects(
        acquireCheckpointProcessLock(active, lockScope),
        /without quiescence proof/u,
      );
      assert.equal(readFileSync(ownerFile, "utf8"), malformedOwner);
      writeFileSync(ownerFile, validOwner);
      const lock = await acquireCheckpointProcessLock(active, lockScope);
      assert.equal(
        readFileSync(path.join(workset, "retained-test-observation.json"), "utf8"),
        "{}",
      );
      await lock.release();
    });
    await withCoverReviewCheckpoint(output, scope, async (workset, lockScope) => {
      const anonymous = path.join(workset, "active.lock");
      mkdirSync(anonymous);
      await assert.rejects(acquireCheckpointProcessLock(anonymous, lockScope), /unreadable/u);
    });
  },
);

void test("protected cover approval binds the review packet, actual source, preimage and decoded bytes", async () => {
  const canonicalPath = fileURLToPath(
    new URL("../crates/portcove-core/catalog/listings.json", import.meta.url),
  );
  const authored = readCatalogSource(path.dirname(canonicalPath));
  const record = authored.records.find(
    ({ listing }) => listing.id === "mortal-kombat-4-recompiled",
  )!;
  const sourceRow = authored.directory.listings.find(
    (listing) => listing.id === record.listing.id,
  )!;
  const original = record.listing.artwork;
  assert.ok(validArtworkMapping(original));
  const candidate = {
    ...original,
    cover_id: original.cover_id + 10_000,
    image_id: "rehearsalcover",
    image_sha256: "8".repeat(64),
  };
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.dirname(canonicalPath),
    encoding: "utf8",
    timeout: 10000,
  }).trim();
  const content = {
    bytes: 12345,
    format: "jpeg",
    height: 352,
    width: 264,
    sha256: candidate.image_sha256,
  };
  const packet = JSON.stringify({
    format_version: 1,
    rule: "same-original-game-cover-review-v1",
    authority: "none",
    state: "pending-independent-review",
    source_commit: source,
    authored_catalog_sha256: observationHash(authored.catalog),
    authored_listings_sha256: observationHash(authored.directory),
    selected_port_ids: [sourceRow.id],
    replacements: [
      {
        candidate,
        accepted_prior: original,
        prior: original,
        content,
        port_id: sourceRow.id,
        prior_record_sha256: observationHash(record),
        proposed_record_sha256: observationHash({
          ...record,
          listing: { ...record.listing, artwork: candidate },
        }),
        role: "cover",
        source: `https://www.igdb.com/games/${original.game_slug}`,
      },
    ],
  });
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/catalog-publish.yml@refs/heads/main",
    GITHUB_ACTOR_ID: "43177418",
    PORTCOVE_TRIGGERING_ACTOR: "boburning",
    GITHUB_RUN_ID: "42",
    PORTCOVE_COVER_REVIEW_PACKET: packet,
    PORTCOVE_COVER_REVIEW_SHA256: createHash("sha256").update(packet).digest("hex"),
    PORTCOVE_COVER_REVIEW_PREIMAGES: JSON.stringify({ [sourceRow.id]: original.image_sha256 }),
  };
  for (const override of [
    { GITHUB_ACTOR_ID: "1" },
    { PORTCOVE_TRIGGERING_ACTOR: "another-reviewer" },
    { GITHUB_REF: "refs/heads/topic" },
    { PORTCOVE_COVER_REVIEW_PACKET: `${packet} ` },
    { PORTCOVE_COVER_REVIEW_PACKET: undefined },
  ]) {
    assert.throws(() => protectedCoverApproval({ ...env, ...override }), /owner-approved/u);
  }
  assert.equal(protectedCoverApproval({}), undefined);
  const input = protectedCoverApproval(env)!;
  const previous = { listings: [sourceRow] };
  let requests = 0;
  const options = {
    input,
    previous,
    prior: readApprovedCoverJournal(undefined),
    canonical: authored.directory,
    compatibleCanonical: authored.directory,
    priorWasWithdrawn: () => false,
    catalogSha: observationHash(authored.catalog),
    canonicalSha: observationHash(authored.directory),
    canonicalPath,
    cli: "unused",
    scratch: "unused",
    inspectImage(image: string, byteLimit: number) {
      assert.equal(image, candidate.image_id);
      assert.equal(byteLimit, content.bytes);
      requests++;
      return Promise.resolve(content);
    },
  };
  const approved = await acceptApprovedCovers(options);
  assert.equal(requests, 1);
  assert.deepEqual(projectApprovedCovers(previous, approved).listings[0]?.artwork, candidate);
  assert.deepEqual(
    projectApprovedCovers(
      { listings: [{ ...sourceRow, original_game_title: "Changed subject" }] },
      approved,
    ).listings[0]?.artwork,
    original,
  );
  await assert.rejects(
    acceptApprovedCovers({ ...options, prior: approved }),
    /already been consumed/u,
  );
  await assert.rejects(
    acceptApprovedCovers({
      ...options,
      input: { ...input, preimages: JSON.stringify({ [sourceRow.id]: "c".repeat(64) }) },
    }),
    /authenticated preimage/u,
  );
  await assert.rejects(
    acceptApprovedCovers({ ...options, canonicalSha: "0".repeat(64) }),
    /current CI-green source/u,
  );
  await assert.rejects(
    acceptApprovedCovers({
      ...options,
      previous: { listings: [{ ...sourceRow, artwork: undefined }] },
    }),
    /authenticated preimage/u,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    acceptApprovedCovers({
      ...options,
      inspectImage: () => Promise.resolve({ ...content, bytes: content.bytes - 1 }),
    }),
    /verified CDN bytes/u,
  );

  // Ordinary health resolves B from the signed journal, even while tracked source
  // continues to declare A. A transient or different body supplies no transition.
  const now = Date.parse("2026-11-21T14:00:00Z");
  const fetchGone = createIgdbInspector(
    null,
    () => assert.fail("Gone has no body"),
    (url) => {
      assert.equal(
        url,
        `https://images.igdb.com/igdb/image/upload/t_cover_big/${candidate.image_id}.jpg`,
      );
      return Promise.resolve(new Response(null, { status: 410 }));
    },
  );
  const healthInput = { ...options, journal: approved, compatible: authored.directory, now };
  const b = projectApprovedCovers(previous, approved);
  const gone = await observeApprovedCoverHealth({
    ...healthInput,
    inspectImage: (image, maximum) => fetchGone.inspectImage(image, maximum),
  });
  assert.deepEqual(
    gone.observations.map(({ artwork, status }) => [artwork, status]),
    [[candidate, "propose_fallback"]],
  );
  const checkpoint = advanceArtworkCheckpoint(null, gone.observations);
  const fallback = checkpoint.apply(b.listings[0]!, sourceRow);
  assert.equal(fallback.artwork, undefined);
  const lastGood = Buffer.from('{"directory":{"listings":[]}}');
  const checkpointBytes = checkpoint.finish(lastGood)!;
  const mismatch = await observeApprovedCoverHealth({
    ...healthInput,
    now: now + 1000,
    inspectImage: () => Promise.resolve({ ...content, sha256: original.image_sha256 }),
  });
  assert.deepEqual(mismatch.observations, []);
  assert.equal(
    advanceArtworkCheckpoint(
      { bytes: checkpointBytes, listing: lastGood },
      mismatch.observations,
    ).apply(b.listings[0]!, sourceRow).artwork,
    undefined,
  );
  const restored = await observeApprovedCoverHealth({ ...healthInput, now: now + 2000 });
  assert.deepEqual(
    advanceArtworkCheckpoint(
      { bytes: checkpointBytes, listing: lastGood },
      restored.observations,
    ).apply(b.listings[0]!, sourceRow).artwork,
    candidate,
  );

  // Review C against signed effective B, keeping the original authored A
  // available for the stable identity and eligibility check.
  const third = {
    ...candidate,
    cover_id: candidate.cover_id + 1,
    image_id: "thirdcover",
    image_sha256: "9".repeat(64),
  };
  const thirdContent = { ...content, sha256: third.image_sha256 };
  const replacementRecord = { ...record, listing: { ...record.listing, artwork: third } };
  const thirdRows = reviewCoverReplacementBatch(
    [record],
    [replacementRecord],
    [sourceRow.id],
    [
      {
        port_id: sourceRow.id,
        role: "cover",
        reason: "exact-original-game-cover",
        mapping: third,
        checks: {
          identity: {
            kind: original.match_kind,
            game_id: original.game_id,
            slug: original.game_slug,
            evidence_url: `https://www.igdb.com/games/${original.game_slug}`,
          },
          content: {
            ...thirdContent,
            validator: "portcove-core",
            validator_artifact_sha256: validator,
          },
        },
      },
    ],
    validator,
    new Map([[sourceRow.id, candidate]]),
  );
  assert.deepEqual(thirdRows[0]?.prior, original);
  assert.deepEqual(thirdRows[0]?.accepted_prior, candidate);
  const nextPacket = JSON.stringify({
    ...(JSON.parse(packet) as object),
    signed_prior_repository_sha256: "b".repeat(64),
    replacements: thirdRows,
  });
  const nextInput = protectedCoverApproval({
    ...env,
    GITHUB_RUN_ID: "43",
    PORTCOVE_COVER_REVIEW_PACKET: nextPacket,
    PORTCOVE_COVER_REVIEW_SHA256: createHash("sha256").update(nextPacket).digest("hex"),
    PORTCOVE_COVER_REVIEW_PREIMAGES: JSON.stringify({ [sourceRow.id]: candidate.image_sha256 }),
  })!;
  const nextOptions = {
    ...options,
    input: nextInput,
    prior: approved,
    previous: { listings: [fallback] },
    priorWasWithdrawn: () => true,
    inspectImage: () => Promise.resolve(thirdContent),
  };
  await assert.rejects(
    acceptApprovedCovers({ ...nextOptions, previous }),
    /authenticated preimage/u,
  );
  const acceptedC = await acceptApprovedCovers(nextOptions);
  assert.deepEqual(acceptedC.consumed_packets, [input.digest, nextInput.digest]);
  assert.deepEqual(projectApprovedCovers(previous, acceptedC).listings[0]?.artwork, third);
  const noResurrection = advanceArtworkCheckpoint(
    { bytes: checkpointBytes, listing: lastGood },
    restored.observations,
  );
  assert.deepEqual(
    noResurrection.apply(projectApprovedCovers(previous, acceptedC).listings[0]!, sourceRow)
      .artwork,
    third,
  );
});
