import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { WebDriver, By, until } from "selenium-webdriver";
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
  captureScreenshot: (name: string) => Promise<unknown>;
  restart: (name: string) => Promise<WebDriver>;
  chooseOwnedLibrary: ReturnType<typeof nativeConfirmation>;
  captureAccessibilityReport: typeof captureAccessibility;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
import { executeBrowserScript } from "./browser-script.mts";
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
  function read(
    command: "get_workspace_snapshot",
    args?: object,
  ): Promise<TransportOutputs["desktop_workspace_snapshot"]>;
  async function read(
    command: "get_bootstrap_status" | "get_library_identity" | "get_workspace_snapshot",
    args?: object,
  ) {
    const result = object(await invoke(command, args));
    assert.equal(result.ok, true, JSON.stringify(result));
    switch (command) {
      case "get_bootstrap_status":
        return transportValue("desktop_bootstrap_status", result.value);
      case "get_library_identity":
        return transportValue("library_identity", result.value);
      case "get_workspace_snapshot":
        return transportValue("desktop_workspace_snapshot", result.value);
    }
  }
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
  await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
  const storageCategory = By.xpath(
    '//nav[@aria-label="Settings categories"]//button[normalize-space(.)="Library and storage"]',
  );
  await browser.wait(until.elementLocated(storageCategory), 15_000);
  await browser.findElement(storageCategory).click();
  const trigger = By.xpath('//button[normalize-space(.)="Choose another library"]');
  const dialog = By.css('[aria-labelledby="library-selection-review-title"]');
  const selectAndReview = async (target: string, name: string) => {
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
    assert.ok((await review.getText()).includes(target));
    return review;
  };
  const futureReview = await selectAndReview(fixture.futureRoot, "future-library-picker");
  assert.deepEqual(await read("get_bootstrap_status"), before);
  assert.deepEqual(await readFile(fixture.preferences), originalPreferences);
  await assertPreservation();
  await captureScreenshot("future-library-reviewed-before-consent");
  await futureReview
    .findElement(By.xpath('.//button[normalize-space(.)="Switch library"]'))
    .click();
  const alert = By.xpath(
    '//article[.//h2[normalize-space(.)="Library at startup"]]//*[@role="alert"]',
  );
  const refusal = await browser.wait(until.elementLocated(alert), 15_000);
  const refusalSummary = await refusal.getText();
  assert.match(refusalSummary, /The current operation state could not be confirmed/);
  await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
  const rejected = await read("get_bootstrap_status");
  assert.deepEqual(rejected, before);
  assert.deepEqual(
    await read("get_library_identity", { generation: rejected.generation }),
    originalIdentity,
  );
  await read("get_workspace_snapshot", { generation: rejected.generation });
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
  const healthyReview = await selectAndReview(fixture.healthyRoot, "healthy-library-picker");
  await healthyReview
    .findElement(By.xpath('.//button[normalize-space(.)="Switch library"]'))
    .click();
  await browser.wait(async () => {
    const status = await read("get_bootstrap_status");
    return (
      status.ready &&
      canonicalPath(required(status.library_root)) === canonicalPath(fixture.healthyRoot)
    );
  }, 15_000);
  const recovered = await read("get_bootstrap_status");
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
  await read("get_workspace_snapshot", { generation: restarted.generation });
  assert.deepEqual(await readFile(fixture.preferences), recoveredPreferences);
  await assertPreservation();
  await captureScreenshot("library-switch-saved-restart");
  const evidence = path.join(output, "library-switch-recovery.json");
  await writeFile(
    evidence,
    `${JSON.stringify({ before, rejected, refusalText, originalIdentity, recovered, recoveredIdentity, restarted, future_database_and_markers_preserved: true, refused_preferences_preserved: true, saved_choice_survived_restart: true }, null, 2)}\n`,
    { flag: "wx" },
  );
  artifacts.push(evidence);
}
