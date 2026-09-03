import { open, save } from "@tauri-apps/plugin-dialog";
import type { SourceProfile } from "./types";

export async function pickSourcePath(profile: SourceProfile, currentPath: string) {
  if (profile.kind === "file-set" && currentPath.toLowerCase().endsWith(".zip")) {
    return pickSourceArchivePath(currentPath);
  }
  const directory = profile.kind === "file-set" || (profile.kind === "psx-disc" && (profile.disc?.discs?.length ?? 0) > 1);
  const extensions = profile.accepted_extensions.map(extension => extension.replace(/^\./, ""));
  return open({
    multiple: false,
    directory,
    defaultPath: currentPath || undefined,
    filters: !directory && extensions.length ? [{ name: "Original game source", extensions }] : undefined,
  });
}

export function pickSourceArchivePath(currentPath: string) {
  return open({
    multiple: false,
    directory: false,
    defaultPath: currentPath || undefined,
    filters: [{ name: "ZIP source set", extensions: ["zip"] }],
  });
}

export function pickInstallFolder(currentPath: string) {
  return open({ multiple: false, directory: true, defaultPath: currentPath || undefined });
}

export function pickMetadataExportPath() {
  return save({ title: "Export library metadata", defaultPath: "portcove-library.json", filters: [{ name: "Portcove library metadata", extensions: ["json"] }] });
}

export function pickMetadataImportPath() {
  return open({ title: "Choose library metadata", multiple: false, directory: false, filters: [{ name: "Portcove library metadata", extensions: ["json"] }] });
}

export function pickSignedCatalogPath() {
  return open({ title: "Choose signed catalog", multiple: false, directory: false, filters: [{ name: "Signed Portcove catalog", extensions: ["json"] }] });
}
