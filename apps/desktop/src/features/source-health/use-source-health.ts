import { useQueries, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

export function useSourceHealth(
  perform: SourceHealthOperation,
  sources: SourceRecord[],
  requestedProfileIds: readonly string[] = [],
  catalogIdentity = "",
  queryClient: QueryClient,
  artworkRead?: { profileId: string; generation: number },
) {
  const [verified, setVerified] = useState<{
    baseline: string;
    outcomes: SourceVerificationOutcome[];
  }>();
  const lifetime = useId();
  const verificationRequests = useRef(new LatestRequestGeneration());
  const mounted = useRef(false);
  const requested = new Set(requestedProfileIds);
  const inspectionSources = sources.filter((source) => requested.has(source.profile_id));
  const baselineKey = `${catalogIdentity}|${JSON.stringify(inspectionSources)}`;
  // A fresh identity also isolates A -> B -> A visits and hook/library lifetimes.
  const baseline = useMemo(() => ({ key: baselineKey, id: crypto.randomUUID() }), [baselineKey]).id;
  const inspectionInput = useRef({ baseline, sources: inspectionSources });
  useLayoutEffect(() => {
    inspectionInput.current = { baseline, sources: inspectionSources };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    const verifications = verificationRequests.current;
    return () => {
      mounted.current = false;
      queryClient.removeQueries({ queryKey: ["source-inspection", lifetime, baseline] });
      verifications.begin();
    };
  }, [baseline, lifetime, queryClient]);
  const options = inspectionSources.map((source) => {
    const read = async (signal: AbortSignal, artworkGeneration?: number) => {
      // IPC has no cancellation API. Guard dispatch and frontend acceptance, rather
      // than suggesting Query cancellation stops already running native work.
      signal.throwIfAborted();
      if (!mounted.current || inspectionInput.current.baseline !== baseline)
        throw new Error("The inspection baseline changed.");
      const report =
        artworkGeneration === undefined
          ? await desktopApi.inspectSource(source.profile_id)
          : await desktopApi.inspectSource(source.profile_id, artworkGeneration);
      signal.throwIfAborted();
      if (report.profile_id !== source.profile_id)
        throw new Error("The inspection does not match the requested saved file.");
      return report;
    };
    return {
      queryKey: ["source-inspection", lifetime, baseline, source.profile_id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => read(signal),
      read,
      enabled: false,
      retry: false,
      retryOnMount: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      networkMode: "always" as const,
      staleTime: 0, // Every settled explicit request reinspects; concurrent calls share native work.
      gcTime: 0,
      structuralSharing: false as const,
    };
  });
  const results = useQueries({ queries: options }, queryClient);
  const inspectionOptions = useRef(options);
  useLayoutEffect(() => {
    inspectionOptions.current = options;
  });
  const automaticProfile = artworkRead?.profileId;
  const automaticGeneration = artworkRead?.generation;
  const automaticInspection = useRef<
    | {
        baseline: string;
        profile: string;
        done: Promise<unknown>;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!automaticProfile || automaticGeneration === undefined) return;
    const selected = inspectionOptions.current.find(
      (option) => option.queryKey[3] === automaticProfile,
    );
    if (
      !selected ||
      queryClient.getQueryData(selected.queryKey) ||
      queryClient.getQueryState(selected.queryKey)?.fetchStatus === "fetching"
    )
      return;
    const done = queryClient
      .query({
        ...selected,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          selected.read(signal, automaticGeneration),
      })
      .catch(() => {
        // The scoped query retains its own read error and the hero uses fallback.
      });
    automaticInspection.current = { baseline, profile: automaticProfile, done };
  }, [automaticProfile, automaticGeneration, baseline, queryClient]);
  const inspectSource = useCallback(
    async (profileId: string) => {
      const baseline = inspectionInput.current.baseline;
      const automatic = automaticInspection.current;
      // A player-requested full check must follow a bounded read already in flight.
      if (automatic?.baseline === baseline && automatic.profile === profileId) await automatic.done;
      if (!mounted.current || inspectionInput.current.baseline !== baseline) return;
      const selected = inspectionOptions.current.find((option) => option.queryKey[3] === profileId);
      if (!selected) return;
      try {
        await queryClient.query(selected);
      } catch {
        // Query owns the read error; the view below preserves safe failure/cancel presentation.
      }
    },
    [queryClient],
  );
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
  const inspections = new Map<string, SourceInspectionReport>();
  const inspectionReads = new Map<string, SourceInspectionReadState>();
  inspectionSources.forEach((source, index) => {
    const result = results[index]!;
    if (result.data && !result.isError) inspections.set(source.profile_id, result.data);
    const value = result.error;
    const failure = failurePresentation(value);
    const code =
      typeof value === "object" && value && "code" in value && typeof value.code === "string"
        ? value.code
        : undefined;
    inspectionReads.set(
      source.profile_id,
      result.isFetching
        ? { status: "pending" }
        : result.isError
          ? {
              status: isCancellation(value) ? "cancelled" : "failed",
              ...(failure ? { failure } : {}),
              ...(code !== undefined ? { code } : {}),
            }
          : { status: result.isSuccess ? "current" : "idle" },
    );
  });
  return { outcomes, inspections, inspectionReads, inspectSource, inspectAll, verifyAll };
}
