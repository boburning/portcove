import { ActionReviewFailure } from "./ActionReviewFailure";
import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { desktopApi } from "../api";
import type { PortDefinition, PortStatus } from "../types";
import { removalReviewPresentation } from "../features/port-actions/port-action-presentation";
import { useActionReview, type ReviewOutcome } from "../use-action-review";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ReviewedRemovalFooter } from "./ReviewedRemovalFooter";

export type ApplyRemoval = (expectedPreview: string) => Promise<ReviewOutcome>;

export function RemovalControl({
  port,
  status,
  generation,
  busy,
  apply,
}: {
  port: PortDefinition;
  status?: PortStatus | undefined;
  generation: number;
  busy: boolean;
  apply: ApplyRemoval;
}) {
  const [open, setOpen] = useState(false);
  const removal = removalReviewPresentation(status, "remove_managed");
  return (
    <>
      <Button
        data-focusable
        variant="destructive"
        disabled={busy || removal.blocked}
        onClick={() => setOpen(true)}
      >
        <Icon glyph={Trash2} />
        Uninstall {port.name}
      </Button>
      {removal.blocked && <p role="status">{removal.reason}</p>}
      {open && (
        <RemovalReviewDialog
          port={port}
          generation={generation}
          apply={apply}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function RemovalReviewDialog({
  port,
  generation,
  apply,
  close,
}: {
  port: PortDefinition;
  generation: number;
  apply: ApplyRemoval;
  close: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const {
    preview,
    pending,
    error,
    review,
    execute: remove,
    dismiss,
  } = useActionReview({
    identity: `${port.id}:${generation}`,
    load: () => desktopApi.previewRemoval(port.id, generation),
    apply: (preview) => apply(preview.preview_sha256),
    close,
    failureMessage:
      "Removal did not complete. Review the current installation and any recovery notice before trying again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        reviewSize="standard"
        aria-describedby="removal-review-description"
      >
        <DialogTitle id="removal-review-title" className="mb-2 text-xl">
          Uninstall {port.name}?
        </DialogTitle>
        <DialogDescription id="removal-review-description" className="mb-4 leading-relaxed">
          This removes all installed versions of {port.name} managed by Portcove.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking installed versions…</p>}
        {preview && (
          <section className="removal-review-details" aria-label="Files removed and data preserved">
            <p className="[overflow-wrap:anywhere]">
              <strong>
                Files inside these {preview.managed_paths.length} installation{" "}
                {preview.managed_paths.length === 1 ? "folder" : "folders"} will be deleted,
                including retained versions:
              </strong>
            </p>
            <ul>
              {preview.managed_paths.map((path) => (
                <li className="[overflow-wrap:anywhere]" key={path}>
                  {path}
                </li>
              ))}
            </ul>
            <p className="[overflow-wrap:anywhere]">
              This game's saved release-channel and update-policy settings will also be removed.
              Sign-ins stored only inside installed versions are deleted with those versions.
            </p>
            <p className="[overflow-wrap:anywhere]">
              <strong>Saved data will be preserved at:</strong>
            </p>
            <p className="[overflow-wrap:anywhere]">{preview.persistent_data_path}</p>
            <p className="[overflow-wrap:anywhere]">
              Your saved data, backups, and game files are kept. Saved game-file locations and the
              original folders used for copied installations are also kept. Other games are
              unaffected.
            </p>
            <p className="[overflow-wrap:anywhere]">
              The game must be stopped. To use this port again, reinstall it or copy an existing
              installation. Uninstall cannot be undone.
            </p>
            <p className="[overflow-wrap:anywhere]">
              If interrupted, Portcove retains a recovery journal and checks removal when the
              library reopens. Review any recovery notice before another attempt; interrupted
              deletion may finish.
            </p>
          </section>
        )}
        <ActionReviewFailure error={error} />
        <ReviewedRemovalFooter
          cancelRef={cancelButton}
          hasPreview={Boolean(preview)}
          pending={pending}
          dismiss={dismiss}
          review={review}
          apply={remove}
          keepLabel="Cancel"
          reviewLabel="Review removal again"
          applyLabel="Uninstall all versions"
          applyingLabel="Uninstalling…"
          canApply={preview?.persistent_data_will_be_preserved}
        />
      </DialogContent>
    </Dialog>
  );
}
