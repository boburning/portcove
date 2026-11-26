import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { reviewCoverReplacementBatch } from "./catalog-cover-replacement-review.mts";
import { coverDeclarationScope } from "./listing-artwork-checkpoint.mts";
import { replacementCoverPreimages } from "./listing-observation-delivery.mts";

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

const declaration = {
  ...subject.listing,
  project_url: "https://example.invalid/original",
};

function predecessor(
  listing: Record<string, unknown>,
  state: "gone" | "restored" = "gone",
  withdrawn: string[] = [],
  scope = coverDeclarationScope(declaration, prior),
) {
  const signed = Buffer.from(
    JSON.stringify({
      listing_delivery_schema: 1,
      revision: 20,
      withdrawn_ids: withdrawn,
      directory: { format_version: 15, listings: [listing] },
    }),
  );
  const checkpoint = Buffer.from(
    JSON.stringify({
      checkpoint_schema: 1,
      listing_sha256: createHash("sha256").update(signed).digest("hex"),
      prior_checkpoint_sha256: null,
      entries: [
        {
          id: "example",
          scope,
          image_id: prior.image_id,
          prior_sha256: prior.image_sha256,
          observed_at: "2026-11-25T00:01:00.000Z",
          receipt: "sha256:" + "e".repeat(64),
          state,
        },
      ],
    }),
  );
  return [signed, checkpoint] as const;
}
const canonical = { format_version: 16, listings: [declaration] };
const withoutCover = { ...declaration, artwork: undefined };

void test("a matching signed cover or exact Gone entry establishes the preimage", () => {
  for (const pair of [predecessor(declaration, "restored"), predecessor(withoutCover)]) {
    assert.deepEqual(
      replacementCoverPreimages(canonical, ...pair, ["example"]),
      new Map([["example", prior]]),
    );
  }
});

void test("missing, foreign, restored, or withdrawn preimages cannot be reviewed", () => {
  for (const pair of [
    predecessor(withoutCover, "restored"),
    predecessor(declaration, "gone"),
    predecessor(withoutCover, "gone", [], "a".repeat(64)),
    predecessor(withoutCover, "gone", ["example"]),
    predecessor({ ...declaration, artwork: next }),
    predecessor({ ...declaration, project_url: "https://example.invalid/different" }),
  ]) {
    assert.throws(
      () => replacementCoverPreimages(canonical, ...pair, ["example"]),
      /authenticated preimage/u,
    );
  }
  const [otherListing] = predecessor(withoutCover);
  const [, oldCheckpoint] = predecessor(declaration, "restored");
  assert.throws(
    () => replacementCoverPreimages(canonical, otherListing, oldCheckpoint, ["example"]),
    /unbound/u,
  );
  assert.throws(
    () => replacementCoverPreimages(canonical, ...predecessor(declaration), ["example", "example"]),
    /unique/u,
  );
});
