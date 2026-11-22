import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import { isRecord } from "./runtime-values.mts";

/** First Windows game-lifecycle contract. Each outcome is mandatory. */
export const gameLifecycleChecks = [
  "acquire-exact-successor",
  "verify-package-and-install",
  "launch-and-close",
  "retain-and-reopen-predecessor",
] as const;

export interface ExpectedGameLifecycle {
  preparation_sha256: string;
  executable_sha256: string;
  check_plan_sha256: string;
  run_id: string;
  run_attempt: number;
  job_id: string;
  platform: "windows-x86-64";
  selected_at: number;
  now: number;
}

const keys = [
  "schema",
  "preparation_sha256",
  "executable_sha256",
  "check_plan_sha256",
  "run_id",
  "run_attempt",
  "job_id",
  "platform",
  "started_at",
  "completed_at",
  "checks",
];

const positiveIdentifier = /^[1-9][0-9]{0,15}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

/**
 * Interpret the predicate only after authenticating its signer and attested
 * subject. Compare against the exact Core preparation bytes and independently
 * read original native job identity from the same run and attempt.
 */
export function verifyGameLifecyclePredicate(predicate: unknown, expected: ExpectedGameLifecycle) {
  if (
    !sha256.test(expected.preparation_sha256) ||
    !sha256.test(expected.executable_sha256) ||
    !sha256.test(expected.check_plan_sha256) ||
    !positiveIdentifier.test(expected.run_id) ||
    !positiveIdentifier.test(expected.job_id) ||
    !Number.isSafeInteger(expected.run_attempt) ||
    expected.run_attempt < 1 ||
    expected.platform !== "windows-x86-64" ||
    !Number.isSafeInteger(expected.selected_at) ||
    !Number.isSafeInteger(expected.now) ||
    !isRecord(predicate) ||
    !isDeepStrictEqual(Object.keys(predicate).sort(), [...keys].sort()) ||
    predicate.schema !== 1 ||
    predicate.preparation_sha256 !== expected.preparation_sha256 ||
    predicate.executable_sha256 !== expected.executable_sha256 ||
    predicate.check_plan_sha256 !== expected.check_plan_sha256 ||
    predicate.run_id !== expected.run_id ||
    predicate.run_attempt !== expected.run_attempt ||
    predicate.job_id !== expected.job_id ||
    predicate.platform !== expected.platform
  ) {
    throw new Error("Game lifecycle receipt differs from the exact prepared subject or job");
  }
  const { started_at, completed_at, checks } = predicate;
  if (
    typeof started_at !== "number" ||
    typeof completed_at !== "number" ||
    !Number.isSafeInteger(started_at) ||
    !Number.isSafeInteger(completed_at) ||
    started_at < expected.selected_at ||
    completed_at < started_at ||
    completed_at > expected.now ||
    !isRecord(checks) ||
    !isDeepStrictEqual(Object.keys(checks).sort(), [...gameLifecycleChecks].sort())
  ) {
    throw new Error("Game lifecycle receipt has an invalid clock or is missing required checks");
  }
  const reports = gameLifecycleChecks.map((check) => {
    const result = checks[check];
    if (
      !isRecord(result) ||
      !isDeepStrictEqual(Object.keys(result).sort(), ["evidence_sha256", "outcome"]) ||
      result.outcome !== "passed" ||
      typeof result.evidence_sha256 !== "string" ||
      !sha256.test(result.evidence_sha256)
    )
      throw new Error("A mandatory game lifecycle check lacks a passing bound outcome");
    return { check, sha256: result.evidence_sha256 };
  });
  return { started_at, completed_at, preparation_sha256: expected.preparation_sha256, reports };
}

export function verifyGameLifecycleJob(
  attempt: unknown,
  job: unknown,
  expected: ExpectedGameLifecycle & { source_commit: string },
  stage: "attesting" | "consuming" = "consuming",
) {
  if (
    !isRecord(attempt) ||
    !isRecord(attempt.repository) ||
    attempt.repository.id !== 1354613114 ||
    attempt.path !== ".github/workflows/game-lifecycle-qualification.yml" ||
    attempt.head_branch !== "main" ||
    attempt.head_sha !== expected.source_commit ||
    String(attempt.id) !== expected.run_id ||
    attempt.run_attempt !== expected.run_attempt ||
    (stage === "consuming"
      ? attempt.status !== "completed" || attempt.conclusion !== "success"
      : attempt.status !== "in_progress" || attempt.conclusion !== null) ||
    (attempt.event !== "workflow_dispatch" && attempt.event !== "schedule") ||
    !isRecord(job) ||
    String(job.id) !== expected.job_id ||
    String(job.run_id) !== expected.run_id ||
    job.run_attempt !== expected.run_attempt ||
    job.head_sha !== expected.source_commit ||
    job.name !== "Exact game lifecycle (Windows x64)" ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Array.isArray(job.labels) ||
    job.labels.length !== 1 ||
    job.labels[0] !== "windows-2022"
  ) {
    throw new Error("Game lifecycle receipt does not belong to the successful original native job");
  }
  if (typeof job.started_at !== "string" || typeof job.completed_at !== "string") {
    throw new Error("Game lifecycle job has no execution interval");
  }
  const started = Date.parse(job.started_at) / 1000;
  const completed = Date.parse(job.completed_at) / 1000;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started)
    throw new Error("Game lifecycle job has an invalid execution interval");
  return { started, completed };
}

/** Offline publication preparation only. The signed catalog and reader gate
 * continue to reject successor-support activation until a capable release. */
export async function verifyAttestedGameLifecycle(
  directory: string,
  expected: ExpectedGameLifecycle & { source_commit: string },
) {
  const file = "successor-preparation.json";
  const before = await readBoundedPublicBuildInputFile(directory, file, 256 * 1024);
  const digest = createHash("sha256").update(before).digest("hex");
  if (digest !== expected.preparation_sha256)
    throw new Error("Game lifecycle preparation bytes differ from the reviewed pair");

  const proof = await withReadOnlyReleaseChildren(directory, () =>
    verifyReleaseSourceAttestation(
      directory,
      file,
      {
        source_commit: expected.source_commit,
        ref: "refs/heads/main",
        run_id: expected.run_id,
        run_attempt: expected.run_attempt,
        subjects: [{ filename: file, sha256: digest }],
      },
      { scope: "game-lifecycle" },
    ),
  );
  const after = await readBoundedPublicBuildInputFile(directory, file, 256 * 1024);
  if (!before.equals(after))
    throw new Error("Game lifecycle preparation changed during verification");
  const receipt = verifyGameLifecyclePredicate(proof.statement.predicate, expected);
  const evidence = [
    { check: "check-plan", sha256: expected.check_plan_sha256 },
    ...receipt.reports,
  ];
  for (const entry of evidence) {
    const bytes = await readBoundedPublicBuildInputFile(
      directory,
      `${entry.check}.json`,
      128 * 1024,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("Game lifecycle phase evidence differs from the attested digest");
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Explicit read-only workflow metadata token required");
  const provider = await createReleaseCustodyProvider({
    token,
    deadline: performance.now() + 30000,
  });
  const attempt = await provider.attempt(expected.run_id, expected.run_attempt);
  const job = await provider.job(Number(expected.job_id));
  const execution = verifyGameLifecycleJob(attempt, job, expected);
  if (receipt.started_at < execution.started || receipt.completed_at > execution.completed)
    throw new Error("Game lifecycle receipt falls outside the original native job");
  return {
    ...receipt,
    verification_path: proof.verification_path,
    authority: "none",
  };
}
