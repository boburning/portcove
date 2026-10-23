import type { PortDefinition, PortStatus } from "../types";

/** Retained registrations keep their trust interpretation when the catalog changes. */
export function usesUserSelectedRuntime(
  port: Pick<PortDefinition, "release">,
  status?: PortStatus,
) {
  if (status?.active || status?.staged) return false;
  if (status?.external_runtime) return Boolean(status.external_runtime.user_selected);
  if (port.release.provider !== "user-prepared") return false;
  return Object.values(port.release.user_prepared ?? {}).some(
    (runtime) => runtime?.trust === "user-selected",
  );
}

/** Existing installation ownership takes precedence over the current acquisition route. */
export function usesExternalRuntimeRoute(port: PortDefinition, status?: PortStatus) {
  if (status?.active || status?.staged) return false;
  return Boolean(status?.external_runtime) || port.release.provider === "user-prepared";
}
