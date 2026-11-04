import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  QueryClient,
  focusManager,
  isCancelledError,
  replaceEqualDeep,
  useQuery,
} from "@tanstack/react-query";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import type {
  ActivityFeed,
  PortListingStatus,
  PendingSetupRecord,
  DoctorReport,
  PortStatus,
  SourceRecord,
  DesktopEventPayloads,
  WorkspaceSnapshot,
} from "../../types";
import {
  ActivityRefreshScheduler,
  closeCoalescedRequest,
  CoalescedRequest,
  LatestRequestGeneration,
} from "../../shared/concurrency-state";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";

export function emptyActivityFeed(terminalHistoryLimit = 50): ActivityFeed {
  return {
    records: [],
    current_activity_ids: [],
    attention_required_activity_ids: [],
    recovery_required_activity_ids: [],
    active_and_actionable_complete: true,
    terminal_history_limit: terminalHistoryLimit,
    terminal_history_count: 0,
    terminal_history_complete: true,
  };
}

function activitySnapshotIdentity(feed: ActivityFeed) {
  return JSON.stringify(feed);
}

interface WorkspaceRead {
  snapshot: WorkspaceSnapshot;
  activityRequest: number | null;
  activities: ActivityFeed;
  fullReadAt: number;
  needsRecovery: boolean;
}

// Extend the documented focus adapter for desktop window focus as well as visibility.
// Query's manager owns listener installation/removal with its mounted clients.
focusManager.setEventListener((onFocus) => {
  if (typeof window === "undefined") return;
  const visible = () => {
    if (!document.hidden) onFocus();
  };
  window.addEventListener("focus", visible);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("focus", visible);
    document.removeEventListener("visibilitychange", visible);
  };
});

function shareWorkspaceRead(previous: unknown, next: unknown): WorkspaceRead {
  const old = previous as WorkspaceRead | undefined;
  const incoming = next as WorkspaceRead;
  const shared = replaceEqualDeep(old, incoming);
  if (!old) return shared;
  // Port identity survives removal/reordering; generic array-index sharing cannot supply this.
  const byPort = new Map(old.snapshot.statuses.map((status) => [status.port_id, status]));
  const statuses = incoming.snapshot.statuses.map((status) =>
    replaceEqualDeep(byPort.get(status.port_id), status),
  );
  const retained =
    statuses.length === old.snapshot.statuses.length &&
    statuses.every((status, index) => status === old.snapshot.statuses[index]);
  return {
    ...shared,
    snapshot: { ...shared.snapshot, statuses: retained ? old.snapshot.statuses : statuses },
  };
}

const emptyStatuses: PortStatus[] = [];
const emptySources: SourceRecord[] = [];
const emptyListingStatuses: PortListingStatus[] = [];
const emptyPendingSetups: PendingSetupRecord[] = [];

function useWorkspaceViewState() {
  const [activityFeed, setActivityFeed] = useState<ActivityFeed>(() => emptyActivityFeed());
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [recoveryFailure, setRecoveryFailure] = useState<{ error: unknown }>();
  const [diagnosticFailure, setDiagnosticFailure] = useState<{ error: unknown }>();
  const [diagnosticRefreshing, setDiagnosticRefreshing] = useState(false);
  const [diagnosticsStale, setDiagnosticsStale] = useState(true);
  const [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const [subscriptionFailure, setSubscriptionFailure] = useState<{ error: unknown }>();
  return {
    activityFeed,
    setActivityFeed,
    doctor,
    setDoctor,
    recoveryFailure,
    setRecoveryFailure,
    diagnosticFailure,
    setDiagnosticFailure,
    diagnosticRefreshing,
    setDiagnosticRefreshing,
    diagnosticsStale,
    setDiagnosticsStale,
    diagnosticRevision,
    setDiagnosticRevision,
    subscriptionFailure,
    setSubscriptionFailure,
  };
}

export function usePortcoveData(libraryGeneration = 0) {
  const view = useWorkspaceViewState();
  const {
    activityFeed,
    doctor,
    recoveryFailure,
    diagnosticFailure,
    diagnosticRefreshing,
    diagnosticsStale,
    diagnosticRevision,
    subscriptionFailure,
    setActivityFeed,
    setDiagnosticFailure,
    setDiagnosticRefreshing,
    setDiagnosticsStale,
    setDiagnosticRevision,
    setDoctor,
    setRecoveryFailure,
    setSubscriptionFailure,
  } = view;
  const activityGeneration = useRef(new LatestRequestGeneration());
  const diagnosticGeneration = useRef(new LatestRequestGeneration());
  const recoveryGeneration = useRef(new LatestRequestGeneration());
  const diagnosticInvalidationRevision = useRef(0);
  const activityIdentity = useRef(activitySnapshotIdentity(emptyActivityFeed()));
  const acceptActivities = useCallback(
    (next: ActivityFeed) => {
      const identity = activitySnapshotIdentity(next);
      if (identity === activityIdentity.current) return;
      activityIdentity.current = identity;
      setActivityFeed(next);
    },
    [setActivityFeed],
  );
  const invalidateDiagnostics = useCallback(() => {
    diagnosticInvalidationRevision.current += 1;
    diagnosticGeneration.current.begin();
    setDiagnosticRevision((revision) => revision + 1);
    setDiagnosticRefreshing(false);
    setDiagnosticsStale(true);
  }, [setDiagnosticRefreshing, setDiagnosticsStale, setDiagnosticRevision]);
  const [queryClient] = useState(() => new QueryClient());
  const [readyGeneration, setReadyGeneration] = useState<number>();
  const queryKey = useMemo(() => ["workspace-snapshot", libraryGeneration], [libraryGeneration]);
  const fullReadRequested = useRef(false);
  useEffect(() => {
    queryClient.mount();
    return () => queryClient.unmount();
  }, [queryClient]);
  const readWorkspace = useCallback(
    async ({ signal }: { signal: AbortSignal }): Promise<WorkspaceRead> => {
      const activityRequest = activityGeneration.current.begin();
      const previous = queryClient.getQueryData<WorkspaceRead>(queryKey);
      const full =
        fullReadRequested.current ||
        !previous ||
        queryClient.getQueryState(queryKey)?.status === "error";
      fullReadRequested.current = false;
      if (!full && previous) {
        let changed = false;
        try {
          changed = await desktopApi.workspaceChanged(libraryGeneration);
        } catch {
          /* Periodic/full read remains the actionable fallback. */
        }
        signal.throwIfAborted(); // Stops frontend continuations, not the already-started backend read.
        if (
          previous.needsRecovery ||
          changed ||
          document.hidden ||
          Date.now() - previous.fullReadAt < 60_000
        ) {
          let activities = previous.activities;
          let activityReadSucceeded = false;
          try {
            activities = await desktopApi.activities();
            activityReadSucceeded = true;
          } catch {
            /* Harmless activity refresh failure. */
          }
          signal.throwIfAborted();
          return {
            ...previous,
            activityRequest: activityReadSucceeded ? activityRequest : null,
            activities,
            needsRecovery:
              !!queryClient.getQueryData<WorkspaceRead>(queryKey)?.needsRecovery || changed,
          };
        }
      }
      const snapshot = await desktopApi.workspaceSnapshot(libraryGeneration);
      signal.throwIfAborted();
      return {
        snapshot,
        activityRequest,
        activities: snapshot.activities,
        fullReadAt: Date.now(),
        needsRecovery: queryClient.getQueryData<WorkspaceRead>(queryKey)?.needsRecovery ?? false,
      };
    },
    [fullReadRequested, libraryGeneration, queryClient, queryKey],
  );
  const options = useMemo(
    () => ({
      queryKey,
      queryFn: readWorkspace,
      networkMode: "always" as const,
      retry: false as const,
      retryOnMount: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: false,
      staleTime: 0,
      gcTime: 0,
      structuralSharing: shareWorkspaceRead,
    }),
    [queryKey, readWorkspace],
  );
  const hasRunningActivity = activityFeed.current_activity_ids.length > 0;
  const workspace = useQuery(
    {
      ...options,
      enabled: readyGeneration === libraryGeneration,
      refetchInterval: hasRunningActivity ? 1000 : document.hidden ? 30_000 : 10_000,
      refetchIntervalInBackground: true,
    },
    queryClient,
  );
  const snapshot = workspace.data?.snapshot;
  const catalog = snapshot?.catalog;
  const statuses = snapshot?.statuses ?? emptyStatuses;
  const sources = snapshot?.sources ?? emptySources;
  const browsing = snapshot?.browsing;
  const refreshFailure = workspace.isError ? { error: workspace.error } : undefined;
  const refreshing = workspace.isFetching;
  const previousSnapshot = useRef<WorkspaceSnapshot | undefined>(undefined);
  useLayoutEffect(() => {
    if (!workspace.data) return;
    const next = workspace.data.snapshot;
    const previous = previousSnapshot.current;
    if (
      previous &&
      (next.catalog !== previous.catalog ||
        next.statuses !== previous.statuses ||
        next.sources !== previous.sources ||
        next.browsing !== previous.browsing ||
        next.listing_catalog !== previous.listing_catalog ||
        next.listing_statuses !== previous.listing_statuses ||
        next.pending_setups !== previous.pending_setups)
    )
      invalidateDiagnostics();
    previousSnapshot.current = next;
    if (
      workspace.data.activityRequest !== null &&
      activityGeneration.current.isCurrent(workspace.data.activityRequest)
    )
      acceptActivities(workspace.data.activities);
  }, [workspace.data, workspace.dataUpdatedAt, acceptActivities, invalidateDiagnostics]);
  const refresh = useCallback(async () => {
    // A known mutation may have arrived after the current read began. Joining that
    // promise is not enough: invalidate after it settles, without cancelling IPC.
    if (queryClient.getQueryState(queryKey)?.fetchStatus === "fetching") {
      try {
        await queryClient.query(options);
      } catch {
        /* Still require a fresh read after failure. */
      }
    }
    if (!queryClient.getQueryState(queryKey)) return; // Retired library or disposed hook.
    fullReadRequested.current = true;
    try {
      await queryClient.invalidateQueries(
        { queryKey, exact: true },
        { cancelRefetch: false, throwOnError: true },
      );
    } catch (error) {
      if (!isCancelledError(error)) throw error;
    }
  }, [options, queryClient, queryKey]);
  const coordinators = useRef<
    | {
        diagnostics: CoalescedRequest;
        activity: ActivityRefreshScheduler;
        recovery: CoalescedRequest;
      }
    | undefined
  >(undefined);
  const retryRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch {
      /* The refresh failure remains visible independently of mutation outcomes. */
    }
  }, [refresh]);
  const refreshAfterMutation = useCallback(() => {
    invalidateDiagnostics();
    return refresh();
  }, [invalidateDiagnostics, refresh]);

  const runDiagnostics = useCallback(async () => {
    const generation = diagnosticGeneration.current.begin();
    const invalidationRevision = diagnosticInvalidationRevision.current;
    setDiagnosticRefreshing(true);
    try {
      const next = await desktopApi.doctor(libraryGeneration);
      if (
        !diagnosticGeneration.current.isCurrent(generation) ||
        invalidationRevision !== diagnosticInvalidationRevision.current
      )
        return;
      setDoctor(next);
      setDiagnosticFailure(undefined);
      setDiagnosticsStale(false);
    } catch (error) {
      if (!diagnosticGeneration.current.isCurrent(generation)) return;
      setDiagnosticFailure({ error });
    } finally {
      if (diagnosticGeneration.current.isCurrent(generation)) setDiagnosticRefreshing(false);
    }
  }, [
    libraryGeneration,
    setDiagnosticFailure,
    setDiagnosticRefreshing,
    setDiagnosticsStale,
    setDoctor,
  ]);
  const refreshDiagnostics = useCallback(
    () =>
      coordinators.current?.diagnostics.request(runDiagnostics, libraryGeneration) ??
      Promise.resolve("disposed" as const),
    [libraryGeneration, runDiagnostics],
  );
  const refreshDiagnosticsAfterMutation = useCallback(() => {
    invalidateDiagnostics();
    return refreshDiagnostics();
  }, [invalidateDiagnostics, refreshDiagnostics]);

  const runActivityRefresh = useCallback(async () => {
    const generation = activityGeneration.current.begin();
    try {
      const next = await desktopApi.activities();
      if (activityGeneration.current.isCurrent(generation)) acceptActivities(next);
    } catch {
      /* Essential refresh remains the actionable IPC failure surface. */
    }
  }, [acceptActivities]);
  const refreshActivities = useCallback(
    (priority: "progress" | "prompt" = "prompt") =>
      coordinators.current?.activity.request(priority) ?? Promise.resolve("disposed" as const),
    [],
  );

  useEffect(() => {
    const lifetime = {
      diagnostics: new CoalescedRequest(),
      activity: new ActivityRefreshScheduler(runActivityRefresh),
      recovery: new CoalescedRequest(),
    };
    coordinators.current = lifetime;
    return () => {
      if (coordinators.current === lifetime) coordinators.current = undefined;
      closeCoalescedRequest(lifetime.diagnostics);
      lifetime.activity.close();
      closeCoalescedRequest(lifetime.recovery);
    };
  }, [libraryGeneration, runActivityRefresh]);

  const runRecovery = useCallback(async () => {
    const generation = recoveryGeneration.current.begin();
    invalidateDiagnostics();
    try {
      await desktopApi.discoverOrphanedOperations(libraryGeneration);
      if (recoveryGeneration.current.isCurrent(generation)) setRecoveryFailure(undefined);
    } catch (error) {
      if (recoveryGeneration.current.isCurrent(generation)) setRecoveryFailure({ error });
    }
    if (recoveryGeneration.current.isCurrent(generation)) {
      queryClient.setQueryData<WorkspaceRead>(queryKey, (previous) =>
        previous ? { ...previous, needsRecovery: false } : undefined,
      );
      await refreshAfterMutation();
    }
  }, [
    invalidateDiagnostics,
    libraryGeneration,
    queryClient,
    queryKey,
    refreshAfterMutation,
    setRecoveryFailure,
  ]);
  const retryRecovery = useCallback(async () => {
    await (coordinators.current?.recovery.request(runRecovery, libraryGeneration) ??
      Promise.resolve("disposed" as const));
  }, [libraryGeneration, runRecovery]);
  useLayoutEffect(() => {
    if (workspace.data?.needsRecovery) void retryRecovery().catch(() => {});
  }, [workspace.data?.needsRecovery, retryRecovery]);
  const initialDiagnostics = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      readyGeneration === libraryGeneration &&
      workspace.isFetched &&
      initialDiagnostics.current !== libraryGeneration
    ) {
      initialDiagnostics.current = libraryGeneration;
      void refreshDiagnostics();
    }
  }, [libraryGeneration, readyGeneration, workspace.isFetched, refreshDiagnostics]);

  useEffect(() => {
    const activityRequests = activityGeneration.current;
    const diagnosticRequests = diagnosticGeneration.current;
    const recoveryRequests = recoveryGeneration.current;
    let closed = false;
    const subscription = startManagedSubscription<
      DesktopEventPayloads["portcove://library-changed"]
    >({
      register: (accept) => listenDesktopEvent("portcove://library-changed", accept),
      onEvent: () => {
        invalidateDiagnostics();
        void retryRecovery().catch(() => {
          /* The refresh failure remains visible; this event has no awaiting caller. */
        });
      },
      onFailure: (error) => setSubscriptionFailure({ error }),
    });
    void (async () => {
      await subscription.ready;
      if (closed) return;
      setReadyGeneration(libraryGeneration);
    })();
    return () => {
      closed = true;
      activityRequests.begin();
      diagnosticRequests.begin();
      recoveryRequests.begin();
      subscription.stop();
      queryClient.removeQueries({ queryKey, exact: true });
    };
  }, [
    invalidateDiagnostics,
    retryRecovery,
    libraryGeneration,
    queryClient,
    queryKey,
    setSubscriptionFailure,
  ]);

  const activities = activityFeed.records;
  return {
    catalog,
    statuses,
    sources,
    browsing,
    refreshFailure,
    refreshing,
    listingCatalog: snapshot?.listing_catalog ?? undefined,
    listingStatuses: snapshot?.listing_statuses ?? emptyListingStatuses,
    pendingSetups: snapshot?.pending_setups ?? emptyPendingSetups,
    activities,
    activityFeed,
    doctor,
    storage: doctor?.library,
    refresh,
    refreshAfterMutation,
    retryRefresh,
    refreshActivities,
    recoveryFailure,
    retryRecovery,
    refreshDiagnostics,
    refreshDiagnosticsAfterMutation,
    invalidateDiagnostics,
    diagnosticFailure,
    diagnosticRefreshing,
    diagnosticsStale,
    diagnosticRevision,
    subscriptionFailure,
  };
}
