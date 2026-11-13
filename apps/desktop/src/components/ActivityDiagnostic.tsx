import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import { useAppTranslation } from "../localization";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import {
  failurePresentation,
  formatBytes,
  isCancellation,
  type FailureDisplay,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { Button } from "./ui/button";
import { ReadOnlyTextField } from "./ui/read-only-text-field";

export function ActivityDiagnostic({
  activityId,
  generation,
}: {
  activityId: string;
  generation: number;
}) {
  return (
    <ActivityDiagnosticSession
      key={`${activityId}:${generation}`}
      activityId={activityId}
      generation={generation}
    />
  );
}

function ActivityDiagnosticSession({
  activityId,
  generation,
}: {
  activityId: string;
  generation: number;
}) {
  const { t } = useAppTranslation("operations");
  const [capture, setCapture] = useState<Diagnostic>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    presentation: FailureDisplay | undefined;
    cancelled: boolean;
  }>();
  const [copyOutcome, setCopyOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const copyRequest = useRef(0);
  const request = useRef(0);
  const reading = useRef(false);
  const readRequested = useRef(false);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
      copyRequest.current += 1;
    };
  }, []);
  const load = async () => {
    if (reading.current) return;
    reading.current = true;
    readRequested.current = true;
    const current = ++request.current;
    setPending(true);
    setFailure(undefined);
    copyRequest.current += 1;
    setCopyOutcome("idle");
    try {
      const value = await desktopApi.activityDiagnostic(activityId, generation);
      if (request.current === current) {
        copyRequest.current += 1;
        setCopyOutcome("idle");
        setCapture(value);
      }
    } catch (value) {
      if (request.current === current)
        setFailure({ presentation: failurePresentation(value), cancelled: isCancellation(value) });
    } finally {
      if (request.current === current) {
        reading.current = false;
        setPending(false);
      }
    }
  };
  const technical = capture ? JSON.stringify(capture, null, 2) : "";
  return (
    <details
      className="activity-diagnostic col-[2/-1] min-w-0 text-xs"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.currentTarget.open && !readRequested.current) void load();
      }}
    >
      <summary data-focusable className="cursor-pointer">
        {t("diagnostic.view")}
      </summary>
      {pending && (
        <p role="status">
          {capture !== undefined ? t("diagnostic.readingWithPrevious") : t("diagnostic.reading")}
        </p>
      )}
      {failure && (
        <div role={failure.cancelled ? "status" : "alert"}>
          <strong>
            {failure.cancelled ? t("diagnostic.cancelled") : t("diagnostic.loadFailed")}
          </strong>
          <p>
            {capture !== undefined
              ? t("diagnostic.availabilityUnknownWithPrevious")
              : t("diagnostic.availabilityUnknown")}
          </p>
          {failure.presentation && (
            <>
              <p>{failure.presentation.summary}</p>
              <FailureDetails presentation={failure.presentation} showMutationSummary={false} />
            </>
          )}
        </div>
      )}
      {capture?.length === 0 && !pending && !failure && <p>{t("diagnostic.none")}</p>}
      {capture?.map((phase) => (
        <section key={phase.phase}>
          <h3>
            {phase.phase === "preparation.extract"
              ? t("diagnostic.phase.extract")
              : phase.phase === "preparation.setup"
                ? t("diagnostic.phase.setup")
                : t("diagnostic.phase.other")}
          </h3>
          <p>{phase.complete ? t("diagnostic.complete") : t("diagnostic.incomplete")}</p>
          {(phase.stdout.truncated || phase.stderr.truncated) && (
            <p>{t("diagnostic.truncated", { limit: formatBytes(phase.stream_limit_bytes) })}</p>
          )}
          <p>
            {t("diagnostic.lastSaved", {
              time: new Date(phase.updated_at * 1000).toLocaleString(),
            })}
          </p>
          <h4>{t("diagnostic.stdout")}</h4>
          <ReadOnlyTextField
            label={t("diagnostic.stdoutLabel")}
            value={phase.stdout.text || t("diagnostic.stdoutEmpty")}
          />
          <h4>{t("diagnostic.stderr")}</h4>
          <ReadOnlyTextField
            label={t("diagnostic.stderrLabel")}
            value={phase.stderr.text || t("diagnostic.stderrEmpty")}
          />
        </section>
      ))}
      <div className="mt-2 flex flex-wrap gap-2">
        {!!capture?.length && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            onClick={() => {
              const current = ++copyRequest.current;
              setCopyOutcome("idle");
              void copyText(technical)
                .then(() => {
                  if (copyRequest.current === current) setCopyOutcome("copied");
                })
                .catch(() => {
                  if (copyRequest.current === current) setCopyOutcome("failed");
                });
            }}
          >
            {copyOutcome === "copied" ? t("diagnostic.copied") : t("diagnostic.copy")}
          </Button>
        )}
        <Button
          data-focusable
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            void load();
          }}
        >
          {failure ? t("diagnostic.retry") : t("diagnostic.refresh")}
        </Button>
      </div>
      {copyOutcome === "copied" && <p role="status">{t("diagnostic.copiedStatus")}</p>}
      {copyOutcome === "failed" && (
        <>
          <p role="alert">{t("diagnostic.clipboardUnavailable")}</p>
          <ReadOnlyTextField label={t("diagnostic.manualCopy")} value={technical} />
        </>
      )}
    </details>
  );
}
