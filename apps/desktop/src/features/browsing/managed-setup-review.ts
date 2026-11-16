import managedSetupReview from "../../managed-setup-review.generated.json";
import type { InstallPlan } from "../../types";

const authoredReviews: Readonly<
  Record<
    string,
    {
      note: string;
      warnings: readonly string[];
      platform_warnings: Partial<Record<InstallPlan["platform"], readonly string[]>>;
    }
  >
> = managedSetupReview;

export function authoredManagedSetupReview(
  portId: string,
  plan: Pick<InstallPlan, "port_id" | "platform"> | null | undefined,
) {
  const review = plan?.port_id === portId ? authoredReviews[portId] : undefined;
  if (!plan || !review) return undefined;
  return {
    note: review.note,
    warnings: [...review.warnings, ...(review.platform_warnings[plan.platform] ?? [])],
  };
}
