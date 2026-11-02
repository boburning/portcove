import type { GameUpdateAcquisition } from "../../types";

export function gameUpdateAcquisitionLabel(phase: GameUpdateAcquisition["phase"]) {
  const labels: Record<GameUpdateAcquisition["phase"], string> = {
    acquiring: "Downloading update",
    verifying: "Checking downloaded update",
    acquired: "Update downloaded, not installed",
    attention_required: "Downloaded update needs attention",
  };
  return Object.hasOwn(labels, phase) ? labels[phase] : "Downloaded update status unavailable";
}
