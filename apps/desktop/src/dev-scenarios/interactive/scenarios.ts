import { artworkState, failureReport, portDefinition, portStatus } from "../../test-fixtures";
import { comparisonEntries } from "./comparison-scene";
import type {
  ActivityFeed,
  BootstrapStatus,
  DoctorReport,
  InstallRecord,
  PreparationPlan,
  WorkspaceSnapshot,
  PortDefinition,
  PortStatus,
  PortListing,
} from "../../types";

export const journeys = [
  { id: "library", label: "Interactive Library" },
  { id: "collection", label: "Mixed collection · simulated content" },
  { id: "collection-large", label: "60-entry collection · simulated content" },
  { id: "comparison", label: "Matched Library comparison · shared content and artwork" },
  { id: "details", label: "Game details · managed, external, downloaded setup and backup error" },
  { id: "setup", label: "Interactive preparation" },
  { id: "activity", label: "Activity and retained setup · simulated tasks" },
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
  if (journey === "details") return detailWorkspace();
  const sample = {
    ...portDefinition(),
    name: "Harbor Adventure",
    summary: "A deterministic development fixture",
    ...(["setup", "activity"].includes(journey)
      ? { adapter: "upstream-managed-setup" as const, setup_output_paths: ["game.dat"] }
      : {}),
  };
  const ordinaryPorts = [
    sample,
    { ...portDefinition(), id: "orchard", name: "Orchard Quest" },
    { ...portDefinition(), id: "summit", name: "Summit Racer" },
  ];
  const ports =
    journey === "comparison"
      ? comparisonEntries.map((entry): PortDefinition => ({
          ...portDefinition(),
          id: entry.id,
          name: entry.port,
          presentation: {
            installation_method: "portable-package",
            saves_and_settings: "portcove-managed",
            source_requirements: [],
            original_game_title: entry.title,
            variant_label: entry.variant,
          },
        }))
      : journey.startsWith("collection")
        ? Array.from(
            { length: journey === "collection-large" ? 60 : 12 },
            (_, index): PortDefinition => ({
              ...portDefinition(),
              id: `collection-${index}`,
              name:
                index === 0
                  ? "sm64-port"
                  : index === 1
                    ? "Mario modern port"
                    : `Harbor desktop port ${index + 1}`,
              presentation: {
                installation_method: "portable-package",
                saves_and_settings: "portcove-managed",
                source_requirements: [],
                ...portDefinition().presentation,
                original_game_title:
                  index < 2
                    ? "Super Mario 64"
                    : index === 2
                      ? "Harbor Adventure: The Very Long Voyage Beyond the Northern Sea — Complete Edition"
                      : ["Orchard Quest", "Summit Racer", "Moonlit Harbor", "The Last Station"][
                          index % 4
                        ]!,
                variant_label: index === 1 ? "Modern renderer" : null,
              },
            }),
          )
        : ordinaryPorts;
  return {
    catalog: { schema_version: 1, ports, source_profiles: [] },
    listing_catalog: null,
    listing_statuses: [],
    pending_setups: [],
    statuses: ports.map((port): PortStatus => ({
      ...portStatus(),
      port_id: port.id,
      active:
        journey.startsWith("collection") || journey === "comparison"
          ? {
              ...install,
              port_id: port.id,
              id: `fixture-${port.id}`,
              path: `fixture/library/${port.id}/versions/1.2`,
            }
          : port.id === "sample"
            ? install
            : port.id === "orchard"
              ? {
                  ...install,
                  port_id: port.id,
                  id: `fixture-${port.id}`,
                  path: `fixture/library/${port.id}`,
                }
              : null,
      readiness: {
        launchable:
          port.id !== "collection-4" &&
          port.id !== "comparison-4" &&
          port.id !== "summit" &&
          (!["setup", "activity"].includes(journey) || port.id !== "sample"),
        pending_setup: ["setup", "activity"].includes(journey) && port.id === "sample",
        blockers: ["collection-4", "comparison-4"].includes(port.id) ? ["missing_source"] : [],
        ...(["collection-4", "comparison-4"].includes(port.id)
          ? { source: "missing" as const }
          : {}),
      },
      ...(journey.startsWith("collection") && port.id === "collection-3"
        ? { staged: { ...install, id: "fixture-staged", port_id: port.id, staged: true } }
        : {}),
    })),
    sources: [],
    activities,
  };
}

function detailWorkspace(): WorkspaceSnapshot {
  const ports = ["ready", "staged", "backup-error"].map((kind): PortDefinition => ({
    ...portDefinition(),
    id: `details-${kind}`,
    name: "Harbor desktop port",
    summary:
      "Explore a coastal world using your own original game files. This disposable library demonstrates installation tools, version choices and saved-data coverage without touching real files.",
    presentation: {
      original_game_title: kind === "backup-error" ? "Orchard Quest" : "Harbor Adventure",
      variant_label:
        kind === "staged"
          ? "Update saved for later"
          : kind === "backup-error"
            ? "Backup history unavailable"
            : "Managed installation",
      installation_method: "portable-package",
      saves_and_settings: "portcove-managed",
      source_requirements: [],
    },
  }));
  const statuses: PortStatus[] = ports.map((port) => ({
    ...portStatus(),
    port_id: port.id,
    active: {
      ...install,
      id: `fixture-${port.id}`,
      port_id: port.id,
      path: `fixture/library/${port.id}/versions/1.2`,
    },
    readiness: { launchable: true, pending_setup: false, blockers: [] },
    ...(port.id === "details-staged"
      ? {
          staged: {
            ...install,
            id: "fixture-staged",
            port_id: port.id,
            version: "1.3",
            staged: true,
          },
        }
      : {}),
  }));
  const listings: PortListing[] = ["external", "unknown", "downloaded"].map((kind) => ({
    id: `details-${kind}`,
    name: `Harbor upstream project · ${kind}`,
    original_game_title: kind === "downloaded" ? "Moonlit Harbor" : "Summit Racer",
    summary:
      "An upstream-maintained desktop game. Choose and maintain its executable and data folder yourself; this demonstration only records disposable launch details.",
    project_url: "https://example.com/harbor",
    setup_url: "https://example.com/harbor/setup",
    release_url: "https://example.com/harbor/releases",
    platforms: ["windows-x86-64"],
    availability: "packages",
  }));
  const listingStatuses = listings.map((listing) => {
    const registered = listing.id !== "details-downloaded";
    const status: PortStatus = {
      ...portStatus(),
      port_id: listing.id,
      ...(registered
        ? {
            external_runtime: {
              id: `fixture-${listing.id}`,
              port_id: listing.id,
              path: `fixture/external/${listing.id}`,
              executable: `fixture/external/${listing.id}/game.exe`,
              version: "user-managed",
              platform: "windows-x86-64",
              archive_sha256: "",
              immutable_tree_sha256: "",
              registered_at: 1,
              user_selected: { arguments: [] },
            },
            ...(listing.id === "details-external"
              ? { readiness: { launchable: true, blockers: [], pending_setup: false } }
              : {}),
          }
        : {}),
    };
    statuses.push(status);
    return {
      port_id: listing.id,
      status,
      actions: [
        {
          action: "launch" as const,
          allowed: listing.id === "details-external",
          reason:
            listing.id === "details-unknown"
              ? "Current launch readiness is unavailable. Refresh and review the selected executable."
              : null,
        },
        { action: "attach-existing" as const, allowed: true },
      ],
    };
  });
  const downloaded = listings[2]!;
  return {
    catalog: { schema_version: 1, ports, source_profiles: [] },
    listing_catalog: { format_version: 1, listings },
    listing_statuses: listingStatuses,
    pending_setups: [
      {
        id: "fixture-downloaded-setup",
        port_id: downloaded.id,
        listing: downloaded,
        path: "fixture/downloads/moonlit-harbor",
        state: "downloaded",
        artifact: {
          release_id: 1,
          asset_id: 1,
          release_tag: "v1.2",
          release_url: "https://example.com/harbor/releases/v1.2",
          name: "harbor.zip",
          size: 1024,
          download_url: "https://example.com/harbor/harbor.zip",
          can_extract: true,
          sha256: null,
        },
        archive_sha256: "a".repeat(64),
        downloaded_at: "2026-10-23T12:00:00Z",
        reason: null,
      },
    ],
    statuses,
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
