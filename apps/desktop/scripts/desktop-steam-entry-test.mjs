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
    await click(button("Steam shortcut"));
    const dialog = By.css('[aria-labelledby="steam-entry-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "Steam entry dialog did not close after Escape",
    );
    const trigger = await browser.findElement(button("Steam shortcut"));
    await browser.wait(
      async () => browser.executeScript("return document.activeElement === arguments[0];", trigger),
      5_000,
      "Steam entry trigger did not regain focus after Escape",
    );
    await click(button("Steam shortcut"));
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
    await click(button("Review shortcut setup"));
    await browser.wait(until.elementLocated(button("Add or repair shortcut")), 15_000);
    const addActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Add or repair shortcut")),
      await browser.findElement(button("Review current state again")),
    );
    const reviewed = await browser.findElement(dialog).getText();
    assert.ok(reviewed.includes(shortcuts));
    assert.ok(reviewed.includes("add"));
    assert.ok(reviewed.includes("Keep Steam closed until this finishes"));
    const accessibility = path.join(output, "steam-entry-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    await click(button("Add or repair shortcut"));
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
    await browser.wait(until.elementLocated(button("Add or repair shortcut")), 15_000);
    await assert.rejects(stat(shortcuts), { code: "ENOENT" });
    await click(button("Add or repair shortcut"));
    await confirmNative(
      "Confirm Steam entry change",
      "Apply reviewed Add / Repair",
      shortcuts,
      "steam-entry-add-native-confirmed",
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Steam shortcut updated.")]'),
      ),
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
    const sourcesBeforeUninstall = command(["source", "list"]);
    const backupsBeforeUninstall = command(["backup", "list", port.id]);
    const savedDataRoot = command(["paths", port.id]).user_data_root;
    const savedData = path.join(savedDataRoot, "owned-steam-removal-save.bin");
    await mkdir(savedDataRoot, { recursive: true });
    await writeFile(savedData, "owned save must survive game and shortcut removal", { flag: "wx" });
    const savedDataBefore = await fileIdentity(savedData);
    const removedInstall = command(["remove", port.id, "--yes"]);
    assert.ok(removedInstall.removed.length > 0);
    assert.equal(command(["status", port.id]).active, null);
    assert.deepEqual(command(["source", "list"]), sourcesBeforeUninstall);
    assert.deepEqual(command(["backup", "list", port.id]), backupsBeforeUninstall);
    assert.deepEqual(await fileIdentity(savedData), savedDataBefore);
    assert.deepEqual(await fileIdentity(shortcuts), added);
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
      port.name,
    );
    const catalogCard = By.xpath(
      `//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
    );
    await click(catalogCard);
    await click(By.css("summary.advanced-summary"));
    await click(button("Steam shortcut"));
    assert.ok((await browser.findElement(dialog).getText()).includes("game is not installed here"));
    await browser.findElement(By.id("steam-installation")).sendKeys(steamRoot);
    await browser.findElement(By.id("steam-profile")).sendKeys(steamUserId);
    assert.equal(await browser.findElement(button("Review shortcut setup")).isEnabled(), false);
    await click(button("Review shortcut removal"));
    await browser.wait(until.elementLocated(button("Remove shortcut")), 15_000);
    const removeActionStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(button("Remove shortcut")),
      await browser.findElement(button("Review current state again")),
    );
    assert.ok((await browser.findElement(dialog).getText()).includes("remove"));
    assert.ok(
      (await browser.findElement(dialog).getText()).includes(
        "selected profile and shortcut are checked",
      ),
    );
    const screenshot = path.join(output, "native-steam-entry-remove-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await click(button("Remove shortcut"));
    await confirmNative(
      "Confirm Steam entry change",
      "Apply reviewed Remove",
      shortcuts,
      "steam-entry-remove-native-confirmed",
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Steam shortcut removed.")]'),
      ),
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
    assert.equal(command(["status", port.id]).active, null);
    assert.deepEqual(command(["source", "list"]), sourcesBeforeUninstall);
    assert.deepEqual(command(["backup", "list", port.id]), backupsBeforeUninstall);
    assert.deepEqual(await fileIdentity(savedData), savedDataBefore);
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
          uninstall_before_owned_remove: true,
          original_sources_backups_and_saved_data_preserved: true,
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
  await scenario("native-reviewed-steam-batch-add", async () => {
    const first = await context.seed("opengoal-jak1", "success");
    const second = await context.seed("opengoal-jak2", "success");
    const steamRoot = path.join(output, "controlled batch Steam ü");
    const steamUserId = "24680";
    const shortcuts = path.join(steamRoot, "userdata", steamUserId, "config", "shortcuts.vdf");
    await mkdir(path.dirname(shortcuts), { recursive: true });
    const beforeSources = command(["source", "list"]);
    const beforeBackups = [first, second].map(({ port }) => command(["backup", "list", port.id]));
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    const { button, click } = reviewControls(browser);
    await click(By.xpath('//nav//button[contains(., "Library")]'));
    await click(button("Add selected games to Steam"));
    const dialog = By.css('[aria-labelledby="steam-batch-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    const boxes = await browser.findElements(
      By.css('[aria-labelledby="steam-batch-title"] input[type="checkbox"]'),
    );
    assert.ok(boxes.length >= 2, "fixture should offer both installed target games");
    assert.equal(await browser.findElement(button("Review selected shortcuts")).isEnabled(), false);
    const firstBox = await browser.findElement(
      By.xpath(
        `//div[@aria-labelledby="steam-batch-title"]//label[normalize-space(.)="${first.port.name}"]/input[@type="checkbox"]`,
      ),
    );
    const secondBox = await browser.findElement(
      By.xpath(
        `//div[@aria-labelledby="steam-batch-title"]//label[normalize-space(.)="${second.port.name}"]/input[@type="checkbox"]`,
      ),
    );
    await firstBox.click();
    assert.equal(await browser.findElement(button("Review selected shortcuts")).isEnabled(), false);
    await secondBox.click();
    assert.equal(
      (await Promise.all(boxes.map((box) => box.isSelected()))).filter(Boolean).length,
      2,
    );
    await browser.findElement(By.id("steam-batch-installation")).sendKeys(steamRoot);
    await browser.findElement(By.id("steam-batch-profile")).sendKeys(steamUserId);
    await click(button("Review selected shortcuts"));
    await browser.wait(until.elementLocated(button("Add or repair selected shortcuts")), 15_000);
    const reviewText = await browser.findElement(dialog).getText();
    for (const { port } of [first, second]) assert.ok(reviewText.includes(port.name));
    assert.ok(reviewText.includes(shortcuts));
    const screenshot = path.join(output, "native-steam-batch-add-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const request = {
      portIds: [first.port.id, second.port.id],
      steamRoot,
      steamUserId,
    };
    const preview = await invoke("preview_steam_batch_add", { request, generation });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(
      preview.value.selected_games.map((game) => game.port_id),
      request.portIds,
    );
    assert.equal(preview.value.changes.length, 2);
    assert.equal(preview.value.writes_required, true);
    const changedSelection = await invoke("apply_steam_batch_add", {
      request: { ...request, portIds: [...request.portIds].reverse() },
      expectedReviewSha256: preview.value.review_sha256,
      generation,
    });
    assert.equal(changedSelection.ok, false, "a changed batch selection must not open consent");
    await assert.rejects(stat(shortcuts), { code: "ENOENT" });
    await click(button("Add or repair selected shortcuts"));
    await confirmNative(
      "Confirm Steam entry change",
      "Cancel",
      shortcuts,
      "steam-batch-native-cancelled",
    );
    await assert.rejects(stat(shortcuts), { code: "ENOENT" });
    await click(button("Add or repair selected shortcuts"));
    await confirmNative(
      "Confirm Steam entry change",
      "Apply reviewed batch Add / Repair",
      shortcuts,
      "steam-batch-native-confirmed",
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="status" and contains(., "Selected Steam shortcuts updated.")]'),
      ),
      15_000,
    );
    const written = await fileIdentity(shortcuts);
    const repeated = await invoke("preview_steam_batch_add", { request, generation });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.value.writes_required, false);
    assert.deepEqual(command(["source", "list"]), beforeSources);
    assert.deepEqual(
      [first, second].map(({ port }) => command(["backup", "list", port.id])),
      beforeBackups,
    );
    for (const { port } of [first, second]) assert.ok(command(["status", port.id]).active);
    const report = path.join(output, "steam-batch-result.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          selected_port_ids: request.portIds,
          steam_root: steamRoot,
          steam_user_id: steamUserId,
          shortcuts,
          review_sha256: preview.value.review_sha256,
          writer_plan_sha256: preview.value.writer_plan_sha256,
          written,
          changed_selection_rejected: true,
          native_cancel_preserved_original: true,
          repeat_review_idempotent: true,
          sources_backups_installs_preserved: true,
          evidence:
            "isolated actual Tauri and native consent with compile-time closed-process fixture; no production Steam or physical platform claim",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
