-- Portcove maintenance store limited-role contract (#4129 checkpoint 1).
--
-- Idempotent. Applied after every migration and after every restore, because
-- backups intentionally omit ownership and privileges so they restore onto an
-- independent PostgreSQL host. Roles are NOLOGIN groups; operators grant
-- membership to their own login roles outside the repository.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'portcove_maintenance_collector',
    'portcove_maintenance_report',
    'portcove_maintenance_executor'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON SCHEMA portcove_maintenance FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA portcove_maintenance
  FROM PUBLIC, portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA portcove_maintenance FROM PUBLIC;
REVOKE ALL ON SCHEMA portcove_maintenance_meta FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA portcove_maintenance_meta FROM PUBLIC;

GRANT USAGE ON SCHEMA portcove_maintenance
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;
GRANT USAGE ON SCHEMA portcove_maintenance_meta
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;
GRANT SELECT ON ALL TABLES IN SCHEMA portcove_maintenance
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;
GRANT SELECT ON portcove_maintenance_meta.schema_migrations
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;

-- Collector: records runs, observations, assessments, transitions,
-- reconsiderations and changes-only notifications. It never dispatches.
GRANT INSERT ON
  portcove_maintenance.collection_runs,
  portcove_maintenance.observations,
  portcove_maintenance.assessments,
  portcove_maintenance.subject_transitions,
  portcove_maintenance.reconsiderations,
  portcove_maintenance.notifications
  TO portcove_maintenance_collector;
GRANT UPDATE (completed_at, coverage, source_revision, expected_count, observed_count, gaps,
  member_count, member_digest)
  ON portcove_maintenance.collection_runs TO portcove_maintenance_collector;
GRANT UPDATE (status, resolved_at, resolution)
  ON portcove_maintenance.reconsiderations TO portcove_maintenance_collector;
GRANT UPDATE (status) ON portcove_maintenance.notifications TO portcove_maintenance_collector;

-- Executor: plans and advances guarded operations and records delivery
-- receipts. It cannot write observations, assessments or history.
GRANT INSERT ON portcove_maintenance.operations TO portcove_maintenance_executor;
GRANT UPDATE (state, receipt_reference, receipt_sha256, revision, updated_at)
  ON portcove_maintenance.operations TO portcove_maintenance_executor;
GRANT UPDATE (status, delivered_at, delivery_receipt)
  ON portcove_maintenance.notifications TO portcove_maintenance_executor;

-- Report: read-only (granted SELECT above).

-- Report membership questions run through the verified membership function.
GRANT EXECUTE ON FUNCTION portcove_maintenance.run_members(text), portcove_maintenance.absent_payload(),
  portcove_maintenance.latest_run(text)
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;

-- Collector freshness: a ticket before external reads, the baseline its
-- changes-only diff used, and verification of an unchanged current result.
GRANT EXECUTE ON FUNCTION portcove_maintenance.acquire_collection(),
  portcove_maintenance.expect_baseline(text, text),
  portcove_maintenance.verify_current(bigint, text)
  TO portcove_maintenance_collector;
-- Scoped Core reuse (migration 0010): bindings are written by the reading run
-- under their guard; due selection is readable by the collector and reports.
GRANT INSERT, UPDATE ON portcove_maintenance.core_reuse_bindings TO portcove_maintenance_collector;
GRANT EXECUTE ON FUNCTION portcove_maintenance.core_reassessment_due(text, jsonb)
  TO portcove_maintenance_collector, portcove_maintenance_report;
-- A run inserted without a ticket takes one from the same sequence at insert.
GRANT USAGE ON SEQUENCE portcove_maintenance.collection_acquisition TO portcove_maintenance_collector;

-- GitHub intake owns these checkpoints. The collector can only observe them.
GRANT INSERT ON
  portcove_maintenance.discovery_intake_batches, portcove_maintenance.discovery_intake_candidates
  TO portcove_maintenance_executor;
GRANT UPDATE (revision, receipt_body, previous_receipt_sha256)
  ON portcove_maintenance.discovery_intake_batches TO portcove_maintenance_executor;
GRANT UPDATE (checkpoint)
  ON portcove_maintenance.discovery_intake_candidates TO portcove_maintenance_executor;
GRANT SELECT ON portcove_maintenance_meta.discovery_intake_activation
  TO portcove_maintenance_executor;

-- The intake worker reserves and settles its own metered work before touching
-- the existing checkpoint store. Ownership and data mutation grants stay separate.
GRANT SELECT, INSERT ON portcove_maintenance_meta.resource_admissions
  TO portcove_maintenance_executor;
GRANT UPDATE (outcome, finished_at, estimate_bytes) ON portcove_maintenance_meta.resource_admissions
  TO portcove_maintenance_executor;

GRANT EXECUTE ON FUNCTION portcove_maintenance.discovery_expanded_state(text, jsonb)
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;

-- Unattended discovery collection writes only through its fenced functions,
-- which check the lease, activation generation and expected revision.
GRANT EXECUTE ON FUNCTION
  portcove_maintenance.discovery_acquire(text, uuid, uuid, integer, text, text, text),
  portcove_maintenance.discovery_acquire_seeded(text, uuid, uuid, integer, text, text, text),
  portcove_maintenance.discovery_acquire_known(text, uuid, uuid, integer, text, text, text, bigint, bigint, text, uuid),
  portcove_maintenance.discovery_commit(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb),
  portcove_maintenance.discovery_commit_hint_delta(text, uuid, uuid, bigint, text, jsonb, integer, jsonb, jsonb, jsonb, jsonb, jsonb),
  portcove_maintenance.discovery_finish(text, uuid, uuid, text, jsonb)
  TO portcove_maintenance_collector;
GRANT SELECT ON portcove_maintenance_meta.discovery_intake_activation
  TO portcove_maintenance_collector, portcove_maintenance_report;
