import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectReleaseRunEvidence, readReleaseEvidenceRequest } from "./release-run-evidence.mjs";

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

function fixture(transform = (response) => response) {
  const calls = [];
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
    request(method, endpoint) {
      assert.equal(method, "GET");
      const url = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      );
      calls.push(url.href);
      const key = url.pathname.slice(new URL(root).pathname.length);
      let body;
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

test("collects exact API identities while retaining unproven artifact and execution bindings", () => {
  const options = fixture();
  const evidence = collectReleaseRunEvidence(request, options);
  assert.equal(options.calls.length, 7);
  assert.equal(evidence.run.attempt, 2);
  assert.equal(evidence.source_tree, tree);
  assert.equal(evidence.source_workflow_sha256, workflowDigest);
  assert.match(evidence.execution_workflow_binding, /unproven/u);
  assert.match(evidence.artifact_scope, /across attempts/u);
  assert.equal(evidence.artifacts[0].producer_attempt, null);
  assert.equal(evidence.artifacts[0].producer_job_id, null);
  assert.match(evidence.qualification, /no artifact-byte/u);
  const { evidence_sha256: digest, ...body } = evidence;
  assert.equal(digest, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});

for (const key of ["jobs", "artifacts"]) {
  const endpoint = key === "jobs" ? jobsPath : artifactPath;
  const record = key === "jobs" ? job : artifact;
  test(`${key}: complete empty and multi-page inventories`, () => {
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
      (body) => {
        delete body.total_count;
      },
    ],
    [
      "negative total",
      (body) => {
        body.total_count = -1;
      },
    ],
    [
      "missing records",
      (body) => {
        delete body[key];
      },
    ],
    [
      "truncated records",
      (body) => {
        body.total_count = 2;
      },
    ],
    [
      "duplicate IDs",
      (body) => {
        body.total_count = 2;
        body[key].push(body[key][0]);
      },
    ],
    [
      "missing ID",
      (body) => {
        delete body[key][0].id;
      },
    ],
    [
      "hard cap",
      (body) => {
        body.total_count = 1601;
      },
    ],
  ])
    test(`${key}: rejects ${label}`, () => {
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

  test(`${key}: accepts the complete 1600-record boundary`, () => {
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

  test(`${key}: rejects changing totals and stalled cursors`, () => {
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
  test(`refuses pagination outside exact endpoint/query scope: ${next}`, () => {
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
    (body) => {
      body.run_attempt = 3;
    },
  ],
  [
    "nonterminal run",
    runPath,
    (body) => {
      body.status = "in_progress";
    },
  ],
  [
    "fork run",
    runPath,
    (body) => {
      body.head_repository.id = 10;
    },
  ],
  [
    "foreign workflow",
    runPath,
    (body) => {
      body.path = ".github/workflows/ci.yml";
    },
  ],
  [
    "source revision",
    runPath,
    (body) => {
      body.head_sha = "3".repeat(40);
    },
  ],
  [
    "attempt identity",
    `${runPath}/attempts/2`,
    (body) => {
      body.workflow_id = 10;
    },
  ],
  [
    "source tree",
    `/git/commits/${revision}`,
    (body) => {
      body.tree.sha = "3".repeat(40);
    },
  ],
  [
    "workflow bytes",
    "/contents/.github/workflows/release.yml",
    (body) => {
      body.content = "eA==";
      body.size = 1;
    },
  ],
  [
    "workflow size",
    "/contents/.github/workflows/release.yml",
    (body) => {
      body.size = 262145;
    },
  ],
  [
    "job attempt",
    jobsPath,
    (body) => {
      body.jobs[0].run_attempt = 1;
    },
  ],
  [
    "job source",
    jobsPath,
    (body) => {
      body.jobs[0].head_sha = "3".repeat(40);
    },
  ],
  [
    "nonterminal job",
    jobsPath,
    (body) => {
      body.jobs[0].status = "in_progress";
    },
  ],
  [
    "artifact repository",
    artifactPath,
    (body) => {
      body.artifacts[0].workflow_run.repository_id = 10;
    },
  ],
  [
    "artifact run",
    artifactPath,
    (body) => {
      body.artifacts[0].workflow_run.id = 8;
    },
  ],
  [
    "artifact source",
    artifactPath,
    (body) => {
      body.artifacts[0].workflow_run.head_sha = "3".repeat(40);
    },
  ],
  [
    "artifact digest",
    artifactPath,
    (body) => {
      body.artifacts[0].digest = "md5:bad";
    },
  ],
])
  test(`rejects mismatched ${label}`, () => {
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

test("retains expired artifacts and missing digests without inventing usable bytes", () => {
  const evidence = collectReleaseRunEvidence(
    request,
    fixture((response, context) => {
      if (context.key === artifactPath) {
        response.body.artifacts[0].expired = true;
        delete response.body.artifacts[0].digest;
      }
      return response;
    }),
  );
  assert.equal(evidence.artifacts[0].expired, true);
  assert.equal(evidence.artifacts[0].archive_sha256, null);
});

test("refuses current-run drift after collecting inventory", () => {
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

test("request and elapsed-time bounds stop collection before another API read", () => {
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

test("rejects extra authority fields and API failures", () => {
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

test("retains cross-endpoint timestamp differences without relaxing run identity", () => {
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

test("refuses receipt publication when final construction exceeds the monotonic deadline", () => {
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

test("request reader admits bounded JSON files and rejects oversized, empty and nonregular input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-release-evidence-"));
  const filename = path.join(directory, "request.json");
  await writeFile(filename, JSON.stringify(request));
  assert.deepEqual(await readReleaseEvidenceRequest(filename), request);
  await writeFile(filename, " ".repeat(16 * 1024 + 1));
  await assert.rejects(readReleaseEvidenceRequest(filename), /bounded regular file/u);
  await writeFile(filename, "");
  await assert.rejects(readReleaseEvidenceRequest(filename), /bounded regular file/u);
  await assert.rejects(readReleaseEvidenceRequest(directory));
});

test("request reader caps actual growth and closes the same handle on drift", async () => {
  let opened = 0;
  let closed = 0;
  let actualRead = 0;
  const handle = {
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

test("request reader opens without following links or blocking on a POSIX FIFO", async () => {
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

test(
  "actual POSIX FIFO is refused without waiting for a writer",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-release-fifo-"));
    const fifo = path.join(directory, "request.fifo");
    const created = spawnSync("mkfifo", [fifo], { timeout: 3000, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const moduleUrl = new URL("./release-run-evidence.mjs", import.meta.url).href;
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

test("request reader refuses same-size mutation and never reopens a replaced pathname", async () => {
  const bytes = Buffer.from(JSON.stringify(request));
  for (const mutate of [false, true]) {
    let opens = 0;
    let stats = 0;
    let consumed = false;
    const handle = {
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
