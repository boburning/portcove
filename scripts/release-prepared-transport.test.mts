import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareReleaseVersion,
  exportPreparedReleaseVersion,
} from "../apps/desktop/scripts/prepare-release-version.mts";
import { checkpointReleaseOpportunity, coordinatorStateRef } from "./release-coordinator-state.mts";
import { publishPreparedCoordinatorCheckpoint } from "./release-prepared-transport.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";

async function fixture(t: test.TestContext, date = "2026-09-14T12:00:00-04:00") {
  const root = await mkdtemp(path.join(os.tmpdir(), "prepared-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    local = path.join(root, "local.git"),
    remote = path.join(root, "remote.git");
  await mkdir(source);
  const git = (
    repo: string,
    args: string[],
    input?: string | Buffer,
    env: NodeJS.ProcessEnv = {},
  ) =>
    execFileSync("git", ["-C", repo, "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      input,
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...env },
    }).trimEnd();
  git(source, ["init", "-q"]);
  git(source, ["config", "user.name", "Fixture"]);
  git(source, ["config", "user.email", "fixture@example.invalid"]);
  for (const [file, contents] of Object.entries({
    "Cargo.toml":
      '[workspace]\nmembers = ["crates/example"]\n[workspace.package]\nversion = "0.1.0-alpha.2"\n',
    "crates/example/Cargo.toml": '[package]\nname = "example"\nversion.workspace = true\n',
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0-alpha.2"\n',
    "apps/desktop/package.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "unrelated.txt": "untouched\n",
  })) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), contents);
  }
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "source"]);
  const commit = git(source, ["rev-parse", "HEAD"]),
    tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  const classification = {
    source_commit: commit,
    reviewed_commit: commit,
    source_tree: tree,
    reviewed_tree: tree,
    change_set_sha256: "a".repeat(64),
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  };
  const input = {
    schema_version: 1,
    now: "2026-09-14T16:00:00.000Z",
    controller: {
      workflow: ".github/workflows/release-coordinator.yml",
      revision: "3".repeat(40),
      publication_paused: false,
      free_capacity_available: true,
    },
    opportunity: {
      source_commit: commit,
      source_tree: tree,
      base_commit: commit,
      change_set_sha256: "a".repeat(64),
      complete_change_set: true,
      meaningful: true,
      documentation_only: false,
      urgency: false,
      requested_channel: "preview",
      classification,
    },
    publication: {
      complete: true,
      observed_at: "2026-09-14T15:59:00.000Z",
      published_versions: ["0.1.0-alpha.2"],
      published_sources: [],
      reserved_versions: [] as string[],
      last_routine_preview_at: null,
    },
    active_candidate: null as Record<string, unknown> | null,
  };
  const initial = await checkpointReleaseOpportunity(source, null, input);
  git(root, ["clone", "--mirror", "--quiet", source, remote]);
  const prepared = await prepareReleaseVersion(
    source,
    classification,
    input.publication.published_versions,
  );
  input.publication.reserved_versions = [prepared.version];
  const candidate = {
    source_commit: commit,
    source_tree: tree,
    prepared_commit: prepared.prepared_commit,
    prepared_tree: prepared.prepared_tree,
    intent_sha256: prepared.intent_sha256,
    version: prepared.version,
    phase: "prepared",
    failure_kind: null,
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: null,
  };
  input.active_candidate = candidate;
  const saved = await checkpointReleaseOpportunity(source, initial.checkpoint, input);
  git(root, ["clone", "--mirror", "--quiet", source, local]);
  const config = { schema_version: 1, namespace: "portcove-test" },
    stateRef = "refs/heads/portcove-test-coordinator-state";
  const refs = new Map([[stateRef, initial.checkpoint]]);
  let posts = 0,
    mutations = 0;
  const faults = {
    post: "",
    lose: "",
    readback: false,
    wrongRepository: false,
    wrongObject: false,
  };
  const reply = (body: unknown, status = 200) => ({
    status,
    body,
    headers: new Map<string, string>(),
  });
  const api: CoordinatorRemoteApi = {
    request(method, endpoint, body) {
      if (endpoint === "repos/boburning/portcove")
        return reply({
          id: faults.wrongRepository ? 1 : 1354613114,
          full_name: "boburning/portcove",
          node_id: "R_fixture",
        });
      const match =
        /^repos\/boburning\/portcove\/git\/(blobs|trees|commits)(?:\/([a-f0-9]{40}))?$/u.exec(
          endpoint,
        );
      assert.ok(match);
      const kind = match[1]!,
        id = match[2];
      if (method === "GET") {
        if (faults.readback && posts > 0 && id !== commit)
          throw new Error("injected readback unavailable");
        let bytes: Buffer;
        try {
          bytes = execFileSync("git", ["-C", remote, "cat-file", kind.slice(0, -1), id!], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          return reply(null, 404);
        }
        if (kind === "blobs")
          return reply({ sha: id, encoding: "base64", content: bytes.toString("base64") });
        if (kind === "trees") return reply({ sha: id });
        const text = bytes.toString("utf8"),
          boundary = text.indexOf("\n\n"),
          lines = text.slice(0, boundary).split("\n");
        const actor = (role: string) => {
          const actorMatch = new RegExp(
            `^${role} (.+) <([^>]+)> ([0-9]+) ([+-][0-9]{4})$`,
            "u",
          ).exec(lines.find((line) => line.startsWith(role + " "))!);
          assert.ok(actorMatch);
          return {
            name: actorMatch[1],
            email: actorMatch[2],
            date: new Date(Number(actorMatch[3]) * 1000).toISOString().replace(".000Z", "Z"),
          };
        };
        return reply({
          sha: id,
          tree: { sha: lines[0]!.slice(5) },
          parents: lines
            .filter((line) => line.startsWith("parent "))
            .map((line) => ({ sha: line.slice(7) })),
          author: actor("author"),
          committer: actor("committer"),
          message: text.slice(boundary + 2).replace(/\n$/u, ""),
          verification: { signature: null, payload: null },
        });
      }
      assert.equal(method, "POST");
      assert.ok(isRecord(body));
      posts++;
      if (faults.post === kind) throw new Error("injected pre-write failure");
      let oid: string;
      if (kind === "blobs") {
        assert.equal(body.encoding, "base64");
        oid = git(
          remote,
          ["hash-object", "-w", "--stdin"],
          Buffer.from(String(body.content), "base64"),
        );
      } else if (kind === "trees") {
        const env = { GIT_INDEX_FILE: path.join(root, "provider-index") };
        assert.ok(body.base_tree === undefined || typeof body.base_tree === "string");
        git(
          remote,
          body.base_tree ? ["read-tree", String(body.base_tree)] : ["read-tree", "--empty"],
          undefined,
          env,
        );
        assert.ok(Array.isArray(body.tree));
        for (const entry of body.tree) {
          assert.ok(isRecord(entry));
          git(
            remote,
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${String(entry.mode)},${String(entry.sha)},${String(entry.path)}`,
            ],
            undefined,
            env,
          );
        }
        oid = git(remote, ["write-tree"], undefined, env);
      } else {
        assert.ok(isRecord(body.author) && isRecord(body.committer) && Array.isArray(body.parents));
        oid = git(
          remote,
          [
            "-c",
            "commit.gpgSign=false",
            "commit-tree",
            String(body.tree),
            ...body.parents.flatMap((parent) => ["-p", String(parent)]),
          ],
          String(body.message),
          {
            GIT_AUTHOR_NAME: String(body.author.name),
            GIT_AUTHOR_EMAIL: String(body.author.email),
            GIT_AUTHOR_DATE: String(body.author.date),
            GIT_COMMITTER_NAME: String(body.committer.name),
            GIT_COMMITTER_EMAIL: String(body.committer.email),
            GIT_COMMITTER_DATE: String(body.committer.date),
          },
        );
      }
      if (faults.lose === kind) {
        if (faults.readback) throw new Error("lost acknowledgement");
        faults.lose = "";
        throw new Error("lost acknowledgement");
      }
      return reply({ sha: faults.wrongObject ? "f".repeat(40) : oid }, 201);
    },
    graphql(query, variables) {
      if (query.startsWith("mutation")) {
        mutations++;
        assert.ok(isRecord(variables.input) && Array.isArray(variables.input.refUpdates));
        for (const ref of variables.input.refUpdates) {
          assert.ok(isRecord(ref));
          assert.equal(ref.force, false);
          assert.equal(ref.beforeOid, refs.get(String(ref.name)) ?? "0".repeat(40));
        }
        for (const ref of variables.input.refUpdates) {
          assert.ok(isRecord(ref));
          refs.set(String(ref.name), String(ref.afterOid));
        }
        return { data: { updateRefs: { clientMutationId: variables.input.clientMutationId } } };
      }
      const node: Record<string, unknown> = {
        __typename: "Repository",
        id: "R_fixture",
        databaseId: 1354613114,
        nameWithOwner: "boburning/portcove",
      };
      for (const [key, value] of Object.entries(variables))
        if (key.startsWith("r")) {
          const name = String(value),
            at = name.indexOf("/", 5) + 1;
          node[key] = refs.has(name)
            ? {
                prefix: name.slice(0, at),
                name: name.slice(at),
                target: { __typename: "Commit", oid: refs.get(name) },
              }
            : null;
        }
      return { data: { node } };
    },
  };
  return {
    root,
    local,
    remote,
    source,
    candidate,
    prepared,
    saved,
    initial,
    config,
    api,
    faults,
    refs,
    git,
    counts: () => ({ posts, mutations }),
    stateRef,
  };
}

void test(
  "real prepared objects and unchanged files reach the existing atomic checkpoint CAS; replay writes nothing",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const result = await publishPreparedCoordinatorCheckpoint(
      f.local,
      f.saved.checkpoint,
      f.config,
      { api: f.api },
    );
    assert.equal(result.objects.length, 6);
    assert.equal(f.counts().mutations, 1);
    assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
    assert.equal(
      f.git(f.remote, ["show", `${f.prepared.prepared_commit}:unrelated.txt`]),
      "untouched",
    );
    assert.equal(
      f.git(f.remote, ["rev-parse", `${f.prepared.prepared_commit}^{tree}`]),
      f.prepared.prepared_tree,
    );
    const before = f.counts();
    await publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, {
      api: f.api,
    });
    assert.deepEqual(f.counts(), before);
  },
);
for (const kind of ["blobs", "trees", "commits"])
  void test(
    `lost ${kind} acknowledgement uses exact readback without repeating the POST`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t);
      f.faults.lose = kind;
      const result = await publishPreparedCoordinatorCheckpoint(
        f.local,
        f.saved.checkpoint,
        f.config,
        { api: f.api },
      );
      assert.equal(result.objects.length, 6);
      assert.ok(result.objects.some((object) => object.mutation_error));
      assert.equal(f.counts().posts, 9);
    },
  );
void test(
  "unknown object outcome retains allocation and causes no later object/ref mutation",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.faults.post = "blobs";
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, { api: f.api }),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.equal(error.evidence.checkpoint, f.saved.checkpoint);
        assert.equal(error.evidence.retry, "forbidden");
        return true;
      },
    );
    assert.deepEqual(f.counts(), { posts: 1, mutations: 0 });
    assert.equal(f.git(f.local, ["rev-parse", coordinatorStateRef]), f.saved.checkpoint);
  },
);
void test(
  "wrong object/repository/configuration refuses before refs or fallback",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, null, { api: f.api }),
    );
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config),
      /unconfigured/,
    );
    assert.deepEqual(f.counts(), { posts: 0, mutations: 0 });
    f.faults.wrongRepository = true;
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, { api: f.api }),
    );
    assert.equal(f.counts().posts, 0);
    f.faults.wrongRepository = false;
    f.faults.wrongObject = true;
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, { api: f.api }),
    );
    assert.deepEqual(f.counts(), { posts: 1, mutations: 0 });
  },
);
void test(
  "lost object acknowledgement and unavailable readback stop after one POST with original evidence",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.faults.lose = "blobs";
    f.faults.readback = true;
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, { api: f.api }),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.ok(isRecord(error.evidence.cause));
        assert.ok(error.evidence.cause.mutation_error);
        assert.ok(error.evidence.cause.readback_error);
        return true;
      },
    );
    assert.deepEqual(f.counts(), { posts: 1, mutations: 0 });
    assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
  },
);
void test(
  "conflicting immutable remote receipt refuses journal publication after inert object custody",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const receipt = `refs/tags/portcove-test-prepared/v${f.prepared.version}`;
    f.refs.set(receipt, f.candidate.source_commit);
    await assert.rejects(
      publishPreparedCoordinatorCheckpoint(f.local, f.saved.checkpoint, f.config, { api: f.api }),
    );
    assert.deepEqual(f.counts(), { posts: 6, mutations: 0 });
    assert.equal(f.refs.get(receipt), f.candidate.source_commit);
    assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
    assert.equal(f.git(f.local, ["rev-parse", coordinatorStateRef]), f.saved.checkpoint);
  },
);
void test(
  "export refuses non-bare custody and arbitrary version-tree changes",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.throws(() => exportPreparedReleaseVersion(f.source, f.candidate), /bare/);
    const bytes = Buffer.from(
      f.git(f.local, ["cat-file", "commit", f.prepared.prepared_commit]) + "\n",
    );
    const changed = f.git(f.local, ["hash-object", "-w", "--stdin"], "extra\n");
    const env = { GIT_INDEX_FILE: path.join(f.root, "bad-index") };
    f.git(f.local, ["read-tree", f.prepared.prepared_tree], undefined, env);
    f.git(
      f.local,
      ["update-index", "--add", "--cacheinfo", `100644,${changed},unrelated.txt`],
      undefined,
      env,
    );
    const tree = f.git(f.local, ["write-tree"], undefined, env);
    const commit = f.git(
      f.local,
      ["hash-object", "-w", "-t", "commit", "--stdin"],
      bytes.toString("utf8").replace(f.prepared.prepared_tree, tree),
    );
    assert.throws(
      () =>
        exportPreparedReleaseVersion(f.local, {
          ...f.candidate,
          prepared_tree: tree,
          prepared_commit: commit,
        }),
      /exact version authorities/,
    );
  },
);
