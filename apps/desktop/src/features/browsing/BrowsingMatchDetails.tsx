import { useState } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
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
  const { t } = useAppTranslation("browsing");
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
  // Only rendered once a matching choice exists.
  const method = (
    <>
      {choice?.installation_method
        ? installationMethodLabels[choice.installation_method]
        : t("match.methodUnknown")}
    </>
  );
  // A data list of independent labels; each part is a complete label or exact value.
  const label = (fact: (typeof contexts)[number]) =>
    [
      fact.member_context ? t("match.installedBuild") : t("match.setup"),
      fact.platform ? platformLabel(fact.platform) : t("match.platformUnknown"),
      fact.channel ? releaseChannelPresentation(fact.channel).label : t("match.channelUnknown"),
      ...(fact.release_version ? [fact.release_version] : []),
    ].join(" · ");
  return (
    <section aria-label={t("match.label")} className="my-4 space-y-2">
      <h2>{t("match.heading")}</h2>
      {result.state !== "matched" ? (
        <p>{t("match.unavailable")}</p>
      ) : contexts.length === 0 ? (
        <p>
          {result.ports.some((port) => port.id === portId)
            ? t("match.noDetails")
            : t("match.noLongerMatches")}
        </p>
      ) : (
        <>
          {lostChoice && <p>{t("match.lostChoice")}</p>}
          {!lostChoice && contexts.length > 1 && <p>{t("match.choose")}</p>}
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
              {/* The method label follows the shared view-model migration. */}
              {choice.member_context ? (
                <Trans
                  t={t}
                  i18nKey="match.savedInstallation"
                  components={{
                    method,
                  }}
                />
              ) : (
                <Trans
                  t={t}
                  i18nKey="match.setupOption"
                  components={{
                    method,
                  }}
                />
              )}
            </p>
          )}
          {choice &&
            (matchingObservation && gameFiles ? (
              <GameFileFilterObservation
                portId={portId}
                context={{ ...gameFiles, byPort: new Map([[portId, matchingObservation]]) }}
              />
            ) : (
              <p>{t("match.noCheck")}</p>
            ))}
        </>
      )}
    </section>
  );
}
