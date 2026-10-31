import { nativePlatformsForReleaseProfile } from "./release-package-policy.mts";
/** Scheduling only. An available artifact is never signature/native acceptance. */
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";
import {
  hostedNativeArchiveLimit,
  hostedNativeArtifactName,
} from "./release-hosted-native-artifact.mts";
import {
  inspectCompleteRunArtifactInventory,
  readCompleteRunArtifactInventory,
} from "./release-run-artifact-inventory.mts";
import { currentPayloadJobDeadline } from "./release-signing-job-budget.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { slice4CapacityResources } from "./release-capacity.mts";
import type { requireControllerJobCredentialRoute } from "./release-authority-configuration.mts";

export function inspectNativePreSignReadiness(
  rawJobs: unknown,
  rawArtifacts: unknown,
  run: string,
  revision: string,
  profile: unknown = "initial-beta-win-linux",
) {
  assert.match(run, /^[1-9][0-9]{0,15}$/u);
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.ok(isRecord(rawJobs) && Array.isArray(rawJobs.jobs));
  const jobs: unknown[] = rawJobs.jobs;
  assert.ok(
    Number.isSafeInteger(rawJobs.total_count) &&
      Number(rawJobs.total_count) >= 0 &&
      Number(rawJobs.total_count) <= 100,
  );
  assert.equal(jobs.length, rawJobs.total_count);
  const ids = new Set<number>();
  for (const job of jobs) {
    assert.ok(
      isRecord(job) &&
        Number.isSafeInteger(job.id) &&
        Number(job.id) > 0 &&
        !ids.has(Number(job.id)),
    );
    ids.add(Number(job.id));
  }
  const inventory = inspectCompleteRunArtifactInventory(rawArtifacts);
  return nativePlatformsForReleaseProfile(profile).map((platform) => {
    const name = hostedNativeJobProfile(platform).job;
    const matches = jobs.filter((job) => isRecord(job) && job.name === name);
    assert.ok(matches.length <= 1, "ambiguous native pre-sign job");
    const job = matches[0];
    if (job !== undefined) {
      assert.ok(isRecord(job));
      assert.equal(typeof job.run_id, "number");
      assert.equal(String(job.run_id), run);
      assert.equal(job.run_attempt, 1);
      assert.equal(job.head_sha, revision);
      assert.ok(
        typeof job.status === "string" &&
          ["queued", "waiting", "pending", "in_progress", "completed"].includes(job.status),
      );
      assert.equal(
        job.conclusion,
        job.status === "completed" ? "success" : null,
        "native pre-sign job refused; retain and recover",
      );
    }
    const artifactName = hostedNativeArtifactName({
      controller_revision: revision,
      run_id: run,
      run_attempt: 1,
      platform_label: platform,
      stage: "payload-signing",
    });
    const artifacts = inventory.artifacts.filter((row) => row.name === artifactName);
    assert.ok(artifacts.length <= 1, "ambiguous native pre-sign artifact");
    const artifact = artifacts[0];
    if (artifact !== undefined) {
      assert.ok(
        isRecord(job) && ["in_progress", "completed"].includes(String(job.status)),
        "native artifact has no started producer",
      );
      assert.equal(artifact.expired, false);
      assert.ok(
        typeof artifact.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
      );
      assert.ok(
        Number.isSafeInteger(artifact.size_in_bytes) &&
          Number(artifact.size_in_bytes) >= 22 &&
          Number(artifact.size_in_bytes) <= hostedNativeArchiveLimit,
      );
      assert.ok(isRecord(artifact.workflow_run));
      assert.equal(String(artifact.workflow_run.id), run);
      assert.equal(artifact.workflow_run.head_sha, revision);
      assert.equal(artifact.workflow_run.repository_id, 1354613114);
      assert.equal(artifact.workflow_run.head_repository_id, 1354613114);
    }
    return {
      platform,
      job_id: isRecord(job) ? Number(job.id) : null,
      artifact_id: artifact ? Number(artifact.id) : null,
      ready: artifact !== undefined,
    };
  });
}

export async function waitForNativePreSignReadiness(input: {
  run: string;
  revision: string;
  release_profile?: unknown;
  active: () => void;
  read: () => { jobs: unknown; artifacts: unknown };
  retain: (value: unknown) => Promise<void>;
  pause: () => Promise<void>;
}) {
  for (let observation = 0; observation < 120; observation++) {
    input.active();
    const raw = input.read();
    input.active();
    const producers = inspectNativePreSignReadiness(
      raw.jobs,
      raw.artifacts,
      input.run,
      input.revision,
      input.release_profile,
    );
    await input.retain({ observation, producers, authority: "none" });
    input.active();
    if (producers.every((producer) => producer.ready))
      return { prerequisites_observed: true, authority: "none" } as const;
    await input.pause();
    input.active();
  }
  throw new Error("native pre-sign observation bound exhausted; retain and recover");
}

/** Before any legacy App/key release. The job token already exists; this code
 * confines its use to bounded GETs, without claiming provider attenuation. */
export async function waitForOriginalPayloadNativeProof(
  captured: Awaited<ReturnType<typeof requireControllerJobCredentialRoute>>,
) {
  captured.recheck();
  if (captured.route.phase !== "payload" || captured.route.credential_transport !== "fixed-job")
    return;
  const source = captured.route.source;
  const identity = {
    controller_revision: source.controller_revision,
    controller_ref: source.controller_ref,
    run_id: String(source.run_id),
    run_attempt: source.run_attempt,
  };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const deadline = currentPayloadJobDeadline(identity, root, performance.now() + 570000);
  const active = () => {
    captured.recheck();
    assert.ok(performance.now() < deadline, "original payload prerequisite clock exhausted");
  };
  active();
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  const record = await open(
    path.join(process.env.RUNNER_TEMP, "native-pre-sign-prerequisites.jsonl"),
    "wx",
    0o600,
  );
  let bytes = 0;
  // The original clock lookup consumed one GET. Pages and later polls share
  // this finite request allowance, rather than renewing it per inventory.
  let requests = 1,
    lastStatus: number | null = null;
  const retain = async (value: unknown) => {
    const line = Buffer.from(`${JSON.stringify(value)}\n`);
    bytes += line.length;
    assert.ok(
      bytes <= slice4CapacityResources.native_presign_receipt_bytes,
      "native pre-sign receipt exceeds bound",
    );
    await record.writeFile(line);
    await record.sync();
    // This gate may refuse before the composite's artifact upload can run.
    // Mirror only the already bounded public scheduling record to retained
    // provider logs; never print raw responses, credentials or proof contents.
    console.error(line.toString("utf8").trimEnd());
  };
  const api = new GitHubApiClient((args, input) => {
    active();
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0);
    return createGitHubRunner({
      cwd: root,
      timeoutMs: Math.min(15000, remaining),
      maxBuffer: slice4CapacityResources.native_presign_response_bytes,
    })([...args, "--hostname", "github.com"], input);
  });
  const read = (endpoint: string, singlePage = false) => {
    active();
    assert.ok(
      requests < slice4CapacityResources.native_presign_maximum_gets,
      "native pre-sign GET allowance exhausted",
    );
    requests++;
    const result = api.request("GET", endpoint);
    lastStatus = result.status ?? null;
    active();
    assert.equal(result.status, 200, "native prerequisite GET refused or ambiguous");
    if (singlePage) assert.ok(!result.headers.get("link"), "native job inventory incomplete");
    return result.body;
  };
  try {
    await waitForNativePreSignReadiness({
      run: identity.run_id,
      revision: identity.controller_revision,
      release_profile: captured.route.release_profile,
      active,
      retain,
      pause: () => delay(slice4CapacityResources.native_presign_poll_milliseconds),
      read: () => ({
        jobs: read(
          `repos/boburning/portcove/actions/runs/${identity.run_id}/attempts/1/jobs?per_page=100`,
          true,
        ),
        artifacts: readCompleteRunArtifactInventory((page) =>
          read(
            `repos/boburning/portcove/actions/runs/${identity.run_id}/artifacts?per_page=100&page=${page}`,
          ),
        ),
      }),
    });
  } catch (error) {
    await retain({
      outcome: "refused-or-ambiguous",
      last_http_status: lastStatus,
      requests,
      recovery_required: true,
      authority: "none",
    });
    throw error;
  } finally {
    await record.close();
  }
  active();
}
