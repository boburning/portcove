import { fixtureValue } from "../../test-fixtures";
import { expect, it } from "vite-plus/test";
import { portStatus } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import {
  catalogSetupPresentation,
  installedCardInputPresentation,
  hasPendingSetupAction,
  definitionHoldReason,
  portActionPresentation,
  removalReviewPresentation,
} from "./port-action-presentation";

type Assessment = NonNullable<PortStatus["port_actions"]>[number];
it("recognizes only an explicit sole setup hold and preserves unknown or stronger holds", () => {
  const launch: Assessment = {
    action: "launch",
    availability: "waiting",
    reason: "preparation_required",
    definition: null,
  };
  const status: PortStatus = {
    ...portStatus(),
    readiness: { launchable: false, pending_setup: true, blockers: ["preparation_required"] },
    port_actions: [launch],
  };
  expect(hasPendingSetupAction(status)).toBe(true);
  expect(hasPendingSetupAction({ ...status, port_actions: [] })).toBe(true);
  expect(hasPendingSetupAction({ ...status, port_actions: [launch, launch] })).toBe(false);
  expect(
    hasPendingSetupAction({
      ...status,
      readiness: {
        ...status.readiness!,
        blockers: ["preparation_required", "invalid_installation"],
      },
    }),
  ).toBe(false);
  expect(
    hasPendingSetupAction({
      ...status,
      readiness: { ...status.readiness, launchable: undefined },
    } as never),
  ).toBe(false);
});
const withAssessment = (assessment: Assessment): PortStatus => ({
  ...portStatus(),
  port_actions: [assessment],
});

it.each(["remove_managed", "remove_external"] as const)(
  "requires a unique consistent current %s review assessment",
  (action) => {
    const ready = { action, availability: "waiting", reason: "review_required" } as const;
    expect(removalReviewPresentation(withAssessment(ready), action).blocked).toBe(false);
    expect(removalReviewPresentation(undefined, action).blocked).toBe(true);
    for (const actions of [
      null,
      [ready, ready],
      [{ action: "launch", availability: "allowed", reason: "available" }],
      [{ ...ready, availability: "future" }],
      [{ ...ready, reason: "available" }],
      [{ ...ready, availability: "allowed", reason: "available" }],
      [{ ...ready, definition: { outcome: "hold", reason: "publisher_revoked" } }],
    ])
      expect(
        removalReviewPresentation({ ...portStatus(), port_actions: actions as never }, action)
          .blocked,
      ).toBe(true);
    for (const actions of [undefined, []])
      expect(
        removalReviewPresentation({ ...portStatus(), port_actions: actions as never }, action)
          .blocked,
      ).toBe(false);
    expect(
      removalReviewPresentation(
        withAssessment({ action, availability: "not_offered", reason: "not_installed" }),
        action,
      ).blocked,
    ).toBe(true);
  },
);

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
    expect(fixtureValue(display.routes[0], "display.routes[0]").reason).toContain(
      "select and review",
    );
    expect(fixtureValue(display.routes[0], "display.routes[0]").availability).toBe("waiting");
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
  expect(
    fixtureValue(
      catalogSetupPresentation(status).routes[1],
      "catalogSetupPresentation(status).routes[1]",
    ).reason,
  ).toContain("External updates remain yours to manage");
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
  expect(fixtureValue(display.routes[0], "display.routes[0]").reason).toContain(
    "do not match the required edition",
  );
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
  expect(fixtureValue(display.routes[0], "display.routes[0]").reason).toContain(
    "review installation",
  );
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
  expect(fixtureValue(display.routes[0], "display.routes[0]").reason).toContain("on this platform");
});

const installedStatus = (
  blockers: NonNullable<PortStatus["readiness"]>["blockers"],
): PortStatus => ({
  ...portStatus(),
  active: { id: "installed" } as NonNullable<PortStatus["active"]>,
  readiness: { launchable: false, pending_setup: false, blockers },
});

const incompatibleStatus = (extension: unknown): PortStatus =>
  ({
    ...installedStatus(["incompatible_source"]),
    readiness: {
      launchable: false,
      pending_setup: false,
      source: "current",
      blockers: ["incompatible_source"],
      required_source_extension: extension,
    },
    port_actions: [{ action: "launch", availability: "waiting", reason: "incompatible_source" }],
  }) as PortStatus;

it("explains the retained runtime's required format in details and installed cards without rejecting source identity", () => {
  const status = incompatibleStatus("z64");
  const original = JSON.stringify(status);
  const action = portActionPresentation(status, "launch");
  expect(action.blocked).toBe(true);
  expect(action.reason).toBe(
    "This runtime requires an uncompressed .z64 game file. Select and validate that file before playing.",
  );
  expect(installedCardInputPresentation(status)).toEqual({
    label: "Game-file format needs review",
    reasons: [action.reason],
  });
  expect(status.readiness?.source).toBe("current");
  expect(JSON.stringify(status)).toBe(original);
});

it.each([
  undefined,
  null,
  "",
  ".z64",
  "../z64",
  "z64\n",
  "z64\u202e",
  "\u212a",
  "a".repeat(17),
  {},
  7,
])(
  "keeps a format hold actionable without reflecting malformed or unavailable extension %j",
  (extension) => {
    const status = incompatibleStatus(extension);
    const action = portActionPresentation(status, "launch");
    expect(action.blocked).toBe(true);
    expect(action.reason).toBe(
      "The selected game-file format cannot be used by this runtime. Select and validate the required format before playing.",
    );
    expect(installedCardInputPresentation(status)?.reasons).toEqual([action.reason]);
  },
);

it("does not infer a format hold from an extension alone or replace a known installation failure", () => {
  const status = incompatibleStatus("z64");
  status.readiness!.blockers = ["invalid_installation", "incompatible_source"];
  expect(installedCardInputPresentation(status)).toBeUndefined();
  status.readiness = {
    launchable: true,
    pending_setup: false,
    blockers: [],
    required_source_extension: "z64",
  };
  status.port_actions = [{ action: "launch", availability: "allowed", reason: "available" }];
  expect(installedCardInputPresentation(status)).toBeUndefined();
  expect(portActionPresentation(status, "launch")).toEqual({ blocked: false });
});

it("keeps BIOS and changed-source problems separate when current readback replaces a format hold", () => {
  const status = incompatibleStatus("z64");
  status.readiness!.blockers.push("missing_bios");
  const compound = installedCardInputPresentation(status);
  expect(compound?.reasons).toEqual([
    "A required BIOS file is missing. View details to select and review the required files.",
    "This runtime requires an uncompressed .z64 game file. Select and validate that file before playing.",
  ]);
  status.readiness!.blockers = ["changed_source"];
  status.readiness!.source = "changed";
  status.port_actions = [{ action: "launch", availability: "waiting", reason: "changed_source" }];
  const current = installedCardInputPresentation(status);
  expect(current?.label).toBe("Game files changed");
  expect(current?.reasons.join(" ")).not.toContain(".z64");
  expect(portActionPresentation(status, "launch").reason).toContain("game files changed");
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
  (() => {
    const status = installedStatus([]);
    delete status.readiness;
    return status;
  })(),
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
