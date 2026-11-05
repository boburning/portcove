import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import type { PortCapabilityReport, PortStatus } from "../types";
import { capabilityActionReason } from "../features/port-actions/port-action-presentation";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui/button";

const featureLabels: Record<string, string> = {
  setup: "Setup",
  "original-files": "Original-file checking",
  launch: "Launch",
  updates: "Game updates",
  settings: "Settings",
  backup: "Backup",
  restore: "Restore",
  "previous-version": "Previous-version recovery",
  gameplay: "Gameplay",
  controls: "Controls",
  audio: "Audio",
  performance: "Performance",
  "save-compatibility": "Save compatibility",
};
const modeLabels = {
  automatic: "Available in Portcove",
  manual: "Manual",
  unavailable: "Unavailable in Portcove",
  unknown: "Unknown",
};
const routeLabels: Record<string, string> = {
  managed: "Managed setup",
  "accepted-external": "Accepted prepared package",
  "existing-copy": "Explicit existing-copy selection",
  "user-selected": "Your selected installation",
  installed: "Current installation",
  "not-installed": "Not installed · operation prerequisites",
  "upstream-setup": "Upstream setup and saved downloads",
};

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
    <section className="mt-4 grid gap-3" aria-label="What works and known issues">
      <h3>What works and known issues</h3>
      <Button
        data-focusable
        variant="outline"
        disabled={busy}
        onClick={() => setRequest((value) => value + 1)}
      >
        Refresh feature details
      </Button>
      {status?.external_runtime && (
        <p className="text-sm">Updates handled upstream · Backups not managed by Portcove</p>
      )}
      <p className="text-sm text-pc-muted-foreground">
        Availability and testing are separate. Each action checks its own current requirements.
      </p>
      {!summary && (
        <p>
          Feature details are unavailable. Use the current action assessments and setup
          instructions.
        </p>
      )}
      {summary && (
        <details>
          <summary data-focusable>Features and setup routes</summary>
          {summary.routes.map((route, index) => (
            <div className="mt-3" key={`${route.route}:${index}`}>
              <h4>{routeLabels[route.route] ?? route.route}</h4>
              <dl className="detail-facts">
                {route.features.map((row) => (
                  <div key={row.feature}>
                    <dt>{featureLabels[row.feature] ?? row.feature}</dt>
                    <dd>{modeLabels[row.mode]} · Not tested by this report</dd>
                    <dd>{row.explanation}</dd>
                    {row.listing_action?.reason && <dd>{row.listing_action.reason}</dd>}
                    {row.action && (
                      <dd>
                        {capabilityActionReason(row.action)}
                        <details>
                          <summary data-focusable>Assessment details</summary>
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
        <p>
          Settings are supported; some configuration files are not initialized or available. Open
          Settings for their current reasons.
        </p>
      )}
      {report?.protection && (
        <p>
          Latest completed backup:{" "}
          {report.protection.latest_completed_backup
            ? "Recorded; restore verifies the selected snapshot"
            : "None recorded"}
          . Review Saves & backups for effective coverage and exclusions.
        </p>
      )}
      {report?.detail_problems.map((problem) => (
        <p key={problem}>{problem}</p>
      ))}
      {report && !["missing", "available"].includes(report.advisory_state) && (
        <p>
          Optional known-issue notices are unavailable. Setup and launch retain their current
          assessments.
        </p>
      )}
      {report?.advisories.map(({ notice, applicability }) => (
        <div key={notice.id} className="text-sm">
          <strong>
            {featureLabels[notice.feature]} · {notice.evidence} ·{" "}
            {applicability === "current-route"
              ? "Applies to this route"
              : applicability === "historical"
                ? "Historical / different scope"
                : "Exact context required"}
          </strong>
          <p>{notice.explanation}</p>
          <p>
            Scope: {notice.platform} · {routeLabels[notice.route] ?? notice.route}
            {notice.release ? ` · release ${notice.release}` : ""}
            {notice.edition ? ` · edition ${notice.edition}` : ""}
            {notice.artifact_sha256 ? ` · artifact ${notice.artifact_sha256}` : ""}.
          </p>
          {(notice.release || notice.artifact_sha256 || notice.edition) && (
            <p>
              Version-specific evidence: check this exact scope before applying it to your copy.
              Later releases do not inherit a failure or a fix.
            </p>
          )}
          {notice.workaround && <p>{notice.workaround}</p>}
          <ExternalLink href={notice.provenance}>Source</ExternalLink> ·{" "}
          {new Date(notice.observed_at * 1000).toLocaleDateString()}
        </div>
      ))}
      {report && report.observations.length > 0 && (
        <details>
          <summary data-focusable>Historical observations and exact applicability</summary>
          <p>
            These results describe the exact game edition, version, files and device that were
            checked. This summary has not matched those conditions to your copy, so the results
            remain historical.
          </p>
          {report.observations.map((observation) => (
            <div key={observation.id} className="mt-2 text-sm">
              <p>{observation.explanation}</p>
              <p>{JSON.stringify(observation.scope)}</p>
              <ExternalLink href={observation.source}>Evidence source</ExternalLink>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
