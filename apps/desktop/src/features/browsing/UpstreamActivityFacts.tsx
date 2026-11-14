import { useAppTranslation } from "../../localization";
import type { PortStatus, UpstreamActivity } from "../../types";

/** Two years without a reported upstream push, measured at the observation itself. */
const QUIET_SECONDS = 730 * 24 * 60 * 60;

export type UpstreamActivityState = "archived" | "quiet" | "recent";

/**
 * Classifies the provider's last repository observation. An absent observation, or
 * one without a reported change time for an unarchived repository, stays unknown.
 */
export function upstreamActivityState(
  activity: UpstreamActivity | null | undefined,
): UpstreamActivityState | undefined {
  if (!activity) return undefined;
  if (activity.archived) return "archived";
  if (activity.last_change_at === undefined || activity.last_change_at === null) return undefined;
  return activity.observed_at - activity.last_change_at >= QUIET_SECONDS ? "quiet" : "recent";
}

/** Upstream maintenance facts Core observed while checking this game for updates. */
export function UpstreamActivityFacts({ status }: { status?: PortStatus | undefined }) {
  const { t, i18n } = useAppTranslation("browsing");
  const activity = status?.last_update_check?.check.upstream_activity;
  const state = upstreamActivityState(activity);
  if (!activity || !state) return null;
  const format = (seconds: number, month: boolean) =>
    new Intl.DateTimeFormat(i18n.language, {
      year: "numeric",
      month: "long",
      ...(month ? {} : { day: "numeric" }),
      timeZone: "UTC",
    }).format(new Date(seconds * 1000));
  const lastChange = activity.last_change_at;
  // Quiet and recent states always carry a reported change time.
  const changed = format(lastChange ?? activity.observed_at, true);
  return (
    <div>
      <dt>{t("upstreamActivity.label")}</dt>
      <dd>
        {state === "archived"
          ? t("upstreamActivity.archived")
          : state === "quiet"
            ? t("upstreamActivity.quiet", { date: changed })
            : t("upstreamActivity.recent", { date: changed })}
      </dd>
      <dd className="text-[var(--color-text-muted)]">
        {t("upstreamActivity.checked", { date: format(activity.observed_at, false) })}
      </dd>
    </div>
  );
}
