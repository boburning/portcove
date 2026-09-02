import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@tauri-apps/plugin-dialog";
import { confirmBackupDeletion, confirmBackupRestore, confirmPortRemoval } from "./confirmation";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
const confirmMock = vi.mocked(confirm);

describe("managed-file removal confirmation", () => {
  beforeEach(() => confirmMock.mockReset());

  it("explains the preservation boundary and returns confirmation", async () => {
    confirmMock.mockResolvedValue(true);
    await expect(confirmPortRemoval("Lighthouse")).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("original source files will be kept"),
      expect.objectContaining({ kind: "warning", okLabel: "Remove managed files" }),
    );
  });

  it("preserves cancellation", async () => {
    confirmMock.mockResolvedValue(false);
    await expect(confirmPortRemoval("Lighthouse")).resolves.toBe(false);
  });
});

describe("backup restore confirmation", () => {
  beforeEach(() => confirmMock.mockReset());

  it("states that current data receives a safety backup", async () => {
    confirmMock.mockResolvedValue(true);
    await expect(confirmBackupRestore("Lighthouse", 1)).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("safety backup of current data"),
      expect.objectContaining({ kind: "warning", okLabel: "Back up current data & restore" }),
    );
  });
});

describe("backup deletion confirmation", () => {
  beforeEach(() => confirmMock.mockReset());

  it("separates one backup from current data and other snapshots", async () => {
    confirmMock.mockResolvedValue(true);
    await expect(confirmBackupDeletion("Lighthouse", 1)).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining("Current game data and other backups will be kept"),
      expect.objectContaining({ kind: "warning", okLabel: "Delete backup" }),
    );
  });
});
