import type { DetailDestination } from "../../view-model";

export const detailSections = ["overview", "files", "saves", "versions", "manage"] as const;
export type DetailSection = (typeof detailSections)[number];
export type DetailOpening = { token: number; destination?: DetailDestination | undefined };

/** Existing operation names identify their presentation home; this grants no action. */
export function detailWorkSection(operation: string): DetailSection {
  if (
    ["verify", "remove", "storage location", "Steam shortcut", "change artwork"].includes(operation)
  )
    return "manage";
  if (["back up data", "delete backup", "restore backup", "open data folder"].includes(operation))
    return "saves";
  if (
    [
      "check",
      "run reviewed game update",
      "acquire_game_update",
      "discard_game_update_acquisition",
      "activate staged update",
      "rollback",
      "channel",
      "policy",
    ].includes(operation)
  )
    return "versions";
  return "files";
}

export function initialDetailSection({
  destination,
  needsFiles,
  hasUpdate,
}: {
  destination?: DetailDestination | undefined;
  needsFiles: boolean;
  hasUpdate: boolean;
}): DetailSection {
  if (destination) return destination === "updates" ? "versions" : destination;
  if (needsFiles) return "files";
  return hasUpdate ? "versions" : "overview";
}
