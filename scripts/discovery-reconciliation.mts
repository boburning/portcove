import { discoveryCheckpointBytes } from "./discovery-checkpoint.mts";
/** Read-only reconciliation of reviewed source identities. No title similarity,
 * source popularity, issue state or release channel grants implementation identity.
 * Callers bind these inputs to their dated upstream and canonical snapshots.
 */
export interface DiscoveryIdentity {
  repository: string;
  repository_id?: number;
  game_key?: string;
}
export interface CanonicalDiscoveryIdentity extends DiscoveryIdentity {
  issue: number;
  aliases?: string[];
  state: "OPEN" | "CLOSED";
}
export interface ReviewedDiscoveryIdentity extends DiscoveryIdentity {
  kind: "implementation" | "helper" | "framework";
  helper_for?: DiscoveryIdentity;
}
function repository(value: string) {
  const key = value
    .replace(/^https:\/\/github\.com\//iu, "")
    .replace(/\.git\/?$/iu, "")
    .replace(/\/$/u, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(key))
    throw new Error("Reconciliation requires an exact GitHub repository");
  return key.toLowerCase();
}
function identity(value: DiscoveryIdentity) {
  repository(value.repository);
  if (
    value.repository_id !== undefined &&
    (!Number.isSafeInteger(value.repository_id) || value.repository_id <= 0)
  )
    throw new Error("Invalid immutable repository identity");
  if (value.game_key !== undefined && (!value.game_key.trim() || value.game_key.length > 256))
    throw new Error("Invalid independently catalogable game identity");
}
function canonicalIndex(canonical: readonly CanonicalDiscoveryIdentity[]) {
  if (Buffer.byteLength(JSON.stringify(canonical)) > discoveryCheckpointBytes)
    throw new Error("Canonical reconciliation byte envelope exceeded");
  for (const row of canonical) {
    identity(row);
    if (
      !Number.isSafeInteger(row.issue) ||
      row.issue <= 0 ||
      !["OPEN", "CLOSED"].includes(row.state) ||
      (row.aliases?.length ?? 0) > 64
    )
      throw new Error("Invalid canonical discovery record");
    row.aliases?.forEach(repository);
  }

  const paths = new Map<string, number[]>(),
    ids = new Map<number, number[]>();
  const append = <K,>(map: Map<K, number[]>, key: K, index: number) => {
    const rows = map.get(key) ?? [];
    rows.push(index);
    map.set(key, rows);
  };
  canonical.forEach((row, index) => {
    for (const path of [row.repository, ...(row.aliases ?? [])])
      append(paths, repository(path), index);
    if (row.repository_id !== undefined) append(ids, row.repository_id, index);
  });
  return { rows: canonical, paths, ids };
}
export function reconcileDiscoveryIdentity(
  candidate: ReviewedDiscoveryIdentity,
  canonical: readonly CanonicalDiscoveryIdentity[],
) {
  return reconcileIndexed(candidate, canonicalIndex(canonical));
}
function reconcileIndexed(
  candidate: ReviewedDiscoveryIdentity,
  index: ReturnType<typeof canonicalIndex>,
) {
  if (!["implementation", "helper", "framework"].includes(candidate.kind))
    throw new Error("Explicit primary-reviewed architecture disposition is required");
  identity(candidate);
  if (candidate.kind === "framework")
    return {
      disposition: "Shared infrastructure",
      issues: [] as number[],
      reason: "Framework is not an independently catalogable game",
    };
  if (candidate.kind === "helper" && !candidate.helper_for)
    return {
      disposition: "Alias/helper",
      issues: [] as number[],
      reason: "Helper requires an evidenced implementation relationship; no port intake",
    };
  const target = candidate.kind === "helper" ? candidate.helper_for! : candidate;
  identity(target);
  const key = repository(target.repository);
  const matching = [
    ...new Set([
      ...(index.paths.get(key) ?? []),
      ...(target.repository_id === undefined ? [] : (index.ids.get(target.repository_id) ?? [])),
    ]),
  ]
    .sort((a, b) => a - b)
    .map((position) => index.rows[position]!);
  if (
    matching.some(
      (row) =>
        target.repository_id !== undefined &&
        row.repository_id !== undefined &&
        target.repository_id !== row.repository_id,
    )
  )
    return {
      disposition: "Identity conflict",
      issues: matching.map((row) => row.issue),
      reason: "A known path now resolves to a different immutable repository; review continuity",
    };
  const selected =
    target.game_key === undefined
      ? matching
      : matching.filter((row) => row.game_key === target.game_key || row.game_key === undefined);
  const issues = [...new Set(selected.map((row) => row.issue))].sort((a, b) => a - b);
  if (issues.length > 1)
    return {
      disposition: "Identity ambiguous",
      issues,
      reason: "Resolve the game/edition within this shared implementation before intake",
    };
  if (issues.length === 1)
    return {
      disposition: candidate.kind === "helper" ? "Alias/helper" : "Existing canonical owner",
      issues,
      reason:
        "Exact reviewed repository identity and game scope; closed/deferred ownership is retained",
    };
  return {
    disposition: candidate.kind === "helper" ? "Alias/helper" : "New canonical intake",
    issues,
    reason:
      candidate.kind === "helper"
        ? "No independent port identity is granted to a helper"
        : "No matching game plus implementation in the supplied complete canonical snapshot",
  };
}

/** Frozen audit replay. It suggests no mutations and requires no provider access.
 * Stable candidate keys preserve multi-game implementations; duplicate source
 * observations are retained together rather than becoming duplicate intakes.
 */
export function reconcileDiscoverySnapshot(
  candidates: readonly (ReviewedDiscoveryIdentity & { key: string; evidence: string })[],
  canonical: readonly CanonicalDiscoveryIdentity[],
) {
  if (Buffer.byteLength(JSON.stringify({ candidates, canonical })) > discoveryCheckpointBytes)
    throw new Error("Discovery reconciliation byte envelope exceeded");
  const index = canonicalIndex(canonical);
  const unique = new Map<string, { identity: ReviewedDiscoveryIdentity; evidence: Set<string> }>();
  for (const candidate of candidates) {
    if (
      !candidate.key ||
      candidate.key.length > 256 ||
      !candidate.evidence ||
      candidate.evidence.length > 4096
    )
      throw new Error("Frozen candidate requires a bounded target key and evidence reference");
    const { key, evidence, ...value } = candidate;
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous.identity) !== JSON.stringify(value))
      throw new Error("Frozen target key has conflicting reviewed identities");
    const row = previous ?? { identity: value, evidence: new Set<string>() };
    row.evidence.add(evidence);
    unique.set(key, row);
  }
  const report = [...unique]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => ({
      key,
      ...reconcileIndexed(row.identity, index),
      evidence: [...row.evidence].sort(),
    }));
  if (Buffer.byteLength(JSON.stringify(report)) > discoveryCheckpointBytes)
    throw new Error("Discovery reconciliation output byte envelope exceeded");
  return report;
}
