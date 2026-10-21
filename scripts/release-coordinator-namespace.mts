import { isRecord } from "./runtime-values.mts";

/** Existing closed destination contract; independent of journal execution. */
export function inspectCoordinatorRemoteNamespace(configuration: unknown): string {
  if (
    !isRecord(configuration) ||
    Object.keys(configuration).sort().join(",") !== "namespace,schema_version" ||
    configuration.schema_version !== 1 ||
    typeof configuration.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(configuration.namespace) ||
    configuration.namespace.length > 64
  )
    throw new Error("remote coordinator requires separately ratified destination configuration");
  return configuration.namespace;
}
