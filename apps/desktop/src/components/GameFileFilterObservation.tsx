import {
  reasons,
  routes,
  states,
  type GameFileFilterContext,
} from "../features/browsing/game-file-query-context";
import { platformLabel, releaseChannelPresentation } from "../view-model";

/** Present the same accepted observation used by the catalog, without another check. */
export function GameFileFilterObservation({
  portId,
  context,
}: {
  portId: string;
  context?: GameFileFilterContext | undefined;
}) {
  const projection = context?.byPort.get(portId);
  if (!projection || projection.port_id !== portId) return null;
  return (
    <section aria-label="Catalog game-file observation" className="space-y-2">
      <h2>Catalog game-file observation</h2>
      <p>{states[projection.state]}</p>
      <p>{reasons[projection.reason]}</p>
      <p className="text-sm text-pc-muted-foreground">
        {routes.find((route) => route.value === projection.route)?.label}
        {" · "}
        {platformLabel(projection.platform)}
        {" · "}
        {releaseChannelPresentation(projection.channel).label}
      </p>
      {projection.state === "files_available" && projection.identity && (
        <p>
          Complete set: {projection.identity.game_id} / {projection.identity.variant_id} /{" "}
          {projection.identity.representation_id}
        </p>
      )}
      <p className="text-sm text-pc-muted-foreground">
        This observation is used by catalog filters. Setup and launch perform their own checks.
      </p>
    </section>
  );
}
