import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
  library,
  restart,
  cacheConditions = false,
}) {
  await scenario(
    cacheConditions ? "native-default-cover-cache-conditions" : "native-default-cover-display",
    async () => {
      const cache = path.join(library, "artwork-cache");
      if (cacheConditions) {
        const initial = await readdir(cache).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        assert.deepEqual(
          initial,
          [],
          "Cold display requires an actually empty isolated artwork cache",
        );
      }
      const refusedOrigins = [];
      const refusalSockets = new Set();
      // Test-only local refusal: never forwards traffic or records headers, paths or credentials.
      const refusal = cacheConditions
        ? createServer((request, response) => {
            refusedOrigins.push("http-request");
            response.writeHead(503).end();
          })
        : null;
      refusal?.on("connection", (socket) => {
        refusalSockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => refusalSockets.delete(socket));
        socket.setTimeout(2000, () => socket.destroy());
      });
      refusal?.on("connect", (request, socket) => {
        refusedOrigins.push(
          request.url === "images.igdb.com:443" ? "images.igdb.com" : "other-origin",
        );
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      });
      let offlineEnvironment;
      if (refusal) {
        await new Promise((resolve, reject) => {
          refusal.once("error", reject);
          refusal.listen(0, "127.0.0.1", resolve);
        });
        const proxy = `http://127.0.0.1:${refusal.address().port}`;
        offlineEnvironment = {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ALL_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          all_proxy: proxy,
          NO_PROXY: "localhost,127.0.0.1,::1",
          no_proxy: "localhost,127.0.0.1,::1",
        };
      }
      let withheld;
      try {
        const catalog = await invoke("get_catalog");
        assert.equal(catalog.ok, true);
        const detailIds = new Set([
          "shipwright",
          "2ship2harkinian",
          "zelda64-recomp",
          "spaghetti-kart",
          "paperboat",
          "dkr-r",
          "banjo-recomp",
          "re-blue",
          "gen1recomp",
          "vpw2-recompiled",
          "open-nectar-pikmin",
          "diddy-kong-racing-golden-balloon",
        ]);
        const ids = catalog.value.ports
          .filter((port) => port.presentation?.artwork)
          .map((port) => port.id);
        assert.ok(ids.length > 0, "The actual catalog must have accepted cover mappings");
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
          try {
            await browser.wait(
              async () =>
                browser.executeScript((selector) => {
                  const frame = document.querySelector(selector);
                  const img = frame?.querySelector("img");
                  return (
                    frame?.dataset.artworkSource === "igdb_cover" &&
                    img?.complete &&
                    img.naturalWidth > 0
                  );
                }, selector),
              15_000,
              `Real default cover did not render: ${selector}`,
            );
          } catch (error) {
            let diagnostics;
            try {
              if (selector.includes(".card-art")) {
                await browser.findElement(By.css(selector.replace(" .card-art", ""))).click();
              }
              const controls = await browser.wait(
                until.elementLocated(By.css(".artwork-controls > summary")),
                5_000,
              );
              await controls.click();
              diagnostics = await browser.executeScript(() =>
                [...document.querySelectorAll(".artwork-controls [role=alert]")].map(
                  (item) => item.textContent,
                ),
              );
            } catch (diagnosticError) {
              diagnostics = { collectionFailure: diagnosticError.message };
            }
            throw new Error(
              `${error.message}; artwork diagnostics: ${JSON.stringify(diagnostics)}`,
              {
                cause: error,
              },
            );
          }
          const rendered = await browser.executeScript((selector) => {
            const frame = document.querySelector(selector);
            const img = frame.querySelector("img");
            return {
              width: img.naturalWidth,
              height: img.naturalHeight,
              background: getComputedStyle(frame).backgroundColor,
              objectFit: getComputedStyle(img).objectFit,
              fallbackPalette: [...frame.classList].some((name) => /^palette-\d+$/.test(name)),
            };
          }, selector);
          assert.equal(
            rendered.background,
            "rgba(0, 0, 0, 0)",
            "Artwork matte follows its surface",
          );
          assert.equal(
            rendered.objectFit,
            "contain",
            "The complete original cover remains visible",
          );
          assert.equal(
            rendered.fallbackPalette,
            false,
            "Real images do not inherit placeholder colors",
          );
          return rendered;
        };
        for (const [pass, theme, size] of [
          [
            cacheConditions ? "cold-empty-cache" : "first-display",
            "light",
            { width: 1280, height: 800 },
          ],
          [
            cacheConditions ? "offline-cached-restart" : "warm",
            "dark",
            { width: 960, height: 640 },
          ],
        ]) {
          if (cacheConditions && pass === "offline-cached-restart") {
            for (const digest of new Set(
              ids.map(
                (id) =>
                  catalog.value.ports.find((port) => port.id === id).presentation.artwork
                    .image_sha256,
              ),
            )) {
              const bytes = await readFile(path.join(cache, `${digest}.jpg`));
              assert.equal(
                createHash("sha256").update(bytes).digest("hex"),
                digest,
                "Cached original matches accepted mapping",
              );
            }
            browser = await restart("default-cover-offline", undefined, offlineEnvironment);
          }
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
            await browser
              .findElement(By.xpath('//nav//button[contains(., "Port catalog")]'))
              .click();
            const search = await browser.wait(until.elementLocated(By.id("port-search")), 10_000);
            await search.sendKeys(Key.CONTROL, "a", Key.NULL, port.name);
            const started = performance.now();
            const selector = `[data-detail-origin="catalog:card:${id}"]`;
            const card = await browser.wait(until.elementLocated(By.css(selector)), 10_000);
            await browser.executeScript((card) => card.scrollIntoView({ block: "center" }), card);
            const cardImage = await image(`${selector} .card-art`);
            const cardMs = performance.now() - started;
            await captureSettled(`default-cover-${id}-${pass}-catalog`, selector);
            let detailImage = null;
            if (detailIds.has(id)) {
              await card.click();
              await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 10_000);
              detailImage = await image(".detail-cover");
              await captureSettled(
                `default-cover-${id}-${pass}-details`,
                "[data-detail-workspace]",
              );
            }
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
        let negativeControl = null;
        if (cacheConditions) {
          assert.equal(
            refusedOrigins.filter((origin) => origin === "images.igdb.com").length,
            0,
            "All mapped cached covers render after restart without an IGDB request",
          );
          const port = catalog.value.ports.find((port) => port.id === "dkr-r");
          assert.ok(
            port?.presentation?.artwork,
            "Negative control requires the maintained DKR mapping",
          );
          const digest = port.presentation.artwork.image_sha256;
          withheld = {
            original: path.join(cache, `${digest}.jpg`),
            retained: path.join(output, `withheld-${digest}.jpg`),
          };
          browser = await restart(
            "default-cover-missing-cache",
            async () => {
              await rename(withheld.original, withheld.retained);
            },
            offlineEnvironment,
          );
          await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
          const search = await browser.wait(until.elementLocated(By.id("port-search")), 10_000);
          await search.sendKeys(Key.CONTROL, "a", Key.NULL, port.name);
          const selector = `[data-detail-origin="catalog:card:${port.id}"]`;
          await browser.wait(until.elementLocated(By.css(selector)), 10_000);
          await browser.wait(
            () => refusedOrigins.includes("images.igdb.com"),
            15_000,
            "Missing cache must exercise actual rejected backend image traffic",
          );
          await browser.wait(
            () =>
              browser.executeScript((selector) => {
                const frame = document.querySelector(`${selector} .card-art`);
                return (
                  frame?.dataset.artworkSource === "generated_fallback" &&
                  !frame.querySelector("img")
                );
              }, selector),
            10_000,
            "Unavailable image must retain an honest generated fallback",
          );
          await captureSettled("default-cover-missing-cache-offline", selector);
          const logical = await invoke("get_catalog");
          assert.equal(logical.ok, true);
          assert.deepEqual(
            logical.value.ports.find((item) => item.id === port.id).presentation.artwork,
            port.presentation.artwork,
            "Missing bytes do not erase the accepted logical mapping",
          );
          negativeControl = {
            id: port.id,
            digest,
            refusedImageRequests: refusedOrigins.filter((origin) => origin === "images.igdb.com")
              .length,
            fallback: true,
          };
        }
        const report = path.join(
          output,
          cacheConditions ? "default-cover-cache-conditions.json" : "default-cover-display.json",
        );
        await writeFile(
          report,
          JSON.stringify(
            {
              scope: cacheConditions
                ? "native development app; isolated empty-cache first display and cached restart with backend image traffic rejected; missing-cache negative control; not installed-package or physical-device evidence"
                : "native development app; every mapped catalog cover in both themes, representative details; first/warm same-session CDN display, not cold-request latency or offline",
              negativeControl,
              refusedOrigins,
              catalogCount: catalog.value.ports.length,
              mappedCount: ids.length,
              rows,
            },
            null,
            2,
          ),
        );
        artifacts.push(report);
      } finally {
        try {
          if (withheld) {
            browser = await restart("default-cover-cache-restored", async () => {
              const bytes = await readFile(withheld.retained);
              assert.equal(
                createHash("sha256").update(bytes).digest("hex"),
                path.basename(withheld.original, ".jpg"),
              );
              await rename(withheld.retained, withheld.original);
            });
          }
        } finally {
          if (refusal) {
            for (const socket of refusalSockets) socket.destroy();
            refusal.closeAllConnections();
            await new Promise((resolve) => refusal.close(resolve));
          }
        }
      }
    },
  );
}
