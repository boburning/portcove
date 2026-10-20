import type { ExternalRuntimePreview } from "../types";

type SharedReview = NonNullable<ExternalRuntimePreview["shared_preferences"]>;

export function sharedRuntimeDisclosure(review: SharedReview): string {
  const { contract, path } = review.binding;
  if (
    !path ||
    typeof review.present !== "boolean" ||
    typeof review.local_fallback_present !== "boolean"
  ) {
    throw new Error("Incomplete shared write scope review.");
  }
  if (contract === "regaiden041-windows" && review.local_fallback_path) {
    return `This game can rewrite shared preferences at ${path}, discard unknown entries and affect other copies in your Windows account. If that location is unavailable, it can instead rewrite ${review.local_fallback_path}. Portcove does not back up, restore or delete these files. Accept this shared write scope in the separate confirmation before registration.`;
  }
  if (
    contract === "smb1r-1.1-stable-windows" &&
    review.local_fallback_path == null &&
    !review.local_fallback_present
  ) {
    return `This game uses the shared directory ${path} for original game files, settings, saves and custom data. Other copies in your Windows account use the same data. The game can regenerate or trash generated caches and prune its logs. This route accepts only vanilla BaseAssets; custom levels and autosaves, blueprints, custom characters and extra resource packs require manual relocation before use. Portcove refuses these inputs without changing them. Portcove does not seed, migrate, back up, restore or delete this directory or its files. Accept this shared write scope in the separate confirmation before registration.`;
  }
  throw new Error("Unsupported or inconsistent shared write scope review.");
}
