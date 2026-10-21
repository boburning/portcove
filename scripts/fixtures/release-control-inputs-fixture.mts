import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CoordinatorRemoteApi } from "../release-coordinator-remote.mts";
import { prepareSemanticReviewHandoff } from "../release-semantic-review.mts";
import { isRecord } from "../runtime-values.mts";
export const source = "a".repeat(40),
  tree = "b".repeat(40),
  before = "c".repeat(40),
  after = "d".repeat(40);
export const opportunity = {
  source_commit: source,
  source_tree: tree,
  base_commit: "e".repeat(40),
  change_set_sha256: "f".repeat(64),
  complete_change_set: true,
  meaningful: true,
  documentation_only: false,
  urgency: false,
  requested_channel: "preview",
  classification: {
    source_commit: source,
    reviewed_commit: source,
    source_tree: tree,
    reviewed_tree: tree,
    change_set_sha256: "f".repeat(64),
    change_set_scope: "portcove-release-net-tree-delta-v1",
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  },
};
export const config = {
  schema_version: 1,
  review_app_id: 101,
  writer_app_id: 202,
  review_check_name: "Independent semantic review",
};
export function releaseControlInputsFixture(
  capacityDocument?: unknown,
  rawOpportunity = opportunity,
  rawConfig = config,
  publicationPaused = true,
  repositoryNodeId = "fixture-repo",
) {
  const opportunity = structuredClone(rawOpportunity);
  const config = structuredClone(rawConfig);
  const source = opportunity.source_commit;
  let content: string | null = null,
    mutations = 0;
  const objects = new Map<string, unknown>();
  const git = (kind: string, bytes: Buffer) =>
    createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
  const blob = (text: string) => {
    const bytes = Buffer.from(text),
      sha = git("blob", bytes);
    objects.set(`blobs/${sha}`, {
      sha,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    });
    return sha;
  };
  const makeTree = (entries: { path: string; mode: string; type: string; sha: string }[]) => {
    entries.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.path + (a.type === "tree" ? "/" : "")),
        Buffer.from(b.path + (b.type === "tree" ? "/" : "")),
      ),
    );
    const sha = git(
      "tree",
      Buffer.concat(
        entries.map((entry) =>
          Buffer.concat([
            Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`),
            Buffer.from(entry.sha, "hex"),
          ]),
        ),
      ),
    );
    objects.set(`trees/${sha}`, { sha, truncated: false, tree: entries });
    return sha;
  };
  const makeCommit = () => {
    const entries = [
      {
        path: "publication.json",
        mode: "100644",
        type: "blob",
        sha: blob(JSON.stringify({ schema_version: 1, publication_paused: publicationPaused })),
      },
    ];
    if (capacityDocument !== undefined)
      entries.push({
        path: "capacity.json",
        mode: "100644",
        type: "blob",
        sha: blob(JSON.stringify(capacityDocument)),
      });
    if (content !== null) {
      const file = makeTree([
        {
          path: `${opportunity.change_set_sha256}.json`,
          mode: "100644",
          type: "blob",
          sha: blob(content),
        },
      ]);
      const directory = makeTree([{ path: source, mode: "040000", type: "tree", sha: file }]);
      entries.push({ path: "classification", mode: "040000", type: "tree", sha: directory });
    }
    const tree = makeTree(entries),
      message = "fixture\n";
    const sha = git(
      "commit",
      Buffer.from(
        `tree ${tree}\nauthor Fixture <fixture@example.invalid> 946684800 +0000\ncommitter Fixture <fixture@example.invalid> 946684800 +0000\n\n${message}`,
      ),
    );
    objects.set(`commits/${sha}`, {
      sha,
      tree: { sha: tree },
      parents: [],
      message,
      author: { name: "Fixture", email: "fixture@example.invalid", date: "2000-01-01T00:00:00Z" },
      committer: {
        name: "Fixture",
        email: "fixture@example.invalid",
        date: "2000-01-01T00:00:00Z",
      },
    });
    return sha;
  };
  let head = makeCommit();
  const initial = head;
  const faults = { value: "" };
  const requests: string[] = [];
  let refReads = 0;
  const api: CoordinatorRemoteApi = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      requests.push(endpoint);
      let body: unknown;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove", node_id: repositoryNodeId };
      else if (endpoint.includes("/git/ref/heads/"))
        body = {
          ref: `refs/heads/${endpoint.split("/").at(-1)}`,
          object: {
            type: "commit",
            sha:
              faults.value === "pause-drift" &&
              requests.filter((route) => route.includes("/git/ref/heads/")).length > 1
                ? after
                : head,
          },
        };
      else if (endpoint.endsWith("/check-runs/303"))
        body = {
          id: 303,
          app: { id: faults.value === "issuer" ? 202 : 101 },
          name: config.review_check_name,
          head_sha: source,
          status: "completed",
          conclusion: faults.value === "failure" ? "failure" : "success",
          completed_at: "2026-01-01T00:00:00Z",
          output: {
            title: "Portcove independent release review v1",
            annotations_count: faults.value === "annotations" ? 1 : 0,
            summary: (() => {
              const reviewed =
                faults.value === "input" ? { ...opportunity, urgency: true } : opportunity;
              const prepared = prepareSemanticReviewHandoff(reviewed, {
                scope: "complete-release-opportunity",
                runtime: "codex-independent-local-review",
                session_ref: "fixture:independent-task",
                completed_at: "2026-01-01T00:00:00Z",
                coverage: { accumulated_changes: true, classification: true, compatibility: true },
                accepted_opportunity: reviewed,
                report:
                  faults.value === "report-change"
                    ? "Changed fixture semantic report"
                    : "Fixture independent semantic review; no live authority.",
              });
              const wire: unknown = JSON.parse(prepared.proposed_request.body.output.summary);
              assert.ok(isRecord(wire) && isRecord(wire.review));
              if (faults.value === "report-bytes") wire.review.report = "Tampered transcript";
              if (faults.value === "pr-scope") wire.review.scope = "implementation-pr";
              if (faults.value === "legacy-report") {
                delete wire.review;
                wire.schema_version = 1;
              }
              return JSON.stringify(wire);
            })(),
          },
        };
      else if (endpoint.includes("/git/")) {
        body = objects.get(endpoint.split("/git/")[1]!);
        if (!body) throw new Error("unknown Git fixture object");
      } else throw new Error("unexpected route");
      return { status: 200, headers: new Map(), body };
    },
    graphql(query, variables) {
      if (query.startsWith("query")) {
        refReads++;
        return {
          data: {
            node: {
              __typename: "Repository",
              id: repositoryNodeId,
              databaseId: 1354613114,
              nameWithOwner: "boburning/portcove",
              ref: {
                id: `opaque-${String(variables.ref)}`,
                name: String(variables.ref).slice(11),
                prefix: "refs/heads/",
                target: {
                  __typename: "Commit",
                  oid: faults.value === "pause-drift" && refReads > 1 ? after : head,
                },
              },
            },
          },
        };
      }
      mutations++;
      const input = variables.input as {
        expectedHeadOid: string;
        branch: { id: string };
        fileChanges: { additions: { contents: string; path: string }[] };
      };
      assert.equal(input.expectedHeadOid, initial);
      assert.equal(input.branch.id, "opaque-refs/heads/portcove-release-inputs");
      assert.equal(input.fileChanges.additions.length, 1);
      if (faults.value === "cas") throw new Error("preimage race");
      content = Buffer.from(input.fileChanges.additions[0]!.contents, "base64").toString();
      head = makeCommit();
      if (faults.value === "ambiguous") throw new Error("lost response");
      return { data: { createCommitOnBranch: { commit: { oid: head } } } };
    },
  };
  return {
    api,
    faults,
    requests,
    mutations: () => mutations,
    head: () => head,
    owns: (endpoint: string) =>
      endpoint.endsWith("/check-runs/303") ||
      (endpoint.includes("/git/") && objects.has(endpoint.split("/git/")[1]!)),
    conflicting: () => {
      content = "{}";
      head = makeCommit();
    },
    legacy: () => {
      assert.ok(content);
      const record: unknown = JSON.parse(content);
      assert.ok(isRecord(record));
      record.schema_version = 1;
      delete record.review_sha256;
      content = JSON.stringify(record);
      head = makeCommit();
    },
  };
}
