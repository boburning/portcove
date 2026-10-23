import type { DetailDestination } from "../../view-model";

export const detailSections = ["overview", "files", "saves", "versions"] as const;
export type DetailSection = (typeof detailSections)[number];
export type DetailOpening = { token: number; destination?: DetailDestination | undefined };

/** Existing operation names identify their presentation home; this grants no action. */
export function detailWorkSection(operation: string): DetailSection {
  if (["back up data", "delete backup", "restore backup", "open data folder"].includes(operation))
    return "saves";
  if (
    [
      "check",
      "run reviewed game update",
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
  if (destination) return destination === "updates" ? "versions" : "saves";
  if (needsFiles) return "files";
  return hasUpdate ? "versions" : "overview";
}
