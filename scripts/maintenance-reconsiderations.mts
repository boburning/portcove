/**
 * Typed reconsideration conditions (#4129), derived only from their canonical
 * owners and never edited in the store:
 *
 * - `intentional_deferral`: an open issue the Project marks `Deferred`. The
 *   Project owner who recorded it is the only authority that reconsiders it, so
 *   only that owner's Project change resolves it; technical viability never does.
 * - `technical_hold` from the Project: an open issue marked `Blocked`, with its
 *   explicit resume condition when the issue records one.
 * - `technical_hold` from Core: a port's reviewed acquisition hold, as Core
 *   reports it for a fresh library.
 *
 * Only a complete read of the owning source creates or resolves conditions: a
 * partial or failed read says nothing about holds and deferrals. Conditions
 * are immutable; a changed condition withdraws the old one and records a new
 * one. Each episode has its own ID, so a deferral lifted and later restored
 * stays two entries in history.
 */
import { createHash } from "node:crypto";

export type ReconsiderationSource = "issues-project" | "core-target-routes";

export interface DesiredReconsideration {
  /** Episode base: kind, subject and condition digest; the store adds `.<n>` for later episodes. */
  base: string;
  subject_key: string;
  kind: "intentional_deferral" | "technical_hold";
  revisit_authority: string;
  condition: Record<string, unknown> & { source: ReconsiderationSource };
}

// Conditions are built here with a fixed key order, so their JSON is stable.
const sha12 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

function desired(
  kind: DesiredReconsideration["kind"],
  subject_key: string,
  revisit_authority: string,
  condition: DesiredReconsideration["condition"],
): DesiredReconsideration {
  const subject = subject_key.replace(/[^A-Za-z0-9.-]/gu, "-");
  return {
    base: `reconsider.${kind}.${subject}.${sha12({ kind, subject_key, condition })}`,
    subject_key,
    kind,
    revisit_authority: revisit_authority.slice(0, 500),
    condition,
  };
}

interface IssueReconsiderationFact {
  number?: number;
  state?: string;
  project?: { archived?: boolean; fields?: Record<string, string> }[];
  reconsideration?: { blocker: string | null; resume_condition: string } | null;
}

/** Conditions the complete issue and Project inventory records today. */
export function issueReconsiderations(
  issues: ReadonlyMap<string, unknown>,
): DesiredReconsideration[] {
  const result: DesiredReconsideration[] = [];
  for (const [key, payload] of issues) {
    const fact = payload as IssueReconsiderationFact;
    if (fact.state !== "OPEN" || typeof fact.number !== "number") continue;
    const statuses = new Set(
      (fact.project ?? [])
        .filter(({ archived }) => !archived)
        .map(({ fields }) => fields?.Status)
        .filter((status): status is string => typeof status === "string"),
    );
    const recorded = {
      resume_condition: fact.reconsideration?.resume_condition ?? null,
      blocker: fact.reconsideration?.blocker ?? null,
    };
    if (statuses.has("Deferred"))
      result.push(
        desired(
          "intentional_deferral",
          key,
          `Project owner of issue #${fact.number} (Status: Deferred)`,
          { source: "issues-project", project_status: "Deferred", ...recorded },
        ),
      );
    if (statuses.has("Blocked"))
      result.push(
        desired("technical_hold", key, `Project owner of issue #${fact.number} (Status: Blocked)`, {
          source: "issues-project",
          project_status: "Blocked",
          ...recorded,
        }),
      );
  }
  return result;
}

/** Reviewed acquisition holds Core reports for a fresh library. */
export function targetReconsiderations(
  targets: ReadonlyMap<string, unknown>,
): DesiredReconsideration[] {
  const result: DesiredReconsideration[] = [];
  for (const [key, payload] of targets) {
    const hold = (payload as { acquisition_hold?: unknown }).acquisition_hold;
    if (typeof hold !== "string" || !hold) continue;
    result.push(
      desired(
        "technical_hold",
        key,
        `Reviewed catalog acquisition hold of ${key.replace(/^port:/u, "")}`,
        { source: "core-target-routes", acquisition_hold: hold.slice(0, 1000) },
      ),
    );
  }
  return result;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * SQL that brings the store's pending conditions of one source in line with
 * that source's complete run: pending conditions the run no longer records are
 * resolved (`satisfied` when lifted, `withdrawn` when replaced by a changed
 * condition), then each recorded condition without a pending episode starts a
 * new one. Resolution names the recorded revisit authority and the observing
 * run; the store enforces that for deferrals.
 */
export function reconsiderationSql(input: {
  source: ReconsiderationSource;
  run: string;
  conditions: readonly DesiredReconsideration[];
}): string[] {
  const rows = JSON.stringify(
    input.conditions.map(({ base, subject_key, kind, revisit_authority, condition }) => ({
      base,
      subject_key,
      kind,
      revisit_authority,
      condition,
    })),
  );
  const desiredRows = `(SELECT d ->> 'base' AS base, d ->> 'subject_key' AS subject_key, d ->> 'kind' AS kind,
      d ->> 'revisit_authority' AS revisit_authority, d -> 'condition' AS condition
      FROM jsonb_array_elements(${literal(rows)}::jsonb) d)`;
  return [
    `UPDATE portcove_maintenance.reconsiderations r
        SET status = CASE WHEN EXISTS (SELECT 1 FROM ${desiredRows} d
                                        WHERE d.subject_key = r.subject_key AND d.kind = r.kind)
                          THEN 'withdrawn' ELSE 'satisfied' END,
            resolved_at = clock_timestamp(),
            resolution = jsonb_build_object(
              'authority', r.revisit_authority,
              'observed_by', ${literal(input.run)},
              'outcome', CASE WHEN EXISTS (SELECT 1 FROM ${desiredRows} d
                                            WHERE d.subject_key = r.subject_key AND d.kind = r.kind)
                              THEN 'condition-changed' ELSE 'condition-lifted' END)
      WHERE r.status = 'pending' AND r.condition ->> 'source' = ${literal(input.source)}
        AND NOT EXISTS (SELECT 1 FROM ${desiredRows} d
                         WHERE d.subject_key = r.subject_key AND d.kind = r.kind
                           AND d.condition = r.condition);`,
    `INSERT INTO portcove_maintenance.reconsiderations
        (reconsideration_id, subject_key, kind, revisit_authority, condition, created_at)
      SELECT CASE WHEN episodes.n = 0 THEN d.base ELSE d.base || '.' || episodes.n END,
             d.subject_key, d.kind, d.revisit_authority, d.condition, clock_timestamp()
        FROM ${desiredRows} d
        CROSS JOIN LATERAL (SELECT count(*) AS n FROM portcove_maintenance.reconsiderations e
                              WHERE e.reconsideration_id = d.base
                                 OR starts_with(e.reconsideration_id, d.base || '.')) episodes
       WHERE NOT EXISTS (SELECT 1 FROM portcove_maintenance.reconsiderations p
                          WHERE p.status = 'pending' AND p.subject_key = d.subject_key
                            AND p.kind = d.kind AND p.condition = d.condition);`,
  ];
}
