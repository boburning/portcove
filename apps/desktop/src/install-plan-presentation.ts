import type { InstallPlan } from "./types";

export function installPlanActionLabel(action: InstallPlan["action"]) {
  const labels: Record<InstallPlan["action"], string> = {
    already_active: "Already active",
    use_staged: "Use staged release",
    reuse_retained: "Reuse retained release",
    blocked_unverified: "Unverified local copy",
    download: "Download verified release",
  };
  return Object.hasOwn(labels, action) ? labels[action] : undefined;
}
