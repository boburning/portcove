import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { BackupInventory } from "../../types";
import { errorText, failurePresentation, type FailureDisplay } from "../../view-model";

export type BackupReadState = {
  status: "idle" | "pending" | "current" | "failed";
  hasInventory: boolean;
  failure?: FailureDisplay;
};

export function usePortBackups(
  portId: string | undefined,
  setError?: (error?: string) => void,
  refreshIdentity?: unknown,
) {
  const selection = useMemo(() => ({ portId }), [portId]);
  const [read, setRead] = useState<{
    selection: typeof selection;
    inventory?: BackupInventory;
    status: BackupReadState["status"];
    failure?: FailureDisplay;
  }>(() => ({ selection, status: portId ? "pending" : "idle" }));
  const requestId = useRef(0);
  const currentSelection = useRef<typeof selection | undefined>(selection);
  useLayoutEffect(() => {
    currentSelection.current = selection;
    return () => {
      if (currentSelection.current === selection) currentSelection.current = undefined;
      requestId.current += 1;
    };
  }, [selection]);
  const readInventory = useCallback(() => {
    if (!portId || currentSelection.current !== selection) return Promise.resolve();
    const request = ++requestId.current;
    return Promise.resolve()
      .then(() => desktopApi.backups(portId))
      .then((inventory) => {
        if (inventory.port_id !== portId)
          throw new Error("Backup inventory does not match the selected port.");
        if (request === requestId.current && currentSelection.current === selection)
          setRead({ selection, inventory, status: "current" });
      })
      .catch((value: unknown) => {
        const failure = failurePresentation(value);
        if (request === requestId.current && currentSelection.current === selection) {
          setRead((previous) => ({
            selection,
            ...(previous.selection === selection && previous.inventory
              ? { inventory: previous.inventory }
              : {}),
            status: "failed",
            ...(failure ? { failure } : {}),
          }));
          setError?.(errorText(value));
        }
      });
  }, [portId, selection, setError]);
  const refresh = useCallback(async () => {
    if (!portId || currentSelection.current !== selection) return;
    setRead((previous) => ({
      selection,
      ...(previous.selection === selection && previous.inventory
        ? { inventory: previous.inventory }
        : {}),
      status: "pending",
    }));
    await readInventory();
  }, [portId, selection, readInventory]);
  useEffect(() => {
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh, refreshIdentity]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);
  const current = read.selection === selection ? read : undefined;
  const inventory = current?.inventory ?? {
    port_id: portId ?? "",
    protection: undefined,
    create_assessment: undefined,
    restore_assessment: undefined,
    state: "healthy" as const,
    backups: [],
    problems: [],
  };
  const readState: BackupReadState = {
    status: current?.status ?? (portId ? "pending" : "idle"),
    hasInventory: Boolean(current?.inventory),
    ...(current?.failure ? { failure: current.failure } : {}),
  };
  return { backups: inventory.backups, inventory, readState, refresh };
}
