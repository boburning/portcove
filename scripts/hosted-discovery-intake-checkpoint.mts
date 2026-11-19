import { connectionFromEnvironment, runSql, sqlLiteral } from "./maintenance-store.mts";

const batches = "portcove_maintenance.discovery_intake_batches";
const candidates = "portcove_maintenance.discovery_intake_candidates";
const executor = "SET LOCAL ROLE portcove_maintenance_executor;";
const active =
  "EXISTS (SELECT 1 FROM portcove_maintenance_meta.discovery_intake_activation WHERE active)";

interface Checkpoint {
  revision: number;
  request_sha256: string;
  receipt_body: string;
  previous_receipt_sha256: string | null;
  candidates: unknown[];
}

export interface HostedIntakeCheckpointStore {
  load(request: number): Checkpoint | null;
  save(
    request: number,
    hash: string,
    revision: number,
    body: string,
    previous: { hash: string; body: string } | null,
    slots: readonly unknown[],
  ): number;
}

export function postgresIntakeCheckpoints(
  environment = connectionFromEnvironment("PORTCOVE_DISCOVERY_DATABASE_URL"),
): HostedIntakeCheckpointStore {
  const query = (sql: string) => runSql(environment, `${executor}\n${sql}`).trim();
  return {
    load(request) {
      const found = query(`SELECT CASE WHEN NOT ${active} THEN 'inactive' ELSE
        (SELECT json_build_object(
        'revision', b.revision, 'request_sha256', b.request_sha256,
        'receipt_body', b.receipt_body, 'previous_receipt_sha256', b.previous_receipt_sha256,
        'candidates', (SELECT json_agg(c.checkpoint ORDER BY c.candidate_index)
          FROM ${candidates} c WHERE c.request_comment = b.request_comment)
      )::text FROM ${batches} b WHERE b.request_comment = ${sqlLiteral(String(request))}::bigint)
        END;`);
      if (found === "inactive")
        throw new Error("Discovery intake is inactive on the restored maintenance store");
      return found ? (JSON.parse(found) as Checkpoint) : null;
    },
    save(request, hash, revision, body, previous, slots) {
      const id = `${sqlLiteral(String(request))}::bigint`;
      const digest = sqlLiteral(hash);
      const receipt = sqlLiteral(body);
      const before = previous === null ? "NULL" : sqlLiteral(previous.hash);
      const beforeBody = previous === null ? "NULL" : sqlLiteral(previous.body);
      const advance =
        revision === 0
          ? `INSERT INTO ${batches}
             (request_comment, request_sha256, revision, receipt_body, previous_receipt_sha256)
           SELECT ${id}, ${digest}, 1, ${receipt}, ${before} WHERE ${active}
           ON CONFLICT DO NOTHING RETURNING request_comment, revision`
          : `UPDATE ${batches}
             SET revision = revision + 1, receipt_body = ${receipt}, previous_receipt_sha256 = ${before}
           WHERE request_comment = ${id} AND request_sha256 = ${digest}
             AND revision = ${sqlLiteral(String(revision))}::integer
             AND receipt_body = ${beforeBody} AND ${active}
           RETURNING request_comment, revision`;
      const result = query(`WITH saved AS (${advance}),
        candidate_updates AS (
          INSERT INTO ${candidates} AS prior (request_comment, candidate_index, checkpoint)
          SELECT saved.request_comment, (slot.ordinal - 1)::integer, slot.value FROM saved
          CROSS JOIN jsonb_array_elements(${sqlLiteral(JSON.stringify(slots))}::jsonb)
            WITH ORDINALITY AS slot(value, ordinal)
          ON CONFLICT (request_comment, candidate_index) DO UPDATE SET checkpoint = EXCLUDED.checkpoint
          WHERE prior.checkpoint IS DISTINCT FROM EXCLUDED.checkpoint
        ) SELECT revision FROM saved;`);
      if (Number(result) !== revision + 1)
        throw new Error(
          "Discovery checkpoint advanced concurrently; reload the exact batch before continuing",
        );
      return Number(result);
    },
  };
}
