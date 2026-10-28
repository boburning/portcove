import { CheckCircle2, Wrench } from "lucide-react";
import { Icon } from "../../components/ui";
import { currentUpdateSnapshot, releaseChannelPresentation } from "../../view-model";
import type { LibraryOrganization, PortStatus } from "../../types";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { observedUpdateCandidate } from "../browsing/update-query-context";
import { updateNoticeHidden } from "../organization/organization";
import { gameUpdateAcquisitionLabel } from "../port-updates/acquisition-presentation";
import { cardInstallationLabel, type browsePortPresentation } from "./browse-presentation";

/** Exact-port cached facts and descriptions, shared by singleton discovery and comparison. */
export function BrowsePortObservations({
  port,
  status,
  observation,
  descriptionId,
  noticeChoice,
}: {
  port: CatalogEntry;
  status: PortStatus | undefined;
  observation: ReturnType<typeof browsePortPresentation>;
  descriptionId: string;
  noticeChoice?: LibraryOrganization["update_notices"][string] | undefined;
}) {
  const { state, input, setup } = observation;
  const release = currentUpdateSnapshot(status)?.check.release;
  const hiddenNotice = updateNoticeHidden(
    noticeChoice,
    release?.asset.sha256
      ? { version: release.version, artifact_sha256: release.asset.sha256 }
      : undefined,
  );
  const updateAvailable =
    !hiddenNotice && observedUpdateCandidate(port.id, status)?.availableAtLastCheck === true;
  return (
    <div className="discover-observations grid gap-1 text-xs">
      <span className="text-pc-muted-foreground">{cardInstallationLabel(port, status)}</span>
      <span
        className={`readiness ${state.tone} inline-flex items-start gap-1.5 font-medium text-pc-muted-foreground [&.ready]:text-pc-success-foreground [&.setup]:text-pc-warning-foreground [&.staged]:text-pc-interactive-foreground`}
      >
        <Icon glyph={state.tone === "ready" ? CheckCircle2 : Wrench} size="sm" />
        {state.label}
      </span>
      {status?.staged && <span className="text-pc-interactive-foreground">Update prepared</span>}
      {status?.acquisition && (
        <span className="text-pc-interactive-foreground">
          {gameUpdateAcquisitionLabel(status.acquisition.phase)}
        </span>
      )}
      {updateAvailable && (
        <span className="text-pc-interactive-foreground">Update available at last check</span>
      )}
      {port.upstream_status === "retired" && (
        <span className="text-pc-warning-foreground">Retired upstream</span>
      )}
      {status?.channel && status.active && status.channel !== status.active.channel && (
        <span className="text-pc-muted-foreground">
          Selected update channel: {releaseChannelPresentation(status.channel).label}
        </span>
      )}
      {(input || setup) && (
        <div id={descriptionId} className="sr-only">
          {input?.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {setup?.routes.map((route) => (
            <p key={route.action}>
              <strong>{route.route}: </strong>
              {route.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
