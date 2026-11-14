import { Download, X } from "lucide-react";
import { useAppTranslation } from "../../localization";
import { Notice } from "../../components/ui/patterns";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui";

/** Global notice for an available Portcove update. Hiding it never prevents the update. */
export function ApplicationUpdateNotices({
  version,
  review,
  dismiss,
}: {
  version: string | undefined;
  review: () => void;
  dismiss: () => void;
}) {
  const { t } = useAppTranslation("applicationUpdate");
  if (!version) return null;
  return (
    <Notice intent="info" className="" role="status" aria-live="polite" aria-atomic="true">
      <span
        data-slot="notice-icon"
        className="error-icon grid h-[2rem] w-[2rem] place-items-center"
      >
        <Icon glyph={Download} />
      </span>
      <div data-slot="notice-body">
        <strong>{t("notice.title", { version })}</strong>
        <p>{t("notice.body")}</p>
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
          onClick={dismiss}
        >
          <Icon glyph={X} />
        </Button>
      </div>
    </Notice>
  );
}
