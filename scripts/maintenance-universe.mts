/**
 * The maintenance identity universe (#4129): every known game and
 * implementation, built only from canonical identities the store already
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

export type UniverseKind = "port" | "implementation" | "issue" | "intake" | "definition";

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
  /** Lineage target, for grouping distinct implementations of one game. */
  target_key: string | null;
  /** Candidate port keys an issue or intake request names; never a `port:` identity. */
  port_keys: string[];
  relations: UniverseRelation[];
  /** Why this entry's retained identities are unknown, when its lineage did not validate. */
  identity_gap: string | null;
}

interface AuthoredRecord extends PortIdentity {
  listing: PortIdentity["listing"] & { name?: string; original_game_title?: string };
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

  for (const record of input.records) {
    const port = entry(`port:${record.listing.id}`, "port");
    port.name = record.listing.name ?? null;
    port.game = record.listing.original_game_title ?? null;
    if (record.listing.issue_number !== undefined)
      relate(port, "canonical-work", `issue:${record.listing.issue_number}`);
    // A record whose lineage does not validate keeps its port entry with the
    // reason visible; the catalog contract owns that refusal, and the universe
    // must neither hide the port nor guess its implementation identities.
    let identities: string[] = [];
    let decisions: LineageDecision[] = [];
    try {
      const assessment = assessUpstreamLineage(record);
      decisions = assessment.decisions;
      identities = lineageIdentityKeys(record);
      // Only a validated lineage target groups entries as one game.
      if (assessment.status === "recorded")
        port.target_key = record.upstream_lineage?.target_key ?? null;
      else
        port.identity_gap =
          "No upstream lineage is recorded (legacy-unassessed); implementation identity is unknown.";
    } catch (error) {
      port.identity_gap = error instanceof Error ? error.message : String(error);
    }
    for (const identity of identities) {
      const implementation = entry(`implementation:${identity}`, "implementation");
      implementation.target_key = port.target_key;
      relate(port, "retains-implementation", implementation.key);
      relate(implementation, "implemented-by", port.key);
    }
    // Only validated, accepted decisions relate ports.
    for (const decision of decisions)
      if (decision.outcome === "accepted" && decision.related_port)
        relate(port, decision.relationship, `port:${decision.related_port.id}`);
  }

  for (const [key, payload] of input.issues ?? []) {
    const fact = payload as IssueFact;
    const catalogIds = fact.catalog_ids ?? [];
    const portKeys = fact.port_keys ?? [];
    if (!catalogIds.length && !portKeys.length) continue;
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

  for (const [key, payload] of input.intake ?? []) {
    const fact = payload as IntakeFact;
    const intake = entry(key, "intake");
    const keys = new Set<string>();
    for (const slot of fact.slots ?? []) {
      if (slot.port_key) keys.add(slot.port_key);
      // The candidate's own implementation identity, searchable; never a port identity.
      if (slot.upstream) relate(intake, "candidate-upstream", `url:${slot.upstream}`);
      if (typeof slot.repository_id === "number")
        relate(intake, "candidate-repository", `repository:github.com:${slot.repository_id}`);
      if (typeof slot.linked_issue === "number")
        relate(intake, "linked-work", `issue:${slot.linked_issue}`);
    }
    intake.port_keys = [...keys].sort();
  }

  for (const key of input.definitions ?? []) entry(key, "definition");

  return [...entries.values()]
    .map((value) => ({ ...value, relations: [...value.relations].sort(byKey) }))
    .sort(byKey);
}

/** Entries grouped by game: one group per lineage target, else per entry. */
export function universeGroups(entries: readonly UniverseEntry[]) {
  const groups = new Map<string, UniverseEntry[]>();
  for (const value of entries) {
    const group = value.target_key ? `target:${value.target_key}` : value.key;
    groups.set(group, [...(groups.get(group) ?? []), value]);
  }
  return groups;
}
