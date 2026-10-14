import { parseArgs } from "node:util";
import { desktopScenarioById, resolveDesktopSelection } from "./desktop-scenarios.mjs";
import { expandNativeHelperInputs } from "./native-helper-dependencies.mjs";

const harnessUrl = new URL("../apps/desktop/scripts/desktop-test.mjs", import.meta.url);
const rootUrl = new URL("../", import.meta.url);
function receiptSource(url) {
  return { kind: "file", path: decodeURIComponent(url.href.slice(rootUrl.href.length)) };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Private planning facts; never execution, consent, or process authority. */
export function planDesktopExecution(
  selectionInput,
  { platform = process.platform, prelaunchCustody = false } = {},
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
  const historySession = selection.selected_scenarios.includes("native-qualification-history");
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
  const identityBoundSession =
    selection.selected_scenarios.includes("native-preliminary-selected-setup") ||
    selection.selected_scenarios.includes("native-saved-folder-hash-resume") ||
    selection.selected_scenarios.includes("native-preliminary-source-review") ||
    (platform === "win32" && selection.selected_scenarios.includes("native-game-update-review")) ||
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
  const cleanupName = selection.selected_scenarios.includes("native-preliminary-selected-setup")
    ? "preliminary-selected-setup"
    : selection.selected_scenarios.includes("native-saved-folder-hash-resume")
      ? "saved-folder-hash-resume"
      : selection.selected_scenarios.includes("native-preliminary-source-review")
        ? "preliminary-source-review"
        : platform === "win32" &&
            selection.selected_scenarios.includes("native-reviewed-backup-restore-and-delete")
          ? "backup-review"
          : platform === "win32" &&
              selection.selected_scenarios.includes("native-game-update-review")
            ? "game-update-review"
            : selection.selected_scenarios.includes("native-external-runtime-review")
              ? "external-runtime-review"
              : selection.selected_scenarios.includes("native-startup-network-diagnostic")
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
                                  : "backup-focus";
  const inputs = ["app", "driver", "native-driver"].map((name) => ({ kind: "executable", name }));
  if (prelaunchCustody)
    for (const source of [
      "scripts/desktop-execution-plan.mjs",
      "apps/desktop/scripts/desktop-owned-fixture-journeys.mjs",
      "apps/desktop/scripts/desktop-owned-ipc-probe.mjs",
    ])
      inputs.push({ kind: "file", path: source });
  inputs.push(receiptSource(harnessUrl));
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
    inputs.push(receiptSource(new URL("./desktop-source-dialog-test.mjs", harnessUrl)));
  if (selection.selected_scenarios.includes("native-selected-setup-completion"))
    for (const name of [
      "desktop-selected-setup-completion-test.mjs",
      "desktop-source-dialog-test.mjs",
      "../../../crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (bootstrapRecoverySession || preferencesRecoverySession)
    for (const name of ["desktop-bootstrap-recovery-test.mjs", "desktop-native-confirmation.mjs"])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (librarySwitchRecoverySession)
    for (const name of [
      "desktop-library-switch-recovery-test.mjs",
      "desktop-bootstrap-recovery-test.mjs",
      "desktop-native-confirmation.mjs",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  inputs.push(receiptSource(new URL("./desktop-controller-test.mjs", harnessUrl)));
  for (const name of ["desktop-startup-observation.mjs", "desktop-owned-native-session.mjs"])
    inputs.push(receiptSource(new URL(name, harnessUrl)));
  inputs.push(receiptSource(new URL("desktop-reload-test.mjs", harnessUrl)));
  inputs.push(receiptSource(new URL("desktop-workspace-refresh-test.mjs", harnessUrl)));
  if (selection.selected_scenarios.includes("native-qualification-history"))
    inputs.push(receiptSource(new URL("desktop-qualification-history-test.mjs", harnessUrl)));
  inputs.push(
    receiptSource(new URL("desktop-catalog-update-test.mjs", harnessUrl)),
    receiptSource(new URL("desktop-default-cover-test.mjs", harnessUrl)),
  );
  if (selection.prerequisites.includes("owned-fixture")) {
    if (selection.selected_scenarios.includes("native-artwork-catalog-correction"))
      for (const name of [
        "desktop-artwork-correction-test.mjs",
        "testdata/catalog-artwork-red.jpg",
        "testdata/catalog-artwork-blue.jpg",
        "../../../scripts/sign-catalog.mjs",
        "../../../crates/portcove-core/catalog/catalog.json",
      ])
        inputs.push(receiptSource(new URL(name, harnessUrl)));
    for (const name of ["preparation-cli", "preparation-tool"]) {
      inputs.push({ kind: "executable", name });
    }
    inputs.push(receiptSource(new URL("./desktop-preparation-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-readiness-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-artwork-observations.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-preparation-recovery-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-backup-review-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-removal-review-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-steam-entry-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-source-removal-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-adoption-review-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-library-handoff-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-cli-handoff-test.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-review-controls.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-native-confirmation.mjs", harnessUrl)));
  }
  if (selection.selected_scenarios.includes("native-library-browsing-context")) {
    for (const name of ["desktop-native-confirmation.mjs"]) {
      const source = receiptSource(new URL(name, harnessUrl));
      if (!inputs.some((input) => input.path === source.path)) inputs.push(source);
    }
  }
  if (selection.prerequisites.includes("install-fixture")) {
    inputs.push(receiptSource(new URL("./desktop-install-fixture.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-install-test.mjs", harnessUrl)));
  }
  inputs.push(receiptSource(new URL("../../../scripts/desktop-scenarios.mjs", harnessUrl)));
  inputs.push(receiptSource(new URL("../../../scripts/native-session-lock.mjs", harnessUrl)));

  const executed = new Set([...selection.selected_scenarios, ...selection.setup_scenarios]);
  const needs = (requirement) => selection.prerequisites.includes(requirement);
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
    "desktop-preparation-test.mjs",
    "desktop-readiness-test.mjs",
    "desktop-preparation-recovery-test.mjs",
    "desktop-backup-review-test.mjs",
    "desktop-steam-entry-test.mjs",
    "desktop-source-dialog-test.mjs",
    "desktop-primary-file-picker-test.mjs",
    "desktop-removal-review-test.mjs",
    "desktop-source-removal-test.mjs",
    "desktop-adoption-review-test.mjs",
    "desktop-library-handoff-test.mjs",
    "desktop-cli-handoff-test.mjs",
    "desktop-artwork-test.mjs",
    "desktop-artwork-correction-test.mjs",
  ]);
  const fixtureFamilies = [
    {
      family: "install",
      members: roles.filter(({ id }) =>
        [
          "install-progress-cancellation",
          "install-commit-refresh-recovery",
          "native-staged-update-composition",
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
    { kind: "known-gaps", gaps: selection.known_gaps },
    ...(needs("owned-fixture")
      ? [
          {
            family: "preparation",
            members: roles.filter(
              ({ id }) =>
                preparationSources.has(desktopScenarioById.get(id)?.source) &&
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
      ...(hashResumeJourney ? { hashResumeJourney: true } : {}),
      holdFirstDownload: completionJourney,
      designCompatibility: needs("design-compatibility-fixture"),
    },
    build: {
      cliFeatures:
        sourceJourney || completionJourney ? ["portcove-core/qualification-fixtures"] : [],
      qualificationFeatures:
        needs("install-fixture") || needs("steam-fixture") || needs("external-runtime-fixture")
          ? ["qualification-fixtures"]
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
      port: { type: "string", default: "4444" },
      "preparation-cli": { type: "string" },
      "preparation-tool": { type: "string" },
      "artwork-only": { type: "boolean", default: false },
      "adoption-only": { type: "boolean", default: false },
      "accessibility-only": { type: "boolean", default: false },
      "restart-cycles": { type: "string", default: "1" },
      "reload-cycles": { type: "string", default: "0" },
      "run-metadata": { type: "string" },
    },
  });
}

export function resolveDesktopHarnessSelection(values) {
  const reloadCycles = Number(values["reload-cycles"]);
  const restartCycles = Number(values["restart-cycles"]);
  const port = Number(values.port);
  if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10)
    throw new Error("--restart-cycles must be 1..10");
  if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25)
    throw new Error("--reload-cycles must be 0..25");
  if (!Number.isInteger(port) || port < 1024 || port > 65533)
    throw new Error("--port must be 1024..65533");
  const focusedModes = ["artwork-only", "adoption-only", "accessibility-only"].filter(
    (name) => values[name],
  );
  if (focusedModes.length > 1) throw new Error("Choose only one focused desktop scenario mode");
  if (focusedModes.length && (values.profile || values.scenario.length))
    throw new Error("Legacy focused modes cannot be combined with --profile or --scenario");
  if (Boolean(values["preparation-cli"]) !== Boolean(values["preparation-tool"]))
    throw new Error("--preparation-cli and --preparation-tool must be supplied together");
  const legacyScenario = values["accessibility-only"]
    ? "accessibility"
    : values["artwork-only"]
      ? "native-local-artwork-picker-and-recovery"
      : values["adoption-only"]
        ? "native-reviewed-existing-install-copy"
        : null;
  return resolveDesktopSelection({
    profile: values.profile,
    scenarios: legacyScenario ? [legacyScenario] : values.scenario,
    reloadCycles,
    defaultProfile: values["preparation-cli"] ? "full" : "smoke",
  });
}
