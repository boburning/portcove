import { desktopScenarioById } from "./desktop-scenarios.mjs";

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
export function planDesktopExecution(selectionInput) {
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
  const cleanupName = selection.selected_scenarios.includes("native-external-runtime-review")
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
                    : "backup-focus";
  const inputs = ["app", "driver", "native-driver"].map((name) => ({ kind: "executable", name }));
  inputs.push(receiptSource(harnessUrl));
  if (selection.selected_scenarios.includes("native-saved-folder-selected-setup"))
    inputs.push(receiptSource(new URL("./desktop-source-dialog-test.mjs", harnessUrl)));
  if (selection.selected_scenarios.includes("native-selected-setup-completion"))
    for (const name of [
      "desktop-selected-setup-completion-test.mjs",
      "desktop-source-dialog-test.mjs",
      "../../../crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (bootstrapRecoverySession || preferencesRecoverySession)
    for (const name of [
      "desktop-bootstrap-recovery-test.mjs",
      "desktop-native-confirmation.mjs",
      "native-confirmation.ps1",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  if (librarySwitchRecoverySession)
    for (const name of [
      "desktop-library-switch-recovery-test.mjs",
      "desktop-bootstrap-recovery-test.mjs",
      "desktop-native-confirmation.mjs",
      "native-confirmation.ps1",
    ])
      inputs.push(receiptSource(new URL(name, harnessUrl)));
  inputs.push(receiptSource(new URL("./desktop-controller-test.mjs", harnessUrl)));
  for (const name of [
    "native-session.ps1",
    "native-process-tree.ps1",
    "native-startup-observation.ps1",
    "desktop-startup-observation.mjs",
    "desktop-owned-native-session.mjs",
  ])
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
    inputs.push(receiptSource(new URL("./native-confirmation.ps1", harnessUrl)));
  }
  if (selection.prerequisites.includes("install-fixture")) {
    inputs.push(receiptSource(new URL("./desktop-install-fixture.mjs", harnessUrl)));
    inputs.push(receiptSource(new URL("./desktop-install-test.mjs", harnessUrl)));
  }
  inputs.push(receiptSource(new URL("../../../scripts/desktop-scenarios.mjs", harnessUrl)));
  inputs.push(receiptSource(new URL("../../../scripts/native-session-lock.mjs", harnessUrl)));

  const executed = new Set([...selection.selected_scenarios, ...selection.setup_scenarios]);
  const needs = (requirement) => selection.prerequisites.includes(requirement);
  const sourceJourney = executed.has("native-saved-folder-selected-setup");
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
      members: roles.filter(({ id }) => id === "native-saved-folder-selected-setup"),
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
                  "native-selected-setup-completion",
                ].includes(id),
            ),
          },
        ]
      : []),
  ];
  return freeze({
    selection,
    receiptInputs: inputs,
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
      completionJourney,
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
