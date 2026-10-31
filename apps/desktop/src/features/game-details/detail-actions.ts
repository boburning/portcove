import { defaultReleaseChannel } from "../../view-model";
import { gameIdentityLabel } from "../../port-identity";
import { desktopApi } from "../../api";
import type { DetailActions } from "../../components/DetailPanel";
import type { PortDefinition, PortStatus } from "../../types";
import type { Perform } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";

const actionLabels: Readonly<Record<string, string>> = {
  "activate staged update": "Apply saved update",
  "back up data": "Back up saved data",
  check: "Check for game updates",
  install: "Install game",
  launch: "Launch game",
  "open data folder": "Open saved data folder",
  "open setup folder": "Open installed setup folder",
  remove: "Remove installation",
  "delete backup": "Delete backup",
  rollback: "Use previous version",
  "restore backup": "Restore backup",
  "recover legacy installation and data": "Recover legacy installation and data",
  "refresh backup history": "Refresh backup history",
  channel: "Change release channel",
  policy: "Save update preferences",
  verify: "Check installed files",
};

const nullableNativeConsent = { cancelledResult: (result: unknown) => result === null };

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
  perform: execute,
  close,
  reviewInstall = () => undefined,
  backupsChanged = () => Promise.resolve(),
  libraryGeneration,
  dismissInstallReview = () => undefined,
}: DetailActionContext): DetailActions {
  if (!Number.isSafeInteger(libraryGeneration) || libraryGeneration < 0) {
    throw new Error("Game details require an explicit library generation");
  }
  const perform: Perform = (name, task, options) =>
    execute(name, task, {
      ...options,
      context: {
        ...targetInvocationContext(
          actionLabels[name] ?? name,
          { kind: "port", id: port.id, label: gameIdentityLabel(port) },
          libraryGeneration,
        ),
        operation: name === "launch" ? "launch" : undefined,
      },
    });
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
      if (await perform("back up data", () => desktopApi.backup(port.id, libraryGeneration)))
        await backupsChanged();
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
        return await perform("install", (reportEvent) =>
          desktopApi.install(
            port.id,
            status?.channel ?? defaultReleaseChannel(port),
            sourcePath,
            biosPath,
            false,
            libraryGeneration,
            reportEvent,
          ),
        );
      } finally {
        // The status layer owns the settled result, including failures and cancellation.
        // Close the modal so that result is reachable and another attempt requires a fresh review.
        dismissInstallReview();
      }
    },
    launch: () =>
      perform("launch", () => desktopApi.launch(port.id, sourcePath, libraryGeneration)),
    openUserData: () =>
      perform("open data folder", () => desktopApi.openUserData(port.id, libraryGeneration), {
        refresh: "none",
        invalidateDiagnostics: false,
      }),
    openSetupFolder: () =>
      perform(
        "open setup folder",
        () => {
          if (!status?.active) throw new Error("Refresh this installation before opening setup.");
          return desktopApi.openManualSetupFolder(port.id, status.active.id, libraryGeneration);
        },
        { refresh: "none", invalidateDiagnostics: false },
      ),
    reviewInstall,
    remove: async (expectedPreview) => {
      const removed = await perform(
        "remove",
        () => desktopApi.remove(port.id, expectedPreview, libraryGeneration),
        nullableNativeConsent,
      );
      if (removed) close();
      return removed === null ? "cancelled" : Boolean(removed);
    },
    deleteBackup: async (backup, expectedPreview) => {
      const result = await perform(
        "delete backup",
        () => desktopApi.deleteBackup(port.id, backup.id, expectedPreview, libraryGeneration),
        nullableNativeConsent,
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    rollback: () => perform("rollback", () => desktopApi.rollback(port.id, libraryGeneration)),
    restoreBackup: async (backup, expectedPreview) => {
      const result = await perform(
        "restore backup",
        () => desktopApi.restoreBackup(port.id, backup.id, expectedPreview, libraryGeneration),
        nullableNativeConsent,
      );
      if (result === null) return "cancelled";
      const completed = Boolean(result);
      if (completed) await backupsChanged();
      return completed;
    },
    recoverGhostshipLegacy:
      port.id === "ghostship"
        ? async (backup, expectedPlan) => {
            if (backup.port_id !== port.id)
              throw new Error("Recovery backup belongs to another game.");
            const result = await perform(
              "recover legacy installation and data",
              () =>
                desktopApi.recoverGhostshipLegacyData(backup.id, expectedPlan, libraryGeneration),
              { cancelledResult: (value) => value === null },
            );
            if (result === null) return "cancelled";
            // Readback failure is separately attributable; it cannot undo committed recovery.
            await perform("refresh backup history", backupsChanged, {
              refresh: "none",
              invalidateDiagnostics: false,
            });
            return Boolean(result);
          }
        : undefined,
    setChannel: (channel) =>
      perform("channel", () => desktopApi.setChannel(port.id, channel, libraryGeneration)),
    setPolicy: (policy) =>
      perform("policy", () => desktopApi.setPolicy(port.id, policy, libraryGeneration)),
    verify: () => perform("verify", () => desktopApi.verify(port.id, libraryGeneration)),
  };
}
