import {
  createImageRefusal,
  restoreCacheAfterObservation,
  selectDefaultCoverIds,
  assertDefaultCoverPresentation,
  assertCachedCoverTraffic,
  type WithheldCover,
} from "./desktop-cover-observations.mts";
import { revealDetailSection, selectCatalogPort } from "./desktop-review-controls.mts";
import { observeCollectionLayoutReady } from "./browser-readiness.mts";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
import type { IRectangle } from "selenium-webdriver";
import type { IgdbArtwork, PortDefinition } from "../src/transport-types.generated.d.ts";
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
  firstOffline?: Awaited<ReturnType<typeof createImageRefusal>>;
};
interface CoverImage {
  portId: string | null;
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
  cardPortId: string;
  pass: string;
  theme: Theme;
  outer: IRectangle;
  viewport: { width: number; height: number };
  cardMs: number | null;
  cardImage: CoverImage | null;
  cardMapping: IgdbArtwork | null;
  detailImage: CoverImage | null;
  mapping: NonNullable<NonNullable<PortDefinition["presentation"]>["artwork"]>;
}
interface DiscoverCoverTiming {
  scope: "accepted-primary-covers";
  pass: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  visibleIds: string[];
  readyIds: string[];
  startedAtEpochMs: number;
  observedAtEpochMs: number;
  firstReadyMs: number | null;
  cohortReadyMs: number | null;
}

type CoverTimingWindow = Window & { portcoveDiscoverCoverTiming?: DiscoverCoverTiming };

interface InspectContext {
  browser: WebDriver;
  ports: PortDefinition[];
  covers: ReadonlyMap<string, IgdbArtwork>;
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
  covers: ReadonlyMap<string, IgdbArtwork>;
  coverPortId: string;
  cache: string;
  offlineEnvironment: NodeJS.ProcessEnv | undefined;
  refusedOrigins: string[];
  explicitScope: boolean;
  captureSettled: CaptureSettled;
  onWithheld: (value: WithheldCover) => void;
}
async function coverInventory(invoke: CoverContext["invoke"]) {
  const bootstrap = await invoke("get_bootstrap_status");
  assert.ok(isRecord(bootstrap));
  assert.equal(bootstrap.ok, true);
  const { generation } = transportValue("desktop_bootstrap_status", bootstrap.value);
  const reply = await invoke("get_workspace_snapshot", { generation });
  assert.ok(isRecord(reply));
  assert.equal(reply.ok, true);
  const snapshot = transportValue("desktop_workspace_snapshot", reply.value);
  const ports = required(snapshot.catalog).ports;
  const listings = required(snapshot.listing_catalog).listings;
  const covers = new Map<string, IgdbArtwork>();
  const primaryIds = [];
  const companions = new Set(
    ports.filter(({ presentation }) => presentation?.companion_cover).map(({ id }) => id),
  );
  for (const { id, artwork, collection_covers: collection } of listings) {
    if (!artwork) continue;
    covers.set(id, artwork);
    if (!collection?.length && !companions.has(id)) primaryIds.push(id);
  }
  return { ports, covers, primaryIds };
}
function required<Value>(value: Value | undefined | null): Value {
  assert.ok(value !== undefined && value !== null);
  return value;
}
import { errorMessage, errorCode, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
  firstOffline,
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
        const { ports, covers, primaryIds } = await coverInventory(invoke);
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
        const ids = selectDefaultCoverIds(ports, coverPortIds, cacheConditions);
        if (coverPortIds.length) for (const id of ids) detailIds.add(id);
        const rows: CoverRow[] = [];
        const discoverTimings: DiscoverCoverTiming[] = [];
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
                portId: frame.getAttribute("data-artwork-port-id"),
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
        const firstOfflineControl = firstOffline
          ? await observeMissingCover({
              browser,
              ports,
              covers,
              refusedOrigins: firstOffline.origins,
              refusedImageRequestsBeforeControl: 0,
              invoke,
              captureSettled,
              screenshot: "default-cover-first-offline",
            })
          : null;
        if (firstOfflineControl) {
          await assertEmptyCache(cache);
          const firstOfflineReport = path.join(output, "default-cover-first-offline.json");
          await writeFile(firstOfflineReport, JSON.stringify(firstOfflineControl, null, 2), {
            flag: "wx",
          });
          artifacts.push(firstOfflineReport);
          browser = await restart("default-cover-after-first-offline");
        }
        const measureDiscover = cacheConditions && coverPortIds.length > 0;
        const timingPath = path.join(output, "default-cover-discover-timing.jsonl");
        if (measureDiscover) {
          await writeFile(timingPath, "", { flag: "wx" });
          artifacts.push(timingPath);
        }
        const recordDiscover = async (pass: string) => {
          const timing = await observeDiscoverCovers(browser, pass, primaryIds);
          discoverTimings.push(timing);
          await appendFile(timingPath, JSON.stringify(timing) + "\n");
        };
        for (const [pass, defaultTheme, defaultSize] of coverPasses(cacheConditions)) {
          const theme = measureDiscover ? "light" : defaultTheme;
          const size = measureDiscover ? { width: 1280, height: 800 } : defaultSize;
          if (cacheConditions && pass === "offline-cached-restart") {
            const measured = discoverTimings.flatMap((row) => row.readyIds);
            const observed = rows.flatMap((row) => [
              ...(row.cardImage ? [row.cardPortId] : []),
              ...(row.detailImage ? [row.id] : []),
            ]);
            await verifyMappedCache(covers, [...new Set([...measured, ...observed])], cache);
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
          if (measureDiscover) {
            await recordDiscover(pass);
            if (pass === "cold-empty-cache") {
              await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
              await recordDiscover("same-session-revisit");
            }
          }
          rows.push(
            ...(await inspectCoverPass({
              browser,
              ports,
              covers,
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
              ports,
              covers,
              coverPortId: required(
                rows.find((row) => row.id === "dkr-r" && row.pass === "offline-cached-restart"),
              ).cardPortId,
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
              detailObservationPortIds: [
                ...new Set(rows.filter((row) => row.detailImage).map((row) => row.id)),
              ],
              availableMappedCount: ports.filter((port) => port.presentation?.artwork).length,
              firstOfflineControl,
              negativeControl,
              refusedOrigins,
              catalogCount: ports.length,
              mappedCount: ids.length,
              discoverTimings,
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

async function verifyMappedCache(
  covers: ReadonlyMap<string, IgdbArtwork>,
  ids: string[],
  cache: string,
) {
  for (const digest of new Set(ids.map((id) => required(covers.get(id)).image_sha256))) {
    assert.match(digest, /^[a-f0-9]{64}$/);
    const bytes = await readFile(path.join(cache, `${digest}.jpg`));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      digest,
      "Cached original matches accepted mapping",
    );
  }
}

async function findCoverCard(browser: WebDriver, id: string) {
  // Membership is a JSON array. Match the whole quoted ID, which stays
  // part of the group when the card's current action changes.
  const member = JSON.stringify(JSON.stringify(id));
  const selector = `.discover-game[data-discover-port-ids*=${member}] .discover-game-identity`;
  const coverPortId = await browser.wait(
    async () => {
      if (!(await executeBrowserScript(browser, observeCollectionLayoutReady))) return null;
      return executeBrowserScript(
        browser,
        (selector) => {
          const card = document.querySelector(selector);
          const frame = card?.querySelector<HTMLElement>(".collection-art");
          const coverPortId = frame?.dataset.artworkPortId;
          if (!card || !coverPortId) return null;
          card.scrollIntoView({ block: "center", behavior: "instant" });
          return coverPortId;
        },
        selector,
      );
    },
    10_000,
    `Discover cover for ${id} did not settle`,
  );
  return { selector, coverPortId: required(coverPortId) };
}

async function missingCacheNegativeControl({
  browser,
  ports,
  covers,
  coverPortId,
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
  const digest = required(covers.get(coverPortId)).image_sha256;
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
  return observeMissingCover({
    browser,
    ports,
    covers,
    expectedCoverPortId: coverPortId,
    refusedOrigins,
    refusedImageRequestsBeforeControl,
    invoke,
    captureSettled,
    screenshot: "default-cover-missing-cache-offline",
  });
}

async function observeMissingCover({
  browser,
  ports,
  covers,
  expectedCoverPortId,
  refusedOrigins,
  refusedImageRequestsBeforeControl,
  invoke,
  captureSettled,
  screenshot,
}: Pick<
  MissingCacheContext,
  "browser" | "ports" | "covers" | "refusedOrigins" | "invoke" | "captureSettled"
> & {
  expectedCoverPortId?: string;
  refusedImageRequestsBeforeControl: number;
  screenshot: string;
}) {
  const port = ports.find((item) => item.id === "dkr-r");
  assert.ok(port?.presentation?.artwork, "Negative control requires the maintained DKR mapping");
  await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
  await searchForCover(browser, port.name);
  const { selector, coverPortId } = await findCoverCard(browser, port.id);
  if (expectedCoverPortId) assert.equal(coverPortId, expectedCoverPortId);
  const mapping = required(covers.get(coverPortId));
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
        (selector, coverPortId) => {
          const card = document.querySelector(selector)?.closest("article.discover-game");
          const frame = card?.querySelector<HTMLElement>(".collection-art");
          return (
            frame?.dataset.artworkPortId === coverPortId &&
            frame.dataset.artworkSource === "generated_fallback" &&
            !frame.querySelector("img") &&
            Array.from(card?.querySelectorAll(".discover-game-metadata > p") ?? []).some(
              (note) => note.textContent === "Image unavailable",
            )
          );
        },
        selector,
        coverPortId,
      ),
    10_000,
    "Unavailable image must retain an honest generated fallback",
  );
  await captureSettled(screenshot, selector, browser);
  assert.deepEqual(
    (await coverInventory(invoke)).covers.get(coverPortId),
    mapping,
    "Missing bytes do not erase the accepted logical mapping",
  );
  return {
    id: coverPortId,
    actionId: port.id,
    digest: mapping.image_sha256,
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

async function observeDiscoverCovers(
  browser: WebDriver,
  pass: string,
  primaryIds: string[],
): Promise<DiscoverCoverTiming> {
  const discover = await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]'));
  await executeBrowserScript(
    browser,
    (button, pass, primaryIds) => {
      const observation = window as CoverTimingWindow;
      delete observation.portcoveDiscoverCoverTiming;
      const mapped = new Set(primaryIds);
      const visible = new Set<string>();
      const ready = new Set<string>();
      const selector =
        '[data-detail-origin^="catalog:card:"] .collection-art[data-artwork-port-id]';
      button.addEventListener(
        "click",
        () => {
          const started = performance.now();
          const startedAtEpochMs = Date.now();
          const viewport = { width: innerWidth, height: innerHeight, devicePixelRatio };
          let firstReadyMs: number | null = null;
          let observer: IntersectionObserver | undefined;
          const inspect = (now: number) => {
            const elapsed = Math.max(0, now - started);
            const covers = document.querySelectorAll<HTMLElement>(selector);
            if (!visible.size && !observer) {
              const frames = new Map<Element, string>();
              for (const frame of covers) {
                const id = frame.dataset.artworkPortId;
                if (id && mapped.has(id)) frames.set(frame, id);
              }
              if (frames.size) {
                const reported = new Set<Element>();
                observer = new IntersectionObserver((entries) => {
                  for (const entry of entries) {
                    reported.add(entry.target);
                    const id = frames.get(entry.target);
                    if (
                      id &&
                      entry.isIntersecting &&
                      entry.intersectionRect.width > 0 &&
                      entry.intersectionRect.height > 0
                    )
                      visible.add(id);
                  }
                  if (reported.size === frames.size) {
                    observer?.disconnect();
                    observer = undefined;
                  }
                });
                for (const frame of frames.keys()) observer.observe(frame);
              }
            }
            if (!observer) {
              for (const frame of covers) {
                const id = frame.dataset.artworkPortId;
                if (!id || !visible.has(id) || ready.has(id)) continue;
                if (frame.dataset.artworkSource !== "igdb_cover") continue;
                const image = frame.querySelector("img");
                if (image?.complete && image.naturalWidth) ready.add(id);
              }
            }
            if (firstReadyMs === null && ready.size) firstReadyMs = elapsed;
            const complete = visible.size > 0 && ready.size === visible.size;
            if (complete || elapsed >= 15_000) {
              observer?.disconnect();
              observation.portcoveDiscoverCoverTiming = {
                scope: "accepted-primary-covers",
                pass,
                viewport,
                visibleIds: [...visible],
                readyIds: [...ready],
                startedAtEpochMs,
                observedAtEpochMs: Date.now(),
                firstReadyMs,
                cohortReadyMs: complete ? elapsed : null,
              };
            } else {
              requestAnimationFrame(inspect);
            }
          };
          requestAnimationFrame(inspect);
        },
        { capture: true, once: true },
      );
    },
    discover,
    pass,
    primaryIds,
  );
  await discover.click();
  const result = await browser.wait(
    async () => {
      return executeBrowserScript(
        browser,
        () => (window as CoverTimingWindow).portcoveDiscoverCoverTiming ?? null,
      );
    },
    20_000,
    `No native Discover artwork timing for ${pass}`,
  );
  return required(result);
}

async function inspectCoverPass({
  browser,
  ports,
  covers,
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
    const { selector, coverPortId: cardPortId } = await findCoverCard(browser, id).catch(
      async (error: unknown) => {
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
      },
    );
    const frameSelector = `${selector} .collection-art`;
    const cardMapping = covers.get(cardPortId) ?? null;
    const cardImage = cardMapping ? await image(frameSelector) : null;
    if (cardImage) assert.equal(cardImage.portId, cardPortId);
    else {
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (selector, portId) => {
              const frame = document.querySelector<HTMLElement>(selector);
              return (
                frame?.dataset.artworkPortId === portId &&
                ((frame.dataset.artworkSource === "generated_fallback" &&
                  !frame.querySelector("img")) ||
                  frame.dataset.artworkSource === "igdb_cover_collection")
              );
            },
            frameSelector,
            cardPortId,
          ),
        10_000,
        `Invalid cover fallback for ${cardPortId}`,
      );
    }
    const cardMs = cardImage ? performance.now() - started : null;
    await captureSettled(`default-cover-${id}-${pass}-catalog`, selector);
    let detailImage = null;
    if (detailIds.has(id) || cardPortId !== id) {
      await selectCatalogPort(browser, id);
      await revealDetailSection(browser, "Overview");
      const hero = await browser.findElement(By.css(".game-hero-detail"));
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "start" }),
        hero,
      );
      detailImage = await image(
        '.game-hero-detail[data-hero-identity="cover"] .game-hero-foreground',
      );
      await captureSettled(`default-cover-${id}-${pass}-details`, "[data-detail-workspace]");
    }
    observations.push({
      id,
      cardPortId,
      pass,
      theme,
      outer,
      viewport,
      cardMs,
      cardImage,
      cardMapping,
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
