import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

type TestedSourceVariant = { game_id: string; variant_id: string; representation_id: string };

function testedVariant(value: unknown): TestedSourceVariant {
  const id = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
  if (
    !isRecord(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), ["game_id", "representation_id", "variant_id"]) ||
    typeof value.game_id !== "string" ||
    !id.test(value.game_id) ||
    typeof value.variant_id !== "string" ||
    !id.test(value.variant_id) ||
    typeof value.representation_id !== "string" ||
    !id.test(value.representation_id)
  )
    throw new Error("Exact tested game source variant is missing or invalid");
  return {
    game_id: value.game_id,
    variant_id: value.variant_id,
    representation_id: value.representation_id,
  };
}

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
  "source_variant",
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

export function inspectGameLifecyclePreparation(bytes: Buffer) {
  if (bytes.length < 1 || bytes.length > 256 * 1024)
    throw new Error("Exact Core preparation has an invalid byte length");
  const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const evidence = isRecord(envelope) ? envelope.data : null;
  if (
    !isRecord(envelope) ||
    envelope.schema_version !== 100 ||
    envelope.ok !== true ||
    envelope.command !== "catalog.prepare-successor-evidence" ||
    envelope.error !== null ||
    !isRecord(evidence) ||
    evidence.rule_version !== 1 ||
    typeof evidence.selected_at !== "number" ||
    !Number.isSafeInteger(evidence.selected_at) ||
    evidence.selected_at < 1 ||
    !Array.isArray(evidence.anchor_observations) ||
    evidence.anchor_observations.length < 1 ||
    evidence.anchor_observations.length > 64
  )
    throw new Error("Exact Core preparation response is missing or unsupported");
  const subject = (row: unknown) => {
    if (
      !isRecord(row) ||
      !isRecord(row.definition) ||
      typeof row.definition.stable_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.definition.stable_id) ||
      row.platform !== "windows-x86-64" ||
      (row.channel !== "stable" && row.channel !== "beta") ||
      typeof row.artifact_sha256 !== "string" ||
      !sha256.test(row.artifact_sha256) ||
      typeof row.tag !== "string" ||
      row.tag.length < 1 ||
      row.tag.length > 256 ||
      !isRecord(row.coordinates) ||
      !["setup", "launch", "data"].every((key) => {
        const value = (row.coordinates as Record<string, unknown>)[key];
        return typeof value === "string" && sha256.test(value);
      }) ||
      !Array.isArray(row.variants) ||
      row.variants.length < 1 ||
      row.variants.length > 32
    )
      throw new Error("Exact Core preparation scope is incomplete or unsupported");
    return {
      id: row.definition.stable_id,
      platform: row.platform,
      channel: row.channel,
      artifact_sha256: row.artifact_sha256,
      tag: row.tag,
      coordinates: row.coordinates,
      variants: row.variants,
    } as const;
  };
  const predecessor = subject(evidence.predecessor);
  const successor = subject(evidence.successor);
  if (
    predecessor.id !== successor.id ||
    predecessor.channel !== successor.channel ||
    predecessor.tag === successor.tag ||
    predecessor.artifact_sha256 === successor.artifact_sha256 ||
    !isDeepStrictEqual(predecessor.coordinates, successor.coordinates) ||
    !isDeepStrictEqual(predecessor.variants, successor.variants)
  )
    throw new Error("Exact Core preparation does not describe an unchanged same-platform pair");
  return {
    selected_at: evidence.selected_at,
    rule_version: evidence.rule_version,
    platform: successor.platform,
    predecessor,
    successor,
  };
}

export async function verifyGameLifecyclePhaseFiles(
  directory: string,
  preparation: ReturnType<typeof inspectGameLifecyclePreparation>,
  receipt: ReturnType<typeof verifyGameLifecyclePredicate>,
  expected: Pick<ExpectedGameLifecycle, "check_plan_sha256" | "executable_sha256">,
) {
  const read = async (name: string, digest: string) => {
    const bytes = await readBoundedPublicBuildInputFile(directory, `${name}.json`, 128 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("Game lifecycle phase evidence differs from the attested digest");
    const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(record)) throw new Error("Game lifecycle phase is not a receipt object");
    return record;
  };
  const plan = await read("check-plan", expected.check_plan_sha256);
  if (
    !isDeepStrictEqual(plan, {
      schema: 1,
      rule_version: preparation.rule_version,
      checks: [...gameLifecycleChecks],
    })
  )
    throw new Error("Game lifecycle plan differs from the approved rule");
  const evidence = new Map<string, Record<string, unknown>>();
  for (const entry of receipt.reports) {
    if (evidence.has(entry.check)) throw new Error("Duplicate game lifecycle phase receipt");
    const report = await read(entry.check, entry.sha256);
    if (report.outcome !== "passed" || report.check !== entry.check)
      throw new Error("Game lifecycle phase identity or outcome differs");
    evidence.set(entry.check, report);
  }
  const acquisition = evidence.get("acquire-exact-successor");
  const verify = evidence.get("verify-package-and-install");
  const launch = evidence.get("launch-and-close");
  const rollback = evidence.get("retain-and-reopen-predecessor");
  const exactKeys = (report: Record<string, unknown>, extra: string[]) =>
    isDeepStrictEqual(Object.keys(report).sort(), ["check", "outcome", ...extra].sort());
  const verifyFiles = (report: Record<string, unknown> | undefined, id: unknown) =>
    report &&
    report.install_id === id &&
    Number.isSafeInteger(report.checked_files) &&
    Number(report.checked_files) > 0 &&
    exactKeys(report, ["install_id", "checked_files"]);
  if (
    !acquisition ||
    !exactKeys(acquisition, [
      "predecessor_install_id",
      "successor_install_id",
      "artifact_sha256",
    ]) ||
    typeof acquisition.predecessor_install_id !== "string" ||
    !acquisition.predecessor_install_id ||
    typeof acquisition.successor_install_id !== "string" ||
    !acquisition.successor_install_id ||
    acquisition.predecessor_install_id === acquisition.successor_install_id ||
    acquisition.artifact_sha256 !== preparation.successor.artifact_sha256 ||
    !verifyFiles(verify, acquisition.successor_install_id) ||
    !verifyFiles(rollback, acquisition.predecessor_install_id) ||
    !launch ||
    !exactKeys(launch, [
      "executable_sha256",
      "method",
      "exited_at",
      "exit_code",
      "source_variant",
    ]) ||
    launch.executable_sha256 !== expected.executable_sha256 ||
    !isDeepStrictEqual(launch.source_variant, receipt.source_variant) ||
    !preparation.successor.variants.some((variant) =>
      isDeepStrictEqual(variant, receipt.source_variant),
    ) ||
    launch.method !== "identity-bound-native-main-window-close-request" ||
    launch.exit_code !== 0 ||
    typeof launch.exited_at !== "string"
  )
    throw new Error(
      "Game lifecycle phases do not prove the exact acquisition, launch and rollback",
    );
  const exitedAt = Math.floor(Date.parse(launch.exited_at) / 1000);
  if (
    !Number.isFinite(exitedAt) ||
    exitedAt < receipt.started_at ||
    exitedAt > receipt.completed_at
  )
    throw new Error("Native game exit falls outside the authenticated lifecycle window");
}

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
  return {
    started_at,
    completed_at,
    preparation_sha256: expected.preparation_sha256,
    source_variant: testedVariant(predicate.source_variant),
    reports,
  };
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
  requested: Omit<ExpectedGameLifecycle, "platform" | "selected_at"> & { source_commit: string },
) {
  const file = "successor-preparation.json";
  const before = await readBoundedPublicBuildInputFile(directory, file, 256 * 1024);
  const digest = createHash("sha256").update(before).digest("hex");
  if (digest !== requested.preparation_sha256)
    throw new Error("Game lifecycle preparation bytes differ from the reviewed pair");
  const preparation = inspectGameLifecyclePreparation(before);
  const expected = {
    ...requested,
    platform: preparation.platform,
    selected_at: preparation.selected_at,
  };

  const scratch = await mkdtemp(path.join(tmpdir(), "portcove-game-receipt-"));
  const { predicate, verification_sha256 } = await (async () => {
    try {
      await writeFile(path.join(scratch, file), before, { flag: "wx", mode: 0o600 });
      const proof = await withReadOnlyReleaseChildren(scratch, () =>
        verifyReleaseSourceAttestation(
          scratch,
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
      const verification = await readBoundedPublicBuildInputFile(
        scratch,
        "source-attestation-verification.json",
        4 * 1024 * 1024,
      );
      return {
        predicate: proof.statement.predicate,
        verification_sha256: createHash("sha256").update(verification).digest("hex"),
      };
    } finally {
      await rm(scratch, { recursive: true });
    }
  })();
  const after = await readBoundedPublicBuildInputFile(directory, file, 256 * 1024);
  if (!before.equals(after))
    throw new Error("Game lifecycle preparation changed during verification");
  const receipt = verifyGameLifecyclePredicate(predicate, expected);
  await verifyGameLifecyclePhaseFiles(directory, preparation, receipt, expected);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Explicit read-only workflow metadata token required");
  const provider = await createReleaseCustodyProvider({
    token,
    deadline: performance.now() + 30000,
  });
  const attempt = await provider.attempt(expected.run_id, expected.run_attempt);
  const job = await provider.job(Number(expected.job_id));
  const execution = verifyGameLifecycleJob(attempt, job, expected);
  if (
    expected.selected_at < execution.started ||
    receipt.started_at < execution.started ||
    receipt.completed_at > execution.completed
  )
    throw new Error("Game lifecycle receipt falls outside the original native job");
  return {
    ...receipt,
    verification_sha256,
    authority: "none",
  };
}
