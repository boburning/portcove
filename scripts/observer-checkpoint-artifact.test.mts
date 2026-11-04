import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  newCatalogObserverCheckpoint,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import {
  collectObserverSnapshot,
  validateObserverSnapshot,
  readObserverSnapshotArchive,
  publishObserverSnapshot,
  recoverObserverCheckpoint,
  snapshotName,
  observerSnapshotLimit,
  encodeObserverSnapshot,
  observerBaselinePermit,
  encodeCompactObserverSnapshot,
  encodeStreamingObserverSnapshot,
  readRecoverableObserverSnapshotArchive,
} from "./observer-checkpoint-artifact.mts";
import {
  encodeObserverRecords,
  decodeObserverRecords,
  observerRecordMagic,
  assertObserverRecordRuntime,
} from "./observer-snapshot-records.mts";
import {
  decodeStoredObserverCheckpoint,
  encodeStoredObserverCheckpoint,
  observerSourceCheckpointLimit,
} from "./observer-checkpoint-storage.mts";
import { observerCheckpointByteLimit } from "./observe-configured-upstream.mts";
import { isRecord } from "./runtime-values.mts";
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

void test("live-shaped discovery pages history and excludes comparison patches within the original metadata envelope", async (t) => {
  const root = await directory(t),
    f = transport(),
    original = f.api.request;
  f.publisher();
  const repoMetadata = Object.fromEntries(
    [
      "forks",
      "keys",
      "collaborators",
      "teams",
      "hooks",
      "issue_events",
      "events",
      "assignees",
      "branches",
      "tags",
      "blobs",
      "git_tags",
      "git_refs",
      "trees",
      "statuses",
      "languages",
      "stargazers",
      "contributors",
      "subscribers",
      "subscription",
      "commits",
      "git_commits",
      "comments",
      "issue_comment",
      "contents",
      "compare",
      "merges",
      "archive",
      "downloads",
      "issues",
      "pulls",
      "milestones",
      "notifications",
      "labels",
      "releases",
      "deployments",
    ].map((key) => [
      `${key}_url`,
      `https://api.github.com/repos/boburning/portcove/${key}{/number}`,
    ]),
  );
  const runs = Array.from({ length: 188 }, (_, i) => ({
    ...f.run,
    id: i === 0 ? 1000 : i === 11 ? source.run : 999 - i,
    head_sha: i === 11 ? source.source : "c".repeat(40),
    status: i === 0 ? "in_progress" : "completed",
    created_at: new Date(
      Date.now() - (i <= 11 ? i * 30 * 60000 : (25 + i - 12) * 3600000),
    ).toISOString(),
    repository: { ...repoMetadata, id: 1354613114 },
    head_repository: { ...repoMetadata, id: 1354613114 },
  }));
  const measured: {
    route: string;
    response_bytes: number;
    total_bytes: number;
    requests: number;
  }[] = [];
  f.api.request = (...args) => {
    const endpoint = args[1],
      response = original(...args);
    let body = response.body;
    if (endpoint.includes("/actions/workflows/")) {
      const query = new URL(`https://api.github.com/${endpoint}`).searchParams,
        size = Number(query.get("per_page")),
        page = Number(query.get("page") ?? 1);
      body = {
        total_count: runs.length,
        workflow_runs: runs.slice((page - 1) * size, page * size),
      };
    } else if (endpoint.includes("/compare/")) {
      const base = endpoint.match(/compare\/([a-f0-9]{40})\.\.\./u)?.[1];
      body = {
        status: "ahead",
        merge_base_commit: { sha: base },
        commits: [
          { sha: "d".repeat(40), commit: { message: "public commit metadata\n".repeat(700) } },
        ],
        ...(!endpoint.includes("page=2")
          ? {
              files: Array.from({ length: 152 }, (_, i) => ({
                filename: `crates/portcove-core/catalog/ports/fixture-${i}.json`,
                patch: "@@ -1 +1 @@\n-old catalog input\n+new catalog input\n".repeat(180),
              })),
            }
          : {}),
      };
    } else if (endpoint.includes("/artifacts?") && !endpoint.includes(`/runs/${source.run}/`))
      body = { total_count: 0, artifacts: [] };
    return { ...response, body, bodyBytes: Buffer.byteLength(JSON.stringify(body)) };
  };
  const result = await recoverObserverCheckpoint({
    root,
    config,
    current: { ...current, run: 1000 },
    deadline: Date.now() + 60000,
    api: f.api,
    download: f.download,
    log: (event) => measured.push(event),
  });
  assert.equal(result.origin, "artifact");
  assert.equal(f.count(), 1);
  const pages = measured.filter((event) => event.route.includes("actions/workflows/"));
  assert.equal(pages.length, 2);
  assert.ok(pages.every((event) => event.route.includes("per_page=10")));
  assert.ok(
    measured
      .filter((event) => event.route.startsWith("compare/"))
      .every((event) => event.route.endsWith("per_page=1&page=2")),
  );
  assert.ok(measured.at(-1)!.total_bytes < observerSnapshotLimit);
  console.log(
    JSON.stringify({
      fixture: "live-shaped-discovery",
      run_pages: pages.length,
      metadata_requests: measured.length,
      metadata_bytes: measured.at(-1)!.total_bytes,
      byte_limit: observerSnapshotLimit,
    }),
  );
});

void test("history pagination refuses changed totals, missing rows, duplicate identities and order drift", async (t) => {
  for (const defect of ["total", "missing", "duplicate", "order"]) {
    const root = await directory(t),
      f = transport(),
      original = f.api.request;
    f.api.request = (...args) => {
      const result = original(...args);
      if (!args[1].includes("/actions/workflows/")) return result;
      const first = Array.from({ length: 10 }, (_, i) => ({
        ...f.run,
        id: 201 + i,
        created_at: new Date(Date.now() - i * 10000).toISOString(),
      }));
      const second = {
        ...f.run,
        id: defect === "duplicate" ? 201 : 211,
        created_at: new Date(Date.now() - (defect === "order" ? 0 : 100000)).toISOString(),
      };
      const page2 = args[1].includes("page=2");
      const body = {
        total_count: page2 && defect === "total" ? 12 : 11,
        workflow_runs: page2 ? (defect === "missing" ? [] : [second]) : first,
      };
      return { ...result, body, bodyBytes: Buffer.byteLength(JSON.stringify(body)) };
    };
    await assert.rejects(
      recoverObserverCheckpoint({
        root,
        config,
        current,
        deadline: Date.now() + 60000,
        api: f.api,
        download: f.download,
      }),
      /inventory|omitted/,
    );
    assert.equal(f.count(), 0);
  }
});

void test("identical source ancestry uses global comparison facts when page two contains no commits", async (t) => {
  const root = await directory(t),
    f = transport(),
    original = f.api.request;
  f.api.request = (...args) => {
    const result = original(...args);
    if (!args[1].includes("/compare/")) return result;
    assert.ok(args[1].endsWith("per_page=1&page=2"));
    const body = { status: "identical", merge_base_commit: { sha: source.source }, commits: [] };
    return { ...result, body, bodyBytes: Buffer.byteLength(JSON.stringify(body)) };
  };
  assert.equal(
    (
      await recoverObserverCheckpoint({
        root,
        config,
        current: { ...current, source: source.source },
        deadline: Date.now() + 60000,
        api: f.api,
        download: f.download,
      })
    ).origin,
    "artifact",
  );
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

async function baselineTransport(t: Parameters<typeof directory>[0], realCatalog = false) {
  const root = await directory(t),
    permit = observerBaselinePermit;
  const clock = Date.parse("2026-11-02T19:01:00Z");
  const files = new Map<string, Buffer>([
    [
      "release/upstream-observer.json",
      await readFile(new URL("../release/upstream-observer.json", import.meta.url)),
    ],
    [
      "crates/portcove-core/catalog/catalog.json",
      realCatalog
        ? await readFile(new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url))
        : Buffer.from(JSON.stringify({ ports: [] })),
    ],
    [
      "crates/portcove-core/catalog/listings.json",
      realCatalog
        ? await readFile(new URL("../crates/portcove-core/catalog/listings.json", import.meta.url))
        : Buffer.from(JSON.stringify({ listings: [] })),
    ],
  ]);
  const metadata = new Map<string, Record<string, unknown>>();
  for (const [filename, bytes] of files) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), bytes);
    metadata.set(filename, {
      type: "file",
      path: filename,
      size: bytes.length,
      sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    });
  }
  const anchor = {
    ...transport().run,
    id: permit.after_run,
    head_sha: String(permit.after_source),
    created_at: permit.after_created_at,
    run_attempt: 1,
  };
  const active = {
    ...anchor,
    id: permit.after_run + 100,
    head_sha: "b".repeat(40),
    created_at: new Date(clock - 1000).toISOString(),
    status: "in_progress",
    conclusion: null as string | null,
  };
  const state = { runs: [active, anchor] as Record<string, unknown>[], total: 2 };
  const routes: string[] = [];
  const api = {
    request: (_method: string, endpoint: string) => {
      routes.push(endpoint);
      let body: unknown;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove", default_branch: "main" };
      else if (endpoint.includes("/actions/workflows/"))
        body = { total_count: state.total, workflow_runs: state.runs };
      else if (endpoint.includes("/compare/"))
        body = {
          status: "ahead",
          merge_base_commit: { sha: endpoint.split("/compare/")[1]!.split("...")[0] },
        };
      else if (endpoint.endsWith(`/actions/runs/${active.id}`)) body = active;
      else if (endpoint.includes("/artifacts?")) body = { total_count: 0, artifacts: [] };
      else if (endpoint.includes("/contents/")) {
        const filename = endpoint.split("/contents/")[1]!.split("?ref=")[0]!;
        body = endpoint.endsWith(`?ref=${active.head_sha}`)
          ? metadata.get(filename)
          : {
              encoding: "base64",
              content: Buffer.from(
                filename === "release/upstream-observer.json"
                  ? files.get(filename)!
                  : "observer-checkpoint-artifact.mts export",
              ).toString("base64"),
            };
      } else throw new Error(`Unexpected baseline route ${endpoint}`);
      return {
        status: 200,
        headers: new Map<string, string>(),
        body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      };
    },
  };
  const options = {
    root,
    config: permit.config_sha256,
    current: { run: active.id, attempt: 1, source: active.head_sha },
    deadline: clock + 60000,
    now: () => clock,
    api,
    download: () => {
      throw new Error("No artifact download admitted");
    },
  };
  return {
    root,
    files,
    metadata,
    anchor,
    active,
    state,
    routes,
    options,
    checkpoint: path.join(root, "work/upstream-observer/catalog/checkpoint.json"),
    receipt: path.join(root, "work", `${permit.id}.consumed.json`),
  };
}

void test("approved natural cutover creates an empty unknown baseline against both real catalog inputs", async (t) => {
  const f = await baselineTransport(t, true);
  const result = await recoverObserverCheckpoint(f.options);
  assert.equal(result.origin, "fresh-baseline");
  const checkpoint = validateCatalogObserverCheckpoint(
    JSON.parse(await readFile(f.checkpoint, "utf8")),
    f.options.now(),
  );
  assert.equal(checkpoint.sequence, 0);
  assert.deepEqual(checkpoint.sources, {});
  assert.equal(checkpoint.provider_retry_at, null);
  assert.deepEqual(checkpoint.baseline, {
    id: observerBaselinePermit.id,
    continuity: "lost",
    initial_freshness: "unknown",
    initialized_at: new Date(f.options.now()).toISOString(),
    producer: f.options.current,
    inputs: {
      config_sha256: observerBaselinePermit.config_sha256,
      catalog_sha256: digest(f.files.get("crates/portcove-core/catalog/catalog.json")!),
      listings_sha256: digest(f.files.get("crates/portcove-core/catalog/listings.json")!),
    },
  });
  assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), checkpoint.baseline);
  assert.equal((await recoverObserverCheckpoint(f.options)).origin, "cache");
  // Later snapshot producers retain historical provenance, without pretending
  // the initializer's producer or input hashes are current observation clocks.
  const later = validateObserverSnapshot(
    {
      ...snapshot(),
      config_sha256: f.options.config,
      producer: { run: f.active.id + 1, attempt: 1, source: "c".repeat(40) },
      files: { "catalog/checkpoint.json": { ...checkpoint, sequence: 9 } },
    },
    f.options.config,
    Date.now(),
  );
  const encoded = encodeObserverSnapshot(later);
  const decoded = readObserverSnapshotArchive(
    createAuditZip([["checkpoint.json", encoded.bytes]]),
    f.options.config,
    Date.now(),
    Date.now() + 60000,
  );
  assert.deepEqual(
    (decoded.files["catalog/checkpoint.json"] as typeof checkpoint).baseline,
    checkpoint.baseline,
  );
  assert.ok(f.routes.some((route) => route.includes("catalog/listings.json?ref=")));
});

void test("fresh-baseline opportunity cannot replay in the same run, a rerun or a later scheduled run", async (t) => {
  const f = await baselineTransport(t);
  await recoverObserverCheckpoint(f.options);
  const consumed = await readFile(f.receipt, "utf8");
  // Simulated loss removes only this test's newly created tree. Production
  // initialization never deletes checkpoint data or consumption receipts.
  await rm(path.join(f.root, "work/upstream-observer"), { recursive: true });
  await assert.rejects(recoverObserverCheckpoint(f.options), { code: "EEXIST" });
  assert.equal(await readFile(f.receipt, "utf8"), consumed);
  await assert.rejects(
    recoverObserverCheckpoint({ ...f.options, current: { ...f.options.current, attempt: 2 } }),
    /history missing/,
  );
  const previous = { ...f.active, status: "completed", conclusion: "failure" };
  f.active.id += 1;
  f.active.head_sha = "c".repeat(40);
  f.active.created_at = new Date(f.options.now()).toISOString();
  f.state.runs = [f.active, previous, f.anchor];
  f.state.total = 3;
  await assert.rejects(
    recoverObserverCheckpoint({
      ...f.options,
      current: { ...f.options.current, run: f.active.id, source: f.active.head_sha },
    }),
    /history missing/,
  );
  await assert.rejects(readFile(f.checkpoint), { code: "ENOENT" });
});

void test("surviving state wins over the fresh-baseline permit and failed publication retains consumption", async (t) => {
  const cached = await baselineTransport(t);
  const prior = JSON.stringify({ ...newCatalogObserverCheckpoint(), sequence: 343 });
  await mkdir(path.dirname(cached.checkpoint), { recursive: true });
  await writeFile(cached.checkpoint, prior);
  assert.deepEqual(await recoverObserverCheckpoint(cached.options), {
    origin: "cache",
    sequence: 343,
  });
  assert.equal(await readFile(cached.checkpoint, "utf8"), prior);
  await assert.rejects(readFile(cached.receipt), { code: "ENOENT" });
  const failed = await baselineTransport(t);
  await mkdir(path.dirname(failed.receipt), { recursive: true });
  const lock = path.join(failed.root, "work/upstream-observer.restore.lock");
  await writeFile(lock, "other owner");
  await assert.rejects(recoverObserverCheckpoint(failed.options), { code: "EEXIST" });
  const consumed = await readFile(failed.receipt, "utf8");
  const receipt: unknown = JSON.parse(consumed);
  assert.ok(isRecord(receipt));
  assert.equal(receipt.id, observerBaselinePermit.id);
  assert.equal(await readFile(lock, "utf8"), "other owner");
  await assert.rejects(readFile(failed.checkpoint), { code: "ENOENT" });
  await assert.rejects(recoverObserverCheckpoint(failed.options), { code: "EEXIST" });
  assert.equal(await readFile(failed.receipt, "utf8"), consumed);
});

void test("one-time baseline refuses incomplete, replayed, foreign or changed inputs before consumption", async (t) => {
  const changes: [
    string,
    (f: Awaited<ReturnType<typeof baselineTransport>>) => void | Promise<void>,
  ][] = [
    [
      "manual dispatch",
      (f) => {
        f.active.event = "workflow_dispatch";
      },
    ],
    [
      "foreign main source",
      (f) => {
        f.active.head_repository = { id: 3 };
      },
    ],
    [
      "old anchor rerun",
      (f) => {
        f.anchor.run_attempt = 2;
      },
    ],
    [
      "changed anchor source",
      (f) => {
        f.anchor.head_sha = "e".repeat(40);
      },
    ],
    [
      "current absent",
      (f) => {
        f.state.runs = [f.anchor];
        f.state.total = 1;
      },
    ],
    [
      "omitted run",
      (f) => {
        f.state.total = 3;
      },
    ],
    [
      "prior queued opportunity",
      (f) => {
        f.state.runs.splice(1, 0, {
          ...f.active,
          id: f.active.id - 1,
          created_at: new Date(f.options.now() - 2000).toISOString(),
          status: "queued",
        });
        f.state.total = 3;
      },
    ],
    [
      "wrong configuration",
      (f) => {
        f.options.config = "0".repeat(64) as typeof f.options.config;
      },
    ],
    [
      "catalog blob mismatch",
      (f) => {
        f.metadata.get("crates/portcove-core/catalog/catalog.json")!.sha = "0".repeat(40);
      },
    ],
    [
      "listing blob mismatch",
      (f) => {
        f.metadata.get("crates/portcove-core/catalog/listings.json")!.sha = "0".repeat(40);
      },
    ],
    [
      "wrong metadata path",
      (f) => {
        f.metadata.get("release/upstream-observer.json")!.path = "foreign";
      },
    ],
    [
      "wrong metadata size",
      (f) => {
        f.metadata.get("release/upstream-observer.json")!.size = 0;
      },
    ],
    [
      "non-file input",
      (f) => {
        f.metadata.get("crates/portcove-core/catalog/listings.json")!.type = "symlink";
      },
    ],
    [
      "forbidden metadata",
      (f) => {
        const request = f.options.api.request;
        f.options.api.request = (method, route) => ({
          ...request(method, route),
          ...(route.endsWith(`/actions/runs/${f.active.id}`) ? { status: 403 } : {}),
        });
      },
    ],
    [
      "invalid advertised snapshot",
      (f) => {
        const request = f.options.api.request;
        f.options.api.request = (method, route) => {
          const result = request(method, route);
          return route.includes("/artifacts?")
            ? {
                ...result,
                body: {
                  total_count: 1,
                  artifacts: [
                    {
                      ...transport().artifact,
                      name: snapshotName(f.options.config, {
                        run: f.anchor.id,
                        attempt: 1,
                        source: f.anchor.head_sha,
                      }),
                      expired: true,
                    },
                  ],
                },
              }
            : result;
        };
      },
    ],
    [
      "metadata envelope",
      (f) => {
        const request = f.options.api.request;
        f.options.api.request = (method, route) => ({
          ...request(method, route),
          ...(route.endsWith(`/actions/runs/${f.active.id}`)
            ? { bodyBytes: observerSnapshotLimit }
            : {}),
        });
      },
    ],
    [
      "provider reserve",
      (f) => {
        const request = f.options.api.request;
        f.options.api.request = (method, route) => ({
          ...request(method, route),
          headers: new Map([
            ["x-ratelimit-limit", "100"],
            ["x-ratelimit-remaining", "5"],
          ]),
        });
      },
    ],
    [
      "source ancestry",
      (f) => {
        const request = f.options.api.request;
        f.options.api.request = (method, route) => {
          const result = request(method, route);
          return route.includes(`/compare/${observerBaselinePermit.main_anchor}...`)
            ? {
                ...result,
                body: { status: "diverged", merge_base_commit: { sha: "f".repeat(40) } },
              }
            : result;
        };
      },
    ],
    [
      "current rerun during admission",
      (f) => {
        const request = f.options.api.request;
        let reads = 0;
        f.options.api.request = (method, route) => {
          if (route.endsWith(`/actions/runs/${f.active.id}`) && ++reads === 2)
            f.active.run_attempt = 2;
          return request(method, route);
        };
      },
    ],
    [
      "history changed during admission",
      (f) => {
        const request = f.options.api.request;
        let reads = 0;
        f.options.api.request = (method, route) => {
          if (route.includes("/actions/workflows/") && ++reads === 2) f.state.total++;
          return request(method, route);
        };
      },
    ],
    [
      "local input changed during admission",
      (f) => {
        const request = f.options.api.request;
        let reads = 0;
        f.options.api.request = (method, route) => {
          if (route.endsWith(`/actions/runs/${f.active.id}`) && ++reads === 2)
            writeFileSync(
              path.join(f.root, "crates/portcove-core/catalog/listings.json"),
              '{"listings":[],"changed":true}',
            );
          return request(method, route);
        };
      },
    ],
    [
      "expired known predecessor",
      (f) => {
        f.options.now = () => Date.parse(observerBaselinePermit.after_created_at) + 25 * 3600000;
        f.options.deadline = f.options.now() + 60000;
      },
    ],
    [
      "partial existing tree",
      async (f) => {
        await mkdir(path.dirname(f.checkpoint), { recursive: true });
        await writeFile(path.join(path.dirname(f.checkpoint), "retained"), "preserve");
      },
    ],
    [
      "invalid cached controller",
      async (f) => {
        await mkdir(path.dirname(f.checkpoint), { recursive: true });
        await writeFile(f.checkpoint, "{}");
      },
    ],
    [
      "preexisting consumption",
      async (f) => {
        await mkdir(path.dirname(f.receipt), { recursive: true });
        await writeFile(f.receipt, "preserve");
      },
    ],
  ];
  for (const [name, change] of changes)
    await t.test(name, async (child) => {
      const f = await baselineTransport(child);
      await change(f);
      await assert.rejects(recoverObserverCheckpoint(f.options));
      if (name !== "preexisting consumption")
        await assert.rejects(readFile(f.receipt), { code: "ENOENT" });
      else assert.equal(await readFile(f.receipt, "utf8"), "preserve");
      if (name === "invalid cached controller")
        assert.equal(await readFile(f.checkpoint, "utf8"), "{}");
      else await assert.rejects(readFile(f.checkpoint), { code: "ENOENT" });
      if (name === "partial existing tree")
        assert.equal(
          await readFile(path.join(path.dirname(f.checkpoint), "retained"), "utf8"),
          "preserve",
        );
    });
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

void test("encoded snapshots retain strict transfer, expansion, digest and envelope validation", () => {
  const good = validateObserverSnapshot(snapshot(), config, Date.now());
  const encoded = encodeObserverSnapshot(good);
  const read = (value: unknown) =>
    readObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", JSON.stringify(value)]]),
      config,
      Date.now(),
      Date.now() + 60000,
    );
  const wire: unknown = JSON.parse(encoded.bytes.toString("utf8"));
  assert.ok(isRecord(wire));
  assert.deepEqual(read(wire), good);
  const gzip = Buffer.from(String(wire.payload), "base64");
  for (const change of [
    { format: 3 },
    { encoding: "other" },
    { extra: true },
    { expanded_bytes: observerCheckpointByteLimit + 1 },
    { expanded_bytes: 1 },
    { expanded_bytes: encoded.decoded_bytes + 1 },
    { sha256: "0".repeat(64) },
    { payload: `${String(wire.payload)}\n` },
    { payload: gzip.subarray(0, gzip.length - 4).toString("base64") },
    { payload: Buffer.from("not gzip").toString("base64") },
    {
      payload: gzipSync(Buffer.from(JSON.stringify(wire))).toString("base64"),
      expanded_bytes: Buffer.byteLength(JSON.stringify(wire)),
      sha256: digest(JSON.stringify(wire)),
    },
  ])
    assert.throws(() => read({ ...wire, ...change }));
  assert.throws(() => encodeObserverSnapshot(good, Date.now() - 1), /deadline exhausted/);
});

void test("format four recovery retains its exact artifact producer and sequence before cache continuation", async (t) => {
  const root = await directory(t),
    f = transport();
  f.value.files["catalog/checkpoint.json"].sequence = 361;
  const encoded = await encodeStreamingObserverSnapshot(
    validateObserverSnapshot(f.value, config, Date.now()),
    Date.now() + 60000,
  );
  const archive = createAuditZip([["checkpoint.json", encoded.bytes]]);
  f.artifact.size_in_bytes = archive.length;
  f.artifact.digest = `sha256:${digest(archive)}`;
  let downloads = 0;
  const restored = await recoverObserverCheckpoint({
    root,
    config,
    current,
    deadline: Date.now() + 60000,
    api: f.api,
    download: () => {
      downloads++;
      return archive;
    },
  });
  assert.deepEqual(restored, { origin: "artifact", producer: source, artifact: 7, sequence: 361 });
  assert.equal(downloads, 1);
  assert.deepEqual(
    await recoverObserverCheckpoint({
      root,
      config,
      current,
      deadline: Date.now() + 60000,
      api: f.api,
      download: () => assert.fail("Validated restored cache requires no download"),
    }),
    { origin: "cache", sequence: 361 },
  );
});

void test("framed transfer enforces runtime, window, integrity, framing, budget and cancellation guards", async () => {
  const limits = {
    member: observerSnapshotLimit - 16384,
    record: observerCheckpointByteLimit,
    records: 1000,
    deadline: Date.now() + 60000,
  };
  for (const version of ["24.19.0", "22.23.3", "26.12.0", "25.9.0"])
    assert.throws(() => assertObserverRecordRuntime(version), /patched/);
  for (const version of ["24.22.2", "22.23.4", "26.12.1"]) assertObserverRecordRuntime(version);
  async function* input() {
    yield { name: "first", bytes: Buffer.from("original") };
    yield { name: "second", bytes: Buffer.from("retained") };
  }
  const encoded = await encodeObserverRecords(input(), limits);
  const values: string[] = [];
  await decodeObserverRecords(encoded.bytes, limits, (name, bytes) =>
    values.push(`${name}:${bytes.toString()}`),
  );
  assert.deepEqual(values, ["first:original", "second:retained"]);
  const start = observerRecordMagic.length,
    end = encoded.bytes.indexOf(10, start);
  const header: unknown = JSON.parse(encoded.bytes.subarray(start, end).toString());
  assert.ok(isRecord(header));
  const altered = (change: Record<string, unknown>) =>
    Buffer.concat([
      observerRecordMagic,
      Buffer.from(JSON.stringify({ ...header, ...change }) + "\n"),
      encoded.bytes.subarray(end + 1),
    ]);
  for (const bytes of [
    altered({ sha256: "0".repeat(64) }),
    altered({ records: 1 }),
    altered({ logical_bytes: 1 }),
    altered({ foreign: true }),
    encoded.bytes.subarray(0, encoded.bytes.length - 1),
    Buffer.concat([encoded.bytes, Buffer.from("garbage")]),
    Buffer.concat([encoded.bytes, encoded.bytes.subarray(end + 1)]),
  ])
    await assert.rejects(decodeObserverRecords(bytes, limits, () => {}));
  const window = Buffer.from(encoded.bytes);
  window[end + 1] = (window[end + 1]! & 240) | 15;
  await assert.rejects(
    decodeObserverRecords(window, limits, () => {}),
    /window/,
  );
  await assert.rejects(
    decodeObserverRecords(encoded.bytes, { ...limits, deadline: Date.now() - 1 }, () => {}),
    /deadline/,
  );
  await assert.rejects(
    decodeObserverRecords(encoded.bytes, limits, () => {
      throw new Error("consumer refusal");
    }),
    /consumer refusal/,
  );
  let closed = false;
  async function* noisy() {
    try {
      for (let i = 0; i < 100; i++)
        yield {
          name: "noise",
          bytes: Buffer.from(Array.from({ length: 10000 }, (_, n) => digest(`${n}:${i}`)).join("")),
        };
    } finally {
      closed = true;
    }
  }
  await assert.rejects(encodeObserverRecords(noisy(), { ...limits, member: 1024 }));
  assert.equal(closed, true);
  await assert.rejects(
    encodeObserverRecords(input(), { ...limits, deadline: Date.now() - 1 }),
    /deadline/,
  );
});

void test("stream snapshot scope and paths refuse before source allocation and legacy formats remain readable", async () => {
  const good = validateObserverSnapshot(snapshot(), config, Date.now());
  const { files, ...metadata } = good;
  const frame = (name: string, value: unknown) => {
    const body = JSON.stringify(value);
    return JSON.stringify({ name, bytes: Buffer.byteLength(body) }) + "\n" + body;
  };
  const wire = (raw: string, records: number) => {
    const bytes = Buffer.from(raw),
      compressed = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6, [constants.BROTLI_PARAM_LGWIN]: 22 },
      });
    return Buffer.concat([
      observerRecordMagic,
      Buffer.from(
        JSON.stringify({
          format: 4,
          encoding: "brotli-records",
          records,
          logical_bytes: bytes.length,
          sha256: digest(bytes),
        }) + "\n",
      ),
      compressed,
    ]);
  };
  const read = (bytes: Buffer) =>
    readRecoverableObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", bytes]]),
      config,
      Date.now(),
      Date.now() + 60000,
    );
  const encoded = await encodeStreamingObserverSnapshot(good, Date.now() + 60000);
  assert.deepEqual(await read(encoded.bytes), good);
  assert.deepEqual(await read(encodeObserverSnapshot(good).bytes), good);
  assert.deepEqual(await read(encodeCompactObserverSnapshot(good).bytes), good);
  assert.deepEqual(await read(Buffer.from(JSON.stringify(good))), good);
  await assert.rejects(
    read(
      wire(
        frame("$snapshot", { ...metadata, repository: "foreign" }) +
          frame("catalog/checkpoint.json", files["catalog/checkpoint.json"]),
        2,
      ),
    ),
    /scope differs/,
  );
  await assert.rejects(
    read(
      wire(
        frame("$snapshot", metadata) +
          frame("catalog/checkpoint.json", files["catalog/checkpoint.json"]) +
          JSON.stringify({
            name: `${"f".repeat(64)}/checkpoint.json`,
            bytes: observerCheckpointByteLimit,
          }) +
          "\n",
        3,
      ),
    ),
    /source inventory differs/,
  );
  await assert.rejects(
    read(wire(frame("$snapshot", metadata) + frame("$snapshot", metadata), 2)),
    /duplicate/,
  );
});

void test("source storage is lossless, bounded, one level only and never admits malformed encodings", () => {
  const original = {
    format: 1,
    retained: "Accepted provider body and original cursor. ".repeat(12000),
  };
  const stored = encodeStoredObserverCheckpoint(original);
  assert.ok(isRecord(stored));
  assert.notEqual(stored.format, 1);
  assert.deepEqual(decodeStoredObserverCheckpoint(stored), original);
  const withPayload = (bytes: Buffer) => ({
    ...stored,
    expanded_bytes: bytes.length,
    sha256: digest(bytes),
    payload: gzipSync(bytes).toString("base64"),
  });
  for (const changed of [
    { ...stored, expanded_bytes: observerSourceCheckpointLimit + 1 },
    { ...stored, expanded_bytes: 1 },
    { ...stored, sha256: "0".repeat(64) },
    { ...stored, payload: `${String(stored.payload)}\n` },
    { ...stored, unknown: true },
    withPayload(Buffer.from(JSON.stringify(stored))),
    withPayload(Buffer.from("null")),
    withPayload(Buffer.from([0xff])),
  ])
    assert.throws(() => decodeStoredObserverCheckpoint(changed));
  assert.throws(() => decodeStoredObserverCheckpoint(stored, Date.now() - 1), /deadline/);
  assert.throws(() => encodeStoredObserverCheckpoint(original, Date.now() - 1), /deadline/);
  assert.throws(
    () =>
      encodeStoredObserverCheckpoint({
        format: 1,
        body: "x".repeat(observerSourceCheckpointLimit),
      }),
    /raw source exceeds/,
  );
  assert.equal(decodeStoredObserverCheckpoint(null), null);
});

void test("binary snapshot headers retain strict identity, hash, expansion and deadline guards", () => {
  const original = validateObserverSnapshot(snapshot(), config, Date.now());
  const encoded = encodeCompactObserverSnapshot(original);
  const headerStart = encoded.bytes.indexOf(10) + 1;
  const headerEnd = encoded.bytes.indexOf(10, headerStart);
  const header: unknown = JSON.parse(
    encoded.bytes.subarray(headerStart, headerEnd).toString("utf8"),
  );
  assert.ok(isRecord(header));
  const wire = (value: unknown) =>
    Buffer.concat([
      encoded.bytes.subarray(0, headerStart),
      Buffer.from(JSON.stringify(value) + "\n"),
      encoded.bytes.subarray(headerEnd + 1),
    ]);
  const read = (bytes: Buffer) =>
    readObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", bytes]]),
      config,
      Date.now(),
      Date.now() + 60000,
    );
  assert.deepEqual(read(encoded.bytes), original);
  for (const changed of [
    { ...header, format: 4 },
    { ...header, encoding: "foreign" },
    { ...header, expanded_bytes: observerCheckpointByteLimit + 1 },
    { ...header, expanded_bytes: Number(header.expanded_bytes) - 1 },
    { ...header, sha256: "0".repeat(64) },
    { ...header, foreign: true },
  ])
    assert.throws(() => read(wire(changed)));
  assert.throws(() => read(encoded.bytes.subarray(0, encoded.bytes.length - 3)));
  assert.throws(() => read(wire({ ...header, padding: "x".repeat(600) })));
  assert.throws(() => encodeCompactObserverSnapshot(original, Date.now() - 1), /deadline/);
});

void test("binary transfer avoids base64 overhead while preserving the unchanged four-MiB artifact reserve", () => {
  const entropy = Array.from({ length: 100000 }, (_, i) =>
    createHash("sha256").update(`inert-fixture-${i}`).digest("base64"),
  ).join("");
  const logical = validateObserverSnapshot(
    {
      ...snapshot(),
      files: {
        "catalog/checkpoint.json": { ...newCatalogObserverCheckpoint(), fixture_entropy: entropy },
      },
    },
    config,
    Date.now(),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(logical)) > observerSnapshotLimit);
  assert.throws(() => encodeObserverSnapshot(logical), /reserved output envelope|buffer/i);
  const binary = encodeCompactObserverSnapshot(logical, Date.now() + 60000);
  assert.ok(binary.bytes.length <= observerSnapshotLimit);
  assert.ok(createAuditZip([["checkpoint.json", binary.bytes]]).length <= observerSnapshotLimit);
  assert.deepEqual(
    readObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", binary.bytes]]),
      config,
      Date.now(),
      Date.now() + 60000,
    ),
    logical,
  );
  assert.throws(
    () =>
      encodeCompactObserverSnapshot(
        validateObserverSnapshot(
          {
            ...logical,
            files: {
              "catalog/checkpoint.json": {
                ...newCatalogObserverCheckpoint(),
                fixture_entropy: entropy + entropy,
              },
            },
          },
          config,
          Date.now(),
        ),
      ),
    /envelope|larger|buffer/i,
  );
  assert.throws(
    () =>
      validateObserverSnapshot(
        {
          ...snapshot(),
          files: {
            "catalog/checkpoint.json": {
              ...newCatalogObserverCheckpoint(),
              fixture_bytes: "x".repeat(observerCheckpointByteLimit),
            },
          },
        },
        config,
        Date.now(),
      ),
    /decoded snapshot/,
  );
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

void test("recovery preserves the provider reserve and its original collection deadline", async (t) => {
  const root = await directory(t),
    f = transport(),
    original = f.api.request;
  f.api.request = (...args) => ({
    ...original(...args),
    headers: new Map([
      ["x-ratelimit-limit", "100"],
      ["x-ratelimit-remaining", "5"],
    ]),
  });
  await assert.rejects(
    recoverObserverCheckpoint({
      root,
      config,
      current,
      deadline: Date.now() + 60000,
      api: f.api,
      download: f.download,
    }),
    /reserve exhausted/,
  );
  assert.equal(f.routes.length, 1);
  assert.equal(f.count(), 0);
  const g = transport(),
    originalRead = g.api.request;
  let clock = Date.now();
  g.api.request = (...args) => {
    const result = originalRead(...args);
    clock += 101;
    return result;
  };
  await assert.rejects(
    recoverObserverCheckpoint({
      root,
      config,
      current,
      deadline: clock + 100,
      now: () => clock,
      api: g.api,
      download: g.download,
    }),
    /deadline exhausted/,
  );
  assert.equal(g.routes.length, 1);
  assert.equal(g.count(), 0);
});

void test("duplicate scheduled run identities refuse before accepting even the first artifact", async (t) => {
  const root = await directory(t),
    f = transport(),
    original = f.api.request;
  f.api.request = (...args) => {
    const result = original(...args);
    if (!args[1].includes("/actions/workflows/")) return result;
    const body = { total_count: 2, workflow_runs: [f.run, f.run] };
    return { ...result, body, bodyBytes: Buffer.byteLength(JSON.stringify(body)) };
  };
  await assert.rejects(
    recoverObserverCheckpoint({
      root,
      config,
      current,
      deadline: Date.now() + 60000,
      api: f.api,
      download: f.download,
    }),
    /inventory invalid/,
  );
  assert.equal(f.count(), 0);
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
