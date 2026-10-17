import { useState } from "react";
import { useGameFileObservation } from "../features/browsing/use-game-file-observation";
import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import type { PortDefinition, ReleaseChannel } from "../types";
import { defaultPortPlatform, platformLabel, releaseChannelPresentation } from "../view-model";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";

import {
  acceptedGameFileQuery,
  routes,
  states,
  reasons,
  type Route,
} from "../features/browsing/game-file-query-context";
export { acceptedGameFileQuery } from "../features/browsing/game-file-query-context";

export function GameFileQueryControl({
  port,
  channel,
  generation,
  context,
  busy,
}: {
  port: PortDefinition;
  channel: ReleaseChannel;
  generation: number;
  /** Accepted catalog, registration and installation observations; change invalidates the result. */
  context: string;
  busy?: boolean;
}) {
  const [route, setRoute] = useState<Route["route"]>("managed_install");
  const [platform, setPlatform] = useState<Route["platform"]>(() => defaultPortPlatform(port));
  const selected: Route = { port_id: port.id, platform, channel, route };
  const observation = useGameFileObservation({
    contextKey: JSON.stringify([port.id, channel, generation, context, route, platform]),
    generation,
    request: () => ({
      routes: [selected],
      maximum_age_seconds: 300,
      limits: {
        max_file_bytes: 2 * 1024 ** 3,
        max_hash_bytes: 32 * 1024 ** 3,
        max_elapsed_ms: 30_000,
      },
    }),
    accept: (snapshot, _request, library, now) => {
      if (!acceptedGameFileQuery(snapshot, selected, library, now))
        throw new Error("The game-file observation no longer matches this selection. Check again.");
      return snapshot;
    },
  });
  const { pending, current, operationId, error } = observation;
  const check = async () => {
    if (busy || !platform || !port.platforms.includes(platform)) return;
    await observation.refresh();
  };
  const projection = current?.routes[0];
  return (
    <section className="my-4 grid gap-3" aria-label="Selected route game files">
      <h2>Game files for this route</h2>
      <ChoiceSelect
        label="Route"
        value={route}
        options={routes}
        disabled={pending || busy}
        onChange={setRoute}
      />
      <ChoiceSelect
        label="Target platform"
        value={platform}
        options={port.platforms.map((value) => ({ value, label: platformLabel(value) }))}
        disabled={pending || busy}
        onChange={setPlatform}
      />
      <p>
        Channel: {releaseChannelPresentation(channel).label}. This check observes connected files;
        setup and launch still require their own reviews and prerequisites.
      </p>
      <Button
        data-focusable
        variant="outline"
        disabled={pending || busy || !port.platforms.includes(platform)}
        onClick={() => {
          void check();
        }}
      >
        {pending ? "Checking game files…" : "Check selected route game files"}
      </Button>
      {pending && operationId && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label="Cancel game-file check"
        />
      )}
      {projection && <p role="status">{states[projection.state]}</p>}
      {projection && <p>{reasons[projection.reason]}</p>}
      <GameFileObservationSummary observation={observation.presentation} />
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
