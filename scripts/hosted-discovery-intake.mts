import { createHash } from "node:crypto";
import {
  hostedAmendmentMarker,
  parseHostedAmendment,
  readHostedAmendment,
  type AmendmentReference,
  type HostedAmendment,
} from "./hosted-discovery-amendment.mts";
import {
  resolveDiscoveryRepository,
  relocationMetadataReader,
  DiscoveryLocationUnavailable,
} from "./upstream-relocation-candidates.mts";
import { isDeepStrictEqual } from "node:util";
import {
  postgresIntakeCheckpoints,
  type HostedIntakeCheckpointStore,
} from "./hosted-discovery-intake-checkpoint.mts";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckedGit } from "./checked-git.mts";
import { RoadmapClient, portFieldInitialization, runDoctor, validateConfig } from "./roadmap.mts";
import { qualificationCatalogObservation } from "./roadmap-qualification.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import {
  createGitHubClient,
  iterateGitHubPages,
  type GitHubClientOptions,
} from "./github-client.mts";
import type { Octokit } from "@octokit/core";
import { discoveryGitHubScope } from "./discovery-github.mts";
import {
  collectRoadmapInventory,
  collectRoadmapInventoryWithRecollection,
  requireRoadmapInventory,
} from "./roadmap-inventory.mts";
import { runScopedDoctor } from "./roadmap-scoped.mts";
import { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";
import {
  DiscoveryRepositoryUnavailable,
  investigateDiscoveryUpstream,
} from "./daily-discovery-sources.mts";
import {
  reconcileDiscoveryIntakeIdentity,
  discoveryGameKey,
} from "./discovery-intake-identity.mts";
import { readCatalogSource } from "./catalog-authoring.mts";
import { assessUpstreamLineage } from "./upstream-lineage.mts";
import {
  discoveryPost,
  recordDiscoveryComment,
  assertDiscoveryCommentMayPost,
} from "./discovery-mutation.mts";
import { validateDiscoveryIntakeBody, discoveryInventoryCost } from "./daily-discovery-session.mts";
import {
  renderPortIssueBody,
  findPortIssueDuplicates,
  normalizedUpstream,
  normalizePortKey,
  portCatalogMarkers,
  portKeyMarkers,
  portUpstreamMarkers,
  portRepositoryIds,
  fieldValue,
} from "./roadmap-issue.mts";
import { observationHash } from "./upstream-observer.mts";
import { validateGitHubBody } from "./github-body-text.mts";
import { isRecord } from "./runtime-values.mts";
import { hostedIntakeMaxPasses } from "./hosted-discovery-intake-runner.mts";
import type { RoadmapInventory, RoadmapInventoryClient } from "./roadmap-inventory.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

export const hostedRequestMarker = "<!-- portcove-hosted-intake:v1 -->";

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
type IntakeIntent = { kind: "create" } | { kind: "observe-existing"; issue: number };

interface Candidate {
  intent?: IntakeIntent;
  title: string;
  upstream: string;
  repository_id: number;
  game: string;
  port_key: string;
  evidence: string;
  resume: string;
}
interface Proposal {
  schema_version: 1 | 2;
  kind: "proposal";
  investigator: string;
  candidates: Candidate[];
  reconcile?: {
    request_comment: number;
    request_sha256: string;
    receipt_comment: number;
    receipt_sha256: string;
    plan_sha256: string;
  };
}
export function parseHostedRequest(body: unknown): Proposal {
  if (typeof body !== "string" || Buffer.byteLength(body) > 64000)
    throw new Error("Hosted request exceeds its comment envelope");
  const match = /^<!-- portcove-hosted-intake:v1 -->\s*```json\n([\s\S]+)\n```\s*$/u.exec(body);
  if (!match) throw new Error("Expected exactly one structured hosted intake request");
  const v = object(JSON.parse(match[1]!));
  if (v.schema_version !== 1 && v.schema_version !== 2)
    throw new Error("Unsupported hosted intake schema");
  exact(v, [
    "schema_version",
    "kind",
    "investigator",
    "candidates",
    ...(v.reconcile === undefined ? [] : ["reconcile"]),
  ]);
  if (v.reconcile !== undefined) {
    const r = object(v.reconcile);
    exact(r, [
      "request_comment",
      "request_sha256",
      "receipt_comment",
      "receipt_sha256",
      "plan_sha256",
    ]);
    positive(r.request_comment);
    positive(r.receipt_comment);
    for (const key of ["request_sha256", "receipt_sha256", "plan_sha256"])
      if (typeof r[key] !== "string" || !/^[a-f0-9]{64}$/u.test(r[key]))
        throw new Error("Expected an exact reconciliation hash");
  }
  if (v.kind !== "proposal" || !Array.isArray(v.candidates) || !v.candidates.length)
    throw new Error("Expected one nonempty logical candidate batch");
  line(v.investigator);
  const seen = new Set<string>();
  const identities = new Set<string>();
  for (const raw of v.candidates) {
    const c = object(raw);
    exact(c, [
      "title",
      "upstream",
      "repository_id",
      "game",
      "port_key",
      "evidence",
      "resume",
      ...(v.schema_version === 2 ? ["intent"] : []),
    ]);
    if (v.schema_version === 2) {
      const intent = object(c.intent);
      if (intent.kind === "observe-existing") {
        exact(intent, ["kind", "issue"]);
        positive(intent.issue);
      } else {
        exact(intent, ["kind"]);
        if (intent.kind !== "create") throw new Error("Unknown candidate intake intent");
      }
    }
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
  updated_at?: string;
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
  amendment?: AmendmentReference;
  location?: { declared: string; current: string; repository_id: number };
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
export async function assertHostedRecovery(
  client: HostedRoadmapOperations,
  inventory: RoadmapInventory,
  number: number,
) {
  requireRoadmapInventory(inventory, client.config.repository, client, { planningIssue: number });
  const issue = await client.repositoryIssue(number);
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
type PlanSlot =
  | Planned
  | (Omit<Planned, "primary" | "evidence_sha256"> & {
      primary: null;
      evidence_sha256: null;
    });
const holdResume =
  "Use owner process dispatch when the exact repository ID and primary evidence are accessible.";
const identityHoldResume =
  "Resolve the explicit issue, implementation key and upstream identity before owner process dispatch.";

class CandidateIdentityConflict extends Error {}

const researchHoldResumes = {
  "owner-research":
    "Resume through a new owner amendment after the candidate's research condition is satisfied.",
  "repository-location":
    "Resume after the declared location and immutable repository ID verify; preserve any unfinished write.",
  "evidence-changed":
    "Submit an owner candidate amendment bound to this slot's exact prior body and evidence hashes.",
} as const;
type ResearchHold = keyof typeof researchHoldResumes;
class CandidateResearchHold extends Error {
  readonly reason: ResearchHold;
  constructor(reason: ResearchHold, message: string) {
    super(message);
    this.reason = reason;
  }
}

interface CandidateHold {
  reason?: ResearchHold;
  port_key: string;
  repository_id: number;
  upstream: string;
  http_status: 404 | null;
  observed_at: string;
  resume: string;
}
interface Delivery {
  hold?: CandidateHold;
  status: string;
  created_issue?: number;
  item_id?: string;
  existing?: boolean;
  canonical_issue?: number;
  created_comment?: number;
  observation_sha256?: string;
  fields?: Record<string, unknown>;
  doctor?: unknown;
}
interface Receipt {
  schema_version: 1;
  request_comment: number;
  request_sha256: string;
  investigator: string;
  plan_sha256: string;
  plan: PlanSlot[];
  plan_encoding?: "proposal-bound-v1" | "proposal-bound-v2";
  delivery: Delivery[];
  status: string;
  head: string;
  run: string;
  attempt: string;
  plan_origin: { head: string; run: string; attempt: string };
  observed_at?: string;
  doctor?: unknown;
  audit_pending?: true;
  error?: unknown;
  continuation?: string | null;
  body_request_comment?: number;
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
export function hostedPlanHash(requestHash: string, plan: PlanSlot[]) {
  return observationHash({
    request_sha256: requestHash,
    candidates: plan.map((p) => ({
      body_sha256: p.body_sha256,
      evidence_sha256: p.evidence_sha256,
    })),
  });
}
function applyHostedAmendment(candidate: Candidate, amendment: HostedAmendment): Candidate {
  const { canonical_owner, ...replacement } = amendment.replacement;
  if (canonical_owner) {
    if (candidate.intent)
      throw new Error(
        "Canonical owner binding requires a legacy candidate without explicit intent",
      );
    return {
      ...candidate,
      ...replacement,
      port_key: canonical_owner.port_key,
      intent: { kind: "observe-existing", issue: canonical_owner.issue },
    };
  }
  if (replacement.game !== undefined && candidate.intent?.kind !== "observe-existing")
    throw new Error("Game label correction requires an explicit existing-owner observation");
  return { ...candidate, ...replacement };
}

function readHostedReceipt(
  comment: Comment,
  request: Comment,
  proposal: Proposal,
  bodyRequest: number,
  all: readonly Comment[] = [],
  owner = "boburning",
  repository = "boburning/portcove",
): Receipt {
  const match = /```json\n([\s\S]+)\n```\s*$/u.exec(comment.body);
  if (!match) throw new Error("Malformed retained hosted receipt");
  const stored = object(JSON.parse(match[1]!));
  if (
    stored.schema_version !== 1 ||
    (stored.body_request_comment ?? request.id) !== bodyRequest ||
    !Array.isArray(stored.plan) ||
    stored.plan.length !== proposal.candidates.length ||
    !Array.isArray(stored.delivery) ||
    stored.delivery.length !== proposal.candidates.length
  )
    throw new Error("Retained receipt body lineage or coverage differs");
  if (
    stored.plan_encoding !== undefined &&
    stored.plan_encoding !== "proposal-bound-v1" &&
    stored.plan_encoding !== "proposal-bound-v2"
  )
    throw new Error("Unknown retained plan encoding");
  stored.plan = stored.plan.map((raw, index) => {
    const binding = object(raw);
    let candidate = proposal.candidates[index]!;
    if (binding.amendment !== undefined) {
      const ref = object(binding.amendment);
      exact(ref, ["comment", "sha256"]);
      const rows = all.filter((c) => c.id === ref.comment);
      if (rows.length !== 1 || observationHash(rows[0]!.body) !== ref.sha256)
        throw new Error("Candidate amendment reference differs");
      const amendment = readHostedAmendment(rows[0]!, owner, repository, request);
      if (amendment.candidate_index !== index || amendment.port_key !== candidate.port_key)
        throw new Error("Candidate amendment identity differs");
      candidate = applyHostedAmendment(candidate, amendment);
    }
    if (binding.location !== undefined) {
      const location = object(binding.location);
      exact(location, ["declared", "current", "repository_id"]);
      if (
        location.declared !== candidate.upstream ||
        location.repository_id !== candidate.repository_id ||
        typeof location.current !== "string" ||
        !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(location.current)
      )
        throw new Error("Retained repository location binding differs");
      candidate = { ...candidate, upstream: location.current };
    }
    const body = hostedBody(candidate, bodyRequest);
    if (
      binding.body_sha256 !== observationHash(body) ||
      (binding.primary === null
        ? stored.plan_encoding !== "proposal-bound-v2" || binding.evidence_sha256 !== null
        : !isRecord(binding.primary) ||
          binding.evidence_sha256 !== observationHash(binding.primary)) ||
      (stored.plan_encoding === undefined
        ? observationHash(binding.candidate) !== observationHash(candidate) || binding.body !== body
        : binding.candidate_index !== index || binding.port_key !== candidate.port_key)
    )
      throw new Error("Retained plan body does not match the exact proposal");
    return {
      candidate,
      body,
      body_sha256: binding.body_sha256,
      evidence_sha256: binding.evidence_sha256,
      primary: binding.primary,
      ...(binding.location === undefined ? {} : { location: binding.location }),
      ...(binding.amendment === undefined ? {} : { amendment: binding.amendment }),
    };
  });
  const receipt = stored as unknown as Receipt;
  if (
    "audit_pending" in receipt &&
    (receipt.audit_pending !== true ||
      receipt.delivery.length <= 10 ||
      receipt.delivery.some((d) => missingDeliveryProof(d)) ||
      receipt.doctor !== undefined ||
      !["applying", "incomplete"].includes(receipt.status))
  )
    throw new Error("Retained required full doctor checkpoint lacks complete scoped delivery");
  const ids = new Set<number>();
  for (const [index, d] of receipt.delivery.entries()) {
    if (
      !d ||
      ![
        "prepared",
        "preflight",
        "reviewed",
        "create-attempted",
        "created",
        "delivered",
        "existing",
      ].includes(d.status) ||
      (d.status === "delivered" && !d.created_issue) ||
      (d.status === "created" && !d.created_issue && !(d.created_comment && d.canonical_issue))
    )
      throw new Error("Retained delivery state is incomplete");
    const slot = receipt.plan[index]!;
    if (d.hold) {
      const c = slot.candidate;
      const h = d.hold;
      if (
        receipt.plan_encoding !== "proposal-bound-v2" ||
        !canHold(d) ||
        h.port_key !== c.port_key ||
        h.repository_id !== c.repository_id ||
        h.upstream !== c.upstream ||
        !(
          (h.http_status === 404 && h.resume === holdResume) ||
          (h.http_status === null && c.intent && h.resume === identityHoldResume) ||
          (h.http_status === null && h.reason && h.resume === researchHoldResumes[h.reason])
        ) ||
        typeof h.observed_at !== "string" ||
        !Number.isFinite(Date.parse(h.observed_at))
      )
        throw new Error("Retained candidate hold is invalid");
    } else if (slot.primary === null || "hold" in d) {
      throw new Error("Unbound primary requires a candidate hold");
    }
    const intent = slot.candidate.intent;
    if (
      intent?.kind === "observe-existing" &&
      (d.created_issue || (d.canonical_issue !== undefined && d.canonical_issue !== intent.issue))
    )
      throw new Error("Retained observation differs from its explicit canonical target");
    if (intent?.kind === "create" && (d.canonical_issue || d.existing || d.created_comment))
      throw new Error("Retained creation cannot contain an existing-owner observation");
    if (d.canonical_issue !== undefined) positive(d.canonical_issue);
    if (d.created_comment !== undefined) positive(d.created_comment);
    if (d.status === "existing") {
      positive(d.canonical_issue);
      positive(d.created_comment);
      if (!d.existing || d.created_issue || !/^[a-f0-9]{64}$/u.test(d.observation_sha256 ?? ""))
        throw new Error("Retained existing-owner observation is incomplete");
      if (slot.candidate.intent?.kind === "observe-existing") receiptProjectItemId(d.item_id);
    }
    if (d.created_issue !== undefined) {
      positive(d.created_issue);
      if (ids.has(d.created_issue))
        throw new Error("Retained canonical issue identity is repeated");
      ids.add(d.created_issue);
    }
  }
  if (
    receipt.request_comment !== request.id ||
    receipt.request_sha256 !== observationHash(request.body) ||
    hostedPlanHash(receipt.request_sha256, receipt.plan) !== receipt.plan_sha256
  )
    throw new Error("Changed proposal or invalid retained plan; preserve prior receipt");
  return receipt;
}
function canHold(d: Delivery) {
  return (
    ["prepared", "preflight", "reviewed"].includes(d.status) &&
    d.created_issue === undefined &&
    d.created_comment === undefined &&
    d.canonical_issue === undefined &&
    !d.existing
  );
}
function isDelivered(d: Delivery) {
  return d.status === "delivered" || d.status === "existing";
}
function missingDeliveryProof(d: Delivery) {
  if (!d || !isDelivered(d) || !isRecord(d.doctor)) return true;
  const doctor = d.doctor;
  const issue = d.created_issue ?? d.canonical_issue;
  if (
    d.status === "delivered" &&
    (!isRecord(d.fields) ||
      Object.entries(portFieldInitialization(null)).some(
        ([field, value]) => d.fields?.[field] !== value,
      ))
  )
    return true;
  return (
    doctor.status !== "passed" ||
    doctor.coverage !== "complete" ||
    observationHash(doctor.issues) !== observationHash([issue]) ||
    typeof doctor.receipt_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(doctor.receipt_sha256)
  );
}
function deliveryCounts(delivery: readonly Delivery[], candidates = delivery.length) {
  const delivered = delivery.filter((d) => d.status === "delivered").length;
  const existing = delivery.filter((d) => d.status === "existing").length;
  const held = delivery.filter((d) => d.hold).length;
  return { delivered, existing, held, pending: candidates - delivered - existing };
}
/**
 * One ordered candidate slot as its receipt records it: the proposal identity,
 * the delivery state and the linked canonical issue (the created issue, or the
 * verified existing owner). Clocks, doctors and evidence stay out of it.
 */
export interface HostedCandidateSlot {
  candidate_index: number;
  port_key: string;
  repository_id: number;
  upstream: string;
  /** Null until a receipt is published. */
  delivery_status: string | null;
  linked_issue: number | null;
  existing: boolean;
  hold: { http_status: number | null; resume: string } | null;
}
function candidateSlots(proposal: Proposal, delivery: readonly Delivery[]): HostedCandidateSlot[] {
  return proposal.candidates.map((candidate, index) => {
    const d = delivery[index];
    return {
      candidate_index: index,
      port_key: candidate.port_key,
      repository_id: candidate.repository_id,
      upstream: candidate.upstream,
      delivery_status: d?.status ?? null,
      linked_issue: d?.created_issue ?? d?.canonical_issue ?? null,
      existing: d?.existing === true,
      hold: d?.hold ? { http_status: d.hold.http_status, resume: d.hold.resume } : null,
    };
  });
}
const receiptByteLimit = 60_000;
const projectItemIdJsonLimit = 256;
const maxProviderId = Number.MAX_SAFE_INTEGER;
const capacityHash = "a".repeat(64);
const largestPrimary = {
  repository_id: maxProviderId,
  readme_commit: "a".repeat(40),
  readme_blob: "a".repeat(40),
  release_fingerprint: capacityHash,
};

function receiptProjectItemId(id: unknown) {
  if (
    typeof id !== "string" ||
    !id ||
    Buffer.byteLength(JSON.stringify(id)) > projectItemIdJsonLimit
  )
    throw new Error("Verified Project item ID is unavailable or exceeds the receipt bound");
  return id;
}

function encodeReceipt(r: Receipt) {
  // Exact bodies are reconstructed from the hash-bound owner proposal. Do not
  // repeat its evidence in both candidate and rendered-body copies on the wire.
  const wire = {
    ...r,
    plan_encoding: r.plan_encoding ?? "proposal-bound-v1",
    plan: r.plan.map(({ candidate, body: _body, ...binding }, index) => ({
      ...binding,
      candidate_index: index,
      port_key: candidate.port_key,
    })),
  };
  return `${receiptMarker(r.request_comment)}\nHosted intake **${r.status}**.\n\n\`\`\`json\n${JSON.stringify(wire, null, 2)}\n\`\`\``;
}

function checkpointSlots(receipt: Receipt) {
  return receipt.plan.map(
    ({ candidate, body_sha256, evidence_sha256, primary, location, amendment }, index) => ({
      ...(location ? { location } : {}),
      ...(amendment ? { amendment } : {}),
      ...(candidate.intent ? { intent: candidate.intent } : {}),
      port_key: candidate.port_key,
      body_sha256,
      evidence_sha256,
      primary,
      delivery: receipt.delivery[index],
    }),
  );
}

function receiptBody(r: Receipt) {
  const body = encodeReceipt(r);
  validateGitHubBody(body);
  if (Buffer.byteLength(body) > receiptByteLimit)
    throw new Error("Hosted receipt exceeds its bounded comment envelope");
  return body;
}

function receiptDiagnostic(error: unknown) {
  const diagnostic = sanitizeOperationError(error);
  if (Buffer.byteLength(JSON.stringify(diagnostic)) <= 3072) return diagnostic;
  // Even the longest JSON escape uses six bytes per retained character.
  return {
    ...diagnostic,
    message: `${Array.from(diagnostic.message).slice(0, 480).join("")} [truncated]`,
  };
}

function assertReceiptCapacity(receipt: Receipt) {
  const largestDelivery: Delivery = {
    status: "create-attempted",
    created_issue: maxProviderId,
    item_id: "a".repeat(projectItemIdJsonLimit - 2),
    existing: false,
    canonical_issue: maxProviderId,
    created_comment: maxProviderId,
    observation_sha256: capacityHash,
    fields: portFieldInitialization(null),
    doctor: {
      status: "passed",
      coverage: "complete",
      global_health: "not_evaluated",
      issues: [maxProviderId],
      checked_issue_count: maxProviderId,
      receipt_sha256: capacityHash,
    },
  };
  // Size the serialized shape, including indentation and retained holds. A
  // previously unbound hold can later add a primary binding.
  const capacity = encodeReceipt({
    ...receipt,
    plan: receipt.plan.map((slot) =>
      slot.primary
        ? slot
        : {
            ...slot,
            primary: largestPrimary,
            evidence_sha256: capacityHash,
          },
    ),
    delivery: receipt.delivery.map(({ hold, ...delivery }, index) => {
      const candidate = receipt.plan[index]!.candidate;
      const held = {
        ...delivery,
        hold: hold ?? candidateHold(candidate),
      };
      const complete = { ...delivery, ...largestDelivery };
      const bytes = (value: Delivery) =>
        Buffer.byteLength(JSON.stringify(value, null, 2).replaceAll("\n", "\n    "));
      return canHold(delivery) && bytes(held) > bytes(complete) ? held : complete;
    }),
  });
  // Leave room for the run metadata, terminal diagnostic and full doctor.
  if (Buffer.byteLength(capacity) + 4096 > receiptByteLimit)
    throw new Error("Logical batch cannot retain complete delivery receipts");
}

function candidateHold(candidate: Candidate, identityConflict = false): CandidateHold {
  return {
    port_key: candidate.port_key,
    repository_id: candidate.repository_id,
    upstream: candidate.upstream,
    http_status: identityConflict ? null : 404,
    observed_at: new Date().toISOString(),
    resume: identityConflict ? identityHoldResume : holdResume,
  };
}
export type HostedRoadmapOperations = RoadmapInventoryClient &
  Pick<
    RoadmapClient,
    | "viewList"
    | "projectAudit"
    | "repositoryIssues"
    | "createPortIssue"
    | "normalizePortIssue"
    | "repositoryIssue"
    | "executionIssue"
    | "setItemFields"
  >;
export class HostedIntakeBridge {
  // Failed mutations remain sticky even if publishing a later diagnostic works.
  uncertainMutations = 0;
  async mutation<T>(action: () => T | Promise<T>): Promise<T> {
    this.uncertainMutations++;
    const result = await action();
    this.uncertainMutations--;
    return result;
  }
  continuation(error: unknown) {
    return this.uncertainMutations === 0 &&
      error instanceof GitHubApiError &&
      ["inventory_changed", "repository_changed", "budget_exhausted", "quota_stale"].includes(
        error.code,
      )
      ? error.code === "budget_exhausted"
        ? "budget_exhausted"
        : "inventory_changed"
      : null;
  }
  planningIssues = new Set<number>();
  inventoryRecollections = 0;
  auditRoadmap: typeof runDoctor = runDoctor;
  /** #177 identity and revision bracketing the last complete, unchanged comment read. */
  queue: { node_id: string; comments: number; updated_at: string } | undefined;
  /** The read-only status route's queue-derived request budget, when it applies. */
  statusBudget: HostedStatusBudget | undefined;
  readonly client: HostedRoadmapOperations;
  readonly github: { project: Octokit; repository: Octokit };
  readonly head: string;
  readonly research: (repository: string) => ReturnType<typeof investigateDiscoveryUpstream>;
  readonly save: (name: string, value: unknown) => void;
  readonly admitRecollection: (cache?: RoadmapInventory) => void | Promise<void>;
  readonly admitWarmInventory: (cache: RoadmapInventory) => void | Promise<void>;
  readonly durable: {
    checkpoints?: () => HostedIntakeCheckpointStore;
    requireIntent?: boolean;
    resolveRepository?: (repository: string, id: number) => Promise<string>;
  };
  constructor(
    client: HostedRoadmapOperations,
    github: { project: Octokit; repository: Octokit },
    head: string,
    research: (repository: string) => ReturnType<typeof investigateDiscoveryUpstream>,
    save: (name: string, value: unknown) => void,
    admitRecollection: (cache?: RoadmapInventory) => void | Promise<void> = () => {
      throw new Error("Inventory recollection admission is not configured");
    },
    admitWarmInventory: (cache: RoadmapInventory) => void | Promise<void> = () => {},
    durable: HostedIntakeBridge["durable"] = {},
  ) {
    this.client = client;
    this.github = github;
    this.head = head;
    this.research = research;
    this.save = save;
    this.admitRecollection = admitRecollection;
    this.admitWarmInventory = admitWarmInventory;
    this.durable = durable;
  }
  get prefix() {
    return `repos/${this.client.config.repository}/issues`;
  }
  private async issueComments(issue: number, perPage: number) {
    if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("Invalid comment owner");
    const rows: unknown[] = [],
      ids = new Set<number>();
    for await (const page of iterateGitHubPages(this.github.project, {
      url: `https://api.github.com/${this.prefix}/${issue}/comments?per_page=${perPage}`,
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    })) {
      if (!Array.isArray(page.data)) throw new Error("Hosted comment inventory is incomplete");
      for (const row of page.data as unknown[]) {
        const id = positive(object(row).id);
        if (ids.has(id)) throw new Error("Hosted comments contain duplicate identities");
        ids.add(id);
        rows.push(row);
      }
    }
    return rows;
  }
  async comments() {
    const before = object(
      (
        await this.github.project.request({
          method: "GET",
          url: new URL(`${this.prefix}/177`, "https://api.github.com/").href,
        })
      ).data,
    );
    const comments = (await this.issueComments(177, 20)).map(
      (v) => object(v) as unknown as Comment,
    );
    const after = object(
      (
        await this.github.project.request({
          method: "GET",
          url: new URL(`${this.prefix}/177`, "https://api.github.com/").href,
        })
      ).data,
    );
    if (
      typeof before.node_id !== "string" ||
      before.node_id !== after.node_id ||
      !Number.isSafeInteger(before.comments) ||
      !Number.isSafeInteger(after.comments) ||
      typeof before.updated_at !== "string" ||
      typeof after.updated_at !== "string"
    )
      throw new Error("Hosted request comment inventory changed or is incomplete");
    if (before.comments !== after.comments || before.updated_at !== after.updated_at)
      throw new GitHubApiError(
        "inventory_changed",
        "Hosted request queue changed during collection",
      );
    if (after.comments !== comments.length)
      throw new Error("Hosted request comment inventory is incomplete");
    this.queue = {
      node_id: after.node_id,
      comments: after.comments,
      updated_at: after.updated_at,
    };
    return comments;
  }
  async fresh(c: Comment) {
    const got = object(
      (
        await this.github.project.request({
          method: "GET",
          url: new URL(`${this.prefix}/comments/${c.id}`, "https://api.github.com/").href,
        })
      ).data,
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
  async persist(receipt: Receipt, prior?: Comment, checkpointBody?: string) {
    if (checkpointBody === undefined) receipt.observed_at = new Date().toISOString();
    this.save(`receipt-${receipt.request_comment}`, receipt);
    const body = checkpointBody ?? receiptBody(receipt);
    if (prior) await this.fresh(prior);
    return await this.mutation(async () => {
      const got = object(
        (
          await this.github.repository.request({
            method: prior ? "PATCH" : "POST",
            url: new URL(
              prior ? `${this.prefix}/comments/${prior.id}` : `${this.prefix}/177/comments`,
              "https://api.github.com/",
            ).href,
            data: { body },
          })
        ).data,
      );
      const observed = object(
        (
          await this.github.project.request({
            method: "GET",
            url: new URL(`${this.prefix}/comments/${positive(got.id)}`, "https://api.github.com/")
              .href,
          })
        ).data,
      );
      if (observed.body !== body || object(observed.user).login !== "github-actions[bot]")
        throw new Error("Bot receipt publication/readback is unconfirmed; no further mutation");
      return observed as unknown as Comment;
    });
  }
  async diagnostic(request: Comment, error: unknown, all: Comment[]) {
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
      continuation: this.continuation(error),
      resume: this.continuation(error)
        ? "The executor continues this retained request within its finite deadline while progress is demonstrated. After that bound, retain it for the next existing intake event; do not recapture delivered identities."
        : "Resolve the named failure and reread the exact proposal/plan before resuming; never repeat an ambiguous creation.",
    };
    const body = `${marker}\n\`\`\`json\n${JSON.stringify(diagnostic, null, 2)}\n\`\`\``;
    if (previous) await this.fresh(previous);
    const got = object(
      (
        await this.github.repository.request({
          method: previous ? "PATCH" : "POST",
          url: new URL(
            previous ? `${this.prefix}/comments/${previous.id}` : `${this.prefix}/177/comments`,
            "https://api.github.com/",
          ).href,
          data: { body },
        })
      ).data,
    );
    const after = object(
      (
        await this.github.project.request({
          method: "GET",
          url: new URL(`${this.prefix}/comments/${positive(got.id)}`, "https://api.github.com/")
            .href,
        })
      ).data,
    );
    if (after.body !== body || object(after.user).login !== "github-actions[bot]")
      throw new Error("Diagnostic publication readback is unconfirmed");
  }
  async primary(c: Candidate, request: number): Promise<Planned> {
    const declared = c.upstream;
    const name = new URL(declared).pathname.slice(1);
    let resolved = name;
    try {
      resolved = (await this.durable.resolveRepository?.(name, c.repository_id)) ?? name;
    } catch (error) {
      if (!(error instanceof DiscoveryLocationUnavailable)) throw error;
      throw new CandidateResearchHold("repository-location", error.message);
    }
    const current = `https://github.com/${resolved}`;
    if (normalizedUpstream(current) !== normalizedUpstream(declared))
      c = { ...c, upstream: current };
    const primary = await this.research(resolved);
    if (
      primary.metadata.id !== c.repository_id ||
      normalizedUpstream(`https://github.com/${String(primary.metadata.full_name)}`) !==
        normalizedUpstream(c.upstream)
    )
      throw new CandidateResearchHold(
        "repository-location",
        "Primary immutable repository identity changed",
      );
    const identity = {
      repository_id: c.repository_id,
      readme_commit: primary.readme.commit,
      readme_blob: primary.readme.blob,
      release_fingerprint: primary.fingerprint,
    };
    if (
      typeof identity.readme_blob !== "string" ||
      Buffer.byteLength(JSON.stringify(identity)) >
        Buffer.byteLength(JSON.stringify(largestPrimary))
    )
      throw new Error("Primary binding exceeds the receipt bound");
    const body = hostedBody(c, request);
    validateDiscoveryIntakeBody(body, c.upstream, c.port_key);
    this.save(`primary-${request}-${c.port_key}`, primary);
    return {
      candidate: c,
      body,
      body_sha256: observationHash(body),
      evidence_sha256: observationHash(identity),
      primary: identity,
      ...(c.upstream === declared
        ? {}
        : {
            location: { declared, current: c.upstream, repository_id: c.repository_id },
          }),
    };
  }
  async inventory(cache?: RoadmapInventory, full = false) {
    if (cache) await this.admitWarmInventory(cache);
    this.client._completeProjectContext = undefined;
    this.client._projectContext = undefined;
    let first: ReturnType<typeof sanitizeOperationError> | undefined;
    return await collectRoadmapInventoryWithRecollection(
      this.client,
      async () =>
        await collectRoadmapInventory(
          this.client,
          cache,
          full
            ? undefined
            : {
                scope: "intake",
                planningIssues: [...this.planningIssues],
              },
        ),
      this,
      {
        before: async (error) => {
          first = sanitizeOperationError(error);
          this.save("inventory-recollection", {
            status: "pending",
            allowance: this.inventoryRecollections,
            first,
          });
          await this.admitRecollection(cache);
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
    const identity = reconcileDiscoveryIntakeIdentity(
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
    if (c.intent?.kind === "observe-existing") {
      const target = c.intent.issue;
      const matching = others.filter((issue) =>
        [...portCatalogMarkers(issue.body), ...portKeyMarkers(issue.body)].includes(c.port_key),
      );
      const expected = matching[0];
      const authored = records.find((record) => record.listing.id === c.port_key);
      const knownIds = expected?.body ? portRepositoryIds(expected.body) : [];
      const exactAuthoredOwner =
        authored?.listing.issue_number === target &&
        normalizedUpstream(authored.listing.project_url) === normalizedUpstream(c.upstream);
      if (
        identity.disposition !== "Existing canonical owner" ||
        identity.issues.length !== 1 ||
        identity.issues[0] !== target ||
        !identity.game_scope_known ||
        (!identity.repository_identity_known && !exactAuthoredOwner) ||
        knownIds.some((id) => id !== c.repository_id) ||
        matching.length !== 1 ||
        !expected ||
        expected.number !== target ||
        !expected.body?.includes("<!-- portcove-port -->") ||
        portUpstreamMarkers(expected.body).length !== 1 ||
        normalizedUpstream(portUpstreamMarkers(expected.body)[0]) !== normalizedUpstream(c.upstream)
      )
        throw new CandidateIdentityConflict(
          "Explicit observation target does not own the implementation key and repository",
        );
      return target;
    }
    const owner =
      identity.disposition === "Existing canonical owner" &&
      identity.game_scope_known &&
      identity.repository_identity_known
        ? identity.issues[0]
        : undefined;
    if (c.intent?.kind === "create" && identity.disposition !== "New canonical intake")
      throw new CandidateIdentityConflict(
        `Explicit create conflicts with canonical identity: ${identity.reason}`,
      );
    if (identity.disposition !== "New canonical intake" && !owner)
      throw new Error(
        `Canonical discovery identity held: ${identity.disposition}; ${identity.reason}`,
      );
    try {
      assertHostedCatalogIdentity(c, records, owner ?? exclude);
    } catch (error) {
      if (!c.intent) throw error;
      throw new CandidateIdentityConflict(error instanceof Error ? error.message : String(error));
    }
    const duplicates = findPortIssueDuplicates(others, {
      title: c.title,
      upstream: c.upstream,
      portKey: c.port_key,
      repositoryIdentity: { id: c.repository_id, game: c.game },
      catalogRecords: records,
    });
    if (duplicates.some((row) => row.issue.number !== owner)) {
      const message = `Canonical duplicate: ${duplicates.map((x) => x.issue.number).join(", ")}`;
      if (c.intent) throw new CandidateIdentityConflict(message);
      throw new Error(message);
    }
    return owner;
  }
  async observeExisting(
    request: Comment,
    p: Planned,
    d: Delivery,
    owner: number,
    inventory: RoadmapInventory,
    persist: () => void | Promise<void>,
  ) {
    if (d.created_issue || (d.canonical_issue && d.canonical_issue !== owner))
      throw new Error("Canonical owner changed during retained delivery");
    const expected = inventory.issues.find((issue) => issue.number === owner);
    const freshOwner = async () => {
      const current = await this.client.repositoryIssue(owner);
      if (
        !expected ||
        expected.id !== current.node_id ||
        expected.body !== current.body ||
        expected.title !== current.title ||
        String(expected.state).toLowerCase() !== String(current.state).toLowerCase()
      )
        throw new Error("Existing canonical owner changed; preserve owner work");
    };
    await freshOwner();
    const existingItem =
      p.candidate.intent?.kind === "observe-existing"
        ? (await this.client.executionIssue(owner)).item
        : undefined;
    if (existingItem) {
      const memberships = [...inventory.items, ...inventory.archivedItems].filter(
        (item) => item.content?.id === expected?.id,
      );
      if (
        existingItem.content.id !== expected?.id ||
        fieldValue(existingItem, "Work type") !== "Port" ||
        memberships.length !== 1 ||
        memberships[0]?.id !== existingItem.id ||
        memberships[0]?.isArchived !== false
      )
        throw new CandidateIdentityConflict(
          "Explicit observation Project identity does not match the canonical port issue",
        );
      receiptProjectItemId(existingItem.id);
    }
    this.planningIssues.add(owner);
    const observation = { candidate: p.candidate, primary: p.primary };
    const marker = `<!-- portcove-hosted-observation:${observationHash(observation)} -->`;
    const body = `${marker}\nDated discovery observation from #177 for existing canonical owner #${owner}. Immutable repository ID and game scope match this owner; any proposed independent-implementation claim is superseded by that identity readback. Candidate prose below remains attributed investigator evidence, not verified qualification or a change to this owner's specification. No new implementation, catalog admission or planning change is claimed.\n\n\`\`\`json\n${JSON.stringify(observation, null, 2)}\n\`\`\``;
    validateGitHubBody(body);
    const rows = (await this.issueComments(owner, 100))
      .map((value) => object(value) as unknown as Comment)
      .filter((c) => c.user.login === "github-actions[bot]" && c.body.startsWith(marker));
    if (rows.length > 1) throw new Error("Ambiguous existing-owner observation marker");
    let comment = rows[0];
    if (!comment) {
      assertDiscoveryCommentMayPost(d);
      await freshOwner();
      await this.fresh(request);
      d.canonical_issue = owner;
      comment = await this.mutation(
        async () =>
          await discoveryPost(
            d,
            async () => {
              const posted = object(
                (
                  await this.github.repository.request({
                    method: "POST",
                    url: new URL(`${this.prefix}/${owner}/comments`, "https://api.github.com/")
                      .href,
                    data: { body },
                  })
                ).data,
              );
              await recordDiscoveryComment(d, posted.id, persist);
              return posted as unknown as Comment;
            },
            persist,
          ),
      );
    }
    const observed = object(
      (
        await this.github.project.request({
          method: "GET",
          url: new URL(`${this.prefix}/comments/${positive(comment.id)}`, "https://api.github.com/")
            .href,
        })
      ).data,
    ) as unknown as Comment;
    if (
      observed.body !== body ||
      observed.user.login !== "github-actions[bot]" ||
      observed.issue_url !== `https://api.github.com/${this.prefix}/${owner}` ||
      (d.created_comment && d.created_comment !== observed.id)
    )
      throw new Error("Existing-owner observation readback differs");
    await freshOwner();
    if (existingItem) {
      const live = (await this.client.executionIssue(owner)).item;
      if (live.id !== existingItem.id || live.content.id !== existingItem.content.id)
        throw new Error("Existing-owner Project identity changed during observation");
      d.item_id = receiptProjectItemId(live.id);
    }
    d.canonical_issue = owner;
    d.created_comment = observed.id;
    d.observation_sha256 = observationHash(body);
    d.existing = true;
    const doctor = await runScopedDoctor(this.client.config, this.client, { issues: [owner] });
    this.save(`doctor-${request.id}-${owner}`, doctor);
    d.doctor = compactDoctor(doctor);
    d.status = "existing";
    await persist();
  }
  async status(request: Comment, all: Comment[]) {
    trustedHostedComment(request, this.client.config.owner);
    const proposal = parseHostedRequest(request.body);
    const found = all.filter(
      (c) => c.user.login === "github-actions[bot]" && c.body.startsWith(receiptMarker(request.id)),
    );
    if (found.length > 1) throw new Error("Ambiguous hosted receipt identity");
    const lineage = await this.reconciliation(request, proposal, all);
    const receipt = found[0]
      ? readHostedReceipt(
          found[0],
          request,
          proposal,
          lineage?.bodyRequest ?? request.id,
          all,
          this.client.config.owner,
          this.client.config.repository,
        )
      : undefined;
    const deliveries = receipt?.delivery ?? [];
    const counts = deliveryCounts(deliveries, proposal.candidates.length);
    const diagnostics = all.filter(
      (c) =>
        c.user.login === "github-actions[bot]" &&
        c.body.startsWith(`<!-- portcove-hosted-intake-diagnostic:${request.id} -->`),
    );
    if (diagnostics.length > 1) throw new Error("Ambiguous hosted diagnostic identity");
    let diagnostic: Record<string, unknown> | undefined;
    const latestDiagnostic = diagnostics[0];
    if (
      latestDiagnostic &&
      (!receipt ||
        (receipt.status === "complete_with_holds" &&
          Date.parse(latestDiagnostic.updated_at ?? "") >= Date.parse(receipt.observed_at ?? "")))
    ) {
      const match = latestDiagnostic.body.match(/```json\n([\s\S]+)\n```\s*$/u);
      if (!match) throw new Error("Malformed hosted diagnostic");
      const value = object(JSON.parse(match[1]!));
      if (
        value.request_comment === request.id &&
        value.request_sha256 === observationHash(request.body)
      )
        diagnostic = value;
    }
    if (receipt?.status === "complete" || receipt?.status === "complete_with_holds") {
      if (
        (receipt.status === "complete"
          ? counts.pending !== 0
          : counts.held === 0 || counts.pending !== counts.held) ||
        deliveries.some((d) => !d.hold && missingDeliveryProof(d))
      )
        throw new Error("Complete receipt lacks candidate-bound scoped doctors");
      if (receipt.status === "complete" && proposal.candidates.length > 10) {
        const doctor = receipt.doctor;
        if (
          !isRecord(doctor) ||
          doctor.status !== "passed" ||
          doctor.coverage !== "complete" ||
          doctor.global_health !== "passed"
        )
          throw new Error("Complete logical batch lacks its required full doctor");
      }
    }
    const error = receipt?.error ?? diagnostic?.error;
    const failure = isRecord(error) ? error : undefined;
    const legacyRecoverable =
      typeof failure?.code === "string" &&
      ["repository_changed", "inventory_changed", "budget_exhausted", "quota_stale"].includes(
        failure.code,
      );
    const continuation =
      receipt && "continuation" in receipt ? receipt.continuation : diagnostic?.continuation;
    const recoverable =
      continuation === undefined
        ? legacyRecoverable
        : typeof continuation === "string" &&
          ["inventory_changed", "budget_exhausted"].includes(continuation);
    return {
      request_comment: request.id,
      receipt_comment: found[0]?.id ?? null,
      reconciles: proposal.reconcile?.request_comment ?? null,
      body_request_comment: lineage?.bodyRequest ?? request.id,
      status:
        !receipt && !failure
          ? "submitted"
          : receipt?.status === "complete" || receipt?.status === "complete_with_holds"
            ? receipt.status
            : ((receipt?.status === "incomplete" || !receipt) && !recoverable) ||
                (receipt?.status === "incomplete" &&
                  deliveries.some((d) => d.status === "create-attempted"))
              ? "blocked"
              : "partial",
      candidates: proposal.candidates.length,
      ...counts,
      full_doctor_required: proposal.candidates.length > 10,
      ...(receipt?.audit_pending ? { audit_pending: true } : {}),
      doctor: receipt?.doctor ?? null,
      last_error: failure ?? null,
      observed_at: receipt?.observed_at ?? null,
      slots: candidateSlots(
        receipt ? { ...proposal, candidates: receipt.plan.map((p) => p.candidate) } : proposal,
        deliveries,
      ),
    };
  }
  async reconciliation(request: Comment, proposal: Proposal, all: Comment[]) {
    const ref = proposal.reconcile;
    if (!ref) return null;
    if (ref.request_comment >= request.id)
      throw new Error("Reconciliation must name an earlier request");
    const sources = all.filter((c) => c.id === ref.request_comment);
    const receipts = all.filter((c) => c.id === ref.receipt_comment);
    if (sources.length !== 1 || receipts.length !== 1)
      throw new Error("Reconciliation source identity is unavailable");
    if (
      all.filter(
        (c) =>
          c.user.login === "github-actions[bot]" &&
          c.body.startsWith(receiptMarker(ref.request_comment)),
      ).length !== 1
    )
      throw new Error("Ambiguous reconciliation source receipt identity");
    const source = trustedHostedComment(sources[0], this.client.config.owner),
      comment = receipts[0]!;
    await this.fresh(source);
    await this.fresh(comment);
    const offset = source.body.indexOf(hostedRequestMarker);
    if (
      offset <= 0 ||
      source.body.indexOf(hostedRequestMarker, offset + hostedRequestMarker.length) !== -1
    )
      throw new Error(
        "Reconciliation requires a withdrawn source with its exact original proposal retained",
      );
    const original = { ...source, body: source.body.slice(offset) };
    const old = parseHostedRequest(original.body);
    if (
      observationHash(original.body) !== ref.request_sha256 ||
      comment.user.login !== "github-actions[bot]" ||
      !comment.body.startsWith(receiptMarker(source.id)) ||
      observationHash(comment.body) !== ref.receipt_sha256 ||
      observationHash(old.candidates) !== observationHash(proposal.candidates)
    )
      throw new Error("Reconciliation source hashes or complete ordered candidate bodies differ");
    const raw = object(
      JSON.parse(comment.body.match(/```json\n([\s\S]+)\n```\s*$/u)?.[1] ?? "null"),
    );
    const bodyRequest =
      raw.body_request_comment === undefined ? source.id : positive(raw.body_request_comment);
    if (bodyRequest > source.id || (old.reconcile === undefined && bodyRequest !== source.id))
      throw new Error("Reconciliation root marker identity differs");
    const receipt = readHostedReceipt(
      comment,
      original,
      old,
      bodyRequest,
      all,
      this.client.config.owner,
      this.client.config.repository,
    );
    if (
      receipt.plan_sha256 !== ref.plan_sha256 ||
      receipt.status === "complete" ||
      !receipt.delivery.some((d) => d.created_issue)
    )
      throw new Error("Reconciliation requires the exact incomplete partially created receipt");
    return { source, comment, receipt, bodyRequest };
  }
  private async finishAudit(
    receipt: Receipt,
    persist: () => Promise<void>,
    cache?: RoadmapInventory,
  ) {
    const inventory = await this.inventory(cache, true);
    const global = await this.auditRoadmap(this.client.config, this.client, {
      quiet: true,
      inventory,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      const missing = new Set(
        [
          ...message.matchAll(/^- Catalog port lacks a canonical Project issue: ([a-z0-9-]+)$/gmu),
        ].map((match) => match[1]),
      );
      if (missing.size) {
        const records = readCatalogSource(
          fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url)),
        ).records;
        const repairs = records
          .filter((record) => missing.has(record.listing.id))
          .map(({ listing }) => {
            const owners = inventory.issues.filter(
              (issue) =>
                portKeyMarkers(issue.body).includes(listing.id) &&
                portUpstreamMarkers(issue.body).length === 1 &&
                normalizedUpstream(portUpstreamMarkers(issue.body)[0]) ===
                  normalizedUpstream(listing.project_url),
            );
            const owner = owners.length === 1 ? owners[0]?.number : undefined;
            return {
              catalog_id: listing.id,
              issue: owner ?? listing.issue_number ?? null,
              remedy: owner
                ? `node scripts/roadmap.mts normalize-port --issue ${owner}`
                : "Reconcile the exact catalog identity with its existing owner",
            };
          });
        this.save(`audit-repairs-${receipt.request_comment}`, repairs);
      }
      throw error;
    });
    receipt.doctor = {
      status: "passed",
      coverage: "complete",
      global_health: "passed",
      receipt_sha256: observationHash(global),
    };
    this.save(`global-doctor-${receipt.request_comment}`, receipt.doctor);
    receipt.status = "complete";
    delete receipt.audit_pending;
    delete receipt.error;
    delete receipt.continuation;
    await persist();
  }
  async process(request: Comment, all: Comment[], { resumeHolds = false, auditOnly = false } = {}) {
    this.uncertainMutations = 0;
    trustedHostedComment(request, this.client.config.owner);
    await this.fresh(request);
    const proposal = parseHostedRequest(request.body);
    const lineage = await this.reconciliation(request, proposal, all);
    const bodyRequest = lineage?.bodyRequest ?? request.id;
    const freshLineage = async () => {
      if (lineage) {
        await this.fresh(lineage.source);
        await this.fresh(lineage.comment);
      }
    };
    const found = all.filter(
      (c) => c.user.login === "github-actions[bot]" && c.body.startsWith(receiptMarker(request.id)),
    );
    if (found.length > 1) throw new Error("Ambiguous hosted receipt identity");
    const parsedAmendments = all.flatMap((comment) => {
      if (
        comment.user.login !== this.client.config.owner ||
        !comment.body.startsWith(hostedAmendmentMarker)
      )
        return [];
      try {
        return [{ comment, value: parseHostedAmendment(comment.body) }];
      } catch {
        // Invalid comments grant no authority. The triggering event still reports
        // its parsing failure, while independent proposals can drain normally.
        return [];
      }
    });
    const amendments = parsedAmendments
      .filter(({ value }) => value.request_comment === request.id)
      .map(({ comment }) => ({
        comment,
        value: readHostedAmendment(
          comment,
          this.client.config.owner,
          this.client.config.repository,
          request,
        ),
      }));
    const freshAmendments = async () => {
      for (const { comment } of amendments) await this.fresh(comment);
    };
    let prior = found[0];
    if (proposal.schema_version === 1 && this.durable.requireIntent && !prior && !lineage)
      throw new Error(
        "Submit new candidates using schema version 2 with an explicit intake intent",
      );
    let receipt: Receipt | undefined;
    if (auditOnly && proposal.candidates.length <= 10)
      throw new Error("Audit mode requires a batch subject to full Roadmap audit");
    if (prior) {
      await this.fresh(prior);
      receipt = readHostedReceipt(
        prior,
        request,
        proposal,
        bodyRequest,
        all,
        this.client.config.owner,
        this.client.config.repository,
      );
      if (receipt.status === "complete") {
        if (
          auditOnly ||
          receipt.plan_encoding === "proposal-bound-v2" ||
          proposal.schema_version === 2
        )
          await this.status(request, all);
        return receipt;
      }
    }
    if (auditOnly && !receipt?.audit_pending)
      throw new Error("Audit mode requires a retained batch with its full audit pending");
    const hasAmendments = amendments.length > 0;
    const authorizedImport =
      proposal.schema_version === 1 &&
      prior &&
      receipt &&
      amendments.some(
        ({ value }) =>
          value.receipt_comment === prior!.id &&
          value.receipt_sha256 === observationHash(prior!.body),
      );
    const checkpointStore =
      proposal.schema_version === 2 || hasAmendments ? this.durable.checkpoints?.() : undefined;
    const saved = checkpointStore?.load(request.id);
    let revision = saved?.revision ?? 0;
    let checkpointFailure: { error: unknown } | undefined;
    const requestHash = observationHash(request.body);
    const checkpointAndPublish = async (next: Receipt, previous?: Comment) => {
      if (!checkpointStore) {
        await freshAmendments();
        return await this.persist(next, previous);
      }
      if (checkpointFailure) throw checkpointFailure.error;
      try {
        await this.fresh(request);
        await freshAmendments();
        if (previous) await this.fresh(previous);
        next.observed_at = new Date().toISOString();
        const body = receiptBody(next);
        revision = checkpointStore.save(
          request.id,
          requestHash,
          revision,
          body,
          previous ? { hash: observationHash(previous.body), body: previous.body } : null,
          checkpointSlots(next),
        );
        return await this.persist(next, previous, body);
      } catch (error) {
        checkpointFailure = { error };
        throw error;
      }
    };
    if (checkpointStore && !saved && prior) {
      if (!authorizedImport || !receipt)
        throw new Error(
          "GitHub intake receipt has no PostgreSQL checkpoint; reconcile the restored store",
        );
      // The owner amendment authorizes importing this exact historical bot state.
      // Validate every amended slot before the first checkpoint or mutation.
      const importReceipt = prior;
      for (const { value } of amendments.filter(
        ({ value }) =>
          value.receipt_comment === importReceipt.id &&
          value.receipt_sha256 === observationHash(importReceipt.body),
      )) {
        const slot = receipt.plan[value.candidate_index],
          d = receipt.delivery[value.candidate_index];
        if (
          !slot ||
          !d ||
          !canHold(d) ||
          slot.candidate.port_key !== value.port_key ||
          slot.body_sha256 !== value.previous_body_sha256 ||
          slot.evidence_sha256 !== value.previous_evidence_sha256
        )
          throw new Error("Historical amendment cannot revise a completed or uncertain candidate");
      }
      await freshAmendments();
      revision = checkpointStore.save(
        request.id,
        requestHash,
        0,
        prior.body,
        null,
        checkpointSlots(receipt),
      );
    }
    if (saved) {
      const projected = { ...request, body: saved.receipt_body };
      const checkpointReceipt = readHostedReceipt(
        projected,
        request,
        proposal,
        bodyRequest,
        all,
        this.client.config.owner,
        this.client.config.repository,
      );
      if (
        saved.request_sha256 !== requestHash ||
        !isDeepStrictEqual(saved.candidates, checkpointSlots(checkpointReceipt))
      )
        throw new Error("PostgreSQL intake checkpoint or candidate coverage differs");
      if (!prior)
        throw new Error(
          "PostgreSQL checkpoint has no confirmed GitHub receipt marker; reconcile before retrying",
        );
      if (prior.body !== saved.receipt_body) {
        if (auditOnly) {
          if (!checkpointReceipt.audit_pending && checkpointReceipt.status !== "complete")
            throw new Error("Stored checkpoint is outside the requested final audit");
          if (checkpointReceipt.status === "complete")
            await this.status(
              request,
              all.map((comment) =>
                comment.id === prior?.id ? { ...comment, body: saved.receipt_body } : comment,
              ),
            );
        }
        if (observationHash(prior.body) !== saved.previous_receipt_sha256)
          throw new Error("GitHub receipt is ahead of or differs from the PostgreSQL checkpoint");
        await this.fresh(request);
        await freshAmendments();
        await freshLineage();
        prior = await this.persist(checkpointReceipt, prior, saved.receipt_body);
        receipt = checkpointReceipt;
        if (receipt.status === "complete") {
          await this.status(
            request,
            all.map((comment) => (comment.id === prior?.id ? prior : comment)),
          );
          return receipt;
        }
      }
    }
    if (receipt) {
      if (
        receipt.status === "complete_with_holds" &&
        !resumeHolds &&
        !authorizedImport &&
        !amendments.some(
          ({ value }) =>
            value.receipt_comment === prior?.id &&
            value.receipt_sha256 === observationHash(prior.body),
        )
      ) {
        await this.status(request, all);
        return receipt;
      }
      if (
        receipt.audit_pending ||
        ((proposal.schema_version === 2 || (!lineage && receipt.delivery.length > 10)) &&
          receipt.delivery.every((d) => !missingDeliveryProof(d)))
      ) {
        const audit = receipt;
        const persist = async () => {
          await this.fresh(request);
          await freshLineage();
          prior = await checkpointAndPublish(audit, prior);
        };
        await freshLineage();
        audit.head = this.head;
        audit.run = process.env.GITHUB_RUN_ID ?? "local";
        audit.attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
        try {
          if (audit.delivery.length > 10) {
            if (!audit.audit_pending) {
              audit.audit_pending = true;
              audit.status = "applying";
              await persist();
            }
            await this.finishAudit(audit, persist);
          } else {
            audit.status = "complete";
            delete audit.error;
            delete audit.continuation;
            await persist();
          }
        } catch (error) {
          if (checkpointFailure || audit.status === "complete") throw error;
          audit.status = "incomplete";
          audit.error = receiptDiagnostic(error);
          audit.continuation = this.continuation(error);
          await persist();
          throw error;
        }
        return audit;
      }
    }
    if (auditOnly) throw new Error("Audit-only recovery cannot enter candidate processing");
    const delivery = structuredClone(
      receipt?.delivery ??
        lineage?.receipt.delivery ??
        proposal.candidates.map((): Delivery => ({ status: "prepared" })),
    );
    const historical = new Set<number>();
    const plan: PlanSlot[] = [];
    for (const [index, original] of proposal.candidates.entries()) {
      const d = delivery[index]!;
      const previous = receipt?.plan[index];
      let candidate = original;
      let amendment = previous?.amendment;
      let amended = false;
      let ownerHold = false;
      const selected = amendments.filter(
        ({ comment, value }) =>
          comment.id !== previous?.amendment?.comment &&
          value.candidate_index === index &&
          value.receipt_comment === prior?.id &&
          value.receipt_sha256 === observationHash(prior.body),
      );
      if (selected.length > 1)
        throw new Error("Multiple owner amendments compete for one candidate");
      if (selected.length) {
        const { comment, value } = selected[0]!;
        if (
          !previous ||
          !canHold(d) ||
          value.port_key !== original.port_key ||
          value.previous_body_sha256 !== previous.body_sha256 ||
          value.previous_evidence_sha256 !== previous.evidence_sha256
        )
          throw new Error("Candidate amendment cannot revise a completed or uncertain write");
        amendment = { comment: comment.id, sha256: observationHash(comment.body) };
        amended = true;
      }
      if (amendment) {
        const comment = all.find((c) => c.id === amendment.comment);
        if (!comment || observationHash(comment.body) !== amendment.sha256)
          throw new Error("Candidate amendment preimage differs");
        const value = readHostedAmendment(
          comment,
          this.client.config.owner,
          this.client.config.repository,
          request,
        );
        candidate = applyHostedAmendment(original, value);
        ownerHold = value.hold === true;
      }
      if (previous && ((d.hold && !resumeHolds && !amended) || (!lineage && isDelivered(d)))) {
        if (isDelivered(d)) {
          if (missingDeliveryProof(d)) throw new Error("Historical delivery lacks a scoped doctor");
          if (
            proposal.schema_version === 2 ||
            receipt?.plan_encoding === "proposal-bound-v2" ||
            hasAmendments
          )
            historical.add(index);
        }
        plan.push(previous);
        continue;
      }
      try {
        if (ownerHold)
          throw new CandidateResearchHold(
            "owner-research",
            "Owner retained this candidate for research",
          );
        const fresh = await this.primary(candidate, bodyRequest);
        if (previous && !canHold(d) && previous.body_sha256 !== fresh.body_sha256)
          throw new Error(
            "An unfinished write retains its original body and location; reconcile its marker",
          );
        if (previous?.primary && previous.evidence_sha256 !== fresh.evidence_sha256 && !amended) {
          throw new CandidateResearchHold(
            "evidence-changed",
            "Primary evidence changed; amend this unfinished candidate",
          );
        }
        plan.push({ ...fresh, ...(amendment ? { amendment } : {}) });
        delete d.hold;
      } catch (error) {
        const researchHold = error instanceof CandidateResearchHold;
        const inaccessible =
          error instanceof DiscoveryRepositoryUnavailable &&
          error.repository === new URL(candidate.upstream).pathname.slice(1);
        if (lineage || (!researchHold && !inaccessible)) throw error;
        if (previous?.primary && isDelivered(d)) {
          if (missingDeliveryProof(d)) throw new Error("Historical delivery lacks a scoped doctor");
          historical.add(index);
          plan.push(previous);
          continue;
        }
        if (!canHold(d)) throw error;
        const heldCandidate = amended ? candidate : (previous?.candidate ?? candidate);
        d.hold = researchHold
          ? {
              ...candidateHold(heldCandidate),
              http_status: null,
              reason: error.reason,
              resume: researchHoldResumes[error.reason],
            }
          : candidateHold(heldCandidate);
        const body = hostedBody(heldCandidate, bodyRequest);
        validateDiscoveryIntakeBody(body, heldCandidate.upstream, heldCandidate.port_key);
        plan.push(
          (!amended && previous) || {
            candidate: heldCandidate,
            body,
            body_sha256: observationHash(body),
            primary: null,
            evidence_sha256: null,
            ...(amendment ? { amendment } : {}),
          },
        );
      }
    }
    this.planningIssues = new Set(
      (receipt?.delivery ?? lineage?.receipt.delivery ?? []).flatMap((d) =>
        d.created_issue ? [d.created_issue] : d.canonical_issue ? [d.canonical_issue] : [],
      ),
    );
    let inventory = await this.inventory();
    for (const [index, slot] of plan.entries()) {
      if (
        delivery[index]!.hold &&
        inventory.issues.some((issue) =>
          issue.body?.includes(
            `<!-- portcove-discovery-intake:hosted-${bodyRequest}-${slot.candidate.port_key} -->`,
          ),
        )
      )
        throw new Error("Held candidate has a retained creation marker; reconcile before resuming");
    }
    if (!receipt) {
      const owners = new Map<number, number>();
      for (const [index, p] of plan.entries()) {
        if (delivery[index]!.hold) continue;
        if (!p.primary) throw new Error("Eligible candidate has no primary binding");
        const marker = `<!-- portcove-discovery-intake:hosted-${bodyRequest}-${p.candidate.port_key} -->`;
        const recovered = inventory.issues.filter((i) => i.body?.includes(marker));
        if (recovered.length > 1) throw new Error("Ambiguous created issue marker");
        try {
          const owner = this.duplicates(
            inventory,
            p,
            lineage?.receipt.delivery[index]?.created_issue ??
              (recovered[0] ? Number(recovered[0].number) : undefined),
          );
          if (owner) owners.set(index, owner);
        } catch (error) {
          if (!(error instanceof CandidateIdentityConflict) || !canHold(delivery[index]!))
            throw error;
          delivery[index]!.hold = candidateHold(p.candidate, true);
          this.save(`hold-${request.id}-${p.candidate.port_key}`, sanitizeOperationError(error));
        }
      }
      await freshLineage();
      receipt = {
        schema_version: 1,
        request_comment: request.id,
        request_sha256: observationHash(request.body),
        investigator: proposal.investigator,
        plan_sha256: hostedPlanHash(observationHash(request.body), plan),
        plan,
        delivery: delivery.map((d, index) => {
          const owner = owners.get(index);
          return owner === undefined || lineage || plan[index]!.candidate.intent
            ? d
            : { ...d, canonical_issue: owner, existing: true };
        }),
        ...(delivery.some((d) => d.hold) ? { plan_encoding: "proposal-bound-v2" as const } : {}),
        ...(lineage ? { body_request_comment: bodyRequest } : {}),
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
      assertReceiptCapacity(receipt);
      prior = await checkpointAndPublish(receipt);
    }
    receipt.plan = plan;
    receipt.plan_sha256 = hostedPlanHash(receipt.request_sha256, plan);
    if (delivery.some((d) => d.hold)) receipt.plan_encoding = "proposal-bound-v2";
    if (found.length) receipt.delivery = delivery;
    assertReceiptCapacity(receipt);
    await freshLineage();
    receipt.head = this.head;
    receipt.run = process.env.GITHUB_RUN_ID ?? "local";
    receipt.attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
    receipt.status = "applying";
    const persist = async () => {
      prior = await checkpointAndPublish(receipt, prior);
    };
    await persist();
    try {
      if (receipt.delivery.some((d, index) => !d.hold && !historical.has(index))) {
        this.uncertainMutations++;
        const writeProof = await probeHostedProjectWrite(this.client, 177);
        this.uncertainMutations--;
        this.save(`write-proof-${request.id}`, writeProof);
      }
      // The same-option owner proof and receipt comments do not change this
      // projection. Refresh at the next actual mutation, not after no-op proof.
      let invalidated = false;
      for (const [index, p] of plan.entries()) {
        const d = receipt.delivery[index];
        if (!d) throw new Error("Retained delivery coverage differs");
        if (d.hold || historical.has(index)) continue;
        if (!p.primary) throw new Error("Eligible candidate has no primary binding");
        if (
          (d.created_issue || d.canonical_issue) &&
          (invalidated || Date.now() - Date.parse(inventory.observed_at) >= 90000)
        ) {
          inventory = await this.inventory(inventory);
          invalidated = false;
        }
        await this.fresh(request);
        await freshLineage();
        const marker = `<!-- portcove-discovery-intake:hosted-${bodyRequest}-${p.candidate.port_key} -->`;
        const recovered = inventory.issues.filter((i) => i.body?.includes(marker));
        if (recovered.length > 1) throw new Error("Ambiguous created issue marker");
        if (p.candidate.intent?.kind === "observe-existing") {
          const originalKey = proposal.candidates[index]!.port_key;
          const originalMarker = `<!-- portcove-discovery-intake:hosted-${bodyRequest}-${originalKey} -->`;
          if (
            recovered.length ||
            (originalKey !== p.candidate.port_key &&
              inventory.issues.some((issue) => issue.body?.includes(originalMarker)))
          )
            throw new Error(
              "Explicit observation has a retained creation marker; reconcile it first",
            );
        }
        if (d.created_issue && recovered[0]?.number !== d.created_issue)
          throw new Error("Created issue identity is unavailable");
        if (!d.created_issue && recovered.length) {
          d.created_issue = Number(recovered[0]!.number);
          this.planningIssues.add(d.created_issue);
          await persist();
          inventory = await this.inventory(inventory);
          invalidated = false;
        }
        if (!d.created_issue && !d.canonical_issue && d.status === "create-attempted")
          throw new Error("Ambiguous issue POST without a confirmed marker; do not recapture");
        const holdConflict = async (error: unknown) => {
          if (!(error instanceof CandidateIdentityConflict) || !canHold(d)) throw error;
          d.hold = candidateHold(p.candidate, true);
          receipt.plan_encoding = "proposal-bound-v2";
          this.save(`hold-${request.id}-${p.candidate.port_key}`, sanitizeOperationError(error));
          await persist();
        };
        let owner: number | undefined;
        try {
          owner = this.duplicates(inventory, p, d.created_issue);
        } catch (error) {
          await holdConflict(error);
          continue;
        }
        if (owner) {
          if (d.status === "preflight") d.status = "prepared";
          try {
            await this.observeExisting(request, p, d, owner, inventory, persist);
          } catch (error) {
            await holdConflict(error);
            continue;
          }
          invalidated = true;
          continue;
        }
        if (d.canonical_issue)
          throw new Error("Retained canonical ownership is no longer established");
        if (d.created_issue) {
          const issue = await assertHostedRecovery(this.client, inventory, d.created_issue);
          if (issue.body !== p.body || issue.title !== `[Port] ${p.candidate.title}`)
            throw new Error("Created issue was revised; preserve owner changes and reconcile");
          const member = inventory.items.find((item) => item.content?.id === issue.node_id);
          const ready =
            member &&
            Object.entries(portFieldInitialization(null)).every(
              ([field, value]) => fieldValue(member, field) === value,
            ) &&
            !fieldValue(member, "Release commitment");
          if (!ready) {
            // A real normalization consumes a fresh target preimage, even when
            // the earlier routing observation looked repairable.
            inventory = await this.inventory(inventory);
            invalidated = false;
            const latest = await assertHostedRecovery(this.client, inventory, d.created_issue);
            if (latest.body !== p.body || latest.title !== `[Port] ${p.candidate.title}`)
              throw new Error("Created issue was revised; preserve owner changes and reconcile");
            const normalized = await this.mutation(
              async () =>
                await this.client.normalizePortIssue({
                  number: d.created_issue!,
                  catalog: qualificationCatalogObservation(
                    JSON.parse(
                      readFileSync(
                        new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
                        "utf8",
                      ),
                    ),
                  ),
                  inventory,
                  repositoryIdentity: { id: p.candidate.repository_id, game: p.candidate.game },
                }),
            );
            invalidated = true;
            d.item_id = receiptProjectItemId(normalized.itemId);
          }
        } else {
          // Reserve room before publishing the checkpoint. A denial here is
          // safe because no issue attempt has been recorded or dispatched.
          await this.admitWarmInventory(inventory);
          // Receipt updates change #177's revision but not its intake semantics.
          // Keep the durable state resumable throughout the fresh negative inventory.
          d.status = "preflight";
          await persist();
          inventory = await this.inventory(inventory);
          invalidated = false;
          await this.fresh(request);
          await freshLineage();
          let lateOwner: number | undefined;
          try {
            lateOwner = this.duplicates(inventory, p);
          } catch (error) {
            await holdConflict(error);
            continue;
          }
          if (lateOwner) {
            d.status = "prepared";
            d.canonical_issue = lateOwner;
            d.existing = true;
            await persist();
            await this.observeExisting(request, p, d, lateOwner, inventory, persist);
            invalidated = true;
            continue;
          }
          d.status = "create-attempted";
          await persist();
          await this.mutation(
            async () =>
              await discoveryPost(
                d,
                async () =>
                  await this.client.createPortIssue({
                    title: p.candidate.title,
                    upstream: p.candidate.upstream,
                    portKey: p.candidate.port_key,
                    body: p.body,
                    inventory,
                    repositoryIdentity: { id: p.candidate.repository_id, game: p.candidate.game },
                    onIssueCreated: async (issue) => {
                      d.created_issue = issue.number;
                      this.planningIssues.add(issue.number);
                      d.status = "created";
                      await persist();
                    },
                  }),
                () => this.save(`receipt-${request.id}`, receipt),
              ),
          );
          invalidated = true;
        }
        const issue = await this.client.repositoryIssue(d.created_issue!);
        const item = (await this.client.executionIssue(d.created_issue!)).item;
        if (issue.body !== p.body || item.content.id !== issue.node_id)
          throw new Error("Exact created body/item readback failed");
        const defaults = portFieldInitialization(null);
        for (const [f, v] of Object.entries(defaults))
          if (fieldValue(item, f) !== v) throw new Error(`Neutral intake field differs: ${f}`);
        if (fieldValue(item, "Release commitment"))
          throw new Error("Intake acquired a release commitment");
        d.item_id = receiptProjectItemId(item.id);
        d.fields = Object.fromEntries(Object.keys(defaults).map((f) => [f, fieldValue(item, f)]));
        const doctor = await runScopedDoctor(this.client.config, this.client, {
          issues: [d.created_issue!],
        });
        this.save(`doctor-${request.id}-${d.created_issue}`, doctor);
        d.doctor = compactDoctor(doctor);
        d.status = "delivered";
        await persist();
      }
      const held = receipt.delivery.some((d) => d.hold);
      if (!held && plan.length > 10) {
        if (receipt.delivery.some((d) => missingDeliveryProof(d)))
          throw new Error("Full audit requires every scoped delivery proof");
        receipt.audit_pending = true;
        await persist();
        await this.finishAudit(
          receipt,
          async () => {
            await this.fresh(request);
            await freshLineage();
            await persist();
          },
          inventory,
        );
        return receipt;
      }
      receipt.status = held ? "complete_with_holds" : "complete";
      delete receipt.error;
      delete receipt.continuation;
      await persist();
    } catch (error) {
      if (checkpointFailure || receipt.status === "complete") throw error;
      receipt.status = "incomplete";
      receipt.error = receiptDiagnostic(error);
      receipt.continuation = this.continuation(error);
      try {
        await persist();
      } catch (publication) {
        this.save(`publication-failure-${request.id}`, sanitizeOperationError(publication));
      }
      throw error;
    }
    return receipt;
  }
}
export async function probeHostedProjectWrite(client: HostedRoadmapOperations, issue: number) {
  const before = (await client.executionIssue(issue)).item;
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
  await client.setItemFields(before.id, { Priority: priority });
  const after = (await client.executionIssue(issue)).item;
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
export async function collectHostedRequests(
  bridge: Pick<HostedIntakeBridge, "comments" | "continuation">,
  initialize: () => void | Promise<void>,
) {
  try {
    await initialize();
    return { status: "collected" as const, comments: await bridge.comments() };
  } catch (error) {
    const continuation = bridge.continuation(error);
    if (!continuation) throw error;
    return { status: "held" as const, continuation, error: sanitizeOperationError(error) };
  }
}
type HostedStatus = Awaited<ReturnType<HostedIntakeBridge["status"]>>;
/** One marker-bearing owner request in the complete status read. */
export type HostedRequestStatus =
  | (HostedStatus & { withdrawn: boolean; superseded_by: number[] })
  | {
      request_comment: number;
      withdrawn: boolean;
      superseded_by: number[];
      error: ReturnType<typeof sanitizeOperationError>;
    };
export interface HostedStatusAll {
  /** #177 node, comment count and revision, plus a digest of every (comment id, body SHA-256). */
  queue: { node_id: string; comments: number; updated_at: string; comments_sha256: string };
  requests: HostedRequestStatus[];
}

/**
 * Read-only status of every owner-authored #177 request the executor selects
 * (`hostedRequestSelection`), from one complete drift-checked comment read. A withdrawn
 * request keeps its exact original proposal after a prepended explanation and
 * is classified from that retained proposal. A request whose own proposal,
 * receipt or reconciliation cannot be validated is reported with its error;
 * provider and budget failures fail the whole read.
 */
export async function hostedStatusAll(
  bridge: Pick<HostedIntakeBridge, "comments" | "status" | "queue" | "client" | "statusBudget">,
): Promise<HostedStatusAll> {
  const all = await bridge.comments();
  const queue = bridge.queue;
  if (!queue) throw new Error("Hosted request queue identity is unavailable");
  const owner = bridge.client.config.owner;
  const selected = all.flatMap((comment) => {
    const selection = hostedRequestSelection(comment, owner);
    return selection ? [{ comment, ...selection }] : [];
  });
  bridge.statusBudget?.admitReconciliations(
    selected.filter(({ request }) => reconciles(request.body)).length,
  );
  const rows: HostedRequestStatus[] = [];
  for (const { comment, withdrawn, request } of selected) {
    try {
      const status = await bridge.status(request, all);
      rows.push({ ...status, withdrawn, superseded_by: [] });
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      rows.push({
        request_comment: comment.id,
        withdrawn,
        superseded_by: [],
        error: sanitizeOperationError(error),
      });
    }
  }
  for (const row of rows)
    if ("reconciles" in row && row.reconciles !== null)
      rows
        .find((source) => source.request_comment === row.reconciles)
        ?.superseded_by.push(row.request_comment);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    queue: {
      ...queue,
      comments_sha256: digest(
        JSON.stringify(
          all
            .map((c) => [c.id, digest(typeof c.body === "string" ? c.body : "")] as const)
            .sort((left, right) => left[0] - right[0]),
        ),
      ),
    },
    requests: rows,
  };
}

/**
 * The marker-bearing owner request a #177 comment carries, by the executor's own
 * selection: an active request starts with the marker; a withdrawn request keeps
 * exactly one marker after its prepended explanation, followed by its complete
 * original proposal. Anything else, including prose that quotes the marker, is
 * not a request.
 */
export function hostedRequestSelection(comment: Comment, owner: string) {
  if (comment.user?.login !== owner || typeof comment.body !== "string") return null;
  if (comment.body.startsWith(hostedRequestMarker)) return { withdrawn: false, request: comment };
  const offset = comment.body.indexOf(hostedRequestMarker);
  if (
    offset <= 0 ||
    comment.body.indexOf(hostedRequestMarker, offset + hostedRequestMarker.length) !== -1
  )
    return null;
  const original = { ...comment, body: comment.body.slice(offset) };
  try {
    parseHostedRequest(original.body);
  } catch {
    return null;
  }
  return { withdrawn: true, request: original };
}
/** Whether a request's proposal names a reconciliation, which costs two exact reads. */
function reconciles(body: string) {
  try {
    return parseHostedRequest(body).reconcile !== undefined;
  } catch {
    return false;
  }
}

/** The repository's stable numeric identity, which GitHub list pagination links use. */
const hostedRepositoryId = 1354613114;
/** Bounded transport retries admitted on top of the planned reads. */
export const hostedStatusRetryAllowance = 4;
/** Absolute ceiling for one status read, whatever the #177 queue size. */
export const hostedStatusRequestCeiling = 200;
/**
 * A status read's request budget, derived from the observed queue: the first
 * #177 revision read is admitted; its comment count then admits one read per
 * 20-comment page plus one, and the closing revision read; each reconciling
 * request admits its two exact-comment reads. A small retry allowance is added,
 * and a plan beyond the absolute ceiling fails before its next request.
 */
export class HostedStatusBudget {
  used = 0;
  planned = 1;
  private sized = false;
  readonly ceiling: number;
  readonly retries: number;
  constructor(ceiling = hostedStatusRequestCeiling, retries = hostedStatusRetryAllowance) {
    this.ceiling = ceiling;
    this.retries = retries;
  }
  get limit() {
    return this.planned + this.retries;
  }
  /** Sizes the comment pages from the first revision read's comment count. */
  observeQueue(comments: unknown) {
    if (this.sized || !Number.isSafeInteger(comments) || (comments as number) < 0) return;
    this.sized = true;
    this.planned += Math.ceil((comments as number) / 20) + 1 + 1;
  }
  /** Admits the exact-comment reads of the requests that reconcile. */
  admitReconciliations(count: number) {
    this.planned += 2 * count;
  }
  reserve() {
    if (this.limit > this.ceiling || ++this.used > this.limit)
      throw new GitHubApiError(
        "budget_exhausted",
        `Hosted status read exceeded its budget (${this.used} of ${Math.min(this.limit, this.ceiling)} requests)`,
      );
  }
}
/**
 * A status-only bridge: GET-only to #177, its comment list and exact comments,
 * with a request budget derived from the observed queue. It needs no
 * RoadmapClient connection, Project scope or write credential, and refuses
 * research, saving and every write.
 */
export async function readOnlyHostedBridge(
  config: { owner: string; repository: string },
  options: Pick<GitHubClientOptions, "credential" | "deadline" | "fetch" | "environmentProxy"> & {
    budget?: HostedStatusBudget;
  },
) {
  const named = `/repos/${config.repository}/issues`;
  const numeric = `/repositories/${hostedRepositoryId}/issues`;
  const budget = options.budget ?? new HostedStatusBudget();
  const sdk = await createGitHubClient({
    ...options,
    maxBytes: 4 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      (url.pathname === `${named}/177` ||
        url.pathname === `${named}/177/comments` ||
        // GitHub Link headers use the stable numeric repository path for list pages.
        url.pathname === `${numeric}/177/comments` ||
        new RegExp(`^${named}/comments/[1-9]\\d*$`, "u").test(url.pathname)),
    reserve() {
      budget.reserve();
      return { consumeBytes() {}, settle() {} };
    },
  });
  sdk.hook.after("request", (response, request) => {
    if (new URL(String(request.url), "https://api.github.com/").pathname === `${named}/177`)
      budget.observeQueue((response.data as { comments?: unknown } | null)?.comments);
  });
  const refuse = () => {
    throw new Error("Status cannot research, save or write");
  };
  const bridge = new HostedIntakeBridge(
    { config } as unknown as HostedRoadmapOperations,
    { project: sdk, repository: sdk },
    "status",
    refuse,
    refuse,
  );
  bridge.statusBudget = budget;
  return bridge;
}
export async function connectHostedGitHub(
  config: ConstructorParameters<typeof RoadmapClient>[0],
  budget: DiscoveryBudget,
  credentials: { project: string; repository: string },
  options: Parameters<typeof discoveryGitHubScope>[2] = {},
) {
  if (!credentials.project || !credentials.repository)
    throw new GitHubApiError(
      "credential_unavailable",
      "Dedicated Project and repository credentials are required",
    );
  const projectScope = discoveryGitHubScope(budget, credentials.project, options);
  const repositoryScope = discoveryGitHubScope(budget, credentials.repository, options);
  const project = await createGitHubClient(projectScope);
  const repository = await createGitHubClient(repositoryScope);
  const client = await RoadmapClient.connect(config, {
    ...projectScope,
    repositoryMutations: repositoryScope,
  });
  return { client, project, repository };
}
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const config = validateConfig(
    JSON.parse(readFileSync(path.join(root, ".github/roadmap.json"), "utf8")),
  );
  if (process.argv[2] === "status") {
    const args = process.argv.slice(3);
    const everything = args.length === 2 && args[0] === "--all" && args[1] === "--json";
    if (
      !everything &&
      (args.length !== 3 ||
        args[0] !== "--request" ||
        args[2] !== "--json" ||
        !/^[1-9]\d*$/u.test(args[1] ?? ""))
    )
      throw new Error(
        "Usage: node scripts/hosted-discovery-intake.mts status (--request <comment-id> | --all) --json",
      );
    const { localDeveloperCredential } = await import("./github-cli.mts");
    const deadline = performance.now() + 120_000;
    const bridge = await readOnlyHostedBridge(config, {
      credential: localDeveloperCredential({ deadline }),
      deadline,
    });
    if (everything) {
      console.log(JSON.stringify(await hostedStatusAll(bridge)));
      return;
    }
    const id = positive(Number(args[1]));
    const comments = await bridge.comments();
    const request = comments.find((c) => c.id === id);
    if (!request) throw new Error("Requested proposal is unavailable");
    bridge.statusBudget?.admitReconciliations(reconciles(request.body) ? 1 : 0);
    console.log(JSON.stringify(await bridge.status(request, comments)));
    return;
  }
  const pass = process.env.HOSTED_INTAKE_PASS ?? "1";
  if (!/^[1-9]\d?$/u.test(pass) || Number(pass) > hostedIntakeMaxPasses)
    throw new Error("Invalid bounded intake pass");
  const directory = path.join(root, "work/hosted-discovery-intake", `pass-${pass}`);
  mkdirSync(directory, { recursive: true });
  const progress = new Map<number, string>();
  const save = (name: string, value: unknown) => {
    if (name.startsWith("receipt-") && isRecord(value)) {
      progress.set(
        Number(name.slice(8)),
        observationHash({
          request: value.request_sha256,
          plan: value.plan_sha256,
          delivery: Array.isArray(value.delivery)
            ? value.delivery.map((raw) => {
                const d = object(raw);
                return {
                  status: d.status,
                  issue: d.created_issue,
                  item: d.item_id,
                  owner: d.canonical_issue,
                  comment: d.created_comment,
                };
              })
            : null,
          global: value.doctor !== undefined,
        }),
      );
    }
    writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2));
  };
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  assertHostedEvent(event, process.env.GITHUB_EVENT_NAME ?? "", config.repository, config.owner);
  if (!process.env.GH_TOKEN || !process.env.REPOSITORY_TOKEN)
    throw new Error("Dedicated Project and repository credentials are required");
  const budget = new DiscoveryBudget("hosted", (usage) => save("budget", usage));
  const { client, project, repository } = await connectHostedGitHub(config, budget, {
    project: process.env.GH_TOKEN,
    repository: process.env.REPOSITORY_TOKEN,
  });
  const locationSdk = await createGitHubClient({
    ...discoveryGitHubScope(budget, process.env.GH_TOKEN),
    observeRedirects: true,
    maxBytes: 16384,
    allowRequest: (method, url) =>
      method === "GET" &&
      (/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname) ||
        /^\/repositories\/[1-9]\d*$/u.test(url.pathname) ||
        url.pathname === "/rate_limit"),
  });
  const locationRead = relocationMetadataReader(locationSdk);
  const http = createDiscoveryTransport(budget, process.env.GH_TOKEN);
  const head = runCheckedGit(["rev-parse", "HEAD"], { cwd: root }).trim();
  const admitInventory = async (cache?: RoadmapInventory) => {
    const cost = cache ? discoveryInventoryCost(cache) : { requests: 1, bytes: 1 };
    // Leave enough existing capacity to restore prepared and publish a bounded
    // receipt/diagnostic if preflight cannot fit; this is not a usage reset.
    await budget.admit(cost.requests + 12, cost.bytes + 2 * 1024 * 1024);
  };
  const bridge = new HostedIntakeBridge(
    client,
    { project, repository },
    head,
    async (repo) => await investigateDiscoveryUpstream({ sdk: project, budget, http, save }, repo),
    save,
    admitInventory,
    admitInventory,
    {
      checkpoints: postgresIntakeCheckpoints,
      requireIntent: Boolean(process.env.PORTCOVE_DISCOVERY_DATABASE_URL),
      resolveRepository: (name, id) => resolveDiscoveryRepository(name, id, locationRead),
    },
  );
  const settleAdmission = async () => {
    const failures = await budget.drain();
    if (failures.length) {
      try {
        save(
          "admission-cleanup",
          failures.map((error) => sanitizeOperationError(error)),
        );
      } catch (error) {
        console.error(JSON.stringify(sanitizeOperationError(error)));
      }
    }
  };
  const initialize = async () => {
    const resources = object(object((await project.request("GET /rate_limit")).data).resources);
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
  };
  try {
    const inputs = object(event).inputs;
    if (
      process.env.HOSTED_INTAKE_MODE === "probe" ||
      (isRecord(inputs) && inputs.mode === "probe")
    ) {
      await initialize();
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
        await settleAdmission();
        save("write-probe", result);
        console.log(JSON.stringify(result));
      } catch (error) {
        await settleAdmission();
        save("write-probe", { status: "failed", head, error: sanitizeOperationError(error) });
        throw error;
      }
      return;
    }
    const collected = await collectHostedRequests(bridge, initialize);
    if (collected.status === "held") {
      await settleAdmission();
      save("summary", {
        status: "incomplete",
        head,
        requests: 0,
        outcomes: [],
        queue_continuation: collected.continuation,
        error: collected.error,
      });
      process.exitCode = 1;
      return;
    }
    const comments = collected.comments;
    const selected: unknown = process.env.HOSTED_INTAKE_REQUESTS
      ? JSON.parse(process.env.HOSTED_INTAKE_REQUESTS)
      : null;
    if (
      selected !== null &&
      (!Array.isArray(selected) ||
        !selected.length ||
        selected.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(selected).size !== selected.length)
    )
      throw new Error("Invalid bounded continuation selection");
    const available = comments.filter(
      (c) => c.user.login === config.owner && c.body.startsWith(hostedRequestMarker),
    );
    const auditOnly = process.env.HOSTED_INTAKE_MODE === "audit";
    if (
      auditOnly &&
      (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
        !Array.isArray(selected) ||
        selected.length !== 1 ||
        String(selected[0]) !== process.env.HOSTED_INTAKE_AUDIT_REQUEST)
    )
      throw new Error("Audit mode requires the exact owner-dispatched proposal ID");
    const requests =
      selected === null
        ? available
        : (selected as number[]).map((id) => {
            const request = available.find((c) => c.id === id);
            if (!request) throw new Error("Continuation request is no longer available");
            return request;
          });
    const outcomes: {
      counts?: ReturnType<typeof deliveryCounts>;
      request: number;
      status: string;
      continuation: string | null;
      progress: string | null;
    }[] = [];
    for (const c of requests) {
      try {
        const receipt = await bridge.process(c, comments, {
          resumeHolds: !auditOnly && process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
          auditOnly,
        });
        outcomes.push({
          request: c.id,
          status: receipt.status,
          counts: deliveryCounts(receipt.delivery),
          continuation: null,
          progress: progress.get(c.id) ?? null,
        });
      } catch (error) {
        let continuation = bridge.continuation(error);
        save(`failure-${c.id}`, sanitizeOperationError(error));
        try {
          if (!auditOnly) await bridge.diagnostic(c, error, comments);
        } catch (publication) {
          continuation = null;
          save(`publication-failure-${c.id}`, sanitizeOperationError(publication));
        }
        outcomes.push({
          request: c.id,
          status: "incomplete",
          continuation,
          progress: progress.get(c.id) ?? null,
        });
      }
    }
    const failed = outcomes.some((o) => o.status === "incomplete");
    await settleAdmission();
    save("summary", {
      status: failed ? "incomplete" : "passed",
      head,
      requests: requests.length,
      outcomes,
    });
    if (failed) process.exitCode = 1;
  } finally {
    await settleAdmission();
    save("api-observations", budget.observations);
    save("roadmap-observations", client.observations);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error) => {
    console.error(JSON.stringify(sanitizeOperationError(error)));
    process.exitCode = 1;
  });
