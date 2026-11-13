import type { TFunction } from "i18next";
import { useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { DesktopSupportBundleExport } from "../types";
import { failurePresentation, type FailureDisplay } from "../view-model";
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
  const [exported, setExported] = useState<DesktopSupportBundleExport>();
  const [pending, setPending] = useState(false);
  const [folderFailed, setFolderFailed] = useState(false);
  const [failure, setFailure] = useState<{ presentation: FailureDisplay | undefined }>();
  const request = useRef(0);
  const exporting = useRef(false);
  useLayoutEffect(() => {
    return () => {
      request.current += 1;
      exporting.current = false;
    };
  }, []);

  const create = async () => {
    if (disabled || exporting.current || !createSupportBundle) return;
    exporting.current = true;
    const current = ++request.current;
    setPending(true);
    setExported(undefined);
    setFailure(undefined);
    setFolderFailed(false);
    try {
      const result = await createSupportBundle();
      if (request.current === current) {
        if (result) setExported(result);
        else setFailure({ presentation: undefined });
      }
    } catch (value) {
      if (request.current === current) setFailure({ presentation: failurePresentation(value) });
    } finally {
      if (request.current === current) {
        exporting.current = false;
        setPending(false);
      }
    }
  };

  const openFolder = () => {
    setFolderFailed(false);
    desktopApi.openSupportReportFolder().catch(() => setFolderFailed(true));
  };

  const incomplete = exported?.manifest.sections.some((section) => section.status !== "included");
  return (
    <div className="support-bundle-export grid min-w-0 gap-3 [overflow-wrap:anywhere]">
      <p>{t("supportReport.intro")}</p>
      <details>
        <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
          {t("supportReport.examplesSummary")}
        </summary>
        <p>{t("supportReport.examples")}</p>
      </details>
      <Button
        data-settings-control="diagnostics"
        data-focusable
        variant="outline"
        size="sm"
        disabled={disabled || pending || !createSupportBundle}
        className="justify-self-start"
        onClick={() => void create()}
      >
        {pending ? t("supportReport.creating") : t("supportReport.create")}
      </Button>
      {pending && <p role="status">{t("supportReport.collecting")}</p>}
      {failure && (
        <div role="alert">
          <p>{t("supportReport.failed")}</p>
          {failure.presentation && (
            <>
              <p>{failure.presentation.summary}</p>
              <FailureDetails presentation={failure.presentation} showMutationSummary={false} />
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
            onClick={openFolder}
          >
            {t("supportReport.openFolder")}
          </Button>
          {folderFailed && <p role="alert">{t("supportReport.openFolderFailed")}</p>}
          {!exported.manifest.library_available && <p>{t("supportReport.libraryUnavailable")}</p>}
          <details>
            <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
              {t("supportReport.contentsSummary")}
            </summary>
            <p>{t("supportReport.contentsLimits")}</p>
            <ul aria-label={t("supportReport.sectionsLabel")} className="grid gap-3 ps-5">
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
