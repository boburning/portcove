-- Portcove maintenance store, migration 0001 (#4129 checkpoint 1).
--
-- Operational history only. Catalog, roadmap, planning and Core policy remain
-- in their owners; rows here reference them by immutable identity. Standard
-- PostgreSQL only: no extensions or provider-specific features.

CREATE SCHEMA portcove_maintenance;

-- One bounded collection attempt for one declared source. Coverage is explicit:
-- partial or failed collection is never evidence of absence.
CREATE TABLE portcove_maintenance.collection_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9-]{0,63}$'),
  runner text NOT NULL CHECK (length(runner) BETWEEN 1 AND 200),
  source_revision text CHECK (length(source_revision) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  coverage text NOT NULL DEFAULT 'in_progress'
    CHECK (coverage IN ('in_progress', 'complete', 'partial', 'failed')),
  expected_count integer CHECK (expected_count >= 0),
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  CHECK ((coverage = 'in_progress') = (completed_at IS NULL)),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (
    coverage <> 'complete'
    OR (
      source_revision IS NOT NULL
      AND expected_count IS NOT NULL
      AND expected_count = observed_count
      AND gaps = '[]'::jsonb
    )
  )
);

-- Immutable observation of one canonical subject, bound to its exact input
-- revision and artifact/platform/route/operation scope.
CREATE TABLE portcove_maintenance.observations (
  observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES portcove_maintenance.collection_runs (run_id),
  subject_key text NOT NULL CHECK (length(subject_key) <= 300 AND subject_key ~ '^[a-z][a-z0-9-]{0,31}:[!-~]+$'),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope) = 'object'),
  input_revision text NOT NULL CHECK (length(input_revision) BETWEEN 1 AND 200),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (run_id, subject_key, scope, content_sha256)
);

-- Immutable policy/input-version-bound assessment. Identical pinned inputs and
-- policy resolve to the same row, so full and incremental passes converge.
CREATE TABLE portcove_maintenance.assessments (
  assessment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_key text NOT NULL CHECK (length(subject_key) <= 300 AND subject_key ~ '^[a-z][a-z0-9-]{0,31}:[!-~]+$'),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 200),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  explanation jsonb NOT NULL CHECK (jsonb_typeof(explanation) = 'object'),
  assessed_at timestamptz NOT NULL,
  run_id text REFERENCES portcove_maintenance.collection_runs (run_id),
  UNIQUE (subject_key, policy_version, input_digest)
);

-- Current state per subject. Written only by the transition guard.
CREATE TABLE portcove_maintenance.subject_current (
  subject_key text PRIMARY KEY,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  assessment_id bigint NOT NULL REFERENCES portcove_maintenance.assessments (assessment_id),
  result_digest text NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Ordered, append-only transition history. An unchanged result is not a
-- transition; a return to an earlier result (A -> B -> A) is.
CREATE TABLE portcove_maintenance.subject_transitions (
  subject_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  assessment_id bigint NOT NULL REFERENCES portcove_maintenance.assessments (assessment_id),
  previous_result_digest text,
  result_digest text NOT NULL,
  state text NOT NULL,
  returns_to_earlier_result boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (subject_key, sequence),
  CHECK ((sequence = 1) = (previous_result_digest IS NULL))
);

-- Typed reconsideration conditions. Technical viability never resolves an
-- intentional deferral by itself: every resolution names its authority.
CREATE TABLE portcove_maintenance.reconsiderations (
  reconsideration_id text PRIMARY KEY CHECK (reconsideration_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  subject_key text NOT NULL CHECK (length(subject_key) <= 300 AND subject_key ~ '^[a-z][a-z0-9-]{0,31}:[!-~]+$'),
  kind text NOT NULL
    CHECK (kind IN ('technical_hold', 'intentional_deferral', 'upstream_change', 'evidence_refresh')),
  revisit_authority text NOT NULL CHECK (length(revisit_authority) BETWEEN 1 AND 500),
  condition jsonb NOT NULL CHECK (jsonb_typeof(condition) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'satisfied', 'withdrawn')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution jsonb,
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK ((status = 'pending') = (resolution IS NULL)),
  CHECK (resolution IS NULL OR (jsonb_typeof(resolution) = 'object' AND resolution ? 'authority'))
);

-- Changes-only notification state. Each row binds one recorded transition, so
-- an unchanged observation cannot create a notification.
CREATE TABLE portcove_maintenance.notifications (
  notification_key text PRIMARY KEY CHECK (notification_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  subject_key text NOT NULL,
  transition_sequence bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'suppressed')),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  delivery_receipt text CHECK (length(delivery_receipt) BETWEEN 1 AND 500),
  UNIQUE (subject_key, transition_sequence),
  FOREIGN KEY (subject_key, transition_sequence)
    REFERENCES portcove_maintenance.subject_transitions (subject_key, sequence),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK (status <> 'delivered' OR delivery_receipt IS NOT NULL)
);

-- Guarded handoffs to existing executors. The store keeps only a reference to
-- the original executor receipt, never a second copy of its authority.
CREATE TABLE portcove_maintenance.operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  subject_key text NOT NULL REFERENCES portcove_maintenance.subject_current (subject_key),
  fence_sequence bigint NOT NULL CHECK (fence_sequence >= 1),
  executor text NOT NULL CHECK (length(executor) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'dispatched', 'ambiguous', 'completed', 'abandoned')),
  receipt_reference text CHECK (length(receipt_reference) BETWEEN 1 AND 500),
  receipt_sha256 text CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state NOT IN ('completed') OR receipt_reference IS NOT NULL),
  CHECK (receipt_sha256 IS NULL OR receipt_reference IS NOT NULL)
);

CREATE INDEX observations_subject ON portcove_maintenance.observations (subject_key, observed_at);
CREATE INDEX assessments_subject ON portcove_maintenance.assessments (subject_key, assessed_at);
CREATE INDEX reconsiderations_pending ON portcove_maintenance.reconsiderations (subject_key)
  WHERE status = 'pending';
CREATE INDEX notifications_pending ON portcove_maintenance.notifications (created_at)
  WHERE status = 'pending';
CREATE INDEX operations_open ON portcove_maintenance.operations (subject_key)
  WHERE state IN ('planned', 'dispatched', 'ambiguous');

-- Append-only enforcement.
CREATE FUNCTION portcove_maintenance.refuse_history_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'maintenance history is append-only: % on %', TG_OP, TG_TABLE_NAME;
END
$$;

CREATE TRIGGER observations_append_only BEFORE UPDATE OR DELETE ON portcove_maintenance.observations
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER observations_no_truncate BEFORE TRUNCATE ON portcove_maintenance.observations
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER assessments_append_only BEFORE UPDATE OR DELETE ON portcove_maintenance.assessments
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER assessments_no_truncate BEFORE TRUNCATE ON portcove_maintenance.assessments
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER transitions_append_only BEFORE UPDATE OR DELETE ON portcove_maintenance.subject_transitions
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER transitions_no_truncate BEFORE TRUNCATE ON portcove_maintenance.subject_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();

-- A finished collection run is immutable; observations only join an open run.
CREATE FUNCTION portcove_maintenance.guard_collection_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'maintenance collection runs are retained history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.coverage <> 'in_progress' OR NEW.observed_count <> 0 THEN
      RAISE EXCEPTION 'a collection run starts in progress with no observations';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.coverage <> 'in_progress' THEN
    RAISE EXCEPTION 'collection run % is already finished', OLD.run_id;
  END IF;
  IF (NEW.run_id, NEW.source, NEW.runner, NEW.started_at)
      IS DISTINCT FROM (OLD.run_id, OLD.source, OLD.runner, OLD.started_at)
     OR (OLD.source_revision IS NOT NULL AND NEW.source_revision IS DISTINCT FROM OLD.source_revision) THEN
    RAISE EXCEPTION 'collection run identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON portcove_maintenance.collection_runs
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_collection_run();

CREATE FUNCTION portcove_maintenance.guard_observation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM portcove_maintenance.collection_runs
    WHERE run_id = NEW.run_id AND coverage = 'in_progress' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'observations may only join an in-progress collection run';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER observations_open_run BEFORE INSERT ON portcove_maintenance.observations
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_observation_run();

-- Monotonic current-state guard. A writer names the sequence it expects to
-- create; a stale or restored worker cannot overwrite newer state.
CREATE FUNCTION portcove_maintenance.guard_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_row portcove_maintenance.subject_current%ROWTYPE;
  next_row portcove_maintenance.assessments%ROWTYPE;
BEGIN
  SELECT * INTO next_row FROM portcove_maintenance.assessments
    WHERE assessment_id = NEW.assessment_id;
  IF NOT FOUND OR next_row.subject_key <> NEW.subject_key THEN
    RAISE EXCEPTION 'transition assessment does not belong to subject %', NEW.subject_key;
  END IF;
  SELECT * INTO current_row FROM portcove_maintenance.subject_current
    WHERE subject_key = NEW.subject_key FOR UPDATE;
  IF NOT FOUND THEN
    IF NEW.sequence <> 1 THEN
      RAISE EXCEPTION 'stale maintenance state for %: expected sequence 1, got %', NEW.subject_key, NEW.sequence;
    END IF;
    NEW.previous_result_digest := NULL;
  ELSE
    IF NEW.sequence <> current_row.sequence + 1 THEN
      RAISE EXCEPTION 'stale maintenance state for %: expected sequence %, got %',
        NEW.subject_key, current_row.sequence + 1, NEW.sequence;
    END IF;
    IF current_row.result_digest = next_row.result_digest THEN
      RAISE EXCEPTION 'unchanged assessment for % is not a transition', NEW.subject_key;
    END IF;
    NEW.previous_result_digest := current_row.result_digest;
  END IF;
  NEW.result_digest := next_row.result_digest;
  NEW.state := next_row.state;
  NEW.recorded_at := statement_timestamp();
  NEW.returns_to_earlier_result := EXISTS (
    SELECT 1 FROM portcove_maintenance.subject_transitions
      WHERE subject_key = NEW.subject_key AND result_digest = next_row.result_digest
  );
  INSERT INTO portcove_maintenance.subject_current AS current_state
      (subject_key, sequence, assessment_id, result_digest, updated_at)
    VALUES (NEW.subject_key, NEW.sequence, NEW.assessment_id, next_row.result_digest, NEW.recorded_at)
    ON CONFLICT (subject_key) DO UPDATE
      SET sequence = EXCLUDED.sequence, assessment_id = EXCLUDED.assessment_id,
          result_digest = EXCLUDED.result_digest, updated_at = EXCLUDED.updated_at
      WHERE current_state.sequence = EXCLUDED.sequence - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale maintenance state for %: concurrent transition', NEW.subject_key;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER transitions_guard BEFORE INSERT ON portcove_maintenance.subject_transitions
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_transition();

CREATE FUNCTION portcove_maintenance.guard_reconsideration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconsiderations are retained history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a reconsideration starts pending';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'reconsideration % is already resolved', OLD.reconsideration_id;
  END IF;
  IF (NEW.reconsideration_id, NEW.subject_key, NEW.kind, NEW.revisit_authority, NEW.condition, NEW.created_at)
      IS DISTINCT FROM
     (OLD.reconsideration_id, OLD.subject_key, OLD.kind, OLD.revisit_authority, OLD.condition, OLD.created_at) THEN
    RAISE EXCEPTION 'reconsideration conditions are immutable';
  END IF;
  IF OLD.kind = 'intentional_deferral' AND NEW.status = 'satisfied'
     AND NEW.resolution ->> 'authority' IS DISTINCT FROM OLD.revisit_authority THEN
    RAISE EXCEPTION 'an intentional deferral is reconsidered only by its recorded authority';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER reconsiderations_guard BEFORE INSERT OR UPDATE OR DELETE ON portcove_maintenance.reconsiderations
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_reconsideration();

CREATE FUNCTION portcove_maintenance.guard_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification state is retained history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a notification starts pending';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'notification % is already %', OLD.notification_key, OLD.status;
  END IF;
  IF (NEW.notification_key, NEW.subject_key, NEW.transition_sequence, NEW.created_at)
      IS DISTINCT FROM (OLD.notification_key, OLD.subject_key, OLD.transition_sequence, OLD.created_at) THEN
    RAISE EXCEPTION 'notification identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER notifications_guard BEFORE INSERT OR UPDATE OR DELETE ON portcove_maintenance.notifications
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_notification();

-- Operation lifecycle with optimistic revision fencing and current-state
-- revalidation before dispatch. An ambiguous remote write is reconciled only
-- through the original executor's receipt.
CREATE FUNCTION portcove_maintenance.guard_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_sequence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operations are retained history';
  END IF;
  SELECT sequence INTO current_sequence FROM portcove_maintenance.subject_current
    WHERE subject_key = NEW.subject_key FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' OR NEW.revision <> 1 OR NEW.receipt_reference IS NOT NULL THEN
      RAISE EXCEPTION 'an operation starts planned at revision 1 without a receipt';
    END IF;
    IF current_sequence IS DISTINCT FROM NEW.fence_sequence THEN
      RAISE EXCEPTION 'stale maintenance state for %: operation fenced at %, current %',
        NEW.subject_key, NEW.fence_sequence, current_sequence;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.operation_id, NEW.kind, NEW.subject_key, NEW.fence_sequence, NEW.executor, NEW.created_at)
      IS DISTINCT FROM (OLD.operation_id, OLD.kind, OLD.subject_key, OLD.fence_sequence, OLD.executor, OLD.created_at) THEN
    RAISE EXCEPTION 'operation identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'stale operation revision for %: expected %, got %',
      OLD.operation_id, OLD.revision + 1, NEW.revision;
  END IF;
  IF OLD.receipt_reference IS NOT NULL
     AND (NEW.receipt_reference, NEW.receipt_sha256) IS DISTINCT FROM (OLD.receipt_reference, OLD.receipt_sha256) THEN
    RAISE EXCEPTION 'original executor receipt reference is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'planned' AND NEW.state IN ('dispatched', 'abandoned'))
    OR (OLD.state = 'dispatched' AND NEW.state IN ('completed', 'ambiguous'))
    OR (OLD.state = 'ambiguous' AND NEW.state IN ('completed', 'abandoned'))
  ) THEN
    RAISE EXCEPTION 'operation % cannot move from % to %', OLD.operation_id, OLD.state, NEW.state;
  END IF;
  IF NEW.state = 'dispatched' AND current_sequence IS DISTINCT FROM OLD.fence_sequence THEN
    RAISE EXCEPTION 'stale maintenance state for %: operation fenced at %, current %',
      OLD.subject_key, OLD.fence_sequence, current_sequence;
  END IF;
  IF OLD.state = 'ambiguous' AND NEW.receipt_reference IS NULL THEN
    RAISE EXCEPTION 'ambiguous operation % resolves only through its original executor receipt',
      OLD.operation_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER operations_guard BEFORE INSERT OR UPDATE OR DELETE ON portcove_maintenance.operations
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_operation();
