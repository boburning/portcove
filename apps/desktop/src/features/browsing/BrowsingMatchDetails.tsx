import { useState } from "react";
import type { CatalogQueryResult } from "./catalog-query";
import {
  platformLabel,
  releaseChannelPresentation,
  installationMethodLabels,
} from "../../view-model";
import { Button } from "../../components/ui/button";
import type { GameFileFilterContext } from "./game-file-query-context";
import { GameFileFilterObservation } from "../../components/GameFileFilterObservation";

/** Detail intent stays bound to the accepted workspace and exact matching context.
 * Execution still needs its independent fresh Core review.
 */
export function BrowsingMatchDetails({
  portId,
  result,
  binding,
  gameFiles,
}: {
  portId: string;
  result?: CatalogQueryResult | undefined;
  binding?: string | undefined;
  gameFiles?: GameFileFilterContext | undefined;
}) {
  const [selected, setSelected] = useState<{
    binding: string;
    portId: string;
    contextId: string;
  }>();
  if (!result || !binding) return null;
  const contexts = result.matchingContexts.get(portId) ?? [];
  const current =
    selected?.binding === binding && selected.portId === portId
      ? contexts.find((fact) => fact.context_id === selected.contextId)
      : undefined;
  const lostChoice = selected?.portId === portId && !current;
  const choice = current ?? (!lostChoice && contexts.length === 1 ? contexts[0] : undefined);
  const observed = gameFiles?.byPort.get(portId);
  const matchingObservation =
    choice &&
    observed &&
    observed.route === choice.route &&
    observed.platform === choice.platform &&
    observed.channel === choice.channel &&
    observed.route_definition_sha256 === choice.definition_sha256 &&
    (observed.route_instance_sha256 ?? null) === choice.instance_sha256
      ? observed
      : undefined;
  const label = (fact: (typeof contexts)[number]) =>
    `${fact.member_context ? "Installed build" : "Setup"} · ${fact.platform ? platformLabel(fact.platform) : "Platform unknown"} · ${fact.channel ? releaseChannelPresentation(fact.channel).label : "Channel unknown"}${fact.release_version ? ` · ${fact.release_version}` : ""}`;
  return (
    <section aria-label="Matching browsing contexts" className="my-4 space-y-2">
      <h2>Matching versions for your filters</h2>
      {result.state !== "matched" ? (
        <p>
          These filter results are unavailable. Return to Filters to update your choices or check
          again.
        </p>
      ) : contexts.length === 0 ? (
        <p>
          {result.ports.some((port) => port.id === portId)
            ? "This game matches your filters. Version details are unavailable; Portcove checks requirements before setup or launch."
            : "This port no longer matches your filters."}
        </p>
      ) : (
        <>
          {lostChoice && (
            <p>Your previous choice is no longer current. Choose a matching version to inspect.</p>
          )}
          {!lostChoice && contexts.length > 1 && (
            <p>Choose a version to inspect. Each choice matches all selected filters.</p>
          )}
          {contexts.map((fact) => (
            <Button
              data-focusable
              key={fact.context_id}
              size="sm"
              variant={choice?.context_id === fact.context_id ? "selected" : "outline"}
              aria-pressed={choice?.context_id === fact.context_id}
              onClick={() => setSelected({ binding, portId, contextId: fact.context_id })}
            >
              {label(fact)}
            </Button>
          ))}
          {choice && (
            <p>
              {choice.installation_method
                ? installationMethodLabels[choice.installation_method]
                : "Saved setup method unknown"}
              .{" "}
              {choice.member_context
                ? "This is your matching saved installation."
                : "This setup option matches your filters."}{" "}
              Portcove checks the current requirements again before setup or launch.
            </p>
          )}
          {choice &&
            (matchingObservation && gameFiles ? (
              <GameFileFilterObservation
                portId={portId}
                context={{ ...gameFiles, byPort: new Map([[portId, matchingObservation]]) }}
              />
            ) : (
              <p>No current game-file check for this version. Check again.</p>
            ))}
        </>
      )}
    </section>
  );
}
