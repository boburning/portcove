-- Store discovery lead records as rows (#177). A commit then carries only the
-- records that changed, instead of resending the whole collector state, and the
-- stored lead set is bounded by the database rather than one document.
CREATE TABLE portcove_maintenance.discovery_lead_records (
  scope text NOT NULL REFERENCES portcove_maintenance.discovery_collection_state,
  lead_id bigint NOT NULL CHECK (lead_id > 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object' AND (record->>'id')::bigint = lead_id),
  updated_attempt_id uuid NOT NULL REFERENCES portcove_maintenance.discovery_collection_attempts,
  PRIMARY KEY (scope, lead_id)
);

DROP FUNCTION portcove_maintenance.discovery_commit(
  text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb);

-- Verify the lease, activation generation and expected revision, then commit the
-- next state together with its observations, watch changes and changed lead
-- records. Returns the new revision. A stale, expired or restored writer is
-- refused and changes nothing.
CREATE FUNCTION portcove_maintenance.discovery_commit(
  target_scope text, target_attempt uuid, token uuid, expected_revision bigint,
  definition text, next_state jsonb, lease_seconds integer,
  new_observations jsonb, watch_changes jsonb, lead_records jsonb
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
  IF lease_seconds NOT BETWEEN 60 AND 7200 THEN
    RAISE EXCEPTION 'Discovery lease must be between 60 and 7200 seconds';
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

  -- Changed lead records only; unchanged rows are not rewritten.
  INSERT INTO portcove_maintenance.discovery_lead_records AS r
    (scope, lead_id, record, updated_attempt_id)
  SELECT target_scope, (l.value->>'id')::bigint, l.value, target_attempt
    FROM jsonb_array_elements(coalesce(lead_records, '[]')) AS l(value)
  ON CONFLICT (scope, lead_id) DO UPDATE
    SET record = EXCLUDED.record, updated_attempt_id = EXCLUDED.updated_attempt_id
    WHERE r.record IS DISTINCT FROM EXCLUDED.record;

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

REVOKE ALL ON FUNCTION portcove_maintenance.discovery_commit(
  text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb) FROM PUBLIC;
