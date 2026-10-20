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
  const fileSet = profile.kind === "file-set" || profile.kind === "relative-file-set";
  if (fileSet && currentPath.toLowerCase().endsWith(".zip")) {
    return pickSourceArchivePath(currentPath, purpose);
  }
  const directory =
    fileSet || (profile.kind === "psx-disc" && (profile.disc?.discs?.length ?? 0) > 1);
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
    title: purpose === "bios" ? "Choose BIOS file" : "Choose game files",
    multiple: false,
    directory,
    ...(currentPath ? { defaultPath: currentPath } : {}),
    ...(!directory && extensions.length
      ? {
          filters: [
            {
              name: purpose === "bios" ? "Required BIOS file or ZIP" : "Original game file",
              extensions,
            },
          ],
        }
      : {}),
  });
}

export function pickSourceArchivePath(currentPath: string, purpose: SourcePickerPurpose = "game") {
  return open({
    title: "Choose ZIP file",
    multiple: false,
    directory: false,
    ...(currentPath ? { defaultPath: currentPath } : {}),
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
    ...(currentPath ? { defaultPath: currentPath } : {}),
  });
}

export function pickGameFileFolder(currentPath: string) {
  return open({
    title: "Choose game-file folder",
    multiple: false,
    directory: true,
    ...(currentPath ? { defaultPath: currentPath } : {}),
  });
}

export function pickLibraryFolder(currentPath: string) {
  return open({
    title: "Choose Portcove library",
    multiple: false,
    directory: true,
    ...(currentPath ? { defaultPath: currentPath } : {}),
  });
}

export function pickSteamFolder(currentPath: string) {
  return open({
    title: "Choose Steam installation",
    multiple: false,
    directory: true,
    ...(currentPath ? { defaultPath: currentPath } : {}),
  });
}

export function pickGameOutputFolder(currentPath: string) {
  return open({
    title: "Choose install folder",
    multiple: false,
    directory: true,
    ...(currentPath ? { defaultPath: currentPath } : {}),
  });
}

export function pickHostToolExecutable(displayName: string, currentPath: string) {
  return open({
    title: `Locate ${displayName} executable`,
    multiple: false,
    directory: false,
    ...(currentPath ? { defaultPath: currentPath } : {}),
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
