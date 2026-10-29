import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../../test-fixtures";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
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
          retained_runtime_copy_will_be_deleted: false,
          preview_sha256: "reviewed-data",
        },
      }) satisfies BackupReview,
  );
});
afterEach(async () => {
  await cleanup();
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
      restoreAssessment={{ action: "backup_restore", availability: "allowed", reason: "available" }}
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

it("keeps current backup history quiet and failed reads explicit without enabling stale restore", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const props = {
    backups,
    restore: vi.fn(),
    remove: vi.fn(),
    retryRead: retry,
    restoreAssessment: {
      action: "backup_restore" as const,
      availability: "allowed" as const,
      reason: "available" as const,
    },
  };
  await root.rerender(
    <BackupHistory {...props} readState={{ status: "current", hasInventory: true }} />,
  );
  expect(container.querySelector(".backup-inventory-notice")).toBeNull();
  const refresh = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh backup history",
  )!;
  expect(refresh.closest('[role="status"]')).toBeNull();
  await act(async () => refresh.click());
  expect(retry).toHaveBeenCalledOnce();
  await root.rerender(
    <BackupHistory {...props} readState={{ status: "failed", hasInventory: true }} />,
  );
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Backup history could not be loaded",
  );
  expect(container.textContent).toContain("last loaded backup list");
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[data-backup-action="restore"]')].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  await root.rerender(
    <BackupHistory {...props} backups={[]} readState={{ status: "current", hasInventory: true }} />,
  );
  expect(container.textContent).toContain("No backups yet");
  expect(container.querySelector(".backup-inventory-notice")).toBeNull();
});

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

it.each(
  [
    {
      action: "backup_restore",
      availability: "allowed",
      reason: "available",
      definition: { outcome: "hold", reason: "publisher_revoked" },
    },
    { action: "backup_restore", availability: "allowed", reason: "missing_backup" },
    { action: "backup_create", availability: "allowed", reason: "available" },
    { action: "backup_restore", availability: "future", reason: "available" },
  ].map((assessment, index) => ({
    name: ["definition hold", "wrong reason", "wrong action", "future state"][index],
    assessment,
  })),
)("does not open restore for $name", async ({ assessment }) => {
  const restore = vi.fn();
  await root.rerender(
    <BackupHistory
      backups={backups}
      restoreAssessment={assessment as never}
      restore={restore}
      remove={vi.fn()}
    />,
  );
  const button = document.body.querySelector<HTMLButtonElement>('[data-backup-action="restore"]');
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Restore eligibility is unknown");
});

it("returns focus to a remaining backup after successful deletion removes the opener", async () => {
  await root.rerender(<History />);
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
        restoreAssessment={{
          action: "backup_restore",
          availability: "allowed",
          reason: "available",
        }}
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
  await root.rerender(<RefreshedHistory />);
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
  await root.rerender(<History />);
  await openDeletion("backup-2");
  await click("Delete this backup permanently");
  const remaining = container.querySelector(
    '[data-backup-id="backup-1"] button[aria-label^="Delete"]',
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(remaining));
});

it("returns focus to the backup heading when the final backup is deleted", async () => {
  await root.rerender(<History initial={backups.slice(0, 1)} />);
  await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(container.textContent).toContain("No backups yet");
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(container.querySelector('[role="heading"]')),
  );
});

it("returns focus to visible Saved data when the uninstalled detail consumer removes all backup history", async () => {
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
        opening={{ token: 1, destination: "saves" }}
        port={portDefinition()}
        backups={current}
        libraryGeneration={7}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />
    );
  }
  await root.rerender(<DetailHistory />);
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(deleteBackup).toHaveBeenCalledExactlyOnceWith(
    fixtureValue(backups[0], "backups[0]"),
    "reviewed-data",
  );
  expect(opener.isConnected).toBe(false);
  expect(container.querySelector(".backup-history")).toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      [...container.querySelectorAll("h3")].find((heading) => heading.textContent === "Saved data"),
    ),
  );
  await act(async () => finish(true));
  expect(document.activeElement).toBe(
    [...container.querySelectorAll("h3")].find((heading) => heading.textContent === "Saved data"),
  );
});

it("returns focus to the original delete action on cancellation without applying", async () => {
  const remove = vi.fn();
  await root.rerender(<History remove={remove} />);
  const opener = await openDeletion("backup-2");
  await click("Cancel");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(remove).not.toHaveBeenCalled();
});

it("keeps a failed deletion in review, then returns focus to its opener on cancellation", async () => {
  const remove = vi.fn().mockResolvedValue(false);
  await root.rerender(<History remove={remove} />);
  const opener = await openDeletion("backup-1");
  await click("Delete this backup permanently");
  expect(remove).toHaveBeenCalledExactlyOnceWith(
    fixtureValue(backups[0], "backups[0]"),
    "reviewed-data",
  );
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
  await root.rerender(
    <BackupHistory
      restoreAssessment={{
        action: "backup_restore",
        availability: "allowed",
        reason: "available",
      }}
      backups={backups}
      generation={7}
      restore={restore}
      remove={vi.fn()}
    />,
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
  await root.rerender(
    <BackupHistory
      restoreAssessment={{
        action: "backup_restore",
        availability: "allowed",
        reason: "available",
      }}
      backups={backups}
      generation={7}
      restore={restore}
      remove={vi.fn()}
    />,
  );
  const opener = container.querySelector<HTMLButtonElement>(
    '[data-backup-id="backup-1"] button[data-backup-action="restore"]',
  )!;
  await act(async () => {
    opener.focus();
    opener.click();
  });
  await click("Restore this backup");
  expect(restore).toHaveBeenCalledExactlyOnceWith(
    fixtureValue(backups[0], "backups[0]"),
    "reviewed-data",
  );
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});

it("does not open a review when recovery requires backup actions to stay disabled", async () => {
  await root.rerender(
    <BackupHistory
      restoreAssessment={{
        action: "backup_restore",
        availability: "allowed",
        reason: "available",
      }}
      backups={backups}
      state="recovery_required"
      restore={vi.fn()}
      remove={vi.fn()}
    />,
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
      restoreAssessment={current.inventory.restore_assessment}
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
  await root.rerender(<ReadHistory />);
  expect(container.textContent).not.toContain("No backups yet");
  expect(container.textContent).toContain("Loading backup history");
});

it("keeps a failed initial read unknown until a successful read-only retry", async () => {
  const read = vi
    .spyOn(desktopApi, "backups")
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "waiting" as const,
        reason: "missing_backup" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: [],
      problems: [],
    });
  const remove = vi.fn();
  const restore = vi.fn();
  await root.rerender(<ReadHistory remove={remove} restore={restore} />);
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
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "waiting" as const,
        reason: "missing_backup" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups,
      problems: [],
    })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: [],
      problems: [],
    });
  const remove = vi.fn();
  const restore = vi.fn();
  await root.rerender(<ReadHistory remove={remove} restore={restore} />);
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
  await root.rerender(<ReadHistory />);
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
  await act(async () =>
    finish({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "waiting" as const,
        reason: "missing_backup" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups,
      problems: [],
    }),
  );
  expect(retry.disabled).toBe(false);
  expect(document.activeElement).toBe(retry);
  expect(container.textContent).toContain("2 verified backups");
});

function DetailReadHistory({
  portId = "sample",
  observe,
}: {
  portId?: string;
  observe?: (refresh: () => Promise<void>) => void;
}) {
  const port = { ...portDefinition(), id: portId };
  const current = usePortBackups(portId);
  observe?.(current.refresh);
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
      opening={{ token: 1, destination: "saves" }}
      port={port}
      backups={current.backups}
      backupProblems={current.inventory.problems}
      backupState={current.inventory.state}
      backupCreateAssessment={current.inventory.create_assessment}
      backupRestoreAssessment={current.inventory.restore_assessment}
      backupReadState={current.readState}
      retryBackupRead={current.refresh}
      libraryGeneration={7}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />
  );
}

it.each(
  [
    {
      action: "backup_create",
      availability: "allowed",
      reason: "available",
      definition: { outcome: "hold", reason: "publisher_revoked" },
    },
    { action: "backup_create", availability: "allowed", reason: "missing_data" },
    { action: "backup_restore", availability: "allowed", reason: "available" },
    { action: "backup_create", availability: "future", reason: "available" },
  ].map((assessment, index) => ({
    name: ["definition hold", "wrong reason", "wrong action", "future state"][index],
    assessment,
  })),
)("does not create a backup for $name", async ({ assessment }) => {
  vi.spyOn(desktopApi, "backups").mockResolvedValue({
    port_id: "sample",
    state: "healthy",
    backups,
    problems: [],
    create_assessment: assessment as never,
    restore_assessment: { action: "backup_restore", availability: "allowed", reason: "available" },
  });
  const create = vi.spyOn(desktopApi, "backup");
  await root.rerender(<DetailReadHistory />);
  const button = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Back up data",
  );
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(create).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Current backup availability is unavailable");
});

it("projects restore-only recovery separately from deletion and refuses stale eligibility after a failed read", async () => {
  let refresh!: () => Promise<void>;
  const inventory: BackupInventory = {
    port_id: "sample",
    state: "healthy",
    backups,
    problems: [],
    create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
    restore_assessment: {
      action: "backup_restore",
      availability: "held",
      reason: "recovery_required",
    },
  };
  vi.spyOn(desktopApi, "backups")
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce({
      ...inventory,
      restore_assessment: {
        action: "backup_restore",
        availability: "allowed",
        reason: "available",
      },
    })
    .mockRejectedValueOnce(failureReport());
  await root.rerender(
    <DetailReadHistory
      observe={(value) => {
        refresh = value;
      }}
    />,
  );
  const restore = () =>
    container.querySelector<HTMLButtonElement>('button[data-backup-action="restore"]')!;
  const remove = () =>
    container.querySelector<HTMLButtonElement>('button[data-backup-action="delete"]')!;
  expect(restore().disabled).toBe(true);
  expect(remove().disabled).toBe(false);
  expect(container.textContent).toContain("Restoring requires recovery to finish");
  await act(async () => restore().click());
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
  await act(async () => refresh());
  expect(restore().disabled).toBe(false);
  await act(async () => refresh());
  expect(restore().disabled).toBe(true);
  expect(remove().disabled).toBe(false);
  expect(container.textContent).toContain("Restore eligibility is unknown");
  await act(async () => restore().click());
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
});

it("holds Restore during a pending refresh and when an assessment is absent", async () => {
  let refresh!: () => Promise<void>;
  let finish!: (inventory: BackupInventory) => void;
  const inventory: BackupInventory = {
    port_id: "sample",
    state: "healthy",
    backups,
    problems: [],
    create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
    restore_assessment: { action: "backup_restore", availability: "allowed", reason: "available" },
  };
  vi.spyOn(desktopApi, "backups")
    .mockResolvedValueOnce(inventory)
    .mockReturnValueOnce(
      new Promise<BackupInventory>((resolve) => {
        finish = resolve;
      }),
    );
  await root.rerender(
    <DetailReadHistory
      observe={(value) => {
        refresh = value;
      }}
    />,
  );
  const restore = () =>
    container.querySelector<HTMLButtonElement>('button[data-backup-action="restore"]')!;
  expect(restore().disabled).toBe(false);
  let pending!: Promise<void>;
  await act(async () => {
    pending = refresh();
  });
  expect(restore().disabled).toBe(true);
  await act(async () => restore().click());
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
  await act(async () => {
    finish(inventory);
    await pending;
  });
  expect(restore().disabled).toBe(false);
  await root.rerender(<BackupHistory backups={backups} restore={vi.fn()} remove={vi.fn()} />);
  expect(restore().disabled).toBe(true);
  await act(async () => restore().click());
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
});

it("offers retained owned-data backup without an install and rejects last-loaded availability after refresh fails", async () => {
  let refresh!: () => Promise<void>;
  vi.spyOn(desktopApi, "backups")
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      backups: [],
      problems: [],
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "waiting" as const,
        reason: "missing_backup" as const,
      },
      create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
    })
    .mockRejectedValueOnce(failureReport());
  await root.rerender(
    <DetailReadHistory
      observe={(value) => {
        refresh = value;
      }}
    />,
  );
  const button = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (value) => value.textContent?.trim() === "Back up data",
    )!;
  expect(button()).toBeDefined();
  expect(button().disabled).toBe(false);
  expect(container.textContent).toContain("Back up saves and settings managed by Portcove.");
  await act(async () => refresh());
  expect(button().disabled).toBe(true);
  expect(container.textContent).toContain("Your saved data could not be checked.");
});

it("waits for current degraded inventory rather than a pending or failed read notice", async () => {
  const element = (node: Element) => ({
    findElements: async (selector: string) => [...node.querySelectorAll(selector)],
  });
  const browser = {
    findElements: async (selector: string) =>
      [...container.querySelectorAll(selector)].map(element),
    wait: async <T,>(predicate: () => Promise<T>, deadline: number) => {
      expect(deadline).toBe(15_000);
      return predicate();
    },
  };
  const { waitForDegradedInventory, degradedInventorySelector } =
    await import("../../../scripts/desktop-backup-inventory-observer.mts");
  const current = (count: number) =>
    waitForDegradedInventory(
      {
        readNotices: () => browser.findElements(degradedInventorySelector),
        readProblems: (notice) => notice.findElements("ul li"),
        wait: browser.wait,
      },
      count,
    );
  const render = async (status: "pending" | "failed" | "idle" | "current") =>
    root.rerender(
      <section aria-labelledby="detail-saves-and-storage">
        <BackupHistory
          restoreAssessment={{
            action: "backup_restore",
            availability: "allowed",
            reason: "available",
          }}
          backups={backups}
          state="degraded"
          problems={[
            {
              kind: "missing_manifest",
              backup_id: "broken",
              operation_id: null,
              path: "backups/broken",
              message: "Missing manifest",
              proposed_action: "Review this entry.",
            },
          ]}
          readState={{ status, hasInventory: true }}
          restore={vi.fn()}
          remove={vi.fn()}
        />
      </section>,
    );
  for (const status of ["pending", "failed"] as const) {
    await render(status);
    expect(container.querySelectorAll(".backup-inventory-notice")).toHaveLength(2);
    expect(await current(1)).toBe(false);
  }
  await render("idle");
  expect(await current(1)).toBe(false);
  await render("current");
  expect(await current(2)).toBe(false);
  expect(await current(1)).toBeTruthy();
  vi.spyOn(desktopApi, "backups").mockResolvedValueOnce({
    port_id: "sample",
    state: "degraded",
    backups,
    restore_assessment: {
      action: "backup_restore" as const,
      availability: "allowed" as const,
      reason: "available" as const,
    },
    create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
    problems: [
      {
        kind: "missing_manifest",
        backup_id: "broken",
        operation_id: null,
        path: "backups/broken",
        message: "Missing manifest",
        proposed_action: "Review this entry.",
      },
    ],
  });
  await root.rerender(<DetailReadHistory />);
  expect(container.querySelector(".backup-history")?.getAttribute("data-backup-read-state")).toBe(
    "current",
  );
  expect(await current(1)).toBeTruthy();
  expect(desktopApi.previewBackupAction).not.toHaveBeenCalled();
});

it("routes the actual native backup selector to visible owned controls without opening unrelated disclosures or consenting", async () => {
  const { default: native } = await import("../../../scripts/desktop-backup-review-test.mts?raw");
  const selector = native.match(/^const backupSectionSelector = '([^']+)';$/mu)?.[1];
  expect(selector).toBeDefined();
  expect(native).not.toContain('By.css("summary.advanced-summary")');
  vi.spyOn(desktopApi, "backups").mockResolvedValueOnce({
    port_id: "sample",
    state: "healthy",
    backups,
    problems: [],
    restore_assessment: {
      action: "backup_restore" as const,
      availability: "allowed" as const,
      reason: "available" as const,
    },
    create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
  });
  const apply = vi.spyOn(desktopApi, "restoreBackup");
  await root.rerender(<DetailReadHistory />);
  const row = container.querySelector(`${selector} [data-backup-id="backup-1"]`)!;
  expect(row).not.toBeNull();
  expect(row.closest("details:not([open])")).toBeNull();
  const restore = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Restore",
  )!;
  expect(restore.disabled).toBe(false);
  const create = container.querySelector<HTMLButtonElement>(
    `${selector} button[aria-describedby="backup-create-explanation"]`,
  )!;
  expect(create.disabled).toBe(false);
  expect(create.closest("details:not([open])")).toBeNull();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  await act(async () => restore.click());
  expect(document.body.querySelector('[aria-labelledby="backup-review-title"]')).not.toBeNull();
  expect(desktopApi.previewBackupAction).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "backup-1",
    "restore",
    7,
  );
  expect(apply).not.toHaveBeenCalled();
});

it("exposes a failed initial read through Saves & backups even without a known backup row", async () => {
  vi.spyOn(desktopApi, "backups").mockRejectedValueOnce(failureReport());
  await root.rerender(<DetailReadHistory />);
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
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: backups.slice(0, 1),
      problems: [],
    })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: backups.slice(1),
      problems: [],
    });
  const remove = vi
    .spyOn(desktopApi, "deleteBackup")
    .mockResolvedValueOnce(fixtureValue(backups[0], "backups[0]"));
  const restore = vi.spyOn(desktopApi, "restoreBackup");
  await root.rerender(<DetailReadHistory />);
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
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: [],
      problems: [],
    });
  await root.rerender(<DetailReadHistory />);
  // Finish the opening's animation-frame focus before exercising an intentional retry.
  await expect
    .poll(() => document.activeElement)
    .toBe(container.querySelector("#detail-section-saves"));
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
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups,
      problems: [],
    })
    .mockRejectedValueOnce(failureReport())
    .mockResolvedValueOnce({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups,
      problems: [],
    });
  const restore = vi.spyOn(desktopApi, "restoreBackup").mockResolvedValueOnce({
    restored_backup: fixtureValue(backups[0], "backups[0]"),
    safety_backup: null,
  });
  const remove = vi.spyOn(desktopApi, "deleteBackup");
  await root.rerender(<DetailReadHistory />);
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
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Backups"));
  expect(opener.disabled).toBe(true);
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
    .mockResolvedValueOnce({
      port_id: "other",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups: [],
      problems: [],
    });
  await root.rerender(<DetailReadHistory />);
  await click("Retry backup history");
  expect(container.textContent).toContain("Loading backup history");
  await root.rerender(<DetailReadHistory portId="other" />);
  await click("Retry backup history");
  expect(read.mock.calls).toEqual([["sample"], ["sample"], ["other"], ["other"]]);
  expect(container.textContent).toContain("No backups yet");
  await act(async () =>
    finishOld({
      port_id: "sample",
      state: "healthy",
      restore_assessment: {
        action: "backup_restore" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
      create_assessment: {
        action: "backup_create",
        availability: "allowed",
        reason: "available",
      } as const,
      backups,
      problems: [],
    }),
  );
  expect(container.querySelectorAll(".backup-row")).toHaveLength(0);
  expect(container.textContent).toContain("No backups yet");
});
