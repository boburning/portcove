// Controlled native consumer proof for one explicit Steam profile. No Steam client is launched.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import { assertSteamEntryContext } from "./desktop-context-contract.mjs";
import {
  assertDestructiveReviewAction,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mjs";

/**
 * @typedef {object} SteamEntryContext
 * @property {import("selenium-webdriver").WebDriver} browser
 * @property {(command: string, args?: object) => Promise<object>} invoke
 * @property {(name: string, run: () => Promise<void>) => Promise<void>} scenario
 * @property {string} output
 * @property {string[]} artifacts
 * @property {(args: string[]) => object} command
 * @property {(portId: string, mode: string) => Promise<{port: object, install: object}>} seed
 * @property {(port: object, waitForPreparation?: boolean) => Promise<void>} open
 * @property {Function} confirmNative
 */

/** @param {SteamEntryContext} context */
export async function steamEntryScenario(context) {
  assertSteamEntryContext(context);
  const { browser, invoke, scenario, output, artifacts, command, open, confirmNative } = context;
  await scenario("native-reviewed-steam-entry-add-and-remove", async () => {
    const { port } = await context.seed("opengoal-jak1", "success");
    assert.ok(command(["status", port.id]).active, "setup must leave the fixture port installed");
    const steamRoot = path.join(output, "controlled Steam ü");
    const steamUserId = "12345";
    const config = path.join(steamRoot, "userdata", steamUserId, "config");
    const shortcuts = path.join(config, "shortcuts.vdf");
    await mkdir(config, { recursive: true });
    await open(port, false);
    const { button, click } = reviewControls(browser);
    await click(By.css("summary.advanced-summary"));
    await click(button("Steam entry"));
    const dialog = By.css('[aria-labelledby="steam-entry-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "Steam entry dialog did not close after Escape",
    );
    const trigger = await browser.findElement(button("Steam entry"));
    await browser.wait(
      async () => browser.executeScript("return document.activeElement === arguments[0];", trigger),
      5_000,
      "Steam entry trigger did not regain focus after Escape",
    );
    await click(button("Steam entry"));
    await browser.wait(until.elementLocated(dialog), 15_000);
    const installationField = await browser.findElement(By.id("steam-installation"));
    const installationLabel = await browser.findElement(By.css('label[for="steam-installation"]'));
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
      installationField,
      installationLabel,
      await browser.findElement(dialog),
    );
    assert.ok(parseFloat(fieldPresentation.width) >= 200, JSON.stringify(fieldPresentation));
    assert.ok(parseFloat(fieldPresentation.paddingLeft) >= 10, JSON.stringify(fieldPresentation));
    assert.equal(fieldPresentation.borderStyle, "solid");
    assert.ok(parseFloat(fieldPresentation.borderWidth) >= 1, JSON.stringify(fieldPresentation));
    assert.notEqual(fieldPresentation.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.notEqual(fieldPresentation.backgroundColor, fieldPresentation.dialogBackgroundColor);
    assert.ok(Number(fieldPresentation.labelFontWeight) >= 700, JSON.stringify(fieldPresentation));
    await browser.findElement(By.id("steam-installation")).sendKeys(steamRoot);
    await browser.findElement(By.id("steam-profile")).sendKeys(steamUserId);
    const preview = await invoke("preview_steam_entry", {
      request: { portId: port.id, steamRoot, steamUserId, operation: "add_or_repair" },
      generation: (await invoke("get_bootstrap_status")).value.generation,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.value.plan_sha256.length, 64);
    assert.equal(preview.value.cli_sha256.length, 64);
    assert.equal(preview.value.cli_product_version, "0.1.0-alpha.2");
    assert.equal(preview.value.writes_required, true);
    await click(button("Review Add / Repair"));
    await browser.wait(until.elementLocated(button("Apply reviewed Add / Repair")), 15_000);
    const addActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Apply reviewed Add / Repair")),
      await browser.findElement(button("Review current state again")),
    );
    const reviewed = await browser.findElement(dialog).getText();
    assert.ok(reviewed.includes(shortcuts));
    assert.ok(reviewed.includes("add"));
    assert.ok(reviewed.includes("Steam appears closed"));
    const accessibility = path.join(output, "steam-entry-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    await click(button("Apply reviewed Add / Repair"));
    await confirmNative(
      "Confirm Steam entry change",
      "__observe__",
      shortcuts,
      "steam-entry-add-native-before-consent",
    );
    await confirmNative(
      "Confirm Steam entry change",
      "Cancel",
      shortcuts,
      "steam-entry-add-native-cancelled",
    );
    await browser.wait(until.elementLocated(button("Apply reviewed Add / Repair")), 15_000);
    await assert.rejects(stat(shortcuts), { code: "ENOENT" });
    await click(button("Apply reviewed Add / Repair"));
    await confirmNative(
      "Confirm Steam entry change",
      "Apply reviewed Add / Repair",
      shortcuts,
      "steam-entry-add-native-confirmed",
    );
    await browser.wait(
      until.elementLocated(By.xpath('//p[@role="status" and contains(., "was written")]')),
      15_000,
    );
    const added = await fileIdentity(shortcuts);
    const current = await invoke("preview_steam_entry", {
      request: { portId: port.id, steamRoot, steamUserId, operation: "add_or_repair" },
      generation: (await invoke("get_bootstrap_status")).value.generation,
    });
    assert.equal(current.ok, true);
    assert.equal(current.value.writes_required, false);
    await click(button("Close"));
    await click(button("Steam entry"));
    await browser.findElement(By.id("steam-installation")).sendKeys(steamRoot);
    await browser.findElement(By.id("steam-profile")).sendKeys(steamUserId);
    await click(button("Review Remove"));
    await browser.wait(until.elementLocated(button("Remove reviewed entry")), 15_000);
    const removeActionStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(button("Remove reviewed entry")),
      await browser.findElement(button("Review current state again")),
    );
    assert.ok((await browser.findElement(dialog).getText()).includes("remove"));
    const screenshot = path.join(output, "native-steam-entry-remove-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await click(button("Remove reviewed entry"));
    await confirmNative(
      "Confirm Steam entry change",
      "Apply reviewed Remove",
      shortcuts,
      "steam-entry-remove-native-confirmed",
    );
    await browser.wait(
      until.elementLocated(By.xpath('//p[@role="status" and contains(., "was written")]')),
      15_000,
    );
    const removed = await fileIdentity(shortcuts);
    assert.notEqual(removed.sha256, added.sha256);
    const absent = await invoke("preview_steam_entry", {
      request: { portId: port.id, steamRoot, steamUserId, operation: "remove" },
      generation: (await invoke("get_bootstrap_status")).value.generation,
    });
    assert.equal(absent.ok, true);
    assert.equal(absent.value.writes_required, false);
    const report = path.join(output, "steam-entry-result.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          port_id: port.id,
          steam_root: steamRoot,
          steam_user_id: steamUserId,
          shortcuts,
          add_plan_sha256: preview.value.plan_sha256,
          added,
          removed,
          native_add_cancelled_without_write: true,
          exact_add_became_idempotent: true,
          exact_owned_remove_became_idempotent: true,
          escape_dismissed_and_restored_focus: true,
          add_action_styles: addActionStyles,
          remove_action_styles: removeActionStyles,
          field_presentation: fieldPresentation,
          steam_process_observation: "qualification-fixture-closed",
          evidence:
            "isolated local Steam tree through actual Tauri renderer and native confirmation with the compile-time qualification closed-process fixture; no actual closed Steam client, production profile, gameplay, or physical-platform claim",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
