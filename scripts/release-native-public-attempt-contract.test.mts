import assert from "node:assert/strict";
import test from "node:test";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectPublicJourneyAttemptMarker,
  inspectPublicJourneyProgress,
  inspectPublicJourneySettlement,
  inspectLinuxPublicRetainedInventory,
  inspectLinuxPublicProofOutcome,
} from "./release-native-public-attempt-contract.mts";
import {
  claimActualPublicJourneyInvocation,
  readActualPublicJourneyProgress,
  requireActualPublicJourneyInvocation,
  recordActualWindowsPublicSettlement,
  readActualRetainedPublicCohort,
  requireActualRetainedPublicCohort,
  recordActualLinuxPublicSettlement,
  readActualPublicJourneyParentPhase,
} from "./release-native-attempt.mts";

void test("Linux settlement keeps every profile chunk at its original path while original wire covers atomic aliases", () => {
  const entry = (name: string, bytes = 42) => ({ path: name, bytes, sha256: "a".repeat(64) });
  const files = [
    entry("public-journey/public-update-journey.json"),
    entry("public-journey/profile-snapshot/profile.json"),
    entry(`public-journey/preimage-store/${"c".repeat(64)}.bin`, 1024 * 1024),
    entry("outer/.outer-json-" + "b".repeat(32)),
  ];
  assert.deepEqual(
    inspectLinuxPublicRetainedInventory(files, "park-v0-with-v1"),
    files.slice(0, 3).map((file) => ({ ...file, path: `guest-capture/${file.path}` })),
  );
  const original = fixture("linux-x86_64");
  inspectPublicJourneySettlement(
    {
      ...original.settlement,
      files: inspectLinuxPublicRetainedInventory(files, "park-v0-with-v1"),
    },
    original.inspected,
  );
  assert.throws(() =>
    inspectLinuxPublicRetainedInventory(
      files.filter((file) => !file.path.endsWith("profile.json")),
      "park-v0-with-v1",
    ),
  );
  assert.throws(() =>
    inspectLinuxPublicRetainedInventory(
      [...files, entry("ordinary.bin", 4 * 1024 * 1024 + 1)],
      "initial-v0-v1",
    ),
  );
  assert.throws(() =>
    inspectLinuxPublicRetainedInventory([...files, entry("../outside")], "park-v0-with-v1"),
  );
  assert.throws(() =>
    inspectLinuxPublicRetainedInventory(
      [...files, entry("outer/.other-hidden")],
      "park-v0-with-v1",
    ),
  );
  assert.throws(() =>
    inspectLinuxPublicRetainedInventory(
      [...files, entry(files[0]!.path.toUpperCase())],
      "park-v0-with-v1",
    ),
  );
});

void test("Linux phase success requires actual driver zero, no failure and exact observed or parked report outcome", () => {
  for (const phase of ["initial-v0-v1", "park-v0-with-v1", "continue-with-v2"] as const) {
    const report = {
      schema_version: 1,
      authority: "none",
      native_acceptance: "not-established",
      phase,
      outcome: phase === "park-v0-with-v1" ? "parked" : "observed",
    };
    assert.equal(inspectLinuxPublicProofOutcome(report, phase, 0, null), "completed");
    for (const status of [null, undefined, 1, "0"])
      assert.equal(inspectLinuxPublicProofOutcome(report, phase, status, null), "refused");
    assert.equal(inspectLinuxPublicProofOutcome(report, phase, 0, "unknown child"), "refused");
    assert.equal(
      inspectLinuxPublicProofOutcome({ ...report, outcome: "failed" }, phase, 0, null),
      "refused",
    );
    assert.equal(
      inspectLinuxPublicProofOutcome({ ...report, cleanup_failure: "unknown" }, phase, 0, null),
      "refused",
    );
    assert.throws(() =>
      inspectLinuxPublicProofOutcome({ ...report, phase: "other" }, phase, 0, null),
    );
  }
});

void test("copied Linux captures and parents cannot write settlement or select a fresh public phase", async () => {
  await assert.rejects(
    recordActualLinuxPublicSettlement({ authority: "none", driver_status: 0 }),
    /actual installed Linux public capture required/,
  );
  await assert.rejects(
    readActualPublicJourneyParentPhase({ authority: "none", public_journey: {} }),
    /actual.*parent/i,
  );
});

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

void test("continuation marker separately binds parked V1 and its exact original B invocation", () => {
  for (const platform of ["windows-x86_64", "linux-x86_64"]) {
    const { marker } = fixture(platform);
    const request = {
      ...marker.request,
      phase: "continue-with-v2",
      client: "client-b",
      proof_inputs: {
        ...marker.request.proof_inputs,
        parked_package_sha256: "8".repeat(64),
        parked_compiler_sha256: platform === "windows-x86_64" ? "9".repeat(64) : null,
        previous_parked_invocation_id: "7".repeat(64),
      },
    };
    const identity = {
      kind: marker.kind,
      setup_grant_sha256: marker.setup_grant_sha256,
      descriptor_sha256: marker.descriptor_sha256,
      request,
    };
    const continuation = {
      ...marker,
      request,
      request_sha256: digest(request),
      invocation_id: digest(identity),
    };
    const inspected = inspectPublicJourneyAttemptMarker(continuation, continuation);
    assert.equal(inspected.phase, "continue-with-v2");
    for (const field of [
      "parked_package_sha256",
      "parked_compiler_sha256",
      "previous_parked_invocation_id",
    ] as const) {
      const proof: Record<string, unknown> = { ...request.proof_inputs };
      delete proof[field];
      assert.throws(() =>
        inspectPublicJourneyAttemptMarker(
          { ...continuation, request: { ...request, proof_inputs: proof } },
          continuation,
        ),
      );
    }
    assert.throws(() =>
      inspectPublicJourneyAttemptMarker(
        { ...continuation, request: { ...request, client: "client-a" } },
        continuation,
      ),
    );
    assert.throws(() =>
      inspectPublicJourneyAttemptMarker(
        { ...marker, request: { ...marker.request, proof_inputs: request.proof_inputs } },
        marker,
      ),
    );
  }
});

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
  await assert.rejects(
    readActualRetainedPublicCohort(marker),
    /actual installed native parent provenance/,
  );
  await assert.rejects(
    requireActualRetainedPublicCohort(marker),
    /actual retained public cohort custody/,
  );
  await assert.rejects(
    recordActualWindowsPublicSettlement(marker),
    /actual fixed parent Windows public capture/,
  );
});

void test("only existing fixed Windows raw-payload slots retain their512MiB preimage bound", () => {
  const { settlement, inspected } = fixture();
  settlement.files[0] = {
    path: "ordinary-public-update/before-local-payload-tamper/staging-candidate-installer.exe",
    bytes: 8 * 1024 * 1024,
    sha256: "5".repeat(64),
  };
  assert.equal(
    inspectPublicJourneySettlement(settlement, inspected).files[0]!.bytes,
    8 * 1024 * 1024,
  );
  for (const path of [
    "ordinary-public-update/before-startup-6/staging-candidate-installer.exe",
    "ordinary-public-update/unappointed/staging-candidate-installer.exe",
    "ordinary-public-update/before-local-payload-tamper/arbitrary.exe",
  ]) {
    const changed = structuredClone(settlement);
    changed.files[0]!.path = path;
    assert.throws(() => inspectPublicJourneySettlement(changed, inspected));
  }
  settlement.files[0].bytes = 512 * 1024 * 1024 + 1;
  assert.throws(() => inspectPublicJourneySettlement(settlement, inspected));
});
