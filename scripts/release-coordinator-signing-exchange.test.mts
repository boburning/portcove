import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { CoordinatorRemoteError } from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { performance } from "node:perf_hooks";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { authenticateCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-authentication.mts";
import { publishCoordinatorSigningExchange } from "./release-coordinator-signing-exchange.mts";
import { createCheckpointJobTokenApi } from "./release-coordinator-journal-api.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  authenticateCapacityExecutor,
  createOwnedCheckpointSigningApi,
} from "./release-capacity-executor.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
  jwk as identityJwk,
} from "./fixtures/assembler-identity-fixture.mts";
import { capacityExecutorJobProfile } from "./assembler-job-identity.mts";

import { remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";

async function signingExchangeFixture(
  t: test.TestContext,
  fault = "",
  now?: string,
  jobToken = false,
) {
  const f = await remoteFixture(t, now),
    proof = checkpointProofFixture(f.checkpoint, f.config);
  const directory = await mkdtemp(path.join(os.tmpdir(), "coordinator-signing-exchange-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousToken = process.env.GH_TOKEN,
    actualSpawn = childProcess.spawnSync;
  process.env.GH_TOKEN = "inert-checkpoint-reader";
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options?: childProcess.SpawnSyncOptions) => {
      if (command !== "gh") return actualSpawn(command, args, options);
      if (args[0] === "attestation")
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: proof.verification }]),
          stderr: "",
        };
      if (String(options?.env?.GH_CONFIG_DIR).startsWith(path.join(directory, "journal-api-"))) {
        assert.equal(options?.env?.GH_TOKEN, "inert-checkpoint-reader");
        assert.ok(options?.input === undefined || typeof options.input === "string");
        const input: unknown = options?.input === undefined ? undefined : JSON.parse(options.input);
        let body: unknown,
          status = 200;
        if (args[1] === "graphql") {
          assert.ok(
            isRecord(input) && typeof input.query === "string" && isRecord(input.variables),
          );
          body = api.graphql(input.query, input.variables);
        } else {
          const response = api.request(args[args.indexOf("--method") + 1]!, args[2]!, input);
          body = response.body;
          status = response.status!;
        }
        return {
          status: 0,
          stdout: `HTTP/2.0 ${status} Fixture\r\n\r\n${JSON.stringify(body)}`,
          stderr: "",
        };
      }
      const response = proof.api.request("GET", args[2]!);
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(response.body)}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  const intent = `refs/tags/portcove-fixture-checkpoint-intent/${f.initial.checkpoint}`;
  if (fault === "object-after") f.faults.object = "evidence-commits";
  let calls = 0,
    mutations = 0,
    produces = 0;
  let gateDrained = false;
  const hooks: { refresh: (stage: string) => Promise<void> } = { async refresh() {} };
  const events: string[] = [],
    zero = "0".repeat(40);
  const api: CoordinatorRemoteApi = {
    request(method, endpoint, body) {
      calls++;
      return f.api.request(method, endpoint, body);
    },
    graphql(query, variables) {
      calls++;
      if (!query.startsWith("mutation")) {
        const result = f.api.graphql(query, variables);
        if (query.includes('repository(owner:"boburning",name:"portcove")')) {
          assert.ok(isRecord(result.data));
          return { data: { repository: result.data.node } };
        }
        return result;
      }
      mutations++;
      assert.ok(isRecord(variables.input) && Array.isArray(variables.input.refUpdates));
      const input = variables.input,
        updates = input.refUpdates;
      assert.ok(Array.isArray(updates));
      assert.equal(input.repositoryId, "R_fixture");
      assert.equal(
        new Set(updates.map((u: unknown) => (isRecord(u) ? u.name : null))).size,
        updates.length,
      );
      for (const update of updates) {
        assert.ok(isRecord(update));
        assert.equal(update.force, false);
        if ((f.refs.get(String(update.name)) ?? zero) !== update.beforeOid)
          throw new Error("atomic fixture preimage conflict");
        assert.notEqual(update.afterOid, zero);
      }
      if (mutations === 1) {
        assert.equal(updates.length, 2);
        assert.deepEqual(
          updates.map((u: unknown) => (isRecord(u) ? [u.name, u.afterOid] : null)),
          [
            [f.stateRef, f.initial.checkpoint],
            [intent, f.saved.checkpoint],
          ],
        );
        assert.equal(f.counts().posts, 3);
        if (fault === "claim-before") throw new Error("claim response lost before effect");
      } else {
        assert.equal(f.counts().posts, 7);
        assert.equal(events.filter((event) => event.startsWith("post:")).length, 2);
        assert.equal(events.at(-1), "refresh:commit");
      }
      for (const update of updates) {
        assert.ok(isRecord(update));
        if (fault !== "partial-final" || !String(update.name).includes("checkpoint-proof/"))
          f.refs.set(String(update.name), String(update.afterOid));
      }
      if (
        (mutations === 1 && fault === "claim-after") ||
        (mutations === 2 && ["final-after", "partial-final"].includes(fault))
      )
        throw new Error("response lost after effects");
      if (mutations === 1 && fault === "claim-ack")
        return { data: { updateRefs: { clientMutationId: "wrong" } } };
      return { data: { updateRefs: { clientMutationId: input.clientMutationId } } };
    },
  };
  const deadline = performance.now() + 60000;
  const transport = jobToken
    ? createCheckpointJobTokenApi(directory, f.checkpoint, f.config, deadline)
    : api;
  let retainedGate: ((stage: "fulcio" | "rekor") => Promise<void>) | undefined;
  const run = () =>
    withReadOnlyReleaseChildren(directory, () =>
      publishCoordinatorSigningExchange(f.bare, f.saved.checkpoint, f.config, deadline, {
        api: transport,
        async refresh(stage) {
          events.push(`refresh:${stage}`);
          await hooks.refresh(stage);
          if (fault === "unawaited" && stage === "fulcio") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            gateDrained = true;
          }
          if (fault === `refuse-${stage}`)
            throw new Error("actual session/control fixture refused");
        },
        async produce(checkpoint, configuration, beforePost) {
          produces++;
          retainedGate = beforePost;
          assert.equal(
            f.refs.get(f.stateRef),
            f.initial.checkpoint,
            "unsigned state never advanced",
          );
          assert.equal(f.refs.get(intent), f.saved.checkpoint);
          assert.equal(checkpoint.checkpoint, f.saved.checkpoint);
          if (fault === "producer-refuse")
            throw new Error("signer/provider refusal after durable claim");
          if (fault === "no-posts")
            return {} as Awaited<ReturnType<typeof authenticateCoordinatorCheckpointEvidence>>;
          if (fault === "unawaited") {
            void beforePost("fulcio");
            return {} as Awaited<ReturnType<typeof authenticateCoordinatorCheckpointEvidence>>;
          }
          if (fault === "concurrent-gates")
            await Promise.all([beforePost("fulcio"), beforePost("fulcio")]);
          if (fault === "wrong-order") await beforePost("rekor");
          for (const stage of ["fulcio", "rekor"] as const) {
            if (fault === `changed-${stage}`) f.refs.set(f.stateRef, "e".repeat(40));
            await beforePost(stage);
            events.push(`post:${stage}`);
          }
          if (fault === "bad-proof")
            proof.verification.signature.certificate.issuer = "https://wrong.invalid";
          return authenticateCoordinatorCheckpointEvidence(
            directory,
            checkpoint,
            configuration,
            proof.evidence,
            proof.expected,
            deadline,
          );
        },
      }),
    );
  return {
    ...f,
    api,
    run,
    proof,
    deadline,
    directory,
    intent,
    events,
    hooks,
    gate: () => retainedGate,
    stats: () => ({ calls, mutations, produces, gateDrained }),
  };
}

for (const fault of ["", "claim-after", "final-after", "partial-final"]) {
  void test(`fixed-job token exchange ${fault || "complete"} uses exact tuple transport and preserves effects`, async (t) => {
    const f = await signingExchangeFixture(t, fault, undefined, true);
    if (fault === "claim-after" || fault === "partial-final") {
      await assert.rejects(f.run(), CoordinatorRemoteError);
      assert.equal(f.stats().produces, fault === "claim-after" ? 0 : 1);
    } else {
      const result = await f.run();
      assert.equal(result.requests, 16);
      assert.equal(result.recovered, fault === "final-after");
    }
    assert.equal(f.refs.get(f.intent), f.saved.checkpoint);
  });
}

void test("same-journal signing claims its predecessor without advancing unsigned head and commits authenticated proof in sixteen requests", async (t) => {
  const f = await signingExchangeFixture(t);
  const result = await f.run();
  assert.equal(result.requests, 16);
  assert.equal(f.stats().calls, 16);
  assert.equal(result.recovered, false);
  assert.equal(result.authority, "none");
  assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
  assert.equal(f.refs.get(f.intent), f.saved.checkpoint, "permanent claim retained");
  assert.deepEqual(f.events, [
    "refresh:claim",
    "refresh:claim",
    "refresh:fulcio",
    "post:fulcio",
    "refresh:rekor",
    "post:rekor",
    "refresh:commit",
  ]);
  await assert.rejects(f.gate()!("fulcio"), /stopped/);
  await assert.rejects(f.run(), CoordinatorRemoteError);
  assert.equal(f.stats().produces, 1, "completed or retained intent is never reminted");
});

for (const fault of [
  "claim-before",
  "claim-after",
  "claim-ack",
  "producer-refuse",
  "no-posts",
  "wrong-order",
  "changed-fulcio",
  "changed-rekor",
  "refuse-claim",
  "refuse-fulcio",
  "refuse-rekor",
  "refuse-commit",
  "bad-proof",
  "partial-final",
  "unawaited",
  "concurrent-gates",
  "object-after",
]) {
  void test(`same-journal ${fault} retains actual effects and refuses further signing/advancement`, async (t) => {
    const f = await signingExchangeFixture(t, fault);
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.automatic_retry, false);
      assert.ok(Number(error.evidence.requests) <= 16);
      if (fault === "object-after") {
        assert.ok(Array.isArray(error.evidence.objects));
        const last: unknown = error.evidence.objects.at(-1);
        assert.ok(isRecord(last));
        assert.equal(last.kind, "commits");
        assert.equal(last.observed, null, "lost acknowledgment stays ambiguous");
        assert.equal(error.evidence.objects.length, 7);
      }
      return true;
    });
    if (fault.startsWith("claim-") || fault === "refuse-claim") assert.equal(f.stats().produces, 0);
    if (!fault.startsWith("changed-") && fault !== "partial-final")
      assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
    if (["claim-after", "claim-ack", "producer-refuse"].includes(fault)) {
      assert.equal(f.refs.get(f.intent), f.saved.checkpoint);
      const before = f.stats().produces;
      await assert.rejects(f.run(), CoordinatorRemoteError);
      assert.equal(f.stats().produces, before);
    }
    if (fault === "partial-final") {
      assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint, "known partial effect preserved");
      assert.equal(
        f.refs.has(`refs/tags/portcove-fixture-checkpoint-proof/${f.saved.checkpoint}`),
        false,
      );
    }
    if (fault === "unawaited")
      assert.equal(f.stats().gateDrained, true, "pending gate drained before refusal returns");
    if (["unawaited", "concurrent-gates"].includes(fault))
      assert.equal(f.events.filter((event) => event.startsWith("post:")).length, 0);
  });
}

void test("ambiguous final CAS can resolve only by exact full-tuple readback with its retained proof", async (t) => {
  const f = await signingExchangeFixture(t, "final-after");
  const result = await f.run();
  assert.equal(result.recovered, true);
  assert.equal(result.requests, 16);
  assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
});

for (const expires of ["first-object", "proof-object", "before-final", "final-response"]) {
  void test(`signing exchange ${expires} expiry retains its true phase and completed effects`, async (t) => {
    const f = await signingExchangeFixture(t);
    let clock = performance.now(),
      posts = 0;
    t.mock.method(performance, "now", () => clock);
    const request = f.api.request.bind(f.api),
      graphql = f.api.graphql.bind(f.api);
    f.api.request = (method, endpoint, body) => {
      const result = request(method, endpoint, body);
      if (method === "POST") {
        posts++;
        if (
          (expires === "first-object" && posts === 1) ||
          (expires === "proof-object" && posts === 4)
        )
          clock = f.deadline + 1;
      }
      return result;
    };
    f.hooks.refresh = async (stage) => {
      if (expires === "before-final" && stage === "commit") clock = f.deadline + 1;
    };
    f.api.graphql = (query, variables) => {
      const result = graphql(query, variables);
      if (expires === "final-response" && query.startsWith("mutation") && f.stats().mutations === 2)
        clock = f.deadline + 1;
      return result;
    };
    if (expires === "final-response") {
      const result = await f.run();
      assert.equal(result.recovered, true, "late response stays ambiguous until exact readback");
      assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
    } else {
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        assert.ok(Array.isArray(error.evidence.objects));
        const last: unknown = error.evidence.objects.at(-1);
        assert.ok(isRecord(last));
        assert.equal(last.status, 201);
        assert.equal(
          last.observed,
          last.expected,
          "late positive object acknowledgment retained without admitting a later mutation",
        );
        return true;
      });
      assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
      assert.equal(posts, expires === "first-object" ? 1 : expires === "proof-object" ? 4 : 7);
    }
  });
}

void test("competing different checkpoints cannot acquire two signing intents for the same predecessor", async (t) => {
  const first = await signingExchangeFixture(t, "producer-refuse");
  await assert.rejects(first.run(), CoordinatorRemoteError);
  const second = await remoteFixture(t, "2026-09-14T12:00:01.000Z");
  assert.equal(second.initial.checkpoint, first.initial.checkpoint);
  assert.notEqual(second.saved.checkpoint, first.saved.checkpoint);
  let produced = false;
  await assert.rejects(
    publishCoordinatorSigningExchange(
      second.bare,
      second.saved.checkpoint,
      second.config,
      performance.now() + 60000,
      {
        api: first.api,
        async refresh() {
          assert.fail("existing predecessor claim must refuse before mutation");
        },
        async produce() {
          produced = true;
          assert.fail("foreign claim cannot appoint producer");
        },
      },
    ),
    CoordinatorRemoteError,
  );
  assert.equal(produced, false);
  assert.equal(first.refs.get(first.intent), first.saved.checkpoint);
});

void test("owned fixed-job factory freezes namespace across actual identity refresh before exporting checkpoint", async (t) => {
  const f = await remoteFixture(t);
  const expected = {
    ...identityExpected,
    audience: "portcove-capacity-executor",
    subject:
      "repo:boburning@43177418/portcove@1354613114:environment:production-release-coordinator",
  };
  const identity = assemblerIdentityFixture(
    {
      aud: expected.audience,
      sub: expected.subject,
      environment: "production-release-coordinator",
    },
    {},
    capacityExecutorJobProfile("coordinator"),
  );
  const saved = new Map(
    ["GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.GH_TOKEN = "inert-owned-job-token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://fixture.actions.githubusercontent.com/oidc";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "inert-runner-token";
  const actualSpawn = childProcess.spawnSync;
  let mutate = false,
    journalCalls = 0;
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    if (mutate) f.config.namespace = "portcove-foreign";
    return new Response(JSON.stringify({ value: identity.token }));
  });
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      if (command !== "gh") return actualSpawn(command, args, options);
      if (args[1] !== "graphql") return identity.transport.spawn(command, args, options);
      journalCalls++;
      assert.equal(options.env?.GH_TOKEN, "inert-owned-job-token");
      assert.ok(typeof options.input === "string");
      const input: unknown = JSON.parse(options.input);
      assert.ok(isRecord(input) && typeof input.query === "string" && isRecord(input.variables));
      assert.ok(
        Object.values(input.variables).every(
          (value) =>
            typeof value === "string" &&
            value.startsWith("refs/") &&
            value.includes("portcove-fixture"),
        ),
      );
      const response = f.api.graphql(input.query, input.variables);
      assert.ok(isRecord(response.data));
      return {
        status: 0,
        stdout: `HTTP/2.0 200 Fixture\r\n\r\n${JSON.stringify({ data: { repository: response.data.node } })}`,
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  const deadline = performance.now() + 60000;
  const session = await authenticateCapacityExecutor(
    "coordinator",
    expected,
    f.repository,
    deadline,
  );
  mutate = true;
  const api = await createOwnedCheckpointSigningApi(session, f.bare, f.saved.checkpoint, f.config);
  assert.equal(f.config.namespace, "portcove-foreign", "mutation occurred during awaited refresh");
  const names = [
    f.stateRef,
    ...f.checkpoint.receipts.map((receipt) =>
      receipt.local_ref.startsWith("refs/portcove/prepared-versions/")
        ? `refs/tags/portcove-fixture-prepared/${receipt.local_ref.slice("refs/portcove/prepared-versions/".length)}`
        : `refs/tags/portcove-fixture-prepared-source/${receipt.local_ref.slice("refs/portcove/prepared-commits/".length)}`,
    ),
    `refs/tags/portcove-fixture-checkpoint-intent/${f.checkpoint.previous!}`,
    `refs/tags/portcove-fixture-checkpoint-proof/${f.checkpoint.checkpoint}`,
  ];
  const declarations = names.map((_, i) => `$r${i}:String!`).join(",");
  const fields = names
    .map((_, i) => `r${i}:ref(qualifiedName:$r${i}){name prefix target{__typename oid}}`)
    .join(" ");
  api.graphql(
    `query(${declarations}){repository(owner:"boburning",name:"portcove"){__typename id databaseId nameWithOwner ${fields}}}`,
    Object.fromEntries(names.map((name, i) => [`r${i}`, name])),
  );
  assert.equal(journalCalls, 1);
  identity.faults.value = "job-completed";
  await assert.rejects(
    createOwnedCheckpointSigningApi(session, f.bare, f.saved.checkpoint, f.config),
    /job/,
  );
  assert.equal(journalCalls, 1, "completed executor cannot obtain another journal transport");
});
