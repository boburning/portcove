import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import { confirmBackupDeletion, confirmBackupRestore, confirmPortRemoval } from "./confirmation";
import { useGamepadNavigation } from "./gamepad";
import type { ActivityRecord, BackupRecord, CatalogDocument, GithubAuthStatus, GithubDeviceLogin, OperationEvent, PortDefinition, PortStatus, ReconcileAction, SourceRecord, SourceVerificationOutcome, UpdateCheckOutcome } from "./types";
import type { DetailActions } from "./components/DetailPanel";
import { errorText, type Filter, type View } from "./view-model";
import { currentUpdateSnapshot } from "./view-model";

export function usePortcoveData() {
  const [catalog, setCatalog] = useState<CatalogDocument>();
  const [statuses, setStatuses] = useState<PortStatus[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof desktopApi.storage>>>();
  const refresh = useCallback(async () => {
    const [nextCatalog, nextStatuses, nextSources, nextActivities, nextStorage] = await Promise.all([
      desktopApi.catalog(), desktopApi.statuses(), desktopApi.sources(), desktopApi.activities(), desktopApi.storage(),
    ]);
    setCatalog(nextCatalog);
    setStatuses(nextStatuses);
    setSources(nextSources);
    setActivities(nextActivities);
    setStorage(nextStorage);
  }, []);
  useEffect(() => {
    const unlisten = listen<string>("portcove://library-changed", () => { void refresh(); });
    return () => { unlisten.then(dispose => dispose()); };
  }, [refresh]);
  return { catalog, statuses, sources, activities, storage, refresh };
}

export function useOperationState(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<OperationEvent>();
  useEffect(() => {
    const unlisten = listen<OperationEvent>("portcove://operation", event => setOperation(event.payload));
    return () => { unlisten.then(dispose => dispose()); };
  }, []);
  const perform = useCallback(async <T,>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(undefined);
    setOperation(undefined);
    const runningRefresh = window.setTimeout(() => {
      void refresh().catch(value => setError(current => current ?? errorText(value)));
    }, 250);
    try {
      const result = await task();
      return result;
    } catch (value) {
      setError(errorText(value));
    } finally {
      window.clearTimeout(runningRefresh);
      try {
        await refresh();
      } catch (value) {
        setError(current => current ?? errorText(value));
      }
      setBusy(undefined);
    }
  }, [refresh]);
  return { busy, error, operation, perform, setError };
}

export function useUpdateCenter(perform: Perform, statuses: PortStatus[]) {
  const [outcomes, setOutcomes] = useState<UpdateCheckOutcome[]>([]);
  const [actions, setActions] = useState<Map<string, ReconcileAction>>(new Map());
  const snapshots = statuses.flatMap(status => {
    const snapshot = currentUpdateSnapshot(status);
    return snapshot ? [{ port_id: status.port_id, ok: true, result: snapshot.check } satisfies UpdateCheckOutcome] : [];
  });
  const snapshotBaseline = snapshots.map(outcome => `${outcome.port_id}:${outcome.result?.release.version}:${outcome.result?.installed_version}`).join("|");
  useEffect(() => {
    setOutcomes(snapshots);
    setActions(new Map());
  }, [snapshotBaseline]);
  const checkAll = useCallback(async () => {
    const result = await perform("check installed", desktopApi.checkInstalled);
    if (result) {
      setOutcomes(result);
      setActions(new Map());
    }
  }, [perform]);
  const applyPolicies = useCallback(async () => {
    const result = await perform("apply policies", desktopApi.reconcileInstalled);
    if (result) {
      setOutcomes(result.map(outcome => ({
        port_id: outcome.port_id,
        ok: outcome.ok,
        result: outcome.result?.check,
        error: outcome.error,
      })));
      setActions(new Map(result.flatMap(outcome => outcome.result ? [[outcome.port_id, outcome.result.action] as const] : [])));
    }
  }, [perform]);
  return { outcomes, actions, checkAll, applyPolicies };
}

export function useInstallPlanning(portId: string | undefined, channel: PortStatus["channel"] | undefined, perform: Perform) {
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof desktopApi.plan>>>();
  useEffect(() => setPlan(undefined), [portId, channel]);
  const review = useCallback(async () => {
    if (!portId || !channel) return;
    setPlan(undefined);
    const result = await perform("review install", () => desktopApi.plan(portId, channel));
    if (result) setPlan(result);
  }, [channel, perform, portId]);
  return { plan, review };
}

export function useSourceHealth(perform: Perform, sources: SourceRecord[]) {
  const [outcomes, setOutcomes] = useState<SourceVerificationOutcome[]>([]);
  const baseline = sources.map(source => `${source.profile_id}:${source.sha256}:${source.size}:${source.path}`).join("|");
  useEffect(() => setOutcomes([]), [baseline]);
  const verifyAll = useCallback(async () => {
    const result = await perform("verify sources", desktopApi.verifySources);
    if (result) setOutcomes(result);
  }, [perform]);
  return { outcomes, verifyAll };
}

export function usePortBackups(portId: string | undefined, setError: (error?: string) => void) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    if (!portId) {
      setBackups([]);
      return;
    }
    try {
      const result = await desktopApi.backups(portId);
      if (request === requestId.current) setBackups(result);
    } catch (value) {
      if (request === requestId.current) setError(errorText(value));
    }
  }, [portId, setError]);
  useEffect(() => {
    setBackups([]);
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  return { backups, refresh };
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
  useEffect(() => { void refresh(); }, [refresh]);
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
          setStatus(result.status);
          setDeviceLogin(undefined);
        } else {
          timer = window.setTimeout(() => { void poll(); }, delay);
        }
      } catch (value) {
        if (!cancelled) {
          setError(errorText(value));
          setDeviceLogin(undefined);
        }
      }
    };
    timer = window.setTimeout(() => { void poll(); }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [deviceLogin, setError]);
  const saveToken = useCallback(async () => {
    const result = await perform("GitHub authentication", () => desktopApi.setGithubToken(token));
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
    const result = await perform("GitHub login", desktopApi.beginGithubDeviceLogin);
    if (result) setDeviceLogin(result);
  }, [perform]);
  return { status, token, setToken, deviceLogin, saveToken, logout, beginDeviceLogin, refresh };
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
  const closeOverlay = useCallback(() => {
    if (adoptOpen) setAdoptOpen(false);
    else setSelectedId(undefined);
  }, [adoptOpen]);
  useGamepadNavigation(closeOverlay);
  return { view, setView, filter, setFilter, query, setQuery, selectedId, setSelectedId, sourcePath, setSourcePath, biosPath, setBiosPath, adoptOpen, setAdoptOpen, adoptPath, setAdoptPath };
}

export type Perform = <T>(name: string, task: () => Promise<T>) => Promise<T | undefined>;

export function detailActions(port: PortDefinition, status: PortStatus | undefined, sourcePath: string, biosPath: string, perform: Perform, close: () => void, reviewInstall: () => void = () => undefined, backupsChanged: () => Promise<void> = async () => undefined): DetailActions {
  return {
    activate: () => perform("activate", () => desktopApi.activate(port.id)),
    backup: async () => {
      if (await perform("back up data", () => desktopApi.backup(port.id))) await backupsChanged();
    },
    check: () => perform("check", () => desktopApi.check(port.id)),
    close,
    install: () => perform("install", () => desktopApi.install(port.id, status?.channel ?? port.channels[0], sourcePath, biosPath, status?.update_policy === "stage")),
    launch: () => perform("launch", () => desktopApi.launch(port.id, sourcePath)),
    openUserData: () => perform("open data folder", () => desktopApi.openUserData(port.id)),
    reviewInstall,
    remove: async () => {
      if (!await confirmPortRemoval(port.name)) return;
      const removed = await perform("remove", () => desktopApi.remove(port.id));
      if (removed !== undefined) close();
    },
    deleteBackup: async backup => {
      if (!await confirmBackupDeletion(port.name, backup.created_at)) return;
      if (await perform("delete backup", () => desktopApi.deleteBackup(port.id, backup.id))) await backupsChanged();
    },
    rollback: () => perform("rollback", () => desktopApi.rollback(port.id)),
    restoreBackup: async backup => {
      if (!await confirmBackupRestore(port.name, backup.created_at)) return;
      if (await perform("restore backup", () => desktopApi.restoreBackup(port.id, backup.id))) await backupsChanged();
    },
    setChannel: channel => perform("channel", () => desktopApi.setChannel(port.id, channel)),
    setPolicy: policy => perform("policy", () => desktopApi.setPolicy(port.id, policy)),
    update: () => perform("update", () => desktopApi.update(port.id, sourcePath, biosPath, status?.update_policy === "stage")),
    verify: () => perform("verify", () => desktopApi.verify(port.id)),
  };
}

export function adoptInstall(path: string, portId: string | undefined, perform: Perform, done: () => void) {
  return perform("adopt", async () => {
    await desktopApi.previewAdoption(path, portId);
    await desktopApi.adopt(path, portId);
    done();
  });
}
