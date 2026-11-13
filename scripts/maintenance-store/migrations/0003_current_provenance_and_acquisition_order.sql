-- Portcove maintenance store, migration 0003 (#4129 current provenance).
--
-- Freshness is decided by the database, never by runner clocks or Git SHA
-- order. A collector takes an acquisition ticket from a sequence before any
-- external read. Its runs are admitted only if no run of the same source with
-- an equal or newer ticket has finished. A collection that finishes late is
-- therefore refused whole, and newer accepted state is never replaced.
--
-- Current state separates three facts:
--   assessment_id / sequence / updated_at   the last material transition
--   applicable_assessment_id                the latest applicable assessment
--   verified_run_id / verified_at           the latest accepted verification
-- An unchanged result refreshes the latter two without a transition or a
-- notification. Planned operations bind the applicable assessment as well as
-- the transition sequence, so changed inputs invalidate an old plan.

CREATE SEQUENCE portcove_maintenance.collection_acquisition AS bigint;

ALTER TABLE portcove_maintenance.collection_runs ADD COLUMN acquisition bigint;

-- Existing history keeps its recorded order: a ticket per run, by start time,
-- with runs of one collection (same start) sharing their order.
ALTER TABLE portcove_maintenance.collection_runs DISABLE TRIGGER collection_runs_guard;
UPDATE portcove_maintenance.collection_runs r SET acquisition = o.ticket
  FROM (SELECT run_id, dense_rank() OVER (ORDER BY started_at) AS ticket
          FROM portcove_maintenance.collection_runs) o
 WHERE o.run_id = r.run_id;
ALTER TABLE portcove_maintenance.collection_runs ENABLE TRIGGER collection_runs_guard;
SELECT setval('portcove_maintenance.collection_acquisition',
              coalesce((SELECT max(acquisition) FROM portcove_maintenance.collection_runs), 1),
              EXISTS (SELECT 1 FROM portcove_maintenance.collection_runs));

-- Writers that take no ticket (fixtures, manual operator runs) are admitted at
-- insert time; the collector always takes its ticket before external reads.
ALTER TABLE portcove_maintenance.collection_runs
  ALTER COLUMN acquisition SET NOT NULL,
  ALTER COLUMN acquisition SET DEFAULT nextval('portcove_maintenance.collection_acquisition'),
  ADD CHECK (acquisition >= 1);
CREATE INDEX collection_runs_source_acquisition
  ON portcove_maintenance.collection_runs (source, acquisition);

-- A ticket for one collection, taken before its external reads.
CREATE FUNCTION portcove_maintenance.acquire_collection() RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT nextval('portcove_maintenance.collection_acquisition')
$$;

-- The latest finished run of a source, in acquisition order.
CREATE FUNCTION portcove_maintenance.latest_run(target_source text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT run_id FROM portcove_maintenance.collection_runs
   WHERE source = target_source AND coverage <> 'in_progress'
   ORDER BY acquisition DESC, run_id COLLATE "C" DESC LIMIT 1
$$;

-- The collector's changes-only diff was computed against this baseline. If
-- another run of the source finished since, the diff is invalid; the collector
-- rereads the baseline and retries without repeating its external reads.
CREATE FUNCTION portcove_maintenance.expect_baseline(target_source text, expected_run text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actual text := portcove_maintenance.latest_run(target_source);
BEGIN
  IF actual IS DISTINCT FROM expected_run THEN
    RAISE EXCEPTION 'maintenance baseline changed for %: expected %, found %',
      target_source, coalesce(expected_run, 'none'), coalesce(actual, 'none');
  END IF;
END
$$;

-- Present members as of one run, in acquisition order (replaces 0002's clock order).
CREATE OR REPLACE FUNCTION portcove_maintenance.run_members(target_run text)
RETURNS TABLE (subject_key text, content_sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH target AS (
    SELECT source, acquisition FROM portcove_maintenance.collection_runs WHERE run_id = target_run
  ), latest AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.content_sha256, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      JOIN target t ON r.source = t.source AND r.acquisition <= t.acquisition
      WHERE r.run_id = target_run OR r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.acquisition DESC, o.observation_id DESC
  )
  SELECT subject_key, content_sha256 FROM latest
    WHERE payload IS DISTINCT FROM portcove_maintenance.absent_payload()
$$;

-- Admission: an issued ticket, strictly newer than every run of the source.
CREATE FUNCTION portcove_maintenance.guard_collection_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  issued bigint;
  newer text;
BEGIN
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO issued
    FROM portcove_maintenance.collection_acquisition;
  IF NEW.acquisition > issued THEN
    RAISE EXCEPTION 'collection run % uses unissued acquisition %', NEW.run_id, NEW.acquisition;
  END IF;
  SELECT run_id INTO newer FROM portcove_maintenance.collection_runs
   WHERE source = NEW.source AND acquisition >= NEW.acquisition
   ORDER BY acquisition DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'stale maintenance collection for %: acquisition % is not newer than run %',
      NEW.source, NEW.acquisition, newer;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_runs_admission BEFORE INSERT ON portcove_maintenance.collection_runs
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_collection_admission();

-- Acquisition is part of a run's immutable identity.
CREATE FUNCTION portcove_maintenance.guard_collection_acquisition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.acquisition IS DISTINCT FROM OLD.acquisition THEN
    RAISE EXCEPTION 'collection run identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_runs_acquisition BEFORE UPDATE ON portcove_maintenance.collection_runs
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_collection_acquisition();

-- Current provenance, separate from the last material transition.
ALTER TABLE portcove_maintenance.subject_current
  ADD COLUMN applicable_assessment_id bigint REFERENCES portcove_maintenance.assessments (assessment_id),
  ADD COLUMN verified_run_id text REFERENCES portcove_maintenance.collection_runs (run_id),
  ADD COLUMN verified_acquisition bigint,
  ADD COLUMN verified_at timestamptz;
UPDATE portcove_maintenance.subject_current c
   SET applicable_assessment_id = c.assessment_id, verified_run_id = a.run_id,
       verified_acquisition = r.acquisition, verified_at = c.updated_at
  FROM portcove_maintenance.assessments a
  LEFT JOIN portcove_maintenance.collection_runs r ON r.run_id = a.run_id
 WHERE a.assessment_id = c.assessment_id;
ALTER TABLE portcove_maintenance.subject_current
  ALTER COLUMN applicable_assessment_id SET NOT NULL,
  ALTER COLUMN verified_at SET NOT NULL,
  ADD CHECK ((verified_run_id IS NULL) = (verified_acquisition IS NULL));

-- The run that verified a transition. Absent for legacy writers, which then
-- bind the assessment's own run.
ALTER TABLE portcove_maintenance.subject_transitions
  ADD COLUMN verified_run_id text REFERENCES portcove_maintenance.collection_runs (run_id);

-- Shared freshness check: the verifying run must exist, must not have failed,
-- and must be no older than the subject's current verification.
CREATE FUNCTION portcove_maintenance.verification_acquisition(
  subject text, verifying_run text, current_acquisition bigint) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ticket bigint;
BEGIN
  IF verifying_run IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT acquisition INTO ticket FROM portcove_maintenance.collection_runs
   WHERE run_id = verifying_run AND coverage <> 'failed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verifying run % does not exist or failed', verifying_run;
  END IF;
  IF current_acquisition IS NOT NULL AND ticket < current_acquisition THEN
    RAISE EXCEPTION 'stale maintenance state for %: run % is older than the current verification',
      subject, verifying_run;
  END IF;
  RETURN ticket;
END
$$;

CREATE OR REPLACE FUNCTION portcove_maintenance.guard_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_row portcove_maintenance.subject_current%ROWTYPE;
  next_row portcove_maintenance.assessments%ROWTYPE;
  verifying text;
  ticket bigint;
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
  verifying := coalesce(NEW.verified_run_id, next_row.run_id);
  -- Only an explicitly verifying run is checked for freshness: a legacy writer's
  -- assessment may be an earlier identical row (A -> B -> A on the same inputs).
  ticket := portcove_maintenance.verification_acquisition(
    NEW.subject_key, verifying, CASE WHEN NEW.verified_run_id IS NULL THEN NULL ELSE current_row.verified_acquisition END);
  NEW.verified_run_id := verifying;
  NEW.result_digest := next_row.result_digest;
  NEW.state := next_row.state;
  NEW.recorded_at := statement_timestamp();
  NEW.returns_to_earlier_result := EXISTS (
    SELECT 1 FROM portcove_maintenance.subject_transitions
      WHERE subject_key = NEW.subject_key AND result_digest = next_row.result_digest
  );
  INSERT INTO portcove_maintenance.subject_current AS current_state
      (subject_key, sequence, assessment_id, result_digest, updated_at,
       applicable_assessment_id, verified_run_id, verified_acquisition, verified_at)
    VALUES (NEW.subject_key, NEW.sequence, NEW.assessment_id, next_row.result_digest, NEW.recorded_at,
       NEW.assessment_id, verifying, ticket, NEW.recorded_at)
    ON CONFLICT (subject_key) DO UPDATE
      SET sequence = EXCLUDED.sequence, assessment_id = EXCLUDED.assessment_id,
          result_digest = EXCLUDED.result_digest, updated_at = EXCLUDED.updated_at,
          applicable_assessment_id = EXCLUDED.applicable_assessment_id,
          verified_run_id = EXCLUDED.verified_run_id,
          verified_acquisition = EXCLUDED.verified_acquisition,
          verified_at = EXCLUDED.verified_at
      WHERE current_state.sequence = EXCLUDED.sequence - 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale maintenance state for %: concurrent transition', NEW.subject_key;
  END IF;
  RETURN NEW;
END
$$;

-- A run that verified current state cannot then finish failed, so "verified"
-- never names a failed run, even one still in progress when it verified.
CREATE INDEX subject_transitions_verified_run
  ON portcove_maintenance.subject_transitions (verified_run_id);

CREATE FUNCTION portcove_maintenance.guard_failed_verifier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.coverage = 'failed' AND OLD.coverage = 'in_progress' AND (
       EXISTS (SELECT 1 FROM portcove_maintenance.subject_current WHERE verified_run_id = OLD.run_id)
       OR EXISTS (SELECT 1 FROM portcove_maintenance.subject_transitions WHERE verified_run_id = OLD.run_id)) THEN
    RAISE EXCEPTION 'collection run % verified maintenance state and cannot finish failed', OLD.run_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_runs_failed_verifier BEFORE UPDATE ON portcove_maintenance.collection_runs
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_failed_verifier();

-- An assessment with the current result refreshes current provenance and
-- verification. It is not a transition and creates no notification.
CREATE FUNCTION portcove_maintenance.verify_current(target_assessment bigint, verifying_run text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_row portcove_maintenance.subject_current%ROWTYPE;
  next_row portcove_maintenance.assessments%ROWTYPE;
  ticket bigint;
BEGIN
  SELECT * INTO next_row FROM portcove_maintenance.assessments WHERE assessment_id = target_assessment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assessment % does not exist', target_assessment;
  END IF;
  SELECT * INTO current_row FROM portcove_maintenance.subject_current
    WHERE subject_key = next_row.subject_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject % has no current state to verify', next_row.subject_key;
  END IF;
  IF current_row.result_digest <> next_row.result_digest THEN
    RAISE EXCEPTION 'changed assessment for % requires a transition', next_row.subject_key;
  END IF;
  IF verifying_run IS NULL THEN
    RAISE EXCEPTION 'verification of % names no run', next_row.subject_key;
  END IF;
  ticket := portcove_maintenance.verification_acquisition(
    next_row.subject_key, verifying_run, current_row.verified_acquisition);
  UPDATE portcove_maintenance.subject_current
     SET applicable_assessment_id = target_assessment, verified_run_id = verifying_run,
         verified_acquisition = ticket, verified_at = statement_timestamp()
   WHERE subject_key = next_row.subject_key;
END
$$;

-- Operations bind the applicable assessment as well as the transition fence.
ALTER TABLE portcove_maintenance.operations
  ADD COLUMN fence_assessment_id bigint REFERENCES portcove_maintenance.assessments (assessment_id);

-- Existing plans bind the assessment of the transition they were fenced to,
-- which was the applicable assessment when they were planned.
ALTER TABLE portcove_maintenance.operations DISABLE TRIGGER operations_guard;
UPDATE portcove_maintenance.operations o SET fence_assessment_id = t.assessment_id
  FROM portcove_maintenance.subject_transitions t
 WHERE t.subject_key = o.subject_key AND t.sequence = o.fence_sequence;
ALTER TABLE portcove_maintenance.operations ENABLE TRIGGER operations_guard;

CREATE OR REPLACE FUNCTION portcove_maintenance.guard_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_sequence bigint;
  current_assessment bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operations are retained history';
  END IF;
  SELECT sequence, applicable_assessment_id INTO current_sequence, current_assessment
    FROM portcove_maintenance.subject_current
    WHERE subject_key = NEW.subject_key FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' OR NEW.revision <> 1 OR NEW.receipt_reference IS NOT NULL THEN
      RAISE EXCEPTION 'an operation starts planned at revision 1 without a receipt';
    END IF;
    IF current_sequence IS DISTINCT FROM NEW.fence_sequence THEN
      RAISE EXCEPTION 'stale maintenance state for %: operation fenced at %, current %',
        NEW.subject_key, NEW.fence_sequence, current_sequence;
    END IF;
    IF NEW.fence_assessment_id IS DISTINCT FROM current_assessment THEN
      RAISE EXCEPTION 'stale maintenance state for %: operation bound to assessment %, current %',
        NEW.subject_key, coalesce(NEW.fence_assessment_id::text, 'none'), current_assessment;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.operation_id, NEW.kind, NEW.subject_key, NEW.fence_sequence, NEW.fence_assessment_id, NEW.executor, NEW.created_at)
      IS DISTINCT FROM (OLD.operation_id, OLD.kind, OLD.subject_key, OLD.fence_sequence, OLD.fence_assessment_id, OLD.executor, OLD.created_at) THEN
    RAISE EXCEPTION 'operation identity is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'operation % update time cannot move backwards', OLD.operation_id;
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
  IF NEW.state = 'dispatched' AND (current_sequence IS DISTINCT FROM OLD.fence_sequence
       OR OLD.fence_assessment_id IS DISTINCT FROM current_assessment) THEN
    RAISE EXCEPTION 'stale maintenance state for %: operation fenced at % on assessment %, current % on %',
      OLD.subject_key, OLD.fence_sequence, coalesce(OLD.fence_assessment_id::text, 'none'),
      current_sequence, current_assessment;
  END IF;
  IF OLD.state = 'ambiguous' AND NEW.receipt_reference IS NULL THEN
    RAISE EXCEPTION 'ambiguous operation % resolves only through its original executor receipt',
      OLD.operation_id;
  END IF;
  RETURN NEW;
END
$$;
