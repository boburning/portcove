import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { PortStatus, UpdateCheckOutcome } from "../../types";
import { failurePresentation, isCancellation, type FailureDisplay } from "../../view-model";

export type UpdateBatchRead = {
  status: "idle" | "pending" | "current" | "failed" | "cancelled";
  hasResults: boolean;
  failure?: FailureDisplay;
};

type UpdateCheckOperation = <T>(
  name: string,
  task: () => Promise<T>,
  options?: { refresh?: "workspace" | "activities" | "none"; invalidateDiagnostics?: boolean },
) => Promise<T | undefined>;

export function useUpdateCenter(perform: UpdateCheckOperation, statuses: PortStatus[]) {
  const installBaseline = JSON.stringify(
    statuses
      .filter((status) => status.active)
      .map(
        (status) =>
          [
            status.port_id,
            status.channel,
            status.active!.id,
            status.active!.version,
            status.active!.artifact.sha256,
            status.active!.runtime,
          ] as const,
      )
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
  const selection = useMemo(() => ({ installBaseline }), [installBaseline]);
  const [checked, setChecked] = useState<{
    selection: typeof selection;
    outcomes?: UpdateCheckOutcome[];
    status: UpdateBatchRead["status"];
    failure?: FailureDisplay;
  }>();
  const requests = useRef(new LatestRequestGeneration());
  const currentSelection = useRef<typeof selection | undefined>(undefined);
  useLayoutEffect(() => {
    const generation = requests.current;
    currentSelection.current = selection;
    generation.begin();
    return () => {
      currentSelection.current = undefined;
      generation.begin();
    };
  }, [selection]);
  const current = checked?.selection === selection ? checked : undefined;
  const outcomes = current?.outcomes ?? [];
  const checkAll = useCallback(async () => {
    if (currentSelection.current !== selection) return;
    const request = requests.current.begin();
    const isCurrent = () =>
      requests.current.isCurrent(request) && currentSelection.current === selection;
    setChecked((previous) => ({
      selection,
      outcomes: previous?.selection === selection ? previous.outcomes : undefined,
      status: "pending",
    }));
    const result = await perform(
      "check installed",
      async () => {
        try {
          return await desktopApi.checkInstalled();
        } catch (error) {
          if (isCurrent()) {
            setChecked((previous) => ({
              selection,
              outcomes: previous?.selection === selection ? previous.outcomes : undefined,
              status: isCancellation(error) ? "cancelled" : "failed",
              failure: isCancellation(error) ? undefined : failurePresentation(error),
            }));
            throw error;
          }
          return undefined;
        }
      },
      {
        refresh: "workspace",
        invalidateDiagnostics: false,
      },
    );
    if (isCurrent()) {
      if (result !== undefined) setChecked({ selection, outcomes: result, status: "current" });
      else
        setChecked((previous) =>
          previous?.status === "pending" ? { ...previous, status: "failed" } : previous,
        );
    }
  }, [perform, selection]);
  const batchRead: UpdateBatchRead = {
    status: current?.status ?? "idle",
    hasResults: current?.outcomes !== undefined,
    failure: current?.failure,
  };
  return { outcomes, batchRead, checkAll };
}
