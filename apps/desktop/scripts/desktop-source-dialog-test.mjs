// Actual-Tauri proof for the paired one-off intake and explicit-folder source journeys.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  openCatalogPortAfterRefresh,
  reviewControls,
} from "./desktop-review-controls.mjs";

async function progressiveScanNavigation({
  browser,
  output,
  artifacts,
  command,
  port,
  searchRoot,
}) {
  const { button, click } = reviewControls(browser);
  const sourcesBefore = command(["source", "list"]);
  const statusBefore = command(["status", port.id]);
  const rootsBefore = command(["source", "roots", "list"]);
  const source = sourcesBefore.find((item) => item.profile_id === port.source_profile);
  assert.ok(source, "The ordinary preparation dependency must supply a registered source");
  assert.ok(Array.isArray(rootsBefore));
  assert.ok(!rootsBefore.some((item) => item.path === searchRoot));
  const root = command(["source", "roots", "add", searchRoot]);
  const observations = {
    evidence:
      "controlled pending scan and provisional registered-source event in normal Tauri; not an actual discovery or backend cancellation",
    port_id: port.id,
    source_profile: source.profile_id,
    injected: 0,
    restored: false,
  };
  try {
    try {
      await click(button("Refresh folders"));
      await browser.wait(async () => {
        const scan = await browser.findElements(button("Scan saved folders"));
        return scan.length === 1 && (await scan[0].isEnabled());
      }, 5_000);
      await browser.executeScript((source) => {
        const native = window.__TAURI_INTERNALS__;
        const original = window.fetch;
        const target = native.convertFileSrc("scan_game_file_roots", "ipc");
        const probe = { original, injected: 0, release: null, channel: null };
        window.__portcoveProgressiveScanProbe = probe;
        window.fetch = function (input, ...args) {
          const url = typeof input === "string" ? input : input.url;
          if (url !== target) return original.call(window, input, ...args);
          probe.injected++;
          const body = args[0].body;
          const payload = JSON.parse(
            typeof body === "string" ? body : new TextDecoder().decode(body),
          );
          if (!/^__CHANNEL__:\d+$/.test(payload.onEvent))
            throw new Error("Unexpected pinned Channel payload");
          probe.channel = Number(payload.onEvent.slice("__CHANNEL__:".length));
          const event = {
            schema_version: 3,
            operation_id: "owned-progressive-navigation-probe",
            parent_operation_id: null,
            target: null,
            operation: "discover_sources",
            timestamp_ms: Date.now(),
          };
          native.runCallback(probe.channel, {
            index: 0,
            message: { ...event, type: "started", sequence: 1 },
          });
          native.runCallback(probe.channel, {
            index: 1,
            message: {
              ...event,
              type: "source_candidate",
              sequence: 2,
              profile_id: source.profile_id,
              path: source.path,
              sha256: source.sha256,
              size: source.size,
            },
          });
          return new Promise((resolve) => {
            probe.release = resolve;
          });
        };
      }, source);
      await click(button("Scan saved folders"));
      await browser.wait(until.elementLocated(button(`View ${port.name} details`)), 5_000);
      assert.equal(await browser.findElement(button("Scan saved folders")).isEnabled(), false);
      assert.equal(await browser.findElement(button("Cancel scan")).isEnabled(), true);
      await click(button(`View ${port.name} details`));
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Back to previous workspace"]')),
        5_000,
      );
      assert.equal((await browser.findElements(By.id("game-file-libraries-heading"))).length, 0);
      await click(By.css('[aria-label="Back to previous workspace"]'));
      await browser.wait(until.elementLocated(button(`View ${port.name} details`)), 5_000);
      assert.equal(await browser.findElement(button("Scan saved folders")).isEnabled(), false);
      assert.equal(await browser.findElement(button("Cancel scan")).isEnabled(), true);
      assert.equal(await browser.findElement(button("Relink")).isEnabled(), false);
      assert.equal(
        await browser.executeScript(() => window.__portcoveProgressiveScanProbe.injected),
        1,
      );
      await browser.wait(
        () =>
          browser.executeScript(
            () =>
              document.activeElement?.closest(
                '[data-detail-origin="game-file-libraries-setup"]',
              ) !== null,
          ),
        5_000,
        "Returning from details must restore the saved-folder origin focus",
      );
      observations.detail_return_focus = true;
      observations.pending_scan_survived_detail_return = true;
      const screenshot = path.join(output, "native-progressive-scan-return.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await captureAccessibilityReport(
        browser,
        path.join(output, "progressive-scan-return-accessibility.json"),
        artifacts,
      );
    } finally {
      Object.assign(
        observations,
        await browser.executeScript(() => {
          const probe = window.__portcoveProgressiveScanProbe;
          if (!probe) return { injected: 0, restored: true, channel_closed: false };
          window.fetch = probe.original;
          if (probe.channel !== null)
            window.__TAURI_INTERNALS__.runCallback(probe.channel, { index: 2, end: true });
          probe.release?.(
            new Response(
              JSON.stringify("Controlled scan observation ended; refresh or scan again."),
              {
                headers: { "Content-Type": "application/json", "Tauri-Response": "error" },
              },
            ),
          );
          return {
            injected: probe.injected,
            restored: window.fetch === probe.original,
            channel_closed: probe.channel !== null,
          };
        }),
      );
    }
    assert.equal(observations.injected, 1);
    assert.equal(observations.restored, true);
    await browser.wait(
      async () => {
        const scan = await browser.findElements(button("Scan saved folders"));
        return scan.length === 1 && (await scan[0].isEnabled());
      },
      5_000,
      "The released controlled scan must no longer block a new request",
    );
    assert.equal((await browser.findElements(button("Cancel scan"))).length, 0);
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="alert" and contains(., "Controlled scan observation ended")]'),
      ),
      5_000,
    );
    await click(button("Refresh folders"));
    await browser.wait(
      async () => (await browser.findElements(By.css('[role="alert"]'))).length === 0,
      5_000,
    );
  } finally {
    const removed = command(["source", "roots", "remove", root.id]);
    assert.equal(removed.removed, true);
    assert.deepEqual(command(["source", "roots", "list"]), rootsBefore);
    assert.deepEqual(command(["source", "list"]), sourcesBefore);
    assert.deepEqual(command(["status", port.id]), statusBefore);
    const report = path.join(output, "progressive-scan-navigation.json");
    await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
    artifacts.push(report);
  }
}

export async function sourceDialogScenario({ browser, scenario, output, artifacts, command }) {
  await scenario("native-source-intake-and-discovery-dialogs", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const profileLabel = port.presentation.source_requirements[0].label;
    const { button, click } = reviewControls(browser);

    await openCatalogPortAfterRefresh(browser, port);
    const disclosure = await browser.findElement(By.css(".requirements-disclosure"));
    if (!(await browser.executeScript((element) => element.open, disclosure))) {
      await click(By.css(".requirements-disclosure > .requirements-summary"));
    }
    assert.equal(await browser.executeScript((element) => element.open, disclosure), true);
    const intakeTrigger = await browser.findElement(button("Check game files"));
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', intakeTrigger);
    await click(button("Check game files"));
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
      until.elementLocated(button("Find required files")),
      15_000,
    );
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "center" });',
      discoveryTrigger,
    );
    await click(button("Find required files"));
    const discoveryDialog = By.css('[aria-labelledby="source-discovery-title"]');
    await browser.wait(until.elementLocated(discoveryDialog), 15_000);
    assert.ok(
      (await browser.findElement(discoveryDialog).getText()).includes(
        "Portcove's game-file folder",
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
      By.xpath('//button[contains(., "Required files")]'),
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
    const sourceRegistrationIndex = activities.findIndex(
      (item) => item.id === sourceRegistration.id,
    );
    const sourceActivityInRecentPreview = sourceRegistrationIndex < 8;
    await click(By.xpath('//nav//button[contains(., "Game updates")]'));
    const sourceActivity = By.xpath(
      `//div[contains(@class, "activity-row") and .//strong[normalize-space()="Game-file location update"]]//button[@aria-label=${JSON.stringify(`Open Game files settings for ${profileLabel}`)}]`,
    );
    await browser.wait(until.elementLocated(By.css(".activity-list")), 15_000);
    if (sourceActivityInRecentPreview)
      await browser.wait(until.elementLocated(sourceActivity), 15_000);
    assert.equal(
      (await browser.findElements(sourceActivity)).length,
      sourceActivityInRecentPreview ? 1 : 0,
      `source registration at history index ${sourceRegistrationIndex} must match the recent preview`,
    );
    if (sourceActivityInRecentPreview) {
      await click(sourceActivity);
      await browser.wait(until.elementLocated(By.id("settings-game-files-heading")), 5_000);
      await browser.wait(
        () =>
          browser.executeScript(
            (profileId) =>
              document.activeElement
                ?.closest("[data-source-profile]")
                ?.getAttribute("data-source-profile") === profileId &&
              document.activeElement?.textContent?.includes("Update file location"),
            port.source_profile,
          ),
        5_000,
        "Source activity did not focus its saved source control",
      );
      await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
      await browser.wait(
        () =>
          browser.executeScript(
            () => document.activeElement?.closest('[data-settings-group="game-files"]') !== null,
          ),
        5_000,
        "Directional navigation left Game files settings",
      );
      const settingsScreenshot = path.join(output, "native-source-activity-settings.png");
      await writeFile(settingsScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(settingsScreenshot);
    }

    await click(By.xpath('//nav//button[contains(., "Game updates")]'));
    const discoveryActivity = By.xpath(
      '//div[contains(@class, "activity-row") and .//strong[normalize-space()="Game-file search"]]//button[@aria-label="Open Game files settings for Portcove library"]',
    );
    await browser.wait(until.elementLocated(discoveryActivity), 15_000);
    await click(discoveryActivity);
    await browser.wait(
      () =>
        browser.executeScript(
          () =>
            document.activeElement?.getAttribute("data-settings-control") === "discover-sources",
        ),
      5_000,
      "Library discovery activity did not focus game-file discovery",
    );
    const discoverySettingsScreenshot = path.join(output, "native-discovery-activity-settings.png");
    await writeFile(discoverySettingsScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(discoverySettingsScreenshot);

    await progressiveScanNavigation({ browser, output, artifacts, command, port, searchRoot });

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
          source_activity_history_index: sourceRegistrationIndex,
          source_activity_in_recent_preview: sourceActivityInRecentPreview,
          source_activity_opened_game_files_settings: sourceActivityInRecentPreview,
          source_activity_settings_control_focused: sourceActivityInRecentPreview,
          library_discovery_activity_opened_game_files_settings: true,
          library_discovery_settings_control_focused: true,
          directional_navigation_stayed_in_game_files: sourceActivityInRecentPreview,
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
