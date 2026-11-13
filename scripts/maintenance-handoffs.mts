/**
 * Executor handoffs for the #4129 maintenance inventory (checkpoint 4).
 *
 * The registry is code, not stored data: one entry per attention kind names
 * the existing action, its exact invocation, its authority, the receipt that
 * counts and why dispatch is disabled. A complete collection records one
 * `handoff:<kind>:<source-subject>` assessment per attention subject through
 * the store's ordinary assessment, transition and notification guards, and
 * `handoffs --record` keeps at most one planned operation per open handoff at
 * its current fence. No executor is dispatched: every entry is disabled with an
 * exact reason and resume condition, and receipt columns stay empty.
 *
 * Handoffs are not a backlog: they carry no priority, owner or status. Work
 * stays in its canonical issues, Project fields and executors.
 */
import { createHash } from "node:crypto";
import { MaintenanceStoreError, runSql } from "./maintenance-store.mts";
import { attentionConditions } from "./maintenance-release-health.mts";
import { upstreamExceptions } from "./maintenance-upstream.mts";
import { hostedIntakeAttention, type HostedIntakeFact } from "./maintenance-hosted-intake.mts";
import { originalLocationReasons } from "./upstream-location-reasons.mts";
import { isRecord } from "./runtime-values.mts";

/** Stored as each handoff assessment's policy version. */
export const handoffPolicyVersion = "maintenance-handoffs/1";

export type HandoffKind =
  | "release-health-relocation"
  | "release-health-condition"
  | "upstream-observer-exception"
  | "hosted-intake-blocked"
  | "hosted-intake-holds";

/** The collection source whose complete run decides a kind. */
export type HandoffSource = "release-health" | "upstream-observations" | "hosted-intake";

export interface HandoffEntry {
  kind: HandoffKind;
  source: HandoffSource;
  action: string;
  /** The existing command or route, with `<placeholders>`; never run by the store. */
  invocation: string;
  authority: "owner-only" | "protected" | "routine";
  /** Recorded as the operation's executor. */
  executor: string;
  /** The existing workflow the invocation names, verified against .github/workflows. */
  workflow: {
    file: string;
    name: string;
    trigger: "workflow_dispatch" | "issue_comment" | "schedule";
    inputs: readonly string[];
  } | null;
  /** The original executor receipt that counts as done. */
  receipt: string;
  dispatch: "disabled";
  disabled_reason: string;
  resume_condition: string;
}

export const handoffRegistry: readonly HandoffEntry[] = [
  {
    kind: "release-health-relocation",
    source: "release-health",
    action:
      "Read bounded relocation evidence for the redirected or missing GitHub repository, then propose any rename in a reviewed catalog change.",
    invocation:
      'gh workflow run upstream-relocation-evidence.yml --ref main -f requests="<OWNER/NAME[@TAG]>"',
    authority: "owner-only",
    executor: "upstream-relocation-evidence.yml",
    workflow: {
      file: ".github/workflows/upstream-relocation-evidence.yml",
      name: "Upstream relocation evidence",
      trigger: "workflow_dispatch",
      inputs: ["requests"],
    },
    receipt: "The next scheduled main upstream-health report no longer shows the condition.",
    dispatch: "disabled",
    disabled_reason:
      "The evidence job runs only when the repository owner is both actor and triggering actor, no delegated dispatch credential exists, and the rename itself is a reviewed catalog change.",
    resume_condition:
      "The owner delegates upstream-relocation-evidence.yml dispatch to a named executor that records the run's own receipt; the rename stays a reviewed catalog change.",
  },
  {
    kind: "release-health-condition",
    source: "release-health",
    action:
      "Follow the monitor's recorded resume condition; account for an expected provider condition, or fix the cause, in a reviewed PR.",
    invocation:
      "The condition's recorded resume_condition, then a reviewed accounting or fix PR; the next scheduled run of upstream-health.yml on main reports the result",
    authority: "routine",
    executor: "upstream-health.yml",
    workflow: {
      file: ".github/workflows/upstream-health.yml",
      name: "Upstream health",
      trigger: "schedule",
      inputs: [],
    },
    receipt: "The next scheduled main upstream-health report no longer shows the condition.",
    dispatch: "disabled",
    disabled_reason:
      "The remedy is a reviewed repository change and only a scheduled main report counts (a dispatched run is never read as the receipt); no executor is authorized to open or merge that change unattended.",
    resume_condition:
      "A named executor is authorized to deliver accounting or fix PRs through the normal guarded merge route, with the next scheduled main report as its receipt.",
  },
  {
    kind: "upstream-observer-exception",
    source: "upstream-observations",
    action:
      "Follow the observer's recorded exception rule and resume condition; land the fix in a reviewed PR.",
    invocation: "gh workflow run configured-upstream-observer.yml --ref main",
    authority: "routine",
    executor: "configured-upstream-observer.yml",
    workflow: {
      file: ".github/workflows/configured-upstream-observer.yml",
      name: "Configured upstream observer",
      trigger: "workflow_dispatch",
      inputs: [],
    },
    receipt: "The next completed observer checkpoint snapshot no longer records the exception.",
    dispatch: "disabled",
    disabled_reason:
      "The remedy is a reviewed repository change and only a retained checkpoint snapshot counts; no executor is authorized to open or merge that change unattended.",
    resume_condition:
      "A named executor is authorized to deliver observer fix PRs through the normal guarded merge route, with the next retained checkpoint snapshot as its receipt.",
  },
  {
    kind: "hosted-intake-blocked",
    source: "hosted-intake",
    action:
      "Follow the recorded blocker on #177: when primary evidence changed, the owner withdraws the request and submits an explicit reconciliation; any other blocker resumes through owner process dispatch of the same queue.",
    invocation:
      "node scripts/hosted-discovery-intake.mts status --request <request_comment> --json; then either an owner reconciliation comment on #177 (docs/DAILY-PORT-DISCOVERY.md) or gh workflow run hosted-discovery-intake.yml --ref main -f mode=process",
    authority: "owner-only",
    executor: "hosted-discovery-intake.yml",
    workflow: {
      file: ".github/workflows/hosted-discovery-intake.yml",
      name: "Hosted discovery intake",
      trigger: "workflow_dispatch",
      inputs: ["mode"],
    },
    receipt: "A new bot receipt on #177 for the request or its reconciliation.",
    dispatch: "disabled",
    disabled_reason:
      "Intake runs only from an owner-authored #177 request or owner process dispatch; no executor may author owner requests and no delegated dispatch credential exists.",
    resume_condition:
      "The owner delegates #177 reconciliation authorship or process dispatch to a named executor that revalidates the blocker and records the new bot receipt.",
  },
  {
    kind: "hosted-intake-holds",
    source: "hosted-intake",
    action:
      "Resume the held candidates through owner process dispatch once each hold's resume condition holds.",
    invocation: "gh workflow run hosted-discovery-intake.yml --ref main -f mode=process",
    authority: "owner-only",
    executor: "hosted-discovery-intake.yml",
    workflow: {
      file: ".github/workflows/hosted-discovery-intake.yml",
      name: "Hosted discovery intake",
      trigger: "workflow_dispatch",
      inputs: ["mode"],
    },
    receipt: "A new bot receipt on #177 for the request.",
    dispatch: "disabled",
    disabled_reason:
      "Process dispatch spends the dedicated Project credential and is owner-only; no delegated dispatch credential exists.",
    resume_condition:
      "The owner delegates process dispatch to a named executor that revalidates each hold's resume condition and records the new bot receipt.",
  },
];

/** Sources that deliberately have no handoff, with the reason. */
export const withoutHandoff = [
  [
    "definition-publication",
    "Definition publication (#246) is protected owner authority; the inventory only reports main versus published facts.",
  ],
  [
    "core-port-capabilities",
    "Core owns the assessment; a change is reported, not reinterpreted as attention.",
  ],
] as const;

/** Explicitly disabled capabilities of this checkpoint. */
export const disabledCapabilities = [
  "executor dispatch (every executor is owner-only or needs an unauthorized reviewed change, and no delegated credential exists)",
  "digest posting",
  "schedules",
  "publication",
] as const;

export const handoffEntry = (kind: string) => handoffRegistry.find((entry) => entry.kind === kind);

export const handoffPrefix = (kind: HandoffKind) => `handoff:${kind}:`;
export const handoffSubject = (kind: HandoffKind, source: string) =>
  `${handoffPrefix(kind)}${source}`;

/** `handoff:<kind>:<source>` split back into its parts; null for any other subject. */
export function parseHandoffSubject(subject: string) {
  const match = /^handoff:([a-z][a-z0-9-]*):(.+)$/u.exec(subject);
  return match ? { kind: match[1]!, source: match[2]! } : null;
}

/** Characters the operation and notification identity checks refuse map to '.'. */
export const identityPart = (value: string) => value.replace(/[^A-Za-z0-9._:-]/gu, ".");

/**
 * `handoff.<kind>.<source>.<fence>[.a<assessment>]`, hashed only when it would
 * exceed the store's 200 characters (less room for the planner's `.<n>` suffix
 * when the assessment is named). The applicable assessment is part of the
 * identity; the planner adds `.<n>` for the n-th plan of one fence and
 * assessment, so a plan replaced and later needed again gets a new operation.
 */
export function handoffOperationId(
  kind: string,
  source: string,
  fence: number,
  assessment?: number,
) {
  const suffix = assessment === undefined ? `${fence}` : `${fence}.a${assessment}`;
  const id = `handoff.${kind}.${identityPart(source)}.${suffix}`;
  return id.length <= (assessment === undefined ? 200 : 190)
    ? id
    : `handoff.${kind}.sha256-${createHash("sha256").update(source).digest("hex").slice(0, 40)}.${suffix}`;
}

export interface HandoffCondition {
  kind: HandoffKind;
  source: string;
  condition: Record<string, unknown>;
}

const releaseConditionFields = [
  "key",
  "rule",
  "operation",
  "provider",
  "location",
  "release_ref",
  "classification",
  "accounted_for",
  "resume_condition",
] as const;

const byText = (left: unknown, right: unknown) =>
  String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;

/**
 * Release-health attention per port, as the report shows it: the monitor's
 * visible conditions, split into GitHub original-location conditions (the
 * monitor's own `originalLocationReasons`: a redirect or a missing repository),
 * which go to relocation evidence, and every other condition.
 */
export function releaseHealthHandoffs(facts: ReadonlyMap<string, unknown>): HandoffCondition[] {
  const relocationRules: readonly unknown[] = originalLocationReasons;
  const relocates = (condition: Record<string, unknown>) =>
    condition.provider === "github" && relocationRules.includes(condition.rule);
  const result: HandoffCondition[] = [];
  for (const [source, payload] of facts) {
    const visible = attentionConditions(payload).map((condition) =>
      Object.fromEntries(releaseConditionFields.map((field) => [field, condition[field] ?? null])),
    );
    const relocation = visible.filter(relocates);
    const other = visible.filter((condition) => !relocates(condition));
    for (const [kind, conditions] of [
      ["release-health-relocation", relocation],
      ["release-health-condition", other],
    ] as const)
      if (conditions.length)
        result.push({
          kind,
          source,
          condition: {
            conditions: conditions.sort((left, right) => byText(left.key, right.key)),
          },
        });
  }
  return result;
}

/** Observer exceptions per port, with the observer's routine partial-progress stops excluded. */
export function upstreamHandoffs(facts: ReadonlyMap<string, unknown>): HandoffCondition[] {
  const result: HandoffCondition[] = [];
  for (const [source, payload] of facts) {
    const exceptions = upstreamExceptions(payload).map((exception) => ({
      source_key: "source_key" in exception ? exception.source_key : null,
      repository: "repository" in exception ? exception.repository : null,
      exception_key: exception.exception_key ?? null,
      exception_rule: exception.exception_rule ?? null,
    }));
    if (exceptions.length)
      result.push({
        kind: "upstream-observer-exception",
        source,
        condition: {
          exceptions: exceptions.sort((left, right) => byText(left.source_key, right.source_key)),
        },
      });
  }
  return result;
}

/** Owner-actionable hosted-intake requests, by the executor's own classification. */
export function hostedIntakeHandoffs(facts: ReadonlyMap<string, unknown>): HandoffCondition[] {
  const result: HandoffCondition[] = [];
  for (const [source, payload] of facts) {
    if (!hostedIntakeAttention(payload).length) continue;
    const fact = payload as HostedIntakeFact;
    if (fact.status === "blocked")
      result.push({
        kind: "hosted-intake-blocked",
        source,
        condition: {
          request_comment: fact.request_comment,
          receipt_comment: fact.receipt_comment,
          reconciles: fact.reconciles,
          blocker: fact.blocker?.code ?? null,
        },
      });
    else if (fact.status === "complete_with_holds")
      result.push({
        kind: "hosted-intake-holds",
        source,
        condition: {
          request_comment: fact.request_comment,
          receipt_comment: fact.receipt_comment,
          holds: fact.slots.flatMap((slot) =>
            slot.hold
              ? [
                  {
                    candidate_index: slot.candidate_index,
                    port_key: slot.port_key,
                    repository_id: slot.repository_id,
                    http_status: slot.hold.http_status,
                    resume: slot.hold.resume,
                  },
                ]
              : [],
          ),
        },
      });
  }
  return result;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const digestSql = (text: string) => `encode(sha256(convert_to(${text}, 'UTF8')), 'hex')`;

/**
 * The assessment, transition and notification statements for one kind after a
 * complete run of its source, in the store's ordinary pattern: the input digest
 * covers the kind, source subject and stable condition (normalized `jsonb`
 * text); an unchanged condition resolves to the same assessment and records
 * nothing; a previously `needs-attention` subject of the kind whose condition
 * is gone transitions to `clear`. A subject that never needed attention gets no
 * row. Unlike source subjects, the first transition is a notification: a
 * handoff appearing is itself the change.
 *
 * With `retired`, the statements instead clear every open handoff whose kind is
 * no longer registered, so a removed kind never lingers as open work.
 */
export function handoffCollectionSql(
  input:
    | { kind: HandoffKind; run: string; conditions: readonly HandoffCondition[] }
    | { retired: true; run: string },
) {
  const conditions =
    "kind" in input && input.conditions.length
      ? input.conditions
          .map(
            ({ kind, source, condition }) =>
              `SELECT ${literal(handoffSubject(kind, source))}::text AS key, ${literal(kind)}::text AS kind, ${literal(source)}::text AS source, ${literal(JSON.stringify(condition))}::jsonb AS condition`,
          )
          .join("\n  UNION ALL ")
      : "SELECT NULL::text AS key, NULL::text AS kind, NULL::text AS source, NULL::jsonb AS condition WHERE false";
  // The current handoff subjects this run decides.
  const decided = (column: string) =>
    "kind" in input
      ? `starts_with(${column}, ${literal(handoffPrefix(input.kind))})`
      : `starts_with(${column}, 'handoff:') AND split_part(${column}, ':', 2) NOT IN (${handoffRegistry
          .map(({ kind }) => literal(kind))
          .join(", ")})`;
  const target = `WITH cond AS (${conditions}),
  target AS (
    SELECT key, 'needs-attention'::text AS state,
           ${digestSql(`kind || E'\\t' || source || E'\\t' || condition::text`)} AS input_digest,
           jsonb_build_object('handoff', kind, 'source_subject', source, 'condition', condition) AS explanation
      FROM cond
    UNION ALL
    SELECT c.subject_key, 'clear', ${digestSql(`'clear' || E'\\t' || c.subject_key`)},
           jsonb_build_object('handoff', split_part(c.subject_key, ':', 2), 'source_subject',
             substring(c.subject_key FROM length(split_part(c.subject_key, ':', 2)) + 10))
      FROM portcove_maintenance.subject_current c
      JOIN portcove_maintenance.assessments a ON a.assessment_id = c.assessment_id
     WHERE ${decided("c.subject_key")} AND a.state = 'needs-attention'
       AND c.subject_key NOT IN (SELECT key FROM cond)
  )`;
  const policy = literal(handoffPolicyVersion);
  return [
    `${target}
INSERT INTO portcove_maintenance.assessments (subject_key, policy_version, input_digest, state, result_digest, explanation, assessed_at, run_id)
  SELECT key, ${policy}, input_digest, state, ${digestSql(`state || E'\\t' || input_digest`)}, explanation, statement_timestamp(), ${literal(input.run)}
    FROM target
  ON CONFLICT (subject_key, policy_version, input_digest) DO NOTHING;`,
    `${target}
INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id, verified_run_id)
  SELECT a.subject_key, coalesce(c.sequence, 0) + 1, a.assessment_id, ${literal(input.run)}
    FROM target t
    JOIN portcove_maintenance.assessments a
      ON a.subject_key = t.key AND a.policy_version = ${policy} AND a.input_digest = t.input_digest
    LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key = t.key
   WHERE c.result_digest IS DISTINCT FROM a.result_digest;`,
    // An unchanged condition is still verified by this complete run, quietly.
    `${target}
SELECT portcove_maintenance.verify_current(a.assessment_id, ${literal(input.run)})
    FROM target t
    JOIN portcove_maintenance.assessments a
      ON a.subject_key = t.key AND a.policy_version = ${policy} AND a.input_digest = t.input_digest
    JOIN portcove_maintenance.subject_current c ON c.subject_key = t.key
   WHERE c.result_digest = a.result_digest
     AND (c.applicable_assessment_id <> a.assessment_id OR c.verified_run_id IS DISTINCT FROM ${literal(input.run)});`,
    `INSERT INTO portcove_maintenance.notifications (notification_key, subject_key, transition_sequence, created_at)
  SELECT 'transition:' || regexp_replace(t.subject_key, '[^A-Za-z0-9._:-]', '.', 'g') || ':' || t.sequence,
         t.subject_key, t.sequence, statement_timestamp()
    FROM portcove_maintenance.subject_transitions t
    JOIN portcove_maintenance.subject_current c ON c.subject_key = t.subject_key AND c.sequence = t.sequence
   WHERE ${decided("t.subject_key")}
  ON CONFLICT (notification_key) DO NOTHING;`,
  ];
}

/** Open handoffs and each one's newest open operation, as one JSON value. */
export const openHandoffsSql = `(SELECT coalesce(json_agg(json_build_object(
      'subject_key', c.subject_key, 'sequence', c.sequence, 'updated_at', c.updated_at,
      'assessment_id', c.applicable_assessment_id,
      'policy_version', a.policy_version, 'explanation', a.explanation,
      'operation', (SELECT json_build_object('operation_id', o.operation_id, 'state', o.state,
                     'fence_sequence', o.fence_sequence, 'fence_assessment_id', o.fence_assessment_id,
                     'revision', o.revision, 'executor', o.executor)
                      FROM portcove_maintenance.operations o
                     WHERE o.subject_key = c.subject_key AND o.state IN ('planned', 'dispatched', 'ambiguous')
                     ORDER BY o.fence_sequence DESC, o.operation_id COLLATE "C" LIMIT 1))
      ORDER BY c.subject_key COLLATE "C"), '[]')
    FROM portcove_maintenance.subject_current c
    JOIN portcove_maintenance.assessments a ON a.assessment_id = c.applicable_assessment_id
   WHERE starts_with(c.subject_key, 'handoff:') AND a.state = 'needs-attention')`;

export interface HandoffOperation {
  operation_id: string;
  state: string;
  fence_sequence: number;
  /** Null for a plan recorded before migration 0003 that the backfill could not bind. */
  fence_assessment_id: number | null;
  revision: number;
  executor: string;
}

export interface OpenHandoff {
  subject_key: string;
  kind: string;
  source_subject: string;
  sequence: number;
  /** The latest applicable assessment that a plan must bind. */
  assessment_id: number;
  updated_at: string;
  condition: unknown;
  /** Null for a kind this registry version does not know. */
  registry: HandoffEntry | null;
  operation: HandoffOperation | null;
}

/** Projects stored rows onto the registry; a kind without an entry stays visible, unregistered. */
export function openHandoffs(rows: unknown): OpenHandoff[] {
  return (
    rows as {
      subject_key: string;
      sequence: number;
      assessment_id: number;
      updated_at: string;
      explanation: { condition?: unknown };
      operation: HandoffOperation | null;
    }[]
  ).map(({ subject_key, sequence, assessment_id, updated_at, explanation, operation }) => {
    const parsed = parseHandoffSubject(subject_key);
    return {
      subject_key,
      kind: parsed?.kind ?? "unknown",
      source_subject: parsed?.source ?? subject_key,
      sequence,
      assessment_id,
      updated_at,
      condition: explanation.condition ?? null,
      registry: handoffEntry(parsed?.kind ?? "") ?? null,
      operation,
    };
  });
}

export function readOpenHandoffs(environment: NodeJS.ProcessEnv) {
  const text = runSql(environment, `SELECT ${openHandoffsSql};`).trim();
  try {
    return openHandoffs(JSON.parse(text));
  } catch {
    throw new MaintenanceStoreError("PostgreSQL returned malformed handoff JSON");
  }
}

/**
 * The action, invocation and resume condition shown for one handoff: its
 * registry entry's, except for release-health conditions (relocation or other)
 * the monitor already records as accounted for (`accounted_for`, a reviewed
 * scope that its triage still keeps visible). Those need no new relocation
 * evidence or accounting, so the monitor's own recorded `resume_condition`
 * replaces that prescription.
 */
export function handoffGuidance(entry: HandoffEntry, condition: unknown) {
  const guidance = {
    action: entry.action,
    invocation: entry.invocation,
    resume_condition: entry.resume_condition,
  };
  if (entry.kind !== "release-health-condition" && entry.kind !== "release-health-relocation")
    return guidance;
  const conditions = (condition as { conditions?: unknown } | null)?.conditions;
  const listed: unknown[] = Array.isArray(conditions) ? conditions : [];
  const accounted = listed.filter(
    (value): value is Record<string, unknown> => isRecord(value) && value.accounted_for === true,
  );
  if (!accounted.length) return guidance;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const recorded = accounted
    .map(
      ({ rule, location, resume_condition }) =>
        `${text(rule, "unknown rule")} at ${text(location, "unknown location")}: ${text(resume_condition, "no resume condition recorded")}`,
    )
    .join("; ");
  if (accounted.length < listed.length)
    return {
      ...guidance,
      action: `${entry.action} Already accounted for by reviewed scope (no new relocation evidence or accounting): ${recorded}`,
    };
  return {
    action:
      "The monitor records this condition as accounted for by reviewed scope; no new relocation evidence or accounting is needed. Follow its recorded resume condition.",
    invocation:
      "The condition's recorded resume_condition; the next scheduled run of upstream-health.yml on main reports the result",
    resume_condition: recorded,
  };
}

/** The report's "Next action" text for one open handoff. */
export function nextAction(handoff: OpenHandoff) {
  const entry = handoff.registry;
  const operation = handoff.operation
    ? `operation ${handoff.operation.operation_id} ${handoff.operation.state} at fence ${handoff.operation.fence_sequence}${handoff.operation.fence_sequence === handoff.sequence && handoff.operation.fence_assessment_id === handoff.assessment_id ? "" : ` (stale; current ${handoff.sequence} on assessment ${handoff.assessment_id})`}`
    : `no operation recorded (fence ${handoff.sequence})`;
  if (!entry) return `Unregistered handoff kind ${handoff.kind}; dispatch disabled. ${operation}.`;
  const guidance = handoffGuidance(entry, handoff.condition);
  return `${guidance.action} Invocation: ${guidance.invocation}. Authority: ${entry.authority}. Dispatch disabled: ${entry.disabled_reason} Resume: ${guidance.resume_condition} Receipt: ${entry.receipt} ${operation}.`;
}

/**
 * Executor bookkeeping on the local store only: plans one operation per open
 * handoff at its current fence, and abandons each planned handoff operation
 * whose subject has moved on (cleared, a newer condition, or a newer applicable
 * assessment of the same result). Nothing is
 * dispatched or completed and no receipt is recorded; replays change nothing.
 */
export function recordHandoffOperations(environment: NodeJS.ProcessEnv) {
  const open = readOpenHandoffs(environment).filter(({ registry }) => registry !== null);
  const rows = open.map(
    ({ subject_key, kind, source_subject, sequence, assessment_id, registry }) =>
      `(${literal(handoffOperationId(kind, source_subject, sequence, assessment_id))}, ${literal(`handoff.${kind}`)}, ${literal(subject_key)}, ${sequence}::bigint, ${assessment_id}::bigint, ${literal(registry!.executor)})`,
  );
  const output = runSql(
    environment,
    `SET LOCAL standard_conforming_strings = on;
WITH abandoned AS (
  UPDATE portcove_maintenance.operations o
     SET state = 'abandoned', revision = o.revision + 1, updated_at = greatest(clock_timestamp(), o.updated_at)
    FROM portcove_maintenance.subject_current c
   WHERE c.subject_key = o.subject_key AND o.state = 'planned' AND starts_with(o.kind, 'handoff.')
     AND (c.sequence <> o.fence_sequence OR c.applicable_assessment_id IS DISTINCT FROM o.fence_assessment_id)
  RETURNING 1)
SELECT count(*) FROM abandoned;
${
  rows.length
    ? `WITH planned AS (
  INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, fence_assessment_id, executor, created_at, updated_at)
    SELECT v.operation_id || CASE WHEN earlier.plans = 0 THEN '' ELSE '.' || (earlier.plans + 1) END,
           v.kind, v.subject_key, v.fence, v.assessment, v.executor, clock_timestamp(), clock_timestamp()
      FROM (VALUES ${rows.join(",\n      ")}) AS v (operation_id, kind, subject_key, fence, assessment, executor)
      JOIN portcove_maintenance.subject_current c
        ON c.subject_key = v.subject_key AND c.sequence = v.fence AND c.applicable_assessment_id = v.assessment
      -- Earlier plans of the same fence and assessment, so a later one gets its own identity.
      CROSS JOIN LATERAL (SELECT count(*) AS plans FROM portcove_maintenance.operations o
                           WHERE o.operation_id = v.operation_id
                              OR starts_with(o.operation_id, v.operation_id || '.')) earlier
     -- One open operation per handoff: a current plan (including one recorded before
     -- migration 0003 under the older identity) or any dispatched or ambiguous
     -- operation, which resolves only through its original executor's receipt.
     WHERE NOT EXISTS (SELECT 1 FROM portcove_maintenance.operations o
                        WHERE o.subject_key = v.subject_key
                          AND (o.state IN ('dispatched', 'ambiguous')
                               OR (o.state = 'planned' AND o.fence_sequence = v.fence
                                   AND o.fence_assessment_id = v.assessment)))
  ON CONFLICT (operation_id) DO NOTHING
  RETURNING 1)
SELECT count(*) FROM planned;`
    : "SELECT 0;"
}`,
  )
    .trim()
    .split("\n");
  return { abandoned: Number(output[0]), planned: Number(output[1]), open: open.length };
}

/** Plain-text listing for the `handoffs` command. */
export function renderHandoffs(handoffs: readonly OpenHandoff[]) {
  if (!handoffs.length) return "No open handoffs. Dispatch is disabled for every handoff kind.\n";
  return `${handoffs
    .map(
      (handoff) =>
        `${handoff.subject_key} (sequence ${handoff.sequence})\n  ${nextAction(handoff)}`,
    )
    .join("\n")}\n`;
}
