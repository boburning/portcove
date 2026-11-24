-- Scoped Core reassessment (#1422). Each subject's stored Core result is bound
-- to the scoped key it was read under: the mechanism the binary was built from,
-- the shared catalog data, the subject's own catalog partition and the policy.
-- A selective run reuses a subject only while its key, catalog fact, result and
-- newest visible clock-dated value are unchanged since the read. The clock
-- value is compared for equality, so a reader whose clock runs behind the
-- original reader's is never handed a result that saw a later value. The
-- store selects the subjects that need Core, so a run transfers only those.
--
-- A binding is current state, not history: runs, observations and assessments
-- keep the history. Only the run that read the subject can write its binding,
-- while that run is being recorded, and never over a binding from a newer
-- acquisition, so a stale or restored worker cannot replace newer state.

CREATE TABLE portcove_maintenance.core_reuse_bindings (
  source text NOT NULL CHECK (source ~ '^core-port-capabilities(-[a-z0-9]+)*$'),
  subject_key text NOT NULL CHECK (subject_key ~ '^port:[A-Za-z0-9._-]{1,190}$'),
  scope_key text NOT NULL CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  run_id text NOT NULL REFERENCES portcove_maintenance.collection_runs,
  read_at timestamptz NOT NULL,
  -- The newest numeric observed_at (seconds) visible to the read; NULL when none.
  visible_until bigint,
  PRIMARY KEY (source, subject_key)
);

CREATE FUNCTION portcove_maintenance.guard_core_reuse_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  next_run portcove_maintenance.collection_runs%ROWTYPE;
  prior_acquisition bigint;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'core reuse bindings are replaced by newer reads, never deleted';
  END IF;
  SELECT * INTO next_run FROM portcove_maintenance.collection_runs WHERE run_id = NEW.run_id;
  IF next_run.source IS DISTINCT FROM NEW.source OR next_run.coverage <> 'in_progress' THEN
    RAISE EXCEPTION 'binding for % must come from an in-progress run of %', NEW.subject_key, NEW.source;
  END IF;
  IF NEW.read_at IS DISTINCT FROM next_run.started_at THEN
    RAISE EXCEPTION 'binding for % must record its run start', NEW.subject_key;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.source, NEW.subject_key) IS DISTINCT FROM (OLD.source, OLD.subject_key) THEN
      RAISE EXCEPTION 'a binding keeps its subject';
    END IF;
    SELECT acquisition INTO prior_acquisition FROM portcove_maintenance.collection_runs
      WHERE run_id = OLD.run_id;
    IF next_run.acquisition IS NULL OR prior_acquisition IS NULL
       OR next_run.acquisition <= prior_acquisition THEN
      RAISE EXCEPTION 'binding for % is newer than run %', NEW.subject_key, NEW.run_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER core_reuse_bindings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON portcove_maintenance.core_reuse_bindings
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.guard_core_reuse_binding();

CREATE TRIGGER core_reuse_bindings_no_truncate
  BEFORE TRUNCATE ON portcove_maintenance.core_reuse_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.guard_core_reuse_binding();

-- The subjects of `desired` (a JSON array of {"s": subject, "k": scope key,
-- "c": catalog digest, "v": newest visible clock value in seconds or null})
-- that need a Core read, with the first reason that applies. Every other
-- desired subject may be reused: its binding has the same key and catalog
-- fact, its result is still the source's latest member, and the newest clock
-- value visible now is the one its read saw.
CREATE FUNCTION portcove_maintenance.core_reassessment_due(target_source text, desired jsonb)
RETURNS TABLE (subject_key text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH wanted AS (
    SELECT d->>'s' AS subject_key, d->>'k' AS scope_key, d->>'c' AS catalog_digest,
           (d->>'v')::bigint AS visible_until
      FROM jsonb_array_elements(desired) d
  ), members AS (
    SELECT m.subject_key, m.content_sha256
      FROM portcove_maintenance.run_members(portcove_maintenance.latest_run(target_source)) m
  )
  SELECT w.subject_key,
         CASE
           WHEN b.subject_key IS NULL THEN 'unbound'
           WHEN b.scope_key <> w.scope_key THEN 'scope-changed'
           WHEN b.catalog_digest <> w.catalog_digest THEN 'catalog-changed'
           WHEN m.content_sha256 IS DISTINCT FROM b.content_sha256 THEN 'result-changed'
           ELSE 'clock'
         END
    FROM wanted w
    LEFT JOIN portcove_maintenance.core_reuse_bindings b
      ON b.source = target_source AND b.subject_key = w.subject_key
    LEFT JOIN members m ON m.subject_key = w.subject_key
   WHERE b.subject_key IS NULL
      OR b.scope_key <> w.scope_key
      OR b.catalog_digest <> w.catalog_digest
      OR m.content_sha256 IS DISTINCT FROM b.content_sha256
      OR w.visible_until IS DISTINCT FROM b.visible_until
   ORDER BY w.subject_key COLLATE "C"
$$;
