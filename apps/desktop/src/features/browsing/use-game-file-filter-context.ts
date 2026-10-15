import { useObservationExpired } from "./use-observation-expiry";
import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import type {
  CatalogDocument,
  SourceRecord,
  PortStatus,
  CatalogBrowsingSnapshot,
} from "../../types";
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
  browsing,
  generation,
  libraryKey,
}: {
  catalog?: CatalogDocument | null | undefined;
  sources: readonly SourceRecord[];
  statuses: readonly PortStatus[];
  browsing?: CatalogBrowsingSnapshot | null | undefined;
  generation: number;
  libraryKey?: string | null;
}) {
  const [selection, setSelection] = useState<Omit<Route, "port_id">>({
    route: "managed_install",
    platform: "windows-x86-64",
    channel: "stable",
  });
  const key = JSON.stringify([
    catalog,
    sources,
    statuses,
    browsing?.workspace_binding_sha256,
    generation,
    libraryKey,
    selection,
  ]);
  const [identity, setIdentity] = useState({ key, epoch: 0 });
  const currentIdentity = identity.key === key ? identity : { key, epoch: identity.epoch + 1 };
  if (identity.key !== key) setIdentity(currentIdentity);
  const epoch = currentIdentity.epoch;
  const owner = useRef({ epoch: 0, closed: false, processing: false });
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{ epoch: number; id: string }>();
  const [result, setResult] = useState<{
    epoch: number;
    context: GameFileFilterContext;
    deadline: number;
  }>();
  const [error, setError] = useState<{ epoch: number; message: string }>();
  useLayoutEffect(() => {
    const lifecycle = owner.current;
    lifecycle.epoch = epoch;
    lifecycle.closed = false;
    return () => {
      lifecycle.closed = true;
    };
  }, [epoch]);
  const window = result
    ? {
        observedAt: result.context.observedAt,
        expiresAt: result.context.expiresAt,
        deadline: result.deadline,
      }
    : undefined;
  const windowExpired = useObservationExpired(result, window);
  const expired = Boolean(result?.epoch === epoch && windowExpired);
  const context = result?.epoch === epoch && !expired ? result.context : undefined;
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
