// Actual-Tauri proof for the paired one-off intake and explicit-folder source journeys.
import assert from "node:assert/strict";
import {
  beginProgressiveScanProbe,
  requireTrustedProbeCleanup,
} from "./desktop-owned-ipc-probe.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible,
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
  const catalog = command(["catalog", "list"]);
  assert.ok(Array.isArray(catalog), "The compiled CLI must return the effective catalog ports");
  const associatedPorts = catalog
    .filter(
      (item) =>
        item.source_profile === source.profile_id || item.bios_source_profile === source.profile_id,
    )
    .map(({ id, name }) => {
      assert.equal(typeof id, "string");
      assert.equal(typeof name, "string");
      return { id, name };
    });
  assert.ok(associatedPorts.some((item) => item.id === port.id));
  const associationText = `Catalog ports using this profile: ${associatedPorts.map((item) => item.name).join(", ")}`;
  assert.ok(Array.isArray(rootsBefore));
  assert.ok(!rootsBefore.some((item) => item.path === searchRoot));
  const root = command(["source", "roots", "add", searchRoot]);
  const observations = {
    evidence:
      "controlled pending scan and provisional registered-source event in normal Tauri; not an actual discovery or backend cancellation",
    port_id: port.id,
    source_profile: source.profile_id,
    expected_associated_ports: associatedPorts,
    expected_association_text: associationText,
    injected: 0,
    restored: false,
  };
  let probe;
  let scenarioError;
  let primaryError;
  let cleanupError;
  try {
    try {
      await click(button("Refresh folders"));
      await browser.wait(async () => {
        const scan = await browser.findElements(button("Scan saved folders"));
        return scan.length === 1 && (await scan[0].isEnabled());
      }, 5_000);
      probe = await beginProgressiveScanProbe(browser, { source });
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
      const ownedRelink = await browser.wait(
        () =>
          browser.executeScript((rootPath) => {
            const row = [...document.querySelectorAll(".source-health-row")].find(
              (item) => item.querySelector("code")?.textContent === rootPath,
            );
            return (
              [...(row?.querySelectorAll("button") ?? [])].find(
                (item) => item.textContent.trim() === "Relink",
              ) ?? null
            );
          }, root.path),
        5_000,
        "The remounted saved-folder read must expose the owned root's Relink control",
      );
      assert.equal(await ownedRelink.isEnabled(), false);
      assert.equal((await probe.capture()).injected, 1);
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
      const association = await browser.wait(
        () =>
          browser.executeScript(
            (profile, sourcePath, expected) => {
              const row = [...document.querySelectorAll("[data-live-candidate]")].find(
                (item) => item.dataset.profileId === profile && item.dataset.path === sourcePath,
              );
              const spans = [...(row?.querySelectorAll("span") ?? [])].filter((item) =>
                item.textContent.trim().startsWith("Catalog ports using this profile:"),
              );
              return spans.length === 1 && spans[0].textContent.trim() === expected
                ? spans[0]
                : null;
            },
            source.profile_id,
            source.path,
            associationText,
          ),
        5_000,
        "The live source row must show the exact effective catalog associations",
      );
      await browser.executeScript(
        (element) =>
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
        association,
      );
      const presentation = await browser.wait(
        () =>
          browser.executeScript(
            (element, expected) => {
              const viewport = {
                width: innerWidth,
                height: innerHeight,
                client_width: document.documentElement.clientWidth,
                client_height: document.documentElement.clientHeight,
                device_scale: devicePixelRatio,
              };
              const clipping = {
                left: 0,
                top: 0,
                right: Math.min(viewport.width, viewport.client_width),
                bottom: Math.min(viewport.height, viewport.client_height),
              };
              const ancestors = [];
              for (let current = element; current; current = current.parentElement) {
                const style = getComputedStyle(current);
                if (
                  style.display === "none" ||
                  style.visibility !== "visible" ||
                  Number(style.opacity) === 0 ||
                  current
                    .getAnimations()
                    .some(
                      (animation) =>
                        animation.playState === "running" &&
                        Number.isFinite(animation.effect?.getComputedTiming().endTime),
                    )
                )
                  return null;
                if (current === element) continue;
                const rect = current.getBoundingClientRect();
                const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
                const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
                if (!clipsX && !clipsY) continue;
                const bounds = {
                  left: rect.left + current.clientLeft,
                  top: rect.top + current.clientTop,
                  right: rect.left + current.clientLeft + current.clientWidth,
                  bottom: rect.top + current.clientTop + current.clientHeight,
                };
                ancestors.push({ tag: current.tagName, id: current.id, clipsX, clipsY, bounds });
                if (clipsX) {
                  clipping.left = Math.max(clipping.left, bounds.left);
                  clipping.right = Math.min(clipping.right, bounds.right);
                }
                if (clipsY) {
                  clipping.top = Math.max(clipping.top, bounds.top);
                  clipping.bottom = Math.min(clipping.bottom, bounds.bottom);
                }
              }
              const text = element.textContent.trim();
              const bounds = element.getBoundingClientRect().toJSON();
              const fragments = [...element.getClientRects()].map((rect) => rect.toJSON());
              const framed = (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= clipping.left &&
                rect.top >= clipping.top &&
                rect.right <= clipping.right &&
                rect.bottom <= clipping.bottom;
              if (
                !element.isConnected ||
                text !== expected ||
                !Number.isFinite(viewport.device_scale) ||
                viewport.device_scale <= 0 ||
                !framed(bounds) ||
                !fragments.length ||
                !fragments.every(framed)
              )
                return null;
              return { text, viewport, bounds, fragments, clipping, clipping_ancestors: ancestors };
            },
            association,
            associationText,
          ),
        5_000,
        "The settled association span must be fully framed within the viewport and clipping ancestors",
      );
      const windowRect = await browser.manage().window().getRect();
      assert.ok(Number.isFinite(windowRect.width) && windowRect.width > 0);
      assert.ok(Number.isFinite(windowRect.height) && windowRect.height > 0);
      observations.association_presentation = { window: windowRect, ...presentation };
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
    } catch (error) {
      scenarioError = error;
      try {
        const dom = path.join(output, "progressive-scan-failure-before-cleanup.html");
        await writeFile(
          dom,
          await browser.executeScript(() => document.documentElement.outerHTML),
          {
            flag: "wx",
          },
        );
        artifacts.push(dom);
        const screenshot = path.join(output, "progressive-scan-failure-before-cleanup.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
      } catch (captureError) {
        observations.failure_capture_error = String(captureError);
      }
      throw error;
    } finally {
      if (probe) {
        Object.assign(observations, await probe.restore());
        requireTrustedProbeCleanup(observations, scenarioError);
      }
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
  } catch (error) {
    primaryError = error;
    observations.failure = error.message;
  } finally {
    observations.owned_cleanup = [];
    for (const [action, run] of [
      [
        "remove-owned-root",
        () => assert.equal(command(["source", "roots", "remove", root.id]).removed, true),
      ],
      ["roots-readback", () => assert.deepEqual(command(["source", "roots", "list"]), rootsBefore)],
      ["sources-readback", () => assert.deepEqual(command(["source", "list"]), sourcesBefore)],
      ["status-readback", () => assert.deepEqual(command(["status", port.id]), statusBefore)],
    ]) {
      try {
        run();
        observations.owned_cleanup.push({ action, attempted: true, completed: true });
      } catch (error) {
        cleanupError ??= error;
        observations.owned_cleanup.push({
          action,
          attempted: true,
          completed: false,
          error: error.message,
        });
      }
    }
    const report = path.join(output, "progressive-scan-navigation.json");
    try {
      await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
      artifacts.push(report);
    } catch (error) {
      cleanupError ??= error;
      console.error("Owned scan observation report failed:", error.message);
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
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

function selectedSetupCommand({ cli, library, output, fixture }) {
  return (args) => {
    const result = spawnCommand(
      cli,
      ["--library", library, "--json", "--non-interactive", ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
          PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    return response.data;
  };
}

// Fixture pre-state only: no native-picker or source-registration claim.
export function seedSelectedSetup(context) {
  const command = selectedSetupCommand(context);
  assert.deepEqual(command(["source", "list"]), []);
  assert.deepEqual(command(["source", "roots", "list"]), []);
  const root = command(["source", "roots", "add", context.fixture.sourceJourney.directory]);
  assert.deepEqual(command(["source", "list"]), []);
  return root;
}

// Same bounded Windows spelling equivalence used by the existing native fixtures.
function assertOwnedSelectedSetupPath(actual, expected) {
  const normalize = (value) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase();
  assert.equal(normalize(actual), normalize(expected));
}

async function waitSelectedSetupCommit(browser, labels) {
  await browser.wait(
    async () => {
      const settled = await browser.executeScript((labels) => {
        const section = document.querySelector('[aria-label="Continue to a game"]');
        const buttons = [...(section?.querySelectorAll("button") ?? [])];
        return (
          !document.querySelector('[aria-label="Source import review"]') &&
          buttons.length === labels.length &&
          buttons.every(
            (button) => !button.disabled && labels.includes(button.textContent.trim()),
          ) &&
          section.contains(document.activeElement)
        );
      }, labels);
      return (
        settled &&
        (
          await browser.findElement(By.xpath('//button[normalize-space(.)="Refresh folders"]'))
        ).isEnabled()
      );
    },
    15_000,
    "Committed sources must finish workspace refresh and focus an enabled authoritative continuation",
  );
}

async function selectedSetupDetail(browser, port, biosRegistered) {
  await browser.wait(until.elementLocated(By.id("port-detail-title")), 5_000);
  assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
  const state = await browser.findElement(By.css(".hero-state")).getText();
  const reason = await browser.findElement(By.css(".hero-reason")).getText();
  if (!biosRegistered) {
    assert.equal(state, "Required BIOS file needed");
    assert.ok(
      (await browser.findElement(By.css(".hero-requirement")).getText()).includes(
        "Selected setup inert BIOS",
      ),
    );
    assert.equal(
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Choose BIOS file"]'))
        .isEnabled(),
      true,
    );
    assert.equal(
      (await browser.findElements(By.xpath('//button[normalize-space(.)="Review installation"]')))
        .length,
      0,
    );
  } else {
    assert.equal(state, "Available to install");
    assert.equal(
      reason,
      "Portcove will check required game files and verify the release before it becomes active.",
    );
    assert.equal((await browser.findElements(By.css(".hero-requirement"))).length, 0);
    assert.equal(
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Review installation"]'))
        .isEnabled(),
      true,
    );
  }
  return { state, reason, bios_registered: biosRegistered };
}

// Preserve the original journey error even if read-only failure capture also fails.
async function recordSelectedSetupFailure(browser, report, error) {
  report.failure = String(error);
  report.failure_details = {
    checkpoint: report.checkpoint ?? "not recorded",
    name: error?.name,
    message: error?.message,
    stack: error?.stack,
  };
  try {
    report.failure_state = await browser.executeScript(() => ({
      candidates: [...document.querySelectorAll("[data-completed-candidate]")].map((row) => ({
        profile_id: row.getAttribute("data-profile-id"),
        controls: [...row.querySelectorAll("button")].map((button) => ({
          text: button.textContent.trim(),
          disabled: button.disabled,
          review: button.hasAttribute("data-candidate-review"),
        })),
      })),
      focus: document.activeElement?.getAttribute("aria-label") ?? null,
      viewport: { width: innerWidth, height: innerHeight },
    }));
  } catch (captureError) {
    report.failure_state_error = String(captureError);
  }
}

async function scanCoveragePresentation({ browser, snapshot, output, artifacts }) {
  const { button, click } = reviewControls(browser);
  let presentationFailure;
  let cleanupFailure;
  const observations = {
    scope:
      "controlled completed-snapshot presentation in actual Tauri; not backend resume execution",
  };
  await browser.executeScript((snapshot) => {
    const native = window.__TAURI_INTERNALS__;
    const original = window.fetch;
    const readTarget = native.convertFileSrc("get_game_file_scan_snapshot", "ipc");
    const scanTarget = native.convertFileSrc("scan_game_file_roots", "ipc");
    const probe = { original, reads: 0, scans: 0, snapshot: structuredClone(snapshot) };
    probe.snapshot.coverage = {
      ...snapshot.coverage,
      batches: 2,
      can_resume: true,
      frontier_exhausted: false,
      remaining_entries: null,
      restart_required: false,
    };
    probe.snapshot.report.limits_reached = ["entries"];
    window.__portcoveCoverageProbe = probe;
    window.fetch = function (input, ...args) {
      const url = typeof input === "string" ? input : input.url;
      if (url !== readTarget && url !== scanTarget) return original.call(window, input, ...args);
      if (url === readTarget) probe.reads++;
      else {
        probe.scans++;
        const body = args[0].body;
        const payload = JSON.parse(
          typeof body === "string" ? body : new TextDecoder().decode(body),
        );
        probe.limits = payload.limits;
        if (!/^__CHANNEL__:\d+$/.test(payload.onEvent)) throw new Error("Unexpected scan Channel");
        native.runCallback(Number(payload.onEvent.slice("__CHANNEL__:".length)), {
          index: 0,
          end: true,
        });
        Object.assign(probe.snapshot.coverage, {
          batches: 3,
          can_resume: false,
          frontier_exhausted: true,
          remaining_entries: 0,
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(probe.snapshot), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        }),
      );
    };
  }, snapshot);
  try {
    await click(button("Refresh folders"));
    const continueButton = await browser.wait(until.elementLocated(button("Continue scan")), 5_000);
    assert.equal(await continueButton.isEnabled(), true);
    const coverage = await browser.wait(
      until.elementLocated(
        By.xpath(
          '//section[@aria-label="Saved folder scan results"]//p[contains(., "These totals cover 2 scan batches.") and contains(., "The number of remaining entries is unknown.")]',
        ),
      ),
      5_000,
    );
    await browser.executeScript(
      (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
      coverage,
    );
    observations.presentation = await browser.wait(
      () =>
        browser.executeScript((element) => {
          const bounds = element.getBoundingClientRect().toJSON();
          const style = getComputedStyle(element);
          if (
            !element.isConnected ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0 ||
            bounds.width <= 0 ||
            bounds.height <= 0 ||
            bounds.top < 0 ||
            bounds.bottom > innerHeight ||
            bounds.left < 0 ||
            bounds.right > document.documentElement.clientWidth ||
            element.getAnimations().some((animation) => animation.playState === "running")
          )
            return null;
          return {
            text: element.textContent.trim(),
            bounds,
            viewport: { width: innerWidth, height: innerHeight },
          };
        }, coverage),
      5_000,
      "Coverage copy must be settled and framed",
    );
    const screenshot = path.join(output, "selected-setup-scan-coverage.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
    await click(button("Continue scan"));
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[contains(., "Skipped files and search limits still apply.")]'),
      ),
      5_000,
    );
    await browser.wait(until.elementLocated(button("Scan saved folders")), 5_000);
    await browser.executeScript(() => {
      Object.assign(window.__portcoveCoverageProbe.snapshot.coverage, {
        restart_required: true,
        frontier_exhausted: false,
      });
    });
    await click(button("Refresh folders"));
    assert.equal(
      await (await browser.wait(until.elementLocated(button("Start new scan")), 5_000)).isEnabled(),
      true,
    );
  } catch (error) {
    presentationFailure = error;
    observations.failure = String(error);
  } finally {
    try {
      Object.assign(
        observations,
        await browser.executeScript(() => {
          const probe = window.__portcoveCoverageProbe;
          window.fetch = probe.original;
          return {
            reads: probe.reads,
            scans: probe.scans,
            limits: probe.limits,
            restored: window.fetch === probe.original,
          };
        }),
      );
      const report = path.join(output, "selected-setup-scan-coverage.json");
      await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
      artifacts.push(report);
    } catch (error) {
      cleanupFailure = error;
      console.error(JSON.stringify({ observations, cleanup_failure: String(error) }));
    }
  }
  if (presentationFailure) throw presentationFailure;
  if (cleanupFailure) throw cleanupFailure;
  assert.equal(observations.scans, 1);
  assert.deepEqual(observations.limits, snapshot.limits);
  assert.equal(observations.restored, true);
  await click(button("Refresh folders"));
  await browser.wait(until.elementLocated(button("Scan saved folders")), 5_000);
}

export async function selectedSetupScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  fixture,
}) {
  await scenario("native-saved-folder-selected-setup", async () => {
    assert.ok(fixture?.sourceJourney, "Only the exact opt-in selection supplies these identities");
    const owned = fixture.sourceJourney;
    assertOwnedSelectedSetupPath(owned.root.path, owned.directory);
    const command = selectedSetupCommand({ cli, library, output, fixture });
    const expectedGameSha256 = createHash("sha256")
      .update(await readFile(owned.gameBefore))
      .digest("hex");
    const expectedReplacementSha256 = createHash("sha256")
      .update(await readFile(owned.gameReplacement))
      .digest("hex");
    const expectedBiosSha256 = createHash("sha256")
      .update(await readFile(owned.biosBefore))
      .digest("hex");
    const { button, click } = reviewControls(browser);
    const nativeRead = async (name, args) => {
      const response = await invoke(name, args);
      assert.equal(response.ok, true, JSON.stringify(response.error));
      return response.value;
    };
    const report = {
      scope: "real saved-root scan and UI guarded registration; uninstalled requirements only",
      limitations: [
        "Saved root seeded by first-party CLI; native picker not exercised",
        "No installation, preparation, launch or runtime qualification",
        "Uninstalled status is NotChecked; missing path inspected separately",
      ],
      port_ids: [fixture.port.id, fixture.refreshPort.id],
      seeded_saved_root: owned.root,
      observations: {},
    };
    const review = By.css('[aria-label="Source import review"]');
    const row = (profile) => By.css(`[data-completed-candidate][data-profile-id="${profile}"]`);
    const reviewCandidate = async (profile) => {
      const candidate = await browser.wait(until.elementLocated(row(profile)), 15_000);
      await clickVisible(browser, await candidate.findElement(By.css("[data-candidate-review]")));
      await browser.wait(until.elementLocated(review), 15_000);
    };
    const plan = (profileId, sourcePath) =>
      nativeRead("plan_source_import", {
        profileId,
        path: sourcePath,
        mode: "use_current_location",
      });
    const scan = async () => {
      const completedBefore = new Set(
        command(["activity"])
          .records.filter(
            (item) => item.operation === "discover_sources" && item.status === "succeeded",
          )
          .map((item) => item.id),
      );
      await click(button("Scan saved folders"));
      await browser.wait(
        async () =>
          (await browser.findElement(button("Scan saved folders"))).isEnabled() &&
          command(["activity"]).records.some(
            (item) =>
              item.operation === "discover_sources" &&
              item.status === "succeeded" &&
              !completedBefore.has(item.id),
          ),
        15_000,
        "The UI scan must produce a new completed Core activity, not reuse a prior snapshot",
      );
      const snapshot = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(snapshot.freshness, "inputs_match");
      assert.deepEqual(
        snapshot.report.candidates.map((item) => item.profile_id).sort(),
        [...owned.profiles].sort(),
      );
      return snapshot;
    };
    let rootMoved = false;
    let journeyFailure;
    let cleanupFailure;
    let artifactFailure;
    const missingRoot = `${owned.directory}-unavailable`;
    try {
      assert.deepEqual(command(["source", "list"]), []);
      await click(
        By.xpath(
          '//nav[@aria-label="Primary navigation"]//button[./span[normalize-space(.)="Settings"]]',
        ),
      );
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      report.observations.initial_scan = await scan();
      assert.deepEqual(command(["source", "list"]), [], "Discovery must never register sources");
      const sourceRow = await browser.findElement(row(owned.profiles[1]));
      const associationText = `Catalog ports using this profile: ${command(["catalog", "list"])
        .filter((port) => port.bios_source_profile === owned.profiles[1])
        .map((port) => port.name)
        .join(", ")}`;
      await browser.executeScript(
        (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
        sourceRow,
      );
      report.observations.source_metadata_presentation = await browser.wait(
        () =>
          browser.executeScript(
            (element, expectedAssociation) => {
              const spans = [...element.querySelectorAll("span")];
              const size = spans.find((span) => span.textContent.trim() === "37 B");
              const association = spans.find(
                (span) => span.textContent.trim() === expectedAssociation,
              );
              if (!size || !association) return null;
              const clipping = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
              for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                if (
                  style.display === "none" ||
                  style.visibility !== "visible" ||
                  Number(style.opacity) === 0 ||
                  ancestor.getAnimations().some((animation) => animation.playState === "running")
                )
                  return null;
                const bounds = ancestor.getBoundingClientRect();
                if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
                  clipping.left = Math.max(clipping.left, bounds.left + ancestor.clientLeft);
                  clipping.right = Math.min(
                    clipping.right,
                    bounds.left + ancestor.clientLeft + ancestor.clientWidth,
                  );
                }
                if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
                  clipping.top = Math.max(clipping.top, bounds.top + ancestor.clientTop);
                  clipping.bottom = Math.min(
                    clipping.bottom,
                    bounds.top + ancestor.clientTop + ancestor.clientHeight,
                  );
                }
              }
              const textRects = (span) => {
                const range = document.createRange();
                range.selectNodeContents(span);
                return [...range.getClientRects()].map((rect) => rect.toJSON());
              };
              const sizeRects = textRects(size);
              const associationRects = textRects(association);
              const framed = (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= clipping.left &&
                rect.top >= clipping.top &&
                rect.right <= clipping.right &&
                rect.bottom <= clipping.bottom;
              if (
                !sizeRects.length ||
                !associationRects.length ||
                ![...sizeRects, ...associationRects].every(framed) ||
                Math.min(...associationRects.map((rect) => rect.top)) <
                  Math.max(...sizeRects.map((rect) => rect.bottom))
              )
                return null;
              return {
                size: size.textContent.trim(),
                association: association.textContent.trim(),
                size_rects: sizeRects,
                association_rects: associationRects,
                clipping,
                viewport: {
                  width: innerWidth,
                  height: innerHeight,
                  device_scale: devicePixelRatio,
                },
              };
            },
            sourceRow,
            associationText,
          ),
        5_000,
        "The settled source size and Catalog association must be fully framed on separate lines",
      );
      report.observations.source_metadata_presentation.window = await browser
        .manage()
        .window()
        .getRect();
      const metadataScreenshot = path.join(output, "selected-setup-source-metadata.png");
      await writeFile(metadataScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(metadataScreenshot);
      await reviewCandidate(owned.profiles[0]);
      assertOwnedSelectedSetupPath(
        await browser.findElement(review).findElement(By.css("code")).getText(),
        owned.gamePath,
      );
      const reviewedA = await plan(owned.profiles[0], owned.gamePath);
      assert.match(reviewedA.plan_sha256, /^[a-f0-9]{64}$/);
      assert.equal(reviewedA.source.sha256, expectedGameSha256);
      assertOwnedSelectedSetupPath(reviewedA.source.path, owned.gamePath);
      assert.deepEqual(command(["source", "list"]), [], "Review must remain non-mutating");
      await writeFile(owned.gamePath, owned.replacement);
      const freshB = await plan(owned.profiles[0], owned.gamePath);
      assert.notEqual(freshB.plan_sha256, reviewedA.plan_sha256);
      assert.notEqual(freshB.source.sha256, reviewedA.source.sha256);
      assert.equal(freshB.source.sha256, expectedReplacementSha256);
      assert.equal(freshB.source.path, reviewedA.source.path);
      report.observations.changed_input = { reviewed_a: reviewedA, admitted_b: freshB };
      const reviewedInputs = path.join(output, "selected-setup-reviewed-inputs.json");
      await writeFile(
        reviewedInputs,
        `${JSON.stringify(report.observations.changed_input, null, 2)}\n`,
        { flag: "wx" },
      );
      artifacts.push(reviewedInputs);
      await click(button("Use current location"));
      const refusal = By.xpath(
        '//p[@role="alert" and normalize-space(.)="The selection changed or another operation is using it. Review its current state."]',
      );
      await browser.wait(until.elementLocated(refusal), 15_000);
      report.observations.changed_input = {
        reviewed_a: reviewedA,
        admitted_b: freshB,
        refusal: await browser.findElement(refusal).getText(),
        activities: command(["activity"]).records,
      };
      const failedImport = report.observations.changed_input.activities.find(
        (item) =>
          item.operation === "import_source" &&
          item.target_id === owned.profiles[0] &&
          item.status === "failed",
      );
      assert.equal(failedImport?.failure?.code, "conflict");
      assert.ok(failedImport.failure.message.includes("changed after review"));
      report.observations.changed_input.failed_import = failedImport;
      assert.deepEqual(
        command(["source", "list"]),
        [],
        "Stale consent must not publish a registration",
      );
      await click(button("Cancel review"));
      await writeFile(owned.gamePath, owned.game);
      report.observations.rescan = await scan();
      await reviewCandidate(owned.profiles[0]);
      report.observations.new_a_review = await plan(owned.profiles[0], owned.gamePath);
      await click(button("Use current location"));
      const continuation = By.css('[aria-label="Continue to a game"]');
      await waitSelectedSetupCommit(
        browser,
        [fixture.port, fixture.refreshPort].map((port) => `Open ${port.name} details`),
      );
      const registeredGame = command(["source", "list"]);
      assert.equal(registeredGame.length, 1);
      assert.equal(registeredGame[0].profile_id, owned.profiles[0]);
      assert.equal(registeredGame[0].path, reviewedA.source.path);
      assert.equal(registeredGame[0].sha256, reviewedA.source.sha256);
      const expectedButtons = [fixture.port, fixture.refreshPort]
        .map((port) => `Open ${port.name} details`)
        .sort();
      const actualButtons = await Promise.all(
        (await browser.findElement(continuation).findElements(By.css("button"))).map((element) =>
          element.getText(),
        ),
      );
      assert.deepEqual(
        actualButtons.sort(),
        expectedButtons,
        "Shared game identity must preserve both distinct port choices",
      );
      report.observations.game_registered = registeredGame;
      await browser.executeScript(
        'arguments[0].scrollIntoView({ block: "center" });',
        await browser.findElement(continuation),
      );
      report.observations.continuation_geometry = await browser.executeScript(() => {
        const section = document.querySelector('[aria-label="Continue to a game"]');
        const bounds = section.getBoundingClientRect();
        return {
          text: section.textContent.trim(),
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          viewport: { width: innerWidth, height: innerHeight },
        };
      });
      const committedScreenshot = path.join(output, "selected-setup-game-registered.png");
      await writeFile(committedScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(committedScreenshot);
      report.observations.missing_bios_status = command(["status", fixture.refreshPort.id]);
      assert.ok(
        report.observations.missing_bios_status.readiness.blockers.includes("missing_bios"),
      );
      report.observations.missing_bios_plan = command(["plan", fixture.refreshPort.id]);
      assert.equal(
        report.observations.missing_bios_plan.source_requirements.find(
          (item) => item.role === "bios",
        ).registered,
        false,
      );
      for (const port of [fixture.port, fixture.refreshPort]) {
        await click(button(`Open ${port.name} details`));
        await browser.wait(
          until.elementLocated(By.css('[aria-label="Back to previous workspace"]')),
          5_000,
        );
        assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
        if (port === fixture.refreshPort)
          report.observations.missing_bios_detail = await selectedSetupDetail(browser, port, false);
        await click(By.css('[aria-label="Back to previous workspace"]'));
        await browser.wait(until.elementLocated(continuation), 5_000);
      }
      await reviewCandidate(owned.profiles[1]);
      assertOwnedSelectedSetupPath(
        await browser.findElement(review).findElement(By.css("code")).getText(),
        owned.biosPath,
      );
      const reviewedBios = await plan(owned.profiles[1], owned.biosPath);
      assertOwnedSelectedSetupPath(reviewedBios.source.path, owned.biosPath);
      assert.equal(reviewedBios.source.sha256, expectedBiosSha256);
      report.observations.bios_review = reviewedBios;
      assert.equal(command(["source", "list"]).length, 1, "BIOS review must not commit it");
      await click(button("Use current location"));
      await waitSelectedSetupCommit(browser, [`Open ${fixture.refreshPort.name} details`]);
      assert.equal(command(["source", "list"]).length, 2);
      const registered = command(["source", "list"]);
      for (const [profile, sourcePath, expectedHash] of [
        [owned.profiles[0], reviewedA.source.path, expectedGameSha256],
        [owned.profiles[1], reviewedBios.source.path, expectedBiosSha256],
      ]) {
        const source = registered.find((item) => item.profile_id === profile);
        assert.equal(source?.path, sourcePath);
        assert.equal(source.sha256, expectedHash);
      }
      report.observations.committed_registrations = registered;
      const statuses = await nativeRead("get_statuses");
      report.observations.authoritative_ports = [fixture.port, fixture.refreshPort].map((port) => {
        const status = command(["status", port.id]);
        assert.deepEqual(
          status,
          statuses.find((item) => item.port_id === port.id),
        );
        assert.equal(status.active, null);
        assert.equal(status.readiness.launchable, false);
        assert.equal(status.readiness.source, "not_checked");
        assert.ok(!status.readiness.blockers.includes("missing_source"));
        if (port === fixture.refreshPort) {
          assert.equal(status.readiness.bios, "not_checked");
          assert.ok(!status.readiness.blockers.includes("missing_bios"));
        }
        const installPlan = command(["plan", port.id]);
        assert.ok(installPlan.source_requirements.every((item) => item.registered));
        assert.deepEqual(
          installPlan.source_requirements.map((item) => item.profile_id).sort(),
          (port === fixture.refreshPort ? owned.profiles : [owned.profiles[0]]).slice().sort(),
        );
        return { status, install_plan: installPlan };
      });
      await click(button(`Open ${fixture.refreshPort.name} details`));
      report.observations.registered_bios_detail = await selectedSetupDetail(
        browser,
        fixture.refreshPort,
        true,
      );
      report.checkpoint = "registered-bios-return-control";
      await click(By.css('[aria-label="Back to previous workspace"]'));
      report.checkpoint = "registered-bios-return-continuation";
      await browser.wait(
        until.elementLocated(continuation),
        5_000,
        "Selected setup: return continuation after registered BIOS details",
      );
      report.checkpoint = "controlled-coverage-presentation";
      const registrationsBeforeCoverage = command(["source", "list"]);
      await scanCoveragePresentation({
        browser,
        snapshot: await nativeRead("get_game_file_scan_snapshot"),
        output,
        artifacts,
      });
      assert.deepEqual(command(["source", "list"]), registrationsBeforeCoverage);
      report.checkpoint = "unavailable-root-refresh";
      await rename(owned.directory, missingRoot);
      rootMoved = true;
      await click(button("Refresh folders"));
      report.checkpoint = "unavailable-root-disabled-review";
      await browser.wait(
        async () =>
          !(await browser
            .findElement(row(owned.profiles[0]))
            .findElement(By.css("[data-candidate-review]"))
            .isEnabled()),
        5_000,
        "Selected setup: stale review disabled after unavailable-root refresh",
      );
      report.checkpoint = "unavailable-root-observations";
      const snapshot = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(snapshot.freshness, "inputs_changed");
      const roots = command(["source", "roots", "list"]);
      const savedRoot = roots.find((item) => item.id === owned.root.id);
      assertOwnedSelectedSetupPath(savedRoot.path, owned.directory);
      assert.equal(savedRoot.availability, "unavailable");
      assert.deepEqual(command(["source", "list"]), registered);
      const inspection = command(["source", "inspect", owned.profiles[0]]);
      assert.equal(inspection.health, "missing");
      for (const profile of owned.profiles)
        assert.equal(
          await browser
            .findElement(row(profile))
            .findElement(By.css("[data-candidate-review]"))
            .isEnabled(),
          false,
        );
      report.observations.unavailable = {
        roots,
        snapshot,
        inspection,
        registrations: command(["source", "list"]),
        controls: await browser.executeScript(() =>
          [...document.querySelectorAll("[data-completed-candidate] button")].map((button) => ({
            text: button.textContent.trim(),
            disabled: button.disabled,
          })),
        ),
      };
      assert.ok(report.observations.unavailable.controls.every((item) => item.disabled));
      report.observations.unavailable.scan_enabled = await browser
        .findElement(button("Scan saved folders"))
        .isEnabled();
      assert.equal(await browser.findElement(button("Refresh folders")).isEnabled(), true);
      const screenshot = path.join(output, "selected-setup-unavailable.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      report.observations.viewport = await browser.executeScript(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      report.observations.window = await browser.manage().window().getRect();
      assert.equal(
        fixture.requests.length,
        0,
        "Read-only plans must not acquire or install the inert package",
      );
    } catch (error) {
      journeyFailure = error;
      await recordSelectedSetupFailure(browser, report, error);
    } finally {
      try {
        if (rootMoved) await rename(missingRoot, owned.directory);
        await writeFile(owned.gamePath, owned.game);
        assert.deepEqual(await readFile(owned.gamePath), await readFile(owned.gameBefore));
        assert.deepEqual(await readFile(owned.biosPath), await readFile(owned.biosBefore));
        report.original_inputs_restored = true;
      } catch (error) {
        cleanupFailure = error;
        report.cleanup_failure = String(error);
      }
      const artifact = path.join(output, "selected-setup-journey.json");
      try {
        await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        artifacts.push(artifact);
      } catch (error) {
        // Retain both observations in the harness log if its artifact cannot be written.
        console.error(JSON.stringify({ report, artifact_write_failure: String(error) }));
        artifactFailure = error;
      }
    }
    // Cleanup/report failures must not replace the original journey error.
    if (journeyFailure) throw journeyFailure;
    if (cleanupFailure) throw cleanupFailure;
    if (artifactFailure) throw artifactFailure;
  });
}
