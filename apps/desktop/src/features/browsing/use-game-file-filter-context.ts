import { useGameFileObservation, GameFileCheckError } from "./use-game-file-observation";
import { useMemo, useState } from "react";
import type {
  CatalogDocument,
  SourceRecord,
  PortStatus,
  CatalogBrowsingSnapshot,
} from "../../types";
import {
  gameFileFilterContext,
  gameFileFilterRequest,
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
  const binding = browsing?.workspace_binding_sha256;
  // Content identity, serialized only when an input reference changes rather than per render.
  const key = useMemo(
    () => JSON.stringify([catalog, sources, statuses, binding, generation, libraryKey, selection]),
    [catalog, sources, statuses, binding, generation, libraryKey, selection],
  );
  const observation = useGameFileObservation({
    contextKey: key,
    generation,
    request: () => (catalog ? gameFileFilterRequest(catalog.ports, selection) : undefined),
    refusal: "catalog_too_large",
    accept: (snapshot, request, library, now) => {
      const accepted = gameFileFilterContext(snapshot, request, library, libraryKey ?? "", now);
      if (!accepted) throw new GameFileCheckError("catalog_mismatch");
      return accepted;
    },
  });
  const refresh = async () => {
    if (!catalog || !libraryKey) return;
    await observation.refresh();
  };
  return {
    selection,
    setSelection,
    refresh,
    pending: observation.pending,
    context: observation.current,
    available: Boolean(catalog && libraryKey),
    operationId: observation.operationId,
    error: observation.error,
    expired: observation.expired,
    observation: observation.presentation,
  };
}

export type GameFileFilterState = ReturnType<typeof useGameFileFilterContext>;
