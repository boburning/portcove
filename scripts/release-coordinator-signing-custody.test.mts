import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";

void test("signing composition freezes namespace, API, guard and opaque custody before awaited validation", async (t) => {
  const f = await remoteFixture(t),
    proof = checkpointProofFixture(f.checkpoint, f.config);
  const originalCustody: Readonly<{ inert: string }> = Object.freeze({
    inert: "original-private-receipt-seam",
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    guards = 0,
    wrong = 0;
  t.mock.module("./release-hosted-native-acceptance.mts", {
    namedExports: {
      async requirePreparedHostedNativeCustody(receipt: object) {
        assert.equal(receipt, originalCustody);
        if (++calls === 1) {
          await waiting;
          return { deadline: performance.now() + 60000, assertCurrent() {} };
        }
        throw new Error("inert stop after owned intent; no SDK POST");
      },
    },
  });
  const { signAndPublishCoordinatorCheckpoint } =
    await import("./release-coordinator-signing-exchange.mts");
  const configuration = structuredClone(f.config);
  const api: CoordinatorRemoteApi = {
    request: f.api.request.bind(f.api),
    graphql(query, variables) {
      if (!query.startsWith("mutation")) {
        const result = f.api.graphql(query, variables);
        if (query.includes('repository(owner:"boburning",name:"portcove")')) {
          assert.ok(isRecord(result.data));
          return { data: { repository: result.data.node } };
        }
        return result;
      }
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
  const options = {
    api,
    nativeCustody: originalCustody,
    async refresh() {
      guards++;
    },
  };
  const pending = signAndPublishCoordinatorCheckpoint(
    f.repository,
    f.bare,
    f.saved.checkpoint,
    configuration,
    { role: "coordinator", producer: proof.producer },
    performance.now() + 60000,
    options,
  );
  configuration.namespace = "not-an-authorized-namespace";
  options.api = {
    request() {
      wrong++;
      throw new Error("changed API");
    },
    graphql() {
      wrong++;
      throw new Error("changed API");
    },
  };
  options.nativeCustody = Object.freeze({ inert: "changed" });
  options.refresh = async () => {
    wrong++;
    throw new Error("changed guard");
  };
  release();
  await assert.rejects(pending, /signing exchange stopped/);
  assert.equal(calls, 2);
  assert.ok(guards > 0);
  assert.equal(wrong, 0);
  assert.equal(
    f.refs.get(`refs/tags/${f.config.namespace}-checkpoint-intent/${f.checkpoint.previous}`),
    f.saved.checkpoint,
  );
  assert.equal(f.refs.get(f.stateRef), f.checkpoint.previous);
});
