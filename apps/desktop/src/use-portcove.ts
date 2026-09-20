import { useCallback, useState, type SetStateAction } from "react";
import { desktopApi } from "./api";
import type { PortDefinition, PortStatus } from "./types";
import type { DetailActions } from "./components/DetailPanel";
import { type Filter, type View } from "./view-model";
import type { Perform } from "./features/operations/use-operation-state";

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
