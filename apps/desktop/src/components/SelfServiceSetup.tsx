import { Gamepad2 } from "lucide-react";
import { useId, useRef, useState } from "react";
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
import { UserSelectedRuntimeControl } from "./ExternalRuntime";
import { ExternalLink } from "./ExternalLink";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { ActionRow, Notice } from "./ui/patterns";

export interface SelfServiceSetupProps {
  entry: CatalogEntry;
  status?: PortStatus | undefined;
  generation: number;
  perform: Perform;
  onChanged: () => void;
}

/** Non-owning setup only. Managed installation remains in the strict detail pane. */
export function SelfServiceSetup({
  entry,
  status,
  generation,
  perform,
  onChanged,
}: SelfServiceSetupProps) {
  const [editorOpen, setEditorOpen] = useState(false);
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
        target: { kind: "port", id: entry.id, label: gameIdentityLabel(entry) },
        libraryGeneration: generation,
        exclusionScope: "target",
      },
    });
  };
  return (
    <section className="grid gap-4" aria-label="Set up and launch">
      {pending && !registered && (
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
                Your download is saved. Complete the upstream setup, then choose the game
                executable.
              </p>
            )}
            <code className="[overflow-wrap:anywhere]">{pending.path}</code>
          </div>
        </Notice>
      )}
      {!registered && !pending && (
        <CatalogDownloadControl
          entry={entry}
          generation={generation}
          busy={busy}
          perform={perform}
        />
      )}
      <ActionRow>
        {registered ? (
          <Button
            data-focusable
            variant="primary"
            size="lg"
            disabled={!launch.allowed || busy}
            onClick={play}
          >
            <Icon glyph={Gamepad2} /> Play
          </Button>
        ) : !needsRecovery ? (
          <Button
            data-focusable
            variant={pending ? "primary" : "outline"}
            disabled={!attach.allowed || busy}
            aria-expanded={editorOpen}
            aria-controls={editorId}
            onClick={showEditor}
          >
            {pending ? "Continue setup" : "Use an existing installation"}
          </Button>
        ) : null}
        {!registered && entry.listing?.setup_url && (
          <ExternalLink href={entry.listing.setup_url}>Upstream setup instructions</ExternalLink>
        )}
      </ActionRow>
      {pending && !registered && (
        <PendingSetupActions
          entry={entry}
          pending={pending}
          generation={generation}
          busy={busy}
          perform={perform}
        />
      )}
      {registered && !launch.allowed && (
        <p role="status" className="text-sm">
          {launch.reason}
        </p>
      )}
      {!registered && !needsRecovery && !attach.allowed && (
        <p role="status" className="text-sm">
          {attach.reason}
        </p>
      )}
      {(registered || (editorOpen && !needsRecovery)) && (
        <div id={editorId} className="grid gap-3 border-t border-pc-border pt-4">
          <h2 ref={editorHeading} tabIndex={-1} className="text-base">
            Launch details
          </h2>
          <UserSelectedRuntimeControl
            port={entry}
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
}
