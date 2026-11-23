import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Octokit } from "@octokit/core";
import { readCatalogSource } from "./catalog-authoring.mts";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";
import {
  advanceDiscovery,
  emptyCheckpoint,
  parseDiscoveryCheckpoint,
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
import { leadFamilyIds, parseLeadState } from "./discovery-leads.mts";
import type { DiscoveryLead, LeadState } from "./discovery-leads.mts";
import type { CollectedSource, SourceContext } from "./daily-discovery-sources.mts";
import {
  DiscoveryStoreRefused,
  discoveryStatusQuery,
  postgresDiscoveryStore,
} from "./discovery-store.mts";
import type {
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
export const discoveryParserVersion = 1;
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
 * dispositions, local evidence paths and observation clocks are excluded so an
 * unchanged project stays one row however often it is seen.
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
  if (aliases) facts.aliases = aliases.slice(0, 20);
  const families = sorted(lead.search_families);
  if (families) facts.search_families = families;
  const lists = sorted(lead.external_lists);
  if (lists) facts.external_lists = lists;
  if (lead.manifest) facts.manifest = lead.manifest;
  if (lead.release_hint) facts.release_assets_observed = lead.release_hint.assets_observed;
  // Keep the row inside the store's bound; the remaining facts identify the project.
  if (Buffer.byteLength(JSON.stringify(facts)) > 12_000) delete facts.manifest;
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
  /** Minimum time between interim commits; every run also commits at its end. */
  commitIntervalMs?: number;
  /** Database transfer the run may spend on interim commits. */
  transferBytes?: number;
  budget?: DiscoveryBudget;
  now?: () => number;
}

export interface DiscoveryWorkerResult {
  format: "portcove-discovery-worker-result";
  format_version: 1;
  outcome: "complete" | "partial" | "failed" | "deferred";
  reason?: string;
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
  };
  budget: { requests: number; bytes: number; milliseconds_remaining: number };
}

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
  const scope = options.scope ?? discoveryWorkerScope;
  const leaseSeconds = options.leaseSeconds ?? 3600;
  const interval = options.commitIntervalMs ?? 120_000;
  const transferBytes = options.transferBytes ?? 12 * 1024 * 1024;
  const lease: DiscoveryLease = { scope, attempt: randomUUID(), token: randomUUID() };
  const committed = {
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
    grant = options.store.acquire(lease, {
      leaseSeconds,
      definition: discoveryDefinitionDigest,
      sourceRevision: options.sourceRevision,
      runner: options.runner,
    });
  } catch (error) {
    if (error instanceof DiscoveryStoreRefused)
      return result("deferred", { reason: `${error.reason}: ${error.message}` });
    throw error;
  }
  const state = parseWorkerState(grant.state);
  let revision = grant.revision;
  // Stored state and its observations commit together, so everything in the
  // loaded state is already retained; only later differences are sent.
  const observed = new Map<string, string>();
  const watched = new Map<string, string>();
  const remember = (leads: LeadState) => {
    const observations: DiscoveryProviderObservation[] = [];
    const watches: DiscoveryWatchChange[] = [];
    for (const lead of Object.values(leads.records)) {
      const observation = leadObservation(lead);
      if (observation && observed.get(observation.provider_id) !== observation.content_sha256)
        observations.push(observation);
      const watch = leadWatch(lead);
      if (watch && watched.get(watch.provider_id) !== `${watch.status}:${watch.evidence_sha256}`)
        watches.push(watch);
    }
    return { observations, watches };
  };
  committed.received_bytes = grant.received_bytes ?? 0;
  // State written under other collector definitions (for example an earlier
  // parser version) is not assumed to have rows under this one; the first commit
  // resends them and the store keeps one row per identical content.
  if (grant.definition_sha256 === discoveryDefinitionDigest) {
    const { observations, watches } = remember(state.leads);
    for (const o of observations) observed.set(o.provider_id, o.content_sha256);
    for (const w of watches) watched.set(w.provider_id, `${w.status}:${w.evidence_sha256}`);
  }

  const budget =
    options.budget ??
    new DiscoveryBudget(
      "ordinary",
      (usage) => writeFileSync(path.join(options.runDir, "budget.json"), JSON.stringify(usage)),
      now,
      startedAt,
    );
  if (state.backoff_until) budget.usage.backoff_until = state.backoff_until;
  const journal: DiscoveryCollectionHost["journal"] = {
    started_at: startedAt,
    notes: [],
    sources: [],
    collection_done: false,
    coverage: "unknown",
  };
  let lastCommit = now();
  let dirty = false;
  let stale = false;
  // Any other failed commit also halts collection, so a database error inside a
  // collector's own error handling is never recorded as a source outcome.
  let halted: Error | undefined;
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
    persist() {
      // Once a newer owner or restore takes the lease, every later step stops here,
      // even inside collectors that tolerate their own source failures.
      if (stale)
        throw new DiscoveryStoreRefused("stale-writer", "This discovery attempt lost its lease");
      if (halted) throw halted;
      dirty = true;
      if (now() - lastCommit < interval) return;
      // Leave room for this commit and the final one within the run's allowance.
      const stateBytes = committed.state_bytes || Buffer.byteLength(JSON.stringify(host.leads));
      if (committed.sent_bytes + committed.received_bytes + 2 * stateBytes <= transferBytes * 0.6)
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
    const { observations, watches } = remember(host.leads);
    const next = {
      format: discoveryWorkerStateFormat,
      leads: host.leads,
      checkpoint: host.checkpoint,
      research_progress: state.research_progress,
      ...(budget.usage.backoff_until ? { backoff_until: budget.usage.backoff_until } : {}),
    };
    try {
      const saved = options.store.commit(lease, revision, {
        definition: discoveryDefinitionDigest,
        leaseSeconds,
        state: next,
        observations,
        watches,
      });
      revision = saved.revision;
      committed.pages++;
      committed.observations += observations.length;
      committed.watch_changes += watches.length;
      committed.state_bytes = Buffer.byteLength(JSON.stringify(next));
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
  const final = result(outcome, {
    ...(reason ? { reason } : {}),
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
  const due = Array.isArray(watches.due) ? (watches.due as Record<string, unknown>[]) : [];
  const lines = [
    "## Unattended discovery collection",
    "",
    latest
      ? `Latest attempt \`${String(latest.attempt_id)}\` (${String(latest.outcome)}) started ${String(latest.started_at)} at \`${String(latest.source_revision)}\`; ${String(latest.committed_pages)} committed pages.`
      : "No discovery attempt is recorded yet.",
    `Retained observations: ${String(observations.rows ?? 0)} rows for ${String(observations.subjects ?? 0)} provider subjects; ${String(observations.latest_attempt_new_rows ?? 0)} new in the latest attempt.`,
    `Canonical ownership: unknown until Roadmap reconciliation. Due watches: ${due.length}.`,
    "",
  ];
  if (sources.length) {
    lines.push("| Source | Status | Records |", "| --- | --- | --- |");
    for (const s of sources)
      lines.push(`| ${String(s.id)} | ${String(s.status)} | ${String(s.records)} |`);
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
      leads,
      checkpoint: emptyCheckpoint(),
      research_progress: {},
    },
    observations,
    watches,
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
    try {
      status = await withMaintenanceAdmission(
        environment,
        "inspect",
        () => queryJson(environment, discoveryStatusQuery({ attempts: 10, watches: 200 })),
        {
          request: run
            ? `github:${run}:discovery-status:${process.env.GITHUB_SHA ?? "unknown"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
            : undefined,
        },
      );
    } catch (error) {
      if (!(error instanceof MaintenanceResourceDeferred)) throw error;
      // The meter or allowance is unavailable; keep the prior export and say so.
      const deferred = `Discovery status export deferred: ${error.message}\n`;
      writeFileSync(
        path.join(output, "status.md"),
        `## Unattended discovery collection\n\n${deferred}`,
      );
      console.log(JSON.stringify({ outcome: "deferred", reason: error.message }));
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
  const write = (value: DiscoveryWorkerResult) => {
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
  const { withMaintenanceAdmission, MaintenanceResourceDeferred } =
    await import("./maintenance-resource-policy.mts");
  let collected: DiscoveryWorkerResult | undefined;
  try {
    collected = await withMaintenanceAdmission(
      environment,
      "discovery",
      async (reservation) =>
        await runDiscoveryWorker({
          store: postgresDiscoveryStore(environment),
          runDir,
          sourceRevision: process.env.GITHUB_SHA ?? "local",
          runner: process.env.GITHUB_RUN_ID
            ? `github-actions:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
            : `local:${os.hostname()}`,
          covered: (() => {
            let cache: Set<string> | undefined;
            return () => (cache ??= catalogCoveredHints());
          })(),
          transferBytes: reservation,
          connect: async (budget) => {
            const scope = discoveryGitHubScope(budget, token, { signal: cancellation.signal });
            // Discovery collection is read-only; refuse any mutation at the client.
            const sdk = await createGitHubClient({
              ...scope,
              allowRequest: (method) => method === "GET" || method === "HEAD",
            });
            return { sdk, http: createDiscoveryTransport(budget, token) };
          },
        }),
      {
        estimate: (value) =>
          200_000 + Math.ceil((value.committed.sent_bytes + value.committed.received_bytes) * 1.3),
        completed: (value) => value.outcome !== "failed",
      },
    );
  } catch (error) {
    if (!(error instanceof MaintenanceResourceDeferred)) throw error;
    const at = new Date().toISOString();
    write({
      format: "portcove-discovery-worker-result",
      format_version: 1,
      outcome: "deferred",
      reason: `resource admission: ${error.message}`,
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
  } finally {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
  write(collected);
  return collected.outcome === "failed" ? 1 : collected.outcome === "deferred" ? 75 : 0;
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
