import type { PortStatus } from "../../types";
import type { CatalogEntry } from "./catalog-entry";
import { originalGame, type GameGroup } from "./original-game";

export type GameChoice = {
  port?: CatalogEntry;
  reason: "explicit" | "installed" | "single" | "ambiguous" | "unavailable" | "stale" | "filtered";
  preferredPortId?: string;
};

/** Resolve display intent only. Existing Core assessments still govern every action. */
export function resolveGameChoice(
  group: GameGroup,
  statuses: ReadonlyMap<string, PortStatus>,
  preferences: Readonly<Record<string, string>> | undefined,
): GameChoice {
  const gameId = originalGame(group.ports[0]!)?.id;
  const preferredPortId = gameId && preferences?.[gameId];
  if (preferredPortId) {
    const port = group.ports.find((candidate) => candidate.id === preferredPortId);
    if (!port) return { reason: "stale", preferredPortId };
    if (!group.matchingPorts.some((candidate) => candidate.id === preferredPortId))
      return { reason: "filtered", preferredPortId };
    return { port, reason: "explicit", preferredPortId };
  }
  if (group.ports.length === 1) return { port: group.matchingPorts[0]!, reason: "single" };
  const installed = group.ports.filter((port) => {
    const status = statuses.get(port.id);
    return Boolean(status?.active || status?.external_runtime);
  });
  if (installed.length === 1) {
    const port = installed[0]!;
    return group.matchingPorts.some((candidate) => candidate.id === port.id)
      ? { port, reason: "installed" }
      : { reason: "filtered" };
  }
  // A preference read failure must not hide the established single-installed
  // offline path above. With several possibilities it cannot invent a choice.
  if (preferences === undefined) return { reason: "unavailable" };
  return { reason: "ambiguous" };
}
