import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  activities,
  artworkState,
  bootstrap,
  doctor,
  generation,
  install,
  preparation,
  workspace,
  type Journey,
} from "./scenarios";
import type { ArtworkSlot, OperationEvent, ApplicationUpdateCheckPhase } from "../../types";
import type { desktopApi } from "../../api";
import { collectionArtwork } from "./collection-artwork";
import { retainedSetup } from "./activity-fixtures";
import { comparisonEntries } from "./comparison-scene";
import type {
  LibraryOrganization,
  OrganizationChange,
  ActivityFeed,
  ActivityRecord,
  GameComparison,
  GameComparisonRequest,
} from "../../types";
import type { OperationResult } from "../../transport-types.generated";

export const recoveryKey = "portcove.interactive.fixture-recovery";
export function installInteractiveTransport(journey: Journey, refuse: (message: string) => void) {
  if (!import.meta.env.DEV || "__TAURI_INTERNALS__" in window || "__TAURI__" in window) {
    throw new Error("Interactive fixtures require an ordinary development browser");
  }
  let disposed = false;
  let prepared = false;
  const favorites = new Set<string>();
  let organization: LibraryOrganization = {
    revision: 0,
    followed_port_ids: [],
    followed_release_acknowledgments: {},
    collections: {},
    hidden_port_ids: [],
    saved_game_ids: [],
    update_notices: {},
    setup_confirmations: [],
  };
  const examples =
    journey === "activity"
      ? [
          retainedSetup("sample", "fixture-retained-harbor"),
          retainedSetup("orchard", "fixture-retained-orchard", true),
        ]
      : [];
  const records: ActivityRecord[] = examples.map((example) => example.record);
  const retained = new Map(
    examples.map((example) => [example.preview.operation_id, example.preview]),
  );
  const feed = (): ActivityFeed => ({
    ...activities,
    records: structuredClone(records),
    current_activity_ids: records
      .filter((record) => record.status === "running")
      .map((record) => record.id),
    attention_required_activity_ids: [...retained.keys()],
    recovery_required_activity_ids: [...retained.keys()],
    terminal_history_count: records.filter((record) => record.status !== "running").length,
  });
  let nextTask = 0;
  let pending:
    | {
        resolve: (value: typeof install) => void;
        reject: (reason: unknown) => void;
        record: ActivityRecord;
        finishEvent: (result: OperationResult) => void;
      }
    | undefined;
  const calls: string[] = [];
  const unsupported = (command: string): never => {
    const message = `Unsupported fixture action: ${command}. No native action was performed.`;
    refuse(message);
    throw new Error(message);
  };
  const argsAre = (args: Record<string, unknown> | undefined, expected: Record<string, unknown>) =>
    JSON.stringify(Object.keys(args ?? {}).sort()) ===
      JSON.stringify(Object.keys(expected).sort()) &&
    Object.entries(expected).every(([key, value]) => args?.[key] === value);
  const requireArgs = (
    command: string,
    args: Record<string, unknown> | undefined,
    expected: Record<string, unknown>,
  ) => {
    if (!argsAre(args, expected)) unsupported(`${command} (unexpected arguments)`);
  };
  const outputLocation = (
    portId: string,
  ): Awaited<ReturnType<typeof desktopApi.outputLocation>> => ({
    port_id: portId,
    library_root: "fixture/library",
    default_output_directory: `fixture/library/${portId}`,
    effective_output_directory: `fixture/library/${portId}`,
    configured_output_directory: null,
    selection_source: "library_default",
    user_data_root: `fixture/library/user/${portId}`,
  });
  const requirePort = (
    command: string,
    args: Record<string, unknown> | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    if (!workspace(journey).catalog.ports.some((port) => port.id === args?.portId))
      return unsupported(command);
    requireArgs(command, args, { portId: args?.portId, generation, ...extra });
    return String(args?.portId);
  };
  const handlers: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
    // Fixtures acknowledge only their ordinary 100% browser baseline. They do
    // not simulate native zoom or claim an enlarged WebView observation.
    "plugin:webview|set_webview_zoom": (args) => {
      requireArgs("plugin:webview|set_webview_zoom", args, { label: "main", value: 1 });
      return null;
    },
    get_library_organization: (args) => {
      requireArgs("get_library_organization", args, { generation });
      return structuredClone(organization);
    },
    change_library_organization: (args) => {
      if (args?.generation !== generation || args.expectedRevision !== organization.revision)
        return unsupported("change_library_organization (stale fixture choices)");
      const change = args.change as OrganizationChange;
      const next = structuredClone(organization);
      const membership = (values: string[], id: string, included: boolean) =>
        included ? [...new Set([...values, id])] : values.filter((value) => value !== id);
      switch (change.kind) {
        case "set_followed_project":
          next.followed_port_ids = membership(
            next.followed_port_ids,
            change.port_id,
            change.followed,
          );
          if (!change.followed) delete next.followed_release_acknowledgments[change.port_id];
          else if (change.observed_identity)
            next.followed_release_acknowledgments[change.port_id] = [
              ...new Set([
                ...(next.followed_release_acknowledgments[change.port_id] ?? []),
                change.observed_identity,
              ]),
            ];
          break;
        case "acknowledge_followed_release":
          next.followed_release_acknowledgments[change.port_id] = [
            ...new Set([
              ...(next.followed_release_acknowledgments[change.port_id] ?? []),
              change.identity,
            ]),
          ];
          break;
        case "set_hidden":
          next.hidden_port_ids = membership(next.hidden_port_ids, change.port_id, change.hidden);
          break;
        case "set_saved":
          next.saved_game_ids = membership(next.saved_game_ids, change.game_id, change.saved);
          break;
        case "set_saved_group":
          next.saved_game_ids = membership(next.saved_game_ids, change.game_id, change.saved);
          if (!change.saved)
            next.saved_game_ids = next.saved_game_ids.filter(
              (id) => !change.legacy_port_ids.some((port) => id === `port-${port}`),
            );
          break;
        case "upsert_collection":
          next.collections[change.collection_id] = {
            name: change.name,
            port_ids: next.collections[change.collection_id]?.port_ids ?? [],
          };
          break;
        case "remove_collection":
          delete next.collections[change.collection_id];
          break;
        case "set_collection_port": {
          const collection = next.collections[change.collection_id];
          if (!collection)
            return unsupported("change_library_organization (missing fixture collection)");
          collection.port_ids = membership(collection.port_ids, change.port_id, change.included);
          break;
        }
        case "set_update_notice":
          next.update_notices[change.port_id] = {
            ...change.choice,
            skipped_release: change.choice.skipped_release ?? null,
          };
          break;
        case "set_setup_confirmation": {
          const confirmation = change.confirmation;
          next.setup_confirmations = next.setup_confirmations.filter(
            (item) =>
              !(
                item.port_id === confirmation.port_id &&
                item.context.kind === confirmation.context.kind &&
                item.context.installation_id === confirmation.context.installation_id
              ),
          );
          if (change.confirmed) next.setup_confirmations.push(confirmation);
          break;
        }
        default:
          return unsupported("change_library_organization (unknown fixture choice)");
      }
      next.revision += 1;
      organization = next;
      return structuredClone(next);
    },
    get_favorite_ports: (args) => {
      requireArgs("get_favorite_ports", args, { generation });
      return [...favorites];
    },
    set_port_favorite: (args) => {
      if (
        typeof args?.favorite !== "boolean" ||
        !workspace(journey).catalog.ports.some((port) => port.id === args.portId)
      )
        return unsupported("set_port_favorite");
      requireArgs("set_port_favorite", args, {
        portId: args.portId,
        favorite: args.favorite,
        generation,
      });
      if (args.favorite) favorites.add(String(args.portId));
      else favorites.delete(String(args.portId));
    },
    get_output_location: (args) => {
      const portId = requirePort("get_output_location", args);
      return outputLocation(portId);
    },
    preview_output_location: (args) => {
      const portId = requirePort("preview_output_location", args, { path: null });
      const active = workspace(journey).statuses.find((item) => item.port_id === portId)?.active;
      return {
        port_id: portId,
        current: outputLocation(portId),
        proposed: outputLocation(portId),
        reset_to_default: true,
        availability: "available",
        ownership: "library_default",
        available_bytes: doctor.library.volume_available_bytes,
        total_bytes: doctor.library.volume_total_bytes,
        volume_identity: "fixture-volume",
        validation_errors: [],
        affected_installs: active
          ? [
              {
                install_id: active.id,
                version: active.version,
                path: active.path,
                active: true,
                previous: false,
                staged: false,
              },
            ]
          : [],
        moves_existing_install: false,
        preview_sha256: "b".repeat(64),
      } satisfies Awaited<ReturnType<typeof desktopApi.previewOutputLocation>>;
    },
    get_output_relocation_status: (args) => {
      requirePort("get_output_relocation_status", args);
      return null;
    },
    get_application_update_status: (args) => {
      requireArgs("get_application_update_status", args, {});
      return {
        schedule: null,
        staged: null,
        apply: null,
        install_eligibility: "not-configured",
        recovery_required: [],
      } satisfies Awaited<ReturnType<typeof desktopApi.applicationUpdateStatus>>;
    },
    get_listing_delivery_status: (args) => {
      requireArgs("get_listing_delivery_status", args, {});
      return {
        delivery_schema: 1,
        revision: null,
        selected: false,
        anchor_sha256: null,
        repository_root_sha256: null,
        target_sha256: null,
        expires_at: null,
        listing_count: 0,
        withdrawn_ids: [],
        fallback_reason: null,
      } satisfies Awaited<ReturnType<typeof desktopApi.listingDeliveryStatus>>;
    },
    refresh_catalog_listings: () => {
      throw new Error("Directory publication requires configured official authority.");
    },
    get_catalog_status: (args) => {
      requireArgs("get_catalog_status", args, {});
      return {
        provenance: doctor.catalog_provenance,
        trusted_keys: [],
        highest_sequence: 0,
        updates_enabled: false,
        can_rollback: false,
        can_use_cached: false,
        state_sha256: "a".repeat(64),
      } satisfies Awaited<ReturnType<typeof desktopApi.catalogStatus>>;
    },
    launch_port: (args) => {
      const status = workspace(journey).statuses.find((item) => item.port_id === args?.portId);
      if (
        (!status?.active && !status?.external_runtime) ||
        (status?.external_runtime &&
          !workspace(journey)
            .listing_statuses?.find((item) => item.port_id === args?.portId)
            ?.actions.some((action) => action.action === "launch" && action.allowed)) ||
        (status.readiness?.launchable === false && !status.readiness.pending_setup) ||
        (status.readiness?.pending_setup && !prepared) ||
        args?.source !== null ||
        !Array.isArray(args.arguments) ||
        args.arguments.length !== 0
      )
        return unsupported("launch_port");
      requireArgs("launch_port", args, {
        portId: args.portId,
        generation,
        source: null,
        arguments: args.arguments,
      });
      return {
        processId: null,
        sessionId: `fixture-launch-${String(args.portId)}`,
      } satisfies Awaited<ReturnType<typeof desktopApi.launch>>;
    },
    report_frontend_error: (args) => {
      if (typeof args?.report !== "object" || args.report === null)
        return unsupported("report_frontend_error");
      requireArgs("report_frontend_error", args, {
        report: args.report,
      });
      refuse("Fixture App rendering failed");
    },
    get_bootstrap_status: (args) => {
      requireArgs("get_bootstrap_status", args, {});
      const recoveryChoice = journey === "recovery" ? sessionStorage.getItem(recoveryKey) : null;
      return bootstrap(
        journey !== "recovery" || ["original", "moved"].includes(recoveryChoice ?? ""),
        recoveryChoice === "original" ? "fixture/original" : "fixture/library",
      );
    },
    reset_default_library: (args) => {
      requireArgs("reset_default_library", args, {});
      if (journey !== "recovery") return unsupported("reset_default_library");
      return bootstrap();
    },
    recover_library_move: (args) => {
      if (journey !== "recovery" || typeof args?.abort !== "boolean")
        return unsupported("recover_library_move");
      requireArgs("recover_library_move", args, { source: "fixture/original", abort: args.abort });
      sessionStorage.setItem(recoveryKey, args.abort ? "original" : "moved");
      return {
        active_root: args.abort ? "fixture/original" : "fixture/library",
        completed: !args.abort,
        destination_root: "fixture/library",
        source_retained: true,
        source_root: "fixture/original",
        transfer_id: "fixture-move",
      } satisfies Awaited<ReturnType<typeof desktopApi.recoverLibraryMove>>;
    },
    compare_game_ports: (args) => {
      const request = args?.request as GameComparisonRequest | undefined;
      if (args?.generation !== generation || !request || typeof request.port_id !== "string")
        return unsupported("compare_game_ports (invalid fixture context)");
      const catalog = workspace(journey).catalog;
      const anchor = catalog.ports.find((port) => port.id === request.port_id);
      if (!anchor) return unsupported("compare_game_ports (unknown fixture project)");
      const game = anchor.presentation?.original_game;
      const ports = catalog.ports.filter(
        (port) =>
          port.id === anchor.id || (game && port.presentation?.original_game?.id === game.id),
      );
      return {
        format_version: 1,
        policy_version: "balanced-v1",
        game_id: game?.id ?? null,
        edition_id: request.edition_id ?? null,
        editions:
          game?.source_editions.map((edition) => ({
            ...edition,
            system: edition.system ?? null,
          })) ?? [],
        platform: request.platform ?? "windows-x86-64",
        environment_id: request.environment_id ?? "unqualified-host",
        source_profile_ids: [],
        source_context_is_hypothetical: false,
        required_capabilities: request.required_capabilities ?? [],
        evaluated_at: 0,
        input_id: "f".repeat(64),
        assessment: null,
        limitations: [
          "Interactive presentation fixture only. No release, original files or gameplay were observed.",
        ],
        ports: ports.map((port) => ({
          port_id: port.id,
          name: port.name,
          project_url: port.project_url,
          edition_ids:
            port.presentation?.original_game?.source_editions.map((edition) => edition.id) ?? [],
          declared_platforms: port.platforms,
          source_profile_ids: [],
          metadata: "missing",
          offered_release: null,
          offered_identity: null,
          freshness: {
            state: "unobserved",
            last_successful_resolution_at: null,
            last_attempt_at: null,
            offered_identity_changed_at: null,
          },
          operation: {
            kind: "unknown",
            reason: "Interactive fixture; no native operation assessment.",
          },
          source_health: null,
          launch_ready: false,
          installed: false,
          followed: organization.followed_port_ids.includes(port.id),
          update_notice: null,
          limitations: [],
        })),
      } satisfies GameComparison;
    },
    get_workspace_snapshot: (args) => {
      requireArgs("get_workspace_snapshot", args, { generation });
      const snapshot = workspace(journey);
      snapshot.activities = feed();
      const [status] = snapshot.statuses;
      if (prepared && !status) throw new Error("Prepared scenario has no port status");
      if (prepared && status)
        status.readiness = {
          launchable: true,
          pending_setup: false,
          blockers: [],
        };
      return snapshot;
    },
    get_workspace_changed: (args) => {
      requireArgs("get_workspace_changed", args, { generation });
      return false;
    },
    discover_orphaned_operations: (args) => {
      requireArgs("discover_orphaned_operations", args, { generation });
      return;
    },
    get_doctor_report: (args) => {
      requireArgs("get_doctor_report", args, { generation });
      return {
        ...doctor,
        catalog_port_count: workspace(journey).catalog.ports.length,
        installed_port_count: workspace(journey).statuses.filter((status) => status.active).length,
        repair: {
          generated_at: Date.now() / 1000,
          items: [...retained.values()].map((preview) => ({
            kind: "retained_preparation" as const,
            port_id: preview.port_id,
            operation_id: preview.operation_id,
            path: preview.retained_path,
            message: "Simulated setup left working files.",
            proposed_action: "Inspect the retained files before deciding what to do.",
          })),
        },
      };
    },
    get_activities: (args) => {
      requireArgs("get_activities", args, {});
      return feed();
    },
    get_activity_diagnostic: (args) => {
      const record = records.find((record) => record.id === args?.activityId);
      if (!record) return unsupported("get_activity_diagnostic");
      requireArgs("get_activity_diagnostic", args, { activityId: record.id, generation });
      const text = record.message ?? "Simulated task";
      return [
        {
          activity_id: record.id,
          complete: record.status !== "running",
          phase: record.status,
          stdout: { text, observed_bytes: new TextEncoder().encode(text).length, truncated: false },
          stderr: { text: "", observed_bytes: 0, truncated: false },
          stream_limit_bytes: 4096,
          updated_at: Date.now() / 1000,
        },
      ] satisfies Awaited<ReturnType<typeof desktopApi.activityDiagnostic>>;
    },
    preview_preparation_cleanup: (args) => {
      const preview = retained.get(String(args?.operationId));
      if (!preview) return unsupported("preview_preparation_cleanup");
      requireArgs("preview_preparation_cleanup", args, {
        operationId: preview.operation_id,
        generation,
      });
      return structuredClone(preview);
    },
    cleanup_preparation: (args) => {
      const preview = retained.get(String(args?.operationId));
      if (!preview) return unsupported("cleanup_preparation");
      requireArgs("cleanup_preparation", args, {
        operationId: preview.operation_id,
        expectedPreview: preview.preview_sha256,
        generation,
      });
      retained.delete(preview.operation_id);
      return structuredClone(preview);
    },
    get_locale_preference: (args) => {
      requireArgs("get_locale_preference", args, {});
      return { locale: "en" } satisfies Awaited<ReturnType<typeof desktopApi.localePreference>>;
    },
    get_github_auth_status: (args) => {
      requireArgs("get_github_auth_status", args, {});
      return {
        authenticated: false,
        device_login_available: false,
        login: null,
        rate_limit: null,
        source: "anonymous",
      } satisfies Awaited<ReturnType<typeof desktopApi.githubAuthStatus>>;
    },
    get_application_update_preferences: (args) => {
      requireArgs("get_application_update_preferences", args, {});
      return {
        schema_version: 1,
        revision: 1,
        choice: { channel: "stable", mode: "notify-only", paused: true },
      } satisfies Awaited<ReturnType<typeof desktopApi.applicationUpdatePreferences>>;
    },
    get_application_update_production_transition: (args) => {
      requireArgs("get_application_update_production_transition", args, {});
      return {
        schema_version: 1,
        preference_revision: 1,
        offer_required: false,
      } satisfies Awaited<ReturnType<typeof desktopApi.applicationUpdateProductionTransition>>;
    },
    get_application_update_notice: (args) => {
      requireArgs("get_application_update_notice", args, {});
      return { notice: null, revision: 0 } satisfies Awaited<
        ReturnType<typeof desktopApi.applicationUpdateNotice>
      >;
    },
    check_application_update: (args) => {
      const request = args?.request;
      if (request != null && (typeof request !== "object" || Array.isArray(request)))
        return unsupported("check_application_update (invalid request)");
      const fields = (request ?? {}) as Record<string, unknown>;
      requireArgs(
        "check_application_update request",
        fields,
        fields.channel === undefined ? {} : { channel: fields.channel },
      );
      const selected = fields.channel ?? "preview";
      if (selected !== "stable" && selected !== "preview")
        return unsupported("check_application_update (invalid channel)");
      if (!(args?.onEvent instanceof Channel))
        return unsupported("check_application_update (missing event channel)");
      requireArgs(
        "check_application_update",
        args,
        args && "request" in args ? { request, onEvent: args.onEvent } : { onEvent: args?.onEvent },
      );
      const events = args.onEvent as Channel<ApplicationUpdateCheckPhase>;
      events.onmessage("checking");
      events.onmessage("complete");
      return {
        checked_channel: selected,
        result: {
          kind: "no-candidate",
          candidate: null,
          reasons: ["Renderer fixture only: no update service or native trust checks were run."],
          staged: false,
        },
      } satisfies Awaited<ReturnType<typeof desktopApi.checkApplicationUpdate>>;
    },
    get_cli_command_context: (args) => {
      requireArgs("get_cli_command_context", args, { generation });
      return {
        executable: null,
        library_root: "fixture/library",
        platform: "windows-x86-64",
      } satisfies Awaited<ReturnType<typeof desktopApi.cliCommandContext>>;
    },
    get_game_file_roots: (args) => {
      requireArgs("get_game_file_roots", args, { generation });
      return [];
    },
    get_game_file_scan_snapshot: (args) => {
      requireArgs("get_game_file_scan_snapshot", args, { generation });
      return null;
    },
    get_backups: (args) => {
      if (!workspace(journey).catalog.ports.some((port) => port.id === args?.portId))
        return unsupported("get_backups");
      requireArgs("get_backups", args, { portId: args?.portId });
      if (journey === "details" && args?.portId === "details-backup-error")
        throw new Error(
          "Disposable fixture: backup history could not be read. The game's saved data is untouched.",
        );
      return {
        port_id: String(args?.portId),
        restore_assessment: {
          action: "backup_restore",
          availability: "waiting",
          reason: "missing_backup",
        },
        create_assessment: {
          action: "backup_create",
          availability: "waiting",
          reason: "missing_data",
        },
        backups: [],
        problems: [],
        state: "healthy",
      } satisfies Awaited<ReturnType<typeof desktopApi.backups>>;
    },
    get_artwork: (args) => {
      if (
        !(
          workspace(journey).catalog.ports.some((port) => port.id === args?.portId) ||
          workspace(journey).listing_catalog?.listings.some(
            (listing) => listing.id === args?.portId,
          )
        ) ||
        !["cover", "detail"].includes(String(args?.slot))
      )
        return unsupported("get_artwork");
      requireArgs("get_artwork", args, { portId: args?.portId, slot: args?.slot, generation });
      const id = String(args?.portId);
      const state = artworkState(
        id,
        args?.slot as ArtworkSlot,
        0,
        (journey.startsWith("collection") && id !== "collection-4") ||
          (journey === "comparison" &&
            comparisonEntries.find((entry) => entry.id === id)?.artwork !== null),
      );
      if (journey.startsWith("collection") || journey === "comparison") {
        const port = workspace(journey).catalog.ports.find((port) => port.id === id)!;
        state.generated_fallback.initials =
          port.presentation?.original_game_title?.slice(0, 2).toUpperCase() ?? "PC";
        state.generated_fallback.palette_index = Number(id.split("-")[1]) % 6;
        if (state.selection) {
          const index = Number(id.split("-")[1]) % 3;
          const identity = String(index + 1).repeat(64);
          state.choice.asset_sha256 = identity;
          state.selection.sha256 = identity;
          state.selection.original_name = "simulated-geometric-artwork.png";
          state.selection.width = [120, 180, 120][index]!;
          state.selection.height = [180, 100, 120][index]!;
          state.resolved_source = { kind: "local_import", asset_sha256: identity };
        }
      }
      return state;
    },
    get_artwork_thumbnail: (args) => {
      if (
        !(journey.startsWith("collection") || journey === "comparison") ||
        !workspace(journey).catalog.ports.some((port) => port.id === args?.portId)
      )
        return unsupported("get_artwork_thumbnail");
      requireArgs("get_artwork_thumbnail", args, {
        portId: args?.portId,
        slot: args?.slot,
        expectedRevision: 0,
        generation,
      });
      const index = Number(String(args?.portId).split("-")[1]) % 3;
      return {
        asset_sha256: String(index + 1).repeat(64),
        choice_revision: 0,
        png_base64: collectionArtwork[index]!,
      };
    },
    plan_preparation: (args) => {
      requireArgs("plan_preparation", args, { portId: "sample", generation });
      if (!["setup", "activity"].includes(journey) || prepared)
        return unsupported("plan_preparation");
      return preparation;
    },
    prepare_port: (args) => {
      if (
        !["setup", "activity"].includes(journey) ||
        pending ||
        !(args?.onEvent instanceof Channel)
      )
        return unsupported("prepare_port");
      requireArgs("prepare_port", args, {
        portId: "sample",
        expectedPlan: preparation.plan_sha256,
        generation,
        onEvent: args.onEvent,
      });
      const channel = args.onEvent as Channel<OperationEvent>;
      const id = nextTask++ === 0 ? "fixture-preparation" : `fixture-preparation-${nextTask}`;
      const record: ActivityRecord = {
        id,
        target_kind: "port",
        target_id: "sample",
        operation: "prepare",
        status: "running",
        started_at: Date.now() / 1000,
        finished_at: null,
        cancellation: { requested: false, phase: "preparing" },
        failure: null,
        message: "Simulated preparation; no real files were used.",
      };
      records.unshift(record);
      const base = {
        schema_version: 2 as const,
        operation_id: id,
        parent_operation_id: null,
        target: null,
        timestamp_ms: 1,
        operation: "prepare" as const,
      };
      channel.onmessage({ ...base, sequence: 0, type: "started" });
      channel.onmessage({
        ...base,
        sequence: 1,
        type: "message",
        level: "info",
        message: "Fixture preparation is waiting. Complete, fail, or cancel it.",
      });
      return new Promise<typeof install>((resolve, reject) => {
        pending = {
          resolve,
          reject,
          record,
          finishEvent: (result) =>
            channel.onmessage({ ...base, sequence: 2, type: "finished", result }),
        };
      });
    },
    cancel_operation: (args) => {
      if (!pending) return unsupported("cancel_operation");
      requireArgs("cancel_operation", args, { operationId: pending.record.id });
      pending.record.cancellation = { requested: true, phase: "preparing" };
      return { requested: true, phase: "preparing" } satisfies Awaited<
        ReturnType<typeof desktopApi.cancelOperation>
      >;
    },
  };
  mockIPC(
    (command, payload) => {
      const handler = handlers[command];
      if (disposed || !Object.hasOwn(handlers, command) || !handler) return unsupported(command);
      if (Array.isArray(payload) || payload instanceof ArrayBuffer || payload instanceof Uint8Array)
        return unsupported(`${command} (unexpected payload)`);
      calls.push(command);
      return handler(payload);
    },
    { shouldMockEvents: true },
  );
  mockWindows("main");
  return {
    calls,
    complete() {
      if (!pending) return unsupported("complete (no preparation running)");
      if (pending.record.cancellation?.requested)
        return unsupported("complete (cancellation requested; settle cancellation instead)");
      prepared = true;
      pending.record.status = "succeeded";
      pending.record.finished_at = Date.now() / 1000;
      pending.record.cancellation = null;
      pending.finishEvent("succeeded");
      pending.resolve(install);
      pending = undefined;
    },
    fail() {
      if (!pending) return unsupported("fail (no preparation running)");
      const example = retainedSetup("sample", pending.record.id);
      Object.assign(pending.record, example.record, {
        started_at: pending.record.started_at,
        finished_at: Date.now() / 1000,
      });
      retained.set(example.preview.operation_id, example.preview);
      pending.finishEvent("failed");
      pending.reject(example.record.failure);
      pending = undefined;
    },
    settleCancellation() {
      if (!pending?.record.cancellation?.requested)
        return unsupported("settle cancellation (no request)");
      pending.record.status = "cancelled";
      pending.record.finished_at = Date.now() / 1000;
      pending.record.cancellation = null;
      pending.finishEvent("cancelled");
      pending.reject({ code: "cancelled", message: "Fixture preparation cancelled", details: {} });
      pending = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.reject({ code: "cancelled", message: "Fixture reset", details: {} });
      pending = undefined;
      clearMocks();
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
    },
  };
}
