import {
  fixtureSuccess as success,
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type { ArtworkSlot, GeneratedArtworkFallback } from "../src/transport-types.generated.d.ts";
import { transportValue } from "./transport-values.mts";
interface ArtworkContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  command: FixtureCommand;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
// Owned local artwork exercises real file selection, core IPC and rendered images.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  revealDetailSection,
  assertCompactReview,
  captureAccessibilityReport,
  reviewControls,
  selectCatalogPort,
  clearCatalogFilters,
} from "./desktop-review-controls.mts";
import { artworkObservations } from "./desktop-artwork-observations.mts";
import { readWorkspaceSnapshotObservation } from "./desktop-review-observation.mts";

export async function readArtworkFallback(
  browser: Pick<ScenarioContext["browser"], "executeScript">,
  selector: string,
  paletteIndex: number,
  quiet: boolean,
) {
  return executeBrowserScript(
    browser,
    (selector, paletteIndex, quiet) => {
      const frame = document.querySelector<HTMLElement>(selector);
      if (!frame) throw new Error("Artwork frame unavailable");
      const roles = ["neutral", "yellow", "blue", "indigo", "green", "red"];
      const role = roles[paletteIndex];
      if (!role) throw new Error("Unknown generated artwork palette");
      const token = quiet ? "--color-bg-subtle" : `--color-art-${role}`;
      const computed = getComputedStyle(frame);
      const probe = document.createElement("span");
      probe.style.display = "none";
      probe.style.backgroundColor = `var(${token})`;
      document.body.append(probe);
      let expectedBackground: string;
      try {
        expectedBackground = getComputedStyle(probe).backgroundColor;
      } finally {
        probe.remove();
      }
      return {
        source: frame.dataset.artworkSource,
        initials: frame.querySelector(":scope > span")?.textContent?.trim(),
        images: frame.querySelectorAll("img").length,
        decorativeIcon: Boolean(frame.querySelector(':scope > span > svg[aria-hidden="true"]')),
        palette: computed.getPropertyValue("--art-color").trim(),
        expectedPalette: getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
        background: computed.backgroundColor,
        expectedBackground,
      };
    },
    selector,
    paletteIndex,
    quiet,
  );
}

export function readArtworkGeometry(browser: Pick<ScenarioContext["browser"], "executeScript">) {
  return executeBrowserScript(browser, () => {
    const frame = document.querySelector(".game-hero-detail .game-hero-foreground");
    if (!frame) throw new Error("Artwork frame unavailable");
    const image = frame.querySelector("img");
    if (!image) throw new Error("Artwork image unavailable");
    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || !image.naturalWidth || !image.naturalHeight)
      throw new Error("Artwork image has no visible decoded footprint");
    return {
      ratio: image.naturalWidth / image.naturalHeight,
      fit: getComputedStyle(image).objectFit,
      titleOutsideImage: !frame.contains(document.querySelector("#port-detail-title")),
    };
  });
}

export async function waitForArtworkImage(
  browser: Pick<ScenarioContext["browser"], "wait" | "executeScript">,
  selector: string,
  revealSelector = selector.replace(/ img$/, ""),
) {
  const frame = await browser.wait(until.elementLocated(By.css(revealSelector)), 10_000);
  await executeBrowserScript(browser, 'arguments[0].scrollIntoView({ block: "center" });', frame);
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (selector) => {
          const image = document.querySelector<HTMLImageElement>(selector);
          return Boolean(image?.complete && image.naturalWidth > 0);
        },
        selector,
      ),
    10_000,
    `Core thumbnail must render in ${selector}`,
  );
}

export async function artworkScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  command,
  confirmNative,
}: ArtworkContext) {
  await scenario("native-local-artwork-picker-and-recovery", async () => {
    const observations = artworkObservations({ browser, output, artifacts });
    const workspaceReadbacks: unknown[] = [];
    let failure;
    try {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        success(await invoke("get_bootstrap_status")),
      );
      const libraryRoot = await realpath(required(bootstrap.library_root));
      const ownedRelative = path.relative(await realpath(output), libraryRoot);
      assert.ok(
        ownedRelative && !ownedRelative.startsWith("..") && !path.isAbsolute(ownedRelative),
        "Artwork tests require the owned qualification library",
      );
      // This owned fixture deliberately has no catalog artwork mapping. Real
      // ports can gain a default cover without changing fallback semantics.
      const portId = "portcove-install-fixture";
      // The qualification fixture belongs to the running application's catalog,
      // not the standalone CLI's ordinary catalog.
      const catalog = transportValue("catalog", success(await invoke("get_catalog")));
      const port = required(catalog.ports.find((candidate) => candidate.id === portId));
      const source = path.join(output, "owned-local-artwork.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQCFgAAAGMAQm4OT/aAAAAAElFTkSuQmCC",
        "base64",
      );
      await writeFile(source, bytes, { flag: "wx" });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const { click } = reviewControls(browser);
      const editorTrigger = By.css("[data-artwork-editor-trigger]");
      const editor = By.css(".artwork-sheet[open]");
      const openEditor = async () => {
        await click(editorTrigger);
        await browser.wait(until.elementLocated(editor), 10_000);
      };
      const closeEditor = async () => {
        await click(By.css(".artwork-sheet[open] [data-artwork-editor-close]"));
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              () =>
                !document.querySelector(".artwork-sheet[open]") &&
                document.activeElement?.matches("[data-artwork-editor-trigger]") === true,
            ),
          10_000,
          "Closing artwork must return focus to Change artwork",
        );
      };
      const slots = ["cover", "detail", "landscape", "logo"] as const;
      const slotLabels: Record<ArtworkSlot, string> = {
        cover: "Cover image",
        detail: "Background",
        landscape: "Wide cover",
        logo: "Logo",
      };
      const activateSlot = (slot: ArtworkSlot) =>
        click(By.xpath(`//*[@role="tab" and normalize-space(.)="${slotLabels[slot]}"]`));
      const control = (slot: ArtworkSlot, label: string) =>
        By.xpath(
          `//section[@aria-label="${slotLabels[slot]}"]//button[normalize-space(.)="${label}"]`,
        );
      const state = async (slot: ArtworkSlot) => {
        const result = await invoke("get_artwork", {
          portId,
          slot,
          generation: bootstrap.generation,
        });
        return transportValue("artwork_state", success(result));
      };
      const readRoles = async (roles: readonly ArtworkSlot[]) => {
        // Each IPC observation temporarily changes the same WebDriver script budget.
        const observed = [];
        for (const role of roles) observed.push(await state(role));
        return observed;
      };
      const expectFallbackVisual = async (
        selector: string,
        fallback: GeneratedArtworkFallback,
        quiet = false,
      ) => {
        const expected = {
          source: "generated_fallback",
          initials: quiet ? "" : fallback.initials,
        };
        const frame = await browser.wait(until.elementLocated(By.css(selector)), 10_000);
        await executeBrowserScript(
          browser,
          'arguments[0].scrollIntoView({ block: "center" });',
          frame,
        );
        try {
          await browser.wait(async () => {
            const actual = await readArtworkFallback(
              browser,
              selector,
              fallback.palette_index,
              quiet,
            );
            return (
              actual.source === expected.source &&
              actual.initials === expected.initials &&
              actual.images === 0 &&
              (!quiet || actual.decorativeIcon) &&
              actual.palette.length > 0 &&
              actual.palette === actual.expectedPalette &&
              actual.background === actual.expectedBackground
            );
          }, 10_000);
        } catch (error) {
          throw new Error(
            `Fallback presentation did not settle: ${JSON.stringify(await readArtworkFallback(browser, selector, fallback.palette_index, quiet))}`,
            { cause: error },
          );
        }
        const actual = await readArtworkFallback(browser, selector, fallback.palette_index, quiet);
        assert.deepEqual({ source: actual.source, initials: actual.initials }, expected);
        assert.ok(actual.palette.length > 0);
        assert.equal(actual.images, 0);
        if (quiet) assert.equal(actual.decorativeIcon, true);
        assert.equal(actual.palette, actual.expectedPalette);
        assert.equal(actual.background, actual.expectedBackground);
      };
      const expectOverviewTextAndReturn = async () => {
        await closeEditor();
        await revealDetailSection(browser, "Overview");
        const hero = await browser.wait(until.elementLocated(By.css(".game-hero-detail")), 10_000);
        await executeBrowserScript(
          browser,
          (element) => element.scrollIntoView({ block: "center" }),
          hero,
        );
        const expectedTitle = port.presentation?.original_game_title?.trim() || port.name;
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (expectedTitle) => {
                const hero = document.querySelector(".game-hero-detail");
                const heading = hero?.querySelector("#port-detail-title");
                return (
                  hero?.getAttribute("data-hero-identity") === "text" &&
                  !hero.hasAttribute("data-hero-compact") &&
                  !hero.querySelector('[data-loading="true"]') &&
                  !hero.querySelector(".game-hero-image") &&
                  heading?.textContent?.trim() === expectedTitle &&
                  Boolean(
                    hero.querySelector('.detail-header-actions button[data-variant="primary"]'),
                  )
                );
              },
              expectedTitle,
            ),
          10_000,
          "Missing cover must retain the real game heading and primary action without a decorative image",
        );
        await revealDetailSection(browser, "Manage");
        await openEditor();
        await activateSlot("cover");
      };
      const open = async () => {
        await observations.capture("before-reload");
        await browser.navigate().refresh();
        await observations.begin();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          15_000,
        );
        // Check the real workspace after reload: a name search must not conceal
        // a missing qualification definition or discovery listing after refresh.
        const workspace = await readWorkspaceSnapshotObservation(
          invoke,
          bootstrap,
          workspaceReadbacks,
        );
        assert.deepEqual(
          required(workspace.catalog).ports.find((candidate) => candidate.id === port.id),
          port,
          "Artwork reload must retain the exact owned operational definition",
        );
        assert.equal(
          required(workspace.listing_catalog?.listings.find((listing) => listing.id === port.id))
            .name,
          port.name,
          "Artwork reload must retain the owned fixture in the discovery directory",
        );
        // Keep the reload above paired with observations.begin(); a second
        // reload here would discard its request observers.
        await click(By.xpath('//nav//button[contains(., "Discover")]'));
        const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await search.sendKeys(
          Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
          Key.BACK_SPACE,
          port.name,
        );
        await clearCatalogFilters(browser);
        await selectCatalogPort(browser, port.id);
        await revealDetailSection(browser, "Manage");
        await openEditor();
        // A reload can mount the Cover controls before its Core artwork read starts.
        await browser.wait(
          async () => {
            const [picker] = await browser.findElements(control("cover", "Choose local image"));
            return (
              picker !== undefined && (await picker.isDisplayed()) && (await picker.isEnabled())
            );
          },
          45_000,
          "The same Cover editor must finish loading and enable Choose local image",
        );
      };
      await open();
      const credentialRead = object(await invoke("get_steamgriddb_key_status"));
      const keyStatus =
        credentialRead.ok === true
          ? transportValue("steamgriddb_key_status", success(credentialRead))
          : undefined;
      let contextualKeySetup = keyStatus?.configured ? "configured-host" : "status-unavailable";
      if (keyStatus && !keyStatus.configured) {
        await activateSlot("detail");
        const beforeSetup = await state("detail");
        const find = control("detail", "Find on SteamGridDB");
        await browser.wait(
          until.elementIsEnabled(await browser.wait(until.elementLocated(find), 10_000)),
          10_000,
        );
        await click(find);
        await click(control("detail", "Set up SteamGridDB key"));
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              () =>
                document.activeElement?.matches(
                  '.artwork-sheet[open] section[aria-label="Background"] h3',
                ) === true &&
                document.activeElement.textContent?.trim() === "Set up your SteamGridDB key",
            ),
          10_000,
          "Contextual key setup must focus its heading within the chosen artwork role",
        );
        await click(control("detail", "Cancel key setup"));
        await browser.wait(
          () =>
            executeBrowserScript(browser, () => {
              const editor = document.querySelector(".artwork-sheet[open]");
              const active = document.activeElement;
              return (
                editor?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ===
                  "Background" &&
                active?.matches('section[aria-label="Background"] button') === true &&
                editor.contains(active) &&
                active.textContent?.trim() === "Set up SteamGridDB key" &&
                !editor.querySelector('input[type="password"]')
              );
            }),
          10_000,
          "Cancelling key setup must restore focus to its opener within Background",
        );
        assert.deepEqual(
          transportValue(
            "steamgriddb_key_status",
            success(await invoke("get_steamgriddb_key_status")),
          ),
          keyStatus,
        );
        assert.deepEqual(await state("detail"), beforeSetup);
        const screenshot = path.join(output, "artwork-contextual-key-return.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
        contextualKeySetup = "cancelled-and-returned";
        await click(find);
        await activateSlot("cover");
      }
      const keySetupEvidence = path.join(output, "artwork-contextual-key-return.json");
      await writeFile(
        keySetupEvidence,
        JSON.stringify({
          generation: bootstrap.generation,
          port_id: portId,
          role: "detail",
          outcome: contextualKeySetup,
        }),
        { flag: "wx" },
      );
      artifacts.push(keySetupEvidence);
      const before = await state("cover");
      assert.equal(before.resolved_source.kind, "generated_fallback");
      assert.match(before.generated_fallback.identity, /^[0-9a-f]{64}$/u);
      assert.equal(before.generated_fallback.style_version, 1);
      assert.ok(before.generated_fallback.palette_index >= 0);
      assert.ok(before.generated_fallback.palette_index < 6);
      await expectOverviewTextAndReturn();
      const stale = object(
        await invoke("reset_artwork", {
          portId,
          slot: "cover",
          expectedRevision: before.choice.revision,
          generation: bootstrap.generation + 1,
        }),
      );
      assert.equal(stale.ok, false);
      assert.equal(object(stale.error).code, "conflict");
      await click(control("cover", "Choose local image"));
      await confirmNative(
        "Choose local artwork",
        "Cancel",
        "File name:",
        "artwork-picker-cancelled",
      );
      await browser.wait(
        until.elementIsEnabled(await browser.findElement(control("cover", "Choose local image"))),
        10_000,
      );
      assert.deepEqual(await state("cover"), before);
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.activeElement?.textContent === "Choose local image",
          ),
        5000,
      );
      const importLocal = async (
        slot: ArtworkSlot,
        selectedPath = source,
        selectedDigest = digest,
      ) => {
        await activateSlot(slot);
        const previous = await state(slot);
        await browser.wait(
          async () => {
            const [picker] = await browser.findElements(control(slot, "Choose local image"));
            return (
              picker !== undefined && (await picker.isDisplayed()) && (await picker.isEnabled())
            );
          },
          45_000,
          `The ${slotLabels[slot]} editor must enable Choose local image`,
        );
        await click(control(slot, "Choose local image"));
        await confirmNative(
          "Choose local artwork",
          "Open",
          "File name:",
          `artwork-picker-${slot}`,
          selectedPath,
        );
        if (slot === "detail") {
          const narrow = await browser.wait(
            until.elementLocated(By.css('input[type="range"][name="narrow-x"]:enabled')),
            30_000,
            "The reviewed Background framing control did not become actionable",
          );
          assert.deepEqual(await state(slot), previous);
          await narrow.sendKeys(Key.END);
          assert.equal(await narrow.getAttribute("aria-valuetext"), "100%");
          await browser.wait(
            () =>
              executeBrowserScript(browser, () => {
                const overview = document.querySelector<HTMLElement>(
                  ".game-hero-framing-preview-detail",
                );
                const continuation = document.querySelector<HTMLElement>(
                  ".game-hero-framing-preview-continue",
                );
                const wide = overview?.querySelector<HTMLImageElement>(".game-hero-background img");
                const narrow = continuation?.querySelector<HTMLImageElement>(
                  ".game-hero-background img",
                );
                return Boolean(
                  overview?.inert &&
                  continuation?.inert &&
                  wide?.naturalWidth &&
                  narrow?.naturalWidth &&
                  getComputedStyle(wide).objectPosition === "50% 35%" &&
                  getComputedStyle(narrow).objectPosition === "100% 35%" &&
                  getComputedStyle(narrow).maskImage !== "none",
                );
              }),
            10_000,
          );
          await click(
            By.xpath(
              '//form[.//h3[normalize-space(.)="Review Background"]]//button[normalize-space(.)="Apply"]',
            ),
          );
        } else {
          await browser.wait(
            until.elementLocated(
              By.xpath(`//form[.//h4[normalize-space(.)="Review ${slotLabels[slot]}"]]`),
            ),
            10_000,
          );
          assert.deepEqual(await state(slot), previous);
          // Job 137084499604 reached this review while artwork reads still took
          // 17.7 s. Wait for this form's actual Apply control before clicking once.
          const applyImage = By.xpath(
            `//form[.//h4[normalize-space(.)="Review ${slotLabels[slot]}"]]//button[normalize-space(.)="Apply" and not(@disabled) and not(@aria-disabled="true")]`,
          );
          await browser.wait(
            until.elementLocated(applyImage),
            45_000,
            `The reviewed ${slotLabels[slot]} Apply control did not become actionable`,
          );
          await click(applyImage);
        }
        // Hosted Windows job 136791041646 committed the Cover but still had an
        // earlier 16.35 s read and an in-flight thumbnail. Observe the exact
        // commit and the editor's settled readback before checking focus.
        const selected = await browser.wait(
          async () => {
            const observed = await state(slot);
            return observed.choice.asset_sha256 === selectedDigest ? observed : false;
          },
          60_000,
          "Core must record the selected artwork digest for this role",
        );
        assert.ok(selected);
        assert.equal(selected.choice.revision, previous.choice.revision + 1);
        const picker = await browser.findElement(control(slot, "Choose local image"));
        await browser.wait(
          until.elementIsEnabled(picker),
          60_000,
          "The artwork editor must settle after the committed role is read back",
        );
        try {
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                (element) => document.activeElement === element,
                picker,
              ),
            5_000,
            "Artwork focus did not return to the edited slot's picker after Apply",
          );
        } catch (error) {
          try {
            const focus = await executeBrowserScript(
              browser,
              (label) => {
                const dialog = document.querySelector<HTMLDialogElement>(
                  "dialog.artwork-sheet[open]",
                );
                const panel = dialog?.querySelector('section[aria-label="' + label + '"]');
                const pickers = [...(panel?.querySelectorAll("button") ?? [])].filter(
                  (button) => button.textContent?.trim() === "Choose local image",
                );
                const active = document.activeElement;
                return {
                  windowFocused: document.hasFocus(),
                  activeTag: active?.tagName,
                  activeRole: active?.getAttribute("role"),
                  activeLabel:
                    active instanceof HTMLButtonElement
                      ? active.textContent?.trim().slice(0, 120)
                      : undefined,
                  activeInEditor: Boolean(active && dialog?.contains(active)),
                  editorOpen: Boolean(dialog),
                  pickerCount: pickers.length,
                  pickerFocused: pickers.some((button) => button === active),
                  pickerDisabled: pickers[0]?.disabled,
                };
              },
              slotLabels[slot],
            );
            const evidence = path.join(output, "artwork-return-focus-" + slot + ".json");
            await writeFile(evidence, JSON.stringify(focus, null, 2), { flag: "wx" });
            artifacts.push(evidence);
          } catch (diagnosticError) {
            console.error("Artwork focus diagnostic unavailable", errorMessage(diagnosticError));
          }
          throw error;
        }
        return selected;
      };
      const importedCover = await importLocal("cover");
      const importedBackground = await importLocal("detail");
      await waitForArtworkImage(browser, ".wide-artwork img");
      const sheetScreenshot = path.join(output, "native-change-artwork-sheet.png");
      await writeFile(sheetScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(sheetScreenshot);
      await closeEditor();
      // Manage keeps the compact header. Overview renders the lazy foreground.
      await revealDetailSection(browser, "Overview");
      await waitForArtworkImage(
        browser,
        ".game-hero-detail .game-hero-foreground img",
        ".game-hero-detail",
      );
      const cover = await state("cover"),
        detail = await state("detail");
      assert.equal(cover.choice.revision, before.choice.revision + 1);
      assert.deepEqual(detail.choice.framing, {
        version: "v1",
        wide: { x: 5000, y: 3500 },
        narrow: { x: 10000, y: 3500 },
      });
      const oldChoice = object(
        await invoke("reset_artwork", {
          portId,
          slot: "cover",
          expectedRevision: before.choice.revision,
          generation: bootstrap.generation,
        }),
      );
      assert.equal(oldChoice.ok, false);
      assert.equal(object(oldChoice.error).code, "conflict");
      const geometry = await readArtworkGeometry(browser);
      assert.ok(Math.abs(geometry.ratio - bytes.readUInt32BE(16) / bytes.readUInt32BE(20)) < 0.02);
      assert.equal(geometry.fit, "contain");
      assert.equal(geometry.titleOutsideImage, true);
      const originalTitle = await executeBrowserScript(browser, () => {
        const title = document.querySelector("#port-detail-title");
        if (!title) throw new Error("Port detail title unavailable");
        const original = title.textContent;
        title.textContent =
          "Owned long-title layout fixture with a deliberately lengthy game name and edition description";
        return original;
      });
      let layoutFailed = false;
      let titleRestoreFailure: { error: unknown } | undefined;
      try {
        await assertCompactReview(browser, ".detail-panel");
        await executeBrowserScript(
          browser,
          'document.querySelector(".detail-hero").scrollIntoView({ block: "start" });',
        );
        const screenshot = path.join(output, "native-artwork-letterboxed-compact.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
        const report = path.join(output, "artwork-accessibility.json");
        await captureAccessibilityReport(browser, report, artifacts);
      } catch (error) {
        layoutFailed = true;
        throw error;
      } finally {
        try {
          await executeBrowserScript(
            browser,
            (original) => {
              const title = document.querySelector("#port-detail-title");
              if (!title?.isConnected)
                throw new Error("Port detail title unavailable for restoration");
              title.textContent = original;
            },
            originalTitle,
          );
        } catch (error) {
          titleRestoreFailure = { error };
          // Keep the original layout failure; retain any secondary restore error.
          if (layoutFailed)
            console.error("Artwork title restoration also failed:", errorMessage(error));
        }
      }
      if (titleRestoreFailure) throw titleRestoreFailure.error;
      await revealDetailSection(browser, "Manage");
      await openEditor();
      await activateSlot("cover");
      const reviewApply = By.xpath(
        '//form[.//h4[normalize-space(.)="Review artwork change"]]//button[normalize-space(.)="Apply"]',
      );
      await click(control("cover", "Hide artwork"));
      assert.deepEqual(await state("cover"), cover);
      await click(reviewApply);
      await browser.wait(async () => (await state("cover")).choice.suppressed === true, 10_000);
      const hidden = await state("cover");
      // Hiding keeps the selection stored but unshown.
      assert.equal(hidden.choice.asset_sha256, cover.choice.asset_sha256);
      assert.equal(hidden.resolved_source.kind, "generated_fallback");
      await expectOverviewTextAndReturn();
      assert.equal((await state("detail")).choice.asset_sha256, digest);
      await click(control("cover", "Show artwork"));
      assert.deepEqual(await state("cover"), hidden);
      await click(reviewApply);
      await browser.wait(
        async () => (await state("cover")).choice.revision > hidden.choice.revision,
        10_000,
      );
      const shown = await state("cover");
      assert.equal(shown.choice.asset_sha256, cover.choice.asset_sha256);
      assert.notEqual(shown.choice.suppressed, true);
      assert.deepEqual(shown.resolved_source, cover.resolved_source);
      await click(control("cover", "Use automatic"));
      assert.deepEqual(await state("cover"), shown);
      await click(reviewApply);
      await browser.wait(
        async () => (await state("cover")).choice.revision > shown.choice.revision,
        10_000,
      );
      const reset = await state("cover");
      assert.equal(reset.choice.asset_sha256, null);
      assert.notEqual(reset.choice.suppressed, true);
      assert.equal(reset.resolved_source.kind, "generated_fallback");
      assert.deepEqual(reset.generated_fallback, before.generated_fallback);
      await expectOverviewTextAndReturn();
      assert.equal((await state("detail")).choice.asset_sha256, digest);

      const original = path.join(libraryRoot, "artwork", digest);
      const retained = path.join(output, "owned-artwork-original-retained.png");
      assert.deepEqual(await readFile(original), bytes);
      await rename(original, retained);
      let unavailable;
      try {
        await activateSlot("detail");
        await click(control("detail", "Refresh artwork"));
        await browser.wait(
          async () =>
            (await browser.findElement(editor))
              .getText()
              .then((text) => text.includes("choice has been retained")),
          45_000,
          "The exact Background refresh must expose the retained choice after the Core read",
        );
        unavailable = await state("detail");
        assert.equal(unavailable.availability, "unavailable");
        assert.equal(unavailable.choice.asset_sha256, digest);
        assert.equal(unavailable.resolved_source.kind, "generated_fallback");
        await expectFallbackVisual(".wide-artwork", unavailable.generated_fallback);
        assert.ok(
          Array.isArray(command(["status"], required(bootstrap.library_root))),
          "Unavailable artwork must not prevent ordinary game status reads",
        );
      } finally {
        await rename(retained, original);
      }
      command(["artwork", "clear-cache"], required(bootstrap.library_root));
      await open();
      await waitForArtworkImage(browser, ".wide-artwork img");
      assert.equal((await state("cover")).choice.asset_sha256, null);
      assert.deepEqual(await state("detail"), detail);
      const currentStates = [reset, detail, ...(await readRoles(["landscape", "logo"]))];
      // Each extra role has distinguishable owned bytes and appropriate geometry.
      const extraImages = [
        {
          slot: "landscape",
          bytes: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAHUlEQVR4nGOQUPP7r+Hf8t+2evP/9OUH/zOgCwAADnAReykEi5YAAAAASUVORK5CYII=",
            "base64",
          ),
        },
        {
          slot: "logo",
          bytes: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFklEQVR4nGNgYGBgeLLD5z+IBjNgGABxgQud8NOUIQAAAABJRU5ErkJggg==",
            "base64",
          ),
        },
      ] as const;
      for (const { slot, bytes: imageBytes } of extraImages) {
        const selectedPath = path.join(output, `owned-local-artwork-${slot}.png`);
        await writeFile(selectedPath, imageBytes, { flag: "wx" });
        const selectedDigest = createHash("sha256").update(imageBytes).digest("hex");
        const selected = await importLocal(slot, selectedPath, selectedDigest);
        assert.equal(selected.selection?.width, imageBytes.readUInt32BE(16));
        assert.equal(selected.selection?.height, imageBytes.readUInt32BE(20));
        assert.deepEqual(await readFile(selectedPath), imageBytes);
        currentStates[slots.indexOf(slot)] = selected;
        assert.deepEqual(
          (await readRoles(slots)).map((role) => role.choice),
          currentStates.map((role) => role.choice),
        );
      }
      await waitForArtworkImage(browser, '.artwork-slot[aria-label="Logo"] img');
      const logoScreenshot = path.join(output, "native-logo-selection.png");
      await writeFile(logoScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(logoScreenshot);
      const importedStates = [importedCover, importedBackground, ...currentStates.slice(2)];

      // Keep the Cover text-fallback and cache-recovery checks above independent
      // of an explicit logo, then exercise the remaining roles' visibility.
      const visibilityResults = [];
      for (const slot of ["detail", "landscape", "logo"] as const) {
        await activateSlot(slot);
        const index = slots.indexOf(slot);
        const selected = currentStates[index]!;
        let previous = selected;
        for (const action of ["Hide artwork", "Show artwork", "Use automatic"] as const) {
          await browser.wait(
            until.elementLocated(
              By.xpath(
                `//section[@aria-label="${slotLabels[slot]}"]//button[normalize-space(.)="${action}" and not(@disabled)]`,
              ),
            ),
            45_000,
          );
          await click(control(slot, action));
          assert.deepEqual((await state(slot)).choice, previous.choice);
          await click(reviewApply);
          const applied = await browser.wait(async () => {
            const observed = await state(slot);
            return observed.choice.revision > previous.choice.revision ? observed : false;
          }, 60_000);
          assert.ok(applied);
          assert.equal(applied.choice.revision, previous.choice.revision + 1);
          assert.equal(Boolean(applied.choice.suppressed), action === "Hide artwork");
          assert.equal(
            applied.choice.asset_sha256,
            action === "Use automatic" ? null : selected.choice.asset_sha256,
          );
          if (action !== "Use automatic") {
            assert.deepEqual(applied.choice.framing, selected.choice.framing);
          }
          assert.equal(
            applied.resolved_source.kind,
            action === "Show artwork" ? "local_import" : "generated_fallback",
          );
          const peers = await readRoles(slots.filter((peer) => peer !== slot));
          assert.deepEqual(
            peers.map((peer) => peer.choice),
            currentStates.filter((_, position) => position !== index).map((peer) => peer.choice),
          );
          visibilityResults.push({ slot, action, before: previous.choice, after: applied.choice });
          previous = applied;
          currentStates[index] = applied;
        }
      }
      assert.deepEqual(await readFile(source), bytes);
      const evidence = path.join(output, "artwork-result.json");
      await writeFile(
        evidence,
        JSON.stringify(
          {
            generation: bootstrap.generation,
            cover,
            detail,
            unavailable,
            reset,
            geometry,
            contextual_key_setup: contextualKeySetup,
            imported_roles: importedStates,
            additional_role_visibility: visibilityResults,
            cancelled_without_mutation: true,
            stale_generation_rejected: true,
            stale_revision_rejected: true,
            renderer_reload_and_cache_rebuild: true,
            original_source_unchanged: true,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(evidence);
    } catch (error) {
      failure = errorMessage(error);
      throw error;
    } finally {
      await observations.finish(failure, workspaceReadbacks);
    }
  });
}
