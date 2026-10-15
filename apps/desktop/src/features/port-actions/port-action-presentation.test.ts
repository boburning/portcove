import { expect, it } from "vite-plus/test";
import { portStatus } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import {
  catalogSetupPresentation,
  installedCardInputPresentation,
  definitionHoldReason,
  portActionPresentation,
} from "./port-action-presentation";

type Assessment = NonNullable<PortStatus["port_actions"]>[number];
const withAssessment = (assessment: Assessment): PortStatus => ({
  ...portStatus(),
  port_actions: [assessment],
});

it("explains exact artifact revocation for retained rollback", () => {
  expect(
    portActionPresentation(
      withAssessment({
        action: "rollback",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "curated_artifact_revoked" },
      }),
      "rollback",
    ),
  ).toEqual({
    blocked: true,
    reason:
      "Restore previous version is on hold. This exact release file was revoked. Your files and saves are retained.",
  });
});

it.each([undefined, { ...portStatus(), port_actions: [] }, portStatus()])(
  "preserves legacy readiness behavior when action projections are absent: %s",
  (status) => {
    expect(portActionPresentation(status, "install")).toEqual({ blocked: false });
    expect(portActionPresentation(status, "launch")).toEqual({ blocked: false });
    expect(portActionPresentation(status, "rollback").blocked).toBe(true);
  },
);

it.each([
  ["allowed", "available", false],
  ["not_offered", "not_installed", true],
  ["not_offered", "route_not_offered", true],
  ["held", "missing_runtime", true],
  ["held", "invalid_installation", true],
] as const)("consumes retained rollback assessment %s/%s", (availability, reason, blocked) => {
  const status = withAssessment({ action: "rollback", availability, reason });
  const before = JSON.stringify(status);
  expect(portActionPresentation(status, "rollback").blocked).toBe(blocked);
  expect(JSON.stringify(status)).toBe(before);
});

it("explains the current-catalog rollback route refusal", () => {
  expect(
    portActionPresentation(
      withAssessment({
        action: "rollback",
        availability: "not_offered",
        reason: "route_not_offered",
      }),
      "rollback",
    ),
  ).toEqual({
    blocked: true,
    reason:
      "Restore previous version is unavailable because this port is no longer in the current catalog.",
  });
});

it.each(
  [
    [{ action: "launch", availability: "allowed", reason: "available" }],
    [{ action: "rollback", availability: "allowed", reason: "missing_runtime" }],
    [{ action: "rollback", availability: "waiting", reason: "missing_runtime" }],
    [{ action: "rollback", availability: "held", reason: "missing_source" }],
    [{ action: "rollback", availability: "held", reason: "route_not_offered" }],
    [{ action: "rollback", availability: "held", reason: "future_reason" }],
    [
      {
        action: "rollback",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "eligible", reason: "mandatory_checks_passed" },
      },
    ],
    [
      { action: "rollback", availability: "allowed", reason: "available" },
      { action: "rollback", availability: "held", reason: "invalid_installation" },
    ],
  ].map((port_actions) => ({ port_actions })),
)("holds incomplete or contradictory rollback projections: %s", ({ port_actions }) => {
  expect(
    portActionPresentation({ ...portStatus(), port_actions } as PortStatus, "rollback"),
  ).toEqual({
    blocked: true,
    reason: "Current rollback availability is unavailable. Refresh the workspace to check again.",
  });
});

it.each(["install", "launch"] as const)(
  "projects allowed %s without granting execution",
  (action) => {
    const status = withAssessment({ action, availability: "allowed", reason: "available" });
    const original = JSON.stringify(status);
    expect(portActionPresentation(status, action)).toEqual({ blocked: false });
    expect(JSON.stringify(status)).toBe(original);
  },
);

it.each(["missing_source", "missing_bios"] as const)(
  "keeps the selected-input review flow for %s",
  (reason) => {
    expect(
      portActionPresentation(
        withAssessment({ action: "install", availability: "waiting", reason }),
        "install",
      ),
    ).toEqual({ blocked: false });
    expect(
      portActionPresentation(
        withAssessment({ action: "launch", availability: "waiting", reason }),
        "launch",
      ).blocked,
    ).toBe(true);
  },
);

it.each([
  ["publisher_revoked", "The catalog publisher was revoked."],
  [
    "curated_artifact_revoked",
    "This exact release file was revoked. Your files and saves are retained.",
  ],
  [
    "curated_distribution_withdrawn",
    "Distribution of this release file was withdrawn. Permitted installed use remains available.",
  ],
  [
    "unknown_safety_semantics",
    "This definition has safety requirements Portcove cannot interpret.",
  ],
  ["publisher_scope_required", "This publisher is not approved for this port."],
  ["engine_capability_required", "This version of Portcove cannot use this route."],
  ["ownership_migration_required", "An existing installation needs ownership review."],
  ["metadata_replay", "The catalog update is older than the accepted version."],
  ["refresh_incomplete", "The catalog update did not finish."],
  ["metadata_stale", "The catalog information needs refreshing."],
  ["recorded_identity_changed", "The accepted file identity changed."],
  ["authenticated_integrity_required", "The required file integrity evidence is missing."],
  ["local_integrity_failed", "A required local file check failed."],
  ["mandatory_check_failed", "A required check failed."],
  ["source_identity_mismatch", "The game files do not match the required edition."],
  ["required_source_missing", "Required game files are missing."],
])("retains the existing definition explanation for %s", (reason, explanation) => {
  expect(definitionHoldReason("Setup", reason)).toBe(`Setup is on hold. ${explanation}`);
  expect(definitionHoldReason("Launch", reason)).toBe(`Launch is on hold. ${explanation}`);
});

it.each([undefined, "future_reason", "__proto__", "<script>arbitrary report</script>"])(
  "keeps unknown definition reasons scoped without displaying untrusted data: %s",
  (reason) => {
    expect(definitionHoldReason("Launch", reason)).toBe(
      "Launch is on hold. Check this port's current requirements.",
    );
  },
);

it.each(["install", "launch"] as const)("explains a scoped %s definition hold", (action) => {
  expect(
    portActionPresentation(
      withAssessment({
        action,
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "metadata_stale" },
      }),
      action,
    ),
  ).toEqual({
    blocked: true,
    reason: `${action === "install" ? "Setup" : "Launch"} is on hold. The catalog information needs refreshing.`,
  });
});

it("keeps an unoffered platform distinct from player game-file input", () => {
  expect(
    portActionPresentation(
      withAssessment({
        action: "install",
        availability: "not_offered",
        reason: "unsupported_platform",
      }),
      "install",
    ),
  ).toEqual({ blocked: true, reason: "This route is unavailable on this platform." });
});

it.each([
  {
    port_actions: [
      {
        action: "install",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "eligible" },
      },
    ],
  },
  {
    port_actions: [
      {
        action: "install",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "eligible", reason: "publisher_revoked" },
      },
    ],
  },
  {
    port_actions: [
      {
        action: "install",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "eligible", reason: "future" },
      },
    ],
  },
  { port_actions: null },
  { port_actions: {} },
  { port_actions: [null] },
  { port_actions: [{ action: "install", availability: "future", reason: "available" }] },
  { port_actions: [{ action: "install", availability: "allowed", reason: "future" }] },
  { port_actions: [{ action: "install", availability: "held", reason: "future" }] },
  { port_actions: [{ action: "launch", availability: "allowed", reason: "available" }] },
  {
    port_actions: [
      {
        action: "install",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  },
  {
    port_actions: [
      { action: "install", availability: "allowed", reason: "available" },
      { action: "install", availability: "allowed", reason: "available" },
    ],
  },
])("keeps malformed or incomplete current setup projections unavailable: %s", (partial) => {
  const status = { ...portStatus(), ...partial } as PortStatus;
  expect(portActionPresentation(status, "install")).toEqual({
    blocked: true,
    reason: "Current setup availability is unavailable. Refresh the workspace to check again.",
  });
});

it("accepts only the complete eligible definition tuple on an allowed assessment", () => {
  expect(
    portActionPresentation(
      withAssessment({
        action: "install",
        availability: "allowed",
        reason: "available",
        definition: { outcome: "eligible", reason: "mandatory_checks_passed" },
      }),
      "install",
    ),
  ).toEqual({ blocked: false });
});

const setupStatus = (
  install: Assessment,
  external: Assessment = {
    action: "register_external",
    availability: "not_offered",
    reason: "route_not_offered",
  },
): PortStatus => ({ ...portStatus(), port_actions: [install, external] });

it.each(["missing_source", "missing_bios"] as const)(
  "keeps %s input review distinct from setup eligibility",
  (reason) => {
    const status = setupStatus({ action: "install", availability: "waiting", reason });
    expect(portActionPresentation(status, "install")).toEqual({ blocked: false });
    const display = catalogSetupPresentation(status);
    expect(display.label).toBe("Setup needs review");
    expect(display.routes[0].reason).toContain("select and review");
    expect(display.routes[0].availability).toBe("waiting");
  },
);

it("keeps offered external review visible when managed installation is not offered", () => {
  const status = setupStatus(
    { action: "install", availability: "not_offered", reason: "route_not_offered" },
    {
      action: "register_external",
      availability: "waiting",
      reason: "review_required",
    },
  );
  expect(catalogSetupPresentation(status).label).toBe("Setup needs review");
  expect(catalogSetupPresentation(status).routes[1].reason).toContain(
    "External updates remain yours to manage",
  );
});

it("explains known definition holds without upgrading source mismatch to gameplay support", () => {
  const display = catalogSetupPresentation(
    setupStatus({
      action: "install",
      availability: "held",
      reason: "definition_ineligible",
      definition: { outcome: "hold", reason: "source_identity_mismatch" },
    }),
  );
  expect(display.label).toBe("Setup on hold");
  expect(display.routes[0].reason).toContain("do not match the required edition");
});

it("presents eligible setup without claiming installed readiness", () => {
  const display = catalogSetupPresentation(
    setupStatus({
      action: "install",
      availability: "allowed",
      reason: "available",
      definition: { outcome: "eligible", reason: "mandatory_checks_passed" },
    }),
  );
  expect(display.label).toBe("Setup available");
  expect(display.routes[0].reason).toContain("review installation");
});

it.each([
  undefined,
  null,
  {},
  [],
  [null],
  [{ action: "install", availability: "allowed", reason: "missing_source" }],
  [{ action: "install", availability: "future", reason: "available" }],
  [
    {
      action: "install",
      availability: "held",
      reason: "definition_ineligible",
      definition: { outcome: "eligible", reason: "mandatory_checks_passed" },
    },
  ],
  [
    {
      action: "install",
      availability: "held",
      reason: "definition_ineligible",
      definition: { outcome: "hold", reason: "future" },
    },
  ],
  [
    { action: "install", availability: "allowed", reason: "available" },
    { action: "install", availability: "waiting", reason: "missing_source" },
  ],
  [{ action: "register_external", availability: "allowed", reason: "available" }],
])(
  "preserves malformed/legacy/future/contradictory setup projection as unknown: %j",
  (port_actions) => {
    const status = { ...portStatus(), port_actions } as PortStatus;
    expect(catalogSetupPresentation(status).label).toBe("Setup status unknown");
  },
);

it("keeps both unavailable routes separate from unsupported gameplay", () => {
  const display = catalogSetupPresentation(
    setupStatus({ action: "install", availability: "not_offered", reason: "unsupported_platform" }),
  );
  expect(display.label).toBe("Setup unavailable");
  expect(display.routes[0].reason).toContain("on this platform");
});

const installedStatus = (
  blockers: NonNullable<PortStatus["readiness"]>["blockers"],
): PortStatus => ({
  ...portStatus(),
  active: { id: "installed" } as NonNullable<PortStatus["active"]>,
  readiness: { launchable: false, pending_setup: false, blockers },
});
it.each([
  ["missing_source", "Game files missing", "Required game files are missing"],
  ["changed_source", "Game files changed", "game files changed"],
  ["unreadable_source", "Game files unreadable", "cannot read the required game files"],
  ["missing_bios", "BIOS file missing", "BIOS file is missing"],
  ["changed_bios", "BIOS file changed", "BIOS file changed"],
  ["unreadable_bios", "BIOS file unreadable", "cannot read the required BIOS file"],
] as const)(
  "displays authoritative installed %s without changing operation presentation",
  (blocker, label, reason) => {
    const status = installedStatus([blocker]);
    const before = JSON.stringify(status);
    const operation = portActionPresentation(status, "launch");
    expect(installedCardInputPresentation(status)?.label).toBe(label);
    expect(installedCardInputPresentation(status)?.reasons[0]).toContain(reason);
    expect(installedCardInputPresentation(status)?.reasons[0]?.includes("restore access")).toBe(
      blocker.startsWith("unreadable"),
    );
    expect(portActionPresentation(status, "launch")).toEqual(operation);
    expect(JSON.stringify(status)).toBe(before);
  },
);
it("preserves all known compound input problems without manufacturing their completion", () => {
  const display = installedCardInputPresentation(
    installedStatus(["changed_source", "missing_bios"]),
  );
  expect(display?.label).toBe("Game files and BIOS need review");
  expect(display?.reasons).toHaveLength(2);
});
it("displays only the explicit launch edition mismatch, without attributing it to a BIOS", () => {
  const status = {
    ...installedStatus([]),
    port_actions: [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "source_identity_mismatch" },
      },
    ],
  } as PortStatus;
  expect(installedCardInputPresentation(status)?.label).toBe("Input edition mismatch");
  expect(installedCardInputPresentation(status)?.reasons[0]).toContain(
    "do not match the required edition",
  );
  expect(installedCardInputPresentation(status)?.label).not.toContain("BIOS");
});
it.each([
  undefined,
  portStatus(),
  { ...installedStatus([]), readiness: undefined },
  {
    ...installedStatus(["changed_source"]),
    readiness: { launchable: true, pending_setup: false, blockers: [] },
  },
  installedStatus(["invalid_installation", "changed_source"]),
  installedStatus(["future" as NonNullable<PortStatus["readiness"]>["blockers"][number]]),
  {
    ...installedStatus([]),
    readiness: { launchable: false, blockers: null, pending_setup: false },
  } as unknown as PortStatus,
])("keeps absent, unknown, Ready and installation-repair semantics: %j", (status) => {
  expect(installedCardInputPresentation(status)).toBeUndefined();
});
it.each(
  [
    [
      {
        action: "launch",
        availability: "allowed",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "source_identity_mismatch" },
      },
    ],
    [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "eligible", reason: "source_identity_mismatch" },
      },
    ],
    [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "future" },
      },
    ],
    [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "source_identity_mismatch" },
      },
      { action: "launch", availability: "allowed", reason: "available" },
    ],
  ].map((port_actions) => ({ port_actions })),
)(
  "does not invent an edition mismatch from contradictory/future action data: %j",
  ({ port_actions }) => {
    expect(
      installedCardInputPresentation({ ...installedStatus([]), port_actions } as PortStatus),
    ).toBeUndefined();
  },
);

it("ignores malformed input entries without coercing them into reason codes", () => {
  const status = {
    ...installedStatus([]),
    readiness: {
      launchable: false,
      pending_setup: false,
      blockers: [null, ["missing_source"], { toString: 42 }],
    },
  } as unknown as PortStatus;
  expect(installedCardInputPresentation(status)).toBeUndefined();
});
