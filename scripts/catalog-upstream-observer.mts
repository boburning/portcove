import { launcherModGameScopes, verifyLauncherModGameScope } from "./launcher-mod-game-scope.mts";
import {
  projectListingObservation,
  projectGitLabListingObservation,
  listingProviderIdentity,
  listingObservationReleaseIds,
  listingProjectionHash,
  listingDeclarationHash,
} from "./listing-upstream-observation.mts";
import {
  observeProviderSource,
  validateProviderProgress,
} from "./provider-release-observation.mts";
import type { ProviderCapacity, ProviderProgress } from "./provider-release-observation.mts";
import { isRecord } from "./runtime-values.mts";
import {
  projectionAssetReleaseIds,
  requireCompleteCoreCoverage,
  retainedCoreProjection,
  statedSourceCoverage,
  validStatedSourceCoverage,
  continuationCursor,
  providerProgressCursor,
  type StatedSourceCoverage,
} from "./catalog-observer-continuation.mts";
import { decodeStoredObserverCheckpoint } from "./observer-checkpoint-storage.mts";
import {
  observationHash,
  ObservationFailure,
  validateObserverConfig,
  checksumSourcesFromProjections,
  configuredCandidateObserverConfig,
  boundedProviderRetryTime,
  boundedRetainedRetryClock,
} from "./upstream-observer.mts";
import type {
  ChecksumSource,
  ObserverGitHubScope,
  ObserverConfig,
  ObserveOptions,
  ProviderObservation,
} from "./upstream-observer.mts";
import { advanceObservation } from "./observe-configured-upstream.mts";
import type { LauncherModObservation } from "./port-upstream-facts.mts";
import {
  type FirstPartyModProgress,
  launcherModSubjects,
  recordLauncherModAttempt,
  selectLauncherModAssessmentWork,
  validateFirstPartyModProgress,
} from "./upstream-launcher-mod-progress.mts";
import {
  observeModProviderRegistry,
  validateModProviderRegistryProgress,
  type ModProviderRegistryProgress,
} from "./upstream-mod-provider-registry.mts";
import {
  inputEvidenceKey,
  n64BuildJobTarget,
  n64RuntimeSourceCache,
  observeN64RuntimeHashSource,
  observeN64RuntimeSource,
  observeOriginalSource,
  type OriginalSourceFamily,
  readOriginalSourceProgress,
  revalidateOriginalSource,
  selectOriginalSourceTarget,
} from "./upstream-original-recognition.mts";
import type { N64RuntimeHashSourceObservation } from "./upstream-n64-runtime-input.mts";
import { n64AuthoringScope } from "./n64-original-binding-candidates.mts";
import {
  advanceUpstreamArtifactBuildObservation,
  rebindUpstreamBuildObservation,
} from "./upstream-github-build-output.mts";
import {
  advanceN64BuildJobObservation,
  rebindN64BuildJobObservation,
} from "./upstream-n64-build-job.mts";

export interface ObservablePort {
  /** Descriptive consumers never enter the managed Core inspector. */
  kind?: "listing";
  listing?: Record<string, unknown>;
  original_source_family?: OriginalSourceFamily;
  n64_authoring_scope_sha256?: string;
  id: string;
  channels: string[];
  definition_sha256: string;
  release: Record<string, unknown> & { repository: string };
}
export interface ObservableSource {
  provider?: "github" | "gitlab" | "direct-manifest";
  key: string;
  repository: string;
  ports: ObservablePort[];
  scope_sha256: string;
}
function listingOnly(source: ObservableSource) {
  return source.ports.every((port) => port.kind === "listing");
}

export interface CatalogObservationScopePolicy {
  policyIdentity: string;
  definitionHash: (portId: string) => string;
  staleAfterHours: number;
}

/** Bind the collector's full source scope to its exact Core policy and normalized definitions. */
export function catalogObservationScopeBinding(
  source: ObservableSource,
  policy: CatalogObservationScopePolicy,
) {
  return observationHash(catalogObservationScopeInputs(source, policy));
}

function catalogObservationScopeInputs(
  source: ObservableSource,
  policy: CatalogObservationScopePolicy,
) {
  const provider = source.provider ?? "github";
  if (listingOnly(source)) {
    return {
      contract: "normalized-current-catalog-listing-policy-v1",
      source: source.key,
      provider,
      ...(provider === "gitlab" ? { provider_proof: "explicit-page-coverage-v2" } : {}),
      scope: source.scope_sha256,
      stale_after_hours: policy.staleAfterHours,
    };
  }
  const definitions = source.ports.map(
    (port) =>
      [
        port.id,
        port.kind === "listing" ? port.definition_sha256 : policy.definitionHash(port.id),
      ] as const,
  );
  if (
    !/^[a-f0-9]{64}$/u.test(policy.policyIdentity) ||
    definitions.some(([, hash]) => !/^[a-f0-9]{64}$/u.test(hash))
  )
    throw new Error("Exact Core policy and normalized observation definitions are required");
  return {
    contract: "normalized-current-catalog-core-policy-v1",
    ...(provider !== "github" ? { provider_proof: "explicit-page-coverage-v2" } : {}),
    policy: policy.policyIdentity,
    scope: source.scope_sha256,
    definitions,
  };
}

function retainedListingClocks(source: ObservableSource, progress: SourceProgress) {
  const clocks = new Map<string, string>();
  for (const policy of progress.last_complete_policies) {
    const update = policy.listing_update;
    const observation = isRecord(update) ? update.upstream_observation : null;
    if (
      policy.format === 2 &&
      policy.authority === "descriptive-listing-observation-only" &&
      policy.repository_id === progress.repository_id &&
      policy.facts_sha256 === progress.last_complete_facts_sha256 &&
      typeof policy.port_id === "string" &&
      isRecord(observation) &&
      observation.provider === "gitlab" &&
      observation.repository === source.repository &&
      typeof observation.attempted_at === "string" &&
      progress.completed_at !== null &&
      Date.parse(observation.attempted_at) <= Date.parse(progress.completed_at)
    ) {
      if (clocks.has(policy.port_id)) return null;
      clocks.set(policy.port_id, observation.attempted_at);
    }
  }
  return source.ports.every(({ id }) => clocks.has(id)) ? clocks : null;
}

interface SelectionProgress {
  binding: string;
  facts_sha256: string;
  cursor: number;
  release_ids: number[];
  sha256: string;
  checksum_sources?: ChecksumSource[];
  checksum_sources_sha256?: string;
}
interface PolicyProgress {
  binding: string;
  facts_sha256: string;
  policies: Record<string, unknown>[];
  sha256: string;
}
export interface SourceProgress {
  provider?: "github" | "gitlab" | "direct-manifest";
  provider_progress?: ProviderProgress;
  provider_previous_progress?: ProviderProgress;
  repository: string;
  repository_id: number | null;
  attempted_sequence: number;
  completed_at: string | null;
  freshness_observed_at: string | null;
  last_change_at: string | null;
  change_intervals: number;
  mean_change_interval_ms: number | null;
  next_due_at: string | null;
  result_sha256: string | null;
  completed_scope_sha256: string | null;
  last_complete_facts_sha256: string | null;
  last_complete_policies: Record<string, unknown>[];
  retry_at: string | null;
  exception_key: string | null;
  /** Rule behind `exception_key`; absent in checkpoints written before #4779. */
  exception_rule?: string | null;
  /** Stated partial, unavailable or failed coverage of the last attempt;
   * omitted when the last attempt completed or none stated it (#8569). */
  coverage?: StatedSourceCoverage;
  /** Consecutive attempts that ended in a provider quota deferral, capped at
   * `quotaDeferralNotifyAfter + 1`; omitted when zero (#8569). */
  quota_deferrals?: number;
  selection_progress: SelectionProgress | null;
  policy_progress: PolicyProgress | null;
  current_config: ObserverConfig | null;
  last_complete_config: ObserverConfig | null;
  retired_configs: ObserverConfig[];
}
/**
 * Budget, cancellation and quota stops are partial progress, not failures: a
 * large managed source keeps its priority while it advances across turns, and
 * such a stop never notifies.
 */
export const partialProgressRules: readonly string[] = ["budget", "cancelled", "provider-quota"];
/**
 * A provider quota deferral stays quiet only while it is transient. The attempt
 * after this many consecutive quota deferrals of one source notifies once
 * through the ordinary exception path; the counter then stops at its cap.
 */
export const quotaDeferralNotifyAfter = 3;
export const catalogCheckpointByteLimit = 32 * 1024 * 1024;
export interface CatalogObserverCheckpoint {
  format: 1;
  authority: "catalog-upstream-observation-only";
  sequence: number;
  provider_retry_at: string | null;
  provider_capacities?: Record<string, ProviderCapacity>;
  mod_provider_registry?: ModProviderRegistryProgress;
  launcher_mod_sources?: Record<string, FirstPartyModProgress>;
  /** Historical provenance only; never a successful observation/freshness clock. */
  baseline?: {
    id: string;
    continuity: "lost";
    initial_freshness: "unknown";
    initialized_at: string;
    producer: { run: number; attempt: number; source: string };
    inputs: { config_sha256: string; catalog_sha256: string; listings_sha256: string };
  };
  sources: Record<string, SourceProgress>;
}
export const newCatalogObserverCheckpoint = (): CatalogObserverCheckpoint => ({
  format: 1,
  authority: "catalog-upstream-observation-only",
  sequence: 0,
  provider_retry_at: null,
  sources: {},
});

/** Reviewed catalog declarations are the only source of observation work. */
export function catalogObservationSources(input: unknown) {
  if (
    !isRecord(input) ||
    !Array.isArray(input.ports) ||
    Buffer.byteLength(JSON.stringify(input)) > 12 * 1024 * 1024
  )
    throw new Error("A bounded reviewed catalog is required");
  const seen = new Set<string>();
  const sources = new Map<string, ObservableSource>();
  const held: { port_id: string; reason: string; resume_condition: string }[] = [];
  for (const port of input.ports) {
    if (
      !isRecord(port) ||
      typeof port.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(port.id) ||
      seen.has(port.id) ||
      !isRecord(port.release)
    )
      throw new Error("Catalog observation requires unique stable port identities");
    seen.add(port.id);
    const provider = port.release.provider ?? "github";
    if (typeof provider !== "string") throw new Error("Invalid reviewed release provider");
    if (!["github", "gitlab", "direct-manifest"].includes(provider)) {
      held.push({
        port_id: port.id,
        reason: `provider-${String(provider)}-not-observable-by-core`,
        resume_condition:
          "A reviewed equivalent provider observation and Core policy capability must be delivered; no artifact eligibility is inferred.",
      });
      continue;
    }
    const repository = provider === "direct-manifest" ? port.id : port.release.repository;
    if (
      typeof repository !== "string" ||
      (provider !== "direct-manifest" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) ||
      !Array.isArray(port.channels) ||
      !port.channels.every((channel: unknown) =>
        ["stable", "beta", "rolling"].includes(String(channel)),
      )
    )
      throw new Error("Invalid reviewed GitHub observation declaration");
    const key = observationHash({ provider, repository });
    const source = sources.get(key) ?? {
      key,
      provider: provider as "github" | "gitlab" | "direct-manifest",
      repository,
      ports: [],
      scope_sha256: "",
    };
    const originalSourceFamily =
      provider === "github" && typeof port.source_profile === "string"
        ? port.adapter === "libultraship-portable"
          ? "libultraship"
          : port.adapter === "n64-recomp-portable"
            ? "n64-recomp"
            : undefined
        : undefined;
    const authoringScope =
      originalSourceFamily === "n64-recomp"
        ? n64AuthoringScope(port, input.source_catalog)
        : undefined;
    source.ports.push({
      ...(originalSourceFamily ? { original_source_family: originalSourceFamily } : {}),
      ...(authoringScope ? { n64_authoring_scope_sha256: authoringScope } : {}),
      id: port.id,
      definition_sha256: observationHash(port),
      channels: port.channels.map((channel: unknown) => String(channel)),
      release: structuredClone(port.release) as ObservablePort["release"],
    });
    sources.set(key, source);
  }
  if (input.listings !== undefined && !Array.isArray(input.listings))
    throw new Error("Invalid listing observation directory");
  const listingIds = new Set<string>();
  for (const listing of (input.listings ?? []) as unknown[]) {
    if (
      !isRecord(listing) ||
      typeof listing.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(listing.id) ||
      listingIds.has(listing.id)
    )
      throw new Error("Listing observation requires unique stable identities");
    listingIds.add(listing.id);
    const identity = listingProviderIdentity(listing);
    if (!identity) {
      held.push({
        port_id: listing.id,
        reason: "listing-provider-observation-unsupported",
        resume_condition:
          "Provide a reviewed supported GitHub/GitLab repository identity; no release absence or acquisition authority is inferred.",
      });
      seen.add(listing.id);
      continue;
    }
    const { provider, repository } = identity;
    const key = observationHash({ provider, repository });
    const source: ObservableSource = sources.get(key) ?? {
      key,
      provider,
      repository,
      ports: [],
      scope_sha256: "",
    };
    const managed = source.ports.find((port) => port.id === listing.id);
    if (managed) managed.listing = structuredClone(listing);
    else
      source.ports.push({
        id: listing.id,
        kind: "listing",
        listing: structuredClone(listing),
        channels: [],
        definition_sha256: listingDeclarationHash(listing),
        release: { repository },
      });
    sources.set(key, source);
    seen.add(listing.id);
  }
  return {
    port_ids: [...seen],
    sources: [...sources.values()].map((source) => ({
      ...source,
      ports: source.ports.toSorted((a, b) => a.id.localeCompare(b.id)),
      scope_sha256: observationHash(
        source.ports
          .map((port) => ({
            id: port.id,
            definition_sha256: port.definition_sha256,
            ...(port.n64_authoring_scope_sha256
              ? { n64_authoring_scope_sha256: port.n64_authoring_scope_sha256 }
              : {}),
            ...(port.listing
              ? {
                  kind: port.kind ?? "managed-with-listing",
                  listing_sha256: listingDeclarationHash(port.listing),
                  projection_policy: listingProjectionHash,
                }
              : {}),
          }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      ),
    })),
    held,
  };
}

export function validateCatalogObserverCheckpoint(
  value: unknown,
  now: number,
): CatalogObserverCheckpoint {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.authority !== "catalog-upstream-observation-only" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    (value.provider_retry_at !== null &&
      (typeof value.provider_retry_at !== "string" ||
        !Number.isFinite(Date.parse(value.provider_retry_at)))) ||
    !isRecord(value.sources) ||
    Buffer.byteLength(JSON.stringify(value)) > catalogCheckpointByteLimit
  )
    throw new Error("Invalid catalog observer checkpoint");
  if (value.mod_provider_registry !== undefined)
    validateModProviderRegistryProgress(value.mod_provider_registry, now);
  if (value.launcher_mod_sources !== undefined)
    validateFirstPartyModProgress(value.launcher_mod_sources, now);
  if (value.baseline !== undefined) {
    const baseline = value.baseline;
    if (
      !isRecord(baseline) ||
      Object.keys(baseline).sort().join(",") !==
        "continuity,id,initial_freshness,initialized_at,inputs,producer" ||
      typeof baseline.id !== "string" ||
      !/^[a-z0-9-]{1,128}$/u.test(baseline.id) ||
      baseline.continuity !== "lost" ||
      baseline.initial_freshness !== "unknown" ||
      typeof baseline.initialized_at !== "string" ||
      !Number.isFinite(Date.parse(baseline.initialized_at)) ||
      Date.parse(baseline.initialized_at) > now ||
      !isRecord(baseline.producer) ||
      Object.keys(baseline.producer).sort().join(",") !== "attempt,run,source" ||
      ![baseline.producer.run, baseline.producer.attempt].every(
        (n) => Number.isSafeInteger(n) && Number(n) > 0,
      ) ||
      typeof baseline.producer.source !== "string" ||
      !/^[a-f0-9]{40}$/u.test(baseline.producer.source) ||
      !isRecord(baseline.inputs) ||
      Object.keys(baseline.inputs).sort().join(",") !==
        "catalog_sha256,config_sha256,listings_sha256" ||
      !Object.values(baseline.inputs).every(
        (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
      )
    )
      throw new Error("Invalid observer baseline provenance");
  }
  if (value.provider_capacities !== undefined) {
    if (!isRecord(value.provider_capacities)) throw new Error("Invalid provider capacity evidence");
    for (const [origin, rate] of Object.entries(value.provider_capacities)) {
      if (
        new URL(origin).origin !== origin ||
        !origin.startsWith("https://") ||
        !isRecord(rate) ||
        [rate.remaining, rate.limit].some(
          (n) => n !== null && (!Number.isSafeInteger(n) || Number(n) < 0),
        ) ||
        [rate.reset_at, rate.retry_at].some(
          (clock) =>
            clock !== null && (typeof clock !== "string" || !Number.isFinite(Date.parse(clock))),
        )
      )
        throw new Error("Invalid provider quota evidence");
    }
  }
  for (const [key, progress] of Object.entries(value.sources)) {
    if (
      !isRecord(progress) ||
      typeof progress.repository !== "string" ||
      key !==
        observationHash({
          provider: progress.provider ?? "github",
          repository: progress.repository,
        }) ||
      (progress.repository_id !== null &&
        (!Number.isSafeInteger(progress.repository_id) || Number(progress.repository_id) <= 0)) ||
      !Number.isSafeInteger(progress.attempted_sequence) ||
      Number(progress.attempted_sequence) < 0 ||
      Number(progress.attempted_sequence) > Number(value.sequence) ||
      [
        progress.completed_at,
        progress.freshness_observed_at,
        progress.last_change_at,
        progress.next_due_at,
        progress.retry_at,
      ].some(
        (clock) =>
          clock !== null && (typeof clock !== "string" || !Number.isFinite(Date.parse(clock))),
      ) ||
      [
        progress.completed_scope_sha256,
        progress.last_complete_facts_sha256,
        progress.exception_key,
      ].some(
        (value) => value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)),
      ) ||
      (progress.exception_rule !== undefined &&
        progress.exception_rule !== null &&
        (typeof progress.exception_rule !== "string" ||
          !/^[a-z-]{1,80}$/u.test(progress.exception_rule))) ||
      (progress.coverage !== undefined && !validStatedSourceCoverage(progress.coverage)) ||
      (progress.quota_deferrals !== undefined &&
        (!Number.isSafeInteger(progress.quota_deferrals) ||
          Number(progress.quota_deferrals) < 1 ||
          Number(progress.quota_deferrals) > quotaDeferralNotifyAfter + 1)) ||
      !Number.isSafeInteger(progress.change_intervals) ||
      Number(progress.change_intervals) < 0 ||
      (progress.mean_change_interval_ms !== null &&
        (typeof progress.mean_change_interval_ms !== "number" ||
          !Number.isFinite(progress.mean_change_interval_ms) ||
          progress.mean_change_interval_ms <= 0)) ||
      [progress.completed_at, progress.freshness_observed_at, progress.last_change_at].some(
        (clock) => typeof clock === "string" && Date.parse(clock) > now,
      ) ||
      !Array.isArray(progress.last_complete_policies) ||
      progress.last_complete_policies.some(
        (policy: unknown) =>
          !isRecord(policy) ||
          ((progress.provider ?? "github") === "github" &&
            policy.repository_id !== progress.repository_id) ||
          policy.facts_sha256 !== progress.last_complete_facts_sha256 ||
          typeof policy.port_id !== "string",
      ) ||
      (progress.result_sha256 !== null &&
        (typeof progress.result_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(progress.result_sha256)))
    )
      throw new Error("Invalid catalog source identity or progress");
  }
  for (const raw of Object.values(value.sources)) {
    if (!isRecord(raw)) throw new Error("Invalid source progress");
    if (
      raw.provider !== undefined &&
      (typeof raw.provider !== "string" ||
        !["github", "gitlab", "direct-manifest"].includes(raw.provider))
    )
      throw new Error("Invalid provider discriminator");
    if (raw.provider_progress !== undefined) validateProviderProgress(raw.provider_progress);
    if (raw.provider_previous_progress !== undefined)
      validateProviderProgress(raw.provider_previous_progress);
    if (!Array.isArray(raw.retired_configs))
      throw new Error("Invalid retired observer configurations");
    const retiredConfigurations: unknown[] = raw.retired_configs;
    const configurations: unknown[] = [
      ...retiredConfigurations,
      ...(raw.current_config === null ? [] : [raw.current_config]),
      ...(raw.last_complete_config === null ? [] : [raw.last_complete_config]),
    ];
    for (const configuration of configurations) {
      const config = validateObserverConfig(configuration);
      if (config.repository !== raw.repository || config.repository_id !== raw.repository_id)
        throw new Error("Retained observer configuration escaped its source identity");
    }
    for (const key of ["selection_progress", "policy_progress"] as const) {
      const progress = raw[key];
      if (progress === null) continue;
      if (
        !isRecord(progress) ||
        ![progress.binding, progress.facts_sha256, progress.sha256].every(
          (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
        )
      )
        throw new Error("Invalid Core continuation binding");
      if (key === "selection_progress") {
        if (
          progress.checksum_sources !== undefined &&
          (!Array.isArray(progress.checksum_sources) ||
            progress.checksum_sources_sha256 !== observationHash(progress.checksum_sources) ||
            observationHash(
              checksumSourcesFromProjections([{ checksum_sources: progress.checksum_sources }]),
            ) !== progress.checksum_sources_sha256)
        )
          throw new Error("Invalid Core checksum continuation");
        if (
          !Number.isSafeInteger(progress.cursor) ||
          Number(progress.cursor) < 0 ||
          !Array.isArray(progress.release_ids) ||
          progress.release_ids.some(
            (id: unknown) => !Number.isSafeInteger(id) || Number(id) <= 0,
          ) ||
          new Set(progress.release_ids).size !== progress.release_ids.length ||
          progress.sha256 !== observationHash(progress.release_ids)
        )
          throw new Error("Invalid Core selection continuation");
      } else if (
        !Array.isArray(progress.policies) ||
        progress.policies.some((policy: unknown) => !isRecord(policy)) ||
        progress.sha256 !== observationHash(progress.policies)
      )
        throw new Error("Invalid Core policy continuation");
    }
  }
  return structuredClone(value) as unknown as CatalogObserverCheckpoint;
}

type SourceResult = Awaited<ReturnType<typeof advanceObservation>>;
export interface CatalogObservationOptions extends Pick<
  ObserveOptions,
  "fetch" | "signal" | "sleep" | "token" | "githubScope"
> {
  now?: () => number;
  deadline?: number;
  excludedSources?: ReadonlySet<string>;
  /** Hard cap on provider requests this operation may admit (#4779). */
  requestLimit?: number;
  /** Give stale recovery regular turns after appointments and expiring managed work. */
  rotateStaleSources?: boolean;
  prioritizeConfigured?: boolean;
  scheduledPrioritySources?: ReadonlySet<string>;
  providerFetch?: typeof fetch;
  modProviderRegistryFetch?: typeof fetch;
  observeLauncherMods?: (
    repository: { id: number; slug: string },
    account: Required<
      Pick<ObserveOptions, "admitRequest" | "observeResponse" | "consumeResponseBytes">
    >,
  ) => Promise<LauncherModObservation>;
  launcherModRequestLimit?: number;
  projectProvider?: (portId: string, observation: Record<string, unknown>) => Promise<unknown>;
  exportProvider?: (
    source: ObservableSource,
    observations: Record<string, unknown>[],
    policies: unknown[],
    report?: { exception: { rule: string; coverage?: StatedSourceCoverage } },
  ) => Promise<void>;
  config: ObserverConfig;
  policyIdentity: string;
  definitionHash: (portId: string) => string;
  withSourceLock: <T>(config: ObserverConfig, operation: () => Promise<T>) => Promise<T>;
  load: (config: ObserverConfig) => Promise<unknown>;
  save: (config: ObserverConfig, checkpoint: unknown) => Promise<void>;
  commit: (checkpoint: CatalogObserverCheckpoint) => Promise<void>;
  observeN64Runtime?: boolean;
  readN64BuildStepLog?: (
    repository: string,
    job: number,
    step: number,
    account: Required<
      Pick<ObserveOptions, "admitRequest" | "observeResponse" | "consumeResponseBytes">
    >,
  ) => Promise<Uint8Array>;
  readOriginalRecognition?: (
    repository: string,
    endpoint: string,
    account: Required<
      Pick<ObserveOptions, "admitRequest" | "observeResponse" | "consumeResponseBytes">
    >,
  ) => Promise<unknown>;
  repositoryId: (
    source: ObservableSource,
    transport: Required<
      Pick<ObserveOptions, "admitRequest" | "observeResponse" | "consumeResponseBytes">
    >,
  ) => Promise<number>;
  project: (
    portId: string,
    repositoryId: number,
    observation: ProviderObservation,
  ) => Promise<unknown>;
  export: (
    source: ObservableSource,
    config: ObserverConfig,
    result: SourceResult,
    policies: unknown[],
  ) => Promise<void>;
}

type ObservationTurn = {
  key: string;
  appointment: boolean;
  /** A healthy source serving a managed port. */
  managed: boolean;
  freshnessObservedAt: string | null;
  attemptedSequence: number;
};

/** Order already-due and retry-admitted sources before the existing request fences. */
export function orderHostedObservationTurns<T extends ObservationTurn>(
  turns: T[],
  freshness?: { now: number; deadline: number; freshnessMs: number },
): T[] {
  const byRole = turns.toSorted(
    (a, b) =>
      Number(b.appointment) - Number(a.appointment) ||
      Number(b.managed) - Number(a.managed) ||
      a.attemptedSequence - b.attemptedSequence ||
      a.key.localeCompare(b.key),
  );
  if (!freshness) return byRole;

  const expiry = (turn: ObservationTurn) =>
    turn.freshnessObservedAt === null
      ? -Infinity
      : Date.parse(turn.freshnessObservedAt) + freshness.freshnessMs;
  const protectedTurns: T[] = [];
  const ordinaryManaged: T[] = [];
  const recovery: T[] = [];
  const remaining: T[] = [];
  for (const turn of byRole) {
    if (turn.appointment || (turn.managed && expiry(turn) <= freshness.deadline)) {
      protectedTurns.push(turn);
    } else if (turn.managed) {
      ordinaryManaged.push(turn);
    } else if (expiry(turn) <= freshness.now) {
      recovery.push(turn);
    } else {
      remaining.push(turn);
    }
  }

  // Preserve the first recovery turn, then keep one in every four ordinary
  // turns while both groups have work. Every turn uses the existing shared
  // quantum. Oldest attempt within recovery keeps failed sources rotating.
  const ordered = protectedTurns;
  let recovered = 0;
  for (let index = 0; index < ordinaryManaged.length; index++) {
    if (index % 3 === 0 && recovered < recovery.length) ordered.push(recovery[recovered++]!);
    ordered.push(ordinaryManaged[index]!);
  }
  return ordered.concat(recovery.slice(recovered), remaining);
}

/** Finite shared runtime/quota, fair durable source turns, existing per-source continuation. */
export async function advanceCatalogObservations(
  catalog: unknown,
  prior: unknown,
  options: CatalogObservationOptions,
) {
  const { sources, held, port_ids: catalogIds } = catalogObservationSources(catalog);
  const now = options.now ?? Date.now;
  const state =
    prior === null
      ? newCatalogObserverCheckpoint()
      : validateCatalogObserverCheckpoint(prior, now());
  const commitCheckpoint = () => {
    if (
      (state.mod_provider_registry || state.launcher_mod_sources) &&
      Buffer.byteLength(JSON.stringify(state)) > catalogCheckpointByteLimit
    )
      throw new ObservationFailure(
        "checkpoint-size",
        "Catalog progress and retained mod observations exceed the checkpoint envelope. The last complete checkpoint remains.",
      );
    return options.commit(structuredClone(state));
  };
  if (state.provider_retry_at && Date.parse(state.provider_retry_at) <= now())
    state.provider_retry_at = null;
  // A retained provider clock beyond the retry horizon was written before the
  // horizon existed; it is discarded rather than deferring the source.
  state.provider_retry_at = boundedRetainedRetryClock(now(), state.provider_retry_at);
  for (const rate of Object.values(state.provider_capacities ?? {})) {
    rate.retry_at = boundedRetainedRetryClock(now(), rate.retry_at);
    rate.reset_at = boundedRetainedRetryClock(now(), rate.reset_at);
  }
  for (const progress of Object.values(state.sources)) {
    progress.retry_at = boundedRetainedRetryClock(now(), progress.retry_at);
    if (
      progress.coverage?.retry_at &&
      boundedRetainedRetryClock(now(), progress.coverage.retry_at) === null
    )
      delete progress.coverage.retry_at;
  }
  const template = validateObserverConfig(options.config);
  const requestCeiling = options.requestLimit ?? Infinity;
  const policyIdentity = options.policyIdentity;
  if (!/^[a-f0-9]{64}$/u.test(policyIdentity))
    throw new Error("Exact Core policy input identity is required");
  const definitionFor = (port: ObservablePort) =>
    port.kind === "listing" ? port.definition_sha256 : options.definitionHash(port.id);
  if (
    sources
      .flatMap((source) => source.ports)
      .some((port) => !/^[a-f0-9]{64}$/u.test(definitionFor(port)))
  )
    throw new Error(
      "Normalized current Core definition or descriptive declaration identities are required",
    );
  const deadline = Math.min(now() + template.budget.duration_ms, options.deadline ?? Infinity);
  const githubScope: ObserverGitHubScope = options.githubScope ?? {
    deadline: performance.now() + Math.max(0, deadline - now()),
    failedReads: new Map(),
    deferral: { primary: new Map(), secondary: 0 },
  };
  if (!Number.isFinite(deadline) || deadline <= now())
    throw new ObservationFailure("budget", "Collector deadline unavailable");
  const scopePolicy = {
    policyIdentity,
    definitionHash: options.definitionHash,
    staleAfterHours: template.stale_after_hours,
  };
  const scopeBinding = (source: ObservableSource) =>
    catalogObservationScopeBinding(source, scopePolicy);
  let requests = 0;
  let responseBytes = 0;
  let operationBytes = 0;
  let unknownSizeResponses = 0;
  let notifyException = false;
  // Only exceptions that can affect what players install, or the configured and
  // scheduled acceptance scopes that feed definition delivery, fail the job. A
  // listing-only source's exception stays in the report and its checkpoint.
  const notifiesOnException = (source: ObservableSource) =>
    source.ports.some((port) => port.kind !== "listing") ||
    options.scheduledPrioritySources?.has(source.key) === true ||
    (source.repository === template.repository &&
      source.ports.some((port) => port.id === template.port_id));
  // A non-notifying exception uses its own key namespace, so a listing that later
  // gains a managed port still reports the same unresolved rule once.
  const exceptionKey = (source: ObservableSource, rule: string) =>
    notifiesOnException(source)
      ? observationHash({ source: source.key, rule })
      : observationHash({ source: source.key, rule, notification: "report-only" });
  let requestStartedAt = now();
  let sampledCostMs = 0;
  let sampledRequests = 0;
  let remaining: number | null = null;
  let resetAt: number | null = null;
  let providerLimit: number | null = null;
  const extendProviderDeferral = (retryAt: string | null) => {
    if (
      retryAt !== null &&
      (state.provider_retry_at === null ||
        Date.parse(retryAt) > Date.parse(state.provider_retry_at))
    )
      state.provider_retry_at = retryAt;
    return state.provider_retry_at;
  };
  const consumeResponseBytes = (bytes: number | null) => {
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
      throw new ObservationFailure("invalid-metadata", "Provider response size is invalid");
    if (bytes === null) unknownSizeResponses++;
    const charged = bytes ?? template.budget.response_bytes;
    responseBytes += charged;
    operationBytes += charged;
    if (operationBytes > template.budget.total_bytes)
      throw new ObservationFailure(
        "budget",
        "Source operation response byte envelope exhausted; retain accepted pages",
      );
  };
  const observeResponse = (response: Response) => {
    sampledCostMs += Math.max(1, now() - requestStartedAt);
    sampledRequests++;
    const integer = (name: string) => {
      const raw = response.headers.get(name);
      return raw !== null && /^\d+$/u.test(raw) && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : null;
    };
    const available = integer("x-ratelimit-remaining");
    const limit = integer("x-ratelimit-limit");
    const reset = integer("x-ratelimit-reset");
    if (available !== null && limit !== null && available <= limit) {
      remaining = available;
      providerLimit = limit;
      resetAt = boundedProviderRetryTime(now(), reset === null ? null : reset * 1000);
    }
  };
  const attempted: string[] = [];
  const completed: string[] = [];
  const failures: {
    source: string;
    repository: string;
    rule: string;
    details: string;
    coverage?: StatedSourceCoverage;
  }[] = [];
  const isConfigured = (source: (typeof sources)[number]) =>
    source.repository === template.repository &&
    source.ports.some((port) => port.id === template.port_id);
  const isScheduledPriority = (source: ObservableSource) =>
    options.scheduledPrioritySources?.has(source.key) === true;
  const freshnessExpired = (progress: SourceProgress) =>
    progress.freshness_observed_at === null ||
    now() - Date.parse(progress.freshness_observed_at) >= template.stale_after_hours * 3600000;
  const scopeDue = (source: ObservableSource, progress: SourceProgress | undefined) =>
    !progress ||
    progress.completed_scope_sha256 !== scopeBinding(source) ||
    !progress.completed_at ||
    !progress.next_due_at ||
    Date.parse(progress.next_due_at) <= now() ||
    (isScheduledPriority(source) && freshnessExpired(progress));
  const earlyTurn = (source: ObservableSource) =>
    options.prioritizeConfigured === true &&
    (isScheduledPriority(source) ||
      (isConfigured(source) && state.sources[source.key]?.attempted_sequence !== state.sequence));
  const healthy = (progress: SourceProgress | undefined) =>
    !progress?.exception_key ||
    progress.exception_rule === undefined ||
    (progress.exception_rule !== null && partialProgressRules.includes(progress.exception_rule));
  const servesManagedPort = (source: ObservableSource) =>
    healthy(state.sources[source.key]) && source.ports.some((port) => port.kind !== "listing");
  const n64RuntimeCache = n64RuntimeSourceCache();
  const pending = orderHostedObservationTurns(
    sources
      .filter((source) => {
        if (options.excludedSources?.has(source.key)) return false;
        const progress = state.sources[source.key];
        return (
          (scopeDue(source, progress) || source.repository === template.repository) &&
          (!progress?.retry_at || Date.parse(progress.retry_at) <= now())
        );
      })
      .map((source) => ({
        source,
        key: source.key,
        appointment: earlyTurn(source),
        managed: servesManagedPort(source),
        freshnessObservedAt: state.sources[source.key]?.freshness_observed_at ?? null,
        attemptedSequence: state.sources[source.key]?.attempted_sequence ?? -1,
      })),
    options.rotateStaleSources === true
      ? { now: now(), deadline, freshnessMs: template.stale_after_hours * 3600000 }
      : undefined,
  ).map(({ source }) => source);
  const earlyTurns = new Set(pending.filter(earlyTurn).map((source) => source.key));
  const earlyTurnCount = earlyTurns.size;
  const capacity = () =>
    state.provider_retry_at && Date.parse(state.provider_retry_at) > now()
      ? 0
      : Math.max(
          0,
          Math.min(
            remaining === null
              ? template.budget.requests - requests
              : remaining - Math.max(1, Math.ceil((providerLimit ?? remaining) * 0.05)),
            requestCeiling - requests,
            Math.floor(
              (deadline - now()) /
                (sampledRequests
                  ? sampledCostMs / sampledRequests
                  : template.budget.duration_ms / template.budget.requests),
            ),
          ),
        );
  const admitRequest = () => {
    if (options.signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled before provider admission");
    const providerDepleted =
      remaining !== null &&
      remaining <= Math.max(1, Math.ceil((providerLimit ?? remaining) * 0.05));
    const retryAt = providerDepleted
      ? extendProviderDeferral(resetAt === null ? null : new Date(resetAt).toISOString())
      : null;
    if (now() >= deadline || capacity() < 1)
      throw new ObservationFailure(
        "budget",
        "Shared provider reserve or runtime exhausted",
        retryAt,
      );
    requestStartedAt = now();
    requests++;
    if (remaining !== null) remaining--;
  };

  let launcherModSummary:
    | {
        enrolled: number;
        due: number;
        attempted: number;
        complete: number;
        deferred: number;
        requests: number;
      }
    | undefined;
  const observeLauncherMods = options.observeLauncherMods;
  if (observeLauncherMods) {
    const gameScopes = launcherModGameScopes(
      catalog,
      isRecord(catalog) && Array.isArray(catalog.listings) ? catalog.listings : [],
    );
    const subjects = launcherModSubjects(sources, state.sources, undefined, gameScopes);
    const old = state.launcher_mod_sources ?? {};
    const progress = Object.fromEntries(
      subjects.flatMap(({ port_id, binding }) =>
        old[port_id]?.binding === binding ? [[port_id, old[port_id]]] : [],
      ),
    ) as Record<string, FirstPartyModProgress>;
    const due = subjects
      .filter(
        ({ port_id }) =>
          Date.parse(progress[port_id]?.next_due_at ?? "") <= now() || !progress[port_id],
      )
      .sort(
        (a, b) =>
          (progress[a.port_id]?.last_attempt_at ?? a.listed_at).localeCompare(
            progress[b.port_id]?.last_attempt_at ?? b.listed_at,
          ) || a.port_id.localeCompare(b.port_id),
      );
    launcherModSummary = {
      enrolled: subjects.length,
      due: due.length,
      attempted: 0,
      complete: 0,
      deferred: due.length,
      requests: 0,
    };
    // Reserve a bounded share of the existing opportunity for descriptive
    // coverage. A complete proof needs at most four admitted GitHub reads.
    const requestsBeforeLauncher = requests;
    const launcherAttempts = Math.min(
      24,
      Math.floor((options.launcherModRequestLimit ?? Math.floor(capacity() / 20)) / 4),
      Math.floor(capacity() / 4),
    );
    let lastReviewed = "",
      lastUnresolved = "";
    for (const [port, row] of Object.entries(progress)) {
      if (gameScopes.has(port)) {
        if (row.last_attempt_at > lastReviewed) lastReviewed = row.last_attempt_at;
      } else if (row.last_attempt_at > lastUnresolved) lastUnresolved = row.last_attempt_at;
    }
    const reviewed = due.filter(({ port_id }) => gameScopes.has(port_id));
    const unresolved = due.filter(({ port_id }) => !gameScopes.has(port_id));
    for (const subject of selectLauncherModAssessmentWork(
      reviewed,
      unresolved,
      progress,
      launcherAttempts,
      lastReviewed,
      lastUnresolved,
    )) {
      if (options.signal?.aborted || capacity() < 4) break;
      let result: LauncherModObservation;
      try {
        result = await observeLauncherMods(
          { id: subject.repository_id, slug: subject.slug },
          { admitRequest, observeResponse, consumeResponseBytes },
        );
      } catch (cause) {
        if (!(cause instanceof ObservationFailure)) throw cause;
        if (cause.retryAt) extendProviderDeferral(cause.retryAt);
        if (partialProgressRules.includes(cause.rule)) break;
        result = { state: "unavailable", reason: cause.rule };
      }
      launcherModSummary.attempted++;
      launcherModSummary.deferred--;
      if (result.state === "observed" || result.state === "absent") {
        if (result.repository_id !== subject.repository_id)
          throw new Error("First-party mod observation returned a different repository ID");
      }
      const scope = gameScopes.get(subject.port_id);
      result =
        !scope && result.state === "observed"
          ? { state: "held", reason: "game-input-scope-unproven" }
          : verifyLauncherModGameScope(result, scope);
      if (result.state === "observed" || result.state === "absent") launcherModSummary.complete++;
      progress[subject.port_id] = recordLauncherModAttempt(
        subject.binding,
        progress[subject.port_id],
        result,
        now(),
        (!scope && result.state !== "unavailable" ? 7 * 24 : template.cadence_hours) * 3600000,
      );
    }
    launcherModSummary.requests = requests - requestsBeforeLauncher;
    if (observationHash(old) !== observationHash(progress) && !options.signal?.aborted) {
      validateFirstPartyModProgress(progress, now());
      if (
        Buffer.byteLength(JSON.stringify({ ...state, launcher_mod_sources: progress })) <=
        catalogCheckpointByteLimit
      ) {
        state.launcher_mod_sources = progress;
        await commitCheckpoint();
      } else {
        failures.push({
          source: "launcher-mod-sources",
          repository: "github.com",
          rule: "checkpoint-size",
          details:
            "First-party mod progress does not fit the catalog checkpoint; prior evidence remains.",
        });
        launcherModSummary.deferred = due.length;
        launcherModSummary.complete = 0;
      }
    }
  }
  let registryProgress: ModProviderRegistryProgress | undefined;
  const registryFits = (progress: ModProviderRegistryProgress) =>
    Buffer.byteLength(JSON.stringify({ ...state, mod_provider_registry: progress })) <=
    catalogCheckpointByteLimit;
  // A due registry read uses the same opportunity and request accounting.
  // Thunderstore's independent reserve does not decrement GitHub's quota.
  if (
    options.modProviderRegistryFetch &&
    !options.signal?.aborted &&
    deadline - now() >= 1000 &&
    Math.min(template.budget.requests, requestCeiling) > 1 &&
    (!state.mod_provider_registry || Date.parse(state.mod_provider_registry.next_due_at) <= now())
  ) {
    const retainedRegistry = state.mod_provider_registry;
    const retainedConflicts = retainedRegistry?.identity_conflicts;
    const conflictReserve =
      retainedConflicts &&
      Buffer.byteLength(JSON.stringify(retainedConflicts)) >
        Buffer.byteLength(JSON.stringify("unknown"))
        ? retainedConflicts
        : "unknown";
    // Reserve space for Retry-After before spending the request. The longest
    // ISO representation covers even a provider delay in an extended year.
    if (
      registryFits({
        last_complete: retainedRegistry?.last_complete ?? null,
        ...(retainedRegistry?.last_complete ? { identity_conflicts: conflictReserve } : {}),
        next_due_at: "+275760-09-13T00:00:00.000Z",
        exception: retainedRegistry?.last_complete ? "identity-changed" : "rate-limit",
      })
    ) {
      const result = await observeModProviderRegistry(state.mod_provider_registry, {
        now,
        cadenceMs: template.cadence_hours * 3600000,
        staleAfterMs: template.stale_after_hours * 3600000,
        timeout: Math.min(10000, deadline - now()),
        responseBytes: template.budget.response_bytes,
        fetch: options.modProviderRegistryFetch,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      requests++;
      responseBytes += result.bytes;
      if (
        result.progress.exception === "rate-limit" ||
        result.progress.exception === "identity-changed"
      ) {
        // Record known identity invalidation before unrelated release progress
        // can consume the remaining checkpoint. The compact marker was reserved
        // before the request and safely suspends all links if details cannot fit.
        state.mod_provider_registry = registryFits(result.progress)
          ? result.progress
          : { ...result.progress, identity_conflicts: "unknown" };
        await commitCheckpoint();
      } else if (!options.signal?.aborted) registryProgress = result.progress;
    } else {
      failures.push({
        source: "thunderstore-ecosystem",
        repository: "thunderstore.io",
        rule: "checkpoint-size",
        details: "A registry retry deadline would exceed the checkpoint envelope.",
      });
    }
  }
  const projectBound = async (
    port: ObservablePort,
    repositoryId: number,
    observation: ProviderObservation,
  ) => {
    const portId = port.id;
    if (options.signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled before Core projection");
    if (now() >= deadline)
      throw new ObservationFailure(
        "budget",
        "Core projection admission exhausted; retain completed projections",
      );
    const policy =
      port.kind === "listing"
        ? projectListingObservation(port.listing!, observation, template.stale_after_hours)
        : await options.project(portId, repositoryId, observation);
    if (
      !isRecord(policy) ||
      policy.format !== 1 ||
      policy.port_id !== portId ||
      policy.repository_id !== repositoryId ||
      policy.facts_sha256 !== observation.facts_sha256 ||
      !Array.isArray(policy.projections) ||
      policy.catalog_definition_sha256 !== definitionFor(port)
    )
      throw new ObservationFailure(
        "core-binding",
        "Core projection differs from the exact reviewed catalog definition, port, source or provider facts",
      );
    if (options.signal?.aborted)
      throw new ObservationFailure(
        "cancelled",
        "Observation cancelled before retaining Core projection",
      );
    const retained = retainedCoreProjection(policy);
    return port.kind !== "listing" && port.listing
      ? {
          ...retained,
          listing_update: projectListingObservation(
            port.listing,
            observation,
            template.stale_after_hours,
          ).listing_update,
        }
      : retained;
  };
  for (const [index, source] of pending.entries()) {
    if (options.signal?.aborted || now() >= deadline) break;
    // Completed provider reads may still admit offline Core continuation while the provider is unavailable.
    const previousProgress = state.sources[source.key];
    const descriptive = listingOnly(source);
    const retainedListingCompletion =
      descriptive &&
      previousProgress?.completed_scope_sha256 &&
      previousProgress.completed_at &&
      previousProgress.freshness_observed_at &&
      previousProgress.last_complete_facts_sha256 &&
      previousProgress.next_due_at
        ? {
            completed_at: previousProgress.completed_at,
            observed_at: previousProgress.freshness_observed_at,
            facts_sha256: previousProgress.last_complete_facts_sha256,
            next_due_at: new Date(
              Math.min(
                Date.parse(previousProgress.next_due_at),
                Date.parse(previousProgress.freshness_observed_at) +
                  template.stale_after_hours * 3600000 -
                  template.budget.duration_ms,
              ),
            ).toISOString(),
          }
        : null;
    const canReuseListing =
      retainedListingCompletion !== null &&
      Date.parse(retainedListingCompletion.next_due_at) > now();
    const scheduledRefreshDue =
      isScheduledPriority(source) &&
      (!previousProgress?.next_due_at || Date.parse(previousProgress.next_due_at) <= now());
    const reprojectFreshFacts =
      !scheduledRefreshDue &&
      (!descriptive || canReuseListing) &&
      previousProgress !== undefined &&
      previousProgress.completed_scope_sha256 !== scopeBinding(source) &&
      previousProgress.last_complete_facts_sha256 !== null;
    const freshOfflineCandidate =
      reprojectFreshFacts &&
      previousProgress.freshness_observed_at !== null &&
      now() - Date.parse(previousProgress.freshness_observed_at) <
        template.stale_after_hours * 3600000;
    if (
      (source.provider ?? "github") === "github" &&
      capacity() < 1 &&
      !previousProgress?.policy_progress &&
      !freshOfflineCandidate
    )
      continue;
    operationBytes = 0;
    const progress = state.sources[source.key] ?? {
      provider: source.provider ?? "github",
      repository: source.repository,
      repository_id: null,
      attempted_sequence: 0,
      completed_at: null,
      freshness_observed_at: null,
      last_change_at: null,
      change_intervals: 0,
      mean_change_interval_ms: null,
      next_due_at: null,
      result_sha256: null,
      completed_scope_sha256: null,
      last_complete_facts_sha256: null,
      last_complete_policies: [],
      retry_at: null,
      exception_key: null,
      selection_progress: null,
      policy_progress: null,
      current_config: null,
      last_complete_config: null,
      retired_configs: [],
    };
    if (state.sequence >= Number.MAX_SAFE_INTEGER)
      throw new Error("Source scheduling sequence exhausted");
    progress.attempted_sequence = ++state.sequence;
    state.sources[source.key] = progress;
    await commitCheckpoint();
    attempted.push(source.key);
    const earlyCollection = earlyTurns.delete(source.key);
    if (source.provider === "gitlab" || source.provider === "direct-manifest") {
      const before = `${progress.provider_progress?.reads.length ?? 0}:${progress.provider_progress?.validation_cursor ?? 0}`;
      try {
        const binding = scopeBinding(source);
        const previousComplete =
          progress.completed_scope_sha256 !== null && progress.exception_key === null;
        if (
          progress.provider_progress &&
          (progress.provider_progress.binding !== source.scope_sha256 ||
            progress.provider_progress.format !== 2)
        ) {
          progress.provider_previous_progress = progress.provider_progress;
          delete progress.provider_progress;
          progress.policy_progress = null;
          progress.completed_scope_sha256 = null;
          await commitCheckpoint();
        }

        const listingClocks = canReuseListing ? retainedListingClocks(source, progress) : null;
        const reuseComplete =
          previousComplete &&
          (!descriptive || listingClocks !== null) &&
          progress.freshness_observed_at !== null &&
          now() - Date.parse(progress.freshness_observed_at) <
            template.stale_after_hours * 3600000 &&
          progress.completed_scope_sha256 !== binding;
        if (progress.provider_progress && !reuseComplete && previousComplete) {
          progress.provider_previous_progress = progress.provider_progress;
          delete progress.provider_progress;
          progress.completed_scope_sha256 = null;
          await commitCheckpoint();
        }
        const result = await observeProviderSource(
          { ...source, provider: source.provider },
          progress.provider_progress,
          {
            now,
            deadline,
            maximumRequests: Math.min(
              64,
              template.budget.requests,
              Math.max(0, requestCeiling - requests),
            ),
            maximumBytes: template.budget.total_bytes,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.providerFetch ? { fetch: options.providerFetch } : {}),
            capacities: (state.provider_capacities ??= {}),
            bindIdentity: async (identity) => {
              if (progress.repository_id !== null && progress.repository_id !== identity)
                throw new ObservationFailure(
                  "repository-identity",
                  "GitLab numeric project identity changed; preserve the declared source and historical evidence",
                );
              progress.repository_id = identity;
              await commitCheckpoint();
            },
            reuseComplete,
            sourcePolicyScope: binding,
            priorSourcePolicies: progress.last_complete_policies,
            ...(reuseComplete && retainedListingCompletion && listingClocks
              ? {
                  retainedCompletion: {
                    observed_at: retainedListingCompletion.observed_at,
                    facts_sha256: retainedListingCompletion.facts_sha256,
                    completed_by_port: listingClocks,
                  },
                }
              : {}),
            admit: () => {
              if (requests >= requestCeiling)
                throw new ObservationFailure("budget", "Shared provider request budget exhausted");
              requests++;
            },
            charge: (bytes) => {
              responseBytes += bytes;
            },
            commit: async (checkpoint) => {
              progress.provider_progress = checkpoint;
              await commitCheckpoint();
            },
            project: async (portId, observation) => {
              const port = source.ports.find((consumer) => consumer.id === portId)!;
              if (port.kind !== "listing" && !options.projectProvider)
                throw new ObservationFailure(
                  "core-provider-capability",
                  "Provider Core projection capability is unavailable",
                );
              if (
                progress.policy_progress?.binding !== binding ||
                progress.policy_progress.facts_sha256 !== observation.facts_sha256
              )
                progress.policy_progress = {
                  binding,
                  facts_sha256: String(observation.facts_sha256),
                  policies: [],
                  sha256: observationHash([]),
                };
              const retained = progress.policy_progress.policies.find(
                (policy) => policy.port_id === portId,
              );
              if (
                retained &&
                retained.catalog_definition_sha256 === definitionFor(port) &&
                retained.facts_sha256 === observation.facts_sha256 &&
                retained.format === 2
              )
                return retained;
              const projected =
                port.kind === "listing"
                  ? projectGitLabListingObservation(
                      port.listing!,
                      observation,
                      template.stale_after_hours,
                    )
                  : await options.projectProvider!(portId, observation);
              const policy =
                port.kind !== "listing" && port.listing && source.provider === "gitlab"
                  ? {
                      ...(projected as Record<string, unknown>),
                      listing_update: projectGitLabListingObservation(
                        port.listing,
                        observation,
                        template.stale_after_hours,
                      ).listing_update,
                    }
                  : projected;
              if (
                !isRecord(policy) ||
                policy.format !== 2 ||
                policy.port_id !== portId ||
                policy.facts_sha256 !== observation.facts_sha256 ||
                policy.catalog_definition_sha256 !== definitionFor(port) ||
                !Array.isArray(policy.projections)
              )
                throw new ObservationFailure(
                  "core-binding",
                  "Provider Core projection differs from exact definition and facts",
                );
              if (options.signal?.aborted)
                throw new ObservationFailure(
                  "cancelled",
                  "Provider projection cancelled before persistence",
                );
              progress.policy_progress.policies.push(structuredClone(policy));
              progress.policy_progress.sha256 = observationHash(progress.policy_progress.policies);
              await commitCheckpoint();
              return policy;
            },
          },
        );
        if (!options.exportProvider)
          throw new ObservationFailure(
            "provider-handoff",
            "Existing provider handoff is unavailable",
          );
        await options.exportProvider(source, result.observations, result.policies);
        const factsHash = String(result.observations[0]!.facts_sha256);
        const retainedTiming =
          reuseComplete &&
          retainedListingCompletion !== null &&
          listingClocks !== null &&
          result.requests === 0;
        if (progress.last_complete_facts_sha256 !== factsHash) {
          if (progress.last_change_at) {
            const interval = Math.max(1, now() - Date.parse(progress.last_change_at));
            progress.mean_change_interval_ms =
              progress.mean_change_interval_ms === null
                ? interval
                : (progress.mean_change_interval_ms * progress.change_intervals + interval) /
                  (progress.change_intervals + 1);
            progress.change_intervals++;
          }
          progress.last_change_at = new Date(now()).toISOString();
        }
        progress.completed_at = retainedTiming
          ? retainedListingCompletion.completed_at
          : new Date(now()).toISOString();
        progress.freshness_observed_at = result.observed_at;
        progress.next_due_at = retainedTiming
          ? retainedListingCompletion.next_due_at
          : new Date(
              Math.min(
                now() +
                  Math.max(
                    template.cadence_hours * 3600000,
                    (progress.mean_change_interval_ms ?? 0) / 2,
                  ),
                Date.parse(result.observed_at) +
                  template.stale_after_hours * 3600000 -
                  template.budget.duration_ms,
              ),
            ).toISOString();
        if (
          result.sourceRetryAt !== null &&
          progress.next_due_at !== null &&
          result.sourceRetryAt < Date.parse(progress.next_due_at)
        ) {
          progress.next_due_at = new Date(result.sourceRetryAt).toISOString();
        }
        progress.completed_scope_sha256 = binding;
        progress.last_complete_facts_sha256 = String(result.observations[0]!.facts_sha256);
        progress.last_complete_policies = result.policies.map((p) => p as Record<string, unknown>);
        progress.result_sha256 = observationHash({
          observations: result.observations.map((o) => o.facts_sha256),
          policies: result.policies,
        });
        progress.exception_key = null;
        progress.exception_rule = null;
        progress.retry_at = null;
        delete progress.coverage;
        delete progress.quota_deferrals;
        progress.policy_progress = null;
        completed.push(source.key);
      } catch (error) {
        const rule = error instanceof ObservationFailure ? error.rule : "provider-operation-failed";
        const key = exceptionKey(source, rule);
        // Consecutive quota deferrals are counted so a source the provider keeps
        // declining surfaces once instead of staying quiet indefinitely.
        const deferrals =
          rule === "provider-quota"
            ? Math.min((progress.quota_deferrals ?? 0) + 1, quotaDeferralNotifyAfter + 1)
            : 0;
        const persistentQuota =
          deferrals > quotaDeferralNotifyAfter &&
          (progress.quota_deferrals ?? 0) <= quotaDeferralNotifyAfter;
        if (deferrals > 0) progress.quota_deferrals = deferrals;
        else delete progress.quota_deferrals;
        if (
          ((progress.exception_key !== key && !partialProgressRules.includes(rule)) ||
            persistentQuota) &&
          notifiesOnException(source)
        )
          notifyException = true;
        progress.exception_key = key;
        progress.exception_rule = rule;
        progress.retry_at = error instanceof ObservationFailure ? error.retryAt : null;
        progress.coverage = statedSourceCoverage(
          error,
          providerProgressCursor(progress.provider_progress),
        );
        failures.push({
          source: source.key,
          repository: source.repository,
          rule,
          details:
            (error instanceof Error ? error.message : "Provider operation failed") +
            (deferrals > quotaDeferralNotifyAfter
              ? ` The provider quota has deferred this source for more than ${quotaDeferralNotifyAfter} consecutive attempts.`
              : ""),
          coverage: progress.coverage,
        });
        if (source.ports.some((port) => port.listing) && options.exportProvider) {
          try {
            await options.exportProvider(source, [], progress.last_complete_policies, {
              exception: { rule, ...(progress.coverage ? { coverage: progress.coverage } : {}) },
            });
          } catch (handoffError) {
            failures.push({
              source: source.key,
              repository: source.repository,
              rule: "provider-failure-handoff",
              details:
                handoffError instanceof Error
                  ? handoffError.message
                  : "Provider failure handoff unavailable",
            });
          }
        }
        if (
          rule === "budget" &&
          before !==
            `${progress.provider_progress?.reads.length ?? 0}:${progress.provider_progress?.validation_cursor ?? 0}` &&
          now() < deadline
        )
          pending.push(source);
      }
      await commitCheckpoint();
      continue;
    }
    // The source's last retained continuation position, so a failure outside
    // the observation itself still states where the next run resumes.
    let retainedCursor: string | null = null;
    try {
      const configured = isConfigured(source);
      if (
        configured &&
        progress.repository_id !== null &&
        progress.repository_id !== template.repository_id
      )
        throw new ObservationFailure(
          "repository-identity",
          "Retained repository identity conflicts with the reviewed configured source",
        );
      if (progress.repository_id === null) {
        const identity = configured
          ? template.repository_id
          : await options.repositoryId(source, {
              admitRequest,
              observeResponse,
              consumeResponseBytes,
            });
        if (!Number.isSafeInteger(identity) || identity <= 0)
          throw new ObservationFailure(
            "repository-identity",
            "Provider repository identity is unavailable",
          );
        progress.repository_id = identity;
        await commitCheckpoint();
      }
      const config: ObserverConfig = configured
        ? configuredCandidateObserverConfig(template)
        : validateObserverConfig({
            ...template,
            format: 2,
            port_id: source.ports[0]!.id,
            repository: source.repository,
            repository_id: progress.repository_id,
            asset_scope: "core-channel-candidates",
            // Only descriptive listings' generated registration reads release
            // text, so only their sources keep it.
            ...(listingOnly(source) ? { release_text: "listing-window" as const } : {}),
            policy_input_sha256: observationHash(
              source.ports.map((port) => ({
                id: port.id,
                channels: port.channels,
                rolling_tag: port.release.rolling_tag ?? null,
                ...(port.listing
                  ? {
                      kind: port.kind ?? "managed-with-listing",
                      listing_sha256: listingDeclarationHash(port.listing),
                      projection_policy: listingProjectionHash,
                    }
                  : {}),
              })),
            ),
          });
      if (
        progress.current_config &&
        observationHash(progress.current_config) !== observationHash(config)
      )
        progress.retired_configs.push(progress.current_config);
      progress.current_config = config;
      await commitCheckpoint();
      const policies: unknown[] = [];
      const scoped = (observation: ProviderObservation, portId: string) => ({
        ...observation,
        port_id: portId,
      });
      let coreProgress = 0;
      const binding = scopeBinding(source);
      const projectAll = async (observation: ProviderObservation) => {
        if (
          progress.policy_progress?.binding !== binding ||
          progress.policy_progress.facts_sha256 !== observation.facts_sha256
        )
          progress.policy_progress = {
            binding,
            facts_sha256: observation.facts_sha256,
            policies: [],
            sha256: observationHash([]),
          };
        const pendingPolicies = progress.policy_progress;
        if (
          pendingPolicies.policies.length > source.ports.length ||
          pendingPolicies.sha256 !== observationHash(pendingPolicies.policies) ||
          pendingPolicies.policies.some(
            (policy, index) =>
              policy.port_id !== source.ports[index]?.id ||
              policy.repository_id !== config.repository_id ||
              policy.facts_sha256 !== observation.facts_sha256 ||
              policy.catalog_definition_sha256 !== definitionFor(source.ports[index]!),
          )
        )
          throw new ObservationFailure(
            "invalid-checkpoint",
            "Continued Core projections differ from exact policy, port order or facts",
          );
        for (let index = pendingPolicies.policies.length; index < source.ports.length; index++) {
          const port = source.ports[index]!;
          const policy = await projectBound(
            port,
            config.repository_id,
            scoped(observation, port.id),
          );
          // Only a final projection gates on coverage; selection probes
          // project headers before their assets are collected.
          if (port.kind !== "listing") requireCompleteCoreCoverage(policy);
          pendingPolicies.policies.push(policy);
          pendingPolicies.sha256 = observationHash(pendingPolicies.policies);
          await commitCheckpoint();
          coreProgress++;
        }
        policies.splice(0, policies.length, ...pendingPolicies.policies);
        return policies[source.ports.findIndex((port) => port.id === config.port_id)];
      };
      let sourceRequests = 0;
      const available = capacity();
      const fairShare = Math.floor(available / (pending.length - index));
      // Split the early collection allowance among the selected turns so
      // other sources retain at least half of the estimated capacity.
      const collectionShare = earlyCollection
        ? Math.min(
            template.budget.pages_per_collection,
            Math.floor(available / (2 * earlyTurnCount)),
          )
        : 0;
      // Dividing capacity across every pending source can round each turn down to
      // a single request, so no source ever completes (#4779: ~1,300 pending sources
      // against ~250 requests per batch). Give each admitted source a turn large
      // enough to finish a typical collection and validation; sources beyond the
      // remaining capacity wait for a later batch in durable rotation order. An
      // early configured turn keeps its existing half-capacity cap.
      const minimumTurn = Math.min(
        template.budget.requests,
        2 * template.budget.pages_per_collection + 4,
      );
      const quantum = Math.max(
        1,
        Math.min(
          template.budget.requests,
          earlyCollection
            ? Math.max(fairShare, collectionShare)
            : Math.max(fairShare, Math.min(minimumTurn, available)),
        ),
      );
      const admitSourceRequest = () => {
        if (sourceRequests >= quantum)
          throw new ObservationFailure(
            "budget",
            "Fair source batch admission exhausted; continue after other admitted source turns",
            null,
          );
        admitRequest();
        sourceRequests++;
      };
      const selectAssetReleases = async (headers: ProviderObservation) => {
        if (
          progress.selection_progress?.binding !== binding ||
          progress.selection_progress.facts_sha256 !== headers.facts_sha256 ||
          progress.selection_progress.checksum_sources === undefined
        )
          progress.selection_progress = {
            binding,
            facts_sha256: headers.facts_sha256,
            cursor: 0,
            release_ids: [],
            sha256: observationHash([]),
            checksum_sources: [],
            checksum_sources_sha256: observationHash([]),
          };
        const selection = progress.selection_progress;
        if (
          selection.cursor > source.ports.length ||
          selection.sha256 !== observationHash(selection.release_ids) ||
          selection.release_ids.some(
            (id) => !headers.facts.releases.some((release) => release.id === id),
          )
        )
          throw new ObservationFailure(
            "invalid-checkpoint",
            "Continued Core selection differs from exact policy or release headers",
          );
        const candidates = new Set(selection.release_ids);
        for (let index = selection.cursor; index < source.ports.length; index++) {
          const port = source.ports[index]!;
          const policy = await projectBound(port, config.repository_id, scoped(headers, port.id));
          if (port.listing)
            for (const id of listingObservationReleaseIds(headers)) candidates.add(id);
          for (const projection of policy.projections as unknown[]) {
            if (isRecord(projection) && port.channels.includes(String(projection.channel)))
              for (const id of projectionAssetReleaseIds(projection)) candidates.add(id);
          }
          selection.checksum_sources = checksumSourcesFromProjections([
            { checksum_sources: selection.checksum_sources },
            ...(policy.projections as unknown[]),
          ]);
          selection.checksum_sources_sha256 = observationHash(selection.checksum_sources);
          selection.release_ids = [...candidates].sort((a, b) => a - b);
          selection.sha256 = observationHash(selection.release_ids);
          selection.cursor = index + 1;
          await commitCheckpoint();
          coreProgress++;
        }
        return selection.release_ids;
      };
      const result = await options.withSourceLock(config, async () => {
        const priorSource = decodeStoredObserverCheckpoint(
          await options.load(config),
          deadline,
          now,
        );
        const position = (continuation: unknown) => {
          if (!isRecord(continuation))
            return observationHash({ phase: "collect", cursor: 0, pages: [] });
          return observationHash({
            phase: continuation.phase,
            cursor: continuation.validation_cursor,
            pages: isRecord(continuation.pages)
              ? Object.entries(continuation.pages).map(([url, page]) => [
                  url,
                  isRecord(page) ? page.sha256 : null,
                ])
              : [],
          });
        };
        const previousPosition = position(isRecord(priorSource) ? priorSource.continuation : null);
        retainedCursor = continuationCursor(
          isRecord(priorSource) ? priorSource.continuation : null,
        );
        const result = await advanceObservation(config, priorSource, {
          deadline,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          githubScope,
          ...(options.token ? { token: options.token } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.sleep ? { sleep: options.sleep } : {}),
          now,
          catalogIds,
          reprojectFreshFacts,
          admitRequest: admitSourceRequest,
          observeResponse,
          consumeResponseBytes,
          selectAssetReleases,
          selectChecksumSources: async (observation) => {
            await selectAssetReleases(observation);
            return progress.selection_progress!.checksum_sources!;
          },
          project: projectAll,
          commitContinuation: async (checkpoint) => {
            await options.save(config, checkpoint);
            retainedCursor = continuationCursor(
              isRecord(checkpoint) ? checkpoint.continuation : null,
            );
          },
        });
        const continuation = result.checkpoint.continuation;
        const readProgress =
          continuation &&
          (Object.keys(continuation.pages).length > 0 || continuation.validation_cursor > 0) &&
          position(continuation) !== previousPosition;
        if (readProgress) coreProgress++;
        await options.save(config, result.checkpoint);
        retainedCursor = continuationCursor(continuation);
        // Historical projections retain their own facts/definition identities.
        // A changed configuration may have no current observation at all.
        const fallback = progress.last_complete_policies;
        const readOriginalRecognition = options.readOriginalRecognition;
        if (!result.report.exception && readOriginalRecognition) {
          const account = {
            admitRequest: admitSourceRequest,
            observeResponse,
            consumeResponseBytes,
          };
          const freshByRelease = new Map<
            string,
            Awaited<ReturnType<typeof observeOriginalSource>>
          >();
          const tagMatches = new Map<string, boolean>();
          const read = (endpoint: string) =>
            readOriginalRecognition(source.repository, endpoint, account);
          for (const policy of policies) {
            if (!isRecord(policy)) continue;
            const port = source.ports.find((port) => port.id === policy.port_id);
            const family = port?.original_source_family;
            if (!family) continue;
            const evidenceKey = inputEvidenceKey(family);
            const target = selectOriginalSourceTarget(
              policy,
              source.repository,
              config.repository_id,
            );
            const previous = readOriginalSourceProgress(
              fallback.find((prior) => prior.port_id === policy.port_id)?.[evidenceKey],
              { repository: source.repository, repository_id: config.repository_id },
              family,
            );
            const retained = previous?.last_complete ?? null;
            let recognitionState: string;
            let complete = retained;
            if (!target) {
              recognitionState = "exact-artifact-unavailable";
            } else {
              const binding = observationHash(target);
              try {
                if (retained?.binding === binding) {
                  const key = JSON.stringify([
                    family,
                    target.release_id,
                    target.release_tag,
                    retained.fact.source_tag_sha1,
                    retained.fact.source_tag_type,
                    retained.fact.source_commit,
                  ]);
                  let matches = tagMatches.get(key);
                  if (matches === undefined) {
                    matches = await revalidateOriginalSource(retained.fact, read);
                    tagMatches.set(key, matches);
                  }
                  recognitionState = matches ? "observed" : "source-tag-changed";
                } else {
                  const release = JSON.stringify([
                    family,
                    target.repository_id,
                    target.release_id,
                    target.release_tag,
                  ]);
                  const fresh = freshByRelease.get(release);
                  let fact = fresh
                    ? { ...fresh, ...target }
                    : await observeOriginalSource(target, read, family);
                  if (!fresh) freshByRelease.set(release, fact);
                  if (
                    fact.parser === "n64-recomp-game-entry-v1" &&
                    retained?.fact.parser === fact.parser &&
                    retained.fact.source_commit === fact.source_commit
                  ) {
                    const runtime = retained.fact.runtime_source;
                    const builds = rebindUpstreamBuildObservation(
                      retained.fact.build_outputs,
                      fact,
                    );
                    fact = {
                      ...fact,
                      ...(runtime ? { runtime_source: runtime } : {}),
                      ...(builds ? { build_outputs: builds } : {}),
                    };
                    const jobTarget = n64BuildJobTarget(fact);
                    const jobs = jobTarget
                      ? rebindN64BuildJobObservation(retained.fact.build_jobs, jobTarget)
                      : undefined;
                    if (jobs) fact = { ...fact, build_jobs: jobs };
                  }
                  complete = { binding, observed_at: new Date(now()).toISOString(), fact };
                  recognitionState = "observed";
                }
              } catch (error) {
                recognitionState =
                  error instanceof ObservationFailure ? error.rule : "source-metadata-unavailable";
                if (error instanceof ObservationFailure && error.rule === "rate-limit") {
                  remaining = 0;
                  extendProviderDeferral(error.retryAt);
                }
              }
            }
            if (
              options.observeN64Runtime &&
              recognitionState === "observed" &&
              complete?.fact.parser === "n64-recomp-game-entry-v1" &&
              (!complete.fact.runtime_source ||
                complete.fact.runtime_source.state === "unavailable")
            ) {
              const fact = complete.fact;
              // Runtime evidence is optional until its own lookup completes.
              // A timeout must keep the release's checked GameEntry observation.
              try {
                const runtime = await observeN64RuntimeSource(fact, read, n64RuntimeCache);
                complete = { ...complete, fact: { ...fact, runtime_source: runtime } };
              } catch (error) {
                complete = {
                  ...complete,
                  fact: { ...fact, runtime_source: { state: "unavailable" } },
                };
                if (error instanceof ObservationFailure && error.rule === "rate-limit") {
                  remaining = 0;
                  extendProviderDeferral(error.retryAt);
                }
              }
            }
            if (
              options.observeN64Runtime &&
              recognitionState === "observed" &&
              complete?.fact.parser === "n64-recomp-game-entry-v1" &&
              complete.fact.runtime_source?.state === "observed"
            ) {
              const fact = complete.fact;
              const runtime = complete.fact.runtime_source.source;
              if (
                runtime.matched_input_blocks &&
                (!runtime.hash_source || runtime.hash_source.state === "unavailable")
              ) {
                let hashSource: N64RuntimeHashSourceObservation = { state: "unavailable" };
                try {
                  hashSource = await observeN64RuntimeHashSource(
                    runtime.revision,
                    read,
                    n64RuntimeCache,
                  );
                } catch (error) {
                  if (error instanceof ObservationFailure && error.rule === "rate-limit") {
                    remaining = 0;
                    extendProviderDeferral(error.retryAt);
                  }
                }
                complete = {
                  ...complete,
                  fact: {
                    ...fact,
                    runtime_source: {
                      state: "observed",
                      source: { ...runtime, hash_source: hashSource },
                    },
                  },
                };
              }
            }
            if (
              options.observeN64Runtime &&
              recognitionState === "observed" &&
              complete?.fact.parser === "n64-recomp-game-entry-v1" &&
              complete.fact.runtime_source?.state === "observed" &&
              complete.fact.runtime_source.source.matched_input_blocks &&
              complete.fact.runtime_source.source.hash_source?.state === "observed" &&
              (!complete.fact.build_outputs || complete.fact.build_outputs.search !== null)
            ) {
              const fact = complete.fact;
              try {
                const builds = await advanceUpstreamArtifactBuildObservation(
                  fact,
                  fact.build_outputs,
                  read,
                  new Date(now()).toISOString(),
                );
                complete = { ...complete, fact: { ...fact, build_outputs: builds } };
              } catch (error) {
                // Keep the source evidence and the build search's last checked cursor.
                if (error instanceof ObservationFailure && error.rule === "rate-limit") {
                  remaining = 0;
                  extendProviderDeferral(error.retryAt);
                }
              }
            }
            const readBuildStep = options.readN64BuildStepLog;
            if (
              readBuildStep &&
              recognitionState === "observed" &&
              complete?.fact.parser === "n64-recomp-game-entry-v1"
            ) {
              const fact = complete.fact;
              const target = n64BuildJobTarget(fact);
              if (
                target &&
                ((fact.build_jobs?.matches.length ?? 0) < target.outputs.length ||
                  fact.build_jobs?.matches.some((match) => !match.compile))
              ) {
                try {
                  const jobs = await advanceN64BuildJobObservation(
                    target,
                    fact.build_jobs,
                    read,
                    (job, step) => readBuildStep(fact.repository, job, step, account),
                  );
                  complete = { ...complete, fact: { ...fact, build_jobs: jobs } };
                } catch (error) {
                  if (error instanceof ObservationFailure && error.rule === "rate-limit") {
                    remaining = 0;
                    extendProviderDeferral(error.retryAt);
                  }
                }
              }
            }
            if (
              recognitionState === "observed" &&
              complete?.fact.parser === "n64-recomp-game-entry-v1" &&
              port?.n64_authoring_scope_sha256
            ) {
              complete = {
                ...complete,
                fact: { ...complete.fact, authoring_scope_sha256: port.n64_authoring_scope_sha256 },
              };
            }
            policy[evidenceKey] = { state: recognitionState, last_complete: complete };
          }
        }
        await options.export(source, config, result, result.report.exception ? fallback : policies);
        return result;
      });
      if (result.report.exception) {
        if (
          result.report.exception.rule === "budget" &&
          coreProgress > 0 &&
          result.checkpoint.continuation &&
          capacity() > 0 &&
          now() < deadline
        )
          pending.push(source);
        if (
          result.notify_exception &&
          !["budget", "cancelled"].includes(result.report.exception.rule) &&
          notifiesOnException(source)
        )
          notifyException = true;
        progress.exception_key = result.report.exception.key;
        progress.exception_rule = result.report.exception.rule;
        progress.retry_at = result.report.exception.retry_at;
        progress.coverage = validStatedSourceCoverage(result.report.exception.coverage)
          ? result.report.exception.coverage
          : statedSourceCoverage(
              new ObservationFailure(
                result.report.exception.rule,
                "",
                result.report.exception.retry_at,
              ),
              continuationCursor(result.checkpoint.continuation),
            );
        if (result.report.exception.rule === "rate-limit") {
          remaining = 0;
          extendProviderDeferral(result.report.exception.retry_at);
        }
        failures.push({
          source: source.key,
          repository: source.repository,
          rule: result.report.exception.rule,
          details:
            isRecord(result.report.exception) && typeof result.report.exception.details === "string"
              ? result.report.exception.details
              : "Source observation is incomplete; resume only after its recorded condition is satisfied.",
          coverage: progress.coverage,
        });
      } else {
        const sameScope = progress.completed_scope_sha256 === binding;
        const retainedTiming =
          reprojectFreshFacts &&
          retainedListingCompletion !== null &&
          sourceRequests === 0 &&
          result.report.last_complete_at === retainedListingCompletion.completed_at &&
          result.report.freshness_observed_at === retainedListingCompletion.observed_at &&
          result.report.observation?.facts_sha256 === retainedListingCompletion.facts_sha256;
        const changed =
          sameScope &&
          progress.last_complete_config?.format === config.format &&
          progress.last_complete_facts_sha256 !== result.report.observation?.facts_sha256;
        if (!sameScope && !retainedTiming) {
          progress.last_change_at = new Date(now()).toISOString();
          progress.change_intervals = 0;
          progress.mean_change_interval_ms = null;
        }
        if (changed) {
          if (
            progress.last_change_at &&
            now() > Date.parse(progress.last_change_at) &&
            progress.change_intervals < Number.MAX_SAFE_INTEGER
          ) {
            const interval = now() - Date.parse(progress.last_change_at);
            progress.change_intervals++;
            progress.mean_change_interval_ms =
              (progress.mean_change_interval_ms ?? interval) +
              (interval - (progress.mean_change_interval_ms ?? interval)) /
                progress.change_intervals;
          }
          progress.last_change_at = new Date(now()).toISOString();
        }
        progress.completed_at = result.report.last_complete_at;
        progress.next_due_at = retainedTiming
          ? retainedListingCompletion.next_due_at
          : result.report.next_observation_due_at;
        progress.freshness_observed_at = result.report.freshness_observed_at;
        if (
          !retainedTiming &&
          progress.mean_change_interval_ms &&
          progress.freshness_observed_at &&
          source.repository !== template.repository
        ) {
          const staleDeadline =
            Date.parse(progress.freshness_observed_at) +
            template.stale_after_hours * 3600000 -
            template.budget.duration_ms;
          const predicted =
            Date.parse(progress.completed_at!) +
            Math.max(template.cadence_hours * 3600000, progress.mean_change_interval_ms / 2);
          progress.next_due_at = new Date(
            Math.max(now(), Math.min(staleDeadline, predicted)),
          ).toISOString();
        }
        progress.retry_at = null;
        progress.exception_key = null;
        progress.exception_rule = null;
        delete progress.coverage;
        // Coverage and current Core output can change eligibility without changing provider facts.
        progress.completed_scope_sha256 = binding;
        progress.last_complete_config = config;
        progress.last_complete_facts_sha256 = result.report.observation?.facts_sha256 ?? null;
        progress.policy_progress = null;
        progress.last_complete_policies = policies.map((policy) => {
          if (!isRecord(policy)) throw new Error("Missing complete Core projection");
          return structuredClone(policy);
        });
        progress.result_sha256 = observationHash({
          facts_sha256: result.report.observation?.facts_sha256,
          coverage: result.report.observation?.coverage ?? null,
          policies: policies.map((policy) => {
            if (!isRecord(policy)) throw new Error("Missing policy output");
            const { observed_at: _clock, ...semantic } = policy;
            return semantic;
          }),
        });
        completed.push(source.key);
      }
    } catch (error) {
      progress.retry_at = error instanceof ObservationFailure ? error.retryAt : null;
      if (error instanceof ObservationFailure && error.rule === "rate-limit") {
        remaining = 0;
        extendProviderDeferral(error.retryAt);
      }
      const rule = error instanceof ObservationFailure ? error.rule : "source-operation-failed";
      const key = exceptionKey(source, rule);
      if (
        progress.exception_key !== key &&
        !["budget", "cancelled"].includes(rule) &&
        notifiesOnException(source)
      )
        notifyException = true;
      progress.exception_key = key;
      progress.exception_rule = rule;
      progress.coverage = statedSourceCoverage(error, retainedCursor);
      failures.push({
        source: source.key,
        repository: source.repository,
        rule,
        details:
          error instanceof ObservationFailure
            ? error.message
            : "Source operation failed before an observation could be completed; inspect its exact scope and retained execution evidence.",
        coverage: progress.coverage,
      });
    }
    await commitCheckpoint();
  }
  // Preserve the source checkpoint first. This optional registry must fit in
  // the space remaining after required release progress.
  if (registryProgress && !options.signal?.aborted) {
    if (registryFits(registryProgress)) {
      state.mod_provider_registry = registryProgress;
      await commitCheckpoint();
    } else {
      failures.push({
        source: "thunderstore-ecosystem",
        repository: "thunderstore.io",
        rule: "checkpoint-size",
        details: "The mod registry does not fit the catalog checkpoint. Prior evidence remains.",
      });
    }
  }
  return {
    checkpoint: state,
    notify_exception: notifyException,
    report: {
      format: 1,
      authority: "catalog-upstream-observation-only",
      generated_at: new Date(now()).toISOString(),
      total_sources: sources.length,
      scope_binding_inputs: {
        core_executable_sha256: policyIdentity,
        listing_stale_after_hours: scopePolicy.staleAfterHours,
        sources: Object.fromEntries(
          sources.map((source) => {
            const input = catalogObservationScopeInputs(source, scopePolicy);
            return [
              source.key,
              {
                contract: input.contract,
                provider_proof: input.provider_proof ?? null,
                source_sha256: input.scope,
                definitions_sha256:
                  "definitions" in input ? observationHash(input.definitions) : null,
                current_sha256: observationHash(input),
                retained_sha256: state.sources[source.key]?.completed_scope_sha256 ?? null,
              },
            ];
          }),
        ),
      },
      ...(launcherModSummary ? { launcher_mod_sources: launcherModSummary } : {}),
      ...(state.mod_provider_registry
        ? {
            mod_provider_registry: {
              observed_at: state.mod_provider_registry.last_complete?.observed_at ?? null,
              expires_at: state.mod_provider_registry.last_complete?.expires_at ?? null,
              communities: state.mod_provider_registry.last_complete?.communities.length ?? null,
              response_sha256: state.mod_provider_registry.last_complete?.response_sha256 ?? null,
              next_due_at: state.mod_provider_registry.next_due_at,
              exception: state.mod_provider_registry.exception,
            },
          }
        : {}),
      checkpoint_storage: {
        bytes: Buffer.byteLength(JSON.stringify(state)),
        limit_bytes: catalogCheckpointByteLimit,
        provider_read_cache_bytes: Object.values(state.sources).reduce(
          (sum, progress) =>
            sum +
            Buffer.byteLength(
              JSON.stringify({
                current: progress.provider_progress ?? null,
                previous: progress.provider_previous_progress ?? null,
              }),
            ),
          0,
        ),
      },
      source_statuses: sources.map((source) => {
        const progress = state.sources[source.key];
        return {
          source_key: source.key,
          provider: source.provider ?? "github",
          repository: source.repository,
          port_ids: source.ports.map((port) => port.id),
          current_scope_complete:
            progress?.completed_scope_sha256 === scopeBinding(source) &&
            progress.exception_key === null,
          observed_at: progress?.freshness_observed_at ?? null,
          stale:
            !progress?.freshness_observed_at ||
            now() - Date.parse(progress.freshness_observed_at) >
              template.stale_after_hours * 3600000,
          retry_at: progress?.retry_at ?? null,
          next_due_at: progress?.next_due_at ?? null,
          ...(progress?.coverage ? { coverage: progress.coverage } : {}),
          ...(progress?.quota_deferrals ? { quota_deferrals: progress.quota_deferrals } : {}),
        };
      }),
      attempted_source_keys: attempted,
      completed_source_keys: completed,
      pending_source_keys: sources
        .filter((source) => scopeDue(source, state.sources[source.key]))
        .map((source) => source.key),
      held,
      failures,
      requests,
      request_accounting:
        "admitted transport attempts; internal GitHub CLI requests and actual provider charges may differ",
      provider_capacity: state.provider_retry_at
        ? { availability: "unavailable-until-reset", retry_at: state.provider_retry_at }
        : { availability: remaining === null ? "unknown" : "observed", remaining },
      additional_provider_capacity: state.provider_capacities ?? {},
      response_bytes_charged: responseBytes,
      unknown_response_size_requests: unknownSizeResponses,
      global_eligibility: "not-assessed",
      protected_publication: "not-authorized",
    },
  };
}
