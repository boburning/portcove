import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ModSetupRecoveryBuild } from "../types";
import { useActionReview } from "../use-action-review";
import { errorText } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { ReviewedRemovalFooter } from "./ReviewedRemovalFooter";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ActionRow } from "./ui/patterns";

type Props = {
  portId: string;
  profileId: string;
  generation: number;
  locked: boolean;
};

export function ModSetupRuntimeRetirement({
  portId,
  profileId,
  generation,
  locked,
  onRetired,
}: Props & { onRetired: () => void }) {
  const { t } = useAppTranslation("gameSettings");
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const request = useRef({ id: 0 });
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ModSetupRecoveryBuild[]>();
  const [target, setTarget] = useState<{
    entry: ModSetupRecoveryBuild;
    opener: HTMLButtonElement;
  }>();
  const [error, setError] = useState<string>();
  const [retired, setRetired] = useState(false);

  useEffect(() => {
    const tracker = request.current;
    return () => {
      tracker.id++;
    };
  }, []);

  const read = async () => {
    const id = ++request.current.id;
    setHistory(undefined);
    setError(undefined);
    try {
      const builds = await desktopApi.modSetupRecoveryBuilds(portId, profileId, generation);
      if (request.current.id !== id) return;
      if (builds.some((entry) => entry.revision.build.port_id !== portId)) {
        setError(t("mods.gameChanged"));
        return;
      }
      setHistory(builds);
    } catch (failure) {
      if (request.current.id === id) setError(errorText(failure));
    }
  };

  return (
    <div className="grid gap-2">
      <ActionRow>
        <Button
          ref={toggle}
          variant="outline"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={locked && !open}
          onClick={() => {
            setOpen(!open);
            if (open) request.current.id++;
            else {
              setRetired(false);
              void read();
            }
          }}
        >
          {open ? t("mods.retirement.hide") : t("mods.retirement.history")}
        </Button>
      </ActionRow>
      {open && (
        <div id={panelId} className="grid gap-2 rounded-pc-md border border-pc-border p-3">
          {retired && <p role="status">{t("mods.retirement.retired")}</p>}
          {error && <p role="alert">{error}</p>}
          {!history && !error && <p role="status">{t("mods.retirement.loading")}</p>}
          {history?.length === 0 && <p>{t("mods.retirement.none")}</p>}
          {history && history.length > 0 && (
            <>
              <p className="text-sm">{t("mods.retirement.explainer")}</p>
              <ul className="m-0 grid list-none gap-2 p-0">
                {history.map((entry) => (
                  <li key={entry.revision.revision}>
                    <ActionRow>
                      <div className="grid text-sm">
                        <bdi className="break-all">{entry.revision.build.artifact.asset_name}</bdi>
                        <span className="text-pc-muted-foreground">
                          {t("mods.retirement.offer", { revision: entry.revision.revision })}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        disabled={locked}
                        aria-label={t("mods.retirement.reviewNamed", {
                          name: entry.revision.build.artifact.asset_name,
                          revision: entry.revision.revision,
                        })}
                        onClick={(event) => setTarget({ entry, opener: event.currentTarget })}
                      >
                        {t("mods.retirement.review")}
                      </Button>
                    </ActionRow>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {target && (
        <RuntimeRetirementReview
          portId={portId}
          profileId={profileId}
          generation={generation}
          locked={locked}
          target={target.entry}
          opener={target.opener}
          toggle={toggle}
          close={() => setTarget(undefined)}
          onRetired={() => {
            setRetired(true);
            onRetired();
            void read();
          }}
        />
      )}
    </div>
  );
}

function RuntimeRetirementReview({
  portId,
  profileId,
  generation,
  locked,
  target,
  opener,
  toggle,
  close,
  onRetired,
}: Props & {
  target: ModSetupRecoveryBuild;
  opener: HTMLButtonElement;
  toggle: React.RefObject<HTMLButtonElement | null>;
  close: () => void;
  onRetired: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const title = useRef<HTMLHeadingElement>(null);
  const retired = useRef(false);
  const descriptionId = useId();
  const revision = target.revision.revision;
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([portId, profileId, generation, revision]),
    load: async () => {
      const next = await desktopApi.previewModSetupRetirement(
        portId,
        profileId,
        revision,
        generation,
      );
      if (
        next.setup_id !== profileId ||
        next.revision.revision !== revision ||
        next.revision.build.port_id !== portId ||
        next.revision.build.install_id !== target.revision.build.install_id ||
        next.revision.build.manifest_sha256 !== target.revision.build.manifest_sha256 ||
        next.revision.build.installed_contract_sha256 !==
          target.revision.build.installed_contract_sha256
      ) {
        throw new Error(t("mods.gameChanged"));
      }
      return next;
    },
    apply: async (confirmed) => {
      await desktopApi.retireModSetupRecoveryBuild(
        portId,
        profileId,
        confirmed.revision.revision,
        confirmed.preview_sha256,
        generation,
      );
      retired.current = true;
      onRetired();
      return true;
    },
    close,
    failureMessage: t("mods.retirement.failed"),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        initialFocus={title}
        finalFocus={() =>
          !retired.current && opener.isConnected && !opener.disabled ? opener : toggle.current
        }
        showCloseButton={false}
        aria-describedby={descriptionId}
      >
        <DialogTitle ref={title} tabIndex={-1} className="pe-0">
          {t("mods.retirement.title", { revision })}
        </DialogTitle>
        <DialogDescription id={descriptionId}>{t("mods.retirement.description")}</DialogDescription>
        {pending === "review" && <p role="status">{t("mods.retirement.loading")}</p>}
        {preview && (
          <bdi className="text-sm break-all">{preview.revision.build.artifact.asset_name}</bdi>
        )}
        <ActionReviewFailure error={error} />
        <ReviewedRemovalFooter
          hasPreview={Boolean(preview)}
          pending={pending}
          dismiss={dismiss}
          review={async () => {
            await review();
          }}
          apply={execute}
          keepLabel={t("mods.retirement.cancel")}
          reviewLabel={t("mods.retirement.reviewAgain")}
          applyLabel={t("mods.retirement.apply")}
          applyingLabel={t("mods.retirement.applying")}
          canApply={!locked}
        />
      </DialogContent>
    </Dialog>
  );
}
