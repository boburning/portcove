/** Inert persisted catalog/site facts. Only protected callers authenticate actual
 * verifier output and public/provider readback; none of these parsers does. */
import { createHash } from "node:crypto";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { metadataInstant, inspectPublishedMetadata } from "./release-metadata-contract.mts";
import { inspectCatalogPublicationDescriptor } from "./release-catalog-publication-contract.mts";

const roles = ["targets", "definitions", "policy", "snapshot", "timestamp"] as const;
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("catalog metadata/site schema differs");
}
function sha(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("catalog metadata/site identity required");
}
function text(raw: unknown): asserts raw is string {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 512 ||
    Array.from(raw).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("catalog metadata/site text invalid");
}
function roleValues(raw: unknown, expiry: boolean) {
  exact(raw, [...roles].sort().join(","));
  return Object.fromEntries(
    roles.map((role) => {
      const value = raw[role];
      if (expiry) metadataInstant(value);
      else if (
        typeof value !== "string" ||
        !/^[1-9][0-9]{0,19}$/u.test(value) ||
        BigInt(value) > 18446744073709551615n
      )
        throw new Error("catalog role version must be exact positive u64 text");
      return [role, String(value)];
    }),
  ) as Record<(typeof roles)[number], string>;
}
function files(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 65536)
    throw new Error("catalog file inventory exceeds bound");
  let total = 0;
  const entries = raw.map((file: unknown) => {
    exact(file, "bytes,sha256,target");
    text(file.target);
    if (
      !/^(?:metadata|targets)\/[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(file.target) ||
      file.target.split("/").length > 16 ||
      file.target.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("catalog file target invalid");
    sha(file.sha256);
    if (
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 8 * 1024 * 1024
    )
      throw new Error("catalog file bytes outside retained bound");
    total += file.bytes;
    if (total > 128 * 1024 * 1024) throw new Error("catalog file aggregate exceeds bound");
    return { target: file.target, bytes: file.bytes, sha256: file.sha256 };
  });
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.target >= entry.target))
    throw new Error("catalog file inventory must be unique and sorted");
  return entries;
}
export function inspectCatalogTufPublicationFacts(raw: unknown) {
  exact(
    raw,
    "expires,immutable_targets_sha256,index_sha256,offline_targets_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,verifier_repository_sha256,versions",
  );
  if (raw.schema_version !== 1) throw new Error("catalog facts schema unsupported");
  for (const name of [
    "immutable_targets_sha256",
    "index_sha256",
    "offline_targets_sha256",
    "repository_sha256",
    "root_sha256",
    "snapshot_sha256",
    "timestamp_sha256",
    "verifier_repository_sha256",
  ] as const)
    sha(raw[name]);
  return {
    schema_version: 1 as const,
    root_sha256: raw.root_sha256,
    offline_targets_sha256: raw.offline_targets_sha256,
    index_sha256: raw.index_sha256,
    repository_sha256: raw.repository_sha256,
    verifier_repository_sha256: raw.verifier_repository_sha256,
    snapshot_sha256: raw.snapshot_sha256,
    timestamp_sha256: raw.timestamp_sha256,
    versions: roleValues(raw.versions, false),
    expires: roleValues(raw.expires, true),
    immutable_targets_sha256: raw.immutable_targets_sha256,
  };
}
/** Full maintained Rust report -> independently named site digest and facts.
 * Its authority:none is retained; valid self-consistent bytes are not admission. */
export function inspectCatalogTufPublicationReport(raw: unknown) {
  exact(
    raw,
    "authority,changed,expires,files,index_sha256,offline_targets_sha256,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,versions",
  );
  if (raw.authority !== "none" || typeof raw.changed !== "boolean")
    throw new Error("inert catalog verifier report required");
  const inventory = files(raw.files);
  const rustDigest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  if (raw.repository_sha256 !== rustDigest) throw new Error("catalog verifier file digest differs");
  const repository = digest(inventory.map(({ target, ...file }) => ({ path: target, ...file })));
  const { authority: _authority, changed: _changed, files: _files, ...facts } = raw;
  return {
    authority: "none" as const,
    files: inventory,
    facts: inspectCatalogTufPublicationFacts({
      ...facts,
      repository_sha256: repository,
      verifier_repository_sha256: rustDigest,
      immutable_targets_sha256: digest(
        inventory.filter((file) => file.target.startsWith("targets/")),
      ),
    }),
  };
}
export function inspectPublishedCatalogMetadata(raw: unknown) {
  if (raw == null) return null;
  exact(
    raw,
    "expires,immutable_targets_sha256,index_sha256,offline_targets_sha256,operation_id,publication,repository_sha256,root_sha256,schema_version,snapshot_sha256,timestamp_sha256,verifier_repository_sha256,versions",
  );
  const { operation_id, publication, ...facts } = raw;
  sha(operation_id);
  exact(publication, "evidence_sha256,remote_identity,site_generation_sha256");
  sha(publication.evidence_sha256);
  sha(publication.site_generation_sha256);
  text(publication.remote_identity);
  return {
    ...inspectCatalogTufPublicationFacts(facts),
    operation_id,
    publication: {
      evidence_sha256: publication.evidence_sha256,
      remote_identity: publication.remote_identity,
      site_generation_sha256: publication.site_generation_sha256,
    },
  };
}
function component(raw: unknown) {
  if (raw === null) return null;
  exact(raw, "repository_sha256,root_sha256");
  sha(raw.repository_sha256);
  sha(raw.root_sha256);
  return { root_sha256: raw.root_sha256, repository_sha256: raw.repository_sha256 };
}
export function inspectPublishedSite(raw: unknown) {
  if (raw == null) return null;
  exact(raw, "components,generation_sha256,operation_id,publication,schema_version");
  if (raw.schema_version !== 1) throw new Error("site cursor schema unsupported");
  sha(raw.generation_sha256);
  if (raw.operation_id !== null) sha(raw.operation_id);
  exact(raw.components, "application,catalog");
  const application = component(raw.components.application),
    catalog = component(raw.components.catalog);
  if (
    (!application && !catalog) ||
    (application && catalog && application.root_sha256 === catalog.root_sha256)
  )
    throw new Error("site cursor requires independently scoped components");
  exact(raw.publication, "evidence_sha256,remote_identity");
  sha(raw.publication.evidence_sha256);
  text(raw.publication.remote_identity);
  return {
    schema_version: 1 as const,
    generation_sha256: raw.generation_sha256,
    components: { application, catalog },
    operation_id: raw.operation_id,
    publication: {
      evidence_sha256: raw.publication.evidence_sha256,
      remote_identity: raw.publication.remote_identity,
    },
  };
}
/** Only ABSENCE permits legacy app-only fallback. Explicit null cannot discard
 * a cursor, and catalog publication always requires an explicit global cursor. */
export function currentPublishedSite(input: Record<string, unknown>) {
  const application = inspectPublishedMetadata(input.published_metadata);
  const catalog = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
  if (!Object.hasOwn(input, "published_site")) {
    if (catalog) throw new Error("catalog metadata requires explicit current site cursor");
    return application
      ? inspectPublishedSite({
          schema_version: 1,
          generation_sha256: application.publication.site_generation_sha256,
          components: {
            application: {
              root_sha256: application.root_sha256,
              repository_sha256: application.repository_sha256,
            },
            catalog: null,
          },
          operation_id: application.operation_id,
          publication: {
            evidence_sha256: application.publication.evidence_sha256,
            remote_identity: application.publication.remote_identity,
          },
        })
      : null;
  }
  const cursor = inspectPublishedSite(input.published_site);
  if (
    digest(cursor?.components.application ?? null) !==
      digest(
        application
          ? {
              root_sha256: application.root_sha256,
              repository_sha256: application.repository_sha256,
            }
          : null,
      ) ||
    digest(cursor?.components.catalog ?? null) !==
      digest(
        catalog
          ? { root_sha256: catalog.root_sha256, repository_sha256: catalog.repository_sha256 }
          : null,
      )
  )
    throw new Error("site cursor differs from durable component records");
  return cursor;
}
export function assertCatalogPublicationBaseline(raw: unknown, input: Record<string, unknown>) {
  const descriptor = inspectCatalogPublicationDescriptor(raw),
    cursor = currentPublishedSite(input);
  const catalog = inspectPublishedCatalogMetadata(input.published_catalog_metadata);
  if (
    descriptor.prior.site_generation_sha256 !== (cursor?.generation_sha256 ?? null) ||
    descriptor.prior.catalog_repository_sha256 !== (catalog?.repository_sha256 ?? null) ||
    (catalog && descriptor.prior.catalog_root_sha256 !== catalog.root_sha256) ||
    descriptor.prior.application_root_sha256 !==
      (cursor?.components.application?.root_sha256 ?? null) ||
    descriptor.prior.application_repository_sha256 !==
      (cursor?.components.application?.repository_sha256 ?? null)
  )
    throw new Error("catalog publication differs from current component/site baseline");
  return descriptor;
}
function settled(
  operation: unknown,
  operationId: string | null,
  publication: { remote_identity: string; evidence_sha256: string },
) {
  if (
    !isRecord(operation) ||
    operation.id !== operationId ||
    operation.kind !== "upload" ||
    operation.destination !== "github-pages:boburning/portcove:complete-site" ||
    !(
      operation.outcome === "succeeded" ||
      (operation.outcome === "recovered" &&
        isRecord(operation.recovery) &&
        operation.recovery.resolution === "effect-completed")
    ) ||
    !Array.isArray(operation.completed_effects) ||
    operation.completed_effects.length !== 1 ||
    digest(operation.completed_effects[0]) !== digest(publication)
  )
    throw new Error("site publication requires exact settled Pages/public readback");
  return operation;
}
export function validatePublishedSiteTransition(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  operation: unknown,
) {
  const before = currentPublishedSite(previous),
    after = currentPublishedSite(next);
  const oldApplication = inspectPublishedMetadata(previous.published_metadata),
    application = inspectPublishedMetadata(next.published_metadata);
  const oldCatalog = inspectPublishedCatalogMetadata(previous.published_catalog_metadata),
    catalog = inspectPublishedCatalogMetadata(next.published_catalog_metadata);
  const appChanged = digest(oldApplication) !== digest(application),
    catalogChanged = digest(oldCatalog) !== digest(catalog);
  if (Object.hasOwn(previous, "published_site") && !Object.hasOwn(next, "published_site"))
    throw new Error("explicit site cursor cannot disappear");
  if (oldCatalog && !catalog) throw new Error("published catalog cannot disappear");
  if (!appChanged && !catalogChanged && digest(before) === digest(after)) return;
  // Preserve the historical explicit app-only setup/import route. It cannot
  // seed catalog trust or remove an explicit cursor.
  if (
    !Object.hasOwn(previous, "published_site") &&
    !Object.hasOwn(next, "published_site") &&
    !oldCatalog &&
    !catalog
  )
    return;
  if (appChanged === catalogChanged || !after || !isRecord(operation))
    throw new Error("site cursor must advance exactly one published component");
  const record = catalogChanged ? catalog : application;
  if (!record) throw new Error("published component cannot disappear");
  settled(operation, after.operation_id, after.publication);
  if (
    record.operation_id !== after.operation_id ||
    record.publication.site_generation_sha256 !== after.generation_sha256 ||
    record.publication.evidence_sha256 !== after.publication.evidence_sha256 ||
    record.publication.remote_identity !== after.publication.remote_identity ||
    after.generation_sha256 === before?.generation_sha256
  )
    throw new Error("site cursor and affected component must share exact new readback");
  if (digest(previous.active_candidate) !== digest(next.active_candidate))
    throw new Error("site readback cannot change active reservation");
  if (catalogChanged) {
    if (
      !catalog ||
      !isRecord(operation.catalog_publication) ||
      !isRecord(operation.catalog_site_expectation)
    )
      throw new Error("catalog publication requires explicit catalog Pages subject");
    const descriptor = assertCatalogPublicationBaseline(
      operation.catalog_publication.descriptor,
      previous,
    );
    const expectation = operation.catalog_site_expectation;
    if (
      descriptor.prior.catalog_root_sha256 !== catalog.root_sha256 ||
      expectation.catalog_root_sha256 !== catalog.root_sha256 ||
      expectation.catalog_repository_sha256 !== catalog.repository_sha256 ||
      expectation.site_generation_sha256 !== after.generation_sha256 ||
      expectation.prior_site_generation_sha256 !== (before?.generation_sha256 ?? null)
    )
      throw new Error("catalog readback differs from frozen Pages expectation");
    if (oldCatalog) {
      if (
        oldCatalog.root_sha256 !== catalog.root_sha256 ||
        oldCatalog.offline_targets_sha256 !== catalog.offline_targets_sha256 ||
        oldCatalog.repository_sha256 === catalog.repository_sha256
      )
        throw new Error("catalog generation cannot rotate offline anchors or repeat repository");
      for (const role of roles) {
        if (
          role === "targets"
            ? oldCatalog.versions[role] !== catalog.versions[role] ||
              oldCatalog.expires[role] !== catalog.expires[role]
            : BigInt(catalog.versions[role]) <= BigInt(oldCatalog.versions[role])
        )
          throw new Error("catalog role version floor/offline target changed");
      }
      // immutable_targets_sha256 is an identity summary, NOT no-removal proof.
      // Actual caller must re-fetch/pin the prior closure and have the fixed
      // Tough assembler verify history; a hash cannot establish those semantics.
    }
    const observed = typeof next.now === "string" ? Date.parse(next.now) : NaN;
    if (!Number.isFinite(observed) || new Date(observed).toISOString() !== next.now)
      throw new Error("catalog readback requires canonical coordinator observation time");
    for (const role of roles)
      if (metadataInstant(catalog.expires[role]) <= BigInt(observed) * 1_000_000n)
        throw new Error("catalog publication expired before readback");
  } else {
    if (operation.catalog_publication || !application || !isRecord(operation.site_expectation))
      throw new Error("application publication requires its existing Pages subject");
    const expected = operation.site_expectation;
    if (
      expected.root_sha256 !== application.root_sha256 ||
      expected.repository_sha256 !== application.repository_sha256 ||
      expected.site_generation_sha256 !== after.generation_sha256 ||
      expected.prior_site_generation_sha256 !== (before?.generation_sha256 ?? null)
    )
      throw new Error("application readback differs from global prior/site expectation");
  }
}
