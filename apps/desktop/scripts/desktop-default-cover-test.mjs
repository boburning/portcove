import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";

// Explicit opt-in live CDN exercise; excluded from routine offline qualification.
export async function defaultCoverScenario({
  browser,
  scenario,
  invoke,
  output,
  artifacts,
  capture,
  setTheme,
}) {
  await scenario("native-default-cover-display", async () => {
    const catalog = await invoke("get_catalog");
    assert.equal(catalog.ok, true);
    const ids = [
      "shipwright",
      "2ship2harkinian",
      "zelda64-recomp",
      "spaghetti-kart",
      "paperboat",
      "dkr-r",
    ];
    const rows = [];
    const captureSettled = async (name, selector) => {
      await browser.wait(
        () =>
          browser.executeScript((selector) => {
            const element = document.querySelector(selector);
            return (
              element &&
              element
                .getAnimations({ subtree: true })
                .every(
                  (animation) =>
                    animation.playState !== "running" ||
                    !Number.isFinite(animation.effect?.getComputedTiming().endTime),
                )
            );
          }, selector),
        5_000,
        `Presentation did not settle: ${selector}`,
      );
      await capture(name, true);
    };
    const image = async (selector) => {
      await browser.wait(
        async () =>
          browser.executeScript((selector) => {
            const frame = document.querySelector(selector);
            const img = frame?.querySelector("img");
            return (
              frame?.dataset.artworkSource === "igdb_cover" && img?.complete && img.naturalWidth > 0
            );
          }, selector),
        15_000,
        `Real default cover did not render: ${selector}`,
      );
      return browser.executeScript((selector) => {
        const img = document.querySelector(selector).querySelector("img");
        return { width: img.naturalWidth, height: img.naturalHeight };
      }, selector);
    };
    for (const [pass, theme, size] of [
      ["first-display", "light", { width: 1280, height: 800 }],
      ["warm", "dark", { width: 960, height: 640 }],
    ]) {
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
      await setTheme(theme);
      await browser.manage().window().setRect(size);
      const outer = await browser.manage().window().getRect();
      assert.equal(outer.width, size.width);
      assert.equal(outer.height, size.height);
      const viewport = await browser.executeScript(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      for (const id of ids) {
        const port = catalog.value.ports.find((port) => port.id === id);
        assert.ok(port?.presentation?.artwork, `Missing maintained mapping: ${id}`);
        await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
        const search = await browser.wait(until.elementLocated(By.id("port-search")), 10_000);
        await search.sendKeys(Key.CONTROL, "a", Key.NULL, port.name);
        const started = performance.now();
        const selector = `[data-detail-origin="catalog:card:${id}"]`;
        const card = await browser.wait(until.elementLocated(By.css(selector)), 10_000);
        await browser.executeScript((card) => card.scrollIntoView({ block: "center" }), card);
        const cardImage = await image(`${selector} .card-art`);
        const cardMs = performance.now() - started;
        await captureSettled(`default-cover-${id}-${pass}-catalog`, selector);
        await card.click();
        await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 10_000);
        const detailImage = await image(".detail-cover");
        await captureSettled(`default-cover-${id}-${pass}-details`, "[data-detail-workspace]");
        rows.push({
          id,
          pass,
          theme,
          outer,
          viewport,
          cardMs,
          cardImage,
          detailImage,
          mapping: port.presentation.artwork,
        });
      }
    }
    const report = path.join(output, "default-cover-display.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          scope:
            "native development app; first/warm same-session CDN display, not cold-request latency or offline",
          rows,
        },
        null,
        2,
      ),
    );
    artifacts.push(report);
  });
}
