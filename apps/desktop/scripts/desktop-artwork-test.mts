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
} from "./desktop-review-controls.mts";
import { artworkObservations } from "./desktop-artwork-observations.mts";

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
      const control = (slot: ArtworkSlot, label: string) =>
        By.xpath(
          `//section[@aria-label="${slot === "cover" ? "Cover" : "Detail"} image"]//button[normalize-space(.)="${label}"]`,
        );
      const state = async (slot: ArtworkSlot) => {
        const result = await invoke("get_artwork", {
          portId,
          slot,
          generation: bootstrap.generation,
        });
        return transportValue("artwork_state", success(result));
      };
      const fallbackVisual = async (selector: string, paletteIndex: number, quiet: boolean) =>
        executeBrowserScript(
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
              decorativeIcon: Boolean(
                frame.querySelector(':scope > span > svg[aria-hidden="true"]'),
              ),
              palette: computed.getPropertyValue("--art-color").trim(),
              expectedPalette: getComputedStyle(document.documentElement)
                .getPropertyValue(token)
                .trim(),
              background: computed.backgroundColor,
              expectedBackground,
            };
          },
          selector,
          paletteIndex,
          quiet,
        );
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
            const actual = await fallbackVisual(selector, fallback.palette_index, quiet);
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
            `Fallback presentation did not settle: ${JSON.stringify(await fallbackVisual(selector, fallback.palette_index, quiet))}`,
            { cause: error },
          );
        }
        const actual = await fallbackVisual(selector, fallback.palette_index, quiet);
        assert.deepEqual({ source: actual.source, initials: actual.initials }, expected);
        assert.ok(actual.palette.length > 0);
        assert.equal(actual.images, 0);
        if (quiet) assert.equal(actual.decorativeIcon, true);
        assert.equal(actual.palette, actual.expectedPalette);
        assert.equal(actual.background, actual.expectedBackground);
      };
      const open = async () => {
        await observations.capture("before-reload");
        await browser.navigate().refresh();
        await observations.begin();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          15_000,
        );
        const preferences = transportValue(
          "desktop_application_update_preferences",
          success(await invoke("get_application_update_preferences")),
        );
        if (preferences.choice === null) {
          const choice = By.xpath(
            '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
          );
          await browser.wait(until.elementLocated(choice), 15_000);
          await click(
            By.xpath(
              '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]//button[normalize-space(.)="Not now"]',
            ),
          );
          await browser.wait(async () => (await browser.findElements(choice)).length === 0, 15_000);
        }
        // Keep the reload above paired with observations.begin(); a second
        // reload here would discard its request observers.
        await click(By.xpath('//nav//button[contains(., "Find games")]'));
        const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await search.sendKeys(
          Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
          Key.BACK_SPACE,
        );
        await click(
          By.xpath(
            '//div[@aria-label="Release channel filters"]//button[normalize-space(.)="All"]',
          ),
        );
        await click(By.css(`[data-detail-origin="catalog:card:${port.id}"]`));
        await revealDetailSection(browser, "Files");
        const summary = await browser.findElement(
          By.xpath('//summary[normalize-space(.)="Change artwork"]'),
        );
        await executeBrowserScript(
          browser,
          'arguments[0].focus(); arguments[0].scrollIntoView({ block: "center" });',
          summary,
        );
        await summary.sendKeys(Key.ENTER);
        await browser.wait(
          until.elementIsEnabled(await browser.findElement(control("cover", "Choose local image"))),
          10_000,
        );
      };
      const waitImage = async (selector: string) => {
        const frame = await browser.wait(
          until.elementLocated(By.css(selector.replace(/ img$/, ""))),
          10_000,
        );
        await executeBrowserScript(
          browser,
          'arguments[0].scrollIntoView({ block: "center" });',
          frame,
        );
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
      };
      await open();
      const before = await state("cover");
      assert.equal(before.resolved_source.kind, "generated_fallback");
      assert.match(before.generated_fallback.identity, /^[0-9a-f]{64}$/u);
      assert.equal(before.generated_fallback.style_version, 1);
      assert.ok(before.generated_fallback.palette_index >= 0);
      assert.ok(before.generated_fallback.palette_index < 6);
      await expectFallbackVisual(".detail-cover", before.generated_fallback, true);
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
      for (const slot of ["cover", "detail"] as const) {
        await click(control(slot, "Choose local image"));
        await confirmNative(
          "Choose local artwork",
          "Open",
          "File name:",
          `artwork-picker-${slot}`,
          source,
        );
        await browser.wait(async () => (await state(slot)).choice.asset_sha256 === digest, 10_000);
        const picker = await browser.findElement(control(slot, "Choose local image"));
        // Core commits before the renderer finishes its preview and returns focus.
        // Observe completion before scrolling to a different image surface.
        await browser.wait(until.elementIsEnabled(picker), 10_000);
        await browser.wait(
          () =>
            executeBrowserScript(browser, (element) => document.activeElement === element, picker),
          5000,
        );
      }
      await waitImage(".wide-artwork img");
      await waitImage(".detail-cover img");
      const cover = await state("cover"),
        detail = await state("detail");
      assert.equal(cover.choice.revision, before.choice.revision + 1);
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
      const geometry = await executeBrowserScript(browser, () => {
        const frame = document.querySelector(".detail-cover");
        if (!frame) throw new Error("Artwork frame unavailable");
        const image = frame.querySelector("img");
        if (!image) throw new Error("Artwork image unavailable");
        const bounds = frame.getBoundingClientRect();
        return {
          ratio: bounds.width / bounds.height,
          fit: getComputedStyle(image).objectFit,
          titleOutsideImage: !frame.contains(document.querySelector("#port-detail-title")),
        };
      });
      assert.ok(Math.abs(geometry.ratio - 2 / 3) < 0.02);
      assert.equal(geometry.fit, "contain");
      assert.equal(geometry.titleOutsideImage, true);
      await executeBrowserScript(browser, () => {
        const title = document.querySelector("#port-detail-title");
        if (!title) throw new Error("Port detail title unavailable");
        title.textContent =
          "Owned long-title layout fixture with a deliberately lengthy game name and edition description";
      });
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
      await click(control("cover", "Reset to default"));
      await browser.wait(async () => (await state("cover")).choice.asset_sha256 === null, 10_000);
      const reset = await state("cover");
      assert.equal(reset.resolved_source.kind, "generated_fallback");
      assert.deepEqual(reset.generated_fallback, before.generated_fallback);
      await expectFallbackVisual(".detail-cover", before.generated_fallback, true);
      assert.equal((await state("detail")).choice.asset_sha256, digest);

      const original = path.join(libraryRoot, "artwork", digest);
      const retained = path.join(output, "owned-artwork-original-retained.png");
      assert.deepEqual(await readFile(original), bytes);
      await rename(original, retained);
      let unavailable;
      try {
        await click(control("detail", "Refresh artwork"));
        await browser.wait(
          async () =>
            (await browser.findElement(By.css(".artwork-controls")))
              .getText()
              .then((text) => text.includes("choice has been retained")),
          10_000,
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
      await waitImage(".wide-artwork img");
      assert.equal((await state("cover")).choice.asset_sha256, null);
      assert.deepEqual(await state("detail"), detail);
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
            cancelled_without_mutation: true,
            stale_generation_rejected: true,
            stale_revision_rejected: true,
            restart_and_cache_rebuild: true,
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
      await observations.finish(failure);
    }
  });
}
