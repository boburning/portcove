import type { ExternalRuntimeRecord, InstallRecord, PortStatus, SourceRecord } from "../../types";
import { failurePresentation } from "../../view-model";

/** Presentation identities only. None grants a Core lock or execution authority. */
export type InvocationContext = {
  action: string;
  target: { kind: "port" | "source" | "library" | "application"; id: string; label: string };
  libraryGeneration: number;
  exclusionScope: "target" | "library" | "application";
  /** Permanently bounded API contracts; event phase strings never grant compatibility. */
  operation?:
    | "acquire_game_update"
    | "launch"
    | "register_external"
    | "change_managed_route"
    | "import_source"
    | undefined;
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
  reviewCurrentState?: true;
  installed?: Pick<InstallRecord, "id" | "port_id" | "version">;
  externalRegistration?: ExternalRuntimeRecord;
  sourceRegistration?: { source: SourceRecord; afterRead: number | undefined };
};

export const managedRouteReadbackGuidance =
  "If your previous installation still appears after refreshing, restart Portcove before using it.";

export const sourceImportRecoveryGuidance =
  "Restart Portcove to check the saved file location and recover any unfinished work before adding it again.";

export function mutationNeedsReadback(error: unknown) {
  const mutation = failurePresentation(error)?.mutation_state;
  return mutation !== "not_started" && mutation !== "no_changes";
}

export function matchingSavedSource(
  record: InvocationRecord,
  sources: readonly SourceRecord[],
  generation: number,
  readRevision: number | undefined,
) {
  const { target, libraryGeneration } = record.context;
  const receipt = record.sourceRegistration;
  if (
    !receipt ||
    record.phase !== "settled" ||
    record.outcome !== "succeeded" ||
    target.kind !== "source" ||
    libraryGeneration !== generation ||
    readRevision === undefined ||
    receipt.afterRead === undefined ||
    readRevision <= receipt.afterRead
  )
    return undefined;
  return sources.find(
    (source) =>
      source.profile_id === target.id && JSON.stringify(source) === JSON.stringify(receipt.source),
  );
}

export function canOpenInstalledResult(
  record: InvocationRecord,
  status: PortStatus | undefined,
  generation: number,
  selectedPortId: string | null | undefined,
  unreadInstallPorts: ReadonlySet<string>,
) {
  const { target, libraryGeneration } = record.context;
  const active = status?.active;
  return (
    record.phase === "settled" &&
    record.outcome === "succeeded" &&
    target.kind === "port" &&
    libraryGeneration === generation &&
    status?.port_id === target.id &&
    !status.external_runtime &&
    selectedPortId !== target.id &&
    !unreadInstallPorts.has(target.id) &&
    active != null &&
    record.installed != null &&
    active.id === record.installed.id &&
    active.port_id === target.id &&
    record.installed.port_id === target.id &&
    active.version === record.installed.version
  );
}

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
