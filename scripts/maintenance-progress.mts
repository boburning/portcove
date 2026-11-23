/** Progress uses the existing store, append-only history and changes-only digest. */
import { isRecord } from "./runtime-values.mts";
import { randomUUID } from "node:crypto";
import { observationHash } from "./upstream-observer.mts";
import {
  progressCondition,
  progressDisplay,
  validProgressRecord,
  type ProgressCollection,
  type ProgressRecord,
} from "./upstream-progress.mts";
const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
const json = (v: unknown) => `${literal(JSON.stringify(v))}::jsonb`;
/** Called inside the inventory's source lock and acquisition-fenced transaction. */
export function progressCollectionSql(
  input: ProgressCollection,
  runner: string,
  acquisition?: number,
): string[] {
  const lines: string[] = [];
  const ordered = [...input.results].sort((a, b) => a.key.localeCompare(b.key));
  for (const result of ordered) {
    const source = `research-progress-${observationHash(result.key).slice(0, 16)}`;
    const run = `${source}:${randomUUID()}`;
    const good = result.status === "observed" || result.status === "opted-out";
    const gaps = good
      ? []
      : [{ subject_key: result.key, code: result.status, message: result.reason }];
    lines.push(
      `SELECT pg_advisory_xact_lock(hashtext('portcove-maintenance-source:'||${literal(source)}));`,
      `INSERT INTO portcove_maintenance.collection_runs (run_id,source,runner,source_revision,started_at,acquisition)
       VALUES (${literal(run)},${literal(source)},${literal(runner)},${literal(input.revision)},${literal(input.checked_at)},${acquisition ?? "DEFAULT"});`,
    );
    if (good) {
      const payload =
        result.status === "opted-out"
          ? { status: "opted-out", repository: result.source.repository }
          : { status: "observed", record: result.record };
      const digest = observationHash(payload);
      lines.push(`INSERT INTO portcove_maintenance.observations (run_id,subject_key,scope,input_revision,content_sha256,observed_at,payload)
       SELECT ${literal(run)},${literal(result.key)},${json({ source, provider: result.source.provider, repository: result.source.repository, version: result.source.version })},${literal(input.revision)},${literal(digest)},statement_timestamp(),${json(payload)}
       WHERE (SELECT o.content_sha256 FROM portcove_maintenance.observations o JOIN portcove_maintenance.collection_runs r ON r.run_id=o.run_id
         WHERE r.source=${literal(source)} AND o.subject_key=${literal(result.key)} ORDER BY r.acquisition DESC,o.observation_id DESC LIMIT 1) IS DISTINCT FROM ${literal(digest)};`);
      lines.push(`UPDATE portcove_maintenance.collection_runs SET coverage='complete',completed_at=clock_timestamp(),expected_count=1,member_count=1,
       member_digest=encode(sha256(convert_to(${literal(result.key + "\t" + digest)},'UTF8')),'hex') WHERE run_id=${literal(run)};`);
    } else
      lines.push(
        `UPDATE portcove_maintenance.collection_runs SET coverage='failed',completed_at=clock_timestamp(),expected_count=1,gaps=${json(gaps)} WHERE run_id=${literal(run)};`,
      );
    if (!good) continue;
    const condition = progressCondition(result);
    if (!condition) continue;
    const subject = `${result.key}:condition`,
      policy = "research-progress/1";
    const digest = observationHash(condition),
      state = condition.met ? "milestone-observed" : "milestone-not-observed";
    const explanation = {
      ...condition,
      repository: result.source.repository,
      game_key: result.source.game_key,
      version: result.source.version,
      evidence_url: result.source.evidence_url,
      authority: "research-only",
      dispatch: "disabled",
      resume:
        "Review this observation against the canonical issue's recorded condition; it cannot reverse an intentional deferral.",
    };
    const resultDigest = observationHash({ state, explanation });
    lines.push(
      `INSERT INTO portcove_maintenance.assessments (subject_key,policy_version,input_digest,state,result_digest,explanation,assessed_at,run_id)
      VALUES (${literal(subject)},${literal(policy)},${literal(digest)},${literal(state)},${literal(resultDigest)},${json(explanation)},statement_timestamp(),${literal(run)})
      ON CONFLICT (subject_key,policy_version,input_digest) DO NOTHING;`,
      `INSERT INTO portcove_maintenance.subject_transitions (subject_key,sequence,assessment_id,verified_run_id)
      SELECT a.subject_key,coalesce(c.sequence,0)+1,a.assessment_id,${literal(run)} FROM portcove_maintenance.assessments a
      LEFT JOIN portcove_maintenance.subject_current c ON c.subject_key=a.subject_key WHERE a.subject_key=${literal(subject)} AND a.policy_version=${literal(policy)} AND a.input_digest=${literal(digest)} AND c.result_digest IS DISTINCT FROM a.result_digest;`,
      `SELECT portcove_maintenance.verify_current(a.assessment_id,${literal(run)}) FROM portcove_maintenance.assessments a JOIN portcove_maintenance.subject_current c ON c.subject_key=a.subject_key
       WHERE a.subject_key=${literal(subject)} AND a.policy_version=${literal(policy)} AND a.input_digest=${literal(digest)} AND c.result_digest=a.result_digest;`,
      `INSERT INTO portcove_maintenance.notifications (notification_key,subject_key,transition_sequence,created_at)
       SELECT 'transition:'||t.subject_key||':'||t.sequence,t.subject_key,t.sequence,statement_timestamp() FROM portcove_maintenance.subject_transitions t
       JOIN portcove_maintenance.subject_current c ON c.subject_key=t.subject_key AND c.sequence=t.sequence WHERE t.subject_key=${literal(subject)} AND t.sequence>1
       ON CONFLICT (notification_key) DO NOTHING;`,
    );
  }
  return lines;
}
export interface StoredProgress {
  subject_key: string;
  payload: { status: string; repository?: string; record?: ProgressRecord };
  checked_at: string;
  latest_attempt?: string;
  last_attempt_at?: string;
}
/** A project opt-out suppresses every provider and historical display for that repository. */
export function visibleProgress(rows: readonly StoredProgress[], now = new Date()) {
  const safe = rows.filter(
    (r) =>
      isRecord(r) &&
      typeof r.subject_key === "string" &&
      isRecord(r.payload) &&
      typeof r.checked_at === "string" &&
      Number.isFinite(Date.parse(r.checked_at)),
  );
  const opted = new Set(
    safe
      .filter((r) => r.payload.status === "opted-out" && typeof r.payload.repository === "string")
      .map((r) => r.payload.repository!.toLowerCase()),
  );
  return safe
    .filter(
      (r) =>
        r.payload.status === "observed" &&
        validProgressRecord(r.payload.record) &&
        !opted.has(r.payload.record.repository.toLowerCase()),
    )
    .map((r) => ({
      subject_key: r.subject_key,
      ...progressDisplay(r.payload.record!, r.checked_at, now),
      latest_attempt: r.latest_attempt ?? "complete",
      last_attempt_at: r.last_attempt_at ?? r.checked_at,
    }));
}
export const progressReportQuery = `(SELECT coalesce(json_agg(p ORDER BY p.subject_key),'[]') FROM (
  SELECT DISTINCT ON (o.subject_key) o.subject_key,o.payload,
    (SELECT r2.coverage FROM portcove_maintenance.collection_runs r2 WHERE r2.source=r.source AND r2.coverage<>'in_progress' ORDER BY r2.acquisition DESC LIMIT 1) AS latest_attempt,
    (SELECT r2.completed_at FROM portcove_maintenance.collection_runs r2 WHERE r2.source=r.source AND r2.coverage<>'in_progress' ORDER BY r2.acquisition DESC LIMIT 1) AS last_attempt_at,
    (SELECT max(r2.completed_at) FROM portcove_maintenance.collection_runs r2
      WHERE r2.source=r.source AND r2.coverage='complete') AS checked_at
    FROM portcove_maintenance.observations o JOIN portcove_maintenance.collection_runs r ON r.run_id=o.run_id
    WHERE r.source LIKE 'research-progress-%' AND r.coverage<>'in_progress' ORDER BY o.subject_key,r.acquisition DESC,o.observation_id DESC) p)`;

/** Public report/digest readers suppress prior research when a current project opt-out exists. */
export const progressOptedOutRepositoriesQuery = `(SELECT lower(p.payload ->> 'repository') FROM (
  SELECT DISTINCT ON (o.subject_key) o.payload FROM portcove_maintenance.observations o
  JOIN portcove_maintenance.collection_runs r ON r.run_id=o.run_id
  WHERE r.source LIKE 'research-progress-%' AND r.coverage<>'in_progress'
  ORDER BY o.subject_key,r.acquisition DESC,o.observation_id DESC) p WHERE p.payload ->> 'status'='opted-out')`;
