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
import { By, Key, until } from "selenium-webdriver";
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
    const originalWindow = await browser.manage().window().getRect();
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = (key: string) =>
      browser.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    let baselineWidth = 0;
    const enlargedStage = async (stage: string) => {
      const observed = await executeBrowserScript(browser, () => ({
        width: innerWidth,
        height: innerHeight,
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        zoom: localStorage.getItem("portcove.appearance.interface-size"),
        dpr: devicePixelRatio,
        theme: document.documentElement.dataset.theme,
        userAgent: navigator.userAgent,
        focus: document.activeElement?.textContent?.trim(),
      }));
      const nativeWindow = await browser.manage().window().getRect();
      assert.equal(nativeWindow.width, 960);
      assert.equal(nativeWindow.height, 640);
      assert.equal(observed.zoom, "400", `Enlargement lost at ${stage}`);
      assert.ok(
        Math.abs(observed.width - baselineWidth / 4) <= 2,
        `Native zoom ratio changed at ${stage}`,
      );
      assert.ok(observed.width <= 240, `Native effective width changed at ${stage}`);
      assert.ok(observed.scroll <= observed.client + 1, `Horizontal overflow at ${stage}`);
      const file = path.join(output, `source-removal-400-${stage}.json`);
      await writeFile(file, JSON.stringify({ ...observed, nativeWindow, baselineWidth }, null, 2), {
        flag: "wx",
      });
      artifacts.push(file);
    };
    let failure: { error: unknown } | undefined;
    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => localStorage.getItem("portcove.appearance.interface-size") === "100",
          ),
        10_000,
      );
      const baseline = await executeBrowserScript(browser, () => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        theme: document.documentElement.dataset.theme,
        userAgent: navigator.userAgent,
      }));
      baselineWidth = baseline.width;
      const baselineFile = path.join(output, "source-removal-100-baseline.json");
      await writeFile(baselineFile, JSON.stringify(baseline, null, 2), { flag: "wx" });
      artifacts.push(baselineFile);
      for (let step = 0; step < 7; step++) await shortcut("+");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () =>
              localStorage.getItem("portcove.appearance.interface-size") === "400" &&
              innerWidth <= 240,
          ),
        10_000,
      );
      await enlargedStage("saved-location");
      const openReview = async () => {
        await click(trigger);
        await browser.wait(until.elementLocated(button("Remove saved location…")), 15_000);
      };
      await openReview();
      await enlargedStage("inline-impact");
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
      await confirmNative(
        "Remove saved location?",
        "Cancel",
        source.path,
        "source-native-cancelled",
      );
      await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
      await enlargedStage("native-cancelled");
      await openReview();
      const bootstrapBeforeChange = await invoke("get_bootstrap_status");
      assert(isRecord(bootstrapBeforeChange) && bootstrapBeforeChange.ok === true);
      const removalGeneration = transportValue(
        "desktop_bootstrap_status",
        bootstrapBeforeChange.value,
      ).generation;
      const beforeChange = await invoke("preview_source_removal", {
        profileId: source.profile_id,
        generation: removalGeneration,
      });
      assert(isRecord(beforeChange) && beforeChange.ok === true);
      const oldPreview = transportValue("source_removal_preview", beforeChange.value);
      const replacement = path.join(output, `owned-replacement-${port.id}.iso`);
      await writeFile(replacement, "changed owned source registration", {
        flag: "wx",
      });
      command(["source", "add", source.profile_id, replacement]);
      preserved.push(await fileIdentity(replacement));
      // Exercise the stale host plan directly: renderer reconciliation can remove
      // its old action before a synthetic click, which is valid invalidation.
      const changed = await invoke("remove_source", {
        profileId: source.profile_id,
        previewSha256: oldPreview.preview_sha256,
        generation: removalGeneration,
      });
      assert(isRecord(changed) && changed.ok === false);
      assert(isRecord(changed.error) && changed.error.code === "conflict");
      await enlargedStage("stale-plan-refused");
      await browser.wait(
        async () => {
          const currentRow = (await browser.findElements(row))[0];
          return (
            currentRow &&
            (await executeBrowserScript(
              browser,
              (element, expected) =>
                element.querySelector("code")?.textContent?.trim() === expected,
              currentRow,
              replacement,
            ))
          );
        },
        15_000,
        "Renderer did not accept the replacement source identity",
      );
      await browser.wait(
        async () => !(await browser.findElements(dialog)).length,
        5_000,
        "Changed identity must retire the old inline intent",
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
      await click(trigger);
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
      await enlargedStage("renewed-impact");
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
      await enlargedStage("removed-location");
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
    } catch (error) {
      failure = { error };
      try {
        const image = path.join(output, "source-removal-enlargement-failure.png");
        await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
        artifacts.push(image);
      } catch (captureError) {
        failure = {
          error: new AggregateError(
            [error, captureError],
            "Source removal and failure capture failed",
          ),
        };
      }
    }
    try {
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => localStorage.getItem("portcove.appearance.interface-size") === "100",
          ),
        10_000,
      );
    } catch (error) {
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, error],
              "Source removal and enlargement cleanup failed",
            )
          : error,
      };
    }
    try {
      await browser.manage().window().setRect(originalWindow);
    } catch (error) {
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, error],
              "Source removal and window restoration failed",
            )
          : error,
      };
    }
    if (failure) throw failure.error;
  });
}
