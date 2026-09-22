// Actual-Tauri presentation proof for catalog trust and update management.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mjs";

export async function catalogUpdateScenario({ browser, invoke, scenario, output, artifacts }) {
  await scenario("native-catalog-update-dialog", async () => {
    const before = await invoke("get_catalog_status");
    assert.equal(before.ok, true);
    const { button, click } = reviewControls(browser);

    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    const trigger = await browser.wait(
      until.elementLocated(button("Manage catalog updates")),
      15_000,
    );
    await click(button("Manage catalog updates"));
    const dialog = By.css('[aria-labelledby="catalog-update-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.wait(
      until.elementLocated(By.xpath('//h3[normalize-space(.)="Trusted publishers"]')),
      15_000,
    );

    const publicKeyField = await browser.findElement(By.id("catalog-public-key"));
    const locationField = await browser.findElement(By.id("catalog-update-location"));
    const fieldPresentation = await browser.executeScript(
      `const fields = arguments;
       return [...fields].map((field) => {
         const style = getComputedStyle(field);
         return {
           width: style.width,
           paddingLeft: style.paddingLeft,
           borderStyle: style.borderStyle,
           borderWidth: style.borderWidth,
           backgroundColor: style.backgroundColor,
           color: style.color,
         };
       });`,
      publicKeyField,
      locationField,
    );
    for (const presentation of fieldPresentation) {
      assert.ok(parseFloat(presentation.width) >= 200, JSON.stringify(presentation));
      assert.ok(parseFloat(presentation.paddingLeft) >= 10, JSON.stringify(presentation));
      assert.equal(presentation.borderStyle, "solid");
      assert.ok(parseFloat(presentation.borderWidth) >= 1, JSON.stringify(presentation));
      assert.notEqual(presentation.backgroundColor, "rgba(0, 0, 0, 0)");
    }

    const close = await browser.findElement(button("Close"));
    const actionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Trust publisher")),
      close,
    );
    const selectTrigger = await browser.findElement(By.id("catalog-update-source"));
    await selectTrigger.sendKeys(Key.ENTER);
    const openSelect = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(until.elementLocated(openSelect), 5_000);
    await selectTrigger.sendKeys(Key.ESCAPE);
    await browser.wait(
      async () => (await browser.findElements(openSelect)).length === 0,
      5_000,
      "First Escape did not close only the nested catalog source select",
    );
    assert.equal((await browser.findElements(dialog)).length, 1);
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, selectTrigger),
      5_000,
      "Catalog source trigger did not regain focus after nested Escape",
    );

    await assertCompactReview(browser, '[aria-labelledby="catalog-update-title"]');
    const accessibility = path.join(output, "catalog-update-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    const screenshot = path.join(output, "native-catalog-update-dialog.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);

    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, trigger),
      5_000,
      "Catalog update trigger did not regain focus after Escape",
    );
    const after = await invoke("get_catalog_status");
    assert.deepEqual(
      after,
      before,
      "presentation-only dialog proof must not change catalog trust or state",
    );

    const report = path.join(output, "catalog-update-dialog-result.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          state_sha256: before.value.state_sha256,
          catalog_origin: before.value.provenance.origin,
          trusted_publishers: before.value.trusted_keys.length,
          catalog_state_unchanged: true,
          nested_select_escape_preserved_dialog: true,
          dialog_escape_restored_focus: true,
          action_styles: actionStyles,
          field_presentation: fieldPresentation,
          evidence:
            "actual Tauri presentation and interaction only; no publisher trust, update plan/application, rollback, publication, or network claim",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
