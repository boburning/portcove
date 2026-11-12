import {
  reasons,
  routes,
  states,
  type GameFileFilterContext,
} from "../features/browsing/game-file-query-context";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { platformLabel, releaseChannelPresentation } from "../view-model";

/** Present the same accepted observation used by the catalog, without another check. */
export function GameFileFilterObservation({
  portId,
  context,
}: {
  portId: string;
  context?: GameFileFilterContext | undefined;
}) {
  const { t } = useAppTranslation("gameFiles");
  const projection = context?.byPort.get(portId);
  if (!projection || projection.port_id !== portId) return null;
  return (
    <section aria-label={t("filterObservation.heading")} className="space-y-2">
      <h2>{t("filterObservation.heading")}</h2>
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
          {/* The identity triple is exact catalog data, never interpolated. */}
          <Trans
            t={t}
            i18nKey="filterObservation.completeSet"
            components={{
              identity: (
                <bdi dir="ltr">
                  {`${projection.identity.game_id} / ${projection.identity.variant_id} / ${projection.identity.representation_id}`}
                </bdi>
              ),
            }}
          />
        </p>
      )}
      <p className="text-sm text-pc-muted-foreground">{t("filterObservation.scope")}</p>
    </section>
  );
}
