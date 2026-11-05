import { requireStorageAppToken } from "./release-storage-credential.mts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
  createPreparedCheckpointObjectApi,
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
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "token inert-fixed-history-only");
    return Response.json({ observed: true });
  });
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
    await assert.rejects(() => reader.api.request(method, route), /only fixed repository GET/);
  await assert.rejects(() => reader.api.graphql("mutation{}", {}), /only exact/);
  assert.equal(calls, 0);
  for (let n = 0; n < 9; n++)
    await reader.api.request("GET", "repos/boburning/portcove/actions/jobs/1");
  await assert.rejects(
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
  await assert.rejects(
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
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    clock += 1001;
    return Response.json({ sha: "a".repeat(40) }, { status: 201 });
  });
  const api = createCoordinatorJournalApi(root, clock + 1000);
  await assert.rejects(
    api.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" }),
    /deadline/u,
  );
  assert.equal(calls, 1);
  await assert.rejects(api.request("GET", "repos/boburning/portcove"), /phase deadline/);
  assert.equal(calls, 1);
});

void test("dedicated journal refuses ambient certificate trust and proxy overrides before dispatch", async (t) => {
  const root = await fixture(t);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-journal-trust";
  for (const [key, value] of [
    ["NODE_OPTIONS", "--use-openssl-ca"],
    ["NODE_OPTIONS", "--use-system-ca"],
    ["NODE_OPTIONS", "--use-env-proxy"],
    ["NODE_USE_SYSTEM_CA", "1"],
    ["SSL_CERT_FILE", "/inert/ambient.pem"],
    ["SSL_CERT_DIR", "/inert/ambient-certs"],
  ] as const) {
    const original = process.env[key];
    process.env[key] = value;
    try {
      assert.throws(() => createCoordinatorJournalApi(root), /trusted direct Node runtime/u);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
  assert.deepEqual(await readdir(root), []);
});

void test("dedicated journal aborts an in-flight write at the tighter coordinator deadline", async (t) => {
  const root = await fixture(t);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "inert-journal-nested-deadline";
  let dispatched = 0;
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    dispatched++;
    assert.ok(init?.signal);
    const signal = init.signal;
    return new Promise<Response>((resolve, reject) => {
      const safety = setTimeout(() => resolve(Response.json({ sha: "a".repeat(40) })), 4000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(safety);
          aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const api = createCoordinatorJournalApi(root, performance.now() + 10000);
  await assert.rejects(
    withCoordinatorDeadline(performance.now() + 800, () =>
      api.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" }),
    ),
    { code: "deadline_exceeded" },
  );
  assert.equal(dispatched, 1);
  assert.equal(aborted, true);
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = [
    "GH_TOKEN",
    "PORTCOVE_STORAGE_APP_TOKEN",
    "PORTCOVE_STORAGE_APP_ID",
    "PORTCOVE_STORAGE_INSTALLATION_ID",
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
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "token inert-fixed-job-secret");
    controls.advance();
    if (url.pathname !== "/graphql") return Response.json({ sha: "d".repeat(40) });
    assert.ok(typeof init?.body === "string");
    const payload = JSON.parse(init.body) as {
      query: string;
      variables: { input?: { clientMutationId: string } };
    };
    return Response.json({
      data:
        payload.query === mutation
          ? { updateRefs: { clientMutationId: payload.variables.input!.clientMutationId } }
          : {
              [payload.query === initial ? "repository" : "node"]: {
                __typename: "Repository",
                id: "R_fixture",
                databaseId: controls.repositoryId,
                nameWithOwner: "boburning/portcove",
              },
            },
    });
  });
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
    (await api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`)).status,
    200,
  );
  for (const endpoint of [
    "repos/boburning/portcove",
    "repos/other/repository",
    `repos/boburning/portcove/git/commits/${"9".repeat(40)}`,
    "repos/boburning/portcove/git/refs",
  ])
    await assert.rejects(() => api.request("GET", endpoint), /outside exact checkpoint/);
  await assert.rejects(
    () => api.graphql(f.initial.replace('name:"portcove"', 'name:"other"'), f.refs),
    /outside exact checkpoint/,
  );
  await assert.rejects(
    () => api.graphql(f.initial, { ...f.refs, r3: "refs/heads/main" }),
    /outside exact checkpoint/,
  );
  await api.graphql(f.initial, f.refs);
  await assert.rejects(
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
    await assert.rejects(() => api.graphql(f.mutation, f.cas(changes)), /exact state/);
  assert.equal(f.calls(), 2);
  await assert.rejects(
    () =>
      api.request("POST", "repos/boburning/portcove/git/blobs", {
        content: "x".repeat(2 * 1024 * 1024),
      }),
    /bounded encoding/,
  );
  await assert.rejects(
    () => api.request("POST", "repos/boburning/portcove/git/blobs"),
    /bounded encoding/,
  );
  assert.equal(f.calls(), 2);
  await api.graphql(f.mutation, f.claim);
  assert.equal(f.calls(), 3);
});

void test("fixed-job journal stops late CAS acknowledgment and permits only original bounded tuple readback", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const deadline = clock + 1000;
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, deadline);
  await api.graphql(f.initial, f.refs);
  f.controls.advance = () => {
    clock = deadline + 1;
  };
  await assert.rejects(api.graphql(f.mutation, f.claim), { code: "deadline_exceeded" });
  f.controls.advance = () => {};
  await assert.rejects(() => api.graphql(f.mutation, f.claim), /original deadline/);
  await assert.rejects(
    () => api.request("POST", "repos/boburning/portcove/git/blobs", {}),
    /original deadline/,
  );
  await assert.rejects(
    () => api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`),
    /original deadline/,
  );
  await assert.rejects(api.graphql(f.next, { id: "R_fixture", ...f.refs }), /original deadline/);
  await api.graphql(f.next, { id: "R_fixture", ...f.refs }, { deadline, collecting: true });
  assert.equal(f.calls(), 3);
  clock = deadline + 30000;
  await assert.rejects(
    api.graphql(f.next, { id: "R_fixture", ...f.refs }, { deadline, collecting: true }),
    /collection bound/,
  );
  assert.equal(f.calls(), 3);
});

void test("fixed-job journal never opens collection time before a CAS attempt", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, clock + 1000);
  await api.graphql(f.initial, f.refs);
  const deadline = clock + 1000;
  clock += 1001;
  await assert.rejects(
    api.graphql(f.next, { id: "R_fixture", ...f.refs }, { deadline, collecting: true }),
    /attempted CAS/,
  );
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
  await assert.rejects(() => api.graphql(f.initial, f.refs), /repository identity/);
  f.controls.repositoryId = 1354613114;
  await api.graphql(f.initial, f.refs);
  for (let n = 2; n < 16; n++) await api.graphql(f.next, { id: "R_fixture", ...f.refs });
  await assert.rejects(() => api.graphql(f.next, { id: "R_fixture", ...f.refs }), /request bound/);
  assert.equal(f.calls(), 16);
});
void test("journal SDK captures only its dedicated credential and refuses other routes", async (t) => {
  const root = await fixture(t);
  const token = "disposable-journal-only-secret";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  process.env.GH_TOKEN = "provider-only-secret";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `token ${token}`);
    if (url.pathname === "/repos/boburning/portcove") return Response.json({ ok: true });
    assert.equal(url.pathname, `/repos/boburning/portcove/git/commits/${"a".repeat(40)}`);
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  const api = createCoordinatorJournalApi(root);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "changed-after-construction";
  assert.deepEqual((await api.request("GET", "repos/boburning/portcove")).body, { ok: true });
  assert.deepEqual(
    await api.request("GET", `repos/boburning/portcove/git/commits/${"a".repeat(40)}`),
    {
      status: 404,
      body: undefined,
    },
  );
  for (const [method, route] of [
    ["GET", "https://evil.invalid"],
    ["POST", "repos/boburning/portcove/git/refs"],
    ["GET", "repos/other/repo"],
    ["DELETE", "repos/boburning/portcove"],
  ] as const)
    await assert.rejects(api.request(method, route), /fixed repository/u);
  assert.deepEqual(await readdir(root), []);
  assert.equal(calls, 2);
  assert.equal(process.env.GH_TOKEN, "provider-only-secret");
});
void test("journal SDK sends the exact write once and redacts provider diagnostics", async (t) => {
  const root = await fixture(t);
  const token = "nonstandard-disposable-sensitive-value";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  const body = { content: "inert", encoding: "base64" };
  let calls = 0;
  let echo = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.href, "https://api.github.com/repos/boburning/portcove/git/blobs");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(typeof init.body === "string" ? init.body : ""), body);
    if (echo) return Response.json({ sha: token }, { status: 201 });
    return Response.json({ message: `GitHub unavailable ${token}` }, { status: 503 });
  });
  const api = createCoordinatorJournalApi(root);
  await assert.rejects(
    api.request("POST", "repos/boburning/portcove/git/blobs", body),
    (error: unknown) => {
      assert.equal(inspect(error, { depth: 10 }).includes(token), false);
      assert.match(String(error), /GitHub unavailable/u);
      return true;
    },
  );
  assert.equal(calls, 1);
  echo = true;
  await assert.rejects(
    api.request("POST", "repos/boburning/portcove/git/blobs", body),
    /contained credential material/u,
  );
  assert.equal(calls, 2);
});

void test("fixed-job collection survives inherited execution expiry only for exact post-CAS tuple GET", async (t) => {
  const f = await jobFixture(t);
  let clock = performance.now();
  t.mock.method(performance, "now", () => clock);
  const deadline = clock + 1000;
  const api = createCheckpointJobTokenApi(f.root, f.checkpoint, f.configuration, deadline);
  await assert.rejects(
    withCoordinatorDeadline(deadline, async () => {
      await api.graphql(f.initial, f.refs);
      await api.graphql(f.mutation, f.claim);
      clock = deadline + 1;
      await assert.rejects(() => api.graphql(f.mutation, f.claim), /original deadline/);
      await assert.rejects(
        () => api.request("GET", `repos/boburning/portcove/git/commits/${"f".repeat(40)}`),
        /original deadline/,
      );
      await api.graphql(f.next, { id: "R_fixture", ...f.refs }, { deadline, collecting: true });
      assert.equal(f.calls(), 3, "exact collection query dispatched through the SDK");
    }),
    /phase deadline/,
  );
  assert.equal(f.calls(), 3);
});

void test("new storage token cannot borrow a job/legacy credential or mismatched App installation", () => {
  const expected = { app_id: 90001, installation_id: 90002 };
  const environment = {
    GH_TOKEN: "job-token",
    PORTCOVE_COORDINATOR_JOURNAL_TOKEN: "legacy-token",
    PORTCOVE_CONTROL_APP_TOKEN: "observer-token",
    PORTCOVE_STORAGE_APP_TOKEN: "new-storage-token",
    PORTCOVE_STORAGE_APP_ID: "90001",
    PORTCOVE_STORAGE_INSTALLATION_ID: "90002",
  };
  assert.equal(requireStorageAppToken(expected, environment), "new-storage-token");
  for (const changed of [
    { ...environment, PORTCOVE_STORAGE_APP_TOKEN: undefined },
    { ...environment, PORTCOVE_STORAGE_APP_TOKEN: "job-token" },
    { ...environment, PORTCOVE_STORAGE_APP_TOKEN: "legacy-token" },
    { ...environment, PORTCOVE_STORAGE_APP_TOKEN: "observer-token" },
    { ...environment, PORTCOVE_STORAGE_APP_TOKEN: "bad token" },
    { ...environment, PORTCOVE_STORAGE_APP_ID: "15368" },
    { ...environment, PORTCOVE_STORAGE_INSTALLATION_ID: "90003" },
  ])
    assert.throws(() => requireStorageAppToken(expected, changed));
});
void test("dedicated storage checkpoint adapter isolates the new token and preserves endpoint/deadline restrictions", async (t) => {
  const root = await fixture(t);
  const { checkpoint, configuration } = checkpointProofFixture();
  process.env.GH_TOKEN = "job-read-only-here";
  process.env.PORTCOVE_STORAGE_APP_TOKEN = "dedicated-storage-token";
  process.env.PORTCOVE_STORAGE_APP_ID = "90001";
  process.env.PORTCOVE_STORAGE_INSTALLATION_ID = "90002";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "token dedicated-storage-token");
    return Response.json({ observed: true }, { status: 201 });
  });
  const api = createCheckpointJobTokenApi(
    root,
    checkpoint,
    configuration,
    performance.now() + 1000,
    { app_id: 90001, installation_id: 90002 },
  );
  for (const route of [
    "repos/boburning/portcove/releases",
    "repos/other/repo/git/blobs",
    "repos/boburning/portcove/actions/jobs/1",
  ])
    await assert.rejects(() => api.request("POST", route, {}));
  assert.equal(calls, 0);
  await api.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" });
  assert.equal(calls, 1);
  const prepared = createPreparedCheckpointObjectApi(root, performance.now() + 1000, {
    app_id: 90001,
    installation_id: 90002,
  });
  await assert.rejects(() => prepared.request("POST", "repos/boburning/portcove/git/refs", {}));
  assert.throws(() => prepared.graphql("mutation { updateRefs }", {}));
  assert.equal(calls, 1);
  await prepared.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" });
  assert.equal(calls, 2);
  assert.equal(process.env.GH_TOKEN, "job-read-only-here");
});
