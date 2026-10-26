import { collectRepositoryIssueInventory } from "./repository-issue-inventory.mts";
import type { InventoryReader } from "./repository-issue-inventory.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";

/** Fixtures pass through the real collector; no production proof-construction bypass. */
export function fixtureIssueInventory(
  client: InventoryReader,
  records: readonly RoadmapIssueItem[],
) {
  const graphql = client.graphql.bind(client);
  const rows = records.map((row) => ({
    ...row,
    id: row.id ?? row.node_id ?? `I_${row.number}`,
    number: Number(row.number),
    title: row.title ?? "Fixture",
    body: row.body ?? "",
    url:
      row.url ??
      row.html_url ??
      `https://github.com/${client.config.repository}/issues/${row.number}`,
    state: String(row.state ?? "OPEN").toUpperCase(),
    updatedAt: row.updatedAt ?? "2026-10-17T00:00:00Z",
  }));
  client.graphql = (query) => ({
    repository: {
      id: "R_fixture",
      nameWithOwner: client.config.repository,
      issues: {
        totalCount: rows.length,
        nodes: query.includes("RepositoryIssueMarker") ? rows.slice(-1) : rows,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
  try {
    return collectRepositoryIssueInventory(client);
  } finally {
    client.graphql = graphql;
  }
}
