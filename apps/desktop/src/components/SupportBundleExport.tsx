import type { TFunction } from "i18next";
import { useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { useSupportReportExport } from "../features/workspace/settings-export-results";
import type { DesktopSupportBundleExport } from "../types";
import { failurePresentation } from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { Button } from "./ui/button";

type BundleSection = DesktopSupportBundleExport["manifest"]["sections"][number];

function sectionLabel(t: TFunction<"settings">, kind: BundleSection["kind"]): string {
  switch (kind) {
    case "startup":
      return t("supportReport.section.startup");
    case "doctor":
      return t("supportReport.section.doctor");
    case "activities":
      return t("supportReport.section.activities");
    case "activity_capture":
      return t("supportReport.section.activityCapture");
    case "runtime_log":
      return t("supportReport.section.runtimeLog");
  }
}

function sectionStatus(t: TFunction<"settings">, status: BundleSection["status"]): string {
  switch (status) {
    case "included":
      return t("supportReport.status.included");
    case "partial":
      return t("supportReport.status.partial");
    case "omitted":
      return t("supportReport.status.omitted");
  }
}

function reasonLabel(t: TFunction<"settings">, reason: BundleSection["reasons"][number]): string {
  switch (reason) {
    case "unavailable":
      return t("supportReport.reason.unavailable");
    case "read_failed":
      return t("supportReport.reason.readFailed");
    case "invalid_record":
      return t("supportReport.reason.invalidRecord");
    case "unsafe_file":
      return t("supportReport.reason.unsafeFile");
    case "section_limit":
      return t("supportReport.reason.sectionLimit");
    case "total_limit":
      return t("supportReport.reason.totalLimit");
    case "record_limit":
      return t("supportReport.reason.recordLimit");
    case "deadline":
      return t("supportReport.reason.deadline");
    case "incomplete_record":
      return t("supportReport.reason.incompleteRecord");
    case "capture_incomplete":
      return t("supportReport.reason.captureIncomplete");
    case "capture_truncated":
      return t("supportReport.reason.captureTruncated");
    case "capture_not_collected":
      return t("supportReport.reason.captureNotCollected");
    case "bounded_snapshot":
      return t("supportReport.reason.boundedSnapshot");
  }
}

export function SupportBundleExport({
  createSupportBundle,
  disabled = false,
}: {
  createSupportBundle?: (() => Promise<DesktopSupportBundleExport | undefined>) | undefined;
  disabled?: boolean;
}) {
  const { t } = useAppTranslation("settings");
  const { result, run } = useSupportReportExport();
  const exported = result.receipt;
  const pending = result.phase === "exporting";
  const failed = result.phase === "failed" || result.phase === "unconfirmed";
  const presentation = failurePresentation(result.error);
  const [folderStatus, setFolderStatus] = useState<"opening" | "failed">();
  const request = useRef(0);
  const openingFolder = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
    };
  }, []);

  const create = () => {
    if (disabled || pending || !createSupportBundle) return;
    request.current += 1;
    setFolderStatus(undefined);
    void run(createSupportBundle);
  };

  const openFolder = async () => {
    const current = request.current;
    if (openingFolder.current === current) return;
    openingFolder.current = current;
    setFolderStatus("opening");
    try {
      await desktopApi.openSupportReportFolder();
      if (request.current === current) setFolderStatus(undefined);
    } catch {
      if (request.current === current) setFolderStatus("failed");
    } finally {
      if (openingFolder.current === current) openingFolder.current = undefined;
    }
  };

  const incomplete = exported?.manifest.sections.some((section) => section.status !== "included");
  return (
    <div className="support-bundle-export grid min-w-0 gap-3 [overflow-wrap:anywhere]">
      <p>{t("supportReport.intro")}</p>
      <details>
        <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
          {t("supportReport.examplesSummary")}
        </summary>
        <p className="mt-2 text-pc-muted-foreground">{t("supportReport.examples")}</p>
      </details>
      <Button
        data-settings-control="diagnostics"
        data-focusable
        variant="outline"
        size="sm"
        disabled={disabled || !createSupportBundle}
        aria-busy={pending || undefined}
        focusableWhenDisabled={pending}
        className="justify-self-start"
        onClick={create}
      >
        {pending ? t("supportReport.creating") : t("supportReport.create")}
      </Button>
      {pending && <p role="status">{t("supportReport.collecting")}</p>}
      {failed && (
        <div role="alert" className="grid gap-2">
          <p className="text-pc-danger-foreground">{t("supportReport.failed")}</p>
          {presentation && (
            <>
              <p>{presentation.summary}</p>
              <FailureDetails presentation={presentation} showMutationSummary={false} />
            </>
          )}
        </div>
      )}
      {exported && (
        <>
          <p role="status">
            <Trans
              t={t}
              i18nKey={incomplete ? "supportReport.savedPartial" : "supportReport.savedComplete"}
              components={{
                path: (
                  <code dir="ltr" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
                    {exported.path}
                  </code>
                ),
              }}
            />
          </p>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="justify-self-start"
            aria-busy={folderStatus === "opening" || undefined}
            focusableWhenDisabled
            onClick={() => void openFolder()}
          >
            {t("supportReport.openFolder")}
          </Button>
          {folderStatus === "failed" && (
            <p role="alert" className="text-pc-danger-foreground">
              {t("supportReport.openFolderFailed")}
            </p>
          )}
          {!exported.manifest.library_available && <p>{t("supportReport.libraryUnavailable")}</p>}
          <details>
            <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
              {t("supportReport.contentsSummary")}
            </summary>
            <p className="mt-2 text-pc-muted-foreground">{t("supportReport.contentsLimits")}</p>
            <ul aria-label={t("supportReport.sectionsLabel")} className="mt-2 grid gap-3 ps-5">
              {exported.manifest.sections.map((section, index) => (
                <li key={`${section.kind}:${section.entry ?? index}`}>
                  <strong>
                    {t("supportReport.sectionSummary", {
                      section: sectionLabel(t, section.kind),
                      status: sectionStatus(t, section.status),
                    })}
                  </strong>
                  {section.entry && (
                    <p>
                      <code dir="ltr" className="[unicode-bidi:isolate]">
                        {section.entry}
                      </code>
                    </p>
                  )}
                  {section.reasons.length > 0 && (
                    <ul className="ps-5">
                      {section.reasons.map((reason) => (
                        <li key={reason}>{reasonLabel(t, reason)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
