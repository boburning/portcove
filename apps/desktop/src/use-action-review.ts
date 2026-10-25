import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { LatestRequestGeneration } from "./shared/concurrency-state";

export type ReviewOutcome = boolean | "cancelled";

// Presentation-only lifecycle shared by detailed reviews; core still authorizes every action.
export function useActionReview<T>({
  identity,
  load,
  apply,
  close,
  failureMessage,
  retainOnCancel = false,
}: {
  identity: string;
  load: () => Promise<T>;
  apply: (review: T) => Promise<ReviewOutcome>;
  close: () => void;
  failureMessage: string;
  retainOnCancel?: boolean;
}) {
  const callbacks = useRef({ load, apply, close, failureMessage, retainOnCancel });
  useLayoutEffect(() => {
    callbacks.current = { load, apply, close, failureMessage, retainOnCancel };
  });
  const requests = useRef(new LatestRequestGeneration());
  const inFlight = useRef<"review" | "apply">(undefined);
  const [reviewed, setReviewed] = useState<{ identity: string; value: T }>();
  const preview = reviewed?.identity === identity ? reviewed.value : undefined;
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<unknown>();
  const dismiss = () => {
    if (inFlight.current !== "apply") callbacks.current.close();
  };
  const review = useCallback(async () => {
    if (inFlight.current === "apply") return;
    const request = requests.current.begin();
    inFlight.current = "review";
    setPending("review");
    setReviewed(undefined);
    setError(undefined);
    try {
      const value = await callbacks.current.load();
      if (requests.current.isCurrent(request)) {
        setReviewed({ identity, value });
        return value;
      }
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(value);
    } finally {
      if (requests.current.isCurrent(request)) {
        inFlight.current = undefined;
        setPending(undefined);
      }
    }
  }, [identity]);
  useLayoutEffect(() => {
    const requestGeneration = requests.current;
    void review();
    return () => {
      requestGeneration.begin();
      inFlight.current = undefined;
    };
  }, [review]);
  const execute = async () => {
    if (!preview || inFlight.current) return;
    const request = requests.current.begin();
    inFlight.current = "apply";
    setPending("apply");
    setError(undefined);
    let cancelled = false;
    try {
      const result = await callbacks.current.apply(preview);
      if (!requests.current.isCurrent(request)) return;
      if (result === true) callbacks.current.close();
      else if (result === "cancelled") {
        cancelled = callbacks.current.retainOnCancel;
        if (!cancelled) callbacks.current.close();
      } else setError(callbacks.current.failureMessage);
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(value);
    } finally {
      if (requests.current.isCurrent(request)) {
        inFlight.current = undefined;
        setPending(undefined);
        if (!cancelled) setReviewed(undefined);
      }
    }
  };
  return { preview, pending, error, review, execute, dismiss };
}
