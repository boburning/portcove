import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireCheckpointProcessLock } from "./process-lock.mts";
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
