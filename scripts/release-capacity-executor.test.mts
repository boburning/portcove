import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  assertCapacityExecutorEffectScope,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";

void test("serialized job claims or a copied kind cannot create an executor session", async () => {
  const imported = Object.freeze({ kind: "authenticated-capacity-executor" as const });
  assert.throws(() => capacityExecutorIdentity(imported), /actual fresh executor/u);
  await assert.rejects(refreshCapacityExecutor(imported), /imported executor/u);
  let entered = false;
  await assert.rejects(
    executeOwnedCapacityEffect(
      imported,
      {
        repository: "unused",
        checkpoint: "a".repeat(40),
        remote_configuration: {},
        request: {
          kind: "upload",
          destination: "github-actions:boburning/portcove:0.1.0-beta.1:payload-signatures",
        },
      },
      () => Promise.resolve(null),
      () => {
        entered = true;
        return Promise.resolve({ remote_identity: "unused", evidence_sha256: "b".repeat(64) });
      },
    ),
    /actual authenticated executor/u,
  );
  assert.equal(entered, false);
});

void test("signing executors can hand off only their own immutable output, never another role or publication", () => {
  const roles = [
    "payload-signing",
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
  ] as const;
  for (const role of roles) {
    const suffix = role === "payload-signing" ? "payload-signatures" : `${role}-envelope`;
    const destination = `github-actions:boburning/portcove:0.1.0-beta.1:${suffix}`;
    assert.doesNotThrow(() =>
      assertCapacityExecutorEffectScope(role, { kind: "upload", destination }),
    );
    for (const other of roles.filter((candidate) => candidate !== role))
      assert.throws(
        () => assertCapacityExecutorEffectScope(other, { kind: "upload", destination }),
        /fixed scope/u,
      );
    for (const invalid of [
      { kind: "dispatch" as const, destination },
      { kind: "retention" as const, destination },
      { kind: "upload" as const, destination: `${destination}:12345` },
      { kind: "upload" as const, destination: "github-pages:boburning/portcove:complete-site" },
      {
        kind: "upload" as const,
        destination: "github-release:boburning/portcove:0.1.0-beta.1:publish",
      },
      {
        kind: "upload" as const,
        destination: destination.replace("boburning/portcove", "attacker/portcove"),
      },
    ])
      assert.throws(() => assertCapacityExecutorEffectScope(role, invalid), /fixed scope/u);
  }
});
