import { useEffect, useRef, useState } from "react";
import { LatestRequestGeneration } from "./concurrency-state";
import { errorText } from "./view-model";

export type ReviewOutcome = boolean | "cancelled";

// Presentation-only lifecycle shared by detailed reviews; core still authorizes every action.
export function useActionReview<T>({ identity, load, apply, close, failureMessage }: {
  identity: string; load: () => Promise<T>; apply: (review: T) => Promise<ReviewOutcome>;
  close: () => void; failureMessage: string;
}) {
  const callbacks = useRef({ load, apply, close, failureMessage });
  callbacks.current = { load, apply, close, failureMessage };
  const requests = useRef(new LatestRequestGeneration());
  const inFlight = useRef<"review" | "apply">(undefined);
  const [preview, setPreview] = useState<T>();
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<string>();
  const dismiss = () => { if (inFlight.current !== "apply") callbacks.current.close(); };
  const review = async () => {
    if (inFlight.current === "apply") return;
    const request = requests.current.begin();
    inFlight.current = "review"; setPending("review"); setPreview(undefined); setError(undefined);
    try {
      const value = await callbacks.current.load();
      if (requests.current.isCurrent(request)) setPreview(value);
    } catch (value) { if (requests.current.isCurrent(request)) setError(errorText(value)); }
    finally { if (requests.current.isCurrent(request)) { inFlight.current = undefined; setPending(undefined); } }
  };
  useEffect(() => { void review(); return () => { requests.current.begin(); inFlight.current = undefined; }; }, [identity]);
  const execute = async () => {
    if (!preview || inFlight.current) return;
    const request = requests.current.begin();
    inFlight.current = "apply"; setPending("apply"); setError(undefined);
    try {
      const result = await callbacks.current.apply(preview);
      if (!requests.current.isCurrent(request)) return;
      if (result) callbacks.current.close();
      else setError(callbacks.current.failureMessage);
    } catch (value) { if (requests.current.isCurrent(request)) setError(errorText(value)); }
    finally { if (requests.current.isCurrent(request)) { inFlight.current = undefined; setPending(undefined); setPreview(undefined); } }
  };
  return { preview, pending, error, review, execute, dismiss };
}
