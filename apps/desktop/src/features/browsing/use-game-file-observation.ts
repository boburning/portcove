import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type {
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  LibraryIdentity,
} from "../../types";
import { errorText, isCancellation } from "../../view-model";
import { useObservationExpired } from "./use-observation-expiry";
import type { Route } from "./game-file-query-context";

/** Informational scope only; never classifications, counts or matching-build evidence. */
export type GameFileObservationMetadata = Readonly<{
  observedAt: number;
  expiresAt: number;
  deadline: number;
  routes: readonly Readonly<Route>[];
}>;
export type GameFileObservationOutcome =
  | "idle"
  | "checking"
  | "waiting"
  | "accepted"
  | "failed"
  | "cancelled";
export type GameFileObservationPresentation = {
  lastAccepted: GameFileObservationMetadata | undefined;
  expired: boolean;
  usable: boolean;
  outcome: GameFileObservationOutcome;
};

/** One explicit request owner per caller; context, attempt and observation identities are distinct. */
export function useGameFileObservation<T>({
  contextKey,
  generation,
  request,
  refusal,
  accept,
}: {
  contextKey: string;
  generation: number;
  request: () => GameFileQueryRefreshRequest | undefined;
  refusal?: string;
  accept: (
    snapshot: GameFileQuerySnapshot,
    request: GameFileQueryRefreshRequest,
    library: LibraryIdentity,
    now: number,
  ) => T;
}) {
  const [identity, setIdentity] = useState({ key: contextKey, epoch: 0 });
  const currentIdentity =
    identity.key === contextKey ? identity : { key: contextKey, epoch: identity.epoch + 1 };
  if (identity.key !== contextKey) setIdentity(currentIdentity);
  const epoch = currentIdentity.epoch;
  const owner = useRef({ epoch: 0, closed: false });
  const processing = useRef(false);
  const attemptOwner = useRef<object | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{ epoch: number; id: string }>();
  const [error, setError] = useState<{ epoch: number; message: string }>();
  const [outcome, setOutcome] = useState<{ epoch: number; value: GameFileObservationOutcome }>();
  const [accepted, setAccepted] = useState<{
    epoch: number;
    metadata: GameFileObservationMetadata;
  }>();
  const [result, setResult] = useState<{
    epoch: number;
    value: T;
    metadata: GameFileObservationMetadata;
  }>();
  useLayoutEffect(() => {
    const lifecycle = owner.current;
    lifecycle.epoch = epoch;
    lifecycle.closed = false;
    return () => {
      lifecycle.closed = true;
    };
  }, [epoch]);
  const metadata = accepted?.epoch === epoch ? accepted.metadata : undefined;
  const windowExpired = useObservationExpired(metadata, metadata);
  const expired = Boolean(metadata && windowExpired);
  const current =
    result?.epoch === epoch && result.metadata === metadata && !expired ? result.value : undefined;
  const refresh = async () => {
    if (processing.current) return;
    const proposed = request();
    if (!proposed) {
      if (refusal) {
        setError({ epoch, message: refusal });
        setOutcome({ epoch, value: "failed" });
      }
      return;
    }
    const requested = structuredClone(proposed);
    processing.current = true;
    const attempt = {};
    attemptOwner.current = attempt;
    const requestEpoch = epoch;
    const active = () =>
      !owner.current.closed &&
      owner.current.epoch === requestEpoch &&
      attemptOwner.current === attempt;
    setPending(true);
    setOperation(undefined);
    setResult(undefined);
    setError(undefined);
    setOutcome({ epoch, value: "checking" });
    try {
      const library = await desktopApi.libraryIdentity(generation);
      if (!active()) return;
      const snapshot = await desktopApi.refreshGameFileQuery(requested, generation, (event) => {
        if (
          active() &&
          (event.schema_version === 2 || event.schema_version === 3) &&
          event.type === "started" &&
          event.operation === "verify_source"
        )
          setOperation({ epoch: requestEpoch, id: event.operation_id });
      });
      if (!active()) return;
      const value = accept(snapshot, requested, library, Math.floor(Date.now() / 1000));
      const acceptedMetadata: GameFileObservationMetadata = Object.freeze({
        observedAt: snapshot.observed_at,
        expiresAt: snapshot.expires_at,
        deadline:
          performance.now() +
          Math.max(0, Math.min(300_000, snapshot.expires_at * 1000 - Date.now())),
        routes: Object.freeze(
          requested.routes.map(({ port_id, platform, channel, route }) =>
            Object.freeze({ port_id, platform, channel, route }),
          ),
        ),
      });
      setAccepted({ epoch: requestEpoch, metadata: acceptedMetadata });
      setResult({ epoch: requestEpoch, value, metadata: acceptedMetadata });
      setOutcome({ epoch: requestEpoch, value: "accepted" });
    } catch (value) {
      if (active()) {
        setError({ epoch: requestEpoch, message: errorText(value) });
        setOutcome({ epoch: requestEpoch, value: isCancellation(value) ? "cancelled" : "failed" });
      }
    } finally {
      attemptOwner.current = undefined;
      processing.current = false;
      if (!owner.current.closed) {
        setPending(false);
        setOperation(undefined);
      }
    }
  };
  const presentation: GameFileObservationPresentation = {
    lastAccepted: metadata,
    expired,
    usable: current !== undefined,
    outcome: outcome?.epoch === epoch ? outcome.value : pending ? "waiting" : "idle",
  };
  return {
    refresh,
    pending,
    current,
    operationId: operation?.epoch === epoch ? operation.id : undefined,
    error: error?.epoch === epoch ? error.message : undefined,
    expired,
    presentation,
  };
}
