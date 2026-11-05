import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectApplicationRunCustody,
  readApplicationRunNotes,
  registerApplicationReleaseRun,
  retainApplicationPreparation,
  readRegisteredApplicationRuns,
  registerApplicationBudgetRun,
  readApplicationBudgetOwner,
  readApplicationMetadataContextPlan,
  retainApplicationDraftAssembly,
  retainApplicationDraftRecovery,
  claimApplicationDraftAssetRemoval,
  retainApplicationMetadataContext,
  assertApplicationCustodyMetadataExtension,
  type ApplicationMetadataContextReservation,
} from "./application-release-run.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";

const source = "a".repeat(40),
  tree = "b".repeat(40);
const execution = {
  source: "c".repeat(40),
  ref: "refs/tags/portcove-production-controller-windows-fixture",
  run_id: "123",
  run_attempt: 1,
};
function fixture(mode = "valid") {
  const releases: Record<string, unknown>[] = [];
  const mutations: { method: string; body: unknown }[] = [];
  const api: CoordinatorRemoteApi = {
    graphql() {
      throw new Error("unexpected GraphQL request");
    },
    request(method, endpoint, body) {
      const root = "repos/boburning/portcove";
      if (endpoint === root) {
        assert.equal(method, "GET");
        return {
          status: 200,
          headers: new Map(),
          body: { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" },
        };
      }
      if (endpoint === `${root}/releases?per_page=100`) {
        assert.equal(method, "GET");
        return { status: 200, headers: new Map(), body: structuredClone(releases) };
      }
      if (method === "POST") {
        assert.equal(endpoint, `${root}/releases`);
        assert.ok(isRecord(body));
        mutations.push({ method, body: structuredClone(body) });
        const value = { ...body, id: 10 + releases.length, immutable: false };
        if (mode !== "lost-before-create") releases.push(value);
        if (mode.startsWith("lost-")) throw new Error("ambiguous POST response");
        return { status: 201, headers: new Map(), body: structuredClone(value) };
      }
      const selected = new RegExp(`^${root}/releases/(10|11)$`, "u").exec(endpoint);
      assert.ok(selected);
      const value = releases.find((release) => release.id === Number(selected[1]));
      assert.ok(value);
      if (method === "PATCH") {
        assert.ok(isRecord(body));
        assert.deepEqual(Object.keys(body), ["body"]);
        mutations.push({ method, body: structuredClone(body) });
        if (mode !== "patch-refused") value.body = body.body;
        if (mode === "patch-clock")
          value.updated_at = new Date(mutations.length * 1000).toISOString();
        if (mode === "patch-lost") throw new Error("ambiguous PATCH response");
        return {
          status: mode === "patch-refused" ? 403 : 200,
          headers: new Map(),
          body: structuredClone(value),
        };
      }
      assert.equal(method, "GET");
      return { status: 200, headers: new Map(), body: structuredClone(value) };
    },
  };
  const guards: string[][] = [];
  const guard = async (known: readonly string[]) => {
    guards.push([...known]);
  };
  return { api, releases, mutations, guards, guard };
}

void test("immutable metadata recovery appends only its existing cohort and never creates or adopts a draft", async () => {
  const opportunity = "d".repeat(64);
  const f = fixture();
  const register = (id: string, mode: "create-or-resume" | "immutable-metadata-only") =>
    registerApplicationReleaseRun(
      f.api,
      { ...execution, run_id: id },
      source,
      tree,
      opportunity,
      f.guard,
      mode,
    );
  await assert.rejects(
    () => register("123", "immutable-metadata-only"),
    /existing metadata cohort/u,
  );
  assert.equal(f.mutations.length, 0);
  await register("123", "create-or-resume");
  await assert.rejects(() => register("124", "immutable-metadata-only"));
  const release = f.releases[0]!;
  release.draft = false;
  release.immutable = true;
  const preimage = structuredClone(release);
  const recovered = await register("124", "immutable-metadata-only");
  assert.deepEqual(recovered.known_run_ids, ["123", "124"]);
  const { body: oldBody, ...oldFields } = preimage;
  const { body: newBody, ...newFields } = release;
  assert.deepEqual(newFields, oldFields);
  assert.notEqual(newBody, oldBody);
  assert.deepEqual(
    f.mutations.map((value) => value.method),
    ["POST", "PATCH"],
  );
  await register("124", "immutable-metadata-only");
  assert.equal(f.mutations.length, 2);
  release.tag_name = "v0.1.0-alpha.3";
  await assert.rejects(() => register("125", "immutable-metadata-only"));
  assert.equal(f.mutations.length, 2);
});

void test("native draft registration precedes private work and a same-run retry preserves its single record", async () => {
  const f = fixture();
  const first = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    f.guard,
  );
  assert.deepEqual(first.known_run_ids, ["123"]);
  assert.equal(first.authority, "none");
  assert.deepEqual(f.guards, [[]]);
  const retry = await registerApplicationReleaseRun(
    f.api,
    { ...execution, run_attempt: 2 },
    source,
    tree,
    source,
    f.guard,
  );
  assert.deepEqual(retry, first);
  assert.deepEqual(f.guards, [[], ["123"]]);
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(
    readRegisteredApplicationRuns(f.api, 10, source, source, tree, execution),
    first.custody,
  );
  assert.throws(() =>
    readRegisteredApplicationRuns(f.api, 10, source, source, "d".repeat(40), execution),
  );
  assert.throws(() =>
    readRegisteredApplicationRuns(f.api, 10, source, source, tree, {
      ...execution,
      source: "f".repeat(40),
    }),
  );
});

void test("recovery appends a bounded native run after immutable publication without changing assets or notes", async () => {
  const f = fixture("patch-lost");
  await registerApplicationReleaseRun(f.api, execution, source, tree, source, f.guard);
  Object.assign(f.releases[0]!, {
    tag_name: "v0.1.0-alpha.3",
    target_commitish: source,
    draft: false,
    immutable: true,
    assets: [{ id: 99, digest: "sha256:unchanged" }],
  });
  const prior = structuredClone(f.releases[0]);
  const second = await registerApplicationReleaseRun(
    f.api,
    { ...execution, run_id: "124" },
    source,
    tree,
    source,
    f.guard,
  );
  assert.deepEqual(second.known_run_ids, ["123", "124"]);
  assert.deepEqual({ ...f.releases[0], body: prior!.body }, prior);
  assert.deepEqual(
    f.mutations.map((m) => m.method),
    ["POST", "PATCH"],
  );
  await registerApplicationReleaseRun(
    f.api,
    { ...execution, run_id: "125" },
    source,
    tree,
    source,
    f.guard,
  );
  await assert.rejects(
    registerApplicationReleaseRun(
      f.api,
      { ...execution, run_id: "126" },
      source,
      tree,
      source,
      f.guard,
    ),
  );
  await assert.rejects(
    registerApplicationReleaseRun(
      f.api,
      { ...execution, source: "f".repeat(40) },
      source,
      tree,
      source,
      f.guard,
    ),
  );
});

void test("ambiguous POST is reconciled once; absent, duplicate, damaged or refused custody never resets", async () => {
  for (const mode of ["lost-after-create", "lost-before-create"]) {
    const f = fixture(mode);
    const pending = registerApplicationReleaseRun(f.api, execution, source, tree, source, f.guard);
    if (mode === "lost-after-create") assert.equal((await pending).release_id, 10);
    else await assert.rejects(pending);
    assert.equal(f.mutations.length, 1);
  }
  for (const mode of [
    "duplicate",
    "damaged",
    "damaged-published",
    "anchor",
    "guard",
    "patch-refused",
  ]) {
    const f = fixture(mode);
    await registerApplicationReleaseRun(f.api, execution, source, tree, source, f.guard);
    if (mode === "duplicate") f.releases.push(structuredClone(f.releases[0]!));
    if (mode === "damaged") f.releases[0]!.body = "lost record";
    if (mode === "damaged-published")
      Object.assign(f.releases[0]!, {
        body: "lost record",
        tag_name: "v0.1.0-alpha.3",
        draft: false,
        immutable: true,
      });
    if (mode === "anchor") f.releases[0]!.target_commitish = "f".repeat(40);
    const before = f.mutations.length;
    await assert.rejects(
      registerApplicationReleaseRun(
        f.api,
        { ...execution, run_id: "124" },
        source,
        tree,
        source,
        mode === "guard"
          ? async () => {
              throw new Error("current guards refused");
            }
          : f.guard,
      ),
    );
    assert.equal(f.mutations.length, before + (mode === "patch-refused" ? 1 : 0));
  }
});

void test("one mechanical preparation is retained exactly and cannot be silently reallocated", async () => {
  const f = fixture("patch-lost");
  const registered = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    f.guard,
  );
  const preparation = {
    source_commit: source,
    source_tree: tree,
    prepared_commit: "d".repeat(40),
    prepared_tree: "e".repeat(40),
    version: "0.1.0-alpha.3",
    intent_sha256: "f".repeat(64),
    classification: {
      source_commit: source,
      reviewed_commit: source,
      base_version: "0.1.0-alpha.2",
      change: "prerelease" as const,
      compatibility: "compatible" as const,
    },
    qualification: {
      workflow: ".github/workflows/application-release.yml" as const,
      workflow_commit: source,
      run_id: 200,
      attempt: 2,
    },
    published_versions: ["0.1.0-alpha.2"],
  };
  const retained = await retainApplicationPreparation(
    f.api,
    10,
    registered.custody,
    preparation,
    f.guard,
  );
  assert.deepEqual(retained.preparation, preparation);
  assert.deepEqual(readApplicationRunNotes(f.releases[0]!.body)?.custody, retained);
  const writes = f.mutations.length;
  assert.deepEqual(
    await retainApplicationPreparation(f.api, 10, retained, preparation, f.guard),
    retained,
  );
  assert.equal(f.mutations.length, writes);
  await assert.rejects(
    retainApplicationPreparation(
      f.api,
      10,
      retained,
      { ...preparation, version: "0.1.0-alpha.4" },
      f.guard,
    ),
  );
  await assert.rejects(
    retainApplicationPreparation(
      f.api,
      10,
      retained,
      {
        ...preparation,
        qualification: { ...preparation.qualification, attempt: 3 },
      },
      f.guard,
    ),
    /cannot be reallocated/,
  );
  assert.equal(f.mutations.length, writes);
  assert.throws(() =>
    inspectApplicationRunCustody({ ...retained, runs: [...retained.runs, retained.runs[0]] }),
  );
  const value = f.releases[0]!;
  Object.assign(value, { draft: false, immutable: true, tag_name: `v${preparation.version}` });
  const immutable = structuredClone(value);
  const recovered = await registerApplicationReleaseRun(
    f.api,
    { ...execution, run_id: "124" },
    source,
    tree,
    source,
    f.guard,
    "immutable-only",
  );
  assert.deepEqual(recovered.custody.preparation, preparation);
  assert.deepEqual(recovered.known_run_ids, ["123", "124"]);
  assert.deepEqual({ ...value, body: immutable.body }, immutable);
  const recoveryWrites = f.mutations.length;
  for (const change of [{ draft: true }, { immutable: false }, { tag_name: "v9.9.9" }]) {
    const original = structuredClone(value);
    Object.assign(value, change);
    await assert.rejects(
      registerApplicationReleaseRun(
        f.api,
        { ...execution, run_id: "125" },
        source,
        tree,
        source,
        f.guard,
        "immutable-only",
      ),
    );
    assert.equal(f.mutations.length, recoveryWrites);
    Object.assign(value, original);
  }
});

void test("immutable-only recovery never creates a missing cohort or adopts an unprepared draft", async () => {
  const f = fixture();
  await assert.rejects(
    registerApplicationReleaseRun(
      f.api,
      execution,
      source,
      tree,
      source,
      f.guard,
      "immutable-only",
    ),
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(f.guards.length, 0);
  await registerApplicationReleaseRun(f.api, execution, source, tree, source, f.guard);
  const writes = f.mutations.length;
  await assert.rejects(
    registerApplicationReleaseRun(
      f.api,
      { ...execution, run_id: "124" },
      source,
      tree,
      source,
      f.guard,
      "immutable-only",
    ),
  );
  assert.equal(f.mutations.length, writes);
});

void test("forward renewal shares one native cost owner, preserves release bytes and cannot drop or duplicate earlier runs", async () => {
  const f = fixture("patch-lost");
  const initial = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    async () => f.guard([]),
  );
  Object.assign(f.releases[0]!, {
    draft: false,
    immutable: true,
    assets: [{ id: 99, digest: "unchanged" }],
  });
  const before = structuredClone(f.releases[0]!);
  const memberOpportunity = "d".repeat(64);
  await assert.rejects(
    registerApplicationBudgetRun(
      f.api,
      { release_id: 10, custody: initial.custody },
      memberOpportunity,
      { ...execution, run_id: "124" },
      async () => {
        throw new Error("source/pause/spending authorization refused");
      },
    ),
  );
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.releases[0], before);
  const linked = await registerApplicationBudgetRun(
    f.api,
    { release_id: 10, custody: initial.custody },
    memberOpportunity,
    { ...execution, run_id: "124" },
    async () => f.guard([]),
  );
  assert.equal(linked.owner.custody.schema_version, 2);
  assert.deepEqual({ ...f.releases[0], body: before.body }, before);
  const member = inspectApplicationRunCustody({
    ...initial.custody,
    schema_version: 2,
    preparation: null,
    opportunity: memberOpportunity,
    runs: [{ id: "124", control_commit: execution.source, control_ref: execution.ref }],
    budget: linked.membership,
  });
  assert.deepEqual(
    readApplicationBudgetOwner(f.api, { release_id: 11, custody: member }),
    linked.owner,
  );
  const writes = f.mutations.length;
  const repeated = await registerApplicationBudgetRun(
    f.api,
    linked.owner,
    memberOpportunity,
    { ...execution, run_id: "124" },
    async () => f.guard([]),
  );
  assert.deepEqual(repeated, linked);
  assert.equal(f.mutations.length, writes);
  assert.throws(() =>
    inspectApplicationRunCustody({
      ...linked.owner.custody,
      budget: { kind: "owner", scopes: [{ opportunity: memberOpportunity, run_ids: ["123"] }] },
    }),
  );
  assert.throws(() => readApplicationBudgetOwner(f.api, { release_id: 10, custody: member }));
  assert.throws(() =>
    readApplicationBudgetOwner(f.api, {
      release_id: 11,
      custody: inspectApplicationRunCustody({
        ...member,
        budget: { ...linked.membership, owner_opportunity: "f".repeat(64) },
      }),
    }),
  );
  const expanded = await registerApplicationBudgetRun(
    f.api,
    linked.owner,
    "e".repeat(64),
    { ...execution, run_id: "125" },
    async () => f.guard([]),
  );
  const totalWrites = f.mutations.length;
  await assert.rejects(
    registerApplicationBudgetRun(
      f.api,
      expanded.owner,
      "f".repeat(64),
      { ...execution, run_id: "126" },
      async () => f.guard([]),
    ),
  );
  assert.equal(f.mutations.length, totalWrites);
});

void test("interrupted owner-before-member registration preserves every cost ID and completes only the authorized member append", async () => {
  const f = fixture();
  const owner = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    f.guard,
  );
  const opportunity = "d".repeat(64);
  const firstLink = await registerApplicationBudgetRun(
    f.api,
    owner,
    opportunity,
    { ...execution, run_id: "124" },
    async () => {},
  );
  const member = await registerApplicationReleaseRun(
    f.api,
    { ...execution, run_id: "124" },
    source,
    tree,
    opportunity,
    f.guard,
    "create-or-resume",
    firstLink.membership,
  );
  Object.assign(f.releases[1]!, {
    draft: false,
    immutable: true,
    assets: [{ id: 99, digest: "preserved" }],
  });
  const beforeMember = structuredClone(f.releases[1]);
  const recovery = { ...execution, run_id: "125" };
  const linked = await registerApplicationBudgetRun(
    f.api,
    member,
    opportunity,
    recovery,
    async () => {},
  );
  await assert.rejects(
    () =>
      registerApplicationReleaseRun(
        f.api,
        recovery,
        source,
        tree,
        opportunity,
        async () => {
          throw new Error("pause changed before member write");
        },
        "immutable-metadata-only",
        firstLink.membership,
      ),
    /pause changed/u,
  );
  assert.deepEqual(f.releases[1], beforeMember);
  assert.deepEqual(readApplicationBudgetOwner(f.api, member), linked.owner);
  const writes = f.mutations.length;
  const retry = await registerApplicationBudgetRun(
    f.api,
    member,
    opportunity,
    recovery,
    async () => {},
  );
  assert.deepEqual(retry, linked);
  assert.equal(f.mutations.length, writes, "owner retry cannot repeat or erase accounting");
  const completed = await registerApplicationReleaseRun(
    f.api,
    recovery,
    source,
    tree,
    opportunity,
    async (_known, context) => {
      assert.ok(context);
      assert.deepEqual(readApplicationBudgetOwner(f.api, context), linked.owner);
    },
    "immutable-metadata-only",
    firstLink.membership,
  );
  assert.deepEqual(completed.known_run_ids, ["124", "125"]);
  assert.deepEqual(readApplicationBudgetOwner(f.api, completed), linked.owner);
  assert.equal(f.mutations.length, writes + 1);
  assert.deepEqual({ ...f.releases[1], body: beforeMember?.body }, beforeMember);
  assert.throws(
    () =>
      readApplicationBudgetOwner(f.api, {
        ...member,
        custody: inspectApplicationRunCustody({
          ...member.custody,
          runs: [{ ...member.custody.runs[0], id: "126" }],
        }),
      }),
    /lost a registered member/u,
  );
  await assert.rejects(() =>
    registerApplicationBudgetRun(
      f.api,
      completed,
      opportunity,
      { ...execution, run_id: "126" },
      async () => {},
    ),
  );
  assert.equal(f.mutations.length, writes + 1, "the original global three-run bound remains");
});

void test("unknown native cost registration keeps the old owner and never retries its PATCH", async () => {
  const f = fixture("patch-refused");
  const initial = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    async () => f.guard([]),
  );
  const before = structuredClone(f.releases[0]);
  await assert.rejects(
    registerApplicationBudgetRun(
      f.api,
      { release_id: 10, custody: initial.custody },
      "d".repeat(64),
      { ...execution, run_id: "124" },
      async () => f.guard([]),
    ),
  );
  assert.deepEqual(f.releases[0], before);
  assert.deepEqual(
    f.mutations.map((row) => row.method),
    ["POST", "PATCH"],
  );
});

function metadataReservation(
  opportunity: string,
  generated_at: string,
  online: string,
  actor = execution,
  digest = "e".repeat(64),
): ApplicationMetadataContextReservation {
  return {
    opportunity,
    generated_at,
    run_id: actor.run_id,
    run_attempt: actor.run_attempt,
    control_commit: actor.source,
    control_ref: actor.ref,
    root_sha256: "1".repeat(64),
    offline_targets_sha256: "2".repeat(64),
    prior_repository_sha256: "3".repeat(64),
    context_sha256: digest,
    context_inventory_sha256: digest,
    records_sha256: "4".repeat(64),
    versions: {
      targets: "1",
      releases: online,
      preview: online,
      stable: online,
      snapshot: online,
      timestamp: online,
    },
  };
}

void test("native context reservations freeze full bytes and burn versions under the original cost owner", async () => {
  const f = fixture(),
    opportunity = "d".repeat(64);
  const registered = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    opportunity,
    async () => {},
  );
  const plan = readApplicationMetadataContextPlan(f.api, registered, execution);
  assert.equal(plan.existing, undefined);
  const first = metadataReservation(opportunity, plan.generated_at, "2");
  const retained = await retainApplicationMetadataContext(
    f.api,
    registered,
    execution,
    first,
    async () => {
      assert.equal(f.mutations.length, 1, "reservation must precede any context consumer");
    },
  );
  assert.equal(retained.custody.schema_version, 3);
  assert.deepEqual(retained.custody.metadata_contexts, [first]);
  assert.deepEqual(
    assertApplicationCustodyMetadataExtension(registered.custody, retained.custody),
    retained.custody,
  );
  assert.throws(() =>
    assertApplicationCustodyMetadataExtension(retained.custody, registered.custody),
  );
  assert.throws(() =>
    assertApplicationCustodyMetadataExtension(registered.custody, {
      ...retained.custody,
      source_tree: "f".repeat(40),
    }),
  );
  const mutations = f.mutations.length;
  await retainApplicationMetadataContext(f.api, registered, execution, first, async () => {});
  assert.equal(f.mutations.length, mutations, "exact producer reuse must not rewrite notes");
  // The context JSON can be identical while its referenced record bytes differ.
  await assert.rejects(
    retainApplicationMetadataContext(
      f.api,
      registered,
      execution,
      { ...first, context_inventory_sha256: "f".repeat(64) },
      async () => {},
    ),
    /exact bytes/,
  );
  assert.equal(f.mutations.length, mutations);
  const secondActor = { ...execution, run_attempt: 2 };
  const secondPlan = readApplicationMetadataContextPlan(f.api, registered, secondActor);
  assert.deepEqual(secondPlan.previous_reserved_versions, first.versions);
  const second = metadataReservation(
    opportunity,
    secondPlan.generated_at,
    "3",
    secondActor,
    "a".repeat(64),
  );
  const secondRetained = await retainApplicationMetadataContext(
    f.api,
    registered,
    secondActor,
    second,
    async () => {},
  );
  assert.deepEqual(secondRetained.custody.metadata_contexts, [first, second]);
  assert.deepEqual(secondRetained.custody.runs, registered.custody.runs);
  assert.throws(
    () => readApplicationMetadataContextPlan(f.api, registered, execution),
    /superseded/,
  );
  await assert.rejects(
    retainApplicationMetadataContext(
      f.api,
      registered,
      { ...execution, run_attempt: 3 },
      { ...second, run_attempt: 3 },
      async () => {},
    ),
    /reused an online version/,
  );
  assert.equal(readApplicationRunNotes(f.releases[0]!.body)!.custody.metadata_contexts?.length, 2);
});

void test("related metadata contexts retain the original owner history and every registered run", async () => {
  const f = fixture("patch-clock");
  const owner = await registerApplicationReleaseRun(
    f.api,
    execution,
    source,
    tree,
    source,
    async () => {},
  );
  const firstPlan = readApplicationMetadataContextPlan(f.api, owner, execution);
  const first = metadataReservation(source, firstPlan.generated_at, "2");
  await retainApplicationMetadataContext(f.api, owner, execution, first, async () => {});
  const memberActor = { ...execution, run_id: "124" },
    opportunity = "d".repeat(64);
  const linked = await registerApplicationBudgetRun(
    f.api,
    {
      release_id: owner.release_id,
      custody: readApplicationRunNotes(f.releases[0]!.body)!.custody,
    },
    opportunity,
    memberActor,
    async () => {},
  );
  assert.deepEqual(linked.owner.custody.metadata_contexts, [first]);
  const member = await registerApplicationReleaseRun(
    f.api,
    memberActor,
    source,
    tree,
    opportunity,
    async () => {},
    "create-or-resume",
    linked.membership,
  );
  const plan = readApplicationMetadataContextPlan(f.api, member, memberActor);
  assert.deepEqual(plan.previous_reserved_versions, first.versions);
  const second = metadataReservation(
    opportunity,
    plan.generated_at,
    "3",
    memberActor,
    "a".repeat(64),
  );
  const retained = await retainApplicationMetadataContext(
    f.api,
    member,
    memberActor,
    second,
    async () => {},
  );
  assert.equal(retained.release_id, owner.release_id);
  assert.deepEqual(retained.custody.metadata_contexts, [first, second]);
  assert.equal(readApplicationRunNotes(f.releases[1]!.body)!.custody.metadata_contexts, undefined);
  assert.deepEqual(readApplicationBudgetOwner(f.api, member).custody.metadata_contexts, [
    first,
    second,
  ]);
  const expires = Object.fromEntries(
    Object.keys(second.versions).map((role) => [role, "2027-01-01T00:00:00Z"]),
  ) as Record<keyof typeof second.versions, string>;
  const assembly = {
    release_id: member.release_id,
    context_sha256: second.context_sha256,
    producer_attempt: second.run_attempt,
    prior_generation: "a".repeat(64),
    prior_repository_sha256: second.prior_repository_sha256,
    retained_inventory_sha256: "b".repeat(64),
    publication: {
      schema_version: 1 as const,
      root_sha256: second.root_sha256,
      offline_targets_sha256: second.offline_targets_sha256,
      records_sha256: second.records_sha256,
      repository_sha256: "c".repeat(64),
      snapshot_sha256: "d".repeat(64),
      timestamp_sha256: "e".repeat(64),
      versions: second.versions,
      expires,
    },
    subjects: ["application-site.zip", "application-metadata.json"].map((name) => ({
      name,
      bytes: 42,
      sha256: "f".repeat(64),
    })),
  };
  const beforeAssembly = f.mutations.length;
  const previousEdit = f.releases[0]!.updated_at;
  const stored = await retainApplicationDraftAssembly(
    f.api,
    member,
    memberActor,
    assembly,
    async () => assert.equal(f.mutations.length, beforeAssembly),
  );
  assert.notEqual(f.releases[0]!.updated_at, previousEdit);
  assert.deepEqual(stored.custody.draft_assemblies, [assembly]);
  assert.deepEqual(readApplicationBudgetOwner(f.api, member).custody, stored.custody);
  assert.equal(readApplicationRunNotes(f.releases[1]!.body)!.custody.draft_assemblies, undefined);
  await retainApplicationDraftAssembly(f.api, member, memberActor, assembly, async () => {});
  assert.equal(f.mutations.length, beforeAssembly + 1);
  await assert.rejects(
    retainApplicationDraftAssembly(
      f.api,
      member,
      memberActor,
      {
        ...assembly,
        subjects: assembly.subjects.map((subject) => ({ ...subject, bytes: 43 })),
      },
      async () => {},
    ),
    /assembly changed/,
  );
  assert.throws(() => assertApplicationCustodyMetadataExtension(stored.custody, retained.custody));
  assert.equal(f.mutations.length, beforeAssembly + 1);
  const nextActor = { ...memberActor, run_attempt: 2 };
  const nextPlan = readApplicationMetadataContextPlan(f.api, member, nextActor);
  const replacement = metadataReservation(
    opportunity,
    nextPlan.generated_at,
    "4",
    nextActor,
    "b".repeat(64),
  );
  await retainApplicationMetadataContext(f.api, member, nextActor, replacement, async () => {});
  const both = await retainApplicationDraftAssembly(
    f.api,
    member,
    nextActor,
    {
      ...assembly,
      context_sha256: replacement.context_sha256,
      producer_attempt: nextActor.run_attempt,
      publication: { ...assembly.publication, versions: replacement.versions },
    },
    async () => {},
  );
  const recovery = {
    release_id: member.release_id,
    old_context_sha256: second.context_sha256,
    replacement_context_sha256: replacement.context_sha256,
    retained_assets_sha256: "a".repeat(64),
    assets: [{ id: 29, name: "application-metadata.json" }],
    backup: { id: 50, bytes: 128, sha256: "f".repeat(64), run_attempt: nextActor.run_attempt },
  };
  const beforeRecovery = f.mutations.length;
  await assert.rejects(
    retainApplicationDraftRecovery(f.api, member, nextActor, recovery, async () => {
      throw new Error("backup or live draft guard failed");
    }),
    /guard failed/,
  );
  assert.equal(f.mutations.length, beforeRecovery);
  const committed = await retainApplicationDraftRecovery(
    f.api,
    member,
    nextActor,
    recovery,
    async () => {},
  );
  assert.deepEqual(committed.custody.draft_recoveries, [recovery]);
  assert.deepEqual(readApplicationBudgetOwner(f.api, member).custody, committed.custody);
  assertApplicationCustodyMetadataExtension(both.custody, committed.custody);
  assert.throws(() => assertApplicationCustodyMetadataExtension(committed.custody, both.custody));
  await retainApplicationDraftRecovery(f.api, member, nextActor, recovery, async () => {});
  assert.equal(f.mutations.length, beforeRecovery + 1);
  await assert.rejects(
    retainApplicationDraftRecovery(
      f.api,
      member,
      nextActor,
      {
        ...recovery,
        backup: { ...recovery.backup, id: 51 },
      },
      async () => {},
    ),
    /backup or preimage changed/,
  );
  assert.equal(f.mutations.length, beforeRecovery + 1);
  const claim = () =>
    claimApplicationDraftAssetRemoval(f.api, member, nextActor, recovery, 29, async () => {});
  assert.deepEqual(await claim(), {
    release_id: owner.release_id,
    notes: f.releases[0]!.body,
  });
  assert.equal(await claim(), undefined);
  assert.equal(f.mutations.length, beforeRecovery + 2);
  const ownerWithClaim = readApplicationBudgetOwner(f.api, member).custody;
  assert.deepEqual(ownerWithClaim.draft_removal_claims, [
    {
      asset_id: 29,
      replacement_context_sha256: replacement.context_sha256,
    },
  ]);
  assertApplicationCustodyMetadataExtension(committed.custody, ownerWithClaim);
  assert.throws(() => assertApplicationCustodyMetadataExtension(ownerWithClaim, committed.custody));
});

void test("ambiguous native reservation PATCH is read back once and never reissued or waived", async () => {
  for (const mode of ["patch-lost", "patch-refused"]) {
    const f = fixture(mode),
      opportunity = "d".repeat(64);
    const registered = await registerApplicationReleaseRun(
      f.api,
      execution,
      source,
      tree,
      opportunity,
      async () => {},
    );
    const plan = readApplicationMetadataContextPlan(f.api, registered, execution);
    const reservation = metadataReservation(opportunity, plan.generated_at, "2");
    const pending = retainApplicationMetadataContext(
      f.api,
      registered,
      execution,
      reservation,
      async () => {},
    );
    if (mode === "patch-lost")
      assert.deepEqual((await pending).custody.metadata_contexts, [reservation]);
    else await assert.rejects(pending, /outcome unknown/);
    assert.equal(f.mutations.filter((value) => value.method === "PATCH").length, 1);
    assert.deepEqual(
      readApplicationRunNotes(f.releases[0]!.body)!.custody.runs,
      registered.custody.runs,
    );
  }
});
