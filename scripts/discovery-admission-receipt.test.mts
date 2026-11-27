import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import {
  checkDiscoveryAdmissionPaths,
  checkDiscoveryReplayTree,
  generatedAdmissionDirectory,
  generatedAdmissionRegistration,
  checkDiscoveryRegistrationDelta,
} from "./discovery-admission-branch.mts";
import {
  scheduledDiscoveryReplayReceipt,
  verifyScheduledDiscoveryReplay,
} from "./discovery-admission-receipt.mts";
import {
  catalogAdmissionGitHub,
  checkCatalogAdmissionBranchFence,
  openCatalogAdmissionProposal,
} from "./discovery-admission-github.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { verifyCatalogAdmissionReview } from "./discovery-admission-review-receipt.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

const run = 159;
const attempt = 2;
const route = "repos/boburning/portcove/actions";
const sourcePath = `${route}/runs/${run}/attempts/${attempt}`;
const artifactPath = `${route}/runs/${run}/artifacts?name=listing-admission-replay-${run}-${attempt}&per_page=100`;
const jobPath = `${sourcePath}/jobs?per_page=100`;
const zipPath = `${route}/artifacts/13/zip`;
const sourceRevision = "a".repeat(40);
const handoff = {
  format: "portcove-discovery-listing-handoff",
  format_version: 1,
  candidates: [
    {
      id: "github-42",
      project_url: "https://github.com/fixture/example",
      repository_id: 42,
      evidence_sha256: "b".repeat(64),
    },
  ],
};
const report = {
  admission: { sha256: "c".repeat(64) },
  released_validation: { status: "validated" },
  automatic_listed_date: "2026-11-26",
  handoff_semantic_sha256: orderedJsonSha256(handoff),
  changed_records: ["github-42"],
};
const workflow = ".github/workflows/maintenance-inventory.yml";
const context = {
  GITHUB_EVENT_NAME: "schedule",
  GITHUB_REPOSITORY: "boburning/portcove",
  GITHUB_WORKFLOW_REF: `boburning/portcove/${workflow}@refs/heads/main`,
  GITHUB_WORKFLOW_SHA: sourceRevision,
  GITHUB_SHA: sourceRevision,
  GITHUB_RUN_ID: String(run),
  GITHUB_RUN_ATTEMPT: String(attempt),
};

function reviewFixture() {
  const repo = "boburning/portcove";
  const repoId = 1354613114;
  const controller = "b".repeat(40);
  const request = {
    review: "240/2",
    producer: "159/2",
    pull: 9285,
    source: sourceRevision,
    head: "c".repeat(40),
    tree: "d".repeat(40),
  };
  const body = {
    format_version: 1,
    discovery_run: "159",
    discovery_attempt: "2",
    source: request.source,
    head: request.head,
    tree: request.tree,
    pull_request: request.pull,
  };
  const review = {
    id: 240,
    run_attempt: 2,
    workflow_id: 432038839,
    path: ".github/workflows/catalog-admission.yml",
    event: "workflow_run",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: controller,
    repository: { id: repoId },
    head_repository: { id: repoId },
  };
  const job = {
    run_id: 240,
    run_attempt: 2,
    head_sha: controller,
    name: "review",
    conclusion: "success",
    steps: [
      { name: "Independently replay the exact draft tree", conclusion: "success" },
      { name: "Retain the independent replay receipt", conclusion: "success" },
    ],
  };
  const artifact = {
    name: "catalog-admission-review-240-2",
    id: 800,
    expired: false,
    digest: "",
    workflow_run: {
      id: 240,
      repository_id: repoId,
      head_repository_id: repoId,
      head_branch: "main",
      head_sha: controller,
    },
  };
  const archive = () =>
    createAuditZip([
      ["catalog-admission-review.json", Buffer.from(JSON.stringify(body)), { descriptor: true }],
    ]);
  artifact.digest = `sha256:${createHash("sha256").update(archive()).digest("hex")}`;
  const runPath = `repos/${repo}/actions/runs/240`;
  const load = async (route: string) => {
    if (route === `${runPath}/attempts/2`) return review;
    if (route === `${runPath}/attempts/2/jobs?per_page=100`) return { total_count: 1, jobs: [job] };
    if (route === `${runPath}/artifacts?name=catalog-admission-review-240-2&per_page=100`)
      return { total_count: 1, artifacts: [artifact] };
    assert.equal(route, `repos/${repo}/actions/artifacts/800/zip`);
    return archive();
  };
  return {
    request,
    review,
    job,
    artifact,
    body,
    load,
    reseal() {
      artifact.digest = `sha256:${createHash("sha256").update(archive()).digest("hex")}`;
    },
  };
}

void test("guarded admission can retrieve an exact successful review despite later workflow failure", async () => {
  const f = reviewFixture();
  const result = await verifyCatalogAdmissionReview(f.request, f.load);
  assert.deepEqual(result, {
    ...f.body,
    review: "240/2",
    controller: f.review.head_sha,
    artifact: 800,
    digest: f.artifact.digest,
  });
});

void test("guarded admission refuses foreign attempts, missing review steps, and changed artifacts", async () => {
  const foreign = reviewFixture();
  foreign.review.workflow_id++;
  await assert.rejects(
    verifyCatalogAdmissionReview(foreign.request, foreign.load),
    /completed catalog admission/u,
  );
  const skipped = reviewFixture();
  skipped.job.steps[1]!.conclusion = "skipped";
  await assert.rejects(
    verifyCatalogAdmissionReview(skipped.request, skipped.load),
    /successful receipt upload/u,
  );
  const changed = reviewFixture();
  changed.body.tree = "e".repeat(40);
  await assert.rejects(
    verifyCatalogAdmissionReview(changed.request, changed.load),
    /artifact digest/u,
  );
  changed.reseal();
  await assert.rejects(
    verifyCatalogAdmissionReview(changed.request, changed.load),
    /exact proposal or producer/u,
  );
  const replay = reviewFixture();
  replay.artifact.workflow_run.head_sha = "e".repeat(40);
  await assert.rejects(
    verifyCatalogAdmissionReview(replay.request, replay.load),
    /exact workflow attempt/u,
  );
});
const receiptFile = "listing-admission-replay.json";
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const bytes = scheduledDiscoveryReplayReceipt(report, handoff, context);
  assert.ok(bytes);
  const repositoryId = 1354613114;
  const runRecord = {
    id: run,
    run_attempt: attempt,
    workflow_id: 416797406,
    path: workflow,
    status: "completed",
    event: "schedule",
    conclusion: "failure",
    head_branch: "main",
    head_sha: sourceRevision,
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
  };
  const discover = {
    name: "discover",
    run_id: run,
    run_attempt: attempt,
    head_sha: sourceRevision,
    conclusion: "success",
    steps: [
      {
        name: "Prepare listing admission from scheduled discovery evidence",
        conclusion: "success",
      },
      { name: "Retain scheduled listing admission replay receipt", conclusion: "success" },
    ],
  };
  const jobs = { total_count: 2, jobs: [discover, { name: "collect", conclusion: "failure" }] };
  let zip: Buffer = createAuditZip([[receiptFile, bytes, { descriptor: true }]]);
  const artifact = {
    name: `listing-admission-replay-${run}-${attempt}`,
    id: 13,
    expired: false,
    digest: `sha256:${sha256(zip)}`,
    workflow_run: {
      id: run,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_branch: "main",
      head_sha: sourceRevision,
    },
  };
  const artifacts = { total_count: 1, artifacts: [artifact] };
  const responses = new Map<string, object>([
    [sourcePath, runRecord],
    [jobPath, jobs],
    [artifactPath, artifacts],
  ]);
  const read = (path: string) => {
    const response = path === zipPath ? zip : responses.get(path);
    assert.ok(response, `unexpected fetch of ${path}`);
    return Promise.resolve(response);
  };
  return {
    read,
    bytes,
    runRecord,
    discover,
    jobs,
    artifact,
    artifacts,
    replaceZip(archive: Buffer) {
      zip = archive;
      artifact.digest = `sha256:${sha256(zip)}`;
    },
  };
}

void test("seals only released-Core preparation from the scheduled source", () => {
  assert.equal(
    scheduledDiscoveryReplayReceipt({ ...report, admission: null }, handoff, context),
    null,
  );
  assert.throws(
    () =>
      scheduledDiscoveryReplayReceipt(report, handoff, { ...context, GITHUB_EVENT_NAME: "push" }),
    /approved read-only producer/u,
  );
  assert.throws(
    () => scheduledDiscoveryReplayReceipt(report, { ...handoff, candidates: [] }, context),
    /approved read-only producer/u,
  );
});

void test("binds the exact scheduled job, artifact bytes and replay inputs despite an unrelated job failure", async () => {
  const { read } = fixture();
  assert.deepEqual(await verifyScheduledDiscoveryReplay(`${run}/${attempt}`, read), {
    handoff,
    revision: sourceRevision,
    expectedPatchSha256: report.admission.sha256,
    previewListedDate: report.automatic_listed_date,
  });
});

void test("replay seals only candidates prepared before the preview deadline", async () => {
  const later = {
    ...handoff.candidates[0]!,
    id: "github-43",
    repository_id: 43,
    project_url: "https://github.com/fixture/later",
  };
  const source = { ...handoff, candidates: [...handoff.candidates, later] };
  const prepared = { ...report, handoff_semantic_sha256: orderedJsonSha256(source) };
  const receipt = scheduledDiscoveryReplayReceipt(prepared, source, context);
  assert.ok(receipt);
  const document: unknown = JSON.parse(receipt.toString());
  assert.ok(isRecord(document));
  assert.equal(document.format_version, 2);
  assert.equal(document.source_handoff_sha256, orderedJsonSha256(source));
  assert.equal(document.handoff_sha256, orderedJsonSha256(handoff));
  const retained = fixture();
  retained.replaceZip(createAuditZip([[receiptFile, receipt]]));
  assert.deepEqual(
    (await verifyScheduledDiscoveryReplay(`${run}/${attempt}`, retained.read)).handoff,
    handoff,
  );
  assert.throws(
    () =>
      scheduledDiscoveryReplayReceipt(
        { ...prepared, changed_records: ["github-99"] },
        source,
        context,
      ),
    /prepared discovery candidates differ/iu,
  );
  assert.throws(
    () =>
      scheduledDiscoveryReplayReceipt(
        { ...prepared, changed_records: ["github-42", "github-42"] },
        source,
        context,
      ),
    /unique prepared candidates/u,
  );
  const duplicate = { ...source, candidates: [...source.candidates, handoff.candidates[0]] };
  assert.throws(
    () =>
      scheduledDiscoveryReplayReceipt(
        { ...prepared, handoff_semantic_sha256: orderedJsonSha256(duplicate) },
        duplicate,
        context,
      ),
    /prepared discovery candidates differ/iu,
  );
});

void test("retained format-one replay receipts still bind their original handoff", async () => {
  const retained = fixture();
  const original: unknown = JSON.parse(retained.bytes.toString());
  assert.ok(isRecord(original));
  const legacy: Record<string, unknown> = { ...original, format_version: 1 };
  delete legacy["source_handoff_sha256"];
  retained.replaceZip(createAuditZip([[receiptFile, JSON.stringify(legacy)]]));
  assert.deepEqual(
    (await verifyScheduledDiscoveryReplay(`${run}/${attempt}`, retained.read)).handoff,
    handoff,
  );
});

void test("refuses incomplete or mismatched origin and artifact evidence", async () => {
  const cases: [RegExp, (input: ReturnType<typeof fixture>) => void][] = [
    [/completed scheduled/u, ({ runRecord }) => (runRecord.event = "workflow_dispatch")],
    [/completed scheduled/u, ({ runRecord }) => (runRecord.head_repository.id = 1)],
    [/enumeration is incomplete/u, ({ jobs }) => (jobs.total_count = 101)],
    [/successful scheduled discovery/u, ({ discover }) => (discover.run_attempt = 1)],
    [/exactly one retained/u, ({ artifacts }) => (artifacts.total_count = 2)],
    [/artifact metadata differs/u, ({ artifact }) => (artifact.expired = true)],
    [/archive differs/u, ({ artifact }) => (artifact.digest = `sha256:${"d".repeat(64)}`)],
    [
      /ZIP rejected/u,
      (f) =>
        f.replaceZip(
          createAuditZip([
            [receiptFile, f.bytes],
            ["extra.patch", "invalid"],
          ]),
        ),
    ],
    [
      /differs from its scheduled source or handoff/u,
      (f) => {
        const original: unknown = JSON.parse(f.bytes.toString());
        assert.ok(isRecord(original));
        const forged = {
          ...original,
          handoff: { ...handoff, candidates: [] },
        };
        f.replaceZip(createAuditZip([[receiptFile, JSON.stringify(forged)]]));
      },
    ],
    [
      /differs from its scheduled source or handoff/u,
      (f) => {
        const original: unknown = JSON.parse(f.bytes.toString());
        assert.ok(isRecord(original));
        const forged = { ...original, source_handoff_sha256: "unknown" };
        f.replaceZip(createAuditZip([[receiptFile, JSON.stringify(forged)]]));
      },
    ],
  ];
  for (const [expected, change] of cases) {
    const input = fixture();
    change(input);
    await assert.rejects(verifyScheduledDiscoveryReplay(`${run}/${attempt}`, input.read), expected);
  }
});

void test("an admission proposal can only add numeric upstream listings and regenerate their directory", () => {
  const path = "crates/portcove-core/catalog/ports/github-52.json";
  const staged = `A\0${path}\0`;
  const projection = `M\0${generatedAdmissionDirectory}\0M\0${generatedAdmissionRegistration}\0`;
  assert.deepEqual(checkDiscoveryAdmissionPaths(staged, false), [path]);
  assert.deepEqual(checkDiscoveryAdmissionPaths(projection + staged, true), [path]);
  for (const invalid of [
    staged + "M\0.github/workflows/ci.yml\0",
    staged + "A\0crates/portcove-core/catalog/ports/github-0.json\0",
    `M\0${path}\0`,
    `D\0${path}\0`,
    staged + staged,
    projection,
    staged.slice(0, -1),
  ]) {
    assert.throws(() => checkDiscoveryAdmissionPaths(invalid, true), /admission/u);
  }
  assert.throws(() => checkDiscoveryAdmissionPaths(staged, true), /generated directory/u);
  assert.throws(() => checkDiscoveryAdmissionPaths(staged + projection, false), /append-only/u);
});

void test("admission registration output only accounts for added listings", () => {
  const before = {
    enrollments: [],
    blocked: { "no-observation": 8, "upstream-unavailable": 9, other: 2 },
  };
  const after = {
    ...before,
    blocked: { ...before.blocked, "no-observation": 9, "upstream-unavailable": 10 },
  };
  checkDiscoveryRegistrationDelta(before, after, 2);
  assert.throws(() => checkDiscoveryRegistrationDelta(before, after, 1), /registration counts/u);
  assert.throws(
    () =>
      checkDiscoveryRegistrationDelta(before, { ...after, enrollments: [{ id: "existing" }] }, 2),
    /registration counts/u,
  );
  assert.throws(
    () =>
      checkDiscoveryRegistrationDelta(
        before,
        { ...after, blocked: { ...after.blocked, other: 3 } },
        2,
      ),
    /registration counts/u,
  );
});

void test("App proposal creation uses exact readback without replaying a mutation", async () => {
  const exact = { url: "fixture" };
  const verify = (rows: unknown[]) => {
    assert.deepEqual(rows, [exact]);
    return exact.url;
  };
  let lookedUp = 0;
  let created = 0;
  const result = await openCatalogAdmissionProposal({
    lookup: async () => (++lookedUp === 1 ? [] : [exact]),
    create: async () => {
      created++;
      throw new Error("Connection interrupted after creation.");
    },
    verify,
  });
  assert.equal(result, exact.url);
  assert.equal(lookedUp, 2);
  assert.equal(created, 1);
  assert.equal(
    await openCatalogAdmissionProposal({
      lookup: async () => [exact],
      create: async () =>
        assert.fail("An exact existing pull request should not be created again."),
      verify,
    }),
    exact.url,
  );
  await assert.rejects(
    openCatalogAdmissionProposal({
      lookup: async () => [],
      create: async () => {
        throw new Error("Permission denied.");
      },
      verify,
    }),
    /without exact remote readback/u,
  );
});

void test("an SDK retry leaves independent allowance for exact post-creation readback", async () => {
  const commit = "c".repeat(40);
  const repo = "boburning/portcove";
  const app = "catalog-admission";
  const branch = "automation/catalog-admission-12-1";
  const ref = `refs/heads/${branch}`;
  const result = `https://github.com/${repo}/pull/22`;
  const row = {
    number: 22,
    html_url: result,
    head: { sha: commit, ref: branch, repo: { full_name: repo } },
    base: { ref: "main", repo: { full_name: repo } },
    user: { login: `${app}[bot]` },
  };
  let refReads = 0;
  let posts = 0;
  let lookups = 0;
  const value = await catalogAdmissionGitHub(
    "deliver",
    {
      DISCOVERY_RUN: "12",
      DISCOVERY_ATTEMPT: "1",
      EXPECTED_APP: app,
      APP_SLUG: app,
      GH_TOKEN: "fixture",
      COMMIT: commit,
      GITHUB_REPOSITORY: repo,
    },
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname.endsWith(branch)) {
        if (++refReads === 1)
          return Response.json({ message: "Transient server error" }, { status: 503 });
        return Response.json({ ref, object: { sha: commit } });
      }
      assert.equal(url.pathname, `/repos/${repo}/pulls`);
      if (init?.method === "POST") {
        posts++;
        assert.equal(typeof init.body, "string");
        const body: unknown = JSON.parse(init.body as string);
        assert.ok(isRecord(body) && body.draft === true);
        return Response.json(row, { status: 201 });
      }
      lookups++;
      return Response.json(posts ? [row] : []);
    },
  );
  assert.equal(value, result);
  assert.equal(refReads, 2);
  assert.equal(lookups, 2);
  assert.equal(posts, 1);
});

void test("independent review binds the open App proposal to the exact replay head", async () => {
  const commit = "c".repeat(40);
  const repo = "boburning/portcove";
  const app = "catalog-admission";
  const env = {
    DISCOVERY_RUN: "12",
    DISCOVERY_ATTEMPT: "1",
    EXPECTED_APP: app,
    GH_TOKEN: "fixture",
    COMMIT: commit,
    GITHUB_REPOSITORY: repo,
  };
  const row = {
    number: 22,
    html_url: `https://github.com/${repo}/pull/22`,
    state: "open",
    head: { sha: commit, ref: "automation/catalog-admission-12-1", repo: { full_name: repo } },
    base: { ref: "main", repo: { full_name: repo } },
    user: { login: `${app}[bot]` },
  };
  const readProposal = (record: unknown, mode = "review") =>
    catalogAdmissionGitHub(mode, { ...env, PROPOSAL: row.html_url }, async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(init?.method, "GET");
      assert.equal(url.pathname, `/repos/${repo}/pulls`);
      assert.equal(url.searchParams.get("head"), "boburning:automation/catalog-admission-12-1");
      return Response.json([record]);
    });
  assert.equal(await readProposal(row), row.html_url);
  assert.equal(await readProposal({ ...row, state: "closed" }), "");
  assert.equal(await readProposal({ ...row, draft: true }, "qualification"), "draft");
  assert.equal(await readProposal({ ...row, draft: false }, "qualification"), "ready");
  assert.equal(
    await readProposal({ ...row, state: "closed", draft: true }, "qualification"),
    "closed",
  );
  for (const altered of [
    { ...row, state: "unknown" },
    { ...row, user: { login: "other[bot]" } },
    { ...row, head: { ...row.head, sha: "d".repeat(40) } },
  ])
    await assert.rejects(readProposal(altered), /proposal readback differs/u);
  await assert.rejects(readProposal(row, "qualification"), /qualification proposal differs/u);
  await assert.rejects(
    readProposal(
      { ...row, number: 23, html_url: `https://github.com/${repo}/pull/23`, draft: true },
      "qualification",
    ),
    /qualification proposal differs/u,
  );
});

void test("a proposal must contain the whole replayed tree and exact single producer parent", () => {
  const [head, source, tree, wrong] = ["a", "b", "c", "d"].map((hex) => hex.repeat(40)) as [
    string,
    string,
    string,
    string,
  ];
  checkDiscoveryReplayTree(head, source, tree, `${head}\n${source}\n${tree}\n`);
  for (const changed of [
    `${wrong}\n${source}\n${tree}\n`,
    `${head}\n${source} ${wrong}\n${tree}\n`,
    `${head}\n${wrong}\n${tree}\n`,
    `${head}\n${source}\n${wrong}\n`,
  ])
    assert.throws(
      () => checkDiscoveryReplayTree(head, source, tree, changed),
      /replay tree or parent/u,
    );
});

void test("admission reviews carry current verifier code into an older producer checkout", () => {
  const workflow: unknown = parse(
    readFileSync(new URL("../.github/workflows/catalog-admission.yml", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(workflow) && isRecord(workflow.jobs) && isRecord(workflow.jobs.review));
  const job = workflow.jobs.review;
  assert.equal(job.environment, undefined);
  assert.ok(isRecord(job.env) && Array.isArray(job.steps));
  assert.equal(job.env.CONTROLLER_SOURCE, "${{ github.workflow_sha }}");
  assert.equal(job.env.DISCOVERY_SOURCE, "${{ github.event.workflow_run.head_sha }}");
  const steps = (job.steps as unknown[]).filter(isRecord);
  const replay = steps.find(({ id }) => id === "replay");
  assert.equal(typeof replay?.run, "string");
  const shell = String(replay?.run);
  assert.match(shell, /worktree add --quiet --detach "\$controller" "\$CONTROLLER_SOURCE"/u);
  assert.match(shell, /node "\$controller\/scripts\/discovery-admission-branch\.mts" review/u);
  assert.match(shell, /node scripts\/prepare-port\.mts --discovery-scheduled-run/u);
  assert.doesNotMatch(shell, /git checkout|secrets\.|APP_PRIVATE_KEY/u);
  assert.equal(
    steps.find(({ name }) => name === "Retain the independent replay receipt")?.if,
    "steps.replay.outputs.matched == 'true'",
  );
  const qualify = workflow.jobs.qualify;
  assert.ok(isRecord(qualify) && Array.isArray(qualify.steps));
  assert.deepEqual(qualify.needs, ["propose", "review"]);
  assert.equal(
    qualify.if,
    "needs.review.result == 'success' && needs.review.outputs.matched == 'true'",
  );
  const readiness = (qualify.steps as unknown[]).filter(isRecord);
  const ready = readiness.find(({ name }) => name === "Mark the verified proposal ready");
  assert.ok(isRecord(ready) && typeof ready.run === "string");
  assert.match(ready.run, /qualification\)[\s\S]*gh pr ready "\$PROPOSAL"[\s\S]*qualification\)/u);
  assert.match(ready.run, /branch-fence\)[\s\S]*gh pr ready "\$PROPOSAL"[\s\S]*branch-fence\)/u);
  assert.doesNotMatch(ready.run, /gh pr merge|--admin/u);
});

void test("automated readiness requires the reviewed update and deletion rules on its exact branch", async () => {
  const id = 104;
  const source = "boburning/portcove";
  const reviewedAt = "2026-11-11T09:38:18.625-05:00";
  const rules = [
    { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    { type: "deletion" },
  ];
  const ruleset = {
    id,
    target: "branch",
    source_type: "Repository",
    source,
    enforcement: "active",
    updated_at: reviewedAt,
    conditions: {
      ref_name: { include: ["refs/heads/automation/catalog-admission-*"], exclude: [] },
    },
    rules,
  };
  const applicable = rules.map((rule) => ({
    ...rule,
    ruleset_id: id,
    ruleset_source_type: "Repository",
    ruleset_source: source,
  }));
  checkCatalogAdmissionBranchFence(ruleset, applicable, id, reviewedAt);
  checkCatalogAdmissionBranchFence({ ...ruleset, bypass_actors: [] }, applicable, id, reviewedAt);
  const defaultRules = [{ type: "update" }, { type: "deletion" }];
  const appliedDefault = applicable.map(({ parameters: _parameters, ...rule }) => rule);
  checkCatalogAdmissionBranchFence(
    { ...ruleset, rules: defaultRules },
    appliedDefault,
    id,
    reviewedAt,
  );
  assert.equal(
    await catalogAdmissionGitHub(
      "branch-fence",
      {
        DISCOVERY_RUN: "12",
        DISCOVERY_ATTEMPT: "1",
        EXPECTED_APP: "catalog-admission",
        GH_TOKEN: "fixture",
        COMMIT: "a".repeat(40),
        GITHUB_REPOSITORY: source,
        ADMISSION_RULESET_ID: String(id),
        ADMISSION_RULESET_REVIEWED_AT: reviewedAt,
      },
      async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(init?.method, "GET");
        if (url.pathname === `/repos/${source}/rulesets/${id}`)
          return Response.json({ ...ruleset, rules: defaultRules });
        assert.equal(
          url.pathname,
          `/repos/${source}/rules/branches/automation%2Fcatalog-admission-12-1`,
        );
        return Response.json(appliedDefault);
      },
    ),
    "locked",
  );
  for (const altered of [
    { ...ruleset, updated_at: "2026-11-27T12:11:00Z" },
    { ...ruleset, enforcement: "evaluate" },
    { ...ruleset, bypass_actors: [{ actor_id: 3 }] },
    { ...ruleset, conditions: { ref_name: { include: ["~ALL"], exclude: [] } } },
  ])
    assert.throws(
      () => checkCatalogAdmissionBranchFence(altered, applicable, id, reviewedAt),
      /reviewed catalog admission branch ruleset differs/u,
    );
  for (const altered of [
    [applicable[0]],
    [applicable[0], { ...applicable[1], ruleset_id: id + 1 }],
    [{ ...applicable[0], parameters: { update_allows_fetch_and_merge: true } }, applicable[1]],
  ])
    assert.throws(
      () => checkCatalogAdmissionBranchFence(ruleset, altered, id, reviewedAt),
      /does not lock the exact/u,
    );
});

void test("proposal gate follows a numeric repository page without changing its scope", async () => {
  let pages = 0;
  const value = await catalogAdmissionGitHub(
    "gate",
    {
      DISCOVERY_RUN: "12",
      DISCOVERY_ATTEMPT: "1",
      EXPECTED_APP: "catalog-admission",
      GH_TOKEN: "fixture",
      GITHUB_REPOSITORY: "boburning/portcove",
    },
    async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/artifacts")) return Response.json({ total_count: 1 });
      assert.equal(url.pathname, "/repos/boburning/portcove/pulls");
      pages++;
      if (pages === 1) {
        return Response.json([], {
          headers: {
            link: '<https://api.github.com/repositories/1354613114/pulls?state=open&base=main&per_page=100&page=2>; rel="next"',
          },
        });
      }
      assert.equal(url.searchParams.get("page"), "2");
      return Response.json([
        {
          user: { login: "catalog-admission[bot]" },
          head: {
            ref: "automation/catalog-admission-11-1",
            repo: { full_name: "boburning/portcove" },
          },
        },
      ]);
    },
  );
  assert.equal(value, "An open catalog admission proposal is still in review.");
  assert.equal(pages, 2);
});
