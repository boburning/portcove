import type { GameUpdateAcquisition } from "../../types";

export function gameUpdateAcquisitionLabel(phase: GameUpdateAcquisition["phase"]) {
  const labels: Record<GameUpdateAcquisition["phase"], string> = {
    acquiring: "Downloading archive",
    verifying: "Verifying archive",
    acquired: "Archive downloaded",
    attention_required: "Archive needs attention",
  };
  return Object.hasOwn(labels, phase) ? labels[phase] : "Archive status unavailable";
}
