import type {
  PortDefinition,
  DirectReleaseSpec,
  SourceEvidenceScope,
} from "../apps/desktop/src/transport-types.generated.d.ts";
import { isRecord, errorCode } from "./runtime-values.mts";
import type { GithubPinScope, GithubSourceArchiveScope } from "./upstream-observer.mts";
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  observationHash,
  githubDirectPin,
  validateGithubDeclaredPinMetadata,
  validateGithubPinMetadata,
  githubSourceArchive,
  validateGithubSourceArchiveMetadata,
} from "./upstream-observer.mts";
import {
  HEALTH_INPUTS_VERSION,
  healthArtifactHash,
  healthEndpointHash,
  healthCatalogPortHashes,
} from "./upstream-health-inputs.mts";
import { assessUpstreamLineage, type UpstreamLineage } from "./upstream-lineage.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

export interface ReviewedPin extends GithubPinScope {
  port_id: string;
  port_contract_sha256: string;
  platform: string;
}
export interface ReviewedSourceArchive extends GithubSourceArchiveScope {
  port_id: string;
  port_contract_sha256: string;
  platform: string;
}
interface OriginalCondition {
  port_id: string;
  port_contract_sha256: string;
  provider: "github";
  repository: string;
  operation: "observe-availability";
  http_status: 301 | 404;
  reason: "provider-redirect" | "inaccessible-or-missing";
  redirect_repository_id: number | null;
  evidence: string;
  resume_condition: string;
  role?: "project" | "acquisition";
}
export interface HealthAccountingPolicy {
  format_version: 1 | 2;
  input_version?: 1;
  authority: string;
  decision: string;
  pins: ReviewedPin[];
  source_archives?: ReviewedSourceArchive[];
  original_conditions: OriginalCondition[];
}

// This observer consumes a narrow raw catalog projection, not Core admission.
type HealthPort = Record<string, unknown> &
  Pick<PortDefinition, "id"> &
  Partial<
    Pick<
      PortDefinition,
      "project_url" | "automated_tested_platforms" | "manually_validated_platforms"
    >
  > & {
    upstream_status?: string;
    release?: {
      provider?: string;
      repository?: string;
      direct?: Record<string, Pick<DirectReleaseSpec, "url" | "sha256" | "version" | "size">>;
    };
  };
type HistoricalIdentity = Pick<SourceEvidenceScope, "port_id" | "upstream_ref" | "artifact_sha256">;
type Qualification = Record<string, unknown> & { scope: HistoricalIdentity };
interface HealthCatalog {
  ports: HealthPort[];
  source_catalog?: { qualification?: Qualification[] };
}
interface ArtifactIdentity {
  port_id: string;
  platform: string;
  version: string;
  sha256: string;
  size: number;
}
interface LocationRecord {
  provider: string;
  repository: string;
  port_ids: string[];
  release_providers: string[];
  original_upstream_port_ids?: string[];
  acquisition_port_ids?: string[];
  release_ref?: string;
  artifact_identities?: ArtifactIdentity[];
  historical_artifact_identities?: HistoricalIdentity[];
}
type HealthReason = keyof typeof resume;
type PinAssessment =
  | { status: "unknown"; reason: string | null }
  | {
      status: "provider-reported-pin-present" | "provider-reported-pin-observed";
      repository_id: number;
      release_id: number;
      asset_id: number;
      asset_facts_sha256: string;
      provider_digest: string | null;
      destination_availability: "unknown";
      accepted_bytes: "unverified";
      accounting_scope_sha256: string;
      identity_binding: "reviewed" | "unbound-observation";
      reason?: never;
    };
type SourceArchiveAssessment =
  | { status: "unknown"; reason: string | null }
  | {
      status: "provider-reported-commit-present";
      repository_id: number;
      commit_sha: string;
      tree_sha: string;
      commit_facts_sha256: string;
      destination_availability: "unknown";
      accepted_bytes: "unverified";
      accounting_scope_sha256: string;
      reason?: never;
    };
interface HealthObservation extends LocationRecord {
  observation_contract_sha256: string;
  observed_at: string;
  attempted: boolean;
  metadata_reused: boolean;
  status: "unknown" | "reachable";
  reason: HealthReason | null;
  http_status: number | null;
  archived: boolean | null;
  observed_repository_id: number | null;
  baseline_repository_id: number | null;
  comparison_http_status: number | null;
  comparison_observed_at: string | null;
  retry_at: string | null;
  resume_condition: string | null;
  pin_assessment: PinAssessment | null;
  source_archive_assessment: SourceArchiveAssessment | null;
  reviewed_condition_sha256: string | null;
  observed_redirect_repository_id: number | null;
  observed_size?: number | null;
  observed_release_id?: number | null;
  observed_asset_digests?: string[];
  accepted_digest_match?: string;
  accounted_for?: boolean;
  classification?: string;
}
type PriorLocation = Record<string, unknown> & { provider: string; repository: string };
type PriorIncident = Record<string, unknown> & { key: string };
interface PriorReport {
  completed_at: string;
  observations: PriorLocation[];
  port_health: { canonical_incidents: PriorIncident[] }[];
}
function isPriorReport(
  value: unknown,
  catalogHash: string,
  count: number,
  started: number,
): value is PriorReport {
  return (
    isRecord(value) &&
    ((value.format_version === 2 && value.catalog_sha256 === catalogHash) ||
      value.format_version === 3) &&
    Array.isArray(value.observations) &&
    Buffer.byteLength(JSON.stringify(value)) <= HEALTH_HISTORY_BYTES &&
    value.observations.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.provider === "string" &&
        typeof entry.repository === "string" &&
        (value.format_version === 2 ||
          isHealthObservationHistory(entry, Date.parse(String(value.completed_at)))),
    ) &&
    Array.isArray(value.port_health) &&
    value.port_health.length <= count &&
    value.port_health.every(
      (port: unknown) =>
        isRecord(port) &&
        Array.isArray(port.canonical_incidents) &&
        port.canonical_incidents.every(
          (entry: unknown) =>
            isRecord(entry) &&
            typeof entry.key === "string" &&
            (value.format_version === 2 ||
              isHealthIncidentHistory(entry, Date.parse(String(value.completed_at)))),
        ),
    ) &&
    typeof value.completed_at === "string" &&
    Number.isFinite(Date.parse(value.completed_at)) &&
    Date.parse(value.completed_at) <= started
  );
}
function priorNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function priorText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing internal health inventory identity");
  return value;
}
function assertHealthCatalog(value: unknown): asserts value is HealthCatalog {
  if (!isRecord(value) || !Array.isArray(value.ports))
    throw new Error("Catalog ports must be an array");
  const ports: unknown[] = value.ports;
  for (const port of ports) {
    if (!isRecord(port) || typeof port.id !== "string")
      throw new Error("Catalog requires unique stable port IDs");
    if (port.project_url !== undefined && typeof port.project_url !== "string")
      throw new Error("Unsupported original upstream location");
    if (port.upstream_status !== undefined && typeof port.upstream_status !== "string")
      throw new Error("Unsupported catalog maintenance declaration");
    for (const key of ["automated_tested_platforms", "manually_validated_platforms"] as const) {
      const platforms = port[key];
      if (
        platforms !== undefined &&
        (!Array.isArray(platforms) ||
          !platforms.every(
            (platform: unknown) =>
              platform === "windows-x86-64" ||
              platform === "linux-x86-64" ||
              platform === "macos-aarch64" ||
              platform === "macos-x86-64",
          ))
      )
        throw new Error("Unsupported catalog platform");
    }
    if (port.release !== undefined) {
      if (!isRecord(port.release)) throw new Error("Unsupported hosted catalog repository");
      for (const key of ["provider", "repository"])
        if (port.release[key] !== undefined && typeof port.release[key] !== "string")
          throw new Error("Unsupported hosted catalog repository");
      if (port.release.direct !== undefined) {
        if (!isRecord(port.release.direct))
          throw new Error("Direct manifest requires explicit artifact locations");
        for (const artifact of Object.values(port.release.direct)) {
          if (!isRecord(artifact) || typeof artifact.url !== "string")
            throw new Error("Direct manifest requires an absolute artifact URL");
          if (
            typeof artifact.sha256 !== "string" ||
            typeof artifact.version !== "string" ||
            typeof artifact.size !== "number"
          )
            throw new Error("Direct manifest requires a safe exact artifact identity");
        }
      }
    }
  }
  if (value.source_catalog !== undefined) {
    if (!isRecord(value.source_catalog)) throw new Error("Invalid source catalog");
    const records = value.source_catalog.qualification;
    if (records !== undefined) {
      if (!Array.isArray(records)) throw new Error("Invalid qualification records");
      const qualifications: unknown[] = records;
      for (const record of qualifications) {
        if (
          !isRecord(record) ||
          !isRecord(record.scope) ||
          typeof record.scope.port_id !== "string" ||
          (record.scope.upstream_ref !== null && typeof record.scope.upstream_ref !== "string") ||
          (record.scope.artifact_sha256 !== null &&
            typeof record.scope.artifact_sha256 !== "string")
        )
          throw new Error("Qualification requires an exact historical release identity");
      }
    }
  }
}
export interface HealthRequestOptions {
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
  method?: "HEAD";
}
export type HealthFetch = (url: string, options: HealthRequestOptions) => Promise<Response>;
export interface HealthOptions {
  fetch?: HealthFetch;
  now?: () => number;
  githubToken?: string | undefined;
  gitlabToken?: string | undefined;
  previousReport?: unknown;
  portIds?: string[] | null;
  reviewedAccounting?: unknown;
  lineageRecords?: unknown[];
}

/** Read reviewed authoring decisions without deriving lineage from live metadata. */
export async function readHealthLineage(
  input: unknown,
  projectRoot = fileURLToPath(new URL("..", import.meta.url)),
): Promise<unknown[]> {
  assertHealthCatalog(input);
  const records: unknown[] = [];
  for (const port of input.ports) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id))
      throw new Error("Invalid lineage authoring port identity");
    const filename = await assertOwnedUnlinkedPath(
      projectRoot,
      path.join(projectRoot, "crates/portcove-core/catalog/ports", `${port.id}.json`),
      "Lineage authoring record",
    );
    let handle;
    try {
      handle = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      // Legacy catalogs and isolated fixtures need not carry authoring history.
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    try {
      const stat = await handle.stat();
      const bound = 1024 * 1024;
      if (!stat.isFile() || stat.size > bound)
        throw new Error("Unbounded lineage authoring record");
      const buffer = Buffer.alloc(bound + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > bound) throw new Error("Unbounded lineage authoring record");
      const record: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (!isRecord(record) || !isRecord(record.listing) || record.listing.id !== port.id)
        throw new Error("Lineage authoring identity differs from catalog");
      if (record.upstream_lineage !== undefined) records.push(record);
    } finally {
      await handle.close();
    }
  }
  return records;
}

function assessedLineage(catalog: HealthCatalog, records: unknown[]) {
  if (!Array.isArray(records) || records.length > catalog.ports.length)
    throw new Error("Unbounded lineage authoring inputs");
  const assessments = new Map<string, ReturnType<typeof assessUpstreamLineage>>();
  for (const record of records) {
    if (
      !isRecord(record) ||
      !isRecord(record.listing) ||
      typeof record.listing.id !== "string" ||
      typeof record.listing.project_url !== "string"
    )
      throw new Error("Invalid lineage authoring input");
    const authorListing = record.listing;
    const port = catalog.ports.find((entry) => entry.id === authorListing.id);
    if (!port || assessments.has(port.id) || port.project_url !== record.listing.project_url)
      throw new Error("Lineage authoring identity differs from catalog");
    const listing = {
      id: port.id,
      project_url: record.listing.project_url,
      ...(typeof record.listing.issue_number === "number"
        ? { issue_number: record.listing.issue_number }
        : {}),
    };
    assessments.set(
      port.id,
      assessUpstreamLineage({
        listing,
        ...(record.upstream_lineage === undefined
          ? {}
          : { upstream_lineage: record.upstream_lineage as UpstreamLineage }),
      }),
    );
  }
  return assessments;
}

const scriptPath = fileURLToPath(import.meta.url);
class HealthFailure extends Error {
  reason: keyof typeof resume;
  constructor(reason: keyof typeof resume) {
    super(reason);
    this.reason = reason;
  }
}
const HARD_REQUEST_CEILING: number = 320;
const PRIOR_REPORT_ENTRIES: number = 512;
// Retained comparison history is independent of one collection's observation cap.
const HEALTH_HISTORY_BYTES = 16 * 1024 * 1024;
const resourceLimits = Object.freeze({
  duration_ms: 180_000,
  request_ms: 15_000,
  response_bytes: 1024 * 1024,
  total_bytes: 16 * 1024 * 1024,
});

const accountingPolicy: unknown = JSON.parse(
  await readFile(new URL("../.github/upstream-health-accounting.json", import.meta.url), "utf8"),
);

function assertHealthAccountingPolicy(policy: unknown): asserts policy is HealthAccountingPolicy {
  const objectKeys = (
    value: unknown,
    expected: readonly string[],
  ): value is Record<string, unknown> =>
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const hash = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const port = (value: unknown): value is string =>
    typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
  const repository = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
  const version2 = isRecord(policy) && policy.format_version === 2;
  const rootKeys = ["format_version", "authority", "decision", "pins", "original_conditions"];
  if (version2) rootKeys.push("input_version");
  if (
    !(objectKeys(policy, rootKeys) || objectKeys(policy, [...rootKeys, "source_archives"])) ||
    (policy.format_version !== 1 && policy.format_version !== 2) ||
    (version2 && policy.input_version !== HEALTH_INPUTS_VERSION) ||
    typeof policy.authority !== "string" ||
    !policy.authority ||
    typeof policy.decision !== "string" ||
    !policy.decision ||
    !Array.isArray(policy.pins) ||
    !Array.isArray(policy.original_conditions) ||
    (Object.hasOwn(policy, "source_archives") && !Array.isArray(policy.source_archives)) ||
    policy.original_conditions.length > 64 ||
    policy.pins.length +
      (Array.isArray(policy.source_archives) ? policy.source_archives.length : 0) >
      (version2 ? 8192 : 64 - policy.original_conditions.length)
  )
    throw new Error("Invalid reviewed health accounting policy");
  const identities = new Set();
  const pins: unknown[] = policy.pins;
  for (const pin of pins) {
    if (
      !objectKeys(pin, [
        "port_id",
        "port_contract_sha256",
        "platform",
        "repository",
        "tag",
        "name",
        "url",
        "size",
        "sha256",
        "repository_id",
        "archived",
        "release_id",
        "release_facts_sha256",
        "asset_id",
        "asset_facts_sha256",
      ]) ||
      !port(pin.port_id) ||
      !hash(pin.port_contract_sha256) ||
      !hash(pin.sha256) ||
      !hash(pin.asset_facts_sha256) ||
      !hash(pin.release_facts_sha256) ||
      !repository(pin.repository) ||
      typeof pin.platform !== "string" ||
      !pin.platform ||
      typeof pin.url !== "string" ||
      !positive(pin.size) ||
      !positive(pin.repository_id) ||
      !positive(pin.release_id) ||
      !positive(pin.asset_id) ||
      typeof pin.archived !== "boolean"
    )
      throw new Error("Invalid reviewed pin scope");
    const parsed = githubDirectPin(pin.url);
    if ((["repository", "tag", "name"] as const).some((key) => pin[key] !== parsed[key]))
      throw new Error("Reviewed pin URL scope differs");
    const key = `pin:${pin.port_id}:${pin.platform}${version2 ? `:${pin.url}` : ""}`;
    if (identities.has(key)) throw new Error("Duplicate reviewed pin scope");
    identities.add(key);
  }
  const archives: unknown[] = Array.isArray(policy.source_archives) ? policy.source_archives : [];
  for (const archive of archives) {
    if (
      !objectKeys(archive, [
        "port_id",
        "port_contract_sha256",
        "platform",
        "repository",
        "url",
        "size",
        "sha256",
        "repository_id",
        "archived",
        "commit_sha",
        "tree_sha",
        "commit_facts_sha256",
      ]) ||
      !port(archive.port_id) ||
      !hash(archive.port_contract_sha256) ||
      typeof archive.platform !== "string" ||
      !archive.platform ||
      !repository(archive.repository) ||
      typeof archive.url !== "string" ||
      !positive(archive.size) ||
      !hash(archive.sha256) ||
      !positive(archive.repository_id) ||
      typeof archive.archived !== "boolean" ||
      typeof archive.commit_sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(archive.commit_sha) ||
      typeof archive.tree_sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(archive.tree_sha) ||
      !hash(archive.commit_facts_sha256)
    )
      throw new Error("Invalid reviewed source archive scope");
    const parsed = githubSourceArchive(archive.url);
    if (parsed.repository !== archive.repository || parsed.commit_sha !== archive.commit_sha)
      throw new Error("Reviewed source archive URL scope differs");
    const key = `pin:${archive.port_id}:${archive.platform}${version2 ? `:${archive.url}` : ""}`;
    if (identities.has(key)) throw new Error("Duplicate reviewed acquisition scope");
    identities.add(key);
  }
  const conditions: unknown[] = policy.original_conditions;
  for (const condition of conditions) {
    if (
      !objectKeys(condition, [
        "port_id",
        "port_contract_sha256",
        "provider",
        "repository",
        "operation",
        "http_status",
        "reason",
        "redirect_repository_id",
        "evidence",
        "resume_condition",
        ...(version2 ? ["role"] : []),
      ]) ||
      (version2 && condition.role !== "project" && condition.role !== "acquisition") ||
      !port(condition.port_id) ||
      !hash(condition.port_contract_sha256) ||
      condition.provider !== "github" ||
      !repository(condition.repository) ||
      condition.operation !== "observe-availability" ||
      !(
        (condition.http_status === 301 &&
          condition.reason === "provider-redirect" &&
          positive(condition.redirect_repository_id)) ||
        (condition.http_status === 404 &&
          condition.reason === "inaccessible-or-missing" &&
          condition.redirect_repository_id === null)
      ) ||
      typeof condition.evidence !== "string" ||
      !/^https:\/\/github\.com\/boburning\/portcove\/issues\/247#issuecomment-[1-9]\d*$/u.test(
        condition.evidence ?? "",
      ) ||
      typeof condition.resume_condition !== "string" ||
      !condition.resume_condition
    )
      throw new Error("Invalid reviewed original-location scope");
    const role = condition.role === "acquisition" ? "acquisition" : "project";
    const key = `original:${condition.port_id}:${condition.provider}:${condition.repository}:${role}`;
    if (identities.has(key)) throw new Error("Duplicate reviewed original-location scope");
    identities.add(key);
  }
  return;
}
export function validateHealthAccountingPolicy(policy: unknown): HealthAccountingPolicy {
  assertHealthAccountingPolicy(policy);
  return policy;
}

function portContract(port: HealthPort) {
  const { summary: _summary, ...contract } = port;
  return observationHash(contract);
}
const resume = {
  "inaccessible-or-missing":
    "Recheck original access/location; a 404 does not establish deletion or succession.",
  authentication:
    "Correct existing authentication before rechecking; do not infer upstream disappearance.",
  forbidden: "Investigate access or provider throttling before rechecking.",
  "rate-limit":
    "Wait until the provider retry time, or at least one minute if unknown, before rechecking.",
  "provider-error": "Recheck after the provider recovers; artifact health is unassessed.",
  "provider-redirect":
    "Review the original location and redirect identity separately; no redirect was followed and destination availability or continuity is unassessed.",
  transport: "Recheck provider transport; this attempt did not establish reachability.",
  timeout: "Recheck within the fixed time budget; this attempt did not establish reachability.",
  "invalid-metadata":
    "Obtain bounded valid repository metadata before treating the endpoint as reachable.",
  "identity-mismatch": "Review the observed location mismatch; do not transfer upstream authority.",
  budget: "Start a separate bounded collection; retain this incomplete coverage report.",
  "release-identity-unavailable":
    "Complete exact accepted-ref and asset metadata; absent provider digests cannot verify accepted bytes.",
  "provider-status": "Investigate the observed HTTP status before rechecking.",
};

function historyText(value: unknown, maximum = 2048): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}
function historyHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function historyIdentity(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function historyClock(value: unknown, latest = 8.64e15): value is string {
  return (
    historyText(value, 40) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= latest
  );
}
function historyStatus(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
  );
}
function historyPortId(value: unknown): value is string {
  return historyText(value, 128) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}
function historyProvider(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["github", "gitlab", "direct-manifest", "project-page", "unlocated-historical"].includes(value)
  );
}
function historyReason(value: unknown): boolean {
  return value === null || (typeof value === "string" && Object.hasOwn(resume, value));
}
function historyAssessment(value: unknown, archive: boolean): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.status === "unknown")
    return (
      historyReason(value.reason) ||
      value.reason ===
        (archive ? "invalid-or-changed-commit-metadata" : "invalid-or-changed-pin-metadata")
    );
  if (
    !historyIdentity(value.repository_id) ||
    value.repository_id === null ||
    value.destination_availability !== "unknown" ||
    value.accepted_bytes !== "unverified" ||
    !historyHash(value.accounting_scope_sha256)
  )
    return false;
  if (archive)
    return (
      value.status === "provider-reported-commit-present" &&
      typeof value.commit_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(value.commit_sha) &&
      typeof value.tree_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(value.tree_sha) &&
      historyHash(value.commit_facts_sha256)
    );
  return (
    ((value.status === "provider-reported-pin-present" && value.identity_binding === "reviewed") ||
      (value.status === "provider-reported-pin-observed" &&
        value.identity_binding === "unbound-observation")) &&
    historyIdentity(value.release_id) &&
    value.release_id !== null &&
    historyIdentity(value.asset_id) &&
    value.asset_id !== null &&
    historyHash(value.asset_facts_sha256) &&
    (value.provider_digest === null ||
      (typeof value.provider_digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(value.provider_digest)))
  );
}

/** Retained comparison data is untrusted input; a malformed ID must never become a new baseline. */
export function isHealthObservationHistory(
  value: unknown,
  completed: number,
): value is HealthObservation {
  if (
    !isRecord(value) ||
    !historyProvider(value.provider) ||
    !historyText(value.repository) ||
    !historyHash(value.observation_contract_sha256) ||
    !historyClock(value.observed_at, completed) ||
    !Array.isArray(value.port_ids) ||
    value.port_ids.length > 4096 ||
    !value.port_ids.every(historyPortId) ||
    new Set(value.port_ids).size !== value.port_ids.length ||
    (value.release_ref !== undefined && !historyText(value.release_ref, 200)) ||
    !["reachable", "unknown"].includes(String(value.status)) ||
    !historyReason(value.reason) ||
    (value.status === "reachable" && value.reason !== null) ||
    !historyIdentity(value.baseline_repository_id) ||
    !historyIdentity(value.observed_repository_id) ||
    !historyIdentity(value.observed_redirect_repository_id) ||
    !historyStatus(value.http_status) ||
    !historyStatus(value.comparison_http_status) ||
    (value.comparison_observed_at !== null &&
      !historyClock(value.comparison_observed_at, Date.parse(value.observed_at))) ||
    (value.retry_at !== null && !historyClock(value.retry_at)) ||
    (value.archived !== null && typeof value.archived !== "boolean") ||
    typeof value.attempted !== "boolean" ||
    typeof value.metadata_reused !== "boolean" ||
    typeof value.accounted_for !== "boolean" ||
    !historyText(value.classification, 256) ||
    (value.resume_condition !== null && !historyText(value.resume_condition, 4096)) ||
    (value.reviewed_condition_sha256 !== null && !historyHash(value.reviewed_condition_sha256)) ||
    !historyAssessment(value.pin_assessment, false) ||
    !historyAssessment(value.source_archive_assessment, true)
  )
    return false;
  return (
    (value.observed_release_id === undefined || historyIdentity(value.observed_release_id)) &&
    (value.observed_size === undefined ||
      value.observed_size === null ||
      (typeof value.observed_size === "number" &&
        Number.isSafeInteger(value.observed_size) &&
        value.observed_size >= 0)) &&
    (value.observed_asset_digests === undefined ||
      (Array.isArray(value.observed_asset_digests) &&
        value.observed_asset_digests.length < 100 &&
        value.observed_asset_digests.every(
          (digest: unknown) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest),
        )))
  );
}

export function isHealthIncidentHistory(value: unknown, completed: number): value is PriorIncident {
  return (
    isRecord(value) &&
    historyHash(value.key) &&
    historyHash(value.material_sha256) &&
    historyHash(value.observation_contract_sha256) &&
    historyPortId(value.port_id) &&
    historyProvider(value.provider) &&
    historyText(value.location) &&
    (value.release_ref === null || historyText(value.release_ref, 200)) &&
    value.operation === "observe-availability" &&
    historyReason(value.rule) &&
    value.rule !== null &&
    typeof value.notify === "boolean" &&
    typeof value.accounted_for === "boolean" &&
    historyText(value.classification, 256) &&
    historyClock(value.observed_at, completed) &&
    historyClock(value.first_seen, Date.parse(value.observed_at)) &&
    typeof value.occurrences === "number" &&
    Number.isSafeInteger(value.occurrences) &&
    value.occurrences > 0 &&
    historyStatus(value.http_status) &&
    historyStatus(value.comparison_http_status) &&
    (value.comparison_observed_at === null ||
      historyClock(value.comparison_observed_at, Date.parse(value.observed_at))) &&
    (value.retry_at === null || historyClock(value.retry_at)) &&
    (value.resume_condition === null || historyText(value.resume_condition, 4096))
  );
}

function recordOriginalMembership(record: LocationRecord, portId: string, releaseProvider: string) {
  if (!record.port_ids.includes(portId)) record.port_ids.push(portId);
  if (!record.release_providers.includes(releaseProvider))
    record.release_providers.push(releaseProvider);
  record.original_upstream_port_ids ??= [];
  if (!record.original_upstream_port_ids.includes(portId))
    record.original_upstream_port_ids.push(portId);
}

function inventoryOriginalLocation(records: Map<string, LocationRecord>, port: HealthPort) {
  const releaseProvider = port.release?.provider ?? "github";
  // Changing provider does not remove the declared original upstream.
  let project;
  try {
    project = new URL(port.project_url ?? "");
  } catch {
    if (port.project_url !== undefined) throw new Error("Unsupported original upstream location");
    project = null;
  }
  if (
    project?.protocol === "https:" &&
    !project.username &&
    !project.password &&
    !project.port &&
    !project.search &&
    !project.hash &&
    ["github.com", "gitlab.com"].includes(project.hostname)
  ) {
    const provider = project.hostname === "github.com" ? "github" : "gitlab";
    const repository = project.pathname.replace(/^\/|\/$/gu, "").replace(/\.git$/u, "");
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..") ||
      (provider === "github" && repository.split("/").length !== 2) ||
      repository.length > 200
    )
      throw new Error("Unsupported original upstream repository");
    const key = `${provider}:${provider === "github" ? repository.toLowerCase() : repository}`;
    if (!records.has(key))
      records.set(key, { provider, repository, port_ids: [], release_providers: [] });
    const record = requiredValue(records.get(key));
    recordOriginalMembership(record, port.id, releaseProvider);
  } else if (project) {
    if (
      project.protocol !== "https:" ||
      project.username ||
      project.password ||
      project.port ||
      project.search ||
      project.hash ||
      project.href.length > 2048 ||
      !/^[a-z0-9.-]+$/iu.test(project.hostname) ||
      !project.hostname.includes(".") ||
      /^(?:[0-9.]+|.*\.local|.*\.localhost)$/iu.test(project.hostname)
    )
      throw new Error("Unsupported original upstream location");
    const key = `project-page:${project.href}`;
    if (!records.has(key))
      records.set(key, {
        provider: "project-page",
        repository: project.href,
        port_ids: [],
        release_providers: [],
      });
    const record = requiredValue(records.get(key));
    recordOriginalMembership(record, port.id, releaseProvider);
  }
}

function recordHistoricalScope(record: LocationRecord, scope: HistoricalIdentity) {
  if (
    !requiredValue(record.historical_artifact_identities).some(
      (value) => observationHash(value) === observationHash(scope),
    )
  )
    requiredValue(record.historical_artifact_identities).push(scope);
}

function inventory(catalog: HealthCatalog) {
  const records = new Map<string, LocationRecord>();
  const directPorts = [];
  const ids = new Set();
  if (!Array.isArray(catalog?.ports)) throw new Error("Catalog ports must be an array");
  for (const port of catalog.ports) {
    if (
      typeof port.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id) ||
      ids.has(port.id)
    )
      throw new Error("Catalog requires unique stable port IDs");
    ids.add(port.id);
    const releaseProvider = port.release?.provider ?? "github";
    if (releaseProvider === "direct-manifest") {
      directPorts.push(port.id);
      if (
        !port.release?.direct ||
        typeof port.release.direct !== "object" ||
        Array.isArray(port.release.direct) ||
        Object.keys(port.release.direct).length === 0
      )
        throw new Error("Direct manifest requires explicit artifact locations");
      for (const [platform, artifact] of Object.entries(port.release.direct)) {
        let url;
        try {
          url = new URL(artifact.url);
        } catch {
          throw new Error("Direct manifest requires an absolute artifact URL");
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.hash ||
          url.search ||
          url.href.length > 2048 ||
          !/^[a-z0-9.-]+$/iu.test(url.hostname) ||
          !url.hostname.includes(".") ||
          /^(?:[0-9.]+|.*\.local|.*\.localhost)$/iu.test(url.hostname) ||
          !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
          typeof artifact.version !== "string" ||
          !artifact.version ||
          !Number.isSafeInteger(artifact.size) ||
          artifact.size <= 0
        )
          throw new Error("Direct manifest requires a safe exact artifact identity");
        const key = `direct-manifest:${url.href}`;
        if (!records.has(key))
          records.set(key, {
            provider: "direct-manifest",
            repository: url.href,
            port_ids: [],
            release_providers: [releaseProvider],
            artifact_identities: [],
          });
        const record = requiredValue(records.get(key));
        if (!record.port_ids.includes(port.id)) record.port_ids.push(port.id);
        requiredValue(record.artifact_identities).push({
          port_id: port.id,
          platform,
          version: artifact.version,
          sha256: artifact.sha256,
          size: artifact.size,
        });
      }
      continue;
    }
    // A prepared runtime may declare only project_url. The original-location
    // pass below inventories that upstream without inferring release artifacts.
    // An explicitly supplied repository still requires normal hosted validation.
    const repository = port.release?.repository;
    if (releaseProvider === "user-prepared" && repository === undefined) continue;
    const provider = releaseProvider === "user-prepared" ? "github" : releaseProvider;
    const pattern =
      provider === "github"
        ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
        : /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
    if (
      !["github", "gitlab"].includes(provider) ||
      typeof repository !== "string" ||
      repository.length > 200 ||
      !pattern.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Unsupported hosted catalog repository");
    const key = `${provider}:${provider === "github" ? repository.toLowerCase() : repository}`;
    if (!records.has(key))
      records.set(key, { provider, repository, port_ids: [], release_providers: [] });
    requiredValue(records.get(key)).port_ids.push(port.id);
    (requiredValue(records.get(key)).acquisition_port_ids ??= []).push(port.id);
    if (!requiredValue(records.get(key)).release_providers.includes(releaseProvider))
      requiredValue(records.get(key)).release_providers.push(releaseProvider);
  }
  for (const port of catalog.ports) inventoryOriginalLocation(records, port);
  for (const port of catalog.ports) {
    const scopes = (catalog.source_catalog?.qualification ?? [])
      .filter((value) => value.scope?.port_id === port.id)
      .map((value) => value.scope);
    const repositories = [...records.values()].filter(
      (record) =>
        ["github", "gitlab"].includes(record.provider) && record.port_ids.includes(port.id),
    );
    for (const scope of scopes) {
      if (
        typeof scope.upstream_ref !== "string" ||
        !scope.upstream_ref ||
        scope.upstream_ref.length > 200 ||
        !/^[a-f0-9]{64}$/u.test(scope.artifact_sha256 ?? "")
      )
        throw new Error("Qualification requires an exact historical release identity");
      const exactDirect = Object.values(port.release?.direct ?? {}).some(
        (pin) => pin.version === scope.upstream_ref && pin.sha256 === scope.artifact_sha256,
      );
      if (exactDirect) continue;
      if (!repositories.length) {
        const key = `unlocated:${port.id}:${scope.upstream_ref}`;
        if (!records.has(key))
          records.set(key, {
            provider: "unlocated-historical",
            repository: "no declared historical acquisition location",
            release_ref: scope.upstream_ref,
            port_ids: [port.id],
            release_providers: [],
            historical_artifact_identities: [],
          });
        const record = requiredValue(records.get(key));
        recordHistoricalScope(record, scope);
      }
      for (const location of repositories) {
        const key = `${location.provider}:${location.repository}:release:${scope.upstream_ref}`;
        if (!records.has(key))
          records.set(key, {
            provider: location.provider,
            repository: location.repository,
            release_ref: scope.upstream_ref,
            historical_artifact_identities: [],
            port_ids: [],
            release_providers: location.release_providers,
          });
        const record = requiredValue(records.get(key));
        if (!record.port_ids.includes(port.id)) record.port_ids.push(port.id);
        recordHistoricalScope(record, scope);
      }
    }
  }
  return { records: [...records.values()], directPorts };
}

function retryAt(headers: Headers, now: number) {
  const retry = headers.get("retry-after");
  const delay =
    retry && /^\d+$/u.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? "");
  const reset = headers.get("x-ratelimit-reset");
  const resetTime = reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 : NaN;
  const candidates = [delay, resetTime].filter(
    (value) => Number.isFinite(value) && value <= 8.64e15,
  );
  return new Date(Math.max(now + 60_000, ...candidates)).toISOString();
}

function statusReason(response: Pick<Response, "status" | "headers">) {
  if ([301, 302, 303, 307, 308].includes(response.status)) return "provider-redirect";
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  )
    return "rate-limit";
  if (response.status === 404) return "inaccessible-or-missing";
  if (response.status === 401) return "authentication";
  if (response.status === 403) return "forbidden";
  if (response.status >= 500) return "provider-error";
  return "provider-status";
}

async function cancelBody(response: { body?: ReadableStream<Uint8Array> | null } | undefined) {
  try {
    await response?.body?.cancel();
  } catch {
    /* A failed stream cannot supply metadata. */
  }
}

async function metadata(
  response: Response,
  budget: { response_bytes: number },
  now: () => number,
  deadline: number,
): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json") || !response.body)
    throw new HealthFailure("invalid-metadata");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const bytesChunk: unknown = chunk;
    if (!(bytesChunk instanceof Uint8Array)) throw new HealthFailure("invalid-metadata");
    bytes += bytesChunk.length;
    budget.response_bytes += bytesChunk.length;
    if (
      bytes > resourceLimits.response_bytes ||
      budget.response_bytes > resourceLimits.total_bytes ||
      now() >= deadline
    )
      throw new HealthFailure("budget");
    chunks.push(bytesChunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HealthFailure("invalid-metadata");
  }
}

function prepareHealthInventory(input: unknown, accountingInput: unknown) {
  assertHealthCatalog(input);
  const catalog = structuredClone(input);
  const reviewedAccounting = validateHealthAccountingPolicy(structuredClone(accountingInput));
  return { catalog, reviewedAccounting, completeInventory: inventory(catalog) };
}

function prepareHealthCollection(
  input: unknown,
  portIds: string[] | null,
  accountingInput: unknown,
  prepared = prepareHealthInventory(input, accountingInput),
) {
  const { catalog, reviewedAccounting, completeInventory } = prepared;
  if (
    portIds !== null &&
    (!Array.isArray(portIds) ||
      new Set(portIds).size !== portIds.length ||
      portIds.some((id) => !catalog.ports.some((port) => port.id === id)))
  )
    throw new Error("Scoped health requires unique existing port IDs");
  const selectedPorts = catalog.ports.filter(
    (port) => portIds === null || portIds.includes(port.id),
  );
  // Keep all shared-location identities and maintenance declarations in a probe.
  // Selecting one port must not erase another port's unaccounted condition.
  const records = completeInventory.records.filter(
    (record) => portIds === null || record.port_ids.some((id) => portIds.includes(id)),
  );
  if (portIds !== null) {
    const order = new Map(portIds.map((id, index) => [id, index]));
    const rank = (record: LocationRecord) =>
      Math.min(...record.port_ids.map((id) => order.get(id) ?? Infinity));
    records.sort((left, right) => rank(left) - rank(right));
  }
  const directPorts = completeInventory.directPorts.filter(
    (id) => portIds === null || portIds.includes(id),
  );
  // Reviewed identities bind the artifact they describe, independently of UI
  // metadata and other platforms. Format 1 remains readable for old fixtures.
  const contractMatches = (
    rule: { port_id: string; port_contract_sha256: string },
    id: string,
    platform?: string,
    endpoint?: { role: "project" | "acquisition"; provider: string; repository: string },
  ) => {
    const port = requiredValue(catalog.ports.find((entry) => entry.id === id));
    const hash =
      reviewedAccounting.format_version === 1
        ? portContract(port)
        : platform !== undefined
          ? healthArtifactHash(port, platform)
          : endpoint
            ? healthEndpointHash(port, endpoint.role, endpoint.provider, endpoint.repository)
            : null;
    return rule.port_id === id && rule.port_contract_sha256 === hash;
  };
  const pinRules = (record: LocationRecord) => {
    if (record.provider !== "direct-manifest") return [];
    const rules = requiredValue(record.artifact_identities).map((identity) =>
      reviewedAccounting.pins.find(
        (rule) =>
          contractMatches(rule, identity.port_id, identity.platform) &&
          rule.platform === identity.platform &&
          rule.url === record.repository &&
          rule.size === identity.size &&
          rule.sha256 === identity.sha256,
      ),
    );
    // A new unbound declaration can share an endpoint with a reviewed one. The
    // reviewed identity is still checked; it never disappears into the generic path.
    return reviewedAccounting.format_version === 2
      ? rules.filter((rule) => rule !== undefined)
      : rules.every((rule) => rule !== undefined)
        ? rules
        : [];
  };
  const pinBindingConflict = (record: LocationRecord) =>
    record.provider === "direct-manifest" &&
    requiredValue(record.artifact_identities).some((identity) =>
      reviewedAccounting.pins.some(
        (rule) =>
          rule.port_id === identity.port_id &&
          rule.platform === identity.platform &&
          rule.url === record.repository &&
          (!contractMatches(rule, identity.port_id, identity.platform) ||
            rule.size !== identity.size ||
            rule.sha256 !== identity.sha256),
      ),
    );
  const declaredPins = (record: LocationRecord) => {
    if (reviewedAccounting.format_version !== 2 || record.provider !== "direct-manifest") return [];
    let parsed;
    try {
      parsed = githubDirectPin(record.repository);
    } catch {
      return [];
    }
    return requiredValue(record.artifact_identities).map((identity) => ({
      ...parsed,
      url: record.repository,
      size: identity.size,
      sha256: identity.sha256,
    }));
  };
  const networkRecords = records.filter((record) => record.provider !== "unlocated-historical");
  const archiveRules = (record: LocationRecord) => {
    if (record.provider !== "direct-manifest") return [];
    const rules = requiredValue(record.artifact_identities).map((identity) =>
      (reviewedAccounting.source_archives ?? []).find(
        (rule) =>
          contractMatches(rule, identity.port_id, identity.platform) &&
          rule.platform === identity.platform &&
          rule.url === record.repository &&
          rule.size === identity.size &&
          rule.sha256 === identity.sha256,
      ),
    );
    return rules.every((rule) => rule !== undefined) ? rules : [];
  };
  const pinnedRecords = records.filter(
    (record) => pinRules(record).length || declaredPins(record).length,
  );
  const archiveRecords = records.filter((record) => archiveRules(record).length);
  const conditionalPinRequests = pinnedRecords.length * 3;
  const conditionalArchiveRequests = archiveRecords.length * 2;
  const conservativeRequests =
    networkRecords.length + conditionalPinRequests + conditionalArchiveRequests;
  const overflow =
    conservativeRequests > HARD_REQUEST_CEILING || records.length > PRIOR_REPORT_ENTRIES;
  const requestPlan = Object.freeze({
    method: "validated selected inventory; no speculative reuse credit",
    network_records: networkRecords.length,
    conditional_pin_requests: conditionalPinRequests,
    conditional_archive_requests: conditionalArchiveRequests,
    conditional_repository_reuses: records.filter(
      (record, index) =>
        record.provider === "github" &&
        !record.release_ref &&
        [...pinnedRecords, ...archiveRecords].some(
          (pin) =>
            records.indexOf(pin) < index &&
            requiredValue(pinRules(pin)[0] ?? declaredPins(pin)[0] ?? archiveRules(pin)[0])
              .repository === record.repository,
        ),
    ).length,
    conservative_requests: conservativeRequests,
    hard_ceiling: HARD_REQUEST_CEILING,
    observation_records: records.length,
    observation_ceiling: PRIOR_REPORT_ENTRIES,
    status: overflow ? "overflow" : "admitted",
  });
  return {
    catalog,
    reviewedAccounting,
    selectedPorts,
    records,
    directPorts,
    contractMatches,
    pinRules,
    pinBindingConflict,
    declaredPins,
    archiveRules,
    overflow,
    requestPlan,
  };
}

/** Invocation-local immutable inventory: retain global identities without rescanning per candidate. */
export function createHealthRequestEstimator(
  input: unknown,
  reviewedAccounting: unknown = accountingPolicy,
) {
  const prepared = prepareHealthInventory(input, reviewedAccounting);
  return (portIds: string[] | null = null) =>
    prepareHealthCollection(null, portIds, null, prepared).requestPlan;
}

/** Pure validated upper bound used by the rotating monitor before any request. */
export function estimateHealthRequests(
  input: unknown,
  portIds: string[] | null = null,
  reviewedAccounting: unknown = accountingPolicy,
) {
  return prepareHealthCollection(input, portIds, reviewedAccounting).requestPlan;
}

// Repository-only facts cannot stand in for the configured release observer's
// pinned repository identity, complete release/asset pages or Core projection.
export async function collectRepositoryHealth(
  input: unknown,
  {
    fetch: fetcher = fetch,
    now = Date.now,
    githubToken,
    gitlabToken,
    previousReport = null,
    portIds = null,
    reviewedAccounting: accountingInput = accountingPolicy,
    lineageRecords = [],
  }: HealthOptions = {},
) {
  const {
    catalog,
    reviewedAccounting,
    selectedPorts,
    records,
    directPorts,
    contractMatches,
    pinRules,
    pinBindingConflict,
    declaredPins,
    archiveRules,
    overflow,
    requestPlan,
  } = prepareHealthCollection(input, portIds, accountingInput);
  const limits = Object.freeze({
    ...resourceLimits,
    requests: overflow ? 0 : requestPlan.conservative_requests,
  });
  const lineage = assessedLineage(catalog, lineageRecords);
  const currentPortHashes = healthCatalogPortHashes(catalog, lineageRecords);
  const catalogHash = observationHash(catalog);
  const started = now();
  const previous = isPriorReport(previousReport, catalogHash, catalog.ports.length, started)
    ? previousReport
    : null;
  if (isRecord(previousReport) && previousReport.format_version === 3 && previous === null)
    throw new Error("Invalid historical health comparison; refusing to reset retained identities");
  const previousUsable =
    previous !== null &&
    ((isRecord(previousReport) && previousReport.format_version === 3) ||
      started - Date.parse(previous.completed_at) <= 24 * 60 * 60 * 1000);
  const priorObservations = previous?.observations ?? [];
  const priorIncidents = new Map<string, PriorIncident>(
    previousUsable
      ? previous.port_health
          .flatMap((port) => port.canonical_incidents)
          .map((incident) => [incident.key, incident])
      : [],
  );
  const deadline = started + limits.duration_ms;
  const consumed = { requests: 0, response_bytes: 0 };
  // This collection's complete 200 repository response can serve both the
  // pin validator and the identical original-location observation. Never
  // import prior reports or equate old and relocated repository endpoints.
  const repositoryMetadata = new Map<string, unknown>();
  const deferred = new Map<string, string>();
  const observations: HealthObservation[] = [];
  const originalRules = (record: LocationRecord) => {
    if (record.release_ref !== undefined) return [];
    const rules = record.port_ids.map((id) =>
      reviewedAccounting.original_conditions.find((rule) => {
        const role = rule.role ?? "project";
        const members =
          role === "project" ? record.original_upstream_port_ids : record.acquisition_port_ids;
        return (
          members?.includes(id) &&
          contractMatches(rule, id, undefined, {
            role,
            provider: record.provider,
            repository: record.repository,
          }) &&
          rule.provider === record.provider &&
          rule.repository === record.repository
        );
      }),
    );
    return rules.every((rule) => rule !== undefined) ? rules : [];
  };
  const observationContract = (record: LocationRecord) =>
    observationHash({
      format_version: HEALTH_INPUTS_VERSION,
      provider: record.provider,
      repository: record.repository,
      release_ref: record.release_ref ?? null,
      artifacts: [...(record.artifact_identities ?? [])].sort((a, b) =>
        observationHash(a).localeCompare(observationHash(b)),
      ),
      historical: [...(record.historical_artifact_identities ?? [])].sort((a, b) =>
        observationHash(a).localeCompare(observationHash(b)),
      ),
      endpoints: record.port_ids.toSorted().map((id) => ({
        port_id: id,
        reviewed_project_identity: record.original_upstream_port_ids?.includes(id)
          ? (lineage.get(id)?.current.repository ?? null)
          : null,
        roles: (["project", "acquisition"] as const)
          .filter((role) =>
            (role === "project"
              ? record.original_upstream_port_ids
              : record.acquisition_port_ids
            )?.includes(id),
          )
          .map((role) =>
            healthEndpointHash(
              requiredValue(catalog.ports.find((port) => port.id === id)),
              role,
              record.provider,
              record.repository,
            ),
          ),
      })),
    });
  const readGithubMetadata = async (endpoint: string) => {
    const remaining = deadline - now();
    if (
      remaining <= 0 ||
      consumed.requests >= limits.requests ||
      consumed.response_bytes >= limits.total_bytes
    )
      throw new HealthFailure("budget");
    if (deferred.has("github")) throw new HealthFailure("rate-limit");
    const headers = {
      "User-Agent": "Portcove-catalog-audit",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    };
    const signal = AbortSignal.timeout(Math.min(limits.request_ms, remaining));
    let response;
    consumed.requests++;
    try {
      response = await fetcher(`https://api.github.com/repos/${endpoint}`, {
        headers,
        redirect: "manual",
        signal,
      });
      if (response.status !== 200) {
        const reason = statusReason(response);
        if (reason === "rate-limit") deferred.set("github", retryAt(response.headers, now()));
        throw new HealthFailure(reason);
      }
      if (response.headers.has("link")) throw new HealthFailure("invalid-metadata");
      const facts = await metadata(response, consumed, now, deadline);
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(endpoint))
        repositoryMetadata.set(`https://api.github.com/repos/${endpoint}`, facts);
      return facts;
    } catch (error) {
      if (error instanceof HealthFailure) throw error;
      throw new HealthFailure(signal.aborted ? "timeout" : "transport");
    } finally {
      await cancelBody(response);
    }
  };
  for (const record of records) {
    const budgetProvider = ["direct-manifest", "project-page"].includes(record.provider)
      ? new URL(record.repository).origin
      : record.provider;
    const priorLocation = priorObservations.find(
      (value) =>
        value.provider === record.provider &&
        value.repository === record.repository &&
        value.release_ref === record.release_ref,
    );
    const priorBaseline = priorNumber(
      priorLocation?.baseline_repository_id ?? priorLocation?.observed_repository_id,
    );
    const contract = observationContract(record);
    const comparisonMatches = priorLocation?.observation_contract_sha256 === contract;
    const result: HealthObservation = {
      ...record,
      observation_contract_sha256: contract,
      observed_at: new Date(started).toISOString(),
      attempted: false,
      metadata_reused: false,
      status: "unknown",
      reason: null,
      http_status: null,
      archived: null,
      observed_repository_id: null,
      baseline_repository_id: priorBaseline !== null && priorBaseline > 0 ? priorBaseline : null,
      comparison_http_status: null,
      comparison_observed_at: null,
      retry_at: null,
      resume_condition: null,
      pin_assessment: null,
      source_archive_assessment: null,
      reviewed_condition_sha256: null,
      observed_redirect_repository_id: null,
    };
    const fail = (reason: HealthReason) => {
      result.reason = reason;
      result.resume_condition = resume[reason];
    };
    observations.push(result);
    const remaining = deadline - now();
    if (remaining <= 0 || consumed.response_bytes >= limits.total_bytes) {
      fail("budget");
      continue;
    }
    // Static no-request failures retain their reasons even when the selected
    // inventory needs zero calls or preflight refuses the whole collection.
    if (record.provider === "unlocated-historical") {
      fail("release-identity-unavailable");
      continue;
    }
    const github = record.provider === "github";
    const direct = record.provider === "direct-manifest";
    const plain = direct || record.provider === "project-page";
    if (
      direct &&
      new Set(
        requiredValue(record.artifact_identities).map((identity) =>
          observationHash({
            version: identity.version,
            sha256: identity.sha256,
            size: identity.size,
          }),
        ),
      ).size !== 1
    ) {
      fail("identity-mismatch");
      continue;
    }
    if (overflow) {
      fail("budget");
      result.resume_condition =
        "The validated request forecast exceeds the fixed hard ceiling; reduce legitimate obligations or deliver a separately reviewed capacity redesign. Partial collections do not establish full health.";
      continue;
    }
    if (deferred.has(budgetProvider)) {
      fail("rate-limit");
      result.retry_at = requiredValue(deferred.get(budgetProvider));
      if (previousUsable && comparisonMatches && priorLocation?.reason === "rate-limit") {
        result.comparison_http_status = priorNumber(
          priorLocation.http_status ?? priorLocation.comparison_http_status,
        );
        result.comparison_observed_at =
          priorText(priorLocation.observed_at) ??
          priorText(priorLocation.comparison_observed_at) ??
          previous?.completed_at ??
          null;
      }
      continue;
    }
    const reused =
      record.provider === "github" &&
      !record.release_ref &&
      repositoryMetadata.has(`https://api.github.com/repos/${record.repository}`);
    if (!reused && consumed.requests >= limits.requests) {
      fail("budget");
      continue;
    }
    if (
      previousUsable &&
      comparisonMatches &&
      priorLocation?.reason === "rate-limit" &&
      typeof priorLocation.retry_at === "string" &&
      Number.isFinite(Date.parse(priorLocation.retry_at)) &&
      Date.parse(priorLocation.retry_at) > started
    ) {
      fail("rate-limit");
      result.retry_at = priorLocation.retry_at;
      result.comparison_http_status = priorNumber(
        priorLocation.http_status ?? priorLocation.comparison_http_status,
      );
      result.comparison_observed_at =
        priorText(priorLocation.comparison_observed_at) ?? previous?.completed_at ?? null;
      continue;
    }
    const url = plain
      ? record.repository
      : github
        ? `https://api.github.com/repos/${record.repository}`
        : `https://gitlab.com/api/v4/projects/${encodeURIComponent(record.repository)}`;
    const requestUrl = record.release_ref
      ? `${url}/releases/${github ? "tags/" : ""}${encodeURIComponent(record.release_ref)}`
      : url;
    const headers: Record<string, string> = { "User-Agent": "Portcove-catalog-audit" };
    if (github) {
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    } else if (record.provider === "gitlab" && gitlabToken) headers["PRIVATE-TOKEN"] = gitlabToken;
    const signal = AbortSignal.timeout(Math.min(limits.request_ms, remaining));
    if (!reused) consumed.requests++;
    result.attempted = !reused;
    result.metadata_reused = Boolean(reused);
    let response: Response | undefined;
    try {
      response = reused
        ? new Response(null, { status: 200 })
        : await fetcher(requestUrl, {
            headers,
            // Observe a redirect as an HTTP fact rather than losing it in a fetch
            // exception. Never follow it or retain a potentially signed Location.
            redirect: "manual",
            signal,
            ...(plain ? { method: "HEAD" } : {}),
          });
      result.http_status = response.status;
      if (response.status !== 200) {
        fail(statusReason(response));
        const conditions = originalRules(record);
        if (
          conditions.length &&
          conditions.every(
            (rule) =>
              rule.http_status === requiredValue(response).status && rule.reason === result.reason,
          )
        ) {
          let match = true;
          if (response.status === 301) {
            const facts = await metadata(response, consumed, now, deadline);
            const expectedId = requiredValue(conditions[0]).redirect_repository_id;
            match =
              isRecord(facts) &&
              facts.message === "Moved Permanently" &&
              facts.url === `https://api.github.com/repositories/${expectedId}` &&
              conditions.every((rule) => rule.redirect_repository_id === expectedId) &&
              (result.baseline_repository_id === null ||
                result.baseline_repository_id === expectedId);
            if (match) result.observed_redirect_repository_id = expectedId;
          }
          if (match) {
            result.reviewed_condition_sha256 = observationHash(conditions);
            result.resume_condition = requiredValue(conditions[0]).resume_condition;
          }
        }
        const pins = pinRules(record);
        const declarations = declaredPins(record);
        if (plain && direct && response.status === 302 && (pins.length || declarations.length)) {
          result.pin_assessment = { status: "unknown", reason: null };
          try {
            if (pinBindingConflict(record)) throw new HealthFailure("identity-mismatch");
            const pin = requiredValue(pins[0] ?? declarations[0]);
            const repo = await readGithubMetadata(pin.repository);
            const release = await readGithubMetadata(
              `${pin.repository}/releases/tags/${encodeURIComponent(pin.tag)}`,
            );
            if (
              !isRecord(release) ||
              typeof release.id !== "number" ||
              !Number.isSafeInteger(release.id) ||
              release.id <= 0
            )
              throw new HealthFailure("invalid-metadata");
            if (
              !isRecord(repo) ||
              typeof repo.id !== "number" ||
              !Number.isSafeInteger(repo.id) ||
              repo.id <= 0
            )
              throw new HealthFailure("invalid-metadata");
            result.observed_repository_id = repo.id;
            result.baseline_repository_id ??= pins[0]?.repository_id ?? repo.id;
            if (
              result.baseline_repository_id !== repo.id ||
              pins.some(
                (scope) => scope.repository_id !== repo.id || scope.release_id !== release.id,
              )
            )
              throw new HealthFailure("identity-mismatch");
            const assets = await readGithubMetadata(
              `${pin.repository}/releases/${release.id}/assets?per_page=100`,
            );
            let facts;
            for (const declaration of declarations)
              facts = validateGithubDeclaredPinMetadata(repo, release, assets, declaration);
            for (const scope of pins) {
              facts = validateGithubPinMetadata(repo, release, assets, scope);
              if (facts.asset.id !== scope.asset_id) throw new HealthFailure("identity-mismatch");
            }
            if (!facts) throw new HealthFailure("invalid-metadata");
            const bound = pins.length === record.artifact_identities?.length;
            result.pin_assessment = {
              status: bound ? "provider-reported-pin-present" : "provider-reported-pin-observed",
              identity_binding: bound ? "reviewed" : "unbound-observation",
              repository_id: facts.repository.id,
              release_id: facts.release.id,
              asset_id: facts.asset.id,
              asset_facts_sha256: observationHash(facts.asset),
              provider_digest: facts.asset.digest,
              destination_availability: "unknown",
              accepted_bytes: "unverified",
              accounting_scope_sha256: observationHash({ reviewed: pins, declarations }),
            };
          } catch (error) {
            result.pin_assessment = {
              status: "unknown",
              reason:
                error instanceof HealthFailure ? error.reason : "invalid-or-changed-pin-metadata",
            };
            result.resume_condition =
              "Reassess exact declared pin metadata; changed, unavailable, ambiguous or incomplete facts remain visible. Reviewed numeric identities are retained. No redirect destination or bytes were inspected.";
          }
        }
        const archives = archiveRules(record);
        if (plain && direct && response.status === 302 && archives.length) {
          result.source_archive_assessment = { status: "unknown", reason: null };
          try {
            const archive = requiredValue(archives[0]);
            const repo = await readGithubMetadata(archive.repository);
            const commit = await readGithubMetadata(
              `${archive.repository}/git/commits/${archive.commit_sha}`,
            );
            let facts;
            for (const scope of archives)
              facts = validateGithubSourceArchiveMetadata(repo, commit, scope);
            if (!facts) throw new HealthFailure("invalid-metadata");
            result.source_archive_assessment = {
              status: "provider-reported-commit-present",
              repository_id: facts.repository.id,
              commit_sha: facts.commit.sha,
              tree_sha: facts.commit.tree_sha,
              commit_facts_sha256: observationHash(facts.commit),
              destination_availability: "unknown",
              accepted_bytes: "unverified",
              accounting_scope_sha256: observationHash(archives),
            };
          } catch (error) {
            result.source_archive_assessment = {
              status: "unknown",
              reason:
                error instanceof HealthFailure
                  ? error.reason
                  : "invalid-or-changed-commit-metadata",
            };
            result.resume_condition =
              "Reassess the exact declared source commit metadata; missing, changed or incomplete facts remain unaccounted. Archive destination and accepted bytes remain unverified.";
          }
        }
        if (result.reason === "rate-limit") {
          result.retry_at = retryAt(response.headers, now());
          deferred.set(budgetProvider, result.retry_at);
        }
        continue;
      }
      if (now() >= deadline) {
        fail("budget");
        continue;
      }
      if (plain) {
        // HEAD never verifies accepted bytes. No download, execution or redirect
        // authority follows from a reachable declared artifact location.
        const length = response.headers.get("content-length");
        result.observed_size =
          length !== null && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length))
            ? Number(length)
            : null;
        if (
          direct &&
          (length === null ||
            !/^\d+$/u.test(length) ||
            requiredValue(record.artifact_identities).some(
              (identity) => Number(length) !== identity.size,
            ))
        ) {
          fail("invalid-metadata");
          continue;
        }
        result.status = "reachable";
        continue;
      }
      let facts;
      try {
        facts = reused
          ? repositoryMetadata.get(requestUrl)
          : await metadata(response, consumed, now, deadline);
      } catch (error) {
        fail(
          error instanceof HealthFailure ? error.reason : signal.aborted ? "timeout" : "transport",
        );
        continue;
      }
      if (record.release_ref) {
        const assets = isRecord(facts)
          ? github
            ? facts.assets
            : isRecord(facts.assets)
              ? facts.assets.links
              : undefined
          : undefined;
        if (
          !isRecord(facts) ||
          facts.tag_name !== record.release_ref ||
          !Array.isArray(assets) ||
          assets.length >= 100 ||
          (github &&
            (typeof facts.id !== "number" || !Number.isSafeInteger(facts.id) || facts.id <= 0))
        ) {
          fail("invalid-metadata");
          continue;
        }
        result.observed_release_id = github ? priorNumber(facts.id) : null;
        result.observed_asset_digests = assets
          .map((asset: unknown) => (isRecord(asset) ? asset.digest : undefined))
          .filter(
            (digest): digest is string =>
              typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest),
          );
        result.accepted_digest_match = result.observed_asset_digests.length
          ? "provider-reported"
          : "unknown; provider supplied no digest";
        if (
          !assets.length ||
          (result.observed_asset_digests.length &&
            requiredValue(record.historical_artifact_identities).some(
              (identity) =>
                !requiredValue(result.observed_asset_digests).includes(
                  `sha256:${identity.artifact_sha256}`,
                ),
            ))
        ) {
          fail("release-identity-unavailable");
          continue;
        }
        result.status = "reachable";
        continue;
      }
      if (
        !isRecord(facts) ||
        typeof facts.id !== "number" ||
        !Number.isSafeInteger(facts.id) ||
        facts.id <= 0 ||
        (typeof facts.archived !== "boolean" && (github || Object.hasOwn(facts, "archived"))) ||
        typeof (github ? facts.full_name : facts.path_with_namespace) !== "string"
      ) {
        fail("invalid-metadata");
        continue;
      }
      const observedName = github ? facts.full_name : facts.path_with_namespace;
      if (typeof observedName !== "string") throw new HealthFailure("invalid-metadata");
      const observed = github ? observedName.toLowerCase() : observedName;
      if (observed !== (github ? record.repository.toLowerCase() : record.repository)) {
        fail("identity-mismatch");
        continue;
      }
      const reviewedIds = new Set([
        ...reviewedAccounting.pins
          .filter(
            (pin) => github && pin.repository.toLowerCase() === record.repository.toLowerCase(),
          )
          .map((pin) => pin.repository_id),
        ...(reviewedAccounting.source_archives ?? [])
          .filter(
            (pin) => github && pin.repository.toLowerCase() === record.repository.toLowerCase(),
          )
          .map((pin) => pin.repository_id),
        ...(record.original_upstream_port_ids ?? []).flatMap((id) => {
          const identity = lineage.get(id)?.current.repository;
          return identity?.host === (github ? "github.com" : "gitlab.com")
            ? [Number(identity.id)]
            : [];
        }),
      ]);
      if (reviewedIds.size > 1 || [...reviewedIds].some((id) => id !== facts.id)) {
        result.observed_repository_id = facts.id;
        fail("identity-mismatch");
        continue;
      }
      result.baseline_repository_id ??= [...reviewedIds][0] ?? facts.id;
      if (result.baseline_repository_id !== facts.id) {
        result.observed_repository_id = facts.id;
        fail("identity-mismatch");
        continue;
      }
      result.status = "reachable";
      result.archived = typeof facts.archived === "boolean" ? facts.archived : null;
      result.observed_repository_id = facts.id;
    } catch (error) {
      fail(
        error instanceof HealthFailure ? error.reason : signal.aborted ? "timeout" : "transport",
      );
    } finally {
      await cancelBody(response);
    }
  }
  const reachable = observations.filter((record) => record.status === "reachable").length;
  for (const record of observations) {
    const knownMaintenance =
      record.reason === "inaccessible-or-missing" &&
      record.port_ids.every(
        (id) =>
          record.original_upstream_port_ids?.includes(id) &&
          ["retired", "superseded", "abandoned"].includes(
            catalog.ports.find((port) => port.id === id)?.upstream_status ?? "",
          ),
      );
    const pinPresent = record.pin_assessment?.status === "provider-reported-pin-present";
    const pinObserved = record.pin_assessment?.status === "provider-reported-pin-observed";
    const commitPresent =
      record.source_archive_assessment?.status === "provider-reported-commit-present";
    record.accounted_for =
      record.status === "reachable" ||
      knownMaintenance ||
      record.reviewed_condition_sha256 !== null ||
      pinPresent ||
      pinObserved ||
      commitPresent;
    record.classification = pinPresent
      ? "provider-reported-pin-present; destination-unknown; bytes-unverified"
      : pinObserved
        ? "provider-reported-pin-observed; identity-unbound; destination-unknown; bytes-unverified"
        : commitPresent
          ? "provider-reported-commit-present; destination-unknown; bytes-unverified"
          : record.reviewed_condition_sha256 !== null
            ? "reviewed-endpoint-condition; availability-unknown; lineage-separately-recorded"
            : knownMaintenance
              ? "catalog-declared-unavailable-original"
              : record.status === "reachable"
                ? "location-reachable; exact-bytes-unverified"
                : "unclassified-or-actionable";
  }
  const incompleteReasons = new Set([
    "authentication",
    "forbidden",
    "rate-limit",
    "provider-error",
    "transport",
    "timeout",
    "invalid-metadata",
    "budget",
    "provider-status",
    "invalid-or-changed-pin-metadata",
    "invalid-or-changed-commit-metadata",
  ]);
  const collected = (record: HealthObservation) =>
    !incompleteReasons.has(record.reason ?? "") &&
    !incompleteReasons.has(record.pin_assessment?.reason ?? "") &&
    !incompleteReasons.has(record.source_archive_assessment?.reason ?? "");
  const portHealth = selectedPorts.map((port) => {
    const locations = observations.filter((record) => record.port_ids.includes(port.id));
    const original = locations.filter((record) =>
      record.original_upstream_port_ids?.includes(port.id),
    );
    const qualification = (catalog.source_catalog?.qualification ?? []).filter(
      (record) => record.scope?.port_id === port.id,
    );
    return {
      port_id: port.id,
      health_contract_sha256: currentPortHashes.get(port.id)!,
      collection_status: locations.every(collected) ? ("complete" as const) : ("partial" as const),
      original_upstream: {
        status:
          original.length && original.every((record) => record.status === "reachable")
            ? "reachable"
            : "unknown",
        declared_project_url: port.project_url ?? null,
        locations: original.map((record) => ({
          provider: record.provider,
          repository: record.repository,
        })),
        resume_condition:
          "Complete original-location observations; reachability never establishes continuity.",
      },
      lineage: {
        status: lineage.get(port.id)?.status ?? "not-assessed",
        owner_issue: 139,
        successor_selected: lineage.has(port.id)
          ? lineage
              .get(port.id)!
              .decisions.some(
                (decision) =>
                  decision.outcome === "accepted" && decision.relationship === "successor",
              )
          : null,
        current: lineage.get(port.id)?.current ?? null,
        history: lineage.get(port.id)?.history ?? [],
        decisions: lineage.get(port.id)?.decisions ?? [],
        catalog_upstream_status: port.upstream_status ?? "active",
        authority: "retained reviewed authoring decisions; no new lineage decision",
      },
      accepted_artifact_obtainability: {
        status: "unknown",
        identities: locations.flatMap((record) =>
          (record.artifact_identities ?? []).filter((identity) => identity.port_id === port.id),
        ),
        historical_identities: qualification.map((record) => record.scope),
        locations: locations.map((record) => ({
          provider: record.provider,
          location: record.repository,
          release_ref: record.release_ref ?? null,
          historical_identities: (record.historical_artifact_identities ?? []).filter(
            (identity) => identity.port_id === port.id,
          ),
          status: record.status,
          reason: record.reason,
        })),
        resume_condition:
          "Resolve and verify exact accepted bytes at every applicable declared acquisition location; metadata and HEAD do not verify bytes.",
      },
      preservation: { status: "unknown", owner_issue: 1306 },
      applicable_holds: {
        status: "unknown",
        owner_issue: 315,
        authority: "not evaluated or modified",
        reported_failures: qualification.filter((record) => record.outcome === "failed"),
        resume_condition:
          "Obtain artifact/authority/distribution-scoped decisions from #315/#246; reported failures never create or clear a hold here.",
      },
      qualification: {
        status: "retained-catalog-records",
        records: qualification,
        historical_platform_arrays: {
          automated: port.automated_tested_platforms ?? [],
          manual: port.manually_validated_platforms ?? [],
        },
        inherited: false,
      },
      canonical_incidents: locations
        .filter((record) => record.status !== "reachable")
        .map((record) => {
          const key = observationHash({
            port_id: port.id,
            provider: record.provider,
            location: record.repository,
            release_ref: record.release_ref ?? null,
            operation: "observe-availability",
            rule: record.reason,
            observation_contract_sha256: record.observation_contract_sha256,
          });
          const prior = priorIncidents.get(key);
          const material = observationHash({
            key,
            http_status: record.http_status ?? record.comparison_http_status,
            repository_id: record.observed_repository_id,
            release_id: record.observed_release_id ?? null,
            asset_digests: (record.observed_asset_digests ?? []).toSorted(),
            size: record.observed_size ?? null,
            classification: record.classification,
            pin_assessment: record.pin_assessment,
            source_archive_assessment: record.source_archive_assessment,
            reviewed_condition_sha256: record.reviewed_condition_sha256,
            observed_redirect_repository_id: record.observed_redirect_repository_id,
          });
          const priorOccurrences = priorNumber(prior?.occurrences);
          const priorFirstSeen = priorText(prior?.first_seen);
          const priorValid =
            prior &&
            prior.key === key &&
            priorOccurrences !== null &&
            priorOccurrences > 0 &&
            priorFirstSeen !== null &&
            Number.isFinite(Date.parse(priorFirstSeen)) &&
            Date.parse(priorFirstSeen) <= started;
          return {
            key,
            material_sha256: material,
            observation_contract_sha256: record.observation_contract_sha256,
            notify: !priorValid || prior.material_sha256 !== material,
            first_seen: priorValid ? priorFirstSeen : new Date(started).toISOString(),
            occurrences: priorValid
              ? Math.min(requiredValue(priorOccurrences ?? undefined) + 1, Number.MAX_SAFE_INTEGER)
              : 1,
            accounted_for: record.accounted_for,
            classification: record.classification,
            port_id: port.id,
            operation: "observe-availability",
            rule: record.reason,
            provider: record.provider,
            location: record.repository,
            release_ref: record.release_ref ?? null,
            comparison_http_status: record.comparison_http_status,
            comparison_observed_at: record.comparison_observed_at,
            http_status: record.http_status,
            observed_at: new Date(now()).toISOString(),
            retry_at: record.retry_at,
            resume_condition: record.resume_condition,
          };
        }),
    };
  });
  const resolvedIncidents = [...priorIncidents.values()]
    .filter((incident) =>
      observations.some(
        (record) =>
          record.status === "reachable" &&
          typeof incident.port_id === "string" &&
          record.port_ids.includes(incident.port_id) &&
          record.provider === incident.provider &&
          record.repository === incident.location &&
          (record.release_ref ?? null) === incident.release_ref &&
          record.observation_contract_sha256 === incident.observation_contract_sha256,
      ),
    )
    .map((incident) => incident.key);
  const assessmentRecoveredIncidents = [...priorIncidents.values()]
    .filter(
      (incident) =>
        incident.accounted_for === false &&
        observations.some(
          (record) =>
            record.accounted_for === true &&
            (record.pin_assessment?.status === "provider-reported-pin-present" ||
              record.pin_assessment?.status === "provider-reported-pin-observed" ||
              record.source_archive_assessment?.status === "provider-reported-commit-present") &&
            typeof incident.port_id === "string" &&
            record.port_ids.includes(incident.port_id) &&
            record.provider === incident.provider &&
            record.repository === incident.location &&
            (record.release_ref ?? null) === incident.release_ref &&
            record.observation_contract_sha256 === incident.observation_contract_sha256,
        ),
    )
    .map((incident) => incident.key);
  return {
    format_version: 3,
    collection_status:
      !overflow && observations.every(collected) ? ("complete" as const) : ("partial" as const),
    authority:
      "read-only-location-observation; no lineage, artifact, hold or qualification authority",
    catalog_sha256: catalogHash,
    accounting_policy_sha256: observationHash(reviewedAccounting),
    scope: {
      mode: portIds === null ? "full" : portIds.length ? "affected" : "none",
      selected_port_ids: selectedPorts.map((port) => port.id),
      unassessed_port_ids: catalog.ports
        .filter((port) => !selectedPorts.includes(port))
        .map((port) => port.id),
      global_health:
        portIds === null && !overflow
          ? "collection attempted; not an installability claim"
          : "not assessed",
    },
    port_health: portHealth,
    started_at: new Date(started).toISOString(),
    completed_at: new Date(now()).toISOString(),
    collection_method:
      "metadata per hosted location or HEAD per direct location; declared GitHub release pins add up to three fixed metadata reads and exact source archives up to two; identical successful repository metadata reused only within this collection; no redirects or retries; accepted bytes unverified",
    resolved_incidents: resolvedIncidents,
    assessment_recovered_incidents: assessmentRecoveredIncidents,
    material_changes: portHealth
      .flatMap((port) => port.canonical_incidents)
      .filter((incident) => incident.notify)
      .map((incident) => incident.key),
    outcome: !selectedPorts.length
      ? "not-applicable"
      : observations.every((record) => record.accounted_for)
        ? "complete"
        : "incomplete",
    degradation: observations.some((record) => record.status !== "reachable"),
    previous_report:
      previousReport === null
        ? "not supplied"
        : previousUsable
          ? "matching observation history"
          : "mismatched or incomplete; not reused",
    coverage: {
      ports: catalog.ports.length,
      hosted_ports: selectedPorts.length - directPorts.length,
      direct_manifest_port_ids: directPorts,
      monitored_ports: selectedPorts.length,
      repositories: records.length,
      attempted_repositories: observations.filter((record) => record.attempted).length,
      reused_repositories: observations.filter((record) => record.metadata_reused).length,
      reachable_repositories: reachable,
      unknown_repositories: records.length - reachable,
    },
    unassessed: [
      "upstream-continuity",
      "accepted-artifact-availability",
      "preservation",
      "distribution-authority",
      "operation-holds",
    ],
    request_plan: requestPlan,
    limits,
    consumed,
    observations,
  };
}

export function renderRepositoryHealth(
  report: Awaited<ReturnType<typeof collectRepositoryHealth>>,
) {
  const { coverage } = report;
  const lines = [
    ...(report.scope?.mode === "none"
      ? ["No selected upstream health inputs; no live requests. Global health is not assessed."]
      : []),
    `Request plan: ${report.request_plan.conservative_requests} conservative calls; ${report.request_plan.conditional_repository_reuses} conditional repository reuses; fixed ceiling ${report.request_plan.hard_ceiling}; ${report.request_plan.status}.`,
    ...(report.request_plan.status === "overflow"
      ? [
          "Preflight overflow: no live requests permitted; selected scope and global health unassessed.",
        ]
      : []),
    `Repository reachability: ${coverage.reachable_repositories}/${coverage.repositories} reachable; ${coverage.unknown_repositories} unknown; ${coverage.attempted_repositories} attempted.`,
    `Repository metadata reused within this collection: ${coverage.reused_repositories}; network requests: ${report.consumed.requests}/${report.limits.requests}.`,
    `Coverage: ${coverage.monitored_ports}/${coverage.ports} ports; ${coverage.direct_manifest_port_ids.length} direct-manifest ports included. Accepted bytes remain unverified.`,
    `Observed ${report.started_at} through ${report.completed_at}.`,
  ];
  if (report.degradation)
    lines.push(
      "Degraded/unavailable conditions remain visible; complete means accounted-for monitoring, never installability.",
    );
  for (const record of report.observations) {
    const status =
      record.status === "reachable"
        ? `reachable${record.archived === null ? " (archive state unknown)" : record.archived ? " (archived)" : ""}`
        : `unknown (${record.reason}${!record.attempted ? "; not attempted" : record.http_status === null ? "; not established" : `; HTTP ${record.http_status}`})`;
    lines.push(
      `${record.provider}:${record.repository}${record.release_ref ? `@${record.release_ref}` : ""} [${record.port_ids.join(", ")}]: ${status}; ${record.classification}`,
    );
    if (record.resume_condition)
      lines.push(
        `  Resume: ${record.resume_condition}${record.retry_at ? ` Retry at ${record.retry_at}.` : ""}`,
      );
    if (record.pin_assessment)
      lines.push(
        `  Pin metadata: ${record.pin_assessment.status}${record.pin_assessment.reason ? ` (${record.pin_assessment.reason})` : ""}; destination unknown; bytes unverified.`,
      );
    if (record.source_archive_assessment)
      lines.push(
        `  Source commit metadata: ${record.source_archive_assessment.status}${record.source_archive_assessment.reason ? ` (${record.source_archive_assessment.reason})` : ""}; destination unknown; bytes unverified.`,
      );
  }
  for (const health of report.port_health) {
    lines.push(
      `${health.port_id}: original upstream ${health.original_upstream.status}; lineage ${health.lineage.status}; exact accepted artifact ${health.accepted_artifact_obtainability.status}; preservation ${health.preservation.status}; holds ${health.applicable_holds.status}; qualification ${health.qualification.records.length} retained exact records (no inheritance).`,
    );
  }
  lines.push(`Unassessed: ${report.unassessed.join(", ")}.`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg: string) =>
        arg !== "--json" && !arg.startsWith("--previous-report=") && !arg.startsWith("--port-ids="),
    ) ||
    args.filter((arg: string) => arg.startsWith("--previous-report=")).length > 1 ||
    args.filter((arg: string) => arg.startsWith("--port-ids=")).length > 1
  )
    throw new Error(
      "Usage: check-catalog-repositories.mts [--json] [--previous-report=PATH] [--port-ids=IDS]",
    );
  const portArgument = args
    .find((arg: string) => arg.startsWith("--port-ids="))
    ?.slice("--port-ids=".length);
  const portIds =
    portArgument === undefined ? null : portArgument === "" ? [] : portArgument.split(",");
  const previousPath = args
    .find((arg: string) => arg.startsWith("--previous-report="))
    ?.slice("--previous-report=".length);
  let previousReport: unknown = null;
  if (previousPath !== undefined) {
    const handle = await open(
      previousPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      const maximum = 2 * 1024 * 1024;
      if (!stat.isFile() || stat.size > maximum)
        throw new Error("Previous report requires a bounded regular file");
      const bytes = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maximum) throw new Error("Previous report exceeds its bound");
      previousReport = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } finally {
      await handle.close();
    }
  }
  const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
  const catalog: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  const report = await collectRepositoryHealth(catalog, {
    lineageRecords: await readHealthLineage(catalog),
    githubToken: process.env.GITHUB_TOKEN,
    gitlabToken: process.env.GITLAB_TOKEN,
    previousReport,
    portIds,
  });
  if (
    process.argv.includes("--json") ||
    previousReport === null ||
    report.outcome !== "complete" ||
    report.degradation ||
    report.resolved_incidents.length ||
    report.material_changes.length
  )
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(report, null, 2)
        : renderRepositoryHealth(report),
    );
  process.exitCode = ["complete", "not-applicable"].includes(report.outcome) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(() => {
    console.error("Repository health collection failed before a complete report.");
    process.exitCode = 1;
  });
}
