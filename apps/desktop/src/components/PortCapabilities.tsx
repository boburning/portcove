import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import type { PortCapabilityReport, PortStatus } from "../types";
import { capabilityActionReason } from "../features/port-actions/port-action-presentation";
import { useAppTranslation } from "../localization";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui/button";

/** Catalog feature ids get player labels; an unrecognized id stays visible as data. */
function featureLabel(t: TFunction<"detail">, feature: string) {
  switch (feature) {
    case "setup":
      return t("capabilities.feature.setup");
    case "original-files":
      return t("capabilities.feature.originalFiles");
    case "launch":
      return t("capabilities.feature.launch");
    case "updates":
      return t("capabilities.feature.updates");
    case "settings":
      return t("capabilities.feature.settings");
    case "backup":
      return t("capabilities.feature.backup");
    case "restore":
      return t("capabilities.feature.restore");
    case "previous-version":
      return t("capabilities.feature.previousVersion");
    case "gameplay":
      return t("capabilities.feature.gameplay");
    case "controls":
      return t("capabilities.feature.controls");
    case "audio":
      return t("capabilities.feature.audio");
    case "performance":
      return t("capabilities.feature.performance");
    case "save-compatibility":
      return t("capabilities.feature.saveCompatibility");
    default:
      return feature;
  }
}

function modeLabel(
  t: TFunction<"detail">,
  mode: "automatic" | "manual" | "unavailable" | "unknown",
) {
  switch (mode) {
    case "automatic":
      return t("capabilities.mode.automatic");
    case "manual":
      return t("capabilities.mode.manual");
    case "unavailable":
      return t("capabilities.mode.unavailable");
    case "unknown":
      return t("capabilities.mode.unknown");
  }
}

function pathLabel(t: TFunction<"detail">, route: string) {
  switch (route) {
    case "managed":
      return t("capabilities.path.managed");
    case "accepted-external":
      return t("capabilities.path.acceptedExternal");
    case "existing-copy":
      return t("capabilities.path.existingCopy");
    case "user-selected":
      return t("capabilities.path.userSelected");
    case "installed":
      return t("capabilities.path.installed");
    case "not-installed":
      return t("capabilities.path.notInstalled");
    case "upstream-setup":
      return t("capabilities.path.upstreamSetup");
    default:
      return route;
  }
}

/** Selected-entry read only. Cancellation and generation keys prevent stale detail publication. */
export function PortCapabilities({
  entry,
  status,
  generation,
  detailsContext,
  busy = false,
}: {
  entry: CatalogEntry;
  status?: PortStatus | undefined;
  generation: number;
  detailsContext?: unknown;
  busy?: boolean | undefined;
}) {
  const { t } = useAppTranslation("detail");
  const [request, setRequest] = useState(0);
  const [detail, setDetail] = useState<{
    key: string;
    report?: PortCapabilityReport;
    failed?: boolean;
  }>();
  const key = JSON.stringify([
    entry.id,
    generation,
    status,
    entry.listing,
    entry.definition,
    entry.pendingSetup,
    detailsContext,
    busy,
    request,
  ]);
  const installation = status?.active?.id ?? status?.external_runtime?.id ?? null;
  useEffect(() => {
    if (busy) return;
    let current = true;
    void desktopApi.portCapabilities(entry.id, generation).then(
      (report) => {
        if (
          current &&
          report?.format_version === 1 &&
          Array.isArray(report.routes) &&
          report.port_id === entry.id &&
          report.routes.at(-1)?.install_id === installation
        )
          setDetail({ key, report });
      },
      () => {
        if (current) setDetail({ key, failed: true });
      },
    );
    return () => {
      // oxlint-disable-next-line react/immutability -- oxc#28401: effect-local cleanup binding.
      current = false;
    };
  }, [entry.id, generation, key, status, installation, busy]);
  const report = detail?.key === key ? detail.report : undefined;
  const cached = entry.listingStatus?.capabilities;
  const summary =
    report ??
    (cached?.format_version === 1 &&
    cached.port_id === entry.id &&
    Array.isArray(cached.routes) &&
    cached.routes.at(-1)?.install_id === installation
      ? cached
      : undefined);
  return (
    <section className="mt-4 grid gap-3" aria-label={t("capabilities.label")}>
      <h3>{t("capabilities.heading")}</h3>
      <Button
        data-focusable
        variant="outline"
        disabled={busy}
        onClick={() => setRequest((value) => value + 1)}
      >
        {t("capabilities.refresh")}
      </Button>
      {status?.external_runtime && <p className="text-sm">{t("capabilities.externalRuntime")}</p>}
      <p className="text-sm text-pc-muted-foreground">{t("capabilities.intro")}</p>
      {!summary && <p>{t("capabilities.unavailable")}</p>}
      {summary && (
        <details>
          <summary data-focusable>{t("capabilities.features")}</summary>
          {summary.routes.map((route, index) => (
            <div className="mt-3" key={`${route.route}:${index}`}>
              <h4>{pathLabel(t, route.route)}</h4>
              <dl className="detail-facts">
                {route.features.map((row) => (
                  <div key={row.feature}>
                    <dt>{featureLabel(t, row.feature)}</dt>
                    <dd>{t("capabilities.untested", { mode: modeLabel(t, row.mode) })}</dd>
                    <dd>{row.explanation}</dd>
                    {row.listing_action?.reason && <dd>{row.listing_action.reason}</dd>}
                    {row.action && (
                      <dd>
                        {capabilityActionReason(row.action)}
                        <details>
                          <summary data-focusable>{t("capabilities.assessment")}</summary>
                          <pre className="wrap-anywhere whitespace-pre-wrap">
                            {JSON.stringify(row.action, null, 2)}
                          </pre>
                        </details>
                      </dd>
                    )}
                    <dd>{row.next_step}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </details>
      )}
      {report?.settings?.available && report.settings.files.some((file) => !file.available) && (
        <p>{t("capabilities.settingsPartial")}</p>
      )}
      {report?.protection && (
        <p>
          {report.protection.latest_completed_backup
            ? t("capabilities.backupRecorded")
            : t("capabilities.backupNone")}
        </p>
      )}
      {report?.detail_problems.map((problem) => (
        <p key={problem}>{problem}</p>
      ))}
      {report && !["missing", "available"].includes(report.advisory_state) && (
        <p>{t("capabilities.noticesUnavailable")}</p>
      )}
      {report?.advisories.map(({ notice, applicability }) => (
        <div key={notice.id} className="text-sm">
          <strong>
            {t("capabilities.notice.heading", {
              feature: featureLabel(t, notice.feature),
              evidence: notice.evidence,
              applicability:
                applicability === "current-route"
                  ? t("capabilities.notice.current")
                  : applicability === "historical"
                    ? t("capabilities.notice.historical")
                    : t("capabilities.notice.exact"),
            })}
          </strong>
          <p>{notice.explanation}</p>
          <p>
            {t("capabilities.notice.scope", {
              scope: [
                notice.platform,
                pathLabel(t, notice.route),
                ...(notice.release
                  ? [t("capabilities.notice.release", { release: notice.release })]
                  : []),
                ...(notice.edition
                  ? [t("capabilities.notice.edition", { edition: notice.edition })]
                  : []),
                ...(notice.artifact_sha256
                  ? [t("capabilities.notice.file", { sha256: notice.artifact_sha256 })]
                  : []),
              ].join(t("capabilities.notice.separator")),
            })}
          </p>
          {(notice.release || notice.artifact_sha256 || notice.edition) && (
            <p>{t("capabilities.notice.versionSpecific")}</p>
          )}
          {notice.workaround && <p>{notice.workaround}</p>}
          <ExternalLink href={notice.provenance}>
            {t("capabilities.notice.source")}
          </ExternalLink> ·{" "}
          {new Date(notice.observed_at * 1000).toLocaleDateString()}
        </div>
      ))}
      {report && report.observations.length > 0 && (
        <details>
          <summary data-focusable>{t("capabilities.observations.summary")}</summary>
          <p>{t("capabilities.observations.intro")}</p>
          {report.observations.map((observation) => (
            <div key={observation.id} className="mt-2 text-sm">
              <p>{observation.explanation}</p>
              <p>{JSON.stringify(observation.scope)}</p>
              <ExternalLink href={observation.source}>
                {t("capabilities.observations.source")}
              </ExternalLink>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
