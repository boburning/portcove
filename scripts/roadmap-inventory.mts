import {
  collectRepositoryIssueInventory,
  readCompleteConnection,
} from "./repository-issue-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import { GitHubApiError } from "./github-api.mts";
import type { RoadmapClient } from "./roadmap.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";

export interface InventoryCache {
  format: 1;
  repository: string;
  repository_node_id: string;
  observed_at: string;
  issues: RoadmapIssueItem[];
}
export interface RoadmapInventory extends InventoryCache {
  scope?: "intake";
  projectId: string;
  items: RoadmapIssueItem[];
  archivedItems: RoadmapIssueItem[];
  body_reads: number;
}
export function collectRoadmapInventoryWithRecollection(
  client: RoadmapClient,
  collect: () => RoadmapInventory,
  state: { inventoryRecollections: number },
  hooks: {
    before: (error: GitHubApiError) => void;
    after: (status: "complete" | "failed", error: unknown) => void;
  },
): RoadmapInventory {
  try {
    return collect();
  } catch (error) {
    if (
      !(error instanceof GitHubApiError) ||
      error.code !== "inventory_changed" ||
      state.inventoryRecollections !== 0
    )
      throw error;
    state.inventoryRecollections++;
    let status: "complete" | "failed" = "failed";
    let failure: unknown;
    try {
      hooks.before(error);
      client._completeProjectContext = undefined;
      client._projectContext = undefined;
      const result = collect();
      status = "complete";
      return result;
    } catch (second) {
      failure = second;
      throw second;
    } finally {
      hooks.after(status, failure);
    }
  }
}
type InventoryRequirement = "full" | "identity" | { planningIssue: number };
const validated = new WeakMap<
  RoadmapInventory,
  { client: RoadmapClient; hash: string; planningIssues?: ReadonlySet<number> }
>();
export function invalidateRoadmapInventory(value: RoadmapInventory) {
  validated.delete(value);
}
export function requireRoadmapInventory(
  value: RoadmapInventory,
  repository: string,
  client?: unknown,
  requirement: InventoryRequirement = "full",
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
  if (
    binding.planningIssues &&
    (requirement === "full" ||
      (typeof requirement === "object" && !binding.planningIssues.has(requirement.planningIssue)))
  )
    throw new Error("Roadmap inventory lacks the required planning/dependency coverage");
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
  options?: { scope: "intake"; planningIssues: readonly number[] },
): RoadmapInventory {
  const intake = options?.scope === "intake";
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
  const enumerate = (bodies = false) => {
    const inventory = collectRepositoryIssueInventory(client, { bodies });
    if (inventory.repository_node_id !== repositoryIdentity)
      throw new Error("Repository provider identity changed during inventory collection");
    return inventory.issues.map((row): RoadmapIssueItem => ({ ...row }));
  };
  // Cold inventories already need every body; use the validated body-bearing listing once.
  let rows = enumerate(!cache);
  const cached = new Map<string, RoadmapIssueItem>();
  const sameRevision = (a: RoadmapIssueItem, b: RoadmapIssueItem) =>
    a.id === b.id &&
    a.url === b.url &&
    a.number === b.number &&
    a.title === b.title &&
    a.state === b.state &&
    a.updatedAt === b.updatedAt;
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
  let bodyReads = 0;
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
    if (typeof row.body === "string") {
      bodyReads++;
      continue;
    }
    const old = cached.get(row.id);
    // GitHub timestamps have second precision: a cache observed in that same second
    // cannot distinguish two edits. Rehydrate that boundary instead of trusting it.
    if (
      old &&
      sameRevision(old, row) &&
      Date.parse(String(row.updatedAt)) < Math.floor(Date.parse(cache!.observed_at) / 1000) * 1000
    )
      row.body = old.body;
    else needs.push(row);
  }
  let hydrationMoved = false;
  const hydrate = (wanted: RoadmapIssueItem[], reconcile = false) => {
    for (let offset = 0; offset < wanted.length; offset += 10) {
      const batch = wanted.slice(offset, offset + 10);
      const data = object(
        client.graphql(
          `query($ids:[ID!]!){nodes(ids:$ids){__typename ... on Issue{id number title state url updatedAt body} ... on PullRequest{id number title state merged url updatedAt body} ... on DraftIssue{id title updatedAt body}}}`,
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
        const kind = row.type ?? row.__typename;
        if (
          !node ||
          node.__typename !== kind ||
          typeof node.body !== "string" ||
          node.url !== row.url ||
          node.number !== row.number
        )
          throw new Error(`Hydrated identity mismatch for issue #${row.number} (${row.id})`);
        if (
          node.updatedAt !== row.updatedAt ||
          node.title !== row.title ||
          node.state !== row.state ||
          (kind === "PullRequest" && node.merged !== row.merged)
        ) {
          if (
            !reconcile ||
            typeof node.updatedAt !== "string" ||
            !Number.isFinite(Date.parse(node.updatedAt)) ||
            typeof node.title !== "string" ||
            (kind !== "DraftIssue" &&
              !(
                kind === "PullRequest" ? ["OPEN", "CLOSED", "MERGED"] : ["OPEN", "CLOSED"]
              ).includes(String(node.state))) ||
            (kind === "PullRequest" && typeof node.merged !== "boolean")
          )
            throw new Error(
              `Issue #${row.number} changed during body hydration: ${String(row.updatedAt)} -> ${String(node.updatedAt)}`,
            );
          // Adopt the whole atomic issue observation, then verify its membership/revision below.
          row.updatedAt = node.updatedAt;
          row.title = node.title;
          if (kind !== "DraftIssue" && typeof node.state === "string") row.state = node.state;
          if (kind === "PullRequest") row.merged = node.merged;
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
  // Read the whole Project view before deciding whether the one reconciliation is needed.
  // Issue updatedAt also moves on comment edits, including edits during this read.
  let projectIdentity: string | undefined;
  const collectProject = (reconcileForeign = false) => {
    client._completeProjectContext = undefined;
    client._projectContext = undefined;
    const context = client.completeProjectContext();
    client._projectContext = context;
    if (!context.details.id) throw new Error("Missing Project identity");
    if (projectIdentity !== undefined && projectIdentity !== context.details.id)
      throw new Error("Project identity changed during inventory reconciliation");
    projectIdentity = context.details.id;
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
    const before = projectMarker();
    const items = client.itemList(client.config.project.number, {
      includeBodies: false,
      includeDependencies: !intake,
      includeFields: !intake,
      details: context.details,
      includeArchived: true,
      pageSize: 100,
    });
    if (items.length !== object(before.items).totalCount)
      throw new Error("Project inventory count mismatch with independent revision observation");
    if (intake) {
      const confirmation = client.itemList(client.config.project.number, {
        includeBodies: false,
        includeDependencies: false,
        includeFields: false,
        details: context.details,
        includeArchived: true,
        pageSize: 100,
      });
      const membership = (rows: RoadmapIssueItem[]) =>
        rows
          .map((item) => {
            const content = item.content;
            if (
              !content ||
              typeof item.id !== "string" ||
              !item.id ||
              typeof content.id !== "string" ||
              !content.id ||
              !["Issue", "PullRequest", "DraftIssue"].includes(
                String(content.type ?? content.__typename),
              ) ||
              typeof item.isArchived !== "boolean"
            )
              throw new Error("Incomplete Project membership identity/archive coverage");
            return [
              item.id,
              item.isArchived,
              content.id,
              content.type ?? content.__typename,
              content.number ?? null,
              content.url ?? null,
            ];
          })
          .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
      const final = projectMarker();
      if (
        confirmation.length !== object(final.items).totalCount ||
        object(before.items).totalCount !== object(final.items).totalCount ||
        observationHash(membership(items)) !== observationHash(membership(confirmation))
      )
        throw new GitHubApiError(
          "inventory_changed",
          "Project membership changed during intake collection",
        );
      // Field/view edits are outside this projection. Confirm every membership
      // instead of treating the Project-wide timestamp as its revision.
      items.splice(0, items.length, ...confirmation);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const item of items) {
      if (typeof item.isArchived !== "boolean") throw new Error("Unknown Project archive scope");
      const content = item.content;
      if (!content) throw new Error("Redacted Project content leaves incomplete coverage");
      const local = byId.get(content.id);
      if (local && (content.url !== local.url || content.number !== local.number))
        throw new Error(`Project/repository identity mismatch for #${local.number}`);
      if (
        local &&
        (typeof content.updatedAt !== "string" || !Number.isFinite(Date.parse(content.updatedAt)))
      )
        throw new Error(`Project/repository issue revision mismatch for #${local.number}`);
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
    // Keep foreign content within the same Project revision bracket too.
    const ids = new Set(rows.map((row) => row.id));
    if (!intake)
      hydrate(
        items.flatMap((item) => (ids.has(item.content!.id) ? [] : [item.content!])),
        reconcileForeign,
      );
    const after = projectMarker();
    if (intake && object(after.items).totalCount !== items.length)
      throw new GitHubApiError(
        "inventory_changed",
        "Project membership count changed after confirmation",
      );
    if (!intake && observationHash(after) !== observationHash(before)) {
      const revision = (value: Record<string, unknown>) => ({
        id: value.id,
        updatedAt: value.updatedAt,
        totalCount: object(value.items).totalCount,
      });
      throw new GitHubApiError(
        "inventory_changed",
        `Project changed during inventory collection: ${JSON.stringify({ before: revision(before), after: revision(after) })}`,
        { operation: "collect Roadmap Project revision" },
      );
    }
    return { items, projectId: context.details.id };
  };
  let project = collectProject(true);
  const afterProject = marker();
  const revisions = new Map(rows.map((row) => [row.id, row]));
  const projectMoved = new Set(
    project.items.flatMap((item) => {
      const local = revisions.get(item.content!.id);
      return local && !sameRevision(local, item.content!) ? [local.id] : [];
    }),
  );
  if (
    hydrationMoved ||
    projectMoved.size > 0 ||
    observationHash(afterHydration) !== observationHash(before) ||
    observationHash(afterProject) !== observationHash(before)
  ) {
    // One semantic reconciliation pass; failed requests and a second drift are never retried.
    stableMarker = afterProject;
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
      if (sameRevision(old, row) && !projectMoved.has(row.id)) row.body = old.body;
      else changed.push(row);
    }
    hydrate(changed);
    if (observationHash(marker()) !== observationHash(stableMarker))
      throw new GitHubApiError(
        "repository_changed",
        "Repository changed during the single inventory reconciliation; resume on a later run",
      );
    rows = refreshed;
    // Discard the entire first Project observation, including dependencies and fields.
    project = collectProject();
    if (observationHash(marker()) !== observationHash(stableMarker))
      throw new GitHubApiError(
        "repository_changed",
        "Repository changed during inventory collection",
      );
  }
  const { items: allItems, projectId } = project;
  const byId = new Map(rows.map((i) => [i.id, i]));
  for (const item of allItems) {
    const content = item.content;
    if (!content) throw new Error("Redacted Project content leaves incomplete coverage");
    const local = byId.get(content.id);
    if (local) {
      if (
        content.url !== local.url ||
        content.number !== local.number ||
        content.title !== local.title ||
        content.state !== local.state ||
        content.updatedAt !== local.updatedAt
      )
        throw new Error(
          `Project/repository issue revision mismatch for #${local.number}: ${String(local.updatedAt)} -> ${String(content.updatedAt)}`,
        );
      content.body = local.body;
    }
  }
  for (const row of rows) {
    row.type = "Issue";
    row.node_id = row.id;
    row.html_url = row.url;
    row.body_sha256 = observationHash(row.body);
  }
  const planningIssues = intake ? new Set(options.planningIssues) : undefined;
  for (const number of planningIssues ?? []) {
    const issue = rows.find((row) => row.number === number);
    if (!Number.isSafeInteger(number) || number < 1 || !issue)
      throw new Error("Intake planning target identity is unavailable");
    const matches = allItems.filter((item) => item.content?.id === issue.id);
    if (matches.length > 1 || matches.some((item) => item.isArchived !== false))
      throw new Error("Intake planning target has ambiguous or archived membership");
    if (!matches.length) continue; // Complete membership proves attachment absent.
    const item = matches[0]!;
    if (typeof item.id !== "string")
      throw new Error("Intake planning item identity is unavailable");
    const fresh = client.directProjectItem(item.id);
    if (
      !fresh.content ||
      !Array.isArray(fresh.fieldValues) ||
      fresh.id !== item.id ||
      fresh.content?.id !== issue.id ||
      !sameRevision(issue, fresh.content) ||
      fresh.content.body !== issue.body
    )
      throw new Error("Intake planning target changed during field hydration");
    allItems[allItems.indexOf(item)] = { ...item, ...fresh, content: item.content! };
  }
  if (intake && observationHash(marker()) !== observationHash(stableMarker))
    throw new Error("Repository changed during intake planning hydration");
  const result: RoadmapInventory = {
    ...(intake ? { scope: "intake" as const } : {}),
    format: 1,
    repository,
    repository_node_id: before.id,
    observed_at: new Date().toISOString(),
    projectId,
    issues: rows,
    items: allItems.filter((i) => i.isArchived === false),
    archivedItems: allItems.filter((i) => i.isArchived === true),
    body_reads: bodyReads,
  };
  if (result.items.length + result.archivedItems.length !== allItems.length)
    throw new Error("Unknown Project archive scope");
  validated.set(result, {
    client,
    hash: observationHash(result),
    ...(planningIssues ? { planningIssues } : {}),
  });
  return result;
}
