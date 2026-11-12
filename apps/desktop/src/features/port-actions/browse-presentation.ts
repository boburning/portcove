import { canonicalIdentityId, identityLabel } from "../identity/identity-style";
import { gameUpdateAcquisitionLabel } from "../port-updates/acquisition-presentation";
import type { PortStatus, PortDefinition } from "../../types";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { listingAvailabilityLabel } from "../browsing/catalog-entry";
import { setupRoutePresentation } from "./setup-route-presentation";
import {
  SOURCE_BLOCKERS,
  BIOS_BLOCKERS,
  hasUnconfirmedLaunchInput,
  portReadiness,
  type PortReadiness,
  type View,
} from "../../view-model";
import {
  catalogSetupPresentation,
  hasPendingSetupAction,
  installedCardInputPresentation,
  portActionPresentation,
  concurrentReadinessReasons,
} from "./port-action-presentation";

/** Shared cached observations only; no setup, launch or installation authority. */
export function browsePortPresentation(
  port: CatalogEntry,
  status: PortStatus | undefined,
  view: View,
  readiness = portReadiness(status),
) {
  const input = installedCardInputPresentation(status);
  const observed = readinessPresentation(readiness, view, status, port);
  const state = input ? { ...observed, label: input.label } : observed;
  const setup =
    view === "catalog" &&
    !status?.active &&
    !status?.external_runtime &&
    !port.pendingSetup &&
    Boolean(port.release)
      ? setupRoutePresentation(port, status)
      : undefined;
  return { input, state, setup, concurrentBlockers: concurrentReadinessReasons(status) };
}

export function readinessPresentation(
  readiness: PortReadiness,
  view: View,
  status?: PortStatus,
  port?: CatalogEntry,
) {
  const setup = pendingSetupPresentation(port, status);
  if (setup) return setup;
  if (readiness === "setup" && hasPendingSetupAction(status))
    return { label: "Setup needed", action: "Finish setup", tone: "setup" } as const;
  if (
    (status?.active || status?.external_runtime) &&
    portActionPresentation(status, "launch").blocked
  )
    return { label: "Launch needs review", action: "View details", tone: "setup" } as const;
  if ((readiness === "ready" || readiness === "staged") && hasUnconfirmedLaunchInput(status, port))
    return { label: "Compatibility unconfirmed", action: "View details", tone: "setup" } as const;
  if (view === "catalog" && !status?.active && !status?.external_runtime)
    return {
      label: port
        ? setupRoutePresentation(port, status).label
        : catalogSetupPresentation(status).label,
      action: "View details",
      tone: "available",
    } as const;
  const values = {
    available: {
      label: "Available",
      action: "View details",
      tone: "available",
    },
    ready: { label: "Ready to play", action: "View details", tone: "ready" },
    source: { label: "Needs game files", action: "Finish setup", tone: "setup" },
    repair: {
      label: "Installation needs repair",
      action: "View details",
      tone: "setup",
    },
    runtime: {
      label: "Runtime required",
      action: "Finish setup",
      tone: "setup",
    },
    bios: { label: "BIOS required", action: "Finish setup", tone: "setup" },
    setup: { label: "Setup needed", action: "Finish setup", tone: "setup" },
    staged: { label: "Ready to play", action: "View details", tone: "ready" },
    unknown: {
      label: "Can't check right now",
      action: "View details",
      tone: "setup",
    },
    blocked: {
      label: "Launch unavailable",
      action: "View details",
      tone: "setup",
    },
  } as const;
  return values[readiness];
}

export function cardInstallationLabel(port: CatalogEntry, status: PortStatus | undefined) {
  if (port.pendingSetup?.state === "attention-required") return "Review download";
  if (port.pendingSetup) return "Continue setup";
  if (!port.release && !status?.external_runtime) return "Setup from upstream";
  return !status
    ? "Installation status unknown"
    : status.active
      ? `Installed ${status.active.version}`
      : status?.external_runtime
        ? `External installation ${status.external_runtime.version}`
        : port.release?.provider === "user-prepared"
          ? "Prepare game"
          : "Not installed";
}

function pendingSetupPresentation(port: CatalogEntry | undefined, status: PortStatus | undefined) {
  if (port?.pendingSetup?.state === "attention-required")
    return { label: "Download needs attention", action: "Review download", tone: "setup" } as const;
  if (port?.pendingSetup)
    return { label: "Downloaded · setup needed", action: "Continue setup", tone: "setup" } as const;
  if (port?.listing && !port.release && !status?.external_runtime)
    return {
      label: listingAvailabilityLabel(port.listing),
      action: "View setup options",
      tone: "available",
    } as const;
}

/** Visual precedence only; does not grant launch or update eligibility. */
export function browseStatusSummary(
  state: { tone: string },
  status: PortStatus | undefined,
  updateAvailable: boolean,
) {
  const update = status?.acquisition
    ? gameUpdateAcquisitionLabel(status.acquisition.phase)
    : status?.staged
      ? "Update saved for later"
      : updateAvailable
        ? "Update available at last check"
        : undefined;
  return { showReadiness: state.tone !== "ready" || !update, update };
}

/** File-state copy only. Paths and review-eligibility booleans cannot prove connected inputs. */
export function gameFilesPresentation(
  port: Pick<
    PortDefinition,
    "source_profile" | "bios_source_profile" | "presentation" | "optional_game_source"
  >,
  status: PortStatus | undefined,
) {
  const readiness = status?.readiness;
  const sourceBlocked = readiness?.blockers.some((blocker) => SOURCE_BLOCKERS.includes(blocker));
  const biosBlocked = readiness?.blockers.some((blocker) => BIOS_BLOCKERS.includes(blocker));
  // An optional source that is not registered is simply absent: it neither requires nor
  // needs checking. A registered one, even if changed or unreadable, is judged as usual.
  const optionalSourceAbsent =
    Boolean(port.optional_game_source) &&
    !sourceBlocked &&
    (readiness?.source == null || readiness.source === "unregistered");
  const sourceRequired = Boolean(
    sourceBlocked ||
    (port.source_profile && !port.optional_game_source) ||
    readiness?.required_source_extension ||
    (!optionalSourceAbsent && (readiness?.source_assessment || readiness?.source)),
  );
  const biosRequired = Boolean(
    biosBlocked || port.bios_source_profile || readiness?.bios_assessment || readiness?.bios,
  );
  const assessments = [
    ...(sourceRequired ? [readiness?.source_assessment] : []),
    ...(biosRequired ? [readiness?.bios_assessment] : []),
  ];
  if (
    readiness?.blockers.some(
      (blocker) => blocker === "missing_source" || blocker === "missing_bios",
    )
  )
    return {
      title: "Setup needed",
      description: missingInputDescription(port, readiness.blockers),
    };
  if (readiness?.pending_setup)
    return {
      title: "Setup needed",
      description:
        "The current installation still needs its recorded setup step. Review the inputs and changes before continuing.",
    };
  if (
    sourceBlocked ||
    biosBlocked ||
    [optionalSourceAbsent ? null : readiness?.source, readiness?.bios].some(
      (value) => value != null && value !== "current",
    )
  )
    return {
      title: "Files need checking",
      description:
        "The current input check is missing, changed or unavailable. Review the recorded checks before continuing.",
    };
  if (
    assessments.length &&
    assessments.every(
      (value) =>
        value?.health === "current" &&
        value.admission.state === "admitted" &&
        value.contract.state === "supported",
    )
  )
    return {
      title: "Files connected",
      description:
        "Recorded input checks are current for this installation’s supported file contract.",
    };
  if (port.optional_game_source && !sourceRequired && !biosRequired)
    return {
      title: "Game files are optional",
      description:
        "You can choose a disc image for Portcove to prepare, or keep using your own files. Play does not need one.",
    };
  if (!sourceRequired && !biosRequired && port.presentation?.source_requirements?.length === 0)
    return {
      title: "No files to add in Portcove",
      description:
        "This route has no file inputs to add here. The game or upstream setup may still require original files; follow its project instructions.",
    };
  if (sourceRequired || biosRequired)
    return {
      title: "Files need checking",
      description:
        "Selected paths and saved locations are inputs for review. Current file compatibility has not been established by this summary.",
    };
  return {
    title: "Requirements not available",
    description:
      "No current file assessment is available here. Check the project instructions and recorded input details.",
  };
}

/** Names what the player owns, not the requirement's role; unknown titles stay generic. */
function missingInputDescription(
  port: Pick<PortDefinition, "presentation">,
  blockers: readonly string[],
) {
  const title = port.presentation?.original_game_title?.trim();
  const systems = [
    ...new Set(
      (port.presentation?.original_game?.source_editions ?? [])
        .map((edition) => edition.system)
        .filter((system): system is string => Boolean(system))
        .map((system) => identityLabel(canonicalIdentityId(system))),
    ),
  ];
  if (title && blockers.includes("missing_source") && !blockers.includes("missing_bios"))
    return `You need your own copy of ${title}${systems.length === 1 ? ` (${systems[0]})` : ""}. Portcove checks that it's a supported version and never changes it.`;
  return "Choose your own copy of the game files or BIOS this port needs, then finish setup. Portcove never changes them.";
}
