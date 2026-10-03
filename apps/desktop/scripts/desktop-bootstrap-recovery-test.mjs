import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const bootstrapRecoveryScenarioId = "native-startup-library-recovery";

export function bootstrapRecoverySelection(selection, platform) {
  if (!selection.selected_scenarios.includes(bootstrapRecoveryScenarioId)) return false;
  assert.equal(platform, "win32", "Startup picker recovery currently requires Windows");
  assert.deepEqual(selection.selected_scenarios, [bootstrapRecoveryScenarioId]);
  assert.deepEqual(selection.setup_scenarios, []);
  return true;
}

const canonicalPath = (value) => path.toNamespacedPath(path.resolve(value));

export function bootstrapRecoveryEnvironment(environment) {
  const isolated = { ...environment };
  delete isolated.PORTCOVE_LIBRARY;
  return isolated;
}

// Called once before the first host, never during a reconnect or restart.
export async function prepareBootstrapRecoveryFixture(output) {
  const invalidRoot = path.join(output, "invalid-library-file");
  const selectedRoot = path.join(output, "selected-library");
  const preferences = path.join(output, "preferences.json");
  const invalidBefore = path.join(output, "invalid-library-before.bin");
  const preferencesBefore = path.join(output, "preferences-before.json");
  const marker = Buffer.from("owned invalid library target\n");
  const saved = Buffer.from(
    `${JSON.stringify({ format_version: 1, library_root: invalidRoot })}\n`,
  );
  await writeFile(invalidRoot, marker, { flag: "wx" });
  await writeFile(invalidBefore, marker, { flag: "wx" });
  await writeFile(preferences, saved, { flag: "wx" });
  await writeFile(preferencesBefore, saved, { flag: "wx" });
  await mkdir(selectedRoot);
  return { invalidRoot, selectedRoot, preferences, invalidBefore, preferencesBefore };
}

export async function bootstrapRecoveryScenario({
  browser,
  invoke,
  By,
  until,
  fixture,
  chooseOwnedLibrary,
  captureScreenshot,
  restart,
  output,
  artifacts,
}) {
  const bootstrap = async () => {
    const result = await invoke("get_bootstrap_status");
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const preferencesBefore = await readFile(fixture.preferencesBefore);
  const invalidBefore = await readFile(fixture.invalidBefore);
  const before = await bootstrap();
  assert.equal(before.ready, false);
  assert.ok(before.error?.code, "Actual failed startup must expose a typed error");
  assert.equal(before.library_root, null);
  assert.deepEqual(await readFile(fixture.preferences), preferencesBefore);
  assert.equal(
    (await browser.findElements(By.css('nav[aria-label="Primary navigation"]'))).length,
    0,
  );
  await captureScreenshot("startup-library-failure");
  const choose = By.xpath('//button[normalize-space(.)="Choose library"]');
  const reset = By.xpath('//button[normalize-space(.)="Use platform default"]');
  await browser.findElement(choose).click();
  await chooseOwnedLibrary("Choose Portcove library", "Cancel", "Folder", "startup-picker-cancel");
  await browser.wait(
    async () => {
      const row = await browser.findElement(By.css(".bootstrap-error .button-row"));
      return (
        (await row.getAttribute("aria-busy")) === "false" &&
        (await browser.findElement(choose).isEnabled()) &&
        (await browser.findElement(reset).isEnabled())
      );
    },
    15_000,
    "Cancelled startup picker did not release recovery controls",
  );
  const cancelled = await bootstrap();
  assert.deepEqual(cancelled, before);
  assert.deepEqual(await readFile(fixture.preferences), preferencesBefore);
  assert.deepEqual(await readFile(fixture.invalidRoot), invalidBefore);
  await captureScreenshot("startup-library-cancelled");

  await browser.findElement(choose).click();
  const picker = await chooseOwnedLibrary(
    "Choose Portcove library",
    "Select Folder",
    "Folder",
    "startup-picker-select",
    undefined,
    fixture.selectedRoot,
  );
  assert.equal(canonicalPath(picker.selected_directory), canonicalPath(fixture.selectedRoot));
  await browser.wait(async () => (await bootstrap()).ready, 15_000);
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  const selected = await bootstrap();
  assert.ok(selected.generation > before.generation);
  const verifyWorkspace = async (status) => {
    assert.equal(status.ready, true);
    assert.equal(canonicalPath(status.library_root), canonicalPath(fixture.selectedRoot));
    assert.equal(status.selection.source, "saved");
    const identity = await invoke("get_library_identity", { generation: status.generation });
    const workspace = await invoke("get_workspace_snapshot", { generation: status.generation });
    const statuses = await invoke("get_statuses");
    for (const result of [identity, workspace, statuses])
      assert.equal(result.ok, true, JSON.stringify(result));
    return { identity: identity.value, workspace: workspace.value, statuses: statuses.value };
  };
  const selectedWorkspace = await verifyWorkspace(selected);
  const preferencesSelected = await readFile(fixture.preferences);
  assert.equal(
    canonicalPath(JSON.parse(preferencesSelected).library_root),
    canonicalPath(fixture.selectedRoot),
  );
  await captureScreenshot("startup-library-recovered");
  browser = await restart("startup-library-saved-choice");
  const restarted = await bootstrap();
  const restartedWorkspace = await verifyWorkspace(restarted);
  assert.deepEqual(restartedWorkspace.identity, selectedWorkspace.identity);
  assert.deepEqual(await readFile(fixture.preferences), preferencesSelected);
  assert.deepEqual(await readFile(fixture.invalidRoot), invalidBefore);
  // Host generations restart independently; only the in-process selection above
  // requires a higher generation. This reconnect uses its own generation-bound IPC.
  await captureScreenshot("startup-library-saved-restart");
  const evidence = path.join(output, "startup-library-recovery.json");
  await writeFile(
    evidence,
    `${JSON.stringify(
      {
        before,
        cancelled,
        selected,
        restarted,
        selectedWorkspace,
        restartedWorkspace,
        invalid_target_preserved: true,
        cancelled_preferences_preserved: true,
        saved_preferences_preserved_after_restart: true,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  artifacts.push(evidence);
}
