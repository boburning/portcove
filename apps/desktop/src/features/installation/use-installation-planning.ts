import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { PortStatus } from "../../types";
import type { Perform } from "../operations/use-operation-state";

// Review data is ephemeral UI intent; core still authorizes every mutation.
function useReviewRequest<T>(identity: string, perform: Perform) {
  const generation = useRef(new LatestRequestGeneration());
  const [reviewed, setReviewed] = useState<{ identity: string; value: T }>();
  useLayoutEffect(() => {
    const requests = generation.current;
    requests.begin();
    return () => {
      requests.begin();
    };
  }, [identity]);
  const review = async (name: string, task: () => Promise<T>) => {
    const request = generation.current.begin();
    setReviewed(undefined);
    const current = () => generation.current.isCurrent(request);
    const result = await perform(
      name,
      async () => {
        try {
          return await task();
        } catch (error) {
          if (current()) throw error;
          return undefined;
        }
      },
      { refresh: "none", invalidateDiagnostics: false },
    );
    if (result !== undefined && current()) setReviewed({ identity, value: result });
  };
  const guard = () => {
    const request = generation.current.begin();
    return () => generation.current.isCurrent(request);
  };
  const invalidate = (expected?: T) => {
    if (expected === undefined) {
      generation.current.begin();
      setReviewed(undefined);
      return;
    }
    setReviewed((current) => (current?.value === expected ? undefined : current));
  };
  return {
    value: reviewed?.identity === identity ? reviewed.value : undefined,
    review,
    guard,
    invalidate,
  };
}

export function useInstallPlanning(
  portId: string | undefined,
  channel: PortStatus["channel"] | undefined,
  perform: Perform,
) {
  const request = useReviewRequest<Awaited<ReturnType<typeof desktopApi.plan>>>(
    JSON.stringify([portId, channel]),
    perform,
  );
  const review = async () => {
    if (portId && channel)
      await request.review("review install", () => desktopApi.plan(portId, channel));
  };
  return { plan: request.value, review, invalidate: request.invalidate };
}

export function useAdoptionPlanning(
  path: string,
  portId: string | undefined,
  open: boolean,
  generation: number,
  perform: Perform,
  done: () => void,
) {
  const identity = JSON.stringify([path, portId, open, generation]);
  const request = useReviewRequest<Awaited<ReturnType<typeof desktopApi.previewAdoption>>>(
    identity,
    perform,
  );
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [completedIdentity, setCompletedIdentity] = useState<string>();
  const notifiedCompletion = useRef<string | undefined>(undefined);
  const review = async () => {
    setFailedIdentity(undefined);
    if (open && path.trim())
      await request.review("preview adoption", () =>
        desktopApi.previewAdoption(path, generation, portId),
      );
  };
  const inFlight = useRef(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    if (completedIdentity !== identity || applying || request.value !== undefined) return;
    if (notifiedCompletion.current === completedIdentity) return;
    notifiedCompletion.current = completedIdentity;
    done();
  }, [applying, completedIdentity, done, identity, request.value]);
  const adopt = async () => {
    const preview = request.value;
    if (!open || !preview?.selected_port_id || inFlight.current) return;
    inFlight.current = true;
    notifiedCompletion.current = undefined;
    setCompletedIdentity(undefined);
    setApplying(true);
    const current = request.guard();
    request.invalidate(preview);
    let adopted: Awaited<ReturnType<typeof desktopApi.adopt>> | undefined;
    try {
      adopted = await perform("adopt", () =>
        desktopApi.adopt(path, preview.plan_sha256, generation, portId),
      );
    } finally {
      inFlight.current = false;
      setApplying(false);
    }
    if (current()) {
      if (adopted !== undefined) setCompletedIdentity(identity);
      else setFailedIdentity(identity);
    }
  };
  return {
    preview: request.value,
    review,
    adopt,
    invalidate: request.invalidate,
    applying,
    copyFailed: failedIdentity === identity,
  };
}
