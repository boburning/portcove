import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { QueryClient, replaceEqualDeep, useQuery } from "@tanstack/react-query";
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
  activityRequest: number;
}

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
  const externalGeneration = useRef(new LatestRequestGeneration());
  const diagnosticInvalidationRevision = useRef(0);
  const activityIdentity = useRef(activitySnapshotIdentity(emptyActivityFeed()));
  const lastFullReconciliationAt = useRef(0);
  const forceWorkspaceReconciliation = useRef(false);
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
  const readWorkspace = useCallback(async (): Promise<WorkspaceRead> => {
    const activityRequest = activityGeneration.current.begin();
    // No recovery or mutation belongs in an automatically executable read function.
    return { snapshot: await desktopApi.workspaceSnapshot(libraryGeneration), activityRequest };
  }, [libraryGeneration]);
  const options = useMemo(
    () => ({
      queryKey: ["workspace-snapshot", libraryGeneration],
      queryFn: readWorkspace,
      // The existing event/subscription adapter decides when a coherent IPC read is needed.
      enabled: false,
      networkMode: "always" as const,
      retry: false as const,
      retryOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
      gcTime: 0,
      structuralSharing: shareWorkspaceRead,
    }),
    [libraryGeneration, readWorkspace],
  );
  const workspace = useQuery(options, queryClient);
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
    lastFullReconciliationAt.current = workspace.dataUpdatedAt;
    if (activityGeneration.current.isCurrent(workspace.data.activityRequest))
      acceptActivities(next.activities);
  }, [workspace.data, workspace.dataUpdatedAt, acceptActivities, invalidateDiagnostics]);
  const runRefresh = useCallback(async () => {
    await queryClient.fetchQuery(options);
  }, [queryClient, options]);
  // An invalidation during a read requires a fresh follow-up, not merely the same
  // in-flight promise. Keep that boundary alongside the non-query coordinators.
  const coordinators = useRef<
    | {
        refresh: CoalescedRequest;
        diagnostics: CoalescedRequest;
        activity: ActivityRefreshScheduler;
        external: CoalescedRequest;
      }
    | undefined
  >(undefined);
  const refresh = useCallback(
    () =>
      coordinators.current?.refresh.request(runRefresh, libraryGeneration) ??
      Promise.resolve("disposed" as const),
    [libraryGeneration, runRefresh],
  );
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
      refresh: new CoalescedRequest(),
      diagnostics: new CoalescedRequest(),
      activity: new ActivityRefreshScheduler(runActivityRefresh),
      external: new CoalescedRequest(),
    };
    coordinators.current = lifetime;
    return () => {
      if (coordinators.current === lifetime) coordinators.current = undefined;
      closeCoalescedRequest(lifetime.refresh);
      closeCoalescedRequest(lifetime.diagnostics);
      lifetime.activity.close();
      closeCoalescedRequest(lifetime.external);
    };
  }, [libraryGeneration, runActivityRefresh]);

  const runWorkspaceReconciliation = useCallback(async () => {
    const requestGeneration = externalGeneration.current.begin();
    const force = forceWorkspaceReconciliation.current;
    forceWorkspaceReconciliation.current = false;
    let changed = false;
    try {
      changed = await desktopApi.workspaceChanged(libraryGeneration);
    } catch {
      /* A forced or periodic full read remains the actionable fallback. */
    }
    if (!externalGeneration.current.isCurrent(requestGeneration)) return;
    const periodicFullReadDue =
      !document.hidden && Date.now() - lastFullReconciliationAt.current >= 60_000;
    if (force || changed || periodicFullReadDue) {
      try {
        await desktopApi.discoverOrphanedOperations(libraryGeneration);
        if (externalGeneration.current.isCurrent(requestGeneration)) setRecoveryFailure(undefined);
      } catch (error) {
        if (externalGeneration.current.isCurrent(requestGeneration)) setRecoveryFailure({ error });
      }
      if (!externalGeneration.current.isCurrent(requestGeneration)) return;
      invalidateDiagnostics();
    }
    if (force || changed || periodicFullReadDue) await refresh();
  }, [invalidateDiagnostics, libraryGeneration, refresh, setRecoveryFailure]);
  const reconcileWorkspace = useCallback(
    (force = false) => {
      if (force) forceWorkspaceReconciliation.current = true;
      return (
        coordinators.current?.external.request(runWorkspaceReconciliation, libraryGeneration) ??
        Promise.resolve("disposed" as const)
      );
    },
    [libraryGeneration, runWorkspaceReconciliation],
  );
  const retryRecovery = useCallback(async () => {
    await reconcileWorkspace(true);
  }, [reconcileWorkspace]);

  useEffect(() => {
    const activityRequests = activityGeneration.current;
    const diagnosticRequests = diagnosticGeneration.current;
    const externalRequests = externalGeneration.current;
    let closed = false;
    const subscription = startManagedSubscription<
      DesktopEventPayloads["portcove://library-changed"]
    >({
      register: (accept) => listenDesktopEvent("portcove://library-changed", accept),
      onEvent: () => {
        invalidateDiagnostics();
        void reconcileWorkspace(true).catch(() => {
          /* The refresh failure remains visible; this event has no awaiting caller. */
        });
      },
      onFailure: (error) => setSubscriptionFailure({ error }),
    });
    void (async () => {
      await subscription.ready;
      if (closed) return;
      await retryRefresh();
      if (closed) return;
      void refreshDiagnostics();
    })();
    return () => {
      closed = true;
      activityRequests.begin();
      diagnosticRequests.begin();
      externalRequests.begin();
      subscription.stop();
    };
  }, [
    invalidateDiagnostics,
    reconcileWorkspace,
    refreshDiagnostics,
    retryRefresh,
    setSubscriptionFailure,
  ]);

  const activities = activityFeed.records;
  const hasRunningActivity = activityFeed.current_activity_ids.length > 0;
  useEffect(() => {
    let closed = false;
    let timer = 0;
    const interval = () => (hasRunningActivity ? 1000 : document.hidden ? 30_000 : 10_000);
    const schedule = () => {
      if (!closed) timer = window.setTimeout(poll, interval());
    };
    const poll = () => {
      void Promise.allSettled([reconcileWorkspace(), refreshActivities("prompt")]).finally(
        schedule,
      );
    };
    const refreshWhenVisible = () => {
      if (!document.hidden)
        void Promise.allSettled([reconcileWorkspace(true), refreshActivities("prompt")]);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    schedule();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [hasRunningActivity, reconcileWorkspace, refreshActivities]);
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
