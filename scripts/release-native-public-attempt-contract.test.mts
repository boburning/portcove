import assert from "node:assert/strict";
import test from "node:test";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectPublicJourneyAttemptMarker,
  inspectPublicJourneyProgress,
  inspectPublicJourneySettlement,
} from "./release-native-public-attempt-contract.mts";
import {
  claimActualPublicJourneyInvocation,
  readActualPublicJourneyProgress,
  requireActualPublicJourneyInvocation,
  readActualRetainedPublicCohort,
  requireActualRetainedPublicCohort,
} from "./release-native-attempt.mts";

function fixture(platform_label = "windows-x86_64") {
  const request = {
    schema_version: 1,
    profile: "ordinary-public-initial-cohort-v1",
    platform_label,
    phase: "initial-v0-v1",
    client: "client-a",
    cohort_sha256: "c".repeat(64),
    lineage: {
      capacity_sha256: "d".repeat(64),
      checkpoint: "e".repeat(40),
      published_metadata_sha256: "f".repeat(64),
    },
    proof_inputs: {
      candidate_compiler_sha256: platform_label === "windows-x86_64" ? "a".repeat(64) : null,
      prior_compiler_sha256: platform_label === "windows-x86_64" ? "b".repeat(64) : null,
      candidate_package_sha256: "1".repeat(64),
      prior_package_sha256: "2".repeat(64),
      pair_sha256: "c".repeat(64),
      source_directory: "native-public-source-123Abc",
    },
  };
  const identity = {
    kind: "ordinary-public-native-attempt",
    setup_grant_sha256: "3".repeat(64),
    descriptor_sha256: "4".repeat(64),
    request,
  };
  const marker = {
    ...identity,
    schema_version: 2,
    authority: "none",
    invocation_id: digest(identity),
    request_sha256: digest(request),
  };
  const inspected = inspectPublicJourneyAttemptMarker(marker, marker);
  const settlement = {
    schema_version: 1,
    kind: "ordinary-public-native-settlement",
    authority: "none",
    invocation_id: marker.invocation_id,
    request_sha256: marker.request_sha256,
    phase: request.phase,
    platform_label,
    proof_outcome: "completed",
    group: { empty: true, remaining_pids: [], observed_at: "2026-10-21T01:02:03.000Z" },
    roots: [
      {
        root_pid: 42,
        creation: {
          kind: platform_label === "windows-x86_64" ? "windows-filetime" : "linux-starttime-ticks",
          value: "123456",
        },
        root_exited: true,
        job_empty: true,
        remaining_pids: [],
        exit_code: 0,
      },
    ],
    files: [{ path: "public-result.json", bytes: 100, sha256: "5".repeat(64) }],
    wire:
      platform_label === "linux-x86_64"
        ? { path: "public-capture.stdout.bin", bytes: 271 * 1024 * 1024, sha256: "6".repeat(64) }
        : null,
  };
  return { marker, inspected, settlement };
}

void test("public attempt binds protected grant, descriptor, phase, platform, source and retained input identities", () => {
  const { marker } = fixture();
  for (const modify of [
    (v: typeof marker) => {
      v.request.client = "client-b";
    },
    (v: typeof marker) => {
      v.request.proof_inputs.source_directory = "../other";
    },
    (v: typeof marker) => {
      v.request.lineage.capacity_sha256 = "changed";
    },
    (v: typeof marker) => {
      v.request.proof_inputs.candidate_compiler_sha256 = null;
    },
    (v: typeof marker) => {
      v.request_sha256 = "0".repeat(64);
    },
    (v: typeof marker) => {
      v.descriptor_sha256 = "a".repeat(64);
    },
  ]) {
    const changed = structuredClone(marker);
    modify(changed);
    assert.throws(() => inspectPublicJourneyAttemptMarker(changed, marker));
  }
});
void test("positive group settlement requires exact root creation and every retained file; Linux original wire keeps its separate bound", () => {
  for (const platform of ["windows-x86_64", "linux-x86_64"]) {
    const { settlement, inspected } = fixture(platform);
    assert.equal(inspectPublicJourneySettlement(settlement, inspected).authority, "none");
    for (const modify of [
      (v: typeof settlement) => {
        v.group.empty = false;
      },
      (v: typeof settlement) => {
        v.roots[0]!.creation.value = "0";
      },
      (v: typeof settlement) => {
        v.roots[0]!.job_empty = false;
      },
      (v: typeof settlement) => {
        v.files.push({ ...v.files[0]! });
      },
      (v: typeof settlement) => {
        v.files[0]!.bytes = 4 * 1024 * 1024 + 1;
      },
      (v: typeof settlement) => {
        v.files[0]!.path = "../capture.json";
      },
    ]) {
      const changed = structuredClone(settlement);
      modify(changed);
      assert.throws(() => inspectPublicJourneySettlement(changed, inspected));
    }
    if (settlement.wire) {
      settlement.wire.bytes = 272 * 1024 * 1024 + 1;
      assert.throws(() => inspectPublicJourneySettlement(settlement, inspected));
    }
  }
});
void test("scheduler cannot repeat completed A or B, skip a phase, change cohort or use a refusal as phase progress", () => {
  const cohort = "c".repeat(64),
    a = {
      phase: "initial-v0-v1" as const,
      cohort_sha256: cohort,
      proof_outcome: "completed" as const,
    },
    b = { ...a, phase: "park-v0-with-v1" as const };
  assert.equal(inspectPublicJourneyProgress([], cohort), "initial-v0-v1");
  assert.equal(inspectPublicJourneyProgress([a], cohort), "park-v0-with-v1");
  assert.equal(inspectPublicJourneyProgress([a, b], cohort), "await-published-v2");
  for (const history of [
    [b],
    [a, a],
    [{ ...a, cohort_sha256: "d".repeat(64) }],
    [{ ...a, proof_outcome: "refused" as const }],
  ])
    assert.throws(() => inspectPublicJourneyProgress(history, cohort));
});
void test("parsed and copied public records cannot mint actual parent, progress or invocation custody", async () => {
  const { marker } = fixture();
  await assert.rejects(readActualPublicJourneyProgress(marker), /actual parent\/public Tough pair/);
  await assert.rejects(
    claimActualPublicJourneyInvocation(marker, {
      pair: marker,
      prior_package: marker,
      candidate_package: marker,
    }),
    /actual public progress/,
  );
  await assert.rejects(requireActualPublicJourneyInvocation(marker), /actual freshly claimed/);
  await assert.rejects(readActualRetainedPublicCohort(marker), /actual installed native parent provenance/);
  await assert.rejects(requireActualRetainedPublicCohort(marker), /actual retained public cohort custody/);
});
