import type { PortStatus } from "../../types";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { listingAvailabilityLabel } from "../browsing/catalog-entry";
import {
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
      ? catalogSetupPresentation(status)
      : undefined;
  return { input, state, setup };
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
    return { label: "Setup required", action: "Finish setup", tone: "setup" } as const;
  if (
    (status?.active || status?.external_runtime) &&
    portActionPresentation(status, "launch").blocked
  )
    return { label: "Launch needs review", action: "View details", tone: "setup" } as const;
  if ((readiness === "ready" || readiness === "staged") && hasUnconfirmedLaunchInput(status, port))
    return { label: "Compatibility unconfirmed", action: "View details", tone: "setup" } as const;
  if (view === "catalog" && !status?.active && !status?.external_runtime)
    return {
      label: catalogSetupPresentation(status).label,
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
    source: { label: "Game files needed", action: "Finish setup", tone: "setup" },
    repair: {
      label: "Installation needs repair",
      action: "Review game",
      tone: "setup",
    },
    runtime: {
      label: "Runtime required",
      action: "Finish setup",
      tone: "setup",
    },
    bios: { label: "BIOS required", action: "Finish setup", tone: "setup" },
    setup: { label: "Setup required", action: "Finish setup", tone: "setup" },
    staged: { label: "Ready to play", action: "View details", tone: "ready" },
    unknown: {
      label: "Readiness unavailable",
      action: "Review game",
      tone: "setup",
    },
    blocked: {
      label: "Launch unavailable",
      action: "Review game",
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
