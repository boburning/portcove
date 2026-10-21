import {
  fixtureSuccess as success,
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
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
import type { Platform, PortDefinition } from "../src/transport-types.generated.d.ts";
interface AdoptionContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  library: string;
  command: FixtureCommand;
  tool: string;
  host: Platform;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
import { executeBrowserScript } from "./browser-script.mts";
// Real adoption of a harmless owned executable; no upstream game or source acquisition.
import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { By, Key, until } from "selenium-webdriver";
import { installedPreservationWitness } from "./desktop-scenario-state.mts";
import {
  reviewControls,
  assertCompactReview,
  captureAccessibilityReport,
} from "./desktop-review-controls.mts";

export async function adoptionReviewScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  tool,
  host,
  confirmNative,
}: AdoptionContext) {
  const portFor = (id: string) => transportValue("port", command(["catalog", "show", id]));
  const hint = (port: PortDefinition) => required(port.executable_hints[host]?.[0]);
  const status = (id: string) => transportValue("status", command(["status", id]));
  await scenario("native-reviewed-existing-install-copy", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const port = portFor("zelda64-recomp");
    const original = path.join(output, "owned-adoption-review");
    await mkdir(original);
    await copyFile(tool, path.join(original, hint(port)));
    const otherPort = portFor("opengoal-jak1");
    const ambiguous = path.join(output, "owned-adoption-ambiguous");
    await mkdir(ambiguous);
    await copyFile(tool, path.join(ambiguous, hint(port)));
    await copyFile(tool, path.join(ambiguous, hint(otherPort)));
    const incoming = path.join(original, "general.json");
    await writeFile(incoming, "incoming settings", { flag: "wx" });
    const previous = installObservation(command(["adopt", original, "--port", port.id, "--yes"]));
    const backup = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(path.join(original, "owned-next-version.bin"), "new application version", {
      flag: "wx",
    });
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const current = path.join(paths.user_data_root, "general.json");
    const unrelated = path.join(paths.user_data_root, "unrelated-save.bin");
    await writeFile(current, "current settings");
    await writeFile(unrelated, "keep unrelated data", { flag: "wx" });
    const preserved = await Promise.all(
      [
        incoming,
        unrelated,
        path.join(backup.path, "data/general.json"),
        path.join(previous.path, hint(port)),
      ].map((file) => fileIdentity(file)),
    );
    const { portId: otherInstallPortId, install: otherInstall } = installedPreservationWitness(
      (args) => transportValue("status", command(args)),
    );
    const sources = transportValues("source", command(["source", "list"]));
    await browser.manage().window().setRect({ width: 1440, height: 1000 });
    await browser.navigate().refresh();
    const { button, click } = reviewControls(browser);
    const dialog = By.css('[aria-labelledby="adopt-title"]');
    await click(button("Add games"));
    await click(By.css('button[aria-label="Use an existing installation"]'));
    const trigger = button("Copy an existing installation");
    await click(trigger);
    await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "existing-install Dialog did not close after Escape",
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
      "existing-install trigger did not regain focus after Escape",
    );
    await click(trigger);
    const ambiguousInput = await browser.findElement(By.id("adopt-path"));
    await ambiguousInput.clear();
    await ambiguousInput.sendKeys(ambiguous);
    await click(button("Review copy plan"));
    const chosenPort = button(`Review ${port.name} — Catalog ID: ${port.id}`);
    const otherChoice = button(`Review ${otherPort.name} — Catalog ID: ${otherPort.id}`);
    await browser.wait(until.elementLocated(chosenPort), 15_000);
    await browser.wait(until.elementLocated(otherChoice), 15_000);
    assert.equal(
      await browser.findElement(button("Continue to copy confirmation")).isEnabled(),
      false,
      "Ambiguous detection must not authorize a copy",
    );
    const ambiguousFiles = await Promise.all(
      [hint(port), hint(otherPort)].map((name: string) => fileIdentity(path.join(ambiguous, name))),
    );
    const ambiguousReport = path.join(output, "adoption-ambiguous-accessibility.json");
    await captureAccessibilityReport(browser, ambiguousReport, artifacts);
    await assertCompactReview(browser, '[aria-labelledby="adopt-title"]');
    const ambiguousScreenshot = path.join(output, "native-adoption-ambiguous-choice.png");
    await writeFile(ambiguousScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(ambiguousScreenshot);
    await click(chosenPort);
    const selectedContinue = await browser.wait(
      until.elementLocated(button("Continue to copy confirmation")),
      15_000,
    );
    await browser.wait(until.elementIsEnabled(selectedContinue), 15_000);
    const selectedIdentity = await browser.findElement(By.id("adopt-port-identity"));
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0]",
          selectedIdentity,
        ),
      5_000,
      "Selected copy plan did not receive focus after candidate review",
    );
    const selectedText = await browser.findElement(dialog).getText();
    assert.ok(selectedText.includes(port.name));
    assert.ok(selectedText.includes(`Catalog ID: ${port.id}`));
    assert.ok(selectedText.includes(paths.user_data_root));
    await click(button("Continue to copy confirmation"));
    await confirmNative(
      "Confirm existing installation copy",
      "__observe__",
      `catalog port ${port.id}?`,
      "adoption-ambiguous-selected-before-consent",
    );
    await confirmNative(
      "Confirm existing installation copy",
      "Cancel",
      ambiguous,
      "adoption-ambiguous-cancelled",
    );
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    assert.deepEqual(
      await Promise.all(ambiguousFiles.map((item) => fileIdentity(item.path))),
      ambiguousFiles,
    );
    assert.equal(required(status(port.id).active).id, previous.id);
    await browser.manage().window().setRect({ width: 1440, height: 1000 });
    const open = async () => {
      await click(trigger);
      const input = await browser.findElement(By.id("adopt-path"));
      await input.clear();
      await input.sendKeys(original);
      await click(button("Review copy plan"));
      const continueButton = await browser.wait(
        until.elementLocated(button("Continue to copy confirmation")),
        15_000,
      );
      await browser.wait(until.elementIsEnabled(continueButton), 15_000);
    };
    await open();
    let text = await browser.findElement(dialog).getText();
    for (const expected of [
      "Add an existing installation to Portcove",
      port.name,
      `Catalog ID: ${port.id}`,
      original,
      paths.user_data_root,
      previous.path,
      "Matching saved files in Portcove will be replaced",
      "Portcove does not create a backup before this copy",
      "Affected saved-data paths from the original folder",
      "general.json",
      "cannot cancel",
    ])
      assert.ok(text.includes(expected), expected);
    await click(button("Cancel"));
    assert.equal(await readFile(current, "utf8"), "current settings");
    await open();
    await click(button("Continue to copy confirmation"));
    await confirmNative(
      "Confirm existing installation copy",
      "__observe__",
      "Portcove does not create a backup before this copy.",
      "adoption-native-before-consent",
    );
    assert.equal(await readFile(current, "utf8"), "current settings");
    assert.equal(required(status(port.id).active).id, previous.id);
    await confirmNative(
      "Confirm existing installation copy",
      "Cancel",
      paths.user_data_root,
      "adoption-native-cancelled",
    );
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    await open();
    await writeFile(current, "changed after review");
    await click(button("Continue to copy confirmation"));
    const reset = await browser.wait(until.elementLocated(button("Review copy plan")), 15_000);
    await browser.wait(until.elementIsEnabled(reset), 15_000);
    assert.equal(await readFile(current, "utf8"), "changed after review");
    const generation = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    ).generation;
    const reviewed = object(
      await invoke("preview_adoption", {
        path: original,
        portId: port.id,
        generation,
      }),
    );
    assert.equal(reviewed.ok, true);
    const preview = transportValue("adoption_preview", reviewed.value);
    const stale = object(
      await invoke("adopt_port", {
        path: original,
        portId: port.id,
        generation: generation + 1,
        planSha256: preview.plan_sha256,
      }),
    );
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    await click(button("Review copy plan"));
    await browser.wait(until.elementLocated(button("Continue to copy confirmation")), 15_000);
    const report = path.join(output, "adoption-review-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const normal = path.join(output, "native-adoption-review.png");
    await writeFile(normal, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(normal);
    await assertCompactReview(browser, '[aria-labelledby="adopt-title"]');
    assert.equal(
      await executeBrowserScript(browser, () => {
        const plan = document.querySelector(".adoption-review");
        if (!plan) throw new Error("required adoption review is missing");
        return plan.scrollHeight > plan.clientHeight + 1;
      }),
      false,
      "The copy plan uses the dialog scroll instead of nesting a second scrolling region",
    );
    const screenshot = path.join(output, "native-adoption-review-compact.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await click(button("Continue to copy confirmation"));
    await confirmNative(
      "Confirm existing installation copy",
      "Copy into Portcove",
      paths.user_data_root,
      "adoption-native-confirmed",
    );
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    const adopted = required(status(port.id).active);
    assert.notEqual(adopted.id, previous.id);
    assert.equal(
      await realpath(path.dirname(adopted.path)),
      await realpath(required(preview.destination).output_location.effective_output_directory),
    );
    assert.equal(await readFile(current, "utf8"), "incoming settings");
    assert.deepEqual(
      await Promise.all(preserved.map((item) => fileIdentity(item.path))),
      preserved,
    );
    assert.deepEqual(transportValues("source", command(["source", "list"])), sources);
    assert.equal(required(status(otherInstallPortId).active).id, otherInstall.id);
    assert.deepEqual(
      transportValue("backup_inventory", command(["backup", "list", port.id])).backups.map(
        (item) => item.id,
      ),
      [backup.id],
    );
    const result = path.join(output, "adoption-review-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          preserved_files: preserved,
          previous_install: previous.id,
          adopted_install: adopted,
          reviewed_destination: preview.destination,
          dismissal_and_native_cancel_preserved_data: true,
          changed_saved_data_rejected: true,
          stale_generation_rejected: true,
          copied_saved_file: await fileIdentity(current),
          preserved_other_install: otherInstall.id,
          preserved_sources: sources,
          preserved_backup: backup.id,
          evidence:
            "native owned-file copy review and saved-data merge; no gameplay or physical interruption claim",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(result);
  });
}
