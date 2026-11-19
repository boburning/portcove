import { hasUnconfirmedLaunchInput, portReadiness } from "../../view-model";
import type { CatalogEntry } from "../browsing/catalog-entry";
import type { PortStatus } from "../../types";
import type { InvocationRecord } from "./invocation-state";

/** Completed actions after which a launchable port is handed back to the player. */
const readyToPlayActions = new Set(["install", "prepare game data"]);

/**
 * Whether a finished invocation may say "ready to play" and offer Play. It uses the
 * same current readiness the Library and game page use, including Core's launch
 * assessment, and leaves external runtimes to the game page and its warnings.
 */
export function readyToPlayAfter(
  record: InvocationRecord,
  status: PortStatus | undefined,
  port: CatalogEntry | undefined,
) {
  if (
    record.outcome !== "succeeded" ||
    record.context.target.kind !== "port" ||
    !readyToPlayActions.has(record.name) ||
    !port ||
    !status ||
    status.external_runtime
  )
    return false;
  const readiness = portReadiness(status);
  return (
    (readiness === "ready" || readiness === "staged") && !hasUnconfirmedLaunchInput(status, port)
  );
}
