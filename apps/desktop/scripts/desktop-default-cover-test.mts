import {
  createImageRefusal,
  restoreCacheAfterObservation,
  selectDefaultCoverIds,
  assertDefaultCoverPresentation,
  assertCachedCoverTraffic,
  type WithheldCover,
} from "./desktop-cover-observations.mts";
import {
  clickVisible,
  openCatalogPortAfterRefresh,
  revealDetailSection,
  selectCatalogPort,
} from "./desktop-review-controls.mts";
import { fixtureObject as object, fixtureSuccess as success } from "./desktop-scenario-state.mts";
import { observeCollectionLayoutReady } from "./browser-readiness.mts";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
import type { IRectangle } from "selenium-webdriver";
import type {
  CatalogListingDocument,
  IgdbArtwork,
  PortDefinition,
} from "../src/transport-types.generated.d.ts";
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
async function artworkWorkspace(invoke: CoverContext["invoke"]) {
  const { generation } = transportValue(
    "desktop_bootstrap_status",
    success(await invoke("get_bootstrap_status")),
  );
  const snapshot = transportValue(
    "desktop_workspace_snapshot",
    success(await invoke("get_workspace_snapshot", { generation })),
  );
  return { generation, snapshot };
}

async function coverInventory(invoke: CoverContext["invoke"]) {
  const { snapshot } = await artworkWorkspace(invoke);
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
import { errorMessage, errorCode } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { WebDriver, By, Key, until } from "selenium-webdriver";

function typedScreenshots(listings: CatalogListingDocument["listings"]) {
  return listings.flatMap((listing) =>
    (listing.media ?? [])
      .filter((media) => media.role === "screenshot" && media.igdb?.kind === "screenshot")
      .map((media) => ({ listing, media })),
  );
}

function screenshotIdentities(entries: ReturnType<typeof typedScreenshots>) {
  return entries
    .map(({ listing, media }) => {
      const subject = media.subject;
      const provider = required(media.igdb);
      return JSON.stringify([
        listing.id,
        media.id,
        media.sha256,
        media.caption,
        subject.kind === "port"
          ? [subject.kind, subject.port_id]
          : [subject.kind, subject.game_id, subject.source_edition_id],
        provider.game_id,
        provider.record_id,
        provider.image_id,
      ]);
    })
    .sort();
}

async function assertEmbeddedScreenshotCatalog(invoke: CoverContext["invoke"]) {
  assert.equal(success(await invoke("get_official_catalog_automatic_updates")), false);
  const delivery = transportValue(
    "listing_delivery_status",
    success(await invoke("get_listing_delivery_status")),
  );
  assert.equal(delivery.selected, false);
  assert.equal(delivery.revision, null);
  assert.equal(delivery.target_sha256, null);
  const status = transportValue("catalog_status", success(await invoke("get_catalog_status")));
  assert.equal(status.provenance.origin, "embedded");
}

// Exercise the embedded catalog through the real gallery and Core image cache.
export async function reviewedScreenshotScenario({
  browser: suppliedBrowser,
  scenario,
  invoke,
  output,
  library,
  artifacts,
  capture,
}: Pick<CoverContext, "browser" | "scenario" | "invoke" | "output" | "artifacts" | "capture"> & {
  library: string;
}) {
  await scenario("native-reviewed-screenshot-display", async () => {
    assert.ok(suppliedBrowser instanceof WebDriver, "Screenshot observation requires WebDriver");
    const browser = suppliedBrowser;
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    assert.equal(await realpath(required(bootstrap.library_root)), await realpath(library));
    assert.equal(
      success(await invoke("set_official_catalog_automatic_updates", { enabled: false })),
      false,
    );
    await assertEmbeddedScreenshotCatalog(invoke);

    const source = await readFile(
      new URL("../../../crates/portcove-core/catalog/listings.json", import.meta.url),
    );
    const bundled = transportValue("catalog_listings", JSON.parse(source.toString("utf8")));
    const entries = typedScreenshots(bundled.listings);
    assert.ok(entries.length, "This source must contain reviewed typed IGDB screenshots");
    const expected = screenshotIdentities(entries);
    const { generation, snapshot } = await artworkWorkspace(invoke);
    assert.equal(generation, bootstrap.generation);
    assert.deepEqual(
      screenshotIdentities(typedScreenshots(required(snapshot.listing_catalog).listings)),
      expected,
    );
    const rows = [];
    for (const { listing, media } of entries) {
      await openCatalogPortAfterRefresh(browser, listing, listing.name);
      await revealDetailSection(browser, "Overview");
      const gallery = await browser.wait(
        until.elementLocated(By.css('.catalog-media[aria-label="Screenshots"]')),
        15_000,
      );
      const subject = media.subject;
      if (subject.kind === "original") {
        const edition = required(
          listing.original_game?.source_editions.find(({ id }) => id === subject.source_edition_id),
        );
        const select = await gallery.findElement(By.css('[role="combobox"]'));
        await clickVisible(browser, select);
        const option = await browser.wait(async () => {
          const options = await browser.findElements(By.css('[role="option"]'));
          for (const candidate of options)
            if ((await candidate.getText()) === edition.title) return candidate;
          return false;
        }, 10_000);
        assert.ok(option);
        await clickVisible(browser, option);
      }
      const opener = await browser.wait(async () => {
        const buttons = await gallery.findElements(
          By.css('button[aria-label^="Enlarge screenshot "]'),
        );
        for (const candidate of buttons)
          if ((await candidate.getAttribute("aria-label"))?.endsWith(`: ${media.caption}`))
            return candidate;
        return false;
      }, 15_000);
      assert.ok(opener);
      await executeBrowserScript(
        browser,
        'arguments[0].scrollIntoView({ block: "center" });',
        opener,
      );
      await browser.wait(
        until.elementIsEnabled(opener),
        30_000,
        "Core screenshot thumbnail did not load",
      );
      await clickVisible(browser, opener);
      const viewer = await browser.wait(
        until.elementLocated(By.css('[role="dialog"] .media-viewer-stage')),
        15_000,
      );
      const thumbnail = object(
        success(
          await invoke("get_catalog_media_thumbnail", {
            portId: listing.id,
            mediaId: media.id,
            expectedSha256: media.sha256,
            generation,
            cacheOnly: true,
          }),
        ),
      );
      assert.equal(thumbnail.asset_sha256, media.sha256);
      const png = thumbnail.png_base64;
      assert.ok(typeof png === "string" && png.length);
      const rendered = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (viewer, expected) => {
              const image = viewer.querySelector("img");
              return image?.complete && image.naturalWidth > 0 && image.currentSrc === expected
                ? { width: image.naturalWidth, height: image.naturalHeight }
                : false;
            },
            viewer,
            `data:image/png;base64,${png}`,
          ),
        15_000,
        "Native gallery did not render the bytes returned for the exact admitted screenshot",
      );
      assert.ok(rendered);
      const dialog = await viewer.findElement(By.xpath('ancestor::*[@role="dialog"]'));
      assert.ok(
        (await dialog.getText()).includes(
          subject.kind === "original"
            ? "From the original release; this port may look different."
            : "Screenshot of this exact port.",
        ),
      );
      await capture(`native-screenshot-${listing.id}-${media.id}`, true);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element, portId) =>
              document.activeElement === element &&
              document
                .querySelector("[data-detail-workspace]")
                ?.getAttribute("data-detail-port-id") === portId,
            opener,
            listing.id,
          ),
        10_000,
        "Screenshot close did not restore focus to the same port's gallery",
      );
      rows.push({
        port_id: listing.id,
        media_id: media.id,
        sha256: media.sha256,
        subject,
        rendered,
      });
    }
    await assertEmbeddedScreenshotCatalog(invoke);
    const finalWorkspace = await artworkWorkspace(invoke);
    assert.equal(finalWorkspace.generation, generation);
    assert.deepEqual(
      screenshotIdentities(
        typedScreenshots(required(finalWorkspace.snapshot.listing_catalog).listings),
      ),
      expected,
    );
    const report = path.join(output, "native-reviewed-screenshot-display.json");
    const listing_source_sha256 = createHash("sha256").update(source).digest("hex");
    await writeFile(
      report,
      JSON.stringify(
        { generation, listing_origin: "embedded", listing_source_sha256, rows },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}

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
                until.elementLocated(By.css("[data-artwork-editor-trigger]")),
                5_000,
              );
              await controls.click();
              diagnostics = await executeBrowserScript(browser, () =>
                [...document.querySelectorAll(".artwork-sheet[open] [role=alert]")].map(
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
