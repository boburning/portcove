import { useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { gameIdentityLabel } from "../port-identity";
import type { PortDefinition } from "../types";
import { useActionReview } from "../use-action-review";
import { failurePresentation, formatBytes, platformLabel } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { OutputLocationControl } from "./OutputLocation";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

type Props = {
  port: PortDefinition;
  generation: number;
  busy: boolean;
  onChanged?: (() => void) | undefined;
};

export function ManagedRouteChangeControl(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-focusable variant="outline" disabled={props.busy} onClick={() => setOpen(true)}>
        Review a Portcove-managed copy…
      </Button>
      {open && <ManagedRouteChangeDialog {...props} close={() => setOpen(false)} />}
    </>
  );
}

function ManagedRouteChangeDialog({
  port,
  generation,
  onChanged,
  close,
}: Props & { close: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsApplying, setOptionsApplying] = useState(false);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([port.id, generation]),
    load: () => desktopApi.previewManagedRouteChange(port.id, generation),
    apply: async (review) => {
      await desktopApi.changeToManagedRuntime(port.id, review.preview_sha256, generation);
      onChanged?.();
      return true;
    },
    close,
    failureMessage:
      "The route change was not confirmed. Review the current installation before trying again.",
  });
  const committed = failurePresentation(error)?.mutation_state === "committed";
  const preservesExternalData =
    preview?.external_files_will_be_preserved === true &&
    preview.external_data_will_be_copied === false;
  const setup = port.presentation?.manual_setup?.steps[0];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !optionsApplying) dismiss();
      }}
    >
      <DialogContent initialFocus={cancel} showCloseButton={false} aria-describedby={descriptionId}>
        <DialogTitle>Use a managed copy of {gameIdentityLabel(port)}?</DialogTitle>
        <DialogDescription id={descriptionId}>
          Portcove prepares a separate copy and switches to it only after verification. Your current
          registration stays usable until then, and its external files stay where they are.
        </DialogDescription>
        {pending === "review" && (
          <p role="status">Checking the recommended release and destination…</p>
        )}
        {preview && (
          <div className="grid min-w-0 gap-3 wrap-anywhere">
            <p>
              <strong>{preview.installation.release.version}</strong> ·{" "}
              {platformLabel(preview.installation.platform)} ·{" "}
              {formatBytes(preview.installation.download_bytes)}
            </p>
            <p>
              New runtime location:{" "}
              <code>{preview.installation.output_location.effective_output_directory}</code>
            </p>
            {setup && (
              <p>
                <strong>{setup.title}.</strong> {setup.instruction}
              </p>
            )}
            {preservesExternalData ? (
              <p>
                Portcove updates the new runtime and preserves its declared data. Your external
                saves are not copied. A game that uses an upstream profile may still read the same
                profile when you choose Play; keep a separate backup of that data.
              </p>
            ) : (
              <p role="alert">
                This proposed change has different file or data handling. Keep your current copy and
                update Portcove before reviewing it again.
              </p>
            )}
            <details>
              <summary data-focusable className="cursor-pointer">
                Files and recovery details
              </summary>
              <p className="mt-2">
                Your previous files remain at <code>{preview.current_registration.path}</code>. You
                can keep using them separately. The saved update policy stays in effect; Play
                remains a separate action.
              </p>
              {port.presentation?.manual_preparation && (
                <p className="mt-2">{port.presentation.manual_preparation}</p>
              )}
            </details>
            {!preview.permitted && <p role="status">{preview.reason}</p>}
          </div>
        )}
        {!committed && (
          <details onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
            <summary data-focusable className="cursor-pointer">
              Change release or location
            </summary>
            {optionsOpen && (
              <div className="mt-3 grid gap-4">
                <p>
                  These choices are saved for future managed installs. They do not move or change
                  your external files.
                </p>
                {preview && (
                  <ReleaseChannelControl
                    channels={port.channels}
                    selected={preview.installation.channel}
                    busy={Boolean(pending) || optionsApplying}
                    change={async (channel) => {
                      setOptionsApplying(true);
                      try {
                        return await desktopApi.setChannel(port.id, channel, generation);
                      } finally {
                        setOptionsApplying(false);
                      }
                    }}
                    refresh={review}
                  />
                )}
                <OutputLocationControl
                  portId={port.id}
                  gameName={gameIdentityLabel(port)}
                  generation={generation}
                  busy={pending ? "Reviewing managed copy" : undefined}
                  onChanged={() => void review()}
                  onApplying={setOptionsApplying}
                />
              </div>
            )}
          </details>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <Button
            ref={cancel}
            data-focusable
            variant="outline"
            disabled={pending === "apply" || optionsApplying}
            onClick={dismiss}
          >
            Cancel
          </Button>
          {committed ? (
            <Button
              data-focusable
              onClick={() => {
                onChanged?.();
                close();
              }}
            >
              Refresh current installation
            </Button>
          ) : preview ? (
            <Button
              data-focusable
              variant="primary"
              disabled={
                Boolean(pending) || optionsApplying || !preview.permitted || !preservesExternalData
              }
              onClick={() => void execute()}
            >
              {pending === "apply" ? "Preparing managed copy…" : "Create managed copy"}
            </Button>
          ) : (
            <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
              Check again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
