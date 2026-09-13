import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import type {
  ActivityRecord,
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateProductionDecision,
  ApplicationUpdateProductionTransition,
  BackupInventory,
  CatalogDocument,
  DoctorReport,
  GithubAuthStatus,
  GithubDeviceLogin,
  OperationEvent,
  PortDefinition,
  PortStatus,
  SourceInspectionReport,
  SourceRecord,
  SourceVerificationOutcome,
  UpdateCheckOutcome,
  WorkspaceSnapshot,
} from "./types";
import type { DetailActions } from "./components/DetailPanel";
import { errorText, isCancellation, type Filter, type View } from "./view-model";
import { currentUpdateSnapshot } from "./view-model";
import { applyOperationEvent, mostRecentOperation } from "./operation-state";
import {
  addPendingOperation,
  closeCoalescedRequest,
  CoalescedRequest,
  LatestRequestGeneration,
  mostRecentPendingOperation,
  removePendingOperation,
} from "./concurrency-state";
import { startManagedSubscription } from "./subscription-lifecycle";

export function useApplicationUpdateChoice(reportError?: (error: unknown) => void) {
  const [preferences, setPreferences] = useState<ApplicationUpdatePreferences>();
  const [dismissedRevision, setDismissedRevision] = useState<number>();
  const accept = useCallback((next: ApplicationUpdatePreferences) => {
    setPreferences((current) => (!current || next.revision >= current.revision ? next : current));
  }, []);
  useEffect(() => {
    let disposed = false;
    void desktopApi
      .applicationUpdatePreferences()
      .then((next) => {
        if (!disposed) accept(next);
      })
      .catch((error: unknown) => {
        if (!disposed) reportError?.(error);
      });
    return () => {
      disposed = true;
    };
  }, [accept, reportError]);
  const choiceRequired = Boolean(
    preferences && !preferences.choice && dismissedRevision !== preferences.revision,
  );
  const dismiss = useCallback(() => {
    if (preferences && !preferences.choice) setDismissedRevision(preferences.revision);
  }, [preferences]);
  return { preferences, choiceRequired, accept, dismiss };
}

export function useApplicationUpdateProductionTransition({
  preferences,
  acceptPreferences,
  reportError,
}: {
  preferences: ApplicationUpdatePreferences | undefined;
  acceptPreferences: (preferences: ApplicationUpdatePreferences) => void;
  reportError?: (error: unknown) => void;
}) {
  const requests = useRef(new LatestRequestGeneration());
  const actions = useRef(new LatestRequestGeneration());
  const [snapshot, setSnapshot] = useState<ApplicationUpdateProductionTransition>();
  const [busy, setBusy] = useState(false);
  const [dismissedRevision, setDismissedRevision] = useState<number>();
  const preferenceRevision = preferences?.revision;

  useEffect(() => {
    const tracker = actions.current;
    return () => {
      tracker.begin();
    };
  }, []);

  useEffect(() => {
    const tracker = requests.current;
    if (preferenceRevision === undefined) return;
    const request = tracker.begin();
    void desktopApi
      .applicationUpdateProductionTransition()
      .then((next) => {
        if (tracker.isCurrent(request)) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (tracker.isCurrent(request)) reportError?.(error);
      });
    return () => {
      tracker.begin();
    };
  }, [preferenceRevision, reportError]);

  const complete = useCallback(
    async (decision: ApplicationUpdateProductionDecision) => {
      if (preferenceRevision === undefined) return false;
      const request = actions.current.begin();
      setBusy(true);
      try {
        const result = await desktopApi.completeApplicationUpdateProductionTransition(
          preferenceRevision,
          decision,
        );
        if (!actions.current.isCurrent(request)) return false;
        acceptPreferences(result.preferences);
        setSnapshot(result.transition);
        return true;
      } catch (error) {
        if (!actions.current.isCurrent(request)) return false;
        reportError?.(error);
        try {
          const [currentPreferences, currentTransition] = await Promise.all([
            desktopApi.applicationUpdatePreferences(),
            desktopApi.applicationUpdateProductionTransition(),
          ]);
          if (actions.current.isCurrent(request)) {
            acceptPreferences(currentPreferences);
            setSnapshot(currentTransition);
          }
        } catch {
          // The original typed error remains the actionable report.
        }
        return false;
      } finally {
        if (actions.current.isCurrent(request)) setBusy(false);
      }
    },
    [acceptPreferences, preferenceRevision, reportError],
  );

  const offerRequired = Boolean(
    snapshot?.offer_required &&
    snapshot.preference_revision === preferenceRevision &&
    dismissedRevision !== preferenceRevision,
  );
  const dismiss = useCallback(() => {
    if (snapshot?.offer_required) setDismissedRevision(snapshot.preference_revision);
  }, [snapshot]);
  return { snapshot, offerRequired, busy, complete, dismiss };
}

export function useApplicationUpdateNotice(reportError?: (error: unknown) => void) {
  const [snapshot, setSnapshot] = useState<ApplicationUpdateNoticeSnapshot>();
  const accept = useCallback((next: ApplicationUpdateNoticeSnapshot) => {
    setSnapshot((current) => (!current || next.revision >= current.revision ? next : current));
  }, []);
  useEffect(() => {
    let disposed = false;
    const subscription = startManagedSubscription<ApplicationUpdateNoticeSnapshot>({
      register: (acceptEvent) =>
        listen<ApplicationUpdateNoticeSnapshot>("portcove://application-update-notice", (event) =>
          acceptEvent(event.payload),
        ),
      onEvent: accept,
    });
    void (async () => {
      await subscription.ready;
      if (disposed) return;
      try {
        accept(await desktopApi.applicationUpdateNotice());
      } catch {
        /* Settings owns actionable updater-state recovery; this surface is optional. */
      }
    })();
    return () => {
      disposed = true;
      subscription.stop();
    };
  }, [accept]);
  const dismiss = useCallback(async () => {
    if (!snapshot?.notice) return;
    try {
      accept(await desktopApi.dismissApplicationUpdateNotice(snapshot.revision));
    } catch (error) {
      reportError?.(error);
    }
  }, [accept, reportError, snapshot]);
  return { snapshot, notice: snapshot?.notice, dismiss };
}

function activitySnapshotIdentity(activities: ActivityRecord[]) {
  return JSON.stringify(activities);
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
  const [subscriptionFailure, setSubscriptionFailure] = useState<{ error: unknown }>();
  const refreshGeneration = useRef(new LatestRequestGeneration());
  const activityGeneration = useRef(new LatestRequestGeneration());
  const diagnosticGeneration = useRef(new LatestRequestGeneration());
  const activityIdentity = useRef(activitySnapshotIdentity([]));
  const acceptActivities = useCallback((next: ActivityRecord[]) => {
    const identity = activitySnapshotIdentity(next);
    if (identity === activityIdentity.current) return;
    activityIdentity.current = identity;
    setActivities(next);
  }, []);
  const runRefresh = useCallback(async () => {
    const generation = refreshGeneration.current.begin();
    const activityRequest = activityGeneration.current.begin();
    setRefreshing(true);
    try {
      const snapshot: WorkspaceSnapshot = await desktopApi.workspaceSnapshot(libraryGeneration);
      if (!refreshGeneration.current.isCurrent(generation)) return;
      setCatalog(snapshot.catalog);
      setStatuses(snapshot.statuses);
      setSources(snapshot.sources);
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
  }, [acceptActivities, libraryGeneration]);
  const coordinators = useRef<
    | {
        refresh: CoalescedRequest;
        diagnostics: CoalescedRequest;
        activity: CoalescedRequest;
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

  const runDiagnostics = useCallback(async () => {
    const generation = diagnosticGeneration.current.begin();
    setDiagnosticRefreshing(true);
    try {
      const next = await desktopApi.doctor(libraryGeneration);
      if (!diagnosticGeneration.current.isCurrent(generation)) return;
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
  const invalidateDiagnostics = useCallback(() => {
    diagnosticGeneration.current.begin();
    setDiagnosticRefreshing(false);
    setDiagnosticsStale(true);
  }, []);

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
    () =>
      coordinators.current?.activity.request(runActivityRefresh, libraryGeneration) ??
      Promise.resolve("disposed" as const),
    [libraryGeneration, runActivityRefresh],
  );

  useEffect(() => {
    const lifetime = {
      refresh: new CoalescedRequest(),
      diagnostics: new CoalescedRequest(),
      activity: new CoalescedRequest(),
    };
    coordinators.current = lifetime;
    return () => {
      if (coordinators.current === lifetime) coordinators.current = undefined;
      closeCoalescedRequest(lifetime.refresh);
      closeCoalescedRequest(lifetime.diagnostics);
      closeCoalescedRequest(lifetime.activity);
    };
  }, [libraryGeneration]);

  useEffect(() => {
    const refreshRequests = refreshGeneration.current;
    const activityRequests = activityGeneration.current;
    const diagnosticRequests = diagnosticGeneration.current;
    let closed = false;
    const subscription = startManagedSubscription<string>({
      register: (accept) =>
        listen<string>("portcove://library-changed", (event) => accept(event.payload)),
      onEvent: () => {
        invalidateDiagnostics();
        void retryRefresh();
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
      subscription.stop();
    };
  }, [invalidateDiagnostics, refreshDiagnostics, retryRefresh]);

  const hasRunningActivity = activities.some((activity) => activity.status === "running");
  useEffect(() => {
    let closed = false;
    let timer = 0;
    const interval = () => (hasRunningActivity ? 1000 : document.hidden ? 30_000 : 10_000);
    const schedule = () => {
      if (!closed) timer = window.setTimeout(poll, interval());
    };
    const poll = () => {
      void refreshActivities().finally(schedule);
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) void refreshActivities();
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
  }, [hasRunningActivity, refreshActivities]);
  return {
    catalog,
    statuses,
    sources,
    activities,
    doctor,
    storage: doctor?.library,
    refresh,
    retryRefresh,
    refreshActivities,
    refreshFailure,
    refreshing,
    refreshDiagnostics,
    invalidateDiagnostics,
    diagnosticFailure,
    diagnosticRefreshing,
    diagnosticsStale,
    subscriptionFailure,
  };
}

export type OperationRefresh = "workspace" | "activities" | "none";

export function useOperationState(
  configuration:
    | (() => Promise<unknown>)
    | {
        refresh: () => Promise<unknown>;
        refreshActivities?: () => Promise<unknown>;
        invalidateDiagnostics?: () => void;
      },
) {
  const refresh = typeof configuration === "function" ? configuration : configuration.refresh;
  const refreshActivities =
    typeof configuration === "function"
      ? configuration
      : (configuration.refreshActivities ?? configuration.refresh);
  const invalidateDiagnostics =
    typeof configuration === "function" ? undefined : configuration.invalidateDiagnostics;
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
      register: (accept) =>
        listen<OperationEvent>("portcove://operation", (event) => accept(event.payload)),
      onEvent: (payload) => {
        setOperationEvents((current) => applyOperationEvent(current, payload));
        void refreshActivities();
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

export function useUpdateCenter(perform: Perform, statuses: PortStatus[]) {
  const snapshots = statuses.flatMap((status) => {
    const snapshot = currentUpdateSnapshot(status);
    return snapshot
      ? [
          {
            port_id: status.port_id,
            ok: true,
            error: null,
            result: snapshot.check,
          } satisfies UpdateCheckOutcome,
        ]
      : [];
  });
  const snapshotBaseline = snapshots
    .map(
      (outcome) =>
        `${outcome.port_id}:${outcome.result?.release.asset.sha256}:${outcome.result?.installed_artifact?.sha256}:${JSON.stringify(outcome.result?.required_runtime)}:${JSON.stringify(outcome.result?.installed_runtime)}`,
    )
    .join("|");
  const [checked, setChecked] = useState<{
    baseline: string;
    outcomes: UpdateCheckOutcome[];
  }>();
  const outcomes = checked?.baseline === snapshotBaseline ? checked.outcomes : snapshots;
  const checkAll = useCallback(async () => {
    const result = await perform("check installed", desktopApi.checkInstalled, {
      refresh: "workspace",
      invalidateDiagnostics: false,
    });
    if (result) {
      setChecked({ baseline: snapshotBaseline, outcomes: result });
    }
  }, [perform, snapshotBaseline]);
  return { outcomes, checkAll };
}

// Review data is ephemeral UI intent; core still authorizes every mutation.
function useReviewRequest<T>(identity: string, perform: Perform) {
  const generation = useRef(new LatestRequestGeneration());
  const [reviewed, setReviewed] = useState<{ identity: string; value: T }>();
  useLayoutEffect(() => {
    const requests = generation.current;
    requests.begin();
    return () => {
      requests.begin();
    };
  }, [identity]);
  const review = async (name: string, task: () => Promise<T>) => {
    const request = generation.current.begin();
    setReviewed(undefined);
    const current = () => generation.current.isCurrent(request);
    const result = await perform(
      name,
      async () => {
        try {
          return await task();
        } catch (error) {
          if (current()) throw error;
          return undefined;
        }
      },
      { refresh: "none", invalidateDiagnostics: false },
    );
    if (result !== undefined && current()) setReviewed({ identity, value: result });
  };
  const guard = () => {
    const request = generation.current.begin();
    return () => generation.current.isCurrent(request);
  };
  const invalidate = (expected?: T) => {
    if (expected === undefined) {
      generation.current.begin();
      setReviewed(undefined);
      return;
    }
    setReviewed((current) => (current?.value === expected ? undefined : current));
  };
  return {
    value: reviewed?.identity === identity ? reviewed.value : undefined,
    review,
    guard,
    invalidate,
  };
}

export function useInstallPlanning(
  portId: string | undefined,
  channel: PortStatus["channel"] | undefined,
  perform: Perform,
) {
  const request = useReviewRequest<Awaited<ReturnType<typeof desktopApi.plan>>>(
    JSON.stringify([portId, channel]),
    perform,
  );
  const review = async () => {
    if (portId && channel)
      await request.review("review install", () => desktopApi.plan(portId, channel));
  };
  return { plan: request.value, review, invalidate: request.invalidate };
}

export function useAdoptionPlanning(
  path: string,
  portId: string | undefined,
  open: boolean,
  generation: number,
  perform: Perform,
  done: () => void,
) {
  const identity = JSON.stringify([path, portId, open, generation]);
  const request = useReviewRequest<Awaited<ReturnType<typeof desktopApi.previewAdoption>>>(
    identity,
    perform,
  );
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [completedIdentity, setCompletedIdentity] = useState<string>();
  const notifiedCompletion = useRef<string | undefined>(undefined);
  const review = async () => {
    setFailedIdentity(undefined);
    if (open && path.trim())
      await request.review("preview adoption", () =>
        desktopApi.previewAdoption(path, generation, portId),
      );
  };
  const inFlight = useRef(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    if (completedIdentity !== identity || applying || request.value !== undefined) return;
    if (notifiedCompletion.current === completedIdentity) return;
    notifiedCompletion.current = completedIdentity;
    done();
  }, [applying, completedIdentity, done, identity, request.value]);
  const adopt = async () => {
    const preview = request.value;
    if (!open || !preview?.selected_port_id || inFlight.current) return;
    inFlight.current = true;
    notifiedCompletion.current = undefined;
    setCompletedIdentity(undefined);
    setApplying(true);
    const current = request.guard();
    request.invalidate(preview);
    let adopted: Awaited<ReturnType<typeof desktopApi.adopt>> | undefined;
    try {
      adopted = await perform("adopt", () =>
        desktopApi.adopt(path, preview.plan_sha256, generation, portId),
      );
    } finally {
      inFlight.current = false;
      setApplying(false);
    }
    if (current()) {
      if (adopted !== undefined) setCompletedIdentity(identity);
      else setFailedIdentity(identity);
    }
  };
  return {
    preview: request.value,
    review,
    adopt,
    invalidate: request.invalidate,
    applying,
    copyFailed: failedIdentity === identity,
  };
}

export function useSourceHealth(
  perform: Perform,
  sources: SourceRecord[],
  requestedProfileIds: readonly string[] = [],
  catalogIdentity = "",
) {
  const [verified, setVerified] = useState<{
    baseline: string;
    outcomes: SourceVerificationOutcome[];
  }>();
  const [inspected, setInspected] = useState<{
    baseline: string;
    inspections: ReadonlyMap<string, SourceInspectionReport>;
  }>();
  const generation = useRef(new LatestRequestGeneration());
  const requested = new Set(requestedProfileIds);
  const inspectionSources = sources.filter((source) => requested.has(source.profile_id));
  const baseline = `${catalogIdentity}|${JSON.stringify(inspectionSources)}`;
  const inspectionInput = useRef({ baseline, sources: inspectionSources });
  useLayoutEffect(() => {
    inspectionInput.current = { baseline, sources: inspectionSources };
  });
  const inspectAll = useCallback(async () => {
    const { baseline: currentBaseline, sources: currentSources } = inspectionInput.current;
    const request = generation.current.begin();
    const results = await Promise.allSettled(
      currentSources.map((source) => desktopApi.inspectSource(source.profile_id)),
    );
    if (!generation.current.isCurrent(request)) return;
    setInspected({
      baseline: currentBaseline,
      inspections: new Map(
        results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [[currentSources[index].profile_id, result.value] as const]
            : [],
        ),
      ),
    });
  }, []);
  useEffect(() => {
    const requests = generation.current;
    requests.begin();
    void inspectAll();
    return () => {
      requests.begin();
    };
  }, [baseline, inspectAll]);
  const verifyAll = useCallback(async () => {
    const result = await perform("verify sources", desktopApi.verifySources);
    if (result) setVerified({ baseline, outcomes: result });
    await inspectAll();
  }, [baseline, inspectAll, perform]);
  const outcomes = verified?.baseline === baseline ? verified.outcomes : [];
  const inspections =
    inspected?.baseline === baseline
      ? inspected.inspections
      : new Map<string, SourceInspectionReport>();
  return { outcomes, inspections, inspectAll, verifyAll };
}

export function usePortBackups(portId: string | undefined, setError: (error?: string) => void) {
  const emptyInventory = useCallback(
    (): BackupInventory => ({
      port_id: portId ?? "",
      state: "healthy",
      backups: [],
      problems: [],
    }),
    [portId],
  );
  const [inventory, setInventory] = useState<BackupInventory>(() => emptyInventory());
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    if (!portId) return;
    try {
      const result = await desktopApi.backups(portId);
      if (request === requestId.current) setInventory(result);
    } catch (value) {
      if (request === requestId.current) setError(errorText(value));
    }
  }, [portId, setError]);
  useEffect(() => {
    if (portId) {
      const request = ++requestId.current;
      void desktopApi
        .backups(portId)
        .then((result) => {
          if (request === requestId.current) setInventory(result);
        })
        .catch((value) => {
          if (request === requestId.current) setError(errorText(value));
        });
    }
    return () => {
      requestId.current += 1;
    };
  }, [portId, setError]);
  const currentInventory = inventory.port_id === (portId ?? "") ? inventory : emptyInventory();
  return { backups: currentInventory.backups, inventory: currentInventory, refresh };
}

export function useGithubAuth(perform: Perform, setError: (error?: string) => void) {
  const [status, setStatus] = useState<GithubAuthStatus>();
  const [token, setToken] = useState("");
  const [deviceLogin, setDeviceLogin] = useState<GithubDeviceLogin>();
  const refresh = useCallback(async () => {
    try {
      setStatus(await desktopApi.githubAuthStatus());
    } catch (value) {
      setError(errorText(value));
    }
  }, [setError]);
  useEffect(() => {
    let current = true;
    void desktopApi
      .githubAuthStatus()
      .then((result) => {
        if (current) setStatus(result);
      })
      .catch((value) => {
        if (current) setError(errorText(value));
      });
    return () => {
      current = false;
    };
  }, [setError]);
  useEffect(() => {
    if (!deviceLogin) return;
    let cancelled = false;
    const delay = Math.max(1, deviceLogin.interval_seconds) * 1000;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await desktopApi.pollGithubDeviceLogin(deviceLogin.session_id);
        if (cancelled) return;
        if (result.state === "complete") {
          setStatus(result.status ?? undefined);
          setDeviceLogin(undefined);
        } else {
          timer = window.setTimeout(() => {
            void poll();
          }, delay);
        }
      } catch (value) {
        if (!cancelled) {
          setError(errorText(value));
          setDeviceLogin(undefined);
        }
      }
    };
    timer = window.setTimeout(() => {
      void poll();
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deviceLogin, setError]);
  const saveToken = useCallback(async () => {
    const result = await perform("GitHub authentication", () => desktopApi.setGithubToken(token), {
      refresh: "none",
      invalidateDiagnostics: false,
    });
    if (result) {
      setStatus(result);
      setToken("");
    }
  }, [perform, token]);
  const logout = useCallback(async () => {
    const result = await perform("GitHub logout", desktopApi.logoutGithub, {
      refresh: "none",
      invalidateDiagnostics: false,
    });
    if (result) setStatus(result);
  }, [perform]);
  const beginDeviceLogin = useCallback(async () => {
    const result = await perform("GitHub login", desktopApi.beginGithubDeviceLogin, {
      refresh: "none",
      invalidateDiagnostics: false,
    });
    if (result) setDeviceLogin(result);
  }, [perform]);
  return {
    status,
    token,
    setToken,
    deviceLogin,
    saveToken,
    logout,
    beginDeviceLogin,
    refresh,
  };
}

export function usePortcoveUi() {
  const [view, setViewState] = useState<View>("library");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [sourcePath, setSourcePath] = useState("");
  const [biosPath, setBiosPath] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptPath, setAdoptPath] = useState("");
  const setView = useCallback((nextView: SetStateAction<View>) => {
    setViewState((current) => (typeof nextView === "function" ? nextView(current) : nextView));
    setFilter("all");
  }, []);
  return {
    view,
    setView,
    filter,
    setFilter,
    query,
    setQuery,
    selectedId,
    setSelectedId,
    sourcePath,
    setSourcePath,
    biosPath,
    setBiosPath,
    adoptOpen,
    setAdoptOpen,
    adoptPath,
    setAdoptPath,
  };
}

export type Perform = <T>(
  name: string,
  task: () => Promise<T>,
  options?: { refresh?: OperationRefresh; invalidateDiagnostics?: boolean },
) => Promise<T | undefined>;

export function detailActions(
  port: PortDefinition,
  status: PortStatus | undefined,
  sourcePath: string,
  biosPath: string,
  perform: Perform,
  close: () => void,
  reviewInstall: DetailActions["reviewInstall"] = () => undefined,
  backupsChanged: () => Promise<void> = () => Promise.resolve(),
  libraryGeneration = 0,
): DetailActions {
  return {
    activate: () =>
      status?.staged
        ? perform("activate staged update", () =>
            desktopApi.activate(
              port.id,
              status.active?.id ?? null,
              status.staged!.id,
              libraryGeneration,
            ),
          )
        : undefined,
    backup: async () => {
      if (await perform("back up data", () => desktopApi.backup(port.id))) await backupsChanged();
    },
    check: () =>
      perform("check", () => desktopApi.check(port.id, libraryGeneration), {
        refresh: "workspace",
        invalidateDiagnostics: false,
      }),
    close,
    install: () =>
      perform("install", () =>
        desktopApi.install(
          port.id,
          status?.channel ?? port.channels[0],
          sourcePath,
          biosPath,
          false,
        ),
      ),
    launch: () => perform("launch", () => desktopApi.launch(port.id, sourcePath)),
    openUserData: () =>
      perform("open data folder", () => desktopApi.openUserData(port.id), {
        refresh: "none",
        invalidateDiagnostics: false,
      }),
    reviewInstall,
    remove: async (expectedPreview) => {
      const removed = await perform("remove", () =>
        desktopApi.remove(port.id, expectedPreview, libraryGeneration),
      );
      if (removed) close();
      return removed === null ? "cancelled" : Boolean(removed);
    },
    deleteBackup: async (backup, expectedPreview) => {
      const result = await perform("delete backup", () =>
        desktopApi.deleteBackup(port.id, backup.id, expectedPreview, libraryGeneration),
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    rollback: () => perform("rollback", () => desktopApi.rollback(port.id)),
    restoreBackup: async (backup, expectedPreview) => {
      const result = await perform("restore backup", () =>
        desktopApi.restoreBackup(port.id, backup.id, expectedPreview, libraryGeneration),
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    setChannel: (channel) =>
      perform("channel", () => desktopApi.setChannel(port.id, channel, libraryGeneration)),
    setPolicy: (policy) =>
      perform("policy", () => desktopApi.setPolicy(port.id, policy, libraryGeneration)),
    verify: () => perform("verify", () => desktopApi.verify(port.id)),
  };
}
