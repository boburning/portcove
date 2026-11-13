import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { copyText } from "../clipboard";
import type {
  BugReportDraft,
  BugReportField,
  BugReportLink,
  GithubAuthStatus,
  ReportKind,
  SubmittedReport,
} from "../types";
import { useAppTranslation } from "../localization";
import { failurePresentation } from "../view-model";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const textareaClassName =
  "min-h-32 w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 font-mono text-sm text-pc-foreground focus-visible:outline-2 focus-visible:outline-offset-2";

/** Fields the player may edit; the others, including the game, are shown as facts. */
const editableFields = new Set([
  "observed",
  "reproduce",
  "evidence",
  "happened",
  "expected",
  "context",
]);

const selectClassName =
  "w-full min-w-0 rounded-pc-md border border-pc-input bg-[var(--color-bg-inset)] px-3 py-2 text-sm font-normal text-pc-foreground focus-visible:outline-2 focus-visible:outline-offset-2";

type ReportChoice = BugReportDraft["choices"][number];

/** The player's own account; Core refuses to submit without it. */
const storyField = (kind: ReportKind) => (kind === "feedback" ? "happened" : "observed");

const valueOf = (fields: BugReportField[], id: string) =>
  fields.find((field) => field.id === id)?.value ?? "";

/** Why text was copied: the player asked, or it was too long for a link. */
type CopyReason = "asked" | "too_long";

type Phase =
  | { kind: "closed" }
  | { kind: "choosing" }
  // A choice made inside the dialog keeps it open while the draft loads.
  | { kind: "loading"; report: ReportKind; inDialog: boolean }
  // `error` keeps the player's text on screen when opening, copying or submitting failed.
  | {
      kind: "ready";
      report: ReportKind;
      fields: BugReportField[];
      choices: ReportChoice[];
      error?: string | undefined;
    }
  | { kind: "opening"; report: ReportKind; fields: BugReportField[]; choices: ReportChoice[] }
  | { kind: "submitted"; report: ReportKind; issue: SubmittedReport }
  | { kind: "copied"; report: ReportKind; reason: CopyReason }
  | {
      kind: "copy_failed";
      report: ReportKind;
      reason: CopyReason;
      text: string;
    }
  // Core's own summary when it gave one; the fallback is translated at render.
  | { kind: "failed"; report: ReportKind | undefined; summary: string | undefined };

/**
 * Shows exactly what a pre-filled GitHub bug report or feedback form will contain,
 * lets the player edit the free-text parts, then opens the form or copies the
 * text. A player signed in to GitHub can also submit it from their own account;
 * Core builds the issue and holds the token. Nothing is sent until the player
 * chooses. Unless `problemOnly` is set, the player first chooses which kind.
 */
export function ReportProblem({
  portId,
  generation,
  problemOnly = false,
  preview = desktopApi.previewBugReport,
  open = desktopApi.openBugReport,
  submitReport = desktopApi.submitReport,
  authStatus = desktopApi.githubAuthStatus,
  openIssue = desktopApi.openExternalUrl,
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
  submitReport?: (fields: BugReportField[], kind: ReportKind) => Promise<SubmittedReport>;
  authStatus?: () => Promise<GithubAuthStatus>;
  openIssue?: (url: string) => Promise<void>;
}) {
  const report: ReportKind | undefined = problemOnly ? "problem" : undefined;
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  // The GitHub account Submit would use; unknown or signed out offers no Submit.
  const [login, setLogin] = useState<string>();
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
    setLogin(undefined);
    // A status read that throws or rejects just leaves Submit hidden.
    Promise.resolve()
      .then(authStatus)
      .then(
        (status) => {
          if (request.current === current)
            setLogin(status.authenticated ? (status.login ?? undefined) : undefined);
        },
        () => undefined,
      );
    preview(portId, generation, kind).then(
      (draft) => {
        if (request.current === current)
          setPhase({
            kind: "ready",
            report: kind,
            fields: draft.fields,
            choices: draft.choices,
          });
      },
      (value) => {
        if (request.current === current)
          setPhase({
            kind: "failed",
            report: kind,
            summary: failurePresentation(value)?.summary,
          });
      },
    );
  };
  const start = () => {
    if (report) load(report, false);
    else setPhase({ kind: "choosing" });
  };
  const send = async (kind: ReportKind, fields: BugReportField[], choices: ReportChoice[]) => {
    const current = request.current;
    setPhase({ kind: "opening", report: kind, fields, choices });
    try {
      const issue = await submitReport(fields, kind);
      if (request.current === current) setPhase({ kind: "submitted", report: kind, issue });
    } catch (value) {
      if (request.current === current)
        setPhase({
          kind: "ready",
          report: kind,
          fields,
          choices,
          error: failurePresentation(value)?.summary ?? t("send.failed"),
        });
    }
  };
  const submit = async (
    kind: ReportKind,
    fields: BugReportField[],
    choices: ReportChoice[],
    copyOnly: boolean,
  ) => {
    setPhase({ kind: "opening", report: kind, fields, choices });
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
        kind: "ready",
        report: kind,
        fields,
        choices,
        error: failurePresentation(value)?.summary ?? t("copy.openFailed"),
      });
    }
  };
  const draft = phase.kind === "ready" || phase.kind === "opening" ? phase : undefined;
  const shown: ReportKind | undefined =
    phase.kind === "closed" || phase.kind === "choosing" ? report : (phase.report ?? report);
  const { title, description, finished } = reportPresentation(t, phase, shown);
  const edit = (id: string, value: string) => {
    if (!draft) return;
    const known = draft.fields.some((field) => field.id === id);
    const label = draft.choices.find((choice) => choice.id === id)?.label ?? id;
    setPhase({
      kind: "ready",
      report: draft.report,
      choices: draft.choices,
      fields: known
        ? draft.fields.map((field) => (field.id === id ? { ...field, value } : field))
        : [...draft.fields, { id, label, value }],
    });
  };
  const readyToSend =
    draft !== undefined &&
    valueOf(draft.fields, storyField(draft.report)).trim() !== "" &&
    draft.choices.every((choice) => choice.options.includes(valueOf(draft.fields, choice.id)));
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
            <ReportDraftFields draft={draft} opening={phase.kind === "opening"} edit={edit} />
          )}
          {phase.kind === "submitted" && (
            <p role="status">{t("send.done", { number: phase.issue.number })}</p>
          )}
          {phase.kind === "copied" && (
            <p role="status">{copiedMessage(t, phase.report, phase.reason)}</p>
          )}
          {phase.kind === "copy_failed" && (
            <div className="grid gap-2">
              <p role="alert">{copyFailedMessage(t, phase.report, phase.reason)}</p>
              <textarea className={textareaClassName} readOnly value={phase.text} />
            </div>
          )}
          {phase.kind === "ready" && phase.error && <p role="alert">{phase.error}</p>}
          {login && draft && !readyToSend && (
            <p id="report-send-needs" className="text-sm text-[var(--color-text-secondary)]">
              {t("send.needs")}
            </p>
          )}
          {phase.kind === "failed" && (
            <p role="alert">{phase.summary ?? t("problem.prepareFailed")}</p>
          )}
          <DialogFooter>
            <Button variant="secondary" disabled={phase.kind === "opening"} onClick={close}>
              {finished ? t("problem.close") : t("problem.cancel")}
            </Button>
            {phase.kind === "submitted" && (
              <Button variant="primary" onClick={() => void openIssue(phase.issue.url)}>
                {t("send.view")}
              </Button>
            )}
            {draft && (
              <>
                <Button
                  variant="outline"
                  disabled={phase.kind === "opening"}
                  onClick={() => void submit(draft.report, draft.fields, draft.choices, true)}
                >
                  {t("copy.button")}
                </Button>
                <Button
                  variant={login ? "outline" : "primary"}
                  disabled={phase.kind === "opening"}
                  onClick={() => void submit(draft.report, draft.fields, draft.choices, false)}
                >
                  {t("problem.submit")}
                </Button>
                {login && (
                  <Button
                    variant="primary"
                    disabled={phase.kind === "opening" || !readyToSend}
                    aria-describedby={readyToSend ? undefined : "report-send-needs"}
                    onClick={() => void send(draft.report, draft.fields, draft.choices)}
                  >
                    {t("send.button", { login })}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ReportTranslation = ReturnType<typeof useAppTranslation<"report">>["t"];

function reportPresentation(t: ReportTranslation, phase: Phase, shown: ReportKind | undefined) {
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
  const finished =
    phase.kind === "copied" ||
    phase.kind === "copy_failed" ||
    phase.kind === "failed" ||
    phase.kind === "submitted";
  return { title, description, finished };
}

const copiedMessage = (t: ReportTranslation, kind: ReportKind, reason: CopyReason) =>
  reason === "asked"
    ? t("copy.copied")
    : kind === "feedback"
      ? t("feedback.copied")
      : t("problem.copied");
const copyFailedMessage = (t: ReportTranslation, kind: ReportKind, reason: CopyReason) =>
  reason === "asked"
    ? t("copy.failed")
    : kind === "feedback"
      ? t("feedback.copyFailed")
      : t("problem.copyFailed");

function ReportDraftFields({
  draft,
  opening,
  edit,
}: {
  draft: Extract<Phase, { kind: "ready" | "opening" }>;
  opening: boolean;
  edit: (id: string, value: string) => void;
}) {
  const { t } = useAppTranslation("report");
  return (
    <div className="grid gap-3">
      {draft.choices.map((choice) => (
        <label key={choice.id} className="grid gap-1 text-sm font-semibold">
          {choice.label}
          <select
            className={selectClassName}
            value={valueOf(draft.fields, choice.id)}
            disabled={opening}
            onChange={(event) => edit(choice.id, event.target.value)}
          >
            <option value="">{t("send.choose")}</option>
            {choice.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ))}
      {draft.fields
        .filter((field) => !draft.choices.some((choice) => choice.id === field.id))
        .map((field) =>
          editableFields.has(field.id) ? (
            <label key={field.id} className="grid gap-1 text-sm font-semibold">
              {field.label}
              <textarea
                className={textareaClassName}
                value={field.value}
                disabled={opening}
                onChange={(event) => edit(field.id, event.target.value)}
              />
            </label>
          ) : (
            <p key={field.id} className="text-sm">
              <span className="font-semibold">{field.label}:</span> {field.value}
            </p>
          ),
        )}
    </div>
  );
}
