import type { PortCapabilityReport } from "../types";
import { useAppTranslation } from "../localization";

export function LaunchBehaviorStages({
  behavior,
}: {
  behavior: NonNullable<PortCapabilityReport["advisories"][number]["notice"]["launch_behavior"]>;
}) {
  const { t } = useAppTranslation("detail");
  return (
    <dl className="grid gap-2">
      <div className="min-w-0">
        <dt className="text-xs text-pc-muted-foreground">{t("capabilities.launch.first")}</dt>
        <dd className="font-medium">{t(`capabilities.launch.${behavior.first_launch}`)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-pc-muted-foreground">{t("capabilities.launch.repeat")}</dt>
        <dd className="font-medium">{t(`capabilities.launch.${behavior.repeat_launch}`)}</dd>
      </div>
    </dl>
  );
}
