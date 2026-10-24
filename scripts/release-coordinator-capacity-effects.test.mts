import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  runBoundedCapacityOperation,
  recordCapacityReadback,
  ProviderCapacityRefusal,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
} from "./release-coordinator-state.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
  recoverOwnedPublishedMetadata,
  recoverOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
  jwk as identityJwk,
} from "./fixtures/assembler-identity-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";

import {
  recoveryFixture,
  fixture,
  remoteCapacityFixture,
} from "./fixtures/coordinator-state-fixtures.mts";

async function capacityStateFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
  return { ...f, capacity, migrated };
}

for (const kind of ["refusal", "ambiguous"]) {
  void test(`schema2 pending intent survives partial ${kind} without phase loss or duplicate attempts`, async (t) => {
    const f = await fixture(t);
    const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
    const capacity = capacityFixture();
    const input = {
      ...f.input,
      schema_version: 2,
      controller: {
        workflow: f.input.controller.workflow,
        revision: f.input.controller.revision,
        publication_paused: false,
        capacity_attempt: capacity,
      },
    };
    const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
    let effects = 0,
      failedCheckpoint = "";
    try {
      await runBoundedCapacityOperation(
        f.repository,
        migrated.checkpoint,
        { kind: "upload", destination: "same-run immutable candidate archive" },
        async () => capacity.boundary,
        async (record) => {
          effects++;
          const pending = f.git("rev-parse", coordinatorStateRef).trim();
          const pendingState = await recoverReleaseOpportunity(f.repository, pending);
          assert.equal(pendingState.plan.action, "pause");
          assert.deepEqual(pendingState.input.active_candidate, f.input.active_candidate);
          await record("artifact:fixture-completed", "a".repeat(64));
          if (kind === "refusal")
            throw new ProviderCapacityRefusal("provider-upload-quota-refusal", "b".repeat(64));
          throw Error("DISPOSABLE-SECRET-unavailable-response");
        },
      );
      assert.fail("must stop");
    } catch (error) {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      failedCheckpoint = String(error.evidence.checkpoint);
      assert.equal(JSON.stringify(error.evidence).includes("DISPOSABLE-SECRET"), false);
    }
    const failed = await recoverReleaseOpportunity(f.repository, failedCheckpoint);
    assert.deepEqual(failed.input.active_candidate, f.input.active_candidate);
    assert.ok(
      isRecord(failed.input.controller) && isRecord(failed.input.controller.capacity_attempt),
    );
    const operation = failed.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.outcome, kind === "refusal" ? "capacity-refused" : "ambiguous");
    assert.ok(Array.isArray(operation.completed_effects));
    assert.equal(operation.completed_effects.length, 1);
    await assert.rejects(
      runBoundedCapacityOperation(
        f.repository,
        failedCheckpoint,
        { kind: "dispatch", destination: "different ID cannot bypass unresolved effect" },
        async () => capacity.boundary,
        async () => {
          effects++;
        },
      ),
    );
    assert.equal(effects, 1);
    const dropped = structuredClone(failed.input);
    assert.ok(isRecord(dropped.controller) && isRecord(dropped.controller.capacity_attempt));
    dropped.controller.capacity_attempt.operation = null;
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, failedCheckpoint, dropped),
      /cannot disappear/,
    );
    await assert.rejects(
      recordCapacityReadback(f.repository, failedCheckpoint, "effect-not-applied", "c".repeat(64)),
      /contradicts/,
    );
    const resolved = await recordCapacityReadback(
      f.repository,
      failedCheckpoint,
      "partial-effects-retained",
      "c".repeat(64),
    );
    const readback = await recoverReleaseOpportunity(f.repository, resolved.checkpoint);
    assert.deepEqual(readback.input.active_candidate, f.input.active_candidate);
    assert.equal(readback.plan.authority.capacity_attempt?.availability, "unknown");
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, resolved.checkpoint, { ...f.input }),
      /cannot downgrade/,
    );
  });
}

void test("successful operation proves only its own effect; next boundary must be checked independently", async (t) => {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
  let effects = 0;
  const success = await runBoundedCapacityOperation(
    f.repository,
    migrated.checkpoint,
    { kind: "upload", destination: "artifact:first" },
    async () => capacity.boundary,
    async (record) => {
      effects++;
      await record("artifact:1", "d".repeat(64));
    },
  );
  assert.equal(success.availability, "unknown");
  assert.equal(success.headroom, "unknown");
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      success.checkpoint,
      { kind: "retention", destination: "artifact:second" },
      async () => ({ ...capacity.boundary, stop_usage: false }),
      async () => {
        effects++;
      },
    ),
  );
  assert.equal(effects, 1);
  const held = await recoverReleaseOpportunity(f.repository, success.checkpoint);
  assert.deepEqual(held.input.active_candidate, f.input.active_candidate);
});

for (const lost of [false, true])
  void test(
    `actual executor integration ${lost ? "retains a lost provider outcome and forbids retry" : "settles only its exact durably retained effect"}`,
    { timeout: 180000 },
    async (t) => {
      // Real local Git journal with simulated GitHub/JWKS/OIDC transport. No real
      // issuer credential, GitHub request, publication or protected grant is used.
      const f = await remoteCapacityFixture(t, true);
      const signed = assemblerIdentityFixture(
        {
          aud: "portcove-capacity-executor",
          environment: "github-pages",
          sub: "repo:boburning@43177418/portcove@1354613114:environment:github-pages",
        },
        {},
        { workflow: productionControllerWorkflow, job: "Publish authenticated application site" },
      );
      let activeIdentity = signed;
      let publisherTerminal = false;
      const coordinatorSubject = controllerOidcSubject(
        identityExpected.controller_ref,
        "production-release-coordinator",
      );
      const coordinatorIdentity = () =>
        assemblerIdentityFixture(
          {
            aud: "portcove-capacity-executor",
            environment: "production-release-coordinator",
            sub: coordinatorSubject,
          },
          {},
          {
            workflow: productionControllerWorkflow,
            job: "Coordinate application release",
            jobId: 502,
            checkRunId: 779,
          },
        );
      const recoveryExpected = {
        ...identityExpected,
        audience: "portcove-capacity-executor",
        subject: coordinatorSubject,
      };
      const metadata = metadataFixture();
      const seeded = lost
        ? f.migrated
        : await recordPublishedMetadata(
            f.bare,
            f.migrated.checkpoint,
            metadata.published,
            f.options,
          );
      const savedEnv = new Map(
        [
          "ACTIONS_ID_TOKEN_REQUEST_URL",
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
          "GH_TOKEN",
          "PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
        ].map((k) => [k, process.env[k]]),
      );
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
        "https://fixture.actions.githubusercontent.com/oidc";
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "inert-runner-token";
      process.env.GH_TOKEN = "inert-provider-read-only-token";
      process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-dedicated-journal-token";
      t.after(() => {
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const http = t.mock.method(globalThis, "fetch", async (raw: Parameters<typeof fetch>[0]) => {
        if (typeof raw !== "string" && !(raw instanceof URL))
          throw new Error("fixture expects a fixed URL");
        const url = typeof raw === "string" ? raw : raw.href;
        if (url === "https://token.actions.githubusercontent.com/.well-known/jwks")
          return new Response(JSON.stringify({ keys: [identityJwk] }));
        assert.equal(
          url,
          "https://fixture.actions.githubusercontent.com/oidc?audience=portcove-capacity-executor",
        );
        return new Response(JSON.stringify({ value: activeIdentity.token }));
      });
      const original = childProcess.spawnSync;
      const command = t.mock.method(
        childProcess,
        "spawnSync",
        (name: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
          if (name !== "gh") return original(name, args, options);
          assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
          if (activeIdentity !== signed && args[2]?.endsWith("/actions/jobs/501"))
            return {
              status: 0,
              stdout: `HTTP/2 200\r\n\r\n${JSON.stringify({
                id: 501,
                run_id: 9988,
                run_attempt: 2,
                head_sha: identityExpected.controller_revision,
                status: publisherTerminal ? "completed" : "in_progress",
                conclusion: publisherTerminal ? "failure" : null,
                check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
              })}`,
              stderr: "",
            };
          if (args[2]?.includes("/actions/") || args[2]?.includes("/check-runs/"))
            return activeIdentity.transport.spawn(name, args, options);
          assert.equal(options.env?.GH_TOKEN, "inert-dedicated-journal-token");
          assert.equal(options.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
          assert.equal(options.env?.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
          let body: unknown;
          let status: number;
          if (args[1] === "graphql") {
            assert.ok(typeof options.input === "string");
            const request: unknown = JSON.parse(options.input);
            assert.ok(
              isRecord(request) && typeof request.query === "string" && isRecord(request.variables),
            );
            body = f.api.graphql(request.query, request.variables);
            status = 200;
          } else {
            assert.equal(args[0], "api");
            const method = args[args.indexOf("--method") + 1];
            assert.ok(method === "GET" || method === "POST");
            assert.ok(options.input === undefined || typeof options.input === "string");
            const response = f.api.request(
              method,
              args[2]!,
              options.input === undefined ? undefined : JSON.parse(options.input),
            );
            body = response.body;
            status = response.status!;
          }
          return {
            status: 0,
            stdout: `HTTP/2 ${status}\r\n\r\n${JSON.stringify(body)}`,
            stderr: "",
          };
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        command.mock.restore();
        http.mock.restore();
        syncBuiltinESMExports();
      });
      const executor = await authenticateCapacityExecutor(
        "site-publication",
        {
          ...identityExpected,
          audience: "portcove-capacity-executor",
          subject: "repo:boburning@43177418/portcove@1354613114:environment:github-pages",
        },
        f.repository,
      );
      const siteExpectation = {
        archive_sha256: "b".repeat(64),
        artifact_id: 123,
        prior_site_generation_sha256: metadata.published.publication.site_generation_sha256,
        repository_sha256: "9".repeat(64),
        root_sha256: metadata.published.root_sha256,
        site_generation_sha256: "a".repeat(64),
      };
      const request = {
        repository: f.bare,
        checkpoint: seeded.checkpoint,
        remote_configuration: f.config,
        request: {
          kind: "upload" as const,
          destination: "github-pages:boburning/portcove:complete-site",
          ...(lost ? {} : { site_expectation: siteExpectation }),
        },
      };
      let effects = 0;
      const receipt = async (pending: { checkpoint: string; operation_id: string }) => {
        effects++;
        assert.equal(
          f.refs.get(f.stateRef),
          pending.checkpoint,
          "pending intent must already be remote",
        );
        const observed = await recoverReleaseOpportunity(f.bare, pending.checkpoint);
        assert.ok(
          isRecord(observed.input.controller) &&
            isRecord(observed.input.controller.capacity_attempt),
        );
        const operation = observed.input.controller.capacity_attempt.operation;
        assert.ok(isRecord(operation) && isRecord(operation.executor_identity));
        assert.equal(operation.id, pending.operation_id);
        assert.equal(operation.executor_identity.job_id, 501);
        assert.deepEqual(operation.site_expectation, lost ? undefined : siteExpectation);
        assert.equal(operation.outcome, "pending");
        if (lost) throw new Error("simulated response lost after provider effect");
        return {
          remote_identity: "github-pages:boburning/portcove:fixture-deployment",
          evidence_sha256: "d".repeat(64),
        };
      };
      if (lost) {
        await assert.rejects(
          executeOwnedCapacityEffect(executor, request, async () => f.capacity.boundary, receipt),
          /read back before/u,
        );
        await assert.rejects(
          executeOwnedCapacityEffect(executor, request, async () => f.capacity.boundary, receipt),
          /stopped/u,
        );
        const retained = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        assert.ok(isRecord(retained.input.controller.capacity_attempt.operation));
        assert.equal(retained.input.controller.capacity_attempt.operation.outcome, "ambiguous");
        assert.equal(retained.input.controller.capacity_attempt.operation.receipt_limit, 1);
        assert.deepEqual(
          retained.input.controller.capacity_attempt.operation.completed_effects,
          [],
        );
        activeIdentity = coordinatorIdentity();
        const recoveryInput = {
          repository: f.bare,
          checkpoint: retained.checkpoint,
          remote_configuration: f.config,
        };
        let readbacks = 0;
        const completedEffect = {
          remote_identity: "github-pages:boburning/portcove:fixture-deployment",
          evidence_sha256: "d".repeat(64),
        };
        const readback = async () => {
          readbacks++;
          return {
            resolution: "effect-completed" as const,
            evidence_sha256: "e".repeat(64),
            completed_effect: completedEffect,
          };
        };
        const live = await authenticateCapacityExecutor(
          "coordinator",
          recoveryExpected,
          f.repository,
        );
        await assert.rejects(
          recoverOwnedCapacityEffect(live, recoveryInput, readback),
          /not observed terminal/,
        );
        assert.equal(readbacks, 0);
        publisherTerminal = true;
        const recovery = await authenticateCapacityExecutor(
          "coordinator",
          recoveryExpected,
          f.repository,
        );
        const completed = await recoverOwnedCapacityEffect(recovery, recoveryInput, readback);
        const final = await recoverReleaseOpportunity(f.bare, completed.checkpoint);
        assert.ok(
          isRecord(final.input.controller) && isRecord(final.input.controller.capacity_attempt),
        );
        const operation = final.input.controller.capacity_attempt.operation;
        assert.ok(isRecord(operation) && isRecord(operation.recovery));
        assert.equal(operation.outcome, "recovered");
        assert.equal(operation.recovery.resolution, "effect-completed");
        assert.deepEqual(operation.completed_effects, [completedEffect]);
        assert.equal(readbacks, 1);
        assert.equal(f.refs.get(f.stateRef), completed.checkpoint);
        assert.deepEqual(final.input.active_candidate, retained.input.active_candidate);
      } else {
        const result = await executeOwnedCapacityEffect(
          executor,
          request,
          async () => f.capacity.boundary,
          receipt,
        );
        assert.equal(
          f.refs.get(f.stateRef),
          result.checkpoint,
          "settlement must be remotely confirmed",
        );
        const settled = await recoverReleaseOpportunity(f.bare, result.checkpoint);
        assert.ok(
          isRecord(settled.input.controller) && isRecord(settled.input.controller.capacity_attempt),
        );
        const operation = settled.input.controller.capacity_attempt.operation;
        assert.ok(
          isRecord(operation) &&
            isRecord(operation.recovery) &&
            isRecord(operation.recovery.executor_identity),
        );
        assert.equal(operation.id, result.operation_id);
        assert.equal(operation.outcome, "recovered");
        assert.equal(operation.recovery.resolution, "effect-completed");
        assert.equal(operation.recovery.executor_identity.job_id, 501);
        assert.equal(result.evidence_sha256, "d".repeat(64));
        assert.deepEqual(settled.input.active_candidate, f.input.active_candidate);
        activeIdentity = coordinatorIdentity();
        let readbacks = 0;
        const observed = async () => {
          readbacks++;
          return {
            ...metadata.published,
            repository_sha256: "9".repeat(64),
            versions: metadata.descriptor.next_versions,
            expires: metadata.descriptor.next_expires,
            operation_id: result.operation_id,
            publication: {
              remote_identity: "github-pages:boburning/portcove:fixture-deployment",
              evidence_sha256: result.evidence_sha256,
              site_generation_sha256: "a".repeat(64),
            },
          };
        };
        const liveRecovery = await authenticateCapacityExecutor(
          "coordinator",
          recoveryExpected,
          f.repository,
        );
        await assert.rejects(
          recoverOwnedPublishedMetadata(
            liveRecovery,
            {
              repository: f.bare,
              checkpoint: result.checkpoint,
              remote_configuration: f.config,
            },
            observed,
          ),
          /not observed terminal/,
        );
        assert.equal(readbacks, 0);
        publisherTerminal = true;
        const recovery = await authenticateCapacityExecutor(
          "coordinator",
          recoveryExpected,
          f.repository,
        );
        const completed = await recoverOwnedPublishedMetadata(
          recovery,
          {
            repository: f.bare,
            checkpoint: result.checkpoint,
            remote_configuration: f.config,
          },
          observed,
        );
        const final = await recoverReleaseOpportunity(f.bare, completed.checkpoint);
        assert.equal(readbacks, 1);
        assert.equal(f.refs.get(f.stateRef), completed.checkpoint);
        assert.deepEqual(final.input.active_candidate, f.input.active_candidate);
        assert.deepEqual(final.input.published_metadata, await observed());
      }
      assert.equal(effects, 1);
    },
  );

void test(
  "separate executors cannot share an identical remote pending intent",
  { timeout: 60000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const contender = path.join(f.repository, "contender.git");
    execFileSync("git", ["clone", "--mirror", "--quiet", f.bare, contender], { windowsHide: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let effects = 0;
    const request = { kind: "upload" as const, destination: "artifact:exclusive" };
    const first = runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      request,
      async () => f.capacity.boundary,
      async (record) => {
        effects++;
        entered.resolve();
        await release.promise;
        await record("artifact:first-executor", "a".repeat(64));
      },
      f.options,
    ).then(
      (result) => ({ result }),
      (error: unknown) => {
        entered.reject(error);
        return { error };
      },
    );
    await entered.promise;
    let secondError: unknown;
    try {
      await runBoundedCapacityOperation(
        contender,
        f.migrated.checkpoint,
        request,
        async () => f.capacity.boundary,
        async (record) => {
          effects++;
          await record("artifact:second-executor", "b".repeat(64));
        },
        f.options,
      );
    } catch (error) {
      secondError = error;
    } finally {
      release.resolve();
    }
    const outcome = await first;
    assert.equal(effects, 1, "only the remote claim creator may enter its effect");
    assert.ok(secondError instanceof CoordinatorRemoteError);
    assert.ok("result" in outcome, "the winning executor retains its pending effect receipt");
  },
);

void test("remote capacity intent and completed effects are durable before handoff", async (t) => {
  const f = await remoteCapacityFixture(t);
  const result = await runBoundedCapacityOperation(
    f.bare,
    f.migrated.checkpoint,
    { kind: "upload", destination: "artifact:durable" },
    async () => f.capacity.boundary,
    async (record) => {
      const pending = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
      assert.ok(
        isRecord(pending.input.controller) && isRecord(pending.input.controller.capacity_attempt),
      );
      const operation = pending.input.controller.capacity_attempt.operation;
      assert.ok(isRecord(operation));
      assert.equal(operation.outcome, "pending");
      // Lost POST acknowledgement is accepted only after the existing readback
      // confirms exact refs; this does not repeat the mutation.
      f.faults.mutation = "after";
      await record("artifact:observed", "d".repeat(64));
      const recorded = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
      assert.ok(
        isRecord(recorded.input.controller) && isRecord(recorded.input.controller.capacity_attempt),
      );
      const saved = recorded.input.controller.capacity_attempt.operation;
      assert.ok(isRecord(saved));
      assert.deepEqual(saved.completed_effects, [
        { remote_identity: "artifact:observed", evidence_sha256: "d".repeat(64) },
      ]);
    },
    f.options,
  );
  assert.equal(result.durable_checkpoint, result.checkpoint);
  assert.equal(result.completion, "readback-required");
  assert.equal(result.operation.outcome, "pending");
  assert.equal(f.refs.get(f.stateRef), result.checkpoint);
  assert.equal(result.availability, "unknown");
  assert.equal(result.headroom, "unknown");
});

void test("trusted checkpoint publisher is frozen before async boundary and used through settlement", async (t) => {
  const f = await remoteCapacityFixture(t, true);
  const published: string[] = [];
  const publish = async (checkpoint: string) => {
    await publishCoordinatorCheckpoint(f.bare, checkpoint, f.config, { api: f.api });
    published.push(checkpoint);
    return { checkpoint };
  };
  const remote = { publish };
  const result = await runBoundedCapacityOperation(
    f.bare,
    f.migrated.checkpoint,
    { kind: "upload", destination: "artifact:captured-publisher" },
    async () => {
      remote.publish = () => Promise.reject(new Error("mutated callback must not run"));
      return f.capacity.boundary;
    },
    async (record) => {
      assert.equal(f.refs.get(f.stateRef), published.at(-1));
      await record("provider:captured", "d".repeat(64));
    },
    { remote },
  );
  assert.equal(result.durable_checkpoint, result.checkpoint);
  assert.equal(published.length, 3, "pending, receipt and final handoff use captured publisher");
  remote.publish = publish;
  const settlement = recordCapacityReadback(
    f.bare,
    result.checkpoint,
    "effect-completed",
    "d".repeat(64),
    { remote },
  );
  remote.publish = () => Promise.reject(new Error("mutated settlement publisher must not run"));
  const settled = await settlement;
  assert.equal(f.refs.get(f.stateRef), settled.checkpoint);
  assert.equal(published.at(-1), settled.checkpoint);
});

void test("conflicting or wrong-checkpoint publisher cannot enable an effect or legacy fallback", async (t) => {
  const f = await remoteCapacityFixture(t, true);
  let effects = 0,
    publications = 0;
  const request = { kind: "upload" as const, destination: "artifact:no-fallback" };
  const read = async () => f.capacity.boundary;
  const effect = async () => {
    effects++;
  };
  await assert.rejects(
    runBoundedCapacityOperation(f.bare, f.migrated.checkpoint, request, read, effect, {
      remote: { ...f.options.remote, publish: async (checkpoint) => ({ checkpoint }) },
    }),
    /one explicit/,
  );
  await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint);
  assert.equal(effects, 0);
  await assert.rejects(
    runBoundedCapacityOperation(f.bare, f.migrated.checkpoint, request, read, effect, {
      remote: {
        publish: async () => {
          publications++;
          return { checkpoint: "f".repeat(40) };
        },
      },
    }),
  );
  assert.equal(effects, 0);
  assert.equal(publications, 1, "wrong confirmation latches failure without another publication");
  assert.equal(f.refs.get(f.stateRef), f.migrated.checkpoint);
});

for (const partial of [false, true]) {
  void test(`remote checkpoint refusal ${partial ? "after partial progress" : "before effect"} stops without a second mutation`, async (t) => {
    const f = await remoteCapacityFixture(t);
    let effects = 0;
    if (!partial) f.faults.mutation = "before";
    const before = f.counts().mutations;
    let retained = "";
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        f.migrated.checkpoint,
        { kind: "upload", destination: "artifact:durability-refused" },
        async () => f.capacity.boundary,
        async (record) => {
          effects++;
          f.faults.mutation = "before";
          await record("artifact:completed-before-checkpoint-refusal", "e".repeat(64));
        },
        f.options,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        retained = String(error.evidence.checkpoint);
        assert.equal(error.evidence.retry, "forbidden");
        assert.ok(error.evidence.checkpoint_transport_error);
        return true;
      },
    );
    assert.equal(effects, partial ? 1 : 0);
    assert.equal(f.counts().mutations - before, partial ? 2 : 1);
    const state = await recoverReleaseOpportunity(f.bare, retained);
    assert.ok(
      isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt),
    );
    const operation = state.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.outcome, "ambiguous");
    assert.equal((operation.completed_effects as unknown[]).length, partial ? 1 : 0);
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        retained,
        { kind: "dispatch", destination: "run:must-not-retry" },
        async () => f.capacity.boundary,
        async () => {
          assert.fail("recovery required");
        },
        f.options,
      ),
    );
  });
}

void test("ambiguous remote pending POST retains its attempt and requires readback before effect", async (t) => {
  const f = await remoteCapacityFixture(t);
  const api: CoordinatorRemoteApi = {
    request: f.api.request,
    graphql(query, variables) {
      try {
        return f.api.graphql(query, variables);
      } finally {
        if (query.startsWith("mutation")) f.faults.snapshot = "after";
      }
    },
  };
  f.faults.mutation = "after";
  const before = f.counts().mutations;
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:ambiguous-intent" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("unconfirmed pending intent");
      },
      { remote: { configuration: f.config, api } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.durable_checkpoint, null);
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.ok(error.evidence.checkpoint_transport_error.mutationError);
      assert.ok(error.evidence.checkpoint_transport_error.readbackError);
      checkpoint = String(error.evidence.checkpoint);
      return true;
    },
  );
  assert.equal(f.counts().mutations - before, 1);
  const retained = await recoverReleaseOpportunity(f.bare, checkpoint);
  assert.ok(
    isRecord(retained.input.controller) && isRecord(retained.input.controller.capacity_attempt),
  );
  const operation = retained.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  // Simulated provider did apply the original pending intent despite the failed
  // response. Its state stays pending; no subsequent outcome POST was attempted.
  const remote: unknown = JSON.parse(
    execFileSync("git", ["-C", f.bare, "show", `${f.refs.get(f.stateRef)!}:state.json`], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.ok(
    isRecord(remote) &&
      isRecord(remote.input) &&
      isRecord(remote.input.controller) &&
      isRecord(remote.input.controller.capacity_attempt),
  );
  const remoteOperation = remote.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(remoteOperation));
  assert.equal(remoteOperation.outcome, "pending");
});

void test("configured mode cannot be cleared mid-effect and final handoff readback failure stays blocking", async (t) => {
  const f = await remoteCapacityFixture(t);
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "upload", destination: "artifact:final-handoff" },
      async () => f.capacity.boundary,
      async (record) => {
        Reflect.deleteProperty(f.options, "remote");
        await record("artifact:completed", "e".repeat(64));
        f.faults.snapshot = "after";
      },
      f.options,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      checkpoint = String(error.evidence.checkpoint);
      assert.ok(error.evidence.durable_checkpoint);
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.match(
        String(error.evidence.checkpoint_transport_error.message),
        /readback unavailable/,
      );
      return true;
    },
  );
  const state = await recoverReleaseOpportunity(f.bare, checkpoint);
  assert.ok(isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt));
  const operation = state.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  assert.equal((operation.completed_effects as unknown[]).length, 1);
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      checkpoint,
      { kind: "dispatch", destination: "run:forbidden-after-handoff" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("explicit recovery required");
      },
    ),
  );
});

void test("throwing null from initial transport cannot clear the failure latch or discard diagnostics", async (t) => {
  const f = await remoteCapacityFixture(t);
  let calls = 0;
  const api: CoordinatorRemoteApi = {
    request() {
      calls++;
      // Deliberately malformed provider exception exercises the failure latch.
      // oxlint-disable-next-line typescript/only-throw-error
      throw null;
    },
    graphql() {
      assert.fail("transport already failed");
    },
  };
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:null-transport" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("missing durable intent");
      },
      { remote: { configuration: f.config, api } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.equal(error.evidence.checkpoint_transport_error.code, "operation_failed");
      return true;
    },
  );
  assert.equal(calls, 1);
});

void test(
  "journal history refuses A B A despite intervening completed operations",
  { timeout: 60000 },
  async (t) => {
    const f = await capacityStateFixture(t);
    const run = (checkpoint: string, destination: string) =>
      runBoundedCapacityOperation(
        f.repository,
        checkpoint,
        { kind: "upload", destination },
        async () => f.capacity.boundary,
        async (record) => {
          await record(destination, "d".repeat(64));
        },
      );
    const a = await run(f.migrated.checkpoint, "artifact:A");
    const b = await run(a.checkpoint, "artifact:B");
    await assert.rejects(run(b.checkpoint, "artifact:A"), /completed operation cannot be repeated/);
    assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), b.checkpoint);
  },
);

void test("checkpoint advancement during final boundary read prevents stale effect", async (t) => {
  const f = await capacityStateFixture(t);
  let reads = 0,
    effects = 0,
    advanced = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:race" },
      async () => {
        if (++reads === 2) {
          const pending = f.git("rev-parse", coordinatorStateRef).trim();
          const state = await recoverReleaseOpportunity(f.repository, pending);
          assert.ok(isRecord(state.input.controller));
          state.input.controller.publication_paused = true;
          advanced = (await checkpointReleaseOpportunity(f.repository, pending, state.input))
            .checkpoint;
        }
        return f.capacity.boundary;
      },
      async () => {
        effects++;
      },
    ),
    CoordinatorRemoteError,
  );
  assert.equal(effects, 0);
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), advanced);
  const retained = await recoverReleaseOpportunity(f.repository, advanced);
  assert.equal(retained.plan.action, "pause");
});

void test("invalid provider receipt stays bounded and unawaited receipt is drained", async (t) => {
  const f = await capacityStateFixture(t);
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      f.migrated.checkpoint,
      { kind: "upload", destination: "artifact:bounded" },
      async () => f.capacity.boundary,
      async (record) => {
        void record("artifact:valid", "e".repeat(64));
        void record("X".repeat(4096), "f".repeat(64));
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      checkpoint = String(error.evidence.checkpoint);
      assert.ok(JSON.stringify(error.evidence).length < 4096);
      return true;
    },
  );
  const state = await recoverReleaseOpportunity(f.repository, checkpoint);
  assert.ok(isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt));
  const operation = state.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  assert.deepEqual(operation.completed_effects, [
    { remote_identity: "artifact:valid", evidence_sha256: "e".repeat(64) },
  ]);
});

for (const outcome of ["pending", "capacity-refused", "succeeded"]) {
  void test(
    `schema2 ${outcome} survives fresh sparse provider recovery with anti-repeat summary`,
    { timeout: 60000 },
    async (t) => {
      const f = await recoveryFixture(t),
        capacity = capacityFixture();
      const input = {
        ...f.input,
        schema_version: 2,
        controller: {
          workflow: f.input.controller.workflow,
          revision: f.input.controller.revision,
          publication_paused: false,
          capacity_attempt: capacity,
        },
      };
      const migrated = await checkpointReleaseOpportunity(f.repository, f.saved.checkpoint, input);
      const a = await runBoundedCapacityOperation(
        f.repository,
        migrated.checkpoint,
        { kind: "upload", destination: "artifact:earlier-A" },
        async () => capacity.boundary,
        async (record) => {
          await record("artifact:A", "a".repeat(64));
        },
      );
      let selected = "",
        pending = "";
      try {
        const b = await runBoundedCapacityOperation(
          f.repository,
          a.checkpoint,
          { kind: "upload", destination: "artifact:later-B" },
          async () => capacity.boundary,
          async (record) => {
            pending = f.git("rev-parse", coordinatorStateRef).trim();
            await record("artifact:B", "b".repeat(64));
            if (outcome === "capacity-refused")
              throw new ProviderCapacityRefusal("provider:refused-after-B", "c".repeat(64));
          },
        );
        selected = outcome === "pending" ? pending : b.checkpoint;
      } catch (error) {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        selected = String(error.evidence.checkpoint);
      }
      f.refs.set("refs/heads/portcove-fixture-coordinator-state", selected);
      const result = await recoverRemoteCoordinator(
        f.parent,
        { schema_version: 1, namespace: "portcove-fixture" },
        { transport: f.transport },
      );
      assert.equal(result.checkpoint, selected);
      assert.throws(() =>
        execFileSync("git", ["-C", result.repository, "cat-file", "-e", migrated.checkpoint], {
          windowsHide: true,
          stdio: "pipe",
        }),
      );
      assert.ok(
        isRecord(result.input.controller) && isRecord(result.input.controller.capacity_attempt),
      );
      const retained = result.input.controller.capacity_attempt;
      assert.ok(isRecord(retained.operation));
      assert.equal(retained.operation.outcome, outcome);
      assert.ok(Array.isArray(retained.prior_operations));
      assert.equal(retained.prior_operations.length, 1);
      await assert.rejects(
        runBoundedCapacityOperation(
          result.repository,
          selected,
          { kind: "upload", destination: "artifact:earlier-A" },
          async () => capacity.boundary,
          async () => {
            assert.fail("must not execute repeated/held effect");
          },
        ),
      );
    },
  );
}
