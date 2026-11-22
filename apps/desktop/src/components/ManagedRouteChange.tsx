import { AuthoredSetupWarnings } from "./AuthoredSetupWarnings";
import { useId, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { desktopApi } from "../api";
import {
  mutationNeedsReadback,
  targetInvocationContext,
} from "../features/operations/invocation-state";
import { useOperationPresentation } from "../features/operations/operation-presentation";
import { gameIdentityLabel } from "../port-identity";
import { authoredManagedSetupReview } from "../features/browsing/managed-setup-review";
import type { PortDefinition } from "../types";
import { useActionReview } from "../use-action-review";
import { formatBytes, platformLabel } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { OutputLocationControl } from "./OutputLocation";
import { ReleaseChannelControl } from "./ReleaseChannel";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

type Props = {
  port: PortDefinition;
  generation: number;
  busy: boolean;
  onChanged?: (() => void | Promise<unknown>) | undefined;
};

export function ManagedRouteChangeControl(props: Props) {
  const { t } = useAppTranslation("installation");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-focusable variant="outline" disabled={props.busy} onClick={() => setOpen(true)}>
        {t("managedRoute.open")}
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
  const { t } = useAppTranslation("installation");
  const owner = useOperationPresentation();
  const cancel = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsApplying, setOptionsApplying] = useState(false);
  const { preview, pending, error, failurePhase, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([port.id, generation]),
    load: () => desktopApi.previewManagedRouteChange(port.id, generation),
    apply: async (review) => {
      const task = async () => {
        const receipt = await desktopApi.changeToManagedRuntime(
          port.id,
          review.preview_sha256,
          generation,
        );
        if (!receipt?.installation?.id || receipt.installation.port_id !== port.id)
          throw new Error(t("managedRoute.failure"));
        return receipt;
      };
      if (!owner?.perform) {
        await task();
        void onChanged?.();
        return true;
      }
      const action = t("managedRoute.create");
      const result = await owner.perform(action, task, {
        ...(onChanged
          ? {
              invalidateDiagnostics: false,
              refresh: async (receipt) => {
                if (receipt) await onChanged();
              },
            }
          : {}),
        context: {
          ...targetInvocationContext(
            action,
            { kind: "port", id: port.id, label: gameIdentityLabel(port) },
            generation,
          ),
          operation: "change_managed_route",
        },
        installedResult: (receipt) => receipt.installation,
        propagateFailure: true,
      });
      return result !== undefined;
    },
    close,
    failureMessage: t("managedRoute.failure"),
  });
  const needsReadback = failurePhase === "apply" && mutationNeedsReadback(error);
  const preservesExternalData =
    preview?.external_files_will_be_preserved === true &&
    preview.external_data_will_be_copied === false;
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
    needsReadback,
    preservesExternalData,
  };
}

function ManagedRouteChangeDialog(props: Parameters<typeof useManagedRouteChangeDialog>[0]) {
  return <ManagedRouteChangeDialogView {...useManagedRouteChangeDialog(props)} />;
}

function ManagedRouteChangeDialogView({
  cancel,
  ...model
}: ReturnType<typeof useManagedRouteChangeDialog>) {
  const { t } = useAppTranslation("installation");
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
        <DialogTitle>
          <Trans
            t={t}
            i18nKey="managedRoute.title"
            components={{ name: <bdi>{gameIdentityLabel(model.port)}</bdi> }}
          />
        </DialogTitle>
        <DialogDescription id={model.descriptionId}>
          {t("managedRoute.description")}
        </DialogDescription>
        {model.pending === "review" && <p role="status">{t("managedRoute.checking")}</p>}
        {<ManagedRoutePreview {...{ model }} />}
        {!model.needsReadback && (
          <details onToggle={(event) => model.setOptionsOpen(event.currentTarget.open)}>
            <summary data-focusable className="cursor-pointer">
              {t("managedRoute.options")}
            </summary>
            {model.optionsOpen && (
              <div className="mt-3 grid gap-4">
                <p>{t("managedRoute.optionsNote")}</p>
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
                  busy={model.pending ? t("managedRoute.reviewing") : undefined}
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
            {t("managedRoute.cancel")}
          </Button>
          {model.needsReadback ? (
            <Button
              data-focusable
              onClick={() => {
                void model.onChanged?.();
                model.close();
              }}
            >
              {t("managedRoute.refresh")}
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
              {model.pending === "apply" ? t("managedRoute.preparing") : t("managedRoute.create")}
            </Button>
          ) : (
            <Button
              data-focusable
              disabled={Boolean(model.pending)}
              onClick={() => void model.review()}
            >
              {t("managedRoute.checkAgain")}
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
  const { t } = useAppTranslation("installation");
  const manualSetup = model.port.presentation?.manual_setup;
  const review = authoredManagedSetupReview(
    model.port.id,
    model.preview?.installation,
    manualSetup,
  );
  return (
    model.preview && (
      <div className="grid min-w-0 gap-3 wrap-anywhere">
        <p>
          <strong>{model.preview.installation.release.version}</strong> ·{" "}
          {platformLabel(model.preview.installation.platform)} ·{" "}
          {formatBytes(model.preview.installation.download_bytes)}
        </p>
        <p>
          <Trans
            t={t}
            i18nKey="managedRoute.folder"
            components={{
              path: (
                <code>{model.preview.installation.output_location.effective_output_directory}</code>
              ),
            }}
          />
        </p>
        <AuthoredSetupWarnings warnings={review?.warnings ?? manualSetup?.warnings} />
        {review && <p>{review.note}</p>}
        {model.preservesExternalData ? (
          <p>{t("managedRoute.preserves")}</p>
        ) : (
          <p role="alert">{t("managedRoute.differentHandling")}</p>
        )}
        <details>
          <summary data-focusable className="cursor-pointer">
            {t("managedRoute.recoverySummary")}
          </summary>
          <p className="mt-2">
            <Trans
              t={t}
              i18nKey="managedRoute.previousFiles"
              components={{ path: <code>{model.preview.current_registration.path}</code> }}
            />
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
