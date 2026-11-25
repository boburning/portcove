import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Octokit } from "@octokit/core";
import { readCatalogSource } from "./catalog-authoring.mts";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import {
  DiscoveryBudget,
  createDiscoveryTransport,
  discoveryProfiles,
} from "./discovery-budget.mts";
import {
  advanceDiscovery,
  emptyCheckpoint,
  parseDiscoveryCheckpoint,
  replaceCheckpointEnvelope,
} from "./discovery-checkpoint.mts";
import type { DiscoveryCheckpoint } from "./discovery-checkpoint.mts";
import { collectDiscoveryRun } from "./discovery-collection.mts";
import type { DiscoveryCollectionHost } from "./discovery-collection.mts";
import {
  externalHintSummary,
  externalListIds,
  externalRepository,
  leadPaths,
} from "./discovery-external-lists.mts";
import { discoveryGitHubScope } from "./discovery-github.mts";
import { leadFamilyIds, parseLeadState, replaceLeadStateEnvelope } from "./discovery-leads.mts";
import type { DiscoveryLead, LeadState } from "./discovery-leads.mts";
import type { CollectedSource, SourceContext } from "./daily-discovery-sources.mts";
import {
  DiscoveryStoreRefused,
  discoveryStatusQuery,
  postgresDiscoveryStore,
  measureDiscoverySeed,
  readDiscoverySnapshot,
} from "./discovery-store.mts";
import type {
  DiscoveryKnownRevision,
  DiscoverySeedPlan,
  DiscoveryLease,
  DiscoveryProviderObservation,
  DiscoveryStore,
  DiscoveryWatchChange,
} from "./discovery-store.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { assessUpstreamLineage } from "./upstream-lineage.mts";

/**
 * Unattended discovery collection for the maintenance workflow (#177).
 *
 * Runs the same deterministic collectors as the interactive session without a
 * terminal, model, personal checkout or Roadmap inventory. Positive provider
 * observations and the collector's continuation commit atomically to the
 * maintenance store under a fenced lease; nothing is written to GitHub.
 */

export const discoveryWorkerScope = "primary";
/** Bump when the normalized observation facts change meaning. */
export const discoveryParserVersion = 2;
export const discoveryWorkerStateFormat = 1;

/** Identifies the collector definitions this state was written under. */
export const discoveryDefinitionDigest = createHash("sha256")
  .update(
    JSON.stringify({
      state_format: discoveryWorkerStateFormat,
      parser_version: discoveryParserVersion,
      lead_families: leadFamilyIds,
      external_lists: externalListIds,
    }),
  )
  .digest("hex");

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Clocks a pass stamps even when it learns nothing new. */
const passClocks = new Set([
  "completed_at",
  "observed_at",
  "checked_at",
  "attempted_at",
  "unchanged_at",
  // A read's measured transfer, not something learned.
  "bytes",
]);

/** Digest of what a pass learned: collector state without its observation clocks. */
export function learnedDigest(value: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (key, field: unknown) => (passClocks.has(key) ? undefined : field)),
    )
    .digest("hex");
}

export interface DiscoveryWorkerState {
  leads: LeadState;
  checkpoint: DiscoveryCheckpoint;
  research_progress: Record<string, unknown>;
  backoff_until?: string;
}

export function parseWorkerState(value: unknown): DiscoveryWorkerState {
  if (!isRecord(value) || Object.keys(value).length === 0)
    return {
      leads: parseLeadState(undefined),
      checkpoint: emptyCheckpoint(),
      research_progress: {},
    };
  if (value.format !== discoveryWorkerStateFormat)
    throw new Error("Stored discovery state has an unsupported format; preserve and reconcile");
  return {
    leads: parseLeadState(value.leads),
    checkpoint: parseDiscoveryCheckpoint(value.checkpoint),
    research_progress: isRecord(value.research_progress) ? { ...value.research_progress } : {},
    ...(typeof value.backoff_until === "string" ? { backoff_until: value.backoff_until } : {}),
  };
}

const sorted = (values: readonly string[] | undefined) =>
  values?.length ? [...new Set(values)].sort() : undefined;

/**
 * Normalized, provider-bound facts for one positive lead. Portcove-side
 * dispositions, search-family and curated-list provenance, local evidence paths
 * and observation clocks are excluded, so an unchanged project stays one row
 * however often and wherever it is seen. Provenance stays in collector state.
 */
export function leadObservation(lead: DiscoveryLead): DiscoveryProviderObservation | undefined {
  if (!Number.isSafeInteger(lead.id) || lead.id <= 0) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(lead.repository)) return undefined;
  const facts: Record<string, unknown> = {
    repository: lead.repository,
    url: lead.url,
    description: lead.description.slice(0, 1000),
  };
  if (lead.created_at) facts.created_at = lead.created_at;
  const aliases = sorted(lead.aliases);
  if (aliases) facts.aliases = aliases;
  if (lead.manifest) facts.manifest = lead.manifest;
  if (lead.release_hint) facts.release_assets_observed = lead.release_hint.assets_observed;
  // Keep the row inside the store's bound; the remaining facts identify the project.
  if (Buffer.byteLength(JSON.stringify(facts)) > 12_000) delete facts.manifest;
  if (Buffer.byteLength(JSON.stringify(facts)) > 12_000) delete facts.aliases;
  return {
    provider: "github",
    provider_id: String(lead.id),
    parser_version: discoveryParserVersion,
    content_sha256: sha256(facts),
    repository: lead.repository,
    facts,
  };
}

/**
 * A lead whose recent releases carried no desktop asset waits on release
 * evidence; when assets appear the same subject becomes due for reconsideration.
 * Release selection and route fit stay with their maintained owners.
 */
export function leadWatch(lead: DiscoveryLead): DiscoveryWatchChange | undefined {
  if (!lead.release_hint || !Number.isSafeInteger(lead.id) || lead.id <= 0) return undefined;
  const assets = lead.release_hint.assets_observed;
  return {
    provider: "github",
    provider_id: String(lead.id),
    reason: "no-native-package",
    status: assets ? "due" : "waiting",
    evidence_sha256: sha256({ release_assets_observed: assets }),
    wake: assets
      ? "Published release assets observed; reconsider host routes and capability fit"
      : "Wake when a published release carries an uploaded desktop asset",
  };
}

/** Catalog lineage the worker can read without the Roadmap inventory. */
export function catalogCoveredHints(
  catalog = fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
) {
  const covered = new Set<string>();
  for (const record of readCatalogSource(catalog).records) {
    const lineage = assessUpstreamLineage(record);
    for (const identity of [lineage.current, ...lineage.history]) {
      const repository = externalRepository(identity.project_url);
      if (repository) covered.add(repository.key);
    }
  }
  return covered;
}

export interface DiscoveryWorkerOptions {
  store: DiscoveryStore;
  connect: (budget: DiscoveryBudget) => Promise<Pick<SourceContext, "sdk" | "http">>;
  runDir: string;
  sourceRevision: string;
  runner: string;
  covered: () => Set<string>;
  scope?: string;
  leaseSeconds?: number;
  /**
   * Interim commit interval. It defaults to half the lease, so every commit also
   * renews the lease long before it can lapse.
   */
  commitIntervalMs?: number;
  /** Database transfer admitted for this pass; a pass that has spent it ends resumably. */
  transferBytes?: number;
  /**
   * Start of the whole run. Passes of one run share it, so work already done in
   * an earlier pass (a release checked, a search window completed) is not redone.
   */
  runStartedAt?: string;
  /** This pass's budget; its limits come from physical resources. */
  budget?: DiscoveryBudget;
  now?: () => number;
  /**
   * State and lead records this process committed in an earlier pass. When the
   * store still holds that exact revision, the pass reuses them instead of
   * reading them again.
   */
  retained?: DiscoveryRetainedState;
  /** Receives what this pass committed, for the next pass to reuse. */
  retain?: (retained: DiscoveryRetainedState | undefined) => void;
}

/** A committed revision held in memory, with the full state including lead records. */
export interface DiscoveryRetainedState extends DiscoveryKnownRevision {
  state: Record<string, unknown>;
}

export interface DiscoveryWorkerResult {
  format: "portcove-discovery-worker-result";
  format_version: 1;
  outcome: "complete" | "partial" | "failed" | "deferred";
  reason?: string;
  /** Whether this pass changed collector state; an unproductive pass is not repeated. */
  progressed?: boolean;
  /** When an exhausted provider quota or backoff lifts, if that is what stopped the pass. */
  wake_at?: string;
  attempt_id?: string;
  acquisition?: number;
  generation?: number;
  revision?: number;
  started_at: string;
  finished_at: string;
  canonical_overlap: "unknown";
  sources: { id: string; status: string; records: number; next_path?: unknown }[];
  notes: unknown[];
  leads: { records: number; pending_families: number; external: unknown };
  committed: {
    pages: number;
    observations: number;
    watch_changes: number;
    state_bytes: number;
    sent_bytes: number;
    received_bytes: number;
    /** Lead records written as rows in this pass. */
    lead_records?: number;
  };
  budget: { requests: number; bytes: number; milliseconds_remaining: number };
}

/** Generous bound on one commit's response (its revision, notices and errors). */
export const commitResponseAllowance = 64 * 1024;

const resumableProviderCodes = new Set([
  "budget_exhausted",
  "rate_limited",
  "deadline_exceeded",
  "cancelled",
  "quota_unknown",
  "quota_stale",
  "retry_exhausted",
]);

export async function runDiscoveryWorker(
  options: DiscoveryWorkerOptions,
): Promise<DiscoveryWorkerResult> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const runStartedAt = options.runStartedAt ?? startedAt;
  const scope = options.scope ?? discoveryWorkerScope;
  const leaseSeconds = options.leaseSeconds ?? 3600;
  const interval = options.commitIntervalMs ?? (leaseSeconds * 1000) / 2;
  const transferBytes = options.transferBytes ?? Number.POSITIVE_INFINITY;
  const lease: DiscoveryLease = { scope, attempt: randomUUID(), token: randomUUID() };
  const committed: DiscoveryWorkerResult["committed"] = {
    pages: 0,
    observations: 0,
    watch_changes: 0,
    state_bytes: 0,
    sent_bytes: 0,
    received_bytes: 0,
  };
  const result = (
    outcome: DiscoveryWorkerResult["outcome"],
    extra: Partial<DiscoveryWorkerResult> = {},
  ): DiscoveryWorkerResult => ({
    format: "portcove-discovery-worker-result",
    format_version: 1,
    outcome,
    started_at: startedAt,
    finished_at: new Date(now()).toISOString(),
    canonical_overlap: "unknown",
    sources: [],
    notes: [],
    leads: { records: 0, pending_families: 0, external: null },
    committed,
    budget: { requests: 0, bytes: 0, milliseconds_remaining: 0 },
    ...extra,
  });

  let grant;
  try {
    const known = options.retained;
    grant = options.store.acquire(lease, {
      leaseSeconds,
      definition: discoveryDefinitionDigest,
      sourceRevision: options.sourceRevision,
      runner: options.runner,
      ...(known
        ? {
            known: {
              revision: known.revision,
              generation: known.generation,
              definition: known.definition,
              attempt: known.attempt,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof DiscoveryStoreRefused)
      return result("deferred", { reason: `${error.reason}: ${error.message}` });
    throw error;
  }
  // The store omits a revision this process committed and still holds in full.
  const reused = grant.unchanged === true && options.retained ? options.retained : undefined;
  options.retain?.(undefined);
  let state: DiscoveryWorkerState;
  const recordDigests = new Map<string, string>();
  const grantDefinition = reused ? reused.definition : grant.definition_sha256;
  // Lead records live in rows; the state document carries everything else.
  // Records still embedded in an older document are kept and move into rows
  // with the first commit. Reused state already carries every stored record.
  let validationStage = "retained state could not be validated";
  committed.received_bytes = grant.received_bytes ?? 0;
  try {
    state = parseWorkerState(reused ? structuredClone(reused.state) : grant.state);
    validationStage = "lead records could not be loaded";
    const loaded = reused
      ? { records: Object.values(state.leads.records), bytes: 0 }
      : options.store.loadLeadRecords(scope);
    committed.received_bytes += loaded.bytes;
    validationStage = "lead records could not be validated";
    const storedRecords: Record<string, unknown> = {};
    for (const raw of loaded.records)
      if (isRecord(raw) && Number.isSafeInteger(raw.id)) {
        storedRecords[String(raw.id)] = raw;
        recordDigests.set(String(raw.id), sha256(raw));
      }
    state.leads = parseLeadState({
      ...state.leads,
      records: { ...storedRecords, ...state.leads.records },
    });
  } catch (error) {
    // No malformed continuation may leave an owned attempt running or be reset.
    const reason = `${validationStage}: ${errorMessage(error).slice(0, 400)}`;
    const failed = result(error instanceof DiscoveryStoreRefused ? "deferred" : "failed", {
      reason, attempt_id: lease.attempt,
    });
    try {
      const { notes: _notes, ...summary } = failed;
      options.store.finish(lease, "failed", summary);
    } catch (finishError) {
      if (!(finishError instanceof DiscoveryStoreRefused))
        throw new Error(`${reason}; lease cleanup failed: ${errorMessage(finishError)}`, {
          cause: finishError,
        });
    }
    return failed;
  }
  const initialDigest = learnedDigest({ leads: state.leads, checkpoint: state.checkpoint });
  let revision = grant.revision;
  // Stored state and its observations commit together, so everything in the
  // loaded state is already retained; only later differences are sent.
  const observed = new Map<string, string>();
  const watched = new Map<string, string>();
  const remember = (leads: LeadState) => {
    const observations: DiscoveryProviderObservation[] = [];
    const watches: DiscoveryWatchChange[] = [];
    const records: DiscoveryLead[] = [];
    for (const lead of Object.values(leads.records)) {
      if (recordDigests.get(String(lead.id)) !== sha256(lead)) records.push(lead);
      const observation = leadObservation(lead);
      if (observation && observed.get(observation.provider_id) !== observation.content_sha256)
        observations.push(observation);
      const watch = leadWatch(lead);
      if (watch && watched.get(watch.provider_id) !== `${watch.status}:${watch.evidence_sha256}`)
        watches.push(watch);
    }
    return { observations, watches, records };
  };
  // State written under other collector definitions (for example an earlier
  // parser version) is not assumed to have rows under this one; the first commit
  // resends them and the store keeps one row per identical content.
  if (grantDefinition === discoveryDefinitionDigest) {
    const { observations, watches } = remember(state.leads);
    for (const o of observations) observed.set(o.provider_id, o.content_sha256);
    for (const w of watches) watched.set(w.provider_id, `${w.status}:${w.evidence_sha256}`);
  }

  const budget =
    options.budget ??
    new DiscoveryBudget(
      "hosted",
      (usage) => writeFileSync(path.join(options.runDir, "budget.json"), JSON.stringify(usage)),
      now,
      startedAt,
    );
  if (state.backoff_until) budget.usage.backoff_until = state.backoff_until;
  const journal: DiscoveryCollectionHost["journal"] = {
    started_at: runStartedAt,
    notes: [],
    sources: [],
    collection_done: false,
    coverage: "unknown",
  };
  const nextState = () => ({
    format: discoveryWorkerStateFormat,
    leads: { ...host.leads, records: {} },
    checkpoint: host.checkpoint,
    research_progress: state.research_progress,
    ...(budget.usage.backoff_until ? { backoff_until: budget.usage.backoff_until } : {}),
  });
  let lastCommit = now();
  let committedDefinition = grantDefinition;
  let committedAttempt = reused?.attempt;
  // The state document of the last commit, which with the committed lead
  // records is exactly what the store holds at `revision`.
  let committedDocument: Record<string, unknown> | undefined;
  let dirty = false;
  let stale = false;
  // Any other failed commit also halts collection, so a database error inside a
  // collector's own error handling is never recorded as a source outcome.
  let halted: Error | undefined;
  // Set once this pass has spent its admitted database transfer.
  let spent: GitHubApiError | undefined;
  const stopped = () => {
    if (stale)
      throw new DiscoveryStoreRefused("stale-writer", "This discovery attempt lost its lease");
    if (halted) throw halted;
    if (spent) throw spent;
  };
  let source: SourceContext | undefined;
  const host: DiscoveryCollectionHost = {
    leads: state.leads,
    checkpoint: state.checkpoint,
    budget,
    get source() {
      if (!source) throw new Error("Discovery sources are not connected");
      return source;
    },
    runDir: options.runDir,
    journal,
    externalCollectionAttempted: false,
    leadCollectionAttempted: false,
    leadFamilies: new Set(),
    deferredLeadFamilies: new Set(),
    leadPages: 0,
    searches: 0,
    unattended: true,
    persist() {
      // Once a newer owner or restore takes the lease, or this pass cannot commit
      // any more, every later step stops here, even inside collectors that
      // tolerate their own source failures.
      stopped();
      dirty = true;
      if (now() - lastCommit < interval) return;
      // Commit (and so renew the lease) only while this commit's and the final
      // one's responses still fit the admitted transfer; otherwise end the pass
      // resumably. Neon meters only what the database sends to the client: a
      // commit's state, records and observations travel to the database and
      // only its short acknowledgement returns. The admission meters 70% of its
      // reservation as payload.
      if (committed.received_bytes + 2 * commitResponseAllowance > transferBytes * 0.7) {
        spent = new GitHubApiError(
          "budget_exhausted",
          "This pass's admitted database transfer is spent; the next pass continues",
        );
        throw spent;
      }
      flush();
    },
    save(name, value) {
      if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name)) throw new Error("Unsafe evidence name");
      writeFileSync(path.join(options.runDir, `${name}.json`), JSON.stringify(value));
    },
    knownLeadUrls: () => new Set<string>(),
    externalCovered: () => options.covered(),
    leadSummary() {
      return {
        canonical_overlap: "unknown",
        external: host.leads.external
          ? externalHintSummary(
              host.leads.external,
              undefined,
              leadPaths(Object.values(host.leads.records)),
              journal.started_at,
            )
          : null,
      };
    },
  };
  const flush = () => {
    if (stale) return;
    const { observations, watches, records } = remember(host.leads);
    const next = nextState();
    try {
      const saved = options.store.commit(lease, revision, {
        definition: discoveryDefinitionDigest,
        leaseSeconds,
        state: next,
        observations,
        watches,
        leadRecords: records,
      });
      revision = saved.revision;
      committedDefinition = discoveryDefinitionDigest;
      committedAttempt = lease.attempt;
      committedDocument = next;
      committed.received_bytes += saved.received_bytes ?? 0;
      committed.pages++;
      committed.observations += observations.length;
      committed.watch_changes += watches.length;
      committed.state_bytes =
        Buffer.byteLength(JSON.stringify(next)) +
        Buffer.byteLength(JSON.stringify(host.leads.records));
      committed.lead_records = (committed.lead_records ?? 0) + records.length;
      for (const record of records) recordDigests.set(String(record.id), sha256(record));
      committed.sent_bytes += saved.bytes;
      for (const o of observations) observed.set(o.provider_id, o.content_sha256);
      for (const w of watches) watched.set(w.provider_id, `${w.status}:${w.evidence_sha256}`);
      dirty = false;
      lastCommit = now();
    } catch (error) {
      if (error instanceof DiscoveryStoreRefused && error.reason === "stale-writer") stale = true;
      else halted = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  };

  let outcome: DiscoveryWorkerResult["outcome"] = "failed";
  let reason: string | undefined;
  try {
    const { sdk, http } = await options.connect(budget);
    source = {
      sdk,
      budget,
      http,
      save: (name, value) => host.save(name, value),
      primaryProgress: { entries: state.research_progress, persist: () => host.persist() },
      acceptSource: (collected: CollectedSource) => {
        // A stopped pass records no further source outcome.
        stopped();
        journal.sources = journal.sources.filter((value) => value.id !== collected.id);
        journal.sources.push(collected);
        host.checkpoint = advanceDiscovery(host.checkpoint, {
          observed_at: new Date(now()).toISOString(),
          sources: [collected],
        });
        host.persist();
      },
    };
    await observeProviderCapacity(sdk, budget);
    await collectDiscoveryRun(host);
    outcome = journal.coverage === "complete" ? "complete" : "partial";
  } catch (error) {
    reason = errorMessage(error).slice(0, 500);
    // Budget, quota, deadline and cancellation are resumable boundaries, never
    // evidence about a source. Committed pages and the last continuation remain.
    if (error instanceof GitHubApiError && resumableProviderCodes.has(error.code)) {
      outcome = "partial";
      journal.notes.push({ phase: "worker", status: "partial", error: reason });
    } else if (error instanceof DiscoveryStoreRefused) {
      outcome = "deferred";
      reason = `${error.reason}: ${error.message}`;
    } else outcome = "failed";
  }
  if (stale) {
    outcome = "deferred";
    reason =
      "stale-writer: a newer owner or restore took this scope's lease; nothing more was committed";
  } else if (halted) {
    outcome = "failed";
    reason = `store commit failed; collection halted at the last committed page: ${halted.message.slice(0, 400)}`;
  } else if (dirty) {
    try {
      flush();
    } catch (error) {
      outcome = error instanceof DiscoveryStoreRefused ? "deferred" : "failed";
      reason = errorMessage(error).slice(0, 500);
    }
  }
  const leads = {
    records: Object.keys(host.leads.records).length,
    pending_families: leadFamilyIds.length - host.leadFamilies.size,
    external: host.leadSummary().external,
  };
  const remaining = budget.remaining();
  const wake = spent ? undefined : providerWake(budget, now());
  const final = result(outcome, {
    ...(reason ? { reason } : {}),
    progressed: learnedDigest({ leads: host.leads, checkpoint: host.checkpoint }) !== initialDigest,
    // A spent transfer allowance continues at once in a new pass; a quota waits.
    ...(spent
      ? { wake_at: new Date(now()).toISOString() }
      : wake === undefined
        ? {}
        : { wake_at: new Date(wake).toISOString() }),
    attempt_id: lease.attempt,
    acquisition: grant.acquisition,
    generation: grant.generation,
    revision,
    // After a halted commit, collector error handling may have relabeled sources
    // with the store error; report none rather than a false source outcome.
    sources: (halted ? [] : journal.sources).map((s) => ({
      id: s.id,
      status: s.status,
      records: s.records.length,
      ...(s.next_path === undefined ? {} : { next_path: s.next_path }),
    })),
    notes: journal.notes.slice(-100),
    leads,
    budget: {
      requests: budget.usage.requests,
      bytes: budget.usage.bytes,
      milliseconds_remaining: Math.max(0, remaining.milliseconds),
    },
  });
  // Hand the next pass exactly what the store holds, when every change committed.
  if (!stale && !halted && !dirty) {
    const document = committedDocument ?? (reused ? undefined : null);
    if (document === undefined) options.retain?.(reused);
    else if (document !== null && committedAttempt)
      options.retain?.({
        revision,
        generation: grant.generation,
        definition: committedDefinition,
        attempt: committedAttempt,
        state: structuredClone({
          ...document,
          leads: { ...(document.leads as Record<string, unknown>), records: host.leads.records },
        }),
      });
  }
  if (!stale) {
    try {
      const { notes: _notes, ...summary } = final;
      options.store.finish(lease, outcome === "deferred" ? "failed" : outcome, summary);
    } catch (error) {
      if (!(error instanceof DiscoveryStoreRefused)) throw error;
      final.outcome = "deferred";
      final.reason = `${error.reason}: ${error.message}`;
    }
  }
  return final;
}

export interface DiscoveryPassOptions extends Omit<
  DiscoveryWorkerOptions,
  "budget" | "transferBytes" | "runStartedAt" | "retained" | "retain"
> {
  /** Epoch milliseconds by which collection must stop, before final commits. */
  deadline: number;
  /** Response bytes the runner can retain. */
  diskBytes: number;
  /** Time to commit a pass's final state within its admission. */
  finalizationMs: number;
  /**
   * Runs one pass under its own database admission. Returns undefined when the
   * shared allowance defers it.
   */
  admit: (
    pass: number,
    run: (admitted: { bytes: number; deadline: number }) => Promise<DiscoveryWorkerResult>,
  ) => Promise<DiscoveryWorkerResult | undefined>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

const cancellableSleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * The retained lead and checkpoint envelope for unattended collection: a quarter
 * of the runner's memory, within the longest string the runtime can serialize
 * (the collector validates its state as one serialized document).
 */
export function physicalLeadEnvelope(memory = os.totalmem()) {
  return Math.min(Math.floor(memory / 4), 2 ** 29 - 24);
}

/**
 * Collect until a physical limit stops the run. Each pass holds its own database
 * admission, lease and attempt; between passes the worker holds nothing while it
 * waits for an exhausted provider quota to reset. A pass that changed nothing is
 * not repeated.
 */
export async function runDiscoveryPasses(options: DiscoveryPassOptions) {
  const envelope = physicalLeadEnvelope();
  const restoreLeads = replaceLeadStateEnvelope(envelope);
  const restoreCheckpoint = replaceCheckpointEnvelope(envelope);
  try {
    return await collectPasses(options);
  } finally {
    restoreCheckpoint();
    restoreLeads();
  }
}

async function collectPasses(options: DiscoveryPassOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? cancellableSleep;
  const runStartedAt = new Date(now()).toISOString();
  const passes: DiscoveryWorkerResult[] = [];
  // What the previous pass committed; the store confirms it is still current.
  let retained: DiscoveryRetainedState | undefined;
  let deferred: string | undefined;
  let failure: string | undefined;
  for (let pass = 1; ; pass++) {
    let result: DiscoveryWorkerResult | undefined;
    try {
      result = await options.admit(pass, async ({ bytes, deadline }) => {
        const finishBy = Math.min(options.deadline, deadline - options.finalizationMs);
        const startedAt = now();
        const budget = new DiscoveryBudget(
          "hosted",
          (usage) => writeFileSync(path.join(options.runDir, "budget.json"), JSON.stringify(usage)),
          now,
          new Date(startedAt).toISOString(),
          {
            requests: Number.MAX_SAFE_INTEGER,
            bytes: options.diskBytes,
            milliseconds: Math.max(1, finishBy - startedAt),
          },
        );
        return await runDiscoveryWorker({
          ...options,
          budget,
          transferBytes: bytes,
          runStartedAt,
          ...(retained ? { retained } : {}),
          retain: (value) => {
            retained = value;
          },
        });
      });
    } catch (error) {
      // Keep the record of the passes that already committed.
      failure = `pass ${pass} failed: ${errorMessage(error).slice(0, 500)}`;
      break;
    }
    if (!result) {
      deferred = "resource admission deferred this pass; the next run continues";
      break;
    }
    passes.push(result);
    if (result.outcome !== "partial" || !result.progressed || !result.wake_at) break;
    const wake = Date.parse(result.wake_at);
    if (!(wake < options.deadline) || options.signal?.aborted) break;
    if (wake > now()) await sleep(wake - now(), options.signal);
    if (options.signal?.aborted) break;
  }
  const last = passes.at(-1);
  const outcome: DiscoveryWorkerResult["outcome"] =
    failure || passes.some((p) => p.outcome === "failed")
      ? "failed"
      : (last?.outcome ?? "deferred");
  return {
    outcome,
    passes,
    ...(deferred ? { deferred } : {}),
    ...(failure ? { reason: failure } : {}),
  };
}

/**
 * When an observed provider quota or Retry-After backoff is what stops work,
 * the time it lifts; otherwise undefined.
 */
export function providerWake(budget: DiscoveryBudget, now: number) {
  const times: number[] = [];
  const backoff = Date.parse(budget.usage.backoff_until ?? "");
  if (Number.isFinite(backoff) && backoff > now) times.push(backoff);
  for (const [resource, quota] of Object.entries(budget.usage.provider_quotas ?? {})) {
    const needed = resource === "graphql" ? budget.graphqlPointHeadroom : 1;
    const reset = Date.parse(quota.resetAt);
    if (quota.remaining < needed && Number.isFinite(reset) && reset > now) times.push(reset);
    // A quota window that has rolled over leaves the pass's observation stale,
    // and the pass stops admitting requests; a new pass observes it afresh now.
    else if (resource === "core" && Number.isFinite(reset) && reset <= now) times.push(now);
  }
  // Wake just after the latest blocking reset, so every exhausted resource has lifted.
  return times.length ? Math.max(...times) + 1000 : undefined;
}

async function observeProviderCapacity(sdk: Octokit, budget: DiscoveryBudget) {
  const response = await sdk.request({
    method: "GET",
    url: new URL("rate_limit", "https://api.github.com/").href,
  });
  const resources: unknown = isRecord(response.data) ? response.data.resources : undefined;
  for (const resource of ["core", "graphql", "search"] as const) {
    const quota: unknown = isRecord(resources) ? resources[resource] : undefined;
    if (!isRecord(quota) || typeof quota.remaining !== "number" || typeof quota.reset !== "number")
      throw new GitHubApiError("quota_unknown", `GitHub ${resource} capacity unknown`);
    budget.observeProvider({
      resource,
      remaining: quota.remaining,
      resetAt: new Date(quota.reset * 1000).toISOString(),
    });
  }
}

/** Short Markdown view of the status export for the job summary. */
export function renderDiscoveryStatus(status: Record<string, unknown>) {
  const attempts = Array.isArray(status.attempts)
    ? (status.attempts as Record<string, unknown>[])
    : [];
  const latest = attempts[0];
  const result = isRecord(latest?.result) ? latest.result : {};
  const sources = Array.isArray(result.sources)
    ? (result.sources as Record<string, unknown>[])
    : [];
  const observations = (isRecord(status.observations) ? status.observations : {}) as Record<
    string,
    number | undefined
  >;
  const watches = isRecord(status.watches) ? status.watches : {};
  const run = isRecord(status.latest_run) ? status.latest_run : undefined;
  const due = Array.isArray(watches.due) ? (watches.due as Record<string, unknown>[]) : [];
  const lines = [
    "## Unattended discovery collection",
    "",
    latest
      ? `Latest attempt \`${String(latest.attempt_id)}\` (${String(latest.outcome)}) started ${String(latest.started_at)} at \`${String(latest.source_revision)}\`; ${String(latest.committed_pages)} committed pages.`
      : "No discovery attempt is recorded yet.",
    `Retained observations: ${String(observations.rows ?? 0)} rows for ${String(observations.subjects ?? 0)} provider subjects; ${String(observations.latest_run_new_rows ?? 0)} new in the latest run${run ? ` (${String(run.passes)} passes: ${Array.isArray(run.outcomes) ? run.outcomes.join(", ") : ""})` : ""}.`,
    `Canonical ownership: unknown until Roadmap reconciliation. Due watches: ${due.length}.`,
    "",
  ];
  if (sources.length) {
    lines.push("| Source | Status | Records |", "| --- | --- | --- |");
    for (const s of sources)
      lines.push(`| ${String(s.id)} | ${String(s.status)} | ${String(s.records)} |`);
    lines.push("");
  }
  // Curated lists and inventory baselines: coverage and contribution per source.
  const cell = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const external =
    isRecord(result.leads) && isRecord(result.leads.external) ? result.leads.external : {};
  const lists = isRecord(external.lists) ? external.lists : {};
  const listRows = Object.entries(lists).filter(([, value]) => isRecord(value));
  if (listRows.length) {
    lines.push(
      `Curated hints: ${Number(external.hints ?? 0)} (unsupported-host ${Number(external["unsupported-host"] ?? 0)}, non-GitHub ${Number(external["non-github"] ?? 0)}).`,
      "",
      "| List | Last complete | Entries | Hints | Discovered | Platform claims | Unresolved hosts | Due |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const [id, raw] of listRows) {
      const value = raw as Record<string, unknown>;
      const clock = isRecord(value.last_complete) ? value.last_complete : undefined;
      const c = isRecord(value.contribution) ? value.contribution : {};
      lines.push(
        `| ${id} | ${clock ? cell(clock.completed_at).slice(0, 16) : "never"} | ${cell(clock?.entries ?? "")} | ${cell(c.hints ?? 0)} | ${cell(c.discovered ?? 0)} | ${cell(c.platform_claims ?? 0)} | ${cell(c.unresolved_hosts ?? 0)} | ${value.due ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }
  const inventories = isRecord(external.inventories) ? external.inventories : {};
  const inventoryRows = Object.entries(inventories).filter(([, value]) => isRecord(value));
  if (inventoryRows.length) {
    lines.push(
      "| Baseline | Inventory read | Items | Read | Due | Without public code |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const [id, raw] of inventoryRows) {
      const value = raw as Record<string, unknown>;
      lines.push(
        `| ${id} | ${cell(value.inventory_at).slice(0, 16)} | ${cell(value.items)} | ${cell(value.read)} | ${cell(value.due)} | ${cell(value.candidates_without_public_code)} |`,
      );
    }
    lines.push("");
  }
  if (due.length) {
    lines.push("| Due subject | Reason | Wake |", "| --- | --- | --- |");
    for (const w of due.slice(0, 25))
      lines.push(
        `| ${String(w.repository ?? w.provider_id)} | ${String(w.reason)} | ${String(w.wake)} |`,
      );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Conservative one-time import of a local discovery checkout's lead state into an
 * empty store scope. Leads, hints and search continuations keep their recorded
 * strength; the local source checkpoint is not trusted as proof of coverage, so
 * those sources are collected again. A scope that already has state is left
 * unchanged, so a repeated import has no effect.
 */
export function importLocalState(
  store: DiscoveryStore,
  stateDir: string,
  options: { sourceRevision: string; runner: string; scope?: string },
) {
  const file = path.join(stateDir, "leads.json");
  const digest = existsSync(file)
    ? createHash("sha256").update(readFileSync(file)).digest("hex")
    : null;
  if (!digest) return { outcome: "nothing-to-import" as const, file, digest };
  const leads = parseLeadState(JSON.parse(readFileSync(file, "utf8")));
  const lease: DiscoveryLease = {
    scope: options.scope ?? discoveryWorkerScope,
    attempt: randomUUID(),
    token: randomUUID(),
  };
  const grant = store.acquire(lease, {
    leaseSeconds: 600,
    definition: discoveryDefinitionDigest,
    sourceRevision: options.sourceRevision,
    runner: options.runner,
  });
  if (grant.revision !== 0) {
    store.finish(lease, "complete", { import: { file, digest, outcome: "scope-has-state" } });
    return { outcome: "scope-has-state" as const, file, digest };
  }
  const records = Object.values(leads.records);
  const observations = records.flatMap((lead) => leadObservation(lead) ?? []);
  const watches = records.flatMap((lead) => leadWatch(lead) ?? []);
  store.commit(lease, 0, {
    definition: discoveryDefinitionDigest,
    leaseSeconds: 600,
    state: {
      format: discoveryWorkerStateFormat,
      leads: { ...leads, records: {} },
      checkpoint: emptyCheckpoint(),
      research_progress: {},
    },
    observations,
    watches,
    leadRecords: records,
  });
  const summary = {
    file,
    digest,
    outcome: "imported" as const,
    observations: observations.length,
    watches: watches.length,
  };
  store.finish(lease, "complete", { import: summary });
  return summary;
}

/**
 * Transfer to reserve for one read of the stored leads. The admission meters 70%
 * of a reservation as payload, and the read returns the state document and
 * every record once.
 */
export function storedLeadsReservation(forecast: { state_bytes: number; record_bytes: number }) {
  return Math.ceil(
    (Number(forecast.state_bytes) + Number(forecast.record_bytes)) / 0.7 + 1024 * 1024,
  );
}

/**
 * The shared store's collected leads for a local runner, read without a lease.
 * Each read holds its own transfer admission sized from the stored state; a
 * commit during the read makes it read again, each time admitted.
 */
export async function readStoredLeads(
  environment: NodeJS.ProcessEnv,
  options: { scope?: string } = {},
): Promise<
  | { outcome: "read"; revision: number; leads: LeadState; bytes: number }
  | { outcome: "empty"; bytes: number }
> {
  const scope = options.scope ?? discoveryWorkerScope;
  const { queryJson } = await import("./maintenance-store.mts");
  const { withMaintenanceAdmission } = await import("./maintenance-resource-policy.mts");
  let bytes = 0;
  for (;;) {
    const forecast = (await withMaintenanceAdmission(environment, "inspect", () =>
      queryJson(environment, discoveryTransferForecastQuery),
    )) as { state_bytes: number; record_bytes: number };
    const snapshot = await withMaintenanceAdmission(
      environment,
      "inspect",
      () => readDiscoverySnapshot(environment, scope),
      { reservationBytes: storedLeadsReservation(forecast) },
    );
    bytes += snapshot.bytes;
    // Commits are half a lease apart and a read takes seconds; every repeat is
    // admitted again, so a deferred admission ends the loop.
    if (snapshot.outcome === "moved") continue;
    if (snapshot.outcome === "empty") return { outcome: "empty", bytes };
    const state = parseWorkerState(snapshot.state);
    const records: Record<string, unknown> = {};
    for (const raw of snapshot.records)
      if (isRecord(raw) && Number.isSafeInteger(raw.id)) records[String(raw.id)] = raw;
    return {
      outcome: "read",
      revision: snapshot.revision,
      // Records still embedded in an older state document take precedence, as
      // they do for the collector.
      leads: parseLeadState({ ...state.leads, records: { ...records, ...state.leads.records } }),
      bytes,
    };
  }
}

/** Recent measured transfer and current state size, read before admission. */
export const discoveryTransferForecastQuery = `SELECT json_build_object(
  'state_bytes', coalesce((SELECT max(octet_length(s.state::text) + coalesce(h.bytes, 0))
    FROM portcove_maintenance.discovery_collection_state s
    LEFT JOIN LATERAL (
      SELECT sum(octet_length(to_jsonb(hint_key)::text) + octet_length(hint::text) + 8) + 32 AS bytes
      FROM portcove_maintenance.discovery_external_hints WHERE scope = s.scope
    ) h ON true), 0),
  'record_bytes', coalesce((SELECT sum(octet_length(record::text))
    FROM portcove_maintenance.discovery_lead_records), 0),
  -- Neon meters only what the database sends to the client.
  'previous_transfer_bytes', coalesce((SELECT max(
      coalesce((result->'committed'->>'received_bytes')::bigint, 0))
    FROM portcove_maintenance.discovery_collection_attempts
    WHERE result IS NOT NULL AND runner IN (
      -- The passes of the last seven runs.
      SELECT runner FROM portcove_maintenance.discovery_collection_attempts
      GROUP BY runner ORDER BY max(acquisition) DESC LIMIT 7)), 0));`;

/** Recent received bytes already include the cold acquire. Do not add a
 * second cold acquire to that measurement; retain room for either complete
 * read scenario plus acknowledgements and the existing protocol headroom. */
export function discoveryPassReservation(acquireBytes: number, previousTransfer: number, commits: number) {
  return Math.ceil(
    Math.max(acquireBytes, previousTransfer) / 0.7 +
      (commits * commitResponseAllowance) / 0.7 + 1024 * 1024,
  );
}

/** Reserve the measured row deltas, compact grant envelope and ordinary acknowledgements. */
export function discoverySeedReservation(plan: Pick<DiscoverySeedPlan, "compactBytes" | "hintsBytes" | "leadsBytes">, commits: number) {
  return discoveryPassReservation(plan.compactBytes + plan.hintsBytes + plan.leadsBytes + commitResponseAllowance, 0, commits);
}

/** Time to write the final state: a generous allowance proportional to its size. */
export function finalizationMilliseconds(stateBytes: number) {
  return 60_000 + Math.ceil(stateBytes / (256 * 1024)) * 1000;
}

const unmigratedReason = "The maintenance store is not migrated for discovery collection yet";

/** Only the store's own missing schema or tables mean "not migrated"; a missing
 * database, role, column or function is a configuration fault and is raised. */
export function unmigratedStore(error: unknown) {
  return /\b(?:relation|schema) "portcove_maintenance(?:\.[a-z_]+)?" does not exist/u.test(
    errorMessage(error),
  );
}

const usage =
  "usage: node scripts/discovery-worker.mts collect|status|import-local [--database-env NAME] [--output DIR] [--state-dir DIR]";

export async function discoveryWorkerMain(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index],
      value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(usage);
    flags.set(key.slice(2), value);
  }
  for (const key of flags.keys())
    if (!["database-env", "output", "state-dir"].includes(key)) throw new Error(usage);
  const { connectionFromEnvironment, queryJson, MaintenanceStoreError } =
    await import("./maintenance-store.mts");
  const environment = connectionFromEnvironment(
    flags.get("database-env") ?? "PORTCOVE_MAINTENANCE_DATABASE_URL",
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = await assertOwnedUnlinkedPath(
    path.join(root, "work"),
    path.resolve(root, flags.get("output") ?? "work/discovery-worker"),
    "discovery worker output",
  );
  mkdirSync(output, { recursive: true });
  if (command === "status") {
    const { withMaintenanceAdmission, MaintenanceResourceDeferred } =
      await import("./maintenance-resource-policy.mts");
    const run = process.env.GITHUB_RUN_ID;
    let status: unknown;
    const request = (suffix: string) =>
      run
        ? `github:${run}:discovery-status:${process.env.GITHUB_SHA ?? "unknown"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}:${suffix}`
        : undefined;
    try {
      // Size the export's admission from what it will read.
      const size = (await withMaintenanceAdmission(
        environment,
        "inspect",
        () =>
          queryJson(
            environment,
            `SELECT (SELECT coalesce(sum(octet_length(w::text)), 0)
                 FROM portcove_maintenance.discovery_watches w WHERE w.status = 'due')
               + (SELECT coalesce(sum(octet_length(a::text)), 0) FROM (
                   SELECT * FROM portcove_maintenance.discovery_collection_attempts
                   ORDER BY acquisition DESC LIMIT 10) a)
               + 1048576;`,
          ),
        { request: request("size") },
      )) as number;
      status = await withMaintenanceAdmission(
        environment,
        "inspect",
        () => queryJson(environment, discoveryStatusQuery({ attempts: 10 })),
        { request: request("export"), reservationBytes: Math.ceil(Number(size) * 2) },
      );
    } catch (error) {
      // A deferred admission or an unmigrated store leaves status.json untouched
      // and replaces status.md with the reason; any other failure is raised.
      const resource = error instanceof MaintenanceResourceDeferred;
      if (!resource && !unmigratedStore(error)) throw error;
      const reason = resource ? errorMessage(error) : unmigratedReason;
      const deferred = `Discovery status export deferred: ${reason}\n`;
      writeFileSync(
        path.join(output, "status.md"),
        `## Unattended discovery collection\n\n${deferred}`,
      );
      console.log(JSON.stringify({ outcome: "deferred", reason }));
      return 75;
    }
    if (!isRecord(status)) throw new MaintenanceStoreError("Malformed discovery status");
    const exported = {
      format: "portcove-discovery-status",
      format_version: 1,
      exported_at: new Date().toISOString(),
      canonical_overlap: "unknown",
      handoff: {
        status: "pending-dependency",
        detail:
          "Due watches are retained for the hosted researcher and the eligible-cohort facts worker; automatic executor dispatch stays disabled under #8570",
      },
      ...status,
    };
    writeFileSync(path.join(output, "status.json"), `${JSON.stringify(exported, null, 2)}\n`);
    writeFileSync(path.join(output, "status.md"), renderDiscoveryStatus(exported));
    console.log(JSON.stringify({ outcome: "exported", file: path.join(output, "status.json") }));
    return 0;
  }
  if (command === "import-local") {
    const stateDir = flags.get("state-dir");
    if (!stateDir) throw new Error(usage);
    const imported = importLocalState(postgresDiscoveryStore(environment), path.resolve(stateDir), {
      sourceRevision: process.env.GITHUB_SHA ?? "local",
      runner: `import:${os.hostname()}`,
    });
    console.log(JSON.stringify(imported));
    return 0;
  }
  if (command !== "collect") throw new Error(usage);
  const token = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
  const runDir = path.join(output, "evidence");
  mkdirSync(runDir, { recursive: true });
  const write = (value: {
    outcome: string;
    reason?: string | undefined;
    [key: string]: unknown;
  }) => {
    writeFileSync(path.join(output, "result.json"), `${JSON.stringify(value, null, 2)}\n`);
    console.log(JSON.stringify({ outcome: value.outcome, reason: value.reason ?? null }));
  };
  if (!token) {
    const at = new Date().toISOString();
    write({
      format: "portcove-discovery-worker-result",
      format_version: 1,
      outcome: "deferred",
      reason: "credential_unavailable: set GH_TOKEN for read-only GitHub collection",
      started_at: at,
      finished_at: at,
      canonical_overlap: "unknown",
      sources: [],
      notes: [],
      leads: { records: 0, pending_families: 0, external: null },
      committed: {
        pages: 0,
        observations: 0,
        watch_changes: 0,
        state_bytes: 0,
        sent_bytes: 0,
        received_bytes: 0,
      },
      budget: { requests: 0, bytes: 0, milliseconds_remaining: 0 },
    });
    return 75;
  }
  const cancellation = new AbortController();
  const cancel = () =>
    cancellation.abort(new GitHubApiError("cancelled", "Discovery worker cancelled"));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const { withMaintenanceAdmission, MaintenanceResourceDeferred, admissionTimeout } =
    await import("./maintenance-resource-policy.mts");
  const run = process.env.GITHUB_RUN_ID;
  const requestKey = (suffix: string) =>
    run
      ? `github:${run}:discovery:${process.env.GITHUB_SHA ?? "unknown"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}:${suffix}`
      : undefined;
  const deferredRun = (reason: string) => {
    const at = new Date().toISOString();
    write({ outcome: "deferred", reason, started_at: at, finished_at: at, passes: [] });
    return 75;
  };
  try {
    // Size every pass from measured state and transfer rather than fixed limits.
    const seed = process.env.PORTCOVE_DISCOVERY_SEED_URL
      ? connectionFromEnvironment("PORTCOVE_DISCOVERY_SEED_URL") : undefined;
    delete process.env.PORTCOVE_DISCOVERY_SEED_URL;
    let plan: DiscoverySeedPlan | null = null;
    let forecast: { state_bytes: number; record_bytes: number; previous_transfer_bytes: number };
    try {
      forecast = (await withMaintenanceAdmission(
        environment,
        "inspect",
        () => {
          const forecast = queryJson(environment, discoveryTransferForecastQuery);
          if (seed) plan = measureDiscoverySeed(environment, seed, discoveryWorkerScope);
          return forecast;
        },
        { request: requestKey("forecast") },
      )) as typeof forecast;
    } catch (error) {
      if (error instanceof MaintenanceResourceDeferred)
        return deferredRun(`resource admission: ${error.message}`);
      if (unmigratedStore(error)) return deferredRun(unmigratedReason);
      throw error;
    }
    const deadlineEpoch = Number(process.env.PORTCOVE_DISCOVERY_DEADLINE_EPOCH);
    const disk = statfsSync(runDir);
    const finalizationMs = finalizationMilliseconds(forecast.state_bytes + forecast.record_bytes);
    // A pass reads the whole state and its lead records once.
    let acquireBytes = forecast.state_bytes + forecast.record_bytes;
    const commits = Math.ceil(admissionTimeout / (3600 * 500)) + 1;
    const measuredPlan = plan as DiscoverySeedPlan | null;
    const selectedPlan = measuredPlan && discoverySeedReservation(measuredPlan, commits) <
      discoveryPassReservation(acquireBytes, forecast.previous_transfer_bytes, commits)
      ? measuredPlan : undefined;
    const store = postgresDiscoveryStore(environment, undefined, seed, selectedPlan);
    const covered = (() => {
      let cache: Set<string> | undefined;
      return () => (cache ??= catalogCoveredHints());
    })();
    let previousTransfer = forecast.previous_transfer_bytes;
    const collected = await runDiscoveryPasses({
      store,
      runDir,
      covered,
      sourceRevision: process.env.GITHUB_SHA ?? "local",
      runner: run
        ? `github-actions:${run}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
        : `local:${os.hostname()}:${randomUUID()}`,
      // The job's own deadline, less time to commit the final state.
      deadline: Number.isFinite(deadlineEpoch)
        ? deadlineEpoch * 1000 - finalizationMs
        : Date.now() + discoveryProfiles.hosted.milliseconds,
      // Half the runner's free space for retained responses and evidence.
      diskBytes: Math.floor((Number(disk.bavail) * Number(disk.bsize)) / 2),
      finalizationMs,
      signal: cancellation.signal,
      connect: async (budget) => {
        const scope = discoveryGitHubScope(budget, token, { signal: cancellation.signal });
        // Discovery collection is read-only; refuse any mutation at the client.
        const sdk = await createGitHubClient({
          ...scope,
          allowRequest: (method) => method === "GET" || method === "HEAD",
        });
        return { sdk, http: createDiscoveryTransport(budget, token) };
      },
      admit: async (pass, collect) => {
        // Neon meters only what the database sends to the client: the acquire
        // read of the state and lead records (omitted when a later pass reuses
        // what this run committed), then a short acknowledgement for a commit
        // every half lease across the admission window and the final commit.
        // The largest response any pass of this run or a recent run received
        // covers growth, including a full read after another writer's commit.
        // The admission meters 70% of a reservation as payload.
        // A measured initial delta cannot fall back to an unadmitted full read.
        // Subsequent passes retain conservative complete-read admission.
        const measuredDiscovery = pass === 1 && selectedPlan !== undefined;
        const reservationBytes = measuredDiscovery && selectedPlan
          ? discoverySeedReservation(selectedPlan, commits)
          : discoveryPassReservation(acquireBytes, previousTransfer, commits);
        try {
          const result = await withMaintenanceAdmission(
            environment,
            "discovery",
            async (bytes, deadline) => await collect({ bytes, deadline }),
            {
              request: requestKey(`pass-${pass}`),
              reservationBytes,
              measuredDiscovery,
              // The responses this pass received, with a protocol margin.
              estimate: (value) => 200_000 + Math.ceil(value.committed.received_bytes * 1.3),
              completed: (value) => value.outcome !== "failed" && value.outcome !== "deferred",
            },
          );
          previousTransfer = Math.max(previousTransfer, result.committed.received_bytes);
          acquireBytes = Math.max(acquireBytes, result.committed.state_bytes);
          return result;
        } catch (error) {
          if (error instanceof MaintenanceResourceDeferred) return undefined;
          throw error;
        }
      },
    });
    write({ format: "portcove-discovery-run-result", format_version: 1, ...collected });
    return collected.outcome === "failed" ? 1 : collected.outcome === "deferred" ? 75 : 0;
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  discoveryWorkerMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    },
  );
