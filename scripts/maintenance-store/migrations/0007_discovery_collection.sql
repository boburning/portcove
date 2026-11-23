-- Unattended discovery collection (#177). The maintenance worker owns one fenced
-- collector state per scope, retains positive provider observations before any
-- canonical identity is resolved, and keeps typed watch conditions that wake when
-- their evidence changes. Discovery never edits the catalog, Roadmap or issues.

-- Collection writers have their own activation and a generation that advances on
-- every portable restore, so a pre-restore lease can never commit afterwards.
ALTER TABLE portcove_maintenance_meta.discovery_intake_activation
  ADD COLUMN collection_active boolean NOT NULL DEFAULT true,
  ADD COLUMN collection_generation bigint NOT NULL DEFAULT 1 CHECK (collection_generation > 0);

CREATE TABLE portcove_maintenance.discovery_collection_state (
  scope text PRIMARY KEY CHECK (scope ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Digest of the collector's source and query definitions when this state was written.
  definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision >= 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  lease_token uuid,
  lease_generation bigint,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_generation IS NULL))
);

CREATE TABLE portcove_maintenance.discovery_collection_attempts (
  attempt_id uuid PRIMARY KEY,
  scope text NOT NULL REFERENCES portcove_maintenance.discovery_collection_state,
  -- Database-issued order, taken before any external read.
  acquisition bigint NOT NULL UNIQUE,
  collection_generation bigint NOT NULL,
  source_revision text NOT NULL CHECK (octet_length(source_revision) BETWEEN 1 AND 100),
  runner text NOT NULL CHECK (octet_length(runner) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'complete', 'partial', 'failed', 'expired')),
  committed_pages integer NOT NULL DEFAULT 0 CHECK (committed_pages >= 0),
  result jsonb CHECK (result IS NULL OR octet_length(result::text) <= 262144),
  CHECK ((finished_at IS NULL) = (outcome = 'running'))
);
CREATE INDEX discovery_collection_attempts_scope
  ON portcove_maintenance.discovery_collection_attempts (scope, acquisition DESC);

-- A positive provider observation exists before canonical identity is resolved.
-- Identical normalized content under one parser version is one row.
CREATE TABLE portcove_maintenance.discovery_observations (
  provider text NOT NULL CHECK (provider IN ('github')),
  provider_id text NOT NULL CHECK (provider_id ~ '^[1-9][0-9]{0,19}$'),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object' AND octet_length(facts::text) <= 16384),
  first_attempt_id uuid NOT NULL REFERENCES portcove_maintenance.discovery_collection_attempts,
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_id, parser_version, content_sha256)
);
CREATE TRIGGER discovery_observations_append_only
  BEFORE UPDATE OR DELETE ON portcove_maintenance.discovery_observations
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER discovery_observations_no_truncate
  BEFORE TRUNCATE ON portcove_maintenance.discovery_observations
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();

-- Current typed waiting condition per provider subject. Evidence changes start a
-- new generation (episode), so A -> B -> A always has a distinct identity.
CREATE TABLE portcove_maintenance.discovery_watches (
  provider text NOT NULL CHECK (provider IN ('github')),
  provider_id text NOT NULL CHECK (provider_id ~ '^[1-9][0-9]{0,19}$'),
  reason text NOT NULL CHECK (reason IN ('no-native-package', 'identity-unresolved', 'source-unavailable')),
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('waiting', 'due', 'resolved')),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  wake text NOT NULL CHECK (octet_length(wake) BETWEEN 1 AND 500),
  updated_attempt_id uuid NOT NULL REFERENCES portcove_maintenance.discovery_collection_attempts,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_id, reason)
);

CREATE TABLE portcove_maintenance.discovery_watch_transitions (
  provider text NOT NULL,
  provider_id text NOT NULL,
  reason text NOT NULL,
  generation integer NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'due', 'resolved')),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  attempt_id uuid NOT NULL REFERENCES portcove_maintenance.discovery_collection_attempts,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_id, reason, generation)
);
CREATE TRIGGER discovery_watch_transitions_append_only
  BEFORE UPDATE OR DELETE ON portcove_maintenance.discovery_watch_transitions
  FOR EACH ROW EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();
CREATE TRIGGER discovery_watch_transitions_no_truncate
  BEFORE TRUNCATE ON portcove_maintenance.discovery_watch_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION portcove_maintenance.refuse_history_rewrite();

-- Take (or take over an expired) lease and a fresh acquisition ticket before any
-- external read. Returns the stored state the worker must resume from.
CREATE FUNCTION portcove_maintenance.discovery_acquire(
  target_scope text, target_attempt uuid, token uuid, lease_seconds integer,
  definition text, revision_source text, runner_name text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  activation record;
  current portcove_maintenance.discovery_collection_state;
  ticket bigint;
BEGIN
  IF lease_seconds NOT BETWEEN 60 AND 7200 THEN
    RAISE EXCEPTION 'Discovery lease must be between 60 and 7200 seconds';
  END IF;
  SELECT collection_active, collection_generation INTO activation
    FROM portcove_maintenance_meta.discovery_intake_activation FOR SHARE;
  IF NOT coalesce(activation.collection_active, false) THEN
    RAISE EXCEPTION 'Discovery collection is inactive on this maintenance store'
      USING ERRCODE = 'P0001', HINT = 'portcove-discovery-inactive';
  END IF;
  INSERT INTO portcove_maintenance.discovery_collection_state
    (scope, definition_sha256, revision, state, state_sha256, updated_at)
    VALUES (target_scope, definition, 0, '{}',
      encode(sha256(convert_to('{}'::jsonb::text, 'UTF8')), 'hex'), clock_timestamp())
    ON CONFLICT DO NOTHING;
  SELECT * INTO current FROM portcove_maintenance.discovery_collection_state
    WHERE scope = target_scope FOR UPDATE;
  IF current.lease_token IS NOT NULL AND current.lease_expires_at > clock_timestamp()
     AND current.lease_generation = activation.collection_generation THEN
    RAISE EXCEPTION 'Discovery scope % is leased until %', target_scope, current.lease_expires_at
      USING ERRCODE = 'P0001', HINT = 'portcove-discovery-leased';
  END IF;
  -- An abandoned attempt is closed as expired; its committed pages remain.
  UPDATE portcove_maintenance.discovery_collection_attempts
    SET outcome = 'expired', finished_at = clock_timestamp()
    WHERE scope = target_scope AND outcome = 'running';
  ticket := portcove_maintenance.acquire_collection();
  UPDATE portcove_maintenance.discovery_collection_state
    SET lease_token = token, lease_generation = activation.collection_generation,
        lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds)
    WHERE scope = target_scope;
  INSERT INTO portcove_maintenance.discovery_collection_attempts
    (attempt_id, scope, acquisition, collection_generation, source_revision, runner, started_at)
    VALUES (target_attempt, target_scope, ticket, activation.collection_generation,
            revision_source, runner_name, clock_timestamp());
  RETURN jsonb_build_object(
    'revision', current.revision, 'state', current.state,
    'state_sha256', current.state_sha256, 'definition_sha256', current.definition_sha256,
    'acquisition', ticket, 'generation', activation.collection_generation);
END $$;

-- Verify the lease, activation generation and expected revision, then commit the
-- next state together with its observations and watch changes. Returns the new
-- revision. A stale, expired or restored writer is refused and changes nothing.
CREATE FUNCTION portcove_maintenance.discovery_commit(
  target_scope text, target_attempt uuid, token uuid, expected_revision bigint,
  definition text, next_state jsonb, lease_seconds integer,
  new_observations jsonb, watch_changes jsonb
) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  activation record;
  current portcove_maintenance.discovery_collection_state;
  attempt portcove_maintenance.discovery_collection_attempts;
  change jsonb;
  prior portcove_maintenance.discovery_watches;
  next_generation integer;
BEGIN
  SELECT collection_active, collection_generation INTO activation
    FROM portcove_maintenance_meta.discovery_intake_activation FOR SHARE;
  SELECT * INTO current FROM portcove_maintenance.discovery_collection_state
    WHERE scope = target_scope FOR UPDATE;
  SELECT * INTO attempt FROM portcove_maintenance.discovery_collection_attempts
    WHERE attempt_id = target_attempt;
  IF NOT coalesce(activation.collection_active, false)
     OR current.lease_token IS DISTINCT FROM token
     OR current.lease_generation IS DISTINCT FROM activation.collection_generation
     OR current.lease_expires_at <= clock_timestamp()
     OR attempt.outcome IS DISTINCT FROM 'running'
     OR attempt.scope IS DISTINCT FROM target_scope
     OR attempt.collection_generation IS DISTINCT FROM activation.collection_generation THEN
    RAISE EXCEPTION 'Discovery lease for % is no longer held by this attempt', target_scope
      USING ERRCODE = 'P0001', HINT = 'portcove-discovery-stale-writer';
  END IF;
  IF current.revision <> expected_revision THEN
    RAISE EXCEPTION 'Discovery state for % advanced concurrently', target_scope
      USING ERRCODE = 'P0001', HINT = 'portcove-discovery-stale-writer';
  END IF;
  IF jsonb_typeof(next_state) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Discovery state must be an object';
  END IF;

  INSERT INTO portcove_maintenance.discovery_observations
    (provider, provider_id, parser_version, content_sha256, repository, facts,
     first_attempt_id, first_seen_at)
  SELECT o.provider, o.provider_id, o.parser_version, o.content_sha256, o.repository, o.facts,
         target_attempt, clock_timestamp()
    FROM jsonb_to_recordset(coalesce(new_observations, '[]'))
      AS o(provider text, provider_id text, parser_version integer, content_sha256 text,
           repository text, facts jsonb)
  ON CONFLICT DO NOTHING;

  FOR change IN SELECT value FROM jsonb_array_elements(coalesce(watch_changes, '[]')) LOOP
    SELECT * INTO prior FROM portcove_maintenance.discovery_watches
      WHERE provider = change->>'provider' AND provider_id = change->>'provider_id'
        AND reason = change->>'reason' FOR UPDATE;
    -- Unchanged evidence and status is quiet; anything else is a new episode.
    IF FOUND AND prior.evidence_sha256 = change->>'evidence_sha256'
       AND prior.status = change->>'status' THEN
      CONTINUE;
    END IF;
    next_generation := coalesce(prior.generation, 0) + 1;
    INSERT INTO portcove_maintenance.discovery_watches AS w
      (provider, provider_id, reason, generation, status, evidence_sha256, wake,
       updated_attempt_id, updated_at)
      VALUES (change->>'provider', change->>'provider_id', change->>'reason', next_generation,
              change->>'status', change->>'evidence_sha256', change->>'wake',
              target_attempt, clock_timestamp())
      ON CONFLICT (provider, provider_id, reason) DO UPDATE SET
        generation = EXCLUDED.generation, status = EXCLUDED.status,
        evidence_sha256 = EXCLUDED.evidence_sha256, wake = EXCLUDED.wake,
        updated_attempt_id = EXCLUDED.updated_attempt_id, updated_at = EXCLUDED.updated_at;
    INSERT INTO portcove_maintenance.discovery_watch_transitions
      (provider, provider_id, reason, generation, status, evidence_sha256, attempt_id, recorded_at)
      VALUES (change->>'provider', change->>'provider_id', change->>'reason', next_generation,
              change->>'status', change->>'evidence_sha256', target_attempt, clock_timestamp());
  END LOOP;

  UPDATE portcove_maintenance.discovery_collection_state
    SET revision = revision + 1, state = next_state,
        state_sha256 = encode(sha256(convert_to(next_state::text, 'UTF8')), 'hex'),
        definition_sha256 = definition, updated_at = clock_timestamp(),
        lease_expires_at = greatest(lease_expires_at,
          clock_timestamp() + make_interval(secs => lease_seconds))
    WHERE scope = target_scope;
  UPDATE portcove_maintenance.discovery_collection_attempts
    SET committed_pages = committed_pages + 1 WHERE attempt_id = target_attempt;
  RETURN current.revision + 1;
END $$;

-- Close the attempt and release the lease. Only the lease holder can finish.
CREATE FUNCTION portcove_maintenance.discovery_finish(
  target_scope text, target_attempt uuid, token uuid, final_outcome text, summary jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF final_outcome NOT IN ('complete', 'partial', 'failed') THEN
    RAISE EXCEPTION 'Unsupported discovery outcome %', final_outcome;
  END IF;
  UPDATE portcove_maintenance.discovery_collection_attempts
    SET outcome = final_outcome, finished_at = clock_timestamp(), result = summary
    WHERE attempt_id = target_attempt AND scope = target_scope AND outcome = 'running'
      AND EXISTS (SELECT 1 FROM portcove_maintenance.discovery_collection_state s
                   WHERE s.scope = target_scope AND s.lease_token = token);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Discovery lease for % is no longer held by this attempt', target_scope
      USING ERRCODE = 'P0001', HINT = 'portcove-discovery-stale-writer';
  END IF;
  UPDATE portcove_maintenance.discovery_collection_state
    SET lease_token = NULL, lease_generation = NULL, lease_expires_at = NULL
    WHERE scope = target_scope AND lease_token = token;
END $$;

REVOKE ALL ON FUNCTION
  portcove_maintenance.discovery_acquire(text, uuid, uuid, integer, text, text, text),
  portcove_maintenance.discovery_commit(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb),
  portcove_maintenance.discovery_finish(text, uuid, uuid, text, jsonb)
  FROM PUBLIC;
