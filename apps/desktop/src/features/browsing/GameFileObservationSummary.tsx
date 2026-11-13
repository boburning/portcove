import { platformLabel, releaseChannelPresentation } from "../../view-model";
import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
import { gameFileRouteLabel } from "./game-file-query-context";
import type { GameFileObservationPresentation } from "./use-game-file-observation";

function observationStatus(
  t: TFunction<"gameFiles">,
  { outcome, usable, expired }: GameFileObservationPresentation,
  catalog: boolean,
) {
  if (outcome === "checking")
    return catalog ? t("summary.checkingCatalog") : t("summary.checkingSelected");
  if (outcome === "waiting") return t("summary.waiting");
  if (outcome === "failed") return t("summary.failed");
  if (outcome === "cancelled") return t("summary.cancelled");
  if (expired) return t("summary.expired");
  if (usable) return catalog ? t("summary.readyCatalog") : t("summary.readySelected");
  return catalog ? t("summary.missingCatalog") : t("summary.missingSelected");
}

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
  const { t } = useAppTranslation("gameFiles");
  const { lastAccepted, usable, expired } = observation;
  if (portId !== undefined && !lastAccepted?.routes.some((route) => route.port_id === portId))
    return null;
  const scope = lastAccepted?.routes[0];
  const status = observationStatus(t, observation, catalog);
  return (
    <div className="space-y-1">
      <p role="status">{status}</p>
      {lastAccepted && scope && (
        <div
          className="space-y-1 text-sm text-pc-muted-foreground"
          aria-label={catalog ? t("summary.catalogHistory") : t("summary.selectedHistory")}
        >
          <p>
            {/* Dates use the system regional format, inserted as an exact value. */}
            <Trans
              t={t}
              i18nKey={usable ? "summary.lastChecked" : "summary.previousCheck"}
              components={{
                time: (
                  <time dateTime={new Date(lastAccepted.observedAt * 1000).toISOString()}>
                    {new Date(lastAccepted.observedAt * 1000).toLocaleString()}
                  </time>
                ),
              }}
            />
          </p>
          <p>
            {catalog
              ? t("summary.catalogScope", { count: lastAccepted.routes.length })
              : t("summary.selectedScope")}
            {" · "}
            {gameFileRouteLabel(t, scope.route)}
            {" · "}
            {platformLabel(scope.platform)}
            {" · "}
            {releaseChannelPresentation(scope.channel).label}
          </p>
          {!usable && (
            <p>
              {expired
                ? catalog
                  ? t("summary.expiredCatalog")
                  : t("summary.expiredSelected")
                : catalog
                  ? t("summary.informationalCatalog")
                  : t("summary.informationalSelected")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
