import { useRef, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
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
  const { t } = useAppTranslation("backups");
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
        {t("ghostship.open")}
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
  const { t } = useAppTranslation("backups");
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
        // Thrown text is read by the shared failure presentation, so it is already translated.
        throw new Error(t("ghostship.planMismatch"));
      return result;
    },
    apply: (reviewed) => apply(reviewed.backup, reviewed.plan_sha256),
    close,
    failureMessage: t("ghostship.failure"),
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
        <DialogTitle>{t("ghostship.title")}</DialogTitle>
        <DialogDescription id="ghostship-recovery-description">
          {t("ghostship.description")}
        </DialogDescription>
        {pending === "review" && <p role="status">{t("ghostship.checking")}</p>}
        {plan && (
          <section aria-label={t("ghostship.planLabel")}>
            <dl>
              <dt>{t("ghostship.field.library")}</dt>
              <dd className="wrap-anywhere">{plan.library_root}</dd>
              <dt>{t("ghostship.field.snapshot")}</dt>
              <dd className="wrap-anywhere">{plan.backup.path}</dd>
              <dt>{t("ghostship.field.legacy")}</dt>
              <dd className="wrap-anywhere">
                {plan.legacy_install.id} · {plan.legacy_install.path}
              </dd>
              <dt>{t("ghostship.field.current")}</dt>
              <dd className="wrap-anywhere">
                {plan.active_install.id} · {plan.active_install.path}
              </dd>
              <dt>{t("ghostship.field.original")}</dt>
              <dd className="wrap-anywhere">{plan.source.path}</dd>
              <dt>{t("ghostship.field.space")}</dt>
              <dd>{formatBytes(plan.required_bytes)}</dd>
            </dl>
            <p>{t("ghostship.activates")}</p>
            <p>{t("ghostship.remains")}</p>
            <p>{t("ghostship.safetyCopy")}</p>
            <p>{t("ghostship.conditions")}</p>
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
            {t("ghostship.cancel")}
          </Button>
          {!plan && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void review();
              }}
            >
              {t("ghostship.reviewAgain")}
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
              {pending === "apply" ? t("ghostship.recovering") : t("ghostship.recover")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
