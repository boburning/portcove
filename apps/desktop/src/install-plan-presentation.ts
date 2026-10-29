import type { InstallPlan } from "./types";

export function installPlanActionLabel(action: InstallPlan["action"]) {
  const labels: Record<InstallPlan["action"], string> = {
    already_active: "Already installed",
    use_staged: "Use saved version",
    reuse_retained: "Use previous version",
    blocked_unverified: "Local copy needs checking",
    download: "Download release",
  };
  return Object.hasOwn(labels, action) ? labels[action] : undefined;
}
