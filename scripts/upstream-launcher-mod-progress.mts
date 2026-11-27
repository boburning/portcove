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

type Complete = Extract<LauncherModObservation, { state: "observed" | "absent" }>;
export interface FirstPartyModProgress {
  binding: string;
  last_attempt_at: string;
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
    });
  }
  return scopes.filter(({ slug }) => bySlug.get(slug.toLowerCase())?.size === 1);
}

export function launcherModSubjects(
  sources: readonly ObservableSource[],
  identities: Readonly<Record<string, { repository_id: number | null }>>,
  scopes = launcherModScopes(sources),
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
  return scopes.flatMap(({ port_id, source_key, slug, original_game }) => {
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
        binding: observationHash([
          launcherModObservationPolicy,
          port_id,
          repository_id,
          original_game,
        ]),
      },
    ];
  });
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
        !Array.isArray(last.result.mod_portals) ||
        last.result.mod_portals.length > 2 ||
        !last.result.mod_portals.every(validLauncherModPortal) ||
        new Set(last.result.mod_portals.map((portal) => (portal as { id: string }).id)).size !==
          last.result.mod_portals.length)
    )
      throw new Error("Invalid retained first-party mod links");
  }
}
