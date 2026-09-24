import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { PortStatus, UpdateCheckOutcome } from "../../types";
import { currentUpdateSnapshot } from "../../view-model";

type UpdateCheckOperation = <T>(
  name: string,
  task: () => Promise<T>,
  options?: { refresh?: "workspace" | "activities" | "none"; invalidateDiagnostics?: boolean },
) => Promise<T | undefined>;

export function useUpdateCenter(perform: UpdateCheckOperation, statuses: PortStatus[]) {
  const snapshots = statuses.flatMap((status) => {
    const snapshot = currentUpdateSnapshot(status);
    return snapshot
      ? [
          {
            port_id: status.port_id,
            ok: true,
            error: null,
            result: snapshot.check,
          } satisfies UpdateCheckOutcome,
        ]
      : [];
  });
  const snapshotBaseline = JSON.stringify(
    statuses
      .filter((status) => status.active)
      .map((status) => {
        const snapshot = currentUpdateSnapshot(status);
        return [
          status.port_id,
          status.channel,
          status.active!.id,
          status.active!.version,
          status.active!.artifact.sha256,
          status.active!.runtime,
          snapshot?.checked_at,
          snapshot?.check.release.asset.sha256,
          snapshot?.check.required_runtime,
        ] as const;
      })
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
  const [checked, setChecked] = useState<{
    baseline: string;
    outcomes: UpdateCheckOutcome[];
  }>();
  const requests = useRef(new LatestRequestGeneration());
  const currentBaseline = useRef(snapshotBaseline);
  useLayoutEffect(() => {
    const generation = requests.current;
    currentBaseline.current = snapshotBaseline;
    generation.begin();
    return () => {
      generation.begin();
    };
  }, [snapshotBaseline]);
  const outcomes = checked?.baseline === snapshotBaseline ? checked.outcomes : snapshots;
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
      setChecked({ baseline, outcomes: result });
    }
  }, [perform]);
  return { outcomes, checkAll };
}
