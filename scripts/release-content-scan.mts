/**
 * Release-content scan (#5353). For each unheld listing that offers an
 * upstream download, find the release asset its hints select in the listing's
 * channel, download each not-yet-scanned asset once, list its entries with
 * bounded external listers and check them with release-content-signals.
 * Nothing is executed or installed; a finding is evidence for a reviewed hold.
 *
 * Usage: node scripts/release-content-scan.mts scan --listings <listings.json>
 *          --checkpoint <in.json|-> [--checkpoint-out <out.json>] --output <report.json>
 *          [--accounting <release-content-accounting.json>]
 *          [--max-assets N] [--max-asset-bytes N] [--max-total-bytes N] [--minutes N]
 *          [--max-retry-assets N] [--max-retry-bytes N]
 *        node scripts/release-content-scan.mts summary|annotations --report <report.json>
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  HEAD_BYTES,
  type ContentSignal,
  type PackageEntry,
  RULES_VERSION,
  headCandidates,
  packageSignals,
} from "./release-content-signals.mts";

export interface ScanTarget {
  id: string;
  provider: "github" | "gitlab";
  repository: string;
  platform: string;
  hints: string[];
  channel: "stable" | "beta";
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
  digest: string | null;
}

export interface UpstreamRelease {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface ScanRecord {
  key: string;
  id: string;
  platform: string;
  repository: string;
  tag: string;
  asset: string;
  sha256: string;
  entries: number;
  /** Candidate files whose bytes could not be read, and whether the candidate list was cut. */
  heads_unread: number;
  heads_truncated: boolean;
  rules: number;
  /** At most {@link SIGNAL_CAP} signals, sorted; `signal_count` is the true total. */
  signals: ContentSignal[];
  signal_count: number;
}

/** Signals kept per record; the rest are counted in `signal_count`. */
export const SIGNAL_CAP = 20;

/** Signals sorted by path, kind and reason, cut at {@link SIGNAL_CAP}, with their true total. */
export function cappedSignals(signals: readonly ContentSignal[], total = signals.length) {
  const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return {
    signals: [...signals]
      .sort(
        (left, right) =>
          order(left.path, right.path) ||
          order(left.kind, right.kind) ||
          order(left.reason, right.reason),
      )
      .slice(0, SIGNAL_CAP),
    signal_count: Math.max(total, signals.length),
  };
}

/**
 * A reviewed dismissal of one finding (`.github/release-content-accounting.json`):
 * the exact package bytes under one rules version, a reason and the reviewed
 * issue or pull request. A new digest or rules version is not covered.
 */
export interface AccountingEntry {
  port_id: string;
  platform: string;
  sha256: string;
  rules: number;
  reason: string;
  evidence: string;
}

/** A finding as reported: its record, and the reviewed accounting that covers it. */
export type ScanFinding = ScanRecord & { accounted?: { reason: string; evidence: string } };

/** The reviewed issue or pull request an accounting entry names. */
export const EVIDENCE_URL =
  /^https:\/\/github\.com\/boburning\/portcove\/(issues|pull)\/[1-9][0-9]*$/u;

/**
 * The accounting file, validated strictly against the listings: every field,
 * one entry per port, platform, digest and rules version, a reviewed issue or
 * pull request as evidence, and a port the listings know.
 */
export function readAccounting(value: unknown, listings: unknown): AccountingEntry[] {
  const fail = (detail: string): never => {
    throw new Error(`Invalid release-content accounting: ${detail}`);
  };
  const file = value as { format_version?: unknown; entries?: unknown } | null;
  if (!file || file.format_version !== 1 || !Array.isArray(file.entries))
    fail("expected { format_version: 1, entries: [] }");
  const ids = new Set(
    ((listings as { listings?: { id?: unknown }[] } | null)?.listings ?? []).map(({ id }) =>
      String(id),
    ),
  );
  const fields = ["port_id", "platform", "sha256", "rules", "reason", "evidence"];
  const seen = new Set<string>();
  return (file!.entries as unknown[]).map((item, index) => {
    const entry = item as Record<string, unknown>;
    const at = `entry ${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return fail(`${at} is not an object`);
    const extra = Object.keys(entry).filter((key) => !fields.includes(key));
    if (extra.length) fail(`${at} has unknown fields ${extra.join(", ")}`);
    if (typeof entry.port_id !== "string" || !ids.has(entry.port_id))
      fail(`${at} names a port that the listings do not contain`);
    if (typeof entry.platform !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(entry.platform))
      fail(`${at} has no valid platform`);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256))
      fail(`${at} has no lowercase SHA-256`);
    if (!Number.isSafeInteger(entry.rules) || (entry.rules as number) < 1)
      fail(`${at} has no rules version`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
      fail(`${at} needs a reason of at least 20 characters`);
    if (typeof entry.evidence !== "string" || !EVIDENCE_URL.test(entry.evidence))
      fail(`${at} evidence must be a boburning/portcove issue or pull request URL`);
    const key = [entry.port_id, entry.platform, entry.sha256, entry.rules].join("\t");
    if (seen.has(key)) fail(`${at} duplicates an earlier entry`);
    seen.add(key);
    return entry as unknown as AccountingEntry;
  });
}

/** The accounting entry that covers a finding under the current rules, if any. */
export function accountingFor(
  entries: readonly AccountingEntry[],
  finding: Pick<ScanRecord, "id" | "platform" | "sha256" | "rules">,
) {
  return entries.find(
    (entry) =>
      entry.port_id === finding.id &&
      entry.platform === finding.platform &&
      entry.sha256 === finding.sha256 &&
      entry.rules === RULES_VERSION &&
      finding.rules === RULES_VERSION,
  );
}

/**
 * Why a target was not scanned. Deferred codes (budgets, the deadline and
 * transient network, provider or tool failures) are retried by a later run.
 * Persistent codes are deterministic for the same release and limits, so a
 * later run would only repeat them: nothing to download (`no-release`,
 * `no-single-asset`), a release read the provider refuses for good
 * (`release-unavailable`: a redirect, 404 or 410), an asset over the per-asset
 * limit (`asset-too-large`), bytes that differ from the published digest
 * (`digest-mismatch`), an archive whose listing needs a password
 * (`encrypted-archive`), or one the listers cannot read (`unlistable`).
 */
export const DEFERRED_UNSCANNED = [
  "time-budget",
  "asset-budget",
  "time-cut",
  "release-read-failed",
  "scan-failed",
] as const;
export const PERSISTENT_UNSCANNED = [
  "no-release",
  "no-single-asset",
  "release-unavailable",
  "asset-too-large",
  "digest-mismatch",
  "encrypted-archive",
  "unlistable",
] as const;
export type UnscannedCode =
  | (typeof DEFERRED_UNSCANNED)[number]
  | (typeof PERSISTENT_UNSCANNED)[number];

/** A downloaded asset's persistent failure, kept in the checkpoint so it is not fetched again. */
export interface ScanFailure {
  key: string;
  code: UnscannedCode;
  /** The per-asset limit in force, so a raised limit retries an `asset-too-large` asset. */
  max_asset_bytes: number;
}

/**
 * Persistent download failures the checkpoint remembers and does not fetch
 * again. `unlistable` is persistent for coverage but is remembered as a retry
 * instead: a lister or environment fault can cause it as well as the package,
 * so it is re-checked each run under its own allowance ({@link scan}).
 */
export const RECORDED_FAILURES: readonly UnscannedCode[] = [
  "asset-too-large",
  "digest-mismatch",
  "encrypted-archive",
];

/** A failure whose cause the scan knows; any other error is a deferred `scan-failed`. */
export class ScanError extends Error {
  readonly code: UnscannedCode;
  constructor(code: UnscannedCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The digest of a target list, independent of order: SHA-256 of the sorted
 * `<id>\t<platform>` lines joined by newlines. A consumer recomputes it from
 * the scanned, reused and not-scanned entries to prove they cover every target.
 */
export function targetsDigest(targets: readonly { id: string; platform: string }[]) {
  return createHash("sha256")
    .update(
      targets
        .map(({ id, platform }) => `${id}\t${platform}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
}

export interface ScanReport {
  format_version: 3;
  /** How many targets the listings produced, and their digest ({@link targetsDigest}). */
  targets: number;
  targets_sha256: string;
  scanned: ScanRecord[];
  /** Targets satisfied from the checkpoint; `reused` is their count. */
  reused: number;
  reused_targets: {
    id: string;
    platform: string;
    key: string;
    tag: string;
    asset: string;
    sha256: string;
  }[];
  findings: ScanFinding[];
  /** `provider` lets a reader route a release it cannot read (GitHub relocation or a GitLab fix). */
  unscanned: {
    id: string;
    platform: string;
    provider: ScanTarget["provider"];
    code: UnscannedCode;
    reason: string;
  }[];
  /** Accounting entries no finding of this run matched: stale, or their target was not reached. */
  accounting_unmatched: { port_id: string; platform: string; sha256: string; rules: number }[];
}

const SKIPPED_ASSET = /(debug|symbols|pdb|source|src)[-_.]|\.(sha256|sig|asc|txt|json)$/i;

/** Listings that offer a download and are not held, one target per hinted platform. */
export function scanTargets(listings: unknown): ScanTarget[] {
  const items = Array.isArray((listings as { listings?: unknown })?.listings)
    ? (listings as { listings: Record<string, unknown>[] }).listings
    : [];
  const targets: ScanTarget[] = [];
  for (const listing of items) {
    if (listing.download_block_reason) continue;
    const hints = listing.download_asset_hints as Record<string, string[]> | undefined;
    if (!hints) continue;
    const url =
      [listing.release_url, listing.project_url].find(
        (value): value is string => typeof value === "string",
      ) ?? "";
    const github = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/i.exec(url);
    const gitlab = /^https:\/\/gitlab\.com\/([^#?]+?)(?:\/-\/.*)?$/i.exec(url);
    if (!github && !gitlab) continue;
    for (const [platform, platformHints] of Object.entries(hints))
      targets.push({
        id: String(listing.id),
        provider: github ? "github" : "gitlab",
        repository: (github?.[1] ?? gitlab?.[1] ?? "").replace(/\.git$/, ""),
        platform,
        hints: platformHints,
        channel: listing.recommended_download_channel === "beta" ? "beta" : "stable",
      });
  }
  return targets;
}

/** The newest published release in the channel: stable skips prereleases. */
export function channelRelease(releases: readonly UpstreamRelease[], channel: "stable" | "beta") {
  return releases.find((release) => !release.draft && (channel === "beta" || !release.prerelease));
}

/** The single asset every hint names, ignoring checksums, symbols and sources. */
export function hintedAsset(assets: readonly ReleaseAsset[], hints: readonly string[]) {
  const matches = assets.filter(
    (asset) =>
      !SKIPPED_ASSET.test(asset.name) &&
      hints.every((hint) => asset.name.toLowerCase().includes(hint.toLowerCase())),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export const assetKey = (target: ScanTarget, tag: string, asset: ReleaseAsset) =>
  [
    `r${RULES_VERSION}`,
    target.provider,
    target.repository.toLowerCase(),
    tag,
    asset.name,
    asset.digest ?? asset.size ?? "",
  ].join("|");

export interface ScanDependencies {
  /** `stopAt` is the run's deadline in epoch milliseconds; no read may outlive it. */
  releases(target: ScanTarget, stopAt: number): Promise<UpstreamRelease[]>;
  /** `stopAt` is the run's deadline in epoch milliseconds; no call may outlive it. */
  download(asset: ReleaseAsset, file: string, maxBytes: number, stopAt: number): Promise<void>;
  list(file: string, name: string, stopAt: number): Promise<PackageEntry[]>;
  heads(
    file: string,
    name: string,
    entries: PackageEntry[],
    stopAt: number,
  ): Promise<Map<string, Buffer>>;
}

export async function scan(
  targets: readonly ScanTarget[],
  checkpoint: ReadonlyMap<string, ScanRecord>,
  deps: ScanDependencies,
  {
    maxAssets = 40,
    maxAssetBytes = 1_500_000_000,
    maxTotalBytes = 12_000_000_000,
    deadline = Number.POSITIVE_INFINITY,
    clock = Date.now,
    failures: knownFailures = new Map<string, ScanFailure>(),
    retries: knownRetries = new Map<string, number>(),
    maxRetryAssets = 4,
    maxRetryBytes = 2_000_000_000,
    accounting = [],
  }: {
    maxAssets?: number | undefined;
    maxAssetBytes?: number | undefined;
    maxTotalBytes?: number | undefined;
    deadline?: number;
    clock?: () => number;
    /** Persistent failures of downloaded assets from earlier runs, by asset key. */
    failures?: ReadonlyMap<string, ScanFailure>;
    /**
     * Asset keys an earlier run found unlistable, with the retry run that last
     * checked each; re-checked in rotation under their own allowance.
     */
    retries?: ReadonlyMap<string, number>;
    maxRetryAssets?: number | undefined;
    maxRetryBytes?: number | undefined;
    /** Reviewed dismissals ({@link readAccounting}). */
    accounting?: readonly AccountingEntry[];
  } = {},
): Promise<{
  report: ScanReport;
  checkpoint: Map<string, ScanRecord>;
  failures: Map<string, ScanFailure>;
  retries: Map<string, number>;
}> {
  const next = new Map(checkpoint);
  const failures = new Map(knownFailures);
  const retries = new Map(knownRetries);
  const matched = new Set<AccountingEntry>();
  // Accounting comes only from the reviewed file: any `accounted` on the input is dropped.
  const finding = (input: ScanRecord): ScanFinding => {
    const { accounted: _ignored, ...record } = input as ScanFinding;
    const entry = accountingFor(accounting, record);
    if (!entry) return record;
    matched.add(entry);
    return { ...record, accounted: { reason: entry.reason, evidence: entry.evidence } };
  };
  const report: ScanReport = {
    format_version: 3,
    targets: targets.length,
    targets_sha256: targetsDigest(targets),
    scanned: [],
    reused: 0,
    reused_targets: [],
    findings: [],
    unscanned: [],
    accounting_unmatched: [],
  };
  const releaseCache = new Map<string, Promise<UpstreamRelease[]>>();
  let budget = maxTotalBytes;
  let attempts = 0;
  // Re-checks of unlistable assets spend only their own allowance, never the main budgets.
  let retryBudget = maxRetryBytes;
  // Phase 1: resolve each target's release and asset. Reads are cached per repository,
  // so every retry candidate of this run is known before any allowance is spent.
  type Plan =
    | { target: ScanTarget; skip: { code: UnscannedCode; reason: string } }
    | { target: ScanTarget; release: UpstreamRelease; asset: ReleaseAsset; key: string };
  const plans: Plan[] = [];
  for (const target of targets) {
    // No release read starts after the deadline; the rest are left for a later run.
    if (clock() >= deadline) {
      plans.push({
        target,
        skip: { code: "time-budget", reason: "time budget reached; scanned in a later run" },
      });
      continue;
    }
    let releases: UpstreamRelease[];
    try {
      const cacheKey = `${target.provider}|${target.repository.toLowerCase()}`;
      if (!releaseCache.has(cacheKey)) releaseCache.set(cacheKey, deps.releases(target, deadline));
      releases = await releaseCache.get(cacheKey)!;
    } catch (error) {
      plans.push({
        target,
        skip:
          // A read the deadline cut says nothing about the release.
          clock() >= deadline && !(error instanceof ScanError)
            ? { code: "time-budget", reason: "time budget reached; scanned in a later run" }
            : {
                code: error instanceof ScanError ? error.code : "release-read-failed",
                reason: `release read failed: ${(error as Error).message}`,
              },
      });
      continue;
    }
    const release = channelRelease(releases, target.channel);
    if (!release) {
      plans.push({
        target,
        skip: { code: "no-release", reason: "no published release in the channel" },
      });
      continue;
    }
    const asset = hintedAsset(release.assets, target.hints);
    if (!asset) {
      plans.push({
        target,
        skip: { code: "no-single-asset", reason: `hints select no single asset in ${release.tag}` },
      });
      continue;
    }
    plans.push({ target, release, asset, key: assetKey(target, release.tag, asset) });
  }
  // Remembered unlistable assets are re-checked in rotation, least recently checked
  // first, within their own allowance; the rest keep their persistent code this run.
  const retryRun = Math.max(0, ...retries.values()) + 1;
  const rechecks = new Set<string>();
  let reserved = maxRetryBytes;
  for (const plan of [
    ...new Map(
      plans.flatMap((plan) =>
        "key" in plan &&
        retries.has(plan.key) &&
        !next.has(plan.key) &&
        !failures.has(plan.key) &&
        (plan.asset.size === null || plan.asset.size <= maxAssetBytes)
          ? [[plan.key, plan] as const]
          : [],
      ),
    ).values(),
  ].sort(
    (left, right) =>
      retries.get(left.key)! - retries.get(right.key)! ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  )) {
    if (rechecks.size >= maxRetryAssets) break;
    const size = plan.asset.size ?? 0;
    if (size > reserved) continue;
    reserved -= size;
    rechecks.add(plan.key);
  }
  // Phase 2: scan in target order.
  const recheckOutcomes = new Map<string, { code: UnscannedCode; reason: string }>();
  for (const plan of plans) {
    const { target } = plan;
    const skip = (code: UnscannedCode, reason: string) =>
      report.unscanned.push({
        id: target.id,
        platform: target.platform,
        provider: target.provider,
        code,
        reason,
      });
    if (clock() >= deadline) {
      skip("time-budget", "time budget reached; scanned in a later run");
      continue;
    }
    if ("skip" in plan) {
      skip(plan.skip.code, plan.skip.reason);
      continue;
    }
    const { release, asset, key } = plan;
    const known = next.get(key);
    if (known) {
      report.reused++;
      report.reused_targets.push({
        id: target.id,
        platform: target.platform,
        key,
        tag: known.tag,
        asset: known.asset,
        sha256: known.sha256,
      });
      if (known.signals.length)
        report.findings.push(
          finding({
            ...known,
            // Records checkpointed before the cap carry every signal and no count.
            ...cappedSignals(known.signals, known.signal_count ?? known.signals.length),
            id: target.id,
            platform: target.platform,
          }),
        );
      continue;
    }
    // A downloaded asset that failed for a deterministic cause is not fetched again
    // until its release, the rules or (for its size) the per-asset limit changes.
    const failed = failures.get(key);
    if (failed && (failed.code !== "asset-too-large" || maxAssetBytes <= failed.max_asset_bytes)) {
      skip(
        failed.code,
        `asset ${asset.name}: ${failed.code} in an earlier run; not retried for this release`,
      );
      continue;
    }
    // An unlistable package another target already re-checked this run (the same key)
    // takes that outcome instead of a second download; a clean re-check was reused above.
    const outcome = recheckOutcomes.get(key);
    if (outcome) {
      skip(outcome.code, `${outcome.reason} (checked for another target in this run)`);
      continue;
    }
    const retry = retries.has(key);
    if (asset.size !== null && asset.size > maxAssetBytes) {
      skip(
        "asset-too-large",
        `asset ${asset.name} exceeds the per-asset byte limit; not scanned under the current limits`,
      );
      continue;
    }
    // A remembered unlistable asset outside this run's rotation, or past its byte
    // allowance, keeps its persistent code: never a deferral, so its port stays a fact.
    if (retry && (!rechecks.has(key) || retryBudget <= 0)) {
      skip(
        "unlistable",
        `asset ${asset.name} was unlistable in an earlier run; re-checked in rotation in a later run`,
      );
      continue;
    }
    if (!retry && (attempts >= maxAssets || budget <= 0)) {
      skip("asset-budget", "asset or byte budget reached; scanned in a later run");
      continue;
    }
    if (!retry && asset.size !== null && asset.size > budget) {
      skip(
        "asset-budget",
        `asset ${asset.name} exceeds the byte budget; retried when the budget allows`,
      );
      continue;
    }
    if (retry) retries.set(key, retryRun);
    else attempts++;
    const limit = Math.max(1, Math.min(maxAssetBytes, retry ? retryBudget : budget));
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-scan-"));
    const file = path.join(dir, "package");
    try {
      await deps.download(asset, file, limit, deadline);
      const bytes = await readFile(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (asset.digest?.startsWith("sha256:") && asset.digest !== `sha256:${sha256}`)
        throw new ScanError(
          "digest-mismatch",
          "downloaded bytes differ from the provider's published digest",
        );
      const entries = await deps.list(file, asset.name, deadline);
      const candidates = headCandidates(entries);
      const read = candidates.slice(0, 64);
      const heads = await deps.heads(file, asset.name, read, deadline);
      const record: ScanRecord = {
        key,
        id: target.id,
        platform: target.platform,
        repository: target.repository,
        tag: release.tag,
        asset: asset.name,
        sha256,
        entries: entries.length,
        heads_unread: read.length - heads.size,
        heads_truncated: candidates.length > read.length,
        rules: RULES_VERSION,
        ...cappedSignals(packageSignals(entries, heads)),
      };
      if (record.heads_unread && !record.signals.length && clock() >= deadline) {
        // A read cut by the clock says nothing about the package: retry it later.
        skip("time-cut", `asset ${asset.name} was cut by the time budget; scanned in a later run`);
        continue;
      }
      next.set(key, record);
      retries.delete(key);
      report.scanned.push(record);
      if (record.signals.length) report.findings.push(finding(record));
    } catch (error) {
      let code: UnscannedCode = error instanceof ScanError ? error.code : "scan-failed";
      // A transfer cut by a smaller remaining budget is retried; only the per-asset cap is
      // final. A re-check cut by its own allowance stays a remembered unlistable asset.
      if (code === "asset-too-large" && limit < maxAssetBytes)
        code = retry ? "unlistable" : "asset-budget";
      if (RECORDED_FAILURES.includes(code)) {
        failures.set(key, { key, code, max_asset_bytes: maxAssetBytes });
        retries.delete(key);
      } else if (code === "unlistable") retries.set(key, retryRun);
      const reason = `asset ${asset.name} could not be scanned: ${(error as Error).message}`;
      if (retry || code === "unlistable") recheckOutcomes.set(key, { code, reason });
      skip(code, reason);
    } finally {
      // Failed transfers spend their budget too, so a bad asset cannot repeat unbounded.
      const spent = await stat(file).then(
        (info) => info.size,
        () => 0,
      );
      if (retry) retryBudget -= spent;
      else budget -= spent;
      await rm(dir, { recursive: true, force: true });
    }
  }
  report.accounting_unmatched = accounting
    .filter((entry) => !matched.has(entry))
    .map(({ port_id, platform, sha256, rules }) => ({ port_id, platform, sha256, rules }));
  return { report, checkpoint: next, failures, retries };
}

// ---- Hosted implementations -------------------------------------------------

const execute = promisify(execFile);
const TOOL_TIMEOUT_MS = 5 * 60_000;
type RunOptions = { maxBuffer?: number; timeout?: number; encoding?: "buffer" };
const run = (file: string, args: string[], options: RunOptions = {}) =>
  execute(file, args, {
    timeout: TOOL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 << 20,
    ...options,
  });

/** A call's timeout: its own cap, never beyond the run's deadline. */
export function callTimeout(cap: number, stopAt: number, now = Date.now()) {
  const remaining = stopAt - now;
  if (remaining <= 0) throw new Error("time budget reached");
  return Math.min(cap, remaining);
}

/** Member names a lister could read as an option, list file or wildcard are not opened. */
export const safeMember = (name: string) => !/^[-@]/.test(name) && !/[*?[\]]/.test(name);

/** One release read's own cap; never beyond the run's deadline. */
const RELEASE_READ_TIMEOUT_MS = 60_000;

async function json(url: string, token: string | undefined, stopAt: number) {
  // The signal also bounds reading the body. A timeout is an ordinary error, so the
  // scan defers the target (`release-read-failed`, or `time-budget` past the deadline).
  const signal = AbortSignal.timeout(callTimeout(RELEASE_READ_TIMEOUT_MS, stopAt));
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "portcove-release-scan",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // A redirect (for example a renamed repository) is reported, never followed.
    redirect: "manual",
  });
  if (!response.ok)
    throw new ScanError(
      permanentRelease(response.status) ? "release-unavailable" : "release-read-failed",
      `${response.status} from ${new URL(url).host}`,
    );
  return response.json();
}

/** Release-read statuses a retry would only repeat: a redirect, 404 or 410. */
export const permanentRelease = (status: number) =>
  (status >= 300 && status < 400) || status === 404 || status === 410;

/** The fields of a child-process failure that say how it ended. */
type ChildFailure = Error & {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  stderr?: string | Buffer;
};

/** curl's exit status when a transfer exceeds `--max-filesize`. */
const CURL_FILESIZE_EXCEEDED = 63;

/**
 * A lister that ran and exited non-zero cannot read the archive: `unlistable`,
 * or `encrypted-archive` when 7z reports that the listing needs a password (7z
 * gives that no exit status of its own, so its message decides). A timeout, a
 * kill, a missing tool or the deadline stays a deferred `scan-failed`.
 */
export function listerFailure(error: unknown, sevenZip = false): unknown {
  const failure = error as ChildFailure;
  if (
    !(error instanceof Error) ||
    typeof failure.code !== "number" ||
    failure.killed ||
    failure.signal
  )
    return error;
  return sevenZip && /wrong password|encrypted/iu.test((failure.stderr ?? "").toString())
    ? new ScanError("encrypted-archive", "the archive listing needs a password")
    : new ScanError("unlistable", `the lister exited with status ${failure.code}`);
}

/** The child-process runner the hosted listers use; tests pass their own. */
export type Runner = typeof run;

export const hostedDependencies = (token?: string, exec: Runner = run): ScanDependencies => ({
  async releases(target, stopAt) {
    if (target.provider === "github") {
      const list = (await json(
        `https://api.github.com/repos/${target.repository}/releases?per_page=10`,
        token,
        stopAt,
      )) as Record<string, unknown>[];
      return list.map((release) => ({
        tag: String(release.tag_name),
        draft: Boolean(release.draft),
        prerelease: Boolean(release.prerelease),
        assets: ((release.assets as Record<string, unknown>[]) ?? []).map((asset) => ({
          name: String(asset.name),
          url: String(asset.browser_download_url),
          size: typeof asset.size === "number" ? asset.size : null,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
      }));
    }
    const list = (await json(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(target.repository)}/releases?per_page=10`,
      undefined,
      stopAt,
    )) as Record<string, unknown>[];
    return list.map((release) => ({
      tag: String(release.tag_name),
      draft: false,
      prerelease: Boolean(release.upcoming_release),
      assets: (
        ((release.assets as Record<string, unknown>)?.links as Record<string, unknown>[]) ?? []
      ).map((link) => ({
        name: String(link.name),
        url: String(link.direct_asset_url ?? link.url),
        size: null,
        digest: null,
      })),
    }));
  },
  async download(asset, file, maxBytes, stopAt) {
    await exec(
      "curl",
      [
        "-fsSL",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-filesize",
        String(maxBytes),
        "-o",
        file,
        asset.url,
      ],
      { timeout: callTimeout(15 * 60_000, stopAt) },
    ).catch((error: unknown) => {
      const failure = error as ChildFailure;
      throw failure.code === CURL_FILESIZE_EXCEEDED && !failure.killed && !failure.signal
        ? new ScanError("asset-too-large", `the transfer exceeds ${maxBytes} bytes`)
        : error;
    });
  },
  async list(file, name, stopAt) {
    const lower = name.toLowerCase();
    const timeout = callTimeout(TOOL_TIMEOUT_MS, stopAt);
    if (lower.endsWith(".appimage")) {
      const offset = await squashfsOffset(file);
      const { stdout } = await exec("unsquashfs", ["-o", String(offset), "-lls", file], {
        timeout,
      }).catch((error: unknown) => {
        throw listerFailure(error);
      });
      return parseUnsquashfs(String(stdout));
    }
    if (/\.(tar\.gz|tgz|tar\.xz|txz)$/.test(lower)) {
      const { stdout } = await exec("tar", ["-tvf", file], { timeout }).catch((error: unknown) => {
        throw listerFailure(error);
      });
      return parseTarVerbose(String(stdout));
    }
    // A dummy password makes encrypted archives fail instead of waiting for input.
    const { stdout } = await exec("7z", ["l", "-ba", "-slt", "-pportcove-scan", "--", file], {
      timeout,
    }).catch((error: unknown) => {
      throw listerFailure(error, true);
    });
    return parse7zTechnical(String(stdout));
  },
  async heads(file, name, entries, stopAt) {
    const lower = name.toLowerCase();
    const heads = new Map<string, Buffer>();
    const offset = lower.endsWith(".appimage") ? String(await squashfsOffset(file)) : "";
    for (const entry of entries) {
      if (Date.now() >= stopAt) break;
      const member = entry.member ?? entry.path;
      if (!safeMember(member)) continue;
      let args: [string, string[]];
      // --occurrence=1 stops at the member instead of decompressing the rest of the stream.
      if (/\.(tar\.gz|tgz|tar\.xz|txz)$/.test(lower))
        args = ["tar", ["-xOf", file, "--occurrence=1", "--", member]];
      else if (offset) args = ["unsquashfs", ["-o", offset, "-cat", file, member]];
      else args = ["7z", ["e", "-so", "-pportcove-scan", "--", file, member]];
      try {
        const { stdout } = await exec(args[0], args[1], {
          timeout: callTimeout(TOOL_TIMEOUT_MS, stopAt),
          encoding: "buffer",
          maxBuffer: Math.max(entry.size, HEAD_BYTES) + 1024,
        });
        heads.set(entry.path, (stdout as unknown as Buffer).subarray(0, HEAD_BYTES));
      } catch {
        // An unreadable entry keeps its name-only judgement.
      }
    }
    return heads;
  },
});

/** The SquashFS image of an AppImage starts where its ELF section headers end. */
export async function squashfsOffset(file: string) {
  const handle = await open(file, "r");
  try {
    const elf = Buffer.alloc(64);
    await handle.read(elf, 0, 64, 0);
    if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2)
      throw new ScanError("unlistable", "not a 64-bit ELF AppImage");
    const offset =
      Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, offset);
    if (magic.toString("latin1") !== "hsqs") throw new ScanError("unlistable", "no SquashFS image");
    return offset;
  } finally {
    await handle.close();
  }
}

export function parse7zTechnical(text: string): PackageEntry[] {
  const entries: PackageEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const fields = new Map(
      block.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf(" = ");
        return at > 0 ? [[line.slice(0, at), line.slice(at + 3)] as const] : [];
      }),
    );
    const name = fields.get("Path");
    if (!name || fields.get("Folder") === "+") continue;
    entries.push({ path: name.replaceAll("\\", "/"), size: Number(fields.get("Size") ?? 0) });
  }
  return entries;
}

export function parseTarVerbose(text: string): PackageEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^-\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line))
    .flatMap((match) =>
      match?.[2]
        ? [{ path: match[2].replace(/^\.\//, ""), size: Number(match[1]), member: match[2] }]
        : [],
    );
}

export function parseUnsquashfs(text: string): PackageEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^-\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+squashfs-root\/(.+)$/.exec(line))
    .flatMap((match) => (match?.[2] ? [{ path: match[2], size: Number(match[1]) }] : []));
}

/** Job-summary text: findings first, then coverage. */
export function summaryMarkdown(report: ScanReport) {
  const lines = ["## Release content scan", ""];
  lines.push(
    `Scanned ${report.scanned.length} new package(s); ${report.reused} already scanned; ${report.unscanned.length} not scanned.`,
    "",
  );
  const line = (finding: ScanFinding) =>
    `- \`${finding.id}\` (${finding.platform}) ${finding.tag} \`${finding.asset}\`: ${finding.signals
      .map((signal) => `${signal.path} (${signal.reason})`)
      .join("; ")}${moreSignals(finding)}`;
  const review = report.findings.filter((finding) => !finding.accounted);
  const accounted = report.findings.filter((finding) => finding.accounted);
  if (review.length) {
    lines.push("### Game-data signals to review", "");
    for (const finding of review) lines.push(line(finding));
    lines.push("");
  } else lines.push("No game-data signals to review.", "");
  if (accounted.length) {
    lines.push("### Accounted signals (reviewed false positives)", "");
    for (const finding of accounted)
      lines.push(
        `${line(finding)} — accounted: ${finding.accounted!.reason} (${finding.accounted!.evidence})`,
      );
    lines.push("");
  }
  if (report.accounting_unmatched.length) {
    lines.push("### Accounting entries no finding matched", "");
    lines.push(
      "Stale, or their target was not reached in this run; remove a stale entry in a reviewed change.",
      "",
    );
    for (const entry of report.accounting_unmatched)
      lines.push(
        `- \`${entry.port_id}\` (${entry.platform}) sha256 \`${entry.sha256}\` rules ${entry.rules}`,
      );
    lines.push("");
  }
  const partial = report.scanned.filter((record) => record.heads_unread || record.heads_truncated);
  if (partial.length) {
    lines.push("### Partly read packages", "");
    for (const record of partial)
      lines.push(
        `- \`${record.id}\` (${record.platform}) \`${record.asset}\`: ${record.heads_unread} candidate file(s) unread${record.heads_truncated ? "; candidate list cut at 64" : ""}`,
      );
    lines.push("");
  }
  if (report.unscanned.length) {
    lines.push("### Not scanned", "");
    for (const entry of report.unscanned)
      lines.push(`- \`${entry.id}\` (${entry.platform}): ${entry.reason}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** " (and N more)" when a record's signals were cut at the cap. */
export const moreSignals = (record: Pick<ScanRecord, "signals" | "signal_count">) =>
  record.signal_count > record.signals.length
    ? ` (and ${record.signal_count - record.signals.length} more)`
    : "";

/** Workflow-command data escaping, so upstream names cannot form commands. */
export const escapeCommand = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

// ---- Command line -----------------------------------------------------------

/**
 * The checkpoint's scanned records, remembered failures and unlistable retries
 * under the current rules. A checkpoint written before a field existed loads
 * without it.
 */
export async function readCheckpoint(file: string | undefined) {
  const records = new Map<string, ScanRecord>();
  const failures = new Map<string, ScanFailure>();
  const retries = new Map<string, number>();
  if (!file || file === "-") return { records, failures, retries };
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      records?: ScanRecord[];
      failures?: ScanFailure[];
      retries?: { key?: unknown; rules?: unknown; checked_at?: unknown }[];
    };
    for (const retry of stored.retries ?? [])
      if (
        typeof retry.key === "string" &&
        retry.key.startsWith(`r${RULES_VERSION}|`) &&
        retry.rules === RULES_VERSION
      )
        // A retry written before rotation counts as never re-checked.
        retries.set(
          retry.key,
          Number.isSafeInteger(retry.checked_at) && (retry.checked_at as number) >= 0
            ? (retry.checked_at as number)
            : 0,
        );
    for (const record of stored.records ?? [])
      if (record.rules === RULES_VERSION) {
        // Only the reviewed accounting file dismisses a finding, never a cached record.
        const { accounted: _accounted, ...plain } = record as ScanFinding;
        records.set(record.key, plain);
      }
    for (const failure of stored.failures ?? [])
      if (
        typeof failure.key === "string" &&
        failure.key.startsWith(`r${RULES_VERSION}|`) &&
        RECORDED_FAILURES.includes(failure.code) &&
        Number.isSafeInteger(failure.max_asset_bytes)
      )
        failures.set(failure.key, failure);
  } catch {
    // A missing or unreadable checkpoint scans from scratch.
  }
  return { records, failures, retries };
}

export async function main(argv: string[]) {
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  if (argv[0] === "summary" && option("--report")) {
    const report = JSON.parse(await readFile(option("--report")!, "utf8")) as ScanReport;
    process.stdout.write(summaryMarkdown(report));
    return;
  }
  if (argv[0] === "annotations" && option("--report")) {
    const report = JSON.parse(await readFile(option("--report")!, "utf8")) as ScanReport;
    // A reviewed, accounted finding is listed in the summary but raises no warning.
    for (const finding of report.findings.filter((entry) => !entry.accounted))
      process.stdout.write(
        `::warning title=Release content scan::${escapeCommand(`${finding.id} ${finding.tag} ${finding.asset}: ${finding.signals.map((signal) => signal.reason).join("; ")}`)}\n`,
      );
    return;
  }
  if (argv[0] !== "scan" || !option("--listings") || !option("--output")) {
    process.stderr.write(
      "Usage: node scripts/release-content-scan.mts scan --listings <listings.json> --checkpoint <file|-> [--checkpoint-out <file>] --output <report.json> [--accounting <file>] [--max-assets N] [--max-asset-bytes N] [--max-total-bytes N] [--minutes N] [--max-retry-assets N] [--max-retry-bytes N]\n       node scripts/release-content-scan.mts summary|annotations --report <report.json>\n",
    );
    process.exit(2);
  }
  const listings = JSON.parse(await readFile(option("--listings")!, "utf8")) as unknown;
  const targets = scanTargets(listings);
  // An invalid accounting file fails the scan; it is never read as no accounting.
  const accounting = option("--accounting")
    ? readAccounting(JSON.parse(await readFile(option("--accounting")!, "utf8")), listings)
    : [];
  const { records: previous, failures, retries } = await readCheckpoint(option("--checkpoint"));
  const numeric = (name: string) => {
    const value = option(name);
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error(`${name} needs a positive whole number`);
    return number;
  };
  // A listings file without targets would read as a complete scan of nothing.
  if (!targets.length) throw new Error("The listings offer no scan targets");
  const {
    report,
    checkpoint,
    failures: nextFailures,
    retries: nextRetries,
  } = await scan(targets, previous, hostedDependencies(process.env.GH_TOKEN), {
    maxAssets: numeric("--max-assets"),
    maxAssetBytes: numeric("--max-asset-bytes"),
    maxTotalBytes: numeric("--max-total-bytes"),
    // Leave time to write the report and checkpoint before the job timeout.
    deadline: Date.now() + (numeric("--minutes") ?? 75) * 60_000,
    failures,
    retries,
    maxRetryAssets: numeric("--max-retry-assets"),
    maxRetryBytes: numeric("--max-retry-bytes"),
    accounting,
  });
  await writeFile(option("--output")!, `${JSON.stringify(report, null, 2)}\n`);
  if (option("--checkpoint-out"))
    await writeFile(
      option("--checkpoint-out")!,
      `${JSON.stringify(
        {
          format_version: 1,
          records: [...checkpoint.values()],
          failures: [...nextFailures.values()],
          retries: [...nextRetries].map(([key, checked_at]) => ({
            key,
            rules: RULES_VERSION,
            checked_at,
          })),
        },
        null,
        2,
      )}\n`,
    );
  process.stdout.write(
    `${JSON.stringify({ targets: targets.length, scanned: report.scanned.length, reused: report.reused, findings: report.findings.length, unscanned: report.unscanned.length })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
