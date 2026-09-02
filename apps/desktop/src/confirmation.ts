import { confirm } from "@tauri-apps/plugin-dialog";

export function confirmPortRemoval(portName: string) {
  return confirm(
    `Remove all Portcove-managed versions of ${portName}? Saves, configuration, mods, and original source files will be kept.`,
    {
      title: `Remove ${portName}`,
      kind: "warning",
      okLabel: "Remove managed files",
      cancelLabel: "Keep installed",
    },
  );
}

export function confirmBackupRestore(portName: string, createdAt: number) {
  const created = new Date(createdAt * 1000).toLocaleString();
  return confirm(
    `Restore ${portName} data from the backup created ${created}? Portcove will create a safety backup of current data before replacing it.`,
    {
      title: `Restore ${portName} data`,
      kind: "warning",
      okLabel: "Back up current data & restore",
      cancelLabel: "Keep current data",
    },
  );
}

export function confirmBackupDeletion(portName: string, createdAt: number) {
  const created = new Date(createdAt * 1000).toLocaleString();
  return confirm(
    `Permanently delete the ${portName} data backup created ${created}? Current game data and other backups will be kept.`,
    {
      title: `Delete ${portName} backup`,
      kind: "warning",
      okLabel: "Delete backup",
      cancelLabel: "Keep backup",
    },
  );
}
