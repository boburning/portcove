import { listingActionAssessment, type CatalogEntry } from "../browsing/catalog-entry";
import type { PortStatus } from "../../types";
import { catalogSetupPresentation } from "./port-action-presentation";

/** Cached display facts. Every operation still uses its own current Core review. */
export function setupRoutePresentation(entry: CatalogEntry, status?: PortStatus) {
  const managed = catalogSetupPresentation(status);
  const occupied = Boolean(status?.active || status?.staged || status?.external_runtime);
  const attach = listingActionAssessment(entry.listingStatus, "attach-existing");
  const existing =
    !occupied &&
    entry.listing?.id === entry.id &&
    entry.listingStatus?.port_id === entry.id &&
    (!status || status.port_id === entry.id) &&
    attach.allowed;
  const preferredManaged = managed.routes.some(
    (route) =>
      route.action === "install" &&
      (route.availability === "allowed" || route.availability === "waiting"),
  );
  const promoteAlternative = !occupied && !entry.pendingSetup && existing && !preferredManaged;
  const routes = [
    ...(entry.definition ? managed.routes : []),
    ...(entry.listing?.manual_setup || entry.listing?.setup_url
      ? [
          {
            action: "upstream-instructions" as const,
            route: "Upstream setup instructions",
            availability: "unknown" as const,
            reason:
              "Follow the reviewed project guide. Download eligibility is checked separately when viewing package options.",
          },
        ]
      : []),
    ...(entry.listing
      ? [
          {
            action: "attach-existing" as const,
            route: "Use an existing installation",
            availability: existing ? ("allowed" as const) : ("not_offered" as const),
            reason:
              attach.reason ??
              "Select your prepared executable and review its launch details. You and upstream manage its files and updates.",
          },
        ]
      : []),
  ];
  return {
    routes,
    promoteAlternative,
    label: entry.pendingSetup
      ? "Continue setup"
      : existing && !preferredManaged
        ? "Manual setup available"
        : managed.label,
    managedReason: managed.routes.find((route) => route.action === "install")?.reason,
  };
}
