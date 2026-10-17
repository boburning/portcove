import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listenDesktopEvent } from "../../desktop-events";
import type { ActivityRecord, OperationEvent } from "../../types";
import { failurePresentation, isCancellation } from "../../view-model";
import {
  addPendingOperation,
  mostRecentPendingOperation,
  removePendingOperation,
} from "../../shared/concurrency-state";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";
import {
  activityIsTerminal,
  applyOperationEvent,
  mostRecentOperation,
  reconcileOperationEvents,
} from "./operation-state";

const noActivities: readonly ActivityRecord[] = [];

export type OperationRefresh = "workspace" | "activities" | "none";

export type Perform = <T>(
  name: string,
  task: () => Promise<T>,
  options?: { refresh?: OperationRefresh; invalidateDiagnostics?: boolean },
) => Promise<T | undefined>;

export function useOperationState(configuration: {
  refresh: () => Promise<unknown>;
  refreshActivities?: (priority?: "progress" | "prompt") => Promise<unknown>;
  invalidateDiagnostics?: () => void;
  activities?: readonly ActivityRecord[];
}) {
  const refresh = configuration.refresh;
  const refreshActivities = configuration.refreshActivities ?? configuration.refresh;
  const invalidateDiagnostics = configuration.invalidateDiagnostics;
  const [pendingOperations, setPendingOperations] = useState<ReadonlyMap<number, string>>(
    new Map(),
  );
  const nextPendingId = useRef(0);
  const busy = mostRecentPendingOperation(pendingOperations);
  const [error, setError] = useState<unknown>();
  const [operationEvents, setOperationEvents] = useState<ReadonlyMap<string, OperationEvent>>(
    new Map(),
  );
  const [subscriptionFailure, setSubscriptionFailure] = useState<unknown>();
  const activities = configuration.activities ?? noActivities;
  const currentActivities = useRef(activities);
  // Remember only observed event identities retired by durable readback, until
  // this workspace owner ends. History pagination must not revive queued events.
  const retiredOperations = useRef(new Set<string>());
  useLayoutEffect(() => {
    currentActivities.current = activities;
    setOperationEvents((current) => {
      const next = reconcileOperationEvents(current, activities);
      for (const id of current.keys()) if (!next.has(id)) retiredOperations.current.add(id);
      return next;
    });
  }, [activities]);
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
      options: { refresh?: OperationRefresh; invalidateDiagnostics?: boolean } = {},
    ): Promise<T | undefined> => {
      const pendingId = ++nextPendingId.current;
      setPendingOperations((current) => addPendingOperation(current, pendingId, name));
      setError(undefined);
      try {
        const result = await task();
        return result;
      } catch (value) {
        const outcome = failurePresentation(value)?.mutation_state;
        const quietCancellation =
          isCancellation(value) && (outcome === "not_started" || outcome === "no_changes");
        if (!quietCancellation) setError(value);
      } finally {
        if (options.invalidateDiagnostics ?? true) invalidateDiagnostics?.();
        try {
          const effect = options.refresh ?? "workspace";
          if (effect === "workspace") await refresh();
          else if (effect === "activities") await refreshActivities();
        } catch (value) {
          setError((current: unknown) => current ?? value);
        }
        setPendingOperations((current) => removePendingOperation(current, pendingId));
      }
    },
    [invalidateDiagnostics, refresh, refreshActivities],
  );
  return { busy, error, operation, pendingOperations, perform, setError, subscriptionFailure };
}
