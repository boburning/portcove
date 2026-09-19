import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { SourceInspectionReport, SourceRecord, SourceVerificationOutcome } from "../../types";

type SourceHealthOperation = <T>(name: string, task: () => Promise<T>) => Promise<T | undefined>;

export function useSourceHealth(
  perform: SourceHealthOperation,
  sources: SourceRecord[],
  requestedProfileIds: readonly string[] = [],
  catalogIdentity = "",
) {
  const [verified, setVerified] = useState<{
    baseline: string;
    outcomes: SourceVerificationOutcome[];
  }>();
  const [inspected, setInspected] = useState<{
    baseline: string;
    inspections: ReadonlyMap<string, SourceInspectionReport>;
  }>();
  const inspectionRequests = useRef(new LatestRequestGeneration());
  const verificationRequests = useRef(new LatestRequestGeneration());
  const requested = new Set(requestedProfileIds);
  const inspectionSources = sources.filter((source) => requested.has(source.profile_id));
  const baseline = `${catalogIdentity}|${JSON.stringify(inspectionSources)}`;
  const inspectionInput = useRef({ baseline, sources: inspectionSources });
  useLayoutEffect(() => {
    inspectionInput.current = { baseline, sources: inspectionSources };
  });
  const inspectAll = useCallback(async () => {
    const { baseline: currentBaseline, sources: currentSources } = inspectionInput.current;
    const request = inspectionRequests.current.begin();
    const results = await Promise.allSettled(
      currentSources.map((source) => desktopApi.inspectSource(source.profile_id)),
    );
    if (!inspectionRequests.current.isCurrent(request)) return;
    setInspected({
      baseline: currentBaseline,
      inspections: new Map(
        results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? [[currentSources[index].profile_id, result.value] as const]
            : [],
        ),
      ),
    });
  }, []);
  useEffect(() => {
    const inspections = inspectionRequests.current;
    const verifications = verificationRequests.current;
    inspections.begin();
    verifications.begin();
    void inspectAll();
    return () => {
      inspections.begin();
      verifications.begin();
    };
  }, [baseline, inspectAll]);
  const verifyAll = useCallback(async () => {
    const request = verificationRequests.current.begin();
    const result = await perform("verify sources", desktopApi.verifySources);
    if (result && verificationRequests.current.isCurrent(request)) {
      setVerified({ baseline, outcomes: result });
    }
    await inspectAll();
  }, [baseline, inspectAll, perform]);
  const outcomes = verified?.baseline === baseline ? verified.outcomes : [];
  const inspections =
    inspected?.baseline === baseline
      ? inspected.inspections
      : new Map<string, SourceInspectionReport>();
  return { outcomes, inspections, inspectAll, verifyAll };
}
