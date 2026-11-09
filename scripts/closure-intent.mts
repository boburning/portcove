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

export function closingReferences(text: unknown, repository: string) {
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
  }): Promise<{ data: unknown; headers?: Record<string, unknown> }>;
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
// Letters and digits only bound a keyword, so `_Fixes #12_` emphasis still counts.
const closingKeyword =
  /(?<![A-Za-z0-9])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?![A-Za-z0-9])/giu;
// Text after a closing keyword that GitHub might read as a reference although
// the exact grammar did not: a reference token, optionally behind markup, colons,
// quotes, HTML tags or invisible separators, in GH- shorthand, another URL form,
// an entity, a fullwidth sign, or zero-padded or spaced form.
const referenceLike =
  /^(?:<[^>]*>|[\s:*_~`[(<"'\u200b-\u200d\u2060\ufeff])*(?:[#\uff03]|&#|gh-\d|https?:\/\/|www\.|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\s*#)/iu;

const exactReferenceAt =
  /^(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s*(?:<?https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*|(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*)\b/iu;

function timelinePageUrl(repository: string, number: number, page: number) {
  return `https://api.github.com/repos/${repository}/issues/${number}/timeline?per_page=${timelinePageSize}&page=${page}`;
}

function nextTimelinePage(link: unknown, number: number) {
  if (link === null || link === undefined) return null;
  if (typeof link !== "string") throw new Error("Closing relationship timeline link is invalid");
  const next = /<([^>]+)>\s*;\s*rel="next"/u.exec(link)?.[1];
  if (next === undefined) {
    if (/next/iu.test(link)) throw new Error("Closing relationship timeline link is invalid");
    return null;
  }
  const url = new URL(next);
  if (
    url.origin !== "https://api.github.com" ||
    !url.pathname.endsWith(`/issues/${number}/timeline`) ||
    url.searchParams.get("per_page") !== String(timelinePageSize)
  )
    throw new Error("Closing relationship timeline link is not bound to the pull request");
  return Number(url.searchParams.get("page"));
}

/**
 * REST reconstruction from the PR body and its complete issue timeline: closing
 * keywords in the body (the same grammar the candidate checks apply to commits
 * and the squash message) are the relationships. Without GraphQL as a
 * backstop, a keyword followed by any other reference-like text refuses.
 * Manual Development links appear as connected/disconnected timeline events
 * whose counterpart REST does not identify exactly, so any such event leaves
 * the inventory unknown and refuses it.
 *
 * Each page is `{ url, link, events }`: the exact `per_page=100` request, its
 * raw `Link` header and the raw events. Every page but the last is full and
 * links the next one; the last is short and links none, so a timeline of an
 * exact multiple of 100 events refuses. The `committed` event of the candidate
 * head binds the timeline to that pull request.
 */
export function restTimelineRelationships(
  candidate: { number: number; head: string; body: string },
  repository: string,
  pages: unknown,
) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > timelinePageLimit)
    throw new Error("Closing relationship timeline is incomplete or exceeds its bounded inventory");
  const entries: readonly unknown[] = pages;
  const events: unknown[] = [];
  entries.forEach((page, index) => {
    if (
      !isRecord(page) ||
      page.url !== timelinePageUrl(repository, candidate.number, index + 1) ||
      !Array.isArray(page.events) ||
      page.events.length > timelinePageSize ||
      nextTimelinePage(page.link, candidate.number) !==
        (index === entries.length - 1 ? null : index + 2) ||
      // A missing Link header must not make a truncated read look final.
      (index === entries.length - 1) !== page.events.length < timelinePageSize
    )
      throw new Error("Closing relationship timeline is incomplete");
    const pageEvents: readonly unknown[] = page.events;
    events.push(...pageEvents);
  });
  let headObserved = false;
  for (const event of events) {
    if (!isRecord(event) || typeof event.event !== "string")
      throw new Error("Closing relationship timeline is incomplete");
    if (event.event === "connected" || event.event === "disconnected")
      throw new Error(
        "A manual Development link is unknown over REST; read closing relationships through GraphQL",
      );
    if (event.event === "committed" && event.sha === candidate.head) headObserved = true;
  }
  if (!headObserved)
    throw new Error("Closing relationship timeline is not bound to the pull request head");
  for (const match of candidate.body.matchAll(closingKeyword)) {
    const at = candidate.body.slice(match.index);
    if (referenceLike.test(at.slice(match[0].length)) && !exactReferenceAt.test(at))
      throw new Error(
        "A closing keyword precedes a reference REST cannot interpret exactly; read closing relationships through GraphQL",
      );
  }
  return closingReferences(candidate.body, repository);
}

export const closingInventoryCheckName = "closing-inventory";
export const closingInventoryWorkflowPath = ".github/workflows/closing-inventory.yml";

/**
 * Manual links that the hosted GraphQL inventory holds beyond the body's
 * closing keywords. Keywords GitHub does not link (for example a pull request
 * number or a non-default base) only make REST stricter and are not findings.
 */
export function closingInventoryFindings(
  observation: { body: string; relationships: readonly string[] },
  repository: string,
) {
  const keywords = new Set(closingReferences(observation.body, repository));
  return observation.relationships.filter((target) => !keywords.has(target));
}

function latestClosingInventoryCheck(value: unknown, head: string) {
  const checks: unknown = isRecord(value) ? value.check_runs : undefined;
  if (
    !isRecord(value) ||
    !Array.isArray(checks) ||
    value.total_count !== checks.length ||
    checks.length > 100
  )
    throw new Error("Closing inventory check list is incomplete");
  const entries: readonly unknown[] = checks;
  const candidates = entries.filter(
    (check): check is Record<string, unknown> =>
      isRecord(check) &&
      check.name === closingInventoryCheckName &&
      isRecord(check.app) &&
      check.app.slug === "github-actions",
  );
  const latest = candidates.toSorted((left, right) => Number(right.id) - Number(left.id))[0];
  if (
    !latest ||
    latest.head_sha !== head ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    !isRecord(latest.check_suite) ||
    !Number.isSafeInteger(latest.check_suite.id)
  )
    throw new Error(
      "The closing-inventory check has not succeeded on this head; edit the PR body or push to rerun it, or read closing relationships through GraphQL",
    );
  return { id: latest.id, suite: Number(latest.check_suite.id) };
}

/**
 * Hosted proof that GitHub's own closing inventory held no manual link when
 * the trusted default-branch workflow last ran on this head. REST cannot see
 * manual links to repositories the reader cannot access; the workflow reads
 * GraphQL and fails on any non-keyword or hidden relationship. Only a
 * pull_request_target run of the default-branch workflow file counts, so a
 * candidate cannot supply its own check.
 */
export function validateClosingInventoryEvidence(
  checks: unknown,
  workflowRuns: unknown,
  head: string,
) {
  const latest = latestClosingInventoryCheck(checks, head);
  const runs: unknown = isRecord(workflowRuns) ? workflowRuns.workflow_runs : undefined;
  const run: unknown = Array.isArray(runs) && runs.length === 1 ? runs[0] : undefined;
  if (
    !isRecord(workflowRuns) ||
    workflowRuns.total_count !== 1 ||
    !isRecord(run) ||
    run.check_suite_id !== latest.suite ||
    run.path !== closingInventoryWorkflowPath ||
    run.event !== "pull_request_target" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("The closing-inventory check is not from the trusted default-branch workflow");
  return latest;
}

async function readClosingInventoryEvidence(api: ClosingApi, repository: string, head: string) {
  const { data: checks } = await api.request({
    method: "GET",
    url: `https://api.github.com/repos/${repository}/commits/${head}/check-runs?check_name=${closingInventoryCheckName}&filter=all&per_page=100`,
    request: { portcove: { replay: "safe-read", attempts: 0 } },
  });
  const { suite } = latestClosingInventoryCheck(checks, head);
  const { data: workflowRuns } = await api.request({
    method: "GET",
    url: `https://api.github.com/repos/${repository}/actions/runs?check_suite_id=${suite}&per_page=1`,
    request: { portcove: { replay: "safe-read", attempts: 0 } },
  });
  return validateClosingInventoryEvidence(checks, workflowRuns, head);
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
    const url = timelinePageUrl(repository, number, page);
    const { data: events, headers } = await api.request({
      method: "GET",
      url,
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    });
    const link = headers?.link ?? null;
    pages.push({ url, link, events });
    if (nextTimelinePage(link, number) === null) break;
  }
  const relationships = restTimelineRelationships({ number, ...first }, repository, pages);
  await readClosingInventoryEvidence(api, repository, first.head);
  if (JSON.stringify(await readPull()) !== JSON.stringify(first))
    throw new Error("Closing relationship inventory changed during pagination");
  return closingObservation(first, relationships, "rest");
}

export async function readClosingRelationshipsGraphql(
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
