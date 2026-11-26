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
import { isRecord } from "./runtime-values.mts";

export type ReconsiderationSource = "issues-project" | "core-target-routes";

export interface DesiredReconsideration {
  /** Episode base: kind, subject and condition digest; the store adds `.<n>` for later episodes. */
  base: string;
  subject_key: string;
  kind: "intentional_deferral" | "technical_hold";
  revisit_authority: string;
  condition: Record<string, unknown> & { source: ReconsiderationSource };
}

/** Truncates by code point, so a cut never leaves a lone surrogate the database refuses. */
export const truncateText = (value: string, length: number) =>
  Array.from(value).slice(0, length).join("");

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
    revisit_authority: truncateText(revisit_authority, 500),
    condition,
  };
}

interface IssueReconsiderationFact {
  number?: number;
  node_id?: string;
  url?: string;
  state?: string;
  project?: { project_id?: string; archived?: boolean; fields?: Record<string, string> }[];
  reconsideration?: { blocker: string | null; resume_condition: string } | null;
  blocked_by?: { number?: number; node_id?: string; url?: string; state?: string }[];
}

function dependencyIssues(fact: IssueReconsiderationFact): number[] {
  return [
    ...new Set(
      (fact.blocked_by ?? [])
        .filter(
          ({ number }) => typeof number === "number" && Number.isSafeInteger(number) && number > 0,
        )
        .map(({ number }) => number!),
    ),
  ].sort((a, b) => a - b);
}

type DependencyRef = { number: number; node_id: string; url: string };

function issueRepository(url: string | undefined, number: number | undefined): string | undefined {
  const match =
    typeof url === "string"
      ? /^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/issues\/([0-9]+)$/iu.exec(url)
      : null;
  return match?.[2] === String(number) ? match[1]?.toLowerCase() : undefined;
}

function dependencyRefs(fact: IssueReconsiderationFact): DependencyRef[] | undefined {
  const edges = fact.blocked_by ?? [];
  const refs: DependencyRef[] = [];
  for (const edge of edges) {
    if (
      typeof edge.number !== "number" ||
      !Number.isSafeInteger(edge.number) ||
      edge.number <= 0 ||
      typeof edge.node_id !== "string" ||
      !edge.node_id ||
      edge.node_id === fact.node_id ||
      typeof edge.url !== "string" ||
      !issueRepository(edge.url, edge.number) ||
      refs.some((ref) => ref.node_id === edge.node_id)
    )
      return undefined;
    refs.push({ number: edge.number, node_id: edge.node_id, url: edge.url });
  }
  return refs.sort((a, b) => a.number - b.number || a.node_id.localeCompare(b.node_id, "en"));
}

/** A complete owner read may identify a review opportunity, never lift a hold.
 * A missing or contradictory dependency is unknown, not closed. */
export function dependencyWake(
  condition: Record<string, unknown>,
  issue: unknown,
  issues: ReadonlyMap<string, unknown>,
  complete: boolean,
): "waiting" | "review-ready" | "unknown" | null {
  if (
    condition.source !== "issues-project" ||
    condition.project_status !== "Blocked" ||
    !Array.isArray(condition.dependency_issues) ||
    !condition.dependency_issues.length
  )
    return null;
  if (!complete || !issue || typeof issue !== "object") return "unknown";
  const fact = issue as IssueReconsiderationFact;
  if (fact.state !== "OPEN") return "unknown";
  const ids = dependencyIssues(fact);
  if (JSON.stringify(ids) !== JSON.stringify(condition.dependency_issues)) return "unknown";
  const refs = dependencyRefs(fact);
  if (
    !refs?.length ||
    !Array.isArray(condition.dependency_refs) ||
    condition.dependency_refs.length !== refs.length
  )
    return "unknown";
  const repository = issueRepository(fact.url, fact.number);
  if (!repository) return "unknown";
  // JSONB may reorder object keys; compare individual identity fields.
  for (const [index, ref] of refs.entries()) {
    const prior: unknown = condition.dependency_refs[index];
    if (
      !isRecord(prior) ||
      prior.number !== ref.number ||
      prior.node_id !== ref.node_id ||
      prior.url !== ref.url
    )
      return "unknown";
  }
  const states = refs.map((ref) => {
    const linked = issues.get(`issue:${ref.number}`) as IssueReconsiderationFact | undefined;
    const edge = fact.blocked_by?.find(({ node_id }) => node_id === ref.node_id);
    if (
      linked?.number !== ref.number ||
      linked.node_id !== ref.node_id ||
      issueRepository(ref.url, ref.number) !== repository ||
      typeof linked.url !== "string" ||
      linked.url.toLowerCase() !== ref.url.toLowerCase() ||
      !edge ||
      edge.state !== linked.state
    )
      return "unknown";
    return linked.state === "OPEN" || linked.state === "CLOSED" ? linked.state : "unknown";
  });
  return states.includes("unknown")
    ? "unknown"
    : states.includes("OPEN")
      ? "waiting"
      : "review-ready";
}

/** Derived queue cohorts from the exact configured Project, not a second planning
 * status. Neutral Watchlist is inventory, not an automatic engineering assignment. */
export function backlogLifecycleReview(
  issues: ReadonlyMap<string, unknown>,
  roadmapProjectId: string,
) {
  const counts = {
    neutral_watchlist: 0,
    watchlist_with_planning: 0,
    watchlist_unknown_planning: 0,
    watchlist_active: 0,
    watchlist_other: 0,
    other_ports: 0,
    unknown_membership: 0,
  };
  const statusStage = new Map<string, { status: string; stage: string; count: number }>();
  for (const payload of issues.values()) {
    if (!payload || typeof payload !== "object") continue;
    const fact = payload as IssueReconsiderationFact;
    if (fact.state !== "OPEN") continue;
    const configured = (fact.project ?? []).filter(
      ({ project_id }) => project_id === roadmapProjectId,
    );
    if (configured.length && configured.every(({ archived }) => archived === true)) continue;
    const active = configured.filter(({ archived }) => archived === false);
    if (active.length !== 1 || configured.some(({ archived }) => archived === undefined)) {
      counts.unknown_membership++;
      continue;
    }
    const fields = active[0]?.fields ?? {};
    if (!fields["Work type"]) {
      counts.unknown_membership++;
      continue;
    }
    if (fields["Work type"] !== "Port") continue;
    const status = fields.Status ?? "Unknown";
    const stage = fields["Port stage"] ?? "Unknown";
    const key = JSON.stringify([status, stage]);
    const group = statusStage.get(key) ?? { status, stage, count: 0 };
    group.count++;
    statusStage.set(key, group);
    if (stage !== "Watchlist") counts.other_ports++;
    else if (status === "In progress" || status === "Validating" || status === "Ready")
      counts.watchlist_active++;
    else if (status !== "Inbox" && status !== "Triage") counts.watchlist_other++;
    else {
      const planning = [
        [fields.Priority, "None"],
        [fields.Horizon, "Someday"],
        [fields["Target release"], "Unscheduled"],
      ] as const;
      if (
        planning.some(([value, neutral]) => value && value !== neutral) ||
        fields["Release commitment"] ||
        dependencyIssues(fact).length
      )
        counts.watchlist_with_planning++;
      else if (planning.every(([value]) => value)) counts.neutral_watchlist++;
      else counts.watchlist_unknown_planning++;
    }
  }
  return {
    scope: "Repository issues and their memberships in the configured Project",
    ...counts,
    status_stage: [...statusStage.values()].sort(
      (a, b) => a.status.localeCompare(b.status, "en") || a.stage.localeCompare(b.stage, "en"),
    ),
  };
}

/**
 * Conditions the complete issue inventory records today in the roadmap
 * Project, the single planning authority; other Projects' fields never count.
 * Closed issues are returned separately: their pending conditions end as
 * `issue-closed`, never as a lifted condition.
 */
export function issueReconsiderations(
  issues: ReadonlyMap<string, unknown>,
  roadmapProjectId: string,
): { conditions: DesiredReconsideration[]; closed: string[] } {
  const result: DesiredReconsideration[] = [];
  const closed: string[] = [];
  for (const [key, payload] of issues) {
    const fact = payload as IssueReconsiderationFact;
    if (typeof fact.number !== "number") continue;
    if (fact.state !== "OPEN") {
      closed.push(key);
      continue;
    }
    const statuses = new Set(
      (fact.project ?? [])
        .filter(({ archived, project_id }) => !archived && project_id === roadmapProjectId)
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
    const refs = dependencyRefs(fact);
    if (statuses.has("Blocked"))
      result.push(
        desired("technical_hold", key, `Project owner of issue #${fact.number} (Status: Blocked)`, {
          source: "issues-project",
          project_status: "Blocked",
          ...recorded,
          ...(!recorded.resume_condition?.trim() && dependencyIssues(fact).length
            ? {
                dependency_issues: dependencyIssues(fact),
                ...(refs ? { dependency_refs: refs } : {}),
              }
            : {}),
        }),
      );
  }
  return { conditions: result, closed };
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
        { source: "core-target-routes", acquisition_hold: truncateText(hold, 1000) },
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
  /** Subjects that ended (a closed issue): their pending conditions are withdrawn as `issue-closed`. */
  closed?: readonly string[];
}): string[] {
  const closed = literal(JSON.stringify(input.closed ?? []));
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
        SET status = CASE WHEN ${closed}::jsonb ? r.subject_key
                            OR EXISTS (SELECT 1 FROM ${desiredRows} d
                                        WHERE d.subject_key = r.subject_key AND d.kind = r.kind)
                          THEN 'withdrawn' ELSE 'satisfied' END,
            resolved_at = clock_timestamp(),
            resolution = jsonb_build_object(
              'authority', r.revisit_authority,
              'observed_by', ${literal(input.run)},
              'outcome', CASE WHEN ${closed}::jsonb ? r.subject_key THEN 'issue-closed'
                              WHEN EXISTS (SELECT 1 FROM ${desiredRows} d
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
