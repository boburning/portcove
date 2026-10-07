import { artworkState, failureReport, portDefinition, portStatus } from "../../test-fixtures";
import type {
  ActivityFeed,
  BootstrapStatus,
  DoctorReport,
  InstallRecord,
  PreparationPlan,
  WorkspaceSnapshot,
} from "../../types";

export const journeys = [
  { id: "library", label: "Interactive Library" },
  { id: "setup", label: "Interactive preparation" },
  { id: "recovery", label: "Interactive startup recovery" },
] as const;
export type Journey = (typeof journeys)[number]["id"];
export function journeyFrom(value: string | null): Journey {
  if (value === null) return "library";
  if (journeys.some((journey) => journey.id === value)) return value as Journey;
  throw new Error(`Unknown interactive journey: ${value}`);
}
export const generation = 1;
export const install: InstallRecord = {
  id: "fixture-install",
  port_id: "sample",
  path: "fixture/library/sample",
  version: "1.2",
  channel: "stable",
  installed_at: 1,
  verified: true,
  staged: false,
  artifact: { asset_name: "fixture.zip", sha256: "a".repeat(64), size: 1024 },
  manifest_sha256: "b".repeat(64),
  selected_executable: "game.exe",
  runtime: null,
};
export const activities: ActivityFeed = {
  active_and_actionable_complete: true,
  attention_required_activity_ids: [],
  current_activity_ids: [],
  records: [],
  recovery_required_activity_ids: [],
  terminal_history_complete: true,
  terminal_history_count: 0,
  terminal_history_limit: 20,
};
export function bootstrap(ready = true, root = "fixture/library"): BootstrapStatus {
  return {
    ready,
    generation,
    library_root: root,
    selection: { root, source: "platform_default" },
    error: ready
      ? null
      : {
          ...failureReport(),
          code: "conflict",
          message: "Fixture library move needs recovery",
          details: {
            transfer_id: "fixture-move",
            retained_source: "fixture/original",
            recovery_action: "resume_library_move",
            move_abort_available: "true",
          },
          presentation: {
            ...failureReport().presentation,
            presentation_key: "fixture_library_move_recovery",
            summary: "Fixture library move needs recovery",
            technical_message: "Fixture library move needs recovery",
            technical_context: { transfer_id: "fixture-move", retained_source: "fixture/original" },
          },
        },
  };
}
export function workspace(journey: Journey): WorkspaceSnapshot {
  const sample = {
    ...portDefinition(),
    name: "Harbor Adventure",
    summary: "A deterministic development fixture",
    ...(journey === "setup"
      ? { adapter: "upstream-managed-setup" as const, setup_output_paths: ["game.dat"] }
      : {}),
  };
  const ports = [
    sample,
    { ...portDefinition(), id: "orchard", name: "Orchard Quest" },
    { ...portDefinition(), id: "summit", name: "Summit Racer" },
  ];
  return {
    catalog: { schema_version: 1, ports, source_profiles: [] },
    statuses: ports.map((port) => ({
      ...portStatus(),
      port_id: port.id,
      active:
        port.id === "sample"
          ? install
          : port.id === "orchard"
            ? { ...install, port_id: port.id, id: `fixture-${port.id}` }
            : null,
      readiness: {
        launchable: port.id !== "summit" && (journey !== "setup" || port.id !== "sample"),
        pending_setup: journey === "setup" && port.id === "sample",
        blockers: [],
      },
    })),
    sources: [],
    activities,
  };
}
export const preparation: PreparationPlan = {
  format_version: 1,
  port_id: "sample",
  plan_sha256: "c".repeat(64),
  copy: { directories: [], files: [], skipped_entries: [], total_bytes: 1024 },
  inputs: {
    definition_sha256: "d".repeat(64),
    host: "windows-x86-64",
    options: { target: "windows-x86-64", mode: "default" },
    conversion_tool: null,
    setup_tool: { path: "fixture/setup.exe", sha256: "e".repeat(64), size: 512 },
    install,
    source: {
      profile_id: "fixture-source",
      path: "fixture/owned.iso",
      sha256: "f".repeat(64),
      size: 512,
      storage_sha256: "f".repeat(64),
      storage_size: 512,
      updated_at: 1,
    },
    source_inspection: {
      schema_version: 1,
      profile_id: "fixture-source",
      health: "current",
      state_code: "selected_needs_checking",
      summary: "Fixture selected source",
      next_action: "Prepare",
      applications: [],
      evidence: [],
      legacy: { registration_identity_not_recorded: true, variant_unspecified_records: [] },
    },
  },
};
export const doctor: DoctorReport = {
  catalog_port_count: 3,
  installed_port_count: 2,
  registered_source_count: 0,
  platform: "windows-x86-64",
  host_tools: [],
  catalog_provenance: {
    catalog_sha256: "a".repeat(64),
    expires_at: null,
    fallback_reasons: [],
    key_id: null,
    origin: "embedded",
    sequence: null,
  },
  library: {
    library_root: "fixture/library",
    volume_available_bytes: 1024 ** 3,
    volume_total_bytes: 2 * 1024 ** 3,
  },
  repair: { generated_at: 0, items: [] },
};
export { artworkState };
