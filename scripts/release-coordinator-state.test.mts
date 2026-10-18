import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";

const execute = promisify(execFile);
const moduleUrl = new URL("./release-coordinator-state.mts", import.meta.url).href;

async function recoveryFixture(t: test.TestContext, signed = false) {
  const local = await fixture(t, signed);
  const saved = await checkpointReleaseOpportunity(
    local.repository,
    local.initial.checkpoint,
    local.input,
  );
  const parent = await mkdtemp(path.join(os.tmpdir(), "portcove-recovery-parent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const refs = new Map([
    ["refs/heads/portcove-fixture-coordinator-state", saved.checkpoint],
    [
      `refs/tags/portcove-fixture-prepared/v${local.prepared.version}`,
      local.prepared.prepared_commit,
    ],
    [
      `refs/tags/portcove-fixture-prepared-source/${local.input.opportunity.source_commit}`,
      local.prepared.prepared_commit,
    ],
  ]);
  const faults = { value: "" };
  let reads = 0;
  let refReads = 0;
  const transport = {
    cwd: parent,
    spawn: (
      command: string,
      rawArgs: readonly string[],
      options: import("node:child_process").SpawnSyncOptionsWithStringEncoding,
    ) => {
      assert.deepEqual(rawArgs.slice(-2), ["--hostname", "github.com"]);
      const args = rawArgs.slice(0, -2);
      assert.equal(command, "gh");
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.equal(options.timeout, 15_000);
      if (faults.value === "overflow")
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("fixture collection overflow"), { code: "ENOBUFS" }),
        };
      reads++;
      const endpoint = args[2]!;
      let body: unknown;
      if (args[1] === "graphql") {
        assert.deepEqual(args, ["api", "graphql", "--include", "--input", "-"]);
        const input = JSON.parse(options.input as string) as {
          variables: { id: string; ref: string };
        };
        assert.equal(input.variables.id, "R_fixture");
        const ref = input.variables.ref;
        refReads++;
        const prefix = ref.startsWith("refs/heads/") ? "refs/heads/" : "refs/tags/";
        body = {
          data: {
            node: {
              __typename: "Repository",
              id: "R_fixture",
              databaseId: faults.value === "repository" && refReads > 1 ? 1 : 1354613114,
              nameWithOwner: "boburning/portcove",
              ref: {
                name: ref.slice(prefix.length),
                prefix,
                target: {
                  __typename: "Commit",
                  oid: faults.value === "changed" && refReads > 4 ? "9".repeat(40) : refs.get(ref),
                },
              },
            },
          },
        };
      } else if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove", node_id: "R_fixture" };
      else {
        assert.deepEqual(args.slice(-2), ["--method", "GET"]);
        assert.equal(options.input, undefined);
        const id = endpoint.split("/").at(-1)!;
        if (endpoint.includes("/git/commits/")) {
          const raw = execFileSync("git", ["-C", local.repository, "cat-file", "commit", id], {
            encoding: "utf8",
            windowsHide: true,
          });
          const boundary = raw.indexOf("\n\n");
          const header = raw.slice(0, boundary);
          const field = (name: string) =>
            header
              .split("\n")
              .find((line) => line.startsWith(`${name} `))!
              .slice(name.length + 1);
          const actor = (name: string) => {
            const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/u.exec(field(name))!;
            return {
              name: match[1],
              email: match[2],
              date: new Date(Number(match[3]) * 1000).toISOString().replace(".000Z", "Z"),
            };
          };
          const signatureStart = header.indexOf("\ngpgsig ");
          const signature =
            signatureStart < 0
              ? null
              : `${header.slice(signatureStart + 8).replaceAll("\n ", "\n")}\n`;
          const payload =
            signatureStart < 0 ? null : `${header.slice(0, signatureStart)}${raw.slice(boundary)}`;
          body = {
            sha: id,
            tree: { sha: field("tree") },
            parents: header
              .split("\n")
              .filter((line) => line.startsWith("parent "))
              .map((line) => ({ sha: line.slice(7) })),
            author: actor("author"),
            committer: actor("committer"),
            message: faults.value === "message" ? "substitution" : raw.slice(boundary + 2),
            verification: { signature, payload },
          };
        } else if (endpoint.includes("/git/trees/")) {
          const entry = local
            .git("ls-tree", id)
            .match(/^100644 blob ([a-f0-9]{40})\tstate.json$/u)!;
          body = {
            sha: id,
            truncated: faults.value === "truncated",
            tree: [{ path: "state.json", mode: "100644", type: "blob", sha: entry[1] }],
          };
        } else {
          assert.ok(endpoint.includes("/git/blobs/"));
          const bytes = execFileSync("git", ["-C", local.repository, "cat-file", "blob", id], {
            windowsHide: true,
          });
          body = {
            sha: id,
            encoding: "base64",
            size: faults.value === "size" ? 65537 : bytes.length,
            content: bytes.toString("base64"),
          };
        }
      }
      return {
        status: 0,
        stdout: `HTTP/2.0 200 Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
        stderr: "",
      };
    },
  };
  return { ...local, saved, parent, refs, faults, transport, reads: () => reads };
}

void test("bounded API recovery restores exact checkpoint and receipts without application files or history", async (t) => {
  for (const signed of [false, true]) {
    const f = await recoveryFixture(t, signed);
    const result = await recoverRemoteCoordinator(
      f.parent,
      { schema_version: 1, namespace: "portcove-fixture" },
      { transport: f.transport },
    );
    assert.equal(result.checkpoint, f.saved.checkpoint);
    assert.deepEqual(result.input, f.input);
    assert.equal(result.readiness, "recovery-only");
    assert.equal(result.complete_allocation_history, false);
    assert.equal(result.application_checkout_available, false);
    assert.equal(result.requests, 16);
    assert.equal(f.reads(), 16);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", result.repository, ...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    assert.equal(git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
    for (const ref of f.prepared.allocation_refs)
      assert.equal(git("rev-parse", ref), f.prepared.prepared_commit);
    assert.throws(() => git("cat-file", "-e", f.input.opportunity.source_tree));
    assert.throws(() => git("cat-file", "-e", `${f.input.opportunity.source_commit}:Cargo.toml`));
    const exported = await exportCoordinatorCheckpoint(result.repository, result.checkpoint);
    assert.equal(exported.required_commits.length, 2);
    assert.deepEqual(
      (await recoverReleaseOpportunity(result.repository, result.checkpoint)).input,
      f.input,
    );
  }
});

void test("sparse recovery uses raw parent headers when older checkpoint history is absent", async (t) => {
  const f = await recoveryFixture(t);
  const next = structuredClone(f.input);
  next.active_candidate!.phase = "qualifying";
  const saved = await checkpointReleaseOpportunity(f.repository, f.saved.checkpoint, next);
  f.refs.set("refs/heads/portcove-fixture-coordinator-state", saved.checkpoint);
  const result = await recoverRemoteCoordinator(
    f.parent,
    { schema_version: 1, namespace: "portcove-fixture" },
    { transport: f.transport },
  );
  assert.equal(result.previous, f.saved.checkpoint);
  assert.ok(isRecord(result.input.active_candidate));
  assert.equal(result.input.active_candidate.phase, "qualifying");
  assert.throws(() =>
    execFileSync("git", ["-C", result.repository, "cat-file", "-e", f.initial.checkpoint], {
      windowsHide: true,
      stdio: "pipe",
    }),
  );
  await writeFile(path.join(result.repository, "shallow"), `${f.prepared.prepared_commit}\n`);
  assert.equal(
    (await exportCoordinatorCheckpoint(result.repository, result.checkpoint)).required_commits[1]!
      .parent,
    f.input.opportunity.source_commit,
  );
});

void test("recovery refuses unavailable transport, changed snapshots and malformed objects before creating a repository", async (t) => {
  const f = await recoveryFixture(t);
  const config = { schema_version: 1, namespace: "portcove-fixture" };
  await assert.rejects(recoverRemoteCoordinator(f.parent, config), /unconfigured/u);
  assert.equal(f.reads(), 0);
  await assert.rejects(
    recoverRemoteCoordinator(
      f.parent,
      { ...config, namespace: "main" },
      { transport: f.transport },
    ),
    /configuration/u,
  );
  assert.equal(f.reads(), 0);
  for (const fault of ["message", "truncated", "size", "changed", "repository", "overflow"]) {
    f.faults.value = fault;
    await assert.rejects(recoverRemoteCoordinator(f.parent, config, { transport: f.transport }));
    assert.deepEqual(await readdir(f.parent), []);
  }
});

void test("shared journal refusal retains an identified partial repository with no installed refs", async (t) => {
  const f = await recoveryFixture(t);
  const run = (args: string[], input?: string) =>
    execFileSync("git", ["-C", f.repository, ...args], {
      input,
      encoding: "utf8",
      windowsHide: true,
    });
  const raw = run(["cat-file", "commit", f.saved.checkpoint]);
  const state = JSON.parse(run(["cat-file", "blob", `${f.saved.checkpoint}:state.json`])) as Record<
    string,
    unknown
  >;
  state.schema_version = 2;
  const blob = run(["hash-object", "-w", "--stdin"], JSON.stringify(state)).trim();
  const tree = run(["mktree"], `100644 blob ${blob}\tstate.json\n`).trim();
  const invalid = run(
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    raw.replace(/^tree [a-f0-9]{40}/u, `tree ${tree}`),
  ).trim();
  f.refs.set("refs/heads/portcove-fixture-coordinator-state", invalid);
  await assert.rejects(
    recoverRemoteCoordinator(
      f.parent,
      { schema_version: 1, namespace: "portcove-fixture" },
      { transport: f.transport },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      assert.equal(error.evidence.phase, "validate-and-import");
      assert.equal(error.evidence.checkpoint, invalid);
      assert.equal(typeof error.evidence.repository, "string");
      const restored = error.evidence.repository as string;
      assert.equal(path.dirname(restored), f.parent);
      assert.equal(
        execFileSync("git", ["-C", restored, "for-each-ref"], {
          encoding: "utf8",
          windowsHide: true,
        }),
        "",
      );
      return true;
    },
  );
  assert.equal((await readdir(f.parent)).length, 1);
});

void test("inert import refuses forged bytes and leaves existing refs intact", async (t) => {
  const f = await recoveryFixture(t);
  const bytes = Buffer.from("independently expected bytes");
  const object = { kind: "blob" as const, oid: gitObject("blob", bytes), bytes };
  await assert.rejects(
    importCoordinatorCheckpoint(f.repository, f.saved.checkpoint, [object, object, object]),
    /duplicate/u,
  );
  await assert.rejects(
    importCoordinatorCheckpoint(f.repository, f.saved.checkpoint, [
      object,
      { ...object, bytes: Buffer.from("changed") },
      object,
    ]),
    /identity/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
});

function gitObject(kind: string, bytes: Buffer) {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}

async function remoteFixture(t: test.TestContext) {
  const local = await fixture(t);
  const saved = await checkpointReleaseOpportunity(
    local.repository,
    local.initial.checkpoint,
    local.input,
  );
  const bare = path.join(local.repository, "coordinator.git");
  execFileSync("git", ["clone", "--mirror", "--quiet", local.repository, bare], {
    windowsHide: true,
  });
  const checkpoint = await exportCoordinatorCheckpoint(bare, saved.checkpoint);
  const config = { schema_version: 1, namespace: "portcove-fixture" };
  const stateRef = "refs/heads/portcove-fixture-coordinator-state";
  const refs = new Map([[stateRef, local.initial.checkpoint]]);
  const commits = new Map(
    checkpoint.required_commits.map((commit) => [
      commit.oid,
      {
        sha: commit.oid,
        tree: { sha: commit.tree },
        parents: commit.parent ? [{ sha: commit.parent }] : [],
      },
    ]),
  );
  let posts = 0;
  let mutations = 0;
  let snapshots = 0;
  let requests = 0;
  const blobs = new Set<string>();
  const faults = { object: "", mutation: "", snapshot: "" };
  const api: CoordinatorRemoteApi = {
    request(method, endpoint, body) {
      requests++;
      const reply = (value: unknown) => ({
        status: method === "GET" ? 200 : 201,
        headers: new Map<string, string>(),
        body: value,
      });
      if (method === "GET" && endpoint === "repos/boburning/portcove")
        return reply({
          id: faults.snapshot === "repository" ? 1 : 1354613114,
          full_name: "boburning/portcove",
          node_id: "R_fixture",
        });
      if (method === "GET") {
        const oid = endpoint.split("/").at(-1)!;
        const value = commits.get(oid);
        return value
          ? reply(value)
          : { status: 404, headers: new Map<string, string>(), body: null };
      }
      posts++;
      assert.ok(isRecord(body));
      const kind = endpoint.split("/").at(-1)!;
      let bytes: Buffer;
      if (kind === "blobs") {
        assert.equal(body.encoding, "base64");
        assert.equal(typeof body.content, "string");
        bytes = Buffer.from(body.content as string, "base64");
      } else if (kind === "trees") {
        assert.ok(Array.isArray(body.tree) && body.tree.length === 1);
        const entry: unknown = body.tree[0];
        assert.ok(isRecord(entry));
        assert.equal(entry.path, "state.json");
        assert.equal(entry.mode, "100644");
        assert.equal(entry.type, "blob");
        assert.ok(typeof entry.sha === "string" && blobs.has(entry.sha));
        bytes = Buffer.concat([
          Buffer.from("100644 state.json\0"),
          Buffer.from(String(entry.sha), "hex"),
        ]);
      } else {
        assert.equal(kind, "commits");
        assert.ok(isRecord(body.author) && isRecord(body.committer));
        assert.ok(Array.isArray(body.parents));
        const person = (value: Record<string, unknown>) =>
          `${String(value.name)} <${String(value.email)}> ${Date.parse(String(value.date)) / 1000} +0000`;
        bytes = Buffer.from(
          `tree ${String(body.tree)}\n${body.parents.map((oid) => `parent ${String(oid)}\n`).join("")}author ${person(body.author)}\ncommitter ${person(body.committer)}\n\n${String(body.message)}`,
        );
      }
      const oid = gitObject(kind.slice(0, -1), bytes);
      if (kind === "blobs") blobs.add(oid);
      return reply({ sha: faults.object === kind ? "f".repeat(40) : oid });
    },
    graphql(query, variables) {
      requests++;
      if (query.startsWith("mutation")) {
        mutations++;
        assert.ok(isRecord(variables.input));
        const input = variables.input;
        assert.equal(input.repositoryId, "R_fixture");
        assert.ok(Array.isArray(input.refUpdates));
        const updates = input.refUpdates;
        assert.equal(
          new Set(updates.map((ref: unknown) => (isRecord(ref) ? ref.name : null))).size,
          updates.length,
        );
        for (const value of updates) {
          assert.ok(isRecord(value));
          assert.equal(value.force, false);
          assert.equal(refs.get(String(value.name)) ?? "0".repeat(40), value.beforeOid);
          assert.notEqual(value.afterOid, "0".repeat(40));
          assert.match(
            String(value.name),
            /^refs\/(?:heads\/portcove-fixture-coordinator-state|tags\/portcove-fixture-prepared(?:-source)?\/.+)$/u,
          );
        }
        if (faults.mutation === "before")
          throw new Error("bounded fixture response lost before CAS");
        for (const value of updates) {
          assert.ok(isRecord(value));
          refs.set(String(value.name), String(value.afterOid));
        }
        if (faults.mutation === "after") throw new Error("bounded fixture response lost after CAS");
        if (faults.mutation === "concurrent") refs.set(stateRef, "e".repeat(40));
        return { data: { updateRefs: { clientMutationId: input.clientMutationId } } };
      }
      snapshots++;
      if (faults.snapshot === "after" && snapshots > 1) throw new Error("readback unavailable");
      const node: Record<string, unknown> = {
        __typename: "Repository",
        id: "R_fixture",
        databaseId: 1354613114,
        nameWithOwner: "boburning/portcove",
      };
      for (const [alias, name] of Object.entries(variables)) {
        if (!/^r\d+$/u.test(alias)) continue;
        assert.equal(typeof name, "string");
        const ref = String(name);
        const oid = refs.get(ref);
        const split = ref.indexOf("/", 5) + 1;
        node[alias] = oid
          ? {
              name: ref.slice(split),
              prefix: ref.slice(0, split),
              target: {
                __typename: faults.snapshot === "tag" ? "Tag" : "Commit",
                oid: faults.snapshot === "zero" ? "0".repeat(40) : oid,
              },
            }
          : null;
      }
      if (faults.snapshot === "incomplete") delete node.r1;
      return { data: { node } };
    },
  };
  return {
    ...local,
    saved,
    bare,
    checkpoint,
    config,
    refs,
    stateRef,
    commits,
    faults,
    api,
    counts: () => ({ posts, mutations, snapshots }),
    requests: () => requests,
  };
}

async function fixture(t: test.TestContext, signed = false) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "portcove-coordinator-state-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-09-14T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-09-14T12:00:00Z",
      },
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Coordinator fixture");
  git("config", "user.email", "fixture@portcove.invalid");
  git("config", "core.autocrlf", "false");
  for (const [name, bytes] of Object.entries({
    "Cargo.toml":
      '[workspace]\nmembers = ["crates/example"]\n[workspace.package]\nversion = "0.1.0-alpha.2"\n',
    "crates/example/Cargo.toml": '[package]\nname = "example"\nversion.workspace = true\n',
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0-alpha.2"\n',
    "apps/desktop/package.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
  })) {
    await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await writeFile(path.join(repository, name), bytes);
  }
  git("add", ".");
  git("commit", "-qm", "independent source fixture");
  if (signed) {
    const original = execFileSync("git", ["-C", repository, "cat-file", "commit", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const boundary = original.indexOf("\n\n");
    // Deliberately non-authentic fixture signature: this tests raw Git byte
    // reproduction, never a publisher signature or production authority.
    const signedBytes = `${original.slice(0, boundary)}\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture-only\n -----END PGP SIGNATURE-----${original.slice(boundary)}`;
    const signedOid = execFileSync(
      "git",
      ["-C", repository, "hash-object", "-w", "-t", "commit", "--stdin"],
      { input: signedBytes, encoding: "utf8", windowsHide: true },
    ).trim();
    git("update-ref", "HEAD", signedOid);
  }
  const source = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const classification = {
    source_commit: source,
    reviewed_commit: source,
    source_tree: tree,
    reviewed_tree: tree,
    change_set_sha256: "a".repeat(64),
    base_version: "0.1.0-alpha.2",
    change: "prerelease",
    compatibility: "compatible",
  };
  const input = {
    schema_version: 1,
    now: "2026-09-14T12:00:00.000Z",
    controller: {
      workflow: ".github/workflows/release-coordinator.yml",
      revision: "3".repeat(40),
      publication_paused: false,
      free_capacity_available: true,
    },
    opportunity: {
      source_commit: source,
      source_tree: tree,
      base_commit: source,
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
      observed_at: "2026-09-14T11:59:00.000Z",
      published_versions: ["0.1.0-alpha.2"],
      published_sources: [] as string[],
      reserved_versions: [] as string[],
      last_routine_preview_at: null,
    },
    active_candidate: null as Record<string, unknown> | null,
  };
  const initial = await checkpointReleaseOpportunity(repository, null, input);
  const prepared = await prepareReleaseVersion(
    repository,
    classification,
    input.publication.published_versions,
  );
  input.publication.reserved_versions = [prepared.version];
  input.active_candidate = {
    source_commit: source,
    source_tree: tree,
    prepared_commit: prepared.prepared_commit,
    prepared_tree: prepared.prepared_tree,
    version: prepared.version,
    intent_sha256: prepared.intent_sha256,
    phase: "prepared",
    failure_kind: null,
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: null,
  };
  return { repository, git, input, initial, prepared };
}

void test("remote checkpoint exports exact Git objects, atomically persists receipts, and repeats without writes", async (t) => {
  const f = await remoteFixture(t);
  // Exercise the real bounded API adapter and its JSON stdin contract without
  // invoking gh, resolving credentials, or making a network request.
  const api = new GitHubApiClient(
    createGitHubRunner({
      cwd: f.bare,
      spawn: (command, args, options) => {
        assert.equal(command, "gh");
        assert.equal(options.timeout, 15_000);
        assert.equal(options.windowsHide, true);
        let response: unknown;
        let status: number;
        if (options.input !== undefined) assert.equal(typeof options.input, "string");
        const input: unknown =
          options.input === undefined ? null : JSON.parse(options.input as string);
        if (args[1] === "graphql") {
          assert.deepEqual(args, ["api", "graphql", "--include", "--input", "-"]);
          assert.ok(
            isRecord(input) && typeof input.query === "string" && isRecord(input.variables),
          );
          response = f.api.graphql(input.query, input.variables);
          status = 200;
        } else {
          const method = args[args.indexOf("--method") + 1];
          assert.ok(method);
          const result = f.api.request(method, args[2]!, input);
          response = result.body;
          status = result.status!;
        }
        return {
          status: 0,
          stdout: `HTTP/2.0 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(response)}`,
          stderr: "",
        };
      },
    }),
  );
  await assert.rejects(
    exportCoordinatorCheckpoint(f.repository, f.saved.checkpoint),
    /bare coordinator/u,
  );
  assert.equal(f.checkpoint.commit.oid, f.saved.checkpoint);
  assert.equal(gitObject("blob", Buffer.from(f.checkpoint.blob.contents)), f.checkpoint.blob.oid);
  const result = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api,
  });
  assert.equal(result.changed, true);
  assert.equal(result.recovered, false);
  assert.equal(result.updates.length, 3);
  assert.deepEqual(f.counts(), { posts: 3, mutations: 1, snapshots: 2 });
  assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
  const again = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api,
  });
  assert.equal(again.changed, false);
  assert.deepEqual(f.counts(), { posts: 3, mutations: 1, snapshots: 3 });
  assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  // Existing receipts are compared even though their values do not change.
  f.input.active_candidate!.phase = "qualifying";
  const advanced = await checkpointReleaseOpportunity(f.bare, f.saved.checkpoint, f.input);
  const next = await publishCoordinatorCheckpoint(f.bare, advanced.checkpoint, f.config, {
    api,
  });
  assert.equal(next.updates.length, 3);
  assert.ok(next.updates.slice(1).every((ref) => ref.beforeOid === ref.afterOid));
});

for (const mode of ["before", "after", "concurrent", "readback"]) {
  void test(`remote checkpoint preserves ambiguous CAS outcome ${mode} without automatic retry`, async (t) => {
    const f = await remoteFixture(t);
    if (mode === "readback") f.faults.snapshot = "after";
    else f.faults.mutation = mode;
    if (mode === "after") {
      const result = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
        api: f.api,
      });
      assert.equal(result.recovered, true);
      assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
    } else {
      await assert.rejects(
        publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api }),
        (error: unknown) => {
          assert.ok(error instanceof CoordinatorRemoteError);
          assert.ok(isRecord(error.evidence));
          if (mode === "before") assert.equal(error.evidence.observation, "observed-before");
          if (mode === "concurrent")
            assert.equal(error.evidence.observation, "unknown-or-concurrent");
          if (mode === "readback") assert.ok(error.evidence.readbackError);
          return true;
        },
      );
    }
    assert.equal(f.counts().mutations, 1);
    assert.equal(f.counts().snapshots, 2);
    assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  });
}

for (const mode of [
  "object-missing",
  "commit-parent",
  "mixed",
  "incomplete",
  "repository",
  "tag",
  "zero",
  "blobs",
  "trees",
  "commits",
]) {
  void test(`remote checkpoint refuses ${mode} before CAS`, async (t) => {
    const f = await remoteFixture(t);
    if (mode === "object-missing") f.commits.clear();
    else if (mode === "commit-parent")
      f.commits.get(f.prepared.prepared_commit)!.parents = [{ sha: "f".repeat(40) }];
    else if (mode === "mixed") f.refs.set(f.stateRef, f.saved.checkpoint);
    else if (["incomplete", "repository", "tag", "zero"].includes(mode)) f.faults.snapshot = mode;
    else f.faults.object = mode;
    await assert.rejects(
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api }),
    );
    assert.equal(f.counts().mutations, 0);
    if (!["blobs", "trees", "commits"].includes(mode)) assert.equal(f.counts().posts, 0);
    assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  });
}

void test("remote checkpoint requires explicit configuration, transport, bare ownership and initialized history before provider calls", async (t) => {
  const f = await remoteFixture(t);
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config),
    /unconfigured/u,
  );
  for (const config of [
    null,
    { ...f.config, namespace: "main" },
    { ...f.config, repository: "other/repo" },
  ])
    await assert.rejects(
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, config, { api: f.api }),
      /configuration/u,
    );
  await assert.rejects(
    publishCoordinatorCheckpoint(f.repository, f.saved.checkpoint, f.config, { api: f.api }),
    /bare coordinator/u,
  );
  execFileSync("git", ["-C", f.bare, "update-ref", coordinatorStateRef, f.initial.checkpoint]);
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, f.initial.checkpoint, f.config, { api: f.api }),
    /initialized previous/u,
  );
  assert.deepEqual(f.counts(), { posts: 0, mutations: 0, snapshots: 0 });
  assert.equal(f.requests(), 0);
});

void test("checkpoint rejects physical trailing whitespace and invalid UTF-8 without normalizing history", async (t) => {
  const f = await fixture(t);
  const original = execFileSync("git", [
    "-C",
    f.repository,
    "cat-file",
    "blob",
    `${f.initial.checkpoint}:state.json`,
  ]);
  for (const suffix of [Buffer.from("\n"), Buffer.from("\t"), Buffer.from([0xff])]) {
    const blob = execFileSync("git", ["-C", f.repository, "hash-object", "-w", "--stdin"], {
      input: Buffer.concat([original, suffix]),
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["-C", f.repository, "mktree"], {
      input: `100644 blob ${blob}\tstate.json\n`,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["-C", f.repository, "commit-tree", tree], {
      input: "physical bytes fixture\n",
      encoding: "utf8",
    }).trim();
    f.git("update-ref", coordinatorStateRef, commit);
    await assert.rejects(recoverReleaseOpportunity(f.repository, commit), /canonical|UTF-8/u);
    assert.equal(f.git("rev-parse", coordinatorStateRef), commit);
  }
});

void test("checkpoint recovers exact prepared candidate and parent history without touching index or branch", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const head = git("rev-parse", "HEAD");
  const index = git("write-tree");
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  assert.equal(saved.plan.action, "resume-active");
  assert.equal(git("rev-parse", `${saved.checkpoint}^`), initial.checkpoint);
  assert.deepEqual((await recoverReleaseOpportunity(repository, saved.checkpoint)).input, input);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("write-tree"), index);
  // A process may lose its response after commit. Same preimage/input must find
  // that exact checkpoint; newer snapshot retries must never roll it back.
  assert.deepEqual(
    await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    saved,
  );
  const next = structuredClone(input);
  next.active_candidate!.phase = "qualifying";
  const advanced = await checkpointReleaseOpportunity(repository, saved.checkpoint, next);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), advanced.checkpoint);
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, saved.checkpoint));
});

void test("missing and conflicting prepared receipts refuse atomically including identical checkpoint retry", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const [versionRef, sourceRef] = prepared.allocation_refs;
  git("update-ref", "-d", sourceRef);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
  git("update-ref", sourceRef, prepared.prepared_commit);
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  git("update-ref", versionRef, input.opportunity.source_commit);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, saved.checkpoint));
  assert.equal(git("rev-parse", coordinatorStateRef), saved.checkpoint);
});

void test("frozen identity, counters, phases, run and active reservation cannot be silently replaced", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  for (const [field, value] of Object.entries({
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    version: "0.1.0-alpha.4",
    intent_sha256: "e".repeat(64),
    phase: "publishing",
    transient_retries: 1,
    substantive_repairs: 1,
  })) {
    const next = structuredClone(input);
    next.active_candidate![field] = value;
    await assert.rejects(
      async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, next),
      Error,
      field,
    );
    assert.equal(git("rev-parse", coordinatorStateRef), saved.checkpoint);
  }
  const clear = structuredClone(input);
  clear.active_candidate = null;
  clear.publication.reserved_versions = [];
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, clear),
    /discard/u,
  );
  const changed = structuredClone(input);
  changed.controller.revision = "f".repeat(40);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, changed),
    /controller/u,
  );
});

void test("failed candidate resumes only through bounded recovery and preserves the run identity", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  input.active_candidate!.phase = "qualifying";
  input.active_candidate!.release_run = {
    run_id: 123,
    attempt: 1,
    revision: input.active_candidate!.prepared_commit,
  };
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const replaced = structuredClone(input);
  replaced.active_candidate!.release_run = {
    run_id: 124,
    attempt: 1,
    revision: input.active_candidate!.prepared_commit,
  };
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, replaced),
    /release run/u,
  );
  input.active_candidate!.phase = "failed";
  input.active_candidate!.failure_kind = "transient";
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const resume = structuredClone(input);
  resume.active_candidate!.phase = "qualifying";
  resume.active_candidate!.failure_kind = null;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, resume),
    /recovery increment/u,
  );
  resume.active_candidate!.transient_retries = 1;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, resume),
    /restart/u,
  );
  resume.active_candidate!.phase = "prepared";
  resume.active_candidate!.release_run = null;
  const recovered = await checkpointReleaseOpportunity(repository, saved.checkpoint, resume);
  assert.equal(recovered.plan.action, "resume-active");
  const reset = structuredClone(resume);
  reset.active_candidate!.transient_retries = 0;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, recovered.checkpoint, reset),
    /regressed/u,
  );
});

void test("competing processes and linked worktrees share one CAS preimage; identical retries agree", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  const linked = path.join(repository, "linked");
  git("worktree", "add", "--detach", linked, "HEAD");
  const invoke = (root: string, data: unknown) =>
    execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {checkpointReleaseOpportunity as save} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await save(${JSON.stringify(root)},${JSON.stringify(initial.checkpoint)},${JSON.stringify(data)})));`,
      ],
      { windowsHide: true, timeout: 15_000 },
    );
  const other = structuredClone(input);
  other.controller.publication_paused = true;
  const raced = await Promise.allSettled([invoke(repository, input), invoke(linked, other)]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
  const winner = raced[0]?.status === "fulfilled" ? input : other;
  const receipts = await Promise.all([invoke(repository, winner), invoke(linked, winner)]);
  const first: unknown = JSON.parse(receipts[0].stdout);
  const second: unknown = JSON.parse(receipts[1].stdout);
  assert.ok(isRecord(first) && isRecord(second));
  assert.equal(first.checkpoint, second.checkpoint);
});

void test("a differently prepared classification cannot replace the planned intent even through both allocation refs", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const message = git("show", "-s", "--format=%B", prepared.prepared_commit);
  const payload: unknown = JSON.parse(message.split("\n").slice(3).join("\n"));
  assert.ok(isRecord(payload));
  payload.migration_notes = "different reviewed intent";
  const bytes = JSON.stringify(payload);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const commit = execFileSync(
    "git",
    [
      "-C",
      repository,
      "commit-tree",
      prepared.prepared_tree,
      "-p",
      input.opportunity.source_commit,
    ],
    {
      encoding: "utf8",
      input: `Prepare application ${prepared.version}\n\nPortcove-Preparation-SHA256: ${digest}\n${bytes}\n`,
      windowsHide: true,
    },
  ).trim();
  for (const ref of prepared.allocation_refs) git("update-ref", ref, commit);
  input.active_candidate!.prepared_commit = commit;
  input.active_candidate!.intent_sha256 = digest;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /reviewed classification/u,
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
});

void test("pause preserves the candidate, failure reclassification and phase-skipping recovery refuse", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  input.controller.publication_paused = true;
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  assert.equal(saved.plan.action, "pause");
  assert.deepEqual(
    (await recoverReleaseOpportunity(repository, saved.checkpoint)).input.active_candidate,
    input.active_candidate,
  );
  input.controller.publication_paused = false;
  input.active_candidate!.phase = "failed";
  input.active_candidate!.failure_kind = "transient";
  saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  const changed = structuredClone(input);
  changed.active_candidate!.failure_kind = "substantive";
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, changed),
    /reclassified/u,
  );
  const skipped = structuredClone(input);
  skipped.active_candidate!.phase = "promoting";
  skipped.active_candidate!.failure_kind = null;
  skipped.active_candidate!.transient_retries = 1;
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, skipped),
    /restart/u,
  );
});

void test("only ordered promotion and matching publication can clear an active reservation", async (t) => {
  const { repository, input, initial } = await fixture(t);
  let saved = await checkpointReleaseOpportunity(repository, initial.checkpoint, input);
  for (const phase of ["qualifying", "building", "publishing", "promoting"]) {
    input.active_candidate!.phase = phase;
    saved = await checkpointReleaseOpportunity(repository, saved.checkpoint, input);
  }
  const published = structuredClone(input);
  published.active_candidate = null;
  published.publication.reserved_versions = [];
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, saved.checkpoint, published),
    /discard/u,
  );
  published.publication.published_versions.push("0.1.0-alpha.3");
  published.publication.published_sources = [input.opportunity.source_commit];
  const completed = await checkpointReleaseOpportunity(repository, saved.checkpoint, published);
  assert.equal(completed.plan.action, "skip");
  assert.equal(
    (await recoverReleaseOpportunity(repository, completed.checkpoint)).input.active_candidate,
    null,
  );
});

void test("lost state, oversized input and unrecognized checkpoint tree remain refusals", async (t) => {
  const { repository, git, input, initial } = await fixture(t);
  await assert.rejects(
    async () => await recoverReleaseOpportunity(repository, git("rev-parse", "HEAD")),
    /state.json/u,
  );
  await assert.rejects(
    async () =>
      await checkpointReleaseOpportunity(repository, initial.checkpoint, {
        ...input,
        opportunity: {
          ...input.opportunity,
          classification: {
            ...input.opportunity.classification,
            migration_notes: { second: "b", first: "a" },
          },
        },
      }),
    /migration notes must be a string/u,
  );
  await assert.rejects(
    async () =>
      await checkpointReleaseOpportunity(repository, initial.checkpoint, {
        ...input,
        padding: "x".repeat(65536),
      }),
    /byte bound/u,
  );
  git("update-ref", "-d", coordinatorStateRef);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
    /conflict/u,
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, initial.checkpoint));
});

void test("symbolic state or prepared refs cannot redirect a checkpoint transaction", async (t) => {
  const { repository, git, input, initial, prepared } = await fixture(t);
  const alias = "refs/portcove/unrelated-state";
  git("update-ref", alias, initial.checkpoint);
  git("symbolic-ref", coordinatorStateRef, alias);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
  );
  await assert.rejects(async () => await recoverReleaseOpportunity(repository, initial.checkpoint));
  assert.equal(git("rev-parse", alias), initial.checkpoint);
  git("update-ref", "--no-deref", coordinatorStateRef, initial.checkpoint);
  const versionRef = prepared.allocation_refs[0];
  const preparedAlias = "refs/portcove/unrelated-preparation";
  git("update-ref", preparedAlias, prepared.prepared_commit);
  git("symbolic-ref", versionRef, preparedAlias);
  await assert.rejects(
    async () => await checkpointReleaseOpportunity(repository, initial.checkpoint, input),
  );
  assert.equal(git("rev-parse", coordinatorStateRef), initial.checkpoint);
  assert.equal(git("rev-parse", preparedAlias), prepared.prepared_commit);
  git("update-ref", "--no-deref", "-d", coordinatorStateRef);
  git("symbolic-ref", coordinatorStateRef, "refs/portcove/missing-state");
  const first = structuredClone(input);
  first.active_candidate = null;
  first.publication.reserved_versions = [];
  await assert.rejects(async () => await checkpointReleaseOpportunity(repository, null, first));
  assert.equal(git("symbolic-ref", coordinatorStateRef), "refs/portcove/missing-state");
});
