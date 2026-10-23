import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

/** Reviewed authoring facts only. These records never grant runtime or publication authority. */
export interface UpstreamIdentity {
  project_url: string;
  repository?: { host: string; id: string };
}
interface Evidence {
  kind: "supporting" | "context" | "contradiction";
  reference: string;
  note: string;
}
export interface LineageDecision {
  from: UpstreamIdentity;
  to: UpstreamIdentity;
  relationship: "relocation" | "successor" | "fork" | "alternative" | "independent";
  outcome: "accepted" | "rejected" | "unresolved";
  rationale: string;
  evidence: Evidence[];
  reconsider_when: string;
  related_port?: { id: string; issue_number: number };
  review?: { reference: string; decision_sha256: string };
}
export interface UpstreamLineage {
  format_version: 1;
  target_key: string;
  origin: UpstreamIdentity;
  decisions: LineageDecision[];
}
interface PortIdentity {
  listing: { id: string; project_url: string; issue_number?: number };
  upstream_lineage?: UpstreamLineage;
}
const stableId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function text(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value) <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}
function object(value: unknown, keys: readonly string[], name: string) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`Invalid ${name} fields.`);
  return value;
}
function projectUrl(value: unknown): string {
  if (!text(value)) throw new Error("Lineage requires a bounded HTTPS reference.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Lineage references must be credential-free HTTPS URLs.");
  return url.href;
}
function identityUrl(value: string) {
  const url = new URL(projectUrl(value));
  // GitHub repository names are case-insensitive. Other hosts retain their path semantics.
  if (
    url.hostname === "github.com" &&
    !url.search &&
    !url.hash &&
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(url.pathname)
  ) {
    url.pathname = url.pathname
      .replace(/\/$/u, "")
      .replace(/\.git$/iu, "")
      .toLowerCase();
  }
  return url.href;
}
function identity(value: unknown): UpstreamIdentity {
  const item = object(value, ["project_url", "repository"], "upstream identity");
  const url = projectUrl(item.project_url);
  const parsed = new URL(url);
  if (
    parsed.hostname === "github.com" &&
    (parsed.search ||
      parsed.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(parsed.pathname))
  )
    throw new Error("A GitHub lineage identity must name a repository root.");
  if (item.repository !== undefined) {
    const repository = object(item.repository, ["host", "id"], "repository identity");
    if (
      !text(repository.host, 253) ||
      repository.host !== new URL(url).hostname ||
      !text(repository.id, 128)
    )
      throw new Error("Repository identity requires its exact host and bounded provider ID.");
  }
  return item as unknown as UpstreamIdentity;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}
function equal(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Binds declared review to the complete decision and its canonical port/issue/target. */
export function lineageDecisionDigest(
  port: PortIdentity,
  lineage: Pick<UpstreamLineage, "target_key">,
  decision: LineageDecision,
) {
  const { review: _review, ...facts } = decision;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          port_id: port.listing.id,
          issue_number: port.listing.issue_number,
          target_key: lineage.target_key,
          decision: facts,
        }),
      ),
    )
    .digest("hex");
}

function checkedDecision(value: unknown, port: PortIdentity, lineage: UpstreamLineage) {
  const item = object(
    value,
    [
      "from",
      "to",
      "relationship",
      "outcome",
      "rationale",
      "evidence",
      "reconsider_when",
      "related_port",
      "review",
    ],
    "lineage decision",
  );
  identity(item.from);
  identity(item.to);
  if (
    typeof item.relationship !== "string" ||
    !["relocation", "successor", "fork", "alternative", "independent"].includes(
      item.relationship,
    ) ||
    typeof item.outcome !== "string" ||
    !["accepted", "rejected", "unresolved"].includes(item.outcome) ||
    !text(item.rationale) ||
    !text(item.reconsider_when) ||
    !Array.isArray(item.evidence) ||
    !item.evidence.length ||
    item.evidence.length > 32
  )
    throw new Error(
      "Lineage decision requires a relationship, outcome, rationale, evidence and reconsideration condition.",
    );
  for (const entry of item.evidence) {
    const evidence = object(entry, ["kind", "reference", "note"], "lineage evidence");
    if (
      typeof evidence.kind !== "string" ||
      !["supporting", "context", "contradiction"].includes(evidence.kind) ||
      !text(evidence.note)
    )
      throw new Error("Invalid attributable lineage evidence.");
    projectUrl(evidence.reference);
  }
  const decision = item as unknown as LineageDecision;
  if (item.related_port !== undefined) {
    const related = object(item.related_port, ["id", "issue_number"], "related port");
    if (
      !text(related.id, 128) ||
      !stableId.test(related.id) ||
      !Number.isSafeInteger(related.issue_number) ||
      Number(related.issue_number) < 1 ||
      related.id === port.listing.id ||
      related.issue_number === port.listing.issue_number
    )
      throw new Error(
        "A distinct implementation requires its own stable port ID and canonical issue.",
      );
  }
  if (item.review !== undefined) {
    const review = object(item.review, ["reference", "decision_sha256"], "lineage review");
    projectUrl(review.reference);
    if (review.decision_sha256 !== lineageDecisionDigest(port, lineage, decision))
      throw new Error("Lineage review does not bind this exact decision, port, issue and target.");
  }
  if (decision.outcome === "accepted") {
    if (!decision.review || decision.evidence.some((e) => e.kind === "contradiction"))
      throw new Error("Accepted lineage requires separate review and no unresolved contradiction.");
    if (!decision.evidence.some((e) => e.kind === "supporting"))
      throw new Error(
        "Names, redirects and shared history alone do not establish reviewed continuity.",
      );
    if (
      ["fork", "alternative", "independent"].includes(decision.relationship) &&
      !decision.related_port
    )
      throw new Error("Parallel implementations require a separate port and issue.");
    const from = decision.from.repository;
    const to = decision.to.repository;
    if (
      from &&
      to &&
      from.host === to.host &&
      from.id !== to.id &&
      (identityUrl(decision.from.project_url) === identityUrl(decision.to.project_url) ||
        decision.relationship === "relocation")
    )
      throw new Error(
        "Repository-name reuse or a different repository is not an accepted relocation.",
      );
  }
  return decision;
}

export function assessUpstreamLineage(port: PortIdentity): {
  status: "legacy-unassessed" | "recorded";
  current: UpstreamIdentity;
  history: UpstreamIdentity[];
  decisions: LineageDecision[];
} {
  if (port.upstream_lineage === undefined)
    return {
      status: "legacy-unassessed" as const,
      current: { project_url: port.listing.project_url },
      history: [] as UpstreamIdentity[],
      decisions: [] as LineageDecision[],
    };
  const value = object(
    port.upstream_lineage,
    ["format_version", "target_key", "origin", "decisions"],
    "upstream lineage",
  );
  if (
    value.format_version !== 1 ||
    !text(value.target_key, 128) ||
    !stableId.test(value.target_key) ||
    !Number.isSafeInteger(port.listing.issue_number) ||
    Number(port.listing.issue_number) < 1 ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > 64
  )
    throw new Error(
      "Lineage requires format 1, a stable target, canonical issue and bounded decisions.",
    );
  let current = identity(value.origin);
  const lineage = value as unknown as UpstreamLineage;
  const history = [current];
  const decisions: LineageDecision[] = [];
  const seen = new Set<string>();
  for (const raw of value.decisions) {
    const decision = checkedDecision(raw, port, lineage);
    if (!equal(decision.from, current))
      throw new Error("Lineage decision does not continue the retained upstream history.");
    const digest = lineageDecisionDigest(port, lineage, decision);
    if (seen.has(digest)) throw new Error("Duplicate lineage decision.");
    seen.add(digest);
    decisions.push(decision);
    if (
      decision.outcome === "accepted" &&
      ["relocation", "successor"].includes(decision.relationship)
    ) {
      if (decision.related_port)
        throw new Error("Continuity retains the canonical port and issue.");
      current = decision.to;
      history.push(current);
    }
  }
  if (identityUrl(current.project_url) !== identityUrl(port.listing.project_url))
    throw new Error("Listing origin must match the last accepted lineage identity.");
  return { status: "recorded" as const, current, history, decisions };
}

/** Existing preparation retains the old record on failure; a reversal appends a new decision. */
export function checkLineageChange(before: PortIdentity, after: PortIdentity) {
  const previous = assessUpstreamLineage(before);
  const proposed = assessUpstreamLineage(after);
  if (
    before.listing.id !== after.listing.id ||
    (before.listing.issue_number !== undefined &&
      before.listing.issue_number !== after.listing.issue_number)
  )
    throw new Error("Lineage cannot replace a stable port or canonical issue.");
  if (before.upstream_lineage) {
    if (
      !after.upstream_lineage ||
      before.upstream_lineage.target_key !== after.upstream_lineage.target_key ||
      !equal(before.upstream_lineage.origin, after.upstream_lineage.origin) ||
      !equal(previous.decisions, proposed.decisions.slice(0, previous.decisions.length))
    )
      throw new Error(
        "Retain the original lineage and every prior decision; append a reviewed reversal.",
      );
  } else if (
    after.upstream_lineage &&
    identityUrl(after.upstream_lineage.origin.project_url) !==
      identityUrl(before.listing.project_url)
  ) {
    throw new Error("A legacy lineage must begin at the retained project origin.");
  }
  if (
    identityUrl(before.listing.project_url) !== identityUrl(after.listing.project_url) &&
    !after.upstream_lineage
  )
    throw new Error("Existing stable ID has another origin; supply a reviewed lineage transition.");
  return proposed;
}

/** Known aliases are unique per target, while separate games may share one repository. */
export function checkLineageIdentities(records: readonly PortIdentity[]) {
  const issues = new Map<number, string>();
  const identities = new Map<string, string>();
  const byId = new Map(records.map((record) => [record.listing.id, record]));
  for (const record of records) {
    const { id, issue_number: issue } = record.listing;
    if (issue !== undefined) {
      if (issues.has(issue) && issues.get(issue) !== id)
        throw new Error(`Canonical issue ${issue} is assigned to multiple port identities.`);
      issues.set(issue, id);
    }
    const lineage = record.upstream_lineage;
    const assessment = assessUpstreamLineage(record);
    if (!lineage) continue;
    for (const decision of assessment.decisions) {
      if (decision.outcome !== "accepted" || !decision.related_port) continue;
      const related = byId.get(decision.related_port.id);
      if (!related || related.listing.issue_number !== decision.related_port.issue_number)
        throw new Error(
          "Parallel implementation does not match a separate canonical catalog record.",
        );
      const known = assessUpstreamLineage(related);
      const candidates = known.status === "legacy-unassessed" ? [known.current] : known.history;
      if (!candidates.some((candidate) => equal(candidate, decision.to)))
        throw new Error(
          "Parallel implementation destination differs from its retained upstream identity.",
        );
    }
    for (const upstream of assessment.history) {
      const keys = [`url:${identityUrl(upstream.project_url)}:${lineage.target_key}`];
      if (upstream.repository)
        keys.push(
          `repository:${upstream.repository.host}:${upstream.repository.id}:${lineage.target_key}`,
        );
      for (const key of keys) {
        const existing = identities.get(key);
        if (existing && existing !== id)
          throw new Error(`Duplicate upstream implementation for ${existing} and ${id}.`);
        identities.set(key, id);
      }
    }
  }
}

export function checkObservedRepository(port: PortIdentity, repositoryId: unknown) {
  const { current } = assessUpstreamLineage(port);
  if (
    current.repository?.host === "github.com" &&
    repositoryId !== undefined &&
    ((typeof repositoryId !== "string" && typeof repositoryId !== "number") ||
      String(repositoryId) !== current.repository.id)
  )
    throw new Error(
      "Observed repository identity contradicts retained lineage; possible repository-name reuse.",
    );
}
