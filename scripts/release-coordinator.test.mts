import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import { validateCapacityTransition } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { planReleaseOpportunity } from "./release-coordinator.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const commit = "1".repeat(40);
const tree = "2".repeat(40);
const controllerRevision = "3".repeat(40);
const baseCommit = "0".repeat(40);
const changeSet = "a".repeat(64);

void test("explicit initial metadata can have no semantic opportunity without inventing release identity", () => {
  const { descriptor } = metadataBootstrapFixture();
  const now = new Date(descriptor.generated_at).toISOString();
  const input = fixture({
    schema_version: 2,
    now,
    opportunity: null,
    metadata_bootstrap: descriptor,
  });
  const publication = input.publication;
  assert.ok(isRecord(publication));
  publication.observed_at = now;
  const controller = {
    workflow: ".github/workflows/application-update-production.yml",
    revision: controllerRevision,
    publication_paused: false,
    capacity_attempt: { ...capacityFixture(), schema_version: 2 },
  };
  input.controller = controller;
  const ready = planReleaseOpportunity(input);
  assert.equal(ready.action, "skip");
  for (const key of [
    "opportunity_commit",
    "opportunity_tree",
    "opportunity_base_commit",
    "reviewed_classification_sha256",
    "change_set_sha256",
  ])
    assert.equal(Object.hasOwn(ready.authority, key), false);
  assert.equal(
    planReleaseOpportunity({
      ...input,
      controller: { ...controller, publication_paused: true },
    }).action,
    "pause",
  );
  assert.throws(
    () => planReleaseOpportunity({ ...input, metadata_bootstrap: null }),
    /explicit initial/,
  );
  assert.throws(
    () =>
      planReleaseOpportunity({
        ...input,
        publication: { ...publication, reserved_versions: ["0.1.0-alpha.3"] },
      }),
    /without a reservation/,
  );
  const existing = { ...input, opportunity: fixture().opportunity };
  assert.throws(() => validateCapacityTransition(existing, input, "f".repeat(40)), /cannot erase/);
});

function fixture(overrides: Record<string, unknown> = {}) {
  const input: Record<string, unknown> = {
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
    input[key] = isRecord(value)
      ? { ...(isRecord(input[key]) ? input[key] : {}), ...value }
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

void test("explicit complete all-Preview history is a conservative cadence upper bound", () => {
  const exact = fixture({
    publication: { last_routine_preview_at: "2026-09-13T11:00:00.000Z" },
  });
  assert.equal(planReleaseOpportunity(exact).action, "prepare");
  const mixed = fixture({
    publication: {
      // This later Preview may have been urgent; including it can delay a
      // routine candidate but cannot let one bypass the real routine cadence.
      last_routine_preview_at: "2026-09-14T10:00:00.000Z",
      last_routine_preview_bound: "all-published-previews",
    },
  });
  const bound = planReleaseOpportunity(mixed);
  assert.equal(bound.action, "coalesce");
  assert.ok("next_opportunity_at" in bound);
  assert.equal(bound.next_opportunity_at, "2026-09-15T10:00:00.000Z");
  const sameTimeExact = structuredClone(mixed);
  assert.ok(isRecord(sameTimeExact.publication));
  delete sameTimeExact.publication.last_routine_preview_bound;
  assert.equal(planReleaseOpportunity(sameTimeExact).action, bound.action);
  assert.notEqual(planReleaseOpportunity(sameTimeExact).plan_sha256, bound.plan_sha256);
  assert.equal(
    planReleaseOpportunity(
      fixture({ publication: { last_routine_preview_bound: "all-published-previews" } }),
    ).action,
    "prepare",
  );
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({ publication: { last_routine_preview_bound: "routine-assumed" } }),
      ),
    /upper-bound scope/,
  );
});

void test("immutable delivered legacy prepare/resume/retry/repair serializations remain unchanged", async () => {
  const oracle: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-coordinator-legacy.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(oracle) && Array.isArray(oracle.rows));
  assert.equal(oracle.source_revision, "799da5783d339b61748de78c372c746f3011164b");
  assert.equal(
    oracle.source_sha256,
    "43412a89993e0eedc675d80db898390f5f0a2b40fe6c712ec67a23824c60dbac",
  );
  assert.equal(oracle.rows.length, 4);
  for (const row of oracle.rows) {
    assert.ok(isRecord(row));
    const result = planReleaseOpportunity(row.input);
    assert.equal(result.action, row.action);
    assert.equal(
      createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      row.serialized_sha256,
    );
    if ("active_candidate" in result && isRecord(result.active_candidate))
      assert.equal(Object.hasOwn(result.active_candidate, "frozen_opportunity"), false);
  }
});

void test("an explicit frozen opportunity survives queued source changes and all active recovery plans", () => {
  const original = fixture().opportunity;
  for (const change of [
    {},
    { phase: "failed", failure_kind: "transient" },
    { phase: "failed", failure_kind: "substantive" },
  ]) {
    const request = fixture({
      active_candidate: active({ ...change, frozen_opportunity: structuredClone(original) }),
      publication: { reserved_versions: ["0.1.0-alpha.3"] },
    });
    assert.ok(isRecord(request.opportunity) && isRecord(request.opportunity.classification));
    request.opportunity.source_commit = "7".repeat(40);
    request.opportunity.classification = {
      ...request.opportunity.classification,
      source_commit: "7".repeat(40),
      reviewed_commit: "7".repeat(40),
    };
    const result = planReleaseOpportunity(request);
    assert.ok("active_candidate" in result && isRecord(result.active_candidate));
    assert.deepEqual(result.active_candidate.frozen_opportunity, original);
    assert.equal(result.active_candidate.source_commit, commit);
    const legacy = structuredClone(request);
    assert.ok(isRecord(legacy.active_candidate));
    delete legacy.active_candidate.frozen_opportunity;
    assert.notEqual(planReleaseOpportunity(legacy).plan_sha256, result.plan_sha256);
  }
  for (const frozen of [
    null,
    [],
    { ...(isRecord(original) ? original : {}), source_commit: "8".repeat(40) },
  ])
    assert.throws(() =>
      planReleaseOpportunity(fixture({ active_candidate: active({ frozen_opportunity: frozen }) })),
    );
});

void test("prepares one deterministic Preview from complete reviewed authority", () => {
  const first = planReleaseOpportunity(fixture());
  const second = planReleaseOpportunity(fixture());
  assert.deepEqual(second, first);
  assert.equal(first.action, "prepare");
  assert.equal(first.proposal.version, "0.1.0-alpha.3");
  assert.equal(first.proposal.source_commit, commit);
  assert.equal(first.authority.opportunity_tree, tree);
  assert.equal(first.authority.change_set_sha256, changeSet);
  assert.equal(typeof first.authority.reviewed_classification_sha256, "string");
  assert.match(first.authority.reviewed_classification_sha256!, /^[a-f0-9]{64}$/u);
  assert.match(first.plan_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.invocation, {
    preparation: "apps/desktop/scripts/prepare-release-version.mts",
    qualification: ".github/workflows/qualification.yml",
    release: ".github/workflows/release.yml",
  });
});

void test("skips docs-only and already-published snapshots without allocating", () => {
  assert.equal(
    planReleaseOpportunity(fixture({ opportunity: { documentation_only: true } })).action,
    "skip",
  );
  assert.equal(
    planReleaseOpportunity(fixture({ publication: { published_sources: [commit] } })).action,
    "skip",
  );
});

void test("coalesces routine Preview work until the daily opportunity and lets urgency bypass cadence", () => {
  const publication = { last_routine_preview_at: "2026-09-14T00:00:01.000Z" };
  const deferred = planReleaseOpportunity(fixture({ publication }));
  assert.equal(deferred.action, "coalesce");
  assert.equal(deferred.next_opportunity_at, "2026-09-15T00:00:01.000Z");
  const urgent = planReleaseOpportunity(fixture({ publication, opportunity: { urgency: true } }));
  assert.equal(urgent.action, "prepare");
  assert.equal(urgent.urgency_bypassed_cadence, true);
});

void test("Stable bypasses Preview cadence but remains impossible for public 0.x", () => {
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

void test("finishes an active frozen candidate and coalesces newer commits without cancellation", () => {
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
  assert.ok(queued.queued_candidate);
  assert.equal(queued.queued_candidate.source_commit, newer);

  const changedIntent = planReleaseOpportunity(
    fixture({
      publication,
      active_candidate: active({ intent_sha256: "9".repeat(64) }),
    }),
  );
  assert.notEqual(changedIntent.plan_sha256, same.plan_sha256);
});

void test("enforces transient and substantive recovery budgets across restarts", () => {
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

void test("pause and free-capacity limits hold before candidate execution", () => {
  assert.equal(
    planReleaseOpportunity(fixture({ controller: { publication_paused: true } })).action,
    "pause",
  );
  assert.equal(
    planReleaseOpportunity(fixture({ controller: { free_capacity_available: false } })).action,
    "pause",
  );
});

void test("rejects incomplete discovery, stale review, lost reservations, and run substitution", () => {
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

void test("CLI emits the same exact plan from a bounded fixture file", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "portcove-release-coordinator-"));
  t.after(async () =>
    import("node:fs/promises").then(({ rm }) => rm(temporary, { recursive: true })),
  );
  const input = path.join(temporary, "input.json");
  await writeFile(input, JSON.stringify(fixture()));
  const output = execFileSync(process.execPath, ["scripts/release-coordinator.mts", input], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(output), planReleaseOpportunity(fixture()));
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/release-coordinator.mts", input], {
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
      execFileSync(process.execPath, ["scripts/release-coordinator.mts", input], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PORTCOVE_CONTROLLER_WORKFLOW: "other.yml" },
        stdio: "pipe",
      }),
    /Command failed/u,
  );
});

void test("manual coordinator rehearsal is serialized, read-only, and default-branch bound", async () => {
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
  assert.match(workflow, /set -o pipefail\s+node scripts\/release-coordinator\.mts[^\n]+\| tee/u);
  assert.doesNotMatch(
    workflow,
    /contents: write|actions: write|secrets\.|gh release|workflow run release/u,
  );
});

void test("coordinator rejects array-valued intent digests before resuming", () => {
  assert.throws(
    () =>
      planReleaseOpportunity(
        fixture({
          active_candidate: active({ intent_sha256: ["6".repeat(64)] }),
          publication: { reserved_versions: ["0.1.0-alpha.3"] },
        }),
      ),
    /intent digest is invalid/,
  );
});

void test("schema2 uses bounded eligibility with Unknown availability and preserves pause/reservation limits", () => {
  const input = fixture();
  input.schema_version = 2;
  input.controller = {
    workflow: ".github/workflows/release-coordinator.yml",
    revision: controllerRevision,
    publication_paused: false,
    capacity_attempt: capacityFixture(),
  };
  const ready = planReleaseOpportunity(input);
  assert.equal(ready.action, "prepare");
  assert.equal(ready.authority.capacity_attempt?.availability, "unknown");
  assert.throws(
    () =>
      planReleaseOpportunity({
        ...input,
        controller: { ...(input.controller as object), free_capacity_available: true },
      }),
    /unknown field/,
  );
  const held = planReleaseOpportunity({
    ...input,
    controller: { ...(input.controller as object), publication_paused: true },
  });
  assert.equal(held.action, "pause");
  const unavailable = capacityFixture();
  unavailable.boundary.stop_usage = false;
  const heldActive = planReleaseOpportunity({
    ...input,
    controller: { ...(input.controller as object), capacity_attempt: unavailable },
    publication: { ...(input.publication as object), reserved_versions: ["0.1.0-alpha.3"] },
    active_candidate: active(),
  });
  assert.equal(heldActive.action, "pause");
  assert.ok("active_candidate" in heldActive);
  assert.ok(isRecord(heldActive.active_candidate));
  assert.equal(heldActive.active_candidate.phase, "qualifying");
  const exhausted = planReleaseOpportunity({
    ...input,
    publication: { ...(input.publication as object), reserved_versions: ["0.1.0-alpha.3"] },
    active_candidate: active({ phase: "failed", failure_kind: "transient", transient_retries: 2 }),
  });
  assert.equal(exhausted.action, "pause-exception");
});
