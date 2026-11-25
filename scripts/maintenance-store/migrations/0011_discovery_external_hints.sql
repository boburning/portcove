-- Separate independently changing external hints from the collector continuation.
-- Preserve complete legacy acquire/commit semantics through fenced wrappers.
CREATE TABLE portcove_maintenance.discovery_external_hints (
  scope text NOT NULL REFERENCES portcove_maintenance.discovery_collection_state(scope),
  hint_key text NOT NULL,
  hint jsonb NOT NULL CHECK (jsonb_typeof(hint) = 'object'),
  PRIMARY KEY (scope, hint_key)
);

-- Fail instead of silently losing an invalid historical hints document.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM portcove_maintenance.discovery_collection_state
      WHERE state #> '{leads,external,hints}' IS NOT NULL
        AND jsonb_typeof(state #> '{leads,external,hints}') <> 'object') THEN
    RAISE EXCEPTION 'Discovery external hints must be an object before migration';
  END IF;
END $$;

INSERT INTO portcove_maintenance.discovery_external_hints (scope, hint_key, hint)
SELECT s.scope, h.key, h.value
FROM portcove_maintenance.discovery_collection_state s
CROSS JOIN LATERAL jsonb_each(coalesce(s.state #> '{leads,external,hints}', '{}'::jsonb)) h;

UPDATE portcove_maintenance.discovery_collection_state
SET state = state #- '{leads,external,hints}',
    state_sha256 = encode(sha256(convert_to((state #- '{leads,external,hints}')::text, 'UTF8')), 'hex')
WHERE state #> '{leads,external,hints}' IS NOT NULL;

-- The complete logical state remains the reader contract. No second mutable
-- authority: both row storage and its compact continuation share one revision.
CREATE FUNCTION portcove_maintenance.discovery_expanded_state(target_scope text, compact jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(compact #> '{leads,external}') = 'object'
    THEN jsonb_set(compact, '{leads,external,hints}', coalesce(
      (SELECT jsonb_object_agg(hint_key, hint) FROM portcove_maintenance.discovery_external_hints
       WHERE scope = target_scope), '{}'::jsonb))
    ELSE compact END;
$$;
REVOKE ALL ON FUNCTION portcove_maintenance.discovery_expanded_state(text, jsonb) FROM PUBLIC;

ALTER FUNCTION portcove_maintenance.discovery_acquire(text, uuid, uuid, integer, text, text, text)
  RENAME TO discovery_acquire_compact;
ALTER FUNCTION portcove_maintenance.discovery_commit(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb)
  RENAME TO discovery_commit_compact;
-- Remove any prior grant to the old names; only the fenced wrapper may call
-- the compact functions, including on a store upgraded in place.
REVOKE ALL ON FUNCTION portcove_maintenance.discovery_acquire_compact(text, uuid, uuid, integer, text, text, text),
  portcove_maintenance.discovery_commit_compact(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb)
  FROM PUBLIC;
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portcove_maintenance_collector') THEN
    REVOKE ALL ON FUNCTION portcove_maintenance.discovery_acquire_compact(text, uuid, uuid, integer, text, text, text),
      portcove_maintenance.discovery_commit_compact(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb)
      FROM portcove_maintenance_collector;
  END IF;
END $;

CREATE FUNCTION portcove_maintenance.discovery_acquire(
  target_scope text, target_attempt uuid, token uuid, lease_seconds integer,
  definition text, revision_source text, runner_name text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  grant_value jsonb;
  expanded jsonb;
BEGIN
  grant_value := portcove_maintenance.discovery_acquire_compact(
    target_scope, target_attempt, token, lease_seconds, definition, revision_source, runner_name);
  expanded := portcove_maintenance.discovery_expanded_state(target_scope, grant_value->'state');
  RETURN grant_value || jsonb_build_object('state', expanded,
    'state_sha256', encode(sha256(convert_to(expanded::text, 'UTF8')), 'hex'));
END $$;

CREATE FUNCTION portcove_maintenance.discovery_commit(
  target_scope text, target_attempt uuid, token uuid, expected_revision bigint,
  definition text, next_state jsonb, lease_seconds integer,
  new_observations jsonb, watch_changes jsonb, lead_records jsonb
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  hints jsonb := coalesce(next_state #> '{leads,external,hints}', '{}'::jsonb);
  next_revision bigint;
BEGIN
  IF jsonb_typeof(hints) IS DISTINCT FROM 'object'
    OR (jsonb_typeof(next_state #> '{leads,external}') = 'object'
      AND next_state #> '{leads,external,hints}' IS NULL) THEN
    RAISE EXCEPTION 'Discovery commit requires complete external hints';
  END IF;
  -- The original function validates the lease, activation and revision before
  -- any row mutation. Its lock and changes remain in this same transaction.
  next_revision := portcove_maintenance.discovery_commit_compact(
    target_scope, target_attempt, token, expected_revision, definition,
    next_state #- '{leads,external,hints}', lease_seconds, new_observations, watch_changes, lead_records);

  INSERT INTO portcove_maintenance.discovery_external_hints AS h (scope, hint_key, hint)
  SELECT target_scope, key, value FROM jsonb_each(hints)
  ON CONFLICT (scope, hint_key) DO UPDATE SET hint = EXCLUDED.hint
    WHERE h.hint IS DISTINCT FROM EXCLUDED.hint;
  DELETE FROM portcove_maintenance.discovery_external_hints h
    WHERE h.scope = target_scope AND NOT (hints ? h.hint_key);
  RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION portcove_maintenance.discovery_acquire(text, uuid, uuid, integer, text, text, text),
  portcove_maintenance.discovery_commit(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb)
  FROM PUBLIC;
