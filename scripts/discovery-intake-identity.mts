import {
  sourceProvenancePortIdentity,
  portRepositoryIds,
  portGameKey as discoveryGameKey,
} from "./roadmap-issue.mts";
import type { RoadmapIssueItem } from "./roadmap-issue.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { assessUpstreamLineage } from "./upstream-lineage.mts";
import { reconcileDiscoveryIdentity } from "./discovery-reconciliation.mts";
import type {
  CanonicalDiscoveryIdentity,
  ReviewedDiscoveryIdentity,
} from "./discovery-reconciliation.mts";
import type { DiscoveryLead } from "./discovery-leads.mts";

export { discoveryGameKey };
const github = (url: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/iu.test(url);
const githubKey = (url: string) =>
  url
    .slice(19)
    .replace(/\/$/u, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
const repositoryKey = (value: string) =>
  github(value) ? githubKey(value) : value.replace(/\.git\/?$|\/$/iu, "").toLowerCase();
export function reviewedDiscoveryFamilyAliases(body: string) {
  const lines = body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Reviewed source-family alias: "));
  if (lines.length > 16) throw new Error("Reviewed family alias capacity exceeded");
  return lines.map((line) => {
    const match = line.match(
      /^Reviewed source-family alias: (https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) \(GitHub repository ID: ([1-9]\d*)\)$/u,
    );
    const id = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(id))
      throw new Error("Invalid reviewed source-family alias");
    return { repository: match[1]!, repository_id: id };
  });
}
type IntakeIdentity = ReviewedDiscoveryIdentity & { catalog_id?: string };

/** Additional duplicate protection only. Fresh complete issue coverage remains
 * mandatory at the caller; local lineage/cache observations cannot prove absence.
 */
export function reconcileDiscoveryIntakeIdentity(
  candidate: IntakeIdentity,
  issues: readonly RoadmapIssueItem[],
  records: readonly AuthoredPort[],
  leads: readonly DiscoveryLead[],
) {
  const canonical: CanonicalDiscoveryIdentity[] = [];
  const issueStates = new Map<number, "OPEN" | "CLOSED">();
  const issueGameKeys = new Map<number, string[]>();
  const authoredByIssue = new Map<number, AuthoredPort[]>();
  for (const record of records) {
    const number = record.listing.issue_number;
    if (number === undefined) continue;
    const owned = authoredByIssue.get(number) ?? [];
    owned.push(record);
    authoredByIssue.set(number, owned);
  }
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
    issueStates.set(number, state);
    const authored = authoredByIssue.get(number)?.[0];
    const history = authored ? assessUpstreamLineage(authored).history : [];
    const urls = [
      ...new Set([
        ...sourceProvenancePortIdentity(issue).upstreams,
        ...history.map((row) => row.project_url),
      ]),
    ].filter(github);
    // Explicit reviewed family aliases are ownership evidence only. They do not
    // replace the primary upstream or admit executable trust/relocation history.
    const aliases = reviewedDiscoveryFamilyAliases(body);
    const bodyIds = portRepositoryIds(body);
    // Canonical display cleanup must not erase a retained source/edition title
    // that already identifies this issue's exact implementation ownership.
    const gameKeys = [
      ...new Set(
        [
          authored?.listing.original_game_title,
          body.match(/^Underlying game: \*\*([^*\r\n]{1,256})\*\*/mu)?.[1],
        ].flatMap((title) => (title ? [discoveryGameKey(title)] : [])),
      ),
    ];
    issueGameKeys.set(number, gameKeys);
    for (const alias of aliases)
      for (const gameKey of gameKeys.length ? gameKeys : [undefined])
        canonical.push({
          ...alias,
          issue: number,
          state,
          ...(gameKey ? { game_key: gameKey } : {}),
        });
    for (const url of urls) {
      const key = githubKey(url);
      const lineage = history.find(
        (row) => github(row.project_url) && githubKey(row.project_url) === key,
      );
      const ids = [
        ...new Set([
          ...(lineage?.repository?.host === "github.com" ? [Number(lineage.repository.id)] : []),
          ...(bodyIds.length === 1 ? bodyIds : []),
        ]),
      ].filter((id) => Number.isSafeInteger(id) && id > 0);
      // A retained observation may flag a reused legacy path. Only an accepted
      // source binding can identify the owner after the repository moves.
      const pathConflicts =
        ids.length === 0 &&
        candidate.repository_id !== undefined &&
        repositoryKey(candidate.repository) === key
          ? leads
              .filter(
                (row) =>
                  row.id !== candidate.repository_id &&
                  [row.repository, ...(row.aliases ?? [])].some(
                    (alias) => repositoryKey(alias) === key,
                  ),
              )
              .map((row) => row.id)
          : [];
      const bindings = [...new Set([...ids, ...pathConflicts])];
      for (const id of bindings.length ? bindings : [undefined])
        for (const gameKey of gameKeys.length ? gameKeys : [undefined])
          canonical.push({
            repository: url,
            issue: number,
            state,
            ...(id !== undefined ? { repository_id: id } : {}),
            ...(gameKey ? { game_key: gameKey } : {}),
          });
    }
  }
  for (const record of records) {
    const { id, issue_number, original_game_title } = record.listing;
    const { current, history } = assessUpstreamLineage(record);
    const issueState = issue_number === undefined ? undefined : issueStates.get(issue_number);
    const gameKeys = original_game_title
      ? [discoveryGameKey(original_game_title)]
      : issue_number !== undefined && authoredByIssue.get(issue_number)?.length === 1
        ? (issueGameKeys.get(issue_number) ?? [])
        : [];
    for (const upstream of history.length ? history : [current]) {
      if (!github(upstream.project_url)) continue;
      const repositoryId = Number(upstream.repository?.id);
      for (const gameKey of gameKeys.length ? gameKeys : [undefined])
        canonical.push({
          catalog_id: id,
          repository: upstream.project_url,
          ...(issue_number !== undefined && issueState
            ? { issue: issue_number, state: issueState }
            : {}),
          ...(upstream.repository?.host === "github.com" &&
          Number.isSafeInteger(repositoryId) &&
          repositoryId > 0
            ? { repository_id: repositoryId }
            : {}),
          ...(gameKey ? { game_key: gameKey } : {}),
        });
    }
  }
  const reconciled = reconcileDiscoveryIdentity(candidate, canonical);
  const matchedCatalogs = "catalog_ids" in reconciled ? reconciled.catalog_ids : undefined;
  const keyOwner = records.find((record) => record.listing.id === candidate.catalog_id);
  const keyMatchesIssue =
    keyOwner?.listing.issue_number !== undefined &&
    !matchedCatalogs?.length &&
    reconciled.disposition === "Existing canonical owner" &&
    reconciled.issues.length === 1 &&
    reconciled.issues[0] === keyOwner.listing.issue_number;
  const result =
    keyOwner && !matchedCatalogs?.includes(keyOwner.listing.id)
      ? {
          ...reconciled,
          catalog_ids: [...(matchedCatalogs ?? []), keyOwner.listing.id].sort(),
          ...(!keyMatchesIssue
            ? {
                disposition: "Identity conflict",
                reason: `Catalog key ${keyOwner.listing.id} already has an accepted owner`,
              }
            : {}),
        }
      : reconciled;
  const matchingCatalogs = "catalog_ids" in result ? result.catalog_ids : undefined;
  const matchingOwners = canonical.filter(
    (row) =>
      (row.issue !== undefined && result.issues.includes(row.issue)) ||
      (row.catalog_id !== undefined && matchingCatalogs?.includes(row.catalog_id)),
  );
  // Candidate context only: source-family ownership and original-game grouping
  // remain separate reviewed decisions. Matching words never assign a game ID.
  const groupingCandidates = records
    .filter(
      (record) =>
        candidate.game_key &&
        discoveryGameKey(record.listing.original_game_title ?? record.listing.name) ===
          candidate.game_key,
    )
    .map((record) => ({
      port_id: record.listing.id,
      original_game_id: record.listing.original_game?.id ?? null,
      review: record.original_game_review ?? null,
    }));
  return {
    ...result,
    grouping_review: {
      scope:
        "Review candidates only; canonical intake ownership and source compatibility are unchanged.",
      candidates: groupingCandidates,
    },
    game_scope_known:
      matchingOwners.length > 0 && matchingOwners.every((row) => row.game_key !== undefined),
    repository_identity_known:
      candidate.repository_id !== undefined &&
      matchingOwners.some((row) => row.repository_id === candidate.repository_id),
  };
}
export function assertDiscoveryIntakeIdentity(
  candidate: IntakeIdentity,
  issues: readonly RoadmapIssueItem[],
  records: readonly AuthoredPort[],
  leads: readonly DiscoveryLead[],
) {
  const result = reconcileDiscoveryIntakeIdentity(candidate, issues, records, leads);
  if (result.disposition !== "New canonical intake")
    throw new Error(
      `Canonical discovery identity held: ${result.disposition}; issues ${result.issues.join(", ") || "none"}; catalog ${result.catalog_ids?.join(", ") || "none"}; ${result.reason}`,
    );
  return result;
}
