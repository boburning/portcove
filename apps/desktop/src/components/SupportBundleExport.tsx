import { useLayoutEffect, useRef, useState } from "react";
import type { DesktopSupportBundleExport } from "../types";
import { failurePresentation, type FailureDisplay } from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { Button } from "./ui/button";

type BundleSection = DesktopSupportBundleExport["manifest"]["sections"][number];

const sectionLabels = {
  startup: "Startup diagnostics",
  doctor: "System and library checks",
  activities: "Recent activity history",
  activity_capture: "Preparation output",
  runtime_log: "Runtime log",
} satisfies Record<BundleSection["kind"], string>;

const sectionStatuses = {
  included: "Included",
  partial: "Partially included",
  omitted: "Omitted",
} satisfies Record<BundleSection["status"], string>;

const reasonLabels = {
  unavailable: "The diagnostic source was unavailable; its contents are unknown.",
  read_failed: "The diagnostic source could not be fully read; any missing contents are unknown.",
  invalid_record: "Invalid records were omitted.",
  unsafe_file: "A file could not be safely read and was omitted.",
  section_limit: "Some data was omitted to stay within the section size limit.",
  total_limit: "Some data was omitted to stay within the bundle size limit.",
  record_limit: "Some records were omitted to stay within the record limit.",
  deadline: "Collection stopped at the time limit.",
  incomplete_record: "An incomplete trailing record was omitted.",
  capture_incomplete: "The retained capture may be missing later output.",
  capture_truncated: "Some captured output was omitted when the capture limit was reached.",
  capture_not_collected: "Retained preparation output was not collected.",
  bounded_snapshot: "Only a bounded snapshot was collected; older or later data may be missing.",
} satisfies Record<BundleSection["reasons"][number], string>;

export function SupportBundleExport({
  createSupportBundle,
  disabled = false,
}: {
  createSupportBundle?: (() => Promise<DesktopSupportBundleExport | undefined>) | undefined;
  disabled?: boolean;
}) {
  const [exported, setExported] = useState<DesktopSupportBundleExport>();
  const [pending, setPending] = useState(false);
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

  const incomplete = exported?.manifest.sections.some((section) => section.status !== "included");
  return (
    <div className="support-bundle-export grid min-w-0 gap-3 [overflow-wrap:anywhere]">
      <p>
        Create a support bundle with available recent logs, operation history, and system details.
        Game-file contents and saved credentials are excluded, but paths, file names, and other
        metadata may remain. Review the bundle before sharing it.
      </p>
      <details>
        <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
          Examples of details that may remain
        </summary>
        <p>
          Port and tool identifiers, timestamps, and other system details can remain after sensitive
          values are redacted.
        </p>
      </details>
      <Button
        data-focusable
        variant="outline"
        size="sm"
        disabled={disabled || pending || !createSupportBundle}
        onClick={() => void create()}
      >
        {pending ? "Creating support bundle…" : "Create support bundle"}
      </Button>
      {pending && <p role="status">Collecting available diagnostics…</p>}
      {failure && (
        <div role="alert">
          <p>Support bundle export did not finish. Try again.</p>
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
            Support bundle saved to{" "}
            <code dir="ltr" className="[overflow-wrap:anywhere] [unicode-bidi:isolate]">
              {exported.path}
            </code>
            .{" "}
            {incomplete
              ? "Some diagnostics are partial or omitted. Review the collection details below."
              : "Only the available diagnostics within collection limits were saved."}
          </p>
          {!exported.manifest.library_available && (
            <p>
              The library was unavailable during collection. Available sections are listed below.
            </p>
          )}
          <details>
            <summary data-focusable className="[scroll-margin-block:var(--space-2)]">
              View support bundle contents
            </summary>
            <p>
              This is a bounded snapshot. Older or later activity and log output may be missing.
            </p>
            <ul aria-label="Support bundle sections" className="grid gap-3 ps-5">
              {exported.manifest.sections.map((section, index) => (
                <li key={`${section.kind}:${section.entry ?? index}`}>
                  <strong>
                    {sectionLabels[section.kind]}: {sectionStatuses[section.status]}
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
                        <li key={reason}>{reasonLabels[reason]}</li>
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
