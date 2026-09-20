import { useCallback, useEffect, useRef, useState } from "react";
import { listenDesktopEvent } from "../../desktop-events";
import type { OperationEvent } from "../../types";
import { isCancellation } from "../../view-model";
import {
  addPendingOperation,
  mostRecentPendingOperation,
  removePendingOperation,
} from "../../shared/concurrency-state";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";
import { applyOperationEvent, mostRecentOperation } from "./operation-state";

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
  const operation = mostRecentOperation(operationEvents);
  useEffect(() => {
    const subscription = startManagedSubscription<OperationEvent>({
      register: (accept) => listenDesktopEvent("portcove://operation", accept),
      onEvent: (payload) => {
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
        if (!isCancellation(value)) setError(value);
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
