import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckedGit } from "./checked-git.mts";
import { RoadmapClient, portFieldInitialization, runDoctor, validateConfig } from "./roadmap.mts";
import { qualificationCatalogObservation } from "./roadmap-qualification.mts";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import {
  collectRoadmapInventory,
  collectRoadmapInventoryWithRecollection,
} from "./roadmap-inventory.mts";
import { runScopedDoctor } from "./roadmap-scoped.mts";
import { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";
import { investigateDiscoveryUpstream } from "./daily-discovery-sources.mts";
import { assertDiscoveryIntakeIdentity, discoveryGameKey } from "./discovery-intake-identity.mts";
import { readCatalogSource } from "./catalog-authoring.mts";
import { assessUpstreamLineage } from "./upstream-lineage.mts";
import { discoveryPost } from "./discovery-mutation.mts";
import { validateDiscoveryIntakeBody, discoveryInventoryCost } from "./daily-discovery-session.mts";
import {
  renderPortIssueBody,
  findPortIssueDuplicates,
  normalizedUpstream,
  normalizePortKey,
  fieldValue,
} from "./roadmap-issue.mts";
import { observationHash } from "./upstream-observer.mts";
import { validateGitHubBody } from "./github-body-text.mts";
import { isRecord } from "./runtime-values.mts";
import type { RoadmapInventory } from "./roadmap-inventory.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

export const hostedRequestMarker = "<!-- portcove-hosted-intake:v1 -->";

export class HostedRoadmapClient extends RoadmapClient {
  // The bounded transport accepts API calls only; reuse the complete schema reader.
  override fieldList(number: number) {
    return { fields: this.completeProjectContext(number).fields };
  }
}
const receiptMarker = (id: number) => `<!-- portcove-hosted-intake-receipt:${id} -->`;
const object = (v: unknown) => {
  if (!isRecord(v)) throw new Error("Expected structured intake data");
  return v;
};
function exact(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).sort().join("|") !== keys.sort().join("|"))
    throw new Error("Unexpected or missing intake fields");
}
function text(v: unknown, limit = 16000) {
  if (typeof v !== "string" || !v.trim() || Buffer.byteLength(v) > limit || v.includes("<!--"))
    throw new Error("Invalid bounded intake text");
  return v;
}
function line(v: unknown) {
  const s = text(v, 256);
  if (/[\r\n<>]/u.test(s)) throw new Error("Expected one plain intake line");
  return s;
}
const positive = (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    throw new Error("Expected a positive provider identity");
  return v;
};
interface Candidate {
  title: string;
  upstream: string;
  repository_id: number;
  game: string;
  port_key: string;
  evidence: string;
  resume: string;
}
interface Proposal {
  schema_version: 1;
  kind: "proposal";
  investigator: string;
  candidates: Candidate[];
}
export function parseHostedRequest(body: unknown): Proposal {
  if (typeof body !== "string" || Buffer.byteLength(body) > 64000)
    throw new Error("Hosted request exceeds its comment envelope");
  const match = /^<!-- portcove-hosted-intake:v1 -->\s*```json\n([\s\S]+)\n```\s*$/u.exec(body);
  if (!match) throw new Error("Expected exactly one structured hosted intake request");
  const v = object(JSON.parse(match[1]!));
  if (v.schema_version !== 1) throw new Error("Unsupported hosted intake schema");
  exact(v, ["schema_version", "kind", "investigator", "candidates"]);
  if (v.kind !== "proposal" || !Array.isArray(v.candidates) || !v.candidates.length)
    throw new Error("Expected one nonempty logical candidate batch");
  line(v.investigator);
  const seen = new Set<string>();
  const identities = new Set<string>();
  for (const raw of v.candidates) {
    const c = object(raw);
    exact(c, ["title", "upstream", "repository_id", "game", "port_key", "evidence", "resume"]);
    line(c.title);
    line(c.game);
    positive(c.repository_id);
    text(c.evidence);
    text(c.resume, 4000);
    if (
      typeof c.upstream !== "string" ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(c.upstream)
    )
      throw new Error("Use an exact primary GitHub repository URL");
    if (
      typeof c.port_key !== "string" ||
      normalizePortKey(c.port_key) !== c.port_key ||
      !c.port_key
    )
      throw new Error("Expected a canonical durable port key");
    if (seen.has(c.port_key)) throw new Error("Duplicate candidate key within logical batch");
    seen.add(c.port_key);
    const identity = `${String(c.repository_id)}:${discoveryGameKey(String(c.game))}`;
    if (identities.has(identity))
      throw new Error("Duplicate implementation/game within logical batch");
    identities.add(identity);
  }
  return v as unknown as Proposal;
}
interface Comment {
  id: number;
  body: string;
  user: { login: string; type?: string };
  issue_url?: string;
}
export function trustedHostedComment(raw: unknown, owner: string): Comment {
  const c = object(raw),
    user = object(c.user);
  positive(c.id);
  if (user.login !== owner || typeof c.body !== "string")
    throw new Error("Untrusted request author");
  return c as unknown as Comment;
}
export function assertHostedEvent(
  event: unknown,
  eventName: string,
  repository: string,
  owner: string,
) {
  const e = object(event);
  if (object(e.repository).full_name !== repository || object(e.sender).login !== owner)
    throw new Error("Hosted intake requires this repository's authorized owner");
  if (eventName === "issue_comment") {
    if (
      object(e.issue).number !== 177 ||
      object(e.issue).pull_request ||
      !["created", "edited"].includes(String(e.action))
    )
      throw new Error("Hosted intake requests belong only on owner issue #177");
    trustedHostedComment(e.comment, owner);
  } else if (eventName !== "workflow_dispatch") throw new Error("Unsupported hosted intake event");
}
interface Planned {
  candidate: Candidate;
  body: string;
  body_sha256: string;
  evidence_sha256: string;
  primary: {
    repository_id: number;
    readme_commit: string;
    readme_blob: unknown;
    release_fingerprint: string;
  };
}
export function assertHostedCatalogIdentity(
  c: Candidate,
  records: AuthoredPort[],
  exclude?: number,
) {
  for (const record of records) {
    if (record.listing.issue_number === exclude && exclude !== undefined) continue;
    const history = assessUpstreamLineage(record).history;
    const sameSource =
      normalizedUpstream(record.listing.project_url) === normalizedUpstream(c.upstream) ||
      history.some(
        (h) =>
          normalizedUpstream(h.project_url) === normalizedUpstream(c.upstream) ||
          (h.repository?.host === "github.com" && Number(h.repository.id) === c.repository_id),
      );
    const knownGame = record.listing.original_game_title;
    if (
      record.listing.id === c.port_key ||
      (sameSource && (!knownGame || discoveryGameKey(knownGame) === discoveryGameKey(c.game)))
    )
      throw new Error(
        `Authored catalog identity already exists or has unknown game scope: ${record.listing.id}`,
      );
  }
}
export function assertHostedRecovery(
  client: RoadmapClient,
  inventory: RoadmapInventory,
  number: number,
) {
  const issue = client.repositoryIssue(number);
  const assignees = object(issue).assignees;
  const rows = [...inventory.items, ...inventory.archivedItems].filter(
    (i) => i.content?.id === issue.node_id,
  );
  if (
    String(issue.state).toLowerCase() !== "open" ||
    (Array.isArray(assignees) && assignees.length) ||
    rows.length > 1 ||
    rows.some((i) => i.isArchived !== false)
  )
    throw new Error("Retained intake has changed owner/state/placement; preserve and reconcile");
  for (const [field, value] of Object.entries(portFieldInitialization(null))) {
    const current = fieldValue(rows[0], field);
    if (current !== undefined && current !== null && current !== "" && current !== value)
      throw new Error(`Retained intake field has owner changes: ${field}`);
  }
  if (fieldValue(rows[0], "Release commitment"))
    throw new Error("Retained intake has an owner release commitment");
  return issue;
}
function compactDoctor(result: Awaited<ReturnType<typeof runScopedDoctor>>) {
  return {
    status: "passed",
    coverage: result.coverage,
    global_health: result.global_health,
    issues: result.scope.issues,
    checked_issue_count: result.scope.checked_issues.length,
    receipt_sha256: observationHash(result),
  };
}
interface Delivery {
  status: string;
  created_issue?: number;
  item_id?: string;
  existing?: boolean;
  fields?: Record<string, unknown>;
  doctor?: unknown;
}
interface Receipt {
  schema_version: 1;
  request_comment: number;
  request_sha256: string;
  investigator: string;
  plan_sha256: string;
  plan: Planned[];
  delivery: Delivery[];
  status: string;
  head: string;
  run: string;
  attempt: string;
  plan_origin: { head: string; run: string; attempt: string };
  observed_at?: string;
  doctor?: unknown;
  error?: unknown;
}
export function hostedBody(c: Candidate, request: number) {
  return renderPortIssueBody({
    title: c.title,
    upstream: c.upstream,
    portKey: c.port_key,
    currentEvidence: `GitHub repository ID: ${c.repository_id}\nUnderlying game: **${c.game}**\n\n${c.evidence}\n\n<!-- portcove-discovery-intake:hosted-${request}-${c.port_key} -->`,
    blocker: c.resume,
  });
}
export function hostedPlanHash(requestHash: string, plan: Planned[]) {
  return observationHash({
    request_sha256: requestHash,
    candidates: plan.map((p) => ({
      body_sha256: p.body_sha256,
      evidence_sha256: p.evidence_sha256,
    })),
  });
}
function receiptBody(r: Receipt) {
  const body = `${receiptMarker(r.request_comment)}\nHosted intake **${r.status}**.\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``;
  validateGitHubBody(body);
  if (Buffer.byteLength(body) > 60000)
    throw new Error("Hosted receipt exceeds its bounded comment envelope");
  return body;
}
export class HostedIntakeBridge {
  inventoryRecollections = 0;
  readonly client: RoadmapClient;
  readonly head: string;
  readonly research: (repository: string) => ReturnType<typeof investigateDiscoveryUpstream>;
  readonly save: (name: string, value: unknown) => void;
  readonly admitRecollection: (cache?: RoadmapInventory) => void;
  constructor(
    client: RoadmapClient,
    head: string,
    research: (repository: string) => ReturnType<typeof investigateDiscoveryUpstream>,
    save: (name: string, value: unknown) => void,
    admitRecollection: (cache?: RoadmapInventory) => void = () => {
      throw new Error("Inventory recollection admission is not configured");
    },
  ) {
    this.client = client;
    this.head = head;
    this.research = research;
    this.save = save;
    this.admitRecollection = admitRecollection;
  }
  get prefix() {
    return `repos/${this.client.config.repository}/issues`;
  }
  comments() {
    const before = object(this.client.api.request("GET", `${this.prefix}/177`).body);
    const comments = this.client.api
      .paginateRest(`${this.prefix}/177/comments?per_page=20`, {
        identity: (v) => object(v).id,
        label: "complete hosted intake request and receipt inventory",
      })
      .map((v) => object(v) as unknown as Comment);
    const after = object(this.client.api.request("GET", `${this.prefix}/177`).body);
    if (
      before.node_id !== after.node_id ||
      before.comments !== comments.length ||
      after.comments !== comments.length ||
      before.updated_at !== after.updated_at
    )
      throw new Error("Hosted request comment inventory changed or is incomplete");
    return comments;
  }
  fresh(c: Comment) {
    const got = object(
      this.client.api.request("GET", `${this.prefix}/comments/${c.id}`).body,
    ) as unknown as Comment;
    if (
      got.id !== c.id ||
      got.body !== c.body ||
      got.user.login !== c.user.login ||
      got.issue_url !== `https://api.github.com/${this.prefix}/177`
    )
      throw new Error("Hosted request or receipt preimage changed; stop and reread");
    return got;
  }
  persist(receipt: Receipt, prior?: Comment) {
    receipt.observed_at = new Date().toISOString();
    this.save(`receipt-${receipt.request_comment}`, receipt);
    const body = receiptBody(receipt);
    if (prior) this.fresh(prior);
    const got = object(
      this.client.api.request(
        prior ? "PATCH" : "POST",
        prior ? `${this.prefix}/comments/${prior.id}` : `${this.prefix}/177/comments`,
        { body },
      ).body,
    );
    const observed = object(
      this.client.api.request("GET", `${this.prefix}/comments/${positive(got.id)}`).body,
    );
    if (observed.body !== body || object(observed.user).login !== "github-actions[bot]")
      throw new Error("Bot receipt publication/readback is unconfirmed; no further mutation");
    return observed as unknown as Comment;
  }
  diagnostic(request: Comment, error: unknown, all: Comment[]) {
    const marker = `<!-- portcove-hosted-intake-diagnostic:${request.id} -->`;
    const rows = all.filter(
      (c) => c.user.login === "github-actions[bot]" && c.body.startsWith(marker),
    );
    if (rows.length > 1) throw new Error("Ambiguous diagnostic comment identity");
    const previous = rows[0];
    const diagnostic = {
      status: "incomplete",
      request_comment: request.id,
      request_sha256: observationHash(request.body),
      head: this.head,
      run: process.env.GITHUB_RUN_ID ?? "local",
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
      error: sanitizeOperationError(error),
      resume:
        "Resolve the named failure, reread the exact proposal/plan and resume process; do not recapture an ambiguous creation.",
    };
    const body = `${marker}\n\`\`\`json\n${JSON.stringify(diagnostic, null, 2)}\n\`\`\``;
    if (previous) this.fresh(previous);
    const got = object(
      this.client.api.request(
        previous ? "PATCH" : "POST",
        previous ? `${this.prefix}/comments/${previous.id}` : `${this.prefix}/177/comments`,
        { body },
      ).body,
    );
    const after = object(
      this.client.api.request("GET", `${this.prefix}/comments/${positive(got.id)}`).body,
    );
    if (after.body !== body || object(after.user).login !== "github-actions[bot]")
      throw new Error("Diagnostic publication readback is unconfirmed");
  }
  primary(c: Candidate, request: number): Planned {
    const primary = this.research(new URL(c.upstream).pathname.slice(1));
    if (
      primary.metadata.id !== c.repository_id ||
      normalizedUpstream(`https://github.com/${String(primary.metadata.full_name)}`) !==
        normalizedUpstream(c.upstream)
    )
      throw new Error("Primary immutable repository identity changed");
    const identity = {
      repository_id: c.repository_id,
      readme_commit: primary.readme.commit,
      readme_blob: primary.readme.blob,
      release_fingerprint: primary.fingerprint,
    };
    const body = hostedBody(c, request);
    validateDiscoveryIntakeBody(body, c.upstream, c.port_key);
    this.save(`primary-${request}-${c.port_key}`, primary);
    return {
      candidate: c,
      body,
      body_sha256: observationHash(body),
      evidence_sha256: observationHash(identity),
      primary: identity,
    };
  }
  inventory(cache?: RoadmapInventory) {
    this.client._completeProjectContext = undefined;
    this.client._projectContext = undefined;
    let first: ReturnType<typeof sanitizeOperationError> | undefined;
    return collectRoadmapInventoryWithRecollection(
      this.client,
      () => collectRoadmapInventory(this.client, cache),
      this,
      {
        before: (error) => {
          first = sanitizeOperationError(error);
          this.save("inventory-recollection", {
            status: "pending",
            allowance: this.inventoryRecollections,
            first,
          });
          this.admitRecollection(cache);
        },
        after: (status, error) =>
          this.save("inventory-recollection", {
            status,
            allowance: this.inventoryRecollections,
            first,
            ...(status === "failed" ? { second: sanitizeOperationError(error) } : {}),
          }),
      },
    );
  }
  duplicates(inventory: RoadmapInventory, p: Planned, exclude?: number) {
    const c = p.candidate,
      others = inventory.issues.filter((i) => i.number !== exclude);
    const records = readCatalogSource(
      fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
    ).records;
    assertHostedCatalogIdentity(c, records, exclude);
    assertDiscoveryIntakeIdentity(
      {
        repository: c.upstream,
        repository_id: c.repository_id,
        kind: "implementation",
        game_key: discoveryGameKey(c.game),
      },
      others,
      records,
      [],
    );
    const duplicates = findPortIssueDuplicates(others, {
      title: c.title,
      upstream: c.upstream,
      portKey: c.port_key,
    });
    if (duplicates.length)
      throw new Error(`Canonical duplicate: ${duplicates.map((x) => x.issue.number).join(", ")}`);
  }
  async process(request: Comment, all: Comment[]) {
    trustedHostedComment(request, this.client.config.owner);
    this.fresh(request);
    const proposal = parseHostedRequest(request.body);
    const found = all.filter(
      (c) => c.user.login === "github-actions[bot]" && c.body.startsWith(receiptMarker(request.id)),
    );
    if (found.length > 1) throw new Error("Ambiguous hosted receipt identity");
    let prior = found[0];
    let receipt: Receipt | undefined;
    if (prior) {
      this.fresh(prior);
      const match = /```json\n([\s\S]+)\n```$/u.exec(prior.body);
      if (!match) throw new Error("Malformed retained hosted receipt");
      receipt = JSON.parse(match[1]!) as Receipt;
      if (
        receipt.request_comment !== request.id ||
        receipt.request_sha256 !== observationHash(request.body) ||
        hostedPlanHash(receipt.request_sha256, receipt.plan) !== receipt.plan_sha256
      )
        throw new Error("Changed proposal or invalid retained plan; preserve prior receipt");
      if (receipt.status === "complete") return receipt;
    }
    const plan = proposal.candidates.map((c) => this.primary(c, request.id));
    let inventory = this.inventory();
    if (!receipt) {
      for (const p of plan) this.duplicates(inventory, p);
      receipt = {
        schema_version: 1,
        request_comment: request.id,
        request_sha256: observationHash(request.body),
        investigator: proposal.investigator,
        plan_sha256: hostedPlanHash(observationHash(request.body), plan),
        plan,
        delivery: plan.map(() => ({ status: "prepared" })),
        status: "prepared",
        head: this.head,
        run: process.env.GITHUB_RUN_ID ?? "local",
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
        plan_origin: {
          head: this.head,
          run: process.env.GITHUB_RUN_ID ?? "local",
          attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
        },
      };
      if (Buffer.byteLength(receiptBody(receipt)) + plan.length * 2048 + 4096 > 60000)
        throw new Error(
          "Logical batch cannot retain complete delivery receipts; reduce evidence text",
        );
      prior = this.persist(receipt);
    }
    if (receipt.plan_sha256 !== hostedPlanHash(observationHash(request.body), plan))
      throw new Error("Primary evidence changed since preparation; a fresh proposal is required");
    receipt.head = this.head;
    receipt.run = process.env.GITHUB_RUN_ID ?? "local";
    receipt.attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
    receipt.status = "applying";
    const persist = () => {
      prior = this.persist(receipt, prior);
    };
    persist();
    try {
      const writeProof = await probeHostedProjectWrite(this.client, 177);
      this.save(`write-proof-${request.id}`, writeProof);
      inventory = this.inventory(inventory);
      for (const [index, p] of plan.entries()) {
        const d = receipt.delivery[index];
        if (!d) throw new Error("Retained delivery coverage differs");
        this.fresh(request);
        const marker = `<!-- portcove-discovery-intake:hosted-${request.id}-${p.candidate.port_key} -->`;
        const recovered = inventory.issues.filter((i) => i.body?.includes(marker));
        if (recovered.length > 1) throw new Error("Ambiguous created issue marker");
        if (d.created_issue && recovered[0]?.number !== d.created_issue)
          throw new Error("Created issue identity is unavailable");
        if (!d.created_issue && recovered.length) d.created_issue = Number(recovered[0]!.number);
        if (!d.created_issue && d.status === "create-attempted")
          throw new Error("Ambiguous issue POST without a confirmed marker; do not recapture");
        this.duplicates(inventory, p, d.created_issue);
        if (d.created_issue) {
          const issue = assertHostedRecovery(this.client, inventory, d.created_issue);
          if (issue.body !== p.body || issue.title !== `[Port] ${p.candidate.title}`)
            throw new Error("Created issue was revised; preserve owner changes and reconcile");
          const normalized = this.client.normalizePortIssue({
            number: d.created_issue,
            catalog: qualificationCatalogObservation(
              JSON.parse(
                readFileSync(
                  new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
                  "utf8",
                ),
              ),
            ),
            inventory,
          });
          d.item_id = normalized.itemId;
        } else {
          // Persist the attempt before recollection: publishing it advances
          // #177's revision, so the negative inventory must come afterwards.
          d.status = "create-attempted";
          persist();
          try {
            inventory = this.inventory(inventory);
            this.fresh(request);
            this.duplicates(inventory, p);
          } catch (error) {
            d.status = "prepared"; // No POST has begun in this preflight.
            persist();
            throw error;
          }
          discoveryPost(
            d,
            () =>
              this.client.createPortIssue({
                title: p.candidate.title,
                upstream: p.candidate.upstream,
                portKey: p.candidate.port_key,
                body: p.body,
                inventory,
                onIssueCreated: (issue) => {
                  d.created_issue = issue.number;
                  d.status = "created";
                  persist();
                },
              }),
            () => this.save(`receipt-${request.id}`, receipt),
          );
        }
        const issue = this.client.repositoryIssue(d.created_issue!);
        const item = this.client.executionIssue(d.created_issue!).item;
        if (issue.body !== p.body || item.content.id !== issue.node_id)
          throw new Error("Exact created body/item readback failed");
        const defaults = portFieldInitialization(null);
        for (const [f, v] of Object.entries(defaults))
          if (fieldValue(item, f) !== v) throw new Error(`Neutral intake field differs: ${f}`);
        if (fieldValue(item, "Release commitment"))
          throw new Error("Intake acquired a release commitment");
        if (typeof item.id !== "string") throw new Error("Verified Project item ID is unavailable");
        d.item_id = item.id;
        d.fields = Object.fromEntries(Object.keys(defaults).map((f) => [f, fieldValue(item, f)]));
        const doctor = await runScopedDoctor(this.client.config, this.client, {
          issues: [d.created_issue!],
        });
        this.save(`doctor-${request.id}-${d.created_issue}`, doctor);
        d.doctor = compactDoctor(doctor);
        d.status = "delivered";
        persist();
        if (index < plan.length - 1 || plan.length > 10) inventory = this.inventory(inventory);
      }
      if (plan.length > 10) {
        const global = await runDoctor(this.client.config, this.client, {
          quiet: true,
          inventory,
        });
        receipt.doctor = {
          status: "passed",
          coverage: "complete",
          global_health: "passed",
          receipt_sha256: observationHash(global),
        };
        this.save(`global-doctor-${request.id}`, receipt.doctor);
      }
      receipt.status = "complete";
      delete receipt.error;
      persist();
    } catch (error) {
      receipt.status = "incomplete";
      receipt.error = sanitizeOperationError(error);
      persist();
      throw error;
    }
    return receipt;
  }
}
export async function probeHostedProjectWrite(client: RoadmapClient, issue: number) {
  const before = client.executionIssue(issue).item;
  const priority = fieldValue(before, "Priority");
  if (
    before.content.number !== issue ||
    typeof priority !== "string" ||
    !client.config.fields.find((f) => f.name === "Priority")?.options.includes(priority) ||
    (issue !== 177 &&
      (fieldValue(before, "Work type") !== "Port" ||
        priority !== "None" ||
        fieldValue(before, "Port stage") !== "Watchlist" ||
        fieldValue(before, "Release commitment")))
  )
    throw new Error("Write probe requires an authorized neutral Watchlist port with Priority None");
  const fields = client.config.fields.map((f) => [f.name, fieldValue(before, f.name) ?? null]);
  if (typeof before.id !== "string") throw new Error("Probe Project item ID is unavailable");
  client.setItemFields(before.id, { Priority: priority });
  const after = client.executionIssue(issue).item;
  if (
    before.id !== after.id ||
    before.content.id !== after.content.id ||
    before.content.body !== after.content.body ||
    observationHash(fields) !==
      observationHash(client.config.fields.map((f) => [f.name, fieldValue(after, f.name) ?? null]))
  )
    throw new Error("Project write probe readback changed meaning or identity");
  return {
    status: "passed",
    issue,
    item_id: after.id,
    operation: `same-option Priority ${priority} write`,
    fields_unchanged: true,
    doctor: await runScopedDoctor(client.config, client, { issues: [issue] }),
  };
}
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = path.join(root, "work/hosted-discovery-intake");
  mkdirSync(directory, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2));
  const config = validateConfig(
    JSON.parse(readFileSync(path.join(root, ".github/roadmap.json"), "utf8")),
  );
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  assertHostedEvent(event, process.env.GITHUB_EVENT_NAME ?? "", config.repository, config.owner);
  if (!process.env.GH_TOKEN || !process.env.REPOSITORY_TOKEN)
    throw new Error("Dedicated Project and repository credentials are required");
  const budget = new DiscoveryBudget("cold", (usage) => save("budget", usage));
  const project = createDiscoveryTransport(budget, process.env.GH_TOKEN);
  const repository = createDiscoveryTransport(budget, process.env.REPOSITORY_TOKEN);
  const api = new GitHubApiClient((args, input) => {
    const endpoint = args[2] ?? "",
      method = args[args.indexOf("--method") + 1];
    const repoMutation =
      args[0] === "api" &&
      args[1] !== "graphql" &&
      ["POST", "PATCH"].includes(method ?? "") &&
      endpoint.startsWith(`repos/${config.repository}/issues`);
    return (repoMutation ? repository : project).runner(args, input);
  });
  const client = new HostedRoadmapClient(config, api);
  const head = runCheckedGit(["rev-parse", "HEAD"], { cwd: root }).trim();
  const resources = object(object(api.request("GET", "rate_limit").body).resources);
  for (const key of ["core", "graphql"]) {
    const rate = object(resources[key]);
    if (typeof rate.remaining !== "number" || typeof rate.reset !== "number")
      throw new Error("Provider quota is unavailable");
    budget.observeProvider({
      resource: key,
      remaining: rate.remaining,
      resetAt: new Date(rate.reset * 1000).toISOString(),
    });
  }
  const bridge = new HostedIntakeBridge(
    client,
    head,
    (repo) => investigateDiscoveryUpstream({ api, budget, http: project, save }, repo),
    save,
    (cache) => {
      const cost = cache ? discoveryInventoryCost(cache) : { requests: 1, bytes: 1 };
      budget.admit(cost.requests, cost.bytes);
    },
  );
  try {
    const inputs = object(event).inputs;
    if (
      process.env.HOSTED_INTAKE_MODE === "probe" ||
      (isRecord(inputs) && inputs.mode === "probe")
    ) {
      const issue = Number(
        process.env.HOSTED_INTAKE_PROBE || (isRecord(inputs) ? inputs.probe_issue : undefined),
      );
      if (!Number.isSafeInteger(issue) || issue !== 3849)
        throw new Error("Only the owner-authorized #3849 neutral canary is permitted");
      try {
        const result = {
          ...(await probeHostedProjectWrite(client, issue)),
          head,
          run: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
        };
        save("write-probe", result);
        console.log(JSON.stringify(result));
      } catch (error) {
        save("write-probe", { status: "failed", head, error: sanitizeOperationError(error) });
        throw error;
      }
      return;
    }
    const comments = bridge.comments();
    const requests = comments.filter(
      (c) => c.user.login === config.owner && c.body.startsWith(hostedRequestMarker),
    );
    let failed = false;
    for (const c of requests) {
      try {
        await bridge.process(c, comments);
      } catch (error) {
        save(`failure-${c.id}`, sanitizeOperationError(error));
        try {
          bridge.diagnostic(c, error, comments);
        } catch (publication) {
          save(`publication-failure-${c.id}`, sanitizeOperationError(publication));
        }
        failed = true;
      }
    }
    save("summary", { status: failed ? "incomplete" : "passed", head, requests: requests.length });
    if (failed) process.exitCode = 1;
  } finally {
    save("api-observations", api.observations);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(JSON.stringify(sanitizeOperationError(error)));
    process.exitCode = 1;
  });
