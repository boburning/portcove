// Optional owned-fixture scenarios; all state stays under desktop-test's new output directory.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { backupReviewScenario } from "./desktop-backup-review-test.mjs";
import { removalReviewScenario } from "./desktop-removal-review-test.mjs";
import { cliHandoffScenario } from "./desktop-cli-handoff-test.mjs";
import { artworkScenario } from "./desktop-artwork-test.mjs";
import { libraryHandoffScenario } from "./desktop-library-handoff-test.mjs";
import { adoptionReviewScenario } from "./desktop-adoption-review-test.mjs";
import { sourceRemovalScenario } from "./desktop-source-removal-test.mjs";
import { interruptedPreparationScenario } from "./desktop-preparation-recovery-test.mjs";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible,
} from "./desktop-review-controls.mjs";
import { readinessScenario } from "./desktop-readiness-test.mjs";
import { steamEntryScenario } from "./desktop-steam-entry-test.mjs";
import { sourceDialogScenario } from "./desktop-source-dialog-test.mjs";

function rgbLuminance(color) {
  const channels = color
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
  const linear = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const values = [rgbLuminance(foreground), rgbLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export async function preparationScenarios({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  tool,
  confirmNative,
  restartApplication,
}) {
  const command = (args, selectedLibrary = library) => {
    const result = spawnCommand(
      cli,
      ["--library", selectedLibrary, "--json", "--non-interactive", ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    return response.data;
  };
  const host =
    process.platform === "win32"
      ? "windows-x86-64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "macos-aarch64"
          : "macos-x86-64"
        : "linux-x86-64";
  async function seed(portId, mode, chd = false) {
    const port = command(["catalog", "show", portId]);
    const original = path.join(output, `owned-${portId}`);
    await mkdir(original);
    for (const relative of [port.executable_hints[host][0], port.setup_executable_hints[host][0]]) {
      const destination = path.join(original, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(tool, destination);
    }
    await writeFile(path.join(original, "owned-setup-mode"), mode);
    const install = command(["adopt", original, "--port", portId, "--yes"]);
    if (chd) command(["tool", "set-path", "chdman", tool]);
    const source = path.join(output, `${portId}.${chd ? "chd" : "iso"}`);
    await writeFile(source, "owned source awaiting upstream validation");
    command(["source", "add", port.source_profile, source]);
    return { port, install };
  }
  const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  async function dismissApplicationUpdateChoice() {
    const preferences = await invoke("get_application_update_preferences");
    assert.equal(preferences.ok, true);
    if (preferences.value.choice !== null) return;
    const choice = By.xpath(
      '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
    );
    await browser.wait(until.elementLocated(choice), 15_000);
    await browser
      .findElement(
        By.xpath(
          '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]//button[normalize-space(.)="Not now"]',
        ),
      )
      .click();
    await browser.wait(async () => (await browser.findElements(choice)).length === 0, 15_000);
  }
  async function open(port, waitForPreparation = true) {
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(
      `//article[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]//button[@data-detail-origin]`,
    );
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    if (waitForPreparation)
      await browser.wait(until.elementLocated(button("Review game preparation")), 15_000);
  }
  async function status(portId) {
    const result = await invoke("get_statuses");
    assert.equal(result.ok, true);
    return result.value.find((item) => item.port_id === portId);
  }
  async function activities() {
    const result = await invoke("get_activities");
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.value.records));
    return result.value.records;
  }
  await scenario("native-preparation-review-and-play", async () => {
    const { port, install } = await seed("opengoal-jak1", "success");
    await open(port);
    assert.equal((await status(port.id)).readiness.launchable, false);
    const outputLocationInput = await browser.findElement(By.id(`output-location-path-${port.id}`));
    const reviewedOutput = path.join(output, "reviewed-future-output");
    await outputLocationInput.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      reviewedOutput,
    );
    const outputLocationTrigger = await browser.findElement(button("Review future folder"));
    await clickVisible(browser, outputLocationTrigger);
    const outputLocationDialog = By.css('[aria-labelledby="output-location-review-title"]');
    const review = await browser.wait(until.elementLocated(outputLocationDialog), 15_000);
    const reviewText = await review.getText();
    assert.ok(reviewText.includes(reviewedOutput));
    assert.ok(reviewText.includes("Future placement only"));
    assert.ok(reviewText.includes("does not move an existing installation"));
    await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Use this folder for future installs")),
      await browser.findElement(button("Cancel review")),
    );
    await assertCompactReview(browser, '[aria-labelledby="output-location-review-title"]');
    const outputLocationAccessibility = path.join(
      output,
      "output-location-review-accessibility.json",
    );
    await captureAccessibilityReport(browser, outputLocationAccessibility, artifacts);
    const outputLocationImage = path.join(output, "native-output-location-review.png");
    await writeFile(outputLocationImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(outputLocationImage);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(outputLocationDialog)).length === 0,
      5_000,
      "Output location review did not close after Escape",
    );
    await browser.wait(
      () =>
        browser.executeScript(
          "return document.activeElement === arguments[0];",
          outputLocationTrigger,
        ),
      5_000,
      "Output location review trigger did not regain focus after Escape",
    );
    assert.equal((await status(port.id)).active.id, install.id, "review must not move versions");
    await browser.findElement(button("Review game preparation")).click();
    const preparationDialog = By.css('[aria-labelledby="preparation-review-title"]');
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.wait(until.elementLocated(button("Start new preparation")), 15_000);
    assert.equal((await status(port.id)).active.id, install.id, "review must not prepare");
    await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Start new preparation")),
      await browser.findElement(button("Cancel review")),
    );
    await assertCompactReview(browser, '[aria-labelledby="preparation-review-title"]');
    const reviewImage = path.join(output, "native-preparation-review.png");
    await writeFile(reviewImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(reviewImage);
    const accessibilityReport = path.join(output, "preparation-accessibility.json");
    await captureAccessibilityReport(browser, accessibilityReport, artifacts);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(preparationDialog)).length === 0,
      5_000,
      "Preparation review did not close after Escape",
    );
    await browser.wait(
      () =>
        browser.executeScript(
          'return document.activeElement?.textContent?.trim() === "Review game preparation";',
        ),
      5_000,
      "Preparation review trigger did not regain focus after Escape",
    );
    assert.equal((await status(port.id)).active.id, install.id, "dismissal must not prepare");
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.findElement(button("Start new preparation")).click();
    await browser.wait(async () => (await status(port.id)).readiness.launchable, 15_000);
    const prepared = await status(port.id);
    assert.notEqual(prepared.active.id, install.id);
    assert.equal(prepared.previous.id, install.id);
    const log = path.join(prepared.active.path, "data/log/setup.log");
    await writeFile(log, "setup must not run during desktop Play");
    await browser.wait(until.elementLocated(button("Play now")), 15_000);
    await browser.wait(
      until.elementIsEnabled(await browser.findElement(button("Play now"))),
      15_000,
    );
    await browser.findElement(button("Play now")).click();
    await browser.wait(async () => (await status(port.id)).successful_launches > 0, 15_000);
    assert.equal(await readFile(log, "utf8"), "setup must not run during desktop Play");
    await browser.findElement(By.css(".detail-back")).click();
    const card = await browser.wait(
      until.elementLocated(
        By.xpath(
          `//article[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
        ),
      ),
      15_000,
    );
    const cardActions = await browser.executeScript((element) => {
      const details = element.querySelector('[data-detail-origin^="library:card:"]');
      const play = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Play",
      );
      const workspace = element.closest("main");
      const cardBounds = element.getBoundingClientRect();
      const detailsBounds = details.getBoundingClientRect();
      const playBounds = play.getBoundingClientRect();
      const detailsStyle = getComputedStyle(details);
      details.focus();
      return {
        tag: element.tagName,
        details: details.textContent.trim(),
        details_slot: details.getAttribute("data-slot"),
        details_variant: details.getAttribute("data-variant"),
        play: play.textContent.trim(),
        play_disabled: play.disabled,
        play_slot: play.getAttribute("data-slot"),
        play_variant: play.getAttribute("data-variant"),
        workspace_horizontal_overflow: workspace.scrollWidth > workspace.clientWidth + 1,
        card_horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
        actions_fit_card:
          detailsBounds.left >= cardBounds.left && playBounds.right <= cardBounds.right,
        details_color: detailsStyle.color,
        details_background: detailsStyle.backgroundColor,
        nested_interactive: element.querySelectorAll("button button, button a, a button, a a")
          .length,
        details_focused: document.activeElement === details,
      };
    }, card);
    const {
      details_color: detailsColor,
      details_background: detailsBackground,
      ...cardStructure
    } = cardActions;
    assert.deepEqual(cardStructure, {
      tag: "ARTICLE",
      details: "View details",
      details_slot: "button",
      details_variant: "outline",
      play: "Play",
      play_disabled: false,
      play_slot: "button",
      play_variant: "primary",
      workspace_horizontal_overflow: false,
      card_horizontal_overflow: false,
      actions_fit_card: true,
      nested_interactive: 0,
      details_focused: true,
    });
    const detailsContrast = contrastRatio(detailsColor, detailsBackground);
    assert.ok(
      detailsContrast >= 4.5,
      `Library View details contrast ${detailsContrast} is below AA`,
    );
    const actionsImage = path.join(output, "library-distinct-card-actions.png");
    await writeFile(actionsImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(actionsImage);
  });
  await readinessScenario({
    browser,
    scenario,
    output,
    artifacts,
    command,
    open,
  });
  await scenario("native-retained-contract-repair-state", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const active = (await status(port.id)).active;
    const manifest = path.join(active.path, ".portcove-manifest.json");
    const original = await readFile(manifest);
    assert.equal(JSON.parse(original).schema_version, 6);
    try {
      await writeFile(manifest, "owned corrupt contract fixture");
      await open(port, false);
      const damaged = await status(port.id);
      assert.equal(damaged.readiness.launchable, false);
      assert.deepEqual(damaged.readiness.blockers, ["invalid_installation"]);
      await browser.wait(
        until.elementLocated(By.xpath('//*[normalize-space(.)="Installation needs repair"]')),
        15_000,
      );
      assert.equal((await browser.findElements(button("Play now"))).length, 0);
      assert.equal((await browser.findElements(button("Choose required source"))).length, 0);
      assert.deepEqual(command(["status", port.id]).readiness, damaged.readiness);
      const report = path.join(output, "retained-contract-accessibility.json");
      await captureAccessibilityReport(browser, report, artifacts);
      const screenshot = path.join(output, "native-retained-contract-repair.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    } finally {
      await writeFile(manifest, original);
    }
    await open(port, false);
    assert.equal((await status(port.id)).readiness.launchable, true);
  });

  await scenario("native-preparation-cancellation", async () => {
    const { port, install } = await seed("opengoal-jak2", "wait", true);
    await open(port);
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(button("Start new preparation")), 15_000);
    await browser.findElement(button("Start new preparation")).click();
    let activity;
    await browser.wait(
      async () => {
        activity = (await activities()).find(
          (item) =>
            item.operation === "prepare" && item.target_id === port.id && item.status === "running",
        );
        return (
          activity &&
          (await stat(
            path.join(library, "staging", activity.id, "payload/data/out/setup-ready"),
          ).then(
            (value) => value.isFile(),
            () => false,
          ))
        );
      },
      15_000,
      "Preparation must reach its owned cancellation checkpoint",
    );
    await browser.findElement(By.css(".detail-back")).click();
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    const runningRowSelector = By.xpath(
      '//div[contains(@class, "activity-row") and contains(@class, "running")][.//strong[normalize-space(.)="Prepared game data"]]',
    );
    const runningRow = await browser.wait(
      until.elementLocated(runningRowSelector),
      15_000,
      "Running preparation must remain discoverable after navigating away",
    );
    const runningText = await runningRow.getText();
    assert.ok(runningText.includes(port.name));
    assert.match(runningText, /In progress/);
    await runningRow.findElement(button("Cancel operation")).click();
    await browser.wait(
      async () => {
        return (await activities()).find((item) => item.id === activity.id)?.status === "cancelled";
      },
      15_000,
      "Preparation cancellation must become durable",
    );
    assert.equal((await status(port.id)).active.id, install.id);
    assert.equal((await status(port.id)).readiness.launchable, false);
    const recorded = (await activities()).find((item) => item.id === activity.id);
    assert.equal(recorded.failure.code, "cancelled");
    assert.equal(recorded.failure.presentation.tone, "neutral");
    assert.equal(recorded.failure.presentation.mutation_state, "recovery_required");
    assert.equal(recorded.failure.presentation.phase, "preparation.setup");
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.wait(
      until.elementLocated(By.xpath('//h1[normalize-space(.)="Portcove settings"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    await browser.wait(
      until.elementLocated(By.css(".activity-row.cancelled .failure-details")),
      15_000,
      "Cancelled preparation must remain discoverable after navigating away and returning",
    );
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    assert.deepEqual(
      (await activities()).find((item) => item.id === activity.id).failure,
      recorded.failure,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    await browser.wait(
      until.elementLocated(By.css(".activity-row.cancelled .failure-details")),
      15_000,
    );
    const row = await browser.findElement(By.css(".activity-row.cancelled"));
    assert.match(await row.getText(), /Retained work needs recovery review/);
    assert.doesNotMatch(await row.getText(), /No files were changed/);
    await row.findElement(By.css("summary")).click();
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const retained = await invoke("get_activity_diagnostic", {
      activityId: activity.id,
      generation,
    });
    assert.equal(retained.ok, true);
    assert.deepEqual(
      retained.value.map((item) => item.phase),
      ["preparation.extract", "preparation.setup"],
    );
    assert.equal(retained.value[0].complete, true);
    assert.match(retained.value[0].stdout.text, /owned conversion began/);
    assert.doesNotMatch(JSON.stringify(retained.value), /owned-conversion-secret/);
    assert.equal(retained.value[1].complete, true);
    assert.match(retained.value[1].stdout.text, /owned setup began/);
    assert.match(retained.value[1].stderr.text, /owned setup diagnostic on stderr/);
    assert.doesNotMatch(JSON.stringify(retained.value), /owned-fixture-private-value/);
    assert.deepEqual(command(["activity", "log", activity.id]), retained.value);
    const staleLog = await invoke("get_activity_diagnostic", {
      activityId: activity.id,
      generation: generation + 1,
    });
    assert.equal(staleLog.ok, false);
    assert.equal(staleLog.error.code, "conflict");
    await row
      .findElement(By.xpath('.//summary[normalize-space(.)="View preparation log"]'))
      .click();
    await browser.wait(
      async () => (await row.getText()).includes("owned setup diagnostic on stderr"),
      15_000,
      "The retained preparation log must render after expansion",
    );
    assert.match(await row.getText(), /Preparing source data/);
    assert.match(await row.getText(), /owned conversion began/);
    assert.doesNotMatch(await row.getText(), /owned-fixture-private-value|owned-conversion-secret/);
    const bundle = await invoke("create_support_bundle");
    assert.equal(bundle.ok, true);
    artifacts.push(bundle.value);
    const capture = path.join(output, "retained-preparation-log.json");
    await writeFile(capture, JSON.stringify(retained.value, null, 2), {
      flag: "wx",
    });
    artifacts.push(capture);

    const report = path.join(output, "recovery-details-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', row);
    const screenshot = path.join(output, "native-preparation-retained-outcome.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  });
  browser = await interruptedPreparationScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    activities,
    confirmNative,
    restartApplication,
  });
  await scenario("native-update-settings-save-without-execution", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const cliBefore = command(["status", port.id]);
    const cliActivities = command(["activity"]);
    const cliSaved = command(["policy", "set", port.id, "stage"]);
    assert.equal(cliSaved.update_policy, "stage");
    for (const key of ["active", "staged", "previous"])
      assert.deepEqual(cliSaved[key], cliBefore[key]);
    assert.deepEqual(command(["activity"]), cliActivities);
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(
      `//article[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]//button[@data-detail-origin]`,
    );
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await clickVisible(
      browser,
      await browser.findElement(By.css("details.advanced-settings > summary")),
    );
    const before = await status(port.id);
    const activities = await invoke("get_activities");
    const policyTrigger = By.xpath('//button[contains(., "Saved update policy")]');
    await browser.findElement(policyTrigger).sendKeys(Key.ENTER);
    const policyPopup = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(
      until.elementLocated(policyPopup),
      5_000,
      "saved update policy options did not open",
    );
    assert.equal(
      await browser.executeScript(
        "return arguments[0].contains(arguments[1]);",
        await browser.findElement(By.css('section[aria-label="Game update settings"]')),
        await browser.findElement(policyPopup),
      ),
      false,
      "saved update policy options must use the shared portal",
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(policyPopup)).length === 0,
      5_000,
      "saved update policy options remained open after Escape",
    );
    const restoredPolicyTrigger = await browser.wait(
      async () => {
        const candidate = await browser.findElement(policyTrigger);
        return (await browser.executeScript(
          "return document.activeElement === arguments[0];",
          candidate,
        ))
          ? candidate
          : false;
      },
      5_000,
      "saved update policy trigger must regain focus after Escape",
    );
    await restoredPolicyTrigger.sendKeys(Key.ENTER);
    const automaticOption = By.xpath(
      '//*[@role="option" and normalize-space(.)="Install when running updates"]',
    );
    await browser.wait(
      until.elementLocated(automaticOption),
      5_000,
      "automatic update policy option did not open",
    );
    await browser.findElement(automaticOption).sendKeys(Key.ENTER);
    assert.equal(
      (await status(port.id)).update_policy,
      before.update_policy,
      "editing a choice is not saving",
    );
    await browser.findElement(button("Save update settings")).click();
    await browser.wait(async () => (await status(port.id)).update_policy === "automatic", 15_000);
    const after = await status(port.id);
    assert.deepEqual(after.active, before.active);
    assert.deepEqual(after.staged, before.staged);
    assert.deepEqual(after.previous, before.previous);
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(
      until.elementLocated(
        By.xpath(
          '//p[@role="status" and contains(., "Update settings saved. No update was run.")]',
        ),
      ),
      15_000,
    );
    const report = path.join(output, "update-settings-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "center" });',
      await browser.findElement(By.css('section[aria-label="Game update settings"]')),
    );
    const screenshot = path.join(output, "native-update-settings-saved.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  });
  await scenario("native-release-channel-selection-and-restart", async () => {
    await browser.findElement(By.css(".detail-back")).click();
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const openCatalogPort = async (id) => {
      const port = command(["catalog", "show", id]);
      const search = await browser.findElement(By.id("port-search"));
      await search.sendKeys(
        Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
        Key.BACK_SPACE,
        port.name,
      );
      await browser.wait(
        async () => (await search.getAttribute("value")) === port.name,
        5_000,
        `catalog search did not settle on ${port.name}`,
      );
      const card = By.xpath(
        `//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
      );
      await browser.wait(until.elementLocated(card), 15_000, `${port.name} card did not appear`);
      await browser.findElement(card).click();
      await clickVisible(
        browser,
        await browser.findElement(By.css("details.advanced-settings > summary")),
      );
      const channel = await browser.findElement(
        By.css('section[aria-label="Game release channel"]'),
      );
      await browser.wait(
        until.elementIsVisible(channel),
        5_000,
        `${port.name} release-channel section did not become visible`,
      );
      return channel;
    };
    const single = await openCatalogPort("ghostship");
    assert.ok((await single.getText()).includes("Stable only"));
    assert.equal((await single.findElements(By.css("button"))).length, 0);
    await browser.findElement(By.css(".detail-back")).click();
    command(["channel", "set", "re-blue", "stable"]);
    const multi = await openCatalogPort("re-blue");
    const before = await status("re-blue");
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const stale = await invoke("set_channel", {
      portId: "re-blue",
      channel: "rolling",
      generation: generation + 1,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
    assert.equal((await status("re-blue")).channel, "stable");
    const staleCheck = await invoke("check_port", {
      portId: "re-blue",
      generation: generation + 1,
    });
    assert.equal(staleCheck.ok, false);
    assert.equal(staleCheck.error.code, "conflict");
    const trigger = await multi.findElement(By.css('button[data-slot="select-trigger"]'));
    await trigger.sendKeys(Key.ENTER);
    const popup = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(
      until.elementLocated(popup),
      5_000,
      "release-channel popup did not open for the Escape probe",
    );
    assert.equal(
      await browser.executeScript(
        "return arguments[0].contains(document.querySelector('[data-slot=\"select-content\"][data-open]'));",
        multi,
      ),
      false,
      "the release-channel popup is portaled outside the details section",
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(popup)).length === 0,
      5_000,
      "release-channel popup did not close after Escape",
    );
    const releaseChannelTrigger = By.css(
      'section[aria-label="Game release channel"] button[data-slot="select-trigger"]',
    );
    const restoredTrigger = await browser.wait(
      until.elementLocated(releaseChannelTrigger),
      5_000,
      "release-channel trigger did not return after Escape",
    );
    assert.equal(
      await browser.executeScript(
        "return document.activeElement === arguments[0];",
        restoredTrigger,
      ),
      true,
      "Escape restores focus to the release-channel trigger",
    );
    await restoredTrigger.sendKeys(Key.ENTER);
    await browser.wait(
      until.elementLocated(popup),
      5_000,
      "release-channel popup did not reopen for selection",
    );
    await browser
      .findElement(By.xpath('//*[@role="option" and normalize-space(.)="Rolling"]'))
      .click();
    await browser.wait(
      async () => (await status("re-blue")).channel === "rolling",
      15_000,
      "rolling channel was not persisted",
    );
    await browser.wait(
      async () => (await browser.findElement(releaseChannelTrigger)).isEnabled(),
      90_000,
      "release-channel trigger did not re-enable after refresh",
    );
    const after = command(["status", "re-blue"]);
    for (const key of ["active", "staged", "previous"]) assert.deepEqual(after[key], before[key]);
    assert.equal(after.channel, "rolling");
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const restarted = await openCatalogPort("re-blue");
    assert.ok((await restarted.getText()).includes("Rolling"));
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', restarted);
    const report = path.join(output, "release-channel-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const screenshot = path.join(output, "native-release-channel-restarted.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  });

  await backupReviewScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    seed,
    open,
    confirmNative,
  });
  await steamEntryScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    command,
    open,
    confirmNative,
  });
  await sourceDialogScenario({ browser, scenario, output, artifacts, command, open });
  await removalReviewScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    open,
    confirmNative,
  });
  await sourceRemovalScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await adoptionReviewScenario({
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
  });
  await libraryHandoffScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await cliHandoffScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    cli,
    command,
  });
  await artworkScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    command,
    confirmNative,
  });
}
