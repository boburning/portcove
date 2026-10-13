import type {
  CatalogBrowsingContext,
  CatalogBrowsingSnapshot,
  PortDefinition,
  PortStatus,
} from "../types";
import type { CatalogQueryContext } from "../features/browsing/catalog-query";

/** Explicit Core-shaped fixture, not producer or native acceptance evidence. */
export function browsingContextFixture(
  ports: readonly PortDefinition[],
  statuses: ReadonlyMap<string, PortStatus>,
  library: string,
): CatalogQueryContext {
  let identity = 0;
  const contexts: CatalogBrowsingContext[] = [];
  for (const port of ports) {
    const status = statuses.get(port.id);
    const instance = status?.active ?? status?.external_runtime;
    const common = {
      port_id: port.id,
      port_member: Boolean(instance),
      definition_sha256: "a".repeat(64),
      instance_sha256: null,
      installation_id: null,
      installation_method: "portable-package" as const,
      release_version: null,
      artifact_sha256: null,
    };
    for (const platform of port.platforms)
      for (const channel of port.channels)
        contexts.push({
          ...common,
          context_id: (++identity).toString(16).padStart(64, "0"),
          route: "managed_install",
          platform,
          channel,
          member_context: false,
        });
    if (instance)
      contexts.push({
        ...common,
        context_id: (++identity).toString(16).padStart(64, "0"),
        route: status?.active ? "managed_launch" : "external_launch",
        platform: status?.external_runtime?.platform ?? port.platforms[0]!,
        channel: status?.active?.channel ?? "stable",
        installation_method: status?.active ? "referenced-disc" : "user-prepared-runtime",
        member_context: true,
        installation_id: instance.id,
        instance_sha256: "b".repeat(64),
        release_version: instance.version,
      });
  }
  const browsing: CatalogBrowsingSnapshot = {
    schema_version: 1,
    contexts,
    library: { id: "opaque", root: library },
    host_platform: "windows-x86-64",
    retained_metadata_complete: true,
    workspace_binding_sha256: "c".repeat(64),
  };
  return { library: { id: library, statuses }, browsing, devicePlatform: browsing.host_platform };
}
