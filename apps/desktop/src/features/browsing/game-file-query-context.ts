import type {
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  PortDefinition,
  LibraryIdentity,
} from "../../types";
export type Route = GameFileQueryRefreshRequest["routes"][number];
export const routes: readonly { value: Route["route"]; label: string }[] = [
  { value: "managed_install", label: "Managed setup" },
  { value: "external_registration", label: "Existing installation setup" },
  { value: "managed_launch", label: "Managed launch" },
  { value: "external_launch", label: "Existing installation launch" },
];
export const states: Record<GameFileQuerySnapshot["routes"][number]["state"], string> = {
  files_available: "Compatible complete files available",
  files_missing: "Files missing",
  needs_checking: "Needs checking",
  no_files_required: "No files to add in Portcove",
  unavailable_context: "Unavailable context",
};
export const reasons: Record<GameFileQuerySnapshot["routes"][number]["reason"], string> = {
  complete_compatible_observation: "Core observed a complete compatible set for this route.",
  no_connected_registration: "No game-file registration is connected for this route.",
  explicit_empty_requirements:
    "This action needs no files added to Portcove. The game may still ask for original files.",
  observation_unavailable: "An accepted observation is unavailable.",
  observation_stale: "The observation needs a fresh check.",
  source_needs_checking: "The connected files need checking.",
  storage_absence_unconfirmed:
    "Storage could not confirm absence; files are not confirmed missing.",
  identity_not_admitted: "The file identity has not been admitted for this route.",
  contract_not_reviewed: "The game-file contract has not been reviewed for this route.",
  variant_not_supported: "The observed file variant does not match this route.",
  release_not_bound: "The observation is not bound to the selected release.",
  route_not_offered: "The selected route is not offered.",
  profile_context_changed: "The selected game-file context has changed.",
};

/** Validate presentation context only. Core remains the execution authority. */
export function acceptedGameFileQuery(
  snapshot: GameFileQuerySnapshot,
  request: Route,
  library: { id: string; root: string },
  now: number,
): boolean {
  const projection = snapshot.routes?.[0];
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0;
  return (
    snapshot.schema_version === 1 &&
    snapshot.library?.id === library.id &&
    snapshot.library?.root === library.root &&
    snapshot.routes?.length === 1 &&
    Number.isSafeInteger(snapshot.observed_at) &&
    Number.isSafeInteger(snapshot.expires_at) &&
    snapshot.observed_at > 0 &&
    snapshot.observed_at <= now &&
    now <= snapshot.expires_at &&
    snapshot.expires_at - snapshot.observed_at <= 300 &&
    digest(snapshot.catalog_binding_sha256) &&
    digest(snapshot.registration_sha256) &&
    digest(snapshot.selection_sha256) &&
    !!projection &&
    projection.port_id === request.port_id &&
    projection.platform === request.platform &&
    projection.channel === request.channel &&
    projection.route === request.route &&
    Object.hasOwn(states, projection.state) &&
    Object.hasOwn(reasons, projection.reason) &&
    (projection.state !== "files_available" ||
      (projection.reason === "complete_compatible_observation" &&
        identifier(projection.contract_id) &&
        identifier(projection.identity?.game_id) &&
        identifier(projection.identity?.variant_id) &&
        identifier(projection.identity?.representation_id) &&
        digest(projection.source_instance_sha256) &&
        digest(projection.route_definition_sha256))) &&
    (projection.state !== "files_missing" || projection.reason === "no_connected_registration") &&
    (projection.state !== "no_files_required" ||
      (projection.reason === "explicit_empty_requirements" &&
        digest(projection.route_definition_sha256)))
  );
}

export interface GameFileFilterContext {
  /** Selected-library browsing scope, separately bound to Core's opaque identity. */
  libraryKey: string;
  library: LibraryIdentity;
  selection: Omit<Route, "port_id">;
  observedAt: number;
  expiresAt: number;
  byPort: ReadonlyMap<string, GameFileQuerySnapshot["routes"][number]>;
}

/** One explicit bounded request for the complete accepted catalog. No subset or automatic chunking. */
export function gameFileFilterRequest(
  ports: readonly PortDefinition[],
  selection: Omit<Route, "port_id">,
): GameFileQueryRefreshRequest | undefined {
  if (
    ports.length === 0 ||
    ports.length > 256 ||
    new Set(ports.map((port) => port.id)).size !== ports.length ||
    ports.some((port) => !port.id || new TextEncoder().encode(port.id).length > 128)
  )
    return undefined;
  return {
    routes: ports.map((port) => ({ port_id: port.id, ...selection })),
    maximum_age_seconds: 300,
    limits: {
      max_file_bytes: 2 * 1024 ** 3,
      max_hash_bytes: 32 * 1024 ** 3,
      max_elapsed_ms: 30_000,
    },
  };
}

/** Accept only exact complete response coverage. Unchecked entries cannot acquire zero counts. */
export function gameFileFilterContext(
  snapshot: GameFileQuerySnapshot,
  request: GameFileQueryRefreshRequest,
  library: LibraryIdentity,
  libraryKey: string,
  now: number,
): GameFileFilterContext | undefined {
  if (
    !libraryKey ||
    request.routes.length === 0 ||
    request.routes.length > 256 ||
    snapshot.routes?.length !== request.routes.length ||
    new Set(request.routes.map((route) => route.port_id)).size !== request.routes.length
  )
    return undefined;
  const selection = request.routes[0];
  if (!selection) return undefined;
  if (
    !request.routes.every((route, index) => {
      const projection = snapshot.routes[index];
      return (
        projection !== undefined &&
        route.platform === selection.platform &&
        route.channel === selection.channel &&
        route.route === selection.route &&
        acceptedGameFileQuery({ ...snapshot, routes: [projection] }, route, library, now)
      );
    })
  )
    return undefined;
  return {
    libraryKey,
    library,
    selection: { platform: selection.platform, channel: selection.channel, route: selection.route },
    observedAt: snapshot.observed_at,
    expiresAt: snapshot.expires_at,
    byPort: new Map(snapshot.routes.map((route) => [route.port_id, route])),
  };
}
