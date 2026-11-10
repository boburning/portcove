import { useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { BugReportDraft, BugReportField, BugReportLink } from "../types";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const textareaClassName =
  "min-h-32 w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 font-mono text-sm text-pc-foreground focus-visible:outline-2 focus-visible:outline-offset-2";

/** Fields the player may edit; the others are shown as facts. */
const editableFields = new Set(["observed", "evidence"]);

type Phase =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; fields: BugReportField[] }
  | { kind: "opening"; fields: BugReportField[] }
  | { kind: "copied" }
  | { kind: "failed"; message: string };

/**
 * Shows exactly what a pre-filled GitHub bug report will contain, lets the player
 * edit the free-text parts, then opens the form. Portcove sends nothing itself.
 */
export function ReportProblem({
  portId,
  generation,
  preview = desktopApi.previewBugReport,
  open = desktopApi.openBugReport,
}: {
  portId?: string | undefined;
  generation: number;
  preview?: (portId: string | undefined, generation: number) => Promise<BugReportDraft>;
  open?: (fields: BugReportField[]) => Promise<BugReportLink>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const close = () => setPhase({ kind: "closed" });
  const start = () => {
    setPhase({ kind: "loading" });
    preview(portId, generation).then(
      (draft) => setPhase({ kind: "ready", fields: draft.fields }),
      (value) => setPhase({ kind: "failed", message: failureMessage(value) }),
    );
  };
  const submit = async (fields: BugReportField[]) => {
    setPhase({ kind: "opening", fields });
    try {
      const link = await open(fields);
      if (link.url) {
        close();
        return;
      }
      await copyText(link.clipboard_text);
      setPhase({ kind: "copied" });
    } catch (value) {
      setPhase({ kind: "failed", message: failureMessage(value) });
    }
  };
  const fields = phase.kind === "ready" || phase.kind === "opening" ? phase.fields : undefined;
  return (
    <>
      <Button data-focusable variant="outline" onClick={start} disabled={phase.kind === "loading"}>
        Report a problem
      </Button>
      <Dialog
        open={phase.kind !== "closed" && phase.kind !== "loading"}
        onOpenChange={(next) => {
          if (!next && phase.kind !== "opening") close();
        }}
      >
        <DialogContent reviewSize="standard" aria-describedby="report-problem-description">
          <DialogTitle className="text-xl">Report a problem</DialogTitle>
          <DialogDescription id="report-problem-description" className="leading-relaxed">
            This is everything that will be filled into a GitHub bug report. Portcove sends nothing
            itself: you review it here, then submit it on GitHub. Folder paths and your user name
            are replaced.
          </DialogDescription>
          {fields && (
            <div className="grid gap-3">
              {fields.map((field) =>
                editableFields.has(field.id) ? (
                  <label key={field.id} className="grid gap-1 text-sm font-semibold">
                    {field.label}
                    <textarea
                      className={textareaClassName}
                      value={field.value}
                      disabled={phase.kind === "opening"}
                      onChange={(event) =>
                        setPhase({
                          kind: "ready",
                          fields: fields.map((other) =>
                            other.id === field.id ? { ...other, value: event.target.value } : other,
                          ),
                        })
                      }
                    />
                  </label>
                ) : (
                  <p key={field.id} className="text-sm">
                    <span className="font-semibold">{field.label}:</span> {field.value}
                  </p>
                ),
              )}
            </div>
          )}
          {phase.kind === "copied" && (
            <p role="status">
              This report is too long for a link, so it was copied instead. Open a new bug report on
              GitHub and paste it in.
            </p>
          )}
          {phase.kind === "failed" && <p role="alert">{phase.message}</p>}
          <DialogFooter>
            <Button variant="secondary" disabled={phase.kind === "opening"} onClick={close}>
              {phase.kind === "copied" || phase.kind === "failed" ? "Close" : "Cancel"}
            </Button>
            {fields && (
              <Button
                variant="primary"
                disabled={phase.kind === "opening"}
                onClick={() => void submit(fields)}
              >
                Open on GitHub
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function failureMessage(value: unknown): string {
  const presentation = failurePresentation(value);
  return presentation?.summary ?? "The report could not be prepared. Try again.";
}
