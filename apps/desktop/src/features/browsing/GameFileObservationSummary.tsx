import { platformLabel, releaseChannelPresentation } from "../../view-model";
import { routes } from "./game-file-query-context";
import type { GameFileObservationPresentation } from "./use-game-file-observation";

/** Displays metadata independently of current classifications and matching-build evidence. */
export function GameFileObservationSummary({
  observation,
  catalog = false,
  portId,
}: {
  observation: GameFileObservationPresentation;
  catalog?: boolean;
  portId?: string;
}) {
  const { lastAccepted, usable, expired, outcome } = observation;
  if (portId !== undefined && !lastAccepted?.routes.some((route) => route.port_id === portId))
    return null;
  const scope = lastAccepted?.routes[0];
  const status =
    outcome === "checking"
      ? catalog
        ? "Checking complete catalog context…"
        : "Checking selected route…"
      : outcome === "waiting"
        ? "Waiting for the previous check to finish."
        : outcome === "failed"
          ? "The latest check failed. No current observation is available."
          : outcome === "cancelled"
            ? "The latest check was canceled. No current observation is available."
            : expired
              ? "Observation expired. Check again."
              : usable
                ? catalog
                  ? "Complete route observations available for filtering."
                  : "Current observation."
                : catalog
                  ? "Game-file choices need a current complete observation."
                  : "No current observation for this selection.";
  return (
    <div className="space-y-1">
      <p role="status">{status}</p>
      {lastAccepted && scope && (
        <div
          className="space-y-1 text-sm text-pc-muted-foreground"
          aria-label={catalog ? "Catalog check history" : "Selected-route check history"}
        >
          <p>
            {usable ? "Last checked" : "Previous check"}:{" "}
            <time dateTime={new Date(lastAccepted.observedAt * 1000).toISOString()}>
              {new Date(lastAccepted.observedAt * 1000).toLocaleString()}
            </time>
          </p>
          <p>
            {catalog
              ? `Complete catalog (${lastAccepted.routes.length} ${lastAccepted.routes.length === 1 ? "port" : "ports"})`
              : "Selected port"}
            {" · "}
            {routes.find((route) => route.value === scope.route)?.label}
            {" · "}
            {platformLabel(scope.platform)}
            {" · "}
            {releaseChannelPresentation(scope.channel).label}
          </p>
          {!usable && (
            <p>
              {expired
                ? "The previous observation expired. "
                : "The previous check is informational only. "}
              {catalog
                ? "To check again, open Filters → Check game-file filters."
                : "Use Check selected route game files to check again."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
