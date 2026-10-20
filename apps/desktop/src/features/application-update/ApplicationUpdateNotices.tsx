import { Download, Settings, ShieldCheck, X } from "lucide-react";
import { Notice } from "../../components/ui/patterns";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui";
import { formatBytes } from "../../view-model";
import type { ApplicationUpdateNoticeSnapshot } from "../../types";
import type { ApplicationUpdateRoute } from "./focus-application-update-route";

/** The feature owns notice priority and actions; the app shell only places the section. */
export function ApplicationUpdateNotices({
  updateNotice,
  updateChoiceRequired,
  productionTransitionRequired,
  productionTransitionBusy,
  reviewUpdate,
  dismissUpdate,
  dismissUpdateChoice,
  useStable,
  keepPreview,
  dismissProductionTransition,
}: {
  updateNotice: ApplicationUpdateNoticeSnapshot["notice"] | undefined;
  updateChoiceRequired: boolean;
  productionTransitionRequired: boolean;
  productionTransitionBusy: boolean;
  reviewUpdate: (route: ApplicationUpdateRoute) => void;
  dismissUpdate: () => Promise<void>;
  dismissUpdateChoice: () => void;
  useStable: () => void;
  keepPreview: () => void;
  dismissProductionTransition: () => void;
}) {
  return (
    <>
      {updateNotice && (
        <ApplicationUpdateNoticeBanner
          notice={updateNotice}
          review={() => reviewUpdate(updateNotice.result.staged ? "status" : "check")}
          dismiss={dismissUpdate}
        />
      )}
      {!updateNotice && updateChoiceRequired && (
        <ApplicationUpdateChoiceBanner
          review={() => reviewUpdate("choice")}
          dismiss={dismissUpdateChoice}
        />
      )}
      {!updateNotice && !updateChoiceRequired && productionTransitionRequired && (
        <ApplicationUpdateProductionTransitionBanner
          busy={Boolean(productionTransitionBusy)}
          useStable={useStable}
          keepPreview={keepPreview}
          dismiss={dismissProductionTransition}
        />
      )}
    </>
  );
}

function ApplicationUpdateProductionTransitionBanner({
  busy,
  useStable,
  keepPreview,
  dismiss,
}: {
  busy: boolean;
  useStable: () => void;
  keepPreview: () => void;
  dismiss: () => void;
}) {
  return (
    <Notice
      intent="info"
      className=""
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={busy}
    >
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={ShieldCheck} />
      </span>
      <div data-slot="notice-body">
        <strong>Choose an update channel</strong>
        <p>
          Stable is recommended and waits for an eligible production release newer than this
          installation; it never downgrades Portcove. Keep Preview to continue receiving eligible
          test releases. Your update mode and pause setting stay unchanged.
        </p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="primary" size="sm" disabled={busy} onClick={useStable}>
          Use Stable
        </Button>
        <Button data-focusable variant="outline" size="sm" disabled={busy} onClick={keepPreview}>
          Keep Preview
        </Button>
        <Button data-focusable variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
          Not now
        </Button>
      </div>
    </Notice>
  );
}

function ApplicationUpdateChoiceBanner({
  review,
  dismiss,
}: {
  review: () => void;
  dismiss: () => void;
}) {
  return (
    <Notice intent="info" className="" role="status" aria-live="polite" aria-atomic="true">
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={Settings} />
      </span>
      <div data-slot="notice-body">
        <strong>Choose how Portcove updates</strong>
        <p>
          Automatic updates are recommended. During public beta, Preview receives eligible test
          releases. Portcove verifies updates and waits for a safe exit or an explicit restart
          before applying them.
        </p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="primary" size="sm" onClick={review}>
          Review options
        </Button>
        <Button data-focusable variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </Notice>
  );
}

function ApplicationUpdateNoticeBanner({
  notice,
  review,
  dismiss,
}: {
  notice: NonNullable<ApplicationUpdateNoticeSnapshot["notice"]>;
  review: () => void;
  dismiss: () => Promise<void>;
}) {
  const candidate = notice.result.candidate;
  if (!candidate) return null;
  const channel = candidate.channel === "preview" ? "Preview" : "Stable";
  return (
    <Notice
      intent={notice.result.staged ? "info" : "warning"}
      className=""
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={Download} />
      </span>
      <div data-slot="notice-body">
        <strong>
          {notice.result.staged
            ? `Portcove ${candidate.version} is ready to install`
            : `Portcove ${candidate.version} is available`}
        </strong>
        <p>
          {notice.result.staged
            ? `${channel} update verified (${formatBytes(candidate.bytes)}). Review it in Settings and restart when convenient.`
            : `${channel} update found (${formatBytes(candidate.bytes)}). Review it in Settings before downloading.`}
        </p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="primary" size="sm" onClick={review}>
          Review update
        </Button>
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss application update notice"
          onClick={() => void dismiss()}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </Notice>
  );
}
