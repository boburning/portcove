import path from "node:path";
import { GitHubApiError } from "./github-operation.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import type { DiscoveryBudget } from "./discovery-budget.mts";
import { advanceDiscovery } from "./discovery-checkpoint.mts";
import type { DiscoveryCheckpoint } from "./discovery-checkpoint.mts";
import {
  collectDiscoverySources,
  resolveDiscoveryDefaultRevision,
  repoName,
} from "./daily-discovery-sources.mts";
import type { CollectedSource, SourceContext } from "./daily-discovery-sources.mts";
import {
  acceptLeadPage,
  advanceLeadFamily,
  leadSearchFamilyCount,
  leadPageSize,
  LeadSearchChanged,
  linkExternalHints,
  nextLeadPage,
  pendingLeads,
  resolveExternalHint,
  restartLeadSlice,
  retainLeadResults,
} from "./discovery-leads.mts";
import type { ExternalResolution, LeadState } from "./discovery-leads.mts";
import {
  bindExternalListSource,
  externalHintSummary,
  externalLeadLists,
  externalListDue,
  leadPaths,
  mergeExternalList,
  parseExternalList,
  recordExternalListFailure,
  selectExternalResolutions,
} from "./discovery-external-lists.mts";

/**
 * Deterministic source collection shared by the interactive discovery session and
 * the unattended maintenance worker. It reads approved sources through the bounded
 * transport and records leads, hints and source checkpoints; it never writes to
 * GitHub, the catalog or the Roadmap. Canonical ownership is optional input: when a
 * host cannot read the Roadmap inventory it reports overlap as unknown instead of
 * blocking collection.
 */
export interface DiscoveryCollectionHost {
  leads: LeadState;
  checkpoint: DiscoveryCheckpoint;
  readonly budget: DiscoveryBudget;
  readonly source: SourceContext;
  readonly runDir: string;
  readonly journal: {
    started_at: string;
    notes: unknown[];
    sources: CollectedSource[];
    collection_done: boolean;
    coverage: string;
  };
  externalCollectionAttempted: boolean;
  leadCollectionAttempted: boolean;
  leadFamilies: Set<string>;
  deferredLeadFamilies: Set<string>;
  leadPages: number;
  searches: number;
  /** Durably records leads, checkpoint and notes before the next external read. */
  persist(): void;
  save(name: string, value: unknown): void;
  /** Upstream URLs already owned by canonical issues (lowercase). */
  knownLeadUrls(): Set<string>;
  /** Normalized external-hint keys already covered by canonical issues or catalog lineage. */
  externalCovered(): Set<string>;
  leadSummary(): { external: ReturnType<typeof externalHintSummary> | null };
}

const object = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error("Expected structured discovery message");
  return v;
};

/** Curated community lists add lead hints only. Each due list is read once per run
 * and a bounded number of uncovered GitHub hints is bound to primary repository IDs.
 */
export async function collectExternalLeadLists(host: DiscoveryCollectionHost) {
  if (host.externalCollectionAttempted) return host.leadSummary().external;
  host.externalCollectionAttempted = true;
  const at = host.journal.started_at;
  // Provider-wide refusals stop this run. Only a typed GitHub answer about one
  // repository path is recorded on that hint; anything unclassified stops too.
  const providerWide = (error: unknown) =>
    !(error instanceof GitHubApiError) ||
    error.status === 401 ||
    (error.status ?? 0) >= 500 ||
    // Without an HTTP answer (DNS, TLS or another network failure) GitHub said
    // nothing about this path; only refusals and malformed answers are per-hint.
    (error.status === null &&
      !["redirect_refused", "invalid_response", "response_limit"].includes(error.code)) ||
    [
      "budget_exhausted",
      "rate_limited",
      "deadline_exceeded",
      "cancelled",
      "credential_unavailable",
      "invalid_configuration",
      "request_refused",
      "quota_unknown",
      "quota_stale",
      "retry_exhausted",
    ].includes(error.code);
  for (const list of externalLeadLists) {
    if (!externalListDue(host.leads.external, list.id, at)) continue;
    const left = host.budget.remaining();
    // One list read may follow up to four redirects; keep the research reserve after them.
    if (
      left.requests < 22 + ("revision_repository" in list ? 3 : 0) ||
      left.bytes < list.cap + 1024 * 1024
    ) {
      host.journal.notes.push({
        phase: "external-list",
        source: list.id,
        status: "deferred",
        resume: "Read this list on a later admitted run; retained hints are unchanged",
      });
      continue;
    }
    const name = `external-list-${list.id}`;
    try {
      let sourceUrl: string;
      let revision: string | undefined;
      if ("revision_repository" in list) {
        revision = await resolveDiscoveryDefaultRevision(
          host.source,
          list.revision_repository,
          list.repository_id,
        );
        sourceUrl = `https://raw.githubusercontent.com/${list.revision_repository}/${revision}/${list.revision_path}`;
      } else {
        sourceUrl = list.url;
      }
      const response = await host.source.http.request("GET", sourceUrl, undefined, false, list.cap);
      host.save(name, { url: sourceUrl, revision, ...response });
      if (response.status !== 200)
        throw new Error(`External list returned HTTP ${String(response.status)}`);
      let parsed = parseExternalList(list.id, response.text);
      if (revision) parsed = bindExternalListSource(parsed, response.text, sourceUrl, revision);
      if (
        "reviewed_revision" in list &&
        revision !== list.reviewed_revision &&
        !host.leads.external?.lists[list.id]
      ) {
        const baselineUrl = `https://raw.githubusercontent.com/${list.revision_repository}/${list.reviewed_revision}/${list.revision_path}`;
        const baseline = await host.source.http.request(
          "GET",
          baselineUrl,
          undefined,
          false,
          list.cap,
        );
        host.save(`${name}-reviewed-baseline`, { url: baselineUrl, ...baseline });
        if (baseline.status !== 200)
          throw new Error(
            "Reviewed external source baseline unavailable; retain canonical overlap as unknown",
          );
        const baselineParsed = bindExternalListSource(
          parseExternalList(list.id, baseline.text),
          baseline.text,
          baselineUrl,
          list.reviewed_revision,
        );
        host.leads = {
          ...host.leads,
          external: mergeExternalList(
            host.leads.external,
            list.id,
            baselineParsed,
            at,
            path.join(host.runDir, `${name}-reviewed-baseline.json`),
          ),
        };
      }
      host.leads = linkExternalHints(
        {
          ...host.leads,
          external: mergeExternalList(
            host.leads.external,
            list.id,
            parsed,
            at,
            path.join(host.runDir, `${name}.json`),
          ),
        },
        at,
      );
    } catch (error) {
      // A list-specific failure waits before its next read; a budget or provider
      // refusal leaves the list due for the next admitted run.
      // The run deadline and cancellation end the whole run; a bounded read that
      // fails once the run's time is spent says nothing about the list either.
      const timeSpent = host.budget.remaining().milliseconds <= 0;
      const budgetRefusal =
        // A worker killed after the run's time is spent throws a plain Error.
        (!(error instanceof GitHubApiError) && timeSpent) ||
        (error instanceof GitHubApiError &&
          ([
            "budget_exhausted",
            "rate_limited",
            "quota_unknown",
            "quota_stale",
            "deadline_exceeded",
            "cancelled",
          ].includes(error.code) ||
            (error.code === "download_failed" && timeSpent)));
      if (!budgetRefusal)
        host.leads = {
          ...host.leads,
          external: recordExternalListFailure(
            host.leads.external,
            list.id,
            at,
            errorMessage(error),
          ),
        };
      host.journal.notes.push({
        phase: "external-list",
        source: list.id,
        status: "partial",
        evidence:
          "revision_repository" in list
            ? `https://github.com/${list.revision_repository}`
            : list.url,
        error: errorMessage(error),
        resume: "Retained hints and the last successful list clock are unchanged",
      });
      if (budgetRefusal) {
        host.persist();
        break;
      }
    }
    host.persist();
  }
  const picks = host.leads.external
    ? selectExternalResolutions(
        host.leads.external,
        host.externalCovered(),
        leadPaths(Object.values(host.leads.records)),
        at,
      )
    : [];
  for (const pick of picks) {
    // Keep the same capacity for two upstream investigations that lead searches keep.
    if (host.budget.remaining().requests < 18 || host.budget.remaining().bytes < 1024 * 1024) {
      host.journal.notes.push({
        phase: "external-resolution",
        status: "deferred",
        next: pick.repository,
        resume: "Resolve remaining curated-list hints on a later admitted run",
      });
      break;
    }
    const name = `external-resolution-${observationHash(pick.key).slice(0, 16)}`;
    let outcome: ExternalResolution;
    try {
      // Admission failures are budget/quota state, never evidence about this hint.
      await host.budget.admit(1, 1);
    } catch (error) {
      host.journal.notes.push({
        phase: "external-resolution",
        status: "deferred",
        next: pick.repository,
        error: errorMessage(error),
        resume: "Resolve remaining curated-list hints on a later admitted run",
      });
      break;
    }
    try {
      const response = await host.source.sdk.request({
        method: "GET",
        url: new URL(`repos/${repoName(pick.repository)}`, "https://api.github.com/").href,
      });
      host.save(name, response.data);
      outcome = { status: "found", repository: response.data };
    } catch (error) {
      if (providerWide(error)) {
        host.journal.notes.push({
          phase: "external-resolution",
          status: "partial",
          next: pick.repository,
          error: errorMessage(error),
          resume: "Resolve remaining curated-list hints on a later admitted run",
        });
        break;
      }
      const status = error instanceof GitHubApiError ? error.status : undefined;
      outcome =
        error instanceof GitHubApiError && error.code === "redirect_refused"
          ? {
              status: "unavailable",
              reason:
                "GitHub redirected this path (renamed or transferred repository); research its new location manually",
            }
          : status === 404 || status === 410
            ? { status: "unavailable", reason: `Repository metadata returned HTTP ${status}` }
            : status === 451 || status === 403
              ? {
                  status: "unavailable",
                  reason: `Repository access is blocked (HTTP ${status})`,
                }
              : {
                  status: "failed",
                  reason: `Repository metadata read failed: ${errorMessage(error).slice(0, 200)}`,
                };
    }
    try {
      host.leads = resolveExternalHint(
        host.leads,
        pick.key,
        outcome,
        at,
        path.join(host.runDir, `${name}.json`),
      );
    } catch (error) {
      // Malformed provider metadata: record a short retry so this hint cannot block others.
      host.leads = resolveExternalHint(
        host.leads,
        pick.key,
        { status: "failed", reason: `Malformed repository metadata: ${errorMessage(error)}` },
        at,
        path.join(host.runDir, `${name}.json`),
      );
    }
    host.persist();
  }
  host.persist();
  return host.leadSummary().external;
}

/** Bounded lead-search families with fixed windows, overlap and continuation. */
export async function searchLeadFamilies(host: DiscoveryCollectionHost) {
  if (host.leadCollectionAttempted) return host.leadSummary();
  host.leadCollectionAttempted = true;
  host.leadFamilies ??= new Set();
  host.deferredLeadFamilies ??= new Set();
  // A full idle rotation terminates even when every family is current, capped or
  // deferred. Successful pages reset it; request/time/byte admission bounds work.
  let idleTurns = 0;
  while (idleTurns < leadSearchFamilyCount) {
    idleTurns++;
    const plan = nextLeadPage(host.leads, host.journal.started_at);
    if (host.deferredLeadFamilies.has(plan.family)) {
      host.leads.next_family = advanceLeadFamily(host.leads.next_family);
      continue;
    }
    if (plan.current) {
      host.leadFamilies.add(plan.family);
      host.leads.next_family = advanceLeadFamily(host.leads.next_family);
      continue;
    }
    if (plan.capped) {
      host.leadFamilies.add(plan.family);
      host.journal.notes.push({
        phase: "lead-search",
        status: "capped",
        ...plan,
        resume:
          "Narrow this capped time slice before a fresh bounded search; no complete coverage claim",
      });
      host.leads.next_family = advanceLeadFamily(host.leads.next_family);
      host.persist();
      continue;
    }
    // Leave bounded capacity for two upstream investigations as well as the existing delivery reserve.
    if (host.budget.remaining().requests < 17 || host.budget.remaining().bytes < 1024 * 1024) {
      host.journal.notes.push({
        phase: "lead-search",
        status: "deferred",
        ...plan,
        resume: "Continue this exact query/page on the next admitted run before quiet rotation",
      });
      break;
    }
    await host.budget.admit(1, 1);
    const response = await host.source.sdk.request({
      method: "GET",
      url: new URL(
        `search/repositories?q=${encodeURIComponent(plan.query)}&per_page=${leadPageSize}&page=${plan.page}${plan.sort ? `&sort=${plan.sort}&order=desc` : ""}`,
        "https://api.github.com/",
      ).href,
    });
    const name = `lead-search-${++host.searches}`;
    host.save(name, {
      ...object(response.data),
      query: plan.query,
      sort: plan.sort ?? "best-match",
      order: plan.sort ? "desc" : undefined,
      page: plan.page,
    });
    try {
      host.leads = acceptLeadPage(
        host.leads,
        plan,
        response.data,
        host.journal.started_at,
        path.join(host.runDir, `${name}.json`),
      );
    } catch (error) {
      if (!(error instanceof LeadSearchChanged)) throw error;
      // Keep independently validated positive identities, never the refused pagination.
      host.leads = retainLeadResults(
        host.leads,
        object(response.data).items as unknown[],
        host.journal.started_at,
        path.join(host.runDir, `${name}.json`),
        plan.family,
      );
      host.leads = restartLeadSlice(host.leads, plan, errorMessage(error));
      host.leadFamilies.add(plan.family);
      host.deferredLeadFamilies.add(plan.family);
      host.leads.next_family = advanceLeadFamily(host.leads.next_family);
      host.journal.notes.push({
        phase: "lead-search",
        status: "partial",
        error: errorMessage(error),
        query: plan.query,
        page: plan.page,
        evidence: path.join(host.runDir, `${name}.json`),
        resume:
          "Discard failed pagination and recollect this fixed slice on a later admitted run; no same-run retry",
      });
      host.persist();
      continue;
    }
    host.leadFamilies.add(plan.family);
    host.leadPages++;
    idleTurns = 0;
    host.persist();
  }
  for (const lead of pendingLeads(host.leads, host.knownLeadUrls())
    .filter(
      (r) =>
        !r.release_hint ||
        Date.parse(host.journal.started_at) - Date.parse(r.release_hint.observed_at) >=
          7 * 86400000,
    )
    .slice(0, 4)) {
    if (host.budget.remaining().requests < 17 || host.budget.remaining().bytes < 1024 * 1024) break;
    const response = await host.source.sdk.request({
      method: "GET",
      url: new URL(`repos/${lead.repository}/releases?per_page=5`, "https://api.github.com/").href,
    });
    if (!Array.isArray(response.data)) throw new Error("Malformed lead release hints");
    const name = `lead-release-hint-${lead.id}`;
    host.save(name, response.data);
    lead.release_hint = {
      assets_observed: response.data.some((raw: unknown) => {
        const release = object(raw);
        return (
          release.draft === false &&
          Array.isArray(release.assets) &&
          release.assets.some((raw: unknown) => {
            const asset = object(raw);
            return (
              asset.state === "uploaded" &&
              typeof asset.name === "string" &&
              /\.(?:zip|tar\.gz|AppImage|exe|msi|dmg)$/iu.test(asset.name)
            );
          })
        );
      }),
      observed_at: host.journal.started_at,
      evidence: path.join(host.runDir, `${name}.json`),
    };
    host.persist();
  }
  host.persist();
  return host.leadSummary();
}

/** One collection pass: curated lists, lead searches, then reviewed source collectors. */
export async function collectDiscoveryRun(host: DiscoveryCollectionHost) {
  if (host.journal.collection_done)
    throw new Error("Source collection already completed in this run");
  try {
    await collectExternalLeadLists(host);
  } catch (error) {
    // Curated hints are optional lead input; their failure never blocks collection.
    host.journal.notes.push({
      phase: "external-list",
      status: "partial",
      error: errorMessage(error),
      resume: "Retained hints are unchanged; retry on a later run",
    });
    host.persist();
  }
  await searchLeadFamilies(host);
  const reserve = host.budget.reserve;
  const pending = pendingLeads(host.leads, host.knownLeadUrls());
  if (pending.length) {
    const left = host.budget.remaining();
    host.budget.reserve = {
      requests: reserve.requests + Math.min(16, Math.max(0, left.requests)),
      bytes: reserve.bytes + Math.min(1024 * 1024, Math.max(0, left.bytes)),
    };
  }
  try {
    await collectDiscoverySources(host.source, host.checkpoint);
  } finally {
    host.budget.reserve = reserve;
  }
  host.checkpoint = advanceDiscovery(host.checkpoint, {
    observed_at: new Date().toISOString(),
    sources: host.journal.sources,
  });
  host.journal.collection_done = true;
  host.journal.coverage =
    host.journal.sources.some((s) => s.status !== "complete") || host.journal.notes.length
      ? "partial"
      : "complete";
  host.persist();
  return {
    sources: host.journal.sources.map((s) => ({
      id: s.id,
      status: s.status,
      next_path: s.next_path,
    })),
    pending: Object.keys(host.checkpoint.pending).length,
  };
}
