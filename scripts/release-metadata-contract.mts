import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

// These parsers bind declared facts. Neither hashes nor journal persistence
// authenticate a root, current public feed, provider readback or execution grant.
const roles = ["targets", "snapshot", "timestamp", "releases", "preview", "stable"] as const;
const roleKeys = [...roles].sort().join(",");
type Roles<T> = Record<(typeof roles)[number], T>;
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("metadata contract schema differs");
}
function sha(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("metadata identity invalid");
}
function text(raw: unknown): asserts raw is string {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 512 ||
    Array.from(raw).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("metadata evidence identity invalid");
}
export function metadataInstant(raw: unknown): bigint {
  if (typeof raw !== "string") throw new Error("metadata time invalid");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(raw);
  if (!match || (match[2] && match[2].endsWith("0")))
    throw new Error("metadata time must be canonical UTC");
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  )
    throw new Error("metadata calendar time invalid");
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}
function versions(raw: unknown): Roles<string> {
  exact(raw, roleKeys);
  for (const role of roles) {
    const value = raw[role];
    if (
      typeof value !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(value) ||
      BigInt(value) > 18_446_744_073_709_551_615n
    )
      throw new Error("metadata version must be canonical positive u64 text");
  }
  return Object.fromEntries(roles.map((role) => [role, raw[role]])) as Roles<string>;
}
function expires(raw: unknown): Roles<string> {
  exact(raw, roleKeys);
  for (const role of roles) metadataInstant(raw[role]);
  return Object.fromEntries(roles.map((role) => [role, raw[role]])) as Roles<string>;
}
export function inspectMetadataRenewalDescriptor(raw: unknown) {
  const online = isRecord(raw) && raw.schema_version === 2;
  const keys =
    "current_expires,current_versions,generated_at,kind,next_expires,next_versions,offline_targets_sha256,prior_repository_sha256,prior_snapshot_sha256,prior_timestamp_sha256,root_sha256,schema_version,unchanged_records_sha256";
  exact(raw, online ? `${keys},top_level_targets_profile`.split(",").sort().join(",") : keys);
  if (
    (!online && raw.schema_version !== 1) ||
    raw.kind !== "application-tuf-metadata-renewal" ||
    (online && raw.top_level_targets_profile !== "online-unchanged-authority-v1")
  )
    throw new Error("unsupported metadata renewal contract");
  const generated = metadataInstant(raw.generated_at);
  for (const key of [
    "offline_targets_sha256",
    "prior_repository_sha256",
    "prior_snapshot_sha256",
    "prior_timestamp_sha256",
    "root_sha256",
    "unchanged_records_sha256",
  ] as const)
    sha(raw[key]);
  const current = versions(raw.current_versions),
    next = versions(raw.next_versions),
    beforeExpiry = expires(raw.current_expires),
    nextExpiry = expires(raw.next_expires);
  for (const role of roles) {
    if (role === "targets" && !online) {
      if (current[role] !== next[role] || beforeExpiry[role] !== nextExpiry[role])
        throw new Error("metadata renewal cannot change offline targets");
    } else {
      const days = role === "timestamp" ? 2 : role === "releases" || role === "targets" ? 90 : 7;
      if (
        BigInt(next[role]) !== BigInt(current[role]) + 1n ||
        metadataInstant(nextExpiry[role]) <= metadataInstant(beforeExpiry[role]) ||
        metadataInstant(nextExpiry[role]) > generated + BigInt(days) * 86_400_000_000_000n
      )
        throw new Error("metadata version/expiry progression differs");
    }
  }
  return {
    schema_version: online ? (2 as const) : (1 as const),
    ...(online ? { top_level_targets_profile: "online-unchanged-authority-v1" as const } : {}),
    kind: "application-tuf-metadata-renewal" as const,
    generated_at: String(raw.generated_at),
    root_sha256: raw.root_sha256,
    offline_targets_sha256: raw.offline_targets_sha256,
    prior_repository_sha256: raw.prior_repository_sha256,
    prior_timestamp_sha256: raw.prior_timestamp_sha256,
    prior_snapshot_sha256: raw.prior_snapshot_sha256,
    current_versions: current,
    next_versions: next,
    current_expires: beforeExpiry,
    next_expires: nextExpiry,
    unchanged_records_sha256: raw.unchanged_records_sha256,
  };
}
/** Explicit no-prior setup facts. This is not an authenticated absence proof,
 * a root appointment or permission to create/configure a public site. */
export function inspectMetadataBootstrapDescriptor(raw: unknown) {
  exact(
    raw,
    "expires,generated_at,initial_records_sha256,initial_site_preimage_sha256,kind,offline_targets_sha256,payload_key_registry_sha256,root_sha256,schema_version,setup_plan_sha256,versions",
  );
  if (raw.schema_version !== 1 || raw.kind !== "application-tuf-initial-bootstrap")
    throw new Error("unsupported initial metadata bootstrap contract");
  const generated = metadataInstant(raw.generated_at);
  for (const key of [
    "setup_plan_sha256",
    "initial_site_preimage_sha256",
    "root_sha256",
    "offline_targets_sha256",
    "payload_key_registry_sha256",
    "initial_records_sha256",
  ] as const)
    sha(raw[key]);
  const initialVersions = versions(raw.versions),
    initialExpires = expires(raw.expires);
  if (raw.initial_records_sha256 !== digest([]))
    throw new Error("initial metadata bootstrap must contain no release/channel records");
  for (const role of roles) {
    const days = role === "timestamp" ? 2 : role === "targets" || role === "releases" ? 90 : 7;
    const expiry = metadataInstant(initialExpires[role]);
    if (
      (role !== "targets" && initialVersions[role] !== "1") ||
      expiry <= generated ||
      expiry > generated + BigInt(days) * 86_400_000_000_000n
    )
      throw new Error("initial metadata versions or expiry exceed first-generation scope");
  }
  return {
    schema_version: 1 as const,
    kind: "application-tuf-initial-bootstrap" as const,
    generated_at: String(raw.generated_at),
    setup_plan_sha256: raw.setup_plan_sha256,
    initial_site_preimage_sha256: raw.initial_site_preimage_sha256,
    root_sha256: raw.root_sha256,
    offline_targets_sha256: raw.offline_targets_sha256,
    payload_key_registry_sha256: raw.payload_key_registry_sha256,
    initial_records_sha256: raw.initial_records_sha256,
    versions: initialVersions,
    expires: initialExpires,
  };
}
export function assertMetadataBootstrapBinding(
  descriptor: ReturnType<typeof inspectMetadataBootstrapDescriptor>,
  published: ReturnType<typeof inspectPublishedMetadata>,
  now: unknown,
) {
  if (published)
    throw new Error("initial metadata bootstrap is permanently closed by published metadata");
  const time = metadataInstant(now);
  if (metadataInstant(descriptor.generated_at) > time + 300_000_000_000n)
    throw new Error("initial metadata generation clock is future");
  for (const role of roles)
    if (metadataInstant(descriptor.expires[role]) <= time)
      throw new Error("expired initial metadata bootstrap requires separate recovery");
}
export function assertMetadataBootstrapPublication(rawDescriptor: unknown, rawFacts: unknown) {
  const descriptor = inspectMetadataBootstrapDescriptor(rawDescriptor),
    facts = inspectTufPublicationFacts(rawFacts);
  if (
    facts.root_sha256 !== descriptor.root_sha256 ||
    facts.offline_targets_sha256 !== descriptor.offline_targets_sha256 ||
    facts.records_sha256 !== descriptor.initial_records_sha256 ||
    digest(facts.versions) !== digest(descriptor.versions) ||
    digest(facts.expires) !== digest(descriptor.expires)
  )
    throw new Error("assembled initial publication differs from exact bootstrap descriptor");
  return descriptor;
}
/** Shape/binding only. The admitted caller must obtain these facts from the
 * actual pinned keyless verifier, never an imported report or artifact label. */
export function inspectTufPublicationFacts(raw: unknown) {
  exact(
    raw,
    "expires,offline_targets_sha256,records_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,versions",
  );
  if (raw.schema_version !== 1) throw new Error("unsupported authenticated TUF publication facts");
  for (const key of [
    "offline_targets_sha256",
    "records_sha256",
    "repository_sha256",
    "root_sha256",
    "snapshot_sha256",
    "timestamp_sha256",
  ] as const)
    sha(raw[key]);
  return {
    schema_version: 1 as const,
    root_sha256: raw.root_sha256,
    offline_targets_sha256: raw.offline_targets_sha256,
    repository_sha256: raw.repository_sha256,
    timestamp_sha256: raw.timestamp_sha256,
    snapshot_sha256: raw.snapshot_sha256,
    records_sha256: raw.records_sha256,
    versions: versions(raw.versions),
    expires: expires(raw.expires),
  };
}

/** Match actual verifier output to the exact frozen maintenance opportunity
 * before any public mutation. Valid signatures alone cannot authorize different
 * records, offline anchors, versions or expirations. */
export function assertMetadataRenewalPublication(rawDescriptor: unknown, rawFacts: unknown) {
  const descriptor = inspectMetadataRenewalDescriptor(rawDescriptor);
  const facts = inspectTufPublicationFacts(rawFacts);
  if (
    facts.root_sha256 !== descriptor.root_sha256 ||
    (descriptor.schema_version === 1 &&
      facts.offline_targets_sha256 !== descriptor.offline_targets_sha256) ||
    (descriptor.schema_version === 2 &&
      facts.offline_targets_sha256 === descriptor.offline_targets_sha256) ||
    facts.records_sha256 !== descriptor.unchanged_records_sha256 ||
    digest(facts.versions) !== digest(descriptor.next_versions) ||
    digest(facts.expires) !== digest(descriptor.next_expires)
  )
    throw new Error("assembled publication differs from frozen metadata renewal");
  return descriptor;
}

export function inspectPublishedMetadata(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  exact(
    raw,
    "expires,offline_targets_sha256,operation_id,publication,records_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,versions",
  );
  if (raw.schema_version !== 1) throw new Error("unsupported published metadata contract");
  for (const key of [
    "offline_targets_sha256",
    "records_sha256",
    "repository_sha256",
    "root_sha256",
    "snapshot_sha256",
    "timestamp_sha256",
  ] as const)
    sha(raw[key]);
  if (raw.operation_id !== null) sha(raw.operation_id);
  exact(raw.publication, "evidence_sha256,remote_identity,site_generation_sha256");
  sha(raw.publication.evidence_sha256);
  sha(raw.publication.site_generation_sha256);
  text(raw.publication.remote_identity);
  return {
    schema_version: 1 as const,
    root_sha256: raw.root_sha256,
    offline_targets_sha256: raw.offline_targets_sha256,
    repository_sha256: raw.repository_sha256,
    timestamp_sha256: raw.timestamp_sha256,
    snapshot_sha256: raw.snapshot_sha256,
    records_sha256: raw.records_sha256,
    versions: versions(raw.versions),
    expires: expires(raw.expires),
    operation_id: raw.operation_id,
    publication: {
      remote_identity: raw.publication.remote_identity,
      evidence_sha256: raw.publication.evidence_sha256,
      site_generation_sha256: raw.publication.site_generation_sha256,
    },
  };
}
export function assertMetadataRenewalBinding(
  descriptor: ReturnType<typeof inspectMetadataRenewalDescriptor>,
  published: ReturnType<typeof inspectPublishedMetadata>,
  now: unknown,
) {
  if (!published)
    throw new Error("metadata renewal held: authenticated published metadata seed absent");
  const time = metadataInstant(now),
    generated = metadataInstant(descriptor.generated_at);
  if (generated > time + 300_000_000_000n)
    throw new Error("metadata renewal generation clock is future");
  if (
    descriptor.root_sha256 !== published.root_sha256 ||
    descriptor.offline_targets_sha256 !== published.offline_targets_sha256 ||
    descriptor.prior_repository_sha256 !== published.repository_sha256 ||
    descriptor.prior_timestamp_sha256 !== published.timestamp_sha256 ||
    descriptor.prior_snapshot_sha256 !== published.snapshot_sha256 ||
    descriptor.unchanged_records_sha256 !== published.records_sha256 ||
    digest(descriptor.current_versions) !== digest(published.versions) ||
    digest(descriptor.current_expires) !== digest(published.expires)
  )
    throw new Error("metadata renewal differs from durable published generation");
  for (const role of roles)
    if (
      metadataInstant(descriptor.current_expires[role]) <= time ||
      metadataInstant(descriptor.next_expires[role]) <= time
    )
      throw new Error("expired metadata requires separate recovery");
}

/** The fixed admitted caller must authenticate actual TUF/public readback before
 * recording this declared result. Initial seed is a separate setup/import step.
 */
export function validatePublishedMetadataTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  operation: unknown,
) {
  const before = inspectPublishedMetadata(previous.published_metadata),
    after = inspectPublishedMetadata(next.published_metadata);
  if (digest(before) === digest(after)) return;
  if (!after) throw new Error("published metadata cannot disappear");
  if (digest(previous.active_candidate) !== digest(next.active_candidate))
    throw new Error("published metadata readback cannot change active reservation");
  if (!before) {
    if (previous.metadata_bootstrap != null || next.metadata_bootstrap != null) {
      const { operation_id: initialOperation, publication: initialPublication, ...facts } = after;
      const descriptor = assertMetadataBootstrapPublication(next.metadata_bootstrap, facts);
      void initialOperation;
      void initialPublication;
      if (
        !isRecord(operation) ||
        !isRecord(operation.metadata_bootstrap) ||
        operation.metadata_bootstrap.descriptor_sha256 !== digest(descriptor) ||
        operation.id !== after.operation_id ||
        !(
          operation.outcome === "succeeded" ||
          (operation.outcome === "recovered" &&
            isRecord(operation.recovery) &&
            operation.recovery.resolution === "effect-completed")
        ) ||
        !Array.isArray(operation.completed_effects) ||
        !operation.completed_effects.some(
          (effect) =>
            isRecord(effect) &&
            effect.remote_identity === after.publication.remote_identity &&
            effect.evidence_sha256 === after.publication.evidence_sha256,
        )
      )
        throw new Error(
          "initial metadata publication requires exact settled bootstrap effect and public readback",
        );
      return;
    }
    if (
      after.operation_id !== null ||
      (isRecord(operation) && !["succeeded", "recovered"].includes(String(operation.outcome)))
    )
      throw new Error("initial metadata seed must be explicit and preserve pending effects");
    return;
  }
  if (
    !isRecord(operation) ||
    operation.id !== after.operation_id ||
    !(
      operation.outcome === "succeeded" ||
      (operation.outcome === "recovered" &&
        isRecord(operation.recovery) &&
        operation.recovery.resolution === "effect-completed")
    ) ||
    !Array.isArray(operation.completed_effects) ||
    !operation.completed_effects.some(
      (effect) =>
        isRecord(effect) &&
        effect.remote_identity === after.publication.remote_identity &&
        effect.evidence_sha256 === after.publication.evidence_sha256,
    )
  )
    throw new Error("published metadata advancement requires exact resolved readback");
  if (
    before.root_sha256 !== after.root_sha256 ||
    before.offline_targets_sha256 !== after.offline_targets_sha256 ||
    before.repository_sha256 === after.repository_sha256
  )
    throw new Error("metadata generation cannot regress or rotate offline anchors");
  for (const role of roles) {
    if (role === "targets") {
      if (
        before.versions[role] !== after.versions[role] ||
        before.expires[role] !== after.expires[role]
      )
        throw new Error("offline targets changed");
    } else if (BigInt(after.versions[role]) <= BigInt(before.versions[role]))
      throw new Error("published metadata version floor did not advance");
  }
  if (isRecord(operation.metadata_renewal)) {
    const descriptor = inspectMetadataRenewalDescriptor(next.metadata_renewal);
    if (
      digest(descriptor) !== operation.metadata_renewal.descriptor_sha256 ||
      descriptor.prior_repository_sha256 !== before.repository_sha256 ||
      descriptor.unchanged_records_sha256 !== after.records_sha256 ||
      digest(descriptor.next_versions) !== digest(after.versions) ||
      digest(descriptor.next_expires) !== digest(after.expires)
    )
      throw new Error("metadata readback differs from frozen renewal");
  }
}

/** Scheduling only, with the existing descriptor/seed parsers. No key/readback
 * authority is conveyed; actual workers still authenticate their own purpose. */
export function applicationMetadataMaintenancePriority(
  input: Record<string, unknown>,
  now: string,
) {
  // Coordinator/wake clocks use ISO milliseconds; TUF metadata itself keeps
  // its stricter fractional canonicalization in the existing seed parser.
  if (!Number.isFinite(Date.parse(now))) throw new Error("maintenance clock invalid");
  if (input.catalog_publication != null) return null;
  const seed = inspectPublishedMetadata(input.published_metadata);
  if (!seed)
    return input.metadata_bootstrap == null
      ? null
      : (inspectMetadataBootstrapDescriptor(input.metadata_bootstrap), "bootstrap" as const);
  const renewal =
    input.metadata_renewal == null
      ? null
      : inspectMetadataRenewalDescriptor(input.metadata_renewal);
  if (renewal?.prior_repository_sha256 === seed.repository_sha256) return "renewal" as const;
  return Date.parse(seed.expires.timestamp) <= Date.parse(now) + 24 * 60 * 60 * 1000
    ? ("renewal" as const)
    : null;
}
