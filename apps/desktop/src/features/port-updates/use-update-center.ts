import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type {
  GithubAuthStatus,
  PortStatus,
  UpdateCheckForecast,
  UpdateCheckOutcome,
} from "../../types";
import { failurePresentation, isCancellation, type FailureDisplay } from "../../view-model";

/** Offered before a check that would likely outrun the anonymous GitHub allowance. */
export type SignInOffer = {
  countedRequests: number;
  remainingRequests: number;
};

/** True only when the check is forecast to exceed what is left and sign-in would relieve it. */
export function signInOfferFor(
  forecast: UpdateCheckForecast,
  auth: GithubAuthStatus,
): SignInOffer | undefined {
  const remaining = auth.rate_limit?.remaining;
  if (auth.authenticated || remaining === undefined) return undefined;
  if (forecast.sign_in_relief_requests > 0 && forecast.counted_requests > remaining)
    return { countedRequests: forecast.counted_requests, remainingRequests: remaining };
  return undefined;
}

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
  const [signInOffer, setSignInOffer] = useState<SignInOffer>();
  const runCheck = useCallback(async () => {
    if (currentSelection.current !== selection) return;
    const request = requests.current.begin();
    const isCurrent = () =>
      requests.current.isCurrent(request) && currentSelection.current === selection;
    setChecked((previous) => ({
      selection,
      ...(previous?.selection === selection && previous.outcomes
        ? { outcomes: previous.outcomes }
        : {}),
      status: "pending",
    }));
    const result = await perform(
      "check installed",
      async () => {
        try {
          return await desktopApi.checkInstalled();
        } catch (error) {
          const failure = isCancellation(error) ? undefined : failurePresentation(error);
          if (isCurrent()) {
            setChecked((previous) => ({
              selection,
              ...(previous?.selection === selection && previous.outcomes
                ? { outcomes: previous.outcomes }
                : {}),
              status: isCancellation(error) ? "cancelled" : "failed",
              ...(failure ? { failure } : {}),
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
  const checkAll = useCallback(async () => {
    // The forecast and allowance are advisory: any failure to read them falls through to
    // the ordinary check rather than blocking it.
    const offer = await (async () => {
      const [forecast, auth] = await Promise.all([
        desktopApi.forecastInstalledUpdateChecks(),
        desktopApi.githubAuthStatus(),
      ]);
      return signInOfferFor(forecast, auth);
    })().catch(() => undefined);
    if (offer) {
      setSignInOffer(offer);
      return;
    }
    setSignInOffer(undefined);
    await runCheck();
  }, [runCheck]);
  const checkAnyway = useCallback(async () => {
    setSignInOffer(undefined);
    await runCheck();
  }, [runCheck]);
  const dismissSignInOffer = useCallback(() => setSignInOffer(undefined), []);
  const batchRead: UpdateBatchRead = {
    status: current?.status ?? "idle",
    hasResults: current?.outcomes !== undefined,
    ...(current?.failure ? { failure: current.failure } : {}),
  };
  return { outcomes, batchRead, checkAll, signInOffer, checkAnyway, dismissSignInOffer };
}
