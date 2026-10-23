import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  createCoordinatorJournalApi,
  createCheckpointJobTokenApi,
  createCheckpointHistoryReader,
} from "./release-coordinator-journal-api.mts";
import { performance } from "node:perf_hooks";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { createHash } from "node:crypto";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

void test("history transport admits only bounded GET evidence and never opens collection time", async (t) => {
  const root = await fixture(t);
  process.env.GH_TOKEN = "inert-fixed-history-only";
  const { checkpoint, configuration } = checkpointProofFixture();
  let clock = performance.now(),
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(childProcess, "spawnSync", () => {
    calls++;
    return { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"observed":true}', stderr: "" };
  });
  syncBuiltinESMExports();
  const deadline = clock + 1000;
  const reader = createCheckpointHistoryReader(
    root,
    checkpoint.checkpoint,
    configuration,
    deadline,
  );
  for (const [method, route] of [
    ["POST", "repos/boburning/portcove/git/blobs"],
    ["GET", "repos/boburning/portcove/actions/jobs/01"],
    ["GET", "repos/other/repo/actions/jobs/1"],
    ["GET", "repos/boburning/portcove/actions/runs/1"],
  ] as const)
    assert.throws(() => reader.api.request(method, route), /only fixed repository GET/);
  assert.throws(() => reader.api.graphql("mutation{}", {}), /only exact/);
  assert.equal(calls, 0);
  for (let n = 0; n < 9; n++) reader.api.request("GET", "repos/boburning/portcove/actions/jobs/1");
  assert.throws(
    () => reader.api.request("GET", "repos/boburning/portcove/actions/jobs/1"),
    /request bound/,
  );
  assert.equal(calls, 9);
  const expiring = createCheckpointHistoryReader(
    root,
    checkpoint.checkpoint,
    configuration,
    deadline,
  );
  clock = deadline + 1;
  assert.throws(
    () => expiring.api.request("GET", "repos/boburning/portcove/actions/jobs/1"),
    /original deadline/,
  );
  assert.equal(calls, 9);
});

void test("journal transport shares one role deadline and refuses late write responses without retry", async (t) => {
  const root = await fixture(t);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "disposable-journal-only-secret";
  let clock = Math.floor(performance.now()),
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  assert.throws(() => createCoordinatorJournalApi(root, clock - 1), /phase deadline/);
  assert.throws(() => createCoordinatorJournalApi(root, Infinity), /must be finite/);
  assert.deepEqual(await readdir(root), []);
  t.mock.method(
    childProcess,
    "spawnSync",
    (_command: string, _args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls++;
      assert.equal(options.timeout, 1000);
      clock += 1001;
      return {
        status: 0,
        stdout: 'HTTP/2.0 201 Created\r\n\r\n{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root, clock + 1000);
  assert.throws(
    () => api.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" }),
    /phase deadline/,
  );
  assert.equal(calls, 1);
  assert.throws(() => api.request("GET", "repos/boburning/portcove"), /phase deadline/);
  assert.equal(calls, 1);
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = [
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
    "HTTPS_PROXY",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "PORTCOVE_PROTECTION_OBSERVER_TOKEN",
    "PORTCOVE_SEMANTIC_TOKEN",
  ];
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return root;
}
void test("journal transport refuses provider-token fallback before any subprocess", async (t) => {
  const root = await fixture(t);
  delete process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  process.env.GH_TOKEN = "provider-credential-must-not-authorize-journal";
  t.mock.method(childProcess, "spawnSync", () => assert.fail("no journal credential"));
  syncBuiltinESMExports();
  assert.throws(
    () => createCoordinatorJournalApi(root),
    /dedicated coordinator journal credential/u,
  );
  assert.deepEqual(await readdir(root), []);
});

async function jobFixture(t: test.TestContext) {
  const root = await fixture(t);
  const { checkpoint, configuration } = checkpointProofFixture();
  checkpoint.required_commits.push({ oid: "f".repeat(40), tree: "a".repeat(40) });
  process.env.GH_TOKEN = "inert-fixed-job-secret";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "excluded-legacy-secret";
  process.env.PORTCOVE_PROTECTION_OBSERVER_TOKEN = "excluded-administration-secret";
  process.env.PORTCOVE_SEMANTIC_TOKEN = "excluded-checks-secret";
  const names = [
    "refs/heads/portcove-fixture-coordinator-state",
    `refs/tags/portcove-fixture-checkpoint-intent/${checkpoint.previous!}`,
    `refs/tags/portcove-fixture-checkpoint-proof/${checkpoint.checkpoint}`,
  ];
  const refs = Object.fromEntries(names.map((name, i) => [`r${i}`, name]));
  const fields = names
    .map((_, i) => `r${i}:ref(qualifiedName:$r${i}){name prefix target{__typename oid}}`)
    .join(" ");
  const declarations = "$r0:String!,$r1:String!,$r2:String!";
  const initial = `query(${declarations}){repository(owner:"boburning",name:"portcove"){__typename id databaseId nameWithOwner ${fields}}}`;
  const next = `query($id:ID!,${declarations}){node(id:$id){__typename ... on Repository{id databaseId nameWithOwner ${fields}}}}`;
  const mutation = "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}";
  const cas = (refUpdates: Record<string, unknown>[]) => ({
    input: {
      repositoryId: "R_fixture",
      refUpdates,
      clientMutationId: createHash("sha256")
        .update(JSON.stringify({ nodeId: "R_fixture", refs: refUpdates }))
        .digest("hex"),
    },
  });
  const claim = cas([
    { name: names[0], beforeOid: checkpoint.previous, afterOid: checkpoint.previous, force: false },
    { name: names[1], beforeOid: "0".repeat(40), afterOid: checkpoint.checkpoint, force: false },
  ]);
  let calls = 0;
  const controls = { advance: () => {}, repositoryId: 1354613114 };
  t.mock.method(
    childProcess,
    "spawnSync",
    (_command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls++;
      assert.equal(options.env?.GH_TOKEN, "inert-fixed-job-secret");
      for (const key of [
        "PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
        "PORTCOVE_PROTECTION_OBSERVER_TOKEN",
        "PORTCOVE_SEMANTIC_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      ])
        assert.equal(options.env?.[key], undefined);
      assert.equal(path.dirname(options.env.GH_CONFIG_DIR!), root);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.ok(options.timeout! > 0 && options.timeout! <= 15000);
      assert.equal(inspect(args).includes("inert-fixed-job-secret"), false);
      controls.advance();
      let body: unknown = { sha: "d".repeat(40) };
      if (args[1] === "graphql") {
        assert.equal(typeof options.input, "string");
        assert.ok(typeof options.input === "string");
        const input = JSON.parse(options.input) as {
          query: string;
          variables: { input?: { clientMutationId: string } };
        };
        body = {
          data:
            input.query === mutation
              ? { updateRefs: { clientMutationId: input.variables.input!.clientMutationId } }
              : {
                  [input.query === initial ? "repository" : "node"]: {
                    __typename: "Repository",
                    id: "R_fixture",
                    databaseId: controls.repositoryId,
                    nameWithOwner: "boburning/portcove",
                  },
                },
        };
      }
      return { status: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
    },
  );
  syncBuiltinESMExports();
  return {
    root,
    checkpoint,
    configuration,
    initial,
    next,
    mutation,
    refs,
    claim,
    cas,
    controls,
    calls: () => calls,
  };
}

void test("fixed-job journal refuses missing job token without App fallback or filesystem effects", async (t) => {
  const f = await jobFixture(t);
  delete process.env.GH_TOKEN;
  assert.throws(
    () =>
      createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, performance.now() + 1000),
    /fixed-job journal credential/,
  );
  assert.equal(f.calls(), 0);
  assert.deepEqual(await readdir(f.root), []);
});

void test("fixed-job journal freezes its credential and exact tuple; foreign reads and mutations never reach provider", async (t) => {
  const f = await jobFixture(t);
  const api = createCheckpointJobTokenApi(
    f.root,
    f.checkpoint,
    f.configuration,
    performance.now() + 10000,
  );
  process.env.GH_TOKEN = "changed-after-capture";
  f.checkpoint.required_commits[0]!.oid = "9".repeat(40);
  assert.equal(
    api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`).status,
    200,
  );
  for (const endpoint of [
    "repos/boburning/portcove",
    "repos/other/repository",
    `repos/boburning/portcove/git/commits/${"9".repeat(40)}`,
    "repos/boburning/portcove/git/refs",
  ])
    assert.throws(() => api.request("GET", endpoint), /outside exact checkpoint/);
  assert.throws(
    () => api.graphql(f.initial.replace('name:"portcove"', 'name:"other"'), f.refs),
    /outside exact checkpoint/,
  );
  assert.throws(
    () => api.graphql(f.initial, { ...f.refs, r3: "refs/heads/main" }),
    /outside exact checkpoint/,
  );
  api.graphql(f.initial, f.refs);
  assert.throws(
    () => api.graphql(f.next, { id: "foreign", ...f.refs }),
    /outside exact checkpoint/,
  );
  for (const changes of [
    [
      {
        name: "refs/heads/main",
        beforeOid: "0".repeat(40),
        afterOid: "a".repeat(40),
        force: false,
      },
    ],
    f.claim.input.refUpdates.map((ref) => ({ ...ref, force: true })),
    f.claim.input.refUpdates.map((ref) => ({ ...ref, afterOid: "0".repeat(40) })),
    [...f.claim.input.refUpdates, f.claim.input.refUpdates[0]!],
  ])
    assert.throws(() => api.graphql(f.mutation, f.cas(changes)), /exact state/);
  assert.equal(f.calls(), 2);
  assert.throws(
    () =>
      api.request("POST", "repos/boburning/portcove/git/blobs", {
        content: "x".repeat(2 * 1024 * 1024),
      }),
    /bounded encoding/,
  );
  assert.throws(
    () => api.request("POST", "repos/boburning/portcove/git/blobs"),
    /bounded encoding/,
  );
  assert.equal(f.calls(), 2);
  api.graphql(f.mutation, f.claim);
  assert.equal(f.calls(), 3);
});

void test("fixed-job journal retains late CAS acknowledgment, then permits only original bounded tuple readback", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const deadline = clock + 1000;
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, deadline);
  api.graphql(f.initial, f.refs);
  f.controls.advance = () => {
    clock = deadline + 1;
  };
  assert.ok(
    api.graphql(f.mutation, f.claim).data,
    "late acknowledgment remains available to exchange",
  );
  f.controls.advance = () => {};
  assert.throws(() => api.graphql(f.mutation, f.claim), /original deadline/);
  assert.throws(
    () => api.request("POST", "repos/boburning/portcove/git/blobs", {}),
    /original deadline/,
  );
  assert.throws(
    () => api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`),
    /original deadline/,
  );
  api.graphql(f.next, { id: "R_fixture", ...f.refs });
  assert.equal(f.calls(), 3);
  clock = deadline + 30000;
  assert.throws(() => api.graphql(f.next, { id: "R_fixture", ...f.refs }), /original deadline/);
  assert.equal(f.calls(), 3);
});

void test("fixed-job journal never opens collection time before a CAS attempt", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, clock + 1000);
  api.graphql(f.initial, f.refs);
  clock += 1001;
  assert.throws(() => api.graphql(f.next, { id: "R_fixture", ...f.refs }), /original deadline/);
  assert.equal(f.calls(), 1);
});

void test("fixed-job journal refuses foreign repository observation and enforces total request bound", async (t) => {
  const f = await jobFixture(t);
  const api = createCheckpointJobTokenApi(
    f.root,
    f.checkpoint,
    f.configuration,
    performance.now() + 10000,
  );
  f.controls.repositoryId = 1;
  assert.throws(() => api.graphql(f.initial, f.refs), /repository identity/);
  f.controls.repositoryId = 1354613114;
  api.graphql(f.initial, f.refs);
  for (let n = 2; n < 16; n++) api.graphql(f.next, { id: "R_fixture", ...f.refs });
  assert.throws(() => api.graphql(f.next, { id: "R_fixture", ...f.refs }), /request bound/);
  assert.equal(f.calls(), 16);
});
void test("journal subprocess receives only its frozen dedicated credential and private configuration", async (t) => {
  const root = await fixture(t);
  const token = "disposable-journal-only-secret";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  process.env.GH_TOKEN = "provider-only-secret";
  process.env.GH_ENTERPRISE_TOKEN = "enterprise-secret";
  process.env.HTTPS_PROXY = "http://must-not-inherit.invalid";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-secret";
  let calls = 0;
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls++;
      assert.equal(command, "gh");
      assert.ok(options.env);
      assert.ok(typeof options.env.GH_CONFIG_DIR === "string");
      assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
      assert.equal(options.env.GH_TOKEN, token);
      assert.equal(options.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
      assert.equal(options.env.GH_ENTERPRISE_TOKEN, undefined);
      assert.equal(options.env.HTTPS_PROXY, undefined);
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(options.env.GH_HOST, "github.com");
      assert.equal(path.dirname(options.env.GH_CONFIG_DIR), root);
      assert.equal(options.env.HOME, options.env.GH_CONFIG_DIR);
      assert.equal(options.env.APPDATA, options.env.GH_CONFIG_DIR);
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.equal(options.windowsHide, true);
      assert.equal(inspect(args).includes(token), false);
      return { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"ok":true}', stderr: "" };
    },
  );
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "changed-after-construction";
  assert.deepEqual(api.request("GET", "repos/boburning/portcove").body, { ok: true });
  for (const [method, route] of [
    ["GET", "https://evil.invalid"],
    ["POST", "repos/boburning/portcove/git/refs"],
    ["GET", "repos/other/repo"],
    ["DELETE", "repos/boburning/portcove"],
  ] as const)
    assert.throws(() => api.request(method, route), /fixed repository/u);
  assert.equal(calls, 1);
  assert.equal(process.env.GH_TOKEN, "provider-only-secret");
});
void test("journal subprocess diagnostics redact its exact credential without losing timeout ambiguity", async (t) => {
  const root = await fixture(t);
  const token = "nonstandard-disposable-sensitive-value";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: token,
    stderr: token,
    error: Object.assign(new Error(token), { code: "ETIMEDOUT" }),
  }));
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root);
  assert.throws(
    () =>
      api.request("POST", "repos/boburning/portcove/git/blobs", {
        content: "inert",
        encoding: "utf-8",
      }),
    (error: unknown) => {
      assert.equal(inspect(error, { depth: 10 }).includes(token), false);
      assert.match(String(error), /timed out/u);
      return true;
    },
  );
});

void test("fixed-job collection survives inherited execution expiry only for exact post-CAS tuple GET", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const deadline = clock + 1000;
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, deadline);
  await assert.rejects(
    withCoordinatorDeadline(deadline, async () => {
      api.graphql(f.initial, f.refs);
      api.graphql(f.mutation, f.claim);
      clock = deadline + 1;
      assert.throws(() => api.graphql(f.mutation, f.claim), /original deadline/);
      assert.throws(
        () => api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`),
        /original deadline/,
      );
      api.graphql(f.next, { id: "R_fixture", ...f.refs });
      assert.equal(f.calls(), 3, "exact collection query reached the fixed child");
    }),
    /phase deadline/,
  );
  assert.equal(f.calls(), 3);
});
