// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { BackupHistory } from "../../components/BackupHistory";
import { DetailPanel, type DetailActions } from "../../components/DetailPanel";
import type { ApplyBackupAction } from "../../components/BackupReview";
import { portDefinition } from "../../test-fixtures";
import type { BackupInventory, BackupRecord, BackupReview } from "../../types";
import { failureReport } from "../../test-fixtures";
import { usePortBackups } from "./use-port-backups";
import { detailActions } from "../game-details/detail-actions";

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

it("restores committed-row focus after operation completion and an awaited inventory refresh", async () => {
  let finishOperation!: () => void;
  let finishInventory!: () => void;
  function RefreshedHistory() {
    const [current, setCurrent] = useState(backups);
    const [busy, setBusy] = useState<string>();
    return (
      <BackupHistory
        backups={current}
        generation={7}
        busy={busy}
        restore={vi.fn()}
        remove={async (backup) => {
          setBusy("delete backup");
          await new Promise<void>((resolve) => {
            finishOperation = resolve;
          });
          setBusy(undefined);
          await new Promise<void>((resolve) => {
            finishInventory = () => {
              setCurrent((items) => items.filter((item) => item.id !== backup.id));
              resolve();
            };
          });
          return true;
        }}
      />
    );
  }
  await act(async () => root.render(<RefreshedHistory />));
  const opener = await openDeletion("backup-1");
  const disconnectedFocus = vi.spyOn(opener, "focus");
  await click("Delete this backup permanently");
  expect(opener.disabled).toBe(true);
  await act(async () => finishOperation());
  expect(opener.disabled).toBe(false);
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finishInventory());
  expect(opener.isConnected).toBe(false);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      container.querySelector('[data-backup-id="backup-2"] button[data-backup-action="delete"]'),
    ),
  );
  expect(disconnectedFocus).not.toHaveBeenCalled();
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

const reportReadFailure = vi.fn();

function ReadHistory({
  remove = vi.fn(),
  restore = vi.fn(),
}: {
  remove?: ApplyBackupAction;
  restore?: ApplyBackupAction;
}) {
  const current = usePortBackups("sample", reportReadFailure);
  return (
    <BackupHistory
      backups={current.backups}
      problems={current.inventory.problems}
      state={current.inventory.state}
      readState={current.readState}
      retryRead={current.refresh}
      restore={restore}
      remove={remove}
    />
  );
}

it("does not present an initial pending read as an empty backup inventory", async () => {
  vi.spyOn(desktopApi, "backups").mockReturnValue(new Promise<BackupInventory>(() => {}));
  await act(async () => root.render(<ReadHistory />));
  expect(container.textContent).not.toContain("No backups yet");
  expect(container.textContent).toContain("Loading backup history");
});

it("keeps a failed initial read unknown until a successful read-only retry", async () => {
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups: [], problems: [] });
  const remove = vi.fn();
  const restore = vi.fn();
  await act(async () => root.render(<ReadHistory remove={remove} restore={restore} />));
  expect(container.textContent).not.toContain("No backups yet");
  expect(container.textContent).toContain("The backup list is unknown");
  await click("Retry backup history");
  expect(container.textContent).toContain("No backups yet");
  expect(read).toHaveBeenCalledTimes(2);
  expect(remove).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
});

it("identifies retained rows after a failed refresh and retries only the inventory read", async () => {
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups, problems: [] })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups: [], problems: [] });
  const remove = vi.fn();
  const restore = vi.fn();
  await act(async () => root.render(<ReadHistory remove={remove} restore={restore} />));
  await click("Refresh backup history");
  expect(container.querySelectorAll(".backup-row")).toHaveLength(2);
  expect(container.textContent).toContain("last loaded backup list");
  expect(container.textContent).not.toContain("2 verified backups");
  await click("Retry backup history");
  expect(container.querySelectorAll(".backup-row")).toHaveLength(0);
  expect(container.textContent).toContain("No backups yet");
  expect(read).toHaveBeenCalledTimes(3);
  expect(remove).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
});

it("keeps read retry focused and disables repeated clicks while a read is pending", async () => {
  let finish!: (inventory: BackupInventory) => void;
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockRejectedValueOnce(new Error("private/raw/read/path"))
    .mockReturnValueOnce(
      new Promise<BackupInventory>((resolve) => {
        finish = resolve;
      }),
    );
  await act(async () => root.render(<ReadHistory />));
  expect(container.textContent).not.toContain("private/raw/read/path");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry backup history",
  )!;
  await act(async () => {
    retry.focus();
    retry.click();
    retry.click();
  });
  expect(retry.disabled).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => finish({ port_id: "sample", state: "healthy", backups, problems: [] }));
  expect(retry.disabled).toBe(false);
  expect(document.activeElement).toBe(retry);
  expect(container.textContent).toContain("2 verified backups");
});

function DetailReadHistory({ portId = "sample" }: { portId?: string }) {
  const port = { ...portDefinition(), id: portId };
  const current = usePortBackups(portId);
  const actions = detailActions({
    port,
    status: undefined,
    sourcePath: "",
    biosPath: "",
    perform: async (_name, task) => task(),
    close: vi.fn(),
    backupsChanged: current.refresh,
    libraryGeneration: 7,
  });
  return (
    <DetailPanel
      port={port}
      backups={current.backups}
      backupProblems={current.inventory.problems}
      backupState={current.inventory.state}
      backupReadState={current.readState}
      retryBackupRead={current.refresh}
      libraryGeneration={7}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />
  );
}

it("exposes a failed initial read through Saves and storage even without a known backup row", async () => {
  vi.spyOn(desktopApi, "backups").mockRejectedValueOnce(failureReport());
  await act(async () => root.render(<DetailReadHistory />));
  expect(container.querySelector(".backup-history")?.textContent).toContain(
    "The backup list is unknown",
  );
  expect(container.textContent).not.toContain("No backups yet");
});

it("preserves a completed reviewed delete and its focus after readback fails, then retries only the read", async () => {
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      backups: backups.slice(0, 1),
      problems: [],
    })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      backups: backups.slice(1),
      problems: [],
    });
  const remove = vi.spyOn(desktopApi, "deleteBackup").mockResolvedValueOnce(backups[0]);
  const restore = vi.spyOn(desktopApi, "restoreBackup");
  await act(async () => root.render(<DetailReadHistory />));
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(remove).toHaveBeenCalledExactlyOnceWith("sample", "backup-1", "reviewed-data", 7);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("last loaded backup list");
  expect(container.textContent).not.toContain("did not complete");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(opener.disabled).toBe(false);
  await click("Retry backup history");
  expect(read).toHaveBeenCalledTimes(3);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(restore).not.toHaveBeenCalled();
  expect(desktopApi.previewBackupAction).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "backup-1",
    "delete",
    7,
  );
  expect(container.querySelector('[data-backup-id="backup-1"]')).toBeNull();
  expect(container.querySelector('[data-backup-id="backup-2"]')).not.toBeNull();
});

it("keeps the retry control focused when an uninstalled port's unknown list becomes current and empty", async () => {
  vi.spyOn(desktopApi, "backups")
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups: [], problems: [] });
  await act(async () => root.render(<DetailReadHistory />));
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry backup history",
  )!;
  await act(async () => {
    retry.focus();
    retry.click();
  });
  expect(container.querySelector(".backup-history")?.textContent).toContain("No backups yet");
  expect(retry.isConnected).toBe(true);
  expect(document.activeElement).toBe(retry);
});

it("preserves a completed reviewed restore and its focus when inventory readback fails", async () => {
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups, problems: [] })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({ port_id: "sample", state: "healthy", backups, problems: [] });
  const restore = vi
    .spyOn(desktopApi, "restoreBackup")
    .mockResolvedValueOnce({ restored_backup: backups[0], safety_backup: null });
  const remove = vi.spyOn(desktopApi, "deleteBackup");
  await act(async () => root.render(<DetailReadHistory />));
  const opener = container.querySelector<HTMLButtonElement>(
    '[data-backup-id="backup-1"] button[data-backup-action="restore"]',
  )!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await click("Restore this backup");
  expect(restore).toHaveBeenCalledExactlyOnceWith("sample", "backup-1", "reviewed-data", 7);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("last loaded backup list");
  expect(container.textContent).not.toContain("did not complete");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(opener.disabled).toBe(false);
  await click("Retry backup history");
  expect(read).toHaveBeenCalledTimes(3);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(desktopApi.previewBackupAction).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "backup-1",
    "restore",
    7,
  );
});

it("lets the next selected port retry while the old port's retry is still pending", async () => {
  let finishOld!: (inventory: BackupInventory) => void;
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockRejectedValueOnce(failureReport())
    .mockReturnValueOnce(
      new Promise<BackupInventory>((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({ port_id: "other", state: "healthy", backups: [], problems: [] });
  await act(async () => root.render(<DetailReadHistory />));
  await click("Retry backup history");
  expect(container.textContent).toContain("Loading backup history");
  await act(async () => root.render(<DetailReadHistory portId="other" />));
  await click("Retry backup history");
  expect(read.mock.calls).toEqual([["sample"], ["sample"], ["other"], ["other"]]);
  expect(container.textContent).toContain("No backups yet");
  await act(async () => finishOld({ port_id: "sample", state: "healthy", backups, problems: [] }));
  expect(container.querySelectorAll(".backup-row")).toHaveLength(0);
  expect(container.textContent).toContain("No backups yet");
});
