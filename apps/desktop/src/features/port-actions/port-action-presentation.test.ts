import { expect, it } from "vitest";
import { portStatus } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import { definitionHoldReason, portActionPresentation } from "./port-action-presentation";

type Assessment = NonNullable<PortStatus["port_actions"]>[number];
const withAssessment = (assessment: Assessment): PortStatus => ({
  ...portStatus(),
  port_actions: [assessment],
});

it.each([undefined, { ...portStatus(), port_actions: [] }, portStatus()])(
  "preserves legacy readiness behavior when action projections are absent: %s",
  (status) => {
    expect(portActionPresentation(status, "install")).toEqual({ blocked: false });
    expect(portActionPresentation(status, "launch")).toEqual({ blocked: false });
  },
);

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
