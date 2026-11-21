import type { ExternalRuntimeRecord, InstallRecord, PortStatus } from "../../types";

/** Presentation identities only. None grants a Core lock or execution authority. */
export type InvocationContext = {
  action: string;
  target: { kind: "port" | "source" | "library" | "application"; id: string; label: string };
  libraryGeneration: number;
  exclusionScope: "target" | "library" | "application";
  /** Permanently bounded API contracts; event phase strings never grant compatibility. */
  operation?: "acquire_game_update" | "launch" | "register_external" | undefined;
  /** Only an identity supplied by an owned API/record, never inferred from events. */
  activityId?: string;
};

export type InvocationRecord = {
  id: number;
  name: string;
  context: InvocationContext;
  phase: "pending" | "settled";
  outcome?: "succeeded" | "failed" | "cancelled";
  failure?: unknown;
  refreshFailure?: unknown;
  installed?: Pick<InstallRecord, "id" | "port_id" | "version">;
  externalRegistration?: ExternalRuntimeRecord;
};

function matchesExternalRegistration(
  receipt: ExternalRuntimeRecord,
  current: ExternalRuntimeRecord | null | undefined,
) {
  // The native command and workspace snapshot serialize the same Core record.
  return current != null && JSON.stringify(current) === JSON.stringify(receipt);
}

export function canOpenExternalRegistration(
  record: InvocationRecord,
  status: PortStatus | undefined,
  generation: number,
  selectedPortId: string | null | undefined,
  unreadExternalPorts: ReadonlySet<string>,
) {
  const { target, libraryGeneration } = record.context;
  return (
    record.phase === "settled" &&
    record.outcome === "succeeded" &&
    target.kind === "port" &&
    libraryGeneration === generation &&
    status?.port_id === target.id &&
    selectedPortId !== target.id &&
    !unreadExternalPorts.has(target.id) &&
    !status.active &&
    record.externalRegistration != null &&
    matchesExternalRegistration(record.externalRegistration, status.external_runtime)
  );
}

function invocationContextsConflict(left: InvocationContext, right: InvocationContext) {
  if (left.exclusionScope === "application" || right.exclusionScope === "application") return true;
  if (left.libraryGeneration !== right.libraryGeneration) return false;
  if (left.exclusionScope === "library" || right.exclusionScope === "library") return true;
  if (left.target.kind !== right.target.kind || left.target.id !== right.target.id) return false;
  if (
    left.target.kind === "port" &&
    ((left.operation === "acquire_game_update" && right.operation === "launch") ||
      (right.operation === "acquire_game_update" && left.operation === "launch"))
  )
    return false;
  return true;
}

export function pendingInvocationConflict(
  records: ReadonlyMap<number, InvocationRecord>,
  context: InvocationContext,
) {
  return [...records.values()].find(
    (record) => record.phase === "pending" && invocationContextsConflict(record.context, context),
  );
}

export function invocationFailure(record: InvocationRecord) {
  return record.failure ?? record.refreshFailure;
}

/** Settle the current caller after task execution and independent readback. */
export function settleInvocationResult<T>({
  isCurrent,
  options,
  taskFailure,
  result,
}: {
  isCurrent: () => boolean;
  options: { propagateFailure?: boolean };
  taskFailure: { value: unknown } | undefined;
  result: T | undefined;
}): T | undefined {
  if (isCurrent() && options.propagateFailure && taskFailure) throw taskFailure.value;
  return isCurrent() ? result : undefined;
}

export function targetInvocationContext(
  action: string,
  target: InvocationContext["target"],
  libraryGeneration: number,
  exclusionScope: InvocationContext["exclusionScope"] = "target",
): InvocationContext {
  return { action, target, libraryGeneration, exclusionScope };
}
