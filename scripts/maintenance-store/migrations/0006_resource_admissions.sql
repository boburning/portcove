-- Production admission evidence is part of the portable maintenance store.
-- A crashed caller leaves its reservation charged for the rest of that period.
CREATE TABLE portcove_maintenance_meta.resource_admissions (
  attempt_id uuid PRIMARY KEY,
  request_key text NOT NULL CHECK (octet_length(request_key) BETWEEN 1 AND 350),
  operation text NOT NULL,
  source_revision text,
  reason text NOT NULL,
  period_start timestamptz NOT NULL,
  reset_at timestamptz NOT NULL CHECK (reset_at > period_start),
  sampled_at timestamptz NOT NULL,
  reported_bytes bigint NOT NULL CHECK (reported_bytes >= 0),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'completed', 'failed', 'deferred')),
  estimate_bytes bigint CHECK (estimate_bytes >= 0),
  CHECK ((finished_at IS NULL) = (outcome = 'running'))
);
CREATE INDEX resource_admissions_period ON portcove_maintenance_meta.resource_admissions (period_start);
CREATE INDEX resource_admissions_request ON portcove_maintenance_meta.resource_admissions (request_key);
