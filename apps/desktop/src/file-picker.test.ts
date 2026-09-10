import { sourceProfile } from "./test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import {
  pickGameOutputFolder,
  pickHostToolExecutable,
  pickInstallFolder,
  pickSourceArchivePath,
  pickSourcePath,
} from "./file-picker";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const openMock = vi.mocked(open);

describe("native path pickers", () => {
  beforeEach(() => openMock.mockReset());

  it("includes supported cartridge ZIPs alongside the profile extensions", async () => {
    openMock.mockResolvedValue("D:/Sources/game.z64");
    await expect(
      pickSourcePath(
        {
          ...sourceProfile(),
          id: "game",
          label: "Game",
          accepted_extensions: [".z64", "n64"],
        },
        "D:/Sources/old.z64",
      ),
    ).resolves.toBe("D:/Sources/game.z64");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      defaultPath: "D:/Sources/old.z64",
      filters: [
        { name: "Original game source", extensions: ["z64", "n64", "zip"] },
      ],
    });
  });

  it("keeps single-disc selection limited to the declared disc formats", async () => {
    await pickSourcePath(
      {
        ...sourceProfile(),
        id: "disc",
        label: "Disc",
        kind: "psx-disc",
        accepted_extensions: ["CHD"],
      },
      "",
    );
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "Original game source", extensions: ["chd"] }],
    });
  });

  it("selects one folder for a multi-disc PSX source", async () => {
    openMock.mockResolvedValue("D:/Sources/Final Fantasy VII");
    const profile = {
      ...sourceProfile(),
      id: "final-fantasy-vii-psx",
      label: "Final Fantasy VII three-disc set",
      kind: "psx-disc" as const,
      accepted_extensions: ["chd"],
      disc: {
        track_counts: [1],
        discs: [
          {
            accepted_sha1: [],
            accepted_sha256: [],
            accepted_volume_ids: [],
            label: "Disc 1",
            track_counts: [1],
          },
          {
            accepted_sha1: [],
            accepted_sha256: [],
            accepted_volume_ids: [],
            label: "Disc 2",
            track_counts: [1],
          },
          {
            accepted_sha1: [],
            accepted_sha256: [],
            accepted_volume_ids: [],
            label: "Disc 3",
            track_counts: [1],
          },
        ],
      },
    };

    await expect(
      pickSourcePath(profile, "D:/Sources/Final Fantasy VII"),
    ).resolves.toBe("D:/Sources/Final Fantasy VII");
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
      ...sourceProfile(),
      id: "g-diffuser-set",
      label: "G-Diffuser source set",
      kind: "file-set" as const,
      accepted_extensions: [],
      members: [],
    };

    await expect(pickSourcePath(profile, "")).resolves.toBe(
      "D:/Sources/G-Diffuser",
    );
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
      defaultPath: undefined,
      filters: undefined,
    });
  });

  it("selects a ZIP for a compressed exact file set", async () => {
    openMock.mockResolvedValue("D:/Sources/outrun.zip");
    await expect(pickSourceArchivePath("")).resolves.toBe(
      "D:/Sources/outrun.zip",
    );
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
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
      defaultPath: undefined,
    });
  });

  it("names the per-game output picker without implying a library move", async () => {
    openMock.mockResolvedValue("F:/Games/Sample");
    await expect(pickGameOutputFolder("F:/Games")).resolves.toBe(
      "F:/Games/Sample",
    );
    expect(openMock).toHaveBeenCalledWith({
      title: "Choose Export / install folder",
      multiple: false,
      directory: true,
      defaultPath: "F:/Games",
    });
  });

  it("uses a neutral native executable picker without accepting probe arguments", async () => {
    openMock.mockResolvedValue(null);
    await expect(
      pickHostToolExecutable("DolphinTool", "D:/Tools/DolphinTool.exe"),
    ).resolves.toBeNull();
    expect(openMock).toHaveBeenCalledWith({
      title: "Locate DolphinTool executable",
      multiple: false,
      directory: false,
      defaultPath: "D:/Tools/DolphinTool.exe",
    });
  });
});
