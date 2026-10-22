import { createHash } from "node:crypto";
import { GitHubApiError, sanitizeOperationError } from "./github-api.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";

export interface InventoryReader {
  config: { repository: string };
  graphql(query: string, variables?: Readonly<Record<string, unknown>>): unknown;
}
export interface RepositoryIssueRecord {
  id: string;
  node_id: string;
  number: number;
  title: string;
  url: string;
  html_url: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  type: "Issue";
  body?: string;
}
export type InventoryFailureKind =
  | "inventory_changed"
  | "inventory_incomplete"
  | "inventory_malformed"
  | "inventory_identity"
  | "transport"
  | "authentication"
  | "rate_limit"
  | "budget"
  | "planning_findings";
export class InventoryError extends GitHubApiError {
  readonly kind: InventoryFailureKind;
  constructor(kind: InventoryFailureKind, message: string) {
    super(kind, message, { operation: "repository issue inventory" });
    this.kind = kind;
  }
}
export function inventoryFailureKind(error: unknown): InventoryFailureKind {
  if (isRecord(error) && Array.isArray(error.doctorErrors)) return "planning_findings";
  if (error instanceof InventoryError) return error.kind;
  if (error instanceof GitHubApiError) {
    if (error.code === "budget_exhausted" || error.code === "quota_unknown") return "budget";
    if (error.code === "rate_limited" || error.rateLimit?.remaining === 0 || error.status === 429)
      return "rate_limit";
    if (error.status === 401 || error.status === 403) return "authentication";
    if (error.code === "inventory_changed") return "inventory_changed";
    if (errorCode(error.cause) === "ENOBUFS") return "inventory_incomplete";
    if (error.code === "invalid_response" || error.code === "graphql_error")
      return "inventory_malformed";
    return "transport";
  }
  return "inventory_malformed";
}
export function retryableInventoryRead(error: unknown) {
  if (error instanceof GitHubApiError && error.retryAfter !== null) return false;
  const kind = inventoryFailureKind(error);
  if (kind === "inventory_changed") return true;
  if (kind !== "transport" || !(error instanceof GitHubApiError)) return false;
  return (
    [502, 503, 504].includes(error.status ?? 0) ||
    ["ETIMEDOUT", "ECONNRESET"].includes(errorCode(error.cause) ?? "")
  );
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value))
    throw new InventoryError("inventory_malformed", "incomplete GitHub inventory object");
  return value;
};
export interface InventoryPageEvidence {
  page: number;
  cursor_sha256: string;
  reported_total: number;
  observed: number;
  terminal: boolean;
}
/** Every connection is independently counted. A failed page never returns partial records. */
export function readCompleteConnection(
  reader: Pick<InventoryReader, "graphql">,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  select: (data: unknown) => unknown,
  identity: (node: unknown) => unknown,
  evidence: InventoryPageEvidence[] = [],
): unknown[] {
  const rows: unknown[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  let after: string | null = null,
    total: number | undefined;
  try {
    for (;;) {
      const page = object(select(reader.graphql(query, { ...variables, after })));
      const info = object(page.pageInfo);
      if (
        !Array.isArray(page.nodes) ||
        typeof page.totalCount !== "number" ||
        !Number.isSafeInteger(page.totalCount) ||
        page.totalCount < 0 ||
        typeof info.hasNextPage !== "boolean" ||
        !(info.endCursor === null || typeof info.endCursor === "string")
      )
        throw new InventoryError(
          "inventory_malformed",
          "incomplete GitHub inventory: malformed connection or pagination",
        );
      total ??= page.totalCount;
      evidence.push({
        page: evidence.length + 1,
        cursor_sha256: hash(after),
        reported_total: page.totalCount,
        observed: page.nodes.length,
        terminal: !info.hasNextPage,
      });
      if (total !== page.totalCount)
        throw new InventoryError(
          "inventory_changed",
          `GitHub inventory changed during pagination; discard the read (total ${total} -> ${page.totalCount})`,
        );
      for (const node of page.nodes) {
        const id = identity(node);
        if (typeof id !== "string" || !id || ids.has(id))
          throw new InventoryError(
            "inventory_incomplete",
            "incomplete GitHub inventory: missing or duplicate record identity",
          );
        ids.add(id);
        rows.push(node);
      }
      if (rows.length > total)
        throw new InventoryError(
          "inventory_incomplete",
          "incomplete GitHub inventory: record count exceeds total",
        );
      if (!info.hasNextPage) break;
      const cursor = info.endCursor;
      if (
        !page.nodes.length ||
        typeof cursor !== "string" ||
        !cursor ||
        cursors.has(cursor) ||
        rows.length >= total
      )
        throw new InventoryError(
          "inventory_incomplete",
          "incomplete GitHub inventory: pagination did not advance",
        );
      cursors.add(cursor);
      after = cursor;
    }
    if (rows.length !== total)
      throw new InventoryError(
        "inventory_incomplete",
        "incomplete GitHub inventory: record count does not match total",
      );
    return rows;
  } catch (error) {
    if (error instanceof Error)
      Object.assign(error, { connectionEvidence: { query_sha256: hash(query), pages: evidence } });
    throw error;
  }
}
export interface RepositoryInventoryEvidence {
  source: "graphql";
  repository: string;
  repository_node_id?: string;
  field_coverage: "metadata" | "bodies";
  started_at: string;
  finished_at?: string;
  query_sha256: string;
  pages: InventoryPageEvidence[];
  total?: number;
}
export interface VerifiedRepositoryIssueInventory {
  readonly repository: string;
  readonly repository_node_id: string;
  readonly observed_at: string;
  readonly field_coverage: "metadata" | "bodies";
  readonly issues: readonly Readonly<RepositoryIssueRecord>[];
  readonly evidence: RepositoryInventoryEvidence;
}
const verified = new WeakMap<
  VerifiedRepositoryIssueInventory,
  { reader: InventoryReader; hash: string }
>();
export function requireRepositoryIssueInventory(
  value: VerifiedRepositoryIssueInventory,
  reader: Pick<InventoryReader, "config">,
  bodies = true,
) {
  const proof = verified.get(value);
  if (
    !proof ||
    proof.reader !== reader ||
    proof.hash !== hash(value) ||
    value.repository !== reader.config.repository ||
    Date.now() - Date.parse(value.observed_at) > 120000 ||
    (bodies && value.field_coverage !== "bodies")
  )
    throw new InventoryError(
      "inventory_incomplete",
      "A fresh collector-verified repository issue inventory is required",
    );
  return value;
}
export function collectRepositoryIssueInventory(
  reader: InventoryReader,
  {
    bodies = true,
    evidence: sink,
  }: {
    bodies?: boolean;
    evidence?: RepositoryInventoryEvidence[];
  } = {},
): VerifiedRepositoryIssueInventory {
  const binding = reader.config.repository;
  const [owner, name, extra] = binding.split("/");
  if (!owner || !name || extra)
    throw new InventoryError("inventory_identity", "Invalid repository inventory binding");
  const query = `query RepositoryIssueInventory($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){id nameWithOwner issues(first:${bodies ? 50 : 100},after:$after,orderBy:{field:CREATED_AT,direction:ASC}){totalCount nodes{id number title ${bodies ? "body" : ""} url state updatedAt} pageInfo{hasNextPage endCursor}}} rateLimit{cost limit remaining used resetAt}}`;
  const evidence: RepositoryInventoryEvidence = {
    source: "graphql",
    repository: binding,
    field_coverage: bodies ? "bodies" : "metadata",
    started_at: new Date().toISOString(),
    query_sha256: hash(query),
    pages: [],
  };
  sink?.push(evidence);
  let repositoryId: string | undefined;
  const repository = (data: unknown) => {
    const value = object(object(data).repository);
    if (
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.nameWithOwner !== "string" ||
      value.nameWithOwner.toLowerCase() !== binding.toLowerCase() ||
      (repositoryId !== undefined && repositoryId !== value.id)
    )
      throw new InventoryError(
        "inventory_identity",
        "incomplete GitHub inventory: repository identity changed or is unavailable",
      );
    repositoryId = value.id;
    evidence.repository_node_id = value.id;
    return value;
  };
  const marker = () => {
    const connection = object(
      repository(
        reader.graphql(
          `query RepositoryIssueMarker($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner issues(first:1,orderBy:{field:CREATED_AT,direction:DESC}){totalCount nodes{id number}}} rateLimit{cost limit remaining used resetAt}}`,
          { owner, name },
        ),
      ).issues,
    );
    const count = connection.totalCount,
      nodes = connection.nodes;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Array.isArray(nodes) ||
      nodes.length !== (count === 0 ? 0 : 1)
    )
      throw new InventoryError(
        "inventory_malformed",
        "incomplete GitHub inventory: invalid repository issue marker",
      );
    const node = count === 0 ? null : object(nodes[0]);
    if (
      node &&
      (typeof node.id !== "string" ||
        !node.id ||
        typeof node.number !== "number" ||
        !Number.isSafeInteger(node.number) ||
        node.number < 1)
    )
      throw new InventoryError(
        "inventory_malformed",
        "incomplete GitHub inventory: invalid repository issue marker",
      );
    return { count, id: node?.id ?? null, number: node?.number ?? null };
  };
  try {
    const before = marker();
    const numbers = new Set<number>();
    const issues = readCompleteConnection(
      reader,
      query,
      { owner, name },
      (data) => repository(data).issues,
      (node) => object(node).id,
      evidence.pages,
    ).map((raw): Readonly<RepositoryIssueRecord> => {
      const row = object(raw);
      if (
        typeof row.id !== "string" ||
        typeof row.number !== "number" ||
        !Number.isSafeInteger(row.number) ||
        row.number < 1 ||
        numbers.has(row.number) ||
        typeof row.title !== "string" ||
        typeof row.url !== "string" ||
        row.url.toLowerCase() !==
          `https://github.com/${binding}/issues/${row.number}`.toLowerCase() ||
        (row.state !== "OPEN" && row.state !== "CLOSED") ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt)) ||
        (bodies && typeof row.body !== "string")
      )
        throw new InventoryError(
          "inventory_malformed",
          "incomplete GitHub inventory: malformed repository issue revision, number or binding",
        );
      numbers.add(row.number);
      return Object.freeze({
        id: row.id,
        node_id: row.id,
        number: row.number,
        title: row.title,
        url: row.url,
        html_url: row.url,
        state: row.state,
        updatedAt: row.updatedAt,
        type: "Issue",
        ...(bodies ? { body: row.body as string } : {}),
      });
    });
    const after = marker();
    if (
      before.count !== issues.length ||
      hash(before) !== hash(after) ||
      (after.id !== null &&
        !issues.some((row) => row.id === after.id && row.number === after.number))
    )
      throw new InventoryError(
        "inventory_changed",
        "GitHub inventory changed during pagination; discard the read",
      );
    evidence.total = issues.length;
    evidence.finished_at = new Date().toISOString();
    const result = Object.freeze({
      repository: binding,
      repository_node_id: repositoryId!,
      observed_at: new Date().toISOString(),
      field_coverage: evidence.field_coverage,
      issues: Object.freeze(issues),
      evidence,
    });
    verified.set(result, { reader, hash: hash(result) });
    return result;
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { inventoryEvidence: evidence });
    throw error;
  } finally {
    evidence.finished_at ??= new Date().toISOString();
  }
}

export interface DoctorReadAttempt {
  attempt: number;
  outcome: "passed" | "failed";
  error?: ReturnType<typeof sanitizeOperationError>;
  failure_kind?: InventoryFailureKind;
  connection_evidence?: unknown;
  provider?: { status: number | null; rate: unknown; retry_after: string | null };
}
/** Retry admission uses fresh counts/quota, never a request-count claim about actual API cost. */
export function admitDoctorReadRetry(
  reader: InventoryReader,
  projectId: string,
  elapsedMs: number,
  pointHeadroom = 10,
) {
  try {
    if (!Number.isFinite(pointHeadroom) || pointHeadroom < 10) return false;
    const requiredMs = Math.max(1, Math.ceil(elapsedMs));
    if (coordinatorCommandTimeout(requiredMs) < requiredMs) return false;
    const [owner, name] = reader.config.repository.split("/");
    const data = object(
      reader.graphql(
        `query DoctorRetryAdmission($owner:String!,$name:String!,$id:ID!){repository(owner:$owner,name:$name){id nameWithOwner issues(first:1){totalCount}} node(id:$id){...on ProjectV2{id items(first:1){totalCount} fields(first:1){totalCount} views(first:1){totalCount}}} rateLimit{cost remaining resetAt}}`,
        { owner, name, id: projectId },
      ),
    );
    const repository = object(data.repository),
      project = object(data.node),
      rate = object(data.rateLimit);
    if (
      repository.nameWithOwner !== reader.config.repository ||
      project.id !== projectId ||
      typeof rate.remaining !== "number" ||
      !Number.isSafeInteger(rate.remaining) ||
      rate.remaining < 0 ||
      typeof rate.resetAt !== "string" ||
      !Number.isFinite(Date.parse(rate.resetAt)) ||
      Date.parse(rate.resetAt) <= Date.now()
    )
      return false;
    const count = (value: unknown) => {
      const total = object(value).totalCount;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
        throw new InventoryError("inventory_incomplete", "Retry admission counts are unavailable");
      return total;
    };
    if (typeof rate.cost !== "number" || !Number.isSafeInteger(rate.cost) || rate.cost < 0)
      return false;
    pointHeadroom = Math.max(pointHeadroom, rate.cost);
    const requests =
      Math.max(1, Math.ceil(count(repository.issues) / 50)) +
      Math.max(1, Math.ceil(count(project.items) / 50)) +
      Math.max(1, Math.ceil(count(project.fields) / 100)) +
      Math.max(1, Math.ceil(count(project.views) / 100)) +
      8;
    // Ten points per planned request is existing Roadmap discovery headroom, not a provider guarantee.
    return (
      rate.remaining >= requests * pointHeadroom &&
      Date.parse(rate.resetAt) > Date.now() &&
      coordinatorCommandTimeout(requiredMs) >= requiredMs
    );
  } catch {
    return false;
  }
}
/** The owner retries a whole read, never an individual page or a mutation. */
export async function runDoctorRead<T>({
  read,
  admitRetry,
  reset,
  attempts,
}: {
  read: () => Promise<T>;
  admitRetry: () => boolean;
  reset: () => void;
  attempts: DoctorReadAttempt[];
}): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await read();
      attempts.push({ attempt, outcome: "passed" });
      return result;
    } catch (error) {
      attempts.push({
        attempt,
        outcome: "failed",
        failure_kind: inventoryFailureKind(error),
        error: sanitizeOperationError(error),
        ...(isRecord(error) && error.connectionEvidence
          ? { connection_evidence: error.connectionEvidence }
          : {}),
        ...(error instanceof GitHubApiError
          ? {
              provider: {
                status: error.status,
                rate: error.rateLimit,
                retry_after: error.retryAfter,
              },
            }
          : {}),
      });
      if (attempt === 2 || !retryableInventoryRead(error) || !admitRetry()) throw error;
      reset();
    }
  }
  throw new Error("Unreachable doctor attempt");
}
