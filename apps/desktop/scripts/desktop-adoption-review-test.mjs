// Real adoption of a harmless owned executable; no upstream game or source acquisition.
import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import { By, Key, until } from "selenium-webdriver";
import {
  reviewControls,
  assertCompactReview,
  captureAccessibilityReport,
} from "./desktop-review-controls.mjs";

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
}) {
  await scenario("native-reviewed-existing-install-copy", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const port = command(["catalog", "show", "zelda64-recomp"]);
    const original = path.join(output, "owned-adoption-review");
    await mkdir(original);
    await copyFile(tool, path.join(original, port.executable_hints[host][0]));
    const otherPort = command(["catalog", "show", "opengoal-jak1"]);
    const ambiguous = path.join(output, "owned-adoption-ambiguous");
    await mkdir(ambiguous);
    await copyFile(tool, path.join(ambiguous, port.executable_hints[host][0]));
    await copyFile(tool, path.join(ambiguous, otherPort.executable_hints[host][0]));
    const incoming = path.join(original, "general.json");
    await writeFile(incoming, "incoming settings", { flag: "wx" });
    const previous = command(["adopt", original, "--port", port.id, "--yes"]);
    const backup = command(["backup", "create", port.id]);
    await writeFile(path.join(original, "owned-next-version.bin"), "new application version", {
      flag: "wx",
    });
    const paths = command(["paths", port.id]);
    const current = path.join(paths.user_data_root, "general.json");
    const unrelated = path.join(paths.user_data_root, "unrelated-save.bin");
    await writeFile(current, "current settings");
    await writeFile(unrelated, "keep unrelated data", { flag: "wx" });
    const preserved = await Promise.all(
      [
        incoming,
        unrelated,
        path.join(backup.path, "data/general.json"),
        path.join(previous.path, port.executable_hints[host][0]),
      ].map(fileIdentity),
    );
    const otherInstall = command(["status", "opengoal-jak1"]).active;
    const sources = command(["source", "list"]);
    await browser.manage().window().setRect({ width: 1440, height: 1000 });
    await browser.navigate().refresh();
    const { button, click } = reviewControls(browser);
    const dialog = By.css('[aria-labelledby="adopt-title"]');
    const trigger = button("Copy existing installation");
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
        return await browser.executeScript(
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
      [port.executable_hints[host][0], otherPort.executable_hints[host][0]].map((name) =>
        fileIdentity(path.join(ambiguous, name)),
      ),
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
        browser.executeScript("return document.activeElement === arguments[0]", selectedIdentity),
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
    assert.equal(command(["status", port.id]).active.id, previous.id);
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
      "Matching saved files are replaced",
      "No automatic safety backup",
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
      "No unsupported items were found in the reviewed copy plan.",
      "adoption-native-before-consent",
    );
    assert.equal(await readFile(current, "utf8"), "current settings");
    assert.equal(command(["status", port.id]).active.id, previous.id);
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
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const reviewed = await invoke("preview_adoption", {
      path: original,
      portId: port.id,
      generation,
    });
    assert.equal(reviewed.ok, true);
    const stale = await invoke("adopt_port", {
      path: original,
      portId: port.id,
      generation: generation + 1,
      planSha256: reviewed.value.plan_sha256,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
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
      await browser.executeScript(() => {
        const plan = document.querySelector(".adoption-review");
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
    const adopted = command(["status", port.id]).active;
    assert.notEqual(adopted.id, previous.id);
    assert.equal(
      await realpath(path.dirname(adopted.path)),
      await realpath(reviewed.value.destination.output_location.effective_output_directory),
    );
    assert.equal(await readFile(current, "utf8"), "incoming settings");
    assert.deepEqual(
      await Promise.all(preserved.map((item) => fileIdentity(item.path))),
      preserved,
    );
    assert.deepEqual(command(["source", "list"]), sources);
    assert.equal(command(["status", "opengoal-jak1"]).active.id, otherInstall.id);
    assert.deepEqual(
      command(["backup", "list", port.id]).backups.map((item) => item.id),
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
          reviewed_destination: reviewed.value.destination,
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
