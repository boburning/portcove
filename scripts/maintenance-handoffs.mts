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
import { candidateRules } from "./upstream-relocation-candidates.mts";

/** Stored as each handoff assessment's policy version. */
export const handoffPolicyVersion = "maintenance-handoffs/1";

export type HandoffKind =
  | "release-health-relocation"
  | "release-health-condition"
  | "upstream-observer-exception"
  | "hosted-intake-blocked"
  | "hosted-intake-holds"
  | "core-assessment-change";

/** The collection source whose complete run decides a kind. */
export type HandoffSource = "release-health" | "upstream-observations" | "hosted-intake" | "core";

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
    trigger: "workflow_dispatch" | "issue_comment";
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
      "Read bounded relocation evidence for the moved or unavailable repository, then propose any rename in a reviewed catalog change.",
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
    invocation: "gh workflow run upstream-health.yml --ref main",
    authority: "routine",
    executor: "upstream-health.yml",
    workflow: {
      file: ".github/workflows/upstream-health.yml",
      name: "Upstream health",
      trigger: "workflow_dispatch",
      inputs: [],
    },
    receipt: "The next scheduled main upstream-health report no longer shows the condition.",
    dispatch: "disabled",
    disabled_reason:
      "The remedy is a reviewed repository change and only a scheduled main report counts; no executor is authorized to open or merge that change unattended.",
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
      "Owner reconciliation on #177: withdraw the blocked request and resubmit the identical batch with a reconcile object.",
    invocation:
      "node scripts/hosted-discovery-intake.mts status --request <request_comment> --json; then an owner comment on #177 starting with <!-- portcove-hosted-intake:v1 --> that carries the reconcile object (docs/DAILY-PORT-DISCOVERY.md)",
    authority: "owner-only",
    executor: "hosted-discovery-intake.yml",
    workflow: {
      file: ".github/workflows/hosted-discovery-intake.yml",
      name: "Hosted discovery intake",
      trigger: "issue_comment",
      inputs: [],
    },
    receipt: "A new bot receipt on #177 for the reconciliation request.",
    dispatch: "disabled",
    disabled_reason:
      "Intake starts only from an owner-authored #177 request; no executor may author owner requests.",
    resume_condition:
      "The owner explicitly delegates #177 request authorship to a named executor; until then the owner posts the reconciliation.",
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
  {
    kind: "core-assessment-change",
    source: "core",
    action:
      "Record the change on the canonical port issue, then requalify the port with exact upstream, source and artifact evidence.",
    invocation:
      "Canonical port issue (<!-- portcove-catalog-id: <port-id> --> marker), then the portcove-port-qualification skill for <port-id>",
    authority: "routine",
    executor: "portcove-port-qualification",
    workflow: null,
    receipt: "The merged commit and the next Core port-capabilities assessment.",
    dispatch: "disabled",
    disabled_reason:
      "Qualification needs exact evidence and a reviewed PR; no executor is authorized to run it unattended.",
    resume_condition:
      "A named executor is authorized for scoped qualification PRs through the normal guarded merge route, with the next Core assessment as its receipt.",
  },
];

/** Sources that deliberately have no handoff, with the reason. */
export const withoutHandoff = [
  [
    "definition-publication",
    "Definition publication (#246) is protected owner authority; the inventory only reports main versus published facts.",
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

/** `handoff.<kind>.<source>.<fence>`, hashed only when it would exceed the store's 200 characters. */
export function handoffOperationId(kind: string, source: string, fence: number) {
  const id = `handoff.${kind}.${identityPart(source)}.${fence}`;
  return id.length <= 200
    ? id
    : `handoff.${kind}.sha256-${createHash("sha256").update(source).digest("hex").slice(0, 40)}.${fence}`;
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
 * visible conditions, split into relocation candidates (the relocation
 * helper's own `candidateRules`) and every other condition.
 */
export function releaseHealthHandoffs(facts: ReadonlyMap<string, unknown>): HandoffCondition[] {
  const result: HandoffCondition[] = [];
  for (const [source, payload] of facts) {
    const visible = attentionConditions(payload).map((condition) =>
      Object.fromEntries(releaseConditionFields.map((field) => [field, condition[field] ?? null])),
    );
    const relocates = (condition: Record<string, unknown>) =>
      typeof condition.rule === "string" && candidateRules.has(condition.rule);
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
 * nothing; a previously `needs-attention` subject in `scope` whose condition is
 * gone transitions to `clear`. A subject that never needed attention gets no
 * row. Unlike source subjects, the first transition is a notification: a
 * handoff appearing is itself the change.
 */
export function handoffCollectionSql(input: {
  kind: HandoffKind;
  run: string;
  /** Literal conditions, or a SELECT yielding (key, source, condition). */
  conditions: readonly HandoffCondition[] | string;
  /** Extra SQL predicate on `c.subject_key` limiting which handoffs this run may clear. */
  clearScope?: string;
}) {
  const prefix = handoffPrefix(input.kind);
  const conditions =
    typeof input.conditions === "string"
      ? input.conditions
      : input.conditions.length
        ? input.conditions
            .map(
              ({ kind, source, condition }) =>
                `SELECT ${literal(handoffSubject(kind, source))}::text AS key, ${literal(source)}::text AS source, ${literal(JSON.stringify(condition))}::jsonb AS condition`,
            )
            .join("\n  UNION ALL ")
        : "SELECT NULL::text AS key, NULL::text AS source, NULL::jsonb AS condition WHERE false";
  const target = `WITH cond AS (${conditions}),
  target AS (
    SELECT key, 'needs-attention'::text AS state,
           ${digestSql(`${literal(input.kind)} || E'\\t' || source || E'\\t' || condition::text`)} AS input_digest,
           jsonb_build_object('handoff', ${literal(input.kind)}, 'source_subject', source, 'condition', condition) AS explanation
      FROM cond
    UNION ALL
    SELECT c.subject_key, 'clear', ${digestSql(`'clear' || E'\\t' || c.subject_key`)},
           jsonb_build_object('handoff', ${literal(input.kind)}, 'source_subject', substring(c.subject_key FROM ${prefix.length + 1}))
      FROM portcove_maintenance.subject_current c
      JOIN portcove_maintenance.assessments a ON a.assessment_id = c.assessment_id
     WHERE starts_with(c.subject_key, ${literal(prefix)}) AND a.state = 'needs-attention'
       AND ${input.clearScope ?? "true"}
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
INSERT INTO portcove_maintenance.subject_transitions (subject_key, sequence, assessment_id)
  SELECT a.subject_key, coalesce(c.sequence, 0) + 1, a.assessment_id
    FROM target t
    JOIN portcove_maintenance.assessments a
      ON a.subject_key = t.key AND a.policy_version = ${policy} AND a.input_digest = t.input_digest
    LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key = t.key
   WHERE c.result_digest IS DISTINCT FROM a.result_digest;`,
    `INSERT INTO portcove_maintenance.notifications (notification_key, subject_key, transition_sequence, created_at)
  SELECT 'transition:' || regexp_replace(t.subject_key, '[^A-Za-z0-9._:-]', '.', 'g') || ':' || t.sequence,
         t.subject_key, t.sequence, statement_timestamp()
    FROM portcove_maintenance.subject_transitions t
    JOIN portcove_maintenance.subject_current c ON c.subject_key = t.subject_key AND c.sequence = t.sequence
   WHERE starts_with(t.subject_key, ${literal(prefix)})
  ON CONFLICT (notification_key) DO NOTHING;`,
  ];
}

/**
 * Core assessment changes from one complete Core run: a subject whose current
 * transition is a change (sequence > 1) to a result it never had before. A
 * return to an earlier result is not new and clears the handoff.
 */
export function coreChangeConditions(subjects: readonly string[]) {
  const keys = subjects.length ? subjects.map(literal).join(", ") : "NULL";
  return `SELECT ${literal(handoffPrefix("core-assessment-change"))} || c.subject_key AS key, c.subject_key AS source,
       jsonb_build_object('sequence', t.sequence, 'previous_state', p.state, 'state', t.state,
                          'previous_result_digest', t.previous_result_digest, 'result_digest', t.result_digest) AS condition
  FROM portcove_maintenance.subject_current c
  JOIN portcove_maintenance.subject_transitions t ON t.subject_key = c.subject_key AND t.sequence = c.sequence
  JOIN portcove_maintenance.subject_transitions p ON p.subject_key = t.subject_key AND p.sequence = t.sequence - 1
 WHERE c.subject_key IN (${keys}) AND NOT t.returns_to_earlier_result`;
}

/** Open handoffs and each one's newest open operation, as one JSON value. */
export const openHandoffsSql = `(SELECT coalesce(json_agg(json_build_object(
      'subject_key', c.subject_key, 'sequence', c.sequence, 'updated_at', c.updated_at,
      'policy_version', a.policy_version, 'explanation', a.explanation,
      'operation', (SELECT json_build_object('operation_id', o.operation_id, 'state', o.state,
                     'fence_sequence', o.fence_sequence, 'revision', o.revision, 'executor', o.executor)
                      FROM portcove_maintenance.operations o
                     WHERE o.subject_key = c.subject_key AND o.state IN ('planned', 'dispatched', 'ambiguous')
                     ORDER BY o.fence_sequence DESC, o.operation_id COLLATE "C" LIMIT 1))
      ORDER BY c.subject_key COLLATE "C"), '[]')
    FROM portcove_maintenance.subject_current c
    JOIN portcove_maintenance.assessments a ON a.assessment_id = c.assessment_id
   WHERE starts_with(c.subject_key, 'handoff:') AND a.state = 'needs-attention')`;

export interface HandoffOperation {
  operation_id: string;
  state: string;
  fence_sequence: number;
  revision: number;
  executor: string;
}

export interface OpenHandoff {
  subject_key: string;
  kind: string;
  source_subject: string;
  sequence: number;
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
      updated_at: string;
      explanation: { condition?: unknown };
      operation: HandoffOperation | null;
    }[]
  ).map(({ subject_key, sequence, updated_at, explanation, operation }) => {
    const parsed = parseHandoffSubject(subject_key);
    return {
      subject_key,
      kind: parsed?.kind ?? "unknown",
      source_subject: parsed?.source ?? subject_key,
      sequence,
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

/** The report's "Next action" text for one open handoff. */
export function nextAction(handoff: OpenHandoff) {
  const entry = handoff.registry;
  const operation = handoff.operation
    ? `operation ${handoff.operation.operation_id} ${handoff.operation.state} at fence ${handoff.operation.fence_sequence}${handoff.operation.fence_sequence === handoff.sequence ? "" : ` (stale; current ${handoff.sequence})`}`
    : `no operation recorded (fence ${handoff.sequence})`;
  return entry
    ? `${entry.action} Invocation: ${entry.invocation}. Authority: ${entry.authority}. Dispatch disabled: ${entry.disabled_reason} Resume: ${entry.resume_condition} Receipt: ${entry.receipt} ${operation}.`
    : `Unregistered handoff kind ${handoff.kind}; dispatch disabled. ${operation}.`;
}

/**
 * Executor bookkeeping on the local store only: plans one operation per open
 * handoff at its current fence, and abandons each planned handoff operation
 * whose subject has moved on (cleared or a newer condition). Nothing is
 * dispatched or completed and no receipt is recorded; replays change nothing.
 */
export function recordHandoffOperations(environment: NodeJS.ProcessEnv) {
  const open = readOpenHandoffs(environment).filter(({ registry }) => registry !== null);
  const rows = open.map(
    ({ subject_key, kind, source_subject, sequence, registry }) =>
      `(${literal(handoffOperationId(kind, source_subject, sequence))}, ${literal(`handoff.${kind}`)}, ${literal(subject_key)}, ${sequence}::bigint, ${literal(registry!.executor)})`,
  );
  const output = runSql(
    environment,
    `SET LOCAL standard_conforming_strings = on;
WITH abandoned AS (
  UPDATE portcove_maintenance.operations o
     SET state = 'abandoned', revision = o.revision + 1, updated_at = greatest(clock_timestamp(), o.updated_at)
    FROM portcove_maintenance.subject_current c
   WHERE c.subject_key = o.subject_key AND o.state = 'planned' AND starts_with(o.kind, 'handoff.')
     AND c.sequence <> o.fence_sequence
  RETURNING 1)
SELECT count(*) FROM abandoned;
${
  rows.length
    ? `WITH planned AS (
  INSERT INTO portcove_maintenance.operations (operation_id, kind, subject_key, fence_sequence, executor, created_at, updated_at)
    SELECT v.operation_id, v.kind, v.subject_key, v.fence, v.executor, clock_timestamp(), clock_timestamp()
      FROM (VALUES ${rows.join(",\n      ")}) AS v (operation_id, kind, subject_key, fence, executor)
      JOIN portcove_maintenance.subject_current c ON c.subject_key = v.subject_key AND c.sequence = v.fence
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
