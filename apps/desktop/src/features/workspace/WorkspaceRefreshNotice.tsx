import { Notice } from "../../components/ui/patterns";
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { focusAndReveal, focusRegion } from "../../focus";
import { errorText, failurePresentation } from "../../view-model";
import { FailureDetails } from "../../components/FailureDetails";
import { Icon } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { useAppTranslation } from "../../localization";

export function WorkspaceRefreshNotice({
  failure,
  recoveryFailure,
  hasSnapshot,
  refreshing,
  retry,
  retryRecovery,
  subscriptionFailure,
}: {
  failure?: { error: unknown } | undefined;
  recoveryFailure?: { error: unknown } | undefined;
  hasSnapshot: boolean;
  refreshing: boolean;
  retry: () => Promise<void>;
  retryRecovery: () => Promise<void>;
  subscriptionFailure?: unknown;
}) {
  const { t } = useAppTranslation("workspace");
  const retryButton = useRef<HTMLButtonElement>(null);
  const recoveryRetryButton = useRef<HTMLButtonElement>(null);
  const retryRequested = useRef(false);
  useEffect(() => {
    if (refreshing || !retryRequested.current) return;
    retryRequested.current = false;
    if (document.activeElement !== document.body) return;
    if (failure) focusAndReveal(retryButton.current);
    else if (recoveryFailure) focusAndReveal(recoveryRetryButton.current);
    else focusRegion("workspace");
  }, [failure, recoveryFailure, refreshing]);
  if (!failure && !recoveryFailure && !subscriptionFailure) return null;
  const recoveryPresentation = recoveryFailure && failurePresentation(recoveryFailure.error);
  const recoveryCode =
    recoveryFailure &&
    typeof recoveryFailure.error === "object" &&
    recoveryFailure.error &&
    "code" in recoveryFailure.error
      ? String(recoveryFailure.error.code)
      : undefined;
  const recoveryNotice = recoveryFailure && (
    <Notice intent="danger" className="" role="alert" aria-busy={refreshing}>
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={AlertTriangle} />
      </span>
      <div data-slot="notice-body">
        <strong>{t("recovery.heading")}</strong>
        <p>{hasSnapshot ? t("recovery.snapshot") : t("notLoaded")}</p>
        <p>{errorText(recoveryFailure.error)}</p>
        {recoveryPresentation && (
          <FailureDetails presentation={recoveryPresentation} code={recoveryCode} />
        )}
        <Button
          ref={recoveryRetryButton}
          variant="outline"
          data-focusable
          disabled={refreshing}
          onClick={() => {
            retryRequested.current = true;
            void retryRecovery();
          }}
        >
          {t("recovery.retry")}
        </Button>
      </div>
    </Notice>
  );
  if (!failure && recoveryFailure) return recoveryNotice;
  if (!failure)
    return (
      <Notice intent="neutral" className="" role="status" aria-busy={refreshing}>
        <span
          data-slot="notice-icon"
          className="error-icon grid h-[2rem] w-[2rem] place-items-center"
        >
          <Icon glyph={AlertTriangle} />
        </span>
        <div data-slot="notice-body">
          <strong>{t("live.heading")}</strong>
          <p>{t("live.body")}</p>
          <Button
            variant="outline"
            data-focusable
            disabled={refreshing}
            onClick={() => void retry()}
          >
            {refreshing ? t("refreshing") : t("live.refresh")}
          </Button>
        </div>
      </Notice>
    );
  const { error } = failure;
  const presentation = failurePresentation(error);
  const showMutationSummary =
    presentation !== undefined &&
    presentation.mutation_state !== "not_started" &&
    presentation.mutation_state !== "no_changes" &&
    presentation.mutation_state !== "unknown";
  const code =
    typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  return (
    <>
      <Notice intent="danger" className="" role="alert" aria-busy={refreshing}>
        <span
          data-slot="notice-icon"
          className="error-icon grid h-[2rem] w-[2rem] place-items-center"
        >
          <Icon glyph={AlertTriangle} />
        </span>
        <div data-slot="notice-body">
          <strong>
            {hasSnapshot ? t("refresh.headingSnapshot") : t("refresh.headingInitial")}
          </strong>
          <p>{hasSnapshot ? t("refresh.snapshot") : t("notLoaded")}</p>
          <p>{errorText(error)}</p>
          {presentation && (
            <FailureDetails
              presentation={presentation}
              code={code}
              showMutationSummary={showMutationSummary}
            />
          )}
          <p>{hasSnapshot ? t("refresh.effectSnapshot") : t("refresh.effectInitial")}</p>
          <Button
            ref={retryButton}
            variant="outline"
            data-focusable
            disabled={refreshing}
            onClick={() => {
              retryRequested.current = true;
              void retry();
            }}
          >
            {refreshing ? t("refreshing") : t("refresh.retry")}
          </Button>
        </div>
      </Notice>
      {recoveryNotice}
    </>
  );
}
