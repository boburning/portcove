-- Portcove maintenance store, migration 0002 (#4129 checkpoint 3).
--
-- Changes-only observation storage. A run stores an observation only for a
-- subject whose content changed since that subject's latest observation from
-- the same source, plus an explicit absence when a complete run no longer sees
-- a previously present subject. The run records its member count and a digest
-- of every present subject's current content digest; the database recomputes
-- both from retained observations, so completeness stays verified without one
-- row per subject per run.

ALTER TABLE portcove_maintenance.collection_runs
  ADD COLUMN member_count integer CHECK (member_count >= 0),
  ADD COLUMN member_digest text CHECK (member_digest ~ '^[0-9a-f]{64}$'),
  ADD CHECK ((member_count IS NULL) = (member_digest IS NULL));

CREATE INDEX observations_source_subject
  ON portcove_maintenance.observations (run_id, subject_key, observation_id);

-- The canonical absence payload. Only a complete run may record it.
CREATE FUNCTION portcove_maintenance.absent_payload() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$ SELECT '{"absent": true}'::jsonb $$;

-- Present members of a source as of one run: each subject's latest observation
-- from runs of the same source started no later than that run, excluding
-- subjects whose latest observation is an absence.
CREATE FUNCTION portcove_maintenance.run_members(target_run text)
RETURNS TABLE (subject_key text, content_sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH target AS (
    SELECT source, started_at FROM portcove_maintenance.collection_runs WHERE run_id = target_run
  ), latest AS (
    SELECT DISTINCT ON (o.subject_key) o.subject_key, o.content_sha256, o.payload
      FROM portcove_maintenance.observations o
      JOIN portcove_maintenance.collection_runs r ON r.run_id = o.run_id
      JOIN target t ON r.source = t.source AND r.started_at <= t.started_at
      WHERE r.run_id = target_run OR r.coverage <> 'in_progress'
      ORDER BY o.subject_key, r.started_at DESC, o.observation_id DESC
  )
  SELECT subject_key, content_sha256 FROM latest
    WHERE payload IS DISTINCT FROM portcove_maintenance.absent_payload()
$$;

CREATE OR REPLACE FUNCTION portcove_maintenance.guard_collection_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  members bigint;
  digest text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'maintenance collection runs are retained history';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.coverage <> 'in_progress' OR NEW.observed_count <> 0
       OR NEW.member_count IS NOT NULL OR NEW.member_digest IS NOT NULL THEN
      RAISE EXCEPTION 'a collection run starts in progress with no observations';
    END IF;
    IF EXISTS (SELECT 1 FROM portcove_maintenance.collection_runs
                 WHERE source = NEW.source AND coverage = 'in_progress') THEN
      RAISE EXCEPTION 'source % already has a collection run in progress', NEW.source;
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
  IF NEW.coverage <> 'in_progress' THEN
    IF NEW.completed_at < (SELECT max(observed_at) FROM portcove_maintenance.observations WHERE run_id = OLD.run_id) THEN
      RAISE EXCEPTION 'collection run % cannot finish before its last observation', OLD.run_id;
    END IF;
    IF NEW.coverage <> 'complete' AND EXISTS (
         SELECT 1 FROM portcove_maintenance.observations
           WHERE run_id = OLD.run_id AND payload = portcove_maintenance.absent_payload()) THEN
      RAISE EXCEPTION 'only a complete collection run may record an absence';
    END IF;
    IF NEW.member_digest IS NULL THEN
      -- Every-subject runs (migration 0001 semantics): the count is the retained observations.
      NEW.observed_count := (SELECT count(*) FROM portcove_maintenance.observations WHERE run_id = OLD.run_id);
    ELSE
      SELECT count(*), encode(sha256(convert_to(coalesce(
               string_agg(m.subject_key || E'\t' || m.content_sha256, E'\n' ORDER BY m.subject_key COLLATE "C"), ''),
               'UTF8')), 'hex')
        INTO members, digest
        FROM portcove_maintenance.run_members(OLD.run_id) m;
      IF NEW.coverage = 'complete' AND (members <> NEW.member_count OR digest <> NEW.member_digest) THEN
        RAISE EXCEPTION 'collection run % membership differs from its retained observations (% recorded, % declared)',
          OLD.run_id, members, NEW.member_count;
      END IF;
      NEW.observed_count := NEW.member_count;
    END IF;
    IF NEW.coverage = 'complete' AND NEW.expected_count IS DISTINCT FROM NEW.observed_count THEN
      RAISE EXCEPTION 'collection run % observed % of % expected subjects; it is not complete',
        OLD.run_id, NEW.observed_count, NEW.expected_count;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
