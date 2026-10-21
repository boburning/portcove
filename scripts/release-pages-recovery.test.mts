import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import {
  inspectPendingPagesReadback,
  readPendingPagesPublication,
} from "./release-pages-recovery.mts";

function operation() {
  const capacity = capacityFixture();
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate: {
      source_commit: "b".repeat(40),
      prepared_commit: "c".repeat(40),
      version: "0.1.0-beta.1",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "github-pages:boburning/portcove:complete-site",
    kind: "upload",
    sequence: 1,
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: capacityDigest(capacity.ratification),
    executor_nonce: "e".repeat(64),
    receipt_limit: 1,
    executor_identity: {
      controller_revision: "a".repeat(40),
      execution_ref: "refs/tags/controller-v1",
      workflow: ".github/workflows/controller.yml",
      run_id: "123",
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
      actor_id: "43177418",
      role: "site-publication",
    },
    site_expectation: {
      archive_sha256: "1".repeat(64),
      artifact_id: 123,
      prior_site_generation_sha256: "2".repeat(64),
      repository_sha256: "3".repeat(64),
      root_sha256: "4".repeat(64),
      site_generation_sha256: "5".repeat(64),
    },
  };
  return {
    ...identity,
    id: capacityDigest(identity),
    outcome: "pending",
    completed_effects: [] as { remote_identity: string; evidence_sha256: string }[],
    failure_evidence: null,
    recovery: null,
  };
}
const response = (body: unknown, status = 200) => ({
  body,
  status,
  headers: new Map<string, string>(),
});

void test("lost Pages acknowledgement resolves only by exact generation GET/public bytes/GET without POST", async () => {
  const pending = operation(),
    calls: string[] = [];
  const provider = createPagesProviderTransport(".", {
    api: {
      request(method, endpoint) {
        calls.push(method + " " + endpoint);
        return response({ status: "succeed" });
      },
    },
  });
  const observed = await readPendingPagesPublication(".", pending, performance.now() + 1000, {
    provider,
    readPublic: async (expected) => {
      calls.push("public " + expected.site_generation_sha256);
      assert.deepEqual(expected, pending.site_expectation);
      return { complete: true };
    },
  });
  const route =
    "GET repos/boburning/portcove/pages/deployments/" +
    pending.site_expectation.site_generation_sha256;
  assert.deepEqual(calls, [
    route,
    "public " + pending.site_expectation.site_generation_sha256,
    route,
  ]);
  assert.equal(observed.resolution.resolution, "effect-completed");
  assert.equal(
    observed.resolution.completed_effect?.remote_identity,
    "github-pages:boburning/portcove:" + pending.site_expectation.site_generation_sha256,
  );
  assert.equal(observed.evidence.evidence_scope, "injected-provider");
  assert.equal(observed.evidence.provider_mutations, 0);
});
void test("missing/failed/pending status and changing provider or public bytes never infer no effect", async () => {
  for (const status of ["missing", "failed", "deployment_in_progress", "drift", "public-drift"]) {
    let reads = 0,
      publicReads = 0;
    const provider = createPagesProviderTransport(".", {
      api: {
        request(method) {
          assert.equal(method, "GET");
          reads++;
          return response(
            {
              status:
                status === "drift" && reads === 2
                  ? "failed"
                  : status === "drift" || status === "public-drift"
                    ? "succeed"
                    : status,
            },
            status === "missing" ? 404 : 200,
          );
        },
      },
    });
    await assert.rejects(
      readPendingPagesPublication(".", operation(), performance.now() + 1000, {
        provider,
        readPublic: async () => {
          publicReads++;
          if (status === "public-drift") throw Error("public bytes differ");
          return {};
        },
      }),
    );
    assert.equal(publicReads, status === "drift" || status === "public-drift" ? 1 : 0);
  }
});
void test("retained completed receipt cannot be replaced and malformed/expired intent makes zero reads", async () => {
  const pending = operation();
  pending.completed_effects = [
    {
      remote_identity:
        "github-pages:boburning/portcove:" + pending.site_expectation.site_generation_sha256,
      evidence_sha256: "9".repeat(64),
    },
  ];
  const provider = createPagesProviderTransport(".", {
    api: {
      request() {
        return response({ status: "succeed" });
      },
    },
  });
  const observed = await readPendingPagesPublication(".", pending, performance.now() + 1000, {
    provider,
    readPublic: async () => ({}),
  });
  assert.equal(observed.resolution.completed_effect, undefined);
  assert.equal(pending.completed_effects[0]!.evidence_sha256, "9".repeat(64));
  assert.throws(() =>
    inspectPendingPagesReadback({
      ...pending,
      completed_effects: [{ ...pending.completed_effects[0], remote_identity: "wrong" }],
    }),
  );
  await assert.rejects(
    readPendingPagesPublication(".", operation(), 0, {
      provider,
      readPublic: async () => {
        throw Error("not called");
      },
    }),
    /deadline/,
  );
});
