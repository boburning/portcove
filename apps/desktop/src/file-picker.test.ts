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
      title: "Choose game files",
      multiple: false,
      directory: false,
      defaultPath: "D:/Sources/old.z64",
      filters: [{ name: "Original game file", extensions: ["z64", "n64", "zip"] }],
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
      title: "Choose game files",
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "Original game file", extensions: ["chd"] }],
    });
  });

  it("labels the BIOS chooser independently from original game files", async () => {
    await pickSourcePath(
      {
        ...sourceProfile(),
        id: "psx-scph-1001-bios",
        label: "PlayStation SCPH-1001 BIOS",
        accepted_extensions: ["BIN", "ROM"],
        accepted_sha1: ["10155d8d6e6e832d6ea66db9bc098321fb5e8ebf"],
        accepted_sha256: ["71af94d1e47a68c11e8fdb9f8368040601514a42a5a399cda48c7d3bff1e99d3"],
      },
      "",
      "bios",
    );
    expect(openMock).toHaveBeenCalledWith({
      title: "Choose BIOS file",
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "Required BIOS file or ZIP", extensions: ["bin", "rom", "zip"] }],
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
            accepted_sha1: ["1f890164ac4daeba07def64bb5b636bfaa1d3ab9"],
            accepted_sha256: ["385d416b651f8ab2a9dee78718e6dd7ae5d83af37507395b990c4d7923d9e5bd"],
            accepted_volume_ids: [],
            label: "Disc 1",
            track_counts: [1],
          },
          {
            accepted_sha1: ["9b8456c661722b032e24f2596840b06ea5cbdd46"],
            accepted_sha256: ["1b9c745af8f68bf58dcbb464c3bb0c16bfa87b72d99bfa6b39615fa052ce681a"],
            accepted_volume_ids: [],
            label: "Disc 2",
            track_counts: [1],
          },
          {
            accepted_sha1: ["0d9614fcd1288bbff2c53e690c6f626d3ac28fd0"],
            accepted_sha256: ["9afd82845c2b0388335c4bee04d78e946ae683c473a5f5c567cd944e11190414"],
            accepted_volume_ids: [],
            label: "Disc 3",
            track_counts: [1],
          },
        ],
      },
    };

    await expect(pickSourcePath(profile, "D:/Sources/Final Fantasy VII")).resolves.toBe(
      "D:/Sources/Final Fantasy VII",
    );
    expect(openMock).toHaveBeenCalledWith({
      title: "Choose game files",
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
      members: [
        {
          id: "cartridge",
          label: "F-Zero X (USA Rev 0) cartridge",
          accepted_filenames: ["baserom.us.rev0.z64"],
          accepted_sha1: ["5f658e88ffa9de23cba6986a8fd3d3a90d7b4340"],
          accepted_sha256: ["2be0f861c30752bbdfa727753a454108bc973c27ad814744f191b1278c1f482d"],
          accepted_crc32: [],
        },
      ],
    };

    await expect(pickSourcePath(profile, "")).resolves.toBe("D:/Sources/G-Diffuser");
    expect(openMock).toHaveBeenCalledWith({
      title: "Choose game files",
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
      title: "Choose game files",
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "ZIP file containing required game files", extensions: ["zip"] }],
    });
  });

  it("keeps a BIOS ZIP filter distinct from game-file archives", async () => {
    openMock.mockResolvedValue("D:/Sources/bios.zip");
    await expect(pickSourceArchivePath("", "bios")).resolves.toBe("D:/Sources/bios.zip");
    expect(openMock).toHaveBeenCalledWith({
      title: "Choose BIOS file",
      multiple: false,
      directory: false,
      defaultPath: undefined,
      filters: [{ name: "ZIP file containing the required BIOS", extensions: ["zip"] }],
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
    await expect(pickGameOutputFolder("F:/Games")).resolves.toBe("F:/Games/Sample");
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
