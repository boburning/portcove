// Actual-Tauri proof for the paired one-off intake and explicit-folder source journeys.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mjs";

export async function sourceDialogScenario({ browser, scenario, output, artifacts, command }) {
  await scenario("native-source-intake-and-discovery-dialogs", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const profileLabel = port.presentation.source_requirements[0].label;
    const { button, click } = reviewControls(browser);

    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await click(By.xpath('//nav//button[contains(., "Port catalog")]'));
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      Key.BACK_SPACE,
    );
    await click(
      By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="All"]'),
    );
    await click(By.css(`[data-detail-origin="catalog:card:${port.id}"]`));
    await click(By.css(".requirements-disclosure > .requirements-summary"));
    const intakeTrigger = await browser.findElement(button("Check original game files"));
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', intakeTrigger);
    await click(button("Check original game files"));
    const intakeDialog = By.css('[aria-labelledby="source-intake-title"]');
    await browser.wait(until.elementLocated(intakeDialog), 15_000);
    assert.ok(
      (await browser.findElement(intakeDialog).getText()).includes("Checking won't change them."),
    );
    const intakeStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Choose game files to check")),
      await browser.findElement(button("Close")),
    );
    await assertCompactReview(browser, '[aria-labelledby="source-intake-title"]');
    const intakeAccessibility = path.join(output, "source-intake-accessibility.json");
    await captureAccessibilityReport(browser, intakeAccessibility, artifacts);
    const intakeScreenshot = path.join(output, "native-source-intake-dialog.png");
    await writeFile(intakeScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(intakeScreenshot);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(intakeDialog)).length === 0, 5_000);
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, intakeTrigger),
      5_000,
      "Source intake trigger did not regain focus after Escape",
    );

    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    const discoveryTrigger = await browser.wait(
      until.elementLocated(button("Choose game files")),
      15_000,
    );
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "center" });',
      discoveryTrigger,
    );
    await click(button("Choose game files"));
    const discoveryDialog = By.css('[aria-labelledby="source-discovery-title"]');
    await browser.wait(until.elementLocated(discoveryDialog), 15_000);
    assert.ok(
      (await browser.findElement(discoveryDialog).getText()).includes(
        "Source Inbox is Portcove's game-file folder.",
      ),
    );
    const searchField = await browser.findElement(By.id("source-search-root"));
    const searchLabel = await browser.findElement(By.css('label[for="source-search-root"]'));
    const fieldPresentation = await browser.executeScript(
      `const field = arguments[0];
       const label = arguments[1];
       const dialog = arguments[2];
       const fieldStyle = getComputedStyle(field);
       const labelStyle = getComputedStyle(label);
       const dialogStyle = getComputedStyle(dialog);
       return {
         width: fieldStyle.width,
         paddingLeft: fieldStyle.paddingLeft,
         borderStyle: fieldStyle.borderStyle,
         borderWidth: fieldStyle.borderWidth,
         backgroundColor: fieldStyle.backgroundColor,
         dialogBackgroundColor: dialogStyle.backgroundColor,
         color: fieldStyle.color,
         labelColor: labelStyle.color,
         labelFontWeight: labelStyle.fontWeight,
       };`,
      searchField,
      searchLabel,
      await browser.findElement(discoveryDialog),
    );
    assert.ok(parseFloat(fieldPresentation.width) >= 200, JSON.stringify(fieldPresentation));
    assert.ok(parseFloat(fieldPresentation.paddingLeft) >= 10, JSON.stringify(fieldPresentation));
    assert.equal(fieldPresentation.borderStyle, "solid");
    assert.ok(parseFloat(fieldPresentation.borderWidth) >= 1, JSON.stringify(fieldPresentation));
    assert.notEqual(fieldPresentation.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.notEqual(fieldPresentation.backgroundColor, fieldPresentation.dialogBackgroundColor);
    assert.ok(Number(fieldPresentation.labelFontWeight) >= 700, JSON.stringify(fieldPresentation));
    const selectTrigger = await browser.findElement(
      By.xpath('//button[contains(., "Required game files")]'),
    );
    await selectTrigger.sendKeys(Key.ENTER);
    const openSelect = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(until.elementLocated(openSelect), 5_000);
    await selectTrigger.sendKeys(Key.ESCAPE);
    await browser.wait(
      async () => (await browser.findElements(openSelect)).length === 0,
      5_000,
      "First Escape did not close only the nested source-profile select",
    );
    assert.equal((await browser.findElements(discoveryDialog)).length, 1);
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, selectTrigger),
      5_000,
      "Source profile trigger did not regain focus after nested Escape",
    );
    await selectTrigger.sendKeys(Key.ENTER);
    await click(
      By.xpath(`//*[@role="option" and normalize-space(.)=${JSON.stringify(profileLabel)}]`),
    );

    const searchRoot = path.join(output, "owned-source-search");
    await mkdir(searchRoot, { recursive: true });
    await writeFile(path.join(searchRoot, "not-a-match.iso"), "owned unmatched source fixture", {
      flag: "wx",
    });
    await browser.findElement(By.id("source-search-root")).sendKeys(searchRoot);
    const searchStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Search this folder")),
      await browser.findElement(button("Close")),
    );
    await click(button("Search this folder"));
    await browser.wait(
      until.elementLocated(By.xpath('//p[contains(., "Found no exact matches.")]')),
      15_000,
    );
    await assertCompactReview(browser, '[aria-labelledby="source-discovery-title"]');
    const discoveryAccessibility = path.join(output, "source-discovery-accessibility.json");
    await captureAccessibilityReport(browser, discoveryAccessibility, artifacts);
    const discoveryScreenshot = path.join(output, "native-source-discovery-dialog.png");
    await writeFile(discoveryScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(discoveryScreenshot);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(discoveryDialog)).length === 0,
      5_000,
    );
    await browser.wait(
      () =>
        browser.executeScript((element) => document.activeElement === element, discoveryTrigger),
      5_000,
      "Source discovery trigger did not regain focus after Escape",
    );

    const activities = command(["activity"]).records;
    const sourceDiscovery = activities.find(
      (item) =>
        item.operation === "discover_sources" &&
        item.target_kind === "library" &&
        item.status === "succeeded",
    );
    assert.ok(sourceDiscovery, "Owned discovery search must record a library activity");
    const sourceRegistration = activities.find(
      (item) =>
        item.operation === "register_source" &&
        item.target_kind === "source" &&
        item.target_id === port.source_profile &&
        item.status === "succeeded",
    );
    assert.ok(sourceRegistration, "Owned setup must record this source registration");
    await click(By.xpath('//nav//button[contains(., "Game updates")]'));
    const sourceActivity = By.xpath(
      `//div[contains(@class, "activity-row") and .//strong[normalize-space()="Game-file location update"]]//button[@aria-label=${JSON.stringify(`Open Game Files settings for ${profileLabel}`)}]`,
    );
    await browser.wait(until.elementLocated(sourceActivity), 15_000);
    await click(sourceActivity);
    await browser.wait(until.elementLocated(By.id("settings-game-files-heading")), 5_000);
    await browser.wait(
      () =>
        browser.executeScript(
          () =>
            document.activeElement?.closest('[data-settings-group="game-files"]') !== null &&
            document.activeElement?.textContent?.includes("Verify sources"),
        ),
      5_000,
      "Source activity did not focus the Game Files verification control",
    );
    await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
    await browser.wait(
      () =>
        browser.executeScript(
          () => document.activeElement?.closest('[data-settings-group="game-files"]') !== null,
        ),
      5_000,
      "Directional navigation left Game Files settings",
    );
    const settingsScreenshot = path.join(output, "native-source-activity-settings.png");
    await writeFile(settingsScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(settingsScreenshot);

    await click(By.xpath('//nav//button[contains(., "Game updates")]'));
    const discoveryActivity = By.xpath(
      '//div[contains(@class, "activity-row") and .//strong[normalize-space()="Game-file search"]]//button[@aria-label="Open Game Files settings for Portcove library"]',
    );
    await browser.wait(until.elementLocated(discoveryActivity), 15_000);
    await click(discoveryActivity);
    await browser.wait(
      () =>
        browser.executeScript(
          () =>
            document.activeElement?.closest('[data-settings-group="game-files"]') !== null &&
            document.activeElement?.textContent?.includes("Verify sources"),
        ),
      5_000,
      "Library discovery activity did not focus the Game Files verification control",
    );
    const discoverySettingsScreenshot = path.join(output, "native-discovery-activity-settings.png");
    await writeFile(discoverySettingsScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(discoverySettingsScreenshot);

    const report = path.join(output, "source-dialog-result.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          port_id: port.id,
          profile_id: port.source_profile,
          profile_label: profileLabel,
          search_root: searchRoot,
          result: "no exact matches",
          nested_select_escape_preserved_dialog: true,
          intake_escape_restored_focus: true,
          discovery_escape_restored_focus: true,
          source_activity_opened_game_files_settings: true,
          source_activity_settings_control_focused: true,
          library_discovery_activity_opened_game_files_settings: true,
          library_discovery_settings_control_focused: true,
          directional_navigation_stayed_in_game_files: true,
          intake_action_styles: intakeStyles,
          search_action_styles: searchStyles,
          field_presentation: fieldPresentation,
          evidence:
            "owned unmatched file through the actual Tauri source-discovery adapter; no source registration, mutation, gameplay, or physical-storage claim",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
