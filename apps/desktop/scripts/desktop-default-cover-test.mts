import {
  createImageRefusal,
  restoreCacheAfterObservation,
  selectDefaultCoverIds,
  assertDefaultCoverPresentation,
  assertCachedCoverTraffic,
  type WithheldCover,
} from "./desktop-cover-observations.mts";
import { revealDetailSection, selectCatalogPort } from "./desktop-review-controls.mts";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
import type { IRectangle } from "selenium-webdriver";
import type { PortDefinition, CatalogDocument } from "../src/transport-types.generated.d.ts";
import type { PreparationContext } from "./desktop-preparation-test.mts";
import { transportValue } from "./transport-values.mts";
type CoverContext = Pick<
  PreparationContext,
  "scenario" | "invoke" | "output" | "artifacts" | "library"
> & {
  browser: WebDriver | LinuxInspectorProtocol | undefined;
  capture: (name: string, force?: boolean) => Promise<unknown>;
  setTheme: (theme: "light" | "dark") => Promise<unknown>;
  restart: PreparationContext["restartApplication"];
  cacheConditions?: boolean;
  coverPortIds?: readonly string[];
};
interface CoverImage {
  width: number;
  height: number;
  background: string;
  identitySurface: boolean;
  surfaceBackground: string;
  objectFit: string;
  fallbackPalette: boolean;
}
type CaptureSettled = (name: string, selector: string, browser?: WebDriver) => Promise<void>;
type Theme = "light" | "dark";
interface CoverRow {
  id: string;
  pass: string;
  theme: Theme;
  outer: IRectangle;
  viewport: { width: number; height: number };
  cardMs: number;
  cardImage: CoverImage;
  detailImage: CoverImage | null;
  mapping: NonNullable<NonNullable<PortDefinition["presentation"]>["artwork"]>;
}
interface InspectContext {
  browser: WebDriver;
  ports: PortDefinition[];
  ids: string[];
  detailIds: Set<string>;
  image: (selector: string) => Promise<CoverImage>;
  captureSettled: CaptureSettled;
  pass: string;
  theme: Theme;
  outer: IRectangle;
  viewport: { width: number; height: number };
}
interface MissingCacheContext extends Pick<
  CoverContext,
  "browser" | "output" | "restart" | "invoke"
> {
  browser: WebDriver;
  ports: PortDefinition[];
  cache: string;
  offlineEnvironment: NodeJS.ProcessEnv | undefined;
  refusedOrigins: string[];
  explicitScope: boolean;
  captureSettled: CaptureSettled;
  onWithheld: (value: WithheldCover) => void;
}
async function catalogValue(invoke: CoverContext["invoke"]): Promise<CatalogDocument> {
  const reply = await invoke("get_catalog");
  assert.ok(isRecord(reply));
  assert.equal(reply.ok, true);
  return transportValue("catalog", reply.value);
}
function required<Value>(value: Value | undefined | null): Value {
  assert.ok(value !== undefined && value !== null);
  return value;
}
import { errorMessage, errorCode, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { WebDriver, By, Key, until } from "selenium-webdriver";

// Explicit opt-in live CDN exercise; excluded from routine offline qualification.
export async function defaultCoverScenario({
  browser: suppliedBrowser,
  scenario,
  invoke,
  output,
  artifacts,
  capture,
  setTheme,
  library,
  restart,
  cacheConditions = false,
  coverPortIds = [],
}: CoverContext) {
  await scenario(
    cacheConditions ? "native-default-cover-cache-conditions" : "native-default-cover-display",
    async () => {
      assert.ok(
        suppliedBrowser instanceof WebDriver,
        "Default cover observation requires WebDriver",
      );
      let browser = suppliedBrowser;
      const { cache, refusal, refusedOrigins, offlineEnvironment } = await createCoverConditions(
        library,
        cacheConditions,
      );
      let withheld: WithheldCover | undefined;
      let primaryFailure: { error: unknown } | undefined;
      try {
        const catalog = await catalogValue(invoke);
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
        const ids = selectDefaultCoverIds(catalog.ports, coverPortIds, cacheConditions);
        if (coverPortIds.length) for (const id of ids) detailIds.add(id);
        const rows: CoverRow[] = [];
        const captureSettled: CaptureSettled = async (name, selector, currentBrowser = browser) => {
          await currentBrowser.wait(
            () =>
              executeBrowserScript(
                currentBrowser,
                (selector) => {
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
                },
                selector,
              ),
            5_000,
            `Presentation did not settle: ${selector}`,
          );
          await capture(name, true);
        };
        const image = async (selector: string) => {
          try {
            await browser.wait(
              async () =>
                executeBrowserScript(
                  browser,
                  (selector) => {
                    const frame = document.querySelector<HTMLElement>(selector);
                    const img = frame?.querySelector("img");
                    return (
                      frame?.dataset.artworkSource === "igdb_cover" &&
                      img?.complete &&
                      img.naturalWidth > 0
                    );
                  },
                  selector,
                ),
              15_000,
              `Real default cover did not render: ${selector}`,
            );
          } catch (error) {
            let diagnostics;
            try {
              if (selector.includes(".collection-art")) {
                await browser.findElement(By.css(selector.replace(" .collection-art", ""))).click();
              }
              await revealDetailSection(browser, "Manage");
              const controls = await browser.wait(
                until.elementLocated(By.css(".artwork-controls > summary")),
                5_000,
              );
              await controls.click();
              diagnostics = await executeBrowserScript(browser, () =>
                [...document.querySelectorAll(".artwork-controls [role=alert]")].map(
                  (item) => item.textContent,
                ),
              );
            } catch (diagnosticError) {
              diagnostics = { collectionFailure: errorMessage(diagnosticError) };
            }
            throw new Error(
              `${errorMessage(error)}; artwork diagnostics: ${JSON.stringify(diagnostics)}`,
              {
                cause: error,
              },
            );
          }
          const rendered = await executeBrowserScript(
            browser,
            (selector) => {
              const frame = document.querySelector(selector);
              const img = frame?.querySelector("img");
              if (!frame || !img) throw new Error("Rendered cover elements disappeared");
              const style = getComputedStyle(frame);
              // CSS minification may serialize the token as hex while WebKit
              // serializes backgroundColor as rgba. Resolve both through CSS.
              const surface = document.createElement("span");
              surface.hidden = true;
              surface.style.backgroundColor = "var(--color-bg-subtle)";
              frame.appendChild(surface);
              let surfaceBackground: string;
              try {
                surfaceBackground = getComputedStyle(surface).backgroundColor;
              } finally {
                surface.remove();
              }
              return {
                width: img.naturalWidth,
                height: img.naturalHeight,
                background: style.backgroundColor,
                identitySurface: frame.classList.contains("[--art-color:var(--color-bg-subtle)]"),
                surfaceBackground,
                objectFit: getComputedStyle(img).objectFit,
                fallbackPalette: [...frame.classList].some(
                  (name) =>
                    /^palette-\d+$/.test(name) || name.startsWith("[--art-color:var(--color-art-"),
                ),
              };
            },
            selector,
          );
          assertDefaultCoverPresentation(rendered);
          return rendered;
        };
        for (const [pass, theme, size] of coverPasses(cacheConditions)) {
          if (cacheConditions && pass === "offline-cached-restart") {
            await verifyMappedCache(catalog.ports, ids, cache);
            browser = await restart("default-cover-offline", undefined, offlineEnvironment);
          }
          await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
          await setTheme(theme);
          await browser.manage().window().setRect(size);
          const outer = await browser.manage().window().getRect();
          assert.equal(outer.width, size.width);
          assert.equal(outer.height, size.height);
          const viewport = await executeBrowserScript(browser, () => ({
            width: innerWidth,
            height: innerHeight,
          }));
          rows.push(
            ...(await inspectCoverPass({
              browser,
              ports: catalog.ports,
              ids,
              detailIds,
              image,
              captureSettled,
              pass,
              theme,
              outer,
              viewport,
            })),
          );
        }
        const negativeControl = cacheConditions
          ? await missingCacheNegativeControl({
              browser,
              ports: catalog.ports,
              cache,
              output,
              restart,
              offlineEnvironment,
              refusedOrigins,
              explicitScope: coverPortIds.length > 0,
              invoke,
              captureSettled,
              onWithheld: (value) => {
                withheld = value;
              },
            })
          : null;
        const report = path.join(
          output,
          cacheConditions ? "default-cover-cache-conditions.json" : "default-cover-display.json",
        );
        await writeFile(
          report,
          JSON.stringify(
            {
              scope: cacheConditions
                ? "native app; isolated empty-cache first display and cached restart with backend image traffic rejected; missing-cache negative control. Package/installation provenance requires an independently joined outer receipt; no physical-device claim"
                : "native app; mapped covers in both themes with the recorded detail subset; first/warm same-session CDN display, not cold-request latency or offline. Package/installation provenance requires an independently joined outer receipt",
              selectionScope: coverPortIds.length ? "explicit-mapped-ports" : "all-mapped-ports",
              requestedPortIds: coverPortIds,
              observedPortIds: ids,
              detailObservationPortIds: ids.filter((id) => detailIds.has(id)),
              availableMappedCount: catalog.ports.filter((port) => port.presentation?.artwork)
                .length,
              negativeControl,
              refusedOrigins,
              catalogCount: catalog.ports.length,
              mappedCount: ids.length,
              rows,
            },
            null,
            2,
          ),
        );
        artifacts.push(report);
      } catch (error) {
        primaryFailure = { error };
        // Restoration starts a replacement app. Preserve the failing UI first.
        try {
          await capture("default-cover-before-restoration-failure", true);
        } catch (captureError) {
          console.error(`Could not retain the failing artwork UI: ${errorMessage(captureError)}`);
        }
        throw error;
      } finally {
        await restoreCacheAfterObservation({
          withheld,
          restart,
          primaryFailure,
          output,
          artifacts,
          refusal,
        });
      }
    },
  );
}

async function assertEmptyCache(cache: string) {
  const initial = await readdir(cache).catch((error) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(initial, [], "Cold display requires an actually empty isolated artwork cache");
}

async function verifyMappedCache(ports: PortDefinition[], ids: string[], cache: string) {
  const mappings = new Map(ports.map((port) => [port.id, port.presentation?.artwork]));
  for (const digest of new Set(ids.map((id) => required(mappings.get(id)).image_sha256))) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    const bytes = await readFile(path.join(cache, `${digest}.jpg`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      digest,
      "Cached original matches accepted mapping",
    );
  }
}

async function missingCacheNegativeControl({
  browser,
  ports,
  cache,
  output,
  restart,
  offlineEnvironment,
  refusedOrigins,
  explicitScope,
  invoke,
  captureSettled,
  onWithheld,
}: MissingCacheContext) {
  const refusedImageRequestsBeforeControl = assertCachedCoverTraffic(refusedOrigins, explicitScope);
  const port = ports.find((port) => port.id === "dkr-r");
  assert.ok(port?.presentation?.artwork, "Negative control requires the maintained DKR mapping");
  const digest = port.presentation.artwork.image_sha256;
  const candidate = {
    original: path.join(cache, `${digest}.jpg`),
    retained: path.join(output, `withheld-${digest}.jpg`),
  };
  browser = await restart(
    "default-cover-missing-cache",
    async () => {
      await rename(candidate.original, candidate.retained);
      onWithheld(candidate);
    },
    offlineEnvironment,
  );
  await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
  await searchForCover(browser, port.name);
  const selector = `[data-detail-origin="catalog:card:${port.id}"]`;
  await browser.wait(until.elementLocated(By.css(selector)), 10_000);
  await browser.wait(
    () =>
      refusedOrigins.filter((origin) => origin === "images.igdb.com").length >
      refusedImageRequestsBeforeControl,
    15_000,
    "Missing cache must exercise actual rejected backend image traffic",
  );
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (selector) => {
          const card = document.querySelector(selector)?.closest("article.discover-game");
          const frame = card?.querySelector<HTMLElement>(".collection-art");
          return (
            frame?.dataset.artworkSource === "generated_fallback" &&
            !frame.querySelector("img") &&
            Array.from(card?.querySelectorAll(".discover-game-metadata > p") ?? []).some(
              (note) => note.textContent === "Image unavailable",
            )
          );
        },
        selector,
      ),
    10_000,
    "Unavailable image must retain an honest generated fallback",
  );
  await captureSettled("default-cover-missing-cache-offline", selector, browser);
  const logical = await catalogValue(invoke);
  assert.deepEqual(
    required(required(logical.ports.find((item) => item.id === port.id)).presentation).artwork,
    port.presentation.artwork,
    "Missing bytes do not erase the accepted logical mapping",
  );
  return {
    id: port.id,
    digest,
    refusedImageRequests: refusedOrigins.filter((origin) => origin === "images.igdb.com").length,
    refusedImageRequestsBeforeControl,
    refusedImageRequestsDuringControl:
      refusedOrigins.filter((origin) => origin === "images.igdb.com").length -
      refusedImageRequestsBeforeControl,
    trafficAttribution: "aggregate-host-only",
    fallback: true,
  };
}

function coverPasses(
  cacheConditions: boolean,
): [string, Theme, { width: number; height: number }][] {
  return [
    [cacheConditions ? "cold-empty-cache" : "first-display", "light", { width: 1280, height: 800 }],
    [cacheConditions ? "offline-cached-restart" : "warm", "dark", { width: 960, height: 640 }],
  ];
}

async function inspectCoverPass({
  browser,
  ports,
  ids,
  detailIds,
  image,
  captureSettled,
  pass,
  theme,
  outer,
  viewport,
}: InspectContext) {
  const observations: CoverRow[] = [];
  for (const id of ids) {
    const port = ports.find((port) => port.id === id);
    assert.ok(port?.presentation?.artwork, `Missing maintained mapping: ${id}`);
    await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
    await searchForCover(browser, port.name);
    const started = performance.now();
    const selector = `[data-detail-origin="catalog:card:${id}"]`;
    const card = await browser
      .wait(until.elementLocated(By.css(selector)), 10_000)
      .catch(async (error: unknown) => {
        let navigation: unknown;
        try {
          navigation = await executeBrowserScript(browser, () => ({
            query: document.querySelector<HTMLInputElement>("#port-search")?.value,
            active: document.activeElement?.id,
            origins: Array.from(document.querySelectorAll("[data-detail-origin^='catalog:card:']"))
              .slice(0, 16)
              .map((element) => element.getAttribute("data-detail-origin")),
          }));
        } catch (diagnosticError) {
          navigation = { collectionFailure: errorMessage(diagnosticError) };
        }
        throw new Error(
          `${pass}/${id}: ${errorMessage(error)}; cover navigation: ${JSON.stringify(navigation)}`,
          { cause: error },
        );
      });
    await executeBrowserScript(browser, (card) => card.scrollIntoView({ block: "center" }), card);
    const cardImage = await image(`${selector} .collection-art`);
    const cardMs = performance.now() - started;
    await captureSettled(`default-cover-${id}-${pass}-catalog`, selector);
    let detailImage = null;
    if (detailIds.has(id)) {
      await selectCatalogPort(browser, id);
      await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 10_000);
      detailImage = await image(
        '.game-hero-detail[data-hero-identity="cover"] .game-hero-foreground',
      );
      await captureSettled(`default-cover-${id}-${pass}-details`, "[data-detail-workspace]");
    }
    observations.push({
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
  return observations;
}

async function createCoverConditions(library: string, cacheConditions: boolean) {
  const cache = path.join(library, "artwork-cache");
  if (!cacheConditions)
    return { cache, refusal: null, refusedOrigins: [], offlineEnvironment: undefined };
  await assertEmptyCache(cache);
  const refusal = await createImageRefusal();
  return {
    cache,
    refusal,
    refusedOrigins: refusal.origins,
    offlineEnvironment: refusal.environment,
  };
}

async function searchForCover(browser: WebDriver, name: string) {
  const search = await browser.wait(until.elementLocated(By.id("port-search")), 10_000);
  const value = () =>
    executeBrowserScript(
      browser,
      () => document.querySelector<HTMLInputElement>("#port-search")?.value,
    );
  const previous = await value();
  assert.ok(typeof previous === "string");
  // Real edit events update React's controlled query; no modifier can remain held.
  await search.sendKeys(Key.END, ...Array.from(previous, () => Key.BACK_SPACE));
  await browser.wait(
    async () => (await value()) === "",
    5_000,
    "Keyboard editing must clear the controlled cover query",
  );
  await search.sendKeys(name);
  await browser.wait(
    async () => (await value()) === name,
    5_000,
    `Controlled cover query must equal ${name}`,
  );
}
