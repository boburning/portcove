import { isRecord, errorCode, errorMessage } from "./runtime-values.mts";
interface SuccessfulSource {
  completed_at: string;
  evidence: string;
  hashes: Record<string, string>;
  snapshot_kind?: "rolling-feed";
}
interface PendingObservation {
  source: string;
  key: string;
  observed_at: string;
  fingerprint?: string;
  absent?: true;
}
export type DispositionOutcome =
  | "no-change"
  | "updated"
  | "intake-complete"
  | "held"
  | "recommendation";
export interface DispositionReceipt {
  outcome: DispositionOutcome;
  evidence: string;
  issue?: number;
  readback?: string;
}
export interface DiscoveryCheckpoint {
  format: 1;
  sources: Record<string, SuccessfulSource>;
  pending: Record<string, PendingObservation>;
  receipts: Record<string, DispositionReceipt>;
  checked: Record<string, string>;
  checked_revisions?: Record<string, string>;
}
interface DiscoveryRun {
  observed_at: string;
  sources: unknown[];
  expected_checkpoint_sha256?: string;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be nonempty text`);
  return value;
}
function stringMap(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([key, item]) => [key, text(item, label)]),
  );
}
function disposition(value: unknown): DispositionReceipt {
  const receipt = object(value, "Disposition");
  const outcome = receipt.outcome;
  if (
    outcome !== "no-change" &&
    outcome !== "updated" &&
    outcome !== "intake-complete" &&
    outcome !== "held" &&
    outcome !== "recommendation"
  )
    throw new Error("Disposition requires an outcome and evidence");
  const evidence = text(receipt.evidence, "Disposition evidence");
  const parsed: DispositionReceipt = { ...receipt, outcome, evidence };
  if (receipt.issue !== undefined) {
    if (
      typeof receipt.issue !== "number" ||
      !Number.isSafeInteger(receipt.issue) ||
      receipt.issue <= 0
    )
      throw new Error("Disposition requires a canonical issue ID");
    parsed.issue = receipt.issue;
  }
  if (receipt.readback !== undefined)
    parsed.readback = text(receipt.readback, "Disposition readback");
  if (
    (outcome === "updated" || outcome === "intake-complete") &&
    (!parsed.issue || !parsed.readback)
  )
    throw new Error("Mutation disposition requires canonical issue and readback evidence");
  return parsed;
}
function checkpoint(value: unknown): DiscoveryCheckpoint {
  const state = object(value, "Discovery checkpoint");
  if (state.format !== 1) throw new Error("Unsupported discovery checkpoint");
  const sources = Object.fromEntries(
    Object.entries(object(state.sources, "Checkpoint sources")).map(([id, value]) => {
      const source = object(value, "Checkpoint source");
      const completed_at = text(source.completed_at, "Checkpoint completion");
      clock(completed_at);
      if (source.snapshot_kind !== undefined && source.snapshot_kind !== "rolling-feed")
        throw new Error("Invalid checkpoint snapshot kind");
      return [
        id,
        {
          ...source,
          completed_at,
          evidence: text(source.evidence, "Checkpoint source evidence"),
          hashes: stringMap(source.hashes, "Checkpoint hashes"),
          ...(source.snapshot_kind === "rolling-feed"
            ? { snapshot_kind: "rolling-feed" as const }
            : {}),
        },
      ];
    }),
  );
  const pending = Object.fromEntries(
    Object.entries(object(state.pending, "Checkpoint pending")).map(
      ([id, value]): [string, PendingObservation] => {
        const item = object(value, "Pending observation");
        const parsed: PendingObservation = {
          ...item,
          source: text(item.source, "Pending source"),
          key: text(item.key, "Pending key"),
          observed_at: text(item.observed_at, "Pending observation clock"),
        };
        clock(parsed.observed_at);
        if (item.fingerprint !== undefined)
          parsed.fingerprint = text(item.fingerprint, "Pending fingerprint");
        if (item.absent !== undefined) {
          if (item.absent !== true) throw new Error("Pending absence must be true");
          parsed.absent = true;
        }
        return [id, parsed];
      },
    ),
  );
  const receipts = Object.fromEntries(
    Object.entries(object(state.receipts, "Checkpoint receipts")).map(([id, receipt]) => [
      id,
      disposition(receipt),
    ]),
  );
  const checked = stringMap(state.checked, "Checkpoint checked");
  Object.values(checked).forEach(clock);
  const revisions =
    state.checked_revisions === undefined
      ? undefined
      : stringMap(state.checked_revisions, "Checkpoint checked revisions");
  if (revisions && Object.values(revisions).some((hash) => !/^[a-f0-9]{64}$/u.test(hash)))
    throw new Error("Invalid checked revision binding");
  return {
    ...state,
    format: 1,
    sources,
    pending,
    receipts,
    checked,
    ...(revisions ? { checked_revisions: revisions } : {}),
  };
}
function discoveryRun(value: unknown): DiscoveryRun {
  const run = object(value, "Discovery run");
  const observed_at = text(run.observed_at, "Observation clock");
  clock(observed_at);
  if (!Array.isArray(run.sources)) throw new Error("Discovery sources must be an array");
  const sources: unknown[] = run.sources;
  const parsed: DiscoveryRun = { ...run, observed_at, sources };
  if (run.expected_checkpoint_sha256 !== undefined)
    parsed.expected_checkpoint_sha256 = text(run.expected_checkpoint_sha256, "Checkpoint preimage");
  return parsed;
}
export const parseDiscoveryCheckpoint = checkpoint;
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observationHash } from "./upstream-observer.mts";
import { withCheckpointLock } from "./observe-configured-upstream.mts";

// Collection/change-detection state only. No network, issue writes or planning fields.
export const emptyCheckpoint = (): DiscoveryCheckpoint => ({
  format: 1,
  sources: {},
  pending: {},
  receipts: {},
  checked: {},
});
const clock = (value: unknown) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("An explicit observation clock is required");
  return Date.parse(value);
};

export function investigationWindow(
  lastSuccess: string | null | undefined,
  now: string,
  overlapHours = 48,
  baselineDays = 14,
) {
  const end = clock(now);
  if (lastSuccess && clock(lastSuccess) > end) throw new Error("Checkpoint is in the future");
  return {
    since: new Date(
      lastSuccess ? clock(lastSuccess) - overlapHours * 3600000 : end - baselineDays * 86400000,
    ).toISOString(),
    until: now,
  };
}

// Include all reviewed channels. Ignore prose/counters, but never ignore replaced bytes or retags.
interface ReleaseAssetObservation {
  id: number;
  name: string | null | undefined;
  size: number;
  digest: string | null | undefined;
  created_at: string | null | undefined;
  updated_at: string | null | undefined;
  browser_download_url: string | null | undefined;
}
interface ReleaseObservation {
  id: number;
  tag_name: string | null | undefined;
  resolved_tag_commit: string | null | undefined;
  target_commitish: string | null | undefined;
  draft: boolean | undefined;
  prerelease: boolean | undefined;
  published_at: string | null | undefined;
  updated_at: string | null | undefined;
  assets: ReleaseAssetObservation[];
}
function optionalText(value: unknown, label: string): string | null | undefined {
  if (value !== null && value !== undefined && typeof value !== "string")
    throw new Error(`${label} must be text or absent`);
  return value;
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${label} must be boolean or absent`);
  return value;
}
export function releaseFingerprint(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Release observations must be an array");
  const releases = (value as unknown[]).map((item): ReleaseObservation => {
    const release = object(item, "Release observation");
    if (typeof release.id !== "number" || !Number.isSafeInteger(release.id) || release.id <= 0)
      throw new Error("Invalid observed release ID");
    if (!Array.isArray(release.assets)) throw new Error("Release assets must be an array");
    const assets = (release.assets as unknown[]).map((item): ReleaseAssetObservation => {
      const asset = object(item, "Release asset observation");
      if (typeof asset.id !== "number" || !Number.isSafeInteger(asset.id) || asset.id <= 0)
        throw new Error("Invalid observed asset ID");
      if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 0)
        throw new Error("Invalid observed asset size");
      return {
        ...asset,
        id: asset.id,
        name: optionalText(asset.name, "Asset name"),
        size: asset.size,
        digest: optionalText(asset.digest, "Asset digest"),
        created_at: optionalText(asset.created_at, "Asset creation"),
        updated_at: optionalText(asset.updated_at, "Asset update"),
        browser_download_url: optionalText(asset.browser_download_url, "Asset URL"),
      };
    });
    return {
      ...release,
      id: release.id,
      assets,
      tag_name: optionalText(release.tag_name, "Release tag"),
      resolved_tag_commit: optionalText(release.resolved_tag_commit, "Resolved tag commit"),
      target_commitish: optionalText(release.target_commitish, "Release target"),
      draft: optionalBoolean(release.draft, "Release draft"),
      prerelease: optionalBoolean(release.prerelease, "Release prerelease"),
      published_at: optionalText(release.published_at, "Release publication"),
      updated_at: optionalText(release.updated_at, "Release update"),
    };
  });
  return observationHash(
    releases
      .map((release) => ({
        id: release.id,
        tag: release.tag_name,
        target: release.resolved_tag_commit ?? null,
        target_hint: release.target_commitish,
        draft: release.draft,
        prerelease: release.prerelease,
        published: release.published_at,
        updated: release.updated_at,
        assets: release.assets
          .map((asset) => ({
            id: asset.id,
            name: asset.name,
            size: asset.size,
            digest: asset.digest,
            created: asset.created_at,
            updated: asset.updated_at,
            url: asset.browser_download_url,
          }))
          .sort((a, b) => a.id - b.id),
      }))
      .sort((a, b) => a.id - b.id),
  );
}

export function advanceDiscovery(stateValue: unknown, runValue: unknown): DiscoveryCheckpoint {
  const state = checkpoint(stateValue),
    run = discoveryRun(runValue);
  clock(run.observed_at);
  const next = structuredClone(state);
  const seen = new Set();
  for (const rawSource of run.sources) {
    const source = object(rawSource, "Discovery source");
    const sourceId = text(source.id, "Discovery source ID");
    if (!/^[a-z0-9-]{1,80}$/u.test(sourceId) || seen.has(sourceId))
      throw new Error("Invalid or duplicate source identity");
    seen.add(sourceId);
    // A rolling feed with a continuity gap still supplies positive leads, but
    // never replaces its last complete baseline or successful clock.
    const partialStream = source.status === "partial" && source.snapshot_kind === "rolling-feed";
    if (source.status !== "complete" && !partialStream) continue;
    if (
      !source.evidence ||
      source.next_page !== null ||
      source.truncated !== false ||
      !Array.isArray(source.records)
    )
      throw new Error("Complete source requires evidence and terminal pagination");
    if (source.records.length > 2000) throw new Error("Source record budget exceeded");
    if (source.snapshot_kind !== undefined && source.snapshot_kind !== "rolling-feed")
      throw new Error("Invalid source snapshot kind");
    const previous = Object.hasOwn(state.sources, sourceId) ? state.sources[sourceId] : undefined;
    if (previous && previous.snapshot_kind !== source.snapshot_kind)
      throw new Error("Source scope changed; reconcile the old checkpoint explicitly");
    if (previous && clock(previous.completed_at) > clock(run.observed_at))
      throw new Error("Observation predates successful checkpoint");
    const hashes: Record<string, string> = {};
    const records: unknown[] = source.records;
    for (const rawRecord of records) {
      const record = object(rawRecord, "Observation record");
      if (
        typeof record.key !== "string" ||
        !/^[a-zA-Z0-9:/_.-]{1,240}$/u.test(record.key) ||
        Object.hasOwn(hashes, record.key)
      )
        throw new Error("Invalid or duplicate observation key");
      if (typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.fingerprint))
        throw new Error("Invalid observation fingerprint");
      Object.defineProperty(hashes, record.key, { value: record.fingerprint, enumerable: true });
      if (previous?.hashes[record.key] !== record.fingerprint) {
        const key = observationHash({
          source: sourceId,
          key: record.key,
          fingerprint: record.fingerprint,
        });
        if (!Object.hasOwn(next.receipts, key))
          next.pending[key] = {
            source: sourceId,
            key: record.key,
            fingerprint: record.fingerprint,
            observed_at: run.observed_at,
          };
      }
    }
    if (partialStream) continue;
    // Disappearance is a lead, never a removal or automatic issue mutation.
    for (const key of source.snapshot_kind === "rolling-feed"
      ? []
      : Object.keys(previous?.hashes ?? {})) {
      if (!Object.hasOwn(hashes, key)) {
        const id = observationHash({
          source: sourceId,
          key,
          absent: true,
          previous: previous?.hashes[key],
        });
        if (!Object.hasOwn(next.receipts, id))
          next.pending[id] = {
            source: sourceId,
            key,
            absent: true,
            observed_at: run.observed_at,
          };
      }
    }
    next.sources[sourceId] = {
      completed_at: run.observed_at,
      evidence: text(source.evidence, "Source evidence"),
      hashes: source.snapshot_kind === "rolling-feed" ? { ...previous?.hashes, ...hashes } : hashes,
      ...(source.snapshot_kind === "rolling-feed" ? { snapshot_kind: "rolling-feed" } : {}),
    };
    if (Object.keys(next.sources[sourceId].hashes).length > 10000)
      throw new Error("Rolling source identity capacity exceeded; retain old checkpoint");
  }
  if (Object.keys(next.pending).length > 10000)
    throw new Error("Pending budget exceeded; retain old checkpoint and resume");
  return next;
}

export function recordDisposition(
  stateValue: unknown,
  id: string,
  receiptValue: unknown,
): DiscoveryCheckpoint {
  const state = checkpoint(stateValue);
  if (!Object.hasOwn(state.pending, id)) throw new Error("Unknown pending observation");
  const receipt = disposition(receiptValue);
  const next = structuredClone(state);
  next.receipts[id] = receipt;
  delete next.pending[id];
  return next;
}

export function rotatingRecheck(
  issues: readonly number[],
  checked: Readonly<Record<string, string>>,
  now: string,
  limit = 50,
) {
  clock(now);
  const unique = [...new Set(issues)];
  if (!unique.every((id) => Number.isSafeInteger(id) && id > 0))
    throw new Error("Invalid canonical issue IDs");
  const ordered = unique.sort(
    (a, b) => (checked[a] ? clock(checked[a]) : 0) - (checked[b] ? clock(checked[b]) : 0) || a - b,
  );
  return {
    selected: ordered.slice(0, limit),
    overdue: ordered.filter((id) => !checked[id] || clock(now) - clock(checked[id]) > 7 * 86400000),
  };
}

// The CLI advances collection state only, with an exact preimage and the existing owned-path lock.
// Research/disposition receipts are supplied by the investigator, never inferred from external text.
async function main(args: string[]) {
  if (args.length !== 3 || !["plan", "apply"].includes(args[0] ?? ""))
    throw new Error("usage: discovery-checkpoint.mts plan|apply STATE_FILE RUN_FILE");
  const [, statePath, runPath] = args;
  if (!statePath || !runPath) throw new Error("Checkpoint paths are required");
  const run = discoveryRun(JSON.parse(await readFile(runPath, "utf8")));
  const load = async () => {
    try {
      return checkpoint(JSON.parse(await readFile(statePath, "utf8")));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyCheckpoint();
      throw error;
    }
  };
  const before = await load();
  const next = advanceDiscovery(before, run);
  if (args[0] === "apply")
    await withCheckpointLock(path.resolve(statePath), async () => {
      if (observationHash(await load()) !== run.expected_checkpoint_sha256)
        throw new Error("Checkpoint changed; refresh preimage");
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(`${statePath}.next`, JSON.stringify(next, null, 2), { flag: "wx" });
      await rename(`${statePath}.next`, statePath);
    });
  console.log(JSON.stringify({ checkpoint_sha256: observationHash(before), next, mode: args[0] }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
