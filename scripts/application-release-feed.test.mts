import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyBootstrapPagesArtifact,
  discoverPublishedApplicationCohort,
} from "./application-release-feed.mts";
import { serializeSiteTar } from "./release-site-deployment.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { sha256 } from "./application-release-io.mts";
import { inspectApplicationRunCustody } from "./application-release-run.mts";

void test("prior discovery joins actual feed to one immutable native cohort and holds newer pending publication", () => {
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
        path: ".github/workflows/release.yml",
        event: "workflow_dispatch",
        repository: repo,
        head_repository: repo,
        head_branch: ref,
      },
      "releases?per_page=100": releases,
      [`git/ref/tags/${tag}`]: { ref: `refs/tags/${tag}`, object: tagObject },
    };
    const api = {
      request(method: string, endpoint: string) {
        assert.equal(method, "GET");
        const suffix = endpoint.replace(/^repos\/boburning\/portcove\/?/u, "");
        assert.ok(Object.hasOwn(responses, suffix), suffix);
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: structuredClone(responses[suffix]),
        };
      },
      graphql() {
        throw new Error("unexpected GraphQL request");
      },
    };
    return { release, releases, tagObject, api };
  };
  const positive = discoverPublishedApplicationCohort(fixture().api);
  assert.equal(positive.release_id, 50);
  assert.deepEqual(positive.custody, custody);
  assert.equal(positive.authority, "none");
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
    assert.throws(() => discoverPublishedApplicationCohort(negative.api));
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
  assert.throws(() => discoverPublishedApplicationCohort(recovering.api));
  assert.equal(
    discoverPublishedApplicationCohort(recovering.api, { release_id: 51, custody: pendingCustody })
      .release_id,
    50,
  );
  assert.throws(() =>
    discoverPublishedApplicationCohort(recovering.api, { release_id: 50, custody }),
  );
  assert.throws(() =>
    discoverPublishedApplicationCohort(recovering.api, { release_id: 51, custody }),
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
  assert.throws(() =>
    discoverPublishedApplicationCohort(recovering.api, { release_id: 51, custody: pendingCustody }),
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
    api: {
      request(method: string, endpoint: string) {
        calls++;
        assert.equal(method, "GET");
        assert.equal(endpoint, "repos/boburning/portcove/actions/artifacts/10");
        return { status: 200, headers: new Map<string, string>(), body: structuredClone(metadata) };
      },
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
