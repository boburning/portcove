import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { pickInstallFolder, pickSourceArchivePath, pickSourcePath } from "./file-picker";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const openMock = vi.mocked(open);

describe("native path pickers", () => {
  beforeEach(() => openMock.mockReset());

  it("limits source selection to the profile extensions", async () => {
    openMock.mockResolvedValue("D:/Sources/game.z64");
    await expect(pickSourcePath({ id: "game", label: "Game", accepted_extensions: [".z64", "n64"] }, "D:/Sources/old.z64")).resolves.toBe("D:/Sources/game.z64");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      defaultPath: "D:/Sources/old.z64",
      filters: [{ name: "Original game source", extensions: ["z64", "n64"] }],
    });
  });

  it("selects one folder for a multi-disc PSX source", async () => {
    openMock.mockResolvedValue("D:/Sources/Final Fantasy VII");
    const profile = {
      id: "final-fantasy-vii-psx",
      label: "Final Fantasy VII three-disc set",
      kind: "psx-disc" as const,
      accepted_extensions: ["chd"],
      disc: {
        track_counts: [1],
        discs: [
          { label: "Disc 1", track_counts: [1] },
          { label: "Disc 2", track_counts: [1] },
          { label: "Disc 3", track_counts: [1] },
        ],
      },
    };

    await expect(pickSourcePath(profile, "D:/Sources/Final Fantasy VII")).resolves.toBe("D:/Sources/Final Fantasy VII");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
      defaultPath: "D:/Sources/Final Fantasy VII",
      filters: undefined,
    });
  });

  it("selects one folder for an exact file-set source", async () => {
    openMock.mockResolvedValue("D:/Sources/G-Diffuser");
    const profile = {
      id: "g-diffuser-set",
      label: "G-Diffuser source set",
      kind: "file-set" as const,
      accepted_extensions: [],
      members: [],
    };

    await expect(pickSourcePath(profile, "")).resolves.toBe("D:/Sources/G-Diffuser");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
      defaultPath: undefined,
      filters: undefined,
    });
  });

  it("selects a ZIP for a compressed exact file set", async () => {
    openMock.mockResolvedValue("D:/Sources/outrun.zip");
    await expect(pickSourceArchivePath("")).resolves.toBe("D:/Sources/outrun.zip");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "ZIP source set", extensions: ["zip"] }],
    });
  });

  it("opens a single directory picker and preserves cancellation", async () => {
    openMock.mockResolvedValue(null);
    await expect(pickInstallFolder("")).resolves.toBeNull();
    expect(openMock).toHaveBeenCalledWith({ multiple: false, directory: true, defaultPath: undefined });
  });
});
