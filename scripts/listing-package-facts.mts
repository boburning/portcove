// Listing package facts: typed player facts for listing-only GitHub packages.
//
// The existing listing observer states which releases and assets an upstream
// publishes and whether that coverage is complete. It never reads bytes, so a
// filename is all it knows, and a filename never authorizes a runtime. This
// worker reads the exact bytes of the latest stable release's archives through
// Core (`portcove --json catalog inspect-listing-artifact`, which executes
// nothing) and records each archive's player candidates with header machine and
// SHA-256 as an `exact-release-structured` fact. Core's filename classifier
// (`portcove --json catalog classify-listing-names`) can only veto: an archive
// whose name says server, installer, tool, another system or architecture is
// contradictory and never enrolls. The generated registration route reads only
// these facts (`scripts/catalog-generated-registration.mts`).
//
// Bounded, resumable and never stalled:
//  - Every observed identity is evaluated each run. Unchanged releases are
//    reconfirmed from the facts already held, without reading bytes.
//  - Permanent cases are completed as ineligible with a reason and
//    re-evaluated only when the release changes: no stable release, no archive,
//    an archive without a provider digest, over the per-archive or per-release
//    limit, more bytes than one whole run may read, a permanent Core refusal,
//    repeated transient failures, invalid facts, or a changed repository id.
//  - Identities that need bytes are inspected in port_id order after a cursor,
//    at most `maxIdentities` and `maxBytes` per run. The cursor moves past every
//    identity it reaches; one that does not fit the remaining bytes is skipped
//    and queued. A bounded retry queue (oldest first, at most a quarter of the
//    identity budget) retries transient failures before the cursor pass.
//  - A non-complete observation (rate limit, not found, partial) keeps the
//    last-good complete facts for `lastGoodRetentionDays`; only a complete
//    observation that no longer fits withdraws immediately.
//  - Each identity's facts are validated alone; a bad one is completed as
//    `invalid-facts` instead of failing the run.
//  - New facts land as one bounded batch per run (`boundFactsBatch`); the rest
//    are held in the worker state and offered again next run.
//
//   node scripts/listing-package-facts.mts --check
//   node scripts/listing-package-facts.mts derive --observations REPORT.json \
//     --cli PORTCOVE [--state STATE.json] [--output TABLE.json]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  boundFactsBatch,
  checkListingFactsEntry,
  checkListingFactsTable,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  lastGoodRetentionDays,
  type ArtifactFactV2,
  type IneligibleReason,
  type ListingFactsEntry,
  type ListingFactsTable,
  type NameSuggestion,
  type PlayerFact,
  type Role,
} from "./catalog-generated-registration.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

export const defaultBudget = {
  maxIdentities: 24,
  maxBytes: 2 * 1024 ** 3,
  maxArchiveBytes: 512 * 1024 ** 2,
  maxArchivesPerRelease: 6,
  /** Consecutive transient inspection failures before an identity is completed. */
  maxInspectionFailures: 3,
} as const;
export type Budget = { -readonly [K in keyof typeof defaultBudget]: number };
export interface RetryItem {
  port_id: string;
  since: string;
  failures: number;
}
export interface WorkerState {
  format: 2;
  /** Inspection resumes after this port_id; null starts a new pass. */
  after: string | null;
  /** Transiently incomplete identities, retried oldest first. */
  retry: RetryItem[];
  /** Derived facts not yet landed because the batch was full. */
  held: ListingFactsEntry[];
}
export const initialState = (): WorkerState => ({ format: 2, after: null, retry: [], held: [] });

export interface ObservedAsset {
  id: number;
  name: string;
  url: string;
  size: number;
  sha256: string | null;
}
interface ObservedRelease {
  id: number;
  version: string;
  published_at: string | null;
  provider_prerelease: boolean;
  assets_complete: boolean;
  assets: ObservedAsset[];
}
/** A failed inspection. `permanent` failures are not retried for this release. */
export class InspectionError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}
/** Reads verified archive bytes and returns their player candidates; throws on failure. */
export type ByteInspector = (asset: ObservedAsset, readerPlatform: string) => Promise<PlayerFact[]>;
/** Core's `catalog.classify-listing-names` data. */
export interface NameClassification {
  filename_rule_version: number;
  releases: { tag: string; provider_prerelease: boolean; prerelease: boolean }[];
  assets: { name: string; role: Role; os: string; arch: string }[];
}
export type NameClassifier = (input: {
  releases: { tag: string; provider_prerelease: boolean }[];
  assets: string[];
}) => Promise<NameClassification>;

const archiveForms = [".zip", ".tar.gz", ".tgz", ".tar.xz"];
const sha = /^[a-f0-9]{64}$/u;
const day = 86_400_000;

interface Observation {
  /** The repository the observer resolved, possibly renamed. */
  observed: string;
  repositoryId: number | null;
  status: string;
  observedAt: string | null;
  releases: ObservedRelease[];
}

/** Listing-only GitHub identities the generated route could serve: id -> listed repository. */
function listingOnly(records: readonly AuthoredPort[]) {
  return new Map(
    records
      .filter((record) => record.integration === undefined)
      .flatMap((record) => {
        const identity = listingProviderIdentity(record.listing);
        return identity?.provider === "github" ? [[record.listing.id, identity.repository]] : [];
      }),
  );
}

function observations(candidates: Map<string, string>, report: unknown) {
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries)) throw new Error("Observer report needs a listings array.");
  const result = new Map<string, Observation>();
  for (const raw of entries) {
    const update: unknown =
      isRecord(raw) && isRecord(raw.listing_update) ? raw.listing_update : raw;
    if (!isRecord(update) || typeof update.id !== "string" || !candidates.has(update.id)) continue;
    const observation = update.upstream_observation;
    if (!isRecord(observation) || observation.provider !== "github") continue;
    result.set(update.id, {
      observed: typeof observation.repository === "string" ? observation.repository : "",
      repositoryId:
        Number.isSafeInteger(observation.repository_id) && Number(observation.repository_id) > 0
          ? Number(observation.repository_id)
          : null,
      status: typeof observation.status === "string" ? observation.status : "failed",
      observedAt: typeof observation.observed_at === "string" ? observation.observed_at : null,
      releases: releasesOf(observation),
    });
  }
  return result;
}

function releasesOf(observation: Record<string, unknown>): ObservedRelease[] {
  return (Array.isArray(observation.releases) ? observation.releases : []).flatMap(
    (release: unknown) =>
      isRecord(release) &&
      Number.isSafeInteger(release.id) &&
      Number(release.id) > 0 &&
      typeof release.version === "string" &&
      Array.isArray(release.assets)
        ? [
            {
              id: Number(release.id),
              version: release.version,
              published_at: typeof release.published_at === "string" ? release.published_at : null,
              provider_prerelease: release.provider_prerelease === true,
              assets_complete: release.assets_complete === true,
              assets: release.assets.flatMap((asset: unknown) =>
                isRecord(asset) &&
                Number.isSafeInteger(asset.id) &&
                Number(asset.id) > 0 &&
                typeof asset.name === "string" &&
                typeof asset.url === "string" &&
                Number.isSafeInteger(asset.size)
                  ? [
                      {
                        id: Number(asset.id),
                        name: asset.name,
                        url: asset.url,
                        size: Number(asset.size),
                        sha256:
                          typeof asset.sha256 === "string" && sha.test(asset.sha256)
                            ? asset.sha256
                            : null,
                      },
                    ]
                  : [],
              ),
            },
          ]
        : [],
  );
}

/** The latest stable release by Core's prerelease rule: newest publication, then highest id. */
function latestStable(
  releases: readonly ObservedRelease[],
  prerelease: (r: ObservedRelease) => boolean,
) {
  return releases
    .filter((release) => !prerelease(release))
    .toSorted(
      (left, right) =>
        (Date.parse(right.published_at ?? "") || 0) - (Date.parse(left.published_at ?? "") || 0) ||
        right.id - left.id,
    )[0];
}

const isArchive = (name: string) => archiveForms.some((form) => name.toLowerCase().endsWith(form));
/** Reader rules only; TAR.XZ is read by the Linux reader. */
const readerPlatform = (name: string) =>
  name.toLowerCase().endsWith(".tar.xz") ? "linux-x86-64" : "windows-x86-64";

const machineOs = (machine: string) =>
  machine.startsWith("pe-")
    ? "windows"
    : machine.startsWith("elf")
      ? "linux"
      : machine.startsWith("macho-")
        ? "macos"
        : "unknown";
function machineArch(machine: string) {
  if (machine.startsWith("macho-universal-")) return "universal";
  const arch = machine.replace(/^(?:pe|elf32|elf64|elf32be|elf64be|macho)-/u, "");
  return arch === "arm64" ? "aarch64" : ["x86-64", "x86"].includes(arch) ? arch : "unknown";
}
const agreed = (values: string[]) =>
  values.length && values.every((value) => value === values[0]) ? values[0]! : "unknown";

/** Whether a filename's architecture agrees with the players' (a universal player serves both). */
const archAgrees = (named: string, actual: string) =>
  named === "unknown" ||
  named === actual ||
  (actual === "universal" && (named === "x86-64" || named === "aarch64"));

/**
 * One archive's structural fact. Native players make the structural claim
 * `desktop-game-runtime`; Core's filename classification can only veto it: a
 * name suggesting a non-runtime role, or another operating system or
 * architecture than the players' header machines, makes it contradictory.
 */
export function artifactFact(
  asset: ObservedAsset & { sha256: string },
  players: PlayerFact[],
  suggestion: NameSuggestion,
): ArtifactFactV2 {
  const os = agreed(players.map(({ machine }) => machineOs(machine)));
  const arch = agreed(players.map(({ machine }) => machineArch(machine)));
  const contradictory =
    players.length > 0 &&
    (!["desktop-game-runtime", "unknown"].includes(suggestion.role) ||
      (suggestion.os !== "unknown" && suggestion.os !== os) ||
      !archAgrees(suggestion.arch, arch));
  return {
    asset_id: asset.id,
    name: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    role: players.length ? "desktop-game-runtime" : "unknown",
    os,
    arch,
    source: {
      kind: "exact-release-structured",
      shape_version: 2,
      archive_sha256: asset.sha256,
    },
    name_suggestion: suggestion,
    players: players.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    contradictory,
  };
}

export interface DeriveInputs {
  records: readonly AuthoredPort[];
  observerReport: unknown;
  table: unknown;
  state?: WorkerState;
  budget?: Partial<Budget>;
  inspect: ByteInspector;
  classify: NameClassifier;
  now: string;
}
export interface ReportRow {
  port_id: string;
  outcome:
    | "complete"
    | "unchanged"
    | "ineligible"
    | "retained-last-good"
    | "unknown"
    | "deferred-budget"
    | "deferred-identities"
    | "held-for-batch";
  reason?: string;
  inspected: number;
  reused: number;
}
export interface DeriveResult {
  table: ListingFactsTable;
  state: WorkerState;
  report: ReportRow[];
  /** Identities whose facts were completed as ineligible, by reason. */
  ineligible: Record<string, number>;
  bytes: number;
}

/** Display-safe placeholder for a value that failed validation. */
const safeText = (value: string, fallback: string) =>
  /^[\x20-\x7e]{1,256}$/u.test(value) && value.trim() === value ? value : fallback;

const assetsDigest = (release: ObservedRelease | undefined) =>
  digestOf(
    (release?.assets ?? [])
      .map(({ id, name, size, sha256 }) => [id, name, size, sha256])
      .toSorted((left, right) => Number(left[0]) - Number(right[0])),
  );

async function classifyInChunks(
  classify: NameClassifier,
  tags: ObservedRelease[],
  assets: string[],
) {
  const chunk = 20_000;
  const prerelease = new Map<string, boolean>();
  const named = new Map<string, NameSuggestion>();
  const key = (release: { tag: string; provider_prerelease: boolean }) =>
    `${release.provider_prerelease ? 1 : 0}:${release.tag}`;
  const uniqueTags = [
    ...new Map(
      tags.map((release) => [
        key({ tag: release.version, provider_prerelease: release.provider_prerelease }),
        { tag: release.version, provider_prerelease: release.provider_prerelease },
      ]),
    ).values(),
  ];
  for (let index = 0; index < uniqueTags.length; index += chunk) {
    const input = uniqueTags.slice(index, index + chunk);
    const result = await classify({ releases: input, assets: [] });
    if (result.releases.length !== input.length) throw new Error("Core classified other tags.");
    for (const [position, release] of result.releases.entries()) {
      if (release.tag !== input[position]!.tag) throw new Error("Core classified other tags.");
      prerelease.set(key(input[position]!), release.prerelease);
    }
  }
  const uniqueAssets = [...new Set(assets)];
  for (let index = 0; index < uniqueAssets.length; index += chunk) {
    const input = uniqueAssets.slice(index, index + chunk);
    const result = await classify({ releases: [], assets: input });
    if (result.assets.length !== input.length) throw new Error("Core classified other names.");
    for (const [position, asset] of result.assets.entries()) {
      if (asset.name !== input[position]) throw new Error("Core classified other names.");
      named.set(asset.name, {
        rule_version: result.filename_rule_version,
        role: asset.role,
        os: asset.os,
        arch: asset.arch,
      });
    }
  }
  return {
    prerelease: (release: ObservedRelease) =>
      prerelease.get(
        key({ tag: release.version, provider_prerelease: release.provider_prerelease }),
      ) ?? true,
    suggestion: (name: string) => named.get(name)!,
  };
}

export async function deriveListingFacts(inputs: DeriveInputs): Promise<DeriveResult> {
  const budget: Budget = { ...defaultBudget, ...inputs.budget };
  const previous = inputs.table ?? emptyFactsTable();
  checkListingFactsTable(previous);
  const state = inputs.state ?? initialState();
  const now = inputs.now;
  const candidates = listingOnly(inputs.records);
  // Facts bind to the repository the listing names; a re-pointed listing rebinds.
  const bound = (entry: ListingFactsEntry) =>
    candidates.get(entry.port_id)?.toLowerCase() === entry.repository.toLowerCase();
  const entries = new Map(
    previous.entries.filter(bound).map((entry) => [entry.port_id, entry] as const),
  );
  const held = new Map(
    state.held
      .filter((entry) => {
        try {
          checkListingFactsEntry(entry);
          return bound(entry);
        } catch {
          return false;
        }
      })
      .map((entry) => [entry.port_id, entry] as const),
  );
  const retry = new Map(
    state.retry.filter((item) => candidates.has(item.port_id)).map((item) => [item.port_id, item]),
  );
  const observed = observations(candidates, inputs.observerReport);
  const complete = (observation: Observation) =>
    observation.status === "complete" && observation.repositoryId !== null;

  const classified = await classifyInChunks(
    inputs.classify,
    [...observed.values()].filter(complete).flatMap((observation) => observation.releases),
    [],
  );
  const latest = new Map<string, ObservedRelease | undefined>(
    [...observed]
      .filter(([, observation]) => complete(observation))
      .map(([id, observation]) => [id, latestStable(observation.releases, classified.prerelease)]),
  );
  const names = await classifyInChunks(
    inputs.classify,
    [],
    [...latest.values()].flatMap((release) =>
      (release?.assets ?? []).filter((asset) => isArchive(asset.name)).map((asset) => asset.name),
    ),
  );

  const report: ReportRow[] = [];
  const ineligibleCounts: Record<string, number> = {};
  const row = (
    port_id: string,
    outcome: ReportRow["outcome"],
    reason?: string,
    inspected = 0,
    reused = 0,
  ) => report.push({ port_id, outcome, ...(reason ? { reason } : {}), inspected, reused });

  const observationOf = (id: string, release: ObservedRelease | undefined) => {
    const observation = observed.get(id)!;
    const observedAt =
      observation.observedAt && !Number.isNaN(Date.parse(observation.observedAt))
        ? new Date(Math.min(Date.parse(observation.observedAt), Date.parse(now))).toISOString()
        : now;
    return {
      release_id: release?.id ?? null,
      tag: release ? safeText(release.version, `release-${release.id}`) : null,
      published_at:
        release?.published_at && !Number.isNaN(Date.parse(release.published_at))
          ? safeText(release.published_at, "") || null
          : null,
      observed_at: observedAt,
      coverage: "complete" as ListingFactsEntry["observation"]["coverage"],
      assets_complete: release?.assets_complete ?? true,
      assets_sha256: assetsDigest(release),
    };
  };
  const base = (id: string, repositoryId: number) => ({
    port_id: id,
    provider: "github" as const,
    repository: candidates.get(id)!,
    repository_id: repositoryId,
    parser: FACTS_PARSER,
    parser_version: FACTS_PARSER_VERSION,
  });
  const ineligible = (
    id: string,
    repositoryId: number,
    release: ObservedRelease | undefined,
    reason: IneligibleReason,
    detail: string,
    observation = observationOf(id, release),
  ) => {
    const entry: ListingFactsEntry = {
      ...base(id, repositoryId),
      observation,
      ineligible: { reason, detail },
      attempt: null,
      artifacts: [],
    };
    checkListingFactsEntry(entry);
    entries.set(id, entry);
    held.delete(id);
    retry.delete(id);
    ineligibleCounts[reason] = (ineligibleCounts[reason] ?? 0) + 1;
    row(id, "ineligible", reason);
  };
  /** Keep last-good complete facts through a non-complete attempt, within the retention bound. */
  const notComplete = (
    id: string,
    status: "partial" | "unavailable" | "failed" | "pending-inspection",
    outcome?: ReportRow["outcome"],
  ) => {
    const prior = entries.get(id);
    if (!prior || prior.ineligible) {
      row(id, outcome ?? "unknown", status);
      return;
    }
    const attempt = prior.attempt
      ? { ...prior.attempt, status, last_at: now, failures: prior.attempt.failures + 1 }
      : { status, first_at: now, last_at: now, failures: 1 };
    if ((Date.parse(now) - Date.parse(attempt.first_at)) / day > lastGoodRetentionDays) {
      ineligible(
        id,
        prior.repository_id,
        undefined,
        "observation-unavailable",
        `Upstream stayed ${status} from ${attempt.first_at.slice(0, 10)}; last-good facts are kept for ${lastGoodRetentionDays} days.`,
        { ...prior.observation },
      );
      return;
    }
    entries.set(id, { ...prior, attempt });
    row(id, outcome ?? "retained-last-good", status);
  };
  /** Rebuild facts from known players with the current filename classification. */
  const refreshed = (artifacts: readonly ArtifactFactV2[], assets: readonly ObservedAsset[]) =>
    artifacts.map((artifact) => {
      const asset = assets.find((candidate) => candidate.id === artifact.asset_id)!;
      return artifactFact(
        { ...asset, sha256: artifact.sha256 },
        artifact.players,
        names.suggestion(asset.name),
      );
    });
  const settle = (
    id: string,
    repositoryId: number,
    release: ObservedRelease,
    artifacts: ArtifactFactV2[],
  ) => {
    const entry: ListingFactsEntry = {
      ...base(id, repositoryId),
      observation: observationOf(id, release),
      ineligible: null,
      attempt: null,
      artifacts,
    };
    try {
      checkListingFactsEntry(entry);
    } catch (error) {
      ineligible(
        id,
        repositoryId,
        release,
        "invalid-facts",
        safeText(
          `Observed facts failed validation: ${error instanceof Error ? error.message : "unknown"}`.slice(
            0,
            500,
          ),
          "Observed facts failed validation.",
        ),
      );
      return false;
    }
    entries.set(id, entry);
    held.delete(id);
    retry.delete(id);
    return true;
  };

  // Pass A: every observed identity, without reading bytes.
  type Need = {
    id: string;
    repositoryId: number;
    release: ObservedRelease;
    archives: (ObservedAsset & { sha256: string })[];
    reusable: Map<string, ArtifactFactV2>;
    cost: number;
  };
  const needs: Need[] = [];
  for (const id of [...observed.keys()].toSorted()) {
    const observation = observed.get(id)!;
    const prior = entries.get(id);
    if (!complete(observation)) {
      notComplete(
        id,
        observation.status === "unavailable"
          ? "unavailable"
          : observation.status === "failed"
            ? "failed"
            : "partial",
      );
      continue;
    }
    const repositoryId = observation.repositoryId!;
    if (prior && prior.repository_id !== repositoryId) {
      // A rename keeps the id; a different id is another repository (name
      // reuse or a re-created repository): withdraw and keep the bound id.
      if (prior.ineligible?.reason === "repository-identity-changed")
        row(id, "unchanged", "repository-identity-changed");
      else
        ineligible(
          id,
          prior.repository_id,
          undefined,
          "repository-identity-changed",
          `The listed repository now resolves to id ${repositoryId}, not the bound id ${prior.repository_id}.`,
          { ...prior.observation, observed_at: observationOf(id, undefined).observed_at },
        );
      continue;
    }
    const release = latest.get(id);
    if (!release) {
      ineligible(
        id,
        repositoryId,
        undefined,
        "no-stable-release",
        "The complete observation lists no stable release.",
      );
      continue;
    }
    if (!release.assets_complete) {
      notComplete(id, "partial");
      continue;
    }
    const fingerprint = assetsDigest(release);
    const same = [prior, held.get(id)].find(
      (entry) =>
        entry &&
        entry.observation.release_id === release.id &&
        entry.observation.assets_sha256 === fingerprint,
    );
    if (
      same?.ineligible &&
      !["observation-unavailable", "repository-identity-changed"].includes(same.ineligible.reason)
    ) {
      // Completed ineligible for this exact release: reconfirm, do not retry.
      entries.set(id, {
        ...same,
        observation: { ...same.observation, observed_at: observationOf(id, release).observed_at },
      });
      retry.delete(id);
      ineligibleCounts[same.ineligible.reason] =
        (ineligibleCounts[same.ineligible.reason] ?? 0) + 1;
      row(id, "unchanged", same.ineligible.reason);
      continue;
    }
    if (same && !same.ineligible) {
      if (settle(id, repositoryId, release, refreshed(same.artifacts, release.assets)))
        row(id, "unchanged", undefined, 0, same.artifacts.length);
      continue;
    }
    const archives = release.assets
      .filter((asset) => isArchive(asset.name))
      .toSorted((left, right) => left.id - right.id);
    if (!archives.length) {
      ineligible(
        id,
        repositoryId,
        release,
        "no-release-archive",
        "The stable release has no ZIP, TAR.GZ or TAR.XZ archive.",
      );
      continue;
    }
    if (archives.some((asset) => !asset.sha256 || asset.size < 1)) {
      ineligible(
        id,
        repositoryId,
        release,
        "unbound-archive",
        "A release archive has no provider SHA-256, so its bytes cannot be bound.",
      );
      continue;
    }
    if (archives.some((asset) => asset.size > budget.maxArchiveBytes)) {
      ineligible(
        id,
        repositoryId,
        release,
        "archive-too-large",
        `A release archive exceeds ${budget.maxArchiveBytes} bytes.`,
      );
      continue;
    }
    if (archives.length > budget.maxArchivesPerRelease) {
      ineligible(
        id,
        repositoryId,
        release,
        "too-many-archives",
        `The release has more than ${budget.maxArchivesPerRelease} archives.`,
      );
      continue;
    }
    const bound = archives as (ObservedAsset & { sha256: string })[];
    const reusable = new Map(
      [prior, held.get(id)]
        .flatMap((entry) => entry?.artifacts ?? [])
        .map((artifact) => [`${artifact.asset_id}/${artifact.sha256}`, artifact] as const),
    );
    const cost = bound
      .filter((asset) => !reusable.has(`${asset.id}/${asset.sha256}`))
      .reduce((sum, asset) => sum + asset.size, 0);
    if (cost > budget.maxBytes) {
      ineligible(
        id,
        repositoryId,
        release,
        "exceeds-run-budget",
        `Its archives need ${cost} bytes; one run reads at most ${budget.maxBytes}.`,
      );
      continue;
    }
    needs.push({ id, repositoryId, release, archives: bound, reusable, cost });
  }

  // Pass B: inspection, retry queue first, then the cursor pass.
  let bytes = 0;
  let inspectedIdentities = 0;
  const inspectOne = async (need: Need) => {
    const artifacts: ArtifactFactV2[] = [];
    let inspected = 0;
    let reused = 0;
    for (const asset of need.archives) {
      const known = need.reusable.get(`${asset.id}/${asset.sha256}`);
      if (known) {
        artifacts.push(artifactFact(asset, known.players, names.suggestion(asset.name)));
        reused++;
        continue;
      }
      try {
        inspected++;
        artifacts.push(
          artifactFact(
            asset,
            await inputs.inspect(asset, readerPlatform(asset.name)),
            names.suggestion(asset.name),
          ),
        );
      } catch (error) {
        if (error instanceof InspectionError && error.permanent) {
          ineligible(
            need.id,
            need.repositoryId,
            need.release,
            "inspection-refused",
            safeText(error.message, "Core refused the archive."),
          );
          return;
        }
        const failures = (retry.get(need.id)?.failures ?? 0) + 1;
        if (failures >= budget.maxInspectionFailures) {
          ineligible(
            need.id,
            need.repositoryId,
            need.release,
            "repeated-inspection-failure",
            `Inspection failed ${failures} runs in a row.`,
          );
          return;
        }
        retry.set(need.id, { port_id: need.id, since: retry.get(need.id)?.since ?? now, failures });
        notComplete(need.id, "failed");
        return;
      }
    }
    if (settle(need.id, need.repositoryId, need.release, artifacts))
      row(need.id, "complete", undefined, inspected, reused);
  };
  const attempted = new Set<string>();
  const retryCap = Math.max(1, Math.floor(budget.maxIdentities / 4));
  const byId = new Map(needs.map((need) => [need.id, need]));
  let retried = false;
  /** Oldest transient failures first, bounded; after the cursor's first identity. */
  const runRetries = async () => {
    if (retried) return;
    retried = true;
    let taken = 0;
    for (const item of [...retry.values()].toSorted(
      (left, right) =>
        left.since.localeCompare(right.since) || left.port_id.localeCompare(right.port_id),
    )) {
      if (taken >= retryCap || inspectedIdentities >= budget.maxIdentities) break;
      const need = byId.get(item.port_id);
      if (!need || attempted.has(need.id) || bytes + need.cost > budget.maxBytes) continue;
      taken++;
      attempted.add(need.id);
      inspectedIdentities++;
      bytes += need.cost;
      await inspectOne(need);
    }
  };
  let after = state.after;
  let finished = true;
  const budgetStopped = new Set<string>();
  for (const need of needs.filter((candidate) => after === null || candidate.id > after)) {
    if (attempted.has(need.id)) continue;
    if (inspectedIdentities >= budget.maxIdentities) {
      finished = false;
      break;
    }
    if (bytes + need.cost > budget.maxBytes) {
      // Every queued identity fits one whole run (larger ones are completed
      // as exceeds-run-budget), so the pass resumes here next run.
      budgetStopped.add(need.id);
      finished = false;
      break;
    }
    after = need.id;
    attempted.add(need.id);
    inspectedIdentities++;
    bytes += need.cost;
    await inspectOne(need);
    await runRetries();
  }
  await runRetries();
  for (const need of needs)
    if (!attempted.has(need.id))
      notComplete(
        need.id,
        "pending-inspection",
        budgetStopped.has(need.id) ? "deferred-budget" : "deferred-identities",
      );

  // One bounded batch lands; the rest is held for the next run.
  const sorted = [...entries.values()]
    .filter((entry) => candidates.has(entry.port_id))
    .toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  const next: ListingFactsTable = {
    format: previous.format,
    generator: previous.generator,
    generated_at: now,
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
  checkListingFactsTable(next);
  const batch = boundFactsBatch(inputs.records, previous, next);
  for (const entry of batch.deferred) {
    const existing = report.find((item) => item.port_id === entry.port_id);
    if (existing) existing.outcome = "held-for-batch";
  }
  return {
    table: batch.table,
    state: {
      format: 2,
      after: finished ? null : after,
      retry: [...retry.values()]
        .filter((item) => !entries.get(item.port_id)?.ineligible)
        .toSorted((left, right) => left.port_id.localeCompare(right.port_id)),
      held: batch.deferred,
    },
    report,
    ineligible: ineligibleCounts,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// I/O shell: bounded download, Core inspection, then delete the bytes.

const timeoutMs = 10 * 60_000;

export interface CoreRun {
  stdout: string;
  /** The process ran to an exit code (not killed or failed to start). */
  exited: boolean;
}
/**
 * Run the Portcove CLI with its temporary directory inside `scratch`, which
 * the caller deletes, so a killed run (timeout) cannot leak Core's workspace.
 */
export async function runCore(
  cli: string,
  args: string[],
  scratch: string,
  timeout = timeoutMs,
): Promise<CoreRun> {
  const temporary = path.join(scratch, "core-tmp");
  await mkdir(temporary, { recursive: true });
  return await new Promise((resolve) => {
    execFile(
      cli,
      args,
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      },
      (error, stdout) => {
        const failure = error as
          | (Error & { killed?: boolean; signal?: string | null; code?: unknown })
          | null;
        resolve({
          stdout: String(stdout ?? ""),
          exited:
            !failure || (!failure.killed && !failure.signal && typeof failure.code === "number"),
        });
      },
    );
  });
}

function coreData(run: CoreRun, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new InspectionError(`Core gave no ${what} result.`, false);
  }
  if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data)) return parsed.data;
  // Core ran and refused these bytes: the same bytes are refused again.
  throw new InspectionError(`Core refused the archive during ${what}.`, run.exited);
}

export function cliInspector(cli: string, workDirectory: string): ByteInspector {
  return async (asset, platform) => {
    if (!asset.sha256 || !/^https:\/\/github\.com\//u.test(asset.url))
      throw new InspectionError("Only digest-bound GitHub release assets are inspected.", true);
    const directory = await mkdtemp(path.join(workDirectory, "asset-"));
    try {
      const file = path.join(
        directory,
        `archive${archiveForms.find((form) => asset.name.toLowerCase().endsWith(form)) ?? ""}`,
      );
      let response: Response;
      try {
        response = await fetch(asset.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new InspectionError("Download failed.", false);
      }
      if (!response.ok || !response.body)
        throw new InspectionError(`Download failed: ${response.status}.`, false);
      const hash = createHash("sha256");
      let received = 0;
      const body = Readable.fromWeb(response.body as never);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > asset.size) body.destroy(new Error("Archive exceeds its declared size."));
        hash.update(chunk);
      });
      try {
        await pipeline(body, createWriteStream(file, { flags: "wx" }));
      } catch {
        if (received > asset.size)
          throw new InspectionError("Archive bytes exceed the provider's size.", true);
        throw new InspectionError("Download was interrupted.", false);
      }
      if (received !== asset.size || hash.digest("hex") !== asset.sha256)
        throw new InspectionError("Archive bytes differ from the provider's size or digest.", true);
      const data = coreData(
        await runCore(
          cli,
          [
            "--json",
            "catalog",
            "inspect-listing-artifact",
            file,
            "--platform",
            platform,
            "--size",
            String(asset.size),
            "--sha256",
            asset.sha256,
          ],
          directory,
        ),
        "inspection",
      );
      if (data.sha256 !== asset.sha256 || !Array.isArray(data.player_candidates))
        throw new InspectionError("Core returned no inspection for these bytes.", false);
      return data.player_candidates.flatMap((player: unknown) =>
        isRecord(player) &&
        typeof player.path === "string" &&
        typeof player.display_path === "string" &&
        typeof player.machine === "string" &&
        typeof player.sha256 === "string"
          ? [
              {
                path: player.path,
                display_path: player.display_path,
                machine: player.machine,
                sha256: player.sha256,
              },
            ]
          : [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export function cliClassifier(cli: string, workDirectory: string): NameClassifier {
  return async (input) => {
    const directory = await mkdtemp(path.join(workDirectory, "names-"));
    try {
      const file = path.join(directory, "names.json");
      await writeFile(file, JSON.stringify(input), { flag: "wx" });
      const data = coreData(
        await runCore(cli, ["--json", "catalog", "classify-listing-names", file], directory),
        "name classification",
      );
      return data as unknown as NameClassification;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = path.join(root, "crates/portcove-core/catalog");
export const factsTablePath = path.join(catalogRoot, "listing-package-facts.generated.json");
const usage =
  "Usage: node scripts/listing-package-facts.mts --check | derive --observations REPORT --cli PORTCOVE [--state FILE] [--output FILE]";

function parseState(text: string): WorkerState {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.format !== 2 ||
    !(value.after === null || typeof value.after === "string") ||
    !Array.isArray(value.retry) ||
    !Array.isArray(value.held)
  )
    return initialState();
  return value as unknown as WorkerState;
}

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--check") {
    checkListingFactsTable(parseCatalogSource(await readFile(factsTablePath, "utf8")));
    return "Listing package facts are well formed.\n";
  }
  if (argv[0] !== "derive") throw new Error(usage);
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage);
    options[name.slice(2)] = value;
  }
  if (!options.observations || !options.cli) throw new Error(usage);
  const output = options.output ?? factsTablePath;
  const { records } = readCatalogSource(catalogRoot);
  const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-"));
  try {
    const cli = path.resolve(options.cli);
    const result = await deriveListingFacts({
      records,
      observerReport: JSON.parse(await readFile(options.observations, "utf8")),
      table: parseCatalogSource(await readFile(factsTablePath, "utf8")),
      ...(options.state
        ? {
            state: await readFile(options.state, "utf8")
              .then(parseState)
              .catch(() => initialState()),
          }
        : {}),
      inspect: cliInspector(cli, work),
      classify: cliClassifier(cli, work),
      now: new Date().toISOString(),
    });
    await writeFile(output, `${JSON.stringify(result.table, null, 2)}\n`);
    if (options.state) await writeFile(options.state, `${JSON.stringify(result.state)}\n`);
    return `${JSON.stringify({ after: result.state.after, retry: result.state.retry.length, held: result.state.held.length, bytes: result.bytes, ineligible: result.ineligible, identities: result.report })}\n`;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (text) => process.stdout.write(text),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
