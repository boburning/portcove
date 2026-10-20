import type { WebDriver } from "selenium-webdriver";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { transportValue, transportValues } from "./transport-values.mts";
interface SourceRemovalContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
import { executeBrowserScript } from "./browser-script.mts";
// Source-reference removal uses the existing owned preparation fixture; no game files are acquired.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { By, until } from "selenium-webdriver";
import { installedPreservationWitness } from "./desktop-scenario-state.mts";
import {
  reviewControls,
  assertCompactReview,
  assertDestructiveReviewAction,
  captureAccessibilityReport,
} from "./desktop-review-controls.mts";

export async function sourceRemovalScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}: SourceRemovalContext) {
  await scenario("native-reviewed-source-reference-removal", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { portId, install } = installedPreservationWitness((args) =>
      transportValue("status", command(args)),
    );
    const port = transportValue("port", command(["catalog", "show", portId]));
    const sources = () => transportValues("source", command(["source", "list"]));
    const source = sources().find((item) => item.profile_id === port.source_profile);
    assert.ok(source);
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await mkdir(paths.user_data_root, { recursive: true });
    const save = path.join(paths.user_data_root, "owned-source-review-save.bin");
    await writeFile(save, "source removal must preserve this save", {
      flag: "wx",
    });
    const backup = transportValue("backup", command(["backup", "create", port.id]));
    const preserved = await Promise.all(
      [source.path, save, path.join(backup.path, "data/owned-source-review-save.bin")].map((file) =>
        fileIdentity(file),
      ),
    );
    const others = () => sources().filter((item) => item.profile_id !== source.profile_id);
    const otherSources = others();
    await browser.navigate().refresh();
    const updatePreference = await invoke("get_application_update_preferences");
    assert(isRecord(updatePreference));
    assert.equal(updatePreference.ok, true);
    const preferences = transportValue(
      "desktop_application_update_preferences",
      updatePreference.value,
    );
    if (preferences.choice === null) {
      const defer = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Not now"]')),
        15_000,
      );
      await defer.click();
      await browser.wait(until.stalenessOf(defer), 15_000);
    }
    const { button, click } = reviewControls(browser);
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(
      By.xpath('//nav[@aria-label="Settings categories"]//button[normalize-space(.)="Game files"]'),
    );
    const row = By.css(`.source-health-row[data-source-profile="${source.profile_id}"]`);
    const impactSelector = '[aria-label="Saved-location removal impact"]';
    const dialog = By.css(impactSelector);
    const trigger = By.xpath(
      `//*[@data-source-profile="${source.profile_id}"]//button[normalize-space(.)="Review saved location removal"]`,
    );
    await browser.wait(until.elementLocated(row), 15_000);
    const rowLayout = await executeBrowserScript(
      browser,
      (element) => {
        const title = element.querySelector("strong");
        const actions = element.querySelector(".source-health-actions");
        const bounds = element.getBoundingClientRect();
        const titleBounds = title?.getBoundingClientRect();
        const actionBounds = actions?.getBoundingClientRect();
        return {
          rowWidth: bounds.width,
          titleColumnWidth: title?.parentElement?.getBoundingClientRect().width ?? 0,
          titleHeight: titleBounds?.height ?? 0,
          actionsTop: actionBounds?.top ?? 0,
          titleBottom: titleBounds?.bottom ?? 0,
        };
      },
      await browser.findElement(row),
    );
    assert.ok(
      rowLayout.titleColumnWidth > rowLayout.rowWidth * 0.7 &&
        rowLayout.titleHeight < 80 &&
        rowLayout.actionsTop >= rowLayout.titleBottom,
      `saved source title is cramped: ${JSON.stringify(rowLayout)}`,
    );
    const openReview = async () => {
      await click(trigger);
      await browser.wait(until.elementLocated(button("Remove saved location…")), 15_000);
    };
    await openReview();
    assert.equal(
      (await browser.findElements(By.css('[role="dialog"]'))).length,
      0,
      "inline impact must not create renderer approval",
    );
    await click(button("Keep location"));
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "source removal inline impact did not close after Keep location",
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
      "source removal trigger did not regain focus after Keep location",
    );
    await openReview();
    const destructiveStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(button("Remove saved location…")),
      await browser.findElement(button("Keep location")),
    );
    let text = await browser.findElement(dialog).getText();
    assert.ok(
      text.includes(source.path) &&
        text.includes(port.name) &&
        text.includes("does not move or delete files at") &&
        text.includes("If interrupted, reopen Settings"),
    );
    await click(button("Keep location"));
    assert.deepEqual(
      sources().find((item) => item.profile_id === source.profile_id),
      source,
    );
    await openReview();
    await click(button("Remove saved location…"));
    await confirmNative(
      "Remove saved location?",
      "__observe__",
      source.path,
      "source-native-before-consent",
    );
    assert.deepEqual(
      sources().find((item) => item.profile_id === source.profile_id),
      source,
    );
    await confirmNative("Remove saved location?", "Cancel", source.path, "source-native-cancelled");
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    await openReview();
    const replacement = path.join(output, `owned-replacement-${port.id}.iso`);
    await writeFile(replacement, "changed owned source registration", {
      flag: "wx",
    });
    command(["source", "add", source.profile_id, replacement]);
    preserved.push(await fileIdentity(replacement));
    await click(button("Remove saved location…"));
    const renewedIntent = await browser.wait(
      async () => {
        if ((await browser.findElements(button("Check saved location again"))).length)
          return "recheck";
        // External-CLI reconciliation may publish the new source identity first.
        // That unmounts the old inline review; reopening is explicit renewed intent.
        if (
          !(await browser.findElements(dialog)).length &&
          (await browser.findElements(trigger)).length
        )
          return "reopen";
        return false;
      },
      15_000,
      "Changed saved location must invalidate the previous impact review",
    );
    assert.equal(
      sources().find((item) => item.profile_id === source.profile_id)?.path,
      replacement,
    );
    const bootstrap = await invoke("get_bootstrap_status");
    assert(isRecord(bootstrap) && bootstrap.ok === true);
    const generation = transportValue("desktop_bootstrap_status", bootstrap.value).generation;
    const reviewed = await invoke("preview_source_removal", {
      profileId: source.profile_id,
      generation,
    });
    assert(isRecord(reviewed));
    assert.equal(reviewed.ok, true);
    const preview = transportValue("source_removal_preview", reviewed.value);
    const stale = await invoke("remove_source", {
      profileId: source.profile_id,
      previewSha256: preview.preview_sha256,
      generation: generation + 1,
    });
    assert(isRecord(stale));
    assert.equal(stale.ok, false);
    assert(isRecord(stale.error));
    assert.equal(stale.error.code, "conflict");
    if (renewedIntent === "reopen") await click(trigger);
    else await click(button("Check saved location again"));
    await browser.wait(until.elementLocated(button("Remove saved location…")), 15_000);
    text = await browser.findElement(dialog).getText();
    assert.ok(text.includes(replacement));
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "start" });',
      await browser.findElement(dialog),
    );
    const report = path.join(output, "source-removal-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const screenshot = path.join(output, "native-source-removal-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await assertCompactReview(browser, impactSelector);
    const compact = path.join(output, "native-source-removal-compact.png");
    await writeFile(compact, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(compact);
    await click(button("Remove saved location…"));
    await confirmNative(
      "Remove saved location?",
      "Remove saved location",
      replacement,
      "source-native-confirmed",
    );
    await browser.wait(async () => (await browser.findElements(row)).length === 0, 15_000);
    assert.ok(!sources().some((item) => item.profile_id === source.profile_id));
    assert.deepEqual(others(), otherSources);
    assert.deepEqual(
      await Promise.all(preserved.map((item) => fileIdentity(item.path))),
      preserved,
    );
    assert.deepEqual(transportValue("status", command(["status", port.id])).active, install);
    assert.ok(
      transportValue("backup_inventory", command(["backup", "list", port.id])).backups.some(
        (item) => item.id === backup.id,
      ),
    );
    const result = path.join(output, "source-removal-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          profile_id: source.profile_id,
          preserved_files: preserved,
          preserved_install: install.id,
          preserved_backup: backup.id,
          preserved_other_sources: otherSources,
          dismissal_and_native_cancel_preserved_reference: true,
          changed_registration_rejected: true,
          stale_generation_rejected: true,
          inline_keep_and_focus_restoration: true,
          destructive_action_styles: destructiveStyles,
          evidence:
            "native owned-file reference removal; no game compatibility or human-comprehension claim",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(result);
  });
}
