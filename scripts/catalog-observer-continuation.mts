import { ObservationFailure } from "./upstream-observer.mts";
import { isRecord } from "./runtime-values.mts";
export function acceptedObservationPosition(value: unknown) {
  if (!isRecord(value)) return { pages: 0, validation: 0, facts: null };
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
  };
}
export function acceptedObservationAdvanced(
  before: ReturnType<typeof acceptedObservationPosition> | undefined,
  after: ReturnType<typeof acceptedObservationPosition>,
) {
  const a = before ?? { pages: 0, validation: 0, facts: null },
    b = after;
  return (
    b.pages > a.pages || b.validation > a.validation || (b.facts !== null && b.facts !== a.facts)
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
  pending_source_keys: string[];
  attempted_source_keys: string[];
  completed_source_keys: string[];
  failures: { source: string; repository: string; rule: string; details: string }[];
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
  operation: (excluded: ReadonlySet<string>) => Promise<T>,
  {
    deadline,
    now = Date.now,
    signal,
    onBatch = () => {},
    evidenceByteLimit = 4 * 1024 * 1024,
  }: {
    deadline: number;
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
  let notify = false,
    requests = 0,
    bytes = 0,
    batches = 0;
  for (;;) {
    if (signal?.aborted)
      throw new ObservationFailure("cancelled", "Observation cancelled between bounded batches");
    const result = await operation(excluded);
    batches++;
    // Publish original batch evidence before bounded aggregate admission can fail.
    await onBatch(result);
    notify ||= result.notify_exception;
    requests += result.report.requests;
    bytes += result.report.response_bytes_charged;
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
    const more = result.report.pending_source_keys.some((key) => !excluded.has(key));
    if (
      !more ||
      !result.made_progress ||
      result.handoff_exhausted ||
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
          attempted_source_keys: [...attempted],
          completed_source_keys: [...completed],
          failures: [...failures.values()],
        },
      };
  }
}
