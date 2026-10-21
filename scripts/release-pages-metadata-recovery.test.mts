import assert from "node:assert/strict";
import test from "node:test";
import { capacityDigest } from "./release-capacity.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import { pagesRecoveryOperationFixture } from "./fixtures/release-pages-recovery-fixture.mts";
import {
  inspectSettledPagesMetadataHandoff,
  publishedPagesMetadataFromCurrentFacts,
  recoverPublishedPagesMetadata,
} from "./release-pages-metadata-recovery.mts";

function fixture() {
  const metadata = metadataFixture();
  const pending = pagesRecoveryOperationFixture();
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...identity
  } = pending;
  const root = metadata.descriptor.root_sha256;
  assert(typeof root === "string");
  identity.site_expectation.root_sha256 = root;
  const operation = {
    ...identity,
    id: capacityDigest(identity),
    outcome: "recovered",
    completed_effects: [
      {
        remote_identity: `github-pages:boburning/portcove:${identity.site_expectation.site_generation_sha256}`,
        evidence_sha256: "f".repeat(64),
      },
    ],
    failure_evidence: null,
    recovery: {
      checkpoint: "a".repeat(40),
      evidence_sha256: "b".repeat(64),
      resolution: "effect-completed",
    },
  };
  const input = {
    controller: { capacity_attempt: { operation } },
    published_metadata: {
      ...metadata.published,
      repository_sha256: "9".repeat(64),
      publication: {
        ...metadata.published.publication,
        site_generation_sha256: operation.site_expectation.prior_site_generation_sha256,
      },
    },
  };
  return { input, operation, descriptor: metadata.descriptor };
}

void test("settled Pages handoff uses authenticated CURRENT facts, never unused next renewal facts", () => {
  const { input, descriptor } = fixture();
  const handoff = inspectSettledPagesMetadataHandoff(input)!;
  const published = publishedPagesMetadataFromCurrentFacts(descriptor, handoff);
  assert.deepEqual(published.versions, descriptor.current_versions);
  assert.deepEqual(published.expires, descriptor.current_expires);
  assert.notDeepEqual(published.versions, descriptor.next_versions);
  assert.notDeepEqual(published.expires, descriptor.next_expires);
  assert.equal(published.repository_sha256, descriptor.prior_repository_sha256);
  assert.equal(published.timestamp_sha256, descriptor.prior_timestamp_sha256);
  assert.equal(published.operation_id, handoff.operation.id);
  assert.deepEqual(published.publication, {
    ...handoff.effect,
    site_generation_sha256: handoff.expected.site_generation_sha256,
  });
  assert.equal(
    inspectSettledPagesMetadataHandoff({ ...input, published_metadata: published }),
    null,
  );
});

void test("settled selector refuses wrong old seed, receipt, current feed, and fabricated empty bootstrap", () => {
  const { input, descriptor } = fixture();
  const handoff = inspectSettledPagesMetadataHandoff(input)!;
  assert.throws(
    () =>
      inspectSettledPagesMetadataHandoff({
        ...input,
        published_metadata: {
          ...input.published_metadata,
          root_sha256: "0".repeat(64),
        },
      }),
    /exact old published seed/,
  );
  assert.throws(
    () =>
      inspectSettledPagesMetadataHandoff({
        ...input,
        published_metadata: {
          ...input.published_metadata,
          publication: {
            ...input.published_metadata.publication,
            site_generation_sha256: "0".repeat(64),
          },
        },
      }),
    /exact old published seed/,
  );
  const wrongReceipt = structuredClone(input);
  wrongReceipt.controller.capacity_attempt.operation.completed_effects[0]!.remote_identity +=
    "-other";
  assert.throws(() => inspectSettledPagesMetadataHandoff(wrongReceipt), /receipt differs/);
  for (const key of ["root_sha256", "prior_repository_sha256"] as const)
    assert.throws(
      () =>
        publishedPagesMetadataFromCurrentFacts({ ...descriptor, [key]: "0".repeat(64) }, handoff),
      /exact Pages intent/,
    );
  assert.throws(
    () => inspectSettledPagesMetadataHandoff({ ...input, published_metadata: null }),
    /bootstrap|schema/,
  );
  const pending = structuredClone(input);
  pending.controller.capacity_attempt.operation.outcome = "pending";
  pending.controller.capacity_attempt.operation.recovery = null as never;
  assert.equal(inspectSettledPagesMetadataHandoff(pending), null);
});

void test("copied tool/executor JSON cannot enter actual Pages metadata handoff", async () => {
  await assert.rejects(
    recoverPublishedPagesMetadata({} as never, {} as never, {}, "unused", NaN, async () => {}),
    /deadline/,
  );
  await assert.rejects(
    recoverPublishedPagesMetadata(
      {} as never,
      {} as never,
      {},
      "unused",
      performance.now() + 10000,
      async () => {},
    ),
    /actual|receipt|verified|tools/i,
  );
});
