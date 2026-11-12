import { useState } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import {
  GameFileCheckError,
  useGameFileObservation,
} from "../features/browsing/use-game-file-observation";
import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import type { PortDefinition, ReleaseChannel } from "../types";
import { defaultPortPlatform, platformLabel, releaseChannelPresentation } from "../view-model";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";

import {
  acceptedGameFileQuery,
  gameFileReasonLabel,
  gameFileRouteLabel,
  gameFileStateLabel,
  gameFileCheckFailureText,
  routeValues,
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
        throw new GameFileCheckError("selection_mismatch");
      return snapshot;
    },
  });
  const { pending, current, operationId, error } = observation;
  const check = async () => {
    if (busy || !platform || !port.platforms.includes(platform)) return;
    await observation.refresh();
  };
  const projection = current?.routes[0];
  const { t } = useAppTranslation("gameFiles");
  return (
    <section className="my-4 grid gap-3" aria-label={t("query.label")}>
      <h2>{t("query.heading")}</h2>
      <ChoiceSelect
        label={t("query.route")}
        value={route}
        options={routeValues.map((value) => ({ value, label: gameFileRouteLabel(t, value) }))}
        disabled={pending || busy}
        onChange={setRoute}
      />
      <ChoiceSelect
        label={t("query.platform")}
        value={platform}
        options={port.platforms.map((value) => ({ value, label: platformLabel(value) }))}
        disabled={pending || busy}
        onChange={setPlatform}
      />
      <p>
        {/* The channel name follows the shared channel-label migration. */}
        <Trans
          t={t}
          i18nKey="query.channelScope"
          components={{ channel: <>{releaseChannelPresentation(channel).label}</> }}
        />
      </p>
      <Button
        data-focusable
        variant="outline"
        disabled={pending || busy || !port.platforms.includes(platform)}
        onClick={() => {
          void check();
        }}
      >
        {pending ? t("query.checking") : t("query.check")}
      </Button>
      {pending && operationId && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label={t("query.cancel")}
        />
      )}
      {projection && <p role="status">{gameFileStateLabel(t, projection.state)}</p>}
      {projection && <p>{gameFileReasonLabel(t, projection.reason)}</p>}
      <GameFileObservationSummary observation={observation.presentation} />
      {error && <p role="alert">{gameFileCheckFailureText(t, error)}</p>}
    </section>
  );
}
