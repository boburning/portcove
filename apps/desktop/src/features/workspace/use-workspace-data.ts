import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import type {
  ActivityRecord,
  CatalogDocument,
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

function activitySnapshotIdentity(activities: ActivityRecord[]) {
  return JSON.stringify(activities);
}

function essentialSnapshotIdentity(snapshot: WorkspaceSnapshot) {
  return JSON.stringify([snapshot.catalog, snapshot.statuses, snapshot.sources]);
}

export function usePortcoveData(libraryGeneration = 0) {
  const [catalog, setCatalog] = useState<CatalogDocument>();
  const [statuses, setStatuses] = useState<PortStatus[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [refreshFailure, setRefreshFailure] = useState<{ error: unknown }>();
  const [refreshing, setRefreshing] = useState(false);
  const [diagnosticFailure, setDiagnosticFailure] = useState<{ error: unknown }>();
  const [diagnosticRefreshing, setDiagnosticRefreshing] = useState(false);
  const [diagnosticsStale, setDiagnosticsStale] = useState(true);
  const [diagnosticRevision, setDiagnosticRevision] = useState(0);
  const [subscriptionFailure, setSubscriptionFailure] = useState<{ error: unknown }>();
  const refreshGeneration = useRef(new LatestRequestGeneration());
  const activityGeneration = useRef(new LatestRequestGeneration());
  const diagnosticGeneration = useRef(new LatestRequestGeneration());
  const externalGeneration = useRef(new LatestRequestGeneration());
  const diagnosticInvalidationRevision = useRef(0);
  const activityIdentity = useRef(activitySnapshotIdentity([]));
  const essentialIdentity = useRef<string | undefined>(undefined);
  const lastFullReconciliationAt = useRef(0);
  const forceWorkspaceReconciliation = useRef(false);
  const acceptActivities = useCallback((next: ActivityRecord[]) => {
    const identity = activitySnapshotIdentity(next);
    if (identity === activityIdentity.current) return;
    activityIdentity.current = identity;
    setActivities(next);
  }, []);
  const invalidateDiagnostics = useCallback(() => {
    diagnosticInvalidationRevision.current += 1;
    diagnosticGeneration.current.begin();
    setDiagnosticRevision((revision) => revision + 1);
    setDiagnosticRefreshing(false);
    setDiagnosticsStale(true);
  }, []);
  const runRefresh = useCallback(async () => {
    const generation = refreshGeneration.current.begin();
    const activityRequest = activityGeneration.current.begin();
    setRefreshing(true);
    try {
      const snapshot: WorkspaceSnapshot = await desktopApi.workspaceSnapshot(libraryGeneration);
      if (!refreshGeneration.current.isCurrent(generation)) return;
      const identity = essentialSnapshotIdentity(snapshot);
      if (essentialIdentity.current !== identity) {
        if (essentialIdentity.current !== undefined) invalidateDiagnostics();
        essentialIdentity.current = identity;
        setCatalog(snapshot.catalog);
        setStatuses(snapshot.statuses);
        setSources(snapshot.sources);
      }
      lastFullReconciliationAt.current = Date.now();
      if (activityGeneration.current.isCurrent(activityRequest))
        acceptActivities(snapshot.activities);
      setRefreshFailure(undefined);
    } catch (error) {
      if (!refreshGeneration.current.isCurrent(generation)) return;
      setRefreshFailure({ error });
      throw error;
    } finally {
      if (refreshGeneration.current.isCurrent(generation)) setRefreshing(false);
    }
  }, [acceptActivities, invalidateDiagnostics, libraryGeneration]);
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
  }, [libraryGeneration]);
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
    if (changed) invalidateDiagnostics();
    const periodicFullReadDue =
      !document.hidden && Date.now() - lastFullReconciliationAt.current >= 60_000;
    if (force || changed || periodicFullReadDue) await refresh();
  }, [invalidateDiagnostics, libraryGeneration, refresh]);
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

  useEffect(() => {
    const refreshRequests = refreshGeneration.current;
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
        void reconcileWorkspace(true);
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
      refreshRequests.begin();
      activityRequests.begin();
      diagnosticRequests.begin();
      externalRequests.begin();
      subscription.stop();
    };
  }, [invalidateDiagnostics, reconcileWorkspace, refreshDiagnostics, retryRefresh]);

  const hasRunningActivity = activities.some((activity) => activity.status === "running");
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
    activities,
    doctor,
    storage: doctor?.library,
    refresh,
    refreshAfterMutation,
    retryRefresh,
    refreshActivities,
    refreshFailure,
    refreshing,
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
