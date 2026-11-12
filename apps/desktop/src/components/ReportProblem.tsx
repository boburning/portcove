import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type { BugReportDraft, BugReportField, BugReportLink, ReportKind } from "../types";
import { useAppTranslation } from "../localization";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const textareaClassName =
  "min-h-32 w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 font-mono text-sm text-pc-foreground focus-visible:outline-2 focus-visible:outline-offset-2";

/** Fields the player may edit; the others are shown as facts. */
const editableFields = new Set(["observed", "evidence", "game", "happened", "expected", "context"]);

/** Why text was copied: the player asked, or it was too long for a link. */
type CopyReason = "asked" | "too_long";

type Phase =
  | { kind: "closed" }
  | { kind: "choosing" }
  // A choice made inside the dialog keeps it open while the draft loads.
  | { kind: "loading"; report: ReportKind; inDialog: boolean }
  | { kind: "ready"; report: ReportKind; fields: BugReportField[] }
  | { kind: "opening"; report: ReportKind; fields: BugReportField[] }
  | { kind: "copied"; report: ReportKind; reason: CopyReason }
  | {
      kind: "copy_failed";
      report: ReportKind;
      reason: CopyReason;
      text: string;
    }
  // Core's own summary when it gave one; the fallback is translated at render.
  | { kind: "failed"; summary: string | undefined };

/**
 * Shows exactly what a pre-filled GitHub bug report or feedback form will contain,
 * lets the player edit the free-text parts, then opens the form or copies the
 * text. Unless `problemOnly` is set, the player first chooses which one to send.
 * Portcove sends nothing itself.
 */
export function ReportProblem({
  portId,
  generation,
  problemOnly = false,
  preview = desktopApi.previewBugReport,
  open = desktopApi.openBugReport,
}: {
  portId?: string | undefined;
  generation: number;
  /** Skip the choice: the context is already a failure, such as a failed launch. */
  problemOnly?: boolean;
  preview?: (
    portId: string | undefined,
    generation: number,
    kind: ReportKind,
  ) => Promise<BugReportDraft>;
  open?: (fields: BugReportField[], kind: ReportKind, copyOnly: boolean) => Promise<BugReportLink>;
}) {
  const report: ReportKind | undefined = problemOnly ? "problem" : undefined;
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
  const load = (kind: ReportKind, inDialog: boolean) => {
    const current = ++request.current;
    setPhase({ kind: "loading", report: kind, inDialog });
    preview(portId, generation, kind).then(
      (draft) => {
        if (request.current === current)
          setPhase({ kind: "ready", report: kind, fields: draft.fields });
      },
      (value) => {
        if (request.current === current)
          setPhase({
            kind: "failed",
            summary: failurePresentation(value)?.summary,
          });
      },
    );
  };
  const start = () => {
    if (report) load(report, false);
    else setPhase({ kind: "choosing" });
  };
  const submit = async (kind: ReportKind, fields: BugReportField[], copyOnly: boolean) => {
    setPhase({ kind: "opening", report: kind, fields });
    try {
      const link = await open(fields, kind, copyOnly);
      if (link.url && !copyOnly) {
        close();
        return;
      }
      const reason: CopyReason = copyOnly ? "asked" : "too_long";
      try {
        await copyText(link.clipboard_text);
        setPhase({ kind: "copied", report: kind, reason });
      } catch {
        // Keep the text on screen so the player can still copy it by hand.
        setPhase({
          kind: "copy_failed",
          report: kind,
          reason,
          text: link.clipboard_text,
        });
      }
    } catch (value) {
      setPhase({
        kind: "failed",
        summary: failurePresentation(value)?.summary,
      });
    }
  };
  const draft = phase.kind === "ready" || phase.kind === "opening" ? phase : undefined;
  const shown: ReportKind | undefined =
    phase.kind === "closed" || phase.kind === "choosing" || phase.kind === "failed"
      ? report
      : phase.report;
  const title =
    shown === "problem"
      ? t("problem.title")
      : shown === "feedback"
        ? t("feedback.title")
        : t("choice.title");
  const description =
    shown === "problem"
      ? t("problem.description")
      : shown === "feedback"
        ? t("feedback.description")
        : t("choice.description");
  const copiedMessage = (kind: ReportKind, reason: CopyReason) =>
    reason === "asked"
      ? t("copy.copied")
      : kind === "feedback"
        ? t("feedback.copied")
        : t("problem.copied");
  const copyFailedMessage = (kind: ReportKind, reason: CopyReason) =>
    reason === "asked"
      ? t("copy.failed")
      : kind === "feedback"
        ? t("feedback.copyFailed")
        : t("problem.copyFailed");
  const finished =
    phase.kind === "copied" || phase.kind === "copy_failed" || phase.kind === "failed";
  return (
    <>
      <Button data-focusable variant="outline" onClick={start} disabled={phase.kind === "loading"}>
        {report === "problem" ? t("problem.open") : t("choice.open")}
      </Button>
      <Dialog
        open={phase.kind !== "closed" && !(phase.kind === "loading" && !phase.inDialog)}
        onOpenChange={(next) => {
          if (!next && phase.kind !== "opening") close();
        }}
      >
        <DialogContent reviewSize="standard" aria-describedby="report-problem-description">
          <DialogTitle className="text-xl">{title}</DialogTitle>
          <DialogDescription id="report-problem-description" className="leading-relaxed">
            {description}
          </DialogDescription>
          {phase.kind === "choosing" && (
            <div className="grid gap-2" role="group" aria-label={t("choice.title")}>
              <Button
                data-focusable
                variant="outline"
                className="h-auto justify-start py-2 text-start whitespace-normal"
                onClick={() => load("problem", true)}
              >
                {t("choice.problem")}
              </Button>
              <Button
                data-focusable
                variant="outline"
                className="h-auto justify-start py-2 text-start whitespace-normal"
                onClick={() => load("feedback", true)}
              >
                {t("choice.feedback")}
              </Button>
            </div>
          )}
          {phase.kind === "loading" && <p role="status">{t("choice.preparing")}</p>}
          {draft && (
            <div className="grid gap-3">
              {draft.fields.map((field) =>
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
                          report: draft.report,
                          fields: draft.fields.map((other) =>
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
            <p role="status">{copiedMessage(phase.report, phase.reason)}</p>
          )}
          {phase.kind === "copy_failed" && (
            <div className="grid gap-2">
              <p role="alert">{copyFailedMessage(phase.report, phase.reason)}</p>
              <textarea className={textareaClassName} readOnly value={phase.text} />
            </div>
          )}
          {phase.kind === "failed" && (
            <p role="alert">{phase.summary ?? t("problem.prepareFailed")}</p>
          )}
          <DialogFooter>
            <Button variant="secondary" disabled={phase.kind === "opening"} onClick={close}>
              {finished ? t("problem.close") : t("problem.cancel")}
            </Button>
            {draft && (
              <>
                <Button
                  variant="outline"
                  disabled={phase.kind === "opening"}
                  onClick={() => void submit(draft.report, draft.fields, true)}
                >
                  {t("copy.button")}
                </Button>
                <Button
                  variant="primary"
                  disabled={phase.kind === "opening"}
                  onClick={() => void submit(draft.report, draft.fields, false)}
                >
                  {t("problem.submit")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
