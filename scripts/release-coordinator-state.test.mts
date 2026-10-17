import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
} from "./release-coordinator-state.mts";

const execute = promisify(execFile);
const moduleUrl = new URL("./release-coordinator-state.mts", import.meta.url).href;

async function fixture(t: test.TestContext) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "portcove-coordinator-state-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      windowsHide: true,
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
