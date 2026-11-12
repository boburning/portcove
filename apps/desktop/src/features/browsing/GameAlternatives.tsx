import { useLayoutEffect, useRef } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
import { Button } from "../../components/ui/button";
import { gameProjectLabel } from "../../port-identity";
import { platformLabel } from "../../view-model";
import type { PortStatus } from "../../types";
import type { Organization } from "../organization/OrganizationControls";
import type { CatalogEntry } from "./catalog-entry";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { originalGame } from "./original-game";

export function ImplementationFacts({
  port,
  status,
}: {
  port: CatalogEntry;
  status?: PortStatus | undefined;
}) {
  const { t } = useAppTranslation("browsing");
  const editions = originalGame(port)?.source_editions ?? [];
  // Catalog requirement labels; an all-empty list falls back like before.
  const requirements = port.presentation?.source_requirements
    ?.map((requirement) => requirement.label)
    .join("; ");
  return (
    <div className="grid gap-1 text-xs text-pc-muted-foreground">
      <p>{port.summary}</p>
      {/* Lists, requirement labels, edition titles and versions are exact values. */}
      <p>
        {port.platforms.length ? (
          <Trans
            t={t}
            i18nKey="alternatives.runsOn"
            components={{ platforms: <>{port.platforms.map(platformLabel).join(", ")}</> }}
          />
        ) : (
          t("alternatives.runsOnUnknown")
        )}
      </p>
      <p>
        {requirements ? (
          <Trans
            t={t}
            i18nKey="alternatives.originalFiles"
            components={{ files: <bdi>{requirements}</bdi> }}
          />
        ) : (
          t("alternatives.originalFilesUnknown")
        )}
      </p>
      {editions.length > 0 && (
        <p>
          <Trans
            t={t}
            i18nKey="alternatives.sourceEditions"
            components={{
              editions: <bdi>{editions.map((edition) => edition.title).join("; ")}</bdi>,
            }}
          />
        </p>
      )}
      <p>
        {status?.active ? (
          <Trans
            t={t}
            i18nKey="alternatives.managed"
            components={{ version: <bdi>{status.active.version}</bdi> }}
          />
        ) : status?.external_runtime ? (
          <Trans
            t={t}
            i18nKey="alternatives.external"
            components={{ version: <bdi>{status.external_runtime.version}</bdi> }}
          />
        ) : status ? (
          t("alternatives.notInstalled")
        ) : (
          t("alternatives.stateUnavailable")
        )}
      </p>
    </div>
  );
}

/** Focused detail-shell control; every alternative retains its own setup and action owner. */
export function GameAlternatives({
  port,
  ports,
  statuses,
  organization,
  onSelect,
}: {
  port: CatalogEntry;
  ports: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  organization: Organization;
  onSelect: (portId: string, originKey?: string) => void;
}) {
  const { t } = useAppTranslation("browsing");
  const root = useRef<HTMLDetailsElement>(null);
  const binding = JSON.stringify([port.id, ports.map((entry) => entry.id)]);
  const current = useRef<string | undefined>(binding);
  useLayoutEffect(() => {
    current.current = binding;
    return () => {
      current.current = undefined;
    };
  }, [binding]);
  if (ports.length < 2) return null;
  return (
    <details ref={root} className="min-w-0 basis-full text-sm">
      <summary data-focusable className="cursor-pointer py-2">
        {t("alternatives.heading", { total: ports.length })}
      </summary>
      <p className="mb-2 text-xs text-pc-muted-foreground">{t("alternatives.independence")}</p>
      <div className="grid gap-3">
        {ports.map((candidate) => (
          <div key={candidate.id} className="grid gap-2 rounded-pc-md border border-pc-border p-3">
            <strong>
              {candidate.id === port.id ? (
                <Trans
                  t={t}
                  i18nKey="alternatives.viewing"
                  components={{ name: <bdi>{gameProjectLabel(candidate) || candidate.name}</bdi> }}
                />
              ) : (
                <bdi>{gameProjectLabel(candidate) || candidate.name}</bdi>
              )}
            </strong>
            <ImplementationFacts port={candidate} status={statuses.get(candidate.id)} />
            <ImplementationChoice
              port={candidate}
              organization={organization}
              onSelected={(trigger) => {
                if (current.current === binding && ownsChoiceFocus(trigger, root.current))
                  onSelect(candidate.id, `detail:alternative:${candidate.id}`);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              data-focusable
              data-detail-origin={`detail:alternative:${candidate.id}`}
              onClick={() => onSelect(candidate.id, `detail:alternative:${candidate.id}`)}
            >
              <Trans
                t={t}
                i18nKey="alternatives.view"
                components={{ name: <bdi>{gameProjectLabel(candidate) || candidate.name}</bdi> }}
              />
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}
