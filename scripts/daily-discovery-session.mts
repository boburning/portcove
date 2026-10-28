import { replacePreparedFileSync } from "./prepared-file-replacement.mts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runScopedDoctor, doctorFailureDiagnostics } from "./roadmap-scoped.mts";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { spawnSync } from "node:child_process";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { GitHubApiClient, GitHubApiError } from "./github-api.mts";
import {
  discoveryPost,
  recordDiscoveryComment,
  assertDiscoveryCommentMayPost,
} from "./discovery-mutation.mts";
import { readDiscoveryCache } from "./discovery-cache.mts";
import {
  RoadmapClient,
  runDoctor,
  fieldValue,
  portFieldInitialization,
  validateDurableIssueBody,
} from "./roadmap.mts";
import {
  findPortIssueDuplicates,
  sourceProvenancePortIssues,
  sourceProvenancePortIdentity,
  reconcilePortIssueMarkers,
  isNonCatalogResearchBody,
} from "./roadmap-issue.mts";
import type { RoadmapInventory, InventoryCache } from "./roadmap-inventory.mts";
import { collectRoadmapInventory, requireRoadmapInventory } from "./roadmap-inventory.mts";
import {
  DiscoveryBudget,
  selectDiscoveryProfile,
  createDiscoveryTransport,
} from "./discovery-budget.mts";
import {
  emptyCheckpoint,
  parseDiscoveryCheckpoint,
  advanceDiscovery,
  recordDisposition,
  rotatingRecheck,
  releaseFingerprint,
} from "./discovery-checkpoint.mts";
import type { DiscoveryCheckpoint } from "./discovery-checkpoint.mts";
import { observationHash } from "./upstream-observer.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { withCheckpointLock } from "./observe-configured-upstream.mts";
import {
  collectDiscoverySources,
  consumeConfiguredObserver,
  investigateDiscoveryUpstream,
  repoName,
} from "./daily-discovery-sources.mts";
import type { SourceContext, CollectedSource } from "./daily-discovery-sources.mts";
import {
  acceptLeadPage,
  nextLeadPage,
  parseLeadState,
  pendingLeads,
  leadPageSize,
  leadFamilyIds,
  advanceLeadFamily,
  leadSearchFamilyCount,
  retainLeadResults,
  LeadSearchChanged,
  restartLeadSlice,
} from "./discovery-leads.mts";
import type { LeadState } from "./discovery-leads.mts";
import { ecosystemBursts } from "./discovery-ecosystems.mts";
import { readCatalogSource } from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { fileURLToPath } from "node:url";
import {
  assertDiscoveryIntakeIdentity,
  discoveryGameKey,
  reviewedDiscoveryFamilyAliases,
} from "./discovery-intake-identity.mts";
import type { ReviewedDiscoveryIdentity } from "./discovery-reconciliation.mts";

interface Candidate {
  id: string;
  kind: "intake" | "comment";
  title: string;
  upstream: string;
  portKey: string;
  game?: string;
  identity_kind?: ReviewedDiscoveryIdentity["kind"];
  issue?: number;
  body: string;
  body_sha256: string;
  evidence_ids: string[];
  evidence_sha256: string;
  status: string;
  review?: unknown;
  created_issue?: number;
  created_comment?: number;
  itemId?: string;
  readback?: string;
  pending_ids?: string[];
  hold?: { reason: string; resume: string };
  superseded_by?: string;
  amendment?: { expected_body_sha256: string; status: "prepared" | "attempted" | "applied" };
  reconciliation?: { snapshot_sha256: string; evidence: string; doctor: string; review?: unknown };
}
interface Evidence {
  repository: string;
  material: string;
  file: string;
  requests: number;
  bytes: number;
  url?: string;
  observed_at?: string;
}
interface Journal {
  format: 1;
  run_id: string;
  started_at: string;
  status: string;
  collection_done: boolean;
  delivery: string;
  coverage: string;
  sources: CollectedSource[];
  candidates: Record<string, Candidate>;
  evidence: Record<string, Evidence>;
  notes: unknown[];
  doctor?: unknown;
  doctors?: unknown[];
  global_doctor_pending?: boolean;
  baseline_completed_at?: string;
  checkpoint?: DiscoveryCheckpoint;
  checkpoint_preimage?: string;
  backoff_until?: string;
  lead_state?: LeadState;
  research_progress?: Record<string, unknown>;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error("Expected structured discovery message");
  return v;
};
const text = (v: unknown) => {
  if (typeof v !== "string" || !v) throw new Error("Missing discovery message text");
  return v;
};
export function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.next`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
  replacePreparedFileSync(temp, file);
}
const discoveryMaterial = (v: ReturnType<typeof investigateDiscoveryUpstream>) =>
  observationHash({
    repository_id: v.metadata.id,
    repository: v.metadata.full_name,
    archived: v.metadata.archived,
    fork: v.metadata.fork,
    parent_id: isRecord(v.metadata.parent) ? v.metadata.parent.id : null,
    selected: v.fingerprint,
    releases: releaseFingerprint(v.releases),
    readme_blob: v.readme.blob,
    manifest: v.manifest ?? null,
    manifest_evidence: v.manifest_evidence,
  });
const material = discoveryMaterial;
export function discoveryInventoryCost(inventory: RoadmapInventory) {
  const items = [...inventory.items, ...inventory.archivedItems];
  const ids = new Set(inventory.issues.map((issue) => issue.id));
  const foreign = items.flatMap((item) =>
    item.content && !ids.has(item.content.id) ? [item.content] : [],
  );
  const dependencyPages = items.reduce((sum, item) => {
    const blockers = item.content?.blockedBy;
    return (
      sum +
      (isRecord(blockers) && typeof blockers.totalCount === "number" && blockers.totalCount > 10
        ? Math.ceil(blockers.totalCount / 100)
        : 0)
    );
  }, 0);
  const pages =
    Math.max(1, Math.ceil(inventory.issues.length / 100)) +
    Math.max(1, Math.ceil(items.length / 100)) +
    Math.ceil(foreign.length / 10) +
    dependencyPages +
    9; // Five repository markers, two Project revision reads, details and fields.
  const thin =
    Buffer.byteLength(
      JSON.stringify(
        items.map((i) => ({
          ...i,
          content: i.content ? { ...i.content, body: undefined } : null,
        })),
      ),
    ) +
    Buffer.byteLength(JSON.stringify(inventory.issues.map((i) => ({ ...i, body: undefined })))) +
    Buffer.byteLength(JSON.stringify(foreign.map((issue) => issue.body)));
  return { requests: pages, bytes: thin };
}
export function discoveryDeliveryCost(
  inventory: RoadmapInventory,
  candidates: readonly { body: string; requests?: number; bytes?: number; amendment?: unknown }[],
) {
  const { requests: pages, bytes: thin } = discoveryInventoryCost(inventory);
  const requests =
    (candidates.length + 1) * pages +
    candidates.length * 8 +
    candidates.filter((c) => c.amendment).length * 3 +
    4 +
    candidates.reduce((s, c) => s + (c.requests ?? 0), 0);
  const bytes =
    (candidates.length + 1) * thin +
    candidates.reduce((s, c) => s + Buffer.byteLength(c.body) * 4 + (c.bytes ?? 0), 0) +
    512 * 1024;
  return {
    // Preserve the existing margin or a whole additional thin inventory, whichever is larger.
    requests: Math.ceil(Math.max(requests * 1.25, requests + pages)),
    bytes: Math.ceil(Math.max(bytes * 1.25, bytes + thin)),
  };
}
export function intakeAmendmentAction(
  body: string,
  current: string,
  amendment: Candidate["amendment"],
) {
  if (current === body) return "observed";
  if (!amendment || observationHash(current) !== amendment.expected_body_sha256)
    throw new Error("Retained intake body changed; preserve and reconcile");
  if (amendment.status !== "prepared")
    throw new Error("Unconfirmed amendment requires readback; no repeated write");
  return "patch";
}
export function validateDiscoveryIntakeBody(body: string, upstream: string, portKey: string) {
  validateDurableIssueBody(body);
  if (reconcilePortIssueMarkers(body, { upstream, portKey }) !== body)
    throw new Error("Intake requires the maintained canonical body markers before delivery");
  if (!isNonCatalogResearchBody(body))
    throw new Error(
      "Intake requires canonical research/watchlist metadata and a support disclaimer before delivery",
    );
}
export class DiscoverySession {
  private intakeRecords?: AuthoredPort[];
  inventory!: RoadmapInventory;
  checkpoint: DiscoveryCheckpoint;
  readonly journal: Journal;
  readonly budget: DiscoveryBudget;
  readonly client: RoadmapClient;
  readonly source: SourceContext;
  readonly checkpointPreimage: string;
  readonly journalFile: string;
  wrote = false;
  inventoryStarted = false;
  inventoryRecollections = 0;
  inventoryCache: InventoryCache | undefined;
  searches = 0;
  intakeAttempts = 0;
  quietAttempts = 0;
  deepInvestigations = 0;
  readonly stateDir: string;
  readonly runDir: string;
  readonly head: string;
  leads: LeadState;
  leadPages = 0;
  leadFamilies = new Set<string>();
  deferredLeadFamilies = new Set<string>();
  researchedLeads = new Set<number>();
  leadCollectionAttempted = false;
  constructor(
    stateDir: string,
    runDir: string,
    config: ConstructorParameters<typeof RoadmapClient>[0],
    token: string,
    startedAt: string,
    head: string,
  ) {
    this.stateDir = stateDir;
    this.runDir = runDir;
    this.head = head;
    const leadFile = path.join(stateDir, "leads.json");
    this.leads = parseLeadState(
      existsSync(leadFile) ? JSON.parse(readFileSync(leadFile, "utf8")) : undefined,
    );
    const checkpointFile = path.join(stateDir, "checkpoint.json");
    this.checkpoint = existsSync(checkpointFile)
      ? parseDiscoveryCheckpoint(JSON.parse(readFileSync(checkpointFile, "utf8")))
      : emptyCheckpoint();
    this.checkpointPreimage = observationHash(this.checkpoint);
    const cacheFile = path.join(stateDir, "inventory.json");
    const cache = readDiscoveryCache(
      cacheFile,
      path.join(runDir, `invalid-inventory-${randomUUID()}.json`),
    );
    this.inventoryCache = cache;
    const profile = selectDiscoveryProfile(cache);
    this.budget = new DiscoveryBudget(profile, (usage) =>
      atomic(path.join(runDir, "budget.json"), usage),
    );
    this.budget.usage.started_at = startedAt;
    this.journalFile = path.join(stateDir, "active-run.json");
    const previous: unknown = existsSync(this.journalFile)
      ? JSON.parse(readFileSync(this.journalFile, "utf8"))
      : undefined;
    if (
      previous !== undefined &&
      (!isRecord(previous) ||
        previous.format !== 1 ||
        !isRecord(previous.candidates) ||
        !isRecord(previous.evidence))
    )
      throw new Error("Unrecognized interrupted journal; preserve and reconcile");
    this.journal = {
      format: 1,
      run_id: path.basename(runDir),
      started_at: startedAt,
      status: "running",
      collection_done: false,
      delivery: "none",
      coverage: "unknown",
      sources: [],
      research_progress:
        isRecord(previous) && previous.research_progress !== undefined
          ? object(previous.research_progress)
          : {},
      candidates:
        previous === undefined ? {} : (object(previous).candidates as Record<string, Candidate>),
      evidence:
        previous === undefined ? {} : (object(previous).evidence as Record<string, Evidence>),
      notes: [],
      ...(isRecord(previous) && previous.global_doctor_pending === true
        ? { global_doctor_pending: true }
        : {}),
      ...(isRecord(previous) && Array.isArray(previous.doctors)
        ? { doctors: previous.doctors }
        : {}),
      ...(isRecord(cache) && typeof cache.baseline_completed_at === "string"
        ? { baseline_completed_at: cache.baseline_completed_at }
        : {}),
    };
    if (isRecord(previous) && previous.lead_state !== undefined)
      this.leads = parseLeadState(previous.lead_state);
    for (const [id, raw] of Object.entries(this.journal.candidates)) {
      const c = object(raw);
      if (
        c.id !== id ||
        (c.kind !== "intake" && c.kind !== "comment") ||
        typeof c.body !== "string" ||
        observationHash(c.body) !== c.body_sha256 ||
        !Array.isArray(c.evidence_ids) ||
        !c.evidence_ids.every((e) => typeof e === "string" && this.journal.evidence[e]) ||
        observationHash(c.evidence_ids.map((e) => this.journal.evidence[String(e)]?.material)) !==
          c.evidence_sha256 ||
        typeof c.status !== "string" ||
        ![
          "prepared",
          "needs-research",
          "needs-review",
          "reviewed",
          "create-attempted",
          "created",
          "doctor-pending",
          "delivered",
          "held",
          "superseded",
        ].includes(c.status)
      )
        throw new Error("Interrupted candidate binding is invalid; preserve and reconcile");
      if (
        c.amendment !== undefined &&
        (!isRecord(c.amendment) ||
          c.kind !== "intake" ||
          !c.created_issue ||
          typeof c.amendment.expected_body_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(c.amendment.expected_body_sha256) ||
          !["prepared", "attempted", "applied"].includes(String(c.amendment.status)))
      )
        throw new Error("Interrupted amendment binding is invalid; preserve and reconcile");
      if (
        c.review !== undefined &&
        (!isRecord(c.review) ||
          c.review.verdict !== "clear" ||
          c.review.body_sha256 !== c.body_sha256 ||
          c.review.evidence_sha256 !== c.evidence_sha256)
      )
        throw new Error("Interrupted candidate review provenance does not match its body/evidence");
      if (c.reconciliation !== undefined) {
        const proof = object(c.reconciliation),
          approval = proof.review === undefined ? undefined : object(proof.review);
        if (
          c.status !== "delivered" ||
          c.kind !== "intake" ||
          !c.created_issue ||
          typeof proof.snapshot_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(proof.snapshot_sha256) ||
          (approval !== undefined &&
            (approval.snapshot_sha256 !== proof.snapshot_sha256 ||
              approval.verdict !== "clear" ||
              approval.model !== "gpt-6.1-sol" ||
              approval.reasoning !== "high" ||
              typeof approval.reviewer !== "string" ||
              !approval.reviewer.trim())) ||
          ![proof.evidence, proof.doctor].every(
            (file) =>
              typeof file === "string" &&
              path.resolve(file).startsWith(path.resolve(stateDir) + path.sep),
          )
        )
          throw new Error("Interrupted reconciliation binding is invalid; preserve and reconcile");
      }
      for (const evidenceId of c.evidence_ids) {
        const evidence = object(this.journal.evidence[String(evidenceId)]);
        if (
          typeof evidence.file !== "string" ||
          !path.resolve(evidence.file).startsWith(path.resolve(stateDir) + path.sep) ||
          typeof evidence.repository !== "string" ||
          typeof evidence.material !== "string" ||
          typeof evidence.requests !== "number" ||
          typeof evidence.bytes !== "number"
        )
          throw new Error("Interrupted evidence binding is invalid");
      }
    }
    if (
      isRecord(previous) &&
      previous.checkpoint_preimage === this.checkpointPreimage &&
      previous.checkpoint
    )
      this.checkpoint = parseDiscoveryCheckpoint(previous.checkpoint);
    if (isRecord(previous) && typeof previous.backoff_until === "string")
      this.budget.usage.backoff_until = previous.backoff_until;
    const http = createDiscoveryTransport(this.budget, token);
    this.client = new RoadmapClient(config, new GitHubApiClient(http.runner));
    this.source = {
      api: this.client.api,
      budget: this.budget,
      http,
      primaryProgress: { entries: this.journal.research_progress!, persist: () => this.persist() },
      acceptSource: (source) => {
        this.journal.sources = this.journal.sources.filter((value) => value.id !== source.id);
        this.journal.sources.push(source);
        this.checkpoint = advanceDiscovery(this.checkpoint, {
          observed_at: new Date().toISOString(),
          sources: [source],
        });
        this.persist();
      },
      save: (name, value) => this.save(name, value),
    };
  }
  save(name: string, value: unknown) {
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name)) throw new Error("Unsafe evidence name");
    atomic(path.join(this.runDir, `${name}.json`), value);
  }
  persist() {
    this.journal.lead_state = this.leads;
    this.journal.checkpoint = this.checkpoint;
    this.journal.checkpoint_preimage = this.checkpointPreimage;
    if (this.budget.usage.backoff_until)
      this.journal.backoff_until = this.budget.usage.backoff_until;
    atomic(this.journalFile, this.journal);
    this.save("journal", this.journal);
    // Evidence references become visible only after their recoverable journal binding.
    atomic(path.join(this.stateDir, "leads.json"), this.leads);
  }
  checkProviderCapacity(requests: number) {
    const response = this.client.api.request("GET", "rate_limit");
    this.save(`provider-admission-${this.budget.usage.requests}`, response.body);
    const resources = object(object(response.body).resources);
    for (const resource of ["core", "graphql"] as const) {
      const quota = object(resources[resource]);
      if (typeof quota.remaining !== "number" || typeof quota.reset !== "number")
        throw new Error(`GitHub ${resource} capacity unknown`);
      this.budget.observeProvider({
        resource,
        remaining: quota.remaining,
        resetAt: new Date(quota.reset * 1000).toISOString(),
      });
    }
    this.budget.requireProviderCapacity(requests);
  }
  refresh() {
    const file = path.join(this.stateDir, "inventory.json");
    const old = this.inventoryCache;
    const collect = () =>
      collectRoadmapInventory(
        this.client,
        this.budget.usage.profile === "cold" && !this.inventoryStarted ? undefined : old,
      );
    const started = this.budget.usage.requests;
    try {
      this.inventory = collect();
    } catch (error) {
      if (
        !(error instanceof GitHubApiError) ||
        error.code !== "inventory_changed" ||
        this.inventoryRecollections !== 0
      )
        throw error;
      this.inventoryRecollections++;
      const observation = {
        phase: "inventory-recollection",
        allowance: this.inventoryRecollections,
        first: {
          error: errorMessage(error),
          requests_before: started,
          requests_after: this.budget.usage.requests,
        },
        second: {
          requests_before: this.budget.usage.requests,
          requests_after: this.budget.usage.requests,
          status: "pending",
          error: "",
        },
      };
      this.journal.notes.push(observation);
      this.persist();
      try {
        if (this.inventory) {
          // The batch reserve already includes this one replacement inventory.
          // Do not require another doctor plus another recollection reserve here.
          const cost = discoveryInventoryCost(this.inventory);
          this.budget.admit(cost.requests, cost.bytes);
        } else this.budget.admit(1, 1);
        this.client._completeProjectContext = undefined;
        this.client._projectContext = undefined;
        this.inventory = collect();
        observation.second.status = "complete";
      } catch (second) {
        observation.second.status = "failed";
        observation.second.error = errorMessage(second);
        throw second;
      } finally {
        observation.second.requests_after = this.budget.usage.requests;
        this.persist();
      }
    }
    this.inventoryCache = this.inventory;
    this.inventoryStarted = true;
    if (this.budget.usage.profile === "cold")
      this.journal.baseline_completed_at = new Date().toISOString();
    atomic(file, {
      ...this.inventory,
      items: undefined,
      archivedItems: undefined,
      baseline_completed_at: this.journal.baseline_completed_at,
    });
    const baselineFile = path.join(this.stateDir, "canonical-baseline.json");
    const prior = existsSync(baselineFile)
      ? object(JSON.parse(readFileSync(baselineFile, "utf8")))
      : {};
    const priorRecords = Array.isArray(prior.records) ? prior.records.map(object) : [];
    atomic(baselineFile, {
      ...prior,
      observed_at: this.inventory.observed_at,
      coverage:
        "Complete live repository issues and explicit active/archived Project inventory; identity cache only",
      records: sourceProvenancePortIssues(this.inventory.issues).map((issue) => {
        const saved = priorRecords.find(
          (record) => record.number === issue.number && record.url === issue.url,
        );
        const identity = sourceProvenancePortIdentity(issue);
        const history: unknown[] = Array.isArray(saved?.identity_history)
          ? Array.from(saved.identity_history as readonly unknown[])
          : [];
        if (saved?.identity && observationHash(saved.identity) !== observationHash(identity))
          history.push({ observed_at: prior.observed_at, identity: saved.identity });
        return {
          ...saved,
          number: issue.number,
          url: issue.url,
          node_id: issue.id,
          updated_at: issue.updatedAt,
          identity,
          identity_history: history,
        };
      }),
    });
    atomic(path.join(this.stateDir, "project-items.json"), [
      ...this.inventory.items,
      ...this.inventory.archivedItems,
    ]);
    return this.inventory;
  }
  start() {
    this.checkProviderCapacity(this.budget.limits.requests);
    this.refresh();
    for (const id of [177, 1422]) {
      const issue = this.client.repositoryIssue(id);
      this.save(`authority-${id}`, issue);
      const comments = this.client.api.paginateRest(
        `repos/${this.client.config.repository}/issues/${id}/comments?per_page=20`,
        { identity: (v) => object(v).id, label: `owner ${id} amendments` },
      );
      this.save(`authority-${id}-comments`, comments);
    }
    try {
      const observer = consumeConfiguredObserver(this.source);
      this.journal.sources.push(observer);
      this.checkpoint = advanceDiscovery(this.checkpoint, {
        observed_at: new Date().toISOString(),
        sources: [observer],
      });
    } catch (e) {
      this.journal.notes.push({
        source: "configured-observer",
        status: "partial",
        error: errorMessage(e),
      });
    }
    const cost = discoveryDeliveryCost(
      this.inventory,
      Object.values(this.journal.candidates)
        .filter((c) => !["delivered", "held", "superseded"].includes(c.status))
        .slice(0, 1),
    );
    this.budget.reserveDelivery(cost.requests, cost.bytes);
    this.persist();
    return {
      phase: "ready",
      run_id: this.journal.run_id,
      profile: this.budget.usage.profile,
      pending: Object.keys(this.checkpoint.pending).length,
      candidates: Object.values(this.journal.candidates).map((c) => ({
        id: c.id,
        status: c.status,
        issue: c.created_issue,
      })),
      remaining: this.budget.remaining(),
      leads: this.leadSummary(),
      next: "Recover unfinished candidates, collect/discover, research and dispose leads before recheck, propose, apply, finish",
    };
  }
  research(repository: string) {
    this.budget.admit(1, 1);
    this.deepInvestigations++;
    const before = { requests: this.budget.usage.requests, bytes: this.budget.usage.bytes };
    const data = investigateDiscoveryUpstream(this.source, repoName(repository));
    const fingerprint = material(data);
    const id = observationHash({ repository: data.metadata.id, material: fingerprint });
    const file = path.join(this.runDir, `research-${id}.json`);
    atomic(file, data);
    this.journal.evidence[id] = {
      repository: repoName(data.metadata.full_name),
      material: fingerprint,
      file,
      requests: this.budget.usage.requests - before.requests,
      bytes: this.budget.usage.bytes - before.bytes,
      observed_at: data.observed_at ?? this.journal.started_at,
    };
    delete this.journal.research_progress![repoName(data.metadata.full_name).toLowerCase()];
    const lead = this.leads.records[String(data.metadata.id)];
    if (lead) {
      if (lead.repository.toLowerCase() !== text(data.metadata.full_name).toLowerCase())
        throw new Error("Lead repository relocation needs continuity review");
      lead.status = "researched";
      lead.research = { evidence_id: id, file, material: fingerprint };
      if (data.manifest) lead.manifest = data.manifest;
      else delete lead.manifest;
      if (!this.knownLeadUrls().has(lead.url.toLowerCase())) this.researchedLeads.add(lead.id);
    }
    this.persist();
    return { id, file, material: fingerprint };
  }
  search(query: string) {
    if (query.length > 500) throw new Error("Lead-search query bound exceeded");
    this.budget.admit(1, 1);
    this.searches++;
    const response = this.source.api.request(
      "GET",
      `search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=${leadPageSize}`,
    );
    this.save(`lead-search-${this.searches}`, response.body);
    const rows = object(response.body).items;
    if (!Array.isArray(rows)) throw new Error("Malformed lead search response");
    this.leads = retainLeadResults(
      this.leads,
      rows,
      this.journal.started_at,
      path.join(this.runDir, `lead-search-${this.searches}.json`),
    );
    this.journal.notes.push({
      source: "primary-leads",
      scope: "One bounded repository-search page; no absence or complete community coverage claim",
      query,
      evidence: path.join(this.runDir, `lead-search-${this.searches}.json`),
    });
    this.persist();
    return { file: path.join(this.runDir, `lead-search-${this.searches}.json`) };
  }
  knownLeadUrls() {
    return new Set(
      sourceProvenancePortIssues(this.inventory.issues).flatMap((issue) =>
        sourceProvenancePortIdentity(issue).upstreams.map((url) => url.toLowerCase()),
      ),
    );
  }
  leadSummary() {
    // Startup can fail before the first validated inventory. Retain the saved
    // queue without interpreting a stale cache as current canonical overlap.
    const pending = this.inventory ? pendingLeads(this.leads, this.knownLeadUrls()) : undefined;
    return {
      searched_pages: this.leadPages,
      pending_families: leadFamilyIds.filter((id) => !this.leadFamilies?.has(id)),
      observed_families: [...(this.leadFamilies ?? [])],
      deferred_families: [...(this.deferredLeadFamilies ?? [])],
      investigated: [...this.researchedLeads],
      canonical_overlap: this.inventory ? "observed" : "unknown",
      pending: pending?.length ?? null,
      next: pending?.slice(0, 12) ?? [],
      continuations: this.leads.slices,
      ecosystem_bursts: ecosystemBursts(Object.values(this.leads.records), this.journal.started_at),
      scope: "Bounded GitHub lead searches; not complete community discovery",
    };
  }
  discover() {
    if (this.leadCollectionAttempted) return this.leadSummary();
    this.leadCollectionAttempted = true;
    this.leadFamilies ??= new Set();
    this.deferredLeadFamilies ??= new Set();
    // A full idle rotation terminates even when every family is current, capped or
    // deferred. Successful pages reset it; request/time/byte admission bounds work.
    let idleTurns = 0;
    while (idleTurns < leadSearchFamilyCount) {
      idleTurns++;
      const plan = nextLeadPage(this.leads, this.journal.started_at);
      if (this.deferredLeadFamilies.has(plan.family)) {
        this.leads.next_family = advanceLeadFamily(this.leads.next_family);
        continue;
      }
      if (plan.current) {
        this.leadFamilies.add(plan.family);
        this.leads.next_family = advanceLeadFamily(this.leads.next_family);
        continue;
      }
      if (plan.capped) {
        this.leadFamilies.add(plan.family);
        this.journal.notes.push({
          phase: "lead-search",
          status: "capped",
          ...plan,
          resume:
            "Narrow this capped time slice before a fresh bounded search; no complete coverage claim",
        });
        this.leads.next_family = advanceLeadFamily(this.leads.next_family);
        this.persist();
        continue;
      }
      // Leave bounded capacity for two upstream investigations as well as the existing delivery reserve.
      if (this.budget.remaining().requests < 17 || this.budget.remaining().bytes < 1024 * 1024) {
        this.journal.notes.push({
          phase: "lead-search",
          status: "deferred",
          ...plan,
          resume: "Continue this exact query/page on the next admitted run before quiet rotation",
        });
        break;
      }
      this.budget.admit(1, 1);
      const response = this.source.api.request(
        "GET",
        `search/repositories?q=${encodeURIComponent(plan.query)}&per_page=${leadPageSize}&page=${plan.page}${plan.sort ? `&sort=${plan.sort}&order=desc` : ""}`,
      );
      const name = `lead-search-${++this.searches}`;
      this.save(name, {
        ...object(response.body),
        query: plan.query,
        sort: plan.sort ?? "best-match",
        order: plan.sort ? "desc" : undefined,
        page: plan.page,
      });
      try {
        this.leads = acceptLeadPage(
          this.leads,
          plan,
          response.body,
          this.journal.started_at,
          path.join(this.runDir, `${name}.json`),
        );
      } catch (error) {
        if (!(error instanceof LeadSearchChanged)) throw error;
        // Keep independently validated positive identities, never the refused pagination.
        this.leads = retainLeadResults(
          this.leads,
          object(response.body).items as unknown[],
          this.journal.started_at,
          path.join(this.runDir, `${name}.json`),
          plan.family,
        );
        this.leads = restartLeadSlice(this.leads, plan, errorMessage(error));
        this.leadFamilies.add(plan.family);
        this.deferredLeadFamilies.add(plan.family);
        this.leads.next_family = advanceLeadFamily(this.leads.next_family);
        this.journal.notes.push({
          phase: "lead-search",
          status: "partial",
          error: errorMessage(error),
          query: plan.query,
          page: plan.page,
          evidence: path.join(this.runDir, `${name}.json`),
          resume:
            "Discard failed pagination and recollect this fixed slice on a later admitted run; no same-run retry",
        });
        this.persist();
        continue;
      }
      this.leadFamilies.add(plan.family);
      this.leadPages++;
      idleTurns = 0;
      this.persist();
    }
    for (const lead of pendingLeads(this.leads, this.knownLeadUrls())
      .filter(
        (r) =>
          !r.release_hint ||
          Date.parse(this.journal.started_at) - Date.parse(r.release_hint.observed_at) >=
            7 * 86400000,
      )
      .slice(0, 4)) {
      if (this.budget.remaining().requests < 17 || this.budget.remaining().bytes < 1024 * 1024)
        break;
      const response = this.source.api.request(
        "GET",
        `repos/${lead.repository}/releases?per_page=5`,
      );
      if (!Array.isArray(response.body)) throw new Error("Malformed lead release hints");
      const name = `lead-release-hint-${lead.id}`;
      this.save(name, response.body);
      lead.release_hint = {
        assets_observed: response.body.some((raw: unknown) => {
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
        observed_at: this.journal.started_at,
        evidence: path.join(this.runDir, `${name}.json`),
      };
      this.persist();
    }
    this.persist();
    return this.leadSummary();
  }
  disposeLead(raw: unknown) {
    const v = object(raw),
      id = text(v.evidence_id),
      evidence = this.journal.evidence[id];
    const lead = Object.values(this.leads.records).find((r) => r.research?.evidence_id === id);
    if (
      !lead ||
      lead.status !== "researched" ||
      !evidence ||
      !evidence.observed_at ||
      !Number.isFinite(Date.parse(evidence.observed_at)) ||
      Date.parse(this.journal.started_at) - Date.parse(evidence.observed_at) >= 7 * 86400000 ||
      evidence.repository.toLowerCase() !== lead.repository.toLowerCase() ||
      !["held", "no-change", "canonical"].includes(text(v.outcome))
    )
      throw new Error("Lead disposition needs its matching investigated provider identity");
    if (v.outcome === "canonical" && !this.knownLeadUrls().has(lead.url.toLowerCase()))
      throw new Error("Canonical lead disposition requires current canonical source identity");
    const outcome = text(v.outcome);
    if (outcome !== "held" && outcome !== "no-change" && outcome !== "canonical")
      throw new Error("Invalid lead disposition");
    lead.status = outcome;
    lead.disposition = { reason: text(v.reason), resume: text(v.resume) };
    lead.checked_at = this.journal.started_at;
    if (!this.knownLeadUrls().has(lead.url.toLowerCase())) this.researchedLeads.add(lead.id);
    this.persist();
    return lead;
  }
  readPrimary(repository: string, url: string) {
    const binding = repoName(repository);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash)
      throw new Error("Primary evidence requires credential-free HTTPS");
    const before = { requests: this.budget.usage.requests, bytes: this.budget.usage.bytes };
    const response = this.source.http.request("GET", parsed.href);
    if (response.status !== 200) throw new Error("Primary source unavailable");
    const fingerprint = observationHash(response.text);
    const id = observationHash({ url: parsed.href, fingerprint });
    const file = path.join(this.runDir, `primary-${id}.json`);
    atomic(file, { url: parsed.href, response });
    this.journal.evidence[id] = {
      repository: binding,
      material: fingerprint,
      file,
      url: parsed.href,
      requests: this.budget.usage.requests - before.requests,
      bytes: this.budget.usage.bytes - before.bytes,
    };
    this.persist();
    return { id, file };
  }
  propose(raw: unknown) {
    const v = object(raw);
    if (v.kind !== "intake" && v.kind !== "comment")
      throw new Error("Only neutral intake or material comment is authorized");
    const upstream = new URL(text(v.upstream));
    if (
      upstream.origin !== "https://github.com" ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash
    )
      throw new Error("Candidate needs exact GitHub upstream");
    repoName(upstream.pathname.slice(1));
    if (
      !Array.isArray(v.evidence_ids) ||
      !v.evidence_ids.length ||
      v.evidence_ids.some((id) => typeof id !== "string" || !this.journal.evidence[id])
    )
      throw new Error("Candidate needs observed primary evidence");
    const evidenceIds = [...new Set(v.evidence_ids as string[])].sort();
    const evidenceHash = observationHash(
      evidenceIds.map((id) => this.journal.evidence[id]?.material),
    );
    const body = text(v.body);
    if (Buffer.byteLength(body) > 65536) throw new Error("Candidate body too large");
    const key = text(v.portKey);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key) || key.length > 100)
      throw new Error("Invalid durable target key");
    if (
      v.game !== undefined &&
      (typeof v.game !== "string" || !v.game.trim() || v.game.length > 256)
    )
      throw new Error("Invalid reviewed game identity");
    if (
      v.identity_kind !== undefined &&
      (typeof v.identity_kind !== "string" ||
        !["implementation", "helper", "framework"].includes(v.identity_kind))
    )
      throw new Error("Invalid reviewed architecture disposition");
    const id = observationHash({
      kind: v.kind,
      upstream: upstream.href,
      key,
      evidence: evidenceHash,
      issue: v.issue,
      game: v.game,
      identity_kind: v.identity_kind,
    });
    if (this.journal.candidates[id]) return this.journal.candidates[id];
    const identityMarker =
      v.kind === "intake"
        ? `\n<!-- portcove-discovery-identity:${observationHash({ game: v.game ?? null, kind: v.identity_kind ?? "implementation" })} -->`
        : "";
    const marked = `<!-- portcove-discovery-${v.kind}:${id} -->${identityMarker}\n\n${body}`;
    if (v.kind === "intake") {
      validateDiscoveryIntakeBody(marked, upstream.href, key);
    }
    const candidate: Candidate = {
      id,
      kind: v.kind,
      title: text(v.title),
      upstream: upstream.href,
      portKey: key,
      body: marked,
      body_sha256: observationHash(marked),
      evidence_ids: evidenceIds,
      evidence_sha256: evidenceHash,
      status: "prepared",
      ...(typeof v.game === "string" ? { game: v.game } : {}),
      ...(v.identity_kind !== undefined
        ? { identity_kind: v.identity_kind as ReviewedDiscoveryIdentity["kind"] }
        : {}),
    };
    if (v.pending_ids !== undefined) {
      if (
        !Array.isArray(v.pending_ids) ||
        v.pending_ids.some((id) => typeof id !== "string" || !this.checkpoint.pending[id])
      )
        throw new Error("Candidate pending observations are unknown");
      candidate.pending_ids = v.pending_ids as string[];
    }
    if (v.kind === "comment") {
      if (typeof v.issue !== "number" || !Number.isSafeInteger(v.issue) || v.issue < 1)
        throw new Error("Comment needs canonical issue");
      candidate.issue = v.issue;
    }
    if (
      !evidenceIds.some(
        (id) =>
          this.journal.evidence[id]?.repository.toLowerCase() ===
          upstream.pathname.slice(1).toLowerCase(),
      )
    )
      throw new Error("Candidate upstream is not bound to investigated identity");
    if (candidate.kind === "intake") this.assertIntakeIdentity(candidate);
    const reserve = discoveryDeliveryCost(
      this.inventory,
      [
        ...Object.values(this.journal.candidates).filter(
          (c) =>
            !(
              c.upstream === candidate.upstream &&
              c.kind === candidate.kind &&
              c.portKey === candidate.portKey &&
              ["prepared", "needs-review", "needs-research", "held"].includes(c.status)
            ),
        ),
        candidate,
      ]
        .filter((c) => !["delivered", "held", "superseded"].includes(c.status))
        .slice(0, 1)
        .map((c) => ({
          ...c,
          requests: c.evidence_ids.reduce(
            (sum, id) => sum + (this.journal.evidence[id]?.requests ?? 0),
            0,
          ),
          bytes: c.evidence_ids.reduce(
            (sum, id) => sum + (this.journal.evidence[id]?.bytes ?? 0),
            0,
          ),
        })),
    );
    this.budget.reserveDelivery(reserve.requests, reserve.bytes);
    for (const old of Object.values(this.journal.candidates))
      if (
        old.upstream === candidate.upstream &&
        old.kind === candidate.kind &&
        old.portKey === candidate.portKey &&
        ["prepared", "needs-review", "needs-research", "held"].includes(old.status) &&
        !old.created_issue
      ) {
        old.status = "superseded";
        old.superseded_by = id;
      }
    this.journal.candidates[id] = candidate;
    this.save(`candidate-${id}`, candidate);
    this.persist();
    return candidate;
  }
  assertIntakeIdentity(
    candidate: Candidate,
    records = (this.intakeRecords ??= readCatalogSource(
      fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
    ).records),
  ) {
    const markers = candidate.body.match(/<!-- portcove-discovery-identity:[^>]*-->/gu) ?? [];
    const expected = `<!-- portcove-discovery-identity:${observationHash({ game: candidate.game ?? null, kind: candidate.identity_kind ?? "implementation" })} -->`;
    if (
      markers.length > 1 ||
      (markers.length === 1 && markers[0] !== expected) ||
      (!markers.length && (candidate.game !== undefined || candidate.identity_kind !== undefined))
    )
      throw new Error(
        "Prepared body does not bind the game/architecture identity; prepare a fresh proposal",
      );
    const primary = candidate.evidence_ids
      .map((id) => this.journal.evidence[id])
      .filter(
        (value) =>
          value &&
          !value.url &&
          value.repository.toLowerCase() ===
            new URL(candidate.upstream).pathname.slice(1).toLowerCase(),
      )
      .map((value) => object(JSON.parse(readFileSync(value!.file, "utf8"))));
    if (
      primary.some(
        (value) =>
          repoName(object(value.metadata).full_name).toLowerCase() !==
          new URL(candidate.upstream).pathname.slice(1).toLowerCase(),
      )
    )
      throw new Error("Primary repository identity no longer matches reviewed upstream");
    const ids = [...new Set(primary.map((value) => object(value.metadata).id))];
    if (
      ids.length !== 1 ||
      typeof ids[0] !== "number" ||
      !Number.isSafeInteger(ids[0]) ||
      ids[0] <= 0
    )
      throw new Error("Intake needs a primary-researched immutable repository identity");
    const result = assertDiscoveryIntakeIdentity(
      {
        repository: new URL(candidate.upstream).pathname.slice(1),
        repository_id: ids[0],
        kind: candidate.identity_kind ?? "implementation",
        ...(candidate.game ? { game_key: discoveryGameKey(candidate.game) } : {}),
      },
      this.inventory.issues,
      records,
      Object.values(this.leads.records),
    );
    for (const alias of reviewedDiscoveryFamilyAliases(candidate.body))
      assertDiscoveryIntakeIdentity(
        {
          ...alias,
          kind: "implementation",
          ...(candidate.game ? { game_key: discoveryGameKey(candidate.game) } : {}),
        },
        this.inventory.issues,
        records,
        Object.values(this.leads.records),
      );
    return result;
  }
  review(raw: unknown) {
    const v = object(raw),
      c = this.journal.candidates[text(v.candidate_id)];
    if (
      !c ||
      !["prepared", "needs-review"].includes(c.status) ||
      v.verdict !== "clear" ||
      v.model !== "gpt-6.1-sol" ||
      v.reasoning !== "high" ||
      v.reviewer === "daily-discovery-runner" ||
      typeof v.reviewer !== "string" ||
      !v.reviewer ||
      v.body_sha256 !== c.body_sha256 ||
      v.evidence_sha256 !== c.evidence_sha256
    )
      throw new Error("Separate review does not match current candidate/evidence");
    c.review = v;
    c.status = "reviewed";
    this.persist();
    return { id: c.id, status: c.status };
  }
  hold(raw: unknown) {
    const v = object(raw),
      c = this.journal.candidates[text(v.candidate_id)];
    if (
      !c ||
      !["prepared", "needs-review", "needs-research", "reviewed", "held"].includes(c.status) ||
      c.created_issue
    )
      throw new Error("Only a candidate without an unresolved public mutation can be held");
    c.status = "held";
    c.hold = { reason: text(v.reason), resume: text(v.resume) };
    this.persist();
    return { id: c.id, status: c.status, hold: c.hold };
  }
  async reconcile(raw: unknown) {
    const v = object(raw),
      c = this.journal.candidates[text(v.candidate_id)];
    if (!c || c.kind !== "intake" || !c.created_issue)
      throw new Error("Reconciliation requires a retained created intake");
    if (c.status === "delivered" && c.reconciliation)
      return { reconciled: c.id, already_completed: true };
    const unappliedAmendment = c.status === "needs-research" && c.amendment?.status === "prepared";
    if (!unappliedAmendment && (!["created", "doctor-pending"].includes(c.status) || c.amendment))
      throw new Error("Reconciliation requires an unamended pending intake");
    const snapshot = () => {
      if (
        unappliedAmendment &&
        (c.status !== "needs-research" || c.amendment?.status !== "prepared")
      )
        throw new Error("Unapplied amendment state changed; preserve mutation evidence");
      requireRoadmapInventory(this.inventory, this.client.config.repository, this.client);
      const issue = this.inventory.issues.find((row) => row.number === c.created_issue);
      const matches = findPortIssueDuplicates(this.inventory.issues, c);
      const identity = issue && sourceProvenancePortIdentity(issue);
      const markers = issue?.body?.match(/<!--\s*portcove-discovery-intake:[^>]*-->/gu) ?? [];
      if (
        !issue ||
        markers.length !== 1 ||
        markers[0] !== `<!-- portcove-discovery-intake:${c.id} -->` ||
        matches.length !== 1 ||
        matches[0]?.issue.id !== issue.id ||
        identity?.portKeys.length !== 1 ||
        identity.portKeys[0] !== c.portKey ||
        identity.upstreams.length !== 1 ||
        identity.upstreams[0] !== c.upstream.toLowerCase()
      )
        throw new Error("Retained intake canonical identity is ambiguous or changed");
      const items = [...this.inventory.items, ...this.inventory.archivedItems].filter(
        (item) => item.content?.id === issue.id,
      );
      const item = items[0];
      if (
        items.length !== 1 ||
        !item ||
        item.isArchived !== false ||
        (c.itemId && c.itemId !== item.id)
      )
        throw new Error("Retained intake Project identity or archive state changed");
      return {
        candidate_id: c.id,
        original_body_sha256: c.body_sha256,
        original_evidence_sha256: c.evidence_sha256,
        ...(unappliedAmendment ? { unapplied_amendment: c.amendment } : {}),
        issue,
        item,
      };
    };
    const review = v.review === undefined ? undefined : object(v.review);
    const expectedSnapshot = v.snapshot_sha256 ?? review?.snapshot_sha256;
    if (expectedSnapshot === undefined) {
      const observed = snapshot(),
        hash = observationHash(observed);
      this.save(`reconcile-${hash}`, observed);
      return { snapshot_sha256: hash, file: path.join(this.runDir, `reconcile-${hash}.json`) };
    }
    if (
      typeof expectedSnapshot !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedSnapshot) ||
      (review !== undefined &&
        (review.verdict !== "clear" ||
          review.model !== "gpt-6.1-sol" ||
          review.reasoning !== "high" ||
          typeof review.reviewer !== "string" ||
          !review.reviewer.trim() ||
          review.snapshot_sha256 !== expectedSnapshot))
    )
      throw new Error("Reconciliation requires the exact retained snapshot binding");
    this.budget.delivery = true;
    try {
      const cost = discoveryInventoryCost(this.inventory);
      this.budget.admit(cost.requests + 1, cost.bytes);
      this.checkProviderCapacity(cost.requests);
      this.refresh();
      const observed = snapshot(),
        hash = observationHash(observed);
      if (hash !== expectedSnapshot)
        throw new Error("Reconciliation snapshot changed; preserve current owner state");
      const doctor = await runScopedDoctor(this.client.config, this.client, {
        issues: [c.created_issue],
        inventory: this.inventory,
      });
      this.save(`reconcile-doctor-${hash}`, doctor);
      this.save(`reconcile-${hash}`, observed);
      c.reconciliation = {
        snapshot_sha256: hash,
        evidence: path.join(this.runDir, `reconcile-${hash}.json`),
        doctor: path.join(this.runDir, `reconcile-doctor-${hash}.json`),
        ...(review === undefined ? {} : { review }),
      };
      if (unappliedAmendment) delete c.amendment;
      c.status = "delivered";
      c.readback = String(observed.issue.url);
      for (const pending of c.pending_ids ?? [])
        if (this.checkpoint.pending[pending])
          this.checkpoint = recordDisposition(this.checkpoint, pending, {
            outcome: "intake-complete",
            issue: c.created_issue,
            readback: c.readback,
            evidence: c.reconciliation.doctor,
          });
      this.journal.notes.push({
        phase: "reconciled-external-owner",
        candidate_id: c.id,
        issue: c.created_issue,
        snapshot_sha256: hash,
        public_writes: 0,
      });
      const remaining = Object.values(this.journal.candidates).filter(
        (candidate) => !["delivered", "held", "superseded"].includes(candidate.status),
      );
      this.journal.delivery = remaining.length ? "pending" : "complete";
      this.persist();
      const reserve = discoveryDeliveryCost(
        this.inventory,
        remaining.map((candidate) => ({
          ...candidate,
          requests: candidate.evidence_ids.reduce(
            (sum, id) => sum + this.journal.evidence[id]!.requests,
            0,
          ),
          bytes: candidate.evidence_ids.reduce(
            (sum, id) => sum + this.journal.evidence[id]!.bytes,
            0,
          ),
        })),
      );
      this.budget.reserveDelivery(reserve.requests, reserve.bytes);
      return { reconciled: c.id, issue: c.created_issue, snapshot_sha256: hash, public_writes: 0 };
    } finally {
      this.budget.delivery = false;
    }
  }
  amend(raw: unknown) {
    const v = object(raw),
      c = this.journal.candidates[text(v.candidate_id)];
    if (
      !c ||
      c.kind !== "intake" ||
      !c.created_issue ||
      c.status !== "doctor-pending" ||
      v.expected_body_sha256 !== c.body_sha256
    )
      throw new Error("Amendment requires the exact retained doctor-pending intake");
    const body = text(v.body);
    if (
      Buffer.byteLength(body) > 65536 ||
      !body.includes(`<!-- portcove-discovery-intake:${c.id} -->`)
    )
      throw new Error("Amendment must preserve the intake identity and body bound");
    validateDiscoveryIntakeBody(body, c.upstream, c.portKey);
    const amendment = { expected_body_sha256: c.body_sha256, status: "prepared" as const };
    const changed = { ...c, body, amendment };
    const cost = discoveryDeliveryCost(
      this.inventory,
      Object.values(this.journal.candidates)
        .filter((candidate) => !["delivered", "held", "superseded"].includes(candidate.status))
        .map((candidate) => (candidate.id === c.id ? changed : candidate))
        .map((candidate) => ({
          ...candidate,
          requests: candidate.evidence_ids.reduce(
            (sum, id) => sum + this.journal.evidence[id]!.requests,
            0,
          ),
          bytes: candidate.evidence_ids.reduce(
            (sum, id) => sum + this.journal.evidence[id]!.bytes,
            0,
          ),
        })),
    );
    this.budget.reserveDelivery(cost.requests, cost.bytes);
    this.save(`amend-history-${c.id}-${c.body_sha256.slice(0, 12)}`, {
      candidate: c,
      reason: text(v.reason),
    });
    c.body = body;
    c.body_sha256 = observationHash(body);
    c.amendment = amendment;
    c.status = "prepared";
    delete c.review;
    this.persist();
    return c;
  }
  collect() {
    if (this.journal.collection_done)
      throw new Error("Source collection already completed in this run");
    this.discover();
    const reserve = this.budget.reserve;
    const pending = pendingLeads(this.leads, this.knownLeadUrls());
    if (pending.length) {
      const left = this.budget.remaining();
      this.budget.reserve = {
        requests: reserve.requests + Math.min(16, Math.max(0, left.requests)),
        bytes: reserve.bytes + Math.min(1024 * 1024, Math.max(0, left.bytes)),
      };
    }
    try {
      collectDiscoverySources(this.source, this.checkpoint);
    } finally {
      this.budget.reserve = reserve;
    }
    this.checkpoint = advanceDiscovery(this.checkpoint, {
      observed_at: new Date().toISOString(),
      sources: this.journal.sources,
    });
    this.journal.collection_done = true;
    this.journal.coverage =
      this.journal.sources.some((s) => s.status !== "complete") || this.journal.notes.length
        ? "partial"
        : "complete";
    this.persist();
    return {
      sources: this.journal.sources.map((s) => ({
        id: s.id,
        status: s.status,
        next_path: s.next_path,
      })),
      pending: Object.keys(this.checkpoint.pending).length,
    };
  }
  recheck() {
    const records = sourceProvenancePortIssues(this.inventory.issues);
    const revision = (issue: (typeof records)[number]) =>
      typeof issue.id === "string" &&
      typeof issue.body === "string" &&
      typeof issue.updatedAt === "string" &&
      Number.isFinite(Date.parse(issue.updatedAt))
        ? observationHash({ id: issue.id, body: issue.body, updated_at: issue.updatedAt })
        : null;
    const due = () => {
      const checked: Record<string, string> = {};
      for (const issue of records) {
        const id = String(issue.number);
        const hash = revision(issue);
        const clock = this.checkpoint.checked[id];
        if (hash && clock && this.checkpoint.checked_revisions?.[id] === hash) checked[id] = clock;
      }
      return rotatingRecheck(
        records.map((issue) => Number(issue.number)),
        checked,
        new Date().toISOString(),
        0,
      ).overdue;
    };
    if (!this.leadWorkComplete()) {
      const deferred = {
        checked: [] as number[],
        overdue: due(),
        phase: "quiet-recheck",
        status: "deferred",
        reason:
          "Collect complementary lead searches and investigate two distinct queued upstreams before quiet rotation",
        next: this.leadSummary(),
      };
      this.journal.notes.push(deferred);
      this.persist();
      return deferred;
    }
    const plan = { selected: due() };
    const checked: number[] = [];
    for (const id of plan.selected) {
      const left = this.budget.remaining();
      if (
        left.requests < 1 ||
        left.bytes < 1 ||
        left.milliseconds <= 0 ||
        (this.budget.usage.backoff_until &&
          Date.parse(this.budget.usage.backoff_until) > Date.now())
      ) {
        this.journal.coverage = "partial";
        this.journal.notes.push({
          phase: "quiet-recheck",
          status: "deferred",
          next_issue: id,
          reason: "Remaining budget or provider backoff",
          resume: "Continue oldest unchecked canonical metadata on the next admitted run",
        });
        break;
      }
      this.budget.admit(1, 1);
      this.quietAttempts++;
      const issue = records.find((i) => Number(i.number) === id);
      if (!issue) continue;
      const identity = sourceProvenancePortIdentity(issue);
      if (identity.upstreams.length !== 1) continue;
      const upstream = identity.upstreams[0];
      if (!upstream?.startsWith("https://github.com/")) continue;
      try {
        const repo = repoName(new URL(upstream).pathname.slice(1));
        const meta = object(this.client.api.request("GET", `repos/${repo}`).body);
        if (typeof meta.id !== "number" || typeof meta.full_name !== "string")
          throw new Error("Repository identity missing");
        this.save(`quiet-${id}`, {
          issue: id,
          upstream,
          repository_id: meta.id,
          current_repository: meta.full_name,
          archived: meta.archived,
          scope:
            "Canonical revision and repository identity/archive only; release currency remains unassessed",
          continuity:
            meta.full_name.toLowerCase() === repo.toLowerCase()
              ? "current location matches canonical"
              : "Unknown historical identity; relocation cannot inherit qualification",
        });
        this.checkpoint.checked[id] = new Date().toISOString();
        this.checkpoint.checked_revisions ??= {};
        const hash = revision(issue);
        if (hash) this.checkpoint.checked_revisions[id] = hash;
        else delete this.checkpoint.checked_revisions[id];
        checked.push(id);
        // Persist every completed operation before attempting the next provider read.
        this.persist();
      } catch (e) {
        this.journal.coverage = "partial";
        this.journal.notes.push({ issue: id, error: errorMessage(e) });
        if (
          this.budget.usage.backoff_until ||
          this.budget.remaining().requests <= 0 ||
          this.budget.remaining().bytes <= 0
        )
          break;
      }
    }
    this.persist();
    return { checked, overdue: due() };
  }
  leadWorkComplete() {
    const pending = pendingLeads(this.leads, this.knownLeadUrls());
    const required = Math.min(
      2,
      new Set([...pending.map((r) => r.id), ...this.researchedLeads]).size,
    );
    return (
      (this.leadPages >= 4 ||
        (this.leadFamilies?.size ?? 0) >= Math.min(6, leadSearchFamilyCount)) &&
      this.researchedLeads.size >= required
    );
  }
  async apply() {
    const delivered: { id: string; issue: number | undefined; readback: string | undefined }[] = [];
    while (true) {
      const pending = Object.values(this.journal.candidates).filter((c) =>
        [
          "prepared",
          "needs-review",
          "reviewed",
          "create-attempted",
          "created",
          "doctor-pending",
        ].includes(c.status),
      );
      if (!pending.length) {
        if (this.journal.global_doctor_pending) await this.applyBatch([]);
        return {
          delivered,
          pending: Object.values(this.journal.candidates).filter(
            (c) => !["delivered", "held", "superseded"].includes(c.status),
          ).length,
        };
      }
      if (new Set(pending.map((c) => c.created_issue ?? c.issue ?? c.id)).size > 10) {
        this.journal.global_doctor_pending = true;
        this.persist();
      }
      // Admit a prefix of the unchanged logical journal; callers never split it.
      // Readback and the applicable doctor finish each independently safe batch.
      this.budget.reserve = { requests: 0, bytes: 0 };
      this.checkProviderCapacity(0);
      const left = this.budget.remaining();
      let count = 0;
      for (let size = 1; size <= pending.length; size++) {
        const cost = discoveryDeliveryCost(
          this.inventory,
          pending.slice(0, size).map((c) => ({
            ...c,
            requests: c.evidence_ids.reduce(
              (sum, id) => sum + (this.journal.evidence[id]?.requests ?? 0),
              0,
            ),
            bytes: c.evidence_ids.reduce(
              (sum, id) => sum + (this.journal.evidence[id]?.bytes ?? 0),
              0,
            ),
          })),
        );
        if (cost.requests > left.requests || cost.bytes > left.bytes || left.milliseconds <= 0)
          break;
        try {
          this.budget.requireProviderCapacity(cost.requests);
        } catch (error) {
          if (!(error instanceof GitHubApiError)) throw error;
          break;
        }
        count = size;
      }
      if (!count) {
        this.journal.delivery = "pending";
        this.journal.notes.push({
          phase: "delivery",
          status: "deferred",
          next_candidate: pending[0]!.id,
          resume:
            "Resume the retained journal in the next admitted run; do not recapture or split candidates",
        });
        this.persist();
        return { delivered, pending: pending.length };
      }
      const result = await this.applyBatch(pending.slice(0, count));
      delivered.push(...result.delivered);
    }
  }
  async applyBatch(candidates: Candidate[]) {
    const cost = discoveryDeliveryCost(
      this.inventory,
      candidates.map((c) => ({
        ...c,
        requests: c.evidence_ids.reduce(
          (s, id) => s + (this.journal.evidence[id]?.requests ?? 0),
          0,
        ),
        bytes: c.evidence_ids.reduce((s, id) => s + (this.journal.evidence[id]?.bytes ?? 0), 0),
      })),
    );
    this.budget.reserve = { requests: 0, bytes: 0 };
    this.budget.admit(cost.requests, cost.bytes);
    this.budget.delivery = true;
    this.journal.delivery = "pending";
    this.persist();
    try {
      this.checkProviderCapacity(cost.requests);
      for (const c of candidates) {
        for (const id of ["prepared", "needs-review", "reviewed"].includes(c.status)
          ? c.evidence_ids
          : []) {
          const old = this.journal.evidence[id];
          if (!old) throw new Error("Missing reviewed evidence");
          const fresh = old.url
            ? this.source.http.request("GET", old.url)
            : investigateDiscoveryUpstream(this.source, old.repository);
          const current = old.url
            ? "text" in fresh && fresh.status === 200
              ? observationHash(fresh.text)
              : null
            : material(fresh as ReturnType<typeof investigateDiscoveryUpstream>);
          if (!old.url) delete this.journal.research_progress![old.repository.toLowerCase()];
          if (current !== old.material) {
            c.status = "needs-research";
            this.persist();
            throw new Error(
              "Primary evidence changed; research and prepare fresh metadata before mutation",
            );
          }
        }
        this.refresh();
        // Fresh complete inventories still guard absence, uniqueness and mutation.
        // Routine candidate work does not require an unrelated global planning pass.
        if (c.kind === "intake") {
          const matches = findPortIssueDuplicates(this.inventory.issues, {
            title: c.title,
            upstream: c.upstream,
            portKey: c.portKey,
          });
          if (c.status === "create-attempted" && !c.created_issue) {
            const exact = matches.filter((m) =>
              m.issue.body?.includes(`portcove-discovery-intake:${c.id}`),
            );
            if (exact.length !== 1)
              throw new Error("Ambiguous creation requires canonical reconciliation; no recapture");
            c.created_issue = Number(exact[0]?.issue.number);
            c.status = "created";
            this.persist();
          }
          if (c.created_issue) {
            const issue = this.client.repositoryIssue(c.created_issue);
            if (!issue.body?.includes(`portcove-discovery-intake:${c.id}`))
              throw new Error("Retained issue does not match candidate");
            // Guard the reviewed preimage before normalization can write any fields.
            if (c.amendment) intakeAmendmentAction(c.body, issue.body, c.amendment);
            if (
              (typeof issue.state === "string" && issue.state.toLowerCase() === "closed") ||
              (Array.isArray(object(issue).assignees) &&
                (object(issue).assignees as unknown[]).length)
            )
              throw new Error("Retained intake has changed owner/state; preserve and reconcile");
            const existing = [...this.inventory.items, ...this.inventory.archivedItems].find(
              (item) => item.content?.id === issue.node_id,
            );
            if (existing?.isArchived === true)
              throw new Error("Retained intake was archived; preserve owner placement");
            for (const [field, value] of Object.entries(portFieldInitialization(null))) {
              const current = fieldValue(existing, field);
              if (current !== undefined && current !== null && current !== "" && current !== value)
                throw new Error(`Retained intake field has owner changes: ${field}`);
            }
            const result = this.client.normalizePortIssue({
              number: c.created_issue,
              catalog: { ports: [] },
              inventory: this.inventory,
            });
            c.itemId = result.itemId;
            if (c.amendment) {
              const fresh = this.client.repositoryIssue(c.created_issue);
              if (intakeAmendmentAction(c.body, text(fresh.body), c.amendment) === "patch") {
                this.save(
                  `amend-preimage-${c.id}-${c.amendment.expected_body_sha256.slice(0, 12)}`,
                  fresh,
                );
                c.amendment.status = "attempted";
                this.persist();
                this.client.api.request(
                  "PATCH",
                  `repos/${this.client.config.repository}/issues/${c.created_issue}`,
                  { body: c.body },
                );
                this.wrote = true;
              }
              c.amendment.status = "applied";
              this.persist();
            }
          } else {
            this.assertIntakeIdentity(c);
            if (matches.length)
              throw new Error(
                "Canonical duplicate or independent-implementation conflict; capture held",
              );
            this.intakeAttempts++;
            const issue = discoveryPost(
              c,
              () =>
                this.client.createPortIssue({
                  title: c.title,
                  upstream: c.upstream,
                  portKey: c.portKey,
                  body: c.body,
                  inventory: this.inventory,
                  onIssueCreated: (issue) => {
                    c.created_issue = issue.number;
                    c.status = "created";
                    this.wrote = true;
                    this.persist();
                  },
                }),
              () => this.persist(),
            );
            c.itemId = issue.itemId;
          }
          const observed = this.client.repositoryIssue(c.created_issue!);
          if (observed.body !== c.body) throw new Error("Intake body readback differs");
          c.readback = String(observed.html_url);
        } else {
          const issue = this.client.repositoryIssue(c.issue!);
          this.save(`preimage-${c.id}`, issue);
          const comments = this.client.api
            .paginateRest(
              `repos/${this.client.config.repository}/issues/${c.issue}/comments?per_page=100`,
              { identity: (v) => object(v).id, label: "complete comment marker inventory" },
            )
            .map(object);
          const matches = comments.filter(
            (v) =>
              typeof v.body === "string" && v.body.includes(`portcove-discovery-comment:${c.id}`),
          );
          if (matches.length > 1)
            throw new Error("Duplicate material comment markers require reconciliation");
          let found = matches[0];
          if (!found) {
            assertDiscoveryCommentMayPost(c);
            found = discoveryPost(
              c,
              () =>
                object(
                  this.client.api.request(
                    "POST",
                    `repos/${this.client.config.repository}/issues/${c.issue}/comments`,
                    { body: c.body },
                  ).body,
                ),
              () => this.persist(),
            );
            this.wrote = true;
          }
          recordDiscoveryComment(c, found.id, () => this.persist());
          const observed = object(
            this.client.api.request(
              "GET",
              `repos/${this.client.config.repository}/issues/comments/${String(found.id)}`,
            ).body,
          );
          if (observed.body !== c.body) throw new Error("Comment readback differs");
          c.readback = text(observed.html_url);
        }
        c.status = "doctor-pending";
        this.persist();
      }
      this.refresh();
      for (const c of candidates) {
        if (c.kind !== "intake") continue;
        const issue = this.inventory.issues.find((i) => Number(i.number) === c.created_issue);
        const items = this.inventory.items.filter((i) => i.content?.id === issue?.id);
        if (!issue || issue.body !== c.body || items.length !== 1)
          throw new Error("Final canonical issue/Project readback differs");
        const item = items[0];
        if (fieldValue(item, "Release commitment"))
          throw new Error(
            "Neutral intake gained a release commitment; preserve and reconcile owner change",
          );
        for (const [field, value] of Object.entries(portFieldInitialization(null)))
          if (fieldValue(item, field) !== value)
            throw new Error(`Final neutral intake field differs: ${field}`);
        this.save(`readback-${c.id}`, { issue, project: item });
      }
      const deliveredIssues = candidates
        .map((candidate) => candidate.created_issue ?? candidate.issue)
        .filter((number): number is number => typeof number === "number");
      const finalBatch = !Object.values(this.journal.candidates).some(
        (candidate) =>
          !candidates.includes(candidate) &&
          !["delivered", "held", "superseded"].includes(candidate.status),
      );
      const fullDoctor =
        new Set(deliveredIssues).size > 10 ||
        (this.journal.global_doctor_pending === true && (finalBatch || candidates.length === 0));
      const doctor = fullDoctor
        ? await runDoctor(this.client.config, this.client, {
            quiet: true,
            inventory: this.inventory,
          })
        : !deliveredIssues.length
          ? { scope: "none", global_health: "not_evaluated", reason: "no roadmap changes" }
          : await runScopedDoctor(this.client.config, this.client, {
              issues: deliveredIssues,
              inventory: this.inventory,
            });
      const doctorName = `doctor-${randomUUID()}`;
      this.save(doctorName, doctor);
      this.journal.doctor = {
        status: fullDoctor || deliveredIssues.length ? "passed" : "not_run",
        scope: fullDoctor ? "global" : !deliveredIssues.length ? "none" : "issues",
        head: this.head,
        evidence: path.join(this.runDir, `${doctorName}.json`),
      };
      (this.journal.doctors ??= []).push(this.journal.doctor);
      if (fullDoctor && finalBatch) delete this.journal.global_doctor_pending;
      for (const c of candidates)
        if (c.status === "doctor-pending") {
          c.status = "delivered";
          for (const pending of c.pending_ids ?? [])
            if (this.checkpoint.pending[pending])
              this.checkpoint = recordDisposition(this.checkpoint, pending, {
                outcome: c.kind === "intake" ? "intake-complete" : "updated",
                issue: c.created_issue ?? c.issue,
                readback: c.readback,
                evidence: path.join(this.runDir, `${doctorName}.json`),
              });
        }
      this.journal.delivery = Object.values(this.journal.candidates).some(
        (c) => !["delivered", "held", "superseded"].includes(c.status),
      )
        ? "pending"
        : "complete";
      this.persist();
      return {
        delivered: candidates.map((c) => ({
          id: c.id,
          issue: c.created_issue ?? c.issue,
          readback: c.readback,
        })),
      };
    } finally {
      this.budget.delivery = false;
      this.budget.reserve = { requests: 0, bytes: 0 };
    }
  }
  async finish(error?: unknown) {
    if (!error && this.journal.global_doctor_pending) {
      try {
        // A held or stale final candidate cannot erase prior substantial
        // changes' global obligation. An empty batch performs only validation.
        await this.applyBatch([]);
      } catch (failure) {
        error = failure;
      }
    }
    if (!error && !this.journal.doctor) {
      try {
        this.budget.delivery = true;
        this.checkProviderCapacity(discoveryDeliveryCost(this.inventory, []).requests);
        this.refresh();
        // No changes need no planning doctor. Collection's complete, fresh
        // inventories and final guards remain required and retain their evidence.
        const doctor = {
          scope: "none",
          global_health: "not_evaluated",
          reason: "no roadmap changes",
          coverage: "collection-inventory",
        };
        this.save("doctor", doctor);
        this.journal.doctor = {
          status: "not_run",
          scope: "none",
          head: this.head,
          evidence: path.join(this.runDir, "doctor.json"),
        };
      } catch (e) {
        error = e;
      } finally {
        this.budget.delivery = false;
      }
    }
    const pending = Object.values(this.journal.candidates).some(
      (c) => !["delivered", "superseded", "held"].includes(c.status),
    );
    this.journal.status = error
      ? "failed"
      : pending || this.journal.global_doctor_pending || !this.leadWorkComplete()
        ? "deferred"
        : this.journal.collection_done
          ? "completed"
          : "deferred";
    this.journal.delivery = pending ? "pending" : this.journal.delivery;
    if (error)
      this.journal.notes.push({
        error: errorMessage(error),
        diagnosis: doctorFailureDiagnostics(error),
      });
    await withCheckpointLock(path.join(this.stateDir, "checkpoint.json"), async () => {
      const file = path.join(this.stateDir, "checkpoint.json");
      const current = existsSync(file)
        ? parseDiscoveryCheckpoint(JSON.parse(readFileSync(file, "utf8")))
        : emptyCheckpoint();
      if (observationHash(current) !== this.checkpointPreimage)
        throw new Error("Checkpoint preimage changed; retained journal is resumable");
      atomic(file, this.checkpoint);
    });
    this.persist();
    const ids = sourceProvenancePortIssues(this.inventory?.issues ?? []).map((i) =>
      Number(i.number),
    );
    const rotation = rotatingRecheck(ids, this.checkpoint.checked, new Date().toISOString(), 50);
    const receipt = {
      format: 1,
      run_id: this.journal.run_id,
      started_at: this.journal.started_at,
      finished_at: new Date().toISOString(),
      local_time: new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        dateStyle: "full",
        timeStyle: "long",
      }).format(new Date()),
      status: this.journal.status,
      coverage: this.journal.coverage,
      delivery: this.journal.delivery,
      profile: this.budget.usage.profile,
      usage: {
        requests: this.budget.usage.requests,
        bytes: this.budget.usage.bytes,
        profile: this.budget.usage.profile,
        backoff_until: this.budget.usage.backoff_until,
      },
      ledger: path.join(this.runDir, "budget.json"),
      head: this.head,
      pending: Object.keys(this.checkpoint.pending).length,
      overdue_ids: rotation.overdue,
      next_ids: rotation.selected,
      candidates: Object.values(this.journal.candidates).map((c) => ({
        id: c.id,
        status: c.status,
        issue: c.created_issue ?? c.issue,
        readback: c.readback,
        reconciliation: c.reconciliation,
      })),
      leads: this.leadSummary(),
      doctor: this.journal.doctor,
      sources: this.journal.sources.map(({ records, ...source }) => ({
        ...source,
        records: records.length,
      })),
      notes: this.journal.notes,
    };
    this.save("receipt", receipt);
    atomic(path.join(this.stateDir, "latest-receipt.json"), receipt);
    return receipt;
  }
}
export function boundedDiscoveryInput() {
  let length = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        length = byte === 10 ? 0 : length + 1;
        if (length > 128 * 1024) {
          callback(new Error("Discovery control message exceeds cap"));
          return;
        }
      }
      callback(null, chunk);
    },
  });
}
export async function runDiscoverySession(
  stateDir: string,
  root: string,
  head: string,
  startedAt: string,
) {
  const runDir = await assertOwnedUnlinkedPath(
    path.join(root, "work"),
    path.join(stateDir, "runs", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`),
    "discovery run",
  );
  await mkdir(runDir, { recursive: true });
  const tokenResult = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 65536,
  });
  if (tokenResult.status !== 0 || tokenResult.error)
    throw new Error("GitHub credentials unavailable");
  const config = JSON.parse(
    await readFile(path.join(root, ".github/roadmap.json"), "utf8"),
  ) as ConstructorParameters<typeof RoadmapClient>[0];
  const session = new DiscoverySession(
    stateDir,
    runDir,
    config,
    tokenResult.stdout.trim(),
    startedAt,
    head,
  );
  const emit = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");
  const guardedInput = boundedDiscoveryInput();
  const input = createInterface({ input: guardedInput, crlfDelay: Infinity });
  let failed: unknown;
  let finished = false;
  const cancel = () => {
    failed = new Error("Run cancelled; owned request worker drained before checkpoint/release");
    input.close();
  };
  guardedInput.on("error", (error) => {
    failed = error;
    input.close();
  });
  process.stdin.pipe(guardedInput);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const timer = setTimeout(cancel, Math.max(1, session.budget.remaining().milliseconds));
  try {
    emit(session.start());
    for await (const line of input) {
      if (Buffer.byteLength(line) > 128 * 1024)
        throw new Error("Discovery control message exceeds cap");
      const message = object(JSON.parse(line));
      if (message.run_id !== session.journal.run_id) throw new Error("Run identity mismatch");
      const op = text(message.op);
      let result: unknown;
      if (op === "finish") {
        finished = true;
        break;
      }
      if (op === "collect") result = session.collect();
      else if (op === "discover") result = session.discover();
      else if (op === "lead-dispose") result = session.disposeLead(message.disposition);
      else if (op === "amend") result = session.amend(message.amendment);
      else if (op === "research") result = session.research(text(message.repository));
      else if (op === "search") result = session.search(text(message.query));
      else if (op === "read-primary")
        result = session.readPrimary(text(message.repository), text(message.url));
      else if (op === "propose") result = session.propose(message.candidate);
      else if (op === "review") result = session.review(message.review);
      else if (op === "hold") result = session.hold(message.hold);
      else if (op === "reconcile") result = await session.reconcile(message.reconciliation);
      else if (op === "apply") result = await session.apply();
      else if (op === "recheck") result = session.recheck();
      else if (op === "dispose") {
        const v = object(message.disposition);
        if (
          !["no-change", "held", "recommendation"].includes(text(v.outcome)) ||
          !session.journal.evidence[text(v.evidence_id)]
        )
          throw new Error("Disposition needs investigated evidence");
        session.checkpoint = recordDisposition(session.checkpoint, text(v.pending_id), {
          outcome: v.outcome,
          evidence: session.journal.evidence[text(v.evidence_id)]!.file,
        });
        result = { disposed: v.pending_id };
      } else throw new Error("Unsupported discovery command");
      emit({ phase: op, result, remaining: session.budget.remaining() });
    }
    if (!finished && !failed)
      failed = new Error("Input ended before explicit finish; preserve interrupted run");
  } catch (error) {
    failed = error;
  } finally {
    clearTimeout(timer);
    input.close();
    process.stdin.unpipe(guardedInput);
    guardedInput.destroy();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    const receipt = await session.finish(failed);
    emit({ phase: "finished", receipt });
    if (receipt.status === "failed") process.exitCode = 1;
  }
}
