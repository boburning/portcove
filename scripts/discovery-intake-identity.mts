import { sourceProvenancePortIdentity } from "./roadmap.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { assessUpstreamLineage } from "./upstream-lineage.mts";
import { reconcileDiscoveryIdentity } from "./discovery-reconciliation.mts";
import type {
  CanonicalDiscoveryIdentity,
  ReviewedDiscoveryIdentity,
} from "./discovery-reconciliation.mts";
import type { DiscoveryLead } from "./discovery-leads.mts";

export const discoveryGameKey = (game: string) =>
  game
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
const github = (url: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/iu.test(url);
const githubKey = (url: string) =>
  url
    .slice(19)
    .replace(/\/$/u, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
/** Additional duplicate protection only. Fresh complete issue coverage remains
 * mandatory at the caller; local lineage/cache observations cannot prove absence.
 */
export function assertDiscoveryIntakeIdentity(
  candidate: ReviewedDiscoveryIdentity,
  issues: readonly RoadmapIssueItem[],
  records: readonly AuthoredPort[],
  leads: readonly DiscoveryLead[],
) {
  const canonical: CanonicalDiscoveryIdentity[] = [];
  for (const issue of issues) {
    const body = issue.body,
      title = issue.title,
      number = Number(issue.number);
    const state = typeof issue.state === "string" ? issue.state.toUpperCase() : "";
    if (
      typeof body !== "string" ||
      typeof title !== "string" ||
      !Number.isSafeInteger(number) ||
      number <= 0 ||
      (state !== "OPEN" && state !== "CLOSED")
    )
      throw new Error("Discovery identity guard requires complete open/closed issue bodies");
    if (!title.startsWith("[Port]") && !body.includes("<!-- portcove-port -->")) continue;
    const authored = records.find((record) => record.listing.issue_number === number);
    const history = authored ? assessUpstreamLineage(authored).history : [];
    const urls = [
      ...new Set([
        ...sourceProvenancePortIdentity(issue).upstreams,
        ...history.map((row) => row.project_url),
      ]),
    ].filter(github);
    const bodyIds = [
      ...new Set(
        [...body.matchAll(/GitHub repository ID:\s*(\d+)/giu)].map((match) => Number(match[1])),
      ),
    ];
    const game =
      authored?.listing.original_game_title ??
      body.match(/^Underlying game: \*\*([^*\r\n]{1,256})\*\*/mu)?.[1];
    for (const url of urls) {
      const key = githubKey(url);
      const lineage = history.find(
        (row) => github(row.project_url) && githubKey(row.project_url) === key,
      );
      const observed = leads.filter((row) =>
        [row.repository, ...(row.aliases ?? [])].some((alias) => alias.toLowerCase() === key),
      );
      const ids = [
        ...new Set([
          ...(lineage?.repository?.host === "github.com" ? [Number(lineage.repository.id)] : []),
          ...(bodyIds.length === 1 ? bodyIds : []),
          ...observed.map((row) => row.id),
        ]),
      ].filter((id) => Number.isSafeInteger(id) && id > 0);
      // Conflicting observations constrain that identity, not unrelated work.
      for (const id of ids.length ? ids : [undefined])
        canonical.push({
          repository: url,
          issue: number,
          state,
          ...(id !== undefined ? { repository_id: id } : {}),
          ...(game ? { game_key: discoveryGameKey(game) } : {}),
        });
    }
  }
  const result = reconcileDiscoveryIdentity(candidate, canonical);
  if (result.disposition !== "New canonical intake")
    throw new Error(
      `Canonical discovery identity held: ${result.disposition}; issues ${result.issues.join(", ") || "none"}; ${result.reason}`,
    );
  return result;
}
