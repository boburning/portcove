import { useAppTranslation } from "../../localization";
import type { PortDefinition, PortStatus, UpstreamActivity } from "../../types";

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

/** The observation describes this port only while it still names the same GitHub repository. */
export function currentUpstreamActivity(
  port: PortDefinition,
  status: PortStatus | undefined,
): UpstreamActivity | undefined {
  const activity = status?.last_update_check?.check.upstream_activity;
  if (!activity) return undefined;
  // GitHub owner and repository names are case-insensitive; an empty name binds nothing.
  if (
    port.release.provider !== "github" ||
    !activity.repository ||
    port.release.repository.toLowerCase() !== activity.repository.toLowerCase()
  )
    return undefined;
  return activity;
}

/**
 * Upstream maintenance facts GitHub reported while Portcove checked this game for
 * updates. Separate from the catalog's reviewed upstream project status.
 */
export function UpstreamActivityFacts({
  port,
  status,
}: {
  port: PortDefinition;
  status?: PortStatus | undefined;
}) {
  const { t, i18n } = useAppTranslation("browsing");
  const activity = currentUpstreamActivity(port, status);
  const state = upstreamActivityState(activity);
  if (!activity || !state) return null;
  const checked = new Date(activity.observed_at * 1000).toLocaleDateString(i18n.language);
  // Quiet and recent states always carry a reported change time.
  const changed = new Date(
    (activity.last_change_at ?? activity.observed_at) * 1000,
  ).toLocaleDateString(i18n.language, { year: "numeric", month: "long" });
  return (
    <div>
      <dt>{t("upstreamActivity.label")}</dt>
      <dd>
        {state === "archived"
          ? t("upstreamActivity.archived", { checked })
          : state === "quiet"
            ? t("upstreamActivity.quiet", { checked, date: changed })
            : t("upstreamActivity.recent", { checked, date: changed })}
      </dd>
    </div>
  );
}
