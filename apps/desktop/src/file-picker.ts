import { open } from "@tauri-apps/plugin-dialog";
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
