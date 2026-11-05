import { expect, test } from "vite-plus/test";
import { installedLaunchStatus, portDefinition, portStatus } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { setupRoutePresentation } from "./setup-route-presentation";
import { browsePortPresentation } from "./browse-presentation";

function fixture() {
  const definition = portDefinition();
  const status: PortStatus = {
    ...portStatus(),
    port_actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "authenticated_integrity_required" },
      },
      { action: "register_external", availability: "not_offered", reason: "route_not_offered" },
    ],
  };
  const entry: CatalogEntry = {
    ...definition,
    definition,
    listing: {
      id: definition.id,
      name: definition.name,
      summary: definition.summary,
      project_url: definition.project_url,
      platforms: definition.platforms,
      availability: "unknown",
    },
    listingStatus: {
      port_id: definition.id,
      status,
      actions: [{ action: "attach-existing", allowed: true }],
    },
  };
  return { entry, status };
}

test("managed hold retains its reason while independent attachment is prominent across browsing", () => {
  const { entry, status } = fixture();
  const result = setupRoutePresentation(entry, status);
  expect(result.promoteAlternative).toBe(true);
  expect(result.label).toBe("Manual setup available");
  expect(result.managedReason).toContain("expected verification");
  expect(result.routes.map((r) => r.action)).toEqual([
    "install",
    "register_external",
    "attach-existing",
  ]);
  expect(browsePortPresentation(entry, status, "catalog").state.label).toBe(
    "Manual setup available",
  );
});

test("current owners and refused or missing assessments never become a fallback grant", () => {
  const { entry, status } = fixture();
  expect(
    setupRoutePresentation(entry, {
      ...status,
      active: { id: "owned" } as NonNullable<typeof status.active>,
    }).promoteAlternative,
  ).toBe(false);
  const withoutStatus = { ...entry };
  delete withoutStatus.listingStatus;
  expect(setupRoutePresentation(withoutStatus, status).promoteAlternative).toBe(false);
  expect(
    setupRoutePresentation(
      {
        ...entry,
        listingStatus: {
          ...entry.listingStatus!,
          actions: [{ action: "attach-existing", allowed: false, reason: "Owner exists" }],
        },
      },
      status,
    ).promoteAlternative,
  ).toBe(false);
});

test("a usable managed route stays preferred without hiding the independent route", () => {
  const { entry, status } = fixture();
  status.port_actions = [{ action: "install", availability: "waiting", reason: "missing_source" }];
  const result = setupRoutePresentation(entry, status);
  expect(result.promoteAlternative).toBe(false);
  expect(result.routes.find((r) => r.action === "attach-existing")?.availability).toBe("allowed");
});

test("accepted packages do not conceal independent selection beside a managed hold", () => {
  const { entry, status } = fixture();
  status.port_actions!.push({
    action: "register_external",
    availability: "waiting",
    reason: "review_required",
  });
  status.port_actions = status.port_actions!.filter(
    (a, index) => a.action !== "register_external" || index === 2,
  );
  expect(setupRoutePresentation(entry, status).promoteAlternative).toBe(true);
});

test("an installed permitted launch stays ready despite a held update and missing optional evidence", () => {
  const { entry } = fixture();
  const status = installedLaunchStatus({ launchable: true, pending_setup: false, blockers: [] });
  status.port_actions = [
    { action: "launch", availability: "allowed", reason: "available" },
    {
      action: "update",
      availability: "held",
      reason: "definition_ineligible",
      definition: { outcome: "hold", reason: "refresh_incomplete" },
    },
  ];
  expect(setupRoutePresentation(entry, status).promoteAlternative).toBe(false);
  expect(browsePortPresentation(entry, status, "library").state.tone).toBe("ready");
});
