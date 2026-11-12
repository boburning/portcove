import type { TFunction } from "i18next";
import { useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard";
import { useAppTranslation } from "../localization";
import type { FailureDisplay } from "../view-model";
import { Button } from "./ui/button";
import { ReadOnlyTextField } from "./ui/read-only-text-field";

/** Outcome summaries by static key; an unknown state reads as "unknown". */
function outcomeSummary(t: TFunction<"common">, state: string): string {
  switch (state) {
    case "not_started":
      return t("failure.outcome.notStarted");
    case "no_changes":
      return t("failure.outcome.noChanges");
    case "committed":
      return t("failure.outcome.committed");
    case "recovery_required":
      return t("failure.outcome.recoveryRequired");
    default:
      return t("failure.outcome.unknown");
  }
}

export function FailureDetails({
  presentation,
  code,
  contextLabel,
  showMutationSummary = true,
}: {
  presentation: FailureDisplay;
  code?: string | undefined;
  contextLabel?: (key: string) => string | undefined;
  showMutationSummary?: boolean;
}) {
  const { t } = useAppTranslation("common");
  const technical = JSON.stringify(
    {
      code,
      mutation_state: presentation.mutation_state,
      phase: presentation.phase,
      message: presentation.technical_message,
      context: presentation.technical_context,
    },
    null,
    2,
  );
  return (
    <div className="failure-details">
      {showMutationSummary && <p>{outcomeSummary(t, presentation.mutation_state)}</p>}
      <details>
        <summary className="cursor-pointer" data-focusable>
          {t("failure.viewDetails")}
        </summary>
        {contextLabel ? (
          <dl className="grid gap-3 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-4">
            {code && (
              <div>
                <dt className="text-xs text-pc-muted-foreground">{t("failure.code")}</dt>
                <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                  {code}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-pc-muted-foreground">{t("failure.outcomeLabel")}</dt>
              <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                {presentation.mutation_state}
              </dd>
            </div>
            {presentation.phase && (
              <div>
                <dt className="text-xs text-pc-muted-foreground">{t("failure.phase")}</dt>
                <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                  {presentation.phase}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-pc-muted-foreground">{t("failure.message")}</dt>
              <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                {presentation.technical_message}
              </dd>
            </div>
            {Object.entries(presentation.technical_context).map(([key, value]) => {
              const label = contextLabel(key);
              return (
                <div key={key}>
                  <dt className="text-xs text-pc-muted-foreground">
                    {label ?? <code>{key}</code>}
                  </dt>
                  <dd className="m-0 min-w-0 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap [unicode-bidi:plaintext]">
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <pre className="text-[length:var(--text-xs)] [overflow-wrap:anywhere] whitespace-pre-wrap">
            {technical}
          </pre>
        )}
        <FailureDetailsCopy key={technical} technical={technical} />
      </details>
    </div>
  );
}

function FailureDetailsCopy({ technical }: { technical: string }) {
  const [copyOutcome, setCopyOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const { t } = useAppTranslation("common");
  const request = useRef(0);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
    };
  }, []);
  return (
    <>
      <Button
        data-focusable
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => {
          const current = ++request.current;
          setCopyOutcome("idle");
          void copyText(technical)
            .then(() => {
              if (request.current === current) setCopyOutcome("copied");
            })
            .catch(() => {
              if (request.current === current) setCopyOutcome("failed");
            });
        }}
      >
        {copyOutcome === "copied" ? t("failure.copied") : t("failure.copy")}
      </Button>
      {copyOutcome === "copied" && <p role="status">{t("failure.copiedStatus")}</p>}
      {copyOutcome === "failed" && (
        <>
          <p role="alert">{t("failure.clipboardUnavailable")}</p>
          <ReadOnlyTextField className="mt-2" label={t("failure.manualCopy")} value={technical} />
        </>
      )}
    </>
  );
}
