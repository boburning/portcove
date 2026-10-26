import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { SourceInspectionReport, SourceRecord, SourceVerificationOutcome } from "../../types";
import { failurePresentation, isCancellation, type FailureDisplay } from "../../view-model";

type SourceHealthOperation = <T>(name: string, task: () => Promise<T>) => Promise<T | undefined>;

export type SourceInspectionReadState = {
  status: "idle" | "pending" | "current" | "failed" | "cancelled";
  failure?: FailureDisplay;
  code?: string;
};
type InspectionFlight = { baseline: symbol; pending: boolean; promise: Promise<void> };

export function useSourceHealth(
  perform: SourceHealthOperation,
  sources: SourceRecord[],
  requestedProfileIds: readonly string[] = [],
  catalogIdentity = "",
) {
  const [verified, setVerified] = useState<{
    baseline: symbol;
    outcomes: SourceVerificationOutcome[];
  }>();
  const [inspected, setInspected] = useState<{
    baseline: symbol;
    inspections: ReadonlyMap<string, SourceInspectionReport>;
    reads: ReadonlyMap<string, SourceInspectionReadState>;
  }>();
  const verificationRequests = useRef(new LatestRequestGeneration());
  const flights = useRef(new Map<string, InspectionFlight>());
  const mounted = useRef(false);
  const requested = new Set(requestedProfileIds);
  const inspectionSources = sources.filter((source) => requested.has(source.profile_id));
  const baselineKey = `${catalogIdentity}|${JSON.stringify(inspectionSources)}`;
  const baseline = useMemo(() => Symbol(baselineKey), [baselineKey]);
  const inspectionInput = useRef({ baseline, sources: inspectionSources });
  useLayoutEffect(() => {
    inspectionInput.current = { baseline, sources: inspectionSources };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    const currentFlights = flights.current;
    const verifications = verificationRequests.current;
    return () => {
      mounted.current = false;
      currentFlights.clear();
      verifications.begin();
    };
  }, [baseline]);
  const inspectSource = useCallback((profileId: string) => {
    const { baseline: currentBaseline, sources: currentSources } = inspectionInput.current;
    if (!mounted.current || !currentSources.some((source) => source.profile_id === profileId))
      return Promise.resolve();
    const existing = flights.current.get(profileId);
    if (existing?.baseline === currentBaseline && existing.pending) return existing.promise;
    const flight: InspectionFlight = {
      baseline: currentBaseline,
      pending: true,
      promise: Promise.resolve(),
    };
    flights.current.set(profileId, flight);
    const isCurrent = () =>
      mounted.current &&
      inspectionInput.current.baseline === currentBaseline &&
      flights.current.get(profileId) === flight;
    const acceptRead = (read: SourceInspectionReadState, report?: SourceInspectionReport) => {
      if (!isCurrent()) return;
      setInspected((previous) => {
        if (!isCurrent()) return previous;
        const current = previous?.baseline === currentBaseline ? previous : undefined;
        const inspections = new Map(current?.inspections);
        const reads = new Map(current?.reads);
        reads.set(profileId, read);
        if (report) inspections.set(profileId, report);
        else if (read.status !== "pending") inspections.delete(profileId);
        return { baseline: currentBaseline, inspections, reads };
      });
    };
    acceptRead({ status: "pending" });
    flight.promise = Promise.resolve()
      .then(async () => {
        if (!isCurrent()) return;
        try {
          const report = await desktopApi.inspectSource(profileId);
          if (report.profile_id !== profileId)
            throw new Error("The inspection does not match the requested saved file.");
          acceptRead({ status: "current" }, report);
        } catch (value: unknown) {
          const failure = failurePresentation(value);
          const code =
            typeof value === "object" && value && "code" in value && typeof value.code === "string"
              ? value.code
              : undefined;
          acceptRead({
            status: isCancellation(value) ? "cancelled" : "failed",
            ...(failure ? { failure } : {}),
            ...(code !== undefined ? { code } : {}),
          });
        }
      })
      .finally(() => {
        flight.pending = false;
      });
    return flight.promise;
  }, []);
  const inspectAll = useCallback(() => {
    const { sources: currentSources } = inspectionInput.current;
    return Promise.all(currentSources.map((source) => inspectSource(source.profile_id))).then(
      () => undefined,
    );
  }, [inspectSource]);
  const verifyAll = useCallback(async () => {
    if (!mounted.current || inspectionInput.current.baseline !== baseline) return;
    const request = verificationRequests.current.begin();
    setVerified(undefined);
    const result = await perform("verify sources", desktopApi.verifySources);
    if (
      !mounted.current ||
      inspectionInput.current.baseline !== baseline ||
      !verificationRequests.current.isCurrent(request)
    )
      return;
    if (result) setVerified({ baseline, outcomes: result });
    await inspectAll();
  }, [baseline, inspectAll, perform]);
  const outcomes = verified?.baseline === baseline ? verified.outcomes : [];
  const current = inspected?.baseline === baseline ? inspected : undefined;
  const inspections = current?.inspections ?? new Map<string, SourceInspectionReport>();
  const inspectionReads = new Map(
    inspectionSources.map((source) => [
      source.profile_id,
      current?.reads.get(source.profile_id) ?? { status: "idle" as const },
    ]),
  );
  return { outcomes, inspections, inspectionReads, inspectSource, inspectAll, verifyAll };
}
