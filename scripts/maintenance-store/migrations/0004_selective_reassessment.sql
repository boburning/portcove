-- Opt-in selective reassessment (#4129). A Core run is either a full read of
-- every subject or a selective one that reused unchanged subjects without
-- calling Core. A reused subject is an unchanged member, exactly like a
-- changes-only member: it writes no observation, assessment, transition or
-- verification, so its verified_at stays at the last real Core read.
-- The reuse key names the Core semantics a run read under; reuse is valid only
-- under the same key as the latest complete run of that source.

ALTER TABLE portcove_maintenance.collection_runs
  ADD COLUMN reassessment text CHECK (reassessment IN ('full', 'selective')),
  ADD COLUMN reuse_key text CHECK (reuse_key ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reused_count integer NOT NULL DEFAULT 0 CHECK (reused_count >= 0),
  ADD CHECK (reused_count = 0 OR (reassessment = 'selective' AND reuse_key IS NOT NULL)),
  ADD CHECK (expected_count IS NULL OR reused_count <= expected_count);

-- These describe how the run was taken: fixed when it starts.
CREATE FUNCTION portcove_maintenance.guard_reassessment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.reassessment, NEW.reuse_key, NEW.reused_count)
      IS DISTINCT FROM (OLD.reassessment, OLD.reuse_key, OLD.reused_count) THEN
    RAISE EXCEPTION 'collection run % reassessment is fixed when it starts', OLD.run_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER collection_runs_reassessment_guard
  BEFORE UPDATE ON portcove_maintenance.collection_runs
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_reassessment();

CREATE INDEX collection_runs_reuse
  ON portcove_maintenance.collection_runs (source, reuse_key, acquisition)
  WHERE reuse_key IS NOT NULL AND coverage = 'complete';
