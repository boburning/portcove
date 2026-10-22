import type { PortDefinition, PortStatus } from "../types";

/** Retained registrations keep their trust interpretation when the catalog changes. */
export function usesUserSelectedRuntime(port: PortDefinition, status?: PortStatus) {
  if (status?.external_runtime) return Boolean(status.external_runtime.user_selected);
  return Object.values(port.release.user_prepared).some(
    (runtime) => runtime?.trust === "user-selected",
  );
}
