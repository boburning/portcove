import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observationHash } from "./upstream-observer.mjs";
import { withCheckpointLock } from "./observe-configured-upstream.mjs";

// Collection/change-detection state only. No network, issue writes or planning fields.
export const emptyCheckpoint = () => ({
  format: 1,
  sources: {},
  pending: {},
  receipts: {},
  checked: {},
});
const clock = (value) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("An explicit observation clock is required");
  return Date.parse(value);
};

export function investigationWindow(lastSuccess, now, overlapHours = 48, baselineDays = 14) {
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
export function releaseFingerprint(releases) {
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

export function advanceDiscovery(state, run) {
  if (state.format !== 1) throw new Error("Unsupported discovery checkpoint");
  clock(run.observed_at);
  const next = structuredClone(state);
  const seen = new Set();
  for (const source of run.sources) {
    if (!/^[a-z0-9-]{1,80}$/u.test(source.id) || seen.has(source.id))
      throw new Error("Invalid or duplicate source identity");
    seen.add(source.id);
    // A partial read can supply leads, but never replaces the last complete baseline.
    if (source.status !== "complete") continue;
    if (
      !source.evidence ||
      source.next_page !== null ||
      source.truncated !== false ||
      !Array.isArray(source.records)
    )
      throw new Error("Complete source requires evidence and terminal pagination");
    if (source.records.length > 2000) throw new Error("Source record budget exceeded");
    const previous = state.sources[source.id];
    if (previous && clock(previous.completed_at) > clock(run.observed_at))
      throw new Error("Observation predates successful checkpoint");
    const hashes = {};
    for (const record of source.records) {
      if (
        typeof record.key !== "string" ||
        !/^[a-zA-Z0-9:/_.-]{1,240}$/u.test(record.key) ||
        Object.hasOwn(hashes, record.key)
      )
        throw new Error("Invalid or duplicate observation key");
      if (!/^[a-f0-9]{64}$/u.test(record.fingerprint))
        throw new Error("Invalid observation fingerprint");
      Object.defineProperty(hashes, record.key, { value: record.fingerprint, enumerable: true });
      if (previous?.hashes[record.key] !== record.fingerprint) {
        const key = observationHash({
          source: source.id,
          key: record.key,
          fingerprint: record.fingerprint,
        });
        if (!Object.hasOwn(next.receipts, key))
          next.pending[key] = {
            source: source.id,
            key: record.key,
            fingerprint: record.fingerprint,
            observed_at: run.observed_at,
          };
      }
    }
    // Disappearance is a lead, never a removal or automatic issue mutation.
    for (const key of Object.keys(previous?.hashes ?? {})) {
      if (!Object.hasOwn(hashes, key)) {
        const id = observationHash({
          source: source.id,
          key,
          absent: true,
          previous: previous.hashes[key],
        });
        if (!Object.hasOwn(next.receipts, id))
          next.pending[id] = {
            source: source.id,
            key,
            absent: true,
            observed_at: run.observed_at,
          };
      }
    }
    next.sources[source.id] = { completed_at: run.observed_at, evidence: source.evidence, hashes };
  }
  if (Object.keys(next.pending).length > 10000)
    throw new Error("Pending budget exceeded; retain old checkpoint and resume");
  return next;
}

export function recordDisposition(state, id, receipt) {
  if (!Object.hasOwn(state.pending, id)) throw new Error("Unknown pending observation");
  if (
    !["no-change", "updated", "intake-complete", "held", "recommendation"].includes(
      receipt.outcome,
    ) ||
    !receipt.evidence
  )
    throw new Error("Disposition requires an outcome and evidence");
  if (
    ["updated", "intake-complete"].includes(receipt.outcome) &&
    (!receipt.issue || !receipt.readback)
  )
    throw new Error("Mutation disposition requires canonical issue and readback evidence");
  const next = structuredClone(state);
  next.receipts[id] = receipt;
  delete next.pending[id];
  return next;
}

export function rotatingRecheck(issues, checked, now, limit = 50) {
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
async function main(args) {
  if (args.length !== 3 || !["plan", "apply"].includes(args[0]))
    throw new Error("usage: discovery-checkpoint.mjs plan|apply STATE_FILE RUN_FILE");
  const [, statePath, runPath] = args;
  const run = JSON.parse(await readFile(runPath, "utf8"));
  const load = async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return emptyCheckpoint();
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
    console.error(error.message);
    process.exitCode = 1;
  });
