import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { BackupReview } from "../types";
import { BackupReviewDialog } from "./BackupReview";

const review: BackupReview = {
  port_name: "Sample Port",
  persistent_data_path: "library/user/sample",
  preview: {
    action: "restore",
    backup: {
      id: "snapshot",
      port_id: "sample",
      path: "library/backups/sample/snapshot",
      created_at: 1,
      file_count: 2,
      size: 128,
      sha256: "a".repeat(64),
    },
    current_user_data_exists: true,
    safety_backup_will_be_created: true,
    retained_runtime_copy_will_be_deleted: false,
    preview_sha256: "reviewed-data",
  },
};
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("reviews exact paths and safety-backup behavior before a bound restore", async () => {
  const preview = vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue(true);
  const close = vi.fn();
  await root.rerender(
    <BackupReviewDialog
      gameName="Harbor Adventure — Édition <A&B> · Modern port"
      backup={review.preview.backup}
      action="restore"
      generation={7}
      apply={apply}
      close={close}
    />,
  );
  expect(preview).toHaveBeenCalledWith("sample", "snapshot", "restore", 7);
  expect(apply).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toContain(
    "Harbor Adventure — Édition <A&B> · Modern port",
  );
  expect(document.body.textContent).toContain("library/user/sample");
  expect(document.body.textContent).toContain("Sample Port");
  expect(document.body.textContent).toContain("Catalog ID: sample");
  expect(document.body.textContent).toContain("library/backups/sample/snapshot");
  expect(document.body.textContent).toContain(
    "Portcove will back up the current saved data before replacing it",
  );
  expect(document.body.textContent).toContain("game must be stopped");
  expect(document.body.textContent).toContain("retains recovery data");
  await captureParityState("backup-restore-reviewed-fixture");
  await expect.poll(() => document.activeElement?.textContent).toBe("Cancel");
  await click("Restore this backup");
  expect(apply).toHaveBeenCalledWith(review.preview.backup, "reviewed-data");
  expect(close).toHaveBeenCalledOnce();
});

it("explains permanent deletion and can dismiss without authorizing it", async () => {
  vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue({
    ...review,
    preview: {
      ...review.preview,
      action: "delete",
      safety_backup_will_be_created: false,
      retained_runtime_copy_will_be_deleted: true,
    },
  });
  const apply = vi.fn();
  const close = vi.fn();
  await root.rerender(
    <BackupReviewDialog
      backup={review.preview.backup}
      action="delete"
      generation={7}
      apply={apply}
      close={close}
    />,
  );
  expect(document.body.textContent).toContain(
    "other backups and installed game versions are preserved",
  );
  expect(document.body.textContent).toContain("cannot be recovered after deletion");
  expect(document.body.textContent).toContain(
    "permanently deletes the retained Ghostship 3.0.0 runtime saves/settings copy",
  );
  expect(document.body.textContent).toContain("not a reversible cancellation");
  await captureParityState("backup-delete-reviewed-fixture");
  await click("Cancel");
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("closes without reporting failure when native consent is declined", async () => {
  vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue(review);
  const apply = vi.fn().mockResolvedValue("cancelled");
  const close = vi.fn();
  await root.rerender(
    <BackupReviewDialog
      backup={review.preview.backup}
      action="restore"
      generation={7}
      apply={apply}
      close={close}
    />,
  );
  await click("Restore this backup");
  expect(close).toHaveBeenCalledOnce();
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});

it("requires a fresh review after a changed selection fails and rejects duplicate application", async () => {
  const preview = vi.spyOn(desktopApi, "previewBackupAction").mockResolvedValue(review);
  let finish!: (result: boolean) => void;
  const apply = vi.fn().mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  await root.rerender(
    <BackupReviewDialog
      backup={review.preview.backup}
      action="restore"
      generation={7}
      apply={apply}
      close={close}
    />,
  );
  await click("Restore this backup");
  expect(document.body.textContent).toContain("Restoring backup…");
  await captureParityState("backup-restore-pending-fixture");
  await click("Restoring backup…");
  await click("Cancel");
  expect(apply).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("did not complete");
  await captureParityState("backup-restore-failed-fixture");
  expect(document.body.textContent).not.toContain("Restore this backup");
  await click("Review again");
  expect(preview).toHaveBeenCalledTimes(2);
});

it("ignores an old review after the library or selected backup changes", async () => {
  let finish!: (result: BackupReview) => void;
  vi.spyOn(desktopApi, "previewBackupAction")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ...review,
      preview: {
        ...review.preview,
        backup: {
          ...review.preview.backup,
          id: "new",
          path: "current/snapshot",
        },
        safety_backup_will_be_created: false,
        retained_runtime_copy_will_be_deleted: false,
      },
    });
  const apply = vi.fn();
  const close = vi.fn();
  await root.rerender(
    <BackupReviewDialog
      key="old"
      backup={review.preview.backup}
      action="restore"
      generation={7}
      apply={apply}
      close={close}
    />,
  );
  await root.rerender(
    <BackupReviewDialog
      key="new"
      backup={{ ...review.preview.backup, id: "new" }}
      action="restore"
      generation={8}
      apply={apply}
      close={close}
    />,
  );
  await act(async () => finish(review));
  expect(document.body.textContent).toContain("current/snapshot");
  expect(document.body.textContent).not.toContain("library/backups/sample/snapshot");
  expect(document.body.textContent).toContain("There is no current saved data to back up");
  expect(apply).not.toHaveBeenCalled();
});
