import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { exportCoordinatorCheckpoint } from "../release-coordinator-state.mts";
import {
  coordinatorCheckpointEvidenceSubject,
  coordinatorCheckpointPredicateType,
} from "../release-coordinator-checkpoint-evidence.mts";
import { capacityExecutorJobProfile } from "../assembler-job-identity.mts";
import type { CapacityExecutorRole } from "../assembler-job-identity.mts";
import type { CheckpointProducerExpectation } from "../release-coordinator-checkpoint-authentication.mts";
import type {
  HistoricalJobProvider,
  HostedNativeSourceProvider,
} from "../release-custody-provider.mts";
import { nativeQualificationFixture } from "./native-qualification-fixture.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
const actor = {
  name: "Portcove release coordinator",
  email: "coordinator@portcove.invalid",
  date: "2000-01-01T00:00:00Z",
};
export function checkpointProofFixture(
  checkpoint: Checkpoint = {
    schema_version: 1,
    checkpoint: "b".repeat(40),
    previous: "c".repeat(40),
    blob: { oid: "d".repeat(40), contents: "{}" },
    tree: {
      oid: "e".repeat(40),
      entries: [{ path: "state.json", mode: "100644", type: "blob", sha: "d".repeat(40) }],
    },
    commit: {
      oid: "b".repeat(40),
      tree: "e".repeat(40),
      parents: ["c".repeat(40)],
      message: "fixture",
      author: actor,
      committer: actor,
    },
    receipts: [],
    required_commits: [],
  },
  configuration = { schema_version: 1, namespace: "portcove-fixture" },
  producerOverrides: Partial<CheckpointProducerExpectation> = {},
  role: CapacityExecutorRole = "coordinator",
) {
  const profile = capacityExecutorJobProfile(role);
  const producer: CheckpointProducerExpectation = {
    actor_id: "1122",
    check_run_id: "777",
    configuration_sha256: "1".repeat(64),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    controller_revision: "a".repeat(40),
    job_id: "501",
    run_attempt: 2,
    run_id: "9988",
    setup_sha256: "2".repeat(64),
    workflow_sha256: "3".repeat(64),
    ...producerOverrides,
  };
  const subject = coordinatorCheckpointEvidenceSubject(checkpoint, configuration, producer);
  const sha256 = createHash("sha256").update(subject).digest("hex");
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "portcove-coordinator-checkpoint-transition", digest: { sha256 } }],
    predicateType: coordinatorCheckpointPredicateType,
    predicate: { schema_version: 1, transition_sha256: sha256, producer },
  };
  const bundle = Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        signatures: [{ keyid: "inert", sig: "aW5lcnQ=" }],
      },
    }),
  );
  const job = {
    id: 501,
    run_id: 9988,
    run_attempt: producer.run_attempt,
    head_sha: producer.controller_revision,
    name: profile.job,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/777",
    status: "completed",
    conclusion: "failure",
    labels: ["ubuntu-24.04"],
    started_at: "2026-10-23T12:00:00Z",
    completed_at: "2026-10-23T12:01:00Z",
  };
  const attempt = {
    id: 9988,
    run_attempt: producer.run_attempt,
    head_sha: producer.controller_revision,
    head_branch: producer.controller_ref.slice("refs/tags/".length),
    path: profile.workflow,
    event: "workflow_dispatch",
    status: "completed",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
    actor: { id: 1122 },
    triggering_actor: { id: 1122 },
  };
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: `https://github.com/boburning/portcove/${profile.workflow}@${producer.controller_ref}`,
    buildSignerDigest: producer.controller_revision,
    sourceRepositoryDigest: producer.controller_revision,
    sourceRepositoryRef: producer.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: `https://github.com/boburning/portcove/actions/runs/9988/attempts/${producer.run_attempt}`,
  };
  const verification = {
    signature: { certificate },
    verifiedTimestamps: [
      { type: "tlog", uri: "https://rekor.sigstore.dev", timestamp: "2026-10-23T12:00:30.123Z" },
    ],
    statement,
  };
  const calls: string[] = [];
  const faults = { value: "" };
  let attemptReads = 0;
  const provider: HistoricalJobProvider = {
    async attempt(run, selectedAttempt) {
      assert.equal(run, producer.run_id);
      assert.equal(selectedAttempt, producer.run_attempt);
      calls.push(`repos/boburning/portcove/actions/runs/${run}/attempts/${selectedAttempt}`);
      attemptReads++;
      return {
        ...attempt,
        ...(faults.value === "changed-attempt" && attemptReads > 1 ? { run_attempt: 3 } : {}),
      };
    },
    async jobs(run, selectedAttempt, page) {
      assert.equal(run, producer.run_id);
      assert.equal(selectedAttempt, producer.run_attempt);
      assert.equal(page, 1);
      calls.push(`repos/boburning/portcove/actions/runs/${run}/attempts/${selectedAttempt}/jobs`);
      const body =
        faults.value === "duplicate"
          ? { total_count: 2, jobs: [job, job] }
          : faults.value === "duplicate-check"
            ? { total_count: 2, jobs: [job, { ...job, id: 502 }] }
            : faults.value === "incomplete"
              ? { total_count: 101, jobs: [job] }
              : { total_count: 1, jobs: [job] };
      return { body, next: null };
    },
    async job(id) {
      assert.equal(id, job.id);
      calls.push(`repos/boburning/portcove/actions/jobs/${id}`);
      return {
        ...job,
        ...(faults.value === "changed-job"
          ? { check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/778" }
          : {}),
      };
    },
  };
  return {
    checkpoint,
    configuration,
    producer,
    evidence: { subject, bundle },
    expected: { role, producer },
    job,
    attempt,
    verification,
    provider,
    calls,
    faults,
  };
}

/** Controlled HTTP peer for tests that exercise the actual locked SDK and
 * private receipt path. Domain tests inject the operations directly. */
export function releaseCustodyFetch(
  provider: HistoricalJobProvider & Partial<HostedNativeSourceProvider>,
  observe?: (url: URL, init?: RequestInit) => Response | void,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.method, "GET");
    const override = observe?.(url, init);
    if (override) return override;
    const route = decodeURIComponent(url.pathname).replace(/^\/repos\/boburning\/portcove\//u, "");
    const attempt = /^actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)(\/jobs)?$/u.exec(route);
    if (attempt) {
      if (!attempt[3])
        return Response.json(await provider.attempt(attempt[1]!, Number(attempt[2])));
      assert.equal(url.searchParams.get("per_page"), "100");
      const result = await provider.jobs(
        attempt[1]!,
        Number(attempt[2]),
        Number(url.searchParams.get("page")),
      );
      return Response.json(
        result.body,
        result.next ? { headers: { link: `<${result.next}>; rel="next"` } } : {},
      );
    }
    const job = /^actions\/jobs\/([1-9][0-9]*)$/u.exec(route);
    if (job) return Response.json(await provider.job(Number(job[1])));
    if (provider.commit && route.startsWith("git/commits/"))
      return Response.json(await provider.commit(route.slice("git/commits/".length)));
    if (provider.file && route.startsWith("contents/")) {
      const ref = url.searchParams.get("ref");
      assert.ok(ref);
      return Response.json(await provider.file(route.slice("contents/".length), ref));
    }
    assert.fail(`Unexpected custody route ${url.pathname}`);
  };
}

export function fixedJobJournalAuthoritiesFixture() {
  return {
    schema_version: 3 as const,
    kind: "two-app-fixed-jobs-v1" as const,
    repository_id: 1354613114,
    namespace: "portcove-fixture",
    setup_plan_sha256: "2".repeat(64),
    apps: {
      semantic: { app_id: 101, installation_id: 1001 },
      protection_observer: { app_id: 202, installation_id: 1002 },
    },
    journal_seed: { checkpoint: "c".repeat(40), state_sha256: "d".repeat(64) },
  };
}

/** Inert configuration, not actual App appointment, native observation or keys. */
export function selectedPublicationAuthoritiesFixture(
  purpose: "application" | "catalog-publication",
) {
  const journal = fixedJobJournalAuthoritiesFixture();
  const common = { schema_version: 4 as const, kind: "two-app-fixed-jobs-v1" as const, journal };
  if (purpose === "catalog-publication")
    return {
      ...common,
      purpose,
      catalog: {
        setup_plan_sha256: journal.setup_plan_sha256,
        public_source: {
          commit: "a".repeat(40),
          root: { path: "public/catalog-root.json", bytes: 2, sha256: "b".repeat(64) },
          offline_targets: {
            path: "public/catalog-targets.json",
            bytes: 2,
            sha256: "c".repeat(64),
          },
        },
        publisher_scope: [
          {
            namespace: "official",
            stable_id: "fixture",
            template: "staged-source-portable",
            repository_id: 123,
            artifact_hosts: ["github.com", "release-assets.githubusercontent.com"],
            max_redirects: 2,
            operations: ["install", "update", "prepare", "launch"],
            policy_schemas: [1, 2, 3, 4],
          },
        ],
      },
    };
  const native = nativeQualificationFixture();
  const platform = (windows: boolean) => ({
    producer: {
      source_commit: native.producer.source_commit,
      source_tree: native.producer.source_tree,
      harness: native.producer.harness,
    },
    engine: {
      name: windows ? "WebView2" : "WebKitGTK",
      minimum_version: windows ? "155.0.4283.62" : "2.52.6",
    },
    minimum_platform: windows ? "windows-11-26h2-x64" : "ubuntu-24.04-x64",
    compatibility: {
      ...native.compatibility,
      minimum_os_version: windows ? "10.0.26200" : "24.04",
    },
  });
  return {
    ...common,
    purpose,
    native_prepublication_profile: "signed-package-compatibility-v1",
    hosted_native: { "windows-x86_64": platform(true), "linux-x86_64": platform(false) },
    publication: {
      setup_plan_sha256: journal.setup_plan_sha256,
      initial_site_preimage_sha256: "8".repeat(64),
      public_source: {
        commit: "a".repeat(40),
        root: { path: "public/application-root.json", bytes: 2, sha256: "d".repeat(64) },
        offline_targets: {
          path: "public/application-targets.json",
          bytes: 2,
          sha256: "e".repeat(64),
        },
        payload_key_registry: {
          path: "public/payload-registry.json",
          bytes: 2,
          sha256: "f".repeat(64),
        },
        initial_site_preimage: {
          path: "public/site-preimage.json",
          bytes: 2,
          sha256: "8".repeat(64),
        },
      },
    },
  };
}
