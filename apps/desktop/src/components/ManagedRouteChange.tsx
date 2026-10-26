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

function useManagedRouteChangeDialog({
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
  return {
    port,
    generation,
    onChanged,
    close,
    cancel,
    descriptionId,
    optionsOpen,
    setOptionsOpen,
    optionsApplying,
    setOptionsApplying,
    preview,
    pending,
    error,
    review,
    execute,
    dismiss,
    committed,
    preservesExternalData,
    setup,
  };
}

function ManagedRouteChangeDialog(props: Parameters<typeof useManagedRouteChangeDialog>[0]) {
  return <ManagedRouteChangeDialogView {...useManagedRouteChangeDialog(props)} />;
}

function ManagedRouteChangeDialogView({
  cancel,
  ...model
}: ReturnType<typeof useManagedRouteChangeDialog>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !model.optionsApplying) model.dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancel}
        showCloseButton={false}
        aria-describedby={model.descriptionId}
      >
        <DialogTitle>Use a managed copy of {gameIdentityLabel(model.port)}?</DialogTitle>
        <DialogDescription id={model.descriptionId}>
          Portcove prepares a separate copy and switches to it only after verification. Your current
          registration stays usable until then, and its external files stay where they are.
        </DialogDescription>
        {model.pending === "review" && (
          <p role="status">Checking the recommended release and destination…</p>
        )}
        {<ManagedRoutePreview {...{ model }} />}
        {!model.committed && (
          <details onToggle={(event) => model.setOptionsOpen(event.currentTarget.open)}>
            <summary data-focusable className="cursor-pointer">
              Change release or location
            </summary>
            {model.optionsOpen && (
              <div className="mt-3 grid gap-4">
                <p>
                  These choices are saved for future managed installs. They do not move or change
                  your external files.
                </p>
                {model.preview && (
                  <ReleaseChannelControl
                    channels={model.port.channels}
                    selected={model.preview.installation.channel}
                    busy={Boolean(model.pending) || model.optionsApplying}
                    change={async (channel) => {
                      model.setOptionsApplying(true);
                      try {
                        return await desktopApi.setChannel(
                          model.port.id,
                          channel,
                          model.generation,
                        );
                      } finally {
                        model.setOptionsApplying(false);
                      }
                    }}
                    refresh={model.review}
                  />
                )}
                <OutputLocationControl
                  portId={model.port.id}
                  gameName={gameIdentityLabel(model.port)}
                  generation={model.generation}
                  busy={model.pending ? "Reviewing managed copy" : undefined}
                  onChanged={() => void model.review()}
                  onApplying={model.setOptionsApplying}
                />
              </div>
            )}
          </details>
        )}
        <ActionReviewFailure error={model.error} />
        <DialogFooter>
          <Button
            ref={cancel}
            data-focusable
            variant="outline"
            disabled={model.pending === "apply" || model.optionsApplying}
            onClick={model.dismiss}
          >
            Cancel
          </Button>
          {model.committed ? (
            <Button
              data-focusable
              onClick={() => {
                model.onChanged?.();
                model.close();
              }}
            >
              Refresh current installation
            </Button>
          ) : model.preview ? (
            <Button
              data-focusable
              variant="primary"
              disabled={
                Boolean(model.pending) ||
                model.optionsApplying ||
                !model.preview.permitted ||
                !model.preservesExternalData
              }
              onClick={() => void model.execute()}
            >
              {model.pending === "apply" ? "Preparing managed copy…" : "Create managed copy"}
            </Button>
          ) : (
            <Button
              data-focusable
              disabled={Boolean(model.pending)}
              onClick={() => void model.review()}
            >
              Check again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManagedRoutePreview({
  model,
}: Pick<{ model: Omit<ReturnType<typeof useManagedRouteChangeDialog>, "cancel"> }, "model">) {
  return (
    model.preview && (
      <div className="grid min-w-0 gap-3 wrap-anywhere">
        <p>
          <strong>{model.preview.installation.release.version}</strong> ·{" "}
          {platformLabel(model.preview.installation.platform)} ·{" "}
          {formatBytes(model.preview.installation.download_bytes)}
        </p>
        <p>
          New runtime location:{" "}
          <code>{model.preview.installation.output_location.effective_output_directory}</code>
        </p>
        {model.setup && (
          <p>
            <strong>{model.setup.title}.</strong> {model.setup.instruction}
          </p>
        )}
        {model.preservesExternalData ? (
          <p>
            Portcove updates the new runtime and preserves its declared data. Your external saves
            are not copied. A game that uses an upstream profile may still read the same profile
            when you choose Play; keep a separate backup of that data.
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
            Your previous files remain at <code>{model.preview.current_registration.path}</code>.
            You can keep using them separately. The saved update policy stays in effect; Play
            remains a separate action.
          </p>
          {model.port.presentation?.manual_preparation && (
            <p className="mt-2">{model.port.presentation.manual_preparation}</p>
          )}
        </details>
        {!model.preview.permitted && <p role="status">{model.preview.reason}</p>}
      </div>
    )
  );
}
