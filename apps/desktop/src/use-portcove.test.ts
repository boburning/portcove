import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./api";
import { confirmBackupDeletion, confirmBackupRestore, confirmPortRemoval } from "./confirmation";
import type { PortDefinition } from "./types";
import { detailActions, type Perform } from "./use-portcove";

vi.mock("./confirmation", () => ({ confirmBackupDeletion: vi.fn(), confirmBackupRestore: vi.fn(), confirmPortRemoval: vi.fn() }));
const confirmMock = vi.mocked(confirmPortRemoval);
const restoreConfirmMock = vi.mocked(confirmBackupRestore);
const deleteConfirmMock = vi.mocked(confirmBackupDeletion);

const port: PortDefinition = {
  id: "lighthouse",
  name: "Lighthouse",
  summary: "Native port",
  project_url: "https://example.com",
  support_tier: "stable",
  channels: ["stable"],
  platforms: ["windows-x86-64"],
  automated_tested_platforms: ["windows-x86-64"],
  manually_validated_platforms: ["windows-x86-64"],
  adapter: "libultraship-portable",
  persistent_paths: ["saves"],
  upstream_status: "active",
  release: {},
  executable_hints: {},
};

describe("detail removal action", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    restoreConfirmMock.mockReset();
    deleteConfirmMock.mockReset();
    vi.restoreAllMocks();
  });

  it("backs up through the shared operation boundary", async () => {
    vi.spyOn(desktopApi, "backup").mockResolvedValue({
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    });
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;

    await detailActions(port, undefined, "", "", perform, vi.fn()).backup();

    expect(perform).toHaveBeenCalledWith("back up data", expect.any(Function));
    expect(desktopApi.backup).toHaveBeenCalledWith(port.id);
  });

  it("does nothing when removal is cancelled", async () => {
    confirmMock.mockResolvedValue(false);
    const perform = vi.fn() as unknown as Perform;
    const close = vi.fn();

    await detailActions(port, undefined, "", "", perform, close).remove();

    expect(perform).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("restores only after confirmation and refreshes backup history", async () => {
    restoreConfirmMock.mockResolvedValue(true);
    const backup = {
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    };
    vi.spyOn(desktopApi, "restoreBackup").mockResolvedValue({ restored_backup: backup });
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const refresh = vi.fn().mockResolvedValue(undefined);

    await detailActions(port, undefined, "", "", perform, vi.fn(), undefined, refresh).restoreBackup(backup);

    expect(restoreConfirmMock).toHaveBeenCalledWith(port.name, backup.created_at);
    expect(desktopApi.restoreBackup).toHaveBeenCalledWith(port.id, backup.id);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("deletes one backup only after confirmation", async () => {
    deleteConfirmMock.mockResolvedValue(true);
    const backup = {
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    };
    vi.spyOn(desktopApi, "deleteBackup").mockResolvedValue(backup);
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const refresh = vi.fn().mockResolvedValue(undefined);

    await detailActions(port, undefined, "", "", perform, vi.fn(), undefined, refresh).deleteBackup(backup);

    expect(deleteConfirmMock).toHaveBeenCalledWith(port.name, backup.created_at);
    expect(desktopApi.deleteBackup).toHaveBeenCalledWith(port.id, backup.id);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("removes through the operation boundary and closes after success", async () => {
    confirmMock.mockResolvedValue(true);
    vi.spyOn(desktopApi, "remove").mockResolvedValue(["managed/version"]);
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const close = vi.fn();

    await detailActions(port, undefined, "", "", perform, close).remove();

    expect(perform).toHaveBeenCalledWith("remove", expect.any(Function));
    expect(desktopApi.remove).toHaveBeenCalledWith(port.id);
    expect(close).toHaveBeenCalledOnce();
  });
});
