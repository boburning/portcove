import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { GitHubApiError } from "./github-operation.mts";
import {
  createReleaseCustodyProvider,
  type ImmutableReleaseMetadataProvider,
} from "./release-custody-provider.mts";
import {
  inspectImmutableReleaseSettlement,
  proposeImmutableReleaseTransition,
  readImmutableReleaseState,
  performImmutableReleaseEffect,
  advanceImmutableReleasePublication,
  verifyPreparedImmutableRelease,
  advanceOwnedImmutableReleasePublication,
  observeOwnedImmutableReleaseCompletion,
  requireOwnedImmutableReleaseCompletion,
  rebindPreparedImmutableReleaseAfterPhase,
} from "./release-immutable-publication.mts";

void test("bounded immutable writes retain late successful responses as unresolved and never start after expiry", async (t) => {
  let clock = 1000,
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  const next = proposeImmutableReleaseTransition(fixture().identity, null, []);
  assert.equal(next.decision, "effect");
  if (next.decision !== "effect") return;
  const transport = async () => {
    calls++;
    clock = 2001;
    return new Response("{}", { status: 201 });
  };
  await assert.rejects(
    performImmutableReleaseEffect(next.effect, null, "inert", transport, 999),
    /phase deadline/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    performImmutableReleaseEffect(next.effect, null, "inert", transport, 2000),
    /phase deadline/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    performImmutableReleaseEffect(next.effect, null, "inert", transport, 5000, Date.now() - 1),
    /risk authorization expired/u,
  );
  assert.equal(calls, 1, "expired waiver cannot start another provider mutation");
});

void test("copied completed releases cannot become owned settlement custody", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("no actual publisher or credential"));
  await assert.rejects(
    requireOwnedImmutableReleaseCompletion({ kind: "actual-owned-immutable-release-completion" }),
    /actual owned immutable/,
  );
  await assert.rejects(
    observeOwnedImmutableReleaseCompletion({} as never, {} as never, {}, {} as never),
    /actual same-process/,
  );
  await assert.rejects(
    observeOwnedImmutableReleaseCompletion({} as never, {} as never, {}, {} as never, 0),
    /phase deadline/,
  );
  await assert.rejects(
    rebindPreparedImmutableReleaseAfterPhase({} as never, {
      checkpoint: "a".repeat(40),
      phase: "publishing",
    }),
    /actual idle immutable/,
  );
  await assert.rejects(
    rebindPreparedImmutableReleaseAfterPhase({} as never, {}, 0),
    /phase deadline/,
  );
});

void test("owned publication refuses copied publication or signing-stage claims before any provider request", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("no admitted publication context"));
  for (const stage of ["payload-signing", "release-publication"] as const) {
    await assert.rejects(
      advanceOwnedImmutableReleasePublication(
        { identity: fixture().identity } as never,
        { kind: "authenticated-capacity-executor" },
        Object.freeze({
          stage,
          admission: { decision: "admitted", holds: [], evidence_scope: "github.com" },
          native_qualifications: [],
          pending_obligations: [],
          checkpoint: "a".repeat(40),
        }),
        { phase: "release-publication", evidence_scope: "github.com" } as never,
        {
          repository: process.cwd(),
          remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
        },
      ),
      /actual same-process/,
    );
  }
});

void test("feed prerequisite cannot import a serialized release preparation or acceptance receipt", async () => {
  await assert.rejects(
    () =>
      verifyPreparedImmutableRelease({ identity: fixture().identity } as never, {
        prepared_commit: "a".repeat(40),
        version: "0.1.0-beta.1",
      }),
    /actual immutable Release preparation/,
  );
});

import { capacityDigest } from "./release-capacity.mts";

const base = "repos/boburning/portcove";
function fixture() {
  const data = new Map([
    ["Portcove.exe", Buffer.from("inert opaque package")],
    ["Portcove.exe.sig", Buffer.from("inert signature; no signature claim")],
    ["SHA256SUMS.txt", Buffer.from("inert manifest")],
  ]);
  const identity = {
    version: "0.1.0-beta.1",
    source_commit: "a".repeat(40),
    assets: [...data].map(([filename, bytes]) => ({
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const release = {
    id: 700,
    tag_name: `v${identity.version}`,
    target_commitish: identity.source_commit,
    prerelease: true,
    draft: true,
    immutable: false,
    url: `https://api.github.com/${base}/releases/700`,
    html_url: `https://github.com/boburning/portcove/releases/tag/untagged-fixture`,
    upload_url: `https://uploads.github.com/${base}/releases/700/assets{?name,label}`,
  };
  const assets = identity.assets.map((a, i) => ({
    id: 800 + i,
    name: a.filename,
    size: a.bytes,
    digest: `sha256:${a.sha256}`,
    state: "uploaded",
    url: `https://api.github.com/${base}/releases/assets/${800 + i}`,
    browser_download_url: `https://github.com/boburning/portcove/releases/download/untagged-fixture/${a.filename}`,
  }));
  const publish = () => {
    release.draft = false;
    release.immutable = true;
    release.html_url = `https://github.com/boburning/portcove/releases/tag/v${identity.version}`;
    for (const a of assets)
      a.browser_download_url = `https://github.com/boburning/portcove/releases/download/v${identity.version}/${a.name}`;
  };
  return { data, identity, release, assets, publish };
}

void test("draft-first transitions propose exactly one missing asset and publish only a complete exact inventory", () => {
  const f = fixture();
  const create = proposeImmutableReleaseTransition(f.identity, null, []);
  assert.equal(create.decision, "effect");
  if (create.decision !== "effect") throw Error("expected effect");
  assert.equal(create.effect.kind, "create-draft");
  assert.ok("body" in create.effect && create.effect.body.draft === true);
  for (let count = 0; count < f.assets.length; count++) {
    const step = proposeImmutableReleaseTransition(f.identity, f.release, f.assets.slice(0, count));
    assert.equal(step.decision, "effect");
    assert.ok(step.decision === "effect" && step.effect.kind === "upload-asset");
  }
  const ready = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.ok(ready.decision === "effect" && ready.effect.kind === "publish-draft");
  f.publish();
  const complete = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.equal(complete.decision, "complete");
  if (complete.decision === "complete") assert.equal(complete.immutable, true);
});

void test("published mutable/incomplete, starter, corrupt, unexpected and duplicate assets refuse without cleanup", () => {
  for (const kind of [
    "mutable",
    "incomplete",
    "starter",
    "digest",
    "duplicate",
    "unexpected",
  ] as const) {
    const f = fixture();
    f.publish();
    if (kind === "mutable") f.release.immutable = false;
    if (kind === "incomplete") f.assets.pop();
    if (kind === "starter") f.assets[0]!.state = "starter";
    if (kind === "digest") f.assets[0]!.digest = `sha256:${"f".repeat(64)}`;
    if (kind === "duplicate") f.assets[1]!.id = f.assets[0]!.id;
    if (kind === "unexpected") f.assets[0]!.name = "unrelated-evidence";
    assert.throws(() => proposeImmutableReleaseTransition(f.identity, f.release, f.assets));
  }
});

void test("complete inventory finds a retained draft and verifies actual version tag without relying on tag lookup", async () => {
  const f = fixture();
  const calls: string[] = [];
  const metadata: ImmutableReleaseMetadataProvider = {
    async releases(page) {
      assert.equal(page, 1);
      calls.push("releases");
      return [f.release];
    },
    async versionTag(tag) {
      assert.equal(tag, `v${f.identity.version}`);
      calls.push("version tag");
      return { kind: "absent" };
    },
    async annotatedTag() {
      assert.fail("no annotated tag");
    },
    async releaseAssets(id, page) {
      assert.equal(id, f.release.id);
      assert.equal(page, 1);
      calls.push("assets");
      return f.assets;
    },
    async release(id) {
      assert.equal(id, f.release.id);
      calls.push("detail");
      return f.release;
    },
  };
  assert.equal(
    (await readImmutableReleaseState(metadata, f.identity)).assets.length,
    f.assets.length,
  );
  assert.deepEqual(calls, ["releases", "version tag", "assets", "detail"]);
  f.publish();
  await assert.rejects(readImmutableReleaseState(metadata, f.identity), /actual version tag/u);
});

void test("locked SDK only treats a complete exact tag 404 as absence after the full Release list", async () => {
  const f = fixture();
  let responseStatus = 404;
  const paths: string[] = [];
  const metadata = await createReleaseCustodyProvider({
    token: "inert-immutable-reader",
    deadline: performance.now() + 15000,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url),
        prefix = "/repos/boburning/portcove";
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token inert-immutable-reader");
      assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
      paths.push(url.pathname);
      if (url.pathname === `${prefix}/releases`) {
        assert.equal(url.searchParams.get("per_page"), "100");
        assert.equal(url.searchParams.get("page"), "1");
        return Response.json([]);
      }
      assert.equal(url.pathname, `${prefix}/git/ref/tags/v${f.identity.version}`);
      return Response.json({ message: "Tag unavailable" }, { status: responseStatus });
    },
  });
  const absent = await readImmutableReleaseState(metadata, f.identity);
  assert.deepEqual(absent, { release: null, assets: [], tag_commit: null });
  const proposed = proposeImmutableReleaseTransition(f.identity, absent.release, absent.assets);
  assert.ok(proposed.decision === "effect" && proposed.effect.kind === "create-draft");
  for (const status of [401, 403, 500, 429]) {
    responseStatus = status;
    await assert.rejects(
      readImmutableReleaseState(metadata, f.identity),
      (error) => error instanceof GitHubApiError && error.status === status,
    );
  }
  assert.equal(paths.length, 10);
  // A new client keeps the previous 429 deferral from hiding the broken body case.
  const truncated = await createReleaseCustodyProvider({
    token: "inert-immutable-reader",
    deadline: performance.now() + 15000,
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname.endsWith("/releases")
        ? Response.json([])
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("incomplete tag metadata"));
              },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
    },
  });
  await assert.rejects(
    readImmutableReleaseState(truncated, f.identity),
    (error) => error instanceof GitHubApiError && error.status === null,
  );
});

void test("locked SDK sends unchanged upload bytes once and refuses redirects or server errors", async () => {
  const f = fixture();
  const step = proposeImmutableReleaseTransition(f.identity, f.release, []);
  assert.ok(step.decision === "effect" && step.effect.kind === "upload-asset");
  const { effect } = step;
  const bytes = f.data.get(effect.asset.filename)!;
  for (const status of [302, 502]) {
    let calls = 0;
    const fetcher: typeof globalThis.fetch = async (input, options) => {
      calls++;
      assert.equal(input, effect.endpoint);
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "manual");
      assert.equal(options?.credentials, "omit");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("authorization"), "token inert-fixture-token");
      assert.equal(headers.get("x-github-api-version"), "2026-03-10");
      assert.equal(headers.get("content-type"), "application/octet-stream");
      assert.ok(options?.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(options.body), bytes);
      return new Response(null, { status, headers: { location: "https://untrusted.invalid/" } });
    };
    await assert.rejects(
      performImmutableReleaseEffect(effect, bytes, "inert-fixture-token", fetcher),
      /readback\/recovery/u,
    );
    assert.equal(calls, 1);
  }
});

void test("locked SDK sends exact draft creation and publish JSON to the fixed API origin", async () => {
  const f = fixture();
  const create = proposeImmutableReleaseTransition(f.identity, null, []);
  const publish = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.ok(create.decision === "effect" && create.effect.kind === "create-draft");
  assert.ok(publish.decision === "effect" && publish.effect.kind === "publish-draft");
  const expected = [
    {
      effect: create.effect,
      method: "POST",
      route: "/repos/boburning/portcove/releases",
      status: 201,
    },
    {
      effect: publish.effect,
      method: "PATCH",
      route: `/repos/boburning/portcove/releases/${f.release.id}`,
      status: 200,
    },
  ];
  const calls: string[] = [];
  for (const { effect, method, route, status } of expected) {
    const result = await performImmutableReleaseEffect(
      effect,
      null,
      "inert-publication",
      async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, `https://api.github.com${route}`);
        assert.equal(request.method, method);
        assert.equal(request.headers.get("authorization"), "token inert-publication");
        assert.equal(request.headers.get("content-type"), "application/json");
        assert.equal(await request.text(), JSON.stringify(effect.body));
        calls.push(method);
        return Response.json({ ignored: true }, { status });
      },
    );
    assert.deepEqual(result, { status });
  }
  assert.deepEqual(calls, ["POST", "PATCH"]);
});

void test("risk expiry during SDK setup prevents dispatch even after the initial gate passed", async (t) => {
  const next = proposeImmutableReleaseTransition(fixture().identity, null, []);
  assert.ok(next.decision === "effect" && next.effect.kind === "create-draft");
  let clockReads = 0,
    sends = 0;
  t.mock.method(Date, "now", () => (++clockReads === 1 ? 1000 : 2000));
  await assert.rejects(
    performImmutableReleaseEffect(
      next.effect,
      null,
      "inert",
      async () => {
        sends++;
        return new Response(null, { status: 201 });
      },
      performance.now() + 5000,
      1500,
    ),
    /risk authorization expired/u,
  );
  assert.ok(clockReads > 1);
  assert.equal(sends, 0);
});

void test("imported accepted receipts cannot execute a Release operation", async () => {
  await assert.rejects(
    advanceImmutableReleasePublication(
      {} as Parameters<typeof advanceImmutableReleasePublication>[0],
      {
        recover: async () => {
          throw Error("must not read");
        },
        effect: async () => {
          throw Error("must not execute");
        },
        token: "inert",
      },
    ),
    /actual release preparation/u,
  );
});

void test("overlapping executor callbacks can dispatch only one immutable Release effect", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { CoordinatorRemoteError } = await import("./release-coordinator-errors.mts");
  const { isRecord } = await import("./runtime-values.mts");
  const source = await readFile(
    new URL("./release-immutable-publication.mts", import.meta.url),
    "utf8",
  );
  const first = source.indexOf("export async function advanceImmutableReleasePublication(");
  const last = source.indexOf("/** One next logical Release effect", first);
  assert.ok(first >= 0 && last > first);
  const session = { identity: fixture().identity, directory: "private" };
  const prepared = new WeakMap([
    [session, { session, descriptor: "unused", checkpoint: "a".repeat(40) }],
  ]);
  const beganRead = Promise.withResolvers<void>(),
    allowRead = Promise.withResolvers<void>();
  let reads = 0,
    sends = 0;
  const run = runInNewContext(
    stripTypeScriptTypes(`(${source.slice(first + "export ".length, last).trim()})`),
    {
      prepared,
      active: new WeakSet(),
      completionOnlySessions: new WeakSet(),
      publicationRemaining: () => 1000,
      requireReservedAggregate: async () => {},
      inspectReleaseEffectExpectation: () => ({}),
      structuredClone,
      isRecord,
      capacityDigest,
      proposeImmutableReleaseTransition,
      CoordinatorRemoteError,
      assets: () => [],
      readImmutableReleaseState: async () => {
        if (++reads > 1) {
          beganRead.resolve();
          await allowRead.promise;
        }
        return { release: null, assets: [], tag_commit: null };
      },
      performImmutableReleaseEffect: async () => {
        sends++;
        throw new Error("ambiguous provider acknowledgement");
      },
    },
  ) as (session: object, options: object) => Promise<unknown>;
  await assert.rejects(
    run(session, {
      metadata: {},
      recover: async () => ({ input: { active_candidate: null } }),
      effect: async (_effect: unknown, callback: () => Promise<unknown>) => {
        const one = callback();
        await beganRead.promise;
        const both = Promise.allSettled([one, callback()]);
        allowRead.resolve();
        const [first, second] = await both;
        assert.equal(first?.status, "rejected");
        assert.equal(second?.status, "rejected");
        if (second?.status === "rejected") assert.match(String(second.reason), /only once/u);
        throw new Error("effect remains unresolved");
      },
    }),
    /ambiguous or refused/u,
  );
  assert.equal(reads, 2);
  assert.equal(sends, 1);
  assert.equal(prepared.has(session), false);
});

void test("settlement binds the actual recovered capacity intent, checkpoint and callback evidence", () => {
  const candidate = {
    prepared_commit: "a".repeat(40),
    source_commit: "b".repeat(40),
    version: "0.1.0-beta.1",
    transient_retries: 0,
    substantive_repairs: 0,
  };
  const identity = {
    before_checkpoint: "c".repeat(40),
    candidate,
    destination: "github-release:boburning/portcove:v0.1.0-beta.1:create-draft",
    executor_nonce: "d".repeat(64),
    kind: "upload",
    policy_sha256: "e".repeat(64),
    ratification_sha256: "f".repeat(64),
    sequence: 1,
  };
  const evidence = {
    remote_identity: "github-release:boburning/portcove:release:1:draft",
    evidence_sha256: "1".repeat(64),
  };
  const operation = {
    ...identity,
    id: capacityDigest(identity),
    outcome: "recovered",
    completed_effects: [evidence],
    failure_evidence: null,
    recovery: {
      checkpoint: "2".repeat(40),
      evidence_sha256: evidence.evidence_sha256,
      resolution: "effect-completed",
    },
  };
  const state = {
    checkpoint: "3".repeat(40),
    input: { controller: { capacity_attempt: { operation } } },
  };
  const expected = {
    checkpoint: state.checkpoint,
    operation_id: operation.id,
    before_checkpoint: identity.before_checkpoint,
    candidate,
    destination: identity.destination,
    ...evidence,
  };
  assert.equal(inspectImmutableReleaseSettlement(state, expected).id, operation.id);
  for (const changed of [
    { ...expected, checkpoint: "4".repeat(40) },
    { ...expected, operation_id: "4".repeat(64) },
    { ...expected, evidence_sha256: "4".repeat(64) },
    { ...expected, remote_identity: "other" },
    { ...expected, before_checkpoint: "4".repeat(40) },
    { ...expected, destination: "other" },
    { ...expected, candidate: { ...candidate, transient_retries: 1 } },
  ])
    assert.throws(() => inspectImmutableReleaseSettlement(state, changed));
  assert.throws(() =>
    inspectImmutableReleaseSettlement(
      {
        ...state,
        input: {
          controller: {
            capacity_attempt: { operation: { ...operation, outcome: "pending", recovery: null } },
          },
        },
      },
      expected,
    ),
  );
  assert.throws(() =>
    inspectImmutableReleaseSettlement(
      {
        ...state,
        input: {
          controller: {
            capacity_attempt: {
              operation: {
                ...operation,
                recovery: { ...operation.recovery, resolution: "partial-effects-retained" },
              },
            },
          },
        },
      },
      expected,
    ),
  );
});

void test("mismatched create tags and invalid publication IDs refuse before any provider call", async () => {
  const f = fixture();
  const create = proposeImmutableReleaseTransition(f.identity, null, []);
  assert.ok(create.decision === "effect" && create.effect.kind === "create-draft");
  const publish = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  assert.ok(publish.decision === "effect" && publish.effect.kind === "publish-draft");
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw new Error("must not fetch");
  }) as typeof fetch;
  await assert.rejects(
    performImmutableReleaseEffect(
      {
        ...create.effect,
        body: { ...create.effect.body, tag_name: "v0.1.0-beta.2", name: "v0.1.0-beta.2" },
      },
      null,
      "inert",
      fetcher,
    ),
  );
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assert.rejects(
      performImmutableReleaseEffect(
        {
          ...publish.effect,
          release_id: id,
          endpoint: `repos/boburning/portcove/releases/${id}`,
          destination: `github-release:boburning/portcove:${publish.effect.tag}:publish`,
        },
        null,
        "inert",
        fetcher,
      ),
    );
  }
  assert.equal(calls, 0);
});

void test("logical purposes stay stable across provider IDs and content while exact requests remain distinct", () => {
  const f = fixture();
  const changedIdentity = {
    ...f.identity,
    source_commit: "f".repeat(40),
    assets: f.identity.assets.map((asset) => ({ ...asset, sha256: "e".repeat(64) })),
  };
  const create = proposeImmutableReleaseTransition(f.identity, null, []);
  const otherCreate = proposeImmutableReleaseTransition(changedIdentity, null, []);
  assert.ok(create.decision === "effect" && otherCreate.decision === "effect");
  assert.equal(create.effect.destination, otherCreate.effect.destination);
  assert.notEqual(capacityDigest(create.effect), capacityDigest(otherCreate.effect));
  const upload = proposeImmutableReleaseTransition(f.identity, f.release, []);
  const otherUpload = proposeImmutableReleaseTransition(
    f.identity,
    {
      ...f.release,
      id: 999,
      url: `https://api.github.com/${base}/releases/999`,
      upload_url: `https://uploads.github.com/${base}/releases/999/assets{?name,label}`,
    },
    [],
  );
  assert.ok(upload.decision === "effect" && otherUpload.decision === "effect");
  assert.equal(upload.effect.destination, otherUpload.effect.destination);
  assert.notEqual(capacityDigest(upload.effect), capacityDigest(otherUpload.effect));
  const changedUpload = proposeImmutableReleaseTransition(
    changedIdentity,
    { ...f.release, target_commitish: changedIdentity.source_commit },
    [],
  );
  assert.ok(changedUpload.decision === "effect");
  assert.equal(upload.effect.destination, changedUpload.effect.destination);
  assert.notEqual(capacityDigest(upload.effect), capacityDigest(changedUpload.effect));
  const publish = proposeImmutableReleaseTransition(f.identity, f.release, f.assets);
  const otherPublish = proposeImmutableReleaseTransition(
    changedIdentity,
    { ...f.release, target_commitish: changedIdentity.source_commit },
    f.assets.map((asset) => ({ ...asset, digest: "sha256:" + "e".repeat(64) })),
  );
  assert.ok(publish.decision === "effect" && otherPublish.decision === "effect");
  assert.equal(publish.effect.destination, otherPublish.effect.destination);
  assert.notEqual(capacityDigest(publish.effect), capacityDigest(otherPublish.effect));
});
