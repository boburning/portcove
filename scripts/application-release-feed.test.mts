import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import {
  verifyBootstrapPagesArtifact,
  verifyApplicationPagesArtifact,
  discoverPublishedApplicationCohort,
  discoverActualPublishedApplicationCohort,
} from "./application-release-feed.mts";
import { serializeSiteTar } from "./release-site-deployment.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { sha256 } from "./application-release-io.mts";
import { readReleaseNotesWithSdk } from "./release-publication-inventory.mts";
import {
  inspectApplicationRunCustody,
  retainedR55Renewal,
  retainedR56FeedRecovery,
} from "./application-release-run.mts";

void test("prior discovery joins actual feed to one immutable native cohort and holds newer pending publication", async (t) => {
  const control = "a".repeat(40),
    source = "b".repeat(40),
    generation = "c".repeat(64);
  const ref = "portcove-production-controller-windows-fixture";
  const repo = { id: 1354613114, node_id: "fixture-node", full_name: "boburning/portcove" };
  const custody = inspectApplicationRunCustody({
    schema_version: 1,
    kind: "application-release-run-custody",
    source,
    source_tree: "d".repeat(40),
    opportunity: "e".repeat(64),
    preparation: null,
    runs: [{ id: "123", control_commit: control, control_ref: `refs/tags/${ref}` }],
  });
  const notes = (value: unknown) =>
    `<!-- portcove-application-runs-v1\n${JSON.stringify(value)}\n-->`;
  const tag = `portcove-production-candidate-${custody.opportunity}`;
  const fixture = () => {
    const release = {
      id: 50,
      tag_name: tag,
      draft: false,
      immutable: true,
      prerelease: true,
      target_commitish: source,
      body: notes(custody),
      published_at: "2026-11-04T11:59:00Z",
    };
    const releases = [release];
    const tagObject = { type: "commit", sha: source };
    const deployment = {
      id: 10,
      sha: generation,
      ref,
      environment: "github-pages",
      created_at: "2026-11-04T12:00:10Z",
    };
    const responses: Record<string, unknown> = {
      "": repo,
      pages: {
        html_url: "https://boburning.github.io/portcove/",
        build_type: "workflow",
        cname: null,
        https_enforced: true,
      },
      "deployments?environment=github-pages&per_page=1": [deployment],
      "deployments/10": deployment,
      "deployments/10/statuses?per_page=1": [
        {
          id: 20,
          state: "success",
          log_url: "https://github.com/boburning/portcove/actions/runs/123/job/456",
          created_at: "2026-11-04T12:00:40Z",
        },
      ],
      "actions/jobs/456": {
        id: 456,
        run_id: 123,
        run_attempt: 1,
        name: "feed",
        status: "completed",
        conclusion: "success",
        head_sha: control,
        started_at: "2026-11-04T12:00:00Z",
        completed_at: "2026-11-04T12:01:00Z",
      },
      "actions/runs/123/attempts/1": {
        id: 123,
        run_attempt: 1,
        head_sha: control,
        path: ".github/workflows/application-release.yml",
        event: "workflow_dispatch",
        repository: repo,
        head_repository: repo,
        head_branch: ref,
      },
      "releases?per_page=100": releases,
      [`git/ref/tags/${tag}`]: { ref: `refs/tags/${tag}`, object: tagObject },
    };
    const transport = {
      async read(endpoint: string) {
        const suffix = endpoint.replace(/^repos\/boburning\/portcove\/?/u, "");
        assert.ok(Object.hasOwn(responses, suffix), suffix);
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: structuredClone(responses[suffix]),
        };
      },
      async releaseNotes() {
        return structuredClone(releases);
      },
    };
    return { release, releases, tagObject, transport, responses };
  };
  const positive = await discoverPublishedApplicationCohort(fixture().transport);
  assert.equal(positive.release_id, 50);
  assert.deepEqual(positive.custody, custody);
  assert.equal(positive.authority, "none");
  const draftOnly = fixture();
  const newerDraft = {
    ...draftOnly.release,
    id: 51,
    draft: true,
    immutable: false,
    body: notes({ ...custody, schema_version: 99 }),
  };
  draftOnly.releases.push(newerDraft);
  assert.equal((await discoverPublishedApplicationCohort(draftOnly.transport)).release_id, 50);
  newerDraft.draft = false;
  await assert.rejects(() => discoverPublishedApplicationCohort(draftOnly.transport));
  const live = fixture();
  const routes: string[] = [];
  const priorToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-actual-feed-reader";
  t.after(() => {
    if (priorToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorToken;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "token inert-actual-feed-reader");
      const endpoint = url.pathname.slice(1) + url.search;
      routes.push(endpoint);
      const response = await live.transport.read(endpoint);
      return Response.json(response.body, { status: response.status });
    },
  );
  assert.deepEqual(await discoverActualPublishedApplicationCohort(), positive);
  assert.deepEqual(
    routes.map((route) => route.replace(/^repos\/boburning\/portcove\/?/u, "")),
    [
      "pages",
      "deployments?environment=github-pages&per_page=1",
      "deployments/10/statuses?per_page=1",
      "actions/jobs/456",
      "actions/runs/123/attempts/1",
      "deployments/10",
      "deployments/10/statuses?per_page=1",
      "pages",
      "deployments?environment=github-pages&per_page=1",
      "deployments/10/statuses?per_page=1",
      "",
      "releases?per_page=100",
      `git/ref/tags/${tag}`,
      "pages",
      "deployments?environment=github-pages&per_page=1",
      "deployments/10/statuses?per_page=1",
    ],
  );
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.release.immutable = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.tagObject.sha = control;
    },
    (f: ReturnType<typeof fixture>) => {
      f.release.body = notes({ ...custody, runs: [{ ...custody.runs[0], id: "999" }] });
    },
    (f: ReturnType<typeof fixture>) => {
      f.release.published_at = "2026-11-04T12:02:00Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.release.published_at = "2026-11-04T12:00:20Z";
    },
    (f: ReturnType<typeof fixture>) => {
      f.releases.push({
        ...f.release,
        id: 51,
        tag_name: `portcove-production-candidate-${"f".repeat(64)}`,
        published_at: "2026-11-04T11:59:30Z",
        body: "missing custody",
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.release.body = "missing custody";
      Object.assign(f.release, {
        tag_name: "v0.1.0-beta.2",
        assets: [{ name: "application-metadata.json" }],
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.releases.push({
        ...f.release,
        id: 51,
        published_at: "2026-11-04T11:59:30Z",
        body: notes({ ...custody, runs: [{ ...custody.runs[0], id: "999" }] }),
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.releases.push({ ...f.release, id: 51 });
    },
  ]) {
    const negative = fixture();
    mutate(negative);
    await assert.rejects(() => discoverPublishedApplicationCohort(negative.transport));
  }
  const r57 = fixture();
  const failed = retainedR56FeedRecovery;
  const formerRef = retainedR55Renewal.next_ref;
  const r56 = {
    id: failed.failed_admission_id,
    sha: failed.control_commit,
    ref: formerRef.slice("refs/tags/".length),
    environment: "github-pages",
  };
  const r44 = { ...(r57.responses["deployments/10"] as object), id: failed.serving_admission_id };
  const r44Statuses = r57.responses["deployments/10/statuses?per_page=1"] as object[];
  r57.responses["deployments?environment=github-pages&per_page=1"] = [r56];
  r57.responses["deployments?environment=github-pages&per_page=2"] = [r56, r44];
  r57.responses[`deployments/${r44.id}`] = r44;
  r57.responses[`deployments/${r44.id}/statuses?per_page=1`] = [
    { ...r44Statuses[0], id: failed.serving_admission_status_id },
  ];
  const failedStatusRoute = `deployments/${r56.id}/statuses?per_page=1`;
  const failedStatus = {
    id: failed.failed_admission_status_id,
    state: "failure",
    environment: "github-pages",
    log_url: `https://github.com/boburning/portcove/actions/runs/${failed.run_id}/job/${failed.feed_job_id}`,
  };
  r57.responses[failedStatusRoute] = [failedStatus];
  const retained = inspectApplicationRunCustody({
    ...custody,
    opportunity: retainedR55Renewal.opportunity,
    runs: [{ id: failed.run_id, control_commit: failed.control_commit, control_ref: formerRef }],
  });
  const retainedRelease = {
    ...r57.release,
    id: retainedR55Renewal.release_id,
    tag_name: `portcove-production-candidate-${retained.opportunity}`,
    published_at: "2026-11-04T11:59:30Z",
    body: notes(retained),
  };
  r57.releases.push(retainedRelease);
  const exclusion = { release_id: retainedRelease.id, custody: retained };
  await assert.rejects(() => discoverPublishedApplicationCohort(r57.transport, exclusion));
  await assert.rejects(() =>
    discoverPublishedApplicationCohort(r57.transport, { ...exclusion, release_id: 123 }, true),
  );
  assert.equal(
    (await discoverPublishedApplicationCohort(r57.transport, exclusion, true)).release_id,
    50,
  );
  for (const driftAt of [2, 3]) {
    let reads = 0;
    await assert.rejects(
      () =>
        discoverPublishedApplicationCohort(
          {
            ...r57.transport,
            async read(route) {
              const response = await r57.transport.read(route);
              if (route.endsWith(failedStatusRoute) && ++reads === driftAt)
                return { ...response, body: [{ ...failedStatus, id: failedStatus.id + 1 }] };
              return response;
            },
          },
          exclusion,
          true,
        ),
      /retained pre-native failed Pages admission changed/u,
    );
  }

  const recovering = fixture();
  const pendingCustody = inspectApplicationRunCustody({
    ...custody,
    opportunity: "f".repeat(64),
    runs: [{ ...custody.runs[0]!, id: "999" }],
  });
  recovering.releases.push({
    ...recovering.release,
    id: 51,
    published_at: "2026-11-04T11:59:30Z",
    body: notes(pendingCustody),
  });
  await assert.rejects(() => discoverPublishedApplicationCohort(recovering.transport));
  assert.equal(
    (
      await discoverPublishedApplicationCohort(recovering.transport, {
        release_id: 51,
        custody: pendingCustody,
      })
    ).release_id,
    50,
  );
  await assert.rejects(() =>
    discoverPublishedApplicationCohort(recovering.transport, { release_id: 50, custody }),
  );
  await assert.rejects(() =>
    discoverPublishedApplicationCohort(recovering.transport, { release_id: 51, custody }),
  );
  recovering.releases.push({
    ...recovering.release,
    id: 52,
    published_at: "2026-11-04T11:59:45Z",
    body: notes({
      ...pendingCustody,
      opportunity: "e".repeat(64),
      runs: [{ ...custody.runs[0]!, id: "998" }],
    }),
  });
  await assert.rejects(() =>
    discoverPublishedApplicationCohort(recovering.transport, {
      release_id: 51,
      custody: pendingCustody,
    }),
  );
});

function fixture(archiveOverride?: (tar: Buffer) => Buffer) {
  const tar = serializeSiteTar(
    new Map([
      [".nojekyll", Buffer.alloc(0)],
      ["application/metadata/timestamp.json", Buffer.from("inert fixture")],
    ]),
  );
  const zip = archiveOverride?.(tar) ?? createAuditZip([["artifact.tar", tar]]);
  const expected = {
    artifact_id: 10,
    control_commit: "a".repeat(40),
    run_id: "123",
    producer_attempt: 1,
    tar: { bytes: tar.length, sha256: sha256(tar) },
  };
  const metadata = {
    id: 10,
    name: "application-pages-123-1",
    expired: false,
    size_in_bytes: zip.length,
    digest: `sha256:${sha256(zip)}`,
    workflow_run: {
      id: 123,
      head_sha: expected.control_commit,
      repository_id: 1354613114,
      head_repository_id: 1354613114,
    },
  };
  let calls = 0,
    reads = 0;
  const transport = {
    async readMetadata(id: number) {
      calls++;
      assert.equal(id, 10);
      return structuredClone(metadata);
    },
    async readArchive(id: number, maximum: number) {
      reads++;
      assert.equal(id, 10);
      assert.equal(maximum, zip.length);
      return zip;
    },
  };
  return {
    expected,
    metadata,
    zip,
    transport,
    run: () => verifyBootstrapPagesArtifact(expected, transport),
    counts: () => ({ calls, reads }),
  };
}

void test("Pages artifact verification brackets exact opaque TAR bytes with fixed provider metadata", async () => {
  const f = fixture();
  const receipt = await f.run();
  assert.equal(receipt.tar.sha256, f.expected.tar.sha256);
  assert.equal(receipt.artifact.id, 10);
  assert.equal(receipt.authority, "none");
  assert.deepEqual(f.counts(), { calls: 2, reads: 1 });
});

void test("actual Pages verifier brackets signed ZIP delivery under the fixed scoped reader", async (t) => {
  const f = fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "fixed-application-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixed-original-pages-reader";
  t.after(() => {
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  });
  const artifact = "/repos/boburning/portcove/actions/artifacts/10";
  const routes: string[] = [];
  let metadataReads = 0;
  let fault = "";
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      routes.push(url.pathname);
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      if (url.origin === "https://productionresultssa1.blob.core.windows.net") {
        assert.equal(request.credentials, "omit");
        assert.equal(request.headers.has("authorization"), false);
        if (fault === "stalled")
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          );
        return new Response(f.zip);
      }
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.search, "");
      assert.equal(request.headers.get("authorization"), "token fixed-original-pages-reader");
      if (url.pathname === `${artifact}/zip`) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://productionresultssa1.blob.core.windows.net/actions-results/pages?sig=inert",
          },
        });
      }
      assert.equal(url.pathname, artifact);
      metadataReads++;
      process.env.GH_TOKEN = "unrelated-after-metadata";
      return Response.json(
        fault === "drift" && metadataReads === 2
          ? { ...f.metadata, digest: `sha256:${"f".repeat(64)}` }
          : f.metadata,
        { status: fault === "non-200" ? 201 : 200 },
      );
    },
  );
  await withReadOnlyReleaseChildren(root, async () => {
    process.env.GH_TOKEN = "unrelated-before-metadata";
    const read = () => verifyApplicationPagesArtifact(f.expected, root);
    assert.deepEqual(await read(), await f.run());
    assert.deepEqual(routes, [artifact, `${artifact}/zip`, "/actions-results/pages", artifact]);
    for (const [scenario, reason, dispatches] of [
      ["non-200", /read unavailable/u, 1],
      ["drift", /changed during byte verification/u, 4],
    ] as const) {
      fault = scenario;
      routes.length = metadataReads = 0;
      await assert.rejects(read(), reason);
      assert.equal(routes.length, dispatches);
    }
    fault = "stalled";
    routes.length = 0;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(withCoordinatorDeadline(performance.now() + 150, read), {
        code: "deadline_exceeded",
      });
      assert.equal(cancelled, true);
      assert.deepEqual(routes, [artifact, `${artifact}/zip`, "/actions-results/pages"]);
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(
      (await readdir(root)).every((name) => !name.startsWith("application-pages-archive-")),
    );
  });
});

void test("wrong producer source/run/name/attempt and expired or oversized Pages archives refuse before download", async () => {
  for (const change of [
    { id: 11 },
    { name: "application-pages-123-2" },
    { expired: true },
    { size_in_bytes: 512 * 1024 ** 2 + 1 },
    {
      workflow_run: {
        id: 123,
        head_sha: "f".repeat(40),
        repository_id: 1354613114,
        head_repository_id: 1354613114,
      },
    },
    {
      workflow_run: {
        id: 124,
        head_sha: "a".repeat(40),
        repository_id: 1354613114,
        head_repository_id: 1354613114,
      },
    },
    {
      workflow_run: {
        id: 123,
        head_sha: "a".repeat(40),
        repository_id: 1354613114,
        head_repository_id: 999,
      },
    },
  ]) {
    const f = fixture();
    Object.assign(f.metadata, change);
    await assert.rejects(f.run());
    assert.equal(f.counts().reads, 0);
  }
});

void test("provider ZIP digest, inner CRC, exact one-file inventory and fixed local TAR identity all remain mandatory", async () => {
  const outer = fixture();
  outer.metadata.digest = `sha256:${"f".repeat(64)}`;
  await assert.rejects(outer.run());
  for (const archive of [
    (tar: Buffer) => createAuditZip([["other.tar", tar]]),
    (tar: Buffer) =>
      createAuditZip([
        ["artifact.tar", tar],
        ["extra", Buffer.from("inert")],
      ]),
    (tar: Buffer) => createAuditZip([["artifact.tar", Buffer.alloc(tar.length)]]),
    (tar: Buffer) => {
      const zip = createAuditZip([["artifact.tar", tar, { method: 0 }]]);
      zip[42] = zip[42]! ^ 1;
      return zip;
    },
  ])
    await assert.rejects(fixture(archive).run());
});

void test("provider metadata drift during archive readback is not a successful upload receipt", async () => {
  const f = fixture();
  const read = f.transport.readArchive;
  f.transport.readArchive = async (id, maximum) => {
    const zip = await read(id, maximum);
    f.metadata.digest = `sha256:${"f".repeat(64)}`;
    return zip;
  };
  await assert.rejects(f.run(), /changed during byte verification/u);
  assert.deepEqual(f.counts(), { calls: 2, reads: 1 });
});

void test("locked application Release notes inventory retains exact records and rejects unscoped pages", async () => {
  const release = {
    id: 50,
    tag_name: "v0.1.0-alpha.3",
    draft: false,
    immutable: true,
    prerelease: true,
    target_commitish: "a".repeat(40),
    body: "exact retained notes",
  };
  const next = { ...release, id: 51, tag_name: "v0.1.0-alpha.4" };
  for (const fault of ["", "foreign", "skip", "duplicate", "malformed", "short-pages"]) {
    const routes: string[] = [];
    const read = () =>
      readReleaseNotesWithSdk({
        token: "inert-app-release-notes",
        deadline: performance.now() + 5000,
        guard() {},
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, "https://api.github.com");
          assert.equal(request.headers.get("authorization"), "token inert-app-release-notes");
          assert.equal(request.method, "GET");
          routes.push(url.pathname + url.search);
          if (url.pathname === "/repos/boburning/portcove")
            return Response.json({
              id: 1354613114,
              full_name: "boburning/portcove",
              node_id: "fixture",
            });
          if (fault === "short-pages") {
            const page = Number(url.searchParams.get("page") ?? "1");
            assert.equal(url.searchParams.get("per_page"), "100");
            return Response.json([{ ...release, id: release.id + page - 1 }], {
              headers:
                page === 17
                  ? {}
                  : {
                      link: `<https://api.github.com/repositories/1354613114/releases?per_page=100&page=${page + 1}>; rel="next"`,
                    },
            });
          }
          if (url.pathname === "/repos/boburning/portcove/releases") {
            const path =
              fault === "foreign"
                ? "/repositories/1/releases"
                : "/repositories/1354613114/releases";
            const page = fault === "skip" ? 3 : 2;
            return Response.json([release], {
              headers: {
                link:
                  fault === "malformed"
                    ? 'rel="next"'
                    : `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next"`,
              },
            });
          }
          assert.equal(url.pathname, "/repositories/1354613114/releases");
          assert.equal(url.search, "?per_page=100&page=2");
          return Response.json([fault === "duplicate" ? release : next]);
        },
      });
    if (fault === "short-pages") {
      assert.equal((await read()).length, 17);
      assert.equal(routes.length, 18);
    } else {
      if (fault) await assert.rejects(read());
      else assert.deepEqual(await read(), [release, next]);
      assert.equal(routes.length, fault && fault !== "duplicate" ? 2 : 3);
    }
  }
});
