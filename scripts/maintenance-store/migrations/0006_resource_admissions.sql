-- Production admission evidence is part of the portable maintenance store.
-- A crashed caller leaves its reservation charged for the rest of that period.
CREATE TABLE portcove_maintenance_meta.resource_admissions (
  attempt_id uuid PRIMARY KEY,
  requested_by name NOT NULL DEFAULT session_user,
  request_key text NOT NULL CHECK (octet_length(request_key) BETWEEN 1 AND 350),
  operation text NOT NULL,
  source_revision text,
  reason text NOT NULL,
  period_start timestamptz NOT NULL,
  reset_at timestamptz NOT NULL CHECK (reset_at > period_start),
  sampled_at timestamptz NOT NULL,
  sample_origin text NOT NULL CHECK (sample_origin IN ('live', 'november-cutover')),
  reported_bytes bigint NOT NULL CHECK (reported_bytes >= 0),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'completed', 'failed', 'deferred')),
  estimate_bytes bigint CHECK (estimate_bytes >= 0),
  CHECK ((finished_at IS NULL) = (outcome = 'running')),
  CHECK (outcome = 'deferred' OR reserved_bytes > 0)
);
CREATE INDEX resource_admissions_period ON portcove_maintenance_meta.resource_admissions (period_start);
CREATE INDEX resource_admissions_request ON portcove_maintenance_meta.resource_admissions (request_key);

ALTER TABLE portcove_maintenance_meta.resource_admissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY resource_read ON portcove_maintenance_meta.resource_admissions
  FOR SELECT USING (true);
CREATE POLICY resource_reserve ON portcove_maintenance_meta.resource_admissions
  FOR INSERT WITH CHECK (requested_by = session_user);
CREATE POLICY resource_settle ON portcove_maintenance_meta.resource_admissions
  FOR UPDATE USING (requested_by = session_user AND outcome = 'running')
  WITH CHECK (requested_by = session_user AND outcome <> 'running');

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'portcove_maintenance_executor') THEN
    GRANT SELECT, INSERT ON portcove_maintenance_meta.resource_admissions TO portcove_maintenance_executor;
    GRANT UPDATE (outcome, finished_at, estimate_bytes) ON portcove_maintenance_meta.resource_admissions TO portcove_maintenance_executor;
  END IF;
END $$;
