/**
 * Executor handoffs for the #4129 maintenance inventory (checkpoint 4).
 *
 * The registry is code, not stored data: one entry per attention kind names
 * the existing action, its exact invocation, its authority, the receipt that
 * counts and why dispatch is disabled. A complete collection records one
 * `handoff:<kind>:<source-subject>` assessment per attention subject through
 * the store's ordinary assessment, transition and notification guards, and
 * `handoffs --record` keeps at most one planned operation per open handoff at
 * its current fence. The registry cannot dispatch executors. The existing
 * scheduled intake worker can record an eligible final audit's original receipt.
 *
 * Handoffs are not a backlog: they carry no priority, owner or status. Work
 * stays in its canonical issues, Project fields and executors.
 */
import { createHash } from "node:crypto";
import { MaintenanceStoreError, runSql } from "./maintenance-store.mts";
import { attentionConditions } from "./maintenance-release-health.mts";
import { upstreamExceptions } from "./maintenance-upstream.mts";
import { hostedIntakeAttention, type HostedIntakeFact } from "./maintenance-hosted-intake.mts";
import {
  releaseContentFindings,
  releaseContentUnscannable,
} from "./maintenance-release-content.mts";
import {
  originalLocationReasons,
  reviewedEndpointClassification,
} from "./upstream-location-reasons.mts";
import { isRecord } from "./runtime-values.mts";

/** Stored as each handoff assessment's policy version. */
export const handoffPolicyVersion = "maintenance-handoffs/1";

export type HandoffKind =
  | "release-health-relocation"
  | "release-health-condition"
  | "upstream-observer-exception"
  | "hosted-intake-blocked"
  | "hosted-intake-holds"
  | "release-content-finding";

/** The collection source whose complete run decides a kind. */
export type HandoffSource =
  | "release-health"
  | "upstream-observations"
  | "hosted-intake"
  | "release-content";

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
      "The daily maintenance schedule resumes verified pending final audits on their original request. When primary evidence changed, the owner withdraws the request and submits an explicit reconciliation. Other blockers use owner process dispatch when their recorded condition holds.",
    invocation:
      "node scripts/hosted-discovery-intake.mts status --request <request_comment> --json; for eligible final audits follow the next scheduled maintenance-inventory.yml run; otherwise use the applicable owner reconciliation on #177 or gh workflow run hosted-discovery-intake.yml --ref main -f mode=process",
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
      "The registry cannot authorize new intake, edit an owner request or dispatch the owner process. The scheduled workflow can resume only an already authorized final audit.",
    resume_condition:
      "For a scheduled final audit, the exact original request, authenticated workflow attempt, pending receipt and durable checkpoint must agree. Other blockers require the existing owner action after the recorded condition holds.",
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
    kind: "release-content-finding",
    source: "release-content",
    action:
      "A person confirms the flagged files against the package, and inspects manually any package the scan could not read (digest mismatch, encrypted, unlistable or over the size limit); an unavailable GitHub release goes through the owner-only release-health relocation route, an unavailable GitLab release through a reviewed location change. If it bundles original game data outside the rights-basis owner exceptions, a reviewed catalog change adds a download hold to the listing's restrictions (docs/CATALOG.md#rights-basis-for-upstream-hosted-packages); a confirmed false positive gets a reviewed .github/release-content-accounting.json entry instead. The scan itself never writes a hold.",
    invocation:
      "Review the finding's package entries in the scan report, or download and inspect the unscannable package, then a reviewed catalog PR adding a download hold to the listing's restrictions when it is game data, or a reviewed .github/release-content-accounting.json entry for a confirmed false positive; the next scheduled run of release-content-scan.yml on main reports the result",
    authority: "routine",
    executor: "release-content-scan.yml",
    workflow: {
      file: ".github/workflows/release-content-scan.yml",
      name: "Release content scan",
      trigger: "schedule",
      inputs: [],
    },
    receipt:
      "The next scheduled main release-content scan report no longer reports the finding or the not-scannable package; a held listing leaves the scan targets.",
    dispatch: "disabled",
    disabled_reason:
      "Confirming game data needs a person to review the package, the hold is a reviewed catalog change, and only a scheduled main report counts (a dispatched scan is never read as the receipt); no executor is authorized to open or merge that change unattended.",
    resume_condition:
      "A named executor is authorized to deliver reviewed hold PRs through the normal guarded merge route after a person confirms the finding, with the next scheduled main scan report as its receipt.",
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
  "executor dispatch from the handoff registry",
  "digest posting",
  "separate handoff schedules",
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
    const watched = relocation.every(
      (condition) =>
        condition.accounted_for === true &&
        condition.classification === reviewedEndpointClassification &&
        typeof condition.resume_condition === "string" &&
        condition.resume_condition.trim().length > 0,
    );
    const other = visible.filter((condition) => !relocates(condition));
    for (const [kind, conditions] of [
      ["release-health-relocation", watched ? [] : relocation],
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

/** Flagged release packages and packages the scan could not inspect, per port, from stored facts only. */
export function releaseContentHandoffs(facts: ReadonlyMap<string, unknown>): HandoffCondition[] {
  const result: HandoffCondition[] = [];
  for (const [source, payload] of facts) {
    // A finding dismissed by reviewed accounting is not attention.
    const findings = releaseContentFindings(payload).filter((entry) => !entry.accounted);
    // Coverage notes (no release, no single asset) are not attention.
    const unscannable = releaseContentUnscannable(payload)
      .filter(({ attention }) => attention)
      .map(({ platform, code, provider }) => ({
        platform,
        code,
        ...(provider ? { provider } : {}),
      }));
    if (findings.length || unscannable.length)
      result.push({
        kind: "release-content-finding",
        source,
        condition: {
          findings: findings.map(
            ({ platform, repository, tag, asset, sha256, rules, signals, signal_count }) => ({
              platform,
              repository,
              tag,
              asset,
              sha256,
              rules,
              signals: signals.map(({ path, kind, reason }) => ({ path, kind, reason })),
              signal_count: signal_count ?? signals.length,
            }),
          ),
          unscannable,
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
    | {
        kind: HandoffKind;
        run: string;
        conditions: readonly HandoffCondition[];
        assessedSources?: readonly string[];
      }
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
  const scopedKeys =
    "kind" in input && input.assessedSources
      ? input.assessedSources.map((source) => literal(handoffSubject(input.kind, source)))
      : undefined;
  const decided = (column: string) =>
    "kind" in input
      ? scopedKeys
        ? `${column} = ANY(ARRAY[${scopedKeys.join(", ")}]::text[])`
        : `starts_with(${column}, ${literal(handoffPrefix(input.kind))})`
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
/** The action, invocation, resume condition and receipt shown for one handoff. */
export interface HandoffGuidance {
  action: string;
  invocation: string;
  resume_condition: string;
  receipt: string;
}

export function handoffGuidance(entry: HandoffEntry, condition: unknown): HandoffGuidance {
  const guidance = {
    action: entry.action,
    invocation: entry.invocation,
    resume_condition: entry.resume_condition,
    receipt: entry.receipt,
  };
  if (entry.kind === "release-content-finding") return releaseContentGuidance(guidance, condition);
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
    receipt: entry.receipt,
  };
}

/**
 * The action and receipt for one release-content handoff, by what it holds:
 * flagged files to confirm, packages to inspect by hand, and releases the scan
 * cannot read, which go through the release-health relocation route before
 * any package can be reviewed.
 */
function releaseContentGuidance(guidance: HandoffGuidance, condition: unknown): HandoffGuidance {
  const value = isRecord(condition) ? condition : {};
  const findings = Array.isArray(value.findings) ? value.findings.length : 0;
  const targets = (Array.isArray(value.unscannable) ? value.unscannable : []).filter(isRecord);
  const codes = targets.flatMap((target) => (typeof target.code === "string" ? [target.code] : []));
  const unavailable = targets.filter((target) => target.code === "release-unavailable");
  // The relocation evidence route reads GitHub repositories only.
  const github = unavailable.some((target) => target.provider === "github");
  const gitlab = unavailable.some((target) => target.provider === "gitlab");
  // A condition recorded before the provider was stored names no route.
  const unknown = unavailable.some(
    (target) => target.provider !== "github" && target.provider !== "gitlab",
  );
  const inspect = [...new Set(codes.filter((code) => code !== "release-unavailable"))];
  const actions: string[] = [];
  const invocations: string[] = [];
  const receipts: string[] = [];
  if (findings) {
    actions.push("A person confirms the flagged files against the package.");
    receipts.push("no longer reports the finding");
  }
  if (inspect.length) {
    actions.push(
      `A person downloads and inspects by hand the package the scan could not read (${inspect.join(", ")}).`,
    );
    receipts.push("no longer reports the not-scannable package");
  }
  if (findings || inspect.length) {
    actions.push(
      "If it bundles original game data outside the rights-basis owner exceptions, a reviewed catalog change adds a download hold to the listing's restrictions (docs/CATALOG.md#rights-basis-for-upstream-hosted-packages); a confirmed false positive gets a reviewed .github/release-content-accounting.json entry instead.",
    );
    invocations.push(guidance.invocation);
  }
  if (github) {
    actions.push(
      "The GitHub release read is redirected or gone. The routine part of this handoff is only to confirm that the release is unavailable; relocation evidence (upstream-relocation-evidence.yml) and any rename are owner-only and follow the port's release-health-relocation handoff and its authority, not this one.",
    );
    invocations.push(
      "confirm the release read still fails; relocation evidence and the rename follow the owner-only release-health-relocation handoff; the next scheduled run of release-content-scan.yml on main reports the result",
    );
  }
  if (unknown) {
    actions.push(
      "The release read is redirected or gone: confirm it, then fix the listing's upstream location in a reviewed catalog change (for a GitHub repository through the owner-only release-health-relocation handoff and its authority).",
    );
    invocations.push(
      "confirm the release read still fails; a reviewed catalog change to the listing's upstream location, through the owner-only release-health-relocation handoff for a GitHub repository; the next scheduled run of release-content-scan.yml on main reports the result",
    );
  }
  if (gitlab) {
    actions.push(
      "The GitLab release read is redirected or gone: fix the listing's upstream location in a reviewed catalog change, then wait for the next scan.",
    );
    invocations.push(
      "a reviewed catalog change to the listing's upstream location; the next scheduled run of release-content-scan.yml on main reports the result",
    );
  }
  if (unavailable.length)
    receipts.push("reads the release (the target is no longer release-unavailable)");
  if (!actions.length) return guidance;
  return {
    ...guidance,
    action: `${actions.join(" ")} The scan itself never writes a hold.`,
    invocation: invocations.join("; for the unavailable release, "),
    receipt: `The next scheduled main release-content scan report ${receipts.join(" and ")}; a held listing leaves the scan targets.`,
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
  return `${guidance.action} Invocation: ${guidance.invocation}. Authority: ${entry.authority}. Dispatch disabled: ${entry.disabled_reason} Resume: ${guidance.resume_condition} Receipt: ${guidance.receipt} ${operation}.`;
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
                               OR ((o.state = 'planned' OR (o.state = 'completed' AND v.kind IN ('handoff.hosted-intake-holds','handoff.hosted-intake-blocked'))) AND o.fence_sequence = v.fence
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

/*
 * Executor contract (#8570).
 *
 * A pure, deterministic description of what an executor would need to act on
 * a handoff: the deciding facts, the operation identity, the generation fence,
 * the lease and checkpoint, the receipt and the wake condition. It is a model
 * only: nothing here reads the store, calls the network, uses a credential or
 * dispatches. Dispatch stays disabled for every kind, and `applyHandoffEvent`
 * refuses every lease claim under the registry's own policy.
 *
 * The store does not yet persist the identity key, source and policy
 * generation, lease or checkpoint (see docs/MAINTENANCE-STORE.md#executor-handoffs).
 */

/** Versions the contract shape and the operation identity derivation. */
export const handoffContractVersion = "maintenance-handoff-contract/1";

/** The store's own identity and receipt limits (migration 0001 `operations` checks). */
const operationIdPattern = /^[A-Za-z0-9._:-]{1,200}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const receiptReferenceLimit = 500;
const executorLimit = 200;

export type WakeRule =
  /** Any return to needs-attention after the completing receipt cleared the subject. */
  | "reappears-after-clear"
  /** A needs-attention assessment whose input digest differs from the completed one. */
  | "input-digest-changed";

export interface ExecutorStep {
  id: string;
  does: string;
  /** Rerunning a completed step changes nothing; required for lease reclaim. */
  idempotent: true;
}

export interface RoutineExecutorPlan {
  mode: "routine";
  /** Where the job would run: an existing schedule, never a new one. */
  runs_in: string;
  steps: readonly ExecutorStep[];
  permissions: readonly string[];
  never: readonly string[];
}

export interface OwnerIntakePlan {
  mode: "owner-intake";
  /** Why the handoff stays inert. */
  reason: string;
}

export interface HandoffContract {
  kind: HandoffKind;
  deciding_facts: {
    source: HandoffSource;
    /** The stored facts the condition is derived from. */
    store_facts: readonly string[];
    /** The condition fields covered by the assessment input digest. */
    condition_fields: readonly string[];
    /** Fields deliberately left out of the digest. */
    excluded: readonly string[];
  };
  wake: { rule: WakeRule; when: string };
  /** Null for owner-only intake: no executor lease exists. */
  lease: { ttl_minutes: number } | null;
  receipt: { reference: string; sha256: string };
  plan: RoutineExecutorPlan | OwnerIntakePlan;
}

const routineNever = [
  "write repository contents, push a branch, or open, approve or merge a pull request",
  "comment on, open, close or edit an issue, or change a GitHub Project field",
  "dispatch any workflow, including upstream-relocation-evidence.yml and hosted-discovery-intake.yml",
  "use the Project credential, a signing key, a publication credential or any owner-delegated token",
  "publish definitions, releases or catalogs",
  "call an AI service or decide a remedy; the remedy stays a reviewed change by a person",
  "read a dispatched or pull-request run as the receipt",
  "act on a decision whose fence (sequence, assessment, source generation or policy generation) has moved",
  "re-open a completed operation unless its wake condition holds",
] as const;

const routineRunsIn =
  "A step of the existing scheduled maintenance-inventory.yml job on main after collection; no new workflow or schedule.";

const routinePermissions = [
  "GITHUB_TOKEN contents: read",
  "GITHUB_TOKEN actions: read (to read the retained receipt run and its artifact)",
  "The existing maintenance store executor role that `handoffs --record` uses, limited to the handoff's operation row",
] as const;

const routineSteps = (evidence: string, receipt: string): readonly ExecutorStep[] => [
  {
    id: "read-handoff",
    does: "Read the open handoff, its applicable assessment and operation with the report role.",
    idempotent: true,
  },
  {
    id: "check-fence",
    does: "Compare the operation's sequence, assessment, source generation and policy generation with the current subject; stop without acting when any has moved.",
    idempotent: true,
  },
  {
    id: "take-lease",
    does: "Claim the operation's lease, or reclaim an expired one, and resume after the last completed checkpoint.",
    idempotent: true,
  },
  { id: "gather-evidence", does: evidence, idempotent: true },
  {
    id: "publish-evidence",
    does: "Write the evidence to the job summary and a retained run artifact named by the operation key; nothing is posted elsewhere.",
    idempotent: true,
  },
  { id: "await-receipt", does: receipt, idempotent: true },
  {
    id: "record-receipt",
    does: "Record the receipt run URL and the SHA-256 of its report against the operation, complete it and release the lease.",
    idempotent: true,
  },
];

export const handoffContracts: Readonly<Record<HandoffKind, HandoffContract>> = {
  "release-health-relocation": {
    kind: "release-health-relocation",
    deciding_facts: {
      source: "release-health",
      store_facts: ["release-health observation of the port in a fresh, complete port assessment"],
      condition_fields: [...releaseConditionFields],
      excluded: ["clocks", "HTTP status", "conditions outside the GitHub original-location rules"],
    },
    wake: {
      rule: "reappears-after-clear",
      when: "The port's relocation handoff returns to needs-attention after the scheduled main upstream-health report cleared it.",
    },
    lease: null,
    receipt: {
      reference:
        "The scheduled main upstream-health run URL whose report no longer shows the condition.",
      sha256: "SHA-256 of that report artifact.",
    },
    plan: {
      mode: "owner-intake",
      reason:
        "Relocation evidence is owner-dispatched and the rename is a reviewed catalog change; no executor holds this handoff.",
    },
  },
  "release-health-condition": {
    kind: "release-health-condition",
    deciding_facts: {
      source: "release-health",
      store_facts: ["release-health observation of the port in a fresh, complete port assessment"],
      condition_fields: [...releaseConditionFields],
      excluded: ["clocks", "HTTP status", "GitHub original-location relocation conditions"],
    },
    wake: {
      rule: "reappears-after-clear",
      when: "The port's condition handoff returns to needs-attention after the scheduled main upstream-health report cleared it.",
    },
    lease: { ttl_minutes: 30 },
    receipt: {
      reference:
        "The scheduled main upstream-health run URL whose report no longer shows the condition.",
      sha256: "SHA-256 of that report artifact.",
    },
    plan: {
      mode: "routine",
      runs_in: routineRunsIn,
      steps: routineSteps(
        "From the stored condition only, list each condition key, rule, location and the monitor's recorded resume condition, and whether reviewed accounting already covers it.",
        "Wait for a later scheduled main upstream-health report; a dispatched or pull-request run never counts.",
      ),
      permissions: routinePermissions,
      never: routineNever,
    },
  },
  "upstream-observer-exception": {
    kind: "upstream-observer-exception",
    deciding_facts: {
      source: "upstream-observations",
      store_facts: ["upstream observation of the port in a complete observer checkpoint"],
      condition_fields: ["source_key", "repository", "exception_key", "exception_rule"],
      excluded: ["partial-progress stops"],
    },
    wake: {
      rule: "reappears-after-clear",
      when: "The port's observer exception handoff returns to needs-attention after a completed checkpoint snapshot cleared it.",
    },
    lease: { ttl_minutes: 30 },
    receipt: {
      reference:
        "The observer run URL of the next completed checkpoint snapshot that no longer records the exception.",
      sha256: "SHA-256 of that retained snapshot.",
    },
    plan: {
      mode: "routine",
      runs_in: routineRunsIn,
      steps: routineSteps(
        "From the stored condition only, list each excepted source key, repository, exception key and rule.",
        "Wait for the next completed observer checkpoint snapshot from its own schedule; never dispatch the observer.",
      ),
      permissions: routinePermissions,
      never: routineNever,
    },
  },
  "hosted-intake-blocked": {
    kind: "hosted-intake-blocked",
    deciding_facts: {
      source: "hosted-intake",
      store_facts: ["hosted-intake request status from a complete native queue read"],
      condition_fields: ["request_comment", "receipt_comment", "reconciles", "blocker"],
      excluded: ["clocks", "slot detail of a blocked request"],
    },
    wake: {
      rule: "input-digest-changed",
      when: "The request's receipt comment, reconciliation or blocker code changes after the bot receipt completed the operation.",
    },
    lease: null,
    receipt: {
      reference: "The new bot receipt comment URL on #177 for the request or its reconciliation.",
      sha256: "SHA-256 of the exact receipt body.",
    },
    plan: {
      mode: "owner-intake",
      reason:
        "New intake, request edits and process dispatch are owner-only; the existing intake worker resumes only an already authorized final audit with its own checkpoint.",
    },
  },
  "hosted-intake-holds": {
    kind: "hosted-intake-holds",
    deciding_facts: {
      source: "hosted-intake",
      store_facts: ["hosted-intake request status from a complete native queue read"],
      condition_fields: [
        "request_comment",
        "receipt_comment",
        "holds.candidate_index",
        "holds.port_key",
        "holds.repository_id",
        "holds.http_status",
        "holds.resume",
      ],
      excluded: ["clocks", "slots without a hold"],
    },
    wake: {
      rule: "input-digest-changed",
      when: "The request's receipt comment or any held candidate's identity, HTTP status or resume changes after the bot receipt completed the operation.",
    },
    lease: null,
    receipt: {
      reference: "The new bot receipt comment URL on #177 for the request.",
      sha256: "SHA-256 of the exact receipt body.",
    },
    plan: {
      mode: "owner-intake",
      reason: "Process dispatch spends the dedicated Project credential and is owner-only.",
    },
  },
  "release-content-finding": {
    kind: "release-content-finding",
    deciding_facts: {
      source: "release-content",
      store_facts: ["release-content scan facts of the port from a complete scheduled main scan"],
      condition_fields: [
        "findings.platform",
        "findings.repository",
        "findings.tag",
        "findings.asset",
        "findings.sha256",
        "findings.rules",
        "findings.signals",
        "findings.signal_count",
        "unscannable.platform",
        "unscannable.code",
        "unscannable.provider",
      ],
      excluded: ["accounted findings", "coverage notes", "clocks"],
    },
    wake: {
      rule: "reappears-after-clear",
      when: "The port's release-content handoff returns to needs-attention after a scheduled main scan cleared it.",
    },
    lease: { ttl_minutes: 30 },
    receipt: {
      reference:
        "The scheduled main release-content scan run URL whose report no longer reports the finding or package.",
      sha256: "SHA-256 of that scan report artifact.",
    },
    plan: {
      mode: "routine",
      runs_in: routineRunsIn,
      steps: routineSteps(
        "From the stored condition only, list each flagged package with its asset, SHA-256 and kept signals, and each package the scan could not read with its code and provider, for a person to confirm.",
        "Wait for a later scheduled main release-content scan; a dispatched scan never counts.",
      ),
      permissions: routinePermissions,
      never: [
        ...routineNever,
        "confirm game data, write a download hold or an accounting entry, or start relocation evidence",
      ],
    },
  },
};

/** The fence a decision was made on; an executor refuses to act when any part moved. */
export interface GenerationFence {
  /** The handoff subject's transition sequence. */
  sequence: number;
  /** Its applicable assessment. */
  assessment_id: number;
  /** The complete collection run that last verified the subject (`verified_run_id`). */
  source_generation: string;
  /** The assessment's policy version. */
  policy_generation: string;
}

/** The exact store facts a handoff was derived from. */
export interface DecidingFacts {
  kind: HandoffKind;
  subject_key: string;
  /** The applicable assessment's `input_digest`: kind, source subject and stable condition. */
  input_digest: string;
}

export interface HandoffLease {
  holder: string;
  /** Epoch milliseconds. */
  acquired_at: number;
  expires_at: number;
  reclaims: number;
}

export interface HandoffReceipt {
  reference: string;
  sha256: string | null;
  /** Further evidence references (run, artifact or comment URLs). */
  evidence: readonly string[];
}

export type ContractState = "planned" | "leased" | "completed" | "abandoned";

export interface ContractOperation {
  contract_version: typeof handoffContractVersion;
  operation_key: string;
  deciding: DecidingFacts;
  fence: GenerationFence;
  state: ContractState;
  lease: HandoffLease | null;
  /** The last completed plan step, or null before the first. */
  checkpoint: string | null;
  receipt: HandoffReceipt | null;
  /** The sequence at which the completing receipt was recorded. */
  completed_sequence: number | null;
}

/**
 * The deterministic operation key: the same kind, subject, deciding input
 * digest and policy generation always yield the same key, so a replayed
 * finding is recognized. The source generation is a fence, not identity: a
 * later run verifying the same condition is the same operation.
 */
export function handoffOperationKey(deciding: DecidingFacts, policyGeneration: string) {
  const digest = createHash("sha256")
    .update(
      [
        handoffContractVersion,
        deciding.kind,
        deciding.subject_key,
        deciding.input_digest,
        policyGeneration,
      ].join("\t"),
    )
    .digest("hex")
    .slice(0, 40);
  return `handoff.${deciding.kind}.k${digest}`;
}

const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
const text = (value: unknown, limit: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;

/**
 * Schema check of one contract operation against the store's own column
 * constraints; returns every violation, empty when valid.
 */
export function contractOperationErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["operation is not an object"];
  if (value.contract_version !== handoffContractVersion) errors.push("contract_version");
  const deciding = isRecord(value.deciding) ? value.deciding : null;
  const kind = typeof deciding?.kind === "string" ? deciding.kind : "";
  const entry = handoffEntry(kind);
  if (!deciding || !entry) errors.push("deciding.kind");
  else {
    if (
      typeof deciding.subject_key !== "string" ||
      parseHandoffSubject(deciding.subject_key)?.kind !== kind
    )
      errors.push("deciding.subject_key");
    if (typeof deciding.input_digest !== "string" || !sha256Pattern.test(deciding.input_digest))
      errors.push("deciding.input_digest");
  }
  const fence = isRecord(value.fence) ? value.fence : null;
  if (!fence) errors.push("fence");
  else {
    if (!positiveInteger(fence.sequence)) errors.push("fence.sequence");
    if (!positiveInteger(fence.assessment_id)) errors.push("fence.assessment_id");
    if (!text(fence.source_generation, executorLimit)) errors.push("fence.source_generation");
    if (!text(fence.policy_generation, executorLimit)) errors.push("fence.policy_generation");
  }
  if (
    typeof value.operation_key !== "string" ||
    !operationIdPattern.test(value.operation_key) ||
    (deciding &&
      entry &&
      fence &&
      typeof fence.policy_generation === "string" &&
      value.operation_key !==
        handoffOperationKey(deciding as unknown as DecidingFacts, fence.policy_generation))
  )
    errors.push("operation_key");
  const state = value.state;
  if (!["planned", "leased", "completed", "abandoned"].includes(state as string))
    errors.push("state");
  const lease = value.lease;
  if (lease !== null) {
    if (!isRecord(lease)) errors.push("lease");
    else {
      if (!text(lease.holder, executorLimit)) errors.push("lease.holder");
      if (
        !Number.isSafeInteger(lease.acquired_at) ||
        !Number.isSafeInteger(lease.expires_at) ||
        (lease.expires_at as number) <= (lease.acquired_at as number)
      )
        errors.push("lease.window");
      if (!Number.isSafeInteger(lease.reclaims) || (lease.reclaims as number) < 0)
        errors.push("lease.reclaims");
    }
    if (entry && handoffContracts[entry.kind].lease === null) errors.push("lease.owner-only");
  }
  if (state === "leased" && lease === null) errors.push("lease.required");
  if (state !== "leased" && lease !== null) errors.push("lease.unexpected");
  const steps =
    entry && handoffContracts[entry.kind].plan.mode === "routine"
      ? (handoffContracts[entry.kind].plan as RoutineExecutorPlan).steps.map(({ id }) => id)
      : [];
  if (value.checkpoint !== null && !steps.includes(value.checkpoint as string))
    errors.push("checkpoint");
  const receipt = value.receipt;
  if (receipt !== null) {
    if (!isRecord(receipt)) errors.push("receipt");
    else {
      if (!text(receipt.reference, receiptReferenceLimit)) errors.push("receipt.reference");
      if (
        receipt.sha256 !== null &&
        (typeof receipt.sha256 !== "string" || !sha256Pattern.test(receipt.sha256))
      )
        errors.push("receipt.sha256");
      if (
        !Array.isArray(receipt.evidence) ||
        !receipt.evidence.every((reference) => text(reference, receiptReferenceLimit))
      )
        errors.push("receipt.evidence");
    }
  }
  // As the store: completed exactly when a receipt exists.
  if ((state === "completed") !== (receipt !== null)) errors.push("receipt.state");
  if ((state === "completed") !== positiveInteger(value.completed_sequence))
    errors.push("completed_sequence");
  return errors;
}

/** The current store facts of one handoff subject, as an executor would read them. */
export interface HandoffObservation {
  state: "needs-attention" | "clear";
  deciding: DecidingFacts;
  fence: GenerationFence;
}

export type HandoffEvent = { event_id: string } & (
  | { type: "observe"; observation: HandoffObservation }
  | { type: "claim"; holder: string; now: number; fence: GenerationFence }
  | { type: "checkpoint"; holder: string; now: number; step: string; fence: GenerationFence }
  | {
      type: "complete";
      holder: string;
      now: number;
      receipt: HandoffReceipt;
      fence: GenerationFence;
      /** The clear transition the receipt shows (routine receipts are the subject clearing). */
      cleared_sequence: number;
    }
);

/** Descriptions of store writes an executor would make; this module performs none. */
export type HandoffEffect =
  | { type: "record-plan"; operation_key: string }
  | { type: "refence"; operation_key: string; fence: GenerationFence }
  | { type: "abandon"; operation_key: string }
  | { type: "record-lease"; operation_key: string; lease: HandoffLease }
  | { type: "record-checkpoint"; operation_key: string; step: string }
  | { type: "record-receipt"; operation_key: string; receipt: HandoffReceipt };

export interface HandoffModel {
  kind: HandoffKind;
  /** Newest operation last; earlier ones are retained history. */
  operations: readonly ContractOperation[];
  /** Applied event ids, so a replayed event is recognized. */
  applied: readonly string[];
}

export type HandoffRefusal =
  | "dispatch-disabled"
  | "owner-only"
  | "no-open-operation"
  | "stale-fence"
  | "leased"
  | "not-holder"
  | "lease-expired"
  | "checkpoint-order"
  | "receipt-immutable"
  | "kind-mismatch";

export interface HandoffTransition {
  model: HandoffModel;
  outcome: "applied" | "duplicate" | "refused" | "unchanged";
  reason?: HandoffRefusal;
  effects: readonly HandoffEffect[];
}

/**
 * Whether lease events are accepted. The registry's policy is always
 * `disabled`; `modelled` exists only so pure tests can show the lease rules
 * and never reaches a dispatch path.
 */
export type ExecutorPolicy = { dispatch: "disabled" } | { dispatch: "modelled" };

export const registryExecutorPolicy = (kind: HandoffKind): ExecutorPolicy => ({
  dispatch: handoffEntry(kind)!.dispatch,
});

export const emptyHandoffModel = (kind: HandoffKind): HandoffModel => ({
  kind,
  operations: [],
  applied: [],
});

const sameFence = (left: GenerationFence, right: GenerationFence) =>
  left.sequence === right.sequence &&
  left.assessment_id === right.assessment_id &&
  left.source_generation === right.source_generation &&
  left.policy_generation === right.policy_generation;

/** Whether a completed operation re-opens on this observation, by its kind's wake rule. */
export function handoffWakes(completed: ContractOperation, observation: HandoffObservation) {
  if (observation.state !== "needs-attention" || completed.completed_sequence === null)
    return false;
  if (observation.fence.policy_generation !== completed.fence.policy_generation) return true;
  return handoffContracts[completed.deciding.kind].wake.rule === "reappears-after-clear"
    ? observation.fence.sequence > completed.completed_sequence
    : observation.deciding.input_digest !== completed.deciding.input_digest;
}

const planned = (observation: HandoffObservation): ContractOperation => ({
  contract_version: handoffContractVersion,
  operation_key: handoffOperationKey(observation.deciding, observation.fence.policy_generation),
  deciding: observation.deciding,
  fence: observation.fence,
  state: "planned",
  lease: null,
  checkpoint: null,
  receipt: null,
  completed_sequence: null,
});

/**
 * The pure reducer: one event against one handoff's model. A replayed event id
 * is a duplicate with no effect. Executor events are refused unless the policy
 * is modelled and the kind is routine, refused on any fence mismatch, and
 * subject to the lease (an expired lease is reclaimable by the next claim).
 */
export function applyHandoffEvent(
  model: HandoffModel,
  event: HandoffEvent,
  policy: ExecutorPolicy = registryExecutorPolicy(model.kind),
): HandoffTransition {
  if (model.applied.includes(event.event_id)) return { model, outcome: "duplicate", effects: [] };
  const done = (
    operations: readonly ContractOperation[],
    effects: readonly HandoffEffect[],
  ): HandoffTransition => ({
    model: { kind: model.kind, operations, applied: [...model.applied, event.event_id] },
    outcome: effects.length ? "applied" : "unchanged",
    effects,
  });
  const refuse = (reason: HandoffRefusal): HandoffTransition => ({
    model,
    outcome: "refused",
    reason,
    effects: [],
  });
  const operations = model.operations;
  const latest = operations.at(-1);
  const replaceLatest = (operation: ContractOperation) => [...operations.slice(0, -1), operation];

  if (event.type === "observe") {
    const { observation } = event;
    if (observation.deciding.kind !== model.kind) return refuse("kind-mismatch");
    const key = handoffOperationKey(observation.deciding, observation.fence.policy_generation);
    if (!latest || latest.state === "abandoned") {
      if (observation.state === "clear") return done(operations, []);
      const next = planned(observation);
      return done([...operations, next], [{ type: "record-plan", operation_key: key }]);
    }
    if (latest.state === "completed") {
      if (!handoffWakes(latest, observation)) return done(operations, []);
      const next = planned(observation);
      // A wake on an unchanged finding keeps its identity; the reopened plan is a new record.
      return done([...operations, next], [{ type: "record-plan", operation_key: key }]);
    }
    // An open operation (planned or leased). The clear an operation awaits is its
    // receipt's evidence, not an abandonment; the complete event records it.
    if (observation.state === "clear" && latest.checkpoint === "await-receipt")
      return done(operations, []);
    if (observation.state === "clear" || key !== latest.operation_key) {
      const abandoned: ContractOperation = { ...latest, state: "abandoned", lease: null };
      const effects: HandoffEffect[] = [{ type: "abandon", operation_key: latest.operation_key }];
      if (observation.state === "clear") return done(replaceLatest(abandoned), effects);
      effects.push({ type: "record-plan", operation_key: key });
      return done([...replaceLatest(abandoned), planned(observation)], effects);
    }
    if (sameFence(latest.fence, observation.fence)) return done(operations, []);
    // Same identity, newer verification: the open operation is re-fenced, so a
    // holder acting on the old fence is refused and must re-read.
    return done(replaceLatest({ ...latest, fence: observation.fence }), [
      { type: "refence", operation_key: latest.operation_key, fence: observation.fence },
    ]);
  }

  const contract = handoffContracts[model.kind];
  if (contract.plan.mode !== "routine" || contract.lease === null) return refuse("owner-only");
  if (policy.dispatch !== "modelled") return refuse("dispatch-disabled");
  if (!latest || (latest.state !== "planned" && latest.state !== "leased")) {
    if (event.type !== "complete" || latest?.state !== "completed")
      return refuse("no-open-operation");
    // The same receipt delivered again records nothing; a different one is refused.
    return JSON.stringify(latest.receipt) === JSON.stringify(event.receipt)
      ? done(operations, [])
      : refuse("receipt-immutable");
  }
  if (!sameFence(latest.fence, event.fence)) return refuse("stale-fence");
  const ttl = contract.lease.ttl_minutes * 60_000;
  const lease = latest.lease;
  const live = lease !== null && event.now < lease.expires_at;

  if (event.type === "claim") {
    if (live && lease.holder !== event.holder) return refuse("leased");
    const next: HandoffLease = {
      holder: event.holder,
      acquired_at: event.now,
      expires_at: event.now + ttl,
      reclaims: (lease?.reclaims ?? 0) + (lease !== null && !live ? 1 : 0),
    };
    // The claim carries a matching fence, so reading and checking it are done.
    const checkpoint = latest.checkpoint ?? "take-lease";
    return done(replaceLatest({ ...latest, state: "leased", lease: next, checkpoint }), [
      { type: "record-lease", operation_key: latest.operation_key, lease: next },
    ]);
  }
  if (!lease || lease.holder !== event.holder) return refuse("not-holder");
  if (!live) return refuse("lease-expired");
  const steps = contract.plan.steps.map(({ id }) => id);
  if (event.type === "checkpoint") {
    const at = latest.checkpoint === null ? -1 : steps.indexOf(latest.checkpoint);
    const index = steps.indexOf(event.step);
    if (index !== -1 && index <= at) return done(operations, []);
    if (index !== at + 1 || event.step === "record-receipt") return refuse("checkpoint-order");
    return done(replaceLatest({ ...latest, checkpoint: event.step }), [
      { type: "record-checkpoint", operation_key: latest.operation_key, step: event.step },
    ]);
  }
  if (latest.checkpoint !== "await-receipt" || event.cleared_sequence <= latest.fence.sequence)
    return refuse("checkpoint-order");
  const completed: ContractOperation = {
    ...latest,
    state: "completed",
    lease: null,
    checkpoint: "record-receipt",
    receipt: event.receipt,
    completed_sequence: event.cleared_sequence,
  };
  return done(replaceLatest(completed), [
    { type: "record-receipt", operation_key: latest.operation_key, receipt: event.receipt },
  ]);
}
