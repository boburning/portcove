import { readFileSync } from "node:fs";
import { isRecord } from "./runtime-values.mts";

interface DesktopScenario {
  operation_routes?: readonly { operation: string; runtime_kind?: string }[];
  id: string;
  description: string;
  runnable: boolean;
  prerequisites: readonly string[];
  dependencies: readonly string[];
  host_resources: readonly string[];
  source: string;
  qualification_only?: boolean;
  platforms?: readonly NodeJS.Platform[];
  reason?: string;
  cycle_option?: "restart-cycles" | "reload-cycles";
}

const nativeResources = ["native-desktop", "keyboard-pointer"];

function scenario(
  id: string,
  description: string,
  options: Partial<Omit<DesktopScenario, "id" | "description">> = {},
): Readonly<DesktopScenario> {
  return Object.freeze({
    id,
    description,
    runnable: true,
    prerequisites: ["desktop"],
    dependencies: [],
    host_resources: nativeResources,
    source: "desktop-test.mts",
    ...options,
  });
}

export const DESKTOP_SCENARIOS = Object.freeze([
  scenario(
    "native-preliminary-selected-setup",
    "Actual NotRun registration enters bounded setup selection and fresh Core review, then cancels safely.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      source: "desktop-source-dialog-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-saved-folder-hash-resume",
    "Actual saved hash-limited scan continues and freshly reviews a newly discovered input without registration.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      source: "desktop-source-dialog-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-preliminary-source-review",
    "Real pinned-validator discovery exposes NotRun and deliberate fresh review without registration.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      source: "desktop-source-dialog-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-qualification-history",
    "Recorded history and technical disclosure remain scoped and usable in the normal Linux WebView.",
    {
      source: "desktop-qualification-history-test.mts",
      qualification_only: true,
      platforms: ["linux"],
    },
  ),
  scenario(
    "native-selected-setup-completion",
    "Discovered synthetic inputs continue through ordinary installation, cancellation, retry and isolated preparation.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      source: "desktop-selected-setup-completion-test.mts",
      qualification_only: true,
      platforms: ["win32", "linux"],
    },
  ),
  scenario(
    "native-saved-folder-selected-setup",
    "Real saved-folder discovery, guarded registration and selected-port requirements preserve owned inputs.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      source: "desktop-source-dialog-test.mts",
      qualification_only: true,
      platforms: ["win32", "linux"],
    },
  ),
  scenario(
    "native-external-runtime-review",
    "Private prepared runtime picker, review, registration and non-owning removal preserve player files.",
    {
      operation_routes: [
        { operation: "register_external" },
        { operation: "remove_external", runtime_kind: "external" },
        { operation: "launch", runtime_kind: "external" },
      ],
      prerequisites: ["desktop", "native-dialog", "external-runtime-fixture"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-external-runtime-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-host-publication-recovery",
    "Instrumented Windows app-only loss at install, restore and whole-library publication boundaries.",
    {
      prerequisites: ["desktop", "owned-fixture", "install-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-host-publication-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-real-prepared-runtime",
    "Two reviewed real prepared runtimes use normal Desktop registration, launch and registration-only removal.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-real-runtime-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-startup-preferences-recovery",
    "Malformed saved preferences remain intact until an owned stopped-host repair, then reopen reliably.",
    {
      source: "desktop-bootstrap-recovery-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-normal-package-webview-boundary",
    "Ordinary Windows package enforces effective main-window assets, IPC, CSP, permission and navigation boundaries.",
    { source: "desktop-main-webview-boundary.mts", qualification_only: true },
  ),
  scenario(
    "native-linux-packaged-webview-boundary",
    "Ordinary Linux DEB payload preserves local assets, IPC, CSP and navigation boundaries; package extraction is not installed-system proof.",
    {
      source: "desktop-main-webview-boundary.mts",
      qualification_only: true,
      platforms: ["linux"],
    },
  ),
  scenario(
    "native-linux-webview-origin-boundary",
    "Actual Linux secondary, remote and same-label main contexts enforce IPC authority.",
    {
      source: "desktop-main-webview-boundary.mts",
      prerequisites: ["desktop", "webview-origin-fixture"],
      qualification_only: true,
      platforms: ["linux"],
    },
  ),
  scenario("empty-library", "Native bootstrap uses the isolated empty library."),
  scenario(
    "native-library-switch-recovery",
    "A refused future-library selection preserves the current workspace and permits a healthy saved restart.",
    {
      prerequisites: ["desktop", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-library-switch-recovery-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-startup-library-recovery",
    "Failed saved-library startup supports native cancellation, selection and a durable healthy restart.",
    {
      prerequisites: ["desktop", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-bootstrap-recovery-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-design-system-compatibility",
    "Generated styles, themes, nested portals, dismissal, focus, motion and offline assets work in Tauri.",
    {
      prerequisites: ["desktop", "design-compatibility-fixture"],
      qualification_only: true,
    },
  ),
  scenario("native-error-recovery", "A rejected native operation leaves the application usable."),
  scenario(
    "native-startup-network-diagnostic",
    "Observe one current auth-status response without repeating installation or claiming startup causality.",
    {
      source: "desktop-startup-network-diagnostic.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-library-selection-review",
    "Whole-library selection review stays non-mutating and restores its trigger.",
  ),
  scenario(
    "native-library-browsing-context",
    "A reviewed library generation change restores only its Catalog browsing inputs.",
    { qualification_only: true },
  ),
  scenario(
    "native-catalog-update-dialog",
    "Catalog trust and update management preserves nested dismissal without mutating catalog state.",
    { source: "desktop-catalog-update-test.mts" },
  ),
  scenario("keyboard-layout", "Keyboard focus and compact layout remain usable."),
  scenario(
    "native-interface-size",
    "Production WebView enlargement, narrow layout, modal reset and profile restoration.",
    {
      source: "desktop-interface-size-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-application-update-preferences",
    "Application update setup consent, focus and corrupt-state recovery remain isolated and explicit.",
  ),
  scenario("appearance-restart", "Appearance preferences survive a real application restart.", {
    cycle_option: "restart-cycles",
  }),
  scenario(
    "native-localization-foundation",
    "The actual Tauri settings journey persists locale, direction, focus and offline assets.",
  ),
  scenario("accessibility", "The native renderer passes the automated accessibility scan.", {
    source: "desktop-review-controls.mts",
  }),
  scenario(
    "native-controller-api-fallback",
    "Declare and observe expected controller API absence/restriction without claiming controller functionality.",
    {
      source: "desktop-controller-test.mts",
      qualification_only: true,
    },
  ),
  scenario("native-controller-large-list", "Injected controller navigation handles a large list.", {
    source: "desktop-controller-test.mts",
  }),
  scenario("native-expanded-navigation-copy", "Expanded navigation copy remains usable.", {
    source: "desktop-accessibility-test.mts",
  }),
  scenario("native-workspace-refresh-recovery", "A failed workspace refresh recovers visibly.", {
    source: "desktop-workspace-refresh-test.mts",
  }),
  scenario(
    "native-external-cli-reconciliation",
    "An open Desktop reconciles actual CLI commits without a synthetic event.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-workspace-refresh-test.mts",
    },
  ),
  scenario(
    "install-progress-cancellation",
    "A reviewed install can be cancelled during a real streamed download and retried safely.",
    {
      operation_routes: [{ operation: "install" }],
      prerequisites: ["desktop", "install-fixture"],
      source: "desktop-install-test.mts",
    },
  ),
  scenario(
    "install-commit-refresh-recovery",
    "A committed install remains successful when its immediate workspace refresh fails.",
    {
      prerequisites: ["desktop", "install-fixture"],
      source: "desktop-install-test.mts",
    },
  ),
  scenario(
    "native-update-acquisition-lifecycle",
    "Real immutable transfers coexist with owned Play, fresh exclusive apply/prepare reuse exact archives, and retained cancellation is discarded after reviewed uninstall.",
    {
      prerequisites: ["desktop", "install-fixture", "owned-fixture"],
      dependencies: ["install-commit-refresh-recovery"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-install-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-staged-update-composition",
    "A real staged update keeps the installed version playable and activation beside Play at compact and wide sizes.",
    {
      prerequisites: ["desktop", "install-fixture"],
      dependencies: ["install-commit-refresh-recovery"],
      source: "desktop-install-test.mts",
      qualification_only: true,
    },
  ),
  scenario("native-preparation-review-and-play", "Reviewed preparation completes before Play.", {
    operation_routes: [{ operation: "launch", runtime_kind: "managed" }],
    prerequisites: ["desktop", "owned-fixture"],
    source: "desktop-preparation-test.mts",
  }),
  scenario(
    "native-library-layout",
    "Native covers/rows preserve identity, search and profile preference through effective 320/240px reflow.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-ready-detail-composition",
    "Ready game details keep Play and the information hierarchy visible in both themes at supported window sizes.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play"],
      source: "desktop-preparation-test.mts",
    },
  ),
  scenario(
    "native-game-return-continuity",
    "Returning from an owned game process retains Library search, filter, scroll and Play focus.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play"],
      source: "desktop-preparation-test.mts",
    },
  ),
  scenario("native-game-update-review", "Game update review is non-mutating and restores focus.", {
    operation_routes: [{ operation: "update", runtime_kind: "managed" }],
    prerequisites: ["desktop", "owned-fixture"],
    source: "desktop-preparation-test.mts",
  }),
  scenario("native-missing-readiness-recovery", "Missing rendered readiness recovers safely.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-preparation-review-and-play"],
    source: "desktop-readiness-test.mts",
  }),
  scenario("native-retained-contract-repair-state", "Damaged retained state routes to repair.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-preparation-review-and-play"],
    source: "desktop-preparation-test.mts",
  }),
  scenario(
    "native-preparation-cancellation",
    "Preparation survives renderer restart, excludes a competing CLI target, permits unrelated native verification and settles cancellation authoritatively.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-test.mts",
    },
  ),
  scenario(
    "native-direct-preparation-recovery",
    "An actual failed owned preparation opens its affected game from the direct error without repeating work.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),

  scenario(
    "native-rejected-listener-registration",
    "One live Core preparation survives actual native event registration rejection and a fresh listener owner.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-preparation-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),

  scenario(
    "native-late-listener-disposal",
    "One live Core preparation survives genuine owner remounts and late native listener disposal.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-preparation-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-interrupted-preparation-recovery",
    "Interrupted preparation stays actionable across navigation and renderer restart.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-cancellation"],
      source: "desktop-preparation-recovery-test.mts",
    },
  ),
  scenario(
    "native-host-interrupted-preparation",
    "Forced Windows host termination during live preparation preserves originals and requires recovery.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-recovery-test.mts",
      qualification_only: true,
    },
  ),
  scenario(
    "native-linux-interrupted-preparation",
    "Private Linux PID namespace teardown during live preparation preserves owned inputs and exposes authoritative recovery.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-recovery-test.mts",
      qualification_only: true,
      platforms: ["linux"],
    },
  ),
  scenario(
    "native-closed-preparation-recovery",
    "Ordinary Windows host close during live preparation preserves originals and exposes uncertain recovery safely.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-recovery-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-minimized-preparation-continuity",
    "Live Windows preparation completes while minimized and restores authoritative ready state.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-recovery-test.mts",
      qualification_only: true,
      platforms: ["win32"],
    },
  ),
  scenario(
    "native-update-settings-save-without-execution",
    "Saving update settings does not execute an update.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play"],
      source: "desktop-preparation-test.mts",
    },
  ),
  scenario(
    "native-library-organization-restart",
    "Normal-app collection membership and favorites persist across an owned application restart.",
    {
      platforms: ["win32"],
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-test.mts",
      qualification_only: true,
    },
  ),
  scenario(
    "native-release-channel-selection-and-restart",
    "Release-channel selection survives renderer restart.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-update-settings-save-without-execution"],
      source: "desktop-preparation-test.mts",
    },
  ),
  scenario(
    "native-backup-delete-focus",
    "Real Windows consent and successful deletion restore remaining-row and parent focus.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-backup-review-test.mts",
      qualification_only: true,
    },
  ),
  scenario(
    "native-reviewed-backup-restore-and-delete",
    "Backup actions require reviewed consent.",
    {
      operation_routes: [
        { operation: "backup_create", runtime_kind: "managed" },
        { operation: "backup_restore", runtime_kind: "managed" },
      ],
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-backup-review-test.mts",
    },
  ),
  scenario(
    "native-reviewed-steam-entry-add-and-remove",
    "Steam entry Add and Remove use the reviewed isolated profile and native consent.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog", "steam-fixture"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-steam-entry-test.mts",
    },
  ),
  scenario(
    "native-reviewed-steam-batch-add",
    "Selected installed games share one reviewed Steam profile write and native consent.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog", "steam-fixture"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-steam-entry-test.mts",
    },
  ),
  scenario(
    "native-source-intake-and-discovery-dialogs",
    "One-off source intake and explicit-folder discovery preserve nested dismissal and source safety.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play"],
      source: "desktop-source-dialog-test.mts",
    },
  ),
  scenario(
    "native-primary-file-pickers",
    "Primary setup action opens the owned game and BIOS pickers and restores focus.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-primary-file-picker-test.mts",
    },
  ),
  scenario(
    "native-reviewed-installed-game-removal",
    "Installed-game removal preserves owned data.",
    {
      operation_routes: [{ operation: "remove_managed", runtime_kind: "managed" }],
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      dependencies: [
        "native-preparation-review-and-play",
        "native-reviewed-backup-restore-and-delete",
      ],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-removal-review-test.mts",
    },
  ),
  scenario("native-reviewed-source-reference-removal", "Source removal remains reference-only.", {
    prerequisites: ["desktop", "owned-fixture", "native-dialog"],
    dependencies: ["native-preparation-review-and-play"],
    host_resources: [...nativeResources, "native-dialog"],
    source: "desktop-source-removal-test.mts",
  }),
  scenario("native-reviewed-existing-install-copy", "Existing-install adoption is reviewed.", {
    prerequisites: ["desktop", "owned-fixture", "native-dialog"],
    dependencies: ["native-preparation-review-and-play"],
    host_resources: [...nativeResources, "native-dialog"],
    source: "desktop-adoption-review-test.mts",
  }),
  scenario(
    "native-library-move-invalidates-prior-reviews",
    "Library move, restore, and recovery invalidate stale reviews.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      dependencies: ["native-preparation-review-and-play", "native-reviewed-existing-install-copy"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-library-handoff-test.mts",
    },
  ),
  scenario("native-contextual-cli-handoff", "The UI exposes CLI context after library handoff.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-library-move-invalidates-prior-reviews"],
    source: "desktop-cli-handoff-test.mts",
  }),
  scenario(
    "native-local-artwork-picker-and-recovery",
    "Local artwork uses the native picker safely.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-artwork-test.mts",
    },
  ),
  scenario("native-repeated-library-reload", "Repeated renderer reloads preserve native reads.", {
    cycle_option: "reload-cycles",
    source: "desktop-reload-test.mts",
  }),
  scenario(
    "native-artwork-catalog-correction",
    "An unchanged app renders signed artwork corrections, preserves local choices and refuses stale publication.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-artwork-correction-test.mts",
      qualification_only: true,
    },
  ),
  scenario(
    "native-default-cover-cache-conditions",
    "Every mapped cover survives an offline cached restart; missing bytes exercise backend refusal and fallback.",
    { source: "desktop-default-cover-test.mts", qualification_only: true },
  ),
  scenario(
    "native-default-cover-display",
    "Accepted IGDB covers render in Catalog and details without client credentials.",
    {
      source: "desktop-default-cover-test.mts",
      qualification_only: true,
    },
  ),
]);

const smoke = [
  "empty-library",
  "native-error-recovery",
  "native-library-selection-review",
  "native-catalog-update-dialog",
  "keyboard-layout",
  "native-application-update-preferences",
  "appearance-restart",
  "accessibility",
  "native-controller-large-list",
  "native-expanded-navigation-copy",
  "native-workspace-refresh-recovery",
  "install-progress-cancellation",
  "install-commit-refresh-recovery",
];
const ownedLifecycle = [
  "native-external-cli-reconciliation",
  "native-preparation-review-and-play",
  "native-ready-detail-composition",
  "native-game-return-continuity",
  "native-game-update-review",
  "native-missing-readiness-recovery",
  "native-retained-contract-repair-state",
  "native-preparation-cancellation",
  "native-interrupted-preparation-recovery",
  "native-update-settings-save-without-execution",
  "native-release-channel-selection-and-restart",
  "native-reviewed-backup-restore-and-delete",
  "native-reviewed-steam-entry-add-and-remove",
  "native-reviewed-steam-batch-add",
  "native-source-intake-and-discovery-dialogs",
  "native-primary-file-pickers",
  "native-reviewed-installed-game-removal",
  "native-reviewed-source-reference-removal",
  "native-reviewed-existing-install-copy",
  "native-library-move-invalidates-prior-reviews",
  "native-contextual-cli-handoff",
];

export const DESKTOP_PROFILES = Object.freeze({
  smoke: Object.freeze(smoke),
  presentation: Object.freeze([
    "empty-library",
    "native-catalog-update-dialog",
    "keyboard-layout",
    "native-application-update-preferences",
    "native-localization-foundation",
    "accessibility",
    "native-controller-large-list",
    "native-expanded-navigation-copy",
  ]),
  restart: Object.freeze(["appearance-restart", "native-workspace-refresh-recovery"]),
  artwork: Object.freeze(["native-local-artwork-picker-and-recovery"]),
  "owned-lifecycle": Object.freeze(ownedLifecycle),
  full: Object.freeze([...smoke, ...ownedLifecycle, "native-local-artwork-picker-and-recovery"]),
});

export const desktopScenarioById = new Map(DESKTOP_SCENARIOS.map((item) => [item.id, item]));

function requireDesktopScenario(id: string): Readonly<DesktopScenario> {
  const item = desktopScenarioById.get(id);
  if (!item) throw new Error(`Unknown desktop scenario: ${id}`);
  return item;
}

function ordered(ids: Iterable<string>) {
  const selected = new Set(ids);
  return DESKTOP_SCENARIOS.filter((item) => selected.has(item.id)).map((item) => item.id);
}

function dependencyClosure(ids: readonly string[]) {
  const closure = new Set<string>();
  const visit = (id: string, chain: readonly string[] = []): void => {
    if (chain.includes(id))
      throw new Error(`Desktop scenario dependency cycle: ${[...chain, id].join(" -> ")}`);
    const item = desktopScenarioById.get(id);
    if (!item) throw new Error(`Unknown desktop scenario dependency: ${id}`);
    for (const dependency of item.dependencies) {
      closure.add(dependency);
      visit(dependency, [...chain, id]);
    }
  };
  for (const id of ids) visit(id);
  return closure;
}

export function resolveDesktopSelection({
  profile,
  scenarios = [],
  reloadCycles = 0,
  defaultProfile = "smoke",
  platform = process.platform,
}: {
  profile?: string | null | undefined;
  scenarios?: readonly string[];
  reloadCycles?: number;
  defaultProfile?: string;
  platform?: NodeJS.Platform;
} = {}) {
  if (profile && scenarios.length) throw new Error("--profile and --scenario cannot be combined");
  const selectedProfile = profile ?? (scenarios.length ? null : defaultProfile);
  const profileScenarios = selectedProfile
    ? Object.entries(DESKTOP_PROFILES).find(([name]) => name === selectedProfile)?.[1]
    : undefined;
  if (selectedProfile && !profileScenarios)
    throw new Error(`Unknown desktop profile: ${selectedProfile}`);
  const requested = profileScenarios ? [...profileScenarios] : [...scenarios];
  if (!requested.length) throw new Error("Desktop verification selected no scenarios");
  if (selectedProfile && reloadCycles > 0) requested.push("native-repeated-library-reload");
  if (!selectedProfile && reloadCycles > 0 && !requested.includes("native-repeated-library-reload"))
    throw new Error(
      "--reload-cycles with exact selection requires --scenario native-repeated-library-reload",
    );
  if (requested.includes("native-repeated-library-reload") && reloadCycles < 1)
    throw new Error("native-repeated-library-reload requires --reload-cycles 1..25");
  const unknown = requested.filter((id) => !desktopScenarioById.has(id));
  if (unknown.length)
    throw new Error(`Unknown desktop scenario: ${[...new Set(unknown)].join(", ")}`);
  const uniqueRequested = ordered(requested);
  if (
    uniqueRequested.includes("native-interface-size") &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("native-interface-size requires one standalone Windows scenario");
  if (
    uniqueRequested.includes("native-linux-interrupted-preparation") &&
    (uniqueRequested.length !== 1 || platform !== "linux")
  )
    throw new Error("native-linux-interrupted-preparation requires one standalone Linux scenario");
  if (
    uniqueRequested.includes("native-update-acquisition-lifecycle") &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("native-update-acquisition-lifecycle requires one standalone Windows scenario");
  if (uniqueRequested.includes("native-preliminary-selected-setup")) {
    if (uniqueRequested.length !== 1)
      throw new Error("native-preliminary-selected-setup requires one exact standalone scenario");
    if (platform !== "win32") throw new Error("native-preliminary-selected-setup requires Windows");
  }
  if (uniqueRequested.includes("native-saved-folder-hash-resume")) {
    if (uniqueRequested.length !== 1)
      throw new Error("native-saved-folder-hash-resume requires one exact standalone scenario");
    if (platform !== "win32") throw new Error("native-saved-folder-hash-resume requires Windows");
  }
  if (uniqueRequested.includes("native-preliminary-source-review")) {
    if (uniqueRequested.length !== 1)
      throw new Error("native-preliminary-source-review requires one exact standalone scenario");
    if (platform !== "win32") throw new Error("native-preliminary-source-review requires Windows");
  }
  if (uniqueRequested.includes("native-selected-setup-completion")) {
    if (uniqueRequested.length !== 1)
      throw new Error("native-selected-setup-completion requires one exact standalone scenario");
    if (!["win32", "linux"].includes(platform))
      throw new Error("native-selected-setup-completion requires Windows or Linux");
  }
  if (uniqueRequested.includes("native-startup-network-diagnostic") && uniqueRequested.length !== 1)
    throw new Error("native-startup-network-diagnostic requires one exact standalone scenario");
  if (
    uniqueRequested.includes("native-linux-packaged-webview-boundary") &&
    uniqueRequested.length !== 1
  )
    throw new Error(
      "native-linux-packaged-webview-boundary requires one exact standalone scenario",
    );
  if (
    uniqueRequested.includes("native-linux-webview-origin-boundary") &&
    uniqueRequested.length !== 1
  )
    throw new Error("native-linux-webview-origin-boundary requires one exact standalone scenario");
  if (uniqueRequested.includes("native-linux-webview-origin-boundary") && platform !== "linux")
    throw new Error("native-linux-webview-origin-boundary requires Linux");
  if (uniqueRequested.includes("native-library-organization-restart") && platform !== "win32")
    throw new Error("native-library-organization-restart requires Windows");
  if (uniqueRequested.includes("native-startup-network-diagnostic") && platform !== "win32")
    throw new Error("native-startup-network-diagnostic requires Windows");
  if (uniqueRequested.includes("native-saved-folder-selected-setup")) {
    if (uniqueRequested.length !== 1)
      throw new Error("native-saved-folder-selected-setup requires one exact standalone scenario");
    if (!["win32", "linux"].includes(platform))
      throw new Error("native-saved-folder-selected-setup requires Windows or Linux");
  }
  if (uniqueRequested.includes("native-external-runtime-review") && uniqueRequested.length !== 1)
    throw new Error("native-external-runtime-review requires one exact standalone scenario");
  if (
    uniqueRequested.includes("native-host-publication-recovery") &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("native-host-publication-recovery requires one standalone Windows scenario");
  if (
    uniqueRequested.includes("native-real-prepared-runtime") &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("native-real-prepared-runtime requires one exact standalone Windows scenario");
  if (uniqueRequested.includes("native-external-runtime-review") && platform !== "win32")
    throw new Error("native-external-runtime-review requires Windows");
  if (
    uniqueRequested.includes("native-direct-preparation-recovery") &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("native-direct-preparation-recovery requires one standalone Windows scenario");
  if (
    (uniqueRequested.includes("native-late-listener-disposal") ||
      uniqueRequested.includes("native-rejected-listener-registration")) &&
    (uniqueRequested.length !== 1 || platform !== "win32")
  )
    throw new Error("Operation listener qualification requires one standalone Windows scenario");
  if (
    uniqueRequested.includes("native-startup-preferences-recovery") &&
    uniqueRequested.length !== 1
  )
    throw new Error("native-startup-preferences-recovery requires one exact standalone scenario");
  if (uniqueRequested.includes("native-startup-library-recovery") && uniqueRequested.length !== 1)
    throw new Error("native-startup-library-recovery requires one exact standalone scenario");
  if (uniqueRequested.includes("native-library-switch-recovery") && uniqueRequested.length !== 1)
    throw new Error("native-library-switch-recovery requires one exact standalone scenario");
  if (
    uniqueRequested.includes("native-closed-preparation-recovery") &&
    uniqueRequested.length !== 1
  )
    throw new Error("native-closed-preparation-recovery requires one exact standalone scenario");
  const nonRunnable = uniqueRequested.filter((id) => !requireDesktopScenario(id).runnable);
  if (!selectedProfile && nonRunnable.length)
    throw new Error(`${nonRunnable.join(", ")} is an acceptance gap, not a runnable scenario`);
  const selected = uniqueRequested.filter((id) => requireDesktopScenario(id).runnable);
  const dependencies = dependencyClosure(selected);
  const selectedSet = new Set(selected);
  const setup = ordered([...dependencies].filter((id) => !selectedSet.has(id)));
  const executed = new Set([...selected, ...setup]);
  if (
    executed.has("native-staged-update-composition") &&
    executed.has("native-preparation-review-and-play")
  )
    throw new Error(
      "Staged-update composition and preparation must use separate fresh libraries; the staged fixture is intentionally retained",
    );
  if (executed.has("native-library-layout") && executed.has("native-preparation-cancellation"))
    throw new Error(
      "Library layout and preparation cancellation must use separate fresh libraries; their JakII fixture modes differ",
    );
  const excluded = DESKTOP_SCENARIOS.filter(
    (item) => !executed.has(item.id) && !nonRunnable.includes(item.id),
  ).map((item) => item.id);
  const prerequisites = [
    ...new Set([...selected, ...setup].flatMap((id) => requireDesktopScenario(id).prerequisites)),
  ];
  const hostResources = [
    ...new Set([...selected, ...setup].flatMap((id) => requireDesktopScenario(id).host_resources)),
  ];
  return {
    profile: selectedProfile,
    requested_scenarios: uniqueRequested,
    selected_scenarios: selected,
    setup_scenarios: setup,
    excluded_scenarios: excluded,
    known_gaps: nonRunnable.map((id) => ({
      scenario: id,
      reason: requireDesktopScenario(id).reason,
    })),
    prerequisites,
    host_resources: hostResources,
  };
}

export function catalogReport() {
  return DESKTOP_SCENARIOS.map((item) => ({
    ...item,
    profiles: Object.entries(DESKTOP_PROFILES)
      .filter(([, ids]) => ids.includes(item.id))
      .map(([name]) => name),
  }));
}

export type DesktopSelection = ReturnType<typeof resolveDesktopSelection>;

export function desktopHarnessDeadlineMs(
  selection: Pick<DesktopSelection, "selected_scenarios" | "setup_scenarios">,
) {
  // Three immutable upgrades, two owned live launches, reviews and positive exit joins.
  if (selection.selected_scenarios.includes("native-update-acquisition-lifecycle")) return 720_000;
  // Five checkpoints, positive host/driver joins and fresh starts; harness only.
  if (selection.selected_scenarios.includes("native-host-publication-recovery")) return 720_000;
  // Includes source verification of the owned256MiB intervention fixture,
  // manual-content restore and its preparation/adoption prerequisites.
  const executed = selection.selected_scenarios.length + selection.setup_scenarios.length;
  const ordinary = Math.max(
    // The integrated full suite has 35 journeys plus two-theme capture matrices.
    // Its previous ten-minute watchdog expired during still-progressing native
    // file handling. Keep individual waits and cleanup unchanged.
    executed > 24
      ? 20 * 60_000
      : executed > 8 ||
          selection.selected_scenarios.includes("native-reviewed-backup-restore-and-delete") ||
          selection.setup_scenarios.includes("native-reviewed-backup-restore-and-delete")
        ? 10 * 60_000
        : 3 * 60_000,
    selection.selected_scenarios.includes("native-library-move-invalidates-prior-reviews") ||
      selection.setup_scenarios.includes("native-library-move-invalidates-prior-reviews")
      ? 300_000
      : 0,
  );
  const cacheConditions = selection.selected_scenarios.includes(
    "native-default-cover-cache-conditions",
  );
  if (!cacheConditions && !selection.selected_scenarios.includes("native-default-cover-display"))
    return ordinary;
  const catalog: unknown = JSON.parse(
    readFileSync(new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url), "utf8"),
  );
  if (!isRecord(catalog) || !Array.isArray(catalog.ports))
    throw new Error("Invalid catalog port inventory");
  const covers = catalog.ports.filter((port: unknown) => {
    if (!isRecord(port)) throw new Error("Invalid catalog port entry");
    return isRecord(port.presentation) && Boolean(port.presentation.artwork);
  }).length;
  // Two themes per cover: existing card location (10s), image (15s), settling
  // (5s), and bounded navigation/capture allowance (10s). The detail subset
  // adds its existing waits. Individual deadlines and routine profiles stay fixed.
  const displayRuns =
    Number(cacheConditions) +
    Number(selection.selected_scenarios.includes("native-default-cover-display"));
  return (
    ordinary +
    displayRuns * (covers * 2 * 40_000 + Math.min(covers, 12) * 2 * 30_000) +
    (cacheConditions ? 180_000 : 0)
  );
}
