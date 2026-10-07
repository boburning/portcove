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
import type { ArtworkSlot, OperationEvent } from "../../types";
import type { desktopApi } from "../../api";

export const recoveryKey = "portcove.interactive.fixture-recovery";
export function installInteractiveTransport(journey: Journey, refuse: (message: string) => void) {
  if (!import.meta.env.DEV || "__TAURI_INTERNALS__" in window || "__TAURI__" in window) {
    throw new Error("Interactive fixtures require an ordinary development browser");
  }
  let disposed = false;
  let prepared = false;
  let pending:
    | { resolve: (value: typeof install) => void; reject: (reason: unknown) => void }
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
  const handlers: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
    report_frontend_error: (args) => {
      if (typeof args?.message !== "string" || typeof args?.componentStack !== "string")
        return unsupported("report_frontend_error");
      requireArgs("report_frontend_error", args, {
        message: args.message,
        componentStack: args.componentStack,
      });
      refuse(`Fixture App error: ${args.message}`);
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
    get_workspace_snapshot: (args) => {
      requireArgs("get_workspace_snapshot", args, { generation });
      const snapshot = workspace(journey);
      if (prepared)
        snapshot.statuses[0].readiness = {
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
      return doctor;
    },
    get_activities: (args) => {
      requireArgs("get_activities", args, {});
      return activities;
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
    get_cli_command_context: (args) => {
      requireArgs("get_cli_command_context", args, { generation });
      return {
        executable: null,
        library_root: "fixture/library",
        platform: "windows-x86-64",
      } satisfies Awaited<ReturnType<typeof desktopApi.cliCommandContext>>;
    },
    get_game_file_roots: (args) => {
      requireArgs("get_game_file_roots", args, {});
      return [];
    },
    get_game_file_scan_snapshot: (args) => {
      requireArgs("get_game_file_scan_snapshot", args, {});
      return null;
    },
    get_backups: (args) => {
      if (!workspace(journey).catalog.ports.some((port) => port.id === args?.portId))
        return unsupported("get_backups");
      requireArgs("get_backups", args, { portId: args?.portId });
      return {
        port_id: String(args?.portId),
        backups: [],
        problems: [],
        state: "healthy",
      } satisfies Awaited<ReturnType<typeof desktopApi.backups>>;
    },
    get_artwork: (args) => {
      if (
        !workspace(journey).catalog.ports.some((port) => port.id === args?.portId) ||
        !["cover", "detail"].includes(String(args?.slot))
      )
        return unsupported("get_artwork");
      requireArgs("get_artwork", args, { portId: args?.portId, slot: args?.slot, generation });
      return artworkState(String(args?.portId), args?.slot as ArtworkSlot);
    },
    plan_preparation: (args) => {
      requireArgs("plan_preparation", args, { portId: "sample", generation });
      if (journey !== "setup" || prepared) return unsupported("plan_preparation");
      return preparation;
    },
    prepare_port: (args) => {
      if (journey !== "setup" || pending || !(args?.onEvent instanceof Channel))
        return unsupported("prepare_port");
      requireArgs("prepare_port", args, {
        portId: "sample",
        expectedPlan: preparation.plan_sha256,
        generation,
        onEvent: args.onEvent,
      });
      const channel = args.onEvent as Channel<OperationEvent>;
      const base = {
        schema_version: 2 as const,
        operation_id: "fixture-preparation",
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
        pending = { resolve, reject };
      });
    },
    cancel_operation: (args) => {
      requireArgs("cancel_operation", args, { operationId: "fixture-preparation" });
      if (!pending) return unsupported("cancel_operation");
      pending.reject({
        code: "cancelled",
        message: "Fixture preparation cancelled",
        details: {},
      });
      pending = undefined;
      return { requested: true, phase: "preparing" } satisfies Awaited<
        ReturnType<typeof desktopApi.cancelOperation>
      >;
    },
  };
  mockIPC(
    (command, payload) => {
      if (disposed || !Object.hasOwn(handlers, command)) return unsupported(command);
      if (Array.isArray(payload) || payload instanceof ArrayBuffer || payload instanceof Uint8Array)
        return unsupported(`${command} (unexpected payload)`);
      calls.push(command);
      return handlers[command](payload);
    },
    { shouldMockEvents: true },
  );
  mockWindows("main");
  return {
    calls,
    complete() {
      if (!pending) return unsupported("complete (no preparation running)");
      prepared = true;
      pending.resolve(install);
      pending = undefined;
    },
    fail() {
      if (!pending) return unsupported("fail (no preparation running)");
      pending.reject(new Error("Controlled fixture preparation failure"));
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
