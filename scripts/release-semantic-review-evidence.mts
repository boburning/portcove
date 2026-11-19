import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

/** Shape/integrity only: this does not authenticate a runtime or certify review. */
export function inspectSemanticReviewEvidence(
  raw: unknown,
  purpose: "application" | "catalog-publication" = "application",
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "completed_at,coverage,report,report_sha256,runtime,scope,session_ref"
  )
    throw new Error("semantic review evidence schema differs");
  if (
    raw.scope !==
      (purpose === "application"
        ? "complete-release-opportunity"
        : "complete-catalog-publication-opportunity") ||
    raw.runtime !== "codex-independent-local-review" ||
    typeof raw.session_ref !== "string" ||
    !raw.session_ref ||
    raw.session_ref.length > 512 ||
    Array.from(raw.session_ref).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    typeof raw.report !== "string" ||
    !raw.report.trim() ||
    Buffer.byteLength(raw.report) > 48 * 1024 ||
    typeof raw.completed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(raw.completed_at) ||
    !Number.isFinite(Date.parse(raw.completed_at)) ||
    new Date(raw.completed_at).toISOString() !== raw.completed_at.replace("Z", ".000Z")
  )
    throw new Error("implementation review or incomplete runtime record is not release acceptance");
  if (
    !isRecord(raw.coverage) ||
    Object.keys(raw.coverage).sort().join(",") !==
      "accumulated_changes,classification,compatibility" ||
    Object.values(raw.coverage).some((value) => value !== true)
  )
    throw new Error("semantic review omitted accumulated changes, classification or compatibility");
  const digest = createHash("sha256").update(raw.report).digest("hex");
  if (raw.report_sha256 !== digest) throw new Error("semantic review report bytes changed");
  return {
    runtime: raw.runtime,
    session_ref: raw.session_ref,
    scope: raw.scope,
    coverage: structuredClone(raw.coverage),
    completed_at: raw.completed_at,
    report: raw.report,
    report_sha256: digest,
  };
}
