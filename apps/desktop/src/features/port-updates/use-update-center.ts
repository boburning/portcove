import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { PortStatus, UpdateCheckOutcome } from "../../types";

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
  const [checked, setChecked] = useState<{
    installBaseline: string;
    outcomes: UpdateCheckOutcome[];
  }>();
  const requests = useRef(new LatestRequestGeneration());
  const currentBaseline = useRef(installBaseline);
  useLayoutEffect(() => {
    const generation = requests.current;
    currentBaseline.current = installBaseline;
    generation.begin();
    return () => {
      generation.begin();
    };
  }, [installBaseline]);
  const outcomes = checked?.installBaseline === installBaseline ? checked.outcomes : [];
  const checkAll = useCallback(async () => {
    const baseline = currentBaseline.current;
    const request = requests.current.begin();
    const isCurrent = () =>
      requests.current.isCurrent(request) && currentBaseline.current === baseline;
    const result = await perform(
      "check installed",
      async () => {
        try {
          return await desktopApi.checkInstalled();
        } catch (error) {
          if (isCurrent()) throw error;
          return undefined;
        }
      },
      {
        refresh: "workspace",
        invalidateDiagnostics: false,
      },
    );
    if (result && isCurrent()) {
      setChecked({ installBaseline: baseline, outcomes: result });
    }
  }, [perform]);
  return { outcomes, checkAll };
}
