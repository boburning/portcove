import { createContext, useContext, type ReactNode } from "react";
import type { PortStatus } from "../../types";
import { portActionPresentation } from "../port-actions/port-action-presentation";
import { pendingInvocationConflict, type InvocationRecord } from "./invocation-state";

type PresentationOwner = { generation: number; pending: ReadonlyMap<number, InvocationRecord> };
const OperationPresentation = createContext<PresentationOwner | null>(null);
export function OperationPresentationProvider({
  generation,
  pending,
  children,
}: PresentationOwner & { children: ReactNode }) {
  return <OperationPresentation value={{ generation, pending }}>{children}</OperationPresentation>;
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
  const reason = pending
    ? `${pending.context.action} for ${pending.context.target.label} is still in progress.`
    : undefined;
  return {
    readiness: portActionPresentation(status, action),
    assessment: portActionPresentation(status, action, reason),
    busy: owner ? pending?.name : fallbackBusy,
    pending,
  };
}
