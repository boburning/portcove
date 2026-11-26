-- Remove the fixed 8 MiB bound on stored discovery collector state (#177).
-- Collection is bounded by measured physical resources instead: the admitted
-- database transfer is sized from the stored state and recent runs, and the
-- client transfer limit follows that admission.
ALTER TABLE portcove_maintenance.discovery_collection_state
  DROP CONSTRAINT discovery_collection_state_state_check;
ALTER TABLE portcove_maintenance.discovery_collection_state
  ADD CONSTRAINT discovery_collection_state_state_check CHECK (jsonb_typeof(state) = 'object');
