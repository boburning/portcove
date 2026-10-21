import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityExecutorIdentity,
  refreshCapacityExecutor,
  assertCapacityExecutorEffectScope,
  inspectCapacityExecutorSubject,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import { metadataFixture, metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
void test("only the site executor may retain its archive and bind an exact Pages expectation", () => {
  const destination = "github-actions:boburning/portcove:complete-site-artifact";
  assert.doesNotThrow(() =>
    assertCapacityExecutorEffectScope("site-publication", { kind: "upload", destination }),
  );
  for (const role of [
    "coordinator",
    "payload-signing",
    "release-publication",
    "tuf-releases",
  ] as const)
    assert.throws(() => assertCapacityExecutorEffectScope(role, { kind: "upload", destination }));
  const site_expectation = {
    archive_sha256: "1".repeat(64),
    artifact_id: 123,
    prior_site_generation_sha256: "2".repeat(64),
    repository_sha256: "3".repeat(64),
    root_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  assert.doesNotThrow(() =>
    assertCapacityExecutorEffectScope("site-publication", {
      kind: "upload",
      destination: "github-pages:boburning/portcove:complete-site",
      site_expectation,
    }),
  );
  assert.throws(() =>
    assertCapacityExecutorEffectScope("site-publication", {
      kind: "upload",
      destination,
      site_expectation,
    }),
  );
  assert.throws(() =>
    assertCapacityExecutorEffectScope("payload-signing", {
      kind: "upload",
      destination: "github-pages:boburning/portcove:complete-site",
      site_expectation,
    }),
  );
});

void test("only the fixed publisher can persist its immutable result under the existing pending journal", () => {
  const destination = "github-actions:boburning/portcove:0.1.0-beta.1:immutable-release-result";
  assert.doesNotThrow(() =>
    assertCapacityExecutorEffectScope("release-publication", { kind: "upload", destination }),
  );
  for (const role of [
    "payload-signing",
    "coordinator",
    "site-publication",
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
  ] as const)
    assert.throws(
      () => assertCapacityExecutorEffectScope(role, { kind: "upload", destination }),
      /fixed scope/,
    );
  for (const request of [
    { kind: "dispatch" as const, destination },
    { kind: "retention" as const, destination },
    { kind: "upload" as const, destination: destination + ":retry" },
    { kind: "upload" as const, destination: destination.replace("boburning", "other-owner") },
  ])
    assert.throws(
      () => assertCapacityExecutorEffectScope("release-publication", request),
      /fixed scope/,
    );
});

void test("only the fixed publisher can persist its immutable result under the existing pending journal", () => {
  const destination = "github-actions:boburning/portcove:0.1.0-beta.1:immutable-release-result";
  assert.doesNotThrow(() =>
    assertCapacityExecutorEffectScope("release-publication", { kind: "upload", destination }),
  );
  for (const role of [
    "payload-signing",
    "coordinator",
    "site-publication",
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
  ] as const)
    assert.throws(
      () => assertCapacityExecutorEffectScope(role, { kind: "upload", destination }),
      /fixed scope/,
    );
  for (const request of [
    { kind: "dispatch" as const, destination },
    { kind: "retention" as const, destination },
    { kind: "upload" as const, destination: destination + ":retry" },
    { kind: "upload" as const, destination: destination.replace("boburning", "other-owner") },
  ])
    assert.throws(
      () => assertCapacityExecutorEffectScope("release-publication", request),
      /fixed scope/,
    );
});

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
  const contextDestination =
    "github-actions:boburning/portcove:0.1.0-beta.1:payload-signing-context";
  assert.doesNotThrow(() =>
    assertCapacityExecutorEffectScope("payload-signing", {
      kind: "upload",
      destination: contextDestination,
    }),
  );
  for (const role of [
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
    "coordinator",
    "release-publication",
    "site-publication",
  ] as const)
    assert.throws(
      () =>
        assertCapacityExecutorEffectScope(role, {
          kind: "upload",
          destination: contextDestination,
        }),
      /fixed scope/,
    );
  assert.throws(
    () =>
      assertCapacityExecutorEffectScope("payload-signing", {
        kind: "upload",
        destination: contextDestination + ":2",
      }),
    /fixed scope/,
  );
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
void test("bootstrap and renewal route distinct explicit subjects through only their existing fixed roles", () => {
  const bootstrap = metadataBootstrapFixture().descriptor,
    renewal = metadataFixture().descriptor;
  for (const role of [
    "coordinator",
    "site-publication",
    "tuf-releases",
    "tuf-preview",
    "tuf-stable",
    "tuf-snapshot",
    "tuf-timestamp",
  ] as const) {
    const request = {
      kind: "upload" as const,
      destination:
        role === "coordinator"
          ? "github-actions:boburning/portcove:metadata-bootstrap-context"
          : role === "site-publication"
            ? "github-pages:boburning/portcove:complete-site"
            : `github-actions:boburning/portcove:metadata-bootstrap:${role}-envelope`,
    };
    assert.doesNotThrow(() => assertCapacityExecutorEffectScope(role, request));
    assert.equal(
      inspectCapacityExecutorSubject(role, { request, metadata_bootstrap: bootstrap }).kind,
      "metadata-bootstrap",
    );
    assert.throws(
      () =>
        inspectCapacityExecutorSubject(role, {
          request,
          metadata_bootstrap: bootstrap,
          metadata_renewal: renewal,
        }),
      /one metadata/u,
    );
    assert.throws(() =>
      inspectCapacityExecutorSubject(role, { request, metadata_bootstrap: renewal }),
    );
    const renewalRequest =
      role === "coordinator"
        ? { ...request, destination: "github-actions:boburning/portcove:metadata-renewal-context" }
        : request;
    assert.equal(
      inspectCapacityExecutorSubject(role, { request: renewalRequest, metadata_renewal: renewal })
        .kind,
      "metadata-renewal",
    );
  }
  const contextRequest = {
    kind: "upload" as const,
    destination: "github-actions:boburning/portcove:metadata-bootstrap-context",
  };
  assert.throws(
    () => inspectCapacityExecutorSubject("coordinator", { request: contextRequest }),
    /explicit/u,
  );
  assert.throws(
    () =>
      inspectCapacityExecutorSubject("coordinator", {
        request: contextRequest,
        metadata_renewal: renewal,
      }),
    /own exact/u,
  );
  for (const role of ["payload-signing", "release-publication"] as const) {
    assert.throws(
      () =>
        inspectCapacityExecutorSubject(role, {
          request: contextRequest,
          metadata_bootstrap: bootstrap,
        }),
      /fixed coordinator/u,
    );
    assert.throws(() => assertCapacityExecutorEffectScope(role, contextRequest), /fixed scope/u);
  }
  assert.equal(
    inspectCapacityExecutorSubject("coordinator", {
      request: {
        kind: "dispatch",
        destination: "github-actions:boburning/portcove:release.yml:dispatch",
      },
    }).kind,
    "candidate",
  );
});
