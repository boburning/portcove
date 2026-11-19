/**
 * Upstream-observation source for the #4129 maintenance inventory.
 *
 * Consumes the checkpoint recovery snapshot of the newest completed schedule or
 * push `main` run of the configured upstream observer that still retains one,
 * bound by run identity, producer source, configuration digest and artifact
 * digest, and validated by the observer's own snapshot reader. Ports are mapped
 * through the observer's own catalog source mapping at the producer's source
 * commit. The observer keeps its authority: this projection grants no
 * admission, eligibility, acquisition or publication authority, and keeps only
 * stable per-source facts so routine re-observation stays quiet in
 * changes-only storage.
 */
import { createHash } from "node:crypto";
import { MaintenanceStoreError } from "./maintenance-store.mts";
import { decodeStoredObserverCheckpoint } from "./observer-checkpoint-storage.mts";
import { isRecord } from "./runtime-values.mts";
import {
  catalogObservationSources,
  validateCatalogObserverCheckpoint,
  partialProgressRules,
} from "./catalog-upstream-observer.mts";

const repository = "boburning/portcove";
const workflowPath = ".github/workflows/configured-upstream-observer.yml";
const checkpointMember = "catalog/checkpoint.json";
// Most push runs are gated and never observe, so a day can hold many candidates.
const candidateLimitPerEvent = 24;
// Bounded eight-MiB artifact decoding/validation can exceed sixty seconds on a
// contended host. This finite CPU/harness budget does not extend provider reads.
import { observerRecordBudgetMs } from "./observer-snapshot-records.mts";
const upstreamCheckpointReadBudgetMs = observerRecordBudgetMs;

/** A validated catalog checkpoint and the catalog its producer observed. */
export interface UpstreamInput {
  revision: string;
  /** Configuration digest the snapshot was produced and validated under. */
  config_sha256: string;
  checkpoint: unknown;
  catalog: unknown;
}

export interface UpstreamGap {
  subject_key: string;
  code: string;
  message: string;
  exception_key?: string | null;
  exception_rule?: string | null;
}

export interface UpstreamObservation {
  revision: string;
  config_sha256: string | null;
  failed: boolean;
  expected: number | null;
  facts: ReadonlyMap<string, unknown>;
  gaps: UpstreamGap[];
}

const failedSubject = "source:upstream-observer-checkpoint";

export interface ManagedReleaseCandidate {
  candidate_key: string;
  platform: string;
  channel: string;
  release_id: number | null;
  tag: string;
  published_at: string | null;
  state: "eligible" | "pending";
  hold_reasons: string[];
}

/** One retained Core result per offered target. A reviewed fallback is a
 * different artifact and cannot make the current candidate eligible. */
function managedReleaseCandidates(
  policy: Record<string, unknown>,
  source: {
    provider: string;
    repositoryId: number;
    portId: string;
    channels: readonly string[];
    release: unknown;
  },
): ManagedReleaseCandidate[] | undefined {
  const { provider, repositoryId, portId, channels, release } = source;
  if (
    !["github", "gitlab"].includes(provider) ||
    !channels.length ||
    !Array.isArray(policy.projections) ||
    policy.projections.length > 12
  )
    return undefined;
  const curated = isRecord(release) && isRecord(release.curated) ? release.curated : {};
  const candidates: ManagedReleaseCandidate[] = [];
  const targets = new Set<string>();
  for (const row of policy.projections) {
    if (
      !isRecord(row) ||
      typeof row.platform !== "string" ||
      !["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"].includes(row.platform) ||
      Object.hasOwn(curated, row.platform) ||
      typeof row.channel !== "string" ||
      !channels.includes(row.channel) ||
      !isRecord(row.channel_candidate)
    )
      continue;
    const candidate = row.channel_candidate;
    const { tag, published_at } = candidate;
    const releaseId =
      typeof candidate.id === "number" && Number.isSafeInteger(candidate.id) && candidate.id > 0
        ? candidate.id
        : null;
    if (
      typeof tag !== "string" ||
      !tag.length ||
      tag.length > 512 ||
      /\p{Cc}/u.test(tag) ||
      (provider === "github" && releaseId === null)
    )
      continue;
    const target = `${row.platform}/${row.channel}`;
    if (targets.has(target)) return undefined;
    targets.add(target);
    const selected = isRecord(row.latest_eligible) ? row.latest_eligible : null;
    const exact =
      selected !== null &&
      isRecord(selected.release) &&
      selected.release.version === tag &&
      (provider === "github"
        ? selected.release_id === releaseId
        : isRecord(selected.identity) && selected.identity.tag === tag);
    const holdReasons: unknown[] = Array.isArray(row.hold_reasons) ? row.hold_reasons : [];
    candidates.push({
      candidate_key: createHash("sha256")
        .update(
          JSON.stringify([
            portId,
            provider,
            repositoryId,
            releaseId ?? tag,
            row.platform,
            row.channel,
          ]),
        )
        .digest("hex"),
      platform: row.platform,
      channel: row.channel,
      release_id: releaseId,
      tag,
      published_at:
        typeof published_at === "string" && Number.isFinite(Date.parse(published_at))
          ? new Date(published_at).toISOString()
          : null,
      state: exact ? "eligible" : "pending",
      hold_reasons: holdReasons
        .filter((reason): reason is string => typeof reason === "string" && reason.length <= 512)
        .slice(0, 16)
        .sort(),
    });
  }
  return candidates.sort(
    (left, right) =>
      left.platform.localeCompare(right.platform) || left.channel.localeCompare(right.channel),
  );
}

const eligibilityWindowMs = 30 * 24 * 60 * 60 * 1000;

type RetainedCandidateObservation = Pick<
  ManagedReleaseCandidate,
  "state" | "published_at" | "hold_reasons"
>;

/** Measures retained observer eligibility. The store clock bounds when eligibility
 * was recorded; it cannot locate the instant of availability to a released client. */
export function managedReleaseEligibilityWindow(rows: readonly unknown[], now: Date) {
  const end = now.getTime();
  const start = end - eligibilityWindowMs;
  let firstRecorded = Infinity;
  let lastRecorded = -Infinity;
  const series = new Map<
    string,
    {
      latest: RetainedCandidateObservation;
      recorded: number;
      eligibleAt: number | null;
      firstPendingAt: number;
      lastEligibleAt: number;
    }
  >();
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.candidate_key !== "string" ||
      !/^[0-9a-f]{64}$/u.test(row.candidate_key) ||
      (row.state !== "pending" && row.state !== "eligible") ||
      typeof row.recorded_at !== "string" ||
      !Array.isArray(row.hold_reasons) ||
      !row.hold_reasons.every((reason) => typeof reason === "string")
    )
      continue;
    const recorded = Date.parse(row.recorded_at);
    if (!(recorded >= start && recorded <= end)) continue;
    firstRecorded = Math.min(firstRecorded, recorded);
    lastRecorded = Math.max(lastRecorded, recorded);
    const candidate: RetainedCandidateObservation = {
      state: row.state,
      published_at: typeof row.published_at === "string" ? row.published_at : null,
      hold_reasons: row.hold_reasons,
    };
    const previous = series.get(row.candidate_key);
    const eligibleTimes = [
      previous?.eligibleAt ?? null,
      row.state === "eligible" ? recorded : null,
    ].filter((value): value is number => value !== null);
    series.set(row.candidate_key, {
      latest: previous && previous.recorded > recorded ? previous.latest : candidate,
      recorded: Math.max(previous?.recorded ?? recorded, recorded),
      eligibleAt: eligibleTimes.length ? Math.min(...eligibleTimes) : null,
      firstPendingAt: Math.min(
        previous?.firstPendingAt ?? Infinity,
        row.state === "pending" ? recorded : Infinity,
      ),
      lastEligibleAt: Math.max(
        previous?.lastEligibleAt ?? -Infinity,
        row.state === "eligible" ? recorded : -Infinity,
      ),
    });
  }
  const recent = [...series.values()].filter(({ latest }) => {
    const published = latest.published_at ? Date.parse(latest.published_at) : NaN;
    return published >= start && published <= end;
  });
  const eligible = recent.filter(({ latest }) => latest.state === "eligible");
  const held = recent.filter(({ latest }) => latest.state === "pending");
  const pendingAges = held.map(({ latest }) => end - Date.parse(latest.published_at!));
  const lags = eligible
    .map(({ latest, eligibleAt }) => eligibleAt! - Date.parse(latest.published_at!))
    .filter((lag) => lag >= 0)
    .sort((left, right) => left - right);
  const reasons = new Map<string, number>();
  let pendingWithoutReason = 0;
  for (const { latest } of held) {
    const recordedReasons = new Set(latest.hold_reasons.filter((reason) => reason.trim().length));
    if (!recordedReasons.size) pendingWithoutReason++;
    for (const reason of recordedReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    from: new Date(start).toISOString(),
    through: now.toISOString(),
    first_recorded_evidence_at: Number.isFinite(firstRecorded)
      ? new Date(firstRecorded).toISOString()
      : null,
    last_recorded_evidence_at: Number.isFinite(lastRecorded)
      ? new Date(lastRecorded).toISOString()
      : null,
    distinct_candidates: recent.length,
    eligible_candidates: eligible.length,
    pending_candidates: held.length,
    pending_without_recorded_hold_reason: pendingWithoutReason,
    observed_pending_candidates: recent.filter(({ firstPendingAt }) =>
      Number.isFinite(firstPendingAt),
    ).length,
    observed_pending_to_eligible_candidates: recent.filter(
      ({ firstPendingAt, lastEligibleAt }) => firstPendingAt < lastEligibleAt,
    ).length,
    unknown_publication_times: [...series.values()].filter(
      ({ latest }) => !latest.published_at || !Number.isFinite(Date.parse(latest.published_at)),
    ).length,
    oldest_pending_age_ms: pendingAges.length ? Math.max(...pendingAges) : null,
    hold_reasons: [...reasons.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, distinct_candidates]) => ({ reason, distinct_candidates })),
    publication_to_recorded_eligibility_ms: lags.length
      ? {
          samples: lags.length,
          median:
            (lags[Math.floor((lags.length - 1) / 2)]! + lags[Math.ceil((lags.length - 1) / 2)]!) /
            2,
          max: lags.at(-1)!,
        }
      : null,
    released_client_unattended_availability: null,
    human_interventions: null,
    signed_automatic_repairs: null,
    operating_cost: null,
  };
}

/**
 * Per-port observer facts and coverage from one catalog checkpoint and the
 * catalog it observed. Each port's payload lists its observation sources with
 * stable facts only. Retain exact managed candidate identities and their
 * policy-projected result without copying the full policy or its observation clock.
 * A port is a fact only when every source serving it has a completed policy
 * for it; otherwise it is a coverage gap. The observer also lists a port as
 * held when one of its declarations is not observable while another source
 * still serves it, so `held` is a gap only for ports no source serves; a served
 * port carries its held reasons in its facts. The observer's routine
 * partial-progress stops are continuation, not stored state.
 */
export function upstreamFacts(checkpoint: unknown, catalog: unknown, now = Date.now()) {
  const state = validateCatalogObserverCheckpoint(checkpoint, now);
  const { sources, held, port_ids: portIds } = catalogObservationSources(catalog);
  const heldReasons = new Map<string, string[]>();
  for (const { port_id, reason } of held)
    heldReasons.set(port_id, [...new Set([...(heldReasons.get(port_id) ?? []), reason])].sort());
  const served = new Set(sources.flatMap((source) => source.ports.map((port) => port.id)));
  const entries = new Map<string, UpstreamSourceFact[]>();
  const gaps = new Map<string, UpstreamGap>();
  const gap = (id: string, value: Omit<UpstreamGap, "subject_key">) => {
    // One gap per port: unserved `held` first, then the first incomplete source in catalog order.
    if (!gaps.has(`port:${id}`)) gaps.set(`port:${id}`, { subject_key: `port:${id}`, ...value });
  };
  for (const [id, reasons] of heldReasons)
    if (!served.has(id))
      gap(id, {
        code: "held",
        message: `The observer does not observe this port's declared provider (${reasons.join(", ")}).`,
      });
  for (const source of sources) {
    const progress = state.sources[source.key];
    for (const port of source.ports) {
      const policy = progress?.last_complete_policies.find(
        (candidate) => candidate.port_id === port.id,
      );
      const exception = {
        exception_key: progress?.exception_key ?? null,
        exception_rule: progress?.exception_key ? (progress.exception_rule ?? null) : null,
      };
      if (!progress || (progress.completed_scope_sha256 === null && !policy)) {
        gap(port.id, {
          code:
            progress?.last_complete_facts_sha256 || progress?.last_complete_policies.length
              ? "scope-changed"
              : "unobserved",
          message:
            "The observer has not completed this port's source for its current scope; prior facts stay current.",
          ...exception,
        });
        continue;
      }
      if (progress.completed_scope_sha256 === null || !policy) {
        gap(port.id, {
          code: "scope-changed",
          message:
            "The observer's last completion does not cover this port's current source scope; prior facts stay current.",
          ...exception,
        });
        continue;
      }
      // A routine partial-progress stop keeps the completed scope; storing it would churn.
      const routine =
        typeof progress.exception_rule === "string" &&
        partialProgressRules.includes(progress.exception_rule);
      const exceptionKey = routine ? null : progress.exception_key;
      const candidates =
        port.kind !== "listing" && progress.repository_id !== null
          ? managedReleaseCandidates(policy, {
              provider: source.provider ?? "github",
              repositoryId: progress.repository_id,
              portId: port.id,
              channels: port.channels,
              release: port.release,
            })
          : undefined;
      entries.set(port.id, [
        ...(entries.get(port.id) ?? []),
        {
          source_key: source.key,
          provider: progress.provider ?? "github",
          repository: progress.repository,
          repository_id: progress.repository_id,
          last_complete_facts_sha256: progress.last_complete_facts_sha256,
          last_change_at: progress.last_change_at,
          exception_key: exceptionKey,
          // Absent in checkpoints written before #4779.
          exception_rule: exceptionKey ? (progress.exception_rule ?? null) : null,
          catalog_definition_sha256:
            typeof policy.catalog_definition_sha256 === "string"
              ? policy.catalog_definition_sha256
              : null,
          ...(candidates === undefined ? {} : { managed_release_candidates: candidates }),
        },
      ]);
    }
  }
  const facts = new Map<string, unknown>();
  for (const id of [...portIds].sort())
    if (!gaps.has(`port:${id}`) && entries.has(id))
      facts.set(`port:${id}`, {
        ...(heldReasons.has(id) ? { held_reasons: heldReasons.get(id) } : {}),
        sources: entries
          .get(id)!
          .sort((left, right) => (left.source_key < right.source_key ? -1 : 1)),
      });
  // The observer's catalog mapping partitions every port into a fact or a gap.
  if (facts.size + gaps.size !== portIds.length)
    throw new MaintenanceStoreError("Unsupported observer catalog mapping");
  return {
    expected: portIds.length,
    facts,
    gaps: [...gaps.values()].sort((left, right) => (left.subject_key < right.subject_key ? -1 : 1)),
  };
}

/**
 * Projects one read. A read or validation failure is a failed run with one gap:
 * nothing is observed, so every prior fact stays current.
 */
export async function upstreamObservation(
  read: () => Promise<UpstreamInput>,
  now = Date.now,
): Promise<UpstreamObservation> {
  try {
    const input = await read();
    return {
      revision: input.revision,
      config_sha256: input.config_sha256,
      failed: false,
      ...upstreamFacts(input.checkpoint, input.catalog, now()),
    };
  } catch (error) {
    return {
      revision: "upstream-observer:unavailable",
      config_sha256: null,
      failed: true,
      expected: null,
      facts: new Map(),
      gaps: [
        {
          subject_key: failedSubject,
          code: "unavailable",
          message:
            `The observer checkpoint could not be read and validated; prior facts stay current. ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 1000),
        },
      ],
    };
  }
}

interface WorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  path: string;
  created_at: string;
  head_repository?: { full_name?: string };
}

/**
 * The read-only GitHub transport of {@link readUpstreamObservations}: bounded
 * metadata reads below `/repos/boburning/portcove/` and one artifact archive
 * download of at most `maxBytes`.
 */
export interface UpstreamTransport {
  read: (endpoint: string) => Promise<Record<string, unknown>>;
  download: (endpoint: string, maxBytes: number) => Promise<Buffer>;
}

/** The maintained GitHub client and artifact transfer under the local developer credential. */
async function githubTransport(producerEventCount: number): Promise<UpstreamTransport> {
  const { createGitHubClient } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const { downloadGitHubArtifactArchive } = await import("./github-artifact-download.mts");
  const deadline = performance.now() + 120_000;
  const credential = localDeveloperCredential({
    deadline,
    command: process.env.PORTCOVE_ROADMAP_GH,
  });
  const prefix = `/repos/${repository}`;
  let requests = 0;
  const sdk = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 2 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      url.pathname.startsWith(`${prefix}/actions/`) &&
      !url.pathname.endsWith("/zip"),
    reserve() {
      if (++requests > producerEventCount * (1 + candidateLimitPerEvent) + 6)
        throw new MaintenanceStoreError("Upstream-observation lookup exceeded its request budget");
      return { consumeBytes() {}, settle() {} };
    },
  });
  return {
    read: async (endpoint) =>
      (await sdk.request({ method: "GET", url: `https://api.github.com${prefix}/${endpoint}` }))
        .data as Record<string, unknown>,
    download: (endpoint, maxBytes) =>
      downloadGitHubArtifactArchive(endpoint, {
        credential,
        deadline: Math.min(deadline, performance.now() + 110_000),
        maxBytes,
        bufferAllowance: "observer-checkpoint",
      }),
  };
}

/**
 * The newest completed schedule or push `main` observer run that retains its
 * unexpired checkpoint snapshot, read-only. `readCommitted` returns a file's
 * exact bytes at a commit and throws when the commit or path is unavailable.
 * The transport defaults to the maintained GitHub client and artifact transfer.
 */
export async function readUpstreamObservations(
  readCommitted: (revision: string, file: string) => Buffer,
  options: { transport?: UpstreamTransport } = {},
): Promise<UpstreamInput> {
  const { readCompleteRunArtifactInventoryAsync } =
    await import("./release-run-artifact-inventory.mts");
  const { producerEvents, observerStreamingSnapshotLimit, readRecoverableObserverSnapshotArchive } =
    await import("./observer-checkpoint-artifact.mts");
  const transport = options.transport ?? (await githubTransport(producerEvents.length));
  const get = transport.read;
  // Keep each producer window. A burst of admission-only pushes must not
  // displace a scheduled snapshot when the windows are merged newest-first.
  const runs: WorkflowRun[] = [];
  for (const event of producerEvents) {
    const window = (
      await get(
        `actions/workflows/configured-upstream-observer.yml/runs?event=${event}&branch=main&status=completed&per_page=${candidateLimitPerEvent}`,
      )
    ).workflow_runs as WorkflowRun[];
    if (!Array.isArray(window) || window.length > candidateLimitPerEvent)
      throw new MaintenanceStoreError("The observer run inventory exceeds its producer window");
    for (const run of window) {
      if (
        run.event !== event ||
        run.head_branch !== "main" ||
        run.path !== workflowPath ||
        run.head_repository?.full_name !== repository ||
        run.status !== "completed"
      )
        throw new MaintenanceStoreError("The observer run inventory names a foreign producer");
      runs.push(run);
    }
  }
  runs.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  // Snapshots are retained for one day and admitted for twenty-four hours.
  const candidates = runs.filter(
    ({ created_at }) => Date.now() - Date.parse(created_at) <= 24 * 3600000,
  );
  for (const run of candidates) {
    // A failed run can still carry a complete snapshot; other conclusions never do.
    if (!["success", "failure"].includes(String(run.conclusion))) continue;
    if (!/^[a-f0-9]{40}$/u.test(run.head_sha) || !Number.isSafeInteger(run.run_attempt))
      throw new MaintenanceStoreError("The observer run identity is invalid");
    const name = new RegExp(
      `^upstream-observer-checkpoint-([a-f0-9]{64})-${run.id}-${run.run_attempt}$`,
      "u",
    );
    const inventory = await readCompleteRunArtifactInventoryAsync(
      async (page) => await get(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`),
    );
    const matches = inventory.artifacts.filter((row) => name.test(String(row.name)));
    if (matches.length > 1)
      throw new MaintenanceStoreError("The observer run retains duplicate checkpoint snapshots");
    const artifact = matches[0] as
      | {
          id: number;
          name: string;
          expired: boolean;
          size_in_bytes: number;
          digest?: string;
          workflow_run?: { id?: number; head_sha?: string };
        }
      | undefined;
    // Gated push runs never observe, and retention is one day: pass over them.
    if (!artifact || artifact.expired) continue;
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "") ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 22 ||
      artifact.size_in_bytes > observerStreamingSnapshotLimit ||
      artifact.workflow_run?.id !== run.id ||
      artifact.workflow_run.head_sha !== run.head_sha
    )
      throw new MaintenanceStoreError("The observer checkpoint artifact is unbound");
    // The workflow names its snapshot by the digest of the configuration it checked out.
    const config = name.exec(artifact.name)![1]!;
    const committedConfig = createHash("sha256")
      .update(readCommitted(run.head_sha, "release/upstream-observer.json"))
      .digest("hex");
    if (committedConfig !== config)
      throw new MaintenanceStoreError(
        "The observer snapshot configuration differs from its producer source",
      );
    const archive = await transport.download(
      `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
      artifact.size_in_bytes,
    );
    const digest = createHash("sha256").update(archive).digest("hex");
    if (archive.length !== artifact.size_in_bytes || `sha256:${digest}` !== artifact.digest)
      throw new MaintenanceStoreError(
        "The observer checkpoint artifact does not match its recorded digest",
      );
    let snapshot;
    let checkpoint;
    const deadline = Date.now() + upstreamCheckpointReadBudgetMs;
    try {
      snapshot = await readRecoverableObserverSnapshotArchive(
        archive,
        config,
        Date.now(),
        deadline,
      );
      checkpoint = decodeStoredObserverCheckpoint(snapshot.files[checkpointMember], deadline);
    } catch (error) {
      throw new MaintenanceStoreError(
        error instanceof Error ? error.message : "Observer snapshot validation failed",
      );
    }
    if (
      snapshot.producer.run !== run.id ||
      snapshot.producer.attempt !== run.run_attempt ||
      snapshot.producer.source !== run.head_sha
    )
      throw new MaintenanceStoreError("The observer snapshot producer differs from its run");
    // The observer reads the reviewed catalog and listing directory at its own source.
    const parse = (file: string) => {
      try {
        return JSON.parse(readCommitted(snapshot.producer.source, file).toString("utf8")) as {
          listings?: unknown;
        };
      } catch (error) {
        if (error instanceof MaintenanceStoreError) throw error;
        throw new MaintenanceStoreError(`${file} at the producer source is not valid JSON`);
      }
    };
    const operational = parse("crates/portcove-core/catalog/catalog.json");
    const listings = parse("crates/portcove-core/catalog/listings.json");
    return {
      revision: `upstream-observer-run:${run.id}-${run.run_attempt}@${run.head_sha}#sha256:${digest}`,
      config_sha256: config,
      checkpoint,
      catalog: { ...operational, listings: listings.listings },
    };
  }
  throw new MaintenanceStoreError(
    `None of the ${candidates.length} newest completed schedule or push main observer runs from the last 24 hours retains an unexpired checkpoint snapshot`,
  );
}

/** One stored source fact, as the report reads it. */
export interface UpstreamSourceFact {
  source_key: string;
  provider: string;
  repository: string;
  repository_id: number | null;
  last_complete_facts_sha256: string | null;
  last_change_at: string | null;
  exception_key: string | null;
  exception_rule: string | null;
  catalog_definition_sha256: string | null;
  managed_release_candidates?: ManagedReleaseCandidate[];
}

const storedSources = (payload: unknown) =>
  (payload as { sources?: UpstreamSourceFact[] } | null)?.sources ?? [];

/**
 * Observer exceptions recorded for a port's sources, as the report shows them:
 * from its stored facts, or from the latest run's coverage gap when the
 * excepted source has not completed for the port. The observer's own
 * partial-progress stops (budget, cancellation, quota) are routine continuation
 * and stay quiet; an exception without a recorded rule stays visible.
 */
export function upstreamAttention(payload: unknown, gap?: unknown) {
  return upstreamExceptions(payload, gap).map(
    (source) =>
      `upstream observer exception: ${source.exception_rule ?? "unrecorded rule"}${"repository" in source ? ` (${source.repository})` : ""}`,
  );
}

/** The excepted sources and gap behind {@link upstreamAttention}, structured. */
export function upstreamExceptions(
  payload: unknown,
  gap?: unknown,
): (UpstreamSourceFact | UpstreamGap)[] {
  const latestGap = gap as UpstreamGap | null | undefined;
  return [
    ...storedSources(payload).filter((source) => source.exception_key !== null),
    ...(typeof latestGap?.exception_key === "string" ? [latestGap] : []),
  ].filter(
    (source) =>
      source.exception_rule === null ||
      source.exception_rule === undefined ||
      !partialProgressRules.includes(source.exception_rule),
  );
}

/**
 * One line of observer state: the stored facts, and why the latest checkpoint
 * did not cover the port. When the source's latest attempt failed, `attempt`
 * names its source-level gap and `gap` comes from the run before it.
 */
export function upstreamSummary(payload: unknown, gap: unknown, attempt?: string | null) {
  const code = (gap as UpstreamGap | null | undefined)?.code;
  return (
    [
      ...storedSources(payload).map(
        (source) =>
          `${source.repository}: facts ${(source.last_complete_facts_sha256 ?? "unknown").slice(0, 12)}, last change ${source.last_change_at ?? "not recorded"}`,
      ),
      attempt ? `latest attempt failed: ${attempt}` : "",
      code ? `${attempt ? "previous checkpoint" : "latest checkpoint"}: ${code}` : "",
    ]
      .filter(Boolean)
      .join("; ") || null
  );
}
