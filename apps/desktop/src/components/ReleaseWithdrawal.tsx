import { useAppTranslation } from "../localization";
import type { PortStatus } from "../types";
import { Button } from "./ui/button";

function withdrawal(status: PortStatus | undefined) {
  const holds = status?.definition_operations?.filter(
    ({ operation, eligibility }) =>
      operation === "install" &&
      eligibility.outcome === "hold" &&
      eligibility.reason === "curated_distribution_withdrawn",
  );
  return {
    installed: holds?.some(({ retained }) => retained) ? status?.active : undefined,
    recommended: Boolean(holds?.some(({ retained }) => !retained)),
  };
}

export function ReleaseWithdrawalBadge({ status }: { status: PortStatus | undefined }) {
  const { t } = useAppTranslation("detail");
  const { installed, recommended } = withdrawal(status);
  if (!installed && !recommended) return null;
  const style =
    "inline-flex rounded-sm border border-pc-border px-1.5 py-0.5 text-xs font-semibold";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {installed && <span className={style}>{t("withdrawal.installedBadge")}</span>}
      {recommended && <span className={style}>{t("withdrawal.recommendedBadge")}</span>}
    </span>
  );
}

export function ReleaseWithdrawalNotice({
  status,
  reviewVersions,
}: {
  status: PortStatus | undefined;
  reviewVersions: () => void;
}) {
  const { t } = useAppTranslation("detail");
  const { installed, recommended } = withdrawal(status);
  if (!installed && !recommended) return null;
  const canRollBack =
    installed &&
    status?.previous &&
    status.port_actions?.some(
      ({ action, availability }) => action === "rollback" && availability === "allowed",
    );
  return (
    <section
      aria-label={t("withdrawal.label")}
      className="grid justify-items-start gap-2 rounded-pc-md border border-pc-border bg-pc-surface p-4"
    >
      {installed && (
        <div className="grid gap-1">
          <p className="m-0 font-semibold">
            {t("withdrawal.installedReason", { version: installed.version })}
          </p>
          <p className="m-0 text-sm text-pc-muted-foreground">{t("withdrawal.installedNext")}</p>
        </div>
      )}
      {recommended && (
        <div className="grid gap-1">
          <p className="m-0 font-semibold">{t("withdrawal.recommendedReason")}</p>
          <p className="m-0 text-sm text-pc-muted-foreground">{t("withdrawal.recommendedNext")}</p>
        </div>
      )}
      {canRollBack && (
        <Button variant="outline" onClick={reviewVersions}>
          {t("withdrawal.rollback")}
        </Button>
      )}
      {recommended && !canRollBack && (
        <Button variant="outline" onClick={reviewVersions}>
          {t("withdrawal.versions")}
        </Button>
      )}
    </section>
  );
}
