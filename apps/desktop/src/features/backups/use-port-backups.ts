import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { BackupInventory } from "../../types";
import { errorText, failurePresentation, type FailureDisplay } from "../../view-model";

export type BackupReadState = {
  status: "idle" | "pending" | "current" | "failed";
  hasInventory: boolean;
  failure?: FailureDisplay;
};

export function usePortBackups(portId: string | undefined, setError?: (error?: string) => void) {
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
  const refresh = useCallback(async () => {
    if (!portId || currentSelection.current !== selection) return;
    const request = ++requestId.current;
    setRead((previous) => ({
      selection,
      inventory: previous.selection === selection ? previous.inventory : undefined,
      status: "pending",
    }));
    try {
      const inventory = await desktopApi.backups(portId);
      if (inventory.port_id !== portId)
        throw new Error("Backup inventory does not match the selected port.");
      if (request === requestId.current && currentSelection.current === selection)
        setRead({ selection, inventory, status: "current" });
    } catch (value) {
      if (request === requestId.current && currentSelection.current === selection) {
        setRead((previous) => ({
          selection,
          inventory: previous.selection === selection ? previous.inventory : undefined,
          status: "failed",
          failure: failurePresentation(value),
        }));
        setError?.(errorText(value));
      }
    }
  }, [portId, selection, setError]);
  useEffect(() => {
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh]);
  const current = read.selection === selection ? read : undefined;
  const inventory = current?.inventory ?? {
    port_id: portId ?? "",
    state: "healthy" as const,
    backups: [],
    problems: [],
  };
  const readState: BackupReadState = {
    status: current?.status ?? (portId ? "pending" : "idle"),
    hasInventory: Boolean(current?.inventory),
    failure: current?.failure,
  };
  return { backups: inventory.backups, inventory, readState, refresh };
}
