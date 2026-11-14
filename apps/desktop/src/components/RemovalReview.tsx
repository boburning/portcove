import { ActionReviewFailure } from "./ActionReviewFailure";
import { gameIdentityLabel } from "../port-identity";
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
import { useAppTranslation } from "../localization";

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
  const { t } = useAppTranslation("removal");
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
        {t("uninstallPort", { name: port.name })}
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
  const { t } = useAppTranslation("removal");
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
    failureMessage: t("failure"),
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
          {t("title", { identity: gameIdentityLabel(port) })}
        </DialogTitle>
        <DialogDescription id="removal-review-description" className="mb-4 leading-relaxed">
          {t("description", { name: port.name })}
        </DialogDescription>
        {pending === "review" && <p role="status">{t("checking")}</p>}
        {preview && (
          <section className="removal-review-details" aria-label={t("detailsLabel")}>
            <p className="[overflow-wrap:anywhere]">
              <strong>{t("deletedFolders", { count: preview.managed_paths.length })}</strong>
            </p>
            <ul>
              {preview.managed_paths.map((path) => (
                <li className="[overflow-wrap:anywhere]" dir="ltr" key={path}>
                  {path}
                </li>
              ))}
            </ul>
            <p className="[overflow-wrap:anywhere]">{t("settingsRemoved")}</p>
            <p className="[overflow-wrap:anywhere]">
              <strong>{t("preservedAt")}</strong>
            </p>
            {/* Paths keep their exact characters in an isolated left-to-right run. */}
            <p className="[overflow-wrap:anywhere]" dir="ltr">
              {preview.persistent_data_path}
            </p>
            {(preview.unknown_file_count ?? 0) > 0 && (
              <>
                <p className="[overflow-wrap:anywhere]">
                  <strong>{t("unknownFiles", { total: preview.unknown_file_count ?? 0 })}</strong>
                </p>
                <ul>
                  {(preview.unknown_files ?? []).map((path) => (
                    <li className="[overflow-wrap:anywhere]" dir="ltr" key={path}>
                      {path}
                    </li>
                  ))}
                </ul>
                {(preview.unknown_file_count ?? 0) > (preview.unknown_files ?? []).length && (
                  <p className="[overflow-wrap:anywhere]">
                    {t("unknownFilesUnlisted", {
                      total:
                        (preview.unknown_file_count ?? 0) - (preview.unknown_files ?? []).length,
                    })}
                  </p>
                )}
              </>
            )}
            <p className="[overflow-wrap:anywhere]">{t("kept")}</p>
            <p className="[overflow-wrap:anywhere]">{t("irreversible")}</p>
            <p className="[overflow-wrap:anywhere]">{t("interrupted")}</p>
          </section>
        )}
        <ActionReviewFailure error={error} />
        <ReviewedRemovalFooter
          cancelRef={cancelButton}
          hasPreview={Boolean(preview)}
          pending={pending}
          dismiss={dismiss}
          review={async () => {
            await review();
          }}
          apply={remove}
          keepLabel={t("cancel")}
          reviewLabel={t("reviewAgain")}
          applyLabel={t("apply")}
          applyingLabel={t("applying")}
          canApply={preview?.persistent_data_will_be_preserved}
        />
      </DialogContent>
    </Dialog>
  );
}
