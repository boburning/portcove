/**
 * The maintenance identity universe (#4129): known games, implementations and
 * upstream repositories, built only from canonical identities the store already
 * holds — authored catalog records, issue markers, hosted-intake requests and
 * definition delivery. Relationships (canonical work, implementation
 * identities, lineage forks and alternatives, intake links) are edges between
 * entries, never merges. Titles and names label entries; they never join them.
 */
import {
  assessUpstreamLineage,
  lineageIdentityKeys,
  type LineageDecision,
  type PortIdentity,
} from "./upstream-lineage.mts";

export type UniverseKind =
  | "port"
  | "implementation"
  | "upstream"
  | "issue"
  | "intake"
  | "definition";

export interface UniverseRelation {
  /** Canonical work, retained implementation identity, lineage relationship or intake link. */
  type: string;
  key: string;
}

export interface UniverseEntry {
  key: string;
  kind: UniverseKind;
  /** Display labels only; never identity evidence. */
  name: string | null;
  game: string | null;
  /** Retained lineage scope; never a fallback original-game identity. */
  target_key: string | null;
  /** Reviewed descriptive game identity, independent of implementation lineage. */
  original_game_id: string | null;
  /** Missing or contradictory descriptive grouping facts; no runtime admission consequence. */
  grouping_gap: string | null;
  grouping_disposition: string | null;
  grouping_reason: string | null;
  /** Candidate port keys an issue or intake request names; never a `port:` identity. */
  port_keys: string[];
  relations: UniverseRelation[];
  /** Why this entry's retained identities are unknown, when its lineage did not validate. */
  identity_gap: string | null;
}

interface AuthoredRecord extends PortIdentity {
  original_game_review?: { disposition: string; reason: string };
  listing: PortIdentity["listing"] & {
    name?: string;
    original_game_title?: string;
    original_game?: { id: string };
  };
}

interface IssueFact {
  number: number;
  title?: string;
  state?: string;
  catalog_ids?: string[];
  port_keys?: string[];
}

interface IntakeFact {
  request_comment?: number;
  slots?: {
    port_key?: string | null;
    repository_id?: number | null;
    upstream?: string | null;
    linked_issue?: number | null;
  }[];
}

const byKey = (left: { key: string }, right: { key: string }) =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

/**
 * Builds the universe from already-verified facts. Only identities the
 * canonical owners assign appear as entries; an issue or intake request that
 * names a port key without a catalog record stays its own entry, searchable,
 * without inventing a catalog identity.
 */
export function buildUniverse(input: {
  records: readonly AuthoredRecord[];
  issues?: ReadonlyMap<string, unknown>;
  intake?: ReadonlyMap<string, unknown>;
  /** `definition:<namespace>/<stable_id>` subjects observed on main. */
  definitions?: readonly string[];
  /**
   * Whether `records` is the complete authored catalog. A sample cannot say an
   * issue's catalog ID is uncataloged, only that its catalog coverage is unknown.
   */
  catalogComplete?: boolean;
}): UniverseEntry[] {
  const entries = new Map<string, UniverseEntry>();
  const entry = (key: string, kind: UniverseKind): UniverseEntry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: UniverseEntry = {
      key,
      kind,
      name: null,
      game: null,
      target_key: null,
      original_game_id: null,
      grouping_gap: null,
      grouping_disposition: null,
      grouping_reason: null,
      port_keys: [],
      relations: [],
      identity_gap: null,
    };
    entries.set(key, created);
    return created;
  };
  const relate = (from: UniverseEntry, type: string, key: string) => {
    if (!from.relations.some((relation) => relation.type === type && relation.key === key))
      from.relations.push({ type, key });
  };
  const ports = new Set(input.records.map(({ listing }) => listing.id));
  const issueReferences = new Set<string>();
  const upstreamRepository = (host: string, id: string) =>
    entry(`upstream:repository:${host}:${id}`, "upstream");

  for (const record of input.records) {
    const port = entry(`port:${record.listing.id}`, "port");
    port.name = record.listing.name ?? null;
    port.game = record.listing.original_game_title ?? null;
    port.original_game_id = record.listing.original_game?.id ?? null;
    port.grouping_disposition =
      record.original_game_review?.disposition ??
      (port.original_game_id ? "single-game" : "legacy-unreviewed");
    port.grouping_reason = record.original_game_review?.reason ?? null;
    if (!port.original_game_id && !record.original_game_review)
      port.grouping_gap =
        "No reviewed original-game identity; this entry remains a separate project.";
    if (record.listing.issue_number !== undefined) {
      const issue = `issue:${record.listing.issue_number}`;
      issueReferences.add(issue);
      relate(port, "canonical-work", issue);
    }
    // A record whose lineage does not validate keeps its port entry with the
    // reason visible; the catalog contract owns that refusal, and the universe
    // must neither hide the port nor guess its implementation identities.
    let identities: string[] = [];
    let decisions: LineageDecision[] = [];
    try {
      const assessment = assessUpstreamLineage(record);
      decisions = assessment.decisions;
      identities = lineageIdentityKeys(record);
      // A validated target groups maintenance implementation scope only.
      if (assessment.status === "recorded") {
        port.target_key = record.upstream_lineage?.target_key ?? null;
        const { repository, project_url: url } = assessment.current;
        if (repository) {
          const upstream = upstreamRepository(repository.host, repository.id);
          if (upstream.name === null || url < upstream.name) upstream.name = url;
          relate(port, "current-upstream", upstream.key);
          relate(upstream, "serves-listing", port.key);
        }
      } else
        port.identity_gap =
          "No upstream lineage is recorded (legacy-unassessed); implementation identity is unknown.";
    } catch (error) {
      port.identity_gap = error instanceof Error ? error.message : String(error);
    }
    for (const identity of identities) {
      const implementation = entry(`implementation:${identity}`, "implementation");
      implementation.target_key = port.target_key;
      implementation.original_game_id = port.original_game_id;
      implementation.grouping_disposition = port.grouping_disposition;
      implementation.grouping_reason = port.grouping_reason;
      relate(port, "retains-implementation", implementation.key);
      relate(implementation, "implemented-by", port.key);
    }
    // Only validated, accepted decisions relate ports.
    for (const decision of decisions)
      if (decision.outcome === "accepted" && decision.related_port)
        relate(port, decision.relationship, `port:${decision.related_port.id}`);
  }

  for (const [key, payload] of input.intake ?? []) {
    const fact = payload as IntakeFact;
    const intake = entry(key, "intake");
    const keys = new Set<string>();
    for (const slot of fact.slots ?? []) {
      if (slot.port_key) keys.add(slot.port_key);
      // The candidate's own implementation identity, searchable; never a port identity.
      if (slot.upstream) relate(intake, "candidate-upstream", `url:${slot.upstream}`);
      if (Number.isSafeInteger(slot.repository_id) && Number(slot.repository_id) > 0) {
        relate(intake, "candidate-repository", `repository:github.com:${slot.repository_id}`);
        const upstream = upstreamRepository("github.com", String(slot.repository_id));
        relate(intake, "candidate-origin", upstream.key);
        relate(upstream, "observed-in-intake", intake.key);
      }
      if (typeof slot.linked_issue === "number") {
        const issue = `issue:${slot.linked_issue}`;
        issueReferences.add(issue);
        relate(intake, "linked-work", issue);
      }
    }
    intake.port_keys = [...keys].sort();
  }

  for (const [key, payload] of input.issues ?? []) {
    const fact = payload as IssueFact;
    const catalogIds = fact.catalog_ids ?? [];
    const portKeys = fact.port_keys ?? [];
    if (!catalogIds.length && !portKeys.length && !issueReferences.has(key)) continue;
    const issue = entry(key, "issue");
    issue.name = fact.title ?? null;
    issue.port_keys = [...portKeys].sort();
    for (const id of catalogIds)
      relate(
        issue,
        ports.has(id)
          ? "tracks-port"
          : input.catalogComplete
            ? "names-uncataloged-port"
            : "names-port-catalog-coverage-unknown",
        `port:${id}`,
      );
  }

  for (const key of input.definitions ?? []) entry(key, "definition");

  for (const group of universeGroups([...entries.values()]).values()) {
    const members = group.filter(({ kind }) => kind === "port");
    const ids = new Set(
      members.flatMap(({ original_game_id }) => (original_game_id ? [original_game_id] : [])),
    );
    if (ids.size > 1)
      for (const member of members)
        member.grouping_gap =
          "One lineage target names multiple original-game IDs; review the target and game scopes.";
    else if (
      ids.size &&
      members.some(
        ({ original_game_id, grouping_disposition }) =>
          !original_game_id && grouping_disposition === "legacy-unreviewed",
      )
    )
      for (const member of members)
        member.grouping_gap =
          "Partial original-game mapping within this lineage target; review unmapped members.";
  }

  return [...entries.values()]
    .map((value) => ({ ...value, relations: [...value.relations].sort(byKey) }))
    .sort(byKey);
}

/** Retained maintenance scopes: one group per lineage target, else per entry. */
export function universeGroups(entries: readonly UniverseEntry[]) {
  const groups = new Map<string, UniverseEntry[]>();
  for (const value of entries) {
    const group = value.target_key ? `target:${value.target_key}` : value.key;
    groups.set(group, [...(groups.get(group) ?? []), value]);
  }
  return groups;
}
