import { fixtureSuccess as success, fixtureObject as object } from "./desktop-scenario-state.mts";
import type { InstallRecord } from "../src/transport-types.generated.d.ts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { transportValue, transportValues } from "./transport-values.mts";
function installObservation(value: unknown) {
  const item = object(value);
  assert.ok(typeof item.id === "string" && typeof item.path === "string");
  const checked: Pick<InstallRecord, "id" | "path"> = { id: item.id, path: item.path };
  return { ...item, ...checked };
}
import type { PortDefinition } from "../src/transport-types.generated.d.ts";
interface RemovalContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  library: string;
  command: FixtureCommand;
  open: (port: PortDefinition) => Promise<unknown>;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
import { executeBrowserScript } from "./browser-script.mts";
// Removal is confined to real managed versions in the harness's new owned library.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { By, Key, until } from "selenium-webdriver";
import { installedPreservationWitness } from "./desktop-scenario-state.mts";
import {
  revealDetailSection,
  assertDestructiveReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mts";

export async function removalReviewScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  open,
  confirmNative,
}: RemovalContext) {
  await scenario("native-reviewed-installed-game-removal", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak3"]));
    const original = path.join(output, `owned-${port.id}`);
    // The backup prerequisite intentionally finishes with retained saves and no
    // installed game. Restore this scenario's owned installation through Core.
    if (transportValue("status", command(["status", port.id])).active === null) {
      installObservation(command(["adopt", original, "--port", port.id, "--yes"]));
    }
    assert.ok(transportValue("status", command(["status", port.id])).active);
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const save = path.join(paths.user_data_root, "owned-review-save.bin");
    const { portId: otherInstallPortId, install: otherInstall } = installedPreservationWitness(
      (args) => transportValue("status", command(args)),
    );
    const sources = transportValues("source", command(["source", "list"]));
    const snapshots = transportValue("backup_inventory", command(["backup", "list", port.id]));
    const beforeSave = await readFile(save);
    const preservedFiles = await Promise.all(
      [
        save,
        path.join(output, `${port.id}.iso`),
        ...snapshots.backups.map((item) => path.join(item.path, "data/owned-review-save.bin")),
      ].map((file) => fileIdentity(file)),
    );
    await open(port);
    await revealDetailSection(browser, "Manage");
    const { button, click } = reviewControls(browser);
    const dialog = By.css('[aria-labelledby="removal-review-title"]');
    const trigger = button(`Uninstall ${port.name}`);
    assert.equal(
      await browser.findElement(trigger).isDisplayed(),
      true,
      "Manage must expose the real reviewed uninstall control",
    );
    const review = async () => {
      await click(trigger);
      await browser.wait(until.elementLocated(button("Uninstall all versions")), 15_000);
    };
    const generation = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    ).generation;
    const initial = object(
      await invoke("preview_removal", {
        portId: port.id,
        generation,
      }),
    );
    assert.equal(initial.ok, true);
    const initialPreview = transportValue("port_removal_preview", initial.value);
    await review();
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "installed-game removal Dialog did not close after Escape",
    );
    await browser.wait(
      async () => {
        const candidate = await browser.findElement(trigger);
        return await executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0];",
          candidate,
        );
      },
      5_000,
      "installed-game removal trigger did not regain focus after Escape",
    );
    await review();
    const destructiveStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(button("Uninstall all versions")),
      await browser.findElement(button("Cancel")),
    );
    for (const affected of initialPreview.managed_paths)
      assert.ok((await browser.findElement(dialog).getText()).includes(affected));
    await click(button("Cancel"));
    await assertManagedFolders(initialPreview.managed_paths);
    assert.deepEqual(await readFile(save), beforeSave);
    await review();
    await click(button("Uninstall all versions"));
    const initialConsent = await confirmNative(
      "Confirm uninstall",
      "__observe__",
      paths.user_data_root,
      "removal-native-before-consent",
    );
    const initialConsentText = object(initialConsent).text;
    assert.ok(typeof initialConsentText === "string");
    for (const expected of [port.name, port.id, ...initialPreview.managed_paths])
      assert.ok(initialConsentText.includes(expected), `native consent omitted ${expected}`);
    assert.ok(initialConsentText.includes("Backups and original game files will be kept"));
    assert.ok(initialConsentText.includes("saved release-channel and update-policy settings"));
    assert.ok(!initialConsentText.includes("review you just read"));
    await assertManagedFolders(initialPreview.managed_paths);
    await confirmNative(
      "Confirm uninstall",
      "Cancel",
      paths.user_data_root,
      "removal-native-cancelled",
    );
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    await assertManagedFolders(initialPreview.managed_paths);
    await review();
    // A real new adoption changes the reviewed inventory; the old review must fail.
    await writeFile(path.join(original, "owned-new-version.bin"), "second reviewed version", {
      flag: "wx",
    });
    const added = installObservation(command(["adopt", original, "--port", port.id, "--yes"]));
    assert.ok(!initialPreview.managed_paths.includes(added.path));
    await click(button("Uninstall all versions"));
    await browser.wait(until.elementLocated(button("Review removal again")), 15_000);
    const current = object(
      await invoke("preview_removal", {
        portId: port.id,
        generation,
      }),
    );
    assert.equal(current.ok, true);
    const currentPreview = transportValue("port_removal_preview", current.value);
    assert.equal(currentPreview.managed_paths.length, initialPreview.managed_paths.length + 1);
    await assertManagedFolders(currentPreview.managed_paths);
    const stale = object(
      await invoke("remove_port", {
        portId: port.id,
        generation: generation + 1,
        expectedPreview: currentPreview.preview_sha256,
      }),
    );
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    await click(button("Review removal again"));
    await browser.wait(until.elementLocated(button("Uninstall all versions")), 15_000);
    const text = await browser.findElement(dialog).getText();
    for (const affected of [...currentPreview.managed_paths, paths.user_data_root])
      assert.ok(text.includes(affected));
    assert.ok(
      text.includes("settings will also be removed") &&
        text.includes("interrupted deletion may finish"),
    );
    const originalFiles = await readdir(original, {
      recursive: true,
      withFileTypes: true,
    });
    preservedFiles.push(
      ...(await Promise.all(
        originalFiles
          .filter((item) => item.isFile())
          .map((item) => fileIdentity(path.join(item.parentPath, item.name))),
      )),
    );
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "start" });',
      await browser.findElement(dialog),
    );
    const accessibilityPath = path.join(output, "removal-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibilityPath, artifacts);
    const screenshot = path.join(output, "native-installed-game-removal-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await click(button("Uninstall all versions"));
    const finalConsent = await confirmNative(
      "Confirm uninstall",
      "Uninstall port",
      paths.user_data_root,
      "removal-native-confirmed",
    );
    const finalConsentText = object(finalConsent).text;
    assert.ok(typeof finalConsentText === "string");
    for (const expected of [port.name, port.id, ...currentPreview.managed_paths])
      assert.ok(finalConsentText.includes(expected), `native consent omitted ${expected}`);
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    for (const affected of currentPreview.managed_paths)
      await assert.rejects(stat(affected), { code: "ENOENT" });
    assert.equal(transportValue("status", command(["status", port.id])).active, null);
    assert.deepEqual(await readFile(save), beforeSave);
    assert.deepEqual(
      transportValue("backup_inventory", command(["backup", "list", port.id])),
      snapshots,
    );
    assert.deepEqual(transportValues("source", command(["source", "list"])), sources);
    assert.deepEqual(
      await Promise.all(preservedFiles.map((item) => fileIdentity(item.path))),
      preservedFiles,
    );
    assert.deepEqual(
      transportValue("status", command(["status", otherInstallPortId])).active,
      otherInstall,
    );
    const report = path.join(output, "removal-review-result.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          port_id: port.id,
          removed_paths: currentPreview.managed_paths,
          saved_data_path: paths.user_data_root,
          preserved_backup_ids: snapshots.backups.map((item) => item.id),
          preserved_files: preservedFiles,
          preserved_other_install: otherInstall.id,
          dismissal_preserved_files: true,
          changed_inventory_rejected: true,
          stale_generation_rejected: true,
          escape_dismissal_and_focus_restoration: true,
          destructive_action_styles: destructiveStyles,
          evidence:
            "owned fixture removal through native UI and core authorization; no physical interruption or gameplay claim",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}

async function assertManagedFolders(paths: readonly string[]) {
  for (const managed of paths) assert.ok((await stat(managed)).isDirectory(), managed);
}
