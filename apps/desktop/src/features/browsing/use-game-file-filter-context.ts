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
  const [route, setRoute] = useState<Route["route"]>("managed_install");
  const [channel, setChannel] = useState<Route["channel"]>("stable");
  const [platformOverride, setPlatform] = useState<Route["platform"]>();
  const platform = platformOverride ?? browsing?.host_platform;
  const binding = browsing?.workspace_binding_sha256;
  // Content identity, serialized only when an input reference changes rather than per render.
  const key = useMemo(
    () =>
      JSON.stringify([
        catalog,
        sources,
        statuses,
        binding,
        generation,
        libraryKey,
        route,
        platform,
        channel,
      ]),
    [catalog, sources, statuses, binding, generation, libraryKey, route, platform, channel],
  );
  const observation = useGameFileObservation({
    contextKey: key,
    generation,
    request: () =>
      catalog && platform
        ? gameFileFilterRequest(catalog.ports, { route, platform, channel })
        : undefined,
    refusal: "catalog_mismatch",
    accept: (snapshot, request, library, now) => {
      const accepted = gameFileFilterContext(snapshot, request, library, libraryKey ?? "", now);
      if (!accepted) throw new GameFileCheckError("catalog_mismatch");
      return accepted;
    },
  });
  const available = Boolean(catalog && libraryKey && platform);
  const refresh = async () => {
    if (!available) return;
    await observation.refresh();
  };
  return {
    selection: { route, platform, channel },
    setRoute,
    setPlatform,
    setChannel,
    refresh,
    pending: observation.pending,
    context: observation.current,
    available,
    operationId: observation.operationId,
    error: observation.error,
    expired: observation.expired,
    observation: observation.presentation,
  };
}

export type GameFileFilterState = ReturnType<typeof useGameFileFilterContext>;
