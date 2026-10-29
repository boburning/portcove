import type { PortListing } from "../../types";
import { platformLabel } from "../../view-model";

/** Current offered-route metadata, independently from an installed runtime. */
export function ListingMaintenanceFacts({ listing }: { listing?: PortListing | undefined }) {
  const maintenance = listing?.release_maintenance;
  if (!maintenance) return null;
  return (
    <div>
      <dt>Current managed offer</dt>
      <dd>
        {maintenance.pinned_releases
          .map((pin) => `${platformLabel(pin.platform)}: ${pin.version}`)
          .join(" · ")}
      </dd>
      <dd>{maintenance.reason}</dd>
      <dd>Reconsider when: {maintenance.reconsider_when}</dd>
    </div>
  );
}
