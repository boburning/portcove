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
  const reserved = isRecord(raw) && raw.schema_version === 3;
  const historical = reserved && Object.hasOwn(raw, "prior_expiration_policy");
  const floorsPresent = reserved && Object.hasOwn(raw, "reserved_version_floors");
  const keys =
    "current_expires,current_versions,generated_at,kind,next_expires,next_versions,offline_targets_sha256,prior_repository_sha256,prior_snapshot_sha256,prior_timestamp_sha256,root_sha256,schema_version,unchanged_records_sha256";
  exact(
    raw,
    [
      ...keys.split(","),
      ...(online ? ["top_level_targets_profile"] : []),
      ...(historical ? ["prior_expiration_policy"] : []),
      ...(floorsPresent ? ["reserved_version_floors"] : []),
    ]
      .sort()
      .join(","),
  );
  if (
    (!online && !reserved && raw.schema_version !== 1) ||
    (reserved && !historical && !floorsPresent) ||
    raw.kind !== "application-tuf-metadata-renewal" ||
    (online && raw.top_level_targets_profile !== "online-unchanged-authority-v1") ||
    (historical && raw.prior_expiration_policy !== "historical-online-expired-v1")
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
  const floors = floorsPresent ? versions(raw.reserved_version_floors) : undefined;
  if (floors && floors.targets !== current.targets)
    throw new Error("reserved floors cannot change pinned Targets");
  for (const role of roles) {
    if (role === "targets" && !online) {
      if (current[role] !== next[role] || beforeExpiry[role] !== nextExpiry[role])
        throw new Error("metadata renewal cannot change offline targets");
    } else {
      const days = role === "timestamp" ? 2 : role === "releases" || role === "targets" ? 90 : 7;
      if (
        BigInt(next[role]) !==
          (floors && BigInt(floors[role]) > BigInt(current[role])
            ? BigInt(floors[role])
            : BigInt(current[role])) +
            1n ||
        metadataInstant(nextExpiry[role]) <= metadataInstant(beforeExpiry[role]) ||
        metadataInstant(nextExpiry[role]) > generated + BigInt(days) * 86_400_000_000_000n
      )
        throw new Error("metadata version/expiry progression differs");
    }
  }
  return {
    schema_version: online ? (2 as const) : reserved ? (3 as const) : (1 as const),
    ...(floors ? { reserved_version_floors: floors } : {}),
    ...(historical ? { prior_expiration_policy: "historical-online-expired-v1" as const } : {}),
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
    (descriptor.schema_version !== 2 &&
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
  const standalone = isRecord(raw) && Object.hasOwn(raw, "standalone_bootstrap_run");
  exact(
    raw,
    standalone
      ? "expires,offline_targets_sha256,operation_id,publication,records_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,standalone_bootstrap_run,timestamp_sha256,versions"
      : "expires,offline_targets_sha256,operation_id,publication,records_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,versions",
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
  if (
    standalone &&
    (!isStandaloneBootstrapRun(raw.standalone_bootstrap_run) || raw.operation_id !== null)
  )
    throw new Error(
      "standalone bootstrap requires its exact external run and no journal operation",
    );
  const facts = {
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
  const publication = {
    remote_identity: raw.publication.remote_identity,
    evidence_sha256: raw.publication.evidence_sha256,
    site_generation_sha256: raw.publication.site_generation_sha256,
  };
  const run = standalone ? standaloneBootstrapRun(raw.standalone_bootstrap_run) : null;
  if (run && !matchesStandaloneBootstrapPublication(facts, publication, run))
    throw new Error("standalone bootstrap adoption differs from exact publication");
  return {
    ...facts,
    operation_id: raw.operation_id,
    ...(run ? { standalone_bootstrap_run: run } : {}),
    publication,
  };
}

/** Only this verified, independently published genesis can replace the absence
 * of App metadata in the existing journal. The abandoned journal descriptor
 * remains untouched, including its original generation clock. */
export const standaloneBootstrapAdoption = {
  run_id: "42403889193",
  attempt: 1,
  feed_job_id: 128498673910,
  revision: "1779ef17eaf154b918a990b9dafba89dbbcddfa7",
  ref: "refs/tags/portcove-production-controller-windows-20261105r29",
  generation: "1000adca784333dd4ca3b92930b0929ca8e6faf186389b27441c9e3c412245ab",
  publication_sha256: "b18311564f29396acd06ec44dd44de06d0a2e43a4cc3c4014ed1b203898dda03",
  abandoned_descriptor_sha256: "603fae90b93dbaeef08d6030cbec243add36f82ceb748aa592423cedc8f17157",
} as const;

export const standaloneBootstrapRenewalAdoption = {
  feed_ref: "refs/tags/portcove-production-controller-windows-20261105r44",
  generation: "07999ab91c4aeef3f2d04d4f7341729b35422d06f8c939535e5e34a4a35dbd74",
  publication_sha256: "c3b7ee8ace1531e52a4be5bb9b0fac45f4d0f208cabd5d55195f1d351b7e8cb2",
} as const;

export const standaloneBootstrapForwardAdoption = {
  prior_run_id: "42459134017",
  prior_job_id: "128666005038",
  prior_repository_sha256: "2f09956c9673b69a37fff2556e611af654adf4141f80ffc24a2d207d7873354e",
  run_id: "42583959281",
  feed_job_id: "129051933704",
  revision: "719851091491cb0db93cb0b42fee3838fce9672b",
  generation: "fa46b99d77acb7bcbd09a699884522cf6afec098692202e13ebd0b627827fada",
  publication_sha256: "5b320322ad87a97e3fcb307bb6750f0218693993953ee5b7f37be01e9e99fd33",
} as const;

// The native metadata-only release advanced Pages while the signed journal
// retained an earlier, settled no-effect renewal.
export const servedNativeBootstrapRenewal = {
  run_id: "43019180783",
  feed_job_id: "130527865397",
  revision: "207819b2a6e89a7801b8722f0b7e7229d4fc4968",
  ref: "refs/tags/portcove-production-controller-windows-20261111r78",
  release_id: 441659465,
  opportunity: "4748878692c8fd350045bbedfedbebc70789b72c3bfa811c30c8d302ec896348",
  generation: "5ced5fe15999ce976eaf3b793d70c76108a432d699ee293bc33d4e1576adf4d3",
  publication_sha256: "cd94458c83aeab9641837f8a77414304b79d4410679877a12b194e61b391975f",
  prior_repository_sha256: "c60ac310b3f6a7ccd118dce45314fa40e09b5db9c397fde469d546541b80c014",
  superseded_descriptor_sha256: "e2cf6e64f8c4d6b3cad2123caf67fe70ee9d3b438dc2ff38d9879dbbb930a413",
  settled_operation_id: "f7468b3daade44b98d7dde0af13f6cc81bbdc03d8b9c838ff8336e0a3a73e542",
} as const;

/** Served feed recovery retains the same signed journal preimage as v8. */
export const servedV13BootstrapRenewal = {
  ...servedNativeBootstrapRenewal,
  run_id: "43350005289",
  feed_job_id: "131648693360",
  revision: "0c333d8e9d8d402f488975312f43c27097154afe",
  ref: "refs/tags/portcove-production-controller-windows-20261113r87",
  release_id: 442923418,
  opportunity: "7db3dcbe2c276d6240e6ec6dccfcd813b4877fc51243d0487314849dbd0138c4",
  generation: "deff5ba394373775c3f19d5ee9c44222484be8e2a58397826e6bd45c8bb40fc6",
  publication_sha256: "891b3fb0373165adef0513f9c5c072d62cecb53cfcb694f953d5be1098abc33a",
  prior_repository_sha256: "666abbccb87032ddd004bdeff0b70a3b7a01288baa21adb9811c8c1f9d753489",
} as const;

export function isServedNativeBootstrapRenewalPreimage(
  input: Record<string, unknown>,
  renewal:
    | typeof servedNativeBootstrapRenewal
    | typeof servedV13BootstrapRenewal = servedNativeBootstrapRenewal,
) {
  const published = inspectPublishedMetadata(input.published_metadata);
  const controller = input.controller;
  const capacity = isRecord(controller) ? controller.capacity_attempt : null;
  const operation = isRecord(capacity) ? capacity.operation : null;
  const v13 = renewal === servedV13BootstrapRenewal;
  const prior = v13 ? servedNativeBootstrapRenewal : standaloneBootstrapForwardAdoption;
  return (
    published?.standalone_bootstrap_run === prior.run_id &&
    published.repository_sha256 === renewal.prior_repository_sha256 &&
    (v13
      ? input.metadata_renewal === null
      : digest(input.metadata_renewal ?? null) === renewal.superseded_descriptor_sha256) &&
    isRecord(operation) &&
    operation.id === renewal.settled_operation_id &&
    operation.kind === "upload" &&
    isRecord(operation.metadata_renewal) &&
    operation.metadata_renewal.descriptor_sha256 === renewal.superseded_descriptor_sha256 &&
    operation.outcome === "recovered" &&
    isRecord(operation.recovery) &&
    operation.recovery.resolution === "effect-not-applied" &&
    Array.isArray(operation.completed_effects) &&
    operation.completed_effects.length === 0 &&
    !Object.hasOwn(input, "published_site") &&
    input.active_candidate === null &&
    input.published_catalog_metadata == null &&
    input.catalog_initialization == null &&
    input.catalog_publication == null &&
    input.catalog_review_request == null &&
    input.catalog_review_disposition == null &&
    digest(input.metadata_bootstrap ?? null) ===
      standaloneBootstrapAdoption.abandoned_descriptor_sha256
  );
}

export function isStandaloneBootstrapForwardPreimage(
  published: ReturnType<typeof inspectPublishedMetadata>,
) {
  const successor = standaloneBootstrapForwardAdoption;
  return (
    published?.standalone_bootstrap_run === successor.prior_run_id &&
    published.repository_sha256 === successor.prior_repository_sha256 &&
    published.publication.site_generation_sha256 ===
      standaloneBootstrapRenewalAdoption.generation &&
    published.publication.remote_identity ===
      `https://github.com/boburning/portcove/actions/runs/${successor.prior_run_id}/job/${successor.prior_job_id}`
  );
}

function isStandaloneBootstrapRun(raw: unknown): raw is string {
  return (
    typeof raw === "string" && /^[1-9][0-9]{0,15}$/u.test(raw) && Number.isSafeInteger(Number(raw))
  );
}

function standaloneBootstrapRun(raw: unknown) {
  if (!isStandaloneBootstrapRun(raw)) throw new Error("standalone bootstrap run is invalid");
  return raw;
}

function matchesStandaloneBootstrapPublication(
  facts: ReturnType<typeof inspectTufPublicationFacts>,
  publication: { remote_identity: string; site_generation_sha256: string },
  run: string,
) {
  const base = `https://github.com/boburning/portcove/actions/runs/${run}/job/`;
  if (!publication.remote_identity.startsWith(base)) return false;
  const job = publication.remote_identity.slice(base.length);
  if (run === standaloneBootstrapAdoption.run_id)
    return (
      job === String(standaloneBootstrapAdoption.feed_job_id) &&
      publication.site_generation_sha256 === standaloneBootstrapAdoption.generation &&
      digest(facts) === standaloneBootstrapAdoption.publication_sha256
    );
  for (const native of [servedNativeBootstrapRenewal, servedV13BootstrapRenewal])
    if (run === native.run_id)
      return (
        job === native.feed_job_id &&
        publication.site_generation_sha256 === native.generation &&
        digest(facts) === native.publication_sha256
      );
  if (run === standaloneBootstrapForwardAdoption.run_id)
    return (
      job === standaloneBootstrapForwardAdoption.feed_job_id &&
      publication.site_generation_sha256 === standaloneBootstrapForwardAdoption.generation &&
      digest(facts) === standaloneBootstrapForwardAdoption.publication_sha256
    );
  return (
    isStandaloneBootstrapRun(job) &&
    publication.site_generation_sha256 === standaloneBootstrapRenewalAdoption.generation &&
    digest(facts) === standaloneBootstrapRenewalAdoption.publication_sha256
  );
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
  if (after.standalone_bootstrap_run) {
    const { operation_id, expires } = after;
    const selected = standaloneBootstrapAdoption;
    const forward = after.standalone_bootstrap_run === standaloneBootstrapForwardAdoption.run_id;
    const native = [servedNativeBootstrapRenewal, servedV13BootstrapRenewal].find(
      (candidate) => candidate.run_id === after.standalone_bootstrap_run,
    );
    if (native) {
      const priorController = previous.controller;
      const priorCapacity = isRecord(priorController) ? priorController.capacity_attempt : null;
      const nextController = next.controller;
      const nextCapacity = isRecord(nextController) ? nextController.capacity_attempt : null;
      if (
        !isServedNativeBootstrapRenewalPreimage(previous, native) ||
        !isRecord(priorCapacity) ||
        !isRecord(nextCapacity) ||
        digest(priorCapacity.operation) !== digest(nextCapacity.operation) ||
        !isRecord(operation) ||
        operation.id !== native.settled_operation_id ||
        operation.outcome !== "recovered" ||
        digest(operation.recovery) !==
          digest(isRecord(priorCapacity.operation) ? priorCapacity.operation.recovery : null) ||
        next.metadata_renewal !== null ||
        Object.hasOwn(next, "published_site") ||
        digest(previous.review_request ?? null) !== digest(next.review_request ?? null) ||
        digest(previous.review_disposition ?? null) !== digest(next.review_disposition ?? null) ||
        digest(next.metadata_bootstrap) !== selected.abandoned_descriptor_sha256 ||
        next.published_catalog_metadata != null ||
        next.catalog_initialization != null ||
        next.catalog_publication != null ||
        next.catalog_review_request != null ||
        next.catalog_review_disposition != null
      )
        throw new Error("served native renewal differs from its exact settled journal preimage");
    } else if (
      (forward
        ? !isStandaloneBootstrapForwardPreimage(before) ||
          Object.hasOwn(previous, "published_site") ||
          Object.hasOwn(next, "published_site")
        : before !== null) ||
      operation_id !== null ||
      operation != null ||
      previous.active_candidate !== null ||
      previous.published_catalog_metadata != null ||
      previous.published_site != null ||
      previous.catalog_initialization != null ||
      previous.catalog_publication != null ||
      previous.catalog_review_request != null ||
      previous.catalog_review_disposition != null ||
      previous.review_request != null ||
      previous.review_disposition != null ||
      previous.metadata_renewal != null ||
      digest(previous.metadata_bootstrap) !== selected.abandoned_descriptor_sha256 ||
      digest(next.metadata_bootstrap) !== selected.abandoned_descriptor_sha256
    )
      throw new Error(
        forward
          ? "standalone bootstrap renewal differs from exact predecessor journal and publication"
          : "standalone bootstrap adoption differs from exact empty journal and publication",
      );
    const now = typeof next.now === "string" ? Date.parse(next.now) : NaN;
    if (!Number.isFinite(now) || new Date(now).toISOString() !== next.now)
      throw new Error("standalone bootstrap requires canonical coordinator observation time");
    for (const role of roles)
      if (metadataInstant(expires[role]) <= BigInt(now) * 1_000_000n)
        throw new Error("expired standalone bootstrap cannot seed the journal");
    return;
  }
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

/** Canonical positive-u64 role versions; parsing grants no authority. */
export const inspectMetadataRoleVersions = versions;
