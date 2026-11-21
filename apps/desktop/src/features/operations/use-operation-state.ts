import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listenDesktopEvent } from "../../desktop-events";
import type {
  ActivityRecord,
  ExternalRuntimeRecord,
  InstallRecord,
  OperationEvent,
} from "../../types";
import { failurePresentation, isCancellation } from "../../view-model";
import {
  invocationFailure,
  pendingInvocationConflict,
  settleInvocationResult,
  type InvocationContext,
  type InvocationRecord,
} from "./invocation-state";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";
import { useInvocationOwner } from "./invocation-owner";
import {
  activityIsTerminal,
  applyOperationEvent,
  mostRecentOperation,
  reconcileOperationEvents,
} from "./operation-state";

const noActivities: readonly ActivityRecord[] = [];
const noUnreadPorts: ReadonlySet<string> = new Set();
type SetupKind = "managed" | "external";

export type OperationRefresh = "workspace" | "activities" | "none";
export type PerformOptions<Result = unknown> = {
  /** Explicit workspace readback may propagate failures unlike an ambient retry action. */
  refresh?: OperationRefresh | ((result: Result | undefined) => Promise<unknown>);
  invalidateDiagnostics?: boolean;
  /** Return a confirmed result while the invocation still owns both readbacks. */
  readbackAfterSuccess?: () => Promise<unknown>;
  /** Preserve the original task rejection after settlement for a current caller. */
  propagateFailure?: boolean;
  /** Only named nullable native-consent commands opt in; other null results retain their meaning. */
  cancelledResult?: (result: unknown) => boolean;
  context?: InvocationContext;
  /** Captures the exact installation returned by a managed setup command. */
  installedResult?: (result: Result) => InvocationRecord["installed"];
  /** Captures the exact external registration returned by a reviewed native command. */
  externalRegistrationResult?: (result: Result) => ExternalRuntimeRecord | undefined;
};

export type ReportError = (value: unknown, context?: InvocationContext) => void;

export type Perform = <T>(
  name: string,
  task: (reportEvent?: (event: OperationEvent) => void) => Promise<T>,
  options?: PerformOptions<T>,
) => Promise<T | undefined>;

export function useOperationState(configuration: {
  refresh: () => Promise<unknown>;
  refreshActivities?: (priority?: "progress" | "prompt") => Promise<unknown>;
  invalidateDiagnostics?: () => void;
  activities?: readonly ActivityRecord[];
  libraryGeneration?: number;
  libraryLabel?: string;
  /** The latest accepted full snapshot, unchanged by activity-only reads. */
  workspaceReadRevision?: number | undefined;
  /** Read only at a mutation's async boundary; includes in-flight/failed full reads. */
  startedWorkspaceReadRevision?: () => number;
}) {
  const refresh = configuration.refresh;
  const refreshActivities = configuration.refreshActivities ?? configuration.refresh;
  const invalidateDiagnostics = configuration.invalidateDiagnostics;
  const { invocations, currentInvocations, nextId, active, updateInvocations } =
    useInvocationOwner();
  const generation = configuration.libraryGeneration ?? 0;
  const startedWorkspaceReadRevision = configuration.startedWorkspaceReadRevision;
  const [committedSetups, setCommittedSetups] = useState<
    ReadonlyMap<string, { portId: string; kind: SetupKind; generation: number; afterRead: number }>
  >(new Map());
  const activeOwner = useRef<number | undefined>(generation);
  useLayoutEffect(() => {
    activeOwner.current = generation;
    return () => {
      activeOwner.current = undefined;
      setCommittedSetups(new Map());
    };
  }, [generation]);
  const noteSetupCommitted = useCallback(
    (portId: string, kind: SetupKind) => {
      if (!active.current || activeOwner.current !== generation || !startedWorkspaceReadRevision)
        return;
      const afterRead = startedWorkspaceReadRevision();
      setCommittedSetups((previous) => {
        const next = new Map([...previous].filter(([, value]) => value.generation === generation));
        next.set(kind + ":" + portId, { portId, kind, generation, afterRead });
        return next;
      });
    },
    [active, startedWorkspaceReadRevision, generation],
  );
  const noteInstallCommitted = useCallback(
    (install: InstallRecord) => noteSetupCommitted(install.port_id, "managed"),
    [noteSetupCommitted],
  );
  // Only a full read started after commit can confirm the setup receipt.
  const { unreadInstallPorts, unreadExternalPorts } = useMemo(() => {
    const managed = new Set<string>();
    const external = new Set<string>();
    for (const value of committedSetups.values()) {
      if (
        value.generation === generation &&
        (configuration.workspaceReadRevision ?? 0) <= value.afterRead
      )
        (value.kind === "managed" ? managed : external).add(value.portId);
    }
    return {
      unreadInstallPorts: managed.size ? managed : noUnreadPorts,
      unreadExternalPorts: external.size ? external : noUnreadPorts,
    };
  }, [committedSetups, configuration.workspaceReadRevision, generation]);
  const pendingOperations = useMemo(
    () => new Map([...invocations].filter(([, record]) => record.phase === "pending")),
    [invocations],
  );
  const busy = [...pendingOperations.values()].at(-1)?.name;
  // Compatibility selector for feature-specific recovery. The records, rather
  // than this projection, own all independently attributable failures.
  const error = [...invocations.values()]
    .reverse()
    .map(invocationFailure)
    .find((value) => value !== undefined);
  const defaultContext = useCallback(
    (action: string): InvocationContext => ({
      action,
      target: {
        kind: "library",
        id: "current-library",
        label: configuration.libraryLabel ?? "Current library",
      },
      libraryGeneration: generation,
      exclusionScope: "library",
    }),
    [configuration.libraryLabel, generation],
  );
  const dismissInvocation = useCallback(
    (id: number) =>
      updateInvocations((current) => {
        if (current.get(id)?.phase === "pending") return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      }),
    [updateInvocations],
  );
  const setError = useCallback(
    (value: unknown, suppliedContext?: InvocationContext) => {
      const context = suppliedContext ?? defaultContext("Review");
      if (activeOwner.current !== generation || context.libraryGeneration !== generation) return;
      updateInvocations((current) => {
        if (value === undefined)
          return new Map([...current].filter(([, record]) => record.phase === "pending"));
        const id = nextId();
        return new Map(current).set(id, {
          id,
          name: "review",
          context,
          phase: "settled",
          outcome: "failed",
          failure: value,
        });
      });
    },
    [defaultContext, generation, nextId, updateInvocations],
  );
  const [operationEvents, setOperationEvents] = useState<ReadonlyMap<string, OperationEvent>>(
    new Map(),
  );
  const [subscriptionFailure, setSubscriptionFailure] = useState<unknown>();
  const activities = configuration.activities ?? noActivities;
  const currentActivities = useRef(activities);
  // Remember only observed event identities retired by durable readback, until
  // this workspace owner ends. History pagination must not revive queued events.
  const retiredOperations = useRef(new Set<string>());
  const observedGeneration = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (observedGeneration.current !== generation) {
      observedGeneration.current = generation;
      // Dropping outgoing presentation does not cancel its Core work. Its
      // continuation cannot publish or refresh the replacement workspace.
      updateInvocations(
        (current) =>
          new Map(
            [...current].filter(
              ([, record]) =>
                record.context.exclusionScope === "application" ||
                record.context.libraryGeneration === generation,
            ),
          ),
      );
      retiredOperations.current.clear();
      setOperationEvents(new Map());
    }
    currentActivities.current = activities;
    setOperationEvents((current) => {
      const next = reconcileOperationEvents(current, activities);
      for (const id of current.keys()) if (!next.has(id)) retiredOperations.current.add(id);
      return next;
    });
  }, [activities, generation, updateInvocations]);
  const operation = mostRecentOperation(operationEvents);
  useEffect(() => {
    const subscription = startManagedSubscription<OperationEvent>({
      register: (accept) => listenDesktopEvent("portcove://operation", accept),
      onEvent: (payload) => {
        if (
          retiredOperations.current.has(payload.operation_id) ||
          currentActivities.current.some(
            (activity) => activity.id === payload.operation_id && activityIsTerminal(activity),
          )
        ) {
          retiredOperations.current.add(payload.operation_id);
          return;
        }
        setOperationEvents((current) => applyOperationEvent(current, payload));
        void refreshActivities(
          payload.type === "started" || payload.type === "finished" ? "prompt" : "progress",
        );
      },
      onFailure: setSubscriptionFailure,
    });
    return () => subscription.stop();
  }, [refreshActivities]);
  const perform = useCallback(
    async <T>(
      name: string,
      task: (reportEvent?: (event: OperationEvent) => void) => Promise<T>,
      options: PerformOptions<T> = {},
    ): Promise<T | undefined> => {
      const context = options.context ?? defaultContext(name);
      const isCurrent = () =>
        activeOwner.current === generation && context.libraryGeneration === generation;
      const isOwned = () =>
        active.current && (context.exclusionScope === "application" || isCurrent());
      if (!isCurrent()) return undefined;
      const pendingId = nextId();
      let record: InvocationRecord = { id: pendingId, name, context, phase: "pending" };
      const conflict = pendingInvocationConflict(currentInvocations.current, context);
      const awaitingExternalReadback =
        (context.operation === "launch" || context.operation === "register_external") &&
        context.target.kind === "port" &&
        unreadExternalPorts.has(context.target.id);
      const hold = awaitingExternalReadback
        ? "Refresh the library to confirm the current external launch details."
        : conflict
          ? `Wait for ${conflict.context.action} for ${conflict.context.target.label} before trying again.`
          : undefined;
      if (hold) {
        updateInvocations((current) =>
          new Map(current).set(pendingId, {
            ...record,
            phase: "settled",
            outcome: "failed",
            failure: new Error(hold),
          }),
        );
        return undefined;
      }
      updateInvocations((current) => new Map(current).set(pendingId, record));
      let outcome: NonNullable<InvocationRecord["outcome"]> = "succeeded";
      let failure: unknown;
      // Quiet cancellation can have no displayed failure; even undefined is a task rejection.
      let taskFailure: { value: unknown } | undefined;
      let refreshFailure: unknown;
      let result: T | undefined;
      let acceptingEvents = true;
      try {
        result = await task((event) => {
          if (!acceptingEvents || !isOwned()) return;
          // This callback belongs to this invocation's API channel. Global events
          // cannot assign identity, and a nested operation cannot replace its root.
          if (
            event.type === "started" &&
            event.parent_operation_id === null &&
            !record.context.activityId
          ) {
            // oxlint-disable-next-line react/immutability -- oxc#28401: invocation-local binding.
            record = { ...record, context: { ...record.context, activityId: event.operation_id } };
            updateInvocations((current) => new Map(current).set(pendingId, record));
          }
          if (
            retiredOperations.current.has(event.operation_id) ||
            currentActivities.current.some(
              (activity) => activity.id === event.operation_id && activityIsTerminal(activity),
            )
          ) {
            retiredOperations.current.add(event.operation_id);
            return;
          }
          setOperationEvents((current) => applyOperationEvent(current, event));
          void refreshActivities(
            event.type === "started" || event.type === "finished" ? "prompt" : "progress",
          );
        });
        if (options.cancelledResult?.(result)) outcome = "cancelled";
        else if (context.target.kind === "port" && options.installedResult) {
          const installed = options.installedResult(result);
          if (installed?.id && installed.port_id === context.target.id) {
            const { id, port_id, version } = installed;
            record = { ...record, installed: { id, port_id, version } };
          }
        } else if (context.target.kind === "port" && options.externalRegistrationResult) {
          const registration = options.externalRegistrationResult(result);
          if (registration?.id && registration.port_id === context.target.id) {
            noteSetupCommitted(registration.port_id, "external");
            record = { ...record, externalRegistration: registration };
          }
        }
      } catch (value) {
        taskFailure = { value };
        ({ outcome, failure } = classifyInvocationFailure(value));
      } finally {
        acceptingEvents = false;
        if (isOwned()) {
          // Report an early task failure immediately, even if its independent
          // snapshot refresh is slow. Local exclusion lasts through readback.
          updateInvocations((current) =>
            new Map(current).set(pendingId, {
              ...record,
              outcome,
              ...(failure !== undefined ? { failure } : {}),
            }),
          );
          const followup = outcome === "succeeded" ? options.readbackAfterSuccess : undefined;
          const settleReadback = async () => {
            try {
              if (isCurrent()) {
                if (options.invalidateDiagnostics ?? true) invalidateDiagnostics?.();
                const refreshInvocation = async () => {
                  const effect = options.refresh ?? "workspace";
                  if (typeof effect === "function") await effect(result);
                  else if (effect === "workspace") await refresh();
                  else if (effect === "activities") await refreshActivities();
                };
                if (followup) {
                  const workspaceRead = refreshInvocation();
                  const followupRead = workspaceRead
                    .catch(() => undefined)
                    .then(() => (isCurrent() ? followup() : undefined));
                  const reads = await Promise.allSettled([workspaceRead, followupRead]);
                  const rejected = reads.find((read) => read.status === "rejected");
                  if (rejected) throw rejected.reason;
                } else await refreshInvocation();
              }
            } catch (value) {
              refreshFailure = value ?? new Error("Current state could not be refreshed.");
            }
            if (isOwned())
              updateInvocations((current) =>
                new Map(current).set(pendingId, {
                  ...record,
                  phase: "settled",
                  outcome,
                  ...(failure !== undefined ? { failure } : {}),
                  ...(refreshFailure !== undefined ? { refreshFailure } : {}),
                }),
              );
          };
          if (followup) void settleReadback();
          else await settleReadback();
        }
      }
      return settleInvocationResult({ isCurrent, options, taskFailure, result });
    },
    [
      defaultContext,
      active,
      currentInvocations,
      nextId,
      generation,
      invalidateDiagnostics,
      refresh,
      refreshActivities,
      noteSetupCommitted,
      unreadExternalPorts,
      updateInvocations,
    ],
  );
  return {
    busy,
    error,
    operation,
    operationEvents,
    pendingOperations,
    unreadInstallPorts,
    unreadExternalPorts,
    noteInstallCommitted,
    invocations,
    dismissInvocation,
    perform,
    setError,
    subscriptionFailure,
  };
}

function classifyInvocationFailure(value: unknown): {
  outcome: "cancelled" | "failed";
  failure: unknown;
} {
  const mutation = failurePresentation(value)?.mutation_state;
  const quietCancellation =
    isCancellation(value) && (mutation === "not_started" || mutation === "no_changes");
  const outcome = isCancellation(value) ? "cancelled" : "failed";
  const failure = quietCancellation
    ? undefined
    : (value ?? new Error("The task failed without diagnostic details."));
  return { outcome, failure };
}
