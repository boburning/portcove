import { Download, Settings, ShieldCheck, X } from "lucide-react";
import { useAppTranslation } from "../../localization";
import type { TFunction } from "i18next";
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
  const { t } = useAppTranslation("applicationUpdate");
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
        <strong>{t("productionTransition.title")}</strong>
        <p>{t("productionTransition.body")}</p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="primary" size="sm" disabled={busy} onClick={useStable}>
          {t("productionTransition.useStable")}
        </Button>
        <Button data-focusable variant="outline" size="sm" disabled={busy} onClick={keepPreview}>
          {t("productionTransition.keepPreview")}
        </Button>
        <Button data-focusable variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
          {t("productionTransition.notNow")}
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
  const { t } = useAppTranslation("applicationUpdate");
  return (
    <Notice intent="info" className="" role="status" aria-live="polite" aria-atomic="true">
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={Settings} />
      </span>
      <div data-slot="notice-body">
        <strong>{t("choice.title")}</strong>
        <p>{t("choice.body")}</p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="outline" size="sm" onClick={review}>
          {t("choice.review")}
        </Button>
        <Button data-focusable variant="ghost" size="sm" onClick={dismiss}>
          {t("choice.notNow")}
        </Button>
      </div>
    </Notice>
  );
}

// Complete per-channel messages with static contexts: a channel name is never
// inserted into a sentence, and no base key can surface as a raw fallback.
function channelUpdateBody(
  t: TFunction<"applicationUpdate">,
  preview: boolean,
  staged: boolean,
  size: string,
) {
  if (staged) {
    return preview
      ? t("notice.readyBody", { context: "preview", size })
      : t("notice.readyBody", { context: "stable", size });
  }
  return preview
    ? t("notice.availableBody", { context: "preview", size })
    : t("notice.availableBody", { context: "stable", size });
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
  const { t } = useAppTranslation("applicationUpdate");
  const candidate = notice.result.candidate;
  if (!candidate) return null;
  const size = formatBytes(candidate.bytes);
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
            ? t("notice.readyTitle", { version: candidate.version })
            : t("notice.availableTitle", { version: candidate.version })}
        </strong>
        <p>{channelUpdateBody(t, candidate.channel === "preview", notice.result.staged, size)}</p>
      </div>
      <div data-slot="notice-actions" className="error-actions flex gap-1">
        <Button data-focusable variant="primary" size="sm" onClick={review}>
          {t("notice.review")}
        </Button>
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          aria-label={t("notice.dismiss")}
          onClick={() => void dismiss()}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </Notice>
  );
}
