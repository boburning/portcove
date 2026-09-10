import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import type {
  ActivityRecord,
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
} from "./types";
import type { DetailActions } from "./components/DetailPanel";
import {
  errorText,
  isCancellation,
  type Filter,
  type View,
} from "./view-model";
import { currentUpdateSnapshot } from "./view-model";
import { applyOperationEvent, mostRecentOperation } from "./operation-state";
import {
  addPendingOperation,
  LatestRequestGeneration,
  mostRecentPendingOperation,
  removePendingOperation,
} from "./concurrency-state";

export function usePortcoveData() {
  const [catalog, setCatalog] = useState<CatalogDocument>();
  const [statuses, setStatuses] = useState<PortStatus[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport>();
  const [refreshFailure, setRefreshFailure] = useState<{ error: unknown }>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshGeneration = useRef(new LatestRequestGeneration());
  const activityGeneration = useRef(new LatestRequestGeneration());
  const refresh = useCallback(async () => {
    const generation = refreshGeneration.current.begin();
    const activityRequest = activityGeneration.current.begin();
    setRefreshing(true);
    try {
      const [
        nextCatalog,
        nextStatuses,
        nextSources,
        nextActivities,
        nextDoctor,
      ] = await Promise.all([
        desktopApi.catalog(),
        desktopApi.statuses(),
        desktopApi.sources(),
        desktopApi.activities(),
        desktopApi.doctor(),
      ]);
      if (!refreshGeneration.current.isCurrent(generation)) return;
      setCatalog(nextCatalog);
      setStatuses(nextStatuses);
      setSources(nextSources);
      if (activityGeneration.current.isCurrent(activityRequest))
        setActivities(nextActivities);
      setDoctor(nextDoctor);
      setRefreshFailure(undefined);
    } catch (error) {
      if (!refreshGeneration.current.isCurrent(generation)) return;
      setRefreshFailure({ error });
      throw error;
    } finally {
      if (refreshGeneration.current.isCurrent(generation)) setRefreshing(false);
    }
  }, []);
  const retryRefresh = useCallback(async () => {
    try {
      await refresh();
    } catch {
      /* The refresh failure remains visible independently of mutation outcomes. */
    }
  }, [refresh]);
  useEffect(() => {
    const refreshRequests = refreshGeneration.current;
    const activityRequests = activityGeneration.current;
    const unlisten = listen<string>("portcove://library-changed", () => {
      void retryRefresh();
    });
    return () => {
      refreshRequests.begin();
      activityRequests.begin();
      void unlisten.then((dispose) => dispose());
    };
  }, [retryRefresh]);
  useEffect(() => {
    let closed = false;
    let timer = 0;
    const poll = async () => {
      const generation = activityGeneration.current.begin();
      try {
        const next = await desktopApi.activities();
        if (!closed && activityGeneration.current.isCurrent(generation))
          setActivities(next);
      } catch {
        /* Full refresh reports IPC failures; keep the last known ledger while polling. */
      }
      if (!closed)
        timer = window.setTimeout(() => {
          void poll();
        }, 1000);
    };
    timer = window.setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      closed = true;
      window.clearTimeout(timer);
    };
  }, []);
  return {
    catalog,
    statuses,
    sources,
    activities,
    doctor,
    storage: doctor?.library,
    refresh,
    retryRefresh,
    refreshFailure,
    refreshing,
  };
}

export function useOperationState(refresh: () => Promise<void>) {
  const [pendingOperations, setPendingOperations] = useState<
    ReadonlyMap<number, string>
  >(new Map());
  const nextPendingId = useRef(0);
  const busy = mostRecentPendingOperation(pendingOperations);
  const [error, setError] = useState<unknown>();
  const [operationEvents, setOperationEvents] = useState<
    ReadonlyMap<string, OperationEvent>
  >(new Map());
  const operation = mostRecentOperation(operationEvents);
  useEffect(() => {
    const unlisten = listen<OperationEvent>("portcove://operation", (event) => {
      setOperationEvents((current) =>
        applyOperationEvent(current, event.payload),
      );
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);
  const perform = useCallback(
    async <T>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
      const pendingId = ++nextPendingId.current;
      setPendingOperations((current) =>
        addPendingOperation(current, pendingId, name),
      );
      setError(undefined);
      const runningRefresh = window.setTimeout(() => {
        void refresh().catch((value: unknown) =>
          setError((current: unknown) => current ?? value),
        );
      }, 250);
      try {
        const result = await task();
        return result;
      } catch (value) {
        if (!isCancellation(value)) setError(value);
      } finally {
        window.clearTimeout(runningRefresh);
        try {
          await refresh();
        } catch (value) {
          setError((current: unknown) => current ?? value);
        }
        setPendingOperations((current) =>
          removePendingOperation(current, pendingId),
        );
      }
    },
    [refresh],
  );
  return { busy, error, operation, pendingOperations, perform, setError };
}

export function useUpdateCenter(perform: Perform, statuses: PortStatus[]) {
  const [outcomes, setOutcomes] = useState<UpdateCheckOutcome[]>([]);
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
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const snapshotBaseline = snapshots
    .map(
      (outcome) =>
        `${outcome.port_id}:${outcome.result?.release.asset.sha256}:${outcome.result?.installed_artifact?.sha256}:${JSON.stringify(outcome.result?.required_runtime)}:${JSON.stringify(outcome.result?.installed_runtime)}`,
    )
    .join("|");
  useEffect(() => {
    setOutcomes(snapshotsRef.current);
  }, [snapshotBaseline]);
  const checkAll = useCallback(async () => {
    const result = await perform("check installed", desktopApi.checkInstalled);
    if (result) {
      setOutcomes(result);
    }
  }, [perform]);
  return { outcomes, checkAll };
}

// Review data is ephemeral UI intent; core still authorizes every mutation.
function useReviewRequest<T>(identity: string, perform: Perform) {
  const generation = useRef(new LatestRequestGeneration());
  const [reviewed, setReviewed] = useState<{ identity: string; value: T }>();
  useLayoutEffect(() => {
    const requests = generation.current;
    requests.begin();
    setReviewed(undefined);
    return () => {
      requests.begin();
    };
  }, [identity]);
  const review = async (name: string, task: () => Promise<T>) => {
    const request = generation.current.begin();
    setReviewed(undefined);
    const current = () => generation.current.isCurrent(request);
    const result = await perform(name, async () => {
      try {
        return await task();
      } catch (error) {
        if (current()) throw error;
        return undefined;
      }
    });
    if (result !== undefined && current())
      setReviewed({ identity, value: result });
  };
  const guard = () => {
    const request = generation.current.begin();
    return () => generation.current.isCurrent(request);
  };
  const invalidate = () => {
    generation.current.begin();
    setReviewed(undefined);
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
      await request.review("review install", () =>
        desktopApi.plan(portId, channel),
      );
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
  const request = useReviewRequest<
    Awaited<ReturnType<typeof desktopApi.previewAdoption>>
  >(identity, perform);
  const [failedIdentity, setFailedIdentity] = useState<string>();
  useLayoutEffect(() => {
    setFailedIdentity(undefined);
  }, [identity]);
  const review = async () => {
    setFailedIdentity(undefined);
    if (open && path.trim())
      await request.review("preview adoption", () =>
        desktopApi.previewAdoption(path, generation, portId),
      );
  };
  const inFlight = useRef(false);
  const [applying, setApplying] = useState(false);
  const adopt = async () => {
    if (!open || !request.value?.selected_port_id || inFlight.current) return;
    inFlight.current = true;
    setApplying(true);
    const current = request.guard();
    try {
      const adopted = await perform("adopt", () =>
        desktopApi.adopt(path, request.value!.plan_sha256, generation, portId),
      );
      if (current()) {
        request.invalidate();
        if (adopted !== undefined) done();
        else setFailedIdentity(identity);
      }
    } finally {
      inFlight.current = false;
      setApplying(false);
    }
  };
  return {
    preview: request.value,
    review,
    adopt,
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
  const [outcomes, setOutcomes] = useState<SourceVerificationOutcome[]>([]);
  const [inspections, setInspections] = useState<
    ReadonlyMap<string, SourceInspectionReport>
  >(new Map());
  const generation = useRef(new LatestRequestGeneration());
  const requested = new Set(requestedProfileIds);
  const inspectionSources = sources.filter((source) =>
    requested.has(source.profile_id),
  );
  const inspectionSourcesRef = useRef(inspectionSources);
  inspectionSourcesRef.current = inspectionSources;
  const baseline = `${catalogIdentity}|${JSON.stringify(inspectionSources)}`;
  const inspectAll = useCallback(async () => {
    const currentSources = inspectionSourcesRef.current;
    const request = generation.current.begin();
    const results = await Promise.allSettled(
      currentSources.map((source) =>
        desktopApi.inspectSource(source.profile_id),
      ),
    );
    if (!generation.current.isCurrent(request)) return;
    setInspections(
      new Map(
        results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [[currentSources[index].profile_id, result.value] as const]
            : [],
        ),
      ),
    );
  }, []);
  useEffect(() => {
    const requests = generation.current;
    requests.begin();
    setOutcomes([]);
    setInspections(new Map());
    void inspectAll();
    return () => {
      requests.begin();
    };
  }, [baseline, inspectAll]);
  const verifyAll = useCallback(async () => {
    const result = await perform("verify sources", desktopApi.verifySources);
    if (result) setOutcomes(result);
    await inspectAll();
  }, [inspectAll, perform]);
  return { outcomes, inspections, inspectAll, verifyAll };
}

export function usePortBackups(
  portId: string | undefined,
  setError: (error?: string) => void,
) {
  const emptyInventory = useCallback(
    (): BackupInventory => ({
      port_id: portId ?? "",
      state: "healthy",
      backups: [],
      problems: [],
    }),
    [portId],
  );
  const [inventory, setInventory] = useState<BackupInventory>(() =>
    emptyInventory(),
  );
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    if (!portId) {
      setInventory(emptyInventory());
      return;
    }
    try {
      const result = await desktopApi.backups(portId);
      if (request === requestId.current) setInventory(result);
    } catch (value) {
      if (request === requestId.current) setError(errorText(value));
    }
  }, [emptyInventory, portId, setError]);
  useEffect(() => {
    setInventory(emptyInventory());
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [emptyInventory, refresh]);
  return { backups: inventory.backups, inventory, refresh };
}

export function useGithubAuth(
  perform: Perform,
  setError: (error?: string) => void,
) {
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
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!deviceLogin) return;
    let cancelled = false;
    const delay = Math.max(1, deviceLogin.interval_seconds) * 1000;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await desktopApi.pollGithubDeviceLogin(
          deviceLogin.session_id,
        );
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
    const result = await perform("GitHub authentication", () =>
      desktopApi.setGithubToken(token),
    );
    if (result) {
      setStatus(result);
      setToken("");
    }
  }, [perform, token]);
  const logout = useCallback(async () => {
    const result = await perform("GitHub logout", desktopApi.logoutGithub);
    if (result) setStatus(result);
  }, [perform]);
  const beginDeviceLogin = useCallback(async () => {
    const result = await perform(
      "GitHub login",
      desktopApi.beginGithubDeviceLogin,
    );
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
  const [view, setView] = useState<View>("library");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [sourcePath, setSourcePath] = useState("");
  const [biosPath, setBiosPath] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptPath, setAdoptPath] = useState("");
  useEffect(() => setFilter("all"), [view]);
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
      if (await perform("back up data", () => desktopApi.backup(port.id)))
        await backupsChanged();
    },
    check: () =>
      perform("check", () => desktopApi.check(port.id, libraryGeneration)),
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
    launch: () =>
      perform("launch", () => desktopApi.launch(port.id, sourcePath)),
    openUserData: () =>
      perform("open data folder", () => desktopApi.openUserData(port.id)),
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
        desktopApi.deleteBackup(
          port.id,
          backup.id,
          expectedPreview,
          libraryGeneration,
        ),
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    rollback: () => perform("rollback", () => desktopApi.rollback(port.id)),
    restoreBackup: async (backup, expectedPreview) => {
      const result = await perform("restore backup", () =>
        desktopApi.restoreBackup(
          port.id,
          backup.id,
          expectedPreview,
          libraryGeneration,
        ),
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    setChannel: (channel) =>
      perform("channel", () =>
        desktopApi.setChannel(port.id, channel, libraryGeneration),
      ),
    setPolicy: (policy) =>
      perform("policy", () =>
        desktopApi.setPolicy(port.id, policy, libraryGeneration),
      ),
    verify: () => perform("verify", () => desktopApi.verify(port.id)),
  };
}
