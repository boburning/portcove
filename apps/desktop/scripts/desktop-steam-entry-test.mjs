// Controlled native consumer proof for one explicit Steam profile. No Steam client is launched.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import { captureAccessibilityReport, reviewControls } from "./desktop-review-controls.mjs";

export async function steamEntryScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  command,
  open,
  confirmNative,
}) {
  await scenario("native-reviewed-steam-entry-add-and-remove", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
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
