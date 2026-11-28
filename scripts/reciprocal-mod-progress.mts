import type { ObservableSource } from "./catalog-upstream-observer.mts";
import type { ReciprocalThunderstoreObservation as Result } from "./port-upstream-facts.mts";
import { isRecord } from "./runtime-values.mts";
import { launcherModSubjects } from "./upstream-launcher-mod-progress.mts";
import type {
  GithubCommunityDocument,
  ModProviderRegistryProgress,
} from "./upstream-mod-provider-registry.mts";
import { observationHash } from "./upstream-observer.mts";

type Proof = Extract<Result, { state: "observed" }>;

export interface ReciprocalModSubject {
  port_id: string;
  repository_id: number;
  slug: string;
  community: string;
  game_uuid: string;
  document: GithubCommunityDocument;
  binding: string;
}

export interface ReciprocalModProgress {
  binding: string;
  last_attempt_at: string;
  outcome: Result["state"];
  reason: string | null;
  next_due_at: string;
  last_success: { observed_at: string; proof: Proof } | null;
}

const sha = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const communityId = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
const markdownPath = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/iu;

export function reciprocalModSubjects(
  sources: readonly ObservableSource[],
  identities: Readonly<Record<string, { repository_id: number | null }>>,
  registry: ModProviderRegistryProgress | undefined,
) {
  if (!registry?.last_complete || registry.identity_conflicts === "unknown")
    return { subjects: [], ambiguous: 0 };
  const conflicts = new Set(registry.identity_conflicts);
  const bySlug = new Map<string, ReciprocalModSubject[]>();
  const planned = launcherModSubjects(sources, identities);
  const byRepository = new Map(planned.map((entry) => [entry.slug.toLowerCase(), entry]));
  for (const { community, game_uuid, listed, github_document: document } of registry.last_complete
    .communities) {
    if (listed !== true || !document || conflicts.has(community)) continue;
    const candidate = byRepository.get(document.repository.toLowerCase());
    if (!candidate) continue;
    const entries = bySlug.get(candidate.port_id) ?? [];
    entries.push({
      port_id: candidate.port_id,
      repository_id: candidate.repository_id,
      slug: candidate.slug,
      community,
      game_uuid,
      document,
      binding: observationHash([
        "reciprocal-thunderstore-document/1",
        candidate.port_id,
        candidate.repository_id,
        candidate.slug.toLowerCase(),
        community,
        game_uuid,
        document.path,
        document.ref,
      ]),
    });
    bySlug.set(candidate.port_id, entries);
  }
  // If several communities claim the same project, hold the association until
  // one exact implementation scope can be established.
  const candidates = [...bySlug.values()];
  return {
    subjects: candidates.flatMap((entries) => (entries.length === 1 ? entries : [])),
    ambiguous: candidates.filter((entries) => entries.length > 1).length,
  };
}

export function validateReciprocalModProgress(
  value: unknown,
  now: number,
): asserts value is Record<string, ReciprocalModProgress> {
  if (!isRecord(value) || Object.keys(value).length > 4096)
    throw new Error("Invalid reciprocal mod checkpoint");
  for (const [id, entry] of Object.entries(value)) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
      !isRecord(entry) ||
      Object.keys(entry).length !== 6 ||
      typeof entry.binding !== "string" ||
      !sha.test(entry.binding) ||
      typeof entry.last_attempt_at !== "string" ||
      typeof entry.next_due_at !== "string" ||
      !Number.isFinite(Date.parse(entry.last_attempt_at)) ||
      Date.parse(entry.last_attempt_at) > now ||
      !(Date.parse(entry.next_due_at) > Date.parse(entry.last_attempt_at)) ||
      !["observed", "held", "unavailable"].some((state) => entry.outcome === state) ||
      (entry.outcome === "observed"
        ? entry.reason !== null || !entry.last_success
        : typeof entry.reason !== "string" || !/^[a-z0-9-]{1,96}$/u.test(entry.reason)) ||
      (entry.outcome === "held" && entry.last_success !== null)
    )
      throw new Error("Invalid reciprocal mod checkpoint entry");
    if (entry.last_success !== null) {
      const success = entry.last_success;
      const proof = isRecord(success) && success.proof;
      if (
        !isRecord(success) ||
        Object.keys(success).length !== 2 ||
        typeof success.observed_at !== "string" ||
        !Number.isFinite(Date.parse(success.observed_at)) ||
        Date.parse(success.observed_at) > Date.parse(entry.last_attempt_at) ||
        (entry.outcome === "observed" && success.observed_at !== entry.last_attempt_at) ||
        !isRecord(proof) ||
        Object.keys(proof).length !== 7 ||
        proof.state !== "observed" ||
        !Number.isSafeInteger(proof.repository_id) ||
        Number(proof.repository_id) <= 0 ||
        typeof proof.commit !== "string" ||
        !commit.test(proof.commit) ||
        typeof proof.path !== "string" ||
        proof.path.length > 1024 ||
        !markdownPath.test(proof.path) ||
        typeof proof.blob !== "string" ||
        !commit.test(proof.blob) ||
        typeof proof.sha256 !== "string" ||
        !sha.test(proof.sha256) ||
        typeof proof.community !== "string" ||
        proof.community.length > 128 ||
        !communityId.test(proof.community)
      )
        throw new Error("Invalid reciprocal mod proof");
    }
  }
}

export function recordReciprocalModAttempt(
  subject: ReciprocalModSubject,
  result: Result,
  previous: ReciprocalModProgress | undefined,
  now: number,
  cadenceHours: number,
): ReciprocalModProgress {
  const at = new Date(now).toISOString();
  if (
    result.state === "observed" &&
    (result.community !== subject.community ||
      result.repository_id !== subject.repository_id ||
      (subject.document.path !== null && result.path !== subject.document.path))
  )
    throw new Error("Reciprocal mod proof does not match its subject");
  const retry = result.state === "unavailable" ? Date.parse(result.retry_after ?? "") : NaN;
  const next = now + cadenceHours * 3_600_000;
  return {
    binding: subject.binding,
    last_attempt_at: at,
    outcome: result.state,
    reason: result.state === "observed" ? null : result.reason,
    next_due_at: new Date(Number.isFinite(retry) ? Math.max(next, retry) : next).toISOString(),
    last_success:
      result.state === "observed"
        ? { observed_at: at, proof: result }
        : result.state === "unavailable" && previous?.binding === subject.binding
          ? previous.last_success
          : null,
  };
}
