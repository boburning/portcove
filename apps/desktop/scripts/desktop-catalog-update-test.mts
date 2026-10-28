import { readReviewFieldStyles } from "./desktop-review-presentation.mts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { transportValue } from "./transport-values.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
interface CatalogContext extends Omit<ScenarioContext, "browser"> {
  browser: WebDriver | LinuxInspectorProtocol | undefined;
  invoke: ScenarioInvoke;
}
import { executeBrowserScript } from "./browser-script.mts";
// Actual-Tauri presentation proof for catalog trust and update management.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until, WebDriver } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mts";

export async function catalogUpdateScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
}: CatalogContext) {
  await scenario("native-catalog-update-dialog", async () => {
    assert.ok(
      browser instanceof WebDriver,
      "Selected catalog scenario requires its connected WebDriver transport",
    );
    const before = await invoke("get_catalog_status");
    assert.ok(isRecord(before));
    assert.equal(before.ok, true);
    const catalogStatus = transportValue("catalog_status", before.value);
    const { button, click } = reviewControls(browser);

    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(
      By.css('nav[aria-label="Settings categories"] button[aria-controls="settings-advanced"]'),
    );
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
    const fieldPresentation = await readReviewFieldStyles(browser, publicKeyField, locationField);
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
      () =>
        executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          selectTrigger,
        ),
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
      () => executeBrowserScript(browser, (element) => document.activeElement === element, trigger),
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
          state_sha256: catalogStatus.state_sha256,
          catalog_origin: catalogStatus.provenance.origin,
          trusted_publishers: catalogStatus.trusted_keys.length,
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
