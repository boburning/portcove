import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listenDesktopEvent } from "../../desktop-events";
import type { ActivityRecord, OperationEvent } from "../../types";
import { failurePresentation, isCancellation } from "../../view-model";
import {
  invocationFailure,
  pendingInvocationConflict,
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

export type OperationRefresh = "workspace" | "activities" | "none";
export type PerformOptions = {
  refresh?: OperationRefresh;
  invalidateDiagnostics?: boolean;
  context?: InvocationContext;
};

export type ReportError = (value: unknown, context?: InvocationContext) => void;

export type Perform = <T>(
  name: string,
  task: () => Promise<T>,
  options?: PerformOptions,
) => Promise<T | undefined>;

export function useOperationState(configuration: {
  refresh: () => Promise<unknown>;
  refreshActivities?: (priority?: "progress" | "prompt") => Promise<unknown>;
  invalidateDiagnostics?: () => void;
  activities?: readonly ActivityRecord[];
  libraryGeneration?: number;
  libraryLabel?: string;
}) {
  const refresh = configuration.refresh;
  const refreshActivities = configuration.refreshActivities ?? configuration.refresh;
  const invalidateDiagnostics = configuration.invalidateDiagnostics;
  const { invocations, currentInvocations, nextId, active, updateInvocations } =
    useInvocationOwner();
  const generation = configuration.libraryGeneration ?? 0;
  const activeOwner = useRef<number | undefined>(generation);
  useLayoutEffect(() => {
    activeOwner.current = generation;
    return () => {
      activeOwner.current = undefined;
    };
  }, [generation]);
  const pendingOperations = new Map(
    [...invocations].filter(([, record]) => record.phase === "pending"),
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
      task: () => Promise<T>,
      options: PerformOptions = {},
    ): Promise<T | undefined> => {
      const context = options.context ?? defaultContext(name);
      const isCurrent = () =>
        activeOwner.current === generation && context.libraryGeneration === generation;
      const isOwned = () =>
        active.current && (context.exclusionScope === "application" || isCurrent());
      if (!isCurrent()) return undefined;
      const pendingId = nextId();
      const record: InvocationRecord = { id: pendingId, name, context, phase: "pending" };
      const conflict = pendingInvocationConflict(currentInvocations.current, context);
      if (conflict) {
        updateInvocations((current) =>
          new Map(current).set(pendingId, {
            ...record,
            phase: "settled",
            outcome: "failed",
            failure: new Error(
              `Wait for ${conflict.context.action} for ${conflict.context.target.label} before trying again.`,
            ),
          }),
        );
        return undefined;
      }
      updateInvocations((current) => new Map(current).set(pendingId, record));
      let outcome: NonNullable<InvocationRecord["outcome"]> = "succeeded";
      let failure: unknown;
      let refreshFailure: unknown;
      let result: T | undefined;
      try {
        result = await task();
      } catch (value) {
        const mutation = failurePresentation(value)?.mutation_state;
        const quietCancellation =
          isCancellation(value) && (mutation === "not_started" || mutation === "no_changes");
        outcome = isCancellation(value) ? "cancelled" : "failed";
        if (!quietCancellation)
          failure = value ?? new Error("The task failed without diagnostic details.");
      } finally {
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
          try {
            if (isCurrent()) {
              if (options.invalidateDiagnostics ?? true) invalidateDiagnostics?.();
              const effect = options.refresh ?? "workspace";
              if (effect === "workspace") await refresh();
              else if (effect === "activities") await refreshActivities();
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
        }
      }
      return isCurrent() ? result : undefined;
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
      updateInvocations,
    ],
  );
  return {
    busy,
    error,
    operation,
    operationEvents,
    pendingOperations,
    invocations,
    dismissInvocation,
    perform,
    setError,
    subscriptionFailure,
  };
}
