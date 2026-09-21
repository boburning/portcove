import { useState } from "react";
import { Trash2 } from "lucide-react";
import { desktopApi } from "../api";
import type { PortDefinition } from "../types";
import { useActionReview, type ReviewOutcome } from "../use-action-review";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export type ApplyRemoval = (expectedPreview: string) => Promise<ReviewOutcome>;

export function RemovalControl({
  port,
  generation,
  busy,
  apply,
}: {
  port: PortDefinition;
  generation: number;
  busy: boolean;
  apply: ApplyRemoval;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-focusable variant="destructive" disabled={busy} onClick={() => setOpen(true)}>
        <Icon glyph={Trash2} />
        Remove managed files
      </Button>
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
        showCloseButton={false}
        className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="removal-review-description"
      >
        <DialogTitle id="removal-review-title" className="mb-2 text-xl">
          Review installed-game removal
        </DialogTitle>
        <DialogDescription id="removal-review-description" className="mb-4 leading-relaxed">
          Remove the managed versions of {port.name} listed below.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking installed versions…</p>}
        {preview && (
          <section className="removal-review-details" aria-label="Files removed and data preserved">
            <p>
              <strong>
                {preview.managed_paths.length} managed{" "}
                {preview.managed_paths.length === 1 ? "folder" : "folders"} will be removed,
                including any retained versions listed here.
              </strong>
            </p>
            <ul>
              {preview.managed_paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            <p>
              This game's saved release-channel and update-policy settings will also be removed.
            </p>
            <p>
              <strong>Saved data will be preserved at:</strong>
            </p>
            <p>{preview.persistent_data_path}</p>
            <p>
              Backups, registered original game sources and the original folders used for copied
              installations are preserved. Other games are unaffected.
            </p>
            <p>
              The game must be stopped. Files inside the listed managed folders will be deleted;
              reinstalling or copying an original again is a new operation, not an undo.
            </p>
            <p>
              If interrupted, Portcove retains a recovery journal and checks removal when the
              library reopens. Review any recovery notice before another attempt; interrupted
              deletion may finish.
            </p>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button
            data-autofocus
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            Keep installed files
          </Button>
          {!preview && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void review();
              }}
            >
              Review removal again
            </Button>
          )}
          {preview && (
            <Button
              data-focusable
              variant="destructive"
              disabled={Boolean(pending) || !preview.persistent_data_will_be_preserved}
              onClick={() => {
                void remove();
              }}
            >
              {pending === "apply" ? "Removing reviewed files…" : "Remove these managed folders"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
