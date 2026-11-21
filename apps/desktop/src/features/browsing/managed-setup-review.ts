import managedSetupReview from "../../managed-setup-review.generated.json";
import type { InstallPlan, PortDefinition } from "../../types";

const authoredReviews: Readonly<
  Record<
    string,
    | string
    | {
        note: string;
        warnings: readonly string[];
        platform_warnings: Partial<Record<InstallPlan["platform"], readonly string[]>>;
      }
  >
> = managedSetupReview;

export function authoredManagedSetupReview(
  portId: string,
  plan: Pick<InstallPlan, "port_id" | "platform"> | null | undefined,
  guide: NonNullable<PortDefinition["presentation"]>["manual_setup"],
) {
  const review = plan?.port_id === portId ? authoredReviews[portId] : undefined;
  if (!plan || !review) return undefined;
  if (typeof review === "string") {
    // Only promote a guide that matches the authored managed step. Use warnings
    // from the selected definition so retained versions keep their own limits.
    return guide?.steps[0]?.instruction === review
      ? { note: review, warnings: guide.warnings }
      : undefined;
  }
  return {
    note: review.note,
    warnings: [...review.warnings, ...(review.platform_warnings[plan.platform] ?? [])],
  };
}
