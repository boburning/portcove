import {
  collectRepositoryIssueInventory,
  readCompleteConnection,
} from "./repository-issue-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import type { RoadmapClient, RoadmapIssueItem } from "./roadmap.mts";

export interface InventoryCache {
  format: 1;
  repository: string;
  repository_node_id: string;
  observed_at: string;
  issues: RoadmapIssueItem[];
}
export interface RoadmapInventory extends InventoryCache {
  projectId: string;
  items: RoadmapIssueItem[];
  archivedItems: RoadmapIssueItem[];
  body_reads: number;
}
const validated = new WeakMap<RoadmapInventory, { client: RoadmapClient; hash: string }>();
export function invalidateRoadmapInventory(value: RoadmapInventory) {
  validated.delete(value);
}
export function requireRoadmapInventory(
  value: RoadmapInventory,
  repository: string,
  client?: unknown,
) {
  const binding = validated.get(value);
  if (
    !binding ||
    (client && binding.client !== client) ||
    binding.hash !== observationHash(value) ||
    value.repository !== repository ||
    Date.now() - Date.parse(value.observed_at) > 120000
  )
    throw new Error("A complete collector-validated Roadmap inventory is required");
  return value;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error("Incomplete Roadmap inventory object");
  return v;
};
function connection(
  client: RoadmapClient,
  query: string,
  variables: Record<string, unknown>,
  select: (v: unknown) => unknown,
) {
  return readCompleteConnection(
    client,
    query,
    variables,
    select,
    (node) => object(node).id,
  ) as RoadmapIssueItem[];
}

export function collectRoadmapInventory(
  client: RoadmapClient,
  cache?: InventoryCache,
): RoadmapInventory {
  const repository = client.config.repository;
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("Invalid repository binding");
  const markerQuery = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner issues(first:1,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{id updatedAt}}}}`;
  let repositoryIdentity: string | undefined;
  const marker = () => {
    const value = object(object(client.graphql(markerQuery, { owner, name })).repository);
    if (
      repositoryIdentity !== undefined &&
      (value.id !== repositoryIdentity ||
        String(value.nameWithOwner).toLowerCase() !== repository.toLowerCase())
    )
      throw new Error("Repository provider identity changed during inventory collection");
    return value;
  };
  const before = marker();
  if (
    typeof before.id !== "string" ||
    String(before.nameWithOwner).toLowerCase() !== repository.toLowerCase()
  )
    throw new Error("Wrong repository inventory identity");
  repositoryIdentity = before.id;
  if (cache?.repository_node_id && cache.repository_node_id !== before.id)
    throw new Error("Repository provider identity changed; preserve the historical baseline");
  const enumerate = () =>
    collectRepositoryIssueInventory(client, { bodies: false }).issues.map(
      (row): RoadmapIssueItem => ({ ...row }),
    );
  let rows = enumerate();
  const cached = new Map<string, RoadmapIssueItem>();
  if (cache?.format === 1 && cache.repository === repository && Array.isArray(cache.issues)) {
    for (const issue of cache.issues) {
      if (
        typeof issue.id === "string" &&
        typeof issue.body === "string" &&
        issue.body_sha256 === observationHash(issue.body)
      )
        cached.set(issue.id, issue);
    }
  }
  const repositoryPrefix = `https://github.com/${repository.toLowerCase()}/issues/`;
  const needs: RoadmapIssueItem[] = [];
  for (const row of rows) {
    if (
      typeof row.id !== "string" ||
      typeof row.updatedAt !== "string" ||
      typeof row.number !== "number" ||
      !Number.isSafeInteger(row.number) ||
      typeof row.url !== "string" ||
      row.url.toLowerCase() !== `${repositoryPrefix}${row.number}`
    )
      throw new Error("Malformed repository issue revision or binding");
    const old = cached.get(row.id);
    if (old?.updatedAt === row.updatedAt && old.url === row.url && old.number === row.number)
      row.body = old.body;
    else needs.push(row);
  }
  let bodyReads = 0;
  let hydrationMoved = false;
  const hydrate = (wanted: RoadmapIssueItem[], reconcile = false) => {
    for (let offset = 0; offset < wanted.length; offset += 10) {
      const batch = wanted.slice(offset, offset + 10);
      const data = object(
        client.graphql(
          `query($ids:[ID!]!){nodes(ids:$ids){__typename ... on Issue{id number title state url updatedAt body} ... on PullRequest{id number title state url updatedAt body} ... on DraftIssue{id updatedAt body}}}`,
          { ids: batch.map((i) => i.id) },
        ),
      );
      if (!Array.isArray(data.nodes) || data.nodes.length !== batch.length)
        throw new Error("Missing hydrated Roadmap nodes");
      const found = new Map<string, Record<string, unknown>>();
      for (const raw of data.nodes) {
        const node = object(raw);
        if (typeof node.id !== "string" || found.has(node.id))
          throw new Error("Missing/duplicate hydrated identity");
        found.set(node.id, node);
      }
      for (const row of batch) {
        const node = found.get(String(row.id));
        if (
          !node ||
          typeof node.body !== "string" ||
          node.url !== row.url ||
          node.number !== row.number
        )
          throw new Error(`Hydrated identity mismatch for issue #${row.number} (${row.id})`);
        if (node.updatedAt !== row.updatedAt) {
          if (
            !reconcile ||
            typeof node.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(node.updatedAt)) ||
            typeof node.title !== "string" ||
            (node.state !== "OPEN" && node.state !== "CLOSED")
          )
            throw new Error(
              `Issue #${row.number} changed during body hydration: ${String(row.updatedAt)} -> ${String(node.updatedAt)}`,
            );
          // Adopt the whole atomic issue observation, then verify its membership/revision below.
          row.updatedAt = node.updatedAt;
          row.title = node.title;
          row.state = node.state;
          hydrationMoved = true;
        }
        row.body = node.body;
        bodyReads++;
      }
    }
  };
  hydrate(needs, true);
  let stableMarker = before;
  const afterHydration = marker();
  if (hydrationMoved || observationHash(afterHydration) !== observationHash(before)) {
    // One semantic reconciliation pass; failed requests and a second drift are never retried.
    stableMarker = afterHydration;
    const refreshed = enumerate();
    const prior = new Map(rows.map((row) => [row.id, row]));
    if (refreshed.length !== rows.length)
      throw new Error("Repository membership changed during inventory collection");
    const changed: RoadmapIssueItem[] = [];
    for (const row of refreshed) {
      const old = prior.get(row.id);
      if (
        !old ||
        old.url !== row.url ||
        old.number !== row.number ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt))
      )
        throw new Error(
          `Repository identity changed during reconciliation for issue #${row.number}`,
        );
      if (old.updatedAt === row.updatedAt) row.body = old.body;
      else changed.push(row);
    }
    hydrate(changed);
    if (observationHash(marker()) !== observationHash(stableMarker))
      throw new Error(
        "Repository changed during the single inventory reconciliation; resume on a later run",
      );
    rows = refreshed;
  }
  client._completeProjectContext = undefined;
  client._projectContext = undefined;
  const context = client.completeProjectContext();
  client._projectContext = context;
  if (!context.details.id) throw new Error("Missing Project identity");
  const projectMarker = () => {
    const value = object(
      object(
        client.graphql(
          `query($id:ID!){projectRevision:node(id:$id){... on ProjectV2{id updatedAt items(first:1,archivedStates:[ARCHIVED,NOT_ARCHIVED]){totalCount}}}}`,
          { id: context.details.id },
        ),
      ).projectRevision,
    );
    if (
      value.id !== context.details.id ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      throw new Error("Project revision binding is invalid");
    const total = object(value.items).totalCount;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new Error("Project revision coverage count is invalid");
    return value;
  };
  const projectBefore = projectMarker();
  const allItems = client.itemList(client.config.project.number, {
    includeBodies: false,
    includeDependencies: true,
    details: context.details,
    includeArchived: true,
    pageSize: 100,
  });
  if (allItems.length !== object(projectBefore.items).totalCount)
    throw new Error("Project inventory count mismatch with independent revision observation");
  const byId = new Map(rows.map((i) => [i.id, i]));
  const foreign: RoadmapIssueItem[] = [];
  for (const item of allItems) {
    const content = item.content;
    if (!content) throw new Error("Redacted Project content leaves incomplete coverage");
    const local = byId.get(content.id);
    if (local) {
      if (
        content.url !== local.url ||
        content.number !== local.number ||
        content.updatedAt !== local.updatedAt
      )
        throw new Error(
          `Project/repository issue revision mismatch for #${local.number}: ${String(local.updatedAt)} -> ${String(content.updatedAt)}`,
        );
      content.body = local.body;
    } else foreign.push(content);
    const blockers = content.blockedBy;
    if (
      isRecord(blockers) &&
      Array.isArray(blockers.nodes) &&
      typeof blockers.totalCount === "number" &&
      blockers.nodes.length < blockers.totalCount
    ) {
      const nodes = connection(
        client,
        `query($id:ID!,$after:String){node(id:$id){... on Issue{blockedBy(first:100,after:$after){totalCount nodes{id number title url state} pageInfo{hasNextPage endCursor}}}}}`,
        { id: content.id },
        (v) => object(object(v).node).blockedBy,
      );
      content.blockedBy = { nodes, totalCount: nodes.length };
    }
  }
  hydrate(foreign);
  if (observationHash(projectMarker()) !== observationHash(projectBefore))
    throw new Error("Project changed during inventory collection");
  if (observationHash(marker()) !== observationHash(stableMarker))
    throw new Error("Repository changed during inventory collection");
  for (const row of rows) {
    row.type = "Issue";
    row.node_id = row.id;
    row.html_url = row.url;
    row.body_sha256 = observationHash(row.body);
  }
  const result: RoadmapInventory = {
    format: 1,
    repository,
    repository_node_id: before.id,
    observed_at: new Date().toISOString(),
    projectId: context.details.id,
    issues: rows,
    items: allItems.filter((i) => i.isArchived === false),
    archivedItems: allItems.filter((i) => i.isArchived === true),
    body_reads: bodyReads,
  };
  if (result.items.length + result.archivedItems.length !== allItems.length)
    throw new Error("Unknown Project archive scope");
  validated.set(result, { client, hash: observationHash(result) });
  return result;
}
