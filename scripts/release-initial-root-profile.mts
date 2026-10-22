/** Expected initial authority shape selected by ratified configuration. This
 * value is never inferred from Root metadata and grants no authority itself. */
export type InitialRootProfile = "legacy-two-of-three-v1" | "single-owner-one-of-one-v1";

export function inspectInitialRootProfile(raw: unknown): InitialRootProfile {
  if (raw !== "legacy-two-of-three-v1" && raw !== "single-owner-one-of-one-v1")
    throw new Error("initial Root profile must be explicitly appointed");
  return raw;
}

/** Preserve existing legacy context bytes and make the new selection explicit. */
export function initialRootProfileFields(profile: InitialRootProfile) {
  return inspectInitialRootProfile(profile) === "single-owner-one-of-one-v1"
    ? { initial_root_profile: profile }
    : {};
}

export type TopLevelTargetsProfile = "offline-pinned-v1" | "online-unchanged-authority-v1";
export function inspectTopLevelTargetsProfile(raw: unknown): TopLevelTargetsProfile {
  if (raw !== "offline-pinned-v1" && raw !== "online-unchanged-authority-v1")
    throw new Error("top-level Targets profile must be explicitly appointed");
  return raw;
}
export function topLevelTargetsProfileFields(profile: TopLevelTargetsProfile) {
  return inspectTopLevelTargetsProfile(profile) === "online-unchanged-authority-v1"
    ? { top_level_targets_profile: profile }
    : {};
}
