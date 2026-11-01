import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { newCatalogObserverCheckpoint } from "./catalog-upstream-observer.mts";
import {
  collectObserverSnapshot,
  validateObserverSnapshot,
  readObserverSnapshotArchive,
  publishObserverSnapshot,
  recoverObserverCheckpoint,
  snapshotName,
  observerSnapshotLimit,
} from "./observer-checkpoint-artifact.mts";
import { parseDocument } from "yaml";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const configBytes = "fixture config",
  config = digest(configBytes);
const source = { run: 101, attempt: 1, source: "a".repeat(40) };
const current = { run: 102, attempt: 1, source: "b".repeat(40) };
function snapshot() {
  return {
    format: 1,
    authority: "observer-checkpoint-cache-only",
    repository: "boburning/portcove",
    repository_id: 1354613114,
    workflow: ".github/workflows/configured-upstream-observer.yml",
    ref: "refs/heads/main",
    config_sha256: config,
    created_at: new Date().toISOString(),
    producer: source,
    files: { "catalog/checkpoint.json": newCatalogObserverCheckpoint() },
  };
}
async function directory(t: { after: (operation: () => Promise<unknown>) => void }) {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "observer-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function transport() {
  const value = snapshot();
  const archive = createAuditZip([["checkpoint.json", JSON.stringify(value)]]);
  const run = {
    id: source.run,
    run_attempt: 1,
    head_sha: source.source,
    workflow_id: 354075266,
    path: ".github/workflows/configured-upstream-observer.yml",
    event: "schedule",
    head_branch: "main",
    repository: { id: 1354613114 },
    head_repository: { id: 1354613114 },
    created_at: value.created_at,
    status: "completed",
    conclusion: "failure",
  };
  const artifact = {
    id: 7,
    name: snapshotName(config, source),
    expired: false,
    size_in_bytes: archive.length,
    digest: `sha256:${digest(archive)}`,
    workflow_run: {
      id: source.run,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: source.source,
    },
  };
  let artifacts: unknown[] = [artifact],
    oldPublisher = false,
    downloads = 0;
  const routes: string[] = [];
  const api = {
    request: (_method: string, endpoint: string) => {
      routes.push(endpoint);
      let body: unknown;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove", default_branch: "main" };
      else if (endpoint.includes("/actions/workflows/"))
        body = { total_count: 1, workflow_runs: [run] };
      else if (endpoint.includes("/compare/"))
        body = { status: "ahead", merge_base_commit: { sha: source.source } };
      else if (endpoint.includes("/contents/"))
        body = {
          encoding: "base64",
          content: Buffer.from(
            endpoint.includes("upstream-observer.json")
              ? configBytes
              : oldPublisher
                ? "observer-checkpoint-artifact.mts export"
                : "legacy workflow",
          ).toString("base64"),
        };
      else if (endpoint.includes("/artifacts?"))
        body = { total_count: artifacts.length, artifacts };
      else if (endpoint.endsWith("/artifacts/7")) body = artifact;
      else if (endpoint.endsWith("/runs/101")) body = run;
      else throw new Error(`Unexpected fixture route ${endpoint}`);
      return {
        status: 200,
        headers: new Map<string, string>(),
        body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      };
    },
  };
  return {
    value,
    archive,
    run,
    artifact,
    api,
    routes,
    download: () => {
      downloads++;
      return archive;
    },
    count: () => downloads,
    missing: () => {
      artifacts = [];
    },
    publisher: () => {
      oldPublisher = true;
    },
  };
}

void test("fresh cache loss restores an exact failed scheduled producer and preserves its original checkpoint", async (t) => {
  const root = await directory(t),
    f = transport();
  const result = await recoverObserverCheckpoint({
    root,
    config,
    current,
    deadline: Date.now() + 60000,
    api: f.api,
    download: f.download,
  });
  assert.equal(result.origin, "artifact");
  assert.equal(f.count(), 1);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, "work/upstream-observer/catalog/checkpoint.json"), "utf8"),
    ),
    f.value.files["catalog/checkpoint.json"],
  );
  const cache = await recoverObserverCheckpoint({
    root,
    config,
    current,
    deadline: Date.now() + 60000,
    api: f.api,
    download: () => assert.fail("Valid cache needs no artifact"),
  });
  assert.equal(cache.origin, "cache");
});

void test("first cutover is explicit but missing history from an earlier deployed publisher refuses even after expiry", async (t) => {
  for (const old of [false, true]) {
    const root = await directory(t),
      f = transport();
    f.missing();
    if (old) f.run.created_at = new Date(Date.now() - 48 * 3600000).toISOString();
    assert.equal(
      (
        await recoverObserverCheckpoint({
          root,
          config,
          current,
          deadline: Date.now() + 60000,
          api: f.api,
          download: f.download,
        })
      ).origin,
      "initial-baseline",
    );
    f.publisher();
    await assert.rejects(
      recoverObserverCheckpoint({
        root,
        config,
        current,
        deadline: Date.now() + 60000,
        api: f.api,
        download: f.download,
      }),
      /history missing/,
    );
    assert.equal(f.count(), 0);
  }
});

void test("foreign producers, altered artifact metadata and bounded-read failures never publish", async (t) => {
  const mutations = [
    (f: ReturnType<typeof transport>) => {
      f.run.head_branch = "feature";
    },
    (f: ReturnType<typeof transport>) => {
      f.run.event = "pull_request";
    },
    (f: ReturnType<typeof transport>) => {
      f.run.head_repository.id = 3;
    },
    (f: ReturnType<typeof transport>) => {
      f.artifact.expired = true;
    },
    (f: ReturnType<typeof transport>) => {
      f.artifact.size_in_bytes = observerSnapshotLimit + 1;
    },
    (f: ReturnType<typeof transport>) => {
      f.artifact.digest = `sha256:${"0".repeat(64)}`;
    },
    (f: ReturnType<typeof transport>) => {
      f.artifact.workflow_run.head_sha = current.source;
    },
    (f: ReturnType<typeof transport>) => {
      const original = f.api.request;
      f.api.request = (...args) => ({ ...original(...args), bodyBytes: observerSnapshotLimit + 1 });
    },
  ];
  for (const mutate of mutations) {
    const root = await directory(t),
      f = transport();
    mutate(f);
    await assert.rejects(
      recoverObserverCheckpoint({
        root,
        config,
        current,
        deadline: Date.now() + 60000,
        api: f.api,
        download: f.download,
      }),
    );
    await assert.rejects(
      readFile(path.join(root, "work/upstream-observer/catalog/checkpoint.json")),
      { code: "ENOENT" },
    );
  }
});

void test("one-member snapshots reject scope, age, graph, archive integrity and physical envelope violations", () => {
  const good = snapshot();
  for (const change of [
    { ref: "refs/heads/feature" },
    { repository_id: 2 },
    { config_sha256: "c".repeat(64) },
    { created_at: new Date(Date.now() - 25 * 3600000).toISOString() },
    { created_at: new Date(Date.now() + 60000).toISOString() },
    { files: {} },
    { extra: true },
    { files: { ...good.files, "../checkpoint.json": {} } },
  ])
    assert.throws(() => validateObserverSnapshot({ ...good, ...change }, config, Date.now()));
  for (const method of [0, 8])
    assert.deepEqual(
      readObserverSnapshotArchive(
        createAuditZip([["checkpoint.json", JSON.stringify(good), { method }]]),
        config,
        Date.now(),
        Date.now() + 60000,
      ).files,
      good.files,
    );
  for (const entries of [
    [["../checkpoint.json", "{}"]] as const,
    [
      ["checkpoint.json", JSON.stringify(good)],
      ["extra", "{}"],
    ] as const,
    [["checkpoint.json", Buffer.alloc(observerSnapshotLimit + 1)]] as const,
    [["checkpoint.json", Buffer.from([255])]] as const,
    [["checkpoint.json", "{}", { attributes: 0xa1ff0000 }]] as const,
  ])
    assert.throws(() =>
      readObserverSnapshotArchive(createAuditZip(entries), config, Date.now(), Date.now() + 60000),
    );
  const corrupt = createAuditZip([["checkpoint.json", JSON.stringify(good), { method: 0 }]]);
  const corruptOffset = 30 + "checkpoint.json".length;
  corrupt[corruptOffset] = corrupt[corruptOffset]! ^ 1;
  assert.throws(() => readObserverSnapshotArchive(corrupt, config, Date.now(), Date.now() + 60000));
});

void test("atomic restore refuses partial destinations, symlinks and contended locks without overwriting", async (t) => {
  const root = await directory(t),
    good = validateObserverSnapshot(snapshot(), config, Date.now());
  await mkdir(path.join(root, "work/upstream-observer"), { recursive: true });
  await writeFile(path.join(root, "work/upstream-observer/foreign"), "preserve");
  await assert.rejects(publishObserverSnapshot(root, good), /destination exists/);
  assert.equal(
    await readFile(path.join(root, "work/upstream-observer/foreign"), "utf8"),
    "preserve",
  );
  await rm(path.join(root, "work/upstream-observer"), { recursive: true });
  await writeFile(path.join(root, "work/upstream-observer.restore.lock"), "owner");
  await assert.rejects(publishObserverSnapshot(root, good), { code: "EEXIST" });
  await rm(path.join(root, "work/upstream-observer.restore.lock"));
  await symlink(path.join(root, "work"), path.join(root, "work/upstream-observer"));
  await assert.rejects(publishObserverSnapshot(root, good), /symbolic-link/);
});

void test("a linked work ancestor cannot redirect snapshot reads or publication outside the checkout", async (t) => {
  const root = await directory(t),
    outside = await directory(t),
    f = transport();
  await writeFile(path.join(outside, "sentinel"), "preserve");
  await symlink(outside, path.join(root, "work"));
  const good = validateObserverSnapshot(snapshot(), config, Date.now());
  await assert.rejects(publishObserverSnapshot(root, good), /symbolic-link/);
  await assert.rejects(collectObserverSnapshot(root, config, source), /symbolic-link/);
  await assert.rejects(
    recoverObserverCheckpoint({
      root,
      config,
      current,
      deadline: Date.now() + 60000,
      api: f.api,
      download: f.download,
    }),
    /symbolic-link/,
  );
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "preserve");
  await assert.rejects(readFile(path.join(outside, "upstream-observer/catalog/checkpoint.json")), {
    code: "ENOENT",
  });
  assert.equal(f.routes.length, 0);
});

void test("snapshot workflow keeps job-only read permission and shares the original finite output allowance", async () => {
  const text = await readFile(
    new URL("../.github/workflows/configured-upstream-observer.yml", import.meta.url),
    "utf8",
  );
  const workflow = parseDocument(text).toJS() as {
    permissions: unknown;
    jobs: {
      observe: { permissions: unknown; steps: { name?: string; with?: Record<string, unknown> }[] };
    };
  };
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.observe.permissions, { contents: "read", actions: "read" });
  assert.equal(
    workflow.jobs.observe.steps.find((step) => step.name === "Retain checkpoint recovery snapshot")!
      .with!["retention-days"],
    1,
  );
  assert.equal(
    workflow.jobs.observe.steps.find((step) => step.name === "Retain checkpoint recovery snapshot")!
      .with!.name,
    "${{ steps.checkpoint.outputs.artifact_name }}",
  );
  assert.doesNotMatch(
    text,
    /actions: write|contents: write|id-token: write|secrets\.(?!GITHUB_TOKEN)/,
  );
});
