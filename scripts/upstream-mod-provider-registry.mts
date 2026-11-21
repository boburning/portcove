import { createHash } from "node:crypto";
import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

// The JSON data publication from the provider's ecosystem-schema repository.
export const thunderstoreRegistryUrl =
  "https://thunderstore.io/api/experimental/schema/ecosystem-json-data/latest/";
export const thunderstoreRegistrySubject = "source:thunderstore-ecosystem";
const schema = "0.3.0";
const maximumCommunities = 4096;
const communityId = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const failureStates = [
  "unavailable",
  "rate-limit",
  "unrecognized-schema",
  "identity-changed",
] as const;
type FailureState = (typeof failureStates)[number];

interface Community {
  community: string;
  game_uuid: string;
  listed: boolean | null;
  gamebanana_game: number | null;
}

interface RegistryFacts {
  format: 1;
  source: typeof thunderstoreRegistryUrl;
  schema: typeof schema;
  response_sha256: string;
  communities_sha256: string;
  communities: Community[];
}

export interface ModProviderRegistryProgress {
  last_complete: (RegistryFacts & { observed_at: string; expires_at: string }) | null;
  next_due_at: string;
  exception: FailureState | null;
}

function exactGameBananaId(link: unknown) {
  if (typeof link !== "string") return null;
  const match = /^https:\/\/gamebanana\.com\/games\/([1-9]\d*)\/?$/u.exec(link);
  const id = match ? Number(match[1]) : null;
  return Number.isSafeInteger(id) ? id : null;
}

function projectCommunities(input: unknown): Community[] {
  if (
    !isRecord(input) ||
    input.schemaVersion !== schema ||
    !isRecord(input.games) ||
    !isRecord(input.communities)
  )
    throw new Error("Unsupported Thunderstore ecosystem schema");
  const games = input.games;
  const communities = input.communities;
  const ids = Object.keys(communities).sort();
  if (!ids.length || ids.length > maximumCommunities)
    throw new Error("Incomplete or oversized Thunderstore community registry");
  const referenced = new Set<string>();
  for (const [id, game] of Object.entries(games)) {
    if (isRecord(game) && game.thunderstore !== undefined) referenced.add(id);
  }
  if (referenced.size !== ids.length)
    throw new Error("Thunderstore community membership disagrees with the games index");
  const identities = new Set<string>();
  return ids.map((id) => {
    const entry = communities[id];
    const game = Object.hasOwn(games, id) ? games[id] : null;
    if (
      !communityId.test(id) ||
      id.length > 128 ||
      !isRecord(entry) ||
      !isRecord(game) ||
      game.label !== id ||
      typeof game.uuid !== "string" ||
      !uuid.test(game.uuid) ||
      identities.has(game.uuid) ||
      !isRecord(game.thunderstore) ||
      observationHash(entry) !== observationHash(game.thunderstore) ||
      (entry.listed !== undefined && typeof entry.listed !== "boolean")
    )
      throw new Error("Invalid or ambiguous Thunderstore community evidence");
    identities.add(game.uuid);
    return {
      community: id,
      game_uuid: game.uuid,
      listed: entry.listed ?? null,
      gamebanana_game: exactGameBananaId(entry.wikiUrl),
    };
  });
}

export function validateModProviderRegistryProgress(value: unknown, now: number) {
  if (
    !isRecord(value) ||
    typeof value.next_due_at !== "string" ||
    !Number.isFinite(Date.parse(value.next_due_at)) ||
    !(value.exception === null || failureStates.some((status) => status === value.exception)) ||
    (value.exception === null && value.last_complete === null)
  )
    throw new Error("Invalid mod provider registry checkpoint");
  if (value.last_complete === null) return;
  const complete = value.last_complete;
  if (
    !isRecord(complete) ||
    complete.format !== 1 ||
    complete.source !== thunderstoreRegistryUrl ||
    complete.schema !== schema ||
    typeof complete.response_sha256 !== "string" ||
    !sha256.test(complete.response_sha256) ||
    typeof complete.observed_at !== "string" ||
    !Number.isFinite(Date.parse(complete.observed_at)) ||
    Date.parse(complete.observed_at) > now ||
    typeof complete.expires_at !== "string" ||
    !(Date.parse(complete.expires_at) > Date.parse(complete.observed_at)) ||
    Date.parse(complete.observed_at) > Date.parse(value.next_due_at) ||
    !Array.isArray(complete.communities) ||
    complete.communities.length === 0 ||
    complete.communities.length > maximumCommunities ||
    complete.communities_sha256 !== observationHash(complete.communities)
  )
    throw new Error("Invalid retained mod provider registry");
  const identities = new Set<string>();
  let previous = "";
  for (const entry of complete.communities) {
    if (
      !isRecord(entry) ||
      typeof entry.community !== "string" ||
      !communityId.test(entry.community) ||
      entry.community.length > 128 ||
      entry.community <= previous ||
      typeof entry.game_uuid !== "string" ||
      !uuid.test(entry.game_uuid) ||
      identities.has(entry.game_uuid) ||
      !(entry.listed === null || typeof entry.listed === "boolean") ||
      !(
        entry.gamebanana_game === null ||
        (Number.isSafeInteger(entry.gamebanana_game) && Number(entry.gamebanana_game) > 0)
      )
    )
      throw new Error("Invalid retained mod provider community");
    previous = entry.community;
    identities.add(entry.game_uuid);
  }
}

export async function observeModProviderRegistry(
  prior: ModProviderRegistryProgress | undefined,
  options: {
    now: () => number;
    timeout: number;
    cadenceMs: number;
    staleAfterMs: number;
    responseBytes: number;
    signal?: AbortSignal;
    fetch: typeof fetch;
  },
) {
  const response = await boundedDiscoveryRequest(
    {
      url: thunderstoreRegistryUrl,
      method: "GET",
      cap: options.responseBytes,
      timeout: options.timeout,
      maxRequests: 1,
      binary: true,
    },
    async (url, init) =>
      options.fetch(url, {
        ...init,
        signal: options.signal ? AbortSignal.any([options.signal, init!.signal!]) : init!.signal!,
      }),
  );
  const now = options.now();
  const next = new Date(now + options.cadenceMs).toISOString();
  const failure = (
    exception: FailureState,
    retry_at = next,
  ): { bytes: number; progress: ModProviderRegistryProgress } => ({
    bytes: response.bytes,
    progress: {
      last_complete: prior?.last_complete ?? null,
      next_due_at: retry_at,
      exception,
    },
  });
  const retry = response.headers["retry-after"];
  if (response.status === 429 || (response.status === 503 && retry)) {
    const at = retry && /^\d+$/u.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? "");
    return failure(
      "rate-limit",
      Number.isFinite(at) && at > now && at <= 8.64e15 ? new Date(at).toISOString() : next,
    );
  }
  if (
    "error" in response ||
    response.status !== 200 ||
    response.headers["content-range"] !== undefined
  )
    return failure("unavailable");
  const bytes = Buffer.from(response.text, "base64");
  let communities;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    communities = projectCommunities(JSON.parse(text));
  } catch {
    return failure("unrecognized-schema");
  }
  // Permanent IDs make an omitted community or a changed UUID evidence of an
  // incomplete or novel registry. Retain the previous snapshot during review.
  const byId = new Map(communities.map((entry) => [entry.community, entry.game_uuid]));
  if (
    prior?.last_complete?.communities.some((entry) => byId.get(entry.community) !== entry.game_uuid)
  )
    return failure("identity-changed");
  return {
    bytes: response.bytes,
    progress: {
      last_complete: {
        format: 1,
        source: thunderstoreRegistryUrl,
        schema,
        observed_at: new Date(now).toISOString(),
        expires_at: new Date(now + options.staleAfterMs).toISOString(),
        response_sha256: createHash("sha256").update(bytes).digest("hex"),
        communities_sha256: observationHash(communities),
        communities,
      },
      next_due_at: next,
      exception: null,
    } satisfies ModProviderRegistryProgress,
  };
}
