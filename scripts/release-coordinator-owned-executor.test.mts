import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  capacityDigest,
  assessBoundedCapacity,
  inspectCapacityOperation,
} from "./release-capacity.mts";
import {
  runBoundedCapacityOperation,
  recordCapacityReadback,
  ProviderCapacityRefusal,
  runBoundedCatalogPublicationOperation,
} from "./release-capacity-operation.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  exportCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import { performance } from "node:perf_hooks";
import {
  checkpointProofFixture,
  fixedJobJournalAuthoritiesFixture,
  selectedPublicationAuthoritiesFixture,
} from "./fixtures/checkpoint-proof-fixture.mts";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
  recoverOwnedPublishedMetadata,
  recoverOwnedPublishedCatalogMetadata,
  recoverOwnedCapacityEffect,
  capacityExecutorIdentity,
  authenticateOwnedCheckpointJournalHistory,
  publishOwnedSignedCoordinatorCheckpoint,
} from "./release-capacity-executor.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
  jwk as identityJwk,
} from "./fixtures/assembler-identity-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { controllerOidcSubject, capacityExecutorJobProfile } from "./assembler-job-identity.mts";

import { remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";

async function selectedOwnedHistoryFixture(
  t: test.TestContext,
  captureDirectory?: string,
  bind = true,
  purpose: "application" | "catalog-publication" = "application",
  fullScope = false,
) {
  const f = await remoteFixture(t);
  const bare = path.join(f.repository, "selected-empty.git");
  execFileSync("git", ["init", "--bare", "--quiet", bare], { windowsHide: true, timeout: 10000 });
  const input = {
    ...f.input,
    schema_version: 2,
    active_candidate: null,
    publication: { ...f.input.publication, reserved_versions: [] },
    controller: {
      workflow: productionControllerWorkflow,
      revision: identityExpected.controller_revision,
      publication_paused: false,
      capacity_attempt: { ...capacityFixture(), schema_version: 2 },
    },
  };
  const seed = await checkpointReleaseOpportunity(bare, null, input);
  const checkpoint = await exportCoordinatorCheckpoint(bare, seed.checkpoint);
  const authorities = fixedJobJournalAuthoritiesFixture();
  authorities.journal_seed = {
    checkpoint: seed.checkpoint,
    state_sha256: createHash("sha256").update(checkpoint.blob.contents).digest("hex"),
  };
  const authorityRecord = fullScope
    ? { ...selectedPublicationAuthoritiesFixture(purpose), journal: authorities }
    : authorities;
  const expected = {
    ...identityExpected,
    run_attempt: 1,
    audience: "portcove-capacity-executor",
    subject: controllerOidcSubject(
      identityExpected.controller_ref,
      "production-release-coordinator",
    ),
  };
  const identity = assemblerIdentityFixture(
    {
      aud: expected.audience,
      sub: expected.subject,
      environment: "production-release-coordinator",
    },
    {},
    { ...capacityExecutorJobProfile("coordinator"), runAttempt: 1 },
  );
  const bytes = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
  );
  const policy = {
    schema_version: 2,
    mode: purpose === "application" ? "bounded-application-release" : "bounded-catalog-publication",
    revision: expected.controller_revision,
    execution_ref: expected.controller_ref,
    actor_id: expected.actor_id,
    authority_configuration_sha256: capacityDigest(authorityRecord),
    grant_sha256: "f".repeat(64),
    workflow_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const runtime: NodeJS.ProcessEnv = {
    GH_TOKEN: "inert-selected-job-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "inert-oidc-bearer",
    PORTCOVE_EXECUTION_PURPOSE: purpose,
    [purpose === "application" ? "PORTCOVE_RELEASE_AUTHORITIES" : "PORTCOVE_CATALOG_AUTHORITIES"]:
      JSON.stringify(authorityRecord),
    [purpose === "application"
      ? "PORTCOVE_CONTROLLER_ADMISSION"
      : "PORTCOVE_CATALOG_CONTROLLER_ADMISSION"]: JSON.stringify(policy),
    GITHUB_ACTIONS: "true",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: expected.controller_ref,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: expected.controller_revision,
    GITHUB_WORKFLOW_SHA: expected.controller_revision,
    GITHUB_WORKFLOW_REF: `boburning/portcove/${productionControllerWorkflow}@${expected.controller_ref}`,
    PORTCOVE_CONTROLLER_REVISION: expected.controller_revision,
    PORTCOVE_CONTROLLER_REF: expected.controller_ref,
    GITHUB_ACTOR_ID: expected.actor_id,
    GITHUB_ACTOR: "fixture-operator",
    GITHUB_TRIGGERING_ACTOR: "fixture-operator",
    GITHUB_RUN_ID: expected.run_id,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "coordinator",
    RUNNER_ENVIRONMENT: "github-hosted",
  };
  const before = new Map(Object.keys(runtime).map((key) => [key, process.env[key]]));
  Object.assign(process.env, runtime);
  const actualSpawn = childProcess.spawnSync;
  let heads = 0;
  t.after(() => {
    for (const [key, value] of before)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(globalThis, "fetch", async (raw: Parameters<typeof fetch>[0]) => {
    assert.ok(typeof raw === "string" || raw instanceof URL);
    const url = typeof raw === "string" ? raw : raw.href;
    if (url === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return new Response(JSON.stringify({ keys: [identityJwk] }));
    assert.equal(
      url,
      "https://fixture.actions.githubusercontent.com/oidc?audience=portcove-capacity-executor",
    );
    return new Response(JSON.stringify({ value: identity.token }));
  });
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      if (command !== "gh") return actualSpawn(command, args, options);
      if (args[1] !== "graphql") return identity.transport.spawn(command, args, options);
      heads++;
      assert.equal(options.env?.GH_TOKEN, "inert-selected-job-token");
      assert.equal(options.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.ok(typeof options.input === "string");
      const query: unknown = JSON.parse(options.input);
      assert.ok(
        isRecord(query) && typeof query.query === "string" && query.query.startsWith("query("),
      );
      return {
        status: 0,
        stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify({ data: { repository: { databaseId: 1354613114, nameWithOwner: "boburning/portcove", state: { prefix: "refs/heads/", name: "portcove-fixture-coordinator-state", target: { __typename: "Commit", oid: seed.checkpoint } }, intent: null } } })}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  const deadline = performance.now() + 60000;
  const session = await authenticateCapacityExecutor(
    "coordinator",
    expected,
    captureDirectory ?? f.repository,
    deadline,
  );
  if (bind) {
    const bound = await authenticateOwnedCheckpointJournalHistory(session, bare, seed.checkpoint);
    assert.equal(bound.history, "ratified-initial-seed");
    assert.equal(heads, 2);
  }
  return {
    session,
    bare,
    seed,
    deadline,
    heads: () => heads,
    fixture: f,
    seedInput: input,
    identity,
    expected,
  };
}

async function selectedEffectFixture(
  t: test.TestContext,
  purpose: "application" | "catalog-publication" = "application",
  applicationReservation = purpose === "application",
  fullScope = true,
) {
  const actualSpawn = childProcess.spawnSync;
  const custody = await mkdtemp(path.join(os.homedir(), ".portcove-owned-effect-test-"));
  t.after(() => rm(custody, { recursive: true, force: true }));
  const f = await selectedOwnedHistoryFixture(t, custody, true, purpose, fullScope);
  const oldFetch = globalThis.fetch;
  const sigstore = assemblerIdentityFixture(
    { aud: "sigstore", sub: f.expected.subject, environment: "production-release-coordinator" },
    {},
    { ...capacityExecutorJobProfile("coordinator"), runAttempt: 1 },
  );
  const proof = checkpointProofFixture(undefined, undefined, { run_attempt: 1 });
  const remote = f.fixture;
  remote.refs.clear();
  remote.refs.set(remote.stateRef, f.seed.checkpoint);
  const faults = { ambiguousFinal: false, originalTerminal: true, originalJobReads: 0 };
  const traffic = { calls: 0 };
  const posts: string[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  t.mock.method(
    globalThis,
    "fetch",
    async (raw: Parameters<typeof fetch>[0], settings?: RequestInit) => {
      traffic.calls++;
      const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
      if (url === "https://fixture.actions.githubusercontent.com/oidc?audience=sigstore")
        return json({ value: sigstore.token });
      if (url === "https://fulcio.sigstore.dev/api/v2/signingCert") {
        posts.push("fulcio");
        const body: unknown = JSON.parse(Buffer.from(settings?.body as Uint8Array).toString());
        assert.ok(isRecord(body) && isRecord(body.publicKeyRequest));
        const request = body.publicKeyRequest;
        assert.ok(isRecord(request.publicKey) && typeof request.publicKey.content === "string");
        assert.ok(typeof request.proofOfPossession === "string");
        assert.ok(
          verify(
            "sha256",
            Buffer.from(f.expected.subject),
            request.publicKey.content,
            Buffer.from(request.proofOfPossession, "base64"),
          ),
        );
        return json({
          signedCertificateEmbeddedSct: {
            chain: {
              certificates: [
                "-----BEGIN CERTIFICATE-----\naW5lcnQtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----",
              ],
            },
          },
        });
      }
      if (url === "https://rekor.sigstore.dev/api/v1/log/entries") {
        posts.push("rekor");
        const body: unknown = JSON.parse(Buffer.from(settings?.body as Uint8Array).toString());
        return json(
          {
            fixture: {
              body: Buffer.from(JSON.stringify(body)).toString("base64"),
              integratedTime: Math.floor(Date.now() / 1000),
              logID: "a".repeat(64),
              logIndex: 1,
              verification: { signedEntryTimestamp: "aW5lcnQ=" },
            },
          },
          201,
        );
      }
      return oldFetch(raw, settings);
    },
  );
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      if (command !== "gh") return actualSpawn(command, args, options);
      traffic.calls++;
      if (args[2]?.endsWith("/actions/jobs/502")) {
        faults.originalJobReads++;
        assert.equal(args[args.indexOf("--method") + 1], "GET");
        return {
          status: 0,
          stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify({
            id: 502,
            run_id: 9988,
            run_attempt: 1,
            head_sha: f.expected.controller_revision,
            status: faults.originalTerminal ? "completed" : "in_progress",
            conclusion: faults.originalTerminal ? "failure" : null,
            check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/778",
          })}`,
          stderr: "",
        };
      }
      if (args[0] === "attestation") {
        const bundle: unknown = JSON.parse(
          readFileSync(args[args.indexOf("--bundle") + 1]!, "utf8"),
        );
        assert.ok(
          isRecord(bundle) &&
            isRecord(bundle.dsseEnvelope) &&
            typeof bundle.dsseEnvelope.payload === "string",
        );
        const statement: unknown = JSON.parse(
          Buffer.from(bundle.dsseEnvelope.payload, "base64").toString(),
        );
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: { ...proof.verification, statement } }]),
          stderr: "",
        };
      }
      if (String(options.cwd).includes("checkpoint-verification-")) {
        const response = proof.api.request("GET", args[2]!);
        return {
          status: 0,
          stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify(response.body)}`,
          stderr: "",
        };
      }
      if (!String(options.env?.GH_CONFIG_DIR).includes("journal-api-"))
        return f.identity.transport.spawn(command, args, options);
      assert.equal(options.env?.GH_TOKEN, "inert-selected-job-token");
      assert.equal(options.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
      assert.ok(typeof options.input === "string" || options.input === undefined);
      const raw: unknown = options.input === undefined ? undefined : JSON.parse(options.input);
      let body: unknown,
        status = 200;
      if (args[1] !== "graphql") {
        const reply = remote.api.request(args[args.indexOf("--method") + 1]!, args[2]!, raw);
        body = reply.body;
        status = reply.status!;
      } else {
        assert.ok(isRecord(raw) && typeof raw.query === "string" && isRecord(raw.variables));
        const variables = raw.variables;
        if (raw.query.startsWith("mutation")) {
          assert.ok(isRecord(variables.input) && Array.isArray(variables.input.refUpdates));
          const input = variables.input;
          const updates = input.refUpdates;
          assert.ok(Array.isArray(updates));
          assert.equal(input.repositoryId, "R_fixture");
          for (const update of updates) {
            assert.ok(isRecord(update));
            assert.equal(update.force, false);
            assert.equal(remote.refs.get(String(update.name)) ?? "0".repeat(40), update.beforeOid);
          }
          for (const update of updates) {
            assert.ok(isRecord(update));
            if (!faults.ambiguousFinal || !String(update.name).includes("checkpoint-proof/"))
              remote.refs.set(String(update.name), String(update.afterOid));
          }
          if (faults.ambiguousFinal && updates.length > 2)
            throw new Error("partial final CAS response lost");
          body = { data: { updateRefs: { clientMutationId: input.clientMutationId } } };
        } else {
          const node: Record<string, unknown> = {
            __typename: "Repository",
            id: "R_fixture",
            databaseId: 1354613114,
            nameWithOwner: "boburning/portcove",
          };
          for (const [alias, name] of Object.entries(variables)) {
            if (typeof name !== "string" || !name.startsWith("refs/")) continue;
            const split = name.indexOf("/", 5) + 1,
              oid = remote.refs.get(name);
            node[alias] = oid
              ? {
                  name: name.slice(split),
                  prefix: name.slice(0, split),
                  target: { __typename: "Commit", oid },
                }
              : null;
          }
          body = { data: { [raw.query.includes("node(id:") ? "node" : "repository"]: node } };
        }
      }
      return {
        status: 0,
        stdout: `HTTP/2.0 ${status} Fixture\r\n\r\n${JSON.stringify(body)}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  execFileSync(
    "git",
    [
      "-C",
      f.bare,
      "fetch",
      "--no-tags",
      remote.repository,
      ...remote.checkpoint.required_commits.map((commit) => commit.oid),
      "refs/portcove/prepared-versions/*:refs/portcove/prepared-versions/*",
      "refs/portcove/prepared-commits/*:refs/portcove/prepared-commits/*",
    ],
    {
      windowsHide: true,
      timeout: 10000,
      stdio: "pipe",
    },
  );
  const reserved = await checkpointReleaseOpportunity(f.bare, f.seed.checkpoint, {
    ...remote.input,
    ...(!applicationReservation
      ? {
          active_candidate: null,
          publication: { ...remote.input.publication, reserved_versions: [] },
        }
      : {}),
    schema_version: 2,
    controller: f.seedInput.controller,
  });
  await publishOwnedSignedCoordinatorCheckpoint(
    f.session,
    f.bare,
    reserved.checkpoint,
    async () => {},
  );
  return { ...f, remote, reserved, faults, posts, traffic };
}

for (const route of ["operation", "application", "catalog"] as const) {
  void test(`selected ${route} recovery refuses missing history without legacy fallback`, async (t) => {
    const f = await selectedOwnedHistoryFixture(t, undefined, false);
    const old = process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
    process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-lingering-legacy-token";
    t.after(() => {
      if (old === undefined) delete process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
      else process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = old;
    });
    process.env.PORTCOVE_RELEASE_AUTHORITIES = '{"schema_version":1}';
    const input = {
      repository: f.bare,
      checkpoint: f.seed.checkpoint,
      remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
    };
    let readbacks = 0;
    const readback = async () => {
      readbacks++;
      return { resolution: "effect-not-applied" as const, evidence_sha256: "e".repeat(64) };
    };
    const work = () =>
      route === "operation"
        ? recoverOwnedCapacityEffect(f.session, input, readback)
        : route === "application"
          ? recoverOwnedPublishedMetadata(f.session, input, readback)
          : recoverOwnedPublishedCatalogMetadata(f.session, input, readback);
    await assert.rejects(work(), /exact bound journal/);
    assert.equal(readbacks, 0);
    assert.equal(f.heads(), 0);
    await assert.rejects(work(), /stopped/);
    await assert.rejects(
      authenticateOwnedCheckpointJournalHistory(f.session, f.bare, f.seed.checkpoint),
      /stopped/,
    );
  });
}

for (const recovery of [
  "effect-completed",
  "effect-not-applied",
  "partial-effects-retained",
  "original-live",
  "incomplete",
  "controls-hold",
  "ambiguous-settlement",
] as const) {
  void test(
    `selected explicit recovery ${recovery} preserves original effects without repeating them`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(t);
      // Retain an inert previous job's operation through the real selected journal.
      // The current coordinator is independently authenticated job501; job502 is
      // observed below, never reappointed by a supplied recovery receipt.
      const prior = { ...capacityExecutorIdentity(f.session), job_id: 502, check_run_id: "778" };
      let effects = 0;
      const receipt = {
        remote_identity: "provider:retained-original",
        evidence_sha256: "d".repeat(64),
      };
      await assert.rejects(
        runBoundedCapacityOperation(
          f.bare,
          f.reserved.checkpoint,
          {
            kind: "dispatch",
            destination: "github-actions:boburning/portcove:release.yml:dispatch",
          },
          async () => capacityFixture().boundary,
          async (record) => {
            effects++;
            if (recovery === "partial-effects-retained")
              await record(receipt.remote_identity, receipt.evidence_sha256);
            throw new Error("original provider response lost; retain exact attempt");
          },
          {
            executorIdentity: prior,
            maximumReceipts: 1,
            remote: {
              publish: (checkpoint) =>
                publishOwnedSignedCoordinatorCheckpoint(
                  f.session,
                  f.bare,
                  checkpoint,
                  async () => {},
                ),
            },
          },
        ),
        /read back before/,
      );
      const checkpoint = f.remote.refs.get(f.remote.stateRef)!;
      const before = await recoverReleaseOpportunity(f.bare, checkpoint);
      f.faults.originalTerminal = recovery !== "original-live";
      let readbacks = 0;
      const input = { repository: f.bare, checkpoint, remote_configuration: f.remote.config };
      const work = () =>
        recoverOwnedCapacityEffect(
          f.session,
          input,
          async () => {
            readbacks++;
            if (recovery === "ambiguous-settlement") f.faults.ambiguousFinal = true;
            return {
              resolution:
                recovery === "partial-effects-retained" || recovery === "effect-not-applied"
                  ? recovery
                  : "effect-completed",
              evidence_sha256: recovery === "incomplete" ? "invalid" : "e".repeat(64),
              ...(recovery === "effect-completed" || recovery === "ambiguous-settlement"
                ? { completed_effect: receipt }
                : {}),
            };
          },
          undefined,
          async () => {
            if (recovery === "controls-hold") throw new Error("actual recovery controls hold");
          },
        );
      if (
        ["original-live", "incomplete", "controls-hold", "ambiguous-settlement"].includes(recovery)
      ) {
        await assert.rejects(work());
        assert.equal(
          readbacks,
          recovery === "original-live" || recovery === "controls-hold" ? 0 : 1,
        );
        const calls = f.traffic.calls;
        await assert.rejects(work(), /stopped/);
        await assert.rejects(
          publishOwnedSignedCoordinatorCheckpoint(
            f.session,
            f.bare,
            f.remote.refs.get(f.remote.stateRef)!,
            async () => {},
          ),
          /stopped/,
        );
        assert.equal(f.traffic.calls, calls);
        if (recovery === "ambiguous-settlement") {
          const head = f.remote.refs.get(f.remote.stateRef)!;
          assert.notEqual(head, checkpoint, "partial remote settlement is retained, never reset");
          assert.equal(
            f.remote.refs.has(`refs/tags/portcove-fixture-checkpoint-proof/${head}`),
            false,
          );
          const retained = await recoverReleaseOpportunity(f.bare, head);
          assert.ok(
            isRecord(retained.input.controller) &&
              isRecord(retained.input.controller.capacity_attempt),
          );
          const operation = inspectCapacityOperation(
            retained.input.controller.capacity_attempt.operation,
          )!;
          assert.equal(operation.recovery?.resolution, "effect-completed");
          assert.deepEqual(operation.completed_effects, [receipt]);
          assert.deepEqual(retained.input.active_candidate, before.input.active_candidate);
        } else {
          const retained = await recoverReleaseOpportunity(f.bare, checkpoint);
          assert.deepEqual(retained.input, before.input);
        }
      } else {
        const result = await work();
        assert.equal(readbacks, 1);
        assert.equal(f.remote.refs.get(f.remote.stateRef), result.checkpoint);
        const retained = await recoverReleaseOpportunity(f.bare, result.checkpoint);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        const operation = inspectCapacityOperation(
          retained.input.controller.capacity_attempt.operation,
        )!;
        assert.equal(operation.recovery?.resolution, recovery);
        assert.ok(operation.recovery && isRecord(operation.recovery.executor_identity));
        assert.equal(operation.recovery.executor_identity.job_id, 501);
        assert.deepEqual(
          operation.completed_effects,
          recovery === "effect-not-applied" ? [] : [receipt],
        );
        assert.deepEqual(retained.input.active_candidate, before.input.active_candidate);
        const capacity = assessBoundedCapacity(retained.input.controller.capacity_attempt);
        assert.equal(capacity.availability, "unknown");
        assert.equal(capacity.headroom, "unknown");
      }
      assert.equal(effects, 1, "recovery never repeats the provider effect");
    },
  );
}

void test("selected source cannot fall back to a lingering App token before history binding", async (t) => {
  const f = await selectedOwnedHistoryFixture(t, undefined, false);
  const oldToken = process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-lingering-legacy-token";
  t.after(() => {
    if (oldToken === undefined) delete process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
    else process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = oldToken;
  });
  // Clearing the live record cannot downgrade the source selected at session creation.
  process.env.PORTCOVE_RELEASE_AUTHORITIES = '{"schema_version":1}';
  let effects = 0;
  await assert.rejects(
    executeOwnedCapacityEffect(
      f.session,
      {
        repository: f.bare,
        checkpoint: f.seed.checkpoint,
        remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
        request: {
          kind: "dispatch",
          destination: "github-actions:boburning/portcove:release.yml:dispatch",
        },
      },
      async () => capacityFixture().boundary,
      async () => {
        effects++;
        return { remote_identity: "must-not-run", evidence_sha256: "d".repeat(64) };
      },
    ),
    /selected effect requires its exact bound journal/,
  );
  assert.equal(effects, 0);
  assert.equal(f.heads(), 0, "no legacy journal request reached the provider");
  await assert.rejects(
    authenticateOwnedCheckpointJournalHistory(f.session, f.bare, f.seed.checkpoint),
    /stopped/,
  );
});

for (const component of ["application", "catalog"] as const) {
  void test(
    `selected ${component} metadata recovery atomically records its component and site cursor`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(
        t,
        component === "catalog" ? "catalog-publication" : "application",
        component === "application",
        true,
      );
      const metadata = metadataFixture();
      const descriptor = catalogPublicationFixture();
      const current = await recoverReleaseOpportunity(f.bare, f.reserved.checkpoint);
      const input = structuredClone(current.input);
      if (component === "catalog") {
        input.active_candidate = null;
        input.catalog_publication = descriptor;
      } else input.published_metadata = metadata.published;
      const initial = await checkpointReleaseOpportunity(f.bare, current.checkpoint, input);
      const remote = {
        publish: (checkpoint: string) =>
          publishOwnedSignedCoordinatorCheckpoint(f.session, f.bare, checkpoint, async () => {}),
      };
      await remote.publish(initial.checkpoint);
      const prior = {
        ...capacityExecutorIdentity(f.session),
        role: "site-publication",
        job_id: 502,
        check_run_id: "778",
      };
      const receipt = {
        remote_identity: "github-pages:boburning/portcove:fixture-deployment",
        evidence_sha256: "d".repeat(64),
      };
      const options = { executorIdentity: prior, maximumReceipts: 1, remote };
      let effects = 0;
      const effect = async (record: (identity: string, hash: string) => Promise<void>) => {
        effects++;
        await record(receipt.remote_identity, receipt.evidence_sha256);
      };
      const result =
        component === "catalog"
          ? await runBoundedCatalogPublicationOperation(
              f.bare,
              initial.checkpoint,
              descriptor,
              {
                kind: "upload",
                destination: "github-pages:boburning/portcove:complete-site",
                catalog_site_expectation: {
                  application_root_sha256: null,
                  archive_sha256: "a".repeat(64),
                  artifact_id: 1,
                  catalog_repository_sha256: "b".repeat(64),
                  catalog_root_sha256: descriptor.prior.catalog_root_sha256,
                  prior_site_generation_sha256: null,
                  site_generation_sha256: "c".repeat(64),
                },
              },
              async () => capacityFixture().boundary,
              effect,
              options,
            )
          : await runBoundedCapacityOperation(
              f.bare,
              initial.checkpoint,
              {
                kind: "upload",
                destination: "github-pages:boburning/portcove:complete-site",
                site_expectation: {
                  archive_sha256: "a".repeat(64),
                  artifact_id: 1,
                  prior_site_generation_sha256:
                    metadata.published.publication.site_generation_sha256,
                  repository_sha256: "9".repeat(64),
                  root_sha256: metadata.published.root_sha256,
                  site_generation_sha256: "c".repeat(64),
                },
              },
              async () => capacityFixture().boundary,
              effect,
              options,
            );
      const publication = { ...receipt, site_generation_sha256: "c".repeat(64) };
      const observed =
        component === "application"
          ? {
              ...metadata.published,
              repository_sha256: "9".repeat(64),
              versions: metadata.descriptor.next_versions,
              expires: metadata.descriptor.next_expires,
              operation_id: result.operation.id,
              publication,
            }
          : {
              schema_version: 1,
              source_commit: descriptor.source_commit,
              source_tree: descriptor.source_tree,
              root_sha256: descriptor.prior.catalog_root_sha256,
              repository_sha256: "b".repeat(64),
              verifier_repository_sha256: "e".repeat(64),
              immutable_targets_sha256: capacityDigest([]),
              offline_targets_sha256: "f".repeat(64),
              index_sha256: "0".repeat(64),
              snapshot_sha256: "1".repeat(64),
              timestamp_sha256: "2".repeat(64),
              versions: {
                targets: "1",
                definitions: "1",
                policy: "1",
                snapshot: "1",
                timestamp: "1",
              },
              expires: Object.fromEntries(
                ["targets", "definitions", "policy", "snapshot", "timestamp"].map((role) => [
                  role,
                  "2026-12-01T00:00:00Z",
                ]),
              ),
              operation_id: result.operation.id,
              publication,
            };
      const site = {
        schema_version: 1,
        generation_sha256: publication.site_generation_sha256,
        operation_id: result.operation.id,
        publication: receipt,
        components: {
          application: null,
          catalog: {
            root_sha256: observed.root_sha256,
            repository_sha256: observed.repository_sha256,
          },
        },
      };
      const request = {
        repository: f.bare,
        checkpoint: (
          await recordCapacityReadback(
            f.bare,
            result.checkpoint,
            "effect-completed",
            "e".repeat(64),
            { remote, executorIdentity: capacityExecutorIdentity(f.session) },
          )
        ).checkpoint,
        remote_configuration: f.remote.config,
      };
      const recovered =
        component === "application"
          ? await recoverOwnedPublishedMetadata(
              f.session,
              request,
              async () => observed,
              undefined,
              async () => {},
            )
          : await recoverOwnedPublishedCatalogMetadata(
              f.session,
              request,
              async () => ({ metadata: observed, site }),
              undefined,
              async () => {},
            );
      assert.equal(effects, 1);
      assert.equal(f.remote.refs.get(f.remote.stateRef), recovered.checkpoint);
      const retained = await recoverReleaseOpportunity(f.bare, recovered.checkpoint);
      assert.deepEqual(
        retained.input[
          component === "application" ? "published_metadata" : "published_catalog_metadata"
        ],
        observed,
      );
      assert.equal(
        isRecord(retained.input.published_site) && retained.input.published_site.operation_id,
        result.operation.id,
      );
      assert.deepEqual(retained.input.active_candidate, input.active_candidate);
      if (component === "catalog") {
        assert.deepEqual(retained.input.published_site, site);
        assert.equal(retained.input.catalog_publication, null);
        assert.equal(retained.input.published_metadata, undefined);
      }
    },
  );
}

for (const route of [
  "effect",
  "operation-recovery",
  "application-recovery",
  "catalog-recovery",
  "late-upgrade",
] as const) {
  void test(
    `journal-only selected custody cannot authorize ${route}`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(
        t,
        route === "catalog-recovery" ? "catalog-publication" : "application",
        true,
        false,
      );
      if (route === "late-upgrade") {
        const journal: unknown = JSON.parse(process.env.PORTCOVE_RELEASE_AUTHORITIES!);
        const full = { ...selectedPublicationAuthoritiesFixture("application"), journal };
        process.env.PORTCOVE_RELEASE_AUTHORITIES = JSON.stringify(full);
        const policy: unknown = JSON.parse(process.env.PORTCOVE_CONTROLLER_ADMISSION!);
        assert.ok(isRecord(policy));
        policy.authority_configuration_sha256 = capacityDigest(full);
        process.env.PORTCOVE_CONTROLLER_ADMISSION = JSON.stringify(policy);
      }
      let effects = 0,
        controls = 0;
      const calls = f.traffic.calls;
      const posts = f.posts.length;
      const checkpoint = f.remote.refs.get(f.remote.stateRef);
      const input = {
        repository: f.bare,
        checkpoint: f.reserved.checkpoint,
        remote_configuration: f.remote.config,
      };
      const read = async (): Promise<never> => {
        effects++;
        throw new Error("journal-only provider readback must not run");
      };
      const control = async () => {
        controls++;
      };
      await assert.rejects(
        route === "operation-recovery"
          ? recoverOwnedCapacityEffect(f.session, input, read, undefined, control)
          : route === "application-recovery"
            ? recoverOwnedPublishedMetadata(f.session, input, read, undefined, control)
            : route === "catalog-recovery"
              ? recoverOwnedPublishedCatalogMetadata(f.session, input, read, undefined, control)
              : executeOwnedCapacityEffect(
                  f.session,
                  {
                    repository: f.bare,
                    checkpoint: f.reserved.checkpoint,
                    remote_configuration: f.remote.config,
                    request: {
                      kind: "dispatch",
                      destination: "github-actions:boburning/portcove:release.yml:dispatch",
                    },
                  },
                  async () => {
                    controls++;
                    return capacityFixture().boundary;
                  },
                  async () => {
                    effects++;
                    return {
                      remote_identity: "inert-should-be-refused",
                      evidence_sha256: "d".repeat(64),
                    };
                  },
                  async () => {
                    controls++;
                  },
                ),
        /full selected publication scope/,
      );
      assert.equal(effects, 0);
      assert.equal(controls, 0);
      assert.equal(f.traffic.calls, calls);
      assert.equal(f.posts.length, posts);
      assert.equal(f.faults.originalJobReads, 0);
      assert.equal(f.remote.refs.get(f.remote.stateRef), checkpoint);
      await assert.rejects(
        publishOwnedSignedCoordinatorCheckpoint(f.session, f.bare, f.reserved.checkpoint, control),
        /stopped/,
      );
    },
  );
}

for (const reratified of [false, true]) {
  void test(
    `full selected publication pin drift ${reratified ? "reratified during session" : "unratified"} cannot borrow unchanged journal custody`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(t, "application", true, true);
      const raw: unknown = JSON.parse(process.env.PORTCOVE_RELEASE_AUTHORITIES!);
      assert.ok(
        isRecord(raw) &&
          isRecord(raw.publication) &&
          isRecord(raw.publication.public_source) &&
          isRecord(raw.publication.public_source.root),
      );
      const commonBefore = capacityDigest(raw.journal);
      raw.publication.public_source.root.sha256 = "0".repeat(64);
      assert.equal(capacityDigest(raw.journal), commonBefore);
      process.env.PORTCOVE_RELEASE_AUTHORITIES = JSON.stringify(raw);
      if (reratified) {
        const policy: unknown = JSON.parse(process.env.PORTCOVE_CONTROLLER_ADMISSION!);
        assert.ok(isRecord(policy));
        policy.authority_configuration_sha256 = capacityDigest(raw);
        process.env.PORTCOVE_CONTROLLER_ADMISSION = JSON.stringify(policy);
      }
      const posts = f.posts.length;
      let effects = 0;
      await assert.rejects(
        executeOwnedCapacityEffect(
          f.session,
          {
            repository: f.bare,
            checkpoint: f.reserved.checkpoint,
            remote_configuration: f.remote.config,
            request: {
              kind: "dispatch",
              destination: "github-actions:boburning/portcove:release.yml:dispatch",
            },
          },
          async () => capacityFixture().boundary,
          async () => {
            effects++;
            return { remote_identity: "must-not-run", evidence_sha256: "d".repeat(64) };
          },
          async () => {},
        ),
        reratified ? /source\/configuration changed/ : /ratification/,
      );
      assert.equal(effects, 0);
      assert.equal(f.posts.length, posts);
      assert.equal(f.remote.refs.get(f.remote.stateRef), f.reserved.checkpoint);
      await assert.rejects(
        publishOwnedSignedCoordinatorCheckpoint(
          f.session,
          f.bare,
          f.reserved.checkpoint,
          async () => {},
        ),
        /stopped/,
      );
    },
  );
}

for (const component of ["application", "catalog"] as const) {
  void test(
    `selected ${component} metadata recovery refuses the opposite source purpose`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(
        t,
        component === "catalog" ? "application" : "catalog-publication",
      );
      let controls = 0;
      const calls = f.traffic.calls;
      const request = {
        repository: f.bare,
        checkpoint: f.reserved.checkpoint,
        remote_configuration: f.remote.config,
      };
      const read = async () => {
        throw new Error("opposite-purpose readback must not run");
      };
      const current = async () => {
        controls++;
      };
      await assert.rejects(
        component === "catalog"
          ? recoverOwnedPublishedCatalogMetadata(f.session, request, read, undefined, current)
          : recoverOwnedPublishedMetadata(f.session, request, read, undefined, current),
        /publication purpose differs/,
      );
      assert.equal(controls, 0);
      assert.equal(f.traffic.calls, calls);
    },
  );
}

for (const purpose of ["application", "catalog-publication"] as const) {
  void test(
    `selected ${purpose} operation recovery refuses the opposite retained subject before provider readback`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(t, purpose, purpose === "catalog-publication");
      const descriptor = catalogPublicationFixture();
      let checkpoint = f.reserved.checkpoint;
      const remote = {
        publish: (head: string) =>
          publishOwnedSignedCoordinatorCheckpoint(f.session, f.bare, head, async () => {}),
      };
      if (purpose === "application") {
        const current = await recoverReleaseOpportunity(f.bare, checkpoint);
        const saved = await checkpointReleaseOpportunity(f.bare, checkpoint, {
          ...current.input,
          catalog_publication: descriptor,
        });
        await remote.publish(saved.checkpoint);
        checkpoint = saved.checkpoint;
      }
      const prior = { ...capacityExecutorIdentity(f.session), job_id: 502, check_run_id: "778" };
      const effect = async () => {
        throw new Error("original provider outcome unknown");
      };
      const options = { executorIdentity: prior, maximumReceipts: 1, remote };
      await assert.rejects(
        purpose === "application"
          ? runBoundedCatalogPublicationOperation(
              f.bare,
              checkpoint,
              descriptor,
              {
                kind: "upload",
                destination: "github-actions:boburning/portcove:catalog-publication-context",
              },
              async () => capacityFixture().boundary,
              effect,
              options,
            )
          : runBoundedCapacityOperation(
              f.bare,
              checkpoint,
              {
                kind: "dispatch",
                destination: "github-actions:boburning/portcove:release.yml:dispatch",
              },
              async () => capacityFixture().boundary,
              effect,
              options,
            ),
        /read back before/,
      );
      checkpoint = f.remote.refs.get(f.remote.stateRef)!;
      const posts = f.posts.length;
      let readbacks = 0;
      await assert.rejects(
        recoverOwnedCapacityEffect(
          f.session,
          {
            repository: f.bare,
            checkpoint,
            remote_configuration: f.remote.config,
          },
          async () => {
            readbacks++;
            return { resolution: "effect-not-applied", evidence_sha256: "e".repeat(64) };
          },
          undefined,
          async () => {},
        ),
        /publication purpose differs/,
      );
      assert.equal(readbacks, 0);
      assert.equal(f.faults.originalJobReads, 0);
      assert.equal(f.posts.length, posts, "wrong-purpose recovery cannot start a signing exchange");
      assert.equal(f.remote.refs.get(f.remote.stateRef), checkpoint);
    },
  );
}

for (const purpose of ["application", "catalog-publication"] as const) {
  void test(
    `selected ${purpose} executor refuses opposite-purpose effects before controls or provider work`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(t, purpose);
      let controls = 0,
        effects = 0;
      const calls = f.traffic.calls;
      await assert.rejects(
        executeOwnedCapacityEffect(
          f.session,
          {
            repository: f.bare,
            checkpoint: f.reserved.checkpoint,
            remote_configuration: f.remote.config,
            ...(purpose === "application"
              ? {
                  catalog_publication: catalogPublicationFixture(),
                  request: {
                    kind: "upload" as const,
                    destination: "github-actions:boburning/portcove:catalog-publication-context",
                  },
                }
              : {
                  request: {
                    kind: "dispatch" as const,
                    destination: "github-actions:boburning/portcove:release.yml:dispatch",
                  },
                }),
          },
          async () => {
            controls++;
          },
          async () => {
            effects++;
            return { remote_identity: "must-not-run", evidence_sha256: "d".repeat(64) };
          },
          async () => {
            controls++;
          },
        ),
        /publication purpose differs/,
      );
      assert.equal(controls, 0);
      assert.equal(effects, 0);
      assert.equal(f.traffic.calls, calls);
    },
  );
}

void test(
  "selected recovery rejects a legacy guard even with bound history and live selected controls",
  {
    timeout: 180000,
    skip:
      process.platform !== "linux" || process.getuid?.() === 0
        ? "default signing custody requires an ordinary native Linux owner"
        : false,
  },
  async (t) => {
    const f = await selectedEffectFixture(t);
    const calls = f.traffic.calls;
    let guards = 0;
    await assert.rejects(
      recoverOwnedCapacityEffect(
        f.session,
        {
          repository: f.bare,
          checkpoint: f.reserved.checkpoint,
          remote_configuration: f.remote.config,
        },
        async () => {
          throw new Error("readback must not run");
        },
        () => {
          guards++;
        },
        async () => {
          guards++;
        },
      ),
      /exact bound journal/,
    );
    assert.equal(guards, 0);
    assert.equal(f.traffic.calls, calls);
    await assert.rejects(
      publishOwnedSignedCoordinatorCheckpoint(
        f.session,
        f.bare,
        f.reserved.checkpoint,
        async () => {},
      ),
      /stopped/,
    );
  },
);

for (const fault of [
  "",
  "pending-controls",
  "provider-refusal",
  "ambiguous-after-effect",
] as const) {
  void test(
    `selected owned effect ${fault || "complete"} uses signed durable intent and preserves actual effects`,
    {
      timeout: 180000,
      skip:
        process.platform !== "linux" || process.getuid?.() === 0
          ? "default signing custody requires an ordinary native Linux owner"
          : false,
    },
    async (t) => {
      const f = await selectedEffectFixture(t);
      let effects = 0,
        controls = 0;
      const input = {
        repository: f.bare,
        checkpoint: f.reserved.checkpoint,
        remote_configuration: f.remote.config,
        request: {
          kind: "dispatch" as const,
          destination: "github-actions:boburning/portcove:release.yml:dispatch",
        },
      };
      const work = () =>
        executeOwnedCapacityEffect(
          f.session,
          input,
          async () => capacityFixture().boundary,
          async (pending) => {
            effects++;
            assert.equal(f.remote.refs.get(f.remote.stateRef), pending.checkpoint);
            assert.ok(
              f.remote.refs.has(
                `refs/tags/portcove-fixture-checkpoint-proof/${pending.checkpoint}`,
              ),
            );
            if (fault === "provider-refusal")
              throw new ProviderCapacityRefusal("provider:capacity-refused", "d".repeat(64));
            if (fault === "ambiguous-after-effect") f.faults.ambiguousFinal = true;
            return { remote_identity: "provider:observed-once", evidence_sha256: "d".repeat(64) };
          },
          async () => {
            controls++;
            if (fault === "pending-controls" && controls > 1)
              throw new Error("actual controls now hold");
          },
        );
      if (fault) {
        await assert.rejects(work());
        assert.equal(effects, fault === "pending-controls" ? 0 : 1);
        const localHead = execFileSync(
          "git",
          ["-C", f.bare, "rev-parse", "refs/portcove/release-coordinator-state"],
          { encoding: "utf8", windowsHide: true },
        ).trim();
        const retained = await recoverReleaseOpportunity(f.bare, localHead);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        const operation = inspectCapacityOperation(
          retained.input.controller.capacity_attempt.operation,
        )!;
        assert.equal(
          operation.outcome,
          fault === "provider-refusal" ? "capacity-refused" : "ambiguous",
        );
        assert.equal(
          operation.completed_effects.length,
          fault === "ambiguous-after-effect" ? 1 : 0,
        );
        if (fault === "provider-refusal")
          assert.deepEqual(operation.failure_evidence, {
            remote_identity: "provider:capacity-refused",
            evidence_sha256: "d".repeat(64),
          });
        const before = f.posts.length;
        await assert.rejects(work(), /stopped/);
        assert.equal(f.posts.length, before, "no signing retry after refusal or ambiguity");
        const calls = f.traffic.calls;
        let laterControls = 0;
        await assert.rejects(
          publishOwnedSignedCoordinatorCheckpoint(
            f.session,
            f.bare,
            f.remote.refs.get(f.remote.stateRef)!,
            async () => {
              laterControls++;
            },
          ),
          /stopped/,
        );
        await assert.rejects(
          authenticateOwnedCheckpointJournalHistory(
            f.session,
            f.bare,
            f.remote.refs.get(f.remote.stateRef)!,
          ),
          /stopped/,
        );
        assert.equal(laterControls, 0);
        assert.equal(f.traffic.calls, calls, "failed effect stops all later journal/provider work");
      } else {
        const result = await work();
        assert.equal(effects, 1);
        assert.equal(f.remote.refs.get(f.remote.stateRef), result.checkpoint);
        const retained = await recoverReleaseOpportunity(f.bare, result.checkpoint);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        const operation = inspectCapacityOperation(
          retained.input.controller.capacity_attempt.operation,
        )!;
        assert.equal(operation.outcome, "recovered");
        assert.equal(operation.recovery?.resolution, "effect-completed");
        assert.deepEqual(operation.completed_effects, [
          { remote_identity: "provider:observed-once", evidence_sha256: "d".repeat(64) },
        ]);
        const capacity = assessBoundedCapacity(retained.input.controller.capacity_attempt);
        assert.equal(capacity.availability, "unknown");
        assert.equal(capacity.headroom, "unknown");
        assert.ok(
          f.posts.length >= 8,
          "reservation, intent, receipt and settlement used the official SDK",
        );
      }
    },
  );
}

void test("selected private history cannot rebind an active publisher or clear its stopped state", async (t) => {
  const { session, bare, seed, heads } = await selectedOwnedHistoryFixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publishing = publishOwnedSignedCoordinatorCheckpoint(
    session,
    bare,
    seed.checkpoint,
    async () => {
      enter();
      await gate;
      throw new Error("retained current-control refusal");
    },
  );
  await entered;
  try {
    await assert.rejects(
      authenticateOwnedCheckpointJournalHistory(session, bare, seed.checkpoint),
      /busy|bound|stopped|recovery/,
    );
  } finally {
    release();
    await assert.rejects(publishing, /current-control refusal/);
  }
  await assert.rejects(
    authenticateOwnedCheckpointJournalHistory(session, bare, seed.checkpoint),
    /stopped|recovery/,
  );
  await assert.rejects(
    publishOwnedSignedCoordinatorCheckpoint(session, bare, seed.checkpoint, async () => {
      assert.fail("stopped publisher");
    }),
    /stopped|recovery/,
  );
  assert.equal(heads(), 2, "no new history/provider work while busy or after refusal");
});

void test("selected signed publisher bounds local Git preparation to original remaining execution", async (t) => {
  const f = await selectedOwnedHistoryFixture(t);
  let clock = performance.now(),
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(
    childProcess,
    "execFileSync",
    (_command: string, _args: readonly string[], options: childProcess.ExecFileSyncOptions) => {
      calls++;
      assert.equal(options.timeout, 1);
      clock = f.deadline + 1;
      return "true";
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(
    publishOwnedSignedCoordinatorCheckpoint(f.session, f.bare, "f".repeat(40), async () => {
      clock = f.deadline - 1;
    }),
    /deadline/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    publishOwnedSignedCoordinatorCheckpoint(f.session, f.bare, f.seed.checkpoint, async () => {
      assert.fail("stopped phase");
    }),
    /stopped|recovery/,
  );
});
