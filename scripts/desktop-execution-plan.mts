import { parseArgs } from "node:util";
import { desktopScenarioById, resolveDesktopSelection } from "./desktop-scenarios.mts";
import { expandNativeHelperInputs } from "./native-helper-dependencies.mts";
import { gameFirstInstalledArgumentNames } from "./desktop-game-first-installed-inputs.mts";
import type { ReceiptInput } from "./native-helper-dependencies.mts";
import type { DesktopSelection } from "./desktop-scenarios.mts";

// The preparation journey is statically imported by the harness. Its validator
// reads these schemas during module initialization, including smoke selections.
// Shared display-identity, review-presentation and staged-layout helpers are runtime imports.
// Package/lock files are reproduction inputs, never claims of executed source.
export const nativeTransportReceiptSources = Object.freeze([
  "apps/desktop/scripts/desktop-scenario-state.mts",
  "apps/desktop/scripts/desktop-cover-observations.mts",
  "apps/desktop/scripts/desktop-scenario-outcomes.mts",
  "apps/desktop/scripts/desktop-review-presentation.mts",
  "apps/desktop/scripts/desktop-staged-layout.mts",
  "apps/desktop/scripts/desktop-game-first-test.mts",
  "scripts/desktop-game-first-installed-inputs.mts",
  "apps/desktop/scripts/transport-values.mts",
  "apps/desktop/src/port-identity.ts",
  "apps/desktop/src/interface-size-controller.ts",
  "apps/desktop/src/transport-schemas.generated.json",
  "apps/desktop/src/transport-host-output.generated.json",
  "apps/desktop/package.json",
  "pnpm-lock.yaml",
] as const);

const harnessUrl = new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url);
const rootUrl = new URL("../", import.meta.url);
function receiptSource(url: URL): Extract<ReceiptInput, { kind: "file" }> {
  return { kind: "file", path: decodeURIComponent(url.href.slice(rootUrl.href.length)) };
}
function freeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Private planning facts; never execution, consent, or process authority. */
export function planDesktopExecution(
  selectionInput: DesktopSelection,
  {
    platform = process.platform,
    prelaunchCustody = false,
    retainedMetadata = false,
  }: { platform?: NodeJS.Platform; prelaunchCustody?: boolean; retainedMetadata?: boolean } = {},
) {
  const selection = structuredClone(selectionInput);
  const bootstrapRecoverySession = selection.selected_scenarios.includes(
    "native-startup-library-recovery",
  );
  const preferencesRecoverySession = selection.selected_scenarios.includes(
    "native-startup-preferences-recovery",
  );
  const librarySwitchRecoverySession = selection.selected_scenarios.includes(
    "native-library-switch-recovery",
  );
  const historySession =
    selection.selected_scenarios.includes("native-qualification-history") ||
    (platform === "linux" &&
      selection.selected_scenarios.includes("native-default-cover-cache-conditions"));
  const backupFocusSession = selection.selected_scenarios.includes("native-backup-delete-focus");
  const hostInterruptionSession = selection.selected_scenarios.includes(
    "native-host-interrupted-preparation",
  );
  const ordinaryCloseSession = selection.selected_scenarios.includes(
    "native-closed-preparation-recovery",
  );
  const minimizedPreparationSession = selection.selected_scenarios.includes(
    "native-minimized-preparation-continuity",
  );
  const normalPackageSession = selection.selected_scenarios.includes(
    "native-normal-package-webview-boundary",
  );
  const acquisitionJourney = selection.selected_scenarios.includes(
    "native-update-acquisition-lifecycle",
  );
  const organizationRestart = selection.selected_scenarios.includes(
    "native-library-organization-restart",
  );
  const presentationSession =
    platform === "win32" &&
    (selection.profile === "presentation" ||
      (selection.selected_scenarios.length === 1 &&
        selection.selected_scenarios[0] === "native-interface-size"));
  const reviewedWorkflowSession =
    platform === "win32" &&
    selection.selected_scenarios.some((id) =>
      [
        "install-progress-cancellation",
        "native-reviewed-existing-install-copy",
        "native-library-move-invalidates-prior-reviews",
        "native-contextual-cli-handoff",
        "native-library-layout",
        "native-staged-update-composition",
        "native-local-artwork-picker-and-recovery",
        "native-artwork-catalog-correction",
        "native-game-first-choice-and-restart",
        "native-game-first-installed-picori",
        "appearance-restart",
        "native-workspace-refresh-recovery",
      ].includes(id),
    );
  const identityBoundSession =
    presentationSession ||
    reviewedWorkflowSession ||
    (platform === "win32" &&
      selection.selected_scenarios.includes("native-interrupted-preparation-recovery")) ||
    organizationRestart ||
    acquisitionJourney ||
    selection.selected_scenarios.includes("native-host-publication-recovery") ||
    selection.selected_scenarios.includes("native-real-prepared-runtime") ||
    selection.selected_scenarios.includes("native-direct-preparation-recovery") ||
    selection.selected_scenarios.includes("native-late-listener-disposal") ||
    selection.selected_scenarios.includes("native-rejected-listener-registration") ||
    selection.selected_scenarios.includes("native-preliminary-selected-setup") ||
    selection.selected_scenarios.includes("native-saved-folder-hash-resume") ||
    selection.selected_scenarios.includes("native-preliminary-source-review") ||
    (platform === "win32" && selection.selected_scenarios.includes("native-game-update-review")) ||
    (platform === "win32" &&
      selection.selected_scenarios.includes("native-reviewed-source-reference-removal")) ||
    (platform === "win32" &&
      selection.selected_scenarios.includes("native-reviewed-steam-batch-add")) ||
    (platform === "win32" &&
      selection.selected_scenarios.includes("native-reviewed-backup-restore-and-delete")) ||
    (platform === "win32" &&
      selection.selected_scenarios.includes("native-retained-contract-repair-state")) ||
    selection.selected_scenarios.includes("native-selected-setup-completion") ||
    selection.selected_scenarios.includes("native-startup-network-diagnostic") ||
    selection.selected_scenarios.includes("native-external-runtime-review") ||
    backupFocusSession ||
    hostInterruptionSession ||
    ordinaryCloseSession ||
    minimizedPreparationSession ||
    normalPackageSession ||
    preferencesRecoverySession ||
    bootstrapRecoverySession ||
    librarySwitchRecoverySession;
  const preferredCleanupName = selection.selected_scenarios.includes(
    "native-game-first-installed-picori",
  )
    ? "game-first-installed-picori"
    : acquisitionJourney
      ? "update-acquisition"
      : selection.selected_scenarios.includes("native-host-publication-recovery")
        ? "host-publication"
        : selection.selected_scenarios.includes("native-real-prepared-runtime")
          ? "real-prepared-runtime"
          : selection.selected_scenarios.includes("native-direct-preparation-recovery")
            ? "direct-preparation-recovery"
            : selection.selected_scenarios.includes("native-rejected-listener-registration")
              ? "rejected-listener-registration"
              : selection.selected_scenarios.includes("native-late-listener-disposal")
                ? "late-listener-disposal"
                : selection.selected_scenarios.includes("native-preliminary-selected-setup")
                  ? "preliminary-selected-setup"
                  : selection.selected_scenarios.includes("native-saved-folder-hash-resume")
                    ? "saved-folder-hash-resume"
                    : selection.selected_scenarios.includes("native-preliminary-source-review")
                      ? "preliminary-source-review"
                      : platform === "win32" &&
                          selection.selected_scenarios.includes(
                            "native-reviewed-backup-restore-and-delete",
                          )
                        ? "backup-review"
                        : platform === "win32" &&
                            selection.selected_scenarios.includes("native-game-update-review")
                          ? "game-update-review"
                          : selection.selected_scenarios.includes("native-external-runtime-review")
                            ? "external-runtime-review"
                            : selection.selected_scenarios.includes(
                                  "native-startup-network-diagnostic",
                                )
                              ? "startup-network-diagnostic"
                              : preferencesRecoverySession
                                ? "startup-preferences-recovery"
                                : librarySwitchRecoverySession
                                  ? "library-switch-recovery"
                                  : bootstrapRecoverySession
                                    ? "startup-library-recovery"
                                    : normalPackageSession
                                      ? "normal-package-boundary"
                                      : ordinaryCloseSession
                                        ? "ordinary-close-preparation"
                                        : hostInterruptionSession
                                          ? "host-interruption"
                                          : minimizedPreparationSession
                                            ? "minimized-preparation"
                                            : selection.selected_scenarios.includes(
                                                  "native-selected-setup-completion",
                                                )
                                              ? "selected-setup-completion"
                                              : platform === "win32" &&
                                                  selection.selected_scenarios.includes(
                                                    "native-retained-contract-repair-state",
                                                  )
                                                ? "retained-contract-repair"
                                                : platform === "win32" &&
                                                    !backupFocusSession &&
                                                    selection.selected_scenarios.includes(
                                                      "native-reviewed-source-reference-removal",
                                                    )
                                                  ? "source-reference-removal"
                                                  : platform === "win32" &&
                                                      !backupFocusSession &&
                                                      selection.selected_scenarios.includes(
                                                        "native-reviewed-steam-batch-add",
                                                      )
                                                    ? "steam-batch"
                                                    : "backup-focus";
  const cleanupName =
    platform === "win32" &&
    selection.selected_scenarios.includes("native-interrupted-preparation-recovery") &&
    preferredCleanupName === "backup-focus"
      ? "preparation-recovery"
      : organizationRestart && !backupFocusSession && preferredCleanupName === "backup-focus"
        ? "organization-restart"
        : presentationSession && preferredCleanupName === "backup-focus"
          ? "presentation"
          : reviewedWorkflowSession && preferredCleanupName === "backup-focus"
            ? "native-review"
            : preferredCleanupName;
  const inputs: ReceiptInput[] = ["app", "driver", "native-driver"].map((name) => ({
    kind: "executable",
    name,
  }));
  if (prelaunchCustody)
    for (const source of [
      "scripts/desktop-execution-plan.mts",
      "apps/desktop/scripts/desktop-owned-fixture-journeys.mts",
      "apps/desktop/scripts/desktop-owned-ipc-probe.mts",
    ])
      inputs.push({ kind: "file", path: source });
  for (const source of nativeTransportReceiptSources) inputs.push({ kind: "file", path: source });
  inputs.push({ kind: "file", path: "apps/desktop/test/capture-target.ts" });
  inputs.push({ kind: "file", path: "scripts/native-readiness.mts" });
  inputs.push({ kind: "file", path: "scripts/runtime-values.mts" });
  inputs.push({ kind: "file", path: "apps/desktop/scripts/browser-script.mts" });
  inputs.push({ kind: "file", path: "apps/desktop/scripts/browser-readiness.mts" });
  // Both owning scenarios are statically imported by the native harness.
  inputs.push({ kind: "file", path: "apps/desktop/scripts/native-enlargement.mts" });
  inputs.push({ kind: "file", path: "scripts/acceptance-packet.mts" });
  inputs.push(receiptSource(harnessUrl));
  if (selection.selected_scenarios.includes("native-host-publication-recovery"))
    inputs.push(receiptSource(new URL("./desktop-host-publication-test.mts", harnessUrl)));
  if (selection.selected_scenarios.includes("native-real-prepared-runtime")) {
    inputs.push(receiptSource(new URL("./desktop-real-runtime-test.mts", harnessUrl)));
    inputs.push({ kind: "file", path: "scripts/desktop-real-runtime-inputs.mts" });
  }
  if (selection.selected_scenarios.includes("native-game-first-installed-picori")) {
    inputs.push({ kind: "executable", name: "preparation-cli" });
    for (const name of gameFirstInstalledArgumentNames)
      inputs.push({ kind: "argument-file", name });
    // The real-runtime module supplies strict process observation and normal close.
    for (const name of [
      "desktop-game-first-installed-test.mts",
      "desktop-real-runtime-test.mts",
      "desktop-source-dialog-test.mts",
      "desktop-review-controls.mts",
      "desktop-native-confirmation.mts",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
    inputs.push({ kind: "file", path: "scripts/desktop-real-runtime-inputs.mts" });
  }
  if (
    platform === "linux" &&
    selection.selected_scenarios.some((id) =>
      ["native-preparation-cancellation", "native-linux-interrupted-preparation"].includes(id),
    )
  )
    for (const name of ["desktop-linux-native-session.mts", "native-linux-init.mts"])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (selection.selected_scenarios.includes("native-linux-packaged-webview-boundary")) {
    inputs.push(receiptSource(new URL("./desktop-main-webview-boundary.mts", harnessUrl)));
    inputs.push({ kind: "file", path: "scripts/desktop-linux-media.mts" });
  }
  if (selection.selected_scenarios.includes("native-linux-webview-origin-boundary"))
    inputs.push(receiptSource(new URL("desktop-main-webview-boundary.mts", harnessUrl)));
  if (
    selection.selected_scenarios.some((id) =>
      [
        "native-saved-folder-selected-setup",
        "native-preliminary-source-review",
        "native-preliminary-selected-setup",
        "native-saved-folder-hash-resume",
      ].includes(id),
    )
  )
    inputs.push(receiptSource(new URL("./desktop-source-dialog-test.mts", harnessUrl)));
  if (acquisitionJourney)
    for (const name of [
      "desktop-native-confirmation.mts",
      "../../../crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (selection.selected_scenarios.includes("native-selected-setup-completion"))
    for (const name of [
      "desktop-selected-setup-completion-test.mts",
      "desktop-completion-focus.mts",
      "desktop-source-dialog-test.mts",
      "../../../crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (bootstrapRecoverySession || preferencesRecoverySession)
    for (const name of ["desktop-bootstrap-recovery-test.mts", "desktop-native-confirmation.mts"])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (librarySwitchRecoverySession)
    for (const name of [
      "desktop-library-switch-recovery-test.mts",
      "desktop-bootstrap-recovery-test.mts",
      "desktop-native-confirmation.mts",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  inputs.push(receiptSource(new URL("./desktop-controller-test.mts", harnessUrl)));
  if (selection.selected_scenarios.includes("native-interface-size"))
    inputs.push(receiptSource(new URL("desktop-interface-size-test.mts", harnessUrl)));
  for (const name of ["desktop-startup-observation.mts", "desktop-owned-native-session.mts"])
    inputs.push(receiptSource(new URL(name, harnessUrl)));
  inputs.push(receiptSource(new URL("desktop-reload-test.mts", harnessUrl)));
  inputs.push(receiptSource(new URL("desktop-workspace-refresh-test.mts", harnessUrl)));
  if (historySession)
    inputs.push(receiptSource(new URL("desktop-qualification-history-test.mts", harnessUrl)));
  if (selection.selected_scenarios.includes("native-rejected-listener-registration"))
    for (const source of ["pnpm-workspace.yaml", "patches/@tauri-apps__api@2.12.4.patch"])
      inputs.push(receiptSource(new URL(source, rootUrl)));
  inputs.push(
    receiptSource(new URL("desktop-catalog-update-test.mts", harnessUrl)),
    receiptSource(new URL("desktop-default-cover-test.mts", harnessUrl)),
  );
  if (selection.prerequisites.includes("owned-fixture")) {
    if (selection.selected_scenarios.includes("native-artwork-catalog-correction"))
      for (const name of [
        "desktop-artwork-correction-test.mts",
        "testdata/catalog-artwork-red.jpg",
        "testdata/catalog-artwork-blue.jpg",
        "../../../scripts/sign-catalog.mts",
        "../../../crates/portcove-core/catalog/catalog.json",
      ])
        inputs.push(receiptSource(new URL(name, harnessUrl)));
    for (const name of ["preparation-cli", "preparation-tool"]) {
      inputs.push({ kind: "executable", name });
    }
    inputs.push(receiptSource(new URL("./desktop-preparation-test.mts", harnessUrl)));
    if (selection.selected_scenarios.includes("native-library-layout"))
      for (const name of ["testdata/catalog-artwork-red.jpg", "testdata/catalog-artwork-blue.jpg"])
        inputs.push(receiptSource(new URL(name, harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-readiness-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-artwork-observations.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-preparation-recovery-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-backup-review-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-removal-review-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-steam-entry-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-source-removal-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-adoption-review-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-library-handoff-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-cli-handoff-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-review-controls.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-native-confirmation.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-listener-lifetime-test.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-listener-lifetime-probe.mts", harnessUrl)));
  }
  if (selection.selected_scenarios.includes("native-library-browsing-context")) {
    for (const name of ["desktop-native-confirmation.mts"]) {
      const source = receiptSource(new URL(name, harnessUrl));
      if (!inputs.some((input) => input.path === source.path)) inputs.push(source);
    }
  }
  if (selection.prerequisites.includes("install-fixture")) {
    inputs.push(receiptSource(new URL("./desktop-install-fixture.mts", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-install-test.mts", harnessUrl)));
  }
  inputs.push(receiptSource(new URL("../../../scripts/desktop-scenarios.mts", harnessUrl)));
  inputs.push(receiptSource(new URL("../../../scripts/native-session-lock.mts", harnessUrl)));

  const executed = new Set([...selection.selected_scenarios, ...selection.setup_scenarios]);
  const needs = (requirement: string) => selection.prerequisites.includes(requirement);
  const preliminarySetupJourney = executed.has("native-preliminary-selected-setup");
  const preliminaryJourney =
    executed.has("native-preliminary-source-review") || preliminarySetupJourney;
  const hashResumeJourney = executed.has("native-saved-folder-hash-resume");
  const sourceJourney =
    executed.has("native-saved-folder-selected-setup") || preliminaryJourney || hashResumeJourney;
  const completionJourney = executed.has("native-selected-setup-completion");
  const roles = [
    ...selection.selected_scenarios.map((id) => ({ id, role: "selected" })),
    ...selection.setup_scenarios.map((id) => ({ id, role: "setup" })),
  ];
  // This order is the pre-change harness traversal, not catalog order.
  const preparationSources = new Set([
    "desktop-preparation-test.mts",
    "desktop-readiness-test.mts",
    "desktop-preparation-recovery-test.mts",
    "desktop-backup-review-test.mts",
    "desktop-steam-entry-test.mts",
    "desktop-source-dialog-test.mts",
    "desktop-primary-file-picker-test.mts",
    "desktop-removal-review-test.mts",
    "desktop-source-removal-test.mts",
    "desktop-adoption-review-test.mts",
    "desktop-library-handoff-test.mts",
    "desktop-cli-handoff-test.mts",
    "desktop-artwork-test.mts",
    "desktop-artwork-correction-test.mts",
    "desktop-game-first-test.mts",
  ]);
  const fixtureFamilies = [
    {
      family: "install",
      members: roles.filter(({ id }) =>
        [
          "install-progress-cancellation",
          "install-commit-refresh-recovery",
          "native-staged-update-composition",
          "native-update-acquisition-lifecycle",
        ].includes(id),
      ),
    },
    {
      family: "selected-setup",
      members: roles.filter(({ id }) =>
        [
          "native-saved-folder-selected-setup",
          "native-preliminary-source-review",
          "native-preliminary-selected-setup",
          "native-saved-folder-hash-resume",
        ].includes(id),
      ),
    },
    {
      family: "selected-setup-completion",
      members: roles.filter(({ id }) => id === "native-selected-setup-completion"),
    },
    { kind: "known-gaps" as const, gaps: selection.known_gaps },
    ...(needs("owned-fixture")
      ? [
          {
            family: "preparation",
            members: roles.filter(
              ({ id }) =>
                preparationSources.has(desktopScenarioById.get(id)?.source ?? "") &&
                ![
                  "native-saved-folder-selected-setup",
                  "native-preliminary-source-review",
                  "native-preliminary-selected-setup",
                  "native-saved-folder-hash-resume",
                  "native-selected-setup-completion",
                ].includes(id),
            ),
          },
        ]
      : []),
  ];
  if (retainedMetadata) inputs.push({ kind: "argument-file", name: "run-metadata" });
  return freeze({
    selection,
    receiptInputs: expandNativeHelperInputs(inputs),
    session: {
      bootstrapRecoverySession,
      preferencesRecoverySession,
      librarySwitchRecoverySession,
      historySession,
      backupFocusSession,
      hostInterruptionSession,
      ordinaryCloseSession,
      minimizedPreparationSession,
      normalPackageSession,
      reviewedWorkflowSession,
      identityBoundSession,
      cleanupName,
    },
    fixtures: {
      install: needs("install-fixture"),
      owned: needs("owned-fixture"),
      steam: needs("steam-fixture"),
      externalRuntime: needs("external-runtime-fixture"),
      sourceJourney,
      preliminaryJourney,
      ...(preliminarySetupJourney ? { preliminarySetupJourney: true } : {}),
      completionJourney,
      ...(acquisitionJourney ? { acquisitionJourney: true } : {}),
      ...(hashResumeJourney ? { hashResumeJourney: true } : {}),
      holdFirstDownload: completionJourney,
      designCompatibility: needs("design-compatibility-fixture"),
    },
    build: {
      cliFeatures:
        sourceJourney ||
        completionJourney ||
        selection.selected_scenarios.includes("native-host-publication-recovery")
          ? ["portcove-core/qualification-fixtures"]
          : [],
      qualificationFeatures:
        needs("install-fixture") || needs("steam-fixture") || needs("external-runtime-fixture")
          ? ["qualification-fixtures"]
          : needs("webview-origin-fixture")
            ? ["native-compatibility-qualification"]
            : [],
    },
    fixtureFamilies,
  });
}

export function parseDesktopHarnessOptions(args = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: {
      app: { type: "string" },
      "package-evidence": { type: "string" },
      driver: { type: "string" },
      "native-driver": { type: "string" },
      output: { type: "string" },
      profile: { type: "string" },
      scenario: { type: "string", multiple: true, default: [] },
      "cover-port-id": { type: "string", multiple: true, default: [] },
      port: { type: "string", default: "4444" },
      "preparation-cli": { type: "string" },
      "preparation-tool": { type: "string" },
      "game-first-inputs": { type: "string" },
      "game-first-source": { type: "string" },
      "game-first-runtime": { type: "string" },
      "game-first-shapes": { type: "string" },
      "game-first-logic": { type: "string" },
      "game-first-archive": { type: "string" },
      "artwork-only": { type: "boolean", default: false },
      "adoption-only": { type: "boolean", default: false },
      "accessibility-only": { type: "boolean", default: false },
      "restart-cycles": { type: "string", default: "1" },
      "reload-cycles": { type: "string", default: "0" },
      "run-metadata": { type: "string" },
    },
  });
}

export function resolveDesktopHarnessSelection(
  values: ReturnType<typeof parseDesktopHarnessOptions>["values"],
) {
  const reloadCycles = Number(values["reload-cycles"]);
  const restartCycles = Number(values["restart-cycles"]);
  const port = Number(values.port);
  if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10)
    throw new Error("--restart-cycles must be 1..10");
  if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25)
    throw new Error("--reload-cycles must be 0..25");
  if (!Number.isInteger(port) || port < 1024 || port > 65533)
    throw new Error("--port must be 1024..65533");
  const focusedModes = (["artwork-only", "adoption-only", "accessibility-only"] as const).filter(
    (name) => values[name],
  );
  if (focusedModes.length > 1) throw new Error("Choose only one focused desktop scenario mode");
  if (focusedModes.length && (values.profile || values.scenario.length))
    throw new Error("Legacy focused modes cannot be combined with --profile or --scenario");
  const installedPicori =
    values.scenario.length === 1 && values.scenario[0] === "native-game-first-installed-picori";
  if (installedPicori) {
    if (!values["preparation-cli"] || values["preparation-tool"])
      throw new Error("Picori requires --preparation-cli without a fixture tool");
    for (const name of gameFirstInstalledArgumentNames)
      if (!values[name]) throw new Error(`Picori requires --${name}`);
  } else if (gameFirstInstalledArgumentNames.some((name) => values[name])) {
    throw new Error("Game-first private inputs require the exact standalone Picori scenario");
  } else if (Boolean(values["preparation-cli"]) !== Boolean(values["preparation-tool"]))
    throw new Error("--preparation-cli and --preparation-tool must be supplied together");
  const legacyScenario = values["accessibility-only"]
    ? "accessibility"
    : values["artwork-only"]
      ? "native-local-artwork-picker-and-recovery"
      : values["adoption-only"]
        ? "native-reviewed-existing-install-copy"
        : null;
  const selection = resolveDesktopSelection({
    profile: values.profile,
    scenarios: legacyScenario ? [legacyScenario] : values.scenario,
    reloadCycles,
    defaultProfile: values["preparation-cli"] ? "full" : "smoke",
  });
  if (
    values["cover-port-id"].length &&
    !selection.selected_scenarios.some((id) =>
      ["native-default-cover-display", "native-default-cover-cache-conditions"].includes(id),
    )
  )
    throw new Error("--cover-port-id requires a default-cover observation scenario");
  return selection;
}
