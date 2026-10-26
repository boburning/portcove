import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityExecutorIdentity,
  inspectSelectedJournalRequirement,
  refreshCapacityExecutor,
  assertCapacityExecutorEffectScope,
  inspectCapacityExecutorSubject,
  executeOwnedCapacityEffect,
  createOwnedCheckpointSigningApi,
  authenticateOwnedCheckpointJournalHistory,
  publishOwnedSignedCoordinatorCheckpoint,
  prepareOwnedNativeCandidateCheckpoint,
  ensureOwnedCheckpointJournalHistory,
} from "./release-capacity-executor.mts";
import { metadataFixture, metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";

void test("imported sessions and custody cannot bind or reserve native checkpoint execution", async () => {
  const imported = Object.freeze({ kind: "authenticated-capacity-executor" as const });
  await assert.rejects(
    prepareOwnedNativeCandidateCheckpoint(imported, "unused", "a".repeat(40), {}, async () => {
      assert.fail("imported session cannot enter native controls");
    }),
    /actual unused native/,
  );
  await assert.rejects(
    ensureOwnedCheckpointJournalHistory(imported, "unused", "a".repeat(40), async () => {
      assert.fail("imported session cannot select a journal");
    }),
    /actual executor/,
  );
});

void test("selected journal refusal discriminator preserves current purpose and rejects malformed downgrade", async (t) => {
  const run = inspectSelectedJournalRequirement;
  for (const catalog of ['{"schema_version":3}', "malformed unused catalog"]) {
    await t.test(`default application ignores ${catalog}`, () =>
      assert.equal(
        run({
          PORTCOVE_RELEASE_AUTHORITIES: '{"schema_version":1}',
          PORTCOVE_CATALOG_AUTHORITIES: catalog,
        }),
        false,
      ),
    );
  }
  await t.test("catalog ignores unrelated application configuration", () =>
    assert.equal(
      run({
        PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
        PORTCOVE_CATALOG_AUTHORITIES:
          '{"schema_version":1,"kind":"catalog-publication-authorities"}',
        PORTCOVE_RELEASE_AUTHORITIES: "malformed unused application",
      }),
      false,
    ),
  );
  await t.test("application cannot use the legacy catalog discriminator", () =>
    assert.throws(() =>
      run({
        PORTCOVE_EXECUTION_PURPOSE: "application",
        PORTCOVE_RELEASE_AUTHORITIES:
          '{"schema_version":1,"kind":"catalog-publication-authorities"}',
      }),
    ),
  );
  await t.test("catalog cannot use an application-only legacy discriminator", () =>
    assert.throws(() =>
      run({
        PORTCOVE_EXECUTION_PURPOSE: "catalog-publication",
        PORTCOVE_CATALOG_AUTHORITIES: '{"schema_version":2}',
      }),
    ),
  );
  await t.test("unknown purpose refuses", () =>
    assert.throws(
      () =>
        run({
          PORTCOVE_EXECUTION_PURPOSE: "unknown",
          PORTCOVE_RELEASE_AUTHORITIES: '{"schema_version":1}',
        }),
      /publication purpose/,
    ),
  );
  for (const raw of [
    "null",
    "[]",
    '"text"',
    "{}",
    '{"schema_version":4}',
    '{"schema_version":1,"kind":"unknown"}',
  ])
    await t.test(`malformed selected record ${raw} refuses`, () =>
      assert.throws(() => run({ PORTCOVE_RELEASE_AUTHORITIES: raw })),
    );
  await t.test("absent selected record remains legacy", () => assert.equal(run({}), false));
  for (const raw of ['{"schema_version":3}', '{"kind":"two-app-fixed-jobs-v1"}'])
    await t.test(`selected marker ${raw} requires binding`, () =>
      assert.equal(run({ PORTCOVE_RELEASE_AUTHORITIES: raw }), true),
    );
});
void test("catalog effects require explicit catalog subject and independently appointed matching role", async () => {
  const catalog_publication = catalogPublicationFixture();
  for (const name of ["definitions", "policy", "snapshot", "timestamp"] as const) {
    const role = `catalog-${name}` as const;
    const request = {
      kind: "upload" as const,
      destination: `github-actions:boburning/portcove:catalog-tuf-role-${name}`,
    };
    assert.equal(
      inspectCapacityExecutorSubject(role, { request, catalog_publication }).kind,
      "catalog-publication",
    );
    assert.throws(() => inspectCapacityExecutorSubject(role, { request }), /explicit catalog/);
    assert.throws(() =>
      inspectCapacityExecutorSubject(role, {
        request,
        catalog_publication,
        metadata_bootstrap: {},
      }),
    );
    assert.throws(() =>
      assertCapacityExecutorEffectScope(role, {
        ...request,
        destination: request.destination + "-other",
      }),
    );
    assert.throws(() =>
      inspectCapacityExecutorSubject("payload-signing", { request, catalog_publication }),
    );
  }
  const context = {
    kind: "upload" as const,
    destination: "github-actions:boburning/portcove:catalog-publication-context",
  };
  assert.equal(
    inspectCapacityExecutorSubject("coordinator", { request: context, catalog_publication }).kind,
    "catalog-publication",
  );
  assert.throws(() => inspectCapacityExecutorSubject("coordinator", { request: context }));
  const request = {
    kind: "upload" as const,
    destination: "github-pages:boburning/portcove:complete-site",
    catalog_site_expectation: {
      artifact_id: 1,
      archive_sha256: "1".repeat(64),
      catalog_root_sha256: "7".repeat(64),
      catalog_repository_sha256: "2".repeat(64),
      application_root_sha256: null,
      prior_site_generation_sha256: null,
      site_generation_sha256: "3".repeat(64),
    },
  };
  assert.equal(
    inspectCapacityExecutorSubject("site-publication", { request, catalog_publication }).kind,
    "catalog-publication",
  );
  assert.throws(
    () => inspectCapacityExecutorSubject("site-publication", { request }),
    /explicit catalog/,
  );
  assert.throws(() => assertCapacityExecutorEffectScope("catalog-snapshot", request));
  let ran = false;
  await assert.rejects(
    executeOwnedCapacityEffect(
      { kind: "authenticated-capacity-executor" },
      {
        repository: "unused",
        checkpoint: "a".repeat(40),
        remote_configuration: {},
        request,
        catalog_publication,
      },
      async () => ({}),
      async () => {
        ran = true;
        return { remote_identity: "unused", evidence_sha256: "b".repeat(64) };
      },
    ),
    /actual authenticated/,
  );
  assert.equal(ran, false);
});
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

void test("serialized job claims or a copied kind cannot create an executor session", async () => {
  const imported = Object.freeze({ kind: "authenticated-capacity-executor" as const });
  assert.throws(() => capacityExecutorIdentity(imported), /actual fresh executor/u);
  await assert.rejects(refreshCapacityExecutor(imported), /imported executor/u);
  await assert.rejects(
    authenticateOwnedCheckpointJournalHistory(imported, "unused", "a".repeat(40)),
    /actual bounded executor/,
  );
  await assert.rejects(
    publishOwnedSignedCoordinatorCheckpoint(imported, "unused", "a".repeat(40), () => {
      assert.fail("imported session cannot enter current controls");
    }),
  );
  await assert.rejects(
    createOwnedCheckpointSigningApi(imported, "unused", "a".repeat(40), {}),
    /actual executor/,
  );
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

async function recoveryProviderControl() {
  const { mock } = await import("node:test");
  const { performance } = await import("node:perf_hooks");
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const githubUrl = new URL("./github-api.mts", process.argv[1]).href;
  const github = (await import(githubUrl)) as typeof import("./github-api.mts");
  let now = 10,
    delay = 0,
    gets = 0;
  const timeouts: number[] = [];
  mock.module(githubUrl, {
    exports: {
      ...github,
      createGitHubRunner(settings: { timeoutMs: number }) {
        timeouts.push(settings.timeoutMs);
        return (args: readonly string[]) => {
          assert.ok(args.includes("github.com"));
          gets++;
          now += delay;
          return 'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n{"original":true}';
        };
      },
    },
  });
  mock.method(performance, "now", () => now);
  const executor = (await import(
    process.argv[1] + "?owned-timeout-control"
  )) as typeof import("./release-capacity-executor.mts");
  const api = executor.capacityRecoveryProviderApi({ directory: "private", deadline: 100 });
  const read = () => api.request("GET", "repos/boburning/portcove/actions/runs/123");
  assert.deepEqual(read().body, { original: true });
  now = 50;
  read();
  assert.deepEqual(timeouts, [90, 50]);
  now = 100;
  assert.throws(read, /deadline exhausted/);
  assert.equal(gets, 2);
  now = 95;
  delay = 6;
  assert.throws(read, /deadline exhausted/);
  assert.equal(gets, 3);
  assert.deepEqual(timeouts, [90, 50, 5]);
  assert.throws(
    () =>
      executor
        .capacityRecoveryProviderApi({ directory: "private", deadline: NaN })
        .request("GET", "unused"),
    /invalid/,
  );
  assert.equal(gets, 3);
  now = 1;
  delay = 0;
  executor.capacityRecoveryProviderApi({ directory: "private" }).request("GET", "unused");
  assert.equal(timeouts.at(-1), 15000);
}

void test("actual recovery provider transport caps each read to original session remaining and refuses late replies", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./release-capacity-executor.mts", import.meta.url),
    "utf8",
  );
  // The two private recovery paths must retain this deadline-bounded provider.
  assert.equal(source.split("const api = capacityRecoveryProviderApi(value);").length - 1, 2);

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `await (${recoveryProviderControl.toString()})();`,
      new URL("./release-capacity-executor.mts", import.meta.url).href,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

void test("actual executor applies the selected journal refusal before authentication", () => {
  const program = `
    import assert from 'node:assert/strict';
    const { authenticateCapacityExecutor } = await import(process.argv[1]);
    await assert.rejects(authenticateCapacityExecutor('coordinator', {}, 'unused'), /protected journal configuration schema differs/);
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      program,
      new URL("./release-capacity-executor.mts", import.meta.url).href,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        PORTCOVE_EXECUTION_PURPOSE: "application",
        PORTCOVE_RELEASE_AUTHORITIES: '{"schema_version":9}',
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
