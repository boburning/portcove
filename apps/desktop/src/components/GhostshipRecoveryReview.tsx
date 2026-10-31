import { useRef, useState } from "react";
import { desktopApi } from "../api";
import { useActionReview } from "../use-action-review";
import type { BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import type { ApplyBackupAction } from "./BackupReview";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export function GhostshipLegacyRecovery({
  backup,
  generation,
  apply,
  disabled,
}: {
  backup: BackupRecord;
  generation: number;
  apply: ApplyBackupAction;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={opener}
        data-focusable
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Review legacy recovery
      </Button>
      {open && (
        <GhostshipRecoveryReview
          key={`${backup.id}:${generation}`}
          backup={backup}
          generation={generation}
          apply={apply}
          close={() => setOpen(false)}
          finalFocus={() => (opener.current?.isConnected ? opener.current : undefined)}
        />
      )}
    </>
  );
}

export function GhostshipRecoveryReview({
  backup,
  generation,
  apply,
  close,
  finalFocus,
}: {
  backup: BackupRecord;
  generation: number;
  apply: ApplyBackupAction;
  close: () => void;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const {
    preview: plan,
    pending,
    error,
    review,
    execute,
    dismiss,
  } = useActionReview({
    identity: `${backup.port_id}:${backup.id}:legacy:${generation}`,
    load: async () => {
      const result = await desktopApi.planGhostshipLegacyRecovery(backup.id, generation);
      if (
        backup.port_id !== "ghostship" ||
        result.backup.port_id !== "ghostship" ||
        result.backup.id !== backup.id
      )
        throw new Error("Recovery plan does not match this backup. Review again.");
      return result;
    },
    apply: (reviewed) => apply(reviewed.backup, reviewed.plan_sha256),
    close,
    failureMessage:
      "Legacy recovery did not complete. Refresh the installation and backup history, then review recovery notices before trying again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancel}
        showCloseButton={false}
        reviewSize="standard"
        aria-describedby="ghostship-recovery-description"
        finalFocus={finalFocus}
      >
        <DialogTitle>Review Ghostship legacy recovery</DialogTitle>
        <DialogDescription id="ghostship-recovery-description">
          Recover the qualified legacy installation and its saved data together. Ordinary backup
          restore changes saved data only.
        </DialogDescription>
        {pending === "review" && (
          <p role="status">Checking whether this snapshot qualifies for legacy recovery…</p>
        )}
        {plan && (
          <section aria-label="Legacy recovery changes and preserved data">
            <dl>
              <dt>Library</dt>
              <dd className="wrap-anywhere">{plan.library_root}</dd>
              <dt>Selected qualified snapshot</dt>
              <dd className="wrap-anywhere">{plan.backup.path}</dd>
              <dt>Retained legacy installation</dt>
              <dd className="wrap-anywhere">
                {plan.legacy_install.id} · {plan.legacy_install.path}
              </dd>
              <dt>Current installation</dt>
              <dd className="wrap-anywhere">
                {plan.active_install.id} · {plan.active_install.path}
              </dd>
              <dt>Original</dt>
              <dd className="wrap-anywhere">{plan.source.path}</dd>
              <dt>Required free space</dt>
              <dd>{formatBytes(plan.required_bytes)}</dd>
            </dl>
            <p>
              This activates a fresh derivative of the retained legacy installation and replaces
              canonical saved data with the selected snapshot.
            </p>
            <p>
              Both existing installations, other staged installations and the selected backup
              remain. Independent safety copies preserve current canonical data and newer-runtime
              saves and settings.
            </p>
            <p>
              The runtime safety copy is stored alongside its canonical safety backup. Ordinary
              restore uses only canonical data. Deleting that safety backup also deletes its runtime
              copy.
            </p>
            <p>
              The game must be stopped. Changed inputs require a new review. Interrupted work
              retains recovery evidence; review recovery notices before another attempt. Recovery
              does not launch the game or prove gameplay or save compatibility.
            </p>
          </section>
        )}
        <ActionReviewFailure error={error} />
        <DialogFooter>
          <Button
            ref={cancel}
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            Cancel
          </Button>
          {!plan && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void review();
              }}
            >
              Review again
            </Button>
          )}
          {plan && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void execute();
              }}
            >
              {pending === "apply"
                ? "Recovering legacy installation and data…"
                : "Recover legacy installation and data"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
