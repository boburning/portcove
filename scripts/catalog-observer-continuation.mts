import { ObservationFailure } from "./upstream-observer.mts";
import { isRecord } from "./runtime-values.mts";
/** Core's typed statement of how completely one observation covered the
 * provider's pages and assets (`fact_provenance.coverage`). Core's GitHub
 * observation report always states it; "unstated" is a projection without it. */
export type CoreCoverage = "complete" | "partial" | "unavailable" | "failed" | "unstated";
const coreCoverageKinds: readonly string[] = ["complete", "partial", "unavailable", "failed"];
export function coreProjectionCoverage(projection: unknown): CoreCoverage {
  const provenance = isRecord(projection) ? projection.fact_provenance : null;
  const coverage = isRecord(provenance) ? provenance.coverage : null;
  if (!isRecord(coverage)) return "unstated";
  return typeof coverage.kind === "string" && coreCoverageKinds.includes(coverage.kind)
    ? (coverage.kind as CoreCoverage)
    : "failed";
}
/** Stated partial, unavailable or failed coverage never advances an accepted
 * cursor or replaces last-good facts: the caller keeps both and records
 * `incomplete-coverage`. A projection without a statement keeps its
 * existing acceptance rules. */
export function requireCompleteCoreCoverage(projection: unknown) {
  const coverage = coreProjectionCoverage(projection);
  if (coverage !== "complete" && coverage !== "unstated") {
    const failure = new ObservationFailure(
      "incomplete-coverage",
      `Core reported ${coverage} provider coverage; the accepted cursor and last-good facts are kept`,
    );
    failure.statedCoverage = coverage;
    throw failure;
  }
}
/**
 * The observer's own statement of how one source's attempt covered its
 * provider, using Core's coverage vocabulary. `rule` is the recorded exception
 * rule; `retry_at` is present only when the provider (or its quota reserve)
 * named the earliest retry time; `next_cursor` is the retained continuation
 * position the next run resumes from (null when the attempt restarts).
 * Complete coverage is never stated here: a complete source omits the field.
 */
export type StatedSourceCoverage =
  | { kind: "partial"; rule: string; next_cursor: string | null; retry_at?: string }
  | { kind: "unavailable"; rule: string; retry_at?: string }
  | { kind: "failed"; rule: string; retry_at?: string };
/**
 * Stopped with retained progress: our own budget, cancellation or a changed
 * collection. A truncated page is stated `partial` by its producer
 * (`partialObservationFailure`); every other `pagination` or
 * `provider-pagination` failure (malformed or escaping links, repeated
 * identities, page mismatches) is an integrity failure and states `failed`.
 */
const partialCoverageRules: readonly string[] = ["budget", "cancelled", "concurrent-change"];
/** The provider declined or could not answer: quota, Retry-After, outage or transport. */
const unavailableCoverageRules: readonly string[] = [
  "rate-limit",
  "provider-quota",
  "transport",
  "provider-transport",
];
const statusRules: readonly string[] = ["provider-status", "provider-http"];
export function statedSourceCoverage(
  error: unknown,
  nextCursor: string | null = null,
): StatedSourceCoverage {
  const failure = error instanceof ObservationFailure ? error : null;
  const rule = failure?.rule ?? "source-operation-failed";
  const retry =
    failure?.retryAt && Number.isFinite(Date.parse(failure.retryAt))
      ? { retry_at: failure.retryAt }
      : {};
  const status = failure?.httpStatus ?? null;
  const kind =
    failure?.statedCoverage ??
    (partialCoverageRules.includes(rule)
      ? "partial"
      : unavailableCoverageRules.includes(rule) ||
          (statusRules.includes(rule) && status !== null && (status >= 500 || status === 408))
        ? "unavailable"
        : "failed");
  return kind === "partial"
    ? { kind, rule, next_cursor: nextCursor, ...retry }
    : { kind, rule, ...retry };
}
/** Bounded validation for a retained statement; absent means complete or unattempted. */
export function validStatedSourceCoverage(value: unknown): value is StatedSourceCoverage {
  if (!isRecord(value)) return false;
  const allowed =
    value.kind === "partial"
      ? ["kind", "rule", "next_cursor", "retry_at"]
      : ["kind", "rule", "retry_at"];
  return (
    ["partial", "unavailable", "failed"].includes(String(value.kind)) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    typeof value.rule === "string" &&
    /^[a-z-]{1,80}$/u.test(value.rule) &&
    (value.kind !== "partial" ||
      value.next_cursor === null ||
      (typeof value.next_cursor === "string" && /^[a-z0-9:-]{1,80}$/u.test(value.next_cursor))) &&
    (value.retry_at === undefined ||
      (typeof value.retry_at === "string" && Number.isFinite(Date.parse(value.retry_at))))
  );
}
/** Retained resume position of a GitHub observation continuation. */
export function continuationCursor(continuation: unknown): string | null {
  if (!isRecord(continuation) || continuation.phase === "restart") return null;
  if (continuation.phase === "validate" && typeof continuation.validation_cursor === "number")
    return `validate:${continuation.validation_cursor}`;
  return continuation.phase === "collect" && isRecord(continuation.pages)
    ? `collect:${Object.keys(continuation.pages).length}`
    : null;
}
/** Retained resume position of GitLab or direct-manifest provider progress. */
export function providerProgressCursor(progress: unknown): string | null {
  if (!isRecord(progress) || !Array.isArray(progress.reads)) return null;
  return `reads:${progress.reads.length}:validate:${typeof progress.validation_cursor === "number" ? progress.validation_cursor : 0}`;
}
/** Releases whose assets one Core channel projection needs: its channel
 * candidate and, when that candidate is excluded, its reviewed fallback. */
export function projectionAssetReleaseIds(projection: unknown): number[] {
  if (!isRecord(projection)) return [];
  return [projection.channel_candidate, projection.reviewed_fallback].flatMap((release) =>
    isRecord(release) && Number.isSafeInteger(release.id) ? [Number(release.id)] : [],
  );
}
/** The Core projection as retained in checkpoints and handoffs. Per-release
 * typed facts are derivable from the retained provider facts and are not
 * needed for continuation, so they stay out of bounded checkpoint storage. */
export function retainedCoreProjection<T>(projection: T): T {
  if (!isRecord(projection) || !Object.hasOwn(projection, "release_facts")) return projection;
  const { release_facts: _facts, ...retained } = projection;
  return retained as T;
}
export function acceptedObservationPosition(value: unknown) {
  if (!isRecord(value))
    return { pages: 0, validation: 0, facts: null, coverage: "unstated" as CoreCoverage };
  const continuation = isRecord(value.continuation) ? value.continuation : null;
  const complete =
    isRecord(value.last_complete) && isRecord(value.last_complete.observation)
      ? value.last_complete.observation
      : null;
  return {
    pages:
      continuation?.phase === "restart"
        ? 0
        : isRecord(continuation?.pages)
          ? Object.keys(continuation.pages).length
          : 0,
    validation:
      typeof continuation?.validation_cursor === "number" ? continuation.validation_cursor : 0,
    facts: typeof complete?.facts_sha256 === "string" ? complete.facts_sha256 : null,
    coverage: coreProjectionCoverage(
      isRecord(value.last_complete) ? value.last_complete.projection : null,
    ),
  };
}
export function acceptedObservationAdvanced(
  before: ReturnType<typeof acceptedObservationPosition> | undefined,
  after: ReturnType<typeof acceptedObservationPosition>,
) {
  const a = before ?? { pages: 0, validation: 0, facts: null },
    b = after;
  // Changed last-good facts are never an accepted advance with stated
  // incomplete coverage.
  return (
    b.pages > a.pages ||
    b.validation > a.validation ||
    (b.facts !== null &&
      b.facts !== a.facts &&
      (b.coverage === "complete" || b.coverage === "unstated"))
  );
}
interface Position {
  id: number | null;
  complete: string | null;
  selection: { scope: string; count: number } | null;
  policy: { scope: string; count: number } | null;
  provider: { scope: string; reads: number; validation: number } | null;
}
export function catalogProgressPosition(value: unknown) {
  const result = new Map<string, Position>();
  if (!isRecord(value) || !isRecord(value.sources)) return result;
  for (const [key, raw] of Object.entries(value.sources)) {
    if (!isRecord(raw)) continue;
    const selection = isRecord(raw.selection_progress) ? raw.selection_progress : null,
      policy = isRecord(raw.policy_progress) ? raw.policy_progress : null,
      provider = isRecord(raw.provider_progress) ? raw.provider_progress : null;
    const scope = (v: Record<string, unknown>) =>
      `${typeof v.binding === "string" ? v.binding : ""}:${typeof v.facts_sha256 === "string" ? v.facts_sha256 : ""}`;
    result.set(key, {
      id: typeof raw.repository_id === "number" ? raw.repository_id : null,
      complete: typeof raw.completed_scope_sha256 === "string" ? raw.completed_scope_sha256 : null,
      selection: selection
        ? {
            scope: scope(selection),
            count: typeof selection.cursor === "number" ? selection.cursor : 0,
          }
        : null,
      policy: policy
        ? {
            scope: scope(policy),
            count: Array.isArray(policy.policies) ? policy.policies.length : 0,
          }
        : null,
      provider: provider
        ? {
            scope: scope(provider),
            reads: Array.isArray(provider.reads) ? provider.reads.length : 0,
            validation:
              typeof provider.validation_cursor === "number" ? provider.validation_cursor : 0,
          }
        : null,
    });
  }
  return result;
}
export function catalogPositionAdvanced(
  before: ReturnType<typeof catalogProgressPosition>,
  after: ReturnType<typeof catalogProgressPosition>,
) {
  for (const [key, value] of after) {
    const prior = before.get(key);
    if (
      (value.id !== null && prior?.id == null) ||
      (value.complete !== null && value.complete !== prior?.complete)
    )
      return true;
    for (const field of ["selection", "policy"] as const) {
      const next = value[field],
        old = prior?.[field];
      if (next && next.count > (old?.scope === next.scope ? old.count : 0)) return true;
    }
    if (
      value.provider &&
      (value.provider.reads >
        (prior?.provider?.scope === value.provider.scope ? prior.provider.reads : 0) ||
        value.provider.validation >
          (prior?.provider?.scope === value.provider.scope ? prior.provider.validation : 0))
    )
      return true;
  }
  return false;
}

interface BatchReport {
  launcher_mod_sources?: {
    enrolled: number;
    due: number;
    attempted: number;
    complete: number;
    deferred: number;
    requests: number;
  };
  pending_source_keys: string[];
  attempted_source_keys: string[];
  completed_source_keys: string[];
  failures: {
    source: string;
    repository: string;
    rule: string;
    details: string;
    coverage?: StatedSourceCoverage;
  }[];
  requests: number;
  response_bytes_charged: number;
}
export async function continueCatalogBatches<
  T extends {
    report: BatchReport;
    notify_exception: boolean;
    made_progress: boolean;
    handoff_exhausted: boolean;
  },
>(
  operation: (excluded: ReadonlySet<string>, requestLimit: number) => Promise<T>,
  {
    deadline,
    maxRequests = Infinity,
    now = Date.now,
    signal,
    onBatch = () => {},
    evidenceByteLimit = 4 * 1024 * 1024,
  }: {
    deadline: number;
    /** Hard aggregate request cap: each batch receives only the remaining
     * allowance, and no batch starts once it is spent (#4779). */
    maxRequests?: number;
    now?: () => number;
    signal?: AbortSignal;
    onBatch?: (result: T) => void | Promise<void>;
    evidenceByteLimit?: number;
  },
) {
  if (!Number.isFinite(deadline) || deadline <= now())
    throw new ObservationFailure("budget", "Observation opportunity is unavailable");
  const excluded = new Set<string>(),
    attempted = new Set<string>(),
    completed = new Set<string>();
  if (!Number.isSafeInteger(evidenceByteLimit) || evidenceByteLimit < 1)
    throw new ObservationFailure("budget", "Observation evidence capacity unavailable");
  const failures = new Map<string, BatchReport["failures"][number]>();
  let failureBytes = 0;
  let launcherProgress: BatchReport["launcher_mod_sources"];
  let notify = false,
    requests = 0,
    bytes = 0,
    batches = 0;
  for (;;) {
    if (signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled between bounded batches");
    const result = await operation(excluded, maxRequests - requests);
    batches++;
    // Publish original batch evidence before bounded aggregate admission can fail.
    await onBatch(result);
    notify ||= result.notify_exception;
    requests += result.report.requests;
    bytes += result.report.response_bytes_charged;
    const launcher = result.report.launcher_mod_sources;
    if (launcher)
      launcherProgress = {
        ...launcher,
        attempted: (launcherProgress?.attempted ?? 0) + launcher.attempted,
        complete: (launcherProgress?.complete ?? 0) + launcher.complete,
        requests: (launcherProgress?.requests ?? 0) + launcher.requests,
      };
    result.report.attempted_source_keys.forEach((key) => attempted.add(key));
    result.report.completed_source_keys.forEach((key) => completed.add(key));
    for (const failure of result.report.failures) {
      const key = JSON.stringify(failure);
      if (!failures.has(key)) {
        failureBytes += Buffer.byteLength(key);
        if (failureBytes > evidenceByteLimit)
          throw new ObservationFailure(
            "handoff-size",
            "Cumulative diagnostic evidence envelope exhausted; original batch logs and checkpoints remain authoritative",
          );
        failures.set(key, failure);
      }
    }
    for (const failure of result.report.failures)
      if (failure.rule !== "budget") excluded.add(failure.source);
    if (signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled after bounded batch");
    const more =
      result.report.pending_source_keys.some((key) => !excluded.has(key)) ||
      (!!launcher && launcher.requests > 0 && launcher.deferred > 0);
    if (
      !more ||
      !result.made_progress ||
      result.handoff_exhausted ||
      requests >= maxRequests ||
      now() >= deadline ||
      signal?.aborted
    )
      return {
        ...result,
        notify_exception: notify,
        batches,
        report: {
          ...result.report,
          requests,
          response_bytes_charged: bytes,
          ...(launcherProgress ? { launcher_mod_sources: launcherProgress } : {}),
          attempted_source_keys: [...attempted],
          completed_source_keys: [...completed],
          failures: [...failures.values()],
        },
      };
  }
}
