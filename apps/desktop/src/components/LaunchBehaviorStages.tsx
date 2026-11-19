import type { PortCapabilityReport } from "../types";
import { useAppTranslation } from "../localization";

export function LaunchBehaviorStages({
  behavior,
}: {
  behavior: NonNullable<PortCapabilityReport["advisories"][number]["notice"]["launch_behavior"]>;
}) {
  const { t } = useAppTranslation("detail");
  return (
    <dl>
      <dt className="font-medium">{t("capabilities.launch.first")}</dt>
      <dd>{t(`capabilities.launch.${behavior.first_launch}`)}</dd>
      <dt className="font-medium">{t("capabilities.launch.repeat")}</dt>
      <dd>{t(`capabilities.launch.${behavior.repeat_launch}`)}</dd>
    </dl>
  );
}
