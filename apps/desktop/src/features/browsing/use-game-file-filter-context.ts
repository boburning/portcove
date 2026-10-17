import { useGameFileObservation } from "./use-game-file-observation";
import { useState } from "react";
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
  const key = JSON.stringify([
    catalog,
    sources,
    statuses,
    browsing?.workspace_binding_sha256,
    generation,
    libraryKey,
    selection,
  ]);
  const observation = useGameFileObservation({
    contextKey: key,
    generation,
    request: () => (catalog ? gameFileFilterRequest(catalog.ports, selection) : undefined),
    refusal:
      "This catalog exceeds the bounded complete query scope. Game-file filters are unavailable.",
    accept: (snapshot, request, library, now) => {
      const accepted = gameFileFilterContext(snapshot, request, library, libraryKey ?? "", now);
      if (!accepted)
        throw new Error(
          "The complete game-file observation no longer matches this context. Check again.",
        );
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
