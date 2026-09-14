import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planReleaseOpportunity } from "./release-coordinator.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const commit = "1".repeat(40);
const tree = "2".repeat(40);
const controllerRevision = "3".repeat(40);
const baseCommit = "0".repeat(40);
const changeSet = "a".repeat(64);

function fixture(overrides = {}) {
  const input = {
    schema_version: 1,
    now: "2026-09-14T12:00:00.000Z",
    controller: {
      workflow: ".github/workflows/release-coordinator.yml",
      revision: controllerRevision,
      publication_paused: false,
      free_capacity_available: true,
    },
    opportunity: {
      source_commit: commit,
      source_tree: tree,
      base_commit: baseCommit,
      change_set_sha256: changeSet,
      complete_change_set: true,
      meaningful: true,
      documentation_only: false,
      urgency: false,
      requested_channel: "preview",
      classification: {
        source_commit: commit,
        reviewed_commit: commit,
        source_tree: tree,
        reviewed_tree: tree,
        change_set_sha256: changeSet,
        base_version: "0.1.0-alpha.2",
        change: "prerelease",
        compatibility: "compatible",
      },
    },
    publication: {
      complete: true,
      observed_at: "2026-09-14T11:59:00.000Z",
      published_versions: ["0.1.0-alpha.2"],
      published_sources: [],
      reserved_versions: [],
      last_routine_preview_at: null,
    },
    active_candidate: null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    input[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...input[key], ...value }
        : value;
  }
  return input;
}

function active(overrides = {}) {
  return {
    source_commit: commit,
    source_tree: tree,
    prepared_commit: "4".repeat(40),
    prepared_tree: "5".repeat(40),
    version: "0.1.0-alpha.3",
    intent_sha256: "6".repeat(64),
    phase: "qualifying",
    failure_kind: null,
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: null,
    ...overrides,
  };
}

test("prepares one deterministic Preview from complete reviewed authority", () => {
  const first = planReleaseOpportunity(fixture());
  const second = planReleaseOpportunity(fixture());
  assert.deepEqual(second, first);
  assert.equal(first.action, "prepare");
  assert.equal(first.proposal.version, "0.1.0-alpha.3");
  assert.equal(first.proposal.source_commit, commit);
  assert.equal(first.authority.opportunity_tree, tree);
  assert.equal(first.authority.change_set_sha256, changeSet);
  assert.match(first.authority.reviewed_classification_sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.plan_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.invocation, {
    preparation: "apps/desktop/scripts/prepare-release-version.mjs",
    qualification: ".github/workflows/qualification.yml",
    release: ".github/workflows/release.yml",
  });
});

test("skips docs-only and already-published snapshots without allocating", () => {
  assert.equal(
    planReleaseOpportunity(fixture({ opportunity: { documentation_only: true } })).action,
    "skip",
  );
  assert.equal(
    planReleaseOpportunity(fixture({ publication: { published_sources: [commit] } })).action,
    "skip",
  );
});

test("coalesces routine Preview work until the daily opportunity and lets urgency bypass cadence", () => {
  const publication = { last_routine_preview_at: "2026-09-14T00:00:01.000Z" };
  const deferred = planReleaseOpportunity(fixture({ publication }));
  assert.equal(deferred.action, "coalesce");
  assert.equal(deferred.next_opportunity_at, "2026-09-15T00:00:01.000Z");
  const urgent = planReleaseOpportunity(fixture({ publication, opportunity: { urgency: true } }));
  assert.equal(urgent.action, "prepare");
  assert.equal(urgent.urgency_bypassed_cadence, true);
});

test("Stable bypasses Preview cadence but remains impossible for public 0.x", () => {
  const stable = planReleaseOpportunity(
    fixture({
      publication: {
        last_routine_preview_at: "2026-09-14T00:00:01.000Z",
        published_versions: ["1.0.0"],
      },
      opportunity: {
        requested_channel: "stable",
        classification: {
          source_commit: commit,
          reviewed_commit: commit,
          source_tree: tree,
          reviewed_tree: tree,
          change_set_sha256: changeSet,
          base_version: "1.0.0",
          change: "patch",
          compatibility: "compatible",
        },
      },
    }),
  );
  assert.equal(stable.action, "prepare");
  assert.equal(stable.proposal.version, "1.0.1");
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({
          publication: { last_routine_preview_at: "2026-09-14T00:00:01.000Z" },
          opportunity: { requested_channel: "stable" },
        }),
      ),
    /cannot be production eligible/u,
  );
});

test("finishes an active frozen candidate and coalesces newer commits without cancellation", () => {
  const publication = { reserved_versions: ["0.1.0-alpha.3"] };
  const same = planReleaseOpportunity(fixture({ publication, active_candidate: active() }));
  assert.equal(same.action, "resume-active");
  assert.equal(same.queued_candidate, null);

  const newer = "7".repeat(40);
  const queued = planReleaseOpportunity(
    fixture({
      opportunity: {
        source_commit: newer,
        source_tree: "8".repeat(40),
        change_set_sha256: "b".repeat(64),
        classification: {
          source_commit: newer,
          reviewed_commit: newer,
          source_tree: "8".repeat(40),
          reviewed_tree: "8".repeat(40),
          change_set_sha256: "b".repeat(64),
          base_version: "0.1.0-alpha.2",
          change: "prerelease",
          compatibility: "compatible",
        },
      },
      publication,
      active_candidate: active(),
    }),
  );
  assert.equal(queued.action, "resume-active");
  assert.equal(queued.active_candidate.prepared_commit, "4".repeat(40));
  assert.equal(queued.active_candidate.intent_sha256, "6".repeat(64));
  assert.equal(queued.active_candidate.phase, "qualifying");
  assert.equal(queued.active_candidate.transient_retries, 0);
  assert.equal(queued.active_candidate.substantive_repairs, 0);
  assert.equal(queued.queued_candidate.source_commit, newer);

  const changedIntent = planReleaseOpportunity(
    fixture({
      publication,
      active_candidate: active({ intent_sha256: "9".repeat(64) }),
    }),
  );
  assert.notEqual(changedIntent.plan_sha256, same.plan_sha256);
});

test("enforces transient and substantive recovery budgets across restarts", () => {
  const publication = { reserved_versions: ["0.1.0-alpha.3"] };
  const transient = planReleaseOpportunity(
    fixture({
      publication,
      active_candidate: active({
        phase: "failed",
        failure_kind: "transient",
        transient_retries: 1,
      }),
    }),
  );
  assert.equal(transient.action, "retry-active");
  assert.equal(transient.retry_number, 2);
  assert.equal(
    planReleaseOpportunity(
      fixture({
        publication,
        active_candidate: active({
          phase: "failed",
          failure_kind: "transient",
          transient_retries: 2,
        }),
      }),
    ).action,
    "pause-exception",
  );
  const repair = planReleaseOpportunity(
    fixture({
      publication,
      active_candidate: active({
        phase: "failed",
        failure_kind: "substantive",
        substantive_repairs: 2,
      }),
    }),
  );
  assert.equal(repair.action, "dispatch-repair");
  assert.equal(repair.repair_number, 3);
  assert.equal(
    planReleaseOpportunity(
      fixture({
        publication,
        active_candidate: active({
          phase: "failed",
          failure_kind: "substantive",
          substantive_repairs: 3,
        }),
      }),
    ).action,
    "pause-exception",
  );
});

test("pause and free-capacity limits hold before candidate execution", () => {
  assert.equal(
    planReleaseOpportunity(fixture({ controller: { publication_paused: true } })).action,
    "pause",
  );
  assert.equal(
    planReleaseOpportunity(fixture({ controller: { free_capacity_available: false } })).action,
    "pause",
  );
});

test("rejects incomplete discovery, stale review, lost reservations, and run substitution", () => {
  assert.throws(
    () => planReleaseOpportunity(fixture({ publication: { complete: false } })),
    /inventory is incomplete/u,
  );
  assert.throws(
    () => planReleaseOpportunity(fixture({ opportunity: { complete_change_set: false } })),
    /complete accumulated change set/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({ opportunity: { classification: { source_commit: "9".repeat(40) } } }),
      ),
    /classification is stale/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({ opportunity: { classification: { reviewed_tree: "9".repeat(40) } } }),
      ),
    /classification is stale/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(fixture({ publication: { reserved_versions: ["0.1.0-alpha.3"] } })),
    /active-candidate recovery/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({
          publication: { reserved_versions: ["0.1.0-alpha.3"] },
          active_candidate: active({
            release_run: { run_id: 12, attempt: 1, revision: "a".repeat(40) },
          }),
        }),
      ),
    /not bound to the prepared commit/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({
          active_candidate: active(),
        }),
      ),
    /reservation inventory/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(fixture({ publication: { observed_at: "2026-09-14T11:40:00.000Z" } })),
    /inventory is stale/u,
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({ publication: { published_versions: ["0.1.0-alpha.2", "0.1.0-alpha.1"] } }),
      ),
    /published versions must be sorted/u,
  );
});

test("CLI emits the same exact plan from a bounded fixture file", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "portcove-release-coordinator-"));
  t.after(async () =>
    import("node:fs/promises").then(({ rm }) => rm(temporary, { recursive: true })),
  );
  const input = path.join(temporary, "input.json");
  await writeFile(input, JSON.stringify(fixture()));
  const output = execFileSync(process.execPath, ["scripts/release-coordinator.mjs", input], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(output), planReleaseOpportunity(fixture()));
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/release-coordinator.mjs", input], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PORTCOVE_CONTROLLER_REVISION: "9".repeat(40) },
        stdio: "pipe",
      }),
    /Command failed/u,
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/release-coordinator.mjs", input], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PORTCOVE_CONTROLLER_WORKFLOW: "other.yml" },
        stdio: "pipe",
      }),
    /Command failed/u,
  );
});

test("manual coordinator rehearsal is serialized, read-only, and default-branch bound", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release-coordinator.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /\n\s+(?:push|pull_request|schedule):/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.match(workflow, /group: release-coordinator/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /GITHUB_REF[^\n]+refs\/heads\/\$DEFAULT_BRANCH/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /PORTCOVE_CONTROLLER_REVISION: \$\{\{ github\.sha \}\}/u);
  assert.match(
    workflow,
    /PORTCOVE_CONTROLLER_WORKFLOW: \.github\/workflows\/release-coordinator\.yml/u,
  );
  assert.doesNotMatch(
    workflow,
    /contents: write|actions: write|secrets\.|gh release|workflow run release/u,
  );
});
