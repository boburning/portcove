import type { GitHubRequestPolicy } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import { createHash } from "node:crypto";

const hazardousNegation =
  /\b(?:(?:do|does|did|will|would|should|can|could|may|might|must)\s+not|(?:do|does|did|would|should|could|must)n['’]t|won['’]t|can(?:not|['’]t))\s+(?:close|fix|resolve)(?:s|d|ing)?\s*:?\s*(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|<?https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)\b/i;

export function hasHazardousClosingNegation(text: string) {
  return hazardousNegation.test(text);
}

function canonicalTarget(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/u.test(value))
    throw new Error("Closure targets must be explicit owner/repository#number identities");
  if (!Number.isSafeInteger(Number(value.split("#")[1])))
    throw new Error("Invalid closure issue number");
  return value.toLowerCase();
}

function validateClosureIntent(intent: unknown) {
  if (
    !isRecord(intent) ||
    JSON.stringify(Object.keys(intent).sort()) !==
      JSON.stringify(["allowed_targets", "format_version"]) ||
    intent.format_version !== 1 ||
    !Array.isArray(intent.allowed_targets)
  )
    throw new Error(
      "An independent format_version:1 closure intent with allowed_targets is required",
    );
  const inputs: readonly unknown[] = intent.allowed_targets;
  const targets = inputs.map(canonicalTarget);
  if (new Set(targets).size !== targets.length) throw new Error("Duplicate closure intent target");
  return [...targets].sort();
}

function closingReferences(text: unknown, repository: string) {
  if (typeof text !== "string") throw new Error("Closure candidate text is unavailable");
  const targets = [];
  const expression =
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s*(?:<?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*))\b/giu;
  for (const match of text.matchAll(expression))
    targets.push(canonicalTarget(`${match[1] ?? match[3] ?? repository}#${match[2] ?? match[4]}`));
  return [...new Set(targets)].sort();
}

export function checkClosureIntent(
  intent: unknown,
  {
    repository,
    texts = [],
    relationships = [],
  }: { repository: string; texts?: readonly string[]; relationships?: readonly string[] },
) {
  const allowed = new Set(validateClosureIntent(intent));
  const observed = new Set(relationships.map(canonicalTarget));
  for (const text of texts) {
    if (hasHazardousClosingNegation(text))
      throw new Error("Hazardous negated closing phrase; use 'Related to #244' instead");
    for (const target of closingReferences(text, repository)) observed.add(target);
  }
  for (const target of observed)
    if (!allowed.has(target)) throw new Error(`Undeclared closing relationship: ${target}`);
  return [...observed].sort();
}

interface ClosingApi {
  request(options: {
    method: "POST" | "GET";
    url: string;
    data?: unknown;
    request: { portcove: GitHubRequestPolicy };
  }): Promise<{ data: unknown }>;
}

function closingObservation(
  binding: { head: string; title: string; body: string },
  relationships: readonly string[],
  source: "graphql" | "rest",
) {
  const observation = { ...binding, relationships: [...relationships].sort() };
  return {
    ...observation,
    source,
    fingerprint: createHash("sha256").update(JSON.stringify(observation)).digest("hex"),
  };
}

/**
 * Read the issues a pull request will close. GitHub's GraphQL inventory is the
 * authority. When GraphQL itself is refused with HTTP 403 (for example a
 * session whose network allows only REST), reconstruct the same set over REST,
 * failing closed on anything REST cannot identify exactly. Integrity failures
 * of either read never fall back.
 */
export async function readClosingRelationships(
  api: ClosingApi,
  repository: string,
  number: number,
) {
  try {
    return await readClosingRelationshipsGraphql(api, repository, number);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 403) throw error;
    return readClosingRelationshipsRest(api, repository, number);
  }
}

const timelinePageLimit = 30;
const timelinePageSize = 100;

/**
 * REST reconstruction from the PR body and its complete issue timeline: closing
 * keywords in the body (the same grammar the candidate checks apply to commits
 * and the squash message) are the relationships. Manual Development links
 * appear only as connected/disconnected timeline events whose counterpart REST
 * does not identify exactly, so any such event leaves the inventory unknown and
 * refuses it. Pages are the raw `per_page=100` responses in order; only a short
 * final page proves the timeline complete.
 */
export function restTimelineRelationships(body: string, repository: string, pages: unknown) {
  if (
    !Array.isArray(pages) ||
    pages.length < 1 ||
    pages.length > timelinePageLimit ||
    !pages.every(
      (page: unknown, index) =>
        Array.isArray(page) &&
        (index === pages.length - 1
          ? page.length < timelinePageSize
          : page.length === timelinePageSize),
    )
  )
    throw new Error("Closing relationship timeline is incomplete or exceeds its bounded inventory");
  for (const event of (pages as unknown[][]).flat()) {
    if (!isRecord(event) || typeof event.event !== "string")
      throw new Error("Closing relationship timeline is incomplete");
    if (event.event === "connected" || event.event === "disconnected")
      throw new Error(
        "A manual Development link is unknown over REST; read closing relationships through GraphQL",
      );
  }
  return closingReferences(body, repository);
}

/** Live REST reconstruction bracketed by unchanged pull request reads. */
export async function readClosingRelationshipsRest(
  api: ClosingApi,
  repository: string,
  number: number,
) {
  const readPull = async () => {
    const { data: pull } = await api.request({
      method: "GET",
      url: `https://api.github.com/repos/${repository}/pulls/${number}`,
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    });
    const head = isRecord(pull) && isRecord(pull.head) ? pull.head.sha : undefined;
    if (
      !isRecord(pull) ||
      pull.number !== number ||
      typeof head !== "string" ||
      !/^[a-f0-9]{40}$/u.test(head) ||
      typeof pull.title !== "string" ||
      !(typeof pull.body === "string" || pull.body === null)
    )
      throw new Error("Closing relationship inventory is incomplete");
    return { head, title: pull.title, body: pull.body ?? "" };
  };
  const first = await readPull();
  const pages: unknown[] = [];
  for (let page = 1; page <= timelinePageLimit; page += 1) {
    const { data: events } = await api.request({
      method: "GET",
      url: `https://api.github.com/repos/${repository}/issues/${number}/timeline?per_page=${timelinePageSize}&page=${page}`,
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    });
    pages.push(events);
    if (!Array.isArray(events) || events.length < timelinePageSize) break;
  }
  const relationships = restTimelineRelationships(first.body, repository, pages);
  if (JSON.stringify(await readPull()) !== JSON.stringify(first))
    throw new Error("Closing relationship inventory changed during pagination");
  return closingObservation(first, relationships, "rest");
}

async function readClosingRelationshipsGraphql(
  api: ClosingApi,
  repository: string,
  number: number,
) {
  const [owner, name] = repository.split("/");
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid title body closingIssuesReferences(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor}nodes{id number repository{nameWithOwner}}}}}}`;
  let cursor: string | null = null;
  let first: { head: string; title: string; body: string } | null = null;
  let total: number | null = null;
  const ids = new Set<string>(),
    targets = new Set<string>(),
    cursors = new Set<string>();
  for (;;) {
    const { data: envelope } = await api.request({
      method: "POST",
      url: "https://api.github.com/graphql",
      data: { query, variables: { owner, name, number, cursor } },
      request: { portcove: { replay: "pure-query", attempts: 0 } },
    });
    const data: unknown = isRecord(envelope) ? envelope.data : undefined;
    const repositoryData: unknown = isRecord(data) ? data.repository : undefined;
    const pull: unknown = isRecord(repositoryData) ? repositoryData.pullRequest : undefined;
    const connection: unknown = isRecord(pull) ? pull.closingIssuesReferences : undefined;
    if (
      !isRecord(pull) ||
      !isRecord(connection) ||
      !isRecord(connection.pageInfo) ||
      pull.number !== number ||
      typeof pull.headRefOid !== "string" ||
      !/^[a-f0-9]{40}$/u.test(pull.headRefOid ?? "") ||
      typeof pull.body !== "string" ||
      typeof pull.title !== "string" ||
      typeof connection.totalCount !== "number" ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0 ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Closing relationship inventory is incomplete");
    const binding = { head: pull.headRefOid, title: pull.title, body: pull.body };
    first ??= binding;
    total ??= connection.totalCount;
    if (JSON.stringify(binding) !== JSON.stringify(first) || connection.totalCount !== total)
      throw new Error("Closing relationship inventory changed during pagination");
    const issues: readonly unknown[] = connection.nodes;
    for (const issue of issues) {
      if (
        !isRecord(issue) ||
        typeof issue.id !== "string" ||
        typeof issue.number !== "number" ||
        !issue.id ||
        !Number.isSafeInteger(issue.number) ||
        issue.number < 1
      )
        throw new Error("Closing relationship identity is incomplete");
      const repositoryName = isRecord(issue.repository)
        ? issue.repository.nameWithOwner
        : undefined;
      const target = canonicalTarget(`${String(repositoryName)}#${issue.number}`);
      if (ids.has(issue.id) || targets.has(target))
        throw new Error("Duplicate closing relationship identity");
      ids.add(issue.id);
      targets.add(target);
    }
    if (!connection.pageInfo.hasNextPage) break;
    const next: unknown = connection.pageInfo.endCursor;
    if (
      typeof next !== "string" ||
      !next ||
      cursors.has(next) ||
      connection.nodes.length === 0 ||
      ids.size >= total
    )
      throw new Error("Closing relationship pagination is incomplete");
    cursors.add(next);
    cursor = next;
  }
  if (!first || ids.size !== total) throw new Error("Closing relationship count is incomplete");
  return closingObservation(first, [...targets], "graphql");
}
