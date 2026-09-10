// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { BackupProblem, SourceImportPlan, SourceImportResult } from "../types";
import { BackupHistory } from "./BackupHistory";
import { SourceImportReview, sourceImportModePresentation, sourceImportNotice } from "./SourceDiscovery";

const source = { profile_id: "owned", path: "D:/Owned/game.iso", sha256: "a".repeat(64), size: 64, storage_sha256: "a".repeat(64), storage_size: 64, updated_at: 1 };
const plan = (mode: SourceImportPlan["mode"]): SourceImportPlan => ({ schema_version: 1, profile_id: source.profile_id, mode, source,
  admission_mode: "structural_checks", destination: "D:/Library/source-inbox/owned/game.iso", destination_exists: false, existing_registration: null,
  reuse_existing: false, required_bytes: 64, source_guard_sha256: "b".repeat(64), plan_sha256: "c".repeat(64) });
const result = (outcome: SourceImportResult["outcome"]): SourceImportResult => ({ import_id: "owned-import", profile_id: source.profile_id,
  mode: outcome === "moved" ? "move" : "copy", outcome, registered: source, copied: true, original_deleted: outcome === "moved",
  original_retained: outcome !== "moved", retained_original_path: outcome === "moved" ? null : source.path, recovered: false });
afterEach(() => { vi.unstubAllGlobals(); });

it.each(["future_mode", "constructor", "__proto__"])("does not offer confirmation or imply preservation for %s", mode => {
  const review = plan(mode as SourceImportPlan["mode"]); const original = JSON.stringify(review);
  const html = renderToStaticMarkup(<SourceImportReview plan={review} busy={false} onApply={vi.fn()} onCancel={vi.fn()} />);
  expect(html).toContain("Import method unavailable");
  expect(html).toContain("Cancel review");
  expect(html.match(/<button /g)).toHaveLength(1);
  expect(html).not.toContain("No source bytes are copied or removed");
  expect(html).not.toContain('class="primary"');
  expect(sourceImportModePresentation(mode).known).toBe(false);
  expect(JSON.stringify(review)).toBe(original);
  const unknown = sourceImportNotice(result(mode as SourceImportResult["outcome"]));
  expect(unknown).toContain("Source import outcome is unavailable");
  expect(unknown).not.toMatch(/verified|original was retained|original was removed/);
});

it.each(["copy", "move", "use_current_location"] as const)("keeps the known %s review actionable", async mode => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host); const apply = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<SourceImportReview plan={plan(mode)} busy={false} onApply={apply} onCancel={vi.fn()} />));
    expect(host.textContent).toContain(sourceImportModePresentation(mode).explanation);
    await act(async () => host.querySelector<HTMLButtonElement>("button.primary")!.click());
    expect(apply).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it.each([
  ["copied", "Inbox copy verified and registered; the original was retained."],
  ["reused_existing", "Existing Inbox copy verified and registered; the original was retained."],
  ["moved", "Inbox copy verified and registered; the original was removed."],
  ["registered_current_location", "Source registered at its current location."],
  ["copied_original_retained", `Inbox copy registered. The original remains at ${source.path}.`],
] as const)("retains the specific known %s outcome", (outcome, expected) => {
  const value = result(outcome); const original = JSON.stringify(value);
  expect(sourceImportNotice(value)).toBe(expected);
  expect(JSON.stringify(value)).toBe(original);
});

it.each(["future_problem", "constructor", "__proto__"])("renders backup problem %s without an inherited label", kind => {
  const problem: BackupProblem = { kind: kind as BackupProblem["kind"], path: "D:/Owned/backup", message: "Owned problem", proposed_action: "Review the recorded backup", backup_id: null, operation_id: null };
  const html = renderToStaticMarkup(<BackupHistory backups={[]} state="degraded" problems={[problem]} restore={vi.fn()} remove={vi.fn()} />);
  expect(html).toContain("Backup information unavailable");
  expect(html).toContain(problem.path);
});
