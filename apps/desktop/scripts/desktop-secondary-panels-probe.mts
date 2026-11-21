import type { WebDriver } from "selenium-webdriver";
import type { SecondaryPanelFixtures } from "./desktop-secondary-panels-fixture.mts";
import { executeBrowserScript } from "./browser-script.mts";

export interface SecondaryPanelProbeOptions {
  generation: number;
  fixtures: SecondaryPanelFixtures;
  recipePath: string;
  portableInputPath: string;
  portableOutputPath: string;
  metadataPath: string;
  refusedMetadataPath: string;
}
export interface SecondaryPanelTrace {
  command: string;
  port_id: string | null;
  generation: number | null;
  outcome: "supplied" | "refused" | "forwarded";
}
export interface SecondaryPanelProbeObservation {
  synthetic: true;
  scope: string;
  trace: SecondaryPanelTrace[];
  mismatches: string[];
  acknowledged: boolean;
}
export interface SecondaryPanelProbeCleanup extends SecondaryPanelProbeObservation {
  restored: boolean;
  trustworthy: boolean;
}
interface ProbeState {
  phase(value: "mods" | "preservation"): void;
  capture(): SecondaryPanelProbeObservation;
  restore(): SecondaryPanelProbeCleanup;
}
interface ProbeWindow extends Window {
  __TAURI_INTERNALS__?: { convertFileSrc(command: string, protocol: string): string };
  __portcoveSecondaryPanelProbe?: ProbeState;
}

export async function beginSecondaryPanelProbe(
  browser: Pick<WebDriver, "executeScript">,
  options: SecondaryPanelProbeOptions,
) {
  await executeBrowserScript(browser, installSecondaryPanelProbe, options);
  return {
    phase: (value: "mods" | "preservation") =>
      executeBrowserScript(
        browser,
        (value) => {
          const probe = (window as ProbeWindow).__portcoveSecondaryPanelProbe;
          if (!probe) throw new Error("Owned secondary panel probe is missing");
          probe.phase(value);
        },
        value,
      ),
    capture: () =>
      executeBrowserScript(browser, () => {
        const probe = (window as ProbeWindow).__portcoveSecondaryPanelProbe;
        if (!probe) throw new Error("Owned secondary panel probe is missing");
        return probe.capture();
      }),
    restore: () =>
      executeBrowserScript(browser, () => {
        const probe = (window as ProbeWindow).__portcoveSecondaryPanelProbe;
        if (!probe) throw new Error("Owned secondary panel probe is missing");
        return probe.restore();
      }),
  };
}

/** Self-contained callback serialized by Selenium into the actual production WebView. */
export function installSecondaryPanelProbe(options: SecondaryPanelProbeOptions) {
  const runtime = window as ProbeWindow;
  const native = runtime.__TAURI_INTERNALS__;
  if (!native || typeof native.convertFileSrc !== "function")
    throw new Error("Pinned native IPC transport is missing");
  if (runtime.__portcoveSecondaryPanelProbe)
    throw new Error("An owned secondary panel probe is already installed");
  const original = window.fetch;
  const fixtures = options.fixtures;
  const { portId, setupId, sha } = fixtures;
  const readReplies: Record<string, unknown> = {
    review_mod_setup_original: fixtures.original,
    inspect_mod_file: fixtures.preservation,
    list_mod_setup_recovery_builds: fixtures.recovery,
    preview_mod_setup_retirement: fixtures.retirement,
    inspect_mod_recipe: fixtures.recipe,
    get_mod_provider_catalog: {
      projects: fixtures.providerPage.page.projects,
      legacy_game_id: "owned-presentation-game",
      complete: true,
      observed_at: fixtures.providerPage.observed_at,
      freshness: fixtures.providerPage.freshness,
    },
    get_provider_project: fixtures.providerProject,
    plan_provider_install: fixtures.providerPlan,
    preview_mod_setup_draft: {
      order: [fixtures.modName],
      conflicts: [],
      conflicts_truncated: false,
    },
    preview_portable_save_export: fixtures.portableExport,
    preview_portable_save_import: fixtures.portableImport,
  };
  const refused = new Set([
    "select_mod_setup_original",
    "relink_mod_setup_original",
    "preserve_mod_file",
    "retire_mod_setup_recovery_build",
    "acquire_mod_recipe_package",
    "apply_mod_recipe",
    "apply_mod_setup_draft",
    "export_portable_saves",
    "import_portable_saves",
  ]);
  // These visible controls are outside this finite journey. Unexpected input
  // fails the observation before the supplied setup can reach a real mutation.
  const unplanned = new Set([
    "create_default_mod_setup",
    "copy_mod_setup",
    "create_clean_mod_setup",
    "list_mod_setup_revisions",
    "plan_profile_recovery",
    "apply_profile_recovery",
    "use_mod_setup",
    "export_mod_recipe",
    "set_mod_package_enabled",
    "remove_mod_package",
    "set_mod_update_policy",
    "check_provider_mod_updates",
    "open_provider_mod_project",
    "plan_local_mod_package",
    "apply_local_mod_package",
  ]);
  const commands = [
    ...Object.keys(readReplies),
    ...refused,
    ...unplanned,
    "get_mod_setups",
    "assess_port_intents",
    "acknowledge_port_readiness",
    "discard_mod_recipe_review",
    "discard_provider_install",
    "export_library_metadata",
  ];
  const boundArguments: Record<string, Record<string, string | number>> = {
    review_mod_setup_original: {
      profileId: setupId,
      expectedRevision: 2,
      requirementId: "owned-original",
    },
    select_mod_setup_original: {
      profileId: setupId,
      expectedRevision: 2,
      requirementId: "owned-original",
      instanceId: "owned-original-alternative",
    },
    relink_mod_setup_original: {
      profileId: setupId,
      expectedRevision: 2,
      requirementId: "owned-original",
    },
    inspect_mod_file: { fileName: fixtures.modName },
    preserve_mod_file: { fileName: fixtures.modName, expectedPlan: sha },
    list_mod_setup_recovery_builds: { profileId: setupId },
    preview_mod_setup_retirement: { profileId: setupId, revision: 1 },
    retire_mod_setup_recovery_build: {
      profileId: setupId,
      revision: 1,
      expectedPreviewSha256: sha,
    },
    acquire_mod_recipe_package: {
      profileId: setupId,
      nativeId: fixtures.modName,
      serializedPlan: fixtures.recipe.serialized_plan,
    },
    get_mod_provider_catalog: { source: "gamebanana" },
    get_provider_project: { projectId: "42", provider: "gamebanana" },
    plan_provider_install: {
      profileId: setupId,
      projectId: "42",
      fileId: "10",
      provider: "gamebanana",
      expectedGameId: "owned-presentation-game",
    },
    preview_mod_setup_draft: { profileId: setupId, expectedRevision: 2 },
    apply_mod_setup_draft: { profileId: setupId, expectedRevision: 2 },
    export_portable_saves: { expectedContent: sha },
    import_portable_saves: { expectedPreview: sha },
  };
  const targets = new Map(
    commands.map((command) => [native.convertFileSrc(command, "ipc"), command]),
  );
  const trace: SecondaryPanelTrace[] = [];
  const mismatches: string[] = [];
  let phase: "mods" | "preservation" = "mods";
  let acknowledgementAttempts = 0;
  let acknowledged = false;
  let traceOverflowed = false;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const reply = (value: unknown, outcome: "ok" | "error") =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Tauri-Response": outcome },
    });
  const refusal = (message = "Owned presentation fixture refused this action.") =>
    reply(
      {
        code: "state",
        message,
        details: { fixture: "native-secondary-panels" },
      },
      "error",
    );
  const capture = (): SecondaryPanelProbeObservation => ({
    synthetic: true,
    scope:
      "Supplied native WebView presentation data. DAT, metadata, Ready and theme preferences use the isolated Core. Unrelated background requests, including standing setup, retain the production transport.",
    trace: trace.map((entry) => ({ ...entry })),
    mismatches: [...mismatches],
    acknowledged,
  });
  const replacement: typeof fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const command = targets.get(url);
    if (!command) return original.call(window, input, init);
    if (trace.length >= 512) {
      if (!traceOverflowed)
        mismatches.push("Owned secondary panel trace exceeded its finite bound");
      traceOverflowed = true;
      return Promise.resolve(refusal());
    }
    let args: Record<string, unknown>;
    try {
      if (typeof init?.body !== "string") throw new Error("Expected JSON IPC arguments");
      const decoded: unknown = JSON.parse(init.body);
      if (!record(decoded)) throw new Error("Expected an IPC argument object");
      args = decoded;
    } catch {
      mismatches.push(`${command}: malformed arguments`);
      trace.push({ command, port_id: null, generation: null, outcome: "refused" });
      return Promise.resolve(refusal());
    }
    const observation: SecondaryPanelTrace = {
      command,
      port_id: typeof args.portId === "string" ? args.portId : null,
      generation: typeof args.generation === "number" ? args.generation : null,
      outcome: "supplied",
    };
    trace.push(observation);
    const deny = (reason: string) => {
      observation.outcome = "refused";
      mismatches.push(`${command}: ${reason}`);
      return Promise.resolve(refusal());
    };
    if (args.generation !== options.generation) return deny("generation changed");
    if (command === "export_library_metadata") {
      if (args.path === options.metadataPath) {
        observation.outcome = "forwarded";
        return original.call(window, input, init);
      }
      if (args.path !== options.refusedMetadataPath) return deny("unexpected metadata path");
      observation.outcome = "refused";
      return Promise.resolve(refusal("Owned presentation metadata export refusal."));
    }
    if (command === "assess_port_intents") {
      return Promise.resolve(
        reply(
          { ...fixtures.ready, assessments: acknowledged ? [] : fixtures.ready.assessments },
          "ok",
        ),
      );
    }
    if (command === "acknowledge_port_readiness") {
      const notices = args.acknowledgements;
      if (
        !Array.isArray(notices) ||
        notices.length !== 1 ||
        !record(notices[0]) ||
        notices[0].port_id !== portId ||
        notices[0].plan_sha256 !== sha
      )
        return deny("unexpected acknowledgement identity");
      acknowledgementAttempts++;
      if (acknowledgementAttempts === 1) {
        observation.outcome = "refused";
        return Promise.resolve(refusal("Owned presentation acknowledgement refusal."));
      }
      acknowledged = true;
      return Promise.resolve(reply(null, "ok"));
    }
    if (args.portId !== portId) return deny("port changed");
    if (unplanned.has(command)) return deny("unplanned panel command");
    if (args.profileId !== undefined && args.profileId !== setupId) return deny("setup changed");
    if (args.onEvent !== undefined) return deny("unexpected progress channel");
    for (const [name, value] of Object.entries(boundArguments[command] ?? {})) {
      if (args[name] !== value) return deny(`unexpected ${name}`);
    }
    if (command === "inspect_mod_recipe" && args.path !== options.recipePath)
      return deny("unexpected recipe path");
    if (command === "preview_portable_save_import" && args.path !== options.portableInputPath)
      return deny("unexpected import path");
    if (command === "export_portable_saves" && args.path !== options.portableOutputPath)
      return deny("unexpected export path");
    if (command === "get_mod_setups") {
      const mods = fixtures.mods;
      return Promise.resolve(
        reply(
          {
            ...mods,
            live: { ...mods.live, unmanaged: phase === "preservation" ? [fixtures.modName] : [] },
          },
          "ok",
        ),
      );
    }
    if (command === "discard_mod_recipe_review" || command === "discard_provider_install")
      return Promise.resolve(reply(null, "ok"));
    if (refused.has(command)) {
      observation.outcome = "refused";
      return Promise.resolve(refusal());
    }
    return Promise.resolve(reply(readReplies[command], "ok"));
  };
  window.fetch = replacement;
  runtime.__portcoveSecondaryPanelProbe = {
    phase(value) {
      phase = value;
    },
    capture,
    restore() {
      const ownsFetch = window.fetch === replacement;
      if (ownsFetch) window.fetch = original;
      const restored = ownsFetch && window.fetch === original;
      const result = { ...capture(), restored, trustworthy: restored && mismatches.length === 0 };
      if (restored) delete runtime.__portcoveSecondaryPanelProbe;
      return result;
    },
  };
}
