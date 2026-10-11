import { useState } from "react";
import type { CatalogQueryResult } from "./catalog-query";
import {
  platformLabel,
  releaseChannelPresentation,
  installationMethodLabels,
} from "../../view-model";
import { Button } from "../../components/ui/button";
import { states, type GameFileFilterContext } from "./game-file-query-context";

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
  result?: CatalogQueryResult;
  binding?: string;
  gameFiles?: GameFileFilterContext;
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
      <h2>Matching contexts for your filters</h2>
      {result.state !== "matched" ? (
        <p>
          The retained context is unavailable. Return to your filters to correct or refresh the
          context.
        </p>
      ) : contexts.length === 0 ? (
        <p>This port no longer matches your filters.</p>
      ) : (
        <>
          {lostChoice && (
            <p>Your previous choice is no longer current. Choose a matching context to inspect.</p>
          )}
          {!lostChoice && contexts.length > 1 && (
            <p>
              Choose a matching context to inspect. Each choice matches all selected filter groups.
            </p>
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
                : "Retained setup method unknown"}
              .{" "}
              {choice.member_context
                ? "This is the matching retained installation."
                : "This is a matching declared setup route."}{" "}
              Actions below require their own current Core review.
            </p>
          )}
          {choice && (
            <p>
              Game files for this context:{" "}
              {matchingObservation ? states[matchingObservation.state] : "observation unavailable"}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
