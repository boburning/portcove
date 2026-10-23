import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isRecord } from "./runtime-values.mts";
import type { ReleaseEvidenceOptions, EvidenceFileHandle } from "./release-run-evidence.mts";
import {
  collectReleaseRunEvidence,
  readReleaseEvidenceRequest,
  verifyReleaseArtifactBytes,
} from "./release-run-evidence.mts";

interface FixtureResponse {
  status: number;
  headers: Map<string, string>;
  body: Record<string, unknown>;
}
interface FixtureContext {
  key: string;
  url: URL;
  calls: string[];
}
type FixtureTransform = (response: FixtureResponse, context: FixtureContext) => FixtureResponse;
interface FixtureOptions extends ReleaseEvidenceOptions {
  api: NonNullable<ReleaseEvidenceOptions["api"]>;
  calls: string[];
  elapsed: () => number;
  now: () => number;
}
function requiredFixture<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Fixture object is missing");
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Fixture collection is missing");
  const items: unknown[] = value;
  return items.map(record);
}
function firstRecord(body: Record<string, unknown>, key: string, index = 0) {
  return requiredFixture(records(body[key])[index]);
}

const revision = "1".repeat(40);
const tree = "2".repeat(40);
const workflow = Buffer.from("name: Release\non: workflow_dispatch\n");
const workflowDigest = createHash("sha256").update(workflow).digest("hex");
const request = {
  schema_version: 1,
  repository_id: 9,
  run_id: 7,
  attempt: 2,
  revision,
  tree,
  workflow_sha256: workflowDigest,
};
const root = "https://api.github.com/repos/boburning/portcove";
const runPath = "/actions/runs/7";
const jobsPath = `${runPath}/attempts/2/jobs`;
const artifactPath = `${runPath}/artifacts`;
const timestamp = "2026-10-12T07:00:00Z";

function job(id = 11) {
  return {
    id,
    run_id: 7,
    run_attempt: 2,
    head_sha: revision,
    name: `job-${id}`,
    status: "completed",
    conclusion: "success",
    runner_id: 5,
    runner_name: "hosted",
    started_at: timestamp,
    completed_at: timestamp,
  };
}

function artifact(id = 21) {
  return {
    id,
    name: `artifact-${id}`,
    size_in_bytes: 100,
    expired: false,
    digest: `sha256:${"a".repeat(64)}`,
    created_at: timestamp,
    expires_at: timestamp,
    workflow_run: { id: 7, repository_id: 9, head_repository_id: 9, head_sha: revision },
  };
}

function fixture(transform: FixtureTransform = (response) => response): FixtureOptions {
  const calls: string[] = [];
  const run = {
    id: 7,
    run_attempt: 2,
    head_sha: revision,
    repository: { id: 9, full_name: "boburning/portcove" },
    head_repository: { id: 9 },
    path: ".github/workflows/release.yml",
    status: "completed",
    conclusion: "success",
    workflow_id: 6,
    event: "workflow_dispatch",
    updated_at: timestamp,
  };
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      const url = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      );
      calls.push(url.href);
      const key = url.pathname.slice(new URL(root).pathname.length);
      let body: Record<string, unknown>;
      if (key === runPath || key === `${runPath}/attempts/2`) body = run;
      else if (key === `/git/commits/${revision}`) body = { sha: revision, tree: { sha: tree } };
      else if (key === "/contents/.github/workflows/release.yml")
        body = {
          type: "file",
          path: ".github/workflows/release.yml",
          encoding: "base64",
          size: workflow.length,
          content: workflow.toString("base64"),
        };
      else if (key === jobsPath) body = { total_count: 1, jobs: [job()] };
      else if (key === artifactPath) body = { total_count: 1, artifacts: [artifact()] };
      else assert.fail(`unexpected fixture endpoint ${key}`);
      return transform(
        { status: 200, headers: new Map(), body: structuredClone(body) },
        { key, url, calls },
      );
    },
  };
  return { api, calls, elapsed: () => 0, now: () => Date.parse(timestamp) };
}

function byteFixture(bytes: Buffer, transform: FixtureTransform = (response) => response) {
  return fixture((response, context) => {
    if (context.key === artifactPath) {
      firstRecord(response.body, "artifacts", 0).size_in_bytes = bytes.length;
      firstRecord(response.body, "artifacts", 0).digest =
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    }
    return transform(response, context);
  });
}

void test("retained artifact bytes bind fresh API identity without attributing producer job or attempt", async (context) => {
  const bytes = Buffer.alloc(150_001, 37);
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-artifact-bytes-"));
  context.after(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  );
  const filename = path.join(directory, "retained.bin");
  await writeFile(filename, bytes);
  const options = byteFixture(bytes);
  const receipt = await verifyReleaseArtifactBytes(request, 21, filename, options);
  assert.equal(receipt.bytes, bytes.length);
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(receipt.producer_attempt, null);
  assert.equal(receipt.producer_job_id, null);
  assert.equal(receipt.attempt, 2);
  assert.equal(receipt.source_tree, tree);
  assert.equal(options.calls.length, 14);
  for (const stage of ["before", "after"] as const) {
    const { evidence_sha256, ...apiEvidence } = receipt[`${stage}_api_evidence`];
    assert.equal(evidence_sha256, receipt[`${stage}_api_evidence_sha256`]);
    assert.equal(
      evidence_sha256,
      createHash("sha256").update(JSON.stringify(apiEvidence)).digest("hex"),
    );
    assert.equal(apiEvidence.jobs.length, 1);
    assert.equal(requiredFixture(apiEvidence.artifacts[0]).id, 21);
  }
  assert.match(receipt.qualification, /package contents.*remain unproven/u);
  await writeFile(filename, Buffer.alloc(bytes.length, 38));
  await assert.rejects(
    verifyReleaseArtifactBytes(request, 21, filename, byteFixture(bytes)),
    /differ from provider digest/u,
  );
});

void test("missing, expired, undigested and oversized artifact identities refuse before local file I/O", async () => {
  const bytes = Buffer.from("retained");
  for (const change of [
    (body: Record<string, unknown>) => {
      body.artifacts = [];
      body.total_count = 0;
    },
    (body: Record<string, unknown>) => {
      firstRecord(body, "artifacts", 0).expired = true;
    },
    (body: Record<string, unknown>) => {
      firstRecord(body, "artifacts", 0).digest = null;
    },
    (body: Record<string, unknown>) => {
      firstRecord(body, "artifacts", 0).size_in_bytes = 512 * 1024 * 1024 + 1;
    },
  ]) {
    const options = byteFixture(bytes, (response, context) => {
      if (context.key === artifactPath) change(response.body);
      return response;
    });
    options.openFile = async () => {
      assert.fail("ineligible identity must not open local bytes");
    };
    await assert.rejects(
      verifyReleaseArtifactBytes(request, 21, "unused", options),
      /no current bounded provider byte identity/u,
    );
  }
});

void test("late API artifact replacement and run changes refuse after byte comparison", async (context) => {
  const bytes = Buffer.from("retained");
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-artifact-drift-"));
  context.after(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  );
  const filename = path.join(directory, "retained.bin");
  await writeFile(filename, bytes);
  for (const change of ["artifact", "run"]) {
    const options = byteFixture(bytes, (response, context) => {
      if (context.calls.length > 7) {
        if (change === "artifact" && context.key === artifactPath)
          firstRecord(response.body, "artifacts", 0).name = "replacement";
        if (change === "run" && context.key.startsWith(runPath) && !context.key.endsWith("jobs"))
          response.body.updated_at = "2026-10-12T07:01:00Z";
      }
      return response;
    });
    await assert.rejects(
      verifyReleaseArtifactBytes(request, 21, filename, options),
      /artifact or run changed/u,
    );
  }
});

void test("artifact growth, same-size mutation and nonregular handles refuse and always close", async () => {
  const bytes = Buffer.from("retained");
  for (const mode of ["growth", "mutation", "nonregular", "short", "late"]) {
    let stats = 0,
      reads = 0,
      closed = false;
    const options = byteFixture(bytes);
    options.openFile = async () => ({
      async stat() {
        stats += 1;
        return {
          isFile: () => mode !== "nonregular",
          size: bytes.length,
          mtimeMs: mode === "mutation" && stats > 1 ? 2 : 1,
          ctimeMs: 1,
          dev: 1,
          ino: 1,
        };
      },
      async read(buffer, offset, length) {
        assert.ok(length <= 64 * 1024);
        reads += 1;
        if (reads > 1) return { bytesRead: mode === "growth" ? 1 : 0 };
        bytes.copy(buffer);
        return { bytesRead: mode === "short" ? bytes.length - 1 : bytes.length };
      },
      async close() {
        closed = true;
      },
    });
    if (mode === "late") options.elapsed = () => (reads ? 120_000 : 0);
    await assert.rejects(
      verifyReleaseArtifactBytes(request, 21, "retained", options),
      /grew|changed|regular file|exhausted/u,
    );
    assert.equal(closed, true);
  }
});

void test("both API collections share one request cap rather than renewing it after local hashing", async (context) => {
  const bytes = Buffer.alloc(100, 37);
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-artifact-request-cap-"));
  context.after(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  );
  const filename = path.join(directory, "retained.bin");
  await writeFile(filename, bytes);
  const options = fixture((response, context) => {
    if ([jobsPath, artifactPath].includes(context.key)) {
      const page = Number(context.url.searchParams.get("page") ?? 1);
      const key = context.key === jobsPath ? "jobs" : "artifacts";
      const record = key === "jobs" ? job : artifact;
      response.body = {
        total_count: 1600,
        [key]: Array.from({ length: 100 }, (_, index) => record((page - 1) * 100 + index + 1)),
      };
      if (key === "artifacts" && page === 1) {
        firstRecord(response.body, "artifacts", 20).digest =
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      }
      if (page < 16)
        response.headers.set(
          "link",
          `<${root}${context.key}?per_page=100&page=${page + 1}>; rel="next"`,
        );
    }
    return response;
  });
  await assert.rejects(
    verifyReleaseArtifactBytes(request, 21, filename, options),
    /exhausted its request bound/u,
  );
  assert.equal(options.calls.length, 40);
});

void test("collects exact API identities while retaining unproven artifact and execution bindings", () => {
  const options = fixture();
  const evidence = collectReleaseRunEvidence(request, options);
  assert.equal(options.calls.length, 7);
  assert.equal(evidence.run.attempt, 2);
  assert.equal(evidence.source_tree, tree);
  assert.equal(evidence.source_workflow_sha256, workflowDigest);
  assert.match(evidence.execution_workflow_binding, /unproven/u);
  assert.match(evidence.artifact_scope, /across attempts/u);
  assert.equal(requiredFixture(evidence.artifacts[0]).producer_attempt, null);
  assert.equal(requiredFixture(evidence.artifacts[0]).producer_job_id, null);
  assert.match(evidence.qualification, /no artifact-byte/u);
  const { evidence_sha256: digest, ...body } = evidence;
  assert.equal(digest, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});

for (const key of ["jobs", "artifacts"] as const) {
  const endpoint = key === "jobs" ? jobsPath : artifactPath;
  const record = key === "jobs" ? job : artifact;
  void test(`${key}: complete empty and multi-page inventories`, () => {
    const empty = fixture((response, context) => {
      if (context.key === endpoint) response.body = { total_count: 0, [key]: [] };
      return response;
    });
    assert.deepEqual(collectReleaseRunEvidence(request, empty)[key], []);
    const multiple = fixture((response, context) => {
      if (context.key === endpoint) {
        const second = context.url.searchParams.has("page");
        response.body = { total_count: 2, [key]: [record(second ? 2 : 1)] };
        if (!second)
          response.headers.set("link", `<${root}${endpoint}?per_page=100&page=2>; rel="next"`);
      }
      return response;
    });
    assert.deepEqual(
      collectReleaseRunEvidence(request, multiple)[key].map((value) => value.id),
      [1, 2],
    );
  });

  for (const [label, mutate] of [
    [
      "missing total",
      (body: Record<string, unknown>) => {
        delete body.total_count;
      },
    ],
    [
      "negative total",
      (body: Record<string, unknown>) => {
        body.total_count = -1;
      },
    ],
    [
      "missing records",
      (body: Record<string, unknown>) => {
        delete body[key];
      },
    ],
    [
      "truncated records",
      (body: Record<string, unknown>) => {
        body.total_count = 2;
      },
    ],
    [
      "duplicate IDs",
      (body: Record<string, unknown>) => {
        body.total_count = 2;
        assert.ok(Array.isArray(body[key]));
        body[key].push(body[key][0]);
      },
    ],
    [
      "missing ID",
      (body: Record<string, unknown>) => {
        delete firstRecord(body, key).id;
      },
    ],
    [
      "hard cap",
      (body: Record<string, unknown>) => {
        body.total_count = 1601;
      },
    ],
  ] satisfies [string, (body: Record<string, unknown>) => void][])
    void test(`${key}: rejects ${label}`, () => {
      assert.throws(() =>
        collectReleaseRunEvidence(
          request,
          fixture((response, context) => {
            if (context.key === endpoint) mutate(response.body);
            return response;
          }),
        ),
      );
    });

  void test(`${key}: accepts the complete 1600-record boundary`, () => {
    const options = fixture((response, context) => {
      if (context.key === endpoint) {
        const page = Number(context.url.searchParams.get("page") ?? 1);
        response.body = {
          total_count: 1600,
          [key]: Array.from({ length: 100 }, (_, index) => record((page - 1) * 100 + index + 1)),
        };
        if (page < 16)
          response.headers.set(
            "link",
            `<${root}${endpoint}?per_page=100&page=${page + 1}>; rel="next"`,
          );
      }
      return response;
    });
    assert.equal(collectReleaseRunEvidence(request, options)[key].length, 1600);
  });

  void test(`${key}: rejects changing totals and stalled cursors`, () => {
    for (const stalled of [false, true])
      assert.throws(() =>
        collectReleaseRunEvidence(
          request,
          fixture((response, context) => {
            if (context.key === endpoint) {
              const second = context.url.searchParams.has("page");
              response.body = { total_count: second ? 3 : 2, [key]: [record(second ? 2 : 1)] };
              response.headers.set(
                "link",
                `<${root}${endpoint}?per_page=100${stalled ? "" : "&page=2"}>; rel="next"`,
              );
            }
            return response;
          }),
        ),
      );
  });
}

for (const next of [
  "https://elsewhere.example/repos/boburning/portcove/actions/runs/7/artifacts?per_page=100&page=2",
  "https://api.github.com/repos/foreign/repository/actions/runs/7/artifacts?per_page=100&page=2",
  `${root}${artifactPath}?per_page=100&page=2&ref=${revision}`,
  `${root}${artifactPath}?per_page=100&page=2&page=3`,
  `${root}${artifactPath}?per_page=101&page=2`,
  `${root}${artifactPath}?per_page=100&page=0`,
  `${root}/contents/.github/workflows/release.yml`,
])
  void test(`refuses pagination outside exact endpoint/query scope: ${next}`, () => {
    const options = fixture((response, context) => {
      if (context.key === artifactPath) {
        response.body.total_count = 2;
        response.headers.set("link", `<${next}>; rel="next"`);
      }
      return response;
    });
    assert.throws(() => collectReleaseRunEvidence(request, options), /read-only scope/u);
    assert.equal(options.calls.length, 6);
  });

for (const [label, key, mutate] of [
  [
    "latest attempt",
    runPath,
    (body: Record<string, unknown>) => {
      body.run_attempt = 3;
    },
  ],
  [
    "nonterminal run",
    runPath,
    (body: Record<string, unknown>) => {
      body.status = "in_progress";
    },
  ],
  [
    "fork run",
    runPath,
    (body: Record<string, unknown>) => {
      record(body.head_repository).id = 10;
    },
  ],
  [
    "foreign workflow",
    runPath,
    (body: Record<string, unknown>) => {
      body.path = ".github/workflows/ci.yml";
    },
  ],
  [
    "source revision",
    runPath,
    (body: Record<string, unknown>) => {
      body.head_sha = "3".repeat(40);
    },
  ],
  [
    "attempt identity",
    `${runPath}/attempts/2`,
    (body: Record<string, unknown>) => {
      body.workflow_id = 10;
    },
  ],
  [
    "source tree",
    `/git/commits/${revision}`,
    (body: Record<string, unknown>) => {
      record(body.tree).sha = "3".repeat(40);
    },
  ],
  [
    "workflow bytes",
    "/contents/.github/workflows/release.yml",
    (body: Record<string, unknown>) => {
      body.content = "eA==";
      body.size = 1;
    },
  ],
  [
    "workflow size",
    "/contents/.github/workflows/release.yml",
    (body: Record<string, unknown>) => {
      body.size = 262145;
    },
  ],
  [
    "job attempt",
    jobsPath,
    (body: Record<string, unknown>) => {
      firstRecord(body, "jobs", 0).run_attempt = 1;
    },
  ],
  [
    "job source",
    jobsPath,
    (body: Record<string, unknown>) => {
      firstRecord(body, "jobs", 0).head_sha = "3".repeat(40);
    },
  ],
  [
    "nonterminal job",
    jobsPath,
    (body: Record<string, unknown>) => {
      firstRecord(body, "jobs", 0).status = "in_progress";
    },
  ],
  [
    "artifact repository",
    artifactPath,
    (body: Record<string, unknown>) => {
      record(firstRecord(body, "artifacts", 0).workflow_run).repository_id = 10;
    },
  ],
  [
    "artifact run",
    artifactPath,
    (body: Record<string, unknown>) => {
      record(firstRecord(body, "artifacts", 0).workflow_run).id = 8;
    },
  ],
  [
    "artifact source",
    artifactPath,
    (body: Record<string, unknown>) => {
      record(firstRecord(body, "artifacts", 0).workflow_run).head_sha = "3".repeat(40);
    },
  ],
  [
    "artifact digest",
    artifactPath,
    (body: Record<string, unknown>) => {
      firstRecord(body, "artifacts", 0).digest = "md5:bad";
    },
  ],
] satisfies [string, string, (body: Record<string, unknown>) => void][])
  void test(`rejects mismatched ${label}`, () => {
    assert.throws(() =>
      collectReleaseRunEvidence(
        request,
        fixture((response, context) => {
          if (context.key === key) mutate(response.body);
          return response;
        }),
      ),
    );
  });

void test("retains expired artifacts and missing digests without inventing usable bytes", () => {
  const evidence = collectReleaseRunEvidence(
    request,
    fixture((response, context) => {
      if (context.key === artifactPath) {
        firstRecord(response.body, "artifacts", 0).expired = true;
        delete firstRecord(response.body, "artifacts", 0).digest;
      }
      return response;
    }),
  );
  assert.equal(requiredFixture(evidence.artifacts[0]).expired, true);
  assert.equal(requiredFixture(evidence.artifacts[0]).archive_sha256, null);
});

void test("refuses current-run drift after collecting inventory", () => {
  assert.throws(
    () =>
      collectReleaseRunEvidence(
        request,
        fixture((response, context) => {
          if (context.calls.length === 7) response.body.updated_at = "changed";
          return response;
        }),
      ),
    /changed during/u,
  );
});

void test("request and elapsed-time bounds stop collection before another API read", () => {
  const options = fixture((response, context) => {
    if (context.key === jobsPath) {
      const page = Number(context.url.searchParams.get("page") ?? 1);
      response.body = { total_count: 1600, jobs: [job(page)] };
      response.headers.set(
        "link",
        `<${root}${jobsPath}?per_page=100&page=${page + 1}>; rel="next"`,
      );
    }
    return response;
  });
  assert.throws(() => collectReleaseRunEvidence(request, options), /exhausted/u);
  assert.equal(options.calls.length, 40);
  const early = fixture();
  let tick = 0;
  early.elapsed = () => (tick++ === 0 ? 0 : 120000);
  assert.throws(() => collectReleaseRunEvidence(request, early), /exhausted/u);
  assert.equal(early.calls.length, 0);
  const late = fixture();
  tick = 0;
  late.elapsed = () => (tick++ < 2 ? 0 : 120000);
  assert.throws(() => collectReleaseRunEvidence(request, late), /late/u);
  assert.equal(late.calls.length, 1);
});

void test("rejects extra authority fields and API failures", () => {
  const options = fixture();
  assert.throws(
    () => collectReleaseRunEvidence({ ...request, publication: true }, options),
    /schema/u,
  );
  assert.equal(options.calls.length, 0);
  assert.throws(
    () =>
      collectReleaseRunEvidence(
        request,
        fixture((response) => ({ ...response, status: 403 })),
      ),
    /unavailable/u,
  );
});

void test("retains cross-endpoint timestamp differences without relaxing run identity", () => {
  const evidence = collectReleaseRunEvidence(
    request,
    fixture((response, context) => {
      if (context.key === `${runPath}/attempts/2`)
        response.body.updated_at = "2026-10-12T07:00:01Z";
      return response;
    }),
  );
  assert.equal(evidence.run.updated_at, timestamp);
  assert.equal(evidence.attempt_updated_at, "2026-10-12T07:00:01Z");
});

void test("refuses receipt publication when final construction exceeds the monotonic deadline", () => {
  const options = fixture();
  let elapsed = 0;
  options.elapsed = () => elapsed;
  options.now = () => {
    elapsed = 120000;
    return Date.parse(timestamp);
  };
  assert.throws(() => collectReleaseRunEvidence(request, options), /exhausted/u);
  assert.equal(options.calls.length, 7);
});

void test("request reader admits bounded JSON files and rejects oversized, empty and nonregular input", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-release-evidence-"));
  context.after(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  );
  const filename = path.join(directory, "request.json");
  await writeFile(filename, JSON.stringify(request));
  assert.deepEqual(await readReleaseEvidenceRequest(filename), request);
  await writeFile(filename, " ".repeat(16 * 1024 + 1));
  await assert.rejects(readReleaseEvidenceRequest(filename), /bounded regular file/u);
  await writeFile(filename, "");
  await assert.rejects(readReleaseEvidenceRequest(filename), /bounded regular file/u);
  await assert.rejects(readReleaseEvidenceRequest(directory));
});

void test("request reader caps actual growth and closes the same handle on drift", async () => {
  let opened = 0;
  let closed = 0;
  let actualRead = 0;
  const handle: EvidenceFileHandle = {
    async stat() {
      return { isFile: () => true, size: 1, mtimeMs: 1, ctimeMs: 1 };
    },
    async read(buffer, offset, length) {
      assert.equal(buffer.length, 16 * 1024 + 1);
      buffer.fill(0x20, offset, offset + length);
      actualRead += length;
      return { bytesRead: length };
    },
    async close() {
      closed += 1;
    },
  };
  await assert.rejects(
    readReleaseEvidenceRequest("request.json", {
      openFile: async () => {
        opened += 1;
        return handle;
      },
    }),
    /changed/u,
  );
  assert.equal(actualRead, 16 * 1024 + 1);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

void test("request reader opens without following links or blocking on a POSIX FIFO", async () => {
  let closed = false;
  await assert.rejects(
    readReleaseEvidenceRequest("fifo", {
      openFile: async (_filename, flags) => {
        for (const flag of [constants.O_NOFOLLOW, constants.O_NONBLOCK]) {
          if (flag !== undefined) assert.equal(flags & flag, flag);
        }
        return {
          async stat() {
            return { isFile: () => false };
          },
          async read() {
            assert.fail("nonregular handles must never be read");
          },
          async close() {
            closed = true;
          },
        };
      },
    }),
    /bounded regular file/u,
  );
  assert.equal(closed, true);
});

void test(
  "actual POSIX FIFO is refused without waiting for a writer",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-release-fifo-"));
    context.after(() =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
    );
    const fifo = path.join(directory, "request.fifo");
    const created = spawnSync("mkfifo", [fifo], { timeout: 3000, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const moduleUrl = new URL("./release-run-evidence.mts", import.meta.url).href;
    const code = `import assert from "node:assert/strict";
    import {readReleaseEvidenceRequest} from ${JSON.stringify(moduleUrl)};
    await assert.rejects(readReleaseEvidenceRequest(process.argv[1]), /bounded regular file/u);`;
    const refused = spawnSync(process.execPath, ["--input-type=module", "-e", code, fifo], {
      timeout: 3000,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 0, refused.stderr);
  },
);

void test("request reader refuses same-size mutation and never reopens a replaced pathname", async () => {
  const bytes = Buffer.from(JSON.stringify(request));
  for (const mutate of [false, true]) {
    let opens = 0;
    let stats = 0;
    let consumed = false;
    const handle: EvidenceFileHandle = {
      async stat() {
        stats += 1;
        return {
          isFile: () => true,
          size: bytes.length,
          mtimeMs: mutate && stats === 2 ? 2 : 1,
          ctimeMs: 1,
        };
      },
      async read(buffer) {
        if (consumed) return { bytesRead: 0 };
        consumed = true;
        bytes.copy(buffer);
        return { bytesRead: bytes.length };
      },
      async close() {},
    };
    const result = readReleaseEvidenceRequest("replaced-path.json", {
      openFile: async () => {
        opens += 1;
        assert.equal(opens, 1, "a replacement pathname must never be reopened");
        return handle;
      },
    });
    if (mutate) await assert.rejects(result, /changed/u);
    else assert.deepEqual(await result, request);
    assert.equal(opens, 1);
  }
});
