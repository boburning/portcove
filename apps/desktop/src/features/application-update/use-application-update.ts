import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import type {
  ApplicationUpdatePreferences,
  ApplicationUpdateProgress,
  ApplicationUpdateStatus,
} from "../../types";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";

export type ApplicationUpdateAction = "check" | "save" | "install";

export interface ApplicationUpdateModel {
  status: ApplicationUpdateStatus | undefined;
  preferences: ApplicationUpdatePreferences | undefined;
  busy: ApplicationUpdateAction | undefined;
  progress: ApplicationUpdateProgress | undefined;
  failure: unknown;
  /** The available version the global notice still announces. */
  noticeVersion: string | undefined;
  check: () => Promise<void>;
  savePreferences: (preferences: ApplicationUpdatePreferences) => Promise<void>;
  install: (generation: number) => Promise<void>;
  dismissNotice: () => void;
}

/**
 * Presentation state for Portcove's own updates. The host owns the channel,
 * the feed check, signature verification and save protection; this hook only
 * mirrors the host status and forwards the player's explicit actions.
 */
export function useApplicationUpdate(): ApplicationUpdateModel {
  const [status, setStatus] = useState<ApplicationUpdateStatus>();
  const [preferences, setPreferences] = useState<ApplicationUpdatePreferences>();
  const [busy, setBusy] = useState<ApplicationUpdateAction>();
  const [progress, setProgress] = useState<ApplicationUpdateProgress>();
  const [failure, setFailure] = useState<unknown>();
  const [dismissedVersion, setDismissedVersion] = useState<string>();

  useEffect(() => {
    let disposed = false;
    const subscription = startManagedSubscription<ApplicationUpdateStatus>({
      register: (accept) => listenDesktopEvent("portcove://application-update-notice", accept),
      onEvent: setStatus,
    });
    void (async () => {
      await subscription.ready;
      if (disposed) return;
      const [nextStatus, nextPreferences] = await Promise.allSettled([
        desktopApi.applicationUpdateStatus(),
        desktopApi.applicationUpdatePreferences(),
      ]);
      if (disposed) return;
      if (nextStatus.status === "fulfilled") setStatus(nextStatus.value);
      if (nextPreferences.status === "fulfilled") setPreferences(nextPreferences.value);
      else setFailure(nextPreferences.reason);
    })();
    return () => {
      disposed = true;
      subscription.stop();
    };
  }, []);

  const run = useCallback(async (action: ApplicationUpdateAction, task: () => Promise<void>) => {
    setBusy(action);
    setFailure(undefined);
    try {
      await task();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }
  }, []);

  const check = useCallback(
    () =>
      run("check", async () => {
        setStatus(await desktopApi.checkApplicationUpdate());
      }),
    [run],
  );

  const savePreferences = useCallback(
    (next: ApplicationUpdatePreferences) =>
      run("save", async () => {
        setPreferences(await desktopApi.setApplicationUpdatePreferences(next));
      }),
    [run],
  );

  const availableVersion = status?.available?.version;
  const install = useCallback(
    (generation: number) =>
      run("install", async () => {
        if (!availableVersion) return;
        // On success the host restarts or hands over to the installer.
        await desktopApi.installApplicationUpdate(availableVersion, generation, setProgress);
      }),
    [availableVersion, run],
  );

  const dismissNotice = useCallback(
    () => setDismissedVersion(availableVersion),
    [availableVersion],
  );

  return {
    status,
    preferences,
    busy,
    progress,
    failure,
    noticeVersion:
      availableVersion && availableVersion !== dismissedVersion ? availableVersion : undefined,
    check,
    savePreferences,
    install,
    dismissNotice,
  };
}
