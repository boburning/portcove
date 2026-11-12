import type { TFunction } from "i18next";
import type {
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  PortDefinition,
  LibraryIdentity,
} from "../../types";
export type Route = GameFileQueryRefreshRequest["routes"][number];
type State = GameFileQuerySnapshot["routes"][number]["state"];
type Reason = GameFileQuerySnapshot["routes"][number]["reason"];

/** The route options in display order; labels resolve through gameFileRouteLabel. */
export const routeValues: readonly Route["route"][] = [
  "managed_install",
  "external_registration",
  "managed_launch",
  "external_launch",
];

/** Values Core may report; exhaustive records keep these in step with the transport types. */
const knownStates: Record<State, true> = {
  files_available: true,
  files_missing: true,
  needs_checking: true,
  no_files_required: true,
  unavailable_context: true,
};
const knownReasons: Record<Reason, true> = {
  complete_compatible_observation: true,
  no_connected_registration: true,
  explicit_empty_requirements: true,
  observation_unavailable: true,
  observation_stale: true,
  source_needs_checking: true,
  storage_absence_unconfirmed: true,
  identity_not_admitted: true,
  contract_not_reviewed: true,
  variant_not_supported: true,
  release_not_bound: true,
  route_not_offered: true,
  profile_context_changed: true,
};

/** Labels by static key, so extraction keeps every form and a live language change re-renders. */
export function gameFileRouteLabel(t: TFunction<"gameFiles">, route: Route["route"]) {
  switch (route) {
    case "managed_install":
      return t("route.managedInstall");
    case "external_registration":
      return t("route.externalRegistration");
    case "managed_launch":
      return t("route.managedLaunch");
    case "external_launch":
      return t("route.externalLaunch");
  }
}

export function gameFileStateLabel(t: TFunction<"gameFiles">, state: State) {
  switch (state) {
    case "files_available":
      return t("state.filesAvailable");
    case "files_missing":
      return t("state.filesMissing");
    case "needs_checking":
      return t("state.needsChecking");
    case "no_files_required":
      return t("state.noFilesRequired");
    case "unavailable_context":
      return t("state.unavailableContext");
  }
}

export function gameFileReasonLabel(t: TFunction<"gameFiles">, reason: Reason) {
  switch (reason) {
    case "complete_compatible_observation":
      return t("reason.completeCompatibleObservation");
    case "no_connected_registration":
      return t("reason.noConnectedRegistration");
    case "explicit_empty_requirements":
      return t("reason.explicitEmptyRequirements");
    case "observation_unavailable":
      return t("reason.observationUnavailable");
    case "observation_stale":
      return t("reason.observationStale");
    case "source_needs_checking":
      return t("reason.sourceNeedsChecking");
    case "storage_absence_unconfirmed":
      return t("reason.storageAbsenceUnconfirmed");
    case "identity_not_admitted":
      return t("reason.identityNotAdmitted");
    case "contract_not_reviewed":
      return t("reason.contractNotReviewed");
    case "variant_not_supported":
      return t("reason.variantNotSupported");
    case "release_not_bound":
      return t("reason.releaseNotBound");
    case "route_not_offered":
      return t("reason.routeNotOffered");
    case "profile_context_changed":
      return t("reason.profileContextChanged");
  }
}

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
    Object.hasOwn(knownStates, projection.state) &&
    Object.hasOwn(knownReasons, projection.reason) &&
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
