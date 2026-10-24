import { capacityFixture } from "./release-capacity-fixture.mts";
import { capacityDigest, assessBoundedCapacity } from "../release-capacity.mts";
import { recordPublishedMetadata } from "../release-capacity-operation.mts";
import { metadataFixture, metadataBootstrapFixture } from "./release-metadata-fixture.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { isRecord } from "../runtime-values.mts";
import { prepareReleaseVersion } from "../../apps/desktop/scripts/prepare-release-version.mts";
import {
  checkpointReleaseOpportunity,
  exportCoordinatorCheckpoint,
} from "../release-coordinator-state.mts";
import { publishCoordinatorCheckpoint } from "../release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "../release-coordinator-remote.mts";
import {
  coordinatorCheckpointEvidenceSubject,
  coordinatorCheckpointPredicateType,
} from "../release-coordinator-checkpoint-evidence.mts";
import { productionControllerWorkflow } from "../production-controller-admission.mts";

export async function recoveryFixture(
  t: test.TestContext,
  signed = false,
  publishedSeed = false,
  pendingContext = false,
) {
  const local = await fixture(t, signed);
  let saved = await checkpointReleaseOpportunity(
    local.repository,
    local.initial.checkpoint,
    local.input,
  );
  if (publishedSeed) {
    const bounded = await checkpointReleaseOpportunity(local.repository, saved.checkpoint, {
      ...local.input,
      schema_version: 2,
      controller: {
        workflow: local.input.controller.workflow,
        revision: local.input.controller.revision,
        publication_paused: false,
        capacity_attempt: capacityFixture(),
      },
    });
    // Declared fixture feed, never public/Tough acceptance. Keep renewal outside
    // its due window so this case still reaches active resumption authority.
    saved = await recordPublishedMetadata(
      local.repository,
      bounded.checkpoint,
      metadataFixture(Date.now() + 2 * 86_400_000).published,
    );
  }
  if (pendingContext) {
    const { descriptor } = metadataBootstrapFixture();
    const capacity = capacityFixture();
    const ready = assessBoundedCapacity(capacity);
    assert.equal(ready.eligibility, "eligible");
    const identity = {
      before_checkpoint: saved.checkpoint,
      metadata_bootstrap: {
        descriptor_sha256: capacityDigest(descriptor),
        setup_plan_sha256: descriptor.setup_plan_sha256,
        initial_site_preimage_sha256: descriptor.initial_site_preimage_sha256,
        observed_at: descriptor.generated_at,
        transient_retries: 0,
        substantive_repairs: 0,
      },
      destination: "github-actions:boburning/portcove:metadata-bootstrap-context",
      executor_nonce: "2".repeat(64),
      executor_identity: {
        actor_id: "43177418",
        check_run_id: "777",
        controller_revision: "3".repeat(40),
        execution_ref: "refs/tags/portcove-production-controller-fixture",
        job_id: 501,
        role: "coordinator",
        run_attempt: 1,
        run_id: "54321",
        workflow: productionControllerWorkflow,
      },
      receipt_limit: 1,
      kind: "upload",
      policy_sha256: ready.resource_policy_sha256,
      ratification_sha256: ready.ratification_sha256,
      sequence: 1,
    };
    saved = await checkpointReleaseOpportunity(local.repository, saved.checkpoint, {
      ...local.input,
      schema_version: 2,
      metadata_bootstrap: descriptor,
      controller: {
        workflow: local.input.controller.workflow,
        revision: local.input.controller.revision,
        publication_paused: false,
        capacity_attempt: {
          ...capacity,
          schema_version: 2,
          operation: {
            ...identity,
            id: capacityDigest(identity),
            outcome: "pending",
            completed_effects: [],
            failure_evidence: null,
            recovery: null,
          },
        },
      },
    });
  }
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

export function gitObject(kind: string, bytes: Buffer) {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}

export async function remoteFixture(t: test.TestContext, now?: string) {
  const local = await fixture(t);
  if (now !== undefined) local.input.now = now;
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
  const objects = new Map<string, { kind: string; body: Record<string, unknown>; bytes: Buffer }>();
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
        const stored = objects.get(oid);
        if (stored) {
          const value =
            stored.kind === "blobs"
              ? {
                  sha: oid,
                  encoding: "base64",
                  content: stored.bytes.toString("base64"),
                  size: stored.bytes.length,
                }
              : stored.kind === "trees"
                ? { sha: oid, tree: stored.body.tree, truncated: false }
                : { ...stored.body, sha: oid, tree: { sha: stored.body.tree } };
          return reply(value);
        }
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
        assert.ok(Array.isArray(body.tree));
        assert.ok([1, 2].includes(body.tree.length));
        const names = body.tree.map((entry: unknown) => (isRecord(entry) ? entry.path : null));
        assert.deepEqual(
          names,
          body.tree.length === 1 ? ["state.json"] : ["bundle.sigstore.json", "transition.json"],
        );
        bytes = Buffer.concat(
          body.tree.flatMap((entry: unknown) => {
            assert.ok(isRecord(entry));
            assert.equal(entry.mode, "100644");
            assert.equal(entry.type, "blob");
            assert.ok(typeof entry.sha === "string" && blobs.has(entry.sha));
            return [Buffer.from(`100644 ${String(entry.path)}\0`), Buffer.from(entry.sha, "hex")];
          }),
        );
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
      objects.set(oid, { kind, body, bytes });
      if (faults.object === "evidence-commits" && posts === 7)
        throw new Error("proof object response lost");
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
            /^refs\/(?:heads\/portcove-fixture-coordinator-state|tags\/portcove-fixture-(?:prepared(?:-source)?|checkpoint-proof)\/.+)$/u,
          );
        }
        if (faults.mutation === "before")
          throw new Error("bounded fixture response lost before CAS");
        for (const value of updates) {
          assert.ok(isRecord(value));
          if (
            faults.mutation !== "partial-proof" ||
            !String(value.name).includes("-checkpoint-proof/")
          )
            refs.set(String(value.name), String(value.afterOid));
        }
        if (faults.mutation === "partial-proof") throw new Error("partial provider effect");
        if (faults.mutation === "after") throw new Error("bounded fixture response lost after CAS");
        if (faults.mutation === "concurrent") refs.set(stateRef, "e".repeat(40));
        return { data: { updateRefs: { clientMutationId: input.clientMutationId } } };
      }
      snapshots++;
      if (typeof variables.name === "string") {
        const name = variables.name;
        const oid = refs.get(name);
        const split = name.indexOf("/", 5) + 1;
        const ref = oid
          ? {
              name: name.slice(split),
              prefix: name.slice(0, split),
              target: { __typename: "Commit", oid },
            }
          : null;
        return {
          data: {
            repository: { databaseId: 1354613114, nameWithOwner: "boburning/portcove", ref },
          },
        };
      }
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
    objects,
    faults,
    api,
    counts: () => ({ posts, mutations, snapshots }),
    requests: () => requests,
  };
}

export async function fixture(t: test.TestContext, signed = false) {
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

export function checkpointEvidence(f: Awaited<ReturnType<typeof remoteFixture>>, salt = "first") {
  const subject = coordinatorCheckpointEvidenceSubject(f.checkpoint, f.config, {
    actor_id: "41898282",
    check_run_id: "111",
    configuration_sha256: "1".repeat(64),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    controller_revision: "2".repeat(40),
    job_id: "222",
    run_attempt: 1,
    run_id: "333",
    setup_sha256: "3".repeat(64),
    workflow_sha256: "4".repeat(64),
  });
  const sha256 = createHash("sha256").update(subject).digest("hex");
  const parsed = JSON.parse(subject.toString()) as { producer: unknown };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "portcove-coordinator-checkpoint-transition", digest: { sha256 } }],
    predicateType: coordinatorCheckpointPredicateType,
    predicate: { schema_version: 1, transition_sha256: sha256, producer: parsed.producer },
  };
  // Deliberately NOT a signed/verified bundle. Transport must never promote it.
  const bundle = Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        signatures: [{ keyid: "inert", sig: Buffer.from(salt).toString("base64") }],
      },
    }),
  );
  return { subject, bundle };
}

export async function remoteCapacityFixture(t: test.TestContext, modern = false) {
  const f = await remoteFixture(t);
  await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api });
  const capacity = { ...capacityFixture(), schema_version: modern ? 2 : 1 };
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
