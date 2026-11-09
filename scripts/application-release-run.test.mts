import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  inspectApplicationRunCustody,
  readApplicationRunNotes,
  createApplicationRunRegistrationProvider,
  registerApplicationReleaseRun,
  resumeApplicationMetadataDraft,
  resumeR55MetadataDraft,
  retainedR55Renewal,
  retainedR56FeedRecovery,
  requireRetainedR56PreNativeEvidence,
  inspectBootstrapDraftRecovery,
  retainApplicationPreparation,
  readRegisteredApplicationRuns,
  registerApplicationBudgetRun,
  readApplicationBudgetOwnerAsync,
  readApplicationMetadataContextPlan,
  retainApplicationDraftAssembly,
  retainApplicationDraftRecovery,
  claimApplicationDraftAssetRemoval,
  retainApplicationMetadataContext,
  assertApplicationCustodyMetadataExtension,
  applicationReleaseNotesPreimage,
  type ApplicationMetadataContextReservation,
} from "./application-release-run.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";
import { applicationSourcePacketMaximumBytes } from "./application-release-policy.mts";

const draftPresentationUrl = "https://github.com/boburning/portcove/releases/tag/untagged-";

void test("notes readback accepts a regenerated untagged mutable draft presentation URL", () => {
  const before = {
    id: 437990696,
    draft: true,
    immutable: false,
    html_url: draftPresentationUrl + "931ae6804dd953088791",
  };
  const after = { ...before, html_url: draftPresentationUrl + "e3923584a69fc5de56c5" };
  assert.deepEqual(applicationReleaseNotesPreimage(before), applicationReleaseNotesPreimage(after));
  for (const changed of [
    { ...after, id: 437990697 },
    { ...after, html_url: after.html_url.replace("/boburning/", "/another-owner/") },
    { ...after, html_url: after.html_url.replace("untagged-", "v") },
    { ...after, html_url: after.html_url + "?changed=1" },
    { ...after, html_url: null },
  ])
    assert.notDeepEqual(
      applicationReleaseNotesPreimage(before),
      applicationReleaseNotesPreimage(changed),
    );
  for (const state of [{ draft: false }, { immutable: true }])
    assert.notDeepEqual(
      applicationReleaseNotesPreimage({ ...before, ...state }),
      applicationReleaseNotesPreimage({ ...after, ...state }),
    );
});
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
        const value = {
          ...body,
          id: 10 + releases.length,
          immutable: false,
          ...(mode === "patch-clock" ? { html_url: draftPresentationUrl + "0".repeat(20) } : {}),
        };
        if (mode !== "lost-before-create") releases.push(value);
        if (mode.startsWith("lost-")) throw new Error("ambiguous POST response");
        return { status: 201, headers: new Map(), body: structuredClone(value) };
      }
      const selected = new RegExp(`^${root}/releases/(10|11|438789814)$`, "u").exec(endpoint);
      assert.ok(selected);
      const value = releases.find((release) => release.id === Number(selected[1]));
      assert.ok(value);
      if (method === "PATCH") {
        assert.ok(isRecord(body));
        if ("tag_name" in body) {
          assert.deepEqual(Object.keys(body).sort(), ["body", "tag_name", "target_commitish"]);
          assert.equal(body.tag_name, value.tag_name);
          assert.equal(body.target_commitish, value.target_commitish);
        } else {
          assert.deepEqual(Object.keys(body), ["body"]);
          if (mode === "patch-lost" && value.draft === true) {
            value.tag_name = "untagged-" + "0".repeat(20);
            value.target_commitish = "main";
          }
        }
        mutations.push({ method, body: structuredClone(body) });
        if (mode !== "patch-refused") value.body = body.body;
        if (mode === "patch-clock") {
          value.updated_at = new Date(mutations.length * 1000).toISOString();
          value.html_url = draftPresentationUrl + mutations.length.toString(16).padStart(20, "0");
        }
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
  const registration = {
    async releaseNotes() {
      return structuredClone(releases);
    },
    async release(id: number) {
      return api.request("GET", `repos/boburning/portcove/releases/${id}`);
    },
    async createDraft(body: Record<string, unknown>) {
      return api.request("POST", "repos/boburning/portcove/releases", body);
    },
    async appendNotes(
      id: number,
      body: string,
      draftIdentity?: { tag_name: string; target_commitish: string },
    ) {
      return api.request("PATCH", `repos/boburning/portcove/releases/${id}`, {
        body,
        ...draftIdentity,
      });
    },
  };
  const readRelease = async (id: number) => (await registration.release(id)).body;
  return { api, releases, mutations, guards, guard, registration, readRelease };
}

void test("immutable metadata recovery appends only its existing cohort and never creates or adopts a draft", async () => {
  const opportunity = "d".repeat(64);
  const f = fixture();
  const register = (id: string, mode: "create-or-resume" | "immutable-metadata-only") =>
    registerApplicationReleaseRun(
      f.registration,
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

void test("metadata successor retains the appointed empty draft and its original source", async () => {
  const opportunity = "d".repeat(64);
  const next = { ...execution, source: "e".repeat(40), run_id: "124" };
  for (const fault of [
    null,
    "assets",
    "notes",
    "drift",
    "missing-inventory",
    "inventory-drift",
    "inventory-tag-drift",
  ] as const) {
    const f = fixture();
    const first = await registerApplicationReleaseRun(
      f.registration,
      execution,
      source,
      tree,
      opportunity,
      f.guard,
    );
    const draft = f.releases[0]!;
    assert.equal(typeof draft.body, "string");
    draft.assets = fault === "assets" ? [{ id: 21 }] : [];
    const appointment = {
      release_id: first.release_id,
      notes_sha256: createHash("sha256").update(String(draft.body)).digest("hex"),
    };
    if (fault === "notes") draft.body = String(draft.body) + "changed";
    if (fault === "missing-inventory") f.registration.releaseNotes = async () => [];
    if (fault === "inventory-tag-drift") {
      f.registration.releaseNotes = async () => [{ ...draft, tag_name: "untagged-fixture" }];
    }
    if (fault === "inventory-drift") {
      f.registration.releaseNotes = async () => {
        const original = String(draft.body);
        draft.body = original.replace(
          JSON.stringify(first.custody),
          JSON.stringify({
            ...first.custody,
            runs: [
              ...first.custody.runs,
              {
                id: next.run_id,
                control_commit: next.source,
                control_ref: next.ref,
              },
            ],
          }),
        );
        assert.notEqual(draft.body, original);
        return structuredClone(f.releases);
      };
    }
    const recovery = resumeApplicationMetadataDraft(
      f.registration,
      next,
      opportunity,
      appointment,
      async (known) => {
        assert.deepEqual(known, [execution.run_id]);
        if (fault === "drift") draft.assets = [{ id: 21 }];
      },
    );
    if (fault) {
      await assert.rejects(recovery);
      assert.equal(f.mutations.length, 1);
    } else {
      const resumed = await recovery;
      assert.equal(resumed.release_id, first.release_id);
      assert.equal(resumed.custody.source, source);
      assert.equal(resumed.custody.source_tree, tree);
      const patch = f.mutations[1]?.body;
      assert.ok(isRecord(patch));
      assert.equal(patch.tag_name, `portcove-production-candidate-${opportunity}`);
      assert.equal(patch.target_commitish, source);
      assert.equal(draft.target_commitish, source);
      assert.deepEqual(resumed.custody.runs, [
        ...first.custody.runs,
        { id: next.run_id, control_commit: next.source, control_ref: next.ref },
      ]);
      assert.deepEqual(
        f.mutations.map(({ method }) => method),
        ["POST", "PATCH"],
      );
    }
  }
});

void test("bootstrap partial recovery preserves the appointed site asset and refuses drift before registration", async () => {
  for (const fault of [undefined, "unappointed", "identity", "drift"] as const) {
    const f = fixture();
    const first = await registerApplicationReleaseRun(
      f.registration,
      execution,
      source,
      tree,
      source,
      f.guard,
    );
    const draft = f.releases[0]!;
    const asset = { id: 21, name: "application-site.zip", bytes: 123, sha256: "d".repeat(64) };
    draft.assets = [
      {
        id: asset.id,
        name: asset.name,
        size: asset.bytes,
        digest: `sha256:${asset.sha256}`,
        state: "uploaded",
      },
    ];
    const appointed = {
      release_id: first.release_id,
      notes_sha256: createHash("sha256").update(String(draft.body)).digest("hex"),
      ...(fault === "unappointed" ? {} : { site_archive: asset }),
    };
    if (fault === "identity") (draft.assets as { id: number }[])[0]!.id++;
    const result = resumeApplicationMetadataDraft(
      f.registration,
      { ...execution, run_id: "124" },
      source,
      appointed,
      async () => {
        if (fault === "drift") draft.assets = [];
      },
    );
    if (fault) {
      await assert.rejects(result);
      assert.equal(f.mutations.length, 1);
    } else {
      const resumed = await result;
      assert.equal(resumed.custody.runs.length, 2);
      assert.deepEqual(draft.assets, [
        {
          id: asset.id,
          name: asset.name,
          size: asset.bytes,
          digest: `sha256:${asset.sha256}`,
          state: "uploaded",
        },
      ]);
      assert.deepEqual(
        f.mutations.map((row) => row.method),
        ["POST", "PATCH"],
      );
    }
  }
  const valid = {
    release_id: 10,
    notes_sha256: "a".repeat(64),
    site_archive: { id: 21, name: "application-site.zip", bytes: 123, sha256: "d".repeat(64) },
  };
  for (const asset of [
    undefined,
    { ...valid.site_archive, name: "application-metadata.json" },
    { ...valid.site_archive, bytes: applicationSourcePacketMaximumBytes / 2 + 1 },
    { ...valid.site_archive, id: "21" },
  ])
    assert.throws(() => inspectBootstrapDraftRecovery({ ...valid, site_archive: asset }));
});

void test("native draft registration precedes private work and a same-run retry preserves its single record", async () => {
  const f = fixture();
  const first = await registerApplicationReleaseRun(
    f.registration,
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
    f.registration,
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
    await readRegisteredApplicationRuns(f.registration, 10, source, source, tree, execution),
    first.custody,
  );
  await assert.rejects(() =>
    readRegisteredApplicationRuns(f.registration, 10, source, source, "d".repeat(40), execution),
  );
  await assert.rejects(() =>
    readRegisteredApplicationRuns(f.registration, 10, source, source, tree, {
      ...execution,
      source: "f".repeat(40),
    }),
  );
});

void test("recovery appends a bounded native run after immutable publication without changing assets or notes", async () => {
  const f = fixture("patch-lost");
  await registerApplicationReleaseRun(f.registration, execution, source, tree, source, f.guard);
  Object.assign(f.releases[0]!, {
    tag_name: "v0.1.0-alpha.3",
    target_commitish: source,
    draft: false,
    immutable: true,
    assets: [{ id: 99, digest: "sha256:unchanged" }],
  });
  const prior = structuredClone(f.releases[0]);
  const second = await registerApplicationReleaseRun(
    f.registration,
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
    f.registration,
    { ...execution, run_id: "125" },
    source,
    tree,
    source,
    f.guard,
  );
  await assert.rejects(
    registerApplicationReleaseRun(
      f.registration,
      { ...execution, run_id: "126" },
      source,
      tree,
      source,
      f.guard,
    ),
  );
  await assert.rejects(
    registerApplicationReleaseRun(
      f.registration,
      { ...execution, source: "f".repeat(40) },
      source,
      tree,
      source,
      f.guard,
    ),
  );
});

void test("ordinary draft re-registration survives an ambiguous notes PATCH without changing tag or target", async () => {
  const f = fixture("patch-lost");
  await registerApplicationReleaseRun(f.registration, execution, source, tree, source, f.guard);
  const prior = structuredClone(f.releases[0]!);
  const next = await registerApplicationReleaseRun(
    f.registration,
    { ...execution, run_id: "124" },
    source,
    tree,
    source,
    f.guard,
  );
  assert.deepEqual(next.known_run_ids, ["123", "124"]);
  assert.deepEqual({ ...f.releases[0], body: prior.body }, prior);
  assert.deepEqual(
    f.mutations.map(({ method }) => method),
    ["POST", "PATCH"],
  );
  assert.deepEqual(f.mutations[1]!.body, {
    body: f.releases[0]!.body,
    tag_name: prior.tag_name,
    target_commitish: prior.target_commitish,
  });
});

void test("ambiguous POST is reconciled once; absent, duplicate, damaged or refused custody never resets", async () => {
  for (const mode of ["lost-after-create", "lost-before-create"]) {
    const f = fixture(mode);
    const pending = registerApplicationReleaseRun(
      f.registration,
      execution,
      source,
      tree,
      source,
      f.guard,
    );
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
    await registerApplicationReleaseRun(f.registration, execution, source, tree, source, f.guard);
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
        f.registration,
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
    f.registration,
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
    f.registration,
    10,
    registered.custody,
    preparation,
    f.guard,
  );
  assert.deepEqual(retained.preparation, preparation);
  assert.deepEqual(readApplicationRunNotes(f.releases[0]!.body)?.custody, retained);
  assert.deepEqual(f.mutations[1]!.body, {
    body: f.releases[0]!.body,
    tag_name: `portcove-production-candidate-${source}`,
    target_commitish: source,
  });
  const writes = f.mutations.length;
  assert.deepEqual(
    await retainApplicationPreparation(f.registration, 10, retained, preparation, f.guard),
    retained,
  );
  assert.equal(f.mutations.length, writes);
  await assert.rejects(
    retainApplicationPreparation(
      f.registration,
      10,
      retained,
      { ...preparation, version: "0.1.0-alpha.4" },
      f.guard,
    ),
  );
  await assert.rejects(
    retainApplicationPreparation(
      f.registration,
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
    f.registration,
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
        f.registration,
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
      f.registration,
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
  await registerApplicationReleaseRun(f.registration, execution, source, tree, source, f.guard);
  const writes = f.mutations.length;
  await assert.rejects(
    registerApplicationReleaseRun(
      f.registration,
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
    f.registration,
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
      f.registration,
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
    f.registration,
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
    await readApplicationBudgetOwnerAsync(f.readRelease, {
      release_id: 11,
      custody: member,
    }),
    linked.owner,
  );
  const writes = f.mutations.length;
  const repeated = await registerApplicationBudgetRun(
    f.registration,
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
  await assert.rejects(() =>
    readApplicationBudgetOwnerAsync(f.readRelease, {
      release_id: 10,
      custody: member,
    }),
  );
  await assert.rejects(() =>
    readApplicationBudgetOwnerAsync(f.readRelease, {
      release_id: 11,
      custody: inspectApplicationRunCustody({
        ...member,
        budget: { ...linked.membership, owner_opportunity: "f".repeat(64) },
      }),
    }),
  );
  const expanded = await registerApplicationBudgetRun(
    f.registration,
    linked.owner,
    "e".repeat(64),
    { ...execution, run_id: "125" },
    async () => f.guard([]),
  );
  const totalWrites = f.mutations.length;
  await assert.rejects(
    registerApplicationBudgetRun(
      f.registration,
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
    f.registration,
    execution,
    source,
    tree,
    source,
    f.guard,
  );
  const opportunity = "d".repeat(64);
  const firstLink = await registerApplicationBudgetRun(
    f.registration,
    owner,
    opportunity,
    { ...execution, run_id: "124" },
    async () => {},
  );
  const member = await registerApplicationReleaseRun(
    f.registration,
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
    f.registration,
    member,
    opportunity,
    recovery,
    async () => {},
  );
  await assert.rejects(
    () =>
      registerApplicationReleaseRun(
        f.registration,
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
  assert.deepEqual(await readApplicationBudgetOwnerAsync(f.readRelease, member), linked.owner);
  const writes = f.mutations.length;
  const retry = await registerApplicationBudgetRun(
    f.registration,
    member,
    opportunity,
    recovery,
    async () => {},
  );
  assert.deepEqual(retry, linked);
  assert.equal(f.mutations.length, writes, "owner retry cannot repeat or erase accounting");
  const completed = await registerApplicationReleaseRun(
    f.registration,
    recovery,
    source,
    tree,
    opportunity,
    async (_known, context) => {
      assert.ok(context);
      assert.deepEqual(await readApplicationBudgetOwnerAsync(f.readRelease, context), linked.owner);
    },
    "immutable-metadata-only",
    firstLink.membership,
  );
  assert.deepEqual(completed.known_run_ids, ["124", "125"]);
  assert.deepEqual(await readApplicationBudgetOwnerAsync(f.readRelease, completed), linked.owner);
  assert.equal(f.mutations.length, writes + 1);
  assert.deepEqual({ ...f.releases[1], body: beforeMember?.body }, beforeMember);
  await assert.rejects(
    () =>
      readApplicationBudgetOwnerAsync(f.readRelease, {
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
      f.registration,
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
    f.registration,
    execution,
    source,
    tree,
    source,
    async () => f.guard([]),
  );
  const before = structuredClone(f.releases[0]);
  await assert.rejects(
    registerApplicationBudgetRun(
      f.registration,
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

void test("retained renewal draft continues with the exact prior reservation as its version floor", async () => {
  const f = fixture();
  const opportunity = "d".repeat(64);
  const initial = await registerApplicationReleaseRun(
    f.registration,
    execution,
    source,
    tree,
    opportunity,
    f.guard,
  );
  const firstPlan = await readApplicationMetadataContextPlan(f.registration, initial, execution);
  const burned = metadataReservation(opportunity, firstPlan.generated_at, "2");
  f.releases[0]!.assets = [];
  await retainApplicationMetadataContext(
    f.registration,
    initial,
    execution,
    burned,
    async () => {},
  );
  const appointment = {
    release_id: initial.release_id,
    notes_sha256: createHash("sha256").update(String(f.releases[0]!.body)).digest("hex"),
  };
  const next = { ...execution, source: "e".repeat(40), run_id: "124" };
  const before = f.mutations.length;
  await assert.rejects(
    resumeApplicationMetadataDraft(f.registration, next, opportunity, appointment, f.guard),
  );
  await assert.rejects(
    resumeApplicationMetadataDraft(f.registration, next, opportunity, appointment, f.guard, [
      "f".repeat(64),
    ]),
  );
  assert.equal(f.mutations.length, before);
  const resumed = await resumeApplicationMetadataDraft(
    f.registration,
    next,
    opportunity,
    appointment,
    f.guard,
    [burned.context_sha256],
  );
  assert.equal(resumed.custody.source, source);
  assert.deepEqual(resumed.custody.metadata_contexts, [burned]);
  assert.deepEqual(resumed.known_run_ids, [execution.run_id, next.run_id]);
  const newPlan = await readApplicationMetadataContextPlan(f.registration, resumed, next);
  assert.equal(newPlan.existing, undefined);
  assert.deepEqual(newPlan.previous_reserved_versions, burned.versions);
  assert.equal(f.mutations.length, before + 1);
});

void test("r56 resumes only the exact r55 draft and reserves above its original v6 context", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-09T07:00:00Z") });
  const retained = retainedR55Renewal;
  const exactNotes =
    "Portcove application preparation. No publication or acceptance is implied.\n\n<!-- portcove-application-runs-v1\n" +
    JSON.stringify({
      schema_version: 3,
      metadata_contexts: [
        {
          opportunity: "c3c807ea153d31ec420aec53cb146faf068049215a2994918364c8ef017b75de",
          run_id: "42570808720",
          run_attempt: 1,
          control_commit: "3dfc18b702caca3c7e7c06ae85cac5f0d93365dd",
          control_ref: "refs/tags/portcove-production-controller-windows-20261108r55",
          generated_at: "2026-11-09T06:09:19.149Z",
          root_sha256: "17de1676cd26c4bd2867d3a7941793147b94670d027e7846557d813bc9f43f92",
          offline_targets_sha256:
            "377ca58a2535229056afe552ca34035c3c0791fe4b8ac1a3a0b861dfc2782642",
          prior_repository_sha256:
            "2f09956c9673b69a37fff2556e611af654adf4141f80ffc24a2d207d7873354e",
          versions: {
            targets: "1",
            snapshot: "6",
            timestamp: "6",
            releases: "6",
            preview: "6",
            stable: "6",
          },
          context_sha256: "bf4c4a0cf397347ccd054b72c260717c6f8ab97dbaba7d1a6a4fb1d0bed26fc4",
          context_inventory_sha256:
            "f7e7f12aec267e3eab28e6c340566652cce2b6bdd7f98cdd21efca794826e16a",
          records_sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        },
      ],
      kind: "application-release-run-custody",
      source: "3dfc18b702caca3c7e7c06ae85cac5f0d93365dd",
      source_tree: "6c40e31c26cb60e57a98e31fa6c22ebd72f328d6",
      opportunity: "c3c807ea153d31ec420aec53cb146faf068049215a2994918364c8ef017b75de",
      preparation: null,
      runs: [
        {
          id: "42570808720",
          control_commit: "3dfc18b702caca3c7e7c06ae85cac5f0d93365dd",
          control_ref: "refs/tags/portcove-production-controller-windows-20261108r55",
        },
      ],
    }) +
    "\n-->";
  const original = readApplicationRunNotes(exactNotes)?.custody;
  assert.ok(original);
  const burned = original.metadata_contexts?.[0];
  assert.ok(burned);
  assert.equal(burned.context_sha256, retained.context_sha256);
  const draft = {
    id: retained.release_id,
    draft: true,
    prerelease: true,
    immutable: false,
    tag_name: `portcove-production-candidate-${retained.opportunity}`,
    target_commitish: retained.original_source,
    body: exactNotes,
    assets: [],
  };
  const next = { ...execution, ref: retained.next_ref };
  for (const refused of [
    { ...next, ref: execution.ref },
    { ...next, source: retained.original_source },
    { ...next, run_id: retained.original_run_id },
    { ...next, run_attempt: 2 },
  ]) {
    const f = fixture();
    f.releases.push(draft);
    await assert.rejects(
      resumeR55MetadataDraft(f.registration, refused, retained.opportunity, f.guard),
    );
    assert.equal(f.mutations.length, 0);
  }
  for (const drift of [
    { body: exactNotes + "\n" },
    { assets: [{ id: 5, name: "unexpected.json", state: "uploaded" }] },
    { target_commitish: "1".repeat(40) },
  ]) {
    const f = fixture();
    f.releases.push({ ...draft, ...drift });
    await assert.rejects(
      resumeR55MetadataDraft(f.registration, next, retained.opportunity, f.guard),
    );
    assert.equal(f.mutations.length, 0);
  }

  const f = fixture();
  f.releases.push({ ...draft });
  await assert.rejects(resumeR55MetadataDraft(f.registration, next, "1".repeat(64), f.guard));
  assert.equal(f.mutations.length, 0);
  const resumed = await resumeR55MetadataDraft(f.registration, next, retained.opportunity, f.guard);
  assert.equal(resumed.release_id, retained.release_id);
  assert.equal(resumed.custody.source, retained.original_source);
  assert.deepEqual(resumed.known_run_ids, [retained.original_run_id, next.run_id]);
  assert.deepEqual(resumed.custody.metadata_contexts, [burned]);
  assert.equal(f.mutations.length, 1);
  const plan = await readApplicationMetadataContextPlan(f.registration, resumed, next);
  assert.equal(plan.existing, undefined);
  assert.deepEqual(plan.previous_reserved_versions, burned.versions);
  const replacement = {
    ...burned,
    generated_at: plan.generated_at,
    run_id: next.run_id,
    control_commit: next.source,
    control_ref: next.ref,
    context_sha256: "1".repeat(64),
    context_inventory_sha256: "2".repeat(64),
  };
  await assert.rejects(
    retainApplicationMetadataContext(f.registration, resumed, next, replacement, async () => {}),
  );
  assert.equal(f.mutations.length, 1);
  const forward = {
    ...replacement,
    versions: {
      targets: "1",
      releases: "7",
      preview: "7",
      stable: "7",
      snapshot: "7",
      timestamp: "7",
    },
  };
  const result = await retainApplicationMetadataContext(
    f.registration,
    resumed,
    next,
    forward,
    async () => {},
  );
  assert.deepEqual(result.custody.metadata_contexts, [burned, forward]);
});

void test("native context reservations freeze full bytes and burn versions under the original cost owner", async () => {
  const f = fixture(),
    opportunity = "d".repeat(64);
  const registered = await registerApplicationReleaseRun(
    f.registration,
    execution,
    source,
    tree,
    opportunity,
    async () => {},
  );
  const plan = await readApplicationMetadataContextPlan(f.registration, registered, execution);
  assert.equal(plan.existing, undefined);
  const first = metadataReservation(opportunity, plan.generated_at, "2");
  const retained = await retainApplicationMetadataContext(
    f.registration,
    registered,
    execution,
    first,
    async () => {
      assert.equal(f.mutations.length, 1, "reservation must precede any context consumer");
    },
  );
  assert.deepEqual(f.mutations[1], {
    method: "PATCH",
    body: {
      body: retained.notes,
      tag_name: `portcove-production-candidate-${opportunity}`,
      target_commitish: source,
    },
  });
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
  await retainApplicationMetadataContext(
    f.registration,
    registered,
    execution,
    first,
    async () => {},
  );
  assert.equal(f.mutations.length, mutations, "exact producer reuse must not rewrite notes");
  // The context JSON can be identical while its referenced record bytes differ.
  await assert.rejects(
    retainApplicationMetadataContext(
      f.registration,
      registered,
      execution,
      { ...first, context_inventory_sha256: "f".repeat(64) },
      async () => {},
    ),
    /exact bytes/,
  );
  assert.equal(f.mutations.length, mutations);
  const secondActor = { ...execution, run_attempt: 2 };
  const secondPlan = await readApplicationMetadataContextPlan(
    f.registration,
    registered,
    secondActor,
  );
  assert.deepEqual(secondPlan.previous_reserved_versions, first.versions);
  const second = metadataReservation(
    opportunity,
    secondPlan.generated_at,
    "3",
    secondActor,
    "a".repeat(64),
  );
  const secondRetained = await retainApplicationMetadataContext(
    f.registration,
    registered,
    secondActor,
    second,
    async () => {},
  );
  assert.deepEqual(secondRetained.custody.metadata_contexts, [first, second]);
  assert.deepEqual(secondRetained.custody.runs, registered.custody.runs);
  await assert.rejects(
    () => readApplicationMetadataContextPlan(f.registration, registered, execution),
    /superseded/,
  );
  await assert.rejects(
    retainApplicationMetadataContext(
      f.registration,
      registered,
      { ...execution, run_attempt: 3 },
      { ...second, run_attempt: 3 },
      async () => {},
    ),
    /reused an online version/,
  );
  assert.equal(readApplicationRunNotes(f.releases[0]!.body)!.custody.metadata_contexts?.length, 2);
});

void test("immutable metadata reservation sends only notes", async () => {
  const f = fixture();
  const owner = await registerApplicationReleaseRun(
    f.registration,
    execution,
    source,
    tree,
    source,
    async () => {},
  );
  Object.assign(f.releases[0]!, { draft: false, immutable: true });
  const plan = await readApplicationMetadataContextPlan(f.registration, owner, execution);
  const reservation = metadataReservation(source, plan.generated_at, "2");
  const retained = await retainApplicationMetadataContext(
    f.registration,
    owner,
    execution,
    reservation,
    async () => {},
  );
  assert.deepEqual(f.mutations[1], { method: "PATCH", body: { body: retained.notes } });
});

void test("related metadata contexts retain the original owner history and every registered run", async () => {
  const f = fixture("patch-clock");
  const owner = await registerApplicationReleaseRun(
    f.registration,
    execution,
    source,
    tree,
    source,
    async () => {},
  );
  const firstPlan = await readApplicationMetadataContextPlan(f.registration, owner, execution);
  const first = metadataReservation(source, firstPlan.generated_at, "2");
  await retainApplicationMetadataContext(f.registration, owner, execution, first, async () => {});
  const memberActor = { ...execution, run_id: "124" },
    opportunity = "d".repeat(64);
  const linked = await registerApplicationBudgetRun(
    f.registration,
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
    f.registration,
    memberActor,
    source,
    tree,
    opportunity,
    async () => {},
    "create-or-resume",
    linked.membership,
  );
  const plan = await readApplicationMetadataContextPlan(f.registration, member, memberActor);
  assert.deepEqual(plan.previous_reserved_versions, first.versions);
  const second = metadataReservation(
    opportunity,
    plan.generated_at,
    "3",
    memberActor,
    "a".repeat(64),
  );
  const retained = await retainApplicationMetadataContext(
    f.registration,
    member,
    memberActor,
    second,
    async () => {},
  );
  assert.equal(retained.release_id, owner.release_id);
  assert.deepEqual(retained.custody.metadata_contexts, [first, second]);
  assert.equal(readApplicationRunNotes(f.releases[1]!.body)!.custody.metadata_contexts, undefined);
  assert.deepEqual(
    (await readApplicationBudgetOwnerAsync(f.readRelease, member)).custody.metadata_contexts,
    [first, second],
  );
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
  const previousUrl = f.releases[0]!.html_url;
  const stored = await retainApplicationDraftAssembly(
    f.registration,
    member,
    memberActor,
    assembly,
    async () => assert.equal(f.mutations.length, beforeAssembly),
  );
  assert.notEqual(f.releases[0]!.updated_at, previousEdit);
  assert.notEqual(f.releases[0]!.html_url, previousUrl);
  assert.deepEqual(stored.custody.draft_assemblies, [assembly]);
  assert.deepEqual(
    (await readApplicationBudgetOwnerAsync(f.readRelease, member)).custody,
    stored.custody,
  );
  assert.equal(readApplicationRunNotes(f.releases[1]!.body)!.custody.draft_assemblies, undefined);
  await retainApplicationDraftAssembly(
    f.registration,
    member,
    memberActor,
    assembly,
    async () => {},
  );
  assert.equal(f.mutations.length, beforeAssembly + 1);
  await assert.rejects(
    retainApplicationDraftAssembly(
      f.registration,
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
  const nextPlan = await readApplicationMetadataContextPlan(f.registration, member, nextActor);
  const replacement = metadataReservation(
    opportunity,
    nextPlan.generated_at,
    "4",
    nextActor,
    "b".repeat(64),
  );
  await retainApplicationMetadataContext(
    f.registration,
    member,
    nextActor,
    replacement,
    async () => {},
  );
  const both = await retainApplicationDraftAssembly(
    f.registration,
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
    retainApplicationDraftRecovery(f.registration, member, nextActor, recovery, async () => {
      throw new Error("backup or live draft guard failed");
    }),
    /guard failed/,
  );
  assert.equal(f.mutations.length, beforeRecovery);
  const committed = await retainApplicationDraftRecovery(
    f.registration,
    member,
    nextActor,
    recovery,
    async () => {},
  );
  assert.deepEqual(committed.custody.draft_recoveries, [recovery]);
  assert.deepEqual(
    (await readApplicationBudgetOwnerAsync(f.readRelease, member)).custody,
    committed.custody,
  );
  assertApplicationCustodyMetadataExtension(both.custody, committed.custody);
  assert.throws(() => assertApplicationCustodyMetadataExtension(committed.custody, both.custody));
  await retainApplicationDraftRecovery(f.registration, member, nextActor, recovery, async () => {});
  assert.equal(f.mutations.length, beforeRecovery + 1);
  await assert.rejects(
    retainApplicationDraftRecovery(
      f.registration,
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
    claimApplicationDraftAssetRemoval(
      f.registration,
      member,
      nextActor,
      recovery,
      29,
      async () => {},
    );
  assert.deepEqual(await claim(), {
    release_id: owner.release_id,
    notes: f.releases[0]!.body,
  });
  assert.equal(await claim(), undefined);
  assert.equal(f.mutations.length, beforeRecovery + 2);
  const ownerWithClaim = (await readApplicationBudgetOwnerAsync(f.readRelease, member)).custody;
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
      f.registration,
      execution,
      source,
      tree,
      opportunity,
      async () => {},
    );
    const plan = await readApplicationMetadataContextPlan(f.registration, registered, execution);
    const reservation = metadataReservation(opportunity, plan.generated_at, "2");
    const pending = retainApplicationMetadataContext(
      f.registration,
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

void test("fixed run registration uses the locked SDK for one-attempt drafts and exact recovery", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-run-registration";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  for (const mode of [
    "valid",
    "lost-after-create",
    "lost-before-create",
    "refused-guard",
    "patch-lost",
  ]) {
    const f = fixture(mode);
    const calls: string[] = [];
    const mockedFetch = t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(request.headers.get("authorization"), "token inert-run-registration");
        calls.push(request.method + " " + url.pathname + url.search);
        const data: unknown = request.method === "GET" ? undefined : await request.json();
        const response = f.api.request(request.method, url.pathname.slice(1) + url.search, data);
        return Response.json(response.body, { status: response.status ?? 500 });
      },
    );
    try {
      const provider = await createApplicationRunRegistrationProvider();
      const run = registerApplicationReleaseRun(
        provider,
        execution,
        source,
        tree,
        source,
        async (known) => {
          assert.deepEqual(known, []);
          if (mode === "refused-guard") throw new Error("fixture refused registration guard");
        },
      );
      if (mode === "lost-before-create" || mode === "refused-guard") await assert.rejects(run);
      else assert.equal((await run).release_id, 10);
      assert.equal(
        calls.filter((call) => call.startsWith("POST ")).length,
        mode === "refused-guard" ? 0 : 1,
      );
      if (mode === "patch-lost") {
        calls.length = 0;
        const second = await registerApplicationReleaseRun(
          await createApplicationRunRegistrationProvider(),
          { ...execution, run_id: "124" },
          source,
          tree,
          source,
          async (known) => assert.deepEqual(known, ["123"]),
        );
        assert.deepEqual(second.known_run_ids, ["123", "124"]);
        assert.equal(
          calls.filter((call) => call === "PATCH /repos/boburning/portcove/releases/10").length,
          1,
        );
        assert.equal(calls.at(-1), "GET /repos/boburning/portcove/releases/10");
        const actor = { ...execution, run_id: "124" };
        const plan = await readApplicationMetadataContextPlan(provider, second, actor);
        const reservation = metadataReservation(source, plan.generated_at, "2", actor);
        calls.length = 0;
        const retained = await retainApplicationMetadataContext(
          provider,
          second,
          actor,
          reservation,
          async () => {},
        );
        assert.deepEqual(retained.custody.metadata_contexts, [reservation]);
        const route = "/repos/boburning/portcove/releases/10";
        assert.deepEqual(calls, [
          `GET ${route}`,
          `GET ${route}`,
          `GET ${route}`,
          `PATCH ${route}`,
          `GET ${route}`,
        ]);
      }
      if (mode === "lost-after-create") {
        assert.equal(calls.filter((call) => call.includes("/releases?per_page=100")).length, 3);
        assert.equal(calls.at(-1), "GET /repos/boburning/portcove/releases/10");
      }
    } finally {
      mockedFetch.mock.restore();
    }
  }
});

void test("r57 accepts only the exact pre-native r56 Pages receipt", () => {
  const evidence = {
    schema_version: 1,
    intent: {
      repository_id: 1354613114,
      site_url: "https://boburning.github.io/portcove/",
      generation: "fa46b99d77acb7bcbd09a699884522cf6afec098692202e13ebd0b627827fada",
      run_id: "42577153790",
      run_attempt: 1,
      artifact_id: 13655854560,
      build_version: "54b124475a390a6813ab90b33b571711da54c626",
    },
    stage: "protection-policy",
    prior_effect: null,
    requests: [],
  };
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(evidence) + "\n")
      .digest("hex"),
    retainedR56FeedRecovery.evidence_sha256,
  );
  requireRetainedR56PreNativeEvidence(evidence);
  for (const changed of [
    { ...evidence, requests: [{ stage: "create", status: 500 }] },
    { ...evidence, stage: "native-create" },
    { ...evidence, prior_effect: { outcome: "unknown" } },
    { ...evidence, intent: { ...evidence.intent, artifact_id: 1 } },
    { ...evidence, intent: { ...evidence.intent, generation: "a".repeat(64) } },
  ])
    assert.throws(() => requireRetainedR56PreNativeEvidence(changed), /pre-native evidence/u);
});
