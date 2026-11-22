import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { WebDriver, WebElement, By, until } from "selenium-webdriver";
import type { ScenarioArtifacts } from "./desktop-scenario-context.mts";
import type { BoundaryInvoke } from "./desktop-main-webview-boundary.mts";
import type { DesktopSelection } from "../../../scripts/desktop-scenarios.mts";
import type {
  OutputDesktopBootstrapStatus,
  TransportOutputs,
} from "../src/transport-types.generated.d.ts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type { captureAccessibilityReport as captureAccessibility } from "./desktop-review-controls.mts";
interface SwitchContext extends ScenarioArtifacts {
  invoke: BoundaryInvoke;
  By: typeof By;
  until: typeof until;
  fixture: Awaited<ReturnType<typeof prepareLibrarySwitchRecoveryFixture>>;
  captureScreenshot: (name: string, required?: boolean) => Promise<unknown>;
  restart: (name: string) => Promise<WebDriver>;
  chooseOwnedLibrary: ReturnType<typeof nativeConfirmation>;
  captureAccessibilityReport: typeof captureAccessibility;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
import { executeBrowserScript } from "./browser-script.mts";
import { readWorkspaceSnapshotObservation } from "./desktop-review-observation.mts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const librarySwitchRecoveryId = "native-library-switch-recovery";

export function librarySwitchRecoverySelection(
  selection: Pick<DesktopSelection, "selected_scenarios" | "setup_scenarios">,
  platform: string,
) {
  if (!selection.selected_scenarios.includes(librarySwitchRecoveryId)) return false;
  assert.equal(platform, "win32", "Library switch recovery currently requires Windows");
  assert.deepEqual(selection.selected_scenarios, [librarySwitchRecoveryId]);
  assert.deepEqual(selection.setup_scenarios, []);
  return true;
}

export async function prepareLibrarySwitchRecoveryFixture(output: string) {
  const currentRoot = path.join(output, "library");
  const futureRoot = path.join(output, "future-library");
  const healthyRoot = path.join(output, "healthy-library");
  await mkdir(futureRoot);
  await mkdir(currentRoot);
  await mkdir(healthyRoot);
  const futureDatabase = path.join(futureRoot, "portcove.sqlite3");
  const database = new DatabaseSync(futureDatabase);
  try {
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);" +
        "INSERT INTO schema_migrations VALUES (999, 0);",
    );
  } finally {
    database.close();
  }
  const currentMarker = path.join(currentRoot, "owned-player-marker.bin");
  const futureMarker = path.join(futureRoot, "owned-player-marker.bin");
  const preferences = path.join(output, "preferences.json");
  for (const marker of [currentMarker, futureMarker])
    await writeFile(marker, "synthetic retained player data\n", { flag: "wx" });
  await writeFile(
    preferences,
    `${JSON.stringify({ format_version: 1, library_root: currentRoot })}\n`,
    { flag: "wx" },
  );
  const before = {
    futureDatabase: path.join(output, "future-database-before.bin"),
    currentMarker: path.join(output, "current-marker-before.bin"),
    futureMarker: path.join(output, "future-marker-before.bin"),
    preferences: path.join(output, "preferences-before.json"),
  };
  const originals = { futureDatabase, currentMarker, futureMarker, preferences };
  for (const key of ["futureDatabase", "currentMarker", "futureMarker", "preferences"] as const)
    await writeFile(before[key], await readFile(originals[key]), { flag: "wx" });
  return {
    currentRoot,
    futureRoot,
    healthyRoot,
    futureDatabase,
    currentMarker,
    futureMarker,
    preferences,
    before,
  };
}

const canonicalPath = (value: string) => path.toNamespacedPath(path.resolve(value));

export function outgoingLibraryBusyDetails(textContent: string, outgoingRoot: string) {
  const details = object(JSON.parse(textContent));
  assert.equal(
    details.message,
    "the library is in use by another Portcove operation or process",
    "Only the outgoing library's exclusive lease refusal can be retried here",
  );
  assert.equal(
    canonicalPath(text(object(details.context).library_root)),
    canonicalPath(outgoingRoot),
    "The busy library must be the original library",
  );
  return details;
}

interface LibraryReadObserver {
  settled(): boolean;
  restore(): void;
}

function installLibraryReadObserver() {
  const runtime = window as Window & {
    __TAURI_INTERNALS__?: { convertFileSrc(command: string, protocol: string): string };
    __portcoveLibraryReadObserver?: LibraryReadObserver;
  };
  if (runtime.__portcoveLibraryReadObserver)
    throw new Error("Library read observer already installed");
  const bridge = runtime.__TAURI_INTERNALS__;
  if (!bridge) throw new Error("Native bridge unavailable");
  const targets = new Set(
    [
      "get_workspace_changed",
      "get_workspace_snapshot",
      "refresh_official_catalog_automatically",
      "run_standing_setup",
      "assess_port_intents",
    ].map((command) => bridge.convertFileSrc(command, "ipc")),
  );
  const original = window.fetch;
  let pending = 0;
  let lastChange = performance.now();
  const settle = () => {
    pending--;
    lastChange = performance.now();
  };
  const fetch: typeof window.fetch = function (this: unknown, ...args) {
    const input = args[0];
    const result = original.apply(this, args);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (targets.has(url)) {
      pending++;
      lastChange = performance.now();
      void result.then(settle, settle);
    }
    return result;
  };
  runtime.__portcoveLibraryReadObserver = {
    settled: () => pending === 0 && performance.now() - lastChange >= 500,
    restore: () => {
      if (window.fetch !== fetch) throw new Error("Library read observer lost fetch ownership");
      window.fetch = original;
      delete runtime.__portcoveLibraryReadObserver;
    },
  };
  window.fetch = fetch;
}

export async function librarySwitchRecoveryScenario({
  browser,
  invoke,
  By,
  until,
  fixture,
  chooseOwnedLibrary,
  captureScreenshot,
  captureAccessibilityReport,
  restart,
  output,
  artifacts,
}: SwitchContext) {
  const { transportValue } = await import("./transport-values.mts");
  function read(
    command: "get_bootstrap_status",
    args?: object,
  ): Promise<OutputDesktopBootstrapStatus>;
  function read(
    command: "get_library_identity",
    args?: object,
  ): Promise<TransportOutputs["library_identity"]>;
  async function read(command: "get_bootstrap_status" | "get_library_identity", args?: object) {
    const result = object(await invoke(command, args));
    assert.equal(result.ok, true, JSON.stringify(result));
    switch (command) {
      case "get_bootstrap_status":
        return transportValue("desktop_bootstrap_status", result.value);
      case "get_library_identity":
        return transportValue("library_identity", result.value);
    }
  }
  const workspaceReadbacks: unknown[] = [];
  const before = await read("get_bootstrap_status");
  assert.equal(before.ready, true);
  assert.equal(canonicalPath(required(before.library_root)), canonicalPath(fixture.currentRoot));
  assert.equal(required(before.selection).source, "saved");
  const originalIdentity = await read("get_library_identity", { generation: before.generation });
  const originalPreferences = await readFile(fixture.preferences);
  const assertPreservation = async () => {
    for (const key of ["futureDatabase", "currentMarker", "futureMarker"] as const)
      assert.deepEqual(await readFile(fixture[key]), await readFile(fixture.before[key]), key);
  };
  const openLibraryStorage = async () => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    const storageCategory = By.xpath(
      '//nav[@aria-label="Settings categories"]//button[normalize-space(.)="Library and storage"]',
    );
    await browser.wait(until.elementLocated(storageCategory), 15_000);
    await browser.findElement(storageCategory).click();
  };
  await openLibraryStorage();
  const trigger = By.xpath('//button[normalize-space(.)="Choose another library"]');
  const dialog = By.css('[aria-labelledby="library-selection-review-title"]');
  const selectAndReview = async (target: string, name: string) => {
    await executeBrowserScript(browser, installLibraryReadObserver);
    let observed: { review: WebElement } | { failure: unknown };
    try {
      await browser.wait(until.elementLocated(trigger), 15_000);
      await browser.findElement(trigger).click();
      const picker = await chooseOwnedLibrary(
        "Choose Portcove library",
        "Select Folder",
        "Folder",
        name,
        undefined,
        target,
      );
      assert.equal(canonicalPath(text(object(picker).selected_directory)), canonicalPath(target));
      const review = await browser.wait(until.elementLocated(dialog), 15_000);
      await browser.wait(until.elementIsVisible(review), 5_000);
      const reviewedPath = await review.findElement(By.css("code")).getText();
      assert.equal(canonicalPath(reviewedPath), canonicalPath(target));
      // The picker returns focus, which can start a real workspace refresh.
      // Wait inside the exact review before giving explicit switch consent.
      await browser.wait(
        () =>
          executeBrowserScript(browser, () => {
            const runtime = window as Window & {
              __portcoveLibraryReadObserver?: LibraryReadObserver;
            };
            if (!runtime.__portcoveLibraryReadObserver)
              throw new Error("Library read observer unavailable");
            return runtime.__portcoveLibraryReadObserver.settled();
          }),
        60_000,
        "The owned WebView must settle its focus-triggered library reads before switch consent",
      );
      observed = { review };
    } catch (failure) {
      observed = { failure };
    }
    try {
      await executeBrowserScript(browser, () => {
        const runtime = window as Window & {
          __portcoveLibraryReadObserver?: LibraryReadObserver;
        };
        if (!runtime.__portcoveLibraryReadObserver)
          throw new Error("Library read observer unavailable for restoration");
        runtime.__portcoveLibraryReadObserver.restore();
      });
    } catch (cleanupError) {
      if ("review" in observed) throw cleanupError;
      console.error("Library read observer could not be restored", cleanupError);
    }
    if ("failure" in observed) throw observed.failure;
    return observed.review;
  };
  const inspectSelection = async (target: string, generation: number) => {
    const result = object(await invoke("review_library_selection", { path: target, generation }));
    assert.equal(result.ok, true, JSON.stringify(result));
    const inspection = transportValue("desktop_library_selection_review", result.value);
    assert.equal(canonicalPath(inspection.path), canonicalPath(target));
    assert.equal(inspection.contents, "existing_database");
    assert.match(inspection.review_sha256, /^[a-f0-9]{64}$/u);
    return inspection;
  };
  const expectPickerFocus = () =>
    browser.wait(
      () =>
        executeBrowserScript(browser, () =>
          document.activeElement?.matches('[data-library-selection-trigger="switch"]'),
        ),
      5_000,
      "Library selection did not return focus to its picker",
    );

  // The Windows folder picker can normalize the alias before returning it.
  // Bind the original lexical alias through the real read-only Core review too.
  const alias = fixture.currentRoot + path.sep + ".";
  const keptReview = await inspectSelection(alias, before.generation);
  assert.equal(keptReview.effect, "keep");
  const sameLibrary = await selectAndReview(alias, "saved-library-alias-picker");
  assert.match(await sameLibrary.getText(), /This library is already selected/);
  assert.equal((await sameLibrary.findElements(By.css("button"))).length, 1);
  await captureScreenshot("saved-library-alias-no-op", true);
  await sameLibrary.findElement(By.xpath('.//button[normalize-space(.)="Done"]')).click();
  await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
  await expectPickerFocus();
  assert.deepEqual(await read("get_bootstrap_status"), before);
  assert.deepEqual(
    await read("get_library_identity", { generation: before.generation }),
    originalIdentity,
  );
  assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
  await assertPreservation();
  const alert = By.xpath(
    '//article[.//h2[normalize-space(.)="Library at startup"]]//*[@role="alert"]',
  );
  const confirmFutureChoice = async (picker: string) => {
    const futureReview = await selectAndReview(fixture.futureRoot, picker);
    assert.deepEqual(await read("get_bootstrap_status"), before);
    assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
    await assertPreservation();
    await captureScreenshot(picker + "-before-consent");
    await futureReview
      .findElement(By.xpath('.//button[normalize-space(.)="Switch library"]'))
      .click();
    return browser.wait(until.elementLocated(alert), 15_000);
  };
  let refusal = await confirmFutureChoice("future-library-picker");
  let futureOutgoingBusy;
  if ((await refusal.getText()).includes("Another task or program is using these files")) {
    await refusal.findElement(By.css("summary")).click();
    futureOutgoingBusy = outgoingLibraryBusyDetails(
      await refusal.findElement(By.css("pre")).getText(),
      fixture.currentRoot,
    );
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
    const unchanged = await read("get_bootstrap_status");
    assert.deepEqual(unchanged, before);
    assert.deepEqual(
      await read("get_library_identity", { generation: unchanged.generation }),
      originalIdentity,
    );
    assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
    await assertPreservation();
    await readWorkspaceSnapshotObservation(invoke, unchanged, workspaceReadbacks);
    await captureScreenshot("future-library-outgoing-lease-refused");
    // This exact refusal leaves both roots and the startup choice unchanged.
    // Open a new native review once after the outgoing workspace read settles.
    refusal = await confirmFutureChoice("future-library-picker-retry");
  }
  const refusalSummary = await refusal.getText();
  assert.match(refusalSummary, /This library requires a newer Portcove database version/);
  assert.ok(refusalSummary.includes("Portcove couldn't confirm whether anything changed."));
  await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
  const rejected = await read("get_bootstrap_status");
  assert.deepEqual(rejected, before);
  assert.deepEqual(
    await read("get_library_identity", { generation: rejected.generation }),
    originalIdentity,
  );
  await readWorkspaceSnapshotObservation(invoke, rejected, workspaceReadbacks);
  assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
  await assertPreservation();
  await browser.wait(until.elementIsEnabled(await browser.findElement(trigger)), 5_000);
  await browser.wait(
    async () =>
      executeBrowserScript(
        browser,
        "return document.activeElement === arguments[0];",
        await browser.findElement(trigger),
      ),
    5_000,
    "Failed library review did not return focus to its trigger",
  );
  await refusal.findElement(By.css("summary")).click();
  const refusalText = await refusal.getText();
  assert.match(refusalText, /newer Portcove database schema/);
  assert.match(refusalText, /library_schema_version/);
  assert.match(refusalText, /999/);
  await captureScreenshot("future-library-refused-current-workspace-retained");
  await captureAccessibilityReport(
    browser,
    path.join(output, "library-switch-refusal-accessibility.json"),
    artifacts,
  );
  const confirmHealthyChoice = async (name: string) => {
    const review = await selectAndReview(fixture.healthyRoot, name);
    await review.findElement(By.xpath('.//button[normalize-space(.)="Switch library"]')).click();
    return browser.wait(
      async () => {
        const status = await read("get_bootstrap_status");
        if (
          status.ready &&
          canonicalPath(required(status.library_root)) === canonicalPath(fixture.healthyRoot)
        )
          return { kind: "switched", status } as const;
        if ((await browser.findElements(dialog)).length > 0) return undefined;
        const refusal = (await browser.findElements(alert))[0];
        return refusal ? ({ kind: "refused", status, refusal } as const) : undefined;
      },
      15_000,
      "The reviewed healthy library must open or show a settled refusal",
    );
  };
  let healthyOutcome = required(await confirmHealthyChoice("healthy-library-picker"));
  let outgoingBusy;
  if (healthyOutcome.kind === "refused") {
    await captureScreenshot("healthy-library-switch-refused");
    await healthyOutcome.refusal.findElement(By.css("summary")).click();
    outgoingBusy = outgoingLibraryBusyDetails(
      await healthyOutcome.refusal.findElement(By.css("pre")).getText(),
      fixture.currentRoot,
    );
    assert.deepEqual(healthyOutcome.status, rejected);
    assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
    await assertPreservation();
    await readWorkspaceSnapshotObservation(invoke, rejected, workspaceReadbacks);
    await captureScreenshot("healthy-library-outgoing-lease-refused");
    // Reopen the picker and confirm the same owned target once after an exact
    // outgoing-library refusal. No write is repeated after a successful switch.
    healthyOutcome = required(await confirmHealthyChoice("healthy-library-picker-retry"));
    if (healthyOutcome.kind === "refused")
      throw new Error(
        `The reviewed healthy library was refused again: ${await healthyOutcome.refusal.getText()}`,
      );
  }
  const recovered = await read("get_bootstrap_status");
  assert.deepEqual(recovered, healthyOutcome.status);
  assert.ok(recovered.generation > before.generation);
  assert.equal(required(recovered.selection).source, "saved");
  const recoveredIdentity = await read("get_library_identity", {
    generation: recovered.generation,
  });
  const recoveredPreferences = await readFile(fixture.preferences);
  const savedPreferences: unknown = JSON.parse(recoveredPreferences.toString("utf8"));
  assert.equal(
    canonicalPath(text(object(savedPreferences).library_root)),
    canonicalPath(fixture.healthyRoot),
  );
  await assertPreservation();
  await captureScreenshot("library-switch-recovered");
  browser = await restart("library-switch-recovered");
  const restarted = await read("get_bootstrap_status");
  assert.equal(restarted.ready, true);
  assert.equal(canonicalPath(required(restarted.library_root)), canonicalPath(fixture.healthyRoot));
  assert.equal(required(restarted.selection).source, "saved");
  assert.deepEqual(
    await read("get_library_identity", { generation: restarted.generation }),
    recoveredIdentity,
  );
  await readWorkspaceSnapshotObservation(invoke, restarted, workspaceReadbacks);
  assert.deepEqual(await readFile(fixture.preferences), recoveredPreferences);
  await assertPreservation();
  await captureScreenshot("library-switch-saved-restart");
  // Simulate an external edit to the owned fixture's startup choice while the
  // healthy library remains open. The explicit Settings action saves it again.
  const changedPreferences = {
    ...object(savedPreferences),
    library_root: fixture.currentRoot,
  };
  await writeFile(fixture.preferences, JSON.stringify(changedPreferences) + "\n");
  const startupReview = await inspectSelection(fixture.healthyRoot, restarted.generation);
  assert.equal(startupReview.effect, "change_startup");
  await openLibraryStorage();
  const saveStartup = await selectAndReview(fixture.healthyRoot, "save-current-library-picker");
  assert.match(await saveStartup.getText(), /Save this library for startup/);
  assert.deepEqual(JSON.parse(await readFile(fixture.preferences, "utf8")), changedPreferences);
  await captureScreenshot("current-library-startup-choice", true);
  await saveStartup
    .findElement(By.xpath('.//button[normalize-space(.)="Save startup choice"]'))
    .click();
  await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
  await expectPickerFocus();
  const savedAgain = await read("get_bootstrap_status");
  assert.deepEqual(savedAgain, restarted);
  assert.deepEqual(
    await read("get_library_identity", { generation: savedAgain.generation }),
    recoveredIdentity,
  );
  const confirmedPreferences = object(JSON.parse(await readFile(fixture.preferences, "utf8")));
  assert.equal(
    canonicalPath(text(confirmedPreferences.library_root)),
    canonicalPath(fixture.healthyRoot),
  );
  assert.deepEqual(confirmedPreferences, savedPreferences);
  await assertPreservation();
  const evidence = path.join(output, "library-switch-recovery.json");
  await writeFile(
    evidence,
    `${JSON.stringify({ before, rejected, refusalText, originalIdentity, outgoing_busy: outgoingBusy, future_outgoing_busy: futureOutgoingBusy, recovered, recoveredIdentity, restarted, kept_review: keptReview, startup_review: startupReview, saved_again: savedAgain, workspace_readbacks: workspaceReadbacks, future_database_and_markers_preserved: true, refused_preferences_preserved: true, saved_choice_survived_restart: true }, null, 2)}\n`,
    { flag: "wx" },
  );
  artifacts.push(evidence);
}
