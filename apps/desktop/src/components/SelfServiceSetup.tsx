import { upstreamUpdatesDestination } from "../features/browsing/upstream-links";
import { Play } from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../api";
import { listingActionAssessment, type CatalogEntry } from "../features/browsing/catalog-entry";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";
import type { Perform } from "../features/operations/use-operation-state";
import { gameIdentityLabel } from "../port-identity";
import type { PortStatus } from "../types";
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
    <Button
      data-focusable
      variant="primary"
      size="lg"
      disabled={!launch.allowed || busy}
      focusableWhenDisabled={launch.allowed && busy}
      aria-busy={launch.allowed && busy}
      onClick={play}
    >
      <Icon glyph={Play} className="fill-current" /> Play
    </Button>
  ) : null;
  const setup = (
    <section
      id="detail-self-service-setup"
      tabIndex={-1}
      className="self-service-setup grid gap-4"
      aria-label="Set up and launch"
    >
      {!registered && entry.listing?.manual_setup && (
        <div className="grid gap-3" aria-label="Upstream setup instructions">
          <h3>Set up from upstream</h3>
          <AuthoredPreparationGuidance
            port={entry}
            ownership="external"
            setup={{ manual_setup: entry.listing.manual_setup }}
          />
        </div>
      )}
      {pending && (
        <Notice intent={needsRecovery ? "warning" : "info"}>
          <div data-slot="notice-body">
            <strong>
              {needsRecovery ? "Download needs attention" : "Downloaded · finish setup"}
            </strong>
            {needsRecovery ? (
              <>
                <p>{pending.reason || "This saved download is not ready for setup."}</p>
                <p>
                  Review the download folder. To download again, remove this setup entry first. Your
                  files will stay where they are.
                </p>
              </>
            ) : (
              <p>
                Your download is ready for setup. If you still need to set it up, open the download
                folder and follow the project’s guide. Then return here and choose the game program.
              </p>
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
            Use an existing installation
          </Button>
        ) : null}
        {!registered && entry.listing?.setup_url && (
          <ExternalLink href={entry.listing.setup_url}>
            Setup guide on the project’s website
          </ExternalLink>
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
            Download another version or package
          </summary>
          <div className="grid gap-3 pt-2">
            <p>
              Keep using your current installation while preparing another copy. Downloading leaves
              its files and launch details unchanged. Review the new game program before switching.
              Check the project’s instructions for any shared save locations.
            </p>
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
          <p>
            Portcove opens the program shown in Launch details. Use the project’s tools to update
            this installation. Downloading another version leaves this choice as it is.
          </p>
          <ExternalLink href={updates!.url}>
            {updates!.releases
              ? "Versions and updates on the project’s website"
              : "Project website"}
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
            Launch details
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
