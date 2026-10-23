import { failureReport } from "../../test-fixtures";
import type { ActivityRecord, PreparationCleanupPreview } from "../../types";

/** Disposable records for reviewing existing Activity/recovery presentation. */
export function retainedSetup(portId: string, id: string, unknown = false) {
  // Fixture-only review token, injective for these bounded operation IDs. This
  // is not a security digest and never substitutes for a real Core fingerprint.
  if (!/^[a-z0-9-]{1,32}$/u.test(id)) throw new Error("Invalid fixture operation ID");
  const reviewToken = [...new TextEncoder().encode(id)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0");
  const failure = failureReport();
  failure.code = "install";
  failure.message = unknown
    ? "The demo could not confirm the setup outcome."
    : "The demo setup did not finish.";
  failure.presentation = {
    ...failure.presentation,
    summary: failure.message,
    mutation_state: unknown ? "unknown" : "recovery_required",
    recovery_actions: ["review_preparation", "view_technical_details"],
  };
  const record: ActivityRecord = {
    id,
    operation: "prepare",
    target_kind: "port",
    target_id: portId,
    started_at: Date.now() / 1000 - 120,
    finished_at: Date.now() / 1000 - 60,
    status: "failed",
    failure,
    cancellation: null,
    message: "Simulated unfinished setup; no real files were used.",
  };
  const preview: PreparationCleanupPreview = {
    format_version: 1,
    operation_id: id,
    port_id: portId,
    retained_path: `fixture/library/work/${id}`,
    retained: {
      directories: ["output"],
      files: [{ relative_path: "output/game.part", sha256: "a".repeat(64), size: 128 }],
      skipped_entries: [],
      total_bytes: 128,
    },
    original_install_path: `fixture/library/${portId}/versions/original`,
    source_path: `fixture/originals/${portId}.iso`,
    persistent_data_path: `fixture/library/user/${portId}`,
    backup_path: `fixture/library/backups/${portId}`,
    logs_path: `fixture/library/logs/${id}`,
    cleanup_is_irreversible: true,
    interrupted_cleanup_will_retry: true,
    preview_sha256: reviewToken,
  };
  return { record, preview };
}
