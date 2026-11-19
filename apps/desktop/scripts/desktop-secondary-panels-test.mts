import type { WebElement } from "selenium-webdriver";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { captureKeyboardTarget } from "./desktop-capture-target.mts";
import { beginSecondaryPanelProbe } from "./desktop-secondary-panels-probe.mts";
import { secondaryPanelFixtures } from "./desktop-secondary-panels-fixture.mts";
import { requireTrustedProbeCleanup } from "./desktop-owned-ipc-probe.mts";
import { fixtureObject, fixtureSuccess } from "./desktop-scenario-state.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  captureAccessibilityReport,
  clearCatalogFilters,
  clickVisible,
  revealDetailSection,
  reviewControls,
  selectCatalogPort,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";

export interface SecondaryPanelsContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  /** The isolated library selected by this native run's owned lifecycle. */
  library: string;
  /** An already installed, disposable runtime owned by this native run. */
  portId: string;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}

/** Production WebView inspection with supplied secondary-panel states and owned files. */
export async function secondaryPanelsScenario(context: SecondaryPanelsContext) {
  const { browser, scenario, library, output, artifacts, invoke, portId, confirmNative } = context;
  await scenario("native-secondary-panel-presentation", async () => {
    assert.ok(path.isAbsolute(library), "The owned library must be an absolute path");
    const readOwnedBootstrap = async () => {
      const value = fixtureObject(fixtureSuccess(await invoke("get_bootstrap_status")));
      assert.ok(typeof value.library_root === "string" && path.isAbsolute(value.library_root));
      assert.equal(
        path.relative(
          path.toNamespacedPath(path.resolve(library)),
          path.toNamespacedPath(path.resolve(value.library_root)),
        ),
        "",
        "The selected library must be this native run's exact owned library",
      );
      return value;
    };
    const bootstrap = await readOwnedBootstrap();
    const generation = bootstrap.generation;
    assert.ok(typeof generation === "number" && Number.isSafeInteger(generation));
    const workspace = fixtureObject(
      fixtureSuccess(await invoke("get_workspace_snapshot", { generation })),
    );
    assert.ok(Array.isArray(workspace.statuses));
    const status: unknown = workspace.statuses.find(
      (entry: unknown) => isRecord(entry) && entry.port_id === portId,
    );
    assert.ok(isRecord(status) && isRecord(status.active), "An owned active fixture is required");
    const installId = status.active.id;
    assert.equal(typeof installId, "string");
    assert.ok(typeof installId === "string");
    const installPath = status.active.path;
    assert.ok(typeof installPath === "string" && path.isAbsolute(installPath));
    const relativeInstall = path.relative(
      path.toNamespacedPath(output),
      path.toNamespacedPath(installPath),
    );
    assert.ok(
      relativeInstall && !relativeInstall.startsWith("..") && !path.isAbsolute(relativeInstall),
      "The active installation must belong to this native run's output directory",
    );
    const fixtures = secondaryPanelFixtures(portId, output, installId);
    const files = {
      dat: path.join(output, "owned-secondary.dat"),
      invalidDat: path.join(output, "owned-secondary-invalid.dat"),
      recipe: path.join(output, "owned-secondary-recipe.json"),
      portableInput: path.join(output, "owned-secondary-saves.json"),
      portableOutput: path.join(output, "owned-secondary-export.json"),
      metadata: path.join(output, "owned-secondary-library.json"),
      refusedMetadata: path.join(output, "owned-secondary-library-refused.json"),
    };
    await writeFile(
      files.dat,
      `<datafile><header><name>Owned native presentation DAT with a long display name</name><version>1</version></header><game name="Owned example"><rom name="owned.bin" size="4" sha1="${"1".repeat(40)}"/></game></datafile>`,
      { flag: "wx" },
    );
    await writeFile(files.invalidDat, "<datafile>", { flag: "wx" });
    await writeFile(files.recipe, JSON.stringify({ fixture: "native presentation recipe" }), {
      flag: "wx",
    });
    await writeFile(files.portableInput, JSON.stringify({ fixture: "native presentation saves" }), {
      flag: "wx",
    });
    artifacts.push(files.dat, files.invalidDat, files.recipe, files.portableInput);
    const originalWindow = await browser.manage().window().getRect();
    const probe = await beginSecondaryPanelProbe(browser, {
      generation,
      fixtures,
      recipePath: files.recipe,
      portableInputPath: files.portableInput,
      portableOutputPath: files.portableOutput,
      metadataPath: files.metadata,
      refusedMetadataPath: files.refusedMetadata,
    });
    const { button, click } = reviewControls(browser);
    const stages: { name: string; geometry: unknown }[] = [];
    const report: Record<string, unknown> = {
      synthetic: true,
      scope:
        "Native rendering and interaction with supplied secondary-panel replies. DAT add/remove, the successful library export, Ready and theme preferences use the isolated Core and owned files. Ordinary background requests, including standing setup, retain the production transport.",
      port_id: portId,
      generation,
      install_id: installId,
      stages,
    };
    let primaryFailure: unknown;
    let actionFailed = false;

    const findButton = async (name: string) => {
      let result: WebElement | undefined;
      await browser.wait(
        async () => {
          for (const candidate of await browser.findElements(By.css("button"))) {
            if ((await candidate.isDisplayed()) && (await candidate.getAccessibleName()) === name) {
              result = candidate;
              return true;
            }
          }
          return false;
        },
        15_000,
        `Missing secondary-panel action ${name}`,
      );
      assert.ok(result);
      return result;
    };
    const focused = async (element: WebElement) =>
      browser.wait(
        () =>
          executeBrowserScript(browser, (element) => document.activeElement === element, element),
        10_000,
        "Secondary-panel focus did not return to its surviving control",
      );
    const text = async (value: string) =>
      browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (value) => document.body.textContent?.includes(value),
            value,
          ),
        15_000,
        `Secondary-panel feedback did not appear: ${value}`,
      );
    const capture = async (name: string, target?: WebElement) => {
      if (target)
        await executeBrowserScript(
          browser,
          (element) => element.scrollIntoView({ block: "center", inline: "nearest" }),
          target,
        );
      const visualTarget =
        target ??
        (await executeBrowserScript(browser, () => {
          const dialogHeading = document.querySelector('[role="dialog"] h2');
          return (
            dialogHeading ??
            [...document.querySelectorAll('[role="alert"]')].find(
              (element) =>
                element.getClientRects().length > 0 && !element.closest("[hidden], [inert]"),
            ) ??
            null
          );
        }));
      assert.ok(visualTarget, "The secondary state needs an exact visible capture target");
      await captureKeyboardTarget(
        { browser, output, artifacts },
        `secondary-${name}`,
        visualTarget,
        "native-secondary-panel-presentation",
      );
      const geometry = await executeBrowserScript(browser, () => {
        const popup = document.querySelector<HTMLElement>('[role="dialog"]');
        const main = document.querySelector<HTMLElement>(".workspace-main");
        const scope = popup ?? main;
        if (!scope) throw new Error("Presentation scope is missing");
        const active = document.activeElement;
        const bounds = active?.getBoundingClientRect();
        return {
          theme: document.documentElement.dataset.theme,
          viewport: { width: innerWidth, height: innerHeight },
          document_overflow: document.documentElement.scrollWidth > innerWidth + 1,
          scope_overflow: scope.scrollWidth > scope.clientWidth + 1,
          focused:
            active instanceof HTMLElement
              ? {
                  tag: active.tagName,
                  id: active.id,
                  name:
                    active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 180),
                  visible: Boolean(
                    bounds &&
                    bounds.width > 0 &&
                    bounds.height > 0 &&
                    bounds.right > 0 &&
                    bounds.left < innerWidth &&
                    bounds.bottom > 0 &&
                    bounds.top < innerHeight,
                  ),
                }
              : null,
        };
      });
      assert.equal(geometry.document_overflow, false, name);
      assert.equal(geometry.scope_overflow, false, name);
      stages.push({ name, geometry });
    };
    const settings = async (id: string) => {
      await selectPrimaryNavigation(browser, "Settings");
      await click(
        By.css(`nav[aria-label="Settings categories"] button[aria-controls="settings-${id}"]`),
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (id) => document.activeElement?.id === `settings-${id}-heading`,
            id,
          ),
        5_000,
      );
    };
    const openDetails = async () => {
      await selectPrimaryNavigation(browser, "Discover");
      const search = await browser.findElement(By.id("port-search"));
      await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, portId);
      await clearCatalogFilters(browser);
      await selectCatalogPort(browser, portId);
    };
    const openMods = async () => {
      await openDetails();
      await revealDetailSection(browser, "Mods");
      await text("Setups and mods");
      const installed = await browser.findElement(By.css(".mod-workspace-views button:last-child"));
      await clickVisible(browser, installed);
    };
    const openSaves = async () => {
      await openDetails();
      await revealDetailSection(browser, "Saves & backups");
    };
    const observedAction = async (command: string, action: () => Promise<unknown>) => {
      const previous = (await probe.capture()).trace.filter(
        (entry) => entry.command === command,
      ).length;
      await action();
      await browser.wait(
        async () =>
          (await probe.capture()).trace.filter((entry) => entry.command === command).length >
          previous,
        15_000,
        `Presentation command was not intercepted: ${command}`,
      );
    };

    const cleanupScenario = async () => {
      const cleanup = await probe.restore().catch((error: unknown) => ({
        restored: false,
        trustworthy: false,
        error: errorMessage(error),
      }));
      report.probe = cleanup;
      if (!cleanup.trustworthy) report.outcome = "failed";
      const receipt = path.join(output, "secondary-panels-observations.json");
      let receiptFailure: unknown;
      let receiptFailed = false;
      try {
        await writeFile(receipt, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
        artifacts.push(receipt);
      } catch (error) {
        receiptFailed = true;
        receiptFailure = error;
        console.error("Could not write the secondary-panel observation receipt", error);
      }
      requireTrustedProbeCleanup(cleanup, actionFailed ? primaryFailure : receiptFailure);
      if (receiptFailed && !actionFailed) throw receiptFailure;
      try {
        await browser.manage().window().setRect(originalWindow);
      } catch (error) {
        if (!actionFailed) throw error;
        console.error("Could not restore the secondary-panel window after failure", error);
      }
    };

    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await settings("game-files");
      const datBefore = fixtureSuccess(await invoke("get_dat_references"));
      assert.deepEqual(datBefore, [], "Use a fresh owned preferences scope");
      const addDat = await findButton("Add DAT file");
      await clickVisible(browser, addDat);
      await confirmNative("Choose a DAT file", "Cancel", "File name:", "secondary-dat-cancel");
      await focused(addDat);
      await clickVisible(browser, addDat);
      await confirmNative(
        "Choose a DAT file",
        "Open",
        "File name:",
        "secondary-dat-invalid",
        files.invalidDat,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.querySelector('[aria-label="DAT files"] [role="alert"]') !== null,
          ),
        10_000,
      );
      assert.deepEqual(fixtureSuccess(await invoke("get_dat_references")), []);
      await capture("dat-refused", addDat);
      await clickVisible(browser, addDat);
      await confirmNative(
        "Choose a DAT file",
        "Open",
        "File name:",
        "secondary-dat-valid",
        files.dat,
      );
      await text("Owned native presentation DAT with a long display name");
      const references = fixtureSuccess(await invoke("get_dat_references"));
      assert.ok(Array.isArray(references) && references.length === 1);
      await capture("dat-added", addDat);
      const remove = await browser.findElement(
        By.css('[aria-label="DAT files"] button[data-dat-id]'),
      );
      await clickVisible(browser, remove);
      await text("No DAT files added.");
      await focused(addDat);
      assert.deepEqual(fixtureSuccess(await invoke("get_dat_references")), []);

      // A real preference change asks the mounted notice component to assess again.
      const noticeSwitch = await browser.wait(
        until.elementLocated(
          By.xpath(
            '//label[contains(., "Tell me when games I chose to hear about are ready")]//*[@role="checkbox"]',
          ),
        ),
        15_000,
      );
      await browser.wait(
        async () => (await noticeSwitch.getAttribute("data-disabled")) === null,
        15_000,
        "Ready notice settings did not finish loading",
      );
      for (let change = 0; change < 2; change++) {
        const before = await noticeSwitch.getAttribute("aria-checked");
        await clickVisible(browser, noticeSwitch);
        await browser.wait(
          async () =>
            (await noticeSwitch.getAttribute("aria-checked")) !== before &&
            (await noticeSwitch.getAttribute("data-disabled")) === null,
          15_000,
        );
      }
      const dismiss = await browser.wait(
        until.elementLocated(
          By.css('[data-settings-group="game-files"] button[aria-labelledby*="-dismiss"]'),
        ),
        15_000,
      );
      await clickVisible(browser, dismiss);
      await text("Couldn’t confirm dismissal. Try Dismiss again.");
      await focused(dismiss);
      await capture("ready-acknowledgement-refused", dismiss);
      await dismiss.sendKeys(Key.ENTER);
      await browser.wait(until.stalenessOf(dismiss), 10_000);
      assert.equal((await probe.capture()).acknowledged, true);

      await settings("library-storage");
      await click(By.xpath('//summary[normalize-space(.)="Prepare a recovery copy"]'));
      const exportMetadata = await findButton("Export library information");
      assert.equal(
        (await readOwnedBootstrap()).generation,
        generation,
        "The owned library generation must remain unchanged before metadata export",
      );
      await clickVisible(browser, exportMetadata);
      await confirmNative(
        "Export library information",
        "Save",
        "File name:",
        "secondary-metadata-save",
        files.metadata,
        undefined,
        false,
        output,
      );
      await text("Library information was last exported to");
      assert.ok(isRecord(JSON.parse(await readFile(files.metadata, "utf8"))));
      artifacts.push(files.metadata);
      await capture("metadata-exported", exportMetadata);
      await clickVisible(browser, exportMetadata);
      await confirmNative(
        "Export library information",
        "Save",
        "File name:",
        "secondary-metadata-refused",
        files.refusedMetadata,
        undefined,
        false,
        output,
      );
      await text("Owned presentation metadata export refusal.");
      await focused(exportMetadata);
      await capture("metadata-export-refused", exportMetadata);
      assert.equal(
        await stat(files.refusedMetadata).then(
          () => true,
          () => false,
        ),
        false,
      );

      for (const theme of ["dark", "light"]) {
        await settings("appearance");
        await click(
          By.xpath(
            `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
          ),
        );
        await probe.phase("mods");
        await openMods();
        const original = await findButton("Review original game files");
        await clickVisible(browser, original);
        await text("Other registered originals");
        await capture(`${theme}-original-choice`, original);
        const choice = await executeBrowserScript(browser, () => {
          const label = [...document.querySelectorAll("span")].find(
            (element) => element.textContent?.trim() === "Other registered originals",
          );
          return (
            [...document.querySelectorAll('[role="combobox"]')].find(
              (element) =>
                label && element.getAttribute("aria-labelledby")?.split(" ").includes(label.id),
            ) ?? null
          );
        });
        assert.ok(choice);
        await clickVisible(browser, choice);
        const [alternativeOriginal] = fixtures.original.instances;
        assert.ok(alternativeOriginal);
        const alternativeName = path.basename(alternativeOriginal.path);
        const alternative = await browser.wait(
          until.elementLocated(
            By.xpath(
              `//*[@role="option"][contains(normalize-space(.),${JSON.stringify(alternativeName)})]`,
            ),
          ),
          5_000,
          "The reviewed alternative original must be available in the open list",
        );
        await clickVisible(browser, alternative);
        await observedAction("select_mod_setup_original", () => click(button("Use this original")));
        await text("Owned presentation fixture refused this action.");
        await capture(`${theme}-original-refused`, original);

        await openMods();
        const recipe = await findButton("Open setup recipe…");
        await clickVisible(browser, recipe);
        await confirmNative(
          "Open setup recipe…",
          "Open",
          "File name:",
          `secondary-${theme}-recipe-open`,
          files.recipe,
        );
        await text("Recipe review");
        const check = await findButton(`Check provider for ${fixtures.modName}`);
        await capture(`${theme}-recipe-review`, check);
        await observedAction("acquire_mod_recipe_package", () => clickVisible(browser, check));
        await text("Owned presentation fixture refused this action.");
        await focused(check);
        await capture(`${theme}-recipe-provider-refused`, check);
        await click(button("Close review"));
        await focused(recipe);

        await openMods();
        await click(button("Browse mods"));
        await click(button(fixtures.providerProject.project.name));
        await click(button(`Add ${fixtures.providerPlan.file.file_name}`));
        await click(button("Review changes"));
        await click(button("Check files"));
        const install = await findButton("Apply changes");
        await capture(`${theme}-provider-review`, install);
        await observedAction("apply_mod_setup_draft", () => clickVisible(browser, install));
        await text("Owned presentation fixture refused this action.");
        await capture(`${theme}-provider-refused`);

        await openMods();
        await click(button("Retained game versions"));
        const retirement = await findButton(
          `Review retiring ${fixtures.retirement.revision.build.artifact.asset_name} (offer 1)`,
        );
        await clickVisible(browser, retirement);
        await text("Retire recovery offer 1?");
        const retire = await findButton("Retire recovery offer");
        await capture(`${theme}-retirement-review`, retire);
        await observedAction("retire_mod_setup_recovery_build", () => retire.sendKeys(Key.ENTER));
        await text("Portcove could not confirm retirement.");
        await capture(`${theme}-retirement-refused`);
        await browser.actions().sendKeys(Key.ESCAPE).perform();
        await focused(retirement);

        await probe.phase("preservation");
        await openMods();
        const reviewFile = await findButton(`Review ${fixtures.modName}`);
        await clickVisible(browser, reviewFile);
        const preserve = await findButton("Preserve file");
        await capture(`${theme}-file-preservation-review`, preserve);
        await observedAction("preserve_mod_file", () => preserve.sendKeys(Key.ENTER));
        await text("Owned presentation fixture refused this action.");
        await focused(reviewFile);
        await capture(`${theme}-file-preservation-refused`, reviewFile);

        await probe.phase("mods");
        await openSaves();
        const exportSaves = await findButton("Export saves…");
        await clickVisible(browser, exportSaves);
        await confirmNative(
          "Export saves",
          "Save",
          "File name:",
          `secondary-${theme}-saves-export`,
          files.portableOutput,
          undefined,
          false,
          output,
        );
        await text("The saves could not be exported.");
        await focused(exportSaves);
        await capture(`${theme}-portable-export-refused`, exportSaves);
        assert.equal(
          await stat(files.portableOutput).then(
            () => true,
            () => false,
          ),
          false,
        );
        const importSaves = await findButton("Import saves…");
        await clickVisible(browser, importSaves);
        await confirmNative(
          "Import saves",
          "Open",
          "File name:",
          `secondary-${theme}-saves-import`,
          files.portableInput,
        );
        await text("Replace this device’s saves with these (they stay in a backup)");
        await capture(`${theme}-portable-import-conflict`, importSaves);
      }
      const accessibility = path.join(output, "secondary-panels-accessibility.json");
      await captureAccessibilityReport(browser, accessibility, artifacts);
      report.outcome = "passed";
    } catch (error) {
      actionFailed = true;
      primaryFailure = error;
      report.outcome = "failed";
      report.failure = errorMessage(error);
      throw error;
    } finally {
      await cleanupScenario();
    }
  });
}
