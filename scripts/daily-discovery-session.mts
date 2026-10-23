import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runScopedDoctor, doctorFailureDiagnostics } from "./roadmap-scoped.mts";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { spawnSync } from "node:child_process";
import { isRecord, errorMessage, errorCode } from "./runtime-values.mts";
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
  findPortIssueDuplicates,
  sourceProvenancePortIssues,
  sourceProvenancePortIdentity,
  fieldValue,
  portFieldInitialization,
  reconcilePortIssueMarkers,
  validateDurableIssueBody,
} from "./roadmap.mts";
import type { RoadmapInventory, InventoryCache } from "./roadmap-inventory.mts";
import { collectRoadmapInventory } from "./roadmap-inventory.mts";
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

interface Candidate {
  id: string;
  kind: "intake" | "comment";
  title: string;
  upstream: string;
  portKey: string;
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
}
interface Evidence {
  repository: string;
  material: string;
  file: string;
  requests: number;
  bytes: number;
  url?: string;
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
  baseline_completed_at?: string;
  checkpoint?: DiscoveryCheckpoint;
  checkpoint_preimage?: string;
  backoff_until?: string;
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
  const deadline = performance.now() + 1000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      const remaining = deadline - performance.now();
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "") ||
        attempt >= 40 ||
        remaining <= 0
      )
        throw error;
      // Retry only replacement of these already prepared bytes. Never unlink the
      // old target. Persistent failure retains both files and the original error.
      // This local wait counts toward the unchanged discovery session deadline.
      Atomics.wait(waiter, 0, 0, Math.min(25, remaining));
    }
  }
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
  candidates: readonly { body: string; requests?: number; bytes?: number }[],
) {
  const { requests: pages, bytes: thin } = discoveryInventoryCost(inventory);
  const requests =
    (candidates.length + 1) * pages +
    candidates.length * 8 +
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
export class DiscoverySession {
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
      candidates:
        previous === undefined ? {} : (object(previous).candidates as Record<string, Candidate>),
      evidence:
        previous === undefined ? {} : (object(previous).evidence as Record<string, Evidence>),
      notes: [],
      ...(isRecord(cache) && typeof cache.baseline_completed_at === "string"
        ? { baseline_completed_at: cache.baseline_completed_at }
        : {}),
    };
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
        !["needs-review", "held", "superseded"].includes(String(c.status)) &&
        (!isRecord(c.review) ||
          c.review.verdict !== "clear" ||
          c.review.body_sha256 !== c.body_sha256 ||
          c.review.evidence_sha256 !== c.evidence_sha256)
      )
        throw new Error("Interrupted candidate lacks its matching separate review");
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
      save: (name, value) => this.save(name, value),
    };
  }
  save(name: string, value: unknown) {
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name)) throw new Error("Unsafe evidence name");
    atomic(path.join(this.runDir, `${name}.json`), value);
  }
  persist() {
    this.journal.checkpoint = this.checkpoint;
    this.journal.checkpoint_preimage = this.checkpointPreimage;
    if (this.budget.usage.backoff_until)
      this.journal.backoff_until = this.budget.usage.backoff_until;
    atomic(this.journalFile, this.journal);
    this.save("journal", this.journal);
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
      Object.values(this.journal.candidates).filter(
        (c) => !["delivered", "held", "superseded"].includes(c.status),
      ),
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
      next: "Recover unfinished candidates, or collect/research, propose, separate review, apply, finish",
    };
  }
  research(repository: string) {
    if (++this.deepInvestigations > 12) throw new Error("Deep investigation limit reached");
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
    };
    this.persist();
    return { id, file, material: fingerprint };
  }
  search(query: string) {
    if (++this.searches > 6 || query.length > 500) throw new Error("Lead-search bound exceeded");
    const response = this.source.api.request(
      "GET",
      `search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`,
    );
    this.save(`lead-search-${this.searches}`, response.body);
    this.journal.notes.push({
      source: "primary-leads",
      scope: "One bounded repository-search page; no absence or complete community coverage claim",
      query,
      evidence: path.join(this.runDir, `lead-search-${this.searches}.json`),
    });
    this.persist();
    return { file: path.join(this.runDir, `lead-search-${this.searches}.json`) };
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
    const id = observationHash({
      kind: v.kind,
      upstream: upstream.href,
      key,
      evidence: evidenceHash,
      issue: v.issue,
    });
    if (this.journal.candidates[id]) return this.journal.candidates[id];
    const marked = `<!-- portcove-discovery-${v.kind}:${id} -->\n\n${body}`;
    if (v.kind === "intake") {
      validateDurableIssueBody(marked);
      if (reconcilePortIssueMarkers(marked, { upstream: upstream.href, portKey: key }) !== marked)
        throw new Error("Intake requires the maintained canonical body markers before review");
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
      status: "needs-review",
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
    const reserve = discoveryDeliveryCost(
      this.inventory,
      [
        ...Object.values(this.journal.candidates).filter(
          (c) =>
            !(
              c.upstream === candidate.upstream &&
              c.kind === candidate.kind &&
              c.portKey === candidate.portKey &&
              ["needs-review", "held"].includes(c.status)
            ),
        ),
        candidate,
      ]
        .filter((c) => !["delivered", "held", "superseded"].includes(c.status))
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
        ["needs-review", "held"].includes(old.status)
      ) {
        old.status = "superseded";
        old.superseded_by = id;
      }
    this.journal.candidates[id] = candidate;
    this.save(`candidate-${id}`, candidate);
    this.persist();
    return candidate;
  }
  review(raw: unknown) {
    const v = object(raw),
      c = this.journal.candidates[text(v.candidate_id)];
    if (
      !c ||
      c.status !== "needs-review" ||
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
    if (!c || !["needs-review", "reviewed", "held"].includes(c.status) || c.created_issue)
      throw new Error("Only a candidate without an unresolved public mutation can be held");
    c.status = "held";
    c.hold = { reason: text(v.reason), resume: text(v.resume) };
    this.persist();
    return { id: c.id, status: c.status, hold: c.hold };
  }
  collect() {
    if (this.journal.collection_done)
      throw new Error("Source collection already completed in this run");
    this.journal.sources.push(...collectDiscoverySources(this.source, this.checkpoint));
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
    const plan = rotatingRecheck(
      records.map((i) => Number(i.number)),
      this.checkpoint.checked,
      new Date().toISOString(),
      Math.max(0, 50 - this.quietAttempts),
    );
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
        checked.push(id);
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
    return {
      checked,
      overdue: rotatingRecheck(
        records.map((i) => Number(i.number)),
        this.checkpoint.checked,
        new Date().toISOString(),
        50,
      ).overdue,
    };
  }
  async apply() {
    const candidates = Object.values(this.journal.candidates)
      .filter((c) =>
        ["reviewed", "create-attempted", "created", "doctor-pending"].includes(c.status),
      )
      .slice(0, 5);
    if (!candidates.length) return { applied: 0 };
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
        for (const id of c.status === "reviewed" ? c.evidence_ids : []) {
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
          if (current !== old.material) {
            c.status = "needs-review";
            this.persist();
            throw new Error("Primary evidence changed; review invalidated before mutation");
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
          } else {
            if (matches.length)
              throw new Error(
                "Canonical duplicate or independent-implementation conflict; capture held",
              );
            if (++this.intakeAttempts > 5) throw new Error("Daily new-issue bound exhausted");
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
      const fullDoctor = new Set(deliveredIssues).size > 10;
      const doctor = !deliveredIssues.length
        ? { scope: "none", global_health: "not_evaluated", reason: "no roadmap changes" }
        : fullDoctor
          ? await runDoctor(this.client.config, this.client, {
              quiet: true,
              inventory: this.inventory,
            })
          : await runScopedDoctor(this.client.config, this.client, {
              issues: deliveredIssues,
              inventory: this.inventory,
            });
      this.save("doctor", doctor);
      this.journal.doctor = {
        status: deliveredIssues.length ? "passed" : "not_run",
        scope: !deliveredIssues.length ? "none" : fullDoctor ? "global" : "issues",
        head: this.head,
        evidence: path.join(this.runDir, "doctor.json"),
      };
      for (const c of candidates)
        if (c.status === "doctor-pending") {
          c.status = "delivered";
          for (const pending of c.pending_ids ?? [])
            if (this.checkpoint.pending[pending])
              this.checkpoint = recordDisposition(this.checkpoint, pending, {
                outcome: c.kind === "intake" ? "intake-complete" : "updated",
                issue: c.created_issue ?? c.issue,
                readback: c.readback,
                evidence: path.join(this.runDir, "doctor.json"),
              });
        }
      this.journal.delivery = "complete";
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
      : pending
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
      })),
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
      else if (op === "research") result = session.research(text(message.repository));
      else if (op === "search") result = session.search(text(message.query));
      else if (op === "read-primary")
        result = session.readPrimary(text(message.repository), text(message.url));
      else if (op === "propose") result = session.propose(message.candidate);
      else if (op === "review") result = session.review(message.review);
      else if (op === "hold") result = session.hold(message.hold);
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
