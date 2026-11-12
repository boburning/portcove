import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
import type { PortListing } from "../../types";
import { platformLabel } from "../../view-model";

/** Current offered-route metadata, independently from an installed runtime. */
export function ListingMaintenanceFacts({ listing }: { listing?: PortListing | undefined }) {
  const { t } = useAppTranslation("browsing");
  const maintenance = listing?.release_maintenance;
  if (!maintenance) return null;
  return (
    <div>
      <dt>{t("maintenance.offer")}</dt>
      <dd>
        {maintenance.pinned_releases
          .map((pin) => `${platformLabel(pin.platform)}: ${pin.version}`)
          .join(" · ")}
      </dd>
      <dd>{maintenance.reason}</dd>
      <dd>
        {/* The condition is authored catalog text, rendered verbatim. */}
        <Trans
          t={t}
          i18nKey="maintenance.reconsider"
          components={{ condition: <>{maintenance.reconsider_when}</> }}
        />
      </dd>
    </div>
  );
}
