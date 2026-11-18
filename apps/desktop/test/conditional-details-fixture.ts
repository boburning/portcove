import type { desktopApi } from "../src/api";
import type { WorkspaceSnapshot } from "../src/types";
import { currentCatalogPort, currentSourceCatalog } from "../src/catalog-test-fixtures";
import { workspace } from "../src/dev-scenarios/interactive/scenarios";
import { artworkState, sourceProfile } from "../src/test-fixtures";

type Reply<K extends keyof typeof desktopApi> = Awaited<ReturnType<(typeof desktopApi)[K]>>;
type Arguments = Record<string, unknown>;
export type ConditionalDetailsConfiguration = "output" | "carried-small";
export type OutputMode = "safe" | "invalid" | "full" | "unknown";

/** Fixed browser replies derived from the frozen R3 presentation probes.
 * These describe recorded state; no Core, provider, file or native action runs. */
export function conditionalDetailsFixture(configuration: ConditionalDetailsConfiguration) {
  const port = currentCatalogPort("snap64-recomp");
  const sourceCatalog = currentSourceCatalog();
  const identity = sourceCatalog.identities.find((value) => value.id === port.source_profile);
  if (port.source_profile && !identity) throw new Error("Required current source identity missing");
  const profile = identity
    ? { ...sourceProfile(), id: identity.id, label: identity.label }
    : undefined;
  const longPath =
    "F:/Synthetic presentation only/" + "Harbor Adventure and the Forgotten Islands/".repeat(5);
  const status = globalThis.structuredClone(workspace("details").statuses.at(0));
  if (!status?.active)
    throw new Error("The maintained details fixture requires a recorded install");
  status.port_id = port.id;
  status.active.port_id = port.id;
  status.active.id = `fixture-${port.id}`;
  status.active.path = longPath + "recorded-install";
  if (configuration === "carried-small") {
    status.carried_files = {
      from_install_id: "fixture-earlier-install",
      to_install_id: status.active.id,
      from_version: "1.0 {{version}}",
      to_version: "2.0",
      from_path: longPath + "earlier {{value}}",
      to_path: status.active.path,
      outcome: {
        carried: ["extra.ini"],
        carried_bytes: 20,
        removed: [],
        kept_separately: [],
        source_unreadable: [],
        new_version_ships_file: [],
        insufficient_space: false,
        source_modified: false,
        counts: {
          carried: 1,
          removed: 0,
          kept_separately: 0,
          source_unreadable: 0,
          new_version_ships_file: 0,
        },
      },
    };
  }
  const calls: { command: string; args: Arguments }[] = [];
  const forbiddenCalls: string[] = [];
  let mode: OutputMode = "safe";
  let completeApply: (() => void) | undefined;
  let applying: Promise<never> | undefined;
  const checked = (
    command: string,
    args: Arguments,
    expected: Arguments = { portId: port.id, generation: 1 },
  ) => {
    if (
      JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
      Object.entries(expected).some(([key, value]) => args[key] !== value)
    )
      throw new Error(`${command}: unexpected exact fixture arguments`);
    calls.push({ command, args: globalThis.structuredClone(args) });
  };
  const forbidden = (command: string): never => {
    forbiddenCalls.push(command);
    throw new Error(
      `Unpermitted real-effect action in conditional presentation fixture: ${command}`,
    );
  };
  const location = (custom: string | null = longPath): Reply<"outputLocation"> => ({
    port_id: port.id,
    library_root: "E:/Synthetic fixture library",
    default_output_directory: `E:/Synthetic fixture library/versions/${port.id}`,
    configured_output_directory: custom,
    effective_output_directory: custom ?? `E:/Synthetic fixture library/versions/${port.id}`,
    selection_source: custom ? "port_setting" : "library_default",
    user_data_root: `E:/Synthetic fixture library/user/${port.id}`,
  });
  const snapshot = (): WorkspaceSnapshot => {
    const value = workspace("details");
    value.catalog.ports = [globalThis.structuredClone(port)];
    value.catalog.source_profiles = profile ? [globalThis.structuredClone(profile)] : [];
    value.catalog.source_catalog = globalThis.structuredClone(sourceCatalog);
    value.statuses = [globalThis.structuredClone(status)];
    value.listing_catalog = null;
    value.listing_statuses = [];
    value.pending_setups = [];
    value.sources = [];
    return value;
  };
  const handlers = {
    get_workspace_snapshot(args: Arguments) {
      checked("get_workspace_snapshot", args, { generation: 1, knownCatalogDigest: null });
      return snapshot();
    },
    get_mod_setups(args: Arguments): Reply<"modSetups"> {
      checked("get_mod_setups", args);
      return {
        port_id: port.id,
        supported: false,
        package_types: [],
        later_mods_take_priority: false,
        held_updates: [],
        provider: null,
        inventory: null,
        live: null,
      };
    },
    get_runtime_prerequisites(args: Arguments): Reply<"runtimePrerequisites"> {
      checked("get_runtime_prerequisites", args, {
        portId: port.id,
        installId: status.active!.id,
        generation: 1,
      });
      return null;
    },
    get_port_capabilities(args: Arguments): Reply<"portCapabilities"> {
      checked("get_port_capabilities", args);
      return {
        format_version: 1,
        port_id: port.id,
        routes: [
          {
            route: "managed",
            install_id: status.active!.id,
            features: [
              {
                feature: "setup",
                mode: "manual",
                explanation: "Synthetic feature assessment only: use your upstream-prepared copy.",
                next_step: "Review the matching game-file and platform requirements.",
                action: {
                  action: "install",
                  availability: "held",
                  reason: "missing_source",
                  definition: null,
                },
                listing_action: { action: "attach-existing", allowed: true },
              },
            ],
          },
        ],
        observations: [],
        settings: null,
        protection: null,
        source_readiness: null,
        detail_problems: [],
        advisory_state: "missing",
        advisories: [],
        setup_guide: null,
        pending_setup: null,
      };
    },
    get_artwork(args: Arguments): Reply<"artwork"> {
      if (args.slot !== "cover" && args.slot !== "detail" && args.slot !== "landscape")
        throw new Error("Unexpected artwork slot");
      checked("get_artwork", args, { portId: port.id, slot: args.slot, generation: 1 });
      return artworkState(port.id, args.slot);
    },
    get_backups(args: Arguments): Reply<"backups"> {
      checked("get_backups", args, { portId: port.id });
      return {
        port_id: port.id,
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
      };
    },
    get_output_location(args: Arguments) {
      checked("get_output_location", args);
      return location();
    },
    get_output_relocation_status(args: Arguments) {
      checked("get_output_relocation_status", args);
      return null;
    },
    preview_output_location(args: Arguments): Reply<"previewOutputLocation"> {
      if (args.path !== null && typeof args.path !== "string")
        throw new Error("Explicit output path or null required");
      checked("preview_output_location", args, { portId: port.id, generation: 1, path: args.path });
      const destination = args.path;
      return {
        port_id: port.id,
        current: location(),
        proposed: location(destination),
        reset_to_default: destination === null,
        availability: mode === "full" ? "full" : "available",
        ownership:
          mode === "invalid" ? "invalid" : destination ? "owned_by_port" : "library_default",
        available_bytes: mode === "full" ? 0 : mode === "unknown" ? null : 8 * 1024 ** 3,
        total_bytes: mode === "unknown" ? null : 16 * 1024 ** 3,
        volume_identity: "synthetic-volume",
        validation_errors:
          mode === "invalid"
            ? [
                "Synthetic destination overlaps the protected fixture library and cannot be selected.",
              ]
            : [],
        affected_installs: [
          {
            install_id: status.active!.id,
            version: status.active!.version,
            path: status.active!.path,
            active: true,
            previous: false,
            staged: false,
          },
        ],
        moves_existing_install: false,
        preview_sha256: "a".repeat(64),
      };
    },
    plan_output_relocation(args: Arguments): Reply<"planOutputRelocation"> {
      if (typeof args.path !== "string")
        throw new Error("Explicit relocation destination required");
      checked("plan_output_relocation", args, { portId: port.id, generation: 1, path: args.path });
      return {
        port_id: port.id,
        current: location(),
        channel: "stable",
        destination_root: args.path,
        installs: [
          {
            install: globalThis.structuredClone(status.active!),
            destination_path: args.path + "/fixture-install",
            active: true,
            previous: false,
            staged: false,
            retained: false,
            copy: { directories: [], files: [], skipped_entries: [], total_bytes: 0 },
          },
        ],
        required_bytes: 0,
        available_bytes: 8 * 1024 ** 3,
        total_bytes: 16 * 1024 ** 3,
        volume_identity: "synthetic-volume",
        availability: "available",
        ownership: "unclaimed",
        validation_errors: [],
        sources_will_move: false,
        user_data_will_move: false,
        backups_will_move: false,
        plan_sha256: "b".repeat(64),
      };
    },
    set_output_location(args: Arguments): Promise<never> {
      if (typeof args.path !== "string") throw new Error("Explicit future destination required");
      return startApply("set_output_location", args, {
        portId: port.id,
        generation: 1,
        path: args.path,
        expectedPreview: "a".repeat(64),
      });
    },
    reset_output_location(args: Arguments): Promise<never> {
      return startApply("reset_output_location", args, {
        portId: port.id,
        generation: 1,
        expectedPreview: "a".repeat(64),
      });
    },
  };
  function startApply(command: string, args: Arguments, expected: Arguments) {
    checked(command, args, expected);
    if (completeApply) throw new Error("Duplicate pending fixture apply");
    applying = new Promise<void>((resolve) => {
      completeApply = resolve;
    }).then(() => {
      throw new Error(
        command === "set_output_location"
          ? "Synthetic future-folder setting refused. No real files or preferences were changed."
          : "Synthetic reset refused. No real preference was changed.",
      );
    });
    // The UI observes this rejection; cleanup also joins it if an assertion interrupts the row.
    return applying;
  }
  return {
    port,
    profile,
    sourceCatalog,
    status,
    longPath,
    calls,
    forbiddenCalls,
    snapshot,
    handlers,
    forbidden,
    setOutputMode(value: OutputMode) {
      mode = value;
    },
    pending: () => (completeApply ? ["output-apply"] : []),
    releaseApply() {
      if (!completeApply) throw new Error("No held output apply");
      const release = completeApply;
      completeApply = undefined;
      release();
    },
    async dispose() {
      if (completeApply) {
        const release = completeApply;
        completeApply = undefined;
        release();
      }
      await applying?.catch(() => {});
    },
  };
}
