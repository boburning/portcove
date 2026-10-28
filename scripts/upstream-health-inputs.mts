import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import { assessUpstreamLineage, type UpstreamLineage } from "./upstream-lineage.mts";

// Version the facts consumed by the location and RetComM observers separately
// from the catalog's presentation and installation contracts. Adding a new
// consumed field requires updating this projection and its behavior tests.
export const HEALTH_INPUTS_VERSION = 1;

export interface HealthPortInputs {
  format_version: 1;
  id: string;
  project_url: string | null;
  upstream_status: string;
  adapter: string | null;
  platforms: string[];
  release: {
    provider: string;
    repository: string | null;
    direct: Record<string, { url: string; version: string; size: number; sha256: string }>;
  };
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid upstream health ${field}`);
  return value;
}

export function healthPortInputs(value: unknown): HealthPortInputs {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id)
  )
    throw new Error("Upstream health inputs require a stable port ID");
  if (value.release !== undefined && !isRecord(value.release))
    throw new Error("Invalid upstream health release");
  const release = isRecord(value.release) ? value.release : {};
  const directEntries: [string, HealthPortInputs["release"]["direct"][string]][] = [];
  if (release.direct !== undefined) {
    if (!isRecord(release.direct)) throw new Error("Invalid upstream health direct artifacts");
    for (const [platform, artifact] of Object.entries(release.direct)) {
      if (
        !isRecord(artifact) ||
        typeof artifact.url !== "string" ||
        typeof artifact.version !== "string" ||
        typeof artifact.size !== "number" ||
        !Number.isSafeInteger(artifact.size) ||
        typeof artifact.sha256 !== "string"
      )
        throw new Error("Invalid upstream health artifact identity");
      directEntries.push([
        platform,
        {
          url: artifact.url,
          version: artifact.version,
          size: artifact.size,
          sha256: artifact.sha256,
        },
      ]);
    }
  }
  let platforms: string[] = [];
  if (value.platforms !== undefined) {
    if (
      !Array.isArray(value.platforms) ||
      !value.platforms.every((entry: unknown) => typeof entry === "string")
    )
      throw new Error("Invalid upstream health platforms");
    platforms = value.platforms.toSorted();
  }
  return {
    format_version: HEALTH_INPUTS_VERSION,
    id: value.id,
    project_url: optionalString(value.project_url, "project URL"),
    upstream_status: optionalString(value.upstream_status, "maintenance status") ?? "active",
    adapter: optionalString(value.adapter, "adapter"),
    platforms,
    release: {
      provider: optionalString(release.provider, "release provider") ?? "github",
      repository: optionalString(release.repository, "release repository"),
      direct: Object.fromEntries(directEntries),
    },
  };
}

export function healthPortHash(port: unknown): string {
  return observationHash(healthPortInputs(port));
}

export interface HealthLineageInputs {
  listing: { id: string; project_url: string; issue_number?: number };
  upstream_lineage?: UpstreamLineage;
}

// The collector reports reviewed authoring facts in addition to the generated
// runtime catalog. Bind those facts without pulling artwork or listing copy
// back into monitoring applicability. The shared lineage validator owns their
// decision/review semantics; this projection supplies its narrow listing input.
export function healthLineageInputs(value: unknown): HealthLineageInputs {
  if (
    !isRecord(value) ||
    !isRecord(value.listing) ||
    typeof value.listing.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.listing.id) ||
    typeof value.listing.project_url !== "string" ||
    Buffer.byteLength(value.listing.project_url) > 4096 ||
    value.listing.project_url.trim() !== value.listing.project_url ||
    /\p{Cc}/u.test(value.listing.project_url) ||
    (value.listing.issue_number !== undefined &&
      (!Number.isSafeInteger(value.listing.issue_number) || Number(value.listing.issue_number) < 1))
  )
    throw new Error("Invalid upstream health lineage listing");
  const url = new URL(value.listing.project_url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Upstream health lineage requires a credential-free HTTPS project URL");
  const inputs: HealthLineageInputs = {
    listing: {
      id: value.listing.id,
      project_url: value.listing.project_url,
      ...(value.listing.issue_number === undefined
        ? {}
        : { issue_number: Number(value.listing.issue_number) }),
    },
    ...(value.upstream_lineage === undefined
      ? {}
      : { upstream_lineage: value.upstream_lineage as UpstreamLineage }),
  };
  assessUpstreamLineage(inputs);
  return inputs;
}

export function healthArtifactHash(port: unknown, platform: string): string {
  const inputs = healthPortInputs(port);
  if (!Object.hasOwn(inputs.release.direct, platform))
    throw new Error("Unknown upstream health artifact platform");
  const artifact = inputs.release.direct[platform];
  if (!artifact) throw new Error("Unknown upstream health artifact platform");
  return observationHash({
    format_version: HEALTH_INPUTS_VERSION,
    port_id: inputs.id,
    platform,
    provider: inputs.release.provider,
    artifact,
  });
}

export function healthEndpointHash(
  port: unknown,
  role: "project" | "acquisition",
  provider: string,
  repository: string,
): string {
  const inputs = healthPortInputs(port);
  if (!["project", "acquisition"].includes(role) || !provider || !repository)
    throw new Error("Invalid upstream health endpoint identity");
  return observationHash({
    format_version: HEALTH_INPUTS_VERSION,
    port_id: inputs.id,
    role,
    provider,
    repository,
    upstream_status: inputs.upstream_status,
    declaration:
      role === "project"
        ? { project_url: inputs.project_url }
        : { provider: inputs.release.provider, repository: inputs.release.repository },
  });
}

export interface HealthCatalogInputs {
  format_version: 1;
  schema_version: number | null;
  ports: { port: HealthPortInputs; qualification: Record<string, unknown>[] }[];
  unassigned_qualification: Record<string, unknown>[];
}

export function healthCatalogInputs(value: unknown): HealthCatalogInputs {
  if (!isRecord(value) || !Array.isArray(value.ports))
    throw new Error("Upstream health inputs require catalog ports");
  if (
    value.schema_version !== undefined &&
    (typeof value.schema_version !== "number" || !Number.isSafeInteger(value.schema_version))
  )
    throw new Error("Invalid upstream health catalog schema version");
  const ports = value.ports
    .map(healthPortInputs)
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(ports.map((port) => port.id));
  if (ids.size !== ports.length) throw new Error("Catalog requires unique stable port IDs");
  if (value.source_catalog !== undefined && !isRecord(value.source_catalog))
    throw new Error("Invalid source catalog");
  const source = isRecord(value.source_catalog) ? value.source_catalog : {};
  const qualification: Record<string, unknown>[] = [];
  if (source.qualification !== undefined) {
    if (!Array.isArray(source.qualification)) throw new Error("Invalid qualification records");
    for (const record of source.qualification) {
      if (!isRecord(record) || !isRecord(record.scope) || typeof record.scope.port_id !== "string")
        throw new Error("Qualification requires a port identity");
      qualification.push(record);
    }
  }
  const portId = (record: Record<string, unknown>) =>
    isRecord(record.scope) ? record.scope.port_id : undefined;
  return {
    format_version: HEALTH_INPUTS_VERSION,
    schema_version: typeof value.schema_version === "number" ? value.schema_version : null,
    ports: ports.map((port) => ({
      port,
      qualification: qualification.filter((record) => portId(record) === port.id),
    })),
    unassigned_qualification: qualification.filter((record) => !ids.has(String(portId(record)))),
  };
}

// Freshness includes retained qualification and authoring lineage because the
// collector reports both. Reviewed endpoint and artifact rules still use their
// narrower role/platform hashes instead of this complete observation snapshot.
export function healthCatalogPortHashes(
  catalog: unknown,
  lineageRecords: unknown[] = [],
): Map<string, string> {
  const inputs = healthCatalogInputs(catalog);
  if (!Array.isArray(lineageRecords) || lineageRecords.length > inputs.ports.length)
    throw new Error("Invalid upstream health lineage inventory");
  const ports = new Map(inputs.ports.map((entry) => [entry.port.id, entry]));
  const lineage = new Map<string, HealthLineageInputs>();
  for (const record of lineageRecords) {
    if (
      !isRecord(record) ||
      !isRecord(record.listing) ||
      typeof record.listing.id !== "string" ||
      !ports.has(record.listing.id) ||
      lineage.has(record.listing.id)
    )
      throw new Error("Invalid or duplicate upstream health lineage port");
    const validated = healthLineageInputs(record);
    if (validated.listing.project_url !== ports.get(record.listing.id)?.port.project_url)
      throw new Error("Upstream health lineage differs from the catalog project identity");
    lineage.set(record.listing.id, validated);
  }
  return new Map(
    inputs.ports.map((port) => [
      port.port.id,
      observationHash({
        format_version: HEALTH_INPUTS_VERSION,
        schema_version: inputs.schema_version,
        ...port,
        lineage: lineage.get(port.port.id) ?? null,
      }),
    ]),
  );
}

export function healthCatalogPortHash(
  catalog: unknown,
  portId: string,
  lineageRecords: unknown[] = [],
): string {
  const hash = healthCatalogPortHashes(catalog, lineageRecords).get(portId);
  if (!hash) throw new Error("Unknown upstream health port ID");
  return hash;
}
