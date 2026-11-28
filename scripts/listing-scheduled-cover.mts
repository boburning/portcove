import { createHash } from "node:crypto";
import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import { admittedGithubRepositoryId, type AuthoredPort } from "./catalog-authoring.mts";
import { positiveId, validArtworkMapping } from "./catalog-cover-mapping.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import { createGitHubClient } from "./github-client.mts";
import {
  ArtworkBatchExhausted,
  isConfirmedIgdbImageGone,
  prepareCatalogArtwork,
  type ArtworkRecord,
  type createIgdbInspector,
} from "./inspect-igdb-artwork.mts";
import { advanceArtworkCheckpoint } from "./listing-artwork-checkpoint.mts";
import { githubRepository } from "./listing-funding.mts";
import type { ReviewedOriginalMediaDecision } from "./reviewed-original-media.mts";
import { isRecord } from "./runtime-values.mts";
import {
  coverIdentity,
  matchesSharedCoverScope,
  sharedCoverScope,
} from "./shared-cover-projection.mts";
import { readObserverMetadata } from "./upstream-observer.mts";

type ProjectCoverIdentity = { name: string; project_url: string; github_repository_id: number };
type ProjectRepositoryReader = (projectUrl: string) => Promise<number | undefined>;
export type ScheduledCover = {
  id: string;
  artwork: IgdbArtwork;
  project?: ProjectCoverIdentity;
};
type Decisions = ReadonlyMap<string, ReviewedOriginalMediaDecision>;
type Listing = Record<string, unknown>;
type Inspector = Pick<
  ReturnType<typeof createIgdbInspector>,
  "inspectGame" | "inspectImage" | "signal"
>;
type CoverObservations = Parameters<typeof advanceArtworkCheckpoint>[1];

function scheduledCoverScope(key: string, artwork: IgdbArtwork) {
  // The key identifies either the original edition or the exact implementation.
  // A provider slug rename does not change the asset's withdrawal history.
  const subject = createHash("sha256")
    .update(JSON.stringify([key, artwork.game_id]))
    .digest("hex");
  const scope = createHash("sha256").update(subject).update(coverIdentity(artwork)).digest("hex");
  return { id: `scheduled-cover-${subject}`, scope };
}

function reviewedScope(record: AuthoredPort, reviewed: Decisions) {
  if (record.listing.artwork || record.listing.collection_covers) return undefined;
  const scope = sharedCoverScope(record);
  const decision = scope && reviewed.get(scope.key);
  if (!scope || decision?.decision !== "match") return undefined;
  return { scope, decision };
}

function projectScope(record: AuthoredPort) {
  const { name, project_url, artwork, collection_covers } = record.listing;
  if (
    artwork ||
    collection_covers ||
    record.igdb_regional_cover ||
    record.igdb_no_shared_cover ||
    usesScummvmEngine(record) ||
    !githubRepository(project_url)
  )
    return undefined;
  return { name, project_url };
}

function projectKey(id: string, repositoryId: number) {
  return JSON.stringify(["project", id, repositoryId]);
}

export function observedProjectCoverRepositoryId(artwork: unknown) {
  return isRecord(artwork) && positiveId(artwork.observed_github_repository_id)
    ? artwork.observed_github_repository_id
    : undefined;
}

export function listingGithubRepositoryId(listing: Record<string, unknown>) {
  const observation = listing.upstream_observation;
  const project =
    typeof listing.project_url === "string" ? githubRepository(listing.project_url) : undefined;
  if (
    project &&
    isRecord(observation) &&
    observation.provider === "github" &&
    typeof observation.observed_at === "string" &&
    typeof observation.repository === "string" &&
    observation.repository.toLowerCase() === `${project.owner}/${project.name}`.toLowerCase() &&
    positiveId(observation.repository_id)
  )
    return observation.repository_id;
}

/** Positives use one bounded repository lookup per slug. Redirects can't bind a stale URL. */
export function readScheduledCoverRepositories(signal: AbortSignal, token?: string) {
  let client: ReturnType<typeof createGitHubClient> | undefined;
  const reads = new Map<string, Promise<number | undefined>>();
  return (projectUrl: string) => {
    const project = githubRepository(projectUrl);
    if (!project || signal.aborted) return Promise.resolve(undefined);
    const repository = `${project.owner}/${project.name}`.toLowerCase();
    const old = reads.get(repository);
    if (old) return old;
    client ??= createGitHubClient({
      credential: token ? { kind: "explicit", token } : { kind: "anonymous" },
      deadline: performance.now() + 45_000,
      maxBytes: 64 * 1024,
      signal,
      allowRequest: (method, url) =>
        method === "GET" && /^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(url.pathname),
    });
    const read = client
      .then(async (sdk) => {
        const { status, body } = await readObserverMetadata(sdk, `/repos/${repository}`);
        return status === 200 &&
          isRecord(body) &&
          positiveId(body.id) &&
          typeof body.full_name === "string" &&
          body.full_name.toLowerCase() === repository
          ? body.id
          : undefined;
      })
      .catch(() => undefined);
    reads.set(repository, read);
    return read;
  };
}

/** Observe a reviewed original once per edition, or the exact project website. */
export async function prepareScheduledCovers(
  authored: readonly AuthoredPort[],
  selected: ReadonlySet<string>,
  reviewed: Decisions,
  inspector: Inspector,
  inspectRepository: ProjectRepositoryReader = readScheduledCoverRepositories(
    inspector.signal ?? AbortSignal.timeout(45_000),
  ),
) {
  const representatives = new Map<string, string>();
  const representativeByPort = new Map<string, string>();
  const projects = new Map<string, Omit<ProjectCoverIdentity, "github_repository_id">>();
  const inputs = authored.flatMap((record) => {
    const { listing } = record;
    if (!selected.has(listing.id)) return [];
    const match = reviewedScope(record, reviewed);
    const project = match ? undefined : projectScope(record);
    const key = match?.scope.key ?? (project && JSON.stringify(["project", listing.id]));
    if (!key) return [];
    if (project) projects.set(listing.id, { name: project.name, project_url: project.project_url });
    const representative = representatives.get(key);
    representativeByPort.set(listing.id, representative ?? listing.id);
    if (representative) return [];
    representatives.set(key, listing.id);
    return [
      {
        id: listing.id,
        name: listing.name,
        project_url: listing.project_url,
        presentation: { original_game: listing.original_game },
      },
    ];
  });
  if (!inputs.length) return { covers: [], records: [], progress: [] };
  // Keep the deadline inside the provider call so partial cover results and
  // other roles survive. Distinguish this budget from provider failures.
  async function observe<T>(read: () => Promise<T>): Promise<T> {
    try {
      inspector.signal?.throwIfAborted();
      return await read();
    } catch (error) {
      if (
        inspector.signal?.aborted &&
        (error === inspector.signal.reason ||
          (error instanceof Error && error.cause === inspector.signal.reason))
      )
        throw new ArtworkBatchExhausted();
      throw error;
    }
  }
  const prepare = (ports: typeof inputs, reviewedOriginalOnly: boolean) =>
    prepareCatalogArtwork(
      { ports },
      {
        inspectGame: (identity) => observe(() => inspector.inspectGame(identity)),
        inspectImage: (imageId, bytes) => observe(() => inspector.inspectImage(imageId, bytes)),
        reviewedOriginalMedia: reviewed,
        reviewedOriginalOnly,
      },
    );
  const originals = await prepare(
    inputs.filter(({ id }) => !projects.has(id)),
    true,
  );
  const implementations = await prepare(
    inputs.filter(({ id }) => projects.has(id)),
    false,
  );
  const records = [...originals.records, ...implementations.records];
  const covers: ScheduledCover[] = [];
  const unresolvedProjects = new Set<string>();
  for (const { port_id: id, reason, mapping } of records) {
    if (!mapping) continue;
    if (reason === "exact-original-game-cover" && !projects.has(id)) {
      covers.push({ id, artwork: mapping });
      continue;
    }
    const project = projects.get(id);
    if (reason !== "exact-port-cover" || !project) continue;
    const repositoryId = await inspectRepository(project.project_url);
    const admitted = admittedGithubRepositoryId(id);
    if (repositoryId === undefined || (admitted !== undefined && admitted !== repositoryId)) {
      unresolvedProjects.add(id);
      continue;
    }
    covers.push({
      id,
      artwork: mapping,
      project: { ...project, github_repository_id: repositoryId },
    });
  }
  const recordsByPort = new Map(records.map((record) => [record.port_id, record]));
  const progress = [...representativeByPort].flatMap(([id, representative]) => {
    const record = recordsByPort.get(representative);
    if (!record) return [];
    const progress = asCoverProgress(id, record);
    if (unresolvedProjects.has(id)) progress.reason = "media-provider-unavailable-or-incomplete";
    return [progress];
  });
  return { covers, records, progress };
}

function asCoverProgress(portId: string, record: ArtworkRecord) {
  const failure = record.exceptions[0]?.reason;
  let reason = failure ?? "no-exact-provider-observation";
  if (record.mapping) reason = "role-selected";
  else if (failure?.includes("budget")) reason = "batch-provider-budget-exhausted";
  else if (failure && /unavailable|incomplete|identity-response-invalid/u.test(failure))
    reason = "media-provider-unavailable-or-incomplete";
  else if (failure === "identity-not-unique") reason = "identity-ambiguous";
  return {
    port_id: portId,
    role: "cover" as const,
    subject: { kind: "port" as const, port_id: portId },
    reason,
  };
}

/** Revalidate newly proposed covers, record Gone and hold changed signed bytes,
 * and share only an exact maintained original-game edition. */
export async function projectScheduledCovers({
  authored,
  reviewed,
  previous,
  source,
  incoming,
  shared,
  denied,
  observedRepositoryIds = new Map<string, number>(),
  held = new Set<string>(),
  ambiguous = new Set<string>(),
  priorCheckpoint = null,
  observations = [],
  receiptStarted,
  receiptDigest,
  now,
  inspect,
  inspectRepository,
}: {
  authored: readonly AuthoredPort[];
  reviewed: Decisions;
  previous: ReadonlyMap<string, Listing>;
  source?: ReadonlyMap<string, Listing>;
  incoming?: readonly ScheduledCover[];
  shared: ReadonlyMap<string, IgdbArtwork>;
  denied: ReadonlySet<string>;
  observedRepositoryIds?: ReadonlyMap<string, number>;
  held?: ReadonlySet<string>;
  ambiguous?: ReadonlySet<string>;
  priorCheckpoint?: Parameters<typeof advanceArtworkCheckpoint>[0];
  observations?: CoverObservations;
  receiptStarted?: number;
  receiptDigest?: string;
  now: number;
  inspect?: Inspector["inspectImage"];
  inspectRepository?: ProjectRepositoryReader;
}) {
  const eligible = new Map(
    authored.flatMap((record) => {
      const original = ambiguous.has(record.listing.id)
        ? undefined
        : reviewedScope(record, reviewed);
      const project = projectScope(record);
      return original || project
        ? [[record.listing.id, { original, project, listing: record.listing }] as const]
        : [];
    }),
  );
  type Offer = { artwork: IgdbArtwork; key: string };
  const retained = new Map<string, Offer>();
  const fresh = new Map<string, Offer>();
  const projectKeys = new Map<string, string>();
  function accepted(
    id: string,
    artwork: unknown,
    producer: Listing | undefined,
    signed = false,
    evidence?: ProjectCoverIdentity,
  ) {
    const entry = eligible.get(id);
    if (
      !entry ||
      !producer ||
      producer.project_url !== entry.listing.project_url ||
      !validArtworkMapping(artwork) ||
      denied.has(artwork.image_id)
    )
      return undefined;
    if (artwork.match_kind === "port") {
      const project = entry.project;
      const repositoryId = signed
        ? observedProjectCoverRepositoryId(artwork)
        : evidence?.github_repository_id;
      const boundId = admittedGithubRepositoryId(id);
      const observedId = observedRepositoryIds.get(id);
      const priorListing = previous.get(id);
      const priorId = priorListing && listingGithubRepositoryId(priorListing);
      if (
        !project ||
        !positiveId(repositoryId) ||
        (boundId !== undefined && boundId !== repositoryId) ||
        (observedId !== undefined && observedId !== repositoryId) ||
        (priorId !== undefined && priorId !== repositoryId) ||
        producer.id !== id ||
        producer.name !== project.name ||
        (!signed &&
          (evidence?.name !== project.name || evidence?.project_url !== project.project_url))
      )
        return undefined;
      const key = projectKey(id, repositoryId);
      return { artwork: { ...artwork, observed_github_repository_id: repositoryId }, key };
    }
    const original = entry.original;
    if (
      !original ||
      evidence ||
      !matchesSharedCoverScope(producer.original_game, original.scope) ||
      artwork.game_id !== original.decision.game_id ||
      (!signed && artwork.game_slug !== original.decision.slug)
    )
      return undefined;
    return {
      artwork: { ...artwork, game_slug: original.decision.slug },
      key: original.scope.key,
    };
  }
  for (const [id, row] of previous) {
    const offer = accepted(id, row.artwork, row, true);
    if (!offer || shared.has(id)) continue;
    if (offer.artwork.match_kind === "port") projectKeys.set(id, offer.key);
    retained.set(id, offer);
  }
  for (const { id, artwork, project } of incoming ?? []) {
    const offer = accepted(id, artwork, source?.get(id), false, project);
    if (!offer || shared.has(id)) continue;
    if (project) {
      if ((await inspectRepository?.(project.project_url)) !== project.github_repository_id)
        continue;
      projectKeys.set(id, offer.key);
    }
    fresh.set(id, offer);
  }
  const reads = new Map<string, Promise<string | null>>();
  function observe(artwork: IgdbArtwork) {
    const old = reads.get(artwork.image_id);
    if (old) return old;
    const request = inspect!(artwork.image_id).then(
      ({ sha256 }) => sha256,
      (error: unknown) => (isConfirmedIgdbImageGone(error, artwork.image_id) ? "gone" : null),
    );
    reads.set(artwork.image_id, request);
    return request;
  }
  const health = [...observations];
  const changed = new Set(held);
  const verified = new Set<string>();
  const prior = advanceArtworkCheckpoint(priorCheckpoint, observations);
  if (inspect) {
    const targets = [
      ...new Map([...retained.values()].map((offer) => [coverIdentity(offer.artwork), offer])),
    ].sort(([a], [b]) => a.localeCompare(b));
    const width = 8;
    const offset =
      (Math.floor(now / 86_400_000) % Math.max(1, Math.ceil(targets.length / width))) * width;
    const projectTargets = [...retained]
      .filter(([, { artwork }]) => artwork.match_kind === "port")
      .sort(([left], [right]) => left.localeCompare(right));
    if (inspectRepository && projectTargets.length) {
      const start =
        (Math.floor(now / 86_400_000) % Math.ceil(projectTargets.length / width)) * width;
      for (const [id, { artwork }] of projectTargets.slice(start, start + width)) {
        const url = eligible.get(id)?.project?.project_url;
        if (!url) continue;
        const actual = await inspectRepository(url);
        if (actual !== undefined && actual !== observedProjectCoverRepositoryId(artwork))
          retained.delete(id);
      }
    }
    for (const [, { artwork }] of targets.slice(offset, offset + width)) {
      const value = await observe(artwork);
      if (value !== null && value !== artwork.image_sha256) changed.add(artwork.image_id);
      if (value === artwork.image_sha256) verified.add(coverIdentity(artwork));
    }
    const goneScopes = new Set<string>();
    for (const { key, artwork } of retained.values()) {
      if ((await reads.get(artwork.image_id)) !== "gone") continue;
      const scope = scheduledCoverScope(key, artwork);
      if (goneScopes.has(scope.scope)) continue;
      goneScopes.add(scope.scope);
      health.push({
        ...scope,
        artwork,
        status: "propose_fallback",
        observed_at: new Date(now).toISOString(),
        report: `sha256:${createHash("sha256")
          .update(JSON.stringify(["approved-cdn-gone", coverIdentity(artwork), now]))
          .digest("hex")}`,
      });
    }
  }
  const preservedCheckpoint = advanceArtworkCheckpoint(priorCheckpoint, health);
  function collect(scoped: Map<string, IgdbArtwork | null>, { key, artwork }: Offer) {
    const earlier = scoped.get(key);
    if (earlier === undefined) scoped.set(key, artwork);
    else if (earlier && coverIdentity(earlier) !== coverIdentity(artwork)) scoped.set(key, null);
  }
  const offers = new Map<string, IgdbArtwork | null>();
  for (const offer of retained.values()) {
    const { id } = scheduledCoverScope(offer.key, offer.artwork);
    if (!preservedCheckpoint.withdrawalsFor(id).length) collect(offers, offer);
  }
  function distribute(allowNew: boolean) {
    const proposals = new Map<string, IgdbArtwork>();
    for (const [id, { original }] of eligible) {
      const retainedOffer = retained.get(id);
      const originalMapping = original && offers.get(original.scope.key);
      const projectKey = projectKeys.get(id);
      const projectMapping = projectKey && offers.get(projectKey);
      const canUse = (mapping: IgdbArtwork | null | undefined, key: string | undefined) =>
        mapping &&
        ((retainedOffer &&
          retainedOffer.key === key &&
          coverIdentity(retainedOffer.artwork) === coverIdentity(mapping)) ||
          (allowNew && !changed.has(mapping.image_id) && verified.has(coverIdentity(mapping))));
      const mapping = canUse(originalMapping, original?.scope.key)
        ? originalMapping
        : canUse(projectMapping || undefined, projectKey)
          ? projectMapping
          : undefined;
      if (!shared.has(id) && mapping) proposals.set(id, mapping);
    }
    return proposals;
  }
  const preserved = distribute(false);
  const candidates = new Map<string, IgdbArtwork | null>();
  for (const offer of fresh.values()) collect(candidates, offer);
  const restorations = new Map<string, CoverObservations[number]>();
  for (const [key, artwork] of candidates)
    if (
      inspect &&
      artwork &&
      !offers.has(key) &&
      !changed.has(artwork.image_id) &&
      (await observe(artwork)) === artwork.image_sha256
    ) {
      const scope = scheduledCoverScope(key, artwork);
      const withdrawals = preservedCheckpoint.withdrawalsFor(scope.id);
      if (withdrawals.length) {
        const sameImage = prior.withdrawalsFor(scope.id).find((row) => row.scope === scope.scope);
        if (
          !sameImage ||
          withdrawals.length !== 1 ||
          Date.parse(sameImage.observed_at) >= now ||
          !receiptDigest ||
          receiptStarted === undefined ||
          receiptStarted <= Date.parse(sameImage.observed_at)
        )
          continue;
        restorations.set(key, {
          ...scope,
          artwork,
          status: "verified_accepted_bytes",
          observed_at: new Date(now).toISOString(),
          report: receiptDigest,
        });
      }
      verified.add(coverIdentity(artwork));
      collect(offers, { key, artwork });
    }
  const proposals = distribute(true);
  function checkpointFor(listings: readonly Listing[]) {
    if (!restorations.size) return preservedCheckpoint;
    const published = new Map<string, CoverObservations[number]>();
    for (const row of listings) {
      if (typeof row.id !== "string" || !proposals.has(row.id)) continue;
      const binding = eligible.get(row.id);
      const mapping = proposals.get(row.id);
      const key =
        mapping?.match_kind === "port" ? projectKeys.get(row.id) : binding?.original?.scope.key;
      if (!key) continue;
      const restored = restorations.get(key);
      if (
        restored &&
        validArtworkMapping(row.artwork) &&
        coverIdentity(restored.artwork) === coverIdentity(row.artwork)
      )
        published.set(key, restored);
    }
    return published.size
      ? advanceArtworkCheckpoint(priorCheckpoint, [...health, ...published.values()])
      : preservedCheckpoint;
  }
  return { preserved, proposals, preservedCheckpoint, checkpointFor };
}
