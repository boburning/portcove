import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { BugReportDraft, BugReportField, BugReportLink } from "../types";
import { useAppTranslation } from "../localization";
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
  | { kind: "copy_failed"; text: string }
  // Core's own summary when it gave one; the fallback is translated at render.
  | { kind: "failed"; summary: string | undefined };

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
  const { t } = useAppTranslation("report");
  // Only the newest request may update the dialog; closing or switching games
  // invalidates an earlier preview that is still loading.
  const request = useRef(0);
  const close = () => {
    request.current += 1;
    setPhase({ kind: "closed" });
  };
  useLayoutEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const start = () => {
    const current = ++request.current;
    setPhase({ kind: "loading" });
    preview(portId, generation).then(
      (draft) => {
        if (request.current === current) setPhase({ kind: "ready", fields: draft.fields });
      },
      (value) => {
        if (request.current === current)
          setPhase({ kind: "failed", summary: failurePresentation(value)?.summary });
      },
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
      try {
        await copyText(link.clipboard_text);
        setPhase({ kind: "copied" });
      } catch {
        // Keep the report on screen so the player can still copy it by hand.
        setPhase({ kind: "copy_failed", text: link.clipboard_text });
      }
    } catch (value) {
      setPhase({ kind: "failed", summary: failurePresentation(value)?.summary });
    }
  };
  const fields = phase.kind === "ready" || phase.kind === "opening" ? phase.fields : undefined;
  return (
    <>
      <Button data-focusable variant="outline" onClick={start} disabled={phase.kind === "loading"}>
        {t("problem.open")}
      </Button>
      <Dialog
        open={phase.kind !== "closed" && phase.kind !== "loading"}
        onOpenChange={(next) => {
          if (!next && phase.kind !== "opening") close();
        }}
      >
        <DialogContent reviewSize="standard" aria-describedby="report-problem-description">
          <DialogTitle className="text-xl">{t("problem.title")}</DialogTitle>
          <DialogDescription id="report-problem-description" className="leading-relaxed">
            {t("problem.description")}
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
          {phase.kind === "copied" && <p role="status">{t("problem.copied")}</p>}
          {phase.kind === "copy_failed" && (
            <div className="grid gap-2">
              <p role="alert">{t("problem.copyFailed")}</p>
              <textarea className={textareaClassName} readOnly value={phase.text} />
            </div>
          )}
          {phase.kind === "failed" && (
            <p role="alert">{phase.summary ?? t("problem.prepareFailed")}</p>
          )}
          <DialogFooter>
            <Button variant="secondary" disabled={phase.kind === "opening"} onClick={close}>
              {phase.kind === "copied" || phase.kind === "copy_failed" || phase.kind === "failed"
                ? t("problem.close")
                : t("problem.cancel")}
            </Button>
            {fields && (
              <Button
                variant="primary"
                disabled={phase.kind === "opening"}
                onClick={() => void submit(fields)}
              >
                {t("problem.submit")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
