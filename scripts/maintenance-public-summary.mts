import { createHash } from "node:crypto";
import path from "node:path";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord } from "./runtime-values.mts";

const unknown = "unknown";
const hourMs = 3_600_000;
const title = "## Managed release operations";

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function utc(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(value)
  )
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const record = (raw: unknown): Record<string, unknown> => (isRecord(raw) ? raw : {});
const hours = (ms: number | null) => (ms === null ? unknown : `${(ms / hourMs).toFixed(1)} h`);

function bySource(raw: unknown, source: string) {
  if (!Array.isArray(raw)) return {};
  const matches = raw.filter((entry) => isRecord(entry) && entry.source === source);
  return matches.length === 1 ? record(matches[0]) : {};
}

function upstreamGaps(raw: unknown) {
  if (!Array.isArray(raw)) return unknown;
  const buckets = { held: 0, unobserved: 0, "scope-changed": 0, unavailable: 0, other: 0 };
  for (const gap of raw) {
    const code = record(gap).code;
    switch (code) {
      case "held":
      case "unobserved":
      case "scope-changed":
      case "unavailable":
        buckets[code]++;
        break;
      default:
        buckets.other++;
    }
  }
  return `${raw.length} records, ${buckets.held} held, ${buckets.unobserved} unobserved, ${buckets["scope-changed"]} changed scope, ${buckets.unavailable} unavailable, ${buckets.other} other`;
}

function pendingReasonBuckets(raw: unknown, otherCount: unknown, withReason: number) {
  if (!Array.isArray(raw)) return unknown;
  const counts = new Map<string, number>();
  for (const entry of raw) {
    const { reason, distinct_candidates } = record(entry);
    const candidates = count(distinct_candidates);
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      counts.has(reason) ||
      candidates === null ||
      candidates > withReason
    )
      return unknown;
    counts.set(reason, candidates);
  }
  const missing = counts.get("asset-missing-or-ambiguous") ?? 0;
  counts.delete("asset-missing-or-ambiguous");
  const excluded = counts.get("reviewed-artifact-excluded") ?? 0;
  counts.delete("reviewed-artifact-excluded");
  // Earlier reports retain only marginal counts. More than one other reason
  // cannot yield a distinct union without the original candidate membership.
  const recordedOther = count(otherCount);
  const otherCandidates = [...counts.values()];
  let other: number | typeof unknown = unknown;
  if (otherCandidates.length <= 1) other = otherCandidates[0] ?? 0;
  else if (
    recordedOther !== null &&
    recordedOther <= withReason &&
    recordedOther <= otherCandidates.reduce((sum, candidates) => sum + candidates, 0) &&
    otherCandidates.every((candidates) => candidates <= recordedOther)
  )
    other = recordedOther;
  return `${missing} asset missing or ambiguous, ${excluded} excluded by reviewed artifact policy, and ${other} with other reasons`;
}

/** Only fixed labels, normalized UTC timestamps and numeric aggregates can leave this renderer. */
export function renderMaintenancePublicSummary(raw: unknown, rawUsage: unknown, digest: string) {
  const report = record(raw);
  const generated = utc(report.generated_at);
  if (
    report.format !== "portcove-maintenance-inventory" ||
    report.format_version !== 1 ||
    !generated
  )
    return `${title}\n\nReport metrics are unknown.\n`;

  const catalog = bySource(report.runs, "catalog-records");
  const upstream = bySource(report.runs, "upstream-observations");
  const freshness = bySource(report.freshness, "upstream-observations");
  const status =
    ["complete", "partial", "failed"].find((status) => status === upstream.coverage) ?? unknown;
  const expected = count(upstream.expected_count);
  const observed = count(upstream.observed_count);
  const observedScope =
    (status === "complete" || status === "partial") &&
    expected !== null &&
    observed !== null &&
    observed <= expected;
  const lastGood = utc(freshness.last_good_at);
  const sourceAge =
    lastGood !== null && lastGood <= generated
      ? Date.parse(generated) - Date.parse(lastGood)
      : null;

  const routes = record(report.managed_route_observation_coverage);
  const offered = count(routes.offered_managed_platforms);
  const fixed = count(routes.fixed_managed_platforms);
  const following = count(routes.offered_following_platforms);
  const verified = count(routes.platforms_with_candidate_observed);
  const retained = count(routes.platforms_with_retained_candidate);
  const routeScope =
    routes.target_scope_known === true &&
    offered !== null &&
    following !== null &&
    fixed !== null &&
    offered === following + fixed;
  const observedRoutes =
    routeScope &&
    routes.observer_membership_verified === true &&
    verified !== null &&
    verified <= following;
  const retainedRoutes =
    routeScope &&
    routes.observer_membership_verified === true &&
    retained !== null &&
    retained <= following;

  const window = record(report.managed_release_eligibility);
  const from = utc(window.from);
  const through = utc(window.through);
  const first = utc(window.first_recorded_evidence_at);
  const last = utc(window.last_recorded_evidence_at);
  const windowKnown =
    from !== null &&
    through === generated &&
    Date.parse(generated) - Date.parse(from) === 30 * 24 * hourMs;
  const hasEvidence =
    windowKnown &&
    first !== null &&
    last !== null &&
    from <= first &&
    first <= last &&
    last <= generated;
  const total = count(window.distinct_candidates);
  const eligible = count(window.eligible_candidates);
  const pending = count(window.pending_candidates);
  const reasonless = count(window.pending_without_recorded_hold_reason);
  const earlierPending = count(window.observed_pending_candidates);
  const moved = count(window.observed_pending_to_eligible_candidates);
  const known =
    hasEvidence &&
    total !== null &&
    eligible !== null &&
    pending !== null &&
    total === eligible + pending;
  const withReason =
    known && reasonless !== null && reasonless <= pending ? pending - reasonless : null;
  const lag = record(window.publication_to_recorded_eligibility_ms);
  const median = typeof lag.median === "number" && lag.median >= 0 ? lag.median : null;
  const maximum = count(lag.max);
  const samples = count(lag.samples);
  const lagKnown =
    known &&
    samples !== null &&
    samples > 0 &&
    samples <= eligible &&
    maximum !== null &&
    median !== null &&
    median <= maximum;

  const usage = record(rawUsage);
  const usageKnown =
    observedScope &&
    usage.format_version === 1 &&
    usage.kind === "maintenance-observer-operating-usage" &&
    usage.scope === "one-imported-observer-attempt" &&
    /^[a-f0-9]{64}$/u.test(digest) &&
    usage.inventory_sha256 === digest &&
    typeof upstream.source_revision === "string" &&
    /^upstream-observer-run:[1-9][0-9]{0,15}-[1-9][0-9]{0,8}@[a-f0-9]{40}#sha256:[a-f0-9]{64}$/u.test(
      upstream.source_revision,
    ) &&
    usage.source_revision === upstream.source_revision;
  const seconds = usage.observed_runner_seconds;
  const runnerSeconds =
    usageKnown && typeof seconds === "number" && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER
      ? seconds
      : unknown;

  return [
    title,
    "",
    `Report generated ${generated}.`,
    "",
    `- Catalog fleet has ${(catalog.coverage === "complete" ? count(catalog.observed_count) : null) ?? unknown} listings and ${(routes.catalog_collection_complete === true ? count(routes.operational_definitions) : null) ?? unknown} operational definitions.`,
    `- ${routeScope ? `${offered} managed platform offers, including ${following} release-following and ${fixed} fixed` : "Managed platform offer counts are unknown"}. ${observedRoutes ? `${verified} of ${following} following offers have an exact current candidate and ${following - verified} lack that evidence` : "Exact candidate coverage is unknown"}. ${retainedRoutes ? `${retained} have retained candidate evidence` : "Retained candidate coverage is unknown"}.`,
    `- Upstream collection is ${status}. Subject coverage is ${observedScope ? `${observed} of ${expected}` : unknown}. The last complete or partial maintenance collection was ${sourceAge === null ? unknown : lastGood}, aged ${hours(sourceAge)} at report generation. Actual observer execution age is unknown. Gap counts are ${upstreamGaps(upstream.gaps)}.`,
    `- Rolling 30-day window ${windowKnown ? `runs from ${from} to ${through}` : "is unknown"}. Retained observations ${hasEvidence ? `span ${first} to ${last}` : "are unknown"}.`,
    `- ${known ? `The observer recorded ${eligible} eligible of ${total} distinct managed candidates with a known release time in the window, with ${pending} still pending` : "Observer eligibility is unknown"}. Candidates without a known release time number ${(hasEvidence ? count(window.unknown_publication_times) : null) ?? unknown}.`,
    `- ${withReason !== null ? `${withReason} pending candidates have a recorded reason and ${reasonless} lack one` : "Pending reasons are unknown"}. Oldest pending age is ${hours(known ? count(window.oldest_pending_age_ms) : null)}. ${known && moved !== null && earlierPending !== null && moved <= earlierPending && earlierPending <= total ? `${moved} of ${earlierPending} candidates observed pending later recorded eligible` : "Pending-to-eligible count is unknown"}.`,
    `- Distinct pending candidates by reason are ${withReason === null ? unknown : pendingReasonBuckets(window.hold_reasons, window.pending_with_other_recorded_hold_reason, withReason)}. One candidate can appear in more than one reason category.`,
    `- Release-to-recorded-eligibility lag ${lagKnown ? `had a median of ${hours(median)}, a maximum of ${hours(maximum)}, and ${samples} samples` : "is unknown"}.`,
    `- The imported observer attempt accounts for ${runnerSeconds} measured runner seconds, ${(usageKnown ? count(usage.unmeasured_jobs) : null) ?? unknown} jobs without a measured duration, and ${(usageKnown ? count(record(usage.checkpoint).bytes) : null) ?? unknown} checkpoint bytes. Fleet resource use and billed cost are unknown.`,
    "- Released-client availability and release-to-availability lag are unknown. The operating target is at least 95% unattended availability over 30 days. Justified holds, false holds, human interventions per 100 candidates and per month, successful local resolutions, and signed automatic repairs are unknown.",
    "",
  ].join("\n");
}

async function readBytes(file: string, limit: number) {
  const absolute = path.resolve(file);
  return readBoundedPublicBuildInputFile(path.dirname(absolute), path.basename(absolute), limit);
}

const decode = (bytes: Buffer): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

if (import.meta.main) {
  try {
    const [input, usageFile, ...extra] = process.argv.slice(2);
    if (!input || extra.length) throw new Error();
    const report = await readBytes(input, 64 * 1024 * 1024);
    const usage = usageFile
      ? await readBytes(usageFile, 128 * 1024)
          .then(decode)
          .catch(() => null)
      : null;
    process.stdout.write(
      renderMaintenancePublicSummary(
        decode(report),
        usage,
        createHash("sha256").update(report).digest("hex"),
      ),
    );
  } catch {
    console.error("Public maintenance summary inventory could not be read");
    process.exitCode = 1;
  }
}
