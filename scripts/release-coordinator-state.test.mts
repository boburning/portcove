import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  runBoundedCapacityOperation,
  recordCapacityReadback,
  ProviderCapacityRefusal,
  runBoundedMetadataRenewalOperation,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import { isDeepStrictEqual } from "node:util";
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
  readRetainedCapacityOperation,
} from "./release-coordinator-state.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  authenticateCapacityExecutor,
  executeOwnedCapacityEffect,
} from "./release-capacity-executor.mts";
import {
  assemblerIdentityFixture,
  expected as identityExpected,
  jwk as identityJwk,
} from "./fixtures/assembler-identity-fixture.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";

const execute = promisify(execFile);
const moduleUrl = new URL("./release-coordinator-state.mts", import.meta.url).href;

void test("optional frozen opportunity binds allocation and cannot be changed, removed or retroactively supplied", async (t) => {
  const f = await fixture(t);
  assert.ok(f.input.active_candidate);
  const original = structuredClone(f.input.opportunity);
  f.input.active_candidate.frozen_opportunity = structuredClone(original);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const queued = structuredClone(f.input);
  queued.opportunity.source_commit = "7".repeat(40);
  queued.opportunity.classification.source_commit = "7".repeat(40);
  queued.opportunity.classification.reviewed_commit = "7".repeat(40);
  const next = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, queued);
  assert.ok("active_candidate" in next.plan);
  assert.deepEqual(next.plan.active_candidate.frozen_opportunity, original);
  const recovered = await recoverReleaseOpportunity(f.repository, next.checkpoint);
  assert.ok(isRecord(recovered.input.active_candidate));
  assert.deepEqual(recovered.input.active_candidate.frozen_opportunity, original);
  for (const mutation of ["remove", "change", "null"]) {
    const changed = structuredClone(queued);
    assert.ok(changed.active_candidate);
    if (mutation === "remove") delete changed.active_candidate.frozen_opportunity;
    else if (mutation === "null") changed.active_candidate.frozen_opportunity = null;
    else changed.active_candidate.frozen_opportunity = { ...original, urgency: true };
    await assert.rejects(checkpointReleaseOpportunity(f.repository, next.checkpoint, changed));
    assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), next.checkpoint);
  }
  const legacy = await fixture(t);
  const legacySaved = await checkpointReleaseOpportunity(
    legacy.repository,
    legacy.initial.checkpoint,
    legacy.input,
  );
  assert.ok(legacy.input.active_candidate);
  legacy.input.active_candidate.frozen_opportunity = structuredClone(legacy.input.opportunity);
  await assert.rejects(
    checkpointReleaseOpportunity(legacy.repository, legacySaved.checkpoint, legacy.input),
    /cannot be added/u,
  );
  const legacyRecovered = await recoverReleaseOpportunity(
    legacy.repository,
    legacySaved.checkpoint,
  );
  assert.ok(isRecord(legacyRecovered.input.active_candidate));
  assert.equal(Object.hasOwn(legacyRecovered.input.active_candidate, "frozen_opportunity"), false);
});

void test("allocation snapshot must match the whole preceding opportunity and never widens checkpoint bytes", async (t) => {
  const f = await fixture(t);
  assert.ok(f.input.active_candidate);
  f.input.active_candidate.frozen_opportunity = {
    ...structuredClone(f.input.opportunity),
    urgency: true,
  };
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input),
    /preceding preparation input/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), f.initial.checkpoint);
  const candidate = structuredClone(f.input.active_candidate);
  delete candidate.frozen_opportunity;
  f.input.active_candidate = null;
  f.input.publication.reserved_versions = [];
  Object.assign(f.input.opportunity.classification, { evidence_note: "x".repeat(33000) });
  const larger = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  candidate.frozen_opportunity = structuredClone(f.input.opportunity);
  f.input.active_candidate = candidate;
  f.input.publication.reserved_versions = [f.prepared.version];
  await assert.rejects(
    checkpointReleaseOpportunity(f.repository, larger.checkpoint, f.input),
    /byte bound/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), larger.checkpoint);
});

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

for (const kind of ["refusal", "ambiguous"]) {
  void test(`schema2 pending intent survives partial ${kind} without phase loss or duplicate attempts`, async (t) => {
    const f = await fixture(t);
    const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
    const capacity = capacityFixture();
    const input = {
      ...f.input,
      schema_version: 2,
      controller: {
        workflow: f.input.controller.workflow,
        revision: f.input.controller.revision,
        publication_paused: false,
        capacity_attempt: capacity,
      },
    };
    const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
    let effects = 0,
      failedCheckpoint = "";
    try {
      await runBoundedCapacityOperation(
        f.repository,
        migrated.checkpoint,
        { kind: "upload", destination: "same-run immutable candidate archive" },
        async () => capacity.boundary,
        async (record) => {
          effects++;
          const pending = f.git("rev-parse", coordinatorStateRef).trim();
          const pendingState = await recoverReleaseOpportunity(f.repository, pending);
          assert.equal(pendingState.plan.action, "pause");
          assert.deepEqual(pendingState.input.active_candidate, f.input.active_candidate);
          await record("artifact:fixture-completed", "a".repeat(64));
          if (kind === "refusal")
            throw new ProviderCapacityRefusal("provider-upload-quota-refusal", "b".repeat(64));
          throw Error("DISPOSABLE-SECRET-unavailable-response");
        },
      );
      assert.fail("must stop");
    } catch (error) {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      failedCheckpoint = String(error.evidence.checkpoint);
      assert.equal(JSON.stringify(error.evidence).includes("DISPOSABLE-SECRET"), false);
    }
    const failed = await recoverReleaseOpportunity(f.repository, failedCheckpoint);
    assert.deepEqual(failed.input.active_candidate, f.input.active_candidate);
    assert.ok(
      isRecord(failed.input.controller) && isRecord(failed.input.controller.capacity_attempt),
    );
    const operation = failed.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.outcome, kind === "refusal" ? "capacity-refused" : "ambiguous");
    assert.ok(Array.isArray(operation.completed_effects));
    assert.equal(operation.completed_effects.length, 1);
    await assert.rejects(
      runBoundedCapacityOperation(
        f.repository,
        failedCheckpoint,
        { kind: "dispatch", destination: "different ID cannot bypass unresolved effect" },
        async () => capacity.boundary,
        async () => {
          effects++;
        },
      ),
    );
    assert.equal(effects, 1);
    const dropped = structuredClone(failed.input);
    assert.ok(isRecord(dropped.controller) && isRecord(dropped.controller.capacity_attempt));
    dropped.controller.capacity_attempt.operation = null;
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, failedCheckpoint, dropped),
      /cannot disappear/,
    );
    await assert.rejects(
      recordCapacityReadback(f.repository, failedCheckpoint, "effect-not-applied", "c".repeat(64)),
      /contradicts/,
    );
    const resolved = await recordCapacityReadback(
      f.repository,
      failedCheckpoint,
      "partial-effects-retained",
      "c".repeat(64),
    );
    const readback = await recoverReleaseOpportunity(f.repository, resolved.checkpoint);
    assert.deepEqual(readback.input.active_candidate, f.input.active_candidate);
    assert.equal(readback.plan.authority.capacity_attempt?.availability, "unknown");
    await assert.rejects(
      checkpointReleaseOpportunity(f.repository, resolved.checkpoint, { ...f.input }),
      /cannot downgrade/,
    );
  });
}
void test("successful operation proves only its own effect; next boundary must be checked independently", async (t) => {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
  let effects = 0;
  const success = await runBoundedCapacityOperation(
    f.repository,
    migrated.checkpoint,
    { kind: "upload", destination: "artifact:first" },
    async () => capacity.boundary,
    async (record) => {
      effects++;
      await record("artifact:1", "d".repeat(64));
    },
  );
  assert.equal(success.availability, "unknown");
  assert.equal(success.headroom, "unknown");
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      success.checkpoint,
      { kind: "retention", destination: "artifact:second" },
      async () => ({ ...capacity.boundary, stop_usage: false }),
      async () => {
        effects++;
      },
    ),
  );
  assert.equal(effects, 1);
  const held = await recoverReleaseOpportunity(f.repository, success.checkpoint);
  assert.deepEqual(held.input.active_candidate, f.input.active_candidate);
});

async function capacityStateFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const saved = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, f.input);
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.repository, saved.checkpoint, input);
  return { ...f, capacity, migrated };
}
async function remoteCapacityFixture(t: test.TestContext) {
  const f = await remoteFixture(t);
  await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api });
  const capacity = capacityFixture();
  const input = {
    ...f.input,
    schema_version: 2,
    controller: {
      workflow: f.input.controller.workflow,
      revision: f.input.controller.revision,
      publication_paused: false,
      capacity_attempt: capacity,
    },
  };
  const migrated = await checkpointReleaseOpportunity(f.bare, f.saved.checkpoint, input);
  await publishCoordinatorCheckpoint(f.bare, migrated.checkpoint, f.config, { api: f.api });
  return { ...f, capacity, migrated, options: { remote: { configuration: f.config, api: f.api } } };
}

for (const lost of [false, true])
  void test(
    `actual executor integration ${lost ? "retains a lost provider outcome and forbids retry" : "settles only its exact durably retained effect"}`,
    { timeout: 180000 },
    async (t) => {
      // Real local Git journal with simulated GitHub/JWKS/OIDC transport. No real
      // issuer credential, GitHub request, publication or protected grant is used.
      const f = await remoteCapacityFixture(t);
      const signed = assemblerIdentityFixture(
        { aud: "portcove-capacity-executor" },
        {},
        { workflow: productionControllerWorkflow, job: "Publish authenticated application site" },
      );
      const savedEnv = new Map(
        ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].map((k) => [
          k,
          process.env[k],
        ]),
      );
      process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
        "https://fixture.actions.githubusercontent.com/oidc";
      process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "inert-runner-token";
      t.after(() => {
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const http = t.mock.method(globalThis, "fetch", async (raw: Parameters<typeof fetch>[0]) => {
        if (typeof raw !== "string" && !(raw instanceof URL))
          throw new Error("fixture expects a fixed URL");
        const url = typeof raw === "string" ? raw : raw.href;
        if (url === "https://token.actions.githubusercontent.com/.well-known/jwks")
          return new Response(JSON.stringify({ keys: [identityJwk] }));
        assert.equal(
          url,
          "https://fixture.actions.githubusercontent.com/oidc?audience=portcove-capacity-executor",
        );
        return new Response(JSON.stringify({ value: signed.token }));
      });
      const original = childProcess.spawnSync;
      const command = t.mock.method(
        childProcess,
        "spawnSync",
        (name: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
          if (name !== "gh") return original(name, args, options);
          assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
          if (args[2]?.includes("/actions/") || args[2]?.includes("/check-runs/"))
            return signed.transport.spawn(name, args, options);
          let body: unknown;
          let status: number;
          if (args[1] === "graphql") {
            assert.ok(typeof options.input === "string");
            const request: unknown = JSON.parse(options.input);
            assert.ok(
              isRecord(request) && typeof request.query === "string" && isRecord(request.variables),
            );
            body = f.api.graphql(request.query, request.variables);
            status = 200;
          } else {
            assert.equal(args[0], "api");
            const method = args[args.indexOf("--method") + 1];
            assert.ok(method === "GET" || method === "POST");
            assert.ok(options.input === undefined || typeof options.input === "string");
            const response = f.api.request(
              method,
              args[2]!,
              options.input === undefined ? undefined : JSON.parse(options.input),
            );
            body = response.body;
            status = response.status!;
          }
          return {
            status: 0,
            stdout: `HTTP/2 ${status}\r\n\r\n${JSON.stringify(body)}`,
            stderr: "",
          };
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        command.mock.restore();
        http.mock.restore();
        syncBuiltinESMExports();
      });
      const executor = await authenticateCapacityExecutor(
        "site-publication",
        { ...identityExpected, audience: "portcove-capacity-executor" },
        f.repository,
      );
      const request = {
        repository: f.bare,
        checkpoint: f.migrated.checkpoint,
        remote_configuration: f.config,
        request: {
          kind: "upload" as const,
          destination: "github-pages:boburning/portcove:complete-site",
        },
      };
      let effects = 0;
      const receipt = async (pending: { checkpoint: string; operation_id: string }) => {
        effects++;
        assert.equal(
          f.refs.get(f.stateRef),
          pending.checkpoint,
          "pending intent must already be remote",
        );
        const observed = await recoverReleaseOpportunity(f.bare, pending.checkpoint);
        assert.ok(
          isRecord(observed.input.controller) &&
            isRecord(observed.input.controller.capacity_attempt),
        );
        const operation = observed.input.controller.capacity_attempt.operation;
        assert.ok(isRecord(operation) && isRecord(operation.executor_identity));
        assert.equal(operation.id, pending.operation_id);
        assert.equal(operation.executor_identity.job_id, 501);
        assert.equal(operation.outcome, "pending");
        if (lost) throw new Error("simulated response lost after provider effect");
        return {
          remote_identity: "github-pages:boburning/portcove:fixture-deployment",
          evidence_sha256: "d".repeat(64),
        };
      };
      if (lost) {
        await assert.rejects(
          executeOwnedCapacityEffect(executor, request, async () => f.capacity.boundary, receipt),
          /read back before/u,
        );
        await assert.rejects(
          executeOwnedCapacityEffect(executor, request, async () => f.capacity.boundary, receipt),
          /stopped/u,
        );
        const retained = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
        assert.ok(
          isRecord(retained.input.controller) &&
            isRecord(retained.input.controller.capacity_attempt),
        );
        assert.ok(isRecord(retained.input.controller.capacity_attempt.operation));
        assert.equal(retained.input.controller.capacity_attempt.operation.outcome, "ambiguous");
      } else {
        const result = await executeOwnedCapacityEffect(
          executor,
          request,
          async () => f.capacity.boundary,
          receipt,
        );
        assert.equal(
          f.refs.get(f.stateRef),
          result.checkpoint,
          "settlement must be remotely confirmed",
        );
        const settled = await recoverReleaseOpportunity(f.bare, result.checkpoint);
        assert.ok(
          isRecord(settled.input.controller) && isRecord(settled.input.controller.capacity_attempt),
        );
        const operation = settled.input.controller.capacity_attempt.operation;
        assert.ok(
          isRecord(operation) &&
            isRecord(operation.recovery) &&
            isRecord(operation.recovery.executor_identity),
        );
        assert.equal(operation.id, result.operation_id);
        assert.equal(operation.outcome, "recovered");
        assert.equal(operation.recovery.resolution, "effect-completed");
        assert.equal(operation.recovery.executor_identity.job_id, 501);
        assert.equal(result.evidence_sha256, "d".repeat(64));
        assert.deepEqual(settled.input.active_candidate, f.input.active_candidate);
      }
      assert.equal(effects, 1);
    },
  );
void test(
  "separate executors cannot share an identical remote pending intent",
  { timeout: 60000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const contender = path.join(f.repository, "contender.git");
    execFileSync("git", ["clone", "--mirror", "--quiet", f.bare, contender], { windowsHide: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let effects = 0;
    const request = { kind: "upload" as const, destination: "artifact:exclusive" };
    const first = runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      request,
      async () => f.capacity.boundary,
      async (record) => {
        effects++;
        entered.resolve();
        await release.promise;
        await record("artifact:first-executor", "a".repeat(64));
      },
      f.options,
    ).then(
      (result) => ({ result }),
      (error: unknown) => {
        entered.reject(error);
        return { error };
      },
    );
    await entered.promise;
    let secondError: unknown;
    try {
      await runBoundedCapacityOperation(
        contender,
        f.migrated.checkpoint,
        request,
        async () => f.capacity.boundary,
        async (record) => {
          effects++;
          await record("artifact:second-executor", "b".repeat(64));
        },
        f.options,
      );
    } catch (error) {
      secondError = error;
    } finally {
      release.resolve();
    }
    const outcome = await first;
    assert.equal(effects, 1, "only the remote claim creator may enter its effect");
    assert.ok(secondError instanceof CoordinatorRemoteError);
    assert.ok("result" in outcome, "the winning executor retains its pending effect receipt");
  },
);
void test("remote capacity intent and completed effects are durable before handoff", async (t) => {
  const f = await remoteCapacityFixture(t);
  const result = await runBoundedCapacityOperation(
    f.bare,
    f.migrated.checkpoint,
    { kind: "upload", destination: "artifact:durable" },
    async () => f.capacity.boundary,
    async (record) => {
      const pending = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
      assert.ok(
        isRecord(pending.input.controller) && isRecord(pending.input.controller.capacity_attempt),
      );
      const operation = pending.input.controller.capacity_attempt.operation;
      assert.ok(isRecord(operation));
      assert.equal(operation.outcome, "pending");
      // Lost POST acknowledgement is accepted only after the existing readback
      // confirms exact refs; this does not repeat the mutation.
      f.faults.mutation = "after";
      await record("artifact:observed", "d".repeat(64));
      const recorded = await recoverReleaseOpportunity(f.bare, f.refs.get(f.stateRef)!);
      assert.ok(
        isRecord(recorded.input.controller) && isRecord(recorded.input.controller.capacity_attempt),
      );
      const saved = recorded.input.controller.capacity_attempt.operation;
      assert.ok(isRecord(saved));
      assert.deepEqual(saved.completed_effects, [
        { remote_identity: "artifact:observed", evidence_sha256: "d".repeat(64) },
      ]);
    },
    f.options,
  );
  assert.equal(result.durable_checkpoint, result.checkpoint);
  assert.equal(result.completion, "readback-required");
  assert.equal(result.operation.outcome, "pending");
  assert.equal(f.refs.get(f.stateRef), result.checkpoint);
  assert.equal(result.availability, "unknown");
  assert.equal(result.headroom, "unknown");
});
for (const partial of [false, true]) {
  void test(`remote checkpoint refusal ${partial ? "after partial progress" : "before effect"} stops without a second mutation`, async (t) => {
    const f = await remoteCapacityFixture(t);
    let effects = 0;
    if (!partial) f.faults.mutation = "before";
    const before = f.counts().mutations;
    let retained = "";
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        f.migrated.checkpoint,
        { kind: "upload", destination: "artifact:durability-refused" },
        async () => f.capacity.boundary,
        async (record) => {
          effects++;
          f.faults.mutation = "before";
          await record("artifact:completed-before-checkpoint-refusal", "e".repeat(64));
        },
        f.options,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        retained = String(error.evidence.checkpoint);
        assert.equal(error.evidence.retry, "forbidden");
        assert.ok(error.evidence.checkpoint_transport_error);
        return true;
      },
    );
    assert.equal(effects, partial ? 1 : 0);
    assert.equal(f.counts().mutations - before, partial ? 2 : 1);
    const state = await recoverReleaseOpportunity(f.bare, retained);
    assert.ok(
      isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt),
    );
    const operation = state.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.outcome, "ambiguous");
    assert.equal((operation.completed_effects as unknown[]).length, partial ? 1 : 0);
    await assert.rejects(
      runBoundedCapacityOperation(
        f.bare,
        retained,
        { kind: "dispatch", destination: "run:must-not-retry" },
        async () => f.capacity.boundary,
        async () => {
          assert.fail("recovery required");
        },
        f.options,
      ),
    );
  });
}
void test("ambiguous remote pending POST retains its attempt and requires readback before effect", async (t) => {
  const f = await remoteCapacityFixture(t);
  const api: CoordinatorRemoteApi = {
    request: f.api.request,
    graphql(query, variables) {
      try {
        return f.api.graphql(query, variables);
      } finally {
        if (query.startsWith("mutation")) f.faults.snapshot = "after";
      }
    },
  };
  f.faults.mutation = "after";
  const before = f.counts().mutations;
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:ambiguous-intent" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("unconfirmed pending intent");
      },
      { remote: { configuration: f.config, api } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.equal(error.evidence.durable_checkpoint, null);
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.ok(error.evidence.checkpoint_transport_error.mutationError);
      assert.ok(error.evidence.checkpoint_transport_error.readbackError);
      checkpoint = String(error.evidence.checkpoint);
      return true;
    },
  );
  assert.equal(f.counts().mutations - before, 1);
  const retained = await recoverReleaseOpportunity(f.bare, checkpoint);
  assert.ok(
    isRecord(retained.input.controller) && isRecord(retained.input.controller.capacity_attempt),
  );
  const operation = retained.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  // Simulated provider did apply the original pending intent despite the failed
  // response. Its state stays pending; no subsequent outcome POST was attempted.
  const remote: unknown = JSON.parse(
    execFileSync("git", ["-C", f.bare, "show", `${f.refs.get(f.stateRef)!}:state.json`], {
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.ok(
    isRecord(remote) &&
      isRecord(remote.input) &&
      isRecord(remote.input.controller) &&
      isRecord(remote.input.controller.capacity_attempt),
  );
  const remoteOperation = remote.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(remoteOperation));
  assert.equal(remoteOperation.outcome, "pending");
});
void test("configured mode cannot be cleared mid-effect and final handoff readback failure stays blocking", async (t) => {
  const f = await remoteCapacityFixture(t);
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "upload", destination: "artifact:final-handoff" },
      async () => f.capacity.boundary,
      async (record) => {
        Reflect.deleteProperty(f.options, "remote");
        await record("artifact:completed", "e".repeat(64));
        f.faults.snapshot = "after";
      },
      f.options,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      checkpoint = String(error.evidence.checkpoint);
      assert.ok(error.evidence.durable_checkpoint);
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.match(
        String(error.evidence.checkpoint_transport_error.message),
        /readback unavailable/,
      );
      return true;
    },
  );
  const state = await recoverReleaseOpportunity(f.bare, checkpoint);
  assert.ok(isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt));
  const operation = state.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  assert.equal((operation.completed_effects as unknown[]).length, 1);
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      checkpoint,
      { kind: "dispatch", destination: "run:forbidden-after-handoff" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("explicit recovery required");
      },
    ),
  );
});
void test("throwing null from initial transport cannot clear the failure latch or discard diagnostics", async (t) => {
  const f = await remoteCapacityFixture(t);
  let calls = 0;
  const api: CoordinatorRemoteApi = {
    request() {
      calls++;
      // Deliberately malformed provider exception exercises the failure latch.
      // oxlint-disable-next-line typescript/only-throw-error
      throw null;
    },
    graphql() {
      assert.fail("transport already failed");
    },
  };
  await assert.rejects(
    runBoundedCapacityOperation(
      f.bare,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:null-transport" },
      async () => f.capacity.boundary,
      async () => {
        assert.fail("missing durable intent");
      },
      { remote: { configuration: f.config, api } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
      assert.ok(isRecord(error.evidence.checkpoint_transport_error));
      assert.equal(error.evidence.checkpoint_transport_error.code, "operation_failed");
      return true;
    },
  );
  assert.equal(calls, 1);
});
void test(
  "journal history refuses A B A despite intervening completed operations",
  { timeout: 60000 },
  async (t) => {
    const f = await capacityStateFixture(t);
    const run = (checkpoint: string, destination: string) =>
      runBoundedCapacityOperation(
        f.repository,
        checkpoint,
        { kind: "upload", destination },
        async () => f.capacity.boundary,
        async (record) => {
          await record(destination, "d".repeat(64));
        },
      );
    const a = await run(f.migrated.checkpoint, "artifact:A");
    const b = await run(a.checkpoint, "artifact:B");
    await assert.rejects(run(b.checkpoint, "artifact:A"), /completed operation cannot be repeated/);
    assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), b.checkpoint);
  },
);
void test("checkpoint advancement during final boundary read prevents stale effect", async (t) => {
  const f = await capacityStateFixture(t);
  let reads = 0,
    effects = 0,
    advanced = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      f.migrated.checkpoint,
      { kind: "dispatch", destination: "run:race" },
      async () => {
        if (++reads === 2) {
          const pending = f.git("rev-parse", coordinatorStateRef).trim();
          const state = await recoverReleaseOpportunity(f.repository, pending);
          assert.ok(isRecord(state.input.controller));
          state.input.controller.publication_paused = true;
          advanced = (await checkpointReleaseOpportunity(f.repository, pending, state.input))
            .checkpoint;
        }
        return f.capacity.boundary;
      },
      async () => {
        effects++;
      },
    ),
    CoordinatorRemoteError,
  );
  assert.equal(effects, 0);
  assert.equal(f.git("rev-parse", coordinatorStateRef).trim(), advanced);
  const retained = await recoverReleaseOpportunity(f.repository, advanced);
  assert.equal(retained.plan.action, "pause");
});
void test("invalid provider receipt stays bounded and unawaited receipt is drained", async (t) => {
  const f = await capacityStateFixture(t);
  let checkpoint = "";
  await assert.rejects(
    runBoundedCapacityOperation(
      f.repository,
      f.migrated.checkpoint,
      { kind: "upload", destination: "artifact:bounded" },
      async () => f.capacity.boundary,
      async (record) => {
        void record("artifact:valid", "e".repeat(64));
        void record("X".repeat(4096), "f".repeat(64));
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      checkpoint = String(error.evidence.checkpoint);
      assert.ok(JSON.stringify(error.evidence).length < 4096);
      return true;
    },
  );
  const state = await recoverReleaseOpportunity(f.repository, checkpoint);
  assert.ok(isRecord(state.input.controller) && isRecord(state.input.controller.capacity_attempt));
  const operation = state.input.controller.capacity_attempt.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.outcome, "ambiguous");
  assert.deepEqual(operation.completed_effects, [
    { remote_identity: "artifact:valid", evidence_sha256: "e".repeat(64) },
  ]);
});

for (const outcome of ["pending", "capacity-refused", "succeeded"]) {
  void test(
    `schema2 ${outcome} survives fresh sparse provider recovery with anti-repeat summary`,
    { timeout: 60000 },
    async (t) => {
      const f = await recoveryFixture(t),
        capacity = capacityFixture();
      const input = {
        ...f.input,
        schema_version: 2,
        controller: {
          workflow: f.input.controller.workflow,
          revision: f.input.controller.revision,
          publication_paused: false,
          capacity_attempt: capacity,
        },
      };
      const migrated = await checkpointReleaseOpportunity(f.repository, f.saved.checkpoint, input);
      const a = await runBoundedCapacityOperation(
        f.repository,
        migrated.checkpoint,
        { kind: "upload", destination: "artifact:earlier-A" },
        async () => capacity.boundary,
        async (record) => {
          await record("artifact:A", "a".repeat(64));
        },
      );
      let selected = "",
        pending = "";
      try {
        const b = await runBoundedCapacityOperation(
          f.repository,
          a.checkpoint,
          { kind: "upload", destination: "artifact:later-B" },
          async () => capacity.boundary,
          async (record) => {
            pending = f.git("rev-parse", coordinatorStateRef).trim();
            await record("artifact:B", "b".repeat(64));
            if (outcome === "capacity-refused")
              throw new ProviderCapacityRefusal("provider:refused-after-B", "c".repeat(64));
          },
        );
        selected = outcome === "pending" ? pending : b.checkpoint;
      } catch (error) {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        selected = String(error.evidence.checkpoint);
      }
      f.refs.set("refs/heads/portcove-fixture-coordinator-state", selected);
      const result = await recoverRemoteCoordinator(
        f.parent,
        { schema_version: 1, namespace: "portcove-fixture" },
        { transport: f.transport },
      );
      assert.equal(result.checkpoint, selected);
      assert.throws(() =>
        execFileSync("git", ["-C", result.repository, "cat-file", "-e", migrated.checkpoint], {
          windowsHide: true,
          stdio: "pipe",
        }),
      );
      assert.ok(
        isRecord(result.input.controller) && isRecord(result.input.controller.capacity_attempt),
      );
      const retained = result.input.controller.capacity_attempt;
      assert.ok(isRecord(retained.operation));
      assert.equal(retained.operation.outcome, outcome);
      assert.ok(Array.isArray(retained.prior_operations));
      assert.equal(retained.prior_operations.length, 1);
      await assert.rejects(
        runBoundedCapacityOperation(
          result.repository,
          selected,
          { kind: "upload", destination: "artifact:earlier-A" },
          async () => capacity.boundary,
          async () => {
            assert.fail("must not execute repeated/held effect");
          },
        ),
      );
    },
  );
}
void test(
  "metadata renewal uses durable remote journal without allocating or changing an active candidate",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const original = (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input;
    const input = structuredClone(original);
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    input.controller.capacity_attempt.schema_version = 2;
    const modern = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, modern.checkpoint, f.config, { api: f.api });
    let effects = 0;
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        modern.checkpoint,
        descriptor,
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        f.options,
      ),
      /seed absent/,
    );
    assert.equal(effects, 0);
    const seeded = await recordPublishedMetadata(f.bare, modern.checkpoint, published, f.options);
    const first = await runBoundedMetadataRenewalOperation(
      f.bare,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:timestamp" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        effects++;
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        assert.ok(isRecord(pending.operation.metadata_renewal));
        assert.equal(
          pending.operation.metadata_renewal.prior_repository_sha256,
          published.repository_sha256,
        );
        assert.equal(pending.operation.candidate, undefined);
        await record("qualification:timestamp-envelope", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(first.operation.outcome, "pending");
    const recovered = await recordCapacityReadback(
      f.bare,
      first.checkpoint,
      "effect-completed",
      "b".repeat(64),
      f.options,
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.bare,
      recovered.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:Pages" },
      async () => f.capacity.boundary,
      async (record) => record("qualification:Pages-generation", "c".repeat(64)),
      { ...f.options, maximumReceipts: 1 },
    );
    const resolved = await recordCapacityReadback(
      f.bare,
      second.checkpoint,
      "effect-completed",
      "d".repeat(64),
      f.options,
    );
    const saved = await recoverReleaseOpportunity(f.bare, resolved.checkpoint);
    assert.deepEqual(saved.input.active_candidate, original.active_candidate);
    assert.equal(saved.input.now, original.now);
    assert.ok(
      isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
    );
    const groups = saved.input.controller.capacity_attempt.prior_operations;
    assert.ok(
      Array.isArray(groups) &&
        isRecord(groups[0]) &&
        Array.isArray(groups[0].attempts) &&
        isRecord(groups[0].attempts[0]),
    );
    const proof = groups[0].attempts[0];
    const raw = readRetainedCapacityOperation(f.bare, {
      checkpoint: String(proof.checkpoint),
      id: String(proof.id),
      operation_sha256: String(proof.operation_sha256),
    });
    assert.equal(raw.id, first.operation.id);
    assert.throws(() =>
      readRetainedCapacityOperation(f.bare, {
        checkpoint: String(proof.checkpoint),
        id: String(proof.id),
        operation_sha256: "0".repeat(64),
      }),
    );
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        resolved.checkpoint,
        { ...descriptor, generated_at: descriptor.generated_at },
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => assert.fail("completed effect cannot repeat"),
        f.options,
      ),
      /repeat|recovery/,
    );
    const advanced = {
      ...published,
      repository_sha256: "e".repeat(64),
      snapshot_sha256: "f".repeat(64),
      timestamp_sha256: "0".repeat(64),
      versions: descriptor.next_versions,
      expires: descriptor.next_expires,
      operation_id: second.operation.id,
      publication: {
        remote_identity: "qualification:Pages-generation",
        evidence_sha256: "c".repeat(64),
        site_generation_sha256: "9".repeat(64),
      },
    };
    const final = await recordPublishedMetadata(f.bare, resolved.checkpoint, advanced, f.options);
    const finalInput = (await recoverReleaseOpportunity(f.bare, final.checkpoint)).input;
    assert.ok(isDeepStrictEqual(finalInput.active_candidate, original.active_candidate));
    assert.deepEqual(finalInput.published_metadata, advanced);
    assert.ok(isRecord(finalInput.controller) && isRecord(finalInput.controller.capacity_attempt));
    assert.deepEqual(finalInput.controller.capacity_attempt.prior_operations, []);
    assert.equal(f.refs.get(f.stateRef), final.checkpoint);
  },
);
void test(
  "metadata-only renewal needs no candidate and its compact state survives sparse import",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const before = (await recoverReleaseOpportunity(f.repository, f.initial.checkpoint)).input;
    const capacity = { ...capacityFixture(), schema_version: 2 };
    const input = {
      ...before,
      schema_version: 2,
      controller: {
        workflow: ".github/workflows/release-coordinator.yml",
        revision: "3".repeat(40),
        publication_paused: false,
        capacity_attempt: capacity,
      },
    };
    const migrated = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, input);
    const { descriptor, published } = metadataFixture();
    const seeded = await recordPublishedMetadata(f.repository, migrated.checkpoint, published);
    const first = await runBoundedMetadataRenewalOperation(
      f.repository,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:releases" },
      async () => capacity.boundary,
      async (record) => record("qualification:release-role", "a".repeat(64)),
      { maximumReceipts: 1 },
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.repository,
      first.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:preview" },
      async () => capacity.boundary,
      async (record) => record("qualification:preview-role", "b".repeat(64)),
      { maximumReceipts: 1 },
    );
    const transportRepository = path.join(f.repository, "metadata-transport.git");
    execFileSync("git", ["clone", "--mirror", "--quiet", f.repository, transportRepository], {
      windowsHide: true,
    });
    const exported = await exportCoordinatorCheckpoint(transportRepository, second.checkpoint);
    const sparse = path.join(f.repository, "metadata-sparse.git");
    execFileSync("git", ["init", "--bare", "--quiet", sparse], { windowsHide: true });
    const objects: { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }[] = [];
    for (const checkpoint of [exported.checkpoint, exported.previous]) {
      assert.ok(checkpoint);
      for (const [kind, suffix] of [
        ["commit", ""],
        ["tree", "^{tree}"],
        ["blob", ":state.json"],
      ] as const) {
        const oid = execFileSync(
          "git",
          ["-C", transportRepository, "rev-parse", checkpoint + suffix],
          { encoding: "utf8", windowsHide: true },
        ).trim();
        if (!objects.some((object) => object.oid === oid))
          objects.push({
            kind,
            oid,
            bytes: execFileSync("git", ["-C", transportRepository, "cat-file", kind, oid], {
              windowsHide: true,
            }),
          });
      }
    }
    await importCoordinatorCheckpoint(sparse, exported.checkpoint, objects);
    const restored = await recoverReleaseOpportunity(sparse, exported.checkpoint);
    assert.equal(restored.input.active_candidate, null);
    assert.deepEqual(restored.input.published_metadata, published);
    assert.equal(restored.input.now, before.now);
    assert.ok(
      isRecord(restored.input.controller) && isRecord(restored.input.controller.capacity_attempt),
    );
    const groups = restored.input.controller.capacity_attempt.prior_operations;
    assert.ok(Array.isArray(groups) && groups.length === 1);
    assert.throws(() =>
      execFileSync("git", ["-C", sparse, "cat-file", "-e", seeded.checkpoint], {
        windowsHide: true,
        stdio: "ignore",
      }),
    );
  },
);
