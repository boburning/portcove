// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type { BackupReview } from "../types";
import { BackupReviewDialog } from "./BackupReview";

const review: BackupReview = {
  persistent_data_path: "library/user/sample",
  preview: { action: "restore", backup: { id: "snapshot", port_id: "sample", path: "library/backups/sample/snapshot", created_at: 1, file_count: 2, size: 128, sha256: "a".repeat(64) }, current_user_data_exists: true, safety_backup_will_be_created: true, preview_sha256: "reviewed-data" },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === label);
  expect(button).toBeDefined(); await act(async () => button?.click());
}

it("reviews exact paths and safety-backup behavior before a bound restore", async () => {
  const preview = vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue(true); const close = vi.fn();
  await act(async () => root.render(<BackupReviewDialog backup={review.preview.backup} action="restore" generation={7} apply={apply} close={close} />));
  expect(preview).toHaveBeenCalledWith("sample", "snapshot", "restore", 7);
  expect(apply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("library/user/sample");
  expect(container.textContent).toContain("library/backups/sample/snapshot");
  expect(container.textContent).toContain("new safety backup");
  expect(container.textContent).toContain("game must be stopped");
  expect(container.textContent).toContain("retains recovery data");
  expect(container.querySelector('[data-autofocus]')?.textContent).toBe("Keep current state");
  await click("Restore this backup");
  expect(apply).toHaveBeenCalledWith(review.preview.backup, "reviewed-data");
  expect(close).toHaveBeenCalledOnce();
});

it("explains permanent deletion and can dismiss without authorizing it", async () => {
  vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue({ ...review, preview: { ...review.preview, action: "delete", safety_backup_will_be_created: false } });
  const apply = vi.fn(); const close = vi.fn();
  await act(async () => root.render(<BackupReviewDialog backup={review.preview.backup} action="delete" generation={7} apply={apply} close={close} />));
  expect(container.textContent).toContain("other backups and installed game versions are preserved");
  expect(container.textContent).toContain("cannot be recovered after deletion");
  expect(container.textContent).toContain("not a reversible cancellation");
  await click("Keep current state");
  expect(close).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
});

it("requires a fresh review after a changed selection fails and rejects duplicate application", async () => {
  const preview = vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue(review);
  let finish!: (result: boolean) => void;
  const apply = vi.fn().mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const close = vi.fn();
  await act(async () => root.render(<BackupReviewDialog backup={review.preview.backup} action="restore" generation={7} apply={apply} close={close} />));
  await click("Restore this backup"); await click("Applying reviewed change…"); await click("Keep current state");
  expect(apply).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("did not complete");
  expect(container.textContent).not.toContain("Restore this backup");
  await click("Review again"); expect(preview).toHaveBeenCalledTimes(2);
});

it("ignores an old review after the library or selected backup changes", async () => {
  let finish!: (result: BackupReview) => void;
  vi.spyOn(desktopApi, "previewBackupAction").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...review, preview: { ...review.preview, backup: { ...review.preview.backup, id: "new", path: "current/snapshot" }, safety_backup_will_be_created: false } });
  const apply = vi.fn(); const close = vi.fn();
  await act(async () => root.render(<BackupReviewDialog key="old" backup={review.preview.backup} action="restore" generation={7} apply={apply} close={close} />));
  await act(async () => root.render(<BackupReviewDialog key="new" backup={{ ...review.preview.backup, id: "new" }} action="restore" generation={8} apply={apply} close={close} />));
  await act(async () => finish(review));
  expect(container.textContent).toContain("current/snapshot");
  expect(container.textContent).not.toContain("library/backups/sample/snapshot");
  expect(container.textContent).toContain("safety backup will not be created");
  expect(apply).not.toHaveBeenCalled();
});
