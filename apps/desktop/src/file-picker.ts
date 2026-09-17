import { open, save } from "@tauri-apps/plugin-dialog";
import type { SourceProfile } from "./types";

export type SourcePickerPurpose = "game" | "bios";

export function pickArtworkPath() {
  return open({
    title: "Choose local artwork",
    multiple: false,
    directory: false,
    filters: [{ name: "Static PNG or JPEG image", extensions: ["png", "jpg", "jpeg"] }],
  });
}

export async function pickSourcePath(
  profile: SourceProfile,
  currentPath: string,
  purpose: SourcePickerPurpose = "game",
) {
  if (profile.kind === "file-set" && currentPath.toLowerCase().endsWith(".zip")) {
    return pickSourceArchivePath(currentPath, purpose);
  }
  const directory =
    profile.kind === "file-set" ||
    (profile.kind === "psx-disc" && (profile.disc?.discs?.length ?? 0) > 1);
  const extensions = profile.accepted_extensions.map((extension) =>
    extension.replace(/^\./, "").toLowerCase(),
  );
  if (
    (!profile.kind || profile.kind === "file") &&
    extensions.length &&
    !extensions.includes("zip")
  )
    extensions.push("zip");
  return open({
    multiple: false,
    directory,
    defaultPath: currentPath || undefined,
    filters:
      !directory && extensions.length
        ? [
            {
              name: purpose === "bios" ? "Required BIOS file or ZIP" : "Original game file",
              extensions,
            },
          ]
        : undefined,
  });
}

export function pickSourceArchivePath(currentPath: string, purpose: SourcePickerPurpose = "game") {
  return open({
    multiple: false,
    directory: false,
    defaultPath: currentPath || undefined,
    filters: [
      {
        name:
          purpose === "bios"
            ? "ZIP file containing the required BIOS"
            : "ZIP file containing required game files",
        extensions: ["zip"],
      },
    ],
  });
}

export function pickInstallFolder(currentPath: string) {
  return open({
    multiple: false,
    directory: true,
    defaultPath: currentPath || undefined,
  });
}

export function pickLibraryFolder(currentPath: string) {
  return open({
    title: "Choose Portcove library",
    multiple: false,
    directory: true,
    defaultPath: currentPath || undefined,
  });
}

export function pickGameOutputFolder(currentPath: string) {
  return open({
    title: "Choose Export / install folder",
    multiple: false,
    directory: true,
    defaultPath: currentPath || undefined,
  });
}

export function pickHostToolExecutable(displayName: string, currentPath: string) {
  return open({
    title: `Locate ${displayName} executable`,
    multiple: false,
    directory: false,
    defaultPath: currentPath || undefined,
  });
}

export function pickMetadataExportPath() {
  return save({
    title: "Export library metadata",
    defaultPath: "portcove-library.json",
    filters: [{ name: "Portcove library metadata", extensions: ["json"] }],
  });
}

export function pickMetadataImportPath() {
  return open({
    title: "Choose library metadata",
    multiple: false,
    directory: false,
    filters: [{ name: "Portcove library metadata", extensions: ["json"] }],
  });
}

export function pickSignedCatalogPath() {
  return open({
    title: "Choose signed catalog",
    multiple: false,
    directory: false,
    filters: [{ name: "Signed Portcove catalog", extensions: ["json"] }],
  });
}
