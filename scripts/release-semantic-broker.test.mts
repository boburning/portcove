import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { collectReleaseSourceChanges } from "./release-source-changes.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import {
  prepareFrozenSemanticInputs,
  requireFrozenSemanticInputs,
  readSemanticPublicationBaseline,
} from "./release-semantic-inputs.mts";
import {
  inspectSemanticRuntimeEvents,
  requireDirectSemanticCapture,
} from "./release-semantic-runtime.mts";
import { prepareSemanticReviewHandoff } from "./release-semantic-review.mts";
import { readbackSemanticCheck, publishSemanticCapture } from "./release-semantic-broker.mts";
import { capacityDigest } from "./release-capacity.mts";

function fixture() {
  const f = releaseSourceFixture();
  const opportunity = {
    ...f.opportunity,
    change_set_sha256: f.expectedHash,
    complete_change_set: true,
    meaningful: true,
    documentation_only: false,
    urgency: false,
    requested_channel: "preview",
    classification: {
      source_commit: f.original.sha,
      reviewed_commit: f.original.sha,
      source_tree: f.sourceTree,
      reviewed_tree: f.sourceTree,
      change_set_sha256: f.expectedHash,
      change_set_scope: "portcove-release-net-tree-delta-v1",
      base_version: "0.1.0-alpha.2",
      change: "prerelease",
      compatibility: "compatible",
    },
  };
  const response = (body: unknown) => ({ status: 200, body, headers: new Map<string, string>() });
  const release = {
    id: 1,
    draft: false,
    tag_name: "v0.1.0-alpha.2",
    published_at: "2026-01-01T00:00:00Z",
  };
  const api = {
    request(method: string, route: string) {
      assert.equal(method, "GET");
      if (route === "repos/boburning/portcove")
        return response({ id: 1354613114, full_name: "boburning/portcove" });
      if (route.includes("/releases?")) return response([release]);
      if (route.endsWith("/releases/1")) return response(release);
      if (route.includes("/git/ref/tags/"))
        return response({
          ref: "refs/tags/v0.1.0-alpha.2",
          object: { type: "commit", sha: f.base.sha },
        });
      return f.api.request(method, route);
    },
  };
  return { f, opportunity, api };
}

void test("exact Git bytes recover normalized unsigned offsets without trusting omitted provider headers", () => {
  const raw = Buffer.from(
    `tree ${"a".repeat(40)}\nauthor Example <fixture@example.invalid> 1704067200 -0400\ncommitter Example <fixture@example.invalid> 1704067200 -0400\n\nUnsigned offset fixture\n`,
  );
  const id = createHash("sha1").update(`commit ${raw.length}\0`).update(raw).digest("hex");
  const actor = { name: "Example", email: "fixture@example.invalid", date: "2024-01-01T00:00:00Z" };
  const record = {
    sha: id,
    tree: { sha: "a".repeat(40) },
    parents: [],
    author: actor,
    committer: actor,
    message: "Unsigned offset fixture",
    verification: { verified: false, reason: "unsigned", payload: null, signature: null },
  };
  assert.throws(() => inspectRemoteCommitObject(record, id), /differ/);
  assert.deepEqual(inspectRemoteCommitObject(record, id, raw).object.bytes, raw);
  for (const changed of [
    { ...record, tree: { sha: "b".repeat(40) } },
    { ...record, author: { ...actor, date: "2024-01-01T00:00:01Z" } },
    { ...record, message: "changed" },
  ])
    assert.throws(() => inspectRemoteCommitObject(changed, id, raw), /disagree/);
  assert.throws(
    () =>
      inspectRemoteCommitObject(record, id, Buffer.from(raw.toString().replace("-0400", "+0000"))),
    /differ/,
  );
  const extra = Buffer.from(raw.toString().replace("\n\n", "\nencoding invented\n\n"));
  const extraId = createHash("sha1").update(`commit ${extra.length}\0`).update(extra).digest("hex");
  assert.throws(
    () => inspectRemoteCommitObject({ ...record, sha: extraId }, extraId, extra),
    /supported headers/,
  );
});

void test("provider numeric repository comparison links retain the exact appointed repository boundary", () => {
  for (const repositoryId of [1354613114, 1354613115]) {
    const f = releaseSourceFixture(101),
      routes: string[] = [];
    const api = {
      request(method: string, route: string) {
        routes.push(route);
        const mapped = route.replace("/repositories/1354613114/", "/repos/boburning/portcove/");
        const result = f.api.request(method, mapped);
        const link = result.headers.get("link");
        return link
          ? {
              ...result,
              headers: new Map([
                [
                  "link",
                  link.replace("/repos/boburning/portcove/", `/repositories/${repositoryId}/`),
                ],
              ]),
            }
          : result;
      },
    };
    if (repositoryId === 1354613114) {
      assert.equal(collectReleaseSourceChanges(api, f.opportunity).commits.length, 101);
      assert.ok(routes.some((route) => route.includes("/repositories/1354613114/")));
    } else assert.throws(() => collectReleaseSourceChanges(api, f.opportunity), /escaped/);
  }
});

void test("frozen source collection binds actual Git blobs, publication and complete provider delta; caller mutation cannot change expected inputs", async (t) => {
  const { f, opportunity, api } = fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-semantic-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
  const git = (args: string[], input?: Buffer | string) =>
    execFileSync("git", ["-C", root, ...args], { input, windowsHide: true })
      .toString()
      .trim();
  for (const text of ["readme\n", "base\n", "source\n"])
    git(["hash-object", "-w", "--stdin"], text);
  for (const blob of [f.oldBlob, f.newBlob]) {
    const readme = git(["hash-object", "--stdin"], "readme\n");
    git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${blob}\tapp.rs\n`);
  }
  for (const commit of [f.base, f.original])
    git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      inspectRemoteCommitObject(commit, commit.sha).object.bytes,
    );
  // A hostile local replace ref must not replace the provider-bound source tree.
  git(["replace", f.original.sha, f.base.sha]);
  const bundle = prepareFrozenSemanticInputs(api, root, opportunity, {
    classification: "fixture",
    compatibility: "fixture only",
  });
  const frozen = requireFrozenSemanticInputs(bundle);
  assert.equal(frozen.manifest.source.source_tree, f.sourceTree);
  assert.equal(frozen.files.length, 3);
  assert.throws(() => requireFrozenSemanticInputs(structuredClone(bundle)), /imported or changed/);
  const first = bundle.files[0]!;
  first.bytes.fill(120);
  first.sha256 = createHash("sha256").update(first.bytes).digest("hex");
  assert.throws(() => requireFrozenSemanticInputs(bundle), /differs/);
  assert.notDeepEqual(frozen.files[0]!.bytes, first.bytes);
});

void test("publication pagination cannot leave the fixed repository release inventory", () => {
  const api = fixture().api;
  const reader = {
    request(method: string, route: string) {
      const result = api.request(method, route);
      if (route.includes("/releases?"))
        return {
          ...result,
          body: Array.from({ length: 100 }, (_, id) => ({
            id,
            draft: false,
            tag_name: `v${id}`,
            published_at: "2026-01-01T00:00:00Z",
          })),
          headers: new Map([
            [
              "link",
              '<https://api.github.com/repos/elsewhere/other/releases?per_page=100&page=2>; rel="next"',
            ],
          ]),
        };
      return result;
    },
  };
  assert.throws(
    () => readSemanticPublicationBaseline(reader, "unused", "0.1.0-alpha.2"),
    /escaped/,
  );
});

void test("only explicit complete-opportunity acceptance passes event integrity; imported captures never acquire producer provenance", async () => {
  const opportunity = fixture().opportunity;
  const bundle = {
    manifest: { opportunity_sha256: capacityDigest(opportunity) },
    bundle_sha256: "a".repeat(64),
  };
  const result = {
    schema_version: 1,
    outcome: "accepted",
    opportunity_sha256: bundle.manifest.opportunity_sha256,
    bundle_sha256: bundle.bundle_sha256,
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Synthetic full-scope report",
  };
  const events = (value: unknown, extra: unknown[] = []) =>
    Buffer.from(
      [
        { type: "thread.started", thread_id: "01234567-0123-0123-0123-0123456789ab" },
        { type: "turn.started" },
        ...extra,
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } },
        { type: "turn.completed" },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
  assert.equal(inspectSemanticRuntimeEvents(events(result), bundle).report, result.report);
  for (const changed of [
    { ...result, outcome: "refused" },
    { ...result, bundle_sha256: "b".repeat(64) },
    { ...result, coverage: { ...result.coverage, compatibility: false } },
  ])
    assert.throws(() => inspectSemanticRuntimeEvents(events(changed), bundle));
  assert.throws(
    () =>
      inspectSemanticRuntimeEvents(
        events(result, [
          { type: "item.completed", item: { type: "command_execution", command: "candidate.exe" } },
        ]),
        bundle,
      ),
    /unauthorized/,
  );
  assert.throws(() =>
    inspectSemanticRuntimeEvents(Buffer.from('{"type":"thread.started"}'), bundle),
  );
  const imported = {} as Parameters<typeof requireDirectSemanticCapture>[0];
  assert.throws(() => requireDirectSemanticCapture(imported), /imported/);
  let credentials = 0;
  await assert.rejects(
    publishSemanticCapture(
      imported,
      { app_id: 101, installation_id: 303, writer_app_id: 202 },
      {
        requireProvisioningGrant: async () => {},
        authenticateIssuer: async () => {
          credentials++;
          throw new Error("must not release");
        },
      },
    ),
    /imported/,
  );
  assert.equal(credentials, 0);
});

void test("GET-only ambiguous recovery binds detailed issuer/report and refuses changed input, wrong issuer, duplicate or absent effects", () => {
  const opportunity = fixture().opportunity;
  const handoff = prepareSemanticReviewHandoff(opportunity, {
    accepted_opportunity: opportunity,
    completed_at: "2026-01-01T00:00:00Z",
    coverage: { accumulated_changes: true, classification: true, compatibility: true },
    report: "Synthetic accepted complete opportunity",
    runtime: "codex-independent-local-review",
    scope: "complete-release-opportunity",
    session_ref: "fixture-only",
  });
  const body = handoff.proposed_request.body;
  const check = {
    ...body,
    id: 7,
    app: { id: 101 },
    output: { ...body.output, annotations_count: 0 },
  };
  const expected = {
    head: body.head_sha,
    external_id: body.external_id,
    summary: body.output.summary,
  };
  let fault = "";
  const api = {
    request(method: string, route: string) {
      assert.equal(method, "GET");
      let value: unknown = check;
      if (route === "repos/boburning/portcove")
        value = { id: 1354613114, full_name: "boburning/portcove", node_id: "fixture-repository" };
      else if (route.includes("/commits/"))
        value = {
          total_count: fault === "missing" ? 0 : fault === "duplicate" ? 2 : 1,
          check_runs:
            fault === "missing"
              ? []
              : fault === "duplicate"
                ? [check, { ...check, id: 8 }]
                : [check],
        };
      else if (fault === "issuer") value = { ...check, app: { id: 202 } };
      else if (fault === "drift") {
        const report: unknown = JSON.parse(body.output.summary);
        assert.ok(typeof report === "object" && report !== null);
        const changed = structuredClone(handoff.evidence);
        const other = prepareSemanticReviewHandoff(opportunity, {
          accepted_opportunity: opportunity,
          completed_at: changed.completed_at,
          coverage: changed.coverage,
          report: "Another valid same-App report",
          runtime: changed.runtime,
          scope: changed.scope,
          session_ref: changed.session_ref,
        });
        value = {
          ...check,
          output: { ...check.output, summary: other.proposed_request.body.output.summary },
        };
      }
      return { status: 200, headers: new Map<string, string>(), body: value };
    },
    graphql() {
      throw new Error("no mutation");
    },
  };
  const config = { app_id: 101, installation_id: 303, writer_app_id: 202 };
  assert.equal(readbackSemanticCheck(api, config, opportunity, expected).check_id, 7);
  for (fault of ["missing", "duplicate", "issuer", "drift"])
    assert.throws(() => readbackSemanticCheck(api, config, opportunity, expected));
  fault = "";
  assert.throws(
    () => readbackSemanticCheck(api, config, { ...opportunity, urgency: true }, expected),
    /exact opportunity/,
  );
});
