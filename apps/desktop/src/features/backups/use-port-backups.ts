import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { BackupInventory } from "../../types";
import { errorText } from "../../view-model";

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
  const currentPortId = useRef(portId);
  useLayoutEffect(() => {
    currentPortId.current = portId;
    return () => {
      if (currentPortId.current === portId) currentPortId.current = undefined;
    };
  }, [portId]);
  const refresh = useCallback(async () => {
    if (!portId || currentPortId.current !== portId) return;
    const request = ++requestId.current;
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
        .catch((value: unknown) => {
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
