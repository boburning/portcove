import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { LaunchSessionView, PortStatus } from "../types";
import { portActionPresentation } from "../features/port-actions/port-action-presentation";
import { ReportProblem } from "./ReportProblem";
import { Button } from "./ui/button";

/**
 * Explains the latest unsuccessful launch in plain words. Core derives the
 * explanation; this only presents it. Wording stays "most likely" and the raw
 * code stays visible and copyable, so an explanation is never shown as proof.
 */
export function LaunchFailureNotice({
  portId,
  generation,
  status,
  busy,
  rollback,
  openActivity,
  load = desktopApi.launchFailure,
}: {
  portId: string;
  generation: number;
  status?: PortStatus | undefined;
  busy?: string | undefined;
  rollback: () => void | Promise<unknown>;
  /** Opens Portcove's Activity history, where the launch and its log are recorded. */
  openActivity?: (() => void) | undefined;
  load?: (portId: string, generation: number) => Promise<LaunchSessionView | null>;
}) {
  // State is keyed by what was loaded, so a stale answer for another game or
  // library generation is never shown while the next read is in flight.
  const requestKey = `${portId}:${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    view: LaunchSessionView | null;
  } | null>(null);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    load(portId, generation).then(
      (view) => {
        if (current) setLoaded({ key: requestKey, view });
      },
      () => {
        // The notice is supplementary; a failed read must not block the details page.
        if (current) setLoaded({ key: requestKey, view: null });
      },
    );
    return () => {
      current = false;
    };
  }, [portId, generation, requestKey, status, load]);
  const loadedView = loaded?.key === requestKey ? loaded.view : null;
  // A failure belongs to the installation that ran: the managed install, or the
  // external registration. After a rollback, update, reinstall or removal it
  // describes software that is no longer active, so it is not shown.
  const currentInstall = status?.active?.id ?? status?.external_runtime?.id;
  const failure =
    loadedView && currentInstall !== undefined && loadedView.install_id === currentInstall
      ? loadedView
      : null;
  const copied = failure !== null && copiedFor === failure.id;
  const explanation = failure?.exit_explanation;
  if (!failure || !explanation) return null;
  return (
    <section
      role="status"
      aria-label="Last launch"
      data-launch-failure={explanation.key}
      className="grid gap-2 rounded-md border border-pc-border p-3"
    >
      <p>{explanation.explanation}</p>
      <p className="text-sm text-pc-muted-foreground">{explanation.next_action}</p>
      <p className="text-sm text-pc-muted-foreground">
        Exit code <code>{explanation.raw_code}</code>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void copyText(explanation.raw_code).then(() => setCopiedFor(failure.id));
          }}
        >
          {copied ? "Copied" : "Copy exit code"}
        </Button>
        <ReportProblem portId={portId} generation={generation} />
        {openActivity && (
          <Button variant="outline" onClick={openActivity}>
            Open Activity
          </Button>
        )}
        {status?.previous && !portActionPresentation(status, "rollback").blocked && (
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => {
              void rollback();
            }}
          >
            Restore previous version
          </Button>
        )}
      </div>
    </section>
  );
}
