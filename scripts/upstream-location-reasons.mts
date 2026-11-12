/**
 * The upstream-health monitor's original-location rules, dependency-free so
 * read-only consumers can classify monitor conditions without loading the
 * monitor, its GitHub client or its reviewed accounting file.
 */

/** Monitor rules that describe the original location itself: a redirect or a missing repository. */
export const originalLocationReasons = ["provider-redirect", "inaccessible-or-missing"] as const;

export type OriginalLocationReason = (typeof originalLocationReasons)[number];
