// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { BackupHistory } from "../../components/BackupHistory";
import { DetailPanel, type DetailActions } from "../../components/DetailPanel";
import type { ApplyBackupAction } from "../../components/BackupReview";
import { portDefinition } from "../../test-fixtures";
import type { BackupRecord, BackupReview } from "../../types";

const backups: BackupRecord[] = [1, 2].map((index) => ({
  id: `backup-${index}`,
  port_id: "sample",
  path: `library/backups/sample/${index}`,
  created_at: index,
  file_count: 1,
  size: 128,
  sha256: "a".repeat(64),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(desktopApi, "previewBackupAction").mockImplementation(
    async (_port, id, action) =>
      ({
        port_name: "Sample Port",
        persistent_data_path: "library/user/sample",
        preview: {
          action,
          backup: backups.find((backup) => backup.id === id)!,
          current_user_data_exists: true,
          safety_backup_will_be_created: false,
          preview_sha256: "reviewed-data",
        },
      }) satisfies BackupReview,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function History({
  initial = backups,
  remove,
}: {
  initial?: BackupRecord[];
  remove?: ApplyBackupAction;
}) {
  const [current, setCurrent] = useState(initial);
  return (
    <BackupHistory
      backups={current}
      generation={7}
      restore={vi.fn()}
      remove={
        remove ??
        (async (backup) => {
          setCurrent((items) => items.filter((item) => item.id !== backup.id));
          return true;
        })
      }
    />
  );
}

async function openDeletion(id: string) {
  const opener = container.querySelector<HTMLButtonElement>(
    `[data-backup-id="${id}"] button[aria-label^="Delete"]`,
  )!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  return opener;
}

async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("returns focus to a remaining backup after successful deletion removes the opener", async () => {
  await act(async () => root.render(<History />));
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(opener.isConnected).toBe(false);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  const remaining = container.querySelector(
    '[data-backup-id="backup-2"] button[aria-label^="Delete"]',
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(remaining));
});

it("returns focus to the previous backup when the last row is deleted", async () => {
  await act(async () => root.render(<History />));
  await openDeletion("backup-2");
  await click("Delete this backup permanently");
  const remaining = container.querySelector(
    '[data-backup-id="backup-1"] button[aria-label^="Delete"]',
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(remaining));
});

it("returns focus to the backup heading when the final backup is deleted", async () => {
  await act(async () => root.render(<History initial={backups.slice(0, 1)} />));
  await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(container.textContent).toContain("No backups yet");
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(container.querySelector('[role="heading"]')),
  );
});

it("returns focus to Saves and storage when the uninstalled detail consumer removes all backup history", async () => {
  let finish!: (result: boolean) => void;
  const deleteBackup = vi.fn((_backup: BackupRecord) => {
    updateBackups([]);
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  let updateBackups!: (backups: BackupRecord[]) => void;
  function DetailHistory() {
    const [current, setCurrent] = useState(backups.slice(0, 1));
    updateBackups = setCurrent;
    const actions: DetailActions = {
      activate: vi.fn(),
      backup: vi.fn(),
      check: vi.fn(),
      close: vi.fn(),
      deleteBackup,
      dismissInstallReview: vi.fn(),
      install: vi.fn(),
      launch: vi.fn(),
      openUserData: vi.fn(),
      reviewInstall: vi.fn(),
      remove: vi.fn(),
      restoreBackup: vi.fn(),
      rollback: vi.fn(),
      setChannel: vi.fn(),
      setPolicy: vi.fn(),
      verify: vi.fn(),
    };
    return (
      <DetailPanel
        port={portDefinition()}
        backups={current}
        libraryGeneration={7}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />
    );
  }
  await act(async () => root.render(<DetailHistory />));
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(deleteBackup).toHaveBeenCalledExactlyOnceWith(backups[0], "reviewed-data");
  expect(opener.isConnected).toBe(false);
  expect(container.querySelector(".backup-history")).toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(container.querySelector("#detail-saves-and-storage")),
  );
  await act(async () => finish(true));
  expect(document.activeElement).toBe(container.querySelector("#detail-saves-and-storage"));
});

it("returns focus to the original delete action on cancellation without applying", async () => {
  const remove = vi.fn();
  await act(async () => root.render(<History remove={remove} />));
  const opener = await openDeletion("backup-2");
  await click("Cancel");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(remove).not.toHaveBeenCalled();
});

it("keeps a failed deletion in review, then returns focus to its opener on cancellation", async () => {
  const remove = vi.fn().mockResolvedValue(false);
  await act(async () => root.render(<History remove={remove} />));
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(remove).toHaveBeenCalledExactlyOnceWith(backups[0], "reviewed-data");
  expect(desktopApi.previewBackupAction).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "backup-1",
    "delete",
    7,
  );
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("did not complete");
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await vi.waitFor(() => expect(dialog?.contains(document.activeElement)).toBe(true));
  expect(opener.isConnected).toBe(true);
  await click("Cancel");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});

it("returns focus to the restore opener after cancelling a restore review", async () => {
  const restore = vi.fn();
  await act(async () =>
    root.render(
      <BackupHistory backups={backups} generation={7} restore={restore} remove={vi.fn()} />,
    ),
  );
  const opener = container.querySelector<HTMLButtonElement>(
    '[data-backup-id="backup-1"] button[data-backup-action="restore"]',
  )!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await click("Cancel");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(restore).not.toHaveBeenCalled();
});

it("returns focus to the restore opener after a successful reviewed restore", async () => {
  const restore = vi.fn().mockResolvedValue(true);
  await act(async () =>
    root.render(
      <BackupHistory backups={backups} generation={7} restore={restore} remove={vi.fn()} />,
    ),
  );
  const opener = container.querySelector<HTMLButtonElement>(
    '[data-backup-id="backup-1"] button[data-backup-action="restore"]',
  )!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await click("Restore this backup");
  expect(restore).toHaveBeenCalledExactlyOnceWith(backups[0], "reviewed-data");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});

it("does not open a review when recovery requires backup actions to stay disabled", async () => {
  await act(async () =>
    root.render(
      <BackupHistory
        backups={backups}
        state="recovery_required"
        restore={vi.fn()}
        remove={vi.fn()}
      />,
    ),
  );
  const actions = container.querySelectorAll<HTMLButtonElement>("button[data-backup-action]");
  expect(actions).toHaveLength(4);
  await act(async () => {
    for (const action of actions) {
      expect(action.disabled).toBe(true);
      action.click();
    }
  });
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
});
