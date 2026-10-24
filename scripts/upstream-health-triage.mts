// Presentation-only classification of read-only upstream conditions. These
// results must never admit a port, authorize bytes or change a Core hold.
export interface HealthTriageCondition {
  port_id: string;
  provider: string;
  location: string;
  release_ref: string | null;
  rule: string | null;
  classification: string;
  accounted_for: boolean;
  changed_in_this_run: boolean;
  observed_this_run: boolean;
  freshness: "fresh" | "stale";
  latest_collection_status: "complete" | "partial";
  first_seen: string;
  observed_at: string;
  occurrences: number;
  retry_at: string | null;
  resume_condition: string | null;
}

// The provider can have successfully accounted for an expected GitHub download
// redirect while the location itself remains unverified. Suppress routine repeats
// only when the retained attempt is fresh and complete. A stale/partial attempt
// must not disappear from the actionable summary merely because it once passed
// metadata accounting.
export function isRoutineProviderCondition(incident: HealthTriageCondition): boolean {
  return (
    incident.accounted_for &&
    !incident.changed_in_this_run &&
    incident.freshness === "fresh" &&
    incident.latest_collection_status === "complete" &&
    incident.classification.startsWith("provider-reported-")
  );
}

function priority(incident: HealthTriageCondition): number {
  if (incident.changed_in_this_run) return 0;
  if (!incident.accounted_for) return 1;
  if (incident.freshness === "stale") return 2;
  if (incident.latest_collection_status === "partial") return 3;
  return 4;
}

export function classifyHealthConditions<T extends HealthTriageCondition>(
  conditions: readonly T[],
) {
  const routine: T[] = [];
  const visible: T[] = [];
  for (const condition of conditions) {
    if (isRoutineProviderCondition(condition)) routine.push(condition);
    else visible.push(condition);
  }
  visible.sort(
    (a, b) =>
      priority(a) - priority(b) ||
      a.port_id.localeCompare(b.port_id) ||
      a.provider.localeCompare(b.provider) ||
      a.location.localeCompare(b.location) ||
      (a.release_ref ?? "").localeCompare(b.release_ref ?? "") ||
      (a.rule ?? "").localeCompare(b.rule ?? ""),
  );
  return {
    routine,
    changed: visible.filter((condition) => condition.changed_in_this_run),
    continuing: visible.filter((condition) => !condition.changed_in_this_run),
    ordered: visible,
    stale: visible.filter((condition) => condition.freshness === "stale").length,
    partial: visible.filter((condition) => condition.latest_collection_status === "partial").length,
    retained: visible.filter((condition) => !condition.observed_this_run).length,
  };
}

// Count *observations*, not consecutive failures or uninterrupted downtime.
// For retained/stale conditions, use the last actual observation clock, not the
// workflow's wall clock, which could otherwise imply coverage that never ran.
export function observedSpan(
  incident: Pick<HealthTriageCondition, "first_seen" | "observed_at">,
): string {
  const first = Date.parse(incident.first_seen);
  const last = Date.parse(incident.observed_at);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return "unknown";
  const hours = Math.floor((last - first) / 3600000);
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
}

export function conditionEvidence(incident: HealthTriageCondition): string {
  if (incident.freshness === "stale") return "Stale history; reobserve before deciding";
  if (incident.latest_collection_status === "partial")
    return "Partial collection; outcome not established";
  if (!incident.observed_this_run) return "Retained fresh history; not checked in this run";
  if (incident.accounted_for)
    return incident.classification.startsWith("provider-reported-")
      ? "Provider metadata accounted for; destination and bytes unverified"
      : "Reviewed exception scope; operation safety unassessed";
  return "Unaccounted observation; investigate exact scope";
}
