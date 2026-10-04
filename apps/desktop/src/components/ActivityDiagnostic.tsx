import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { ActivityDiagnostic as Diagnostic } from "../types";
import {
  failurePresentation,
  formatBytes,
  isCancellation,
  type FailureDisplay,
} from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { Button } from "./ui/button";

const diagnosticTextareaClass =
  "min-h-20 max-h-96 w-full resize-y overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] [font:inherit]";

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
  const [capture, setCapture] = useState<Diagnostic>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    presentation?: FailureDisplay;
    cancelled: boolean;
  }>();
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const reading = useRef(false);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
    };
  }, []);
  const load = async () => {
    if (reading.current) return;
    reading.current = true;
    const current = ++request.current;
    setPending(true);
    setFailure(undefined);
    setCopied(false);
    try {
      const value = await desktopApi.activityDiagnostic(activityId, generation);
      if (request.current === current) setCapture(value);
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
  return (
    <details
      className="activity-diagnostic col-[2/-1] min-w-0 text-xs"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.currentTarget.open && request.current === 0) void load();
      }}
    >
      <summary data-focusable className="cursor-pointer">
        View preparation log
      </summary>
      {pending && (
        <p role="status">
          Reading the retained log…
          {capture !== undefined &&
            " Showing the last loaded capture while the current log is checked."}
        </p>
      )}
      {failure && (
        <div role={failure.cancelled ? "status" : "alert"}>
          <strong>
            {failure.cancelled ? "Log read cancelled" : "Preparation log could not be loaded"}
          </strong>
          <p>
            Current log availability is unknown.
            {capture !== undefined &&
              " Showing the last loaded capture; it may have changed since it was read."}
          </p>
          {failure.presentation && (
            <>
              <p>{failure.presentation.summary}</p>
              <FailureDetails presentation={failure.presentation} showMutationSummary={false} />
            </>
          )}
        </div>
      )}
      {capture?.length === 0 && !pending && !failure && (
        <p>
          No retained diagnostic capture is available. Older activity details may be available in a
          redacted support bundle in Settings.
        </p>
      )}
      {capture?.map((phase) => (
        <section key={phase.phase}>
          <h3>
            {phase.phase === "preparation.extract"
              ? "Preparing source data"
              : phase.phase === "preparation.setup"
                ? "Running game setup"
                : "Preparation log"}
          </h3>
          <p>
            {phase.complete
              ? "Capture reached the end of both output streams."
              : "Capture is incomplete. Only the output saved before the last observation is available."}
          </p>
          {(phase.stdout.truncated || phase.stderr.truncated) && (
            <p>
              Some output was omitted because it exceeded the{" "}
              {formatBytes(phase.stream_limit_bytes)} capture limit per stream.
            </p>
          )}
          <p>Last saved: {new Date(phase.updated_at * 1000).toLocaleString()}</p>
          <h4>Standard output</h4>
          <textarea
            readOnly
            className={diagnosticTextareaClass}
            aria-label="Preparation standard output"
            value={phase.stdout.text || "No standard output was captured."}
          />
          <h4>Standard error</h4>
          <textarea
            readOnly
            className={diagnosticTextareaClass}
            aria-label="Preparation standard error"
            value={phase.stderr.text || "No standard error was captured."}
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
              const current = request.current;
              void copyText(JSON.stringify(capture, null, 2))
                .then(() => {
                  if (request.current === current) setCopied(true);
                })
                .catch(() => {
                  if (request.current === current) setCopied(false);
                });
            }}
          >
            {copied ? "Copied" : "Copy retained log"}
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
          {failure ? "Retry log read" : "Refresh captured log"}
        </Button>
      </div>
    </details>
  );
}
