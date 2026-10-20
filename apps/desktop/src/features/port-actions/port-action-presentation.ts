import type { PortStatus } from "../../types";

type PresentedAction = "install" | "launch" | "rollback";
type ActionPresentation = { blocked: false; reason?: never } | { blocked: true; reason: string };
type Assessment = NonNullable<PortStatus["port_actions"]>[number];

/** Opens a fresh removal review only; Core still binds ownership and consent. */
export function removalReviewPresentation(
  status: PortStatus | undefined,
  action: "remove_managed" | "remove_external",
): ActionPresentation {
  const unknown: ActionPresentation = {
    blocked: true,
    reason: "Current removal availability is unavailable. Refresh the workspace to check again.",
  };
  if (!status) return unknown;
  const assessments = status.port_actions;
  // Supported older statuses omitted the entire projection or supplied an empty list.
  if (assessments === undefined || (Array.isArray(assessments) && assessments.length === 0))
    return { blocked: false };
  if (!Array.isArray(assessments)) return unknown;
  const matches = assessments.filter((assessment) => assessment?.action === action);
  const [assessment] = matches;
  if (matches.length !== 1 || !assessment || assessment.definition != null) return unknown;
  if (assessment.availability === "waiting" && assessment.reason === "review_required")
    return { blocked: false };
  if (assessment.availability === "not_offered" && assessment.reason === "not_installed")
    return {
      blocked: true,
      reason:
        action === "remove_external"
          ? "There is no saved external installation to remove."
          : "There is no managed installation to uninstall.",
    };
  return unknown;
}

const definitionReasons: Record<string, string> = {
  publisher_revoked: "The catalog publisher was revoked.",
  curated_artifact_revoked:
    "This exact release file was revoked. Your files and saves are retained.",
  curated_distribution_withdrawn:
    "Distribution of this release file was withdrawn. Permitted installed use remains available.",
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

const incompatibleSourceFallback =
  "The selected game-file format cannot be used by this runtime. Select and validate the required format before playing.";

const actionReasons: Record<string, string> = {
  route_not_offered: "This route is unavailable. Check the port details for current requirements.",
  already_registered: "This installation is already in your library.",
  unsupported_platform: "This route is unavailable on this platform.",
  not_installed: "Choose an installation before playing.",
  review_required: "Review the current requirements before continuing.",
  missing_source: "Required game files are missing.",
  unreadable_source: "Portcove cannot read the required game files.",
  changed_source: "The required game files changed. Review them before playing.",
  incompatible_source: incompatibleSourceFallback,
  missing_bios: "A required BIOS file is missing.",
  unreadable_bios: "Portcove cannot read the required BIOS file.",
  changed_bios: "The required BIOS file changed. Review it before playing.",
  incompatible_bios:
    "This BIOS edition is not supported by the installed version. Choose a supported BIOS file.",
  missing_runtime: "A required runtime component is missing.",
  preparation_required: "Prepare game data before playing.",
  shared_preferences_review_required:
    "Windows account or shared preferences location changed. Remove the managed installation while keeping saves and settings, then review a fresh installation. Leave the shared preferences file in place.",
  shared_preferences_unavailable:
    "Portcove cannot safely check this game's shared preferences. Leave the file unchanged, close other copies of the game, check that your Windows profile is available, then refresh. Reinstalling does not fix an unsafe or unreadable shared location.",
  invalid_installation: "Portcove could not verify the installed files.",
};

function sourceFormatReason(status: PortStatus | undefined): string {
  if (status?.readiness?.source_assessment?.contract.state === "recognized_not_listed")
    return "This game edition is not supported by the installed version. Select and check a supported edition before playing.";
  if (status?.readiness?.source_assessment?.admission.state === "rejected")
    return "The registered game files failed their checks. Choose replacement files and check them again.";
  const extension = status?.readiness?.required_source_extension;
  return typeof extension === "string" &&
    extension.length > 0 &&
    extension.length <= 16 &&
    !/[^a-zA-Z0-9]/u.test(extension)
    ? `This runtime requires an uncompressed .${extension} game file. Select and validate that file before playing.`
    : incompatibleSourceFallback;
}

function unavailable(action: PresentedAction): ActionPresentation {
  return {
    blocked: true,
    reason: `Current ${action === "install" ? "setup" : action} availability is unavailable. Refresh the workspace to check again.`,
  };
}

function presentRollbackAssessment(assessment: Assessment): ActionPresentation {
  const { availability, reason, definition } = assessment;
  if (
    availability === "held" &&
    reason === "definition_ineligible" &&
    definition?.outcome === "hold" &&
    definition.reason === "curated_artifact_revoked"
  ) {
    return {
      blocked: true,
      reason: `Restore previous version is on hold. ${definitionReasons.curated_artifact_revoked}`,
    };
  }
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
  status: PortStatus | undefined,
): ActionPresentation {
  const { availability, reason, definition } = assessment;
  if (assessmentAllowsInputReview(assessment, action)) return { blocked: false };
  if (!["waiting", "held", "not_offered"].includes(availability)) return unavailable(action);
  if (reason === "definition_ineligible")
    return {
      blocked: true,
      reason: definitionHoldReason(action === "install" ? "Setup" : "Launch", definition?.reason),
    };
  if (action === "launch" && reason === "incompatible_source" && definition == null)
    return { blocked: true, reason: sourceFormatReason(status) };
  const explanation = Object.hasOwn(actionReasons, reason) ? actionReasons[reason] : undefined;
  if (explanation !== undefined) return { blocked: true, reason: explanation };
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
  const [assessment] = matching;
  if (matching.length !== 1 || !assessment) return unavailable(action);
  return action === "rollback"
    ? presentRollbackAssessment(assessment)
    : presentAssessment(assessment, action, status);
}

type SetupRoute = "install" | "register_external";
type SetupRoutePresentation = {
  action: SetupRoute;
  route: string;
  availability: Assessment["availability"] | "unknown";
  reason: string;
};

/** Cached setup facts only; neither input review nor this display grants execution authority. */
export function catalogSetupPresentation(status: PortStatus | undefined) {
  const routes = (["install", "register_external"] as const).map((action) => {
    const route = action === "install" ? "Managed setup" : "External setup";
    const unknown: SetupRoutePresentation = {
      action,
      route,
      availability: "unknown",
      reason: "Setup status unknown. View details for current requirements.",
    };
    const assessments = status?.port_actions;
    if (!Array.isArray(assessments)) return unknown;
    const matches = assessments.filter((assessment) => assessment?.action === action);
    const [assessment] = matches;
    if (matches.length !== 1 || !assessment) return unknown;
    const { availability, reason, definition } = assessment;
    const definitionDisposition = () => {
      if (availability === "held" && reason === "definition_ineligible") {
        if (
          !definition ||
          !["hold", "escalate"].includes(definition.outcome) ||
          !Object.hasOwn(definitionReasons, definition.reason)
        )
          return unknown;
        return {
          action,
          route,
          availability,
          reason: definitionHoldReason("Setup", definition.reason),
        };
      }
      if (
        definition != null &&
        !(
          availability === "allowed" &&
          definition.outcome === "eligible" &&
          definition.reason === "mandatory_checks_passed"
        )
      )
        return unknown;
      return undefined;
    };
    const reviewedDefinition = definitionDisposition();
    if (reviewedDefinition) return reviewedDefinition;
    if (action === "install" && availability === "allowed" && reason === "available")
      return {
        action,
        route,
        availability,
        reason: "Current setup checks passed. View details to review installation.",
      };
    if (definition != null) return unknown;
    if (
      action === "install" &&
      availability === "waiting" &&
      ["missing_source", "missing_bios"].includes(reason)
    )
      return {
        action,
        route,
        availability,
        reason: `${actionReasons[reason]} View details to select and review the required files.`,
      };
    if (
      action === "register_external" &&
      availability === "waiting" &&
      reason === "review_required"
    )
      return {
        action,
        route,
        availability,
        reason:
          "Review preparation requirements and your external game folder in details. External updates remain yours to manage.",
      };
    if (
      availability === "not_offered" &&
      ["route_not_offered", "unsupported_platform", "already_registered"].includes(reason)
    )
      return { action, route, availability, reason: actionReasons[reason] };
    return unknown;
  });
  // An offered route remains visible even when the other route is not offered or unknown.
  const label = routes.some((route) => route.availability === "allowed")
    ? "Setup available"
    : routes.some((route) => route.availability === "waiting")
      ? "Setup needs review"
      : routes.some((route) => route.availability === "unknown")
        ? "Setup status unknown"
        : routes.some((route) => route.availability === "held")
          ? "Setup on hold"
          : "Setup unavailable";
  return { label, routes };
}

const installedInputLabels = {
  missing_source: "Game files missing",
  changed_source: "Game files changed",
  unreadable_source: "Game files unreadable",
  missing_bios: "BIOS file missing",
  changed_bios: "BIOS file changed",
  incompatible_bios: "BIOS edition unsupported",
  unreadable_bios: "BIOS file unreadable",
};

/** Display cached input problems; keep admission and operation availability with their existing owners. */
export function installedCardInputPresentation(status: PortStatus | undefined) {
  const readiness = status?.readiness;
  if (
    !(status?.active || status?.external_runtime) ||
    readiness?.launchable !== false ||
    !Array.isArray(readiness.blockers) ||
    readiness.blockers.includes("invalid_installation")
  )
    return undefined;
  const inputs = [...new Set(readiness.blockers)].filter(
    (reason): reason is keyof typeof installedInputLabels =>
      typeof reason === "string" && Object.hasOwn(installedInputLabels, reason),
  );
  const reasons = inputs.map((reason) => {
    const recovery = reason.startsWith("unreadable_")
      ? "View details to restore access or choose the required files again."
      : "View details to select and review the required files.";
    return `${actionReasons[reason]} ${recovery}`;
  });
  const incompatible = readiness.blockers.includes("incompatible_source");
  if (incompatible) reasons.push(sourceFormatReason(status));
  const assessments = status.port_actions;
  const launch = Array.isArray(assessments)
    ? assessments.filter((assessment) => assessment?.action === "launch")
    : [];
  const [launchAssessment] = launch;
  const mismatch =
    launch.length === 1 &&
    launchAssessment?.availability === "held" &&
    launchAssessment.reason === "definition_ineligible" &&
    ["hold", "escalate"].includes(launchAssessment.definition?.outcome ?? "") &&
    launchAssessment.definition?.reason === "source_identity_mismatch";
  if (mismatch)
    reasons.push(
      `${definitionHoldReason("Launch", "source_identity_mismatch")} View details to review the input requirements.`,
    );
  if (reasons.length === 0) return undefined;
  const game = inputs.some((reason) => reason.endsWith("_source"));
  const bios = inputs.some((reason) => reason.endsWith("_bios"));
  const [singleInput] = inputs;
  const label = mismatch
    ? "Input edition mismatch"
    : incompatible
      ? "Game-file format needs review"
      : inputs.length === 1 && singleInput !== undefined
        ? installedInputLabels[singleInput]
        : game && bios
          ? "Game files and BIOS need review"
          : bios
            ? "BIOS file needs review"
            : "Game files need review";
  return { label, reasons };
}

function assessmentAllowsInputReview(
  assessment: Assessment,
  action: Exclude<PresentedAction, "rollback">,
) {
  const { availability, reason, definition } = assessment;
  if (
    availability === "allowed" &&
    reason === "available" &&
    (definition == null ||
      (definition.outcome === "eligible" && definition.reason === "mandatory_checks_passed"))
  )
    return true;
  // A newly selected source/BIOS path still needs the existing installation review.
  if (
    action === "install" &&
    availability === "waiting" &&
    (reason === "missing_source" || reason === "missing_bios") &&
    definition == null
  )
    return true;
  return false;
}
