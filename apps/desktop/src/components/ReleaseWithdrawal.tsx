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
  if (status?.active && holds?.some(({ retained }) => retained)) return "installed";
  if (holds?.some(({ retained }) => !retained)) return "recommended";
  return null;
}

export function ReleaseWithdrawalBadge({ status }: { status: PortStatus | undefined }) {
  const { t } = useAppTranslation("detail");
  const target = withdrawal(status);
  if (!target) return null;
  return (
    <span className="inline-flex rounded-sm border border-pc-border px-1.5 py-0.5 text-xs font-semibold">
      {target === "installed" ? t("withdrawal.installedBadge") : t("withdrawal.recommendedBadge")}
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
  const target = withdrawal(status);
  if (!target) return null;
  const installed = target === "installed";
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
      <p className="m-0 font-semibold">
        {installed
          ? t("withdrawal.installedReason", { version: status?.active?.version })
          : t("withdrawal.recommendedReason")}
      </p>
      <p className="m-0 text-sm text-pc-muted-foreground">
        {installed
          ? t("withdrawal.installedNext")
          : t("withdrawal.recommendedNext")}
      </p>
      {canRollBack && (
        <Button variant="outline" onClick={reviewVersions}>
          {t("withdrawal.rollback")}
        </Button>
      )}
      {!installed && (
        <Button variant="outline" onClick={reviewVersions}>
          {t("withdrawal.versions")}
        </Button>
      )}
    </section>
  );
}
