import { isRecord } from "./runtime-values.mts";

export type QualifiedApplicationReview = {
  source_commit: string;
  run_id: number;
  run_attempt: number;
};

export function inspectQualifiedApplicationReview(raw: unknown): QualifiedApplicationReview {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "run_attempt,run_id,source_commit" ||
    typeof raw.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.source_commit) ||
    typeof raw.run_id !== "number" ||
    !Number.isSafeInteger(raw.run_id) ||
    raw.run_id < 1 ||
    typeof raw.run_attempt !== "number" ||
    !Number.isSafeInteger(raw.run_attempt) ||
    raw.run_attempt < 1 ||
    raw.run_attempt > 3
  )
    throw new Error("exact qualified application request fields differ");
  return { source_commit: raw.source_commit, run_id: raw.run_id, run_attempt: raw.run_attempt };
}
