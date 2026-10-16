import { createHash } from "node:crypto";

const hazardousNegation =
  /\b(?:(?:do|does|did|will|would|should|can|could|may|might|must)\s+not|(?:do|does|did|would|should|could|must)n['’]t|won['’]t|can(?:not|['’]t))\s+(?:close|fix|resolve)(?:s|d|ing)?\s*:?\s*(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|<?https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)\b/i;

export function hasHazardousClosingNegation(text) {
  return hazardousNegation.test(text);
}

function canonicalTarget(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/u.test(value))
    throw new Error("Closure targets must be explicit owner/repository#number identities");
  if (!Number.isSafeInteger(Number(value.split("#")[1])))
    throw new Error("Invalid closure issue number");
  return value.toLowerCase();
}

export function validateClosureIntent(intent) {
  if (
    !intent ||
    JSON.stringify(Object.keys(intent).sort()) !==
      JSON.stringify(["allowed_targets", "format_version"]) ||
    intent.format_version !== 1 ||
    !Array.isArray(intent.allowed_targets)
  )
    throw new Error(
      "An independent format_version:1 closure intent with allowed_targets is required",
    );
  const targets = intent.allowed_targets.map(canonicalTarget);
  if (new Set(targets).size !== targets.length) throw new Error("Duplicate closure intent target");
  return [...targets].sort();
}

export function closingReferences(text: string, repository) {
  if (typeof text !== "string") throw new Error("Closure candidate text is unavailable");
  const targets = [];
  const expression =
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s*(?:<?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*))\b/giu;
  for (const match of text.matchAll(expression))
    targets.push(canonicalTarget(`${match[1] ?? match[3] ?? repository}#${match[2] ?? match[4]}`));
  return [...new Set(targets)].sort();
}

export function checkClosureIntent(intent, { repository, texts = [], relationships = [] }) {
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

export function readClosingRelationships(api, repository: string, number) {
  const [owner, name] = repository.split("/");
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid title body closingIssuesReferences(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor}nodes{id number repository{nameWithOwner}}}}}}`;
  let cursor = null,
    first = null,
    total = null;
  const ids = new Set(),
    targets = new Set(),
    cursors = new Set();
  for (;;) {
    const pull = api.graphql(query, { owner, name, number, cursor }).data?.repository?.pullRequest;
    const connection = pull?.closingIssuesReferences;
    if (
      pull?.number !== number ||
      !/^[a-f0-9]{40}$/u.test(pull.headRefOid ?? "") ||
      typeof pull.body !== "string" ||
      typeof pull.title !== "string" ||
      !Number.isSafeInteger(connection?.totalCount) ||
      connection.totalCount < 0 ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Closing relationship inventory is incomplete");
    const binding = { head: pull.headRefOid, title: pull.title, body: pull.body };
    if (!first) {
      first = binding;
      total = connection.totalCount;
    }
    if (JSON.stringify(binding) !== JSON.stringify(first) || connection.totalCount !== total)
      throw new Error("Closing relationship inventory changed during pagination");
    for (const issue of connection.nodes) {
      if (
        typeof issue?.id !== "string" ||
        !issue.id ||
        !Number.isSafeInteger(issue.number) ||
        issue.number < 1
      )
        throw new Error("Closing relationship identity is incomplete");
      const target = canonicalTarget(`${issue.repository?.nameWithOwner}#${issue.number}`);
      if (ids.has(issue.id) || targets.has(target))
        throw new Error("Duplicate closing relationship identity");
      ids.add(issue.id);
      targets.add(target);
    }
    if (!connection.pageInfo.hasNextPage) break;
    const next = connection.pageInfo.endCursor;
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
  if (ids.size !== total) throw new Error("Closing relationship count is incomplete");
  const observation = { ...first, relationships: [...targets].sort() };
  return {
    ...observation,
    fingerprint: createHash("sha256").update(JSON.stringify(observation)).digest("hex"),
  };
}
