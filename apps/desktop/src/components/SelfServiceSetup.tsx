import { upstreamUpdatesDestination } from "../features/browsing/upstream-links";
import { Play } from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { listingActionAssessment, type CatalogEntry } from "../features/browsing/catalog-entry";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";
import type { Perform } from "../features/operations/use-operation-state";
import { gameIdentityLabel } from "../port-identity";
import type { PortStatus } from "../types";
import { ExternalLaunchWarnings } from "./AuthoredSetupWarnings";
import { CatalogDownloadControl, PendingSetupActions } from "./CatalogDownload";
import { AuthoredPreparationGuidance, UserSelectedRuntimeControl } from "./ExternalRuntime";
import { ExternalLink } from "./ExternalLink";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { ActionRow, Notice } from "./ui/patterns";

export interface SelfServiceSetupProps {
  entry: CatalogEntry;
  libraryRoot?: string | undefined;
  status?: PortStatus | undefined;
  generation: number;
  perform: Perform;
  onChanged: () => void;
  render?: ((slots: { play: ReactNode; setup: ReactNode }) => ReactNode) | undefined;
}

/** Non-owning setup only. Managed installation remains in the strict detail pane. */
export function SelfServiceSetup({
  entry,
  libraryRoot,
  status,
  generation,
  perform,
  onChanged,
  render,
}: SelfServiceSetupProps) {
  const { t } = useAppTranslation("installation");
  const updates =
    entry.listing &&
    upstreamUpdatesDestination(entry.listing.project_url, entry.listing.release_url);
  const [editorOpen, setEditorOpen] = useState(false);
  // Only this explicitly selected non-owning surface uses listing guidance.
  // Keep the strict definition and the managed detail's retained guide intact.
  const routeEntry = useMemo(
    () => ({
      ...entry,
      presentation: {
        ...entry.presentation,
        manual_setup: entry.listing?.manual_setup ?? null,
        manual_preparation: null,
      },
    }),
    [entry],
  );
  const editorId = useId();
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const pending = entry.pendingSetup;
  const needsRecovery = pending?.state === "attention-required";
  const registered = status?.external_runtime;
  const launch = listingActionAssessment(entry.listingStatus, "launch");
  const attach = listingActionAssessment(entry.listingStatus, "attach-existing");
  const operation = presentPortAction(useOperationPresentation(), entry.id, status, "launch");
  const busy = Boolean(operation.busy);
  const showEditor = () => {
    setEditorOpen(true);
    window.requestAnimationFrame(() => editorHeading.current?.focus());
  };
  const play = () => {
    if (!launch.allowed || busy) return;
    void perform("launch", () => desktopApi.launch(entry.id, "", generation), {
      context: {
        action: "Launch",
        operation: "launch",
        target: { kind: "port", id: entry.id, label: gameIdentityLabel(entry) },
        libraryGeneration: generation,
        exclusionScope: "target",
      },
    });
  };
  const playAction = registered ? (
    <div className="grid min-w-0 justify-items-start gap-2 wrap-anywhere">
      <ExternalLaunchWarnings portId={entry.id} status={status} />
      <Button
        data-focusable
        variant="primary"
        size="lg"
        disabled={!launch.allowed || busy}
        focusableWhenDisabled={launch.allowed && busy}
        aria-busy={launch.allowed && busy}
        onClick={play}
      >
        <Icon glyph={Play} className="fill-current" /> {t("selfService.play")}
      </Button>
    </div>
  ) : null;
  const setup = (
    <section
      id="detail-self-service-setup"
      tabIndex={-1}
      className="self-service-setup grid gap-4"
      aria-label={t("selfService.label")}
    >
      {!registered && entry.listing?.manual_setup && (
        <div className="grid gap-3" aria-label={t("selfService.upstreamLabel")}>
          <h3>{t("selfService.upstreamHeading")}</h3>
          {/* External ownership is the guidance default for this non-owning route. */}
          <AuthoredPreparationGuidance
            port={entry}
            setup={{ manual_setup: entry.listing.manual_setup }}
          />
        </div>
      )}
      {pending && (
        <Notice intent={needsRecovery ? "warning" : "info"}>
          <div data-slot="notice-body">
            <strong>
              {needsRecovery ? t("selfService.pending.attention") : t("selfService.pending.ready")}
            </strong>
            {needsRecovery ? (
              <>
                <p>{pending.reason || t("selfService.pending.notReady")}</p>
                <p>{t("selfService.pending.review")}</p>
              </>
            ) : (
              <p>{t("selfService.pending.readyBody")}</p>
            )}
            <code className="[overflow-wrap:anywhere]">{pending.path}</code>
          </div>
        </Notice>
      )}
      {!registered && !pending && (
        <div data-detail-download>
          <CatalogDownloadControl
            autoCheck
            libraryRoot={libraryRoot}
            entry={routeEntry}
            generation={generation}
            busy={busy}
            perform={perform}
          />
        </div>
      )}
      <ActionRow>
        {!render && playAction}
        {!registered && !pending && !needsRecovery ? (
          <Button
            data-focusable
            data-self-service-continue
            variant="outline"
            disabled={!attach.allowed || busy}
            aria-expanded={editorOpen}
            aria-controls={editorId}
            onClick={showEditor}
          >
            {t("selfService.useExisting")}
          </Button>
        ) : null}
        {!registered && entry.listing?.setup_url && (
          <ExternalLink href={entry.listing.setup_url}>{t("selfService.setupGuide")}</ExternalLink>
        )}
      </ActionRow>
      {pending && (
        <PendingSetupActions
          entry={entry}
          pending={pending}
          generation={generation}
          busy={busy}
          perform={perform}
        />
      )}
      {registered?.user_selected && !pending && (
        <details>
          <summary data-focusable className="cursor-pointer py-2 font-medium">
            {t("selfService.another.summary")}
          </summary>
          <div className="grid gap-3 pt-2">
            <p>{t("selfService.another.body")}</p>
            <CatalogDownloadControl
              libraryRoot={libraryRoot}
              entry={routeEntry}
              generation={generation}
              busy={busy}
              perform={perform}
            />
          </div>
        </details>
      )}
      {registered && !launch.allowed && (
        <p role="status" className="text-sm">
          {launch.reason}
        </p>
      )}
      {registered && entry.listing && (
        <div className="grid gap-2 text-sm">
          <p>{t("selfService.registeredNote")}</p>
          <ExternalLink href={updates!.url}>
            {updates!.releases ? t("selfService.versionsLink") : t("selfService.projectLink")}
          </ExternalLink>
        </div>
      )}
      {!registered && !needsRecovery && !attach.allowed && (
        <p role="status" className="text-sm">
          {attach.reason}
        </p>
      )}
      {(registered || ((editorOpen || pending?.state === "downloaded") && !needsRecovery)) && (
        <div id={editorId} className="grid gap-3 border-t border-pc-border pt-4">
          <h2 ref={editorHeading} tabIndex={-1} className="text-base">
            {t("selfService.launchDetails")}
          </h2>
          <UserSelectedRuntimeControl
            libraryRoot={libraryRoot}
            port={routeEntry}
            status={status}
            listingStatus={entry.listingStatus}
            generation={generation}
            initialDirectory={pending?.state === "downloaded" ? pending.path : undefined}
            busy={busy}
            onChanged={onChanged}
          />
        </div>
      )}
    </section>
  );
  return render ? render({ play: playAction, setup }) : setup;
}
