import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { desktopApi } from "../api";
import type { InstallRecord, OperationEvent, PreparationPlan } from "../types";
import { errorText, formatBytes, isCancellation } from "../view-model";
import { ArtworkImage } from "./Artwork";
import { OperationCancellation } from "./OperationCancellation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

/**
 * Reports whether a surrounding page already shows Cancel for a running operation,
 * so this control shows progress without a second Cancel. The review dialog keeps
 * its own, because it covers the page.
 */
export const PreparationCancellationShown = createContext<(operationId: string) => boolean>(
  () => false,
);

export type RunPreparation = (
  expectedPlan: string,
  onEvent: (event: OperationEvent) => void,
) => Promise<InstallRecord | undefined>;

type PreparationStatus = "starting" | "prepared" | "unfinished" | "cancelled" | { text: string };

function preparationStatusMessage(
  t: ReturnType<typeof useAppTranslation<"installation">>["t"],
  status: PreparationStatus | undefined,
) {
  if (status === undefined) return undefined;
  if (typeof status === "object") return status.text;
  switch (status) {
    case "starting":
      return t("preparation.status.starting");
    case "prepared":
      return t("preparation.status.prepared");
    case "unfinished":
      return t("preparation.status.unfinished");
    case "cancelled":
      return t("preparation.status.cancelled");
  }
}

export function PreparationControl({
  portId,
  taskLabel,
  generation,
  disabled,
  run,
  focusFallback,
  onPrepared,
}: {
  portId: string;
  taskLabel?: string;
  generation: number;
  disabled: boolean;
  run?: RunPreparation | undefined;
  focusFallback?: () => HTMLElement | null;
  onPrepared?: () => void;
}) {
  const { t } = useAppTranslation("installation");
  const cancellationShown = useContext(PreparationCancellationShown);
  const [plan, setPlan] = useState<PreparationPlan>();
  const [pending, setPending] = useState<"review" | "prepare">();
  // App-owned outcomes are codes translated at render; Core progress text stays verbatim.
  const [status, setStatus] = useState<PreparationStatus>();
  const message = preparationStatusMessage(t, status);
  const [error, setError] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const request = useRef(0);
  const completed = useRef(false);
  const observing = useRef(true);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const actionRegion = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    // Confirmation disappears when the running view commits. Move focus in
    // that commit, before popup focus recovery handles the removed button.
    if (pending === "prepare" && plan) reviewTitle.current?.focus();
  }, [pending, plan]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const dismissReview = () => {
    setPlan(undefined);
  };
  const review = async () => {
    observing.current = true;
    completed.current = false;
    const current = ++request.current;
    setPending("review");
    setError(undefined);
    setPlan(undefined);
    setStatus(undefined);
    try {
      const value = await desktopApi.planPreparation(portId, generation);
      if (request.current === current) setPlan(value);
    } catch (value) {
      if (request.current === current) setError(errorText(value));
    } finally {
      if (request.current === current) setPending(undefined);
    }
  };
  const prepare = async () => {
    if (!plan || !run) return;
    const current = ++request.current;
    setPending("prepare");
    setError(undefined);
    setStatus("starting");
    try {
      const result = await run(plan.plan_sha256, (event) => {
        if (request.current !== current) return;
        if (event.type === "started") setOperationId(event.operation_id);
        if (event.type === "message") setStatus({ text: event.message });
      });
      // Readback may already have removed this control. The parent completion
      // owner validates its target/epoch and connected workspace before focusing.
      if (result && observing.current) onPrepared?.();
      if (request.current === current) completed.current = Boolean(result);
      if (request.current === current) setStatus(result ? "prepared" : "unfinished");
    } catch (value) {
      if (request.current === current) {
        if (isCancellation(value)) setStatus("cancelled");
        else setError(errorText(value));
      }
    } finally {
      if (request.current === current) {
        setPending(undefined);
        setOperationId(undefined);
        setPlan(undefined);
      }
    }
  };
  return (
    <section
      ref={actionRegion}
      tabIndex={-1}
      aria-label={t("preparation.label")}
      className="preparation-control"
    >
      {taskLabel && <p className="font-semibold [overflow-wrap:anywhere]">{taskLabel}</p>}
      <p>{t("preparation.intro")}</p>
      <Button
        ref={reviewButton}
        hidden={Boolean(plan)}
        data-focusable
        className={plan ? "hidden" : "wide"}
        variant="outline"
        size="lg"
        disabled={disabled || Boolean(pending) || !run}
        onClick={() => {
          void review();
        }}
      >
        {pending === "review" ? t("preparation.checking") : t("preparation.review")}
      </Button>
      {plan && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen && pending !== "prepare") dismissReview();
          }}
        >
          <DialogContent
            className="@container/preparation"
            showCloseButton={false}
            initialFocus={reviewTitle}
            finalFocus={() => {
              const fallback = focusFallback?.();
              if (!observing.current)
                return fallback?.isConnected
                  ? fallback
                  : actionRegion.current?.isConnected
                    ? actionRegion.current
                    : false;
              if (focusFallback && !fallback?.isConnected) return false;
              if (completed.current && fallback?.isConnected) return fallback;
              // Popup cleanup precedes this commit's removal of the opener's
              // temporary hidden/pending state. Its owner determines availability.
              if (reviewButton.current?.isConnected && !disabled && run)
                return reviewButton.current;
              return fallback?.isConnected ? fallback : false;
            }}
            reviewSize="standard"
            aria-describedby="preparation-review-description"
          >
            <DialogTitle
              ref={reviewTitle}
              id="preparation-review-title"
              tabIndex={-1}
              className="mb-2 text-xl"
            >
              {t("preparation.title")}
            </DialogTitle>
            <DialogDescription id="preparation-review-description" className="mb-4 leading-relaxed">
              {pending === "prepare"
                ? t("preparation.description.running")
                : t("preparation.description.review")}
            </DialogDescription>
            <div className="mb-4 flex min-w-0 items-center gap-4 border-b border-[var(--color-border)] pb-4">
              <ArtworkImage
                port={{ id: portId }}
                className="aspect-[2/3] w-12 shrink-0 rounded-pc-sm"
                quietFallback
              />
              <div className="min-w-0">
                <p className="m-0 font-semibold [overflow-wrap:anywhere]">
                  {taskLabel ?? t("preparation.selected")}
                </p>
                <p className="mt-1 mb-0 text-[length:var(--text-xs)] text-[var(--color-text-secondary)]">
                  <Trans
                    t={t}
                    i18nKey="preparation.installedVersion"
                    components={{ version: <bdi>{plan.inputs.install.version}</bdi> }}
                  />
                </p>
              </div>
            </div>
            {pending === "prepare" ? (
              <>
                <p role="status">{message ?? t("preparation.status.starting")}</p>
                <p>{t("preparation.keepOpen")}</p>
                {operationId && (
                  <OperationCancellation
                    key={operationId}
                    operationId={operationId}
                    label={t("preparation.cancel")}
                  />
                )}
                <details className="mt-4">
                  <summary data-focusable className="cursor-pointer py-2">
                    {t("preparation.details")}
                  </summary>
                  <PreparationFacts plan={plan} />
                </details>
              </>
            ) : (
              <PreparationFacts plan={plan} />
            )}
            <DialogFooter className="mt-4">
              {pending === "prepare" && (
                <Button
                  data-focusable
                  variant="outline"
                  onClick={() => {
                    observing.current = false;
                    setPlan(undefined);
                  }}
                >
                  {t("preparation.continue")}
                </Button>
              )}
              {pending !== "prepare" && (
                <Button
                  data-focusable
                  variant="primary"
                  disabled={disabled || Boolean(pending)}
                  onClick={() => {
                    void prepare();
                  }}
                >
                  {t("preparation.prepare")}
                </Button>
              )}
              {pending !== "prepare" && (
                <Button
                  data-focusable
                  variant="outline"
                  disabled={disabled}
                  onClick={dismissReview}
                >
                  {t("preparation.cancelReview")}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {!plan && message && <p role="status">{message}</p>}
      {!plan && operationId && !cancellationShown(operationId) && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label={t("preparation.cancel")}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function PreparationFacts({ plan }: { plan: PreparationPlan }) {
  const { t } = useAppTranslation("installation");
  return (
    <div className="preparation-plan" aria-label={t("preparation.plan.label")}>
      <dl className="preparation-inputs">
        <div>
          <dt className="text-pc-secondary-foreground">{t("preparation.plan.uses")}</dt>
          <dd className="m-0 [user-select:text]">
            <bdi dir="ltr">{plan.inputs.source.path}</bdi>
          </dd>
        </div>
        <div>
          <dt className="text-pc-secondary-foreground">{t("preparation.plan.current")}</dt>
          <dd className="m-0 [user-select:text]">
            <bdi dir="ltr">{plan.inputs.install.path}</bdi>
            <span className="block">{t("preparation.plan.destination")}</span>
            <span className="block text-[length:var(--text-xs)] text-[var(--color-text-secondary)]">
              <Trans
                t={t}
                i18nKey="preparation.installedVersion"
                components={{ version: <bdi>{plan.inputs.install.version}</bdi> }}
              />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-pc-secondary-foreground">{t("preparation.plan.needs")}</dt>
          <dd className="m-0">
            <Trans
              t={t}
              i18nKey="preparation.plan.needsText"
              components={{
                size: (
                  <bdi>{formatBytes(plan.copy.total_bytes + plan.inputs.source.storage_size)}</bdi>
                ),
              }}
            />
          </dd>
        </div>
      </dl>
      <p>{t("preparation.plan.originalSafe")}</p>
      <details>
        <summary data-focusable className="cursor-pointer py-2">
          {t("preparation.plan.ifWrong")}
        </summary>
        <div className="preparation-during" role="group" aria-label={t("preparation.plan.during")}>
          <p>{t("preparation.plan.activationText")}</p>
          <p>{t("preparation.plan.duringOpen")}</p>
          <p>{t("preparation.plan.duringInterrupt")}</p>
        </div>
      </details>
      <details>
        <summary data-focusable className="cursor-pointer py-2">
          {t("preparation.plan.window")}
        </summary>
        <p className="mt-2 mb-0">{t("preparation.plan.windowText")}</p>
      </details>
    </div>
  );
}
