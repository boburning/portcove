import {
  inspectSelectedPublicationAuthorityConfiguration,
  applicationReleaseProfile,
} from "./release-authority-configuration-contract.mts";
import { inspectReleaseProfile } from "./release-package-policy.mts";
/** Read-only acknowledgement of a report-only workflow invocation. This never
 * grants admission, signing custody or publication eligibility. */
import assert from "node:assert/strict";
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import {
  inspectPublicationReportRepair,
  reportRepairDispatchDestination,
} from "./release-report-repair-contract.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";

export function inspectReportRepairIdentity(
  raw: unknown,
  environment: Record<string, string | undefined>,
  run: unknown,
) {
  assert.ok(
    isRecord(raw) &&
      isRecord(raw.active_candidate) &&
      isRecord(raw.controller) &&
      isRecord(raw.controller.capacity_attempt),
  );
  const candidate = raw.active_candidate,
    operation = raw.controller.capacity_attempt.operation;
  const proof = inspectPublicationReportRepair(candidate.report_repair, candidate);
  assert.equal(environment.PORTCOVE_REPORT_REPAIR_SHA256, digest(proof));
  assert.equal(candidate.transient_retries, proof.expected_transient_retry);
  assert.ok(
    ["prepared", "qualifying", "building", "publishing", "promoting"].includes(
      String(candidate.phase),
    ),
  );
  assert.ok(
    isRecord(operation) && isRecord(operation.candidate) && isRecord(operation.executor_identity),
  );
  assert.equal(operation.kind, "dispatch");
  assert.equal(operation.destination, reportRepairDispatchDestination(candidate));
  assert.equal(operation.receipt_limit, 1);
  assert.equal(operation.executor_identity.role, "coordinator");
  assert.equal(
    operation.executor_identity.workflow,
    ".github/workflows/application-update-production.yml",
  );
  for (const key of [
    "source_commit",
    "prepared_commit",
    "version",
    "transient_retries",
    "substantive_repairs",
  ])
    assert.equal(operation.candidate[key], candidate[key]);
  assert.equal(environment.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(environment.GITHUB_REPOSITORY_ID, "1354613114");
  assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(environment.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(environment.GITHUB_SHA, candidate.prepared_commit);
  const authorities: unknown = JSON.parse(environment.PORTCOVE_RELEASE_AUTHORITIES ?? "null");
  assert.ok(isRecord(authorities));
  const selected =
    authorities.schema_version === 4
      ? inspectSelectedPublicationAuthorityConfiguration(authorities)
      : null;
  if (selected) assert.equal(selected.purpose, "application");
  else
    assert.ok(
      authorities.repository_id === 1354613114 &&
        isRecord(authorities.apps) &&
        isRecord(authorities.apps.dispatch),
    );
  const actor = selected
    ? operation.executor_identity.actor_id
    : isRecord(authorities.apps) && isRecord(authorities.apps.dispatch)
      ? authorities.apps.dispatch.actor_id
      : undefined;
  assert.ok(typeof actor === "string" && /^[1-9][0-9]*$/u.test(actor));
  assert.equal(
    inspectReleaseProfile(environment.PORTCOVE_RELEASE_PROFILE),
    selected ? applicationReleaseProfile(selected) : "initial-beta-win-linux",
  );
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: selected ? selected.journal.namespace : authorities.namespace,
  });
  assert.equal(
    environment.GITHUB_REF,
    `refs/tags/${namespace}-prepared/v${String(candidate.version)}`,
  );
  assert.equal(environment.GITHUB_ACTOR_ID, actor);
  assert.equal(
    environment.GITHUB_WORKFLOW_REF,
    `boburning/portcove/.github/workflows/release.yml@${environment.GITHUB_REF}`,
  );
  assert.ok(
    isRecord(run) &&
      isRecord(run.repository) &&
      isRecord(run.actor) &&
      isRecord(run.triggering_actor),
  );
  assert.equal(String(run.id), environment.GITHUB_RUN_ID);
  assert.equal(run.repository.id, 1354613114);
  assert.equal(run.repository.full_name, "boburning/portcove");
  assert.equal(run.path, ".github/workflows/release.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_sha, candidate.prepared_commit);
  assert.equal(run.head_branch, environment.GITHUB_REF.slice("refs/tags/".length));
  assert.equal(run.run_attempt, 1);
  assert.ok(["in_progress", "completed"].includes(String(run.status)));
  assert.equal(String(run.actor.id), actor);
  assert.equal(String(run.triggering_actor.id), actor);
  assert.equal(run.display_title, `Report repair ${digest(proof)}`);
  assert.ok(Array.isArray(operation.completed_effects) && operation.completed_effects.length <= 1);
  if (operation.completed_effects.length === 1) {
    assert.ok(isRecord(operation.completed_effects[0]));
    assert.equal(
      operation.completed_effects[0].remote_identity,
      `github-actions:boburning/portcove:run:${environment.GITHUB_RUN_ID}:attempt:1`,
    );
    assert.ok(
      operation.outcome === "succeeded" ||
        (operation.outcome === "recovered" &&
          isRecord(operation.recovery) &&
          operation.recovery.resolution === "effect-completed"),
    );
  } else
    assert.ok(
      ["pending", "ambiguous", "capacity-refused"].includes(String(operation.outcome)),
      "report dispatch intent is not unresolved or positively settled",
    );
  return {
    report_only_repair: true,
    report_repair_sha256: digest(proof),
    authority: "none" as const,
  };
}

async function main() {
  const env = { ...process.env },
    start = performance.now(),
    deadline = start + 60000;
  assert.ok(/^[a-f0-9]{64}$/u.test(env.PORTCOVE_REPORT_REPAIR_SHA256 ?? ""));
  assert.ok(/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? ""));
  const authorities: unknown = JSON.parse(env.PORTCOVE_RELEASE_AUTHORITIES ?? "null");
  assert.ok(isRecord(authorities));
  const selected =
    authorities.schema_version === 4
      ? inspectSelectedPublicationAuthorityConfiguration(authorities)
      : null;
  if (selected) assert.equal(selected.purpose, "application");
  const configuration = {
    schema_version: 1,
    namespace: selected ? selected.journal.namespace : authorities.namespace,
  };
  inspectCoordinatorRemoteNamespace(configuration);
  const snapshot = await readRemoteCoordinatorSnapshot(process.cwd(), configuration, {
    transport: { cwd: process.cwd(), deadline },
  });
  const api = new GitHubApiClient((args, input) => {
    const timeoutMs = Math.floor(Math.min(15000, deadline - performance.now()));
    assert.ok(timeoutMs > 0);
    return createGitHubRunner({ cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024, timeoutMs })(
      [...args, "--hostname", "github.com"],
      input,
    );
  });
  const route = `repos/boburning/portcove/actions/runs/${env.GITHUB_RUN_ID}`;
  const observed = api.request("GET", route);
  assert.equal(observed.status, 200);
  inspectReportRepairIdentity(snapshot.input, env, observed.body);
  const again = await readRemoteCoordinatorSnapshot(process.cwd(), configuration, {
    transport: { cwd: process.cwd(), deadline },
  });
  assert.equal(again.checkpoint, snapshot.checkpoint);
  assert.equal(digest(again.input), digest(snapshot.input));
  assert.ok(performance.now() < deadline && env.GITHUB_OUTPUT);
  await appendFile(env.GITHUB_OUTPUT, "report_only_repair=true\n");
}
if (
  process.argv[1] &&
  /(?:^|[\\/])release-report-repair-identity\.mts$/u.test(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error("report-only dispatch identity refused; retain current journal intent");
    process.exitCode = 1;
  });
