import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type { CatalogDocument, SourceRecord, PortStatus } from "../../types";
import { errorText } from "../../view-model";
import {
  gameFileFilterContext,
  gameFileFilterRequest,
  type GameFileFilterContext,
  type Route,
} from "./game-file-query-context";

/** Explicit observation lifecycle. Search, filter and view changes are deliberately not inputs. */
export function useGameFileFilterContext({
  catalog,
  sources,
  statuses,
  generation,
  libraryKey,
}: {
  catalog?: CatalogDocument | null;
  sources: readonly SourceRecord[];
  statuses: readonly PortStatus[];
  generation: number;
  libraryKey?: string | null;
}) {
  const [selection, setSelection] = useState<Omit<Route, "port_id">>({
    route: "managed_install",
    platform: "windows-x86-64",
    channel: "stable",
  });
  const key = JSON.stringify([catalog, sources, statuses, generation, libraryKey, selection]);
  const owner = useRef({ key, epoch: 0, closed: false, processing: false });
  if (owner.current.key !== key) {
    owner.current.key = key;
    owner.current.epoch += 1;
  }
  const epoch = owner.current.epoch;
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{ epoch: number; id: string }>();
  const [result, setResult] = useState<{
    epoch: number;
    context: GameFileFilterContext;
    deadline: number;
  }>();
  const [error, setError] = useState<{ epoch: number; message: string }>();
  const [expiredEpoch, setExpiredEpoch] = useState<number>();
  const invalidObservation = useRef<number | undefined>(undefined);
  useEffect(() => {
    owner.current.closed = false;
    return () => {
      owner.current.closed = true;
    };
  }, []);
  if (
    result?.epoch === epoch &&
    (Date.now() >= result.context.expiresAt * 1000 ||
      Date.now() < result.context.observedAt * 1000 ||
      performance.now() >= result.deadline)
  )
    invalidObservation.current = epoch;
  const expired = expiredEpoch === epoch || invalidObservation.current === epoch;
  const context = result?.epoch === epoch && !expired ? result.context : undefined;
  useEffect(() => {
    if (!context) return;
    const deadline =
      performance.now() + Math.max(0, Math.min(300_000, context.expiresAt * 1000 - Date.now()));
    const expire = () => {
      if (Date.now() >= context.expiresAt * 1000 || performance.now() >= deadline)
        setExpiredEpoch(epoch);
    };
    const timer = setTimeout(
      () => setExpiredEpoch(epoch),
      Math.max(0, deadline - performance.now()),
    );
    const clock = setInterval(expire, 1000);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [context, epoch]);
  const refresh = async () => {
    if (owner.current.processing || !catalog || !libraryKey) return;
    const request = gameFileFilterRequest(catalog.ports, selection);
    if (!request) {
      setError({
        epoch,
        message:
          "This catalog exceeds the bounded complete query scope. Game-file filters are unavailable.",
      });
      return;
    }
    const requestEpoch = epoch;
    const active = () => !owner.current.closed && owner.current.epoch === requestEpoch;
    owner.current.processing = true;
    setPending(true);
    setOperation(undefined);
    setResult(undefined);
    setError(undefined);
    setExpiredEpoch(undefined);
    invalidObservation.current = undefined;
    try {
      const library = await desktopApi.libraryIdentity(generation);
      if (!active()) return;
      const snapshot = await desktopApi.refreshGameFileQuery(request, generation, (event) => {
        if (
          active() &&
          (event.schema_version === 2 || event.schema_version === 3) &&
          event.type === "started" &&
          event.operation === "verify_source"
        )
          setOperation({ epoch: requestEpoch, id: event.operation_id });
      });
      if (!active()) return;
      const accepted = gameFileFilterContext(
        snapshot,
        request,
        library,
        libraryKey,
        Math.floor(Date.now() / 1000),
      );
      if (!accepted)
        throw new Error(
          "The complete game-file observation no longer matches this context. Check again.",
        );
      setResult({
        epoch: requestEpoch,
        context: accepted,
        deadline:
          performance.now() +
          Math.max(0, Math.min(300_000, accepted.expiresAt * 1000 - Date.now())),
      });
    } catch (value) {
      if (active()) setError({ epoch: requestEpoch, message: errorText(value) });
    } finally {
      owner.current.processing = false;
      if (!owner.current.closed) {
        setPending(false);
        setOperation(undefined);
      }
    }
  };
  return {
    selection,
    setSelection,
    refresh,
    pending,
    context,
    available: Boolean(catalog && libraryKey),
    operationId: operation?.epoch === epoch ? operation.id : undefined,
    error: error?.epoch === epoch ? error.message : undefined,
    expired,
  };
}

export type GameFileFilterState = ReturnType<typeof useGameFileFilterContext>;
