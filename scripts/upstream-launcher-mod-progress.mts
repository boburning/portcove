import { validLauncherModPortal } from "./first-party-mod-portal.mts";
import type { ObservableSource } from "./catalog-upstream-observer.mts";
import {
  githubRepository,
  launcherModObservationPolicy,
  type LauncherModObservation,
} from "./port-upstream-facts.mts";
import { admittedGithubRepositoryId } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";

type Complete = Extract<LauncherModObservation, { state: "observed" | "absent" }>;
export interface FirstPartyModProgress {
  binding: string;
  last_attempt_at: string;
  last_attempt_kind?: "first" | "renewal";
  next_due_at: string;
  outcome: LauncherModObservation["state"];
  reason?: string;
  last_complete?: { observed_at: string; result: Complete };
}

export function launcherModScopes(sources: readonly ObservableSource[]) {
  const bySlug = new Map<string, Set<string>>();
  const scopes = [];
  for (const source of sources) {
    if ((source.provider ?? "github") !== "github") continue;
    const slug = source.repository.toLowerCase();
    const ids = bySlug.get(slug) ?? new Set<string>();
    for (const port of source.ports) ids.add(port.id);
    bySlug.set(slug, ids);
    const [port] = source.ports;
    if (source.ports.length !== 1 || !port?.listing || typeof port.listing.project_url !== "string")
      continue;
    if (usesScummvmEngine({ listing: port.listing })) continue;
    try {
      if (githubRepository(port.listing.project_url)?.toLowerCase() !== slug) continue;
    } catch {
      continue;
    }
    scopes.push({
      port_id: port.id,
      source_key: source.key,
      slug: source.repository,
      original_game: port.listing.original_game ?? null,
      listed_at: typeof port.listing.listed_at === "string" ? port.listing.listed_at : "",
    });
  }
  return scopes.filter(({ slug }) => bySlug.get(slug.toLowerCase())?.size === 1);
}

export function launcherModSubjectBinding(
  portId: string,
  repositoryId: number,
  originalGame: unknown,
  sharedEditionBinding?: string,
) {
  return observationHash([
    launcherModObservationPolicy,
    portId,
    repositoryId,
    originalGame,
    ...(sharedEditionBinding ? [sharedEditionBinding] : []),
  ]);
}

export function launcherModSubjects(
  sources: readonly ObservableSource[],
  identities: Readonly<Record<string, { repository_id: number | null }>>,
  scopes = launcherModScopes(sources),
  gameScopes?: ReadonlyMap<string, { sharedEditionBinding?: string }>,
) {
  const byRepositoryId = new Map<number, Set<string>>();
  for (const source of sources) {
    if ((source.provider ?? "github") !== "github") continue;
    const id = identities[source.key]?.repository_id;
    if (!id) continue;
    const ports = byRepositoryId.get(id) ?? new Set<string>();
    for (const port of source.ports) ports.add(port.id);
    byRepositoryId.set(id, ports);
  }
  return scopes.flatMap(({ port_id, source_key, slug, original_game, listed_at }) => {
    const repository_id = identities[source_key]?.repository_id;
    const declared = admittedGithubRepositoryId(port_id);
    if (
      !repository_id ||
      byRepositoryId.get(repository_id)?.size !== 1 ||
      (declared !== undefined && declared !== repository_id)
    )
      return [];
    return [
      {
        port_id,
        source_key,
        slug,
        repository_id,
        listed_at,
        binding: launcherModSubjectBinding(
          port_id,
          repository_id,
          original_game,
          gameScopes && !gameScopes.has(port_id)
            ? "unresolved-original-game-scope"
            : gameScopes?.get(port_id)?.sharedEditionBinding,
        ),
      },
    ];
  });
}

/** Give established scopes most of each allowance and leave a bounded share for
 * missing scopes. A single-slot run goes to the lane serviced least recently. */
export function selectLauncherModWork<T>(
  reviewed: readonly T[],
  unresolved: readonly T[],
  limit: number,
  lastReviewed: string,
  lastUnresolved: string,
) {
  if (limit < 1) return [];
  if (!reviewed.length || !unresolved.length) return [...reviewed, ...unresolved].slice(0, limit);
  const reviewQuota =
    limit === 1
      ? Number(lastReviewed <= lastUnresolved)
      : Math.min(reviewed.length, limit - Math.ceil(limit / 4));
  const probing = unresolved.slice(0, limit - reviewQuota);
  const established = reviewed.slice(0, limit - probing.length);
  if (probing.length && lastUnresolved < lastReviewed)
    return [...probing.slice(0, 1), ...established, ...probing.slice(1)];
  return [...established, ...probing];
}

/** Share productive batches between establishing coverage and renewing prior facts. */
export function selectLauncherModAssessmentWork<T extends { port_id: string }>(
  reviewed: readonly T[],
  unresolved: readonly T[],
  progress: Readonly<Record<string, FirstPartyModProgress>>,
  limit: number,
  lastReviewed: string,
  lastUnresolved: string,
) {
  if (limit < 1) return [];
  let lastFirst = "";
  let lastRenewal = "";
  for (const row of Object.values(progress)) {
    if (row.last_attempt_kind === "first") {
      if (row.last_attempt_at > lastFirst) lastFirst = row.last_attempt_at;
    } else if (row.last_attempt_at > lastRenewal) {
      lastRenewal = row.last_attempt_at;
    }
  }
  const firstStarts = lastFirst <= lastRenewal;
  const reviewedFirst = reviewed.filter(({ port_id }) => !progress[port_id]);
  const unresolvedFirst = unresolved.filter(({ port_id }) => !progress[port_id]);
  const reviewedDue = reviewed.filter(({ port_id }) => progress[port_id]);
  const unresolvedDue = unresolved.filter(({ port_id }) => progress[port_id]);
  const dueCount = reviewedDue.length + unresolvedDue.length;
  const reserveDue = Math.min(
    dueCount,
    limit === 1 && firstStarts ? 0 : Math.max(1, Math.floor(limit / 3)),
  );
  const first = selectLauncherModWork(
    reviewedFirst,
    unresolvedFirst,
    limit - reserveDue,
    lastReviewed,
    lastUnresolved,
  );
  const due = selectLauncherModWork(
    reviewedDue,
    unresolvedDue,
    limit - first.length,
    lastReviewed,
    lastUnresolved,
  );
  // A deadline can cut a batch short. Start with the class served least
  // recently, then give the other class a turn before using the remaining slots.
  return firstStarts
    ? [...first.slice(0, 1), ...due.slice(0, 1), ...first.slice(1), ...due.slice(1)]
    : [...due.slice(0, 1), ...first, ...due.slice(1)];
}

export function recordLauncherModAttempt(
  binding: string,
  old: FirstPartyModProgress | undefined,
  result: LauncherModObservation,
  now: number,
  cadenceMs: number,
): FirstPartyModProgress {
  const attemptAt = new Date(now).toISOString();
  const complete = result.state === "observed" || result.state === "absent";
  const retryAt =
    result.state === "unavailable" && result.retry_after ? Date.parse(result.retry_after) : NaN;
  const retryDelay = Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
  const nextDue = now + Math.min(7 * 86400000, Math.max(cadenceMs, retryDelay));
  // An outage does not renew a known result. An authoritative scope conflict
  // suspends it until a new complete observation establishes the association.
  const retained = complete
    ? { observed_at: attemptAt, result }
    : result.state === "unavailable" && old?.binding === binding
      ? old.last_complete
      : undefined;
  return {
    binding,
    last_attempt_at: attemptAt,
    last_attempt_kind: old?.binding === binding ? "renewal" : "first",
    next_due_at: new Date(nextDue).toISOString(),
    outcome: result.state,
    ...("reason" in result ? { reason: result.reason } : {}),
    ...(retained ? { last_complete: retained } : {}),
  };
}

export function validateFirstPartyModProgress(value: unknown, now: number): void {
  const digest = (input: unknown, size: number) =>
    typeof input === "string" && input.length === size && /^[a-f0-9]+$/u.test(input);
  const date = (input: unknown) =>
    typeof input === "string" && input.length === 24 && Number.isFinite(Date.parse(input))
      ? Date.parse(input)
      : NaN;
  if (!isRecord(value) || Object.keys(value).length > 8192)
    throw new Error("Invalid first-party mod progress map");
  for (const [id, row] of Object.entries(value)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
      !isRecord(row) ||
      !digest(row.binding, 64) ||
      !["unavailable", "held", "absent", "observed"].includes(String(row.outcome)) ||
      !(date(row.last_attempt_at) <= now) ||
      (row.last_attempt_kind !== undefined &&
        row.last_attempt_kind !== "first" &&
        row.last_attempt_kind !== "renewal") ||
      !(date(row.next_due_at) >= date(row.last_attempt_at)) ||
      date(row.next_due_at) > date(row.last_attempt_at) + 7 * 86400000 ||
      (row.reason !== undefined &&
        (typeof row.reason !== "string" || !/^[a-z0-9-]{1,96}$/u.test(row.reason)))
    )
      throw new Error("Invalid first-party mod observation progress");
    const last = row.last_complete;
    if (last === undefined) {
      if (row.outcome === "observed" || row.outcome === "absent")
        throw new Error("Complete first-party mod observation is missing its result");
      continue;
    }
    if (
      row.outcome === "held" ||
      !isRecord(last) ||
      !(date(last.observed_at) <= date(row.last_attempt_at)) ||
      !isRecord(last.result) ||
      !Number.isSafeInteger(last.result.repository_id) ||
      Number(last.result.repository_id) <= 0 ||
      !digest(last.result.commit, 40) ||
      !digest(last.result.tree, 40) ||
      (row.outcome !== "unavailable" && row.outcome !== last.result.state) ||
      !["observed", "absent"].includes(String(last.result.state))
    )
      throw new Error("Invalid retained first-party mod observation");
    if (
      last.result.state === "observed" &&
      (!digest(last.result.blob, 40) ||
        !digest(last.result.manifest_sha256, 64) ||
        (last.result.game_input_ids !== undefined &&
          (!Array.isArray(last.result.game_input_ids) ||
            last.result.game_input_ids.length === 0 ||
            last.result.game_input_ids.length > 32 ||
            !last.result.game_input_ids.every(
              (id: unknown) => typeof id === "string" && /^[A-Za-z0-9_-]{1,24}$/u.test(id),
            ))) ||
        !Array.isArray(last.result.mod_portals) ||
        last.result.mod_portals.length > 2 ||
        !last.result.mod_portals.every(validLauncherModPortal) ||
        new Set(last.result.mod_portals.map((portal) => (portal as { id: string }).id)).size !==
          last.result.mod_portals.length)
    )
      throw new Error("Invalid retained first-party mod links");
  }
}
