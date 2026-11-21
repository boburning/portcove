import { createContext, type RefCallback } from "react";
import type { PortStatus } from "../../types";

/** The mounted detail header owns the control that the palette may activate. */
export const CurrentGamePlayControl = createContext<RefCallback<HTMLButtonElement> | null>(null);

export function currentGamePlayKey(portId: string, generation: number, status?: PortStatus) {
  return JSON.stringify([generation, portId, status?.active?.id, status?.external_runtime?.id]);
}
