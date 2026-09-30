import { desktopApi } from "../../api";
import type { DetailActions } from "../../components/DetailPanel";
import type { PortDefinition, PortStatus } from "../../types";
import type { Perform } from "../operations/use-operation-state";

export interface DetailActionContext {
  port: PortDefinition;
  status: PortStatus | undefined;
  sourcePath: string;
  biosPath: string;
  perform: Perform;
  close: () => void;
  reviewInstall?: DetailActions["reviewInstall"];
  backupsChanged?: () => Promise<void>;
  libraryGeneration: number;
  dismissInstallReview?: DetailActions["dismissInstallReview"];
}

export function detailActions({
  port,
  status,
  sourcePath,
  biosPath,
  perform,
  close,
  reviewInstall = () => undefined,
  backupsChanged = () => Promise.resolve(),
  libraryGeneration,
  dismissInstallReview = () => undefined,
}: DetailActionContext): DetailActions {
  if (!Number.isSafeInteger(libraryGeneration) || libraryGeneration < 0) {
    throw new Error("Game details require an explicit library generation");
  }
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
    dismissInstallReview,
    install: async () => {
      try {
        return await perform("install", () =>
          desktopApi.install(
            port.id,
            status?.channel ?? port.channels[0],
            sourcePath,
            biosPath,
            false,
          ),
        );
      } finally {
        // The status layer owns the settled result, including failures and cancellation.
        // Close the modal so that result is reachable and another attempt requires a fresh review.
        dismissInstallReview();
      }
    },
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
