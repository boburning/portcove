import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { CoordinatorRemoteError } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";

void test("synthetic native composition retains completed CAS but refuses return after shorter caller deadline", async (t) => {
  const f = await remoteFixture(t),
    proof = checkpointProofFixture(f.checkpoint, f.config);
  const originalSigner = await import("./release-coordinator-checkpoint-signing.mts");
  const originalAuthentication =
    await import("./release-coordinator-checkpoint-authentication.mts");
  const base = performance.now();
  let clock = base,
    mutations = 0,
    freshNativeChecks = 0;
  t.mock.method(performance, "now", () => clock);
  // Deliberately synthetic signer/authenticator seams: this tests the owning
  // composition's clock/effect accounting, never real native acceptance.
  t.mock.module("./release-hosted-native-acceptance.mts", {
    namedExports: {
      async requirePreparedHostedNativeCustody() {
        return {
          deadline: base + 60000,
          assertCurrent() {
            freshNativeChecks++;
            assert.ok(clock < base + 60000, "original native clocks remain live");
          },
        };
      },
    },
  });
  t.mock.module("./release-coordinator-checkpoint-signing.mts", {
    namedExports: {
      async signCoordinatorCheckpointEvidence(
        ...args: Parameters<typeof originalSigner.signCoordinatorCheckpointEvidence>
      ) {
        await args[5]?.beforePost?.("fulcio");
        await args[5]?.beforePost?.("rekor");
        return { evidence: proof.evidence };
      },
    },
  });
  t.mock.module("./release-coordinator-checkpoint-authentication.mts", {
    namedExports: {
      ...originalAuthentication,
      async authenticateCoordinatorCheckpointEvidence() {
        return Object.freeze({ inert: "synthetic-verifier" });
      },
      requireAuthenticatedCheckpointEvidence() {
        return proof.evidence;
      },
    },
  });
  const { signAndPublishCoordinatorCheckpoint } =
    await import("./release-coordinator-signing-exchange.mts");
  const api: CoordinatorRemoteApi = {
    request: f.api.request.bind(f.api),
    graphql(query, variables) {
      if (!query.startsWith("mutation")) {
        const result = f.api.graphql(query, variables);
        if (mutations === 2) clock = base + 31000;
        if (query.includes('repository(owner:"boburning",name:"portcove")')) {
          assert.ok(isRecord(result.data));
          return { data: { repository: result.data.node } };
        }
        return result;
      }
      mutations++;
      assert.ok(isRecord(variables.input) && Array.isArray(variables.input.refUpdates));
      for (const update of variables.input.refUpdates) {
        assert.ok(isRecord(update));
        assert.equal(f.refs.get(String(update.name)) ?? "0".repeat(40), update.beforeOid);
      }
      for (const update of variables.input.refUpdates) {
        assert.ok(isRecord(update));
        f.refs.set(String(update.name), String(update.afterOid));
      }
      return { data: { updateRefs: { clientMutationId: variables.input.clientMutationId } } };
    },
  };
  await assert.rejects(
    signAndPublishCoordinatorCheckpoint(
      f.repository,
      f.bare,
      f.saved.checkpoint,
      f.config,
      { role: "coordinator", producer: proof.producer },
      base + 30000,
      {
        api,
        async refresh() {},
        nativeCustody: Object.freeze({ inert: "synthetic-private-seam" }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.phase, "native-custody-return");
      assert.equal(error.evidence.automatic_retry, false);
      assert.ok(isRecord(error.evidence.result));
      assert.equal(error.evidence.result.checkpoint, f.saved.checkpoint);
      assert.equal(error.evidence.result.changed, true);
      return true;
    },
  );
  assert.equal(mutations, 2);
  assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
  assert.ok(freshNativeChecks > 0);
});
