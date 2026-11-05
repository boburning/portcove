import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import {
  inspectPublicationResultArchive,
  preparePublicationResultPredicate,
  receivePublicationResultArtifact,
  requireReceivedPublicationResult,
  intersectPublicationResultDeadline,
} from "./release-publication-result-artifact.mts";

void test("a downstream phase can tighten the retained acquisition budget and cannot extend or invalidate it", () => {
  const retained = performance.now() + 10000,
    earlier = retained - 9000;
  assert.equal(intersectPublicationResultDeadline(retained), retained);
  assert.equal(intersectPublicationResultDeadline(retained, earlier), earlier);
  assert.equal(intersectPublicationResultDeadline(earlier, retained), earlier);
  assert.equal(intersectPublicationResultDeadline(retained, -1), -1);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => intersectPublicationResultDeadline(retained, invalid), /deadline invalid/);
    assert.throws(() => intersectPublicationResultDeadline(invalid, retained), /deadline invalid/);
  }
});

void test("a retained SDK custody reader honors a shorter phase and never renews its original deadline", async (t) => {
  let now = 1000,
    current = 9000,
    sends = 0;
  t.mock.method(performance, "now", () => now);
  const provider = await createReleaseCustodyProvider({
    token: "inert-result-reader",
    deadline: 10000,
    currentDeadline: () => current,
    fetch: async () => {
      sends++;
      return Response.json({ id: 1 });
    },
  });
  assert.deepEqual(await provider.artifact(1), { id: 1 });
  current = 999;
  await assert.rejects(provider.artifact(1), /deadline exhausted/);
  current = 20000;
  now = 10001;
  await assert.rejects(provider.artifact(1), /deadline exhausted/);
  assert.equal(sends, 1);
});

void test("publication result handoff admits one bounded UTF-8 member and rejects alternate inventory, CRC, and expansion", () => {
  const bytes = Buffer.from('{"scope":"fixture-integrity-only"}\n');
  for (const method of [0, 8]) {
    const archive = createAuditZip([["immutable-release-result.json", bytes, { method }]]);
    assert.deepEqual(inspectPublicationResultArchive(archive), bytes);
  }
  assert.throws(
    () => inspectPublicationResultArchive(createAuditZip([["other.json", bytes]])),
    /path|inventory/,
  );
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([
          ["immutable-release-result.json", bytes],
          ["extra", bytes],
        ]),
      ),
    /limit|inventory|bound|path/,
  );
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([["immutable-release-result.json", Buffer.alloc(65537)]]),
      ),
    /limit|bound/,
  );
  const archive = createAuditZip([["immutable-release-result.json", bytes, { method: 0 }]]);
  const offset = 30 + Buffer.byteLength("immutable-release-result.json");
  archive[offset] = archive[offset]! ^ 1;
  assert.throws(() => inspectPublicationResultArchive(archive), /byte|CRC/);
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([["immutable-release-result.json", Buffer.from([0xff])]]),
      ),
    /byte/,
  );
  assert.deepEqual(
    inspectPublicationResultArchive(
      createAuditZip([["immutable-release-result-attestation.json", bytes]]),
      true,
    ),
    bytes,
  );
});

void test("copied publication custody cannot prepare a predicate or establish a received result", async () => {
  await assert.rejects(
    preparePublicationResultPredicate(
      {},
      { id: 1, sha256: "a".repeat(64) },
      performance.now() + 1000,
    ),
    /actual owned/,
  );
  await assert.rejects(
    requireReceivedPublicationResult({
      kind: "attested-owned-immutable-release-result",
      evidence_scope: "github.com",
    }),
    /actual authenticated/,
  );
});

function expectedResult() {
  return {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "123",
    run_attempt: 1,
    artifact: { id: 1, sha256: "c".repeat(64) },
    bundle: { id: 2, sha256: "d".repeat(64) },
    report_sha256: "e".repeat(64),
  };
}

void test("receiver refuses changed controller expectations and provider artifact identity before any download", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-result-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = expectedResult();
  let downloads = 0;
  const download = () => {
    downloads++;
    throw new Error("must not download");
  };
  await assert.rejects(
    receivePublicationResultArtifact(
      directory,
      { ...expected, run_attempt: 2 },
      {},
      performance.now() + 10000,
      { download },
    ),
    /identity/,
  );
  assert.deepEqual(await readdir(directory), []);
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    path: ".github/workflows/application-update-production.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const requests: string[] = [];
  await assert.rejects(
    receivePublicationResultArtifact(directory, expected, {}, performance.now() + 10000, {
      download,
      metadata: {
        async commit(sha) {
          assert.equal(sha, expected.controller_revision);
          requests.push("commit");
          return { sha, tree: { sha: expected.source_tree } };
        },
        async run(id) {
          assert.equal(id, expected.run_id);
          requests.push("run");
          return run;
        },
        async attempt(id, attempt) {
          assert.equal(id, expected.run_id);
          assert.equal(attempt, 1);
          requests.push("attempt");
          return run;
        },
        async artifact(id) {
          requests.push("artifact");
          assert.equal(id, expected.artifact.id);
          return {
            id,
            name: "wrong-publisher-artifact",
            digest: `sha256:${expected.artifact.sha256}`,
            expired: false,
          };
        },
        async job() {
          assert.fail("invalid artifact must stop before job proof");
        },
      },
    }),
    /acquisition refused/,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(requests, ["commit", "run", "attempt", "artifact"]);
  const [retained] = await readdir(directory);
  const refusal: unknown = JSON.parse(
    await readFile(path.join(directory, retained!, "refusal.json"), "utf8"),
  );
  assert.ok(isRecord(refusal));
  assert.equal(refusal.phase, "provider-before");
  assert.equal(refusal.automatic_retry, false);
  const before = await readdir(directory);
  await assert.rejects(
    receivePublicationResultArtifact(directory, expected, {}, performance.now() - 1, { download }),
    /deadline/,
  );
  assert.deepEqual(await readdir(directory), before);
});

void test("locked result metadata reads the original proof in order and refuses incomplete provider packets", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "publication-result-sdk-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-result-reader";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const expected = expectedResult();
  const base = "https://api.github.com/repos/boburning/portcove";
  const routes = [
    `${base}/git/commits/${expected.controller_revision}`,
    `${base}/actions/runs/${expected.run_id}`,
    `${base}/actions/runs/${expected.run_id}/attempts/1`,
    `${base}/actions/artifacts/${expected.artifact.id}`,
    `${base}/actions/artifacts/${expected.bundle.id}`,
  ];
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    path: ".github/workflows/application-update-production.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  for (const fault of [
    "complete",
    "stream",
    "cap",
    "redirect",
    "unavailable",
    "non-200",
  ] as const) {
    let sends = 0,
      downloads = 0;
    const mockedFetch = t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const index = sends++;
        assert.equal(input instanceof Request ? input.url : String(input), routes[index]);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "manual");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "token inert-result-reader");
        assert.equal(headers.get("x-github-api-version"), "2022-11-28");
        if (fault === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid" },
          });
        if (fault === "unavailable")
          return Response.json({ message: "unavailable" }, { status: 503 });
        if (fault === "cap") return new Response("x".repeat(2 * 1024 ** 2 + 1));
        if (fault === "stream" && index === 3)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("artifact metadata incomplete"));
              },
            }),
          );
        if (index === 0)
          return Response.json(
            { sha: expected.controller_revision, tree: { sha: expected.source_tree } },
            {
              status: fault === "non-200" ? 201 : 200,
            },
          );
        if (index === 1 || index === 2) return Response.json(run);
        const item = index === 3 ? expected.artifact : expected.bundle;
        return Response.json({
          id: item.id,
          digest: `sha256:${item.sha256}`,
          expired: false,
          size_in_bytes: 22,
          name: `trusted-immutable-release-result${index === 4 ? "-attestation" : ""}-123-1`,
          workflow_run: {
            id: 123,
            repository_id: 1354613114,
            head_repository_id: 1354613114,
            head_sha: expected.controller_revision,
          },
        });
      },
    );
    try {
      await assert.rejects(
        receivePublicationResultArtifact(parent, expected, {}, performance.now() + 15000, {
          download(endpoint) {
            downloads++;
            assert.equal(endpoint, "repos/boburning/portcove/actions/artifacts/1/zip");
            throw new Error("fixture stops at separate archive acquisition");
          },
        }),
        /acquisition refused/,
      );
      assert.equal(sends, fault === "complete" ? 5 : fault === "stream" ? 4 : 1);
      assert.equal(downloads, fault === "complete" ? 1 : 0);
    } finally {
      mockedFetch.mock.restore();
    }
  }
});
