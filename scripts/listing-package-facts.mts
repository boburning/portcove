// Listing package facts: typed player facts for listing-only GitHub packages.
//
// The existing listing observer states which releases and assets an upstream
// publishes and whether that coverage is complete. It never reads bytes, so a
// filename is all it knows, and a filename never authorizes a runtime. This
// worker reads the exact bytes of the latest stable release's archives through
// Core (`portcove --json catalog inspect-listing-artifact`, which executes
// nothing) and records each archive's player candidates with platform-true
// header machine and SHA-256 as an `exact-release-structured` fact. Core's
// filename classifier (`portcove --json catalog classify-listing-names`) can
// only veto: an archive whose name says server, installer, tool, a non-desktop
// system, or a system or architecture none of its players has is
// contradictory and never enrolls. The generated registration route reads only
// these facts (`scripts/catalog-generated-registration.mts`).
//
// Bounded, resumable and never stalled:
//  - Every observed identity is evaluated each run. Unchanged releases are
//    reconfirmed from the facts already held, without reading bytes.
//  - Permanent cases are completed as ineligible with a reason and
//    re-evaluated only when the release changes: no stable release, no
//    package, only unsupported desktop forms (recorded), only non-desktop
//    forms, an archive without a provider digest, over the per-archive or
//    per-release limit, more bytes than one whole run may read, a permanent
//    Core refusal, repeated transient failures, invalid facts (including a
//    malformed or unclassifiable newer release), or a changed repository id.
//  - Every entry records the package forms of its release it does not read
//    (`unread_forms`), also beside a supported archive.
//  - Each identity is evaluated alone: a name Core cannot classify, a
//    malformed observation or any unexpected failure settles that identity as
//    `invalid-facts` and never fails the run.
//  - Identities that need bytes share `maxIdentities` and `maxBytes` per run:
//    the cursor pass's next new identity first, then offered identities whose
//    release changed (all but a reserved share), new identities' retries, the
//    rest of the cursor pass, and offered identities with what is left.
//  - A non-complete upstream observation (rate limit, not found, partial)
//    keeps the last-good complete facts for `lastGoodRetentionDays`; the
//    worker's own backlog (`pending-inspection`) is not an upstream attempt
//    and only the facts age bounds it. A complete observation that no longer
//    fits withdraws immediately.
//  - New facts land as one bounded batch per run (`boundFactsBatch`); the rest
//    are held in the worker state and offered again next run. Held entries
//    count in the backlog as `held_for_batch`, and a run that settles nothing
//    while work waits reports `no_progress: true`.
//
//   node scripts/listing-package-facts.mts --check
//   node scripts/listing-package-facts.mts derive --observations REPORT.json \
//     --cli PORTCOVE [--state STATE.json] [--output TABLE.json] [--cadence-hours N] \
//     [--workflow-run-id ID --source-commit SHA --inputs-sha256 SHA] [--report FILE]
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
  archiveForms,
  boundFactsBatch,
  compareCodePoints,
  checkFactsProvenance,
  checkListingFactsEntry,
  checkListingFactsTable,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  fitDecision,
  deltaBounds,
  lastGoodRetentionDays,
  machineSystem,
  nameContradicts,
  nonDesktopForms,
  packageFormOf,
  roles,
  unreadForms,
  type ArtifactFactV2,
  type ExcludedPlayer,
  type FactsProvenance,
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
export interface ObservedRelease {
  id: number;
  version: string;
  published_at: string | null;
  provider_prerelease: boolean;
  assets_complete: boolean;
  assets: ObservedAsset[];
  /** Asset records in this release the worker cannot read; never dropped silently. */
  malformed_assets: number;
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
  assets: {
    name: string;
    role: Role;
    os: string;
    arch: string;
    tool_token: string | null;
    system_token: string | null;
  }[];
  programs: { name: string; tool_token: string | null }[];
}
export type NameClassifier = (input: {
  releases: { tag: string; provider_prerelease: boolean }[];
  assets: string[];
  programs: string[];
}) => Promise<NameClassification>;

const sha = /^[a-f0-9]{64}$/u;
const day = 86_400_000;

interface Observation {
  /** The repository the observer resolved, possibly renamed. */
  observed: string;
  repositoryId: number | null;
  status: string;
  observedAt: string | null;
  releases: ObservedRelease[];
  /** Release records the observer reported in a shape the worker cannot read. */
  malformedReleases: number;
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
      malformedReleases:
        (Array.isArray(observation.releases) ? observation.releases.length : 0) -
        releasesOf(observation).length,
    });
  }
  return result;
}

/** An asset record the worker can read: positive id, name, URL and size. */
function readableAsset(asset: unknown) {
  return (
    isRecord(asset) &&
    Number.isSafeInteger(asset.id) &&
    Number(asset.id) > 0 &&
    typeof asset.name === "string" &&
    typeof asset.url === "string" &&
    Number.isSafeInteger(asset.size)
  );
}

/**
 * Why the release list cannot be ordered or read, if it cannot: the newest
 * release (highest id) has no parseable publication time, so the latest
 * stable release is unknown; or the release that would be offered, or a newer
 * one, holds an asset record the worker cannot read.
 */
export function unreadableReleases(
  releases: readonly ObservedRelease[],
  chosen: ObservedRelease | undefined,
): string | undefined {
  const newest = releases.toSorted((left, right) => right.id - left.id)[0];
  if (newest && Number.isNaN(Date.parse(newest.published_at ?? "")))
    return `The newest release (id ${newest.id}) has no parseable publication time, so the latest stable release is unknown.`;
  const relevant = releases.filter(
    (release) =>
      release === chosen ||
      (chosen !== undefined &&
        (Date.parse(release.published_at ?? "") || 0) >=
          (Date.parse(chosen.published_at ?? "") || 0)),
  );
  const malformed = (chosen ? relevant : releases).reduce(
    (sum, release) => sum + release.malformed_assets,
    0,
  );
  if (malformed > 0)
    return `The observation holds ${malformed} release asset record(s) the worker cannot read, so the release's packages are unknown.`;
  return undefined;
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
              malformed_assets: release.assets.filter((asset: unknown) => !readableAsset(asset))
                .length,
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

/**
 * The latest stable release by Core's prerelease rule: newest publication,
 * then highest id. A newer release whose tag Core did not classify is never
 * skipped as a prerelease: it is returned as `unclassified`, so the identity
 * records invalid facts instead of silently falling back to an older release.
 */
function latestStable(
  releases: readonly ObservedRelease[],
  verdict: (r: ObservedRelease) => boolean | undefined,
): { release?: ObservedRelease; unclassified?: ObservedRelease } {
  const ordered = releases.toSorted(
    (left, right) =>
      (Date.parse(right.published_at ?? "") || 0) - (Date.parse(left.published_at ?? "") || 0) ||
      right.id - left.id,
  );
  for (const release of ordered) {
    const prerelease = verdict(release);
    if (prerelease === undefined) return { unclassified: release };
    if (!prerelease) return { release };
  }
  return {};
}

export const isArchive = (name: string) =>
  (archiveForms as readonly string[]).includes(packageFormOf(name) ?? "");
/** Sorted, unique package forms of these assets that the worker does not read. */
const unreadFormsOf = (release: ObservedRelease | undefined) =>
  [
    ...new Set(
      (release?.assets ?? []).flatMap((asset) => {
        const form = packageFormOf(asset.name);
        return form && !(archiveForms as readonly string[]).includes(form) ? [form] : [];
      }),
    ),
  ].toSorted(compareCodePoints);
/** Reader rules only; TAR.XZ is read by the Linux reader. */
export const readerPlatform = (name: string) =>
  name.toLowerCase().endsWith(".tar.xz") ? "linux-x86-64" : "windows-x86-64";

const agreed = (values: string[]) =>
  values.length && values.every((value) => value === values[0]) ? values[0]! : "unknown";

/**
 * One archive's structural fact. Native players make the structural claim
 * `desktop-game-runtime`; Core's filename classification can only veto it: a
 * name suggesting a non-runtime role, a tool or non-desktop system, or a
 * system or architecture that none of the players' platform-true header
 * machines has, makes it contradictory (`nameContradicts`). `os` and `arch`
 * summarize the kept players; the fit reads each player's own machine.
 */
export function artifactFact(
  asset: ObservedAsset & { sha256: string },
  candidates: readonly PlayerFact[],
  suggestion: NameSuggestion,
  programToken: (name: string) => string | null,
): ArtifactFactV2 {
  // Core's listing-only tool veto excludes a player, never the whole archive;
  // a tool token in the archive's own name vetoes the archive below.
  const players: PlayerFact[] = [];
  const excluded: ExcludedPlayer[] = [];
  for (const candidate of candidates) {
    const player = {
      path: candidate.path,
      display_path: candidate.display_path,
      machine: candidate.machine,
      sha256: candidate.sha256,
    };
    const token = programToken(basenameOf(candidate.display_path));
    if (token === null) players.push(player);
    else excluded.push({ ...player, token });
  }
  const systems = players.map(({ machine }) => machineSystem(machine));
  const os = agreed(systems.map((system) => system.os));
  const arch = agreed(systems.map((system) => system.arch));
  const contradictory = nameContradicts(suggestion, players);
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
    players: players.toSorted((left, right) => compareCodePoints(left.path, right.path)),
    excluded_players: excluded.toSorted((left, right) => compareCodePoints(left.path, right.path)),
    contradictory,
  };
}

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Every program an artifact fact recorded, kept or excluded, as Core reported it. */
const candidatesOf = (artifact: ArtifactFactV2): PlayerFact[] =>
  [...artifact.players, ...artifact.excluded_players].map(
    ({ path, display_path, machine, sha256 }) => ({ path, display_path, machine, sha256 }),
  );

export interface DeriveInputs {
  records: readonly AuthoredPort[];
  observerReport: unknown;
  table: unknown;
  state?: WorkerState;
  budget?: Partial<Budget>;
  inspect: ByteInspector;
  classify: NameClassifier;
  now: string;
  /** Recorded in the table by an unattended run; absent for local runs. */
  provenance?: FactsProvenance;
  /** The schedule's cadence, for the backlog drain estimate. */
  cadenceHours?: number;
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
  /** The worker's own inspection backlog; never counted as an upstream attempt. */
  backlog: ReturnType<typeof backlogOf>;
  /** Identities this run settled into the landed table: complete, or newly ineligible. */
  settled: number;
  /**
   * True when work waits (pending inspection or held for the batch bound) but
   * this run settled no identity into the landed table: the run made no
   * progress and a person should look at why.
   */
  no_progress: boolean;
}

/** Display-safe placeholder for a value that failed validation. */
export const safeText = (value: string, fallback: string) =>
  /^[\x20-\x7e]{1,256}$/u.test(value) && value.trim() === value ? value : fallback;

export const assetsDigest = (release: ObservedRelease | undefined) =>
  digestOf(
    (release?.assets ?? [])
      .map(({ id, name, size, sha256 }) => [id, name, size, sha256])
      .toSorted((left, right) => Number(left[0]) - Number(right[0])),
  );

/** Core refuses a classification request holding a longer name. */
export const maximumNameBytes = 1024;
/** Names one classification request carries, by count and by serialized size. */
const chunkNames = 10_000;
const chunkBytes = 4 * 1024 * 1024;
/** A name Core can classify: well-formed Unicode within Core's byte bound. */
export const sendableName = (name: string) =>
  name.isWellFormed() && Buffer.byteLength(name) <= maximumNameBytes;

type TagInput = { tag: string; provider_prerelease: boolean };
const tagKey = (release: TagInput) => `${release.provider_prerelease ? 1 : 0}:${release.tag}`;
const probe = {
  releases: [{ tag: "v1.0", provider_prerelease: false }],
  assets: ["Game-v1.0-windows-x64.zip"],
  programs: ["Game.exe"],
};

/**
 * Core's verdicts for names, collected across requests. One name never fails
 * a run: names Core cannot take are not sent, and a refused request is split
 * until the refused name is isolated and left unclassified. Only a refused
 * known-good probe (an unusable CLI) fails the run.
 */
export class NameVerdicts {
  readonly #classify: NameClassifier;
  readonly #prerelease = new Map<string, boolean>();
  readonly #assets = new Map<string, NameSuggestion>();
  readonly #programs = new Map<string, string | null>();
  readonly #tried = new Set<string>();
  constructor(classify: NameClassifier) {
    this.#classify = classify;
  }
  static async start(classify: NameClassifier) {
    const verdicts = new NameVerdicts(classify);
    if (!(await verdicts.#request(probe)))
      throw new Error("Core refused a known-good name classification; the CLI is unusable.");
    return verdicts;
  }
  /** The reviewed prerelease verdict, or undefined when Core did not classify the tag. */
  prerelease(release: { version: string; provider_prerelease: boolean }) {
    return this.#prerelease.get(
      tagKey({ tag: release.version, provider_prerelease: release.provider_prerelease }),
    );
  }
  /** The asset name's suggestion, or undefined when Core did not classify it. */
  suggestion(name: string) {
    return this.#assets.get(name);
  }
  /** The program name's tool token (null for none), or undefined when unclassified. */
  programToken(name: string) {
    return this.#programs.get(name);
  }
  async add(input: { releases?: TagInput[]; assets?: string[]; programs?: string[] }) {
    const fresh = <T,>(values: T[], key: (value: T) => string, name: (value: T) => string) => {
      const chosen = new Map<string, T>();
      for (const value of values) {
        const at = key(value);
        if (!sendableName(name(value)) || this.#tried.has(at)) continue;
        this.#tried.add(at);
        chosen.set(at, value);
      }
      return [...chosen.values()];
    };
    const items = [
      ...fresh(
        input.releases ?? [],
        (release) => `t${tagKey(release)}`,
        (release) => release.tag,
      ).map((release) => ({ kind: "releases" as const, value: release, name: release.tag })),
      ...fresh(
        input.assets ?? [],
        (name) => `a${name}`,
        (name) => name,
      ).map((name) => ({
        kind: "assets" as const,
        value: name,
        name,
      })),
      ...fresh(
        input.programs ?? [],
        (name) => `p${name}`,
        (name) => name,
      ).map((name) => ({
        kind: "programs" as const,
        value: name,
        name,
      })),
    ];
    let chunk: typeof items = [];
    let size = 0;
    const flush = async () => {
      if (chunk.length) await this.#split(chunk);
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      const cost = Buffer.byteLength(JSON.stringify(item.name)) + 64;
      if (chunk.length >= chunkNames || size + cost > chunkBytes) await flush();
      chunk.push(item);
      size += cost;
    }
    await flush();
  }
  async #split(
    items: { kind: "releases" | "assets" | "programs"; value: unknown; name: string }[],
  ): Promise<void> {
    const ok = await this.#request({
      releases: items.flatMap((item) => (item.kind === "releases" ? [item.value as TagInput] : [])),
      assets: items.flatMap((item) => (item.kind === "assets" ? [item.name] : [])),
      programs: items.flatMap((item) => (item.kind === "programs" ? [item.name] : [])),
    });
    if (ok || items.length === 1) return;
    const half = Math.ceil(items.length / 2);
    await this.#split(items.slice(0, half));
    await this.#split(items.slice(half));
  }
  /** One request; records its verdicts only when the whole answer is well formed. */
  async #request(input: { releases: TagInput[]; assets: string[]; programs: string[] }) {
    let result: unknown;
    try {
      result = await this.#classify(input);
    } catch {
      return false;
    }
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.filename_rule_version) ||
      Number(result.filename_rule_version) < 1 ||
      !Array.isArray(result.releases) ||
      !Array.isArray(result.assets) ||
      !Array.isArray(result.programs) ||
      result.releases.length !== input.releases.length ||
      result.assets.length !== input.assets.length ||
      result.programs.length !== input.programs.length
    )
      return false;
    const token = (value: unknown) =>
      value === null || (typeof value === "string" && /^[a-z0-9]{1,32}$/u.test(value));
    const releases = result.releases as unknown[];
    const assets = result.assets as unknown[];
    const programs = result.programs as unknown[];
    const wellFormed =
      releases.every(
        (release, index) =>
          isRecord(release) &&
          release.tag === input.releases[index]!.tag &&
          typeof release.prerelease === "boolean",
      ) &&
      assets.every(
        (asset, index) =>
          isRecord(asset) &&
          asset.name === input.assets[index] &&
          (roles as readonly unknown[]).includes(asset.role) &&
          typeof asset.os === "string" &&
          typeof asset.arch === "string" &&
          token(asset.tool_token) &&
          token(asset.system_token),
      ) &&
      programs.every(
        (program, index) =>
          isRecord(program) && program.name === input.programs[index] && token(program.tool_token),
      );
    if (!wellFormed) return false;
    const typed = result as unknown as NameClassification;
    for (const [index, release] of typed.releases.entries())
      this.#prerelease.set(tagKey(input.releases[index]!), release.prerelease);
    for (const asset of typed.assets)
      this.#assets.set(asset.name, {
        rule_version: typed.filename_rule_version,
        role: asset.role,
        os: asset.os,
        arch: asset.arch,
        tool_token: asset.tool_token,
        system_token: asset.system_token,
      });
    for (const program of typed.programs) this.#programs.set(program.name, program.tool_token);
    return true;
  }
}

export async function deriveListingFacts(inputs: DeriveInputs): Promise<DeriveResult> {
  const budget: Budget = { ...defaultBudget, ...inputs.budget };
  const previous = inputs.table ?? emptyFactsTable();
  checkListingFactsTable(previous);
  const now = inputs.now;
  if (Number.isNaN(Date.parse(now)) || Date.parse(now) < Date.parse(previous.generated_at))
    throw new Error(
      `The worker clock (${now}) is before the facts table's generation time (${previous.generated_at}).`,
    );
  if (inputs.provenance !== undefined) checkFactsProvenance(inputs.provenance);
  const state = sanitizeState(inputs.state ?? initialState());
  const candidates = listingOnly(inputs.records);
  const recordById = new Map(inputs.records.map((record) => [record.listing.id, record]));
  // Facts bind to the repository the listing names; a re-pointed listing rebinds.
  const bound = (entry: ListingFactsEntry) =>
    candidates.get(entry.port_id)?.toLowerCase() === entry.repository.toLowerCase();
  const entries = new Map(
    previous.entries.filter(bound).map((entry) => [entry.port_id, entry] as const),
  );
  // Identities the previous table already offers: keeping them fresh comes
  // before growth.
  const offered = new Set(
    [...entries.values()]
      .filter((entry) => {
        const record = recordById.get(entry.port_id);
        return record ? fitDecision(record, entry, previous.generated_at).fit : false;
      })
      .map((entry) => entry.port_id),
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

  const names = await NameVerdicts.start(inputs.classify);
  await names.add({
    releases: [...observed.values()]
      .filter(complete)
      .flatMap((observation) => observation.releases)
      .map((release) => ({
        tag: release.version,
        provider_prerelease: release.provider_prerelease,
      })),
  });
  const choice = new Map(
    [...observed]
      .filter(([, observation]) => complete(observation))
      .map(([id, observation]) => [
        id,
        latestStable(observation.releases, (release) => names.prerelease(release)),
      ]),
  );
  const latest = new Map<string, ObservedRelease | undefined>(
    [...choice].map(([id, chosen]) => [id, chosen.release]),
  );
  await names.add({
    assets: [...latest.values()].flatMap((release) =>
      (release?.assets ?? []).filter((asset) => isArchive(asset.name)).map((asset) => asset.name),
    ),
    programs: [...entries.values(), ...held.values()].flatMap((entry) =>
      entry.artifacts.flatMap(candidatesOf).map((player) => basenameOf(player.display_path)),
    ),
  });

  const report: ReportRow[] = [];
  const ineligibleCounts: Record<string, number> = {};
  /** Identities whose new entry this run settled (complete or newly ineligible). */
  const settledIds = new Set<string>();
  const row = (
    port_id: string,
    outcome: ReportRow["outcome"],
    reason?: string,
    inspected = 0,
    reused = 0,
  ) => {
    const existing = report.findIndex((item) => item.port_id === port_id);
    if (existing >= 0) report.splice(existing, 1);
    report.push({ port_id, outcome, ...(reason ? { reason } : {}), inspected, reused });
  };

  const observationOf = (id: string, release: ObservedRelease | undefined) => {
    const observation = observed.get(id)!;
    const observedAt =
      observation.observedAt && !Number.isNaN(Date.parse(observation.observedAt))
        ? new Date(Math.min(Date.parse(observation.observedAt), Date.parse(now))).toISOString()
        : now;
    const published = release?.published_at ? Date.parse(release.published_at) : NaN;
    return {
      release_id: release?.id ?? null,
      tag: release ? safeText(release.version, `release-${release.id}`) : null,
      published_at: Number.isNaN(published) ? null : new Date(published).toISOString(),
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
      unread_forms: release ? unreadFormsOf(release) : (entries.get(id)?.unread_forms ?? []),
      attempt: null,
      artifacts: [],
    };
    checkListingFactsEntry(entry);
    const prior = entries.get(id);
    // Reconfirming the same verdict for the same release is not progress.
    if (
      prior?.ineligible?.reason !== reason ||
      prior.observation.release_id !== observation.release_id ||
      prior.observation.assets_sha256 !== observation.assets_sha256
    )
      settledIds.add(id);
    entries.set(id, entry);
    held.delete(id);
    retry.delete(id);
    ineligibleCounts[reason] = (ineligibleCounts[reason] ?? 0) + 1;
    row(id, "ineligible", reason);
  };
  const invalid = (
    id: string,
    repositoryId: number,
    release: ObservedRelease | undefined,
    why: string,
  ) =>
    ineligible(
      id,
      repositoryId,
      release,
      "invalid-facts",
      safeText(why.slice(0, 500), "Observed facts failed validation."),
    );
  /**
   * Keep last-good complete facts through a non-complete upstream attempt,
   * within the retention bound. The worker's own backlog
   * (`pending-inspection`) is not an upstream attempt: upstream was complete,
   * so it starts no retention clock and leaves the entry unchanged once
   * recorded; only the facts age (`stale-facts`) bounds it.
   */
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
    if (status === "pending-inspection") {
      if (prior.attempt?.status !== "pending-inspection")
        entries.set(id, {
          ...prior,
          attempt: { status, first_at: now, last_at: now, failures: 1 },
        });
      row(id, outcome ?? "retained-last-good", status);
      return;
    }
    const attempt =
      prior.attempt && prior.attempt.status !== "pending-inspection"
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
  /** Facts for known candidates with Core's current name verdicts; undefined if a name is unclassified. */
  const factFor = (asset: ObservedAsset & { sha256: string }, players: readonly PlayerFact[]) => {
    const suggestion = names.suggestion(asset.name);
    const programs = players.map((player) => basenameOf(player.display_path));
    if (!suggestion || programs.some((name) => names.programToken(name) === undefined))
      return undefined;
    return artifactFact(asset, players, suggestion, (name) => names.programToken(name)!);
  };
  const unclassified =
    "A release file or program name could not be classified by Core (malformed, over 1,024 bytes or refused), so it cannot be vetoed.";
  const settle = (
    id: string,
    repositoryId: number,
    release: ObservedRelease,
    artifacts: (ArtifactFactV2 | undefined)[],
  ) => {
    if (artifacts.some((artifact) => artifact === undefined)) {
      invalid(id, repositoryId, release, unclassified);
      return false;
    }
    const entry: ListingFactsEntry = {
      ...base(id, repositoryId),
      observation: observationOf(id, release),
      ineligible: null,
      unread_forms: unreadFormsOf(release),
      attempt: null,
      artifacts: artifacts as ArtifactFactV2[],
    };
    try {
      checkListingFactsEntry(entry);
    } catch (error) {
      invalid(
        id,
        repositoryId,
        release,
        `Observed facts failed validation: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    }
    entries.set(id, entry);
    held.delete(id);
    retry.delete(id);
    return true;
  };
  /**
   * One identity's evaluation. Anything unexpected settles this identity as
   * `invalid-facts`, or, when even that cannot be recorded, leaves its prior
   * entry unchanged; it never fails the run.
   */
  const isolated = async (id: string, work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      const why = `The worker could not evaluate this identity: ${error instanceof Error ? error.message : "unknown error"}`;
      const repositoryId = observed.get(id)?.repositoryId ?? entries.get(id)?.repository_id;
      try {
        if (!repositoryId) throw new Error("no repository id");
        const release = latest.get(id) ?? choice.get(id)?.unclassified;
        invalid(
          id,
          repositoryId,
          release && Number.isSafeInteger(release.id) ? release : undefined,
          why,
        );
      } catch {
        row(id, "unknown", "worker-error");
      }
    }
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
  const evaluate = (id: string) => {
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
      return;
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
      return;
    }
    if (observation.malformedReleases > 0) {
      invalid(
        id,
        repositoryId,
        undefined,
        `The observation holds ${observation.malformedReleases} release record(s) the worker cannot read, so the latest stable release is unknown.`,
      );
      return;
    }
    const unreadable = unreadableReleases(
      observation.releases,
      choice.get(id)?.release ?? choice.get(id)?.unclassified,
    );
    if (unreadable) {
      invalid(id, repositoryId, undefined, unreadable);
      return;
    }
    const unclassifiedRelease = choice.get(id)?.unclassified;
    if (unclassifiedRelease) {
      // Never fall back to an older release past a tag Core could not judge.
      invalid(
        id,
        repositoryId,
        unclassifiedRelease,
        "A release newer than every stable release has a tag Core could not classify, so the latest stable release is unknown.",
      );
      return;
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
      return;
    }
    if (!release.assets_complete) {
      notComplete(id, "partial");
      return;
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
      return;
    }
    if (same && !same.ineligible) {
      const refreshed = same.artifacts.map((artifact) => {
        const asset = release.assets.find((candidate) => candidate.id === artifact.asset_id);
        return asset
          ? factFor({ ...asset, sha256: artifact.sha256 }, candidatesOf(artifact))
          : undefined;
      });
      if (settle(id, repositoryId, release, refreshed))
        row(id, "unchanged", undefined, 0, same.artifacts.length);
      return;
    }
    const archives = release.assets
      .filter((asset) => isArchive(asset.name))
      .toSorted((left, right) => left.id - right.id);
    if (!archives.length) {
      const forms = unreadFormsOf(release);
      const desktop = forms.filter((form) => (unreadForms as readonly string[]).includes(form));
      const mobile = forms.filter((form) => (nonDesktopForms as readonly string[]).includes(form));
      if (desktop.length)
        ineligible(
          id,
          repositoryId,
          release,
          "unsupported-archive-format",
          `The stable release has no ZIP, TAR.GZ or TAR.XZ archive; it has ${forms.join(", ")}.`,
        );
      else if (mobile.length)
        ineligible(
          id,
          repositoryId,
          release,
          "non-desktop-platform",
          `The stable release has only non-desktop packages: ${mobile.join(", ")}.`,
        );
      else
        ineligible(
          id,
          repositoryId,
          release,
          "no-release-archive",
          "The stable release has no package file.",
        );
      return;
    }
    // A name Core could not classify cannot be vetoed: never read its bytes.
    if (archives.some((asset) => !names.suggestion(asset.name))) {
      invalid(id, repositoryId, release, unclassified);
      return;
    }
    if (archives.some((asset) => !asset.sha256 || asset.size < 1)) {
      ineligible(
        id,
        repositoryId,
        release,
        "no-digest",
        "A release archive has no provider SHA-256, so its bytes cannot be bound.",
      );
      return;
    }
    if (archives.some((asset) => asset.size > budget.maxArchiveBytes)) {
      ineligible(
        id,
        repositoryId,
        release,
        "too-large",
        `A release archive exceeds ${budget.maxArchiveBytes} bytes.`,
      );
      return;
    }
    if (archives.length > budget.maxArchivesPerRelease) {
      ineligible(
        id,
        repositoryId,
        release,
        "too-many-assets",
        `The release has more than ${budget.maxArchivesPerRelease} archives.`,
      );
      return;
    }
    const digestBound = archives as (ObservedAsset & { sha256: string })[];
    const reusable = new Map(
      [prior, held.get(id)]
        .flatMap((entry) => entry?.artifacts ?? [])
        .map((artifact) => [`${artifact.asset_id}/${artifact.sha256}`, artifact] as const),
    );
    const cost = digestBound
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
      return;
    }
    needs.push({ id, repositoryId, release, archives: digestBound, reusable, cost });
  };
  for (const id of [...observed.keys()].toSorted(compareCodePoints))
    await isolated(id, () => evaluate(id));

  // Pass B: inspection within one bounded budget. The cursor's next new
  // identity goes first, so a pass always advances. Offered identities whose
  // release changed come next, oldest pending first, within all but a reserved
  // share of the identities. New identities' transient failures are retried
  // within part of that share, and the cursor pass takes the rest.
  let bytes = 0;
  let inspectedIdentities = 0;
  const inspectOne = async (need: Need) => {
    const found: { asset: ObservedAsset & { sha256: string }; players: PlayerFact[] }[] = [];
    let inspected = 0;
    let reused = 0;
    for (const asset of need.archives) {
      const known = need.reusable.get(`${asset.id}/${asset.sha256}`);
      if (known) {
        found.push({ asset, players: candidatesOf(known) });
        reused++;
        continue;
      }
      try {
        inspected++;
        found.push({ asset, players: await inputs.inspect(asset, readerPlatform(asset.name)) });
      } catch (error) {
        if (error instanceof InspectionError && error.permanent) {
          ineligible(
            need.id,
            need.repositoryId,
            need.release,
            "core-refused",
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
    await names.add({
      programs: found.flatMap(({ players }) =>
        players.map((player) => basenameOf(player.display_path)),
      ),
    });
    if (
      settle(
        need.id,
        need.repositoryId,
        need.release,
        found.map(({ asset, players }) => factFor(asset, players)),
      )
    ) {
      settledIds.add(need.id);
      row(need.id, "complete", undefined, inspected, reused);
    }
  };
  const attempted = new Set<string>();
  const take = async (need: Need) => {
    attempted.add(need.id);
    inspectedIdentities++;
    bytes += need.cost;
    await isolated(need.id, () => inspectOne(need));
  };
  const fits = (need: Need) => bytes + need.cost <= budget.maxBytes;
  const reserved = newIdentityShare(budget);
  const newRetryCap = Math.max(0, Math.floor(reserved / 2));
  const refreshing = needs.filter((need) => offered.has(need.id));
  const growing = needs.filter((need) => !offered.has(need.id));
  const pendingSince = (need: Need) => {
    const attempt = entries.get(need.id)?.attempt;
    return attempt?.status === "pending-inspection" ? attempt.first_at : now;
  };
  let after = state.after;
  const cursor = growing.filter((need) => after === null || need.id > after);
  let finished = true;
  const budgetStopped = new Set<string>();
  /** Advance the cursor pass by one identity; false when it must stop this run. */
  const advance = async (limit: number) => {
    const need = cursor.find((candidate) => !attempted.has(candidate.id));
    if (!need) return false;
    if (inspectedIdentities >= limit) {
      finished = false;
      return false;
    }
    if (!fits(need)) {
      // Every queued identity fits one whole run (larger ones are completed
      // as exceeds-run-budget), so the pass resumes here next run.
      budgetStopped.add(need.id);
      finished = false;
      return false;
    }
    after = need.id;
    await take(need);
    return true;
  };
  await advance(budget.maxIdentities);
  const refreshOrder = refreshing.toSorted(
    (left, right) =>
      compareCodePoints(pendingSince(left), pendingSince(right)) ||
      compareCodePoints(left.id, right.id),
  );
  let refreshed = 0;
  for (const need of refreshOrder) {
    if (refreshed >= budget.maxIdentities - reserved) break;
    if (inspectedIdentities >= budget.maxIdentities) break;
    if (!fits(need)) {
      budgetStopped.add(need.id);
      continue;
    }
    refreshed++;
    await take(need);
  }
  let retried = 0;
  for (const item of [...retry.values()].toSorted(
    (left, right) =>
      compareCodePoints(left.since, right.since) || compareCodePoints(left.port_id, right.port_id),
  )) {
    if (retried >= newRetryCap || inspectedIdentities >= budget.maxIdentities) break;
    const need = growing.find((candidate) => candidate.id === item.port_id);
    if (!need || attempted.has(need.id)) continue;
    if (!fits(need)) {
      budgetStopped.add(need.id);
      continue;
    }
    retried++;
    await take(need);
  }
  while (await advance(budget.maxIdentities));
  // Share the cursor pass did not need goes back to offered identities.
  for (const need of refreshOrder) {
    if (inspectedIdentities >= budget.maxIdentities) break;
    if (attempted.has(need.id)) continue;
    if (!fits(need)) {
      budgetStopped.add(need.id);
      continue;
    }
    await take(need);
  }
  const pending = needs.filter((need) => !attempted.has(need.id));
  for (const need of pending)
    await isolated(need.id, () =>
      notComplete(
        need.id,
        "pending-inspection",
        budgetStopped.has(need.id) ? "deferred-budget" : "deferred-identities",
      ),
    );

  // One bounded batch lands; the rest is held for the next run.
  const sorted = [...entries.values()]
    .filter((entry) => candidates.has(entry.port_id))
    .toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  const next: ListingFactsTable = {
    format: previous.format,
    generator: previous.generator,
    generated_at: now,
    ...(inputs.provenance ? { provenance: inputs.provenance } : {}),
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
  checkListingFactsTable(next);
  const batch = boundFactsBatch(inputs.records, previous, next);
  for (const entry of batch.deferred) {
    const existing = report.find((item) => item.port_id === entry.port_id);
    if (existing) existing.outcome = "held-for-batch";
  }
  const deferredIds = new Set(batch.deferred.map((entry) => entry.port_id));
  const settled = [...settledIds].filter((id) => !deferredIds.has(id)).length;
  const backlog = backlogOf(
    pending.filter((need) => offered.has(need.id)),
    pending.filter((need) => !offered.has(need.id)),
    budget,
    inputs.cadenceHours ?? defaultCadenceHours,
    batch.deferred.length,
  );
  return {
    table: batch.table,
    state: {
      format: 2,
      after: finished ? null : after,
      retry: [...retry.values()]
        .filter((item) => !entries.get(item.port_id)?.ineligible)
        .toSorted((left, right) => compareCodePoints(left.port_id, right.port_id)),
      held: batch.deferred,
    },
    report,
    ineligible: ineligibleCounts,
    bytes,
    backlog,
    settled,
    no_progress:
      settled === 0 && backlog.enrolled_pending + backlog.new_pending + backlog.held_for_batch > 0,
  };
}

/** Identities each run reserves for new identities: a quarter, at least one. */
export const newIdentityShare = (budget: Pick<Budget, "maxIdentities">) =>
  Math.max(1, Math.floor(budget.maxIdentities / 4));
/** The scheduled job's intended cadence. */
export const defaultCadenceHours = 24;

/**
 * The worker's own backlog and how long draining it takes at the configured
 * cadence. Offered identities get all but the reserved share of each run; the
 * whole backlog drains no faster than the identity and byte bounds allow.
 * `held_for_batch` counts derived facts waiting only for the enrollment delta
 * bound: they need no bytes, and at most the smallest delta bound of them
 * land per run (`runs_to_land_held`).
 */
export function backlogOf(
  enrolled: readonly { cost: number }[],
  growth: readonly { cost: number }[],
  budget: Budget,
  cadenceHours: number,
  heldForBatch = 0,
) {
  const sum = (items: readonly { cost: number }[]) =>
    items.reduce((total, item) => total + item.cost, 0);
  // Offered identities get every identity a run has when nothing new waits.
  const share = growth.length
    ? budget.maxIdentities - newIdentityShare(budget)
    : budget.maxIdentities;
  const enrolledRuns = Math.max(
    Math.ceil(enrolled.length / Math.max(1, share)),
    Math.ceil(sum(enrolled) / budget.maxBytes),
  );
  const allRuns = Math.max(
    Math.ceil((enrolled.length + growth.length) / budget.maxIdentities),
    Math.ceil((sum(enrolled) + sum(growth)) / budget.maxBytes),
  );
  const days = (runs: number) => Math.round(((runs * cadenceHours) / 24) * 10) / 10;
  const landPerRun = Math.min(deltaBounds.added, deltaBounds.withdrawn, deltaBounds.changed);
  return {
    enrolled_pending: enrolled.length,
    new_pending: growth.length,
    bytes_pending: sum(enrolled) + sum(growth),
    cadence_hours: cadenceHours,
    runs_to_drain_enrolled: enrolledRuns,
    runs_to_drain_all: allRuns,
    days_to_drain_enrolled: days(enrolledRuns),
    days_to_drain_all: days(allRuns),
    held_for_batch: heldForBatch,
    runs_to_land_held: Math.ceil(heldForBatch / landPerRun),
  };
}

/** A state file's usable parts; anything malformed starts that part fresh. */
function sanitizeState(state: WorkerState): WorkerState {
  return {
    format: 2,
    after: typeof state.after === "string" ? state.after : null,
    retry: (Array.isArray(state.retry) ? state.retry : []).filter(
      (item: unknown): item is RetryItem =>
        isRecord(item) &&
        typeof item.port_id === "string" &&
        typeof item.since === "string" &&
        !Number.isNaN(Date.parse(item.since)) &&
        Number.isSafeInteger(item.failures) &&
        Number(item.failures) > 0,
    ),
    held: Array.isArray(state.held) ? state.held : [],
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
        `archive${isArchive(asset.name) ? packageFormOf(asset.name)! : ""}`,
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
  "Usage: node scripts/listing-package-facts.mts --check | derive --observations REPORT --cli PORTCOVE [--state FILE] [--output FILE] [--cadence-hours N] [--workflow-run-id ID --source-commit SHA --inputs-sha256 SHA] [--report FILE]";

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
  const provenanceOptions = ["workflow-run-id", "source-commit", "inputs-sha256"].map((name) =>
    Boolean(options[name]),
  );
  if (provenanceOptions.some((given) => given !== provenanceOptions[0]))
    throw new Error(
      "Provenance needs --workflow-run-id, --source-commit and --inputs-sha256 together.",
    );
  const cadenceHours = options["cadence-hours"] ? Number(options["cadence-hours"]) : undefined;
  if (cadenceHours !== undefined && !(cadenceHours > 0)) throw new Error(usage);
  const output = options.output ?? factsTablePath;
  const { records } = readCatalogSource(catalogRoot);
  const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-"));
  try {
    const cli = path.resolve(options.cli);
    const provenance = options["workflow-run-id"]
      ? {
          workflow_run_id: options["workflow-run-id"],
          source_commit: options["source-commit"]!,
          cli_sha256: createHash("sha256")
            .update(await readFile(cli))
            .digest("hex"),
          inputs_sha256: options["inputs-sha256"]!,
        }
      : undefined;
    const result = await deriveListingFacts({
      ...(provenance ? { provenance } : {}),
      ...(cadenceHours ? { cadenceHours } : {}),
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
    const summary = `${JSON.stringify({ no_progress: result.no_progress, settled: result.settled, after: result.state.after, retry: result.state.retry.length, held: result.state.held.length, bytes: result.bytes, backlog: result.backlog, ineligible: result.ineligible, identities: result.report })}\n`;
    if (options.report) await writeFile(options.report, summary);
    return `${JSON.stringify({ no_progress: result.no_progress, settled: result.settled, after: result.state.after, retry: result.state.retry.length, held: result.state.held.length, bytes: result.bytes, backlog: result.backlog, ineligible: result.ineligible, identities: result.report })}\n`;
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
