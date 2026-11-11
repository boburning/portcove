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
GRANT EXECUTE ON FUNCTION portcove_maintenance.run_members(text), portcove_maintenance.absent_payload()
  TO portcove_maintenance_collector, portcove_maintenance_report, portcove_maintenance_executor;
