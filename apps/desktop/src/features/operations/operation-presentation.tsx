import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PortStatus } from "../../types";
import type { Perform } from "./use-operation-state";
import { portActionPresentation } from "../port-actions/port-action-presentation";
import { pendingInvocationConflict, type InvocationRecord } from "./invocation-state";

type PresentationOwner = {
  generation: number;
  pending: ReadonlyMap<number, InvocationRecord>;
  unreadInstallPorts?: ReadonlySet<string> | undefined;
  unreadExternalPorts?: ReadonlySet<string> | undefined;
  unreadManagedRoutePorts?: ReadonlySet<string> | undefined;
  perform?: Perform | undefined;
};
const OperationPresentation = createContext<PresentationOwner | null>(null);
export function OperationPresentationProvider({
  generation,
  pending,
  unreadInstallPorts,
  unreadExternalPorts,
  unreadManagedRoutePorts,
  perform,
  children,
}: PresentationOwner & { children: ReactNode }) {
  const owner = useMemo(
    () => ({
      generation,
      pending,
      unreadInstallPorts,
      unreadExternalPorts,
      unreadManagedRoutePorts,
      perform,
    }),
    [
      generation,
      pending,
      unreadInstallPorts,
      unreadExternalPorts,
      unreadManagedRoutePorts,
      perform,
    ],
  );
  return <OperationPresentation value={owner}>{children}</OperationPresentation>;
}
export const useOperationPresentation = () => useContext(OperationPresentation);

/** Shared by covers/rows, details and Activity. Core remains execution authority. */
export function presentPortAction(
  owner: PresentationOwner | null,
  portId: string,
  status: PortStatus | undefined,
  action: "install" | "launch" | "rollback",
  fallbackBusy?: string,
) {
  const pending = owner
    ? pendingInvocationConflict(owner.pending, {
        action,
        target: { kind: "port", id: portId, label: portId },
        libraryGeneration: owner.generation,
        exclusionScope: "target",
        operation: action === "launch" ? "launch" : undefined,
      })
    : undefined;
  const awaitingExternalReadback = action === "launch" && owner?.unreadExternalPorts?.has(portId);
  const awaitingManagedReadback = owner?.unreadInstallPorts?.has(portId);
  const managedRouteReadbackRequired = Boolean(owner?.unreadManagedRoutePorts?.has(portId));
  const reason = pending
    ? `${pending.context.action} for ${pending.context.target.label} is still in progress.`
    : awaitingExternalReadback
      ? "Refresh the library to confirm the current external launch details."
      : action === "launch" && awaitingManagedReadback
        ? "Refresh the library to confirm the current installation."
        : undefined;
  return {
    readiness: portActionPresentation(status, action),
    assessment: portActionPresentation(status, action, reason),
    busy: owner ? (pending?.name ?? reason) : fallbackBusy,
    pending,
    managedRouteReadbackRequired,
    installReadbackRequired:
      action === "install" &&
      (managedRouteReadbackRequired ||
        Boolean(awaitingManagedReadback && !status?.active && !status?.external_runtime)),
  };
}
