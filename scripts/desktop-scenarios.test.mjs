import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileIdentity } from "./development-evidence.mjs";
import {
  verifyNormalPackageEvidence,
  assertOwnedBoundaryRequests,
} from "../apps/desktop/scripts/desktop-main-webview-boundary.mjs";
import { assertSteamEntryContext } from "../apps/desktop/scripts/desktop-context-contract.mjs";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  librarySwitchRecoverySelection,
  prepareLibrarySwitchRecoveryFixture,
} from "../apps/desktop/scripts/desktop-library-switch-recovery-test.mjs";
import {
  bootstrapRecoveryEnvironment,
  bootstrapRecoverySelection,
  prepareBootstrapRecoveryFixture,
  preferencesRecoverySelection,
  preparePreferencesRecoveryFixture,
} from "../apps/desktop/scripts/desktop-bootstrap-recovery-test.mjs";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  DESKTOP_PROFILES,
  DESKTOP_SCENARIOS,
  resolveDesktopSelection,
} from "./desktop-scenarios.mjs";

test("preferences recovery is standalone and preserves a malformed original before repair", async (t) => {
  const id = "native-startup-preferences-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.equal(preferencesRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => preferencesRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-preferences-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await preparePreferencesRecoveryFixture(output);
  const original = await readFile(fixture.preferencesBefore);
  assert.throws(() => JSON.parse(original), SyntaxError);
  assert.deepEqual(await readFile(fixture.preferences), original);
  assert.deepEqual(await readFile(fixture.marker), await readFile(fixture.markerBefore));
  const repaired = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, repaired);
  await assert.rejects(preparePreferencesRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferencesBefore), original);
  assert.deepEqual(await readFile(fixture.preferences), repaired);
});

test("library switch recovery refuses unsupported hosts and mixed setup before launch", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-library-switch-recovery"] });
  assert.equal(librarySwitchRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => librarySwitchRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    librarySwitchRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(
    () =>
      resolveDesktopSelection({ scenarios: ["native-library-switch-recovery", "empty-library"] }),
    /standalone/,
  );
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-library-switch-recovery"));
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

test("future library fixture has a real SQLite ledger and cannot reseed a saved choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-library-switch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareLibrarySwitchRecoveryFixture(output);
  const bytes = await readFile(fixture.futureDatabase);
  assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
  const database = new DatabaseSync(fixture.futureDatabase, { readOnly: true });
  try {
    assert.deepEqual(
      database
        .prepare("SELECT version, applied_at FROM schema_migrations")
        .all()
        .map((row) => ({ ...row })),
      [{ version: 999, applied_at: 0 }],
    );
  } finally {
    database.close();
  }
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  assert.equal(
    JSON.parse(await readFile(fixture.preferences, "utf8")).library_root,
    fixture.currentRoot,
  );
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.healthyRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareLibrarySwitchRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.futureDatabase), bytes);
  for (const marker of ["currentMarker", "futureMarker"])
    assert.deepEqual(await readFile(fixture[marker]), await readFile(fixture.before[marker]));
});

test("startup recovery refuses unsupported host and mixed setup before launch", () => {
  const selection = {
    selected_scenarios: ["native-startup-library-recovery"],
    setup_scenarios: [],
  };
  assert.equal(bootstrapRecoverySelection(selection, "win32"), true);
  for (const platform of ["linux", "darwin"])
    assert.throws(() => bootstrapRecoverySelection(selection, platform), /requires Windows/);
  assert.throws(() =>
    bootstrapRecoverySelection({ ...selection, setup_scenarios: ["empty-library"] }, "win32"),
  );
  assert.throws(() =>
    bootstrapRecoverySelection(
      { ...selection, selected_scenarios: [...selection.selected_scenarios, "empty-library"] },
      "win32",
    ),
  );
});

test("startup fixture child cannot inherit case aliases that mask saved selection", () => {
  const inherited = {
    ...process.env,
    PORTCOVE_LIBRARY: "masked-saved-selection",
    Portcove_Library: "masked-mixed-selection",
    portcove_library: "masked-lower-selection",
    PORTCOVE_PREFERENCES: "owned-preferences",
  };
  const environment = bootstrapRecoveryEnvironment(inherited);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({library:process.env.PORTCOVE_LIBRARY,preferences:process.env.PORTCOVE_PREFERENCES}))",
    ],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { preferences: "owned-preferences" });
  assert.deepEqual(
    Object.keys(environment).filter((key) => key.toUpperCase() === "PORTCOVE_LIBRARY"),
    [],
  );
  assert.equal(inherited.PORTCOVE_LIBRARY, "masked-saved-selection");
  assert.equal(inherited.Portcove_Library, "masked-mixed-selection");
  assert.equal(inherited.portcove_library, "masked-lower-selection");
});

test("initial saved target is a regular file and reseeding cannot overwrite a recovered choice", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-recovery-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const fixture = await prepareBootstrapRecoveryFixture(output);
  assert.ok((await stat(fixture.invalidRoot)).isFile());
  assert.ok((await stat(fixture.selectedRoot)).isDirectory());
  const before = await readFile(fixture.preferencesBefore);
  assert.equal(JSON.parse(before).library_root, fixture.invalidRoot);
  assert.deepEqual(await readFile(fixture.invalidRoot), await readFile(fixture.invalidBefore));
  const recovered = Buffer.from(
    JSON.stringify({ format_version: 1, library_root: fixture.selectedRoot }),
  );
  await writeFile(fixture.preferences, recovered);
  await assert.rejects(prepareBootstrapRecoveryFixture(output), { code: "EEXIST" });
  assert.deepEqual(await readFile(fixture.preferences), recovered);
  assert.deepEqual(await readFile(fixture.preferencesBefore), before);
});

test("initial startup recovery remains a standalone opt-in native picker route", () => {
  const id = "native-startup-library-recovery";
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "native-dialog"]);
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  assert.throws(() => resolveDesktopSelection({ scenarios: [id, "empty-library"] }), /standalone/);
  assert.equal(desktopHarnessDeadlineMs(selection), 3 * 60_000);
});

test("cancelled navigation permits only observed GETs and never popup or execution traffic", () => {
  const request = { method: "GET", path: "/untrusted", phase: "navigation-http" };
  assertOwnedBoundaryRequests([]);
  assertOwnedBoundaryRequests([request]);
  for (const invalid of [
    { ...request, method: "POST" },
    { ...request, path: "/untrusted/popup" },
    { ...request, path: "/untrusted/executed-marker" },
    { ...request, phase: "main-controls" },
  ])
    assert.throws(() => assertOwnedBoundaryRequests([invalid]));
});

test("ordinary package boundary is isolated and rejects stale or substituted evidence", async (t) => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-normal-package-webview-boundary"],
  });
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop"]);
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-normal-package-webview-boundary"));
  const work = path.resolve("work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "normal-package-contract-"));
  t.after(async () => {
    assert.equal(path.dirname(root), work);
    await rm(root, { recursive: true });
  });
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  const configuration = [];
  for (const name of ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"]) {
    const file = path.join(root, "apps/desktop/src-tauri", name);
    await writeFile(file, "owned configuration fixture");
    configuration.push(await fileIdentity(file));
  }
  const installerPath = path.join(root, "installer.exe");
  await writeFile(installerPath, "owned package fixture");
  const installer = await fileIdentity(installerPath);
  const executable = { sha256: "a".repeat(64) };
  const receiptPath = path.join(root, "installer-evidence.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      phase: "complete",
      details: {
        installer_sha256: installer.sha256,
        installed_executable_sha256: executable.sha256,
        application_responding: true,
        persistent_data_preserved: true,
        managed_files_removed: true,
        registration_removed: true,
        application_exit_code: 0,
      },
    }),
  );
  const manifest = {
    revision: "b".repeat(40),
    build_command: ["corepack", "pnpm", "tauri", "build", "--bundles", "nsis"],
    qualification_features: [],
    configuration,
    installer,
    installer_evidence: await fileIdentity(receiptPath),
  };
  const manifestPath = path.join(root, "package.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root);
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, "c".repeat(40), executable, root),
    /source must match/,
  );
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, { sha256: "d".repeat(64) }, root),
  );
  await writeFile(installerPath, "substituted package");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
    /input changed/,
  );
  await writeFile(installerPath, "owned package fixture");
  const originalReceipt = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, originalReceipt.replace('"complete"', '"failed"'));
  manifest.installer_evidence = await fileIdentity(receiptPath);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, executable, root),
  );
  await mkdir(path.join(root, "installed"));
  const installedPath = path.join(root, "installed", "portcove-desktop.exe");
  await writeFile(installedPath, "owned installed executable");
  const installedExecutable = await fileIdentity(installedPath);
  const ready = {
    phase: "current_installed_boundary_ready",
    details: {
      installer_sha256: installer.sha256,
      installed_executable_sha256: installedExecutable.sha256,
      installed_executable_path: installedPath,
      install_root: path.dirname(installedPath),
      registration_path:
        "Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PortcoveFixture",
      uninstall_registration_count: 1,
      application_responding: true,
      application_exit_code: 0,
      persistent_data_preserved: true,
    },
  };
  manifest.execution_context = "current-installed";
  const bindReady = async (receipt) => {
    await writeFile(receiptPath, JSON.stringify(receipt));
    manifest.installer_evidence = await fileIdentity(receiptPath);
    await writeFile(manifestPath, JSON.stringify(manifest));
  };
  await bindReady(ready);
  const verified = await verifyNormalPackageEvidence(
    manifestPath,
    manifest.revision,
    installedExecutable,
    root,
  );
  assert.equal(verified.execution_context, "current-installed");
  for (const [field, value] of [
    ["uninstall_registration_count", 0],
    ["uninstall_registration_count", 2],
    [
      "registration_path",
      ready.details.registration_path.replace("HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"),
    ],
    ["installed_executable_path", path.join(root, "copied.exe")],
    ["install_root", root],
    ["application_responding", false],
    ["application_exit_code", 1],
    ["persistent_data_preserved", false],
  ]) {
    await bindReady({ ...ready, details: { ...ready.details, [field]: value } });
    await assert.rejects(
      verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
      `${field} must refuse current-installed credit`,
    );
  }
  await bindReady({ ...ready, phase: "complete" });
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Post-uninstall evidence must not claim a current installation",
  );
  await bindReady(ready);
  await writeFile(installedPath, "changed after installation");
  await assert.rejects(
    verifyNormalPackageEvidence(manifestPath, manifest.revision, installedExecutable, root),
    "Changed installed bytes must fail even when the manifest still matches",
  );
});

test("desktop scenario catalog is nonempty, unique, and fully profiled", () => {
  assert.ok(DESKTOP_SCENARIOS.length > 0);
  assert.equal(new Set(DESKTOP_SCENARIOS.map((item) => item.id)).size, DESKTOP_SCENARIOS.length);
  for (const [profile, ids] of Object.entries(DESKTOP_PROFILES)) {
    assert.ok(ids.length > 0, profile);
    assert.equal(new Set(ids).size, ids.length, profile);
    for (const id of ids)
      assert.ok(
        DESKTOP_SCENARIOS.some((item) => item.id === id),
        `${profile}: ${id}`,
      );
  }
  for (const item of catalogReport()) {
    if (item.id === "native-repeated-library-reload" || item.qualification_only) continue;
    assert.ok(item.profiles.length > 0, item.id);
    for (const dependency of item.dependencies) {
      const dependencyIndex = DESKTOP_SCENARIOS.findIndex(
        (candidate) => candidate.id === dependency,
      );
      const itemIndex = DESKTOP_SCENARIOS.findIndex((candidate) => candidate.id === item.id);
      assert.ok(dependencyIndex >= 0, `${item.id}: missing dependency ${dependency}`);
      assert.ok(dependencyIndex < itemIndex, `${item.id}: dependency must execute first`);
      assert.equal(DESKTOP_SCENARIOS[dependencyIndex].runnable, true, dependency);
    }
  }
});

test("smoke includes isolated install cancellation and committed-refresh recovery", () => {
  const selection = resolveDesktopSelection();
  assert.equal(selection.profile, "smoke");
  assert.ok(selection.selected_scenarios.includes("keyboard-layout"));
  assert.ok(selection.selected_scenarios.includes("install-progress-cancellation"));
  assert.ok(selection.selected_scenarios.includes("install-commit-refresh-recovery"));
  assert.ok(selection.prerequisites.includes("install-fixture"));
  assert.deepEqual(selection.known_gaps, []);
});

test("live default-cover observation remains opt-in without fixtures or offline profiles", () => {
  for (const id of ["native-default-cover-display", "native-default-cover-cache-conditions"]) {
    for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
    const selection = resolveDesktopSelection({ scenarios: [id] });
    assert.deepEqual(selection.selected_scenarios, [id]);
    assert.deepEqual(selection.setup_scenarios, []);
    assert.deepEqual(selection.prerequisites, ["desktop"]);
    assert.ok(desktopHarnessDeadlineMs(selection) > 180_000);
  }
});

test("exact selections are deduplicated and returned in catalog order", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["accessibility", "keyboard-layout", "accessibility"],
  });
  assert.equal(selection.profile, null);
  assert.deepEqual(selection.selected_scenarios, ["keyboard-layout", "accessibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
});

test("signed artwork correction is an isolated opt-in consumer proof", () => {
  const id = "native-artwork-catalog-correction";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});

test("design compatibility stays exact-selection-only and requests its isolated fixture", () => {
  for (const ids of Object.values(DESKTOP_PROFILES))
    assert.ok(!ids.includes("native-design-system-compatibility"));
  const selection = resolveDesktopSelection({
    scenarios: ["native-design-system-compatibility"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-design-system-compatibility"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("design-compatibility-fixture"));
});

test("live host interruption selects its own fixture without synthetic recovery setup", () => {
  const id = "native-host-interrupted-preparation";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture"]);
  assert.ok(selection.host_resources.includes("native-desktop"));
});

test("replacement identity failure cannot reuse the former host's exit receipt", () => {
  const session = new OwnedNativeSession();
  session.driver = { pid: 1 };
  session.inventory = "former-host-inventory";
  session.cleanup = { exited: { observed_processes: 3 } };
  const previous = session.requireQuiescence();
  session.beginLaunch(); // Called before spawning the replacement.
  // Spawn succeeded; its subsequent identity capture failed.
  assert.equal(session.cleanup, undefined, "Final cleanup cannot take an old-success shortcut");
  assert.equal(session.inventory, undefined);
  assert.throws(() => session.requireQuiescence(), /Current owned launch identity/);
  assert.equal(previous.exited.observed_processes, 3, "Former receipt stays preserved separately");
  session.driver = { pid: 2 };
  assert.throws(() => session.requireQuiescence(), /Current owned exit inventory/);
  session.inventory = "replacement-host-inventory";
  assert.throws(() => session.requireQuiescence(), /Positive current owned/);
  session.cleanup = { exited: { observed_processes: 4 } };
  assert.equal(session.requireQuiescence().exited.observed_processes, 4);
});

test("focused lifecycle selection resolves setup without claiming it", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-installed-game-removal"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-installed-game-removal"]);
  assert.deepEqual(selection.setup_scenarios, [
    "native-preparation-review-and-play",
    "native-reviewed-backup-restore-and-delete",
  ]);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
});

test("fixture-only reviews select without first-play while continuity keeps its setup", () => {
  const selection = resolveDesktopSelection({
    scenarios: ["native-reviewed-steam-entry-add-and-remove"],
  });
  assert.deepEqual(selection.selected_scenarios, ["native-reviewed-steam-entry-add-and-remove"]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.ok(selection.prerequisites.includes("owned-fixture"));
  assert.ok(selection.prerequisites.includes("steam-fixture"));
  assert.ok(selection.host_resources.includes("native-dialog"));
  for (const id of ["native-game-update-review", "native-reviewed-backup-restore-and-delete"])
    assert.deepEqual(resolveDesktopSelection({ scenarios: [id] }).setup_scenarios, [], id);
  assert.deepEqual(
    resolveDesktopSelection({ scenarios: ["native-game-return-continuity"] }).setup_scenarios,
    ["native-preparation-review-and-play"],
  );
  assert.ok(
    resolveDesktopSelection({ profile: "full" }).selected_scenarios.includes(
      "native-preparation-review-and-play",
    ),
  );
});

test("staged native composition installs its isolated fixture before review", () => {
  const selection = resolveDesktopSelection({ scenarios: ["native-staged-update-composition"] });
  assert.deepEqual(selection.selected_scenarios, ["native-staged-update-composition"]);
  assert.deepEqual(selection.setup_scenarios, ["install-commit-refresh-recovery"]);
  assert.ok(selection.prerequisites.includes("install-fixture"));
});

test("missing Steam review context fails without loading Selenium", () => {
  const context = {
    browser: {},
    invoke: async () => {},
    scenario: async () => {},
    output: "<negative-fixture>",
    artifacts: [],
    command: () => {},
    seed: async () => {},
    confirmNative: async () => {},
  };
  assert.throws(
    () => assertSteamEntryContext(context),
    /Steam review scenario requires context\.open/,
  );
});

test("selection rejects ambiguity, unknown IDs, and invalid reload requests", () => {
  assert.throws(
    () => resolveDesktopSelection({ profile: "smoke", scenarios: ["accessibility"] }),
    /cannot be combined/,
  );
  assert.throws(() => resolveDesktopSelection({ profile: "unknown" }), /Unknown desktop profile/);
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["missing"] }),
    /Unknown desktop scenario/,
  );
  const install = resolveDesktopSelection({ scenarios: ["install-progress-cancellation"] });
  assert.deepEqual(install.selected_scenarios, ["install-progress-cancellation"]);
  assert.ok(install.prerequisites.includes("install-fixture"));
  const refresh = resolveDesktopSelection({ scenarios: ["install-commit-refresh-recovery"] });
  assert.deepEqual(refresh.selected_scenarios, ["install-commit-refresh-recovery"]);
  assert.deepEqual(refresh.setup_scenarios, []);
  assert.ok(refresh.prerequisites.includes("install-fixture"));
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["native-repeated-library-reload"] }),
    /requires --reload-cycles/,
  );
  assert.throws(
    () => resolveDesktopSelection({ scenarios: ["accessibility"], reloadCycles: 2 }),
    /requires --scenario/,
  );
});

test("reload is opt-in for restart and full profiles", () => {
  assert.ok(
    !resolveDesktopSelection({ profile: "restart" }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
  assert.ok(
    resolveDesktopSelection({ profile: "restart", reloadCycles: 3 }).selected_scenarios.includes(
      "native-repeated-library-reload",
    ),
  );
});

test("large lifecycle profiles receive a bounded profile-scale watchdog", () => {
  assert.equal(
    desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "presentation" })),
    180_000,
  );
  assert.equal(desktopHarnessDeadlineMs(resolveDesktopSelection({ profile: "full" })), 600_000);
});

test("backup success-focus acceptance is isolated and exact-selection-only", () => {
  const id = "native-backup-delete-focus";
  for (const ids of Object.values(DESKTOP_PROFILES)) assert.ok(!ids.includes(id));
  const selection = resolveDesktopSelection({ scenarios: [id] });
  assert.deepEqual(selection.selected_scenarios, [id]);
  assert.deepEqual(selection.setup_scenarios, []);
  assert.deepEqual(selection.prerequisites, ["desktop", "owned-fixture", "native-dialog"]);
  assert.deepEqual(selection.host_resources, [
    "native-desktop",
    "keyboard-pointer",
    "native-dialog",
  ]);
  assert.equal(desktopHarnessDeadlineMs(selection), 180_000);
});
