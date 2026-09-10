// Owned local artwork exercises real file selection, core IPC and rendered images.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import axe from "axe-core";
import { By, Key, until } from "selenium-webdriver";
import { assertCompactReview, reviewControls } from "./desktop-review-controls.mjs";
import { artworkObservations } from "./desktop-artwork-observations.mjs";

export async function artworkScenario({ browser, invoke, scenario, output, artifacts, command, confirmNative }) {
  await scenario("native-local-artwork-picker-and-recovery", async () => {
    const observations = artworkObservations({ browser, output, artifacts });
    let failure;
    try {
      const bootstrap = (await invoke("get_bootstrap_status")).value;
      const libraryRoot = await realpath(bootstrap.library_root);
      const ownedRelative = path.relative(await realpath(output), libraryRoot);
      assert.ok(ownedRelative && !ownedRelative.startsWith("..") && !path.isAbsolute(ownedRelative), "Artwork tests require the owned qualification library");
      const portId = "zelda64-recomp";
      const port = command(["catalog", "show", portId], bootstrap.library_root);
      const source = path.join(output, "owned-local-artwork.png");
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQCFgAAAGMAQm4OT/aAAAAAElFTkSuQmCC", "base64");
      await writeFile(source, bytes, { flag: "wx" });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const { click } = reviewControls(browser);
      const control = (slot, label) => By.xpath(`//section[@aria-label="${slot === "cover" ? "Cover" : "Detail"} image"]//button[normalize-space(.)="${label}"]`);
      const state = async slot => {
        const result = await invoke("get_artwork", { portId, slot, generation: bootstrap.generation });
        assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
      };
      const open = async () => {
        await observations.capture("before-reload");
        await browser.navigate().refresh();
        await observations.begin();
        await click(By.xpath('//nav//button[contains(., "Port catalog")]'));
        await click(By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`));
        const summary = await browser.findElement(By.xpath('//summary[normalize-space(.)="Change artwork"]'));
        await browser.executeScript('arguments[0].focus(); arguments[0].scrollIntoView({ block: "center" });', summary);
        await summary.sendKeys(Key.ENTER);
        await browser.wait(until.elementIsEnabled(await browser.findElement(control("cover", "Choose local image"))), 10_000);
      };
      const waitImage = async selector => {
        const frame = await browser.wait(until.elementLocated(By.css(selector.replace(/ img$/, ""))), 10_000);
        await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', frame);
        await browser.wait(() => browser.executeScript(selector => {
          const image = document.querySelector(selector); return Boolean(image?.complete && image.naturalWidth > 0);
        }, selector), 10_000, `Core thumbnail must render in ${selector}`);
      };
      await open();
      const before = await state("cover");
      const stale = await invoke("reset_artwork", { portId, slot: "cover", expectedRevision: before.choice.revision, generation: bootstrap.generation + 1 });
      assert.equal(stale.ok, false); assert.equal(stale.error.code, "conflict");
      await click(control("cover", "Choose local image"));
      await confirmNative("Choose local artwork", "Cancel", "File name:", "artwork-picker-cancelled");
      await browser.wait(until.elementIsEnabled(await browser.findElement(control("cover", "Choose local image"))), 10_000);
      assert.deepEqual(await state("cover"), before);
      await browser.wait(() => browser.executeScript(() => document.activeElement?.textContent === "Choose local image"), 5000);
      for (const slot of ["cover", "detail"]) {
        await click(control(slot, "Choose local image"));
        await confirmNative("Choose local artwork", "Open", "File name:", `artwork-picker-${slot}`, source);
        await browser.wait(async () => (await state(slot)).choice.asset_sha256 === digest, 10_000);
        const picker = await browser.findElement(control(slot, "Choose local image"));
        // Core commits before the renderer finishes its preview and returns focus.
        // Observe completion before scrolling to a different image surface.
        await browser.wait(until.elementIsEnabled(picker), 10_000);
        await browser.wait(() => browser.executeScript(element => document.activeElement === element, picker), 5000);
      }
      await waitImage(".wide-artwork img"); await waitImage(".detail-cover img");
      const cover = await state("cover"), detail = await state("detail");
      assert.equal(cover.choice.revision, before.choice.revision + 1);
      const oldChoice = await invoke("reset_artwork", { portId, slot: "cover", expectedRevision: before.choice.revision, generation: bootstrap.generation });
      assert.equal(oldChoice.ok, false); assert.equal(oldChoice.error.code, "conflict");
      const geometry = await browser.executeScript(() => {
        const frame = document.querySelector(".detail-cover"); const bounds = frame.getBoundingClientRect();
        return { ratio: bounds.width / bounds.height, fit: getComputedStyle(frame.querySelector("img")).objectFit, titleOutsideImage: !frame.contains(document.querySelector("#port-detail-title")) };
      });
      assert.ok(Math.abs(geometry.ratio - 2 / 3) < 0.02); assert.equal(geometry.fit, "contain"); assert.equal(geometry.titleOutsideImage, true);
      await browser.executeScript(() => { document.querySelector("#port-detail-title").textContent = "Owned long-title layout fixture with a deliberately lengthy game name and edition description"; });
      await assertCompactReview(browser, ".detail-panel");
      await browser.executeScript('document.querySelector(".detail-hero").scrollIntoView({ block: "start" });');
      const screenshot = path.join(output, "native-artwork-letterboxed-compact.png");
      await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
      await browser.executeScript(axe.source);
      const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
      const report = path.join(output, "artwork-accessibility.json");
      await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
      assert.deepEqual(accessibility.violations.map(item => item.id), []);
      await click(control("cover", "Reset to default"));
      await browser.wait(async () => (await state("cover")).choice.asset_sha256 === null, 10_000);
      assert.equal((await state("detail")).choice.asset_sha256, digest);

      const original = path.join(libraryRoot, "artwork", digest);
      const retained = path.join(output, "owned-artwork-original-retained.png");
      assert.deepEqual(await readFile(original), bytes);
      await rename(original, retained);
      let unavailable;
      try {
        await click(control("detail", "Refresh artwork"));
        await browser.wait(async () => (await browser.findElement(By.css(".artwork-controls"))).getText().then(text => text.includes("choice has been retained")), 10_000);
        unavailable = await state("detail"); assert.equal(unavailable.availability, "unavailable");
        assert.equal(unavailable.choice.asset_sha256, digest);
        assert.ok(Array.isArray(command(["status"], bootstrap.library_root)), "Unavailable artwork must not prevent ordinary game status reads");
      } finally { await rename(retained, original); }
      command(["artwork", "clear-cache"], bootstrap.library_root);
      await open(); await waitImage(".wide-artwork img");
      assert.equal((await state("cover")).choice.asset_sha256, null);
      assert.deepEqual(await state("detail"), detail);
      assert.deepEqual(await readFile(source), bytes);
      const evidence = path.join(output, "artwork-result.json");
      await writeFile(evidence, JSON.stringify({ generation: bootstrap.generation, cover, detail, unavailable, geometry, cancelled_without_mutation: true, stale_generation_rejected: true, stale_revision_rejected: true, restart_and_cache_rebuild: true, original_source_unchanged: true }, null, 2), { flag: "wx" }); artifacts.push(evidence);
    } catch (error) { failure = error.message; throw error; }
    finally { await observations.finish(failure); }
  });
}
