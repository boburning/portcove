import type { PortStatus } from "../../types";

type PresentedAction = "install" | "launch" | "rollback";
type ActionPresentation = { blocked: false; reason?: never } | { blocked: true; reason: string };
type Assessment = NonNullable<PortStatus["port_actions"]>[number];

const definitionReasons: Record<string, string> = {
  publisher_revoked: "The catalog publisher was revoked.",
  unknown_safety_semantics: "This definition has safety requirements Portcove cannot interpret.",
  publisher_scope_required: "This publisher is not approved for this port.",
  engine_capability_required: "This version of Portcove cannot use this route.",
  ownership_migration_required: "An existing installation needs ownership review.",
  metadata_replay: "The catalog update is older than the accepted version.",
  refresh_incomplete: "The catalog update did not finish.",
  metadata_stale: "The catalog information needs refreshing.",
  recorded_identity_changed: "The accepted file identity changed.",
  authenticated_integrity_required: "The required file integrity evidence is missing.",
  local_integrity_failed: "A required local file check failed.",
  mandatory_check_failed: "A required check failed.",
  source_identity_mismatch: "The game files do not match the required edition.",
  required_source_missing: "Required game files are missing.",
};

export function definitionHoldReason(context: "Setup" | "Launch", reason?: string) {
  const explanation =
    reason && Object.hasOwn(definitionReasons, reason)
      ? definitionReasons[reason]
      : "Check this port's current requirements.";
  return `${context} is on hold. ${explanation}`;
}

const actionReasons: Record<string, string> = {
  route_not_offered: "This route is unavailable. Check the port details for current requirements.",
  already_registered: "This installation is already in your library.",
  unsupported_platform: "This route is unavailable on this platform.",
  not_installed: "Choose an installation before playing.",
  review_required: "Review the current requirements before continuing.",
  missing_source: "Required game files are missing.",
  unreadable_source: "Portcove cannot read the required game files.",
  changed_source: "The required game files changed. Review them before playing.",
  missing_bios: "A required BIOS file is missing.",
  unreadable_bios: "Portcove cannot read the required BIOS file.",
  changed_bios: "The required BIOS file changed. Review it before playing.",
  missing_runtime: "A required runtime component is missing.",
  preparation_required: "Prepare game data before playing.",
  invalid_installation: "Portcove could not verify the installed files.",
};

function unavailable(action: PresentedAction): ActionPresentation {
  return {
    blocked: true,
    reason: `Current ${action === "install" ? "setup" : action} availability is unavailable. Refresh the workspace to check again.`,
  };
}

function presentRollbackAssessment(assessment: Assessment): ActionPresentation {
  const { availability, reason, definition } = assessment;
  if (definition != null) return unavailable("rollback");
  if (availability === "allowed" && reason === "available") return { blocked: false };
  if (availability === "not_offered" && reason === "not_installed")
    return { blocked: true, reason: "No previous managed version is retained for rollback." };
  if (availability === "not_offered" && reason === "route_not_offered")
    return {
      blocked: true,
      reason:
        "Restore previous version is unavailable because this port is no longer in the current catalog.",
    };
  if (availability === "held" && reason === "missing_runtime")
    return {
      blocked: true,
      reason: "The previous version needs its verified runtime before it can be restored.",
    };
  if (availability === "held" && reason === "invalid_installation")
    return {
      blocked: true,
      reason:
        "Portcove could not verify the previous version. Restore previous version is on hold.",
    };
  return unavailable("rollback");
}

function presentAssessment(
  assessment: Assessment,
  action: Exclude<PresentedAction, "rollback">,
): ActionPresentation {
  const { availability, reason, definition } = assessment;
  if (
    availability === "allowed" &&
    reason === "available" &&
    (definition == null ||
      (definition.outcome === "eligible" && definition.reason === "mandatory_checks_passed"))
  )
    return { blocked: false };
  // A newly selected source/BIOS path still needs the existing installation review.
  if (
    action === "install" &&
    availability === "waiting" &&
    (reason === "missing_source" || reason === "missing_bios") &&
    definition == null
  )
    return { blocked: false };
  if (!["waiting", "held", "not_offered"].includes(availability)) return unavailable(action);
  if (reason === "definition_ineligible")
    return {
      blocked: true,
      reason: definitionHoldReason(action === "install" ? "Setup" : "Launch", definition?.reason),
    };
  if (Object.hasOwn(actionReasons, reason)) return { blocked: true, reason: actionReasons[reason] };
  return unavailable(action);
}

/** Presentation only: an allowed snapshot never supplies execution authority. */
export function portActionPresentation(
  status: PortStatus | undefined,
  action: PresentedAction,
): ActionPresentation {
  const assessments = status?.port_actions;
  // Earlier status contracts omitted this projection or serialized an empty list.
  if (assessments === undefined || (Array.isArray(assessments) && assessments.length === 0))
    return action === "rollback" ? unavailable(action) : { blocked: false };
  if (!Array.isArray(assessments)) return unavailable(action);
  const matching = assessments.filter((assessment) => assessment?.action === action);
  if (matching.length !== 1) return unavailable(action);
  return action === "rollback"
    ? presentRollbackAssessment(matching[0])
    : presentAssessment(matching[0], action);
}
