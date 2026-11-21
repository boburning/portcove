import type { WebDriver, WebElement, Locator } from "selenium-webdriver";
import type { PortDefinition } from "../src/transport-types.generated.js";
import { isRecord, recordField } from "../../../scripts/runtime-values.mts";
import { exactButtonXPath, executeBrowserScript } from "./browser-script.mts";
import { decodeDiscoverPortIds } from "./desktop-review-presentation.mts";
// Shared native review interactions; visibility waits never bypass product consent.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, Key, until } from "selenium-webdriver";

/** Edit through real keys, releasing the modifier before a separate text command.
 * WebKitGTK can keep Control held through text after Element Send Keys' NULL.
 */
export async function replaceKeyboardText(browser: WebDriver, element: WebElement, text: string) {
  await clickVisible(browser, element);
  const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
  await browser.actions().keyDown(modifier).sendKeys("a").keyUp(modifier).perform();
  await element.sendKeys(Key.BACK_SPACE);
  if (text.length > 0) await element.sendKeys(text);
}

/** Find the direct preparation log disclosure in the Activity row. */
export async function preparationLogControl(browser: WebDriver, row: WebElement) {
  const log = await row.findElement(
    By.xpath('.//summary[normalize-space(.)="View preparation log"]'),
  );
  await browser.wait(until.elementIsVisible(log), 5_000);
  return log;
}

/** Open the scan workspace from the Game files settings category. */
export async function openGameFileScan(browser: WebDriver) {
  const trigger = await browser.wait(
    until.elementLocated(By.css("[data-open-game-file-scan]")),
    5_000,
  );
  await clickVisible(browser, trigger);
  await browser.wait(until.elementLocated(By.id("add-games-folders-heading")), 5_000);
}

/** Reveal the real panel through its tab; scrolling cannot reveal hidden content. */
export async function revealDetailSection(
  browser: WebDriver,
  label:
    | "Overview"
    | "Game files"
    | "Saves & backups"
    | "Versions & updates"
    | "Mods"
    | "Game settings"
    | "Manage",
) {
  const tab = await browser.wait(
    until.elementLocated(
      By.xpath(`//*[@data-detail-workspace]//*[@role="tab"][normalize-space(.)="${label}"]`),
    ),
    15_000,
  );
  if ((await tab.getAttribute("aria-selected")) !== "true") await clickVisible(browser, tab);
  await browser.wait(
    async () => {
      if ((await tab.getAttribute("aria-selected")) !== "true") return false;
      const panelId = await tab.getAttribute("aria-controls");
      if (!panelId) return false;
      const panel = await browser.findElement(By.id(panelId));
      return (
        (await panel.isDisplayed()) &&
        (await executeBrowserScript(
          browser,
          (element) => !element.hasAttribute("hidden") && !element.hasAttribute("inert"),
          panel,
        ))
      );
    },
    5_000,
    `The ${label} detail panel must be visible and interactive`,
  );
}

export async function openCatalogPortAfterRefresh(
  browser: WebDriver,
  port: Pick<PortDefinition, "id">,
  query = "",
) {
  await browser.navigate().refresh();
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  await selectPrimaryNavigation(browser, "Discover");
  const search = await browser.findElement(By.id("port-search"));
  await replaceKeyboardText(browser, search, query);
  await clearCatalogFilters(browser);
  await selectCatalogPort(browser, port.id);
}

async function catalogPortGroup(browser: WebDriver, portId: string): Promise<WebElement> {
  let selected: WebElement | undefined;
  await browser.wait(
    async () => {
      for (const group of await browser.findElements(
        By.css(".discover-game[data-discover-port-ids]"),
      )) {
        const ids = decodeDiscoverPortIds(await group.getAttribute("data-discover-port-ids"));
        if (ids.includes(portId)) {
          selected = group;
          return true;
        }
      }
      return false;
    },
    15_000,
    `Discover group for exact port ${portId} did not appear`,
  );
  assert.ok(selected);
  return selected;
}

/** Use the real single-port action or comparison dialog, never a direct state change. */
export async function selectCatalogPort(
  browser: WebDriver,
  portId: string,
  options: ReviewClickOptions = {},
) {
  // Search and filter results re-render after input, which can replace the
  // located group between lookup and click. Opening a port's detail is
  // non-mutating, so re-locate a bounded number of times on a stale reference.
  for (let attempt = 1; ; attempt++) {
    try {
      return await selectCatalogPortOnce(browser, portId, options);
    } catch (error) {
      if (!(error instanceof Error && error.name === "StaleElementReferenceError") || attempt >= 3)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function selectCatalogPortOnce(
  browser: WebDriver,
  portId: string,
  options: ReviewClickOptions,
) {
  const group = await catalogPortGroup(browser, portId);
  const matching = decodeDiscoverPortIds(
    await group.getAttribute("data-discover-matching-port-ids"),
  );
  if (matching.length === 1 && matching[0] === portId) {
    await clickVisible(
      browser,
      await group.findElement(By.css(".discover-game-identity")),
      options,
    );
  } else {
    const compare = await group.findElement(
      By.xpath('.//button[starts-with(normalize-space(.),"Compare")]'),
    );
    await clickVisible(browser, compare, options);
    const target = await browser.wait(
      until.elementLocated(By.css(`[role="dialog"] button[data-discover-port-id="${portId}"]`)),
      5_000,
    );
    await clickVisible(browser, target, options);
  }
  await browser.wait(
    until.elementLocated(By.css(`[data-detail-workspace][data-detail-port-id="${portId}"]`)),
    15_000,
  );
}

export async function catalogResultPortIds(browser: WebDriver): Promise<string[]> {
  const groups = await executeBrowserScript(browser, () =>
    [
      ...document.querySelectorAll<HTMLElement>(".discover-game[data-discover-matching-port-ids]"),
    ].map((group) => group.dataset.discoverMatchingPortIds ?? null),
  );
  const ids = groups.flatMap(decodeDiscoverPortIds).sort();
  assert.equal(
    new Set(ids).size,
    ids.length,
    "Each matching port appears in exactly one authored group",
  );
  return ids;
}

export async function openCatalogFilters(browser: WebDriver, options: ReviewClickOptions = {}) {
  const trigger = await browser.wait(
    until.elementLocated(By.xpath('//button[starts-with(@aria-label,"Filters (")]')),
    15_000,
  );
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await clickVisible(browser, trigger, options);
  const panel = await browser.wait(
    until.elementLocated(By.css('section[aria-label="Filter options"]')),
    5_000,
  );
  await browser.wait(until.elementIsVisible(panel), 5_000);
  return panel;
}

export async function clearCatalogFilters(browser: WebDriver, options: ReviewClickOptions = {}) {
  const panel = await openCatalogFilters(browser, options);
  await clickVisible(
    browser,
    await panel.findElement(By.xpath('.//button[normalize-space(.)="Clear filters"]')),
    options,
  );
  await clickVisible(
    browser,
    await panel.findElement(By.xpath('.//button[normalize-space(.)="Done"]')),
    options,
  );
}

async function waitForEntrance(browser: WebDriver, element: WebElement) {
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (element) => {
          const dialog = element.closest('[role="dialog"]') ?? element;
          return !dialog.getAnimations().some((animation) => animation.playState === "running");
        },
        element,
      ),
    5_000,
    "The review must finish its entrance animation before interaction or measurement",
  );
}

export interface WebKitPointerObservation {
  target: { tag: string; id: string; role: string | null; label: string };
  cssPoint: { x: number; y: number };
  nativePoint: { x: number; y: number };
  pageZoom: number;
  viewport: { width: number; height: number };
  delivered: boolean;
}

export type ReviewClickOptions =
  | { dispatch?: "webdriver" | "dom" }
  | {
      dispatch: "webkit-window-pointer";
      pageZoom: 4;
      baselineViewport: { width: number; height: number };
      observe: (observation: WebKitPointerObservation) => void;
    };

/** Re-observe the same control after scrolling. Callers must still confirm delivery. */
function revealPointerTarget(element: Element) {
  element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  const bounds = element.getBoundingClientRect();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const hit = document.elementFromPoint(centerX, centerY);
  return hit === element || element.contains(hit) ? { x: centerX, y: centerY } : false;
}

export async function clickVisible(
  browser: WebDriver,
  element: WebElement,
  options: ReviewClickOptions = {},
) {
  const { dispatch = "webdriver" } = options;
  let stage = "entrance";
  let webkitPointer: WebKitPointerObservation | undefined;
  try {
    await waitForEntrance(browser, element);
    stage = "focus";
    await executeBrowserScript(browser, "arguments[0].focus({ preventScroll: true });", element);
    // Native visibility can reject an offscreen control before WebDriver's
    // eventual click has a chance to scroll it. Reveal the target first;
    // hidden/disabled/occluded controls still fail the existing gates below.
    stage = "scroll";
    await executeBrowserScript(
      browser,
      (element) =>
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
      element,
    );
    stage = "visible";
    await browser.wait(until.elementIsVisible(element), 5_000);
    stage = "enabled";
    await browser.wait(until.elementIsEnabled(element), 5_000);
    stage = "pointer-target";
    const point = await browser.wait(
      () => executeBrowserScript(browser, revealPointerTarget, element),
      5_000,
      "The reviewed control must receive the pointer before clicking",
    );
    if (dispatch === "dom") {
      stage = "dom-click";
      await executeBrowserScript(browser, "arguments[0].click();", element);
    } else if (options.dispatch === "webkit-window-pointer") {
      stage = "webkit-window-point";
      assert.equal(process.platform, "linux", "GTK window coordinates are Linux-only");
      assert.equal(options.pageZoom, 4, "Only the reviewed 400% journey uses GTK coordinates");
      assert.ok(point);
      const geometry = await executeBrowserScript(
        browser,
        (element) => ({
          zoom: localStorage.getItem("portcove.appearance.interface-size"),
          viewport: { width: innerWidth, height: innerHeight },
          target: {
            tag: element.tagName,
            id: element.id.slice(0, 80),
            role: element.getAttribute("role")?.slice(0, 40) ?? null,
            label: (element.getAttribute("aria-label") ?? element.textContent ?? "")
              .trim()
              .slice(0, 120),
          },
        }),
        element,
      );
      assert.equal(geometry.zoom, "400", "GTK pointer conversion must retain actual 400% zoom");
      for (const axis of ["width", "height"] as const)
        assert.ok(
          Number.isFinite(geometry.viewport[axis]) &&
            geometry.viewport[axis] > 0 &&
            Number.isFinite(options.baselineViewport[axis]) &&
            options.baselineViewport[axis] > 0 &&
            Math.abs(geometry.viewport[axis] * options.pageZoom - options.baselineViewport[axis]) <=
              8,
          "GTK pointer conversion requires the measured enlarged viewport",
        );
      const move = async (cssPoint: WebKitPointerObservation["cssPoint"]) => {
        stage = "webkit-window-point";
        assert.ok(
          Number.isFinite(cssPoint.x) &&
            Number.isFinite(cssPoint.y) &&
            cssPoint.x >= 0 &&
            cssPoint.x < geometry.viewport.width &&
            cssPoint.y >= 0 &&
            cssPoint.y < geometry.viewport.height,
          "The CSS target point must be inside the enlarged viewport",
        );
        const pointer: WebKitPointerObservation = {
          target: geometry.target,
          cssPoint,
          nativePoint: {
            x: Math.floor(cssPoint.x * options.pageZoom),
            y: Math.floor(cssPoint.y * options.pageZoom),
          },
          pageZoom: options.pageZoom,
          viewport: geometry.viewport,
          delivered: false,
        };
        webkitPointer = pointer;
        options.observe(pointer);
        stage = "webkit-pointer-move";
        // GTK receives window coordinates. DOM tests below stay in CSS pixels.
        await browser
          .actions()
          .move({ ...pointer.nativePoint, duration: 0 })
          .perform();
        stage = "webkit-delivered-target";
        return pointer;
      };
      const sample = (pointer: WebKitPointerObservation) =>
        executeBrowserScript(
          browser,
          (element, point, zoom, viewport) => {
            const eligible =
              localStorage.getItem("portcove.appearance.interface-size") === "400" &&
              innerWidth === viewport.width &&
              innerHeight === viewport.height &&
              !element.matches(":disabled");
            const hit = document.elementFromPoint(point.x / zoom, point.y / zoom);
            const sameTarget = hit === element || element.contains(hit);
            return {
              eligible,
              sameTarget,
              delivered: eligible && sameTarget && element.matches(":hover"),
            };
          },
          element,
          pointer.nativePoint,
          options.pageZoom,
          geometry.viewport,
        );
      let pointer = await move(point);
      let repositioned = false;
      await browser.wait(
        async () => {
          const current = await sample(pointer);
          if (current.delivered) return true;
          if (!current.eligible || current.sameTarget || repositioned) return false;

          // A measured collection row can move during native pointer delivery.
          // Recenter the exact same control once within the existing wait.
          repositioned = true;
          const updated = await executeBrowserScript(browser, revealPointerTarget, element);
          if (!updated || (updated.x === pointer.cssPoint.x && updated.y === pointer.cssPoint.y))
            return false;
          pointer = await move(updated);
          return (await sample(pointer)).delivered;
        },
        5_000,
        "The native GTK pointer must hover the reviewed target before pressing",
      );
      pointer.delivered = true;
      stage = "webkit-pointer-click";
      await browser.actions().press().release().perform();
    } else {
      stage = "webdriver-click";
      assert.equal(dispatch, "webdriver", `Unsupported click dispatch: ${dispatch}`);
      await element.click();
    }
  } catch (error) {
    // WebDriver can return an empty message with a meaningful error class.
    // Keep this prefix before DOM details, including in the bounded job record.
    const boundedJsonString = (value: string, maximumBytes: number) => {
      let result = "";
      let bytes = 2; // Include the JSON string's quotes, escapes and UTF-8 encoding.
      for (const character of value) {
        const size = Buffer.byteLength(JSON.stringify(character)) - 2;
        if (bytes + size > maximumBytes) break;
        result += character;
        bytes += size;
      }
      return result;
    };
    const describe = (value: unknown) => {
      let type: string = typeof value;
      let name = "";
      let message = "<unreadable error>";
      try {
        if (value instanceof Error) type = "Error";
        const reportedName = recordField(value, "name");
        if (typeof reportedName === "string") name = reportedName;
      } catch {
        /* A diagnostic inspection must not replace the original rejection. */
      }
      try {
        const reportedMessage = recordField(value, "message");
        message = typeof reportedMessage === "string" ? reportedMessage : String(value);
      } catch {
        /* Retain the original cause below. */
      }
      const boundedName = boundedJsonString(name, 128);
      const boundedMessage = boundedJsonString(message, 1024);
      return {
        type,
        name: boundedName,
        name_truncated: boundedName !== name,
        message: boundedMessage,
        message_truncated: boundedMessage !== message,
      };
    };
    const primary = { stage, error: describe(error), webkitPointer };
    let details: string;
    try {
      const context = await executeBrowserScript(
        browser,
        (element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          const scrollContainers = [];
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.scrollHeight > parent.clientHeight)
              scrollContainers.push({
                element: parent.outerHTML.slice(0, 200),
                scrollTop: parent.scrollTop,
                clientHeight: parent.clientHeight,
                scrollHeight: parent.scrollHeight,
              });
          }
          return {
            target: element.outerHTML,
            expanded: element.closest("details")?.open,
            focused: document.activeElement?.outerHTML,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            hit: hit?.outerHTML,
            scrollContainers,
          };
        },
        element,
      );
      details = `Review control: ${JSON.stringify(context)}`;
    } catch (contextError) {
      details = `Review control unavailable: ${JSON.stringify(describe(contextError))}`;
    }
    throw new Error(`Review interaction failed: ${JSON.stringify(primary)}\n${details}`, {
      cause: error,
    });
  }
}

/** Use the shipping narrow navigation sheet when the desktop navigation is hidden. */
export async function selectPrimaryNavigation(
  browser: WebDriver,
  label: "Library" | "Discover" | "Activity" | "Settings",
  options: ReviewClickOptions = {},
) {
  const locator = By.xpath(
    `//nav[@aria-label="Primary navigation"]//button[.//span[normalize-space(.)="${label}"]]`,
  );
  const renderedDestination = async () => {
    let rendered: WebElement | undefined;
    for (const candidate of await browser.findElements(locator)) {
      // A wide navigation item can be clipped by document scrolling. Choose its
      // rendered route before clickVisible reveals it; responsive display:none
      // destinations still require the shipping narrow sheet.
      const state = await executeBrowserScript(
        browser,
        (element) => ({
          rendered:
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden" &&
            !element.closest("[hidden], [inert]"),
          inSheet: element.closest(".navigation-sheet") !== null,
        }),
        candidate,
      );
      if (!state.rendered) continue;
      // Below 42rem the icon rail stays beside the sheet. An open sheet's modal
      // overlay covers that rail, so its own destination is the one that can be
      // clicked.
      if (state.inSheet) return candidate;
      rendered ??= candidate;
    }
    return rendered;
  };
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  let destination = await renderedDestination();
  if (!destination) {
    const trigger = await browser.wait(
      until.elementLocated(By.css('button[aria-label="Open navigation"]')),
      5_000,
    );
    await clickVisible(browser, trigger, options);
    await browser.wait(async () => {
      destination = await renderedDestination();
      return Boolean(destination);
    }, 5_000);
  }
  assert.ok(destination, `Visible primary navigation destination missing: ${label}`);
  await clickVisible(browser, destination, options);
  await browser.wait(
    async () => {
      const sheets = await browser.findElements(By.css(".navigation-sheet"));
      return !(await Promise.all(sheets.map((sheet) => sheet.isDisplayed()))).some(Boolean);
    },
    5_000,
    "The narrow navigation sheet must close after choosing a destination",
  );
}

// The detail hero, the Game files review opener and the review confirmation all
// read "Finish setup"; these name the tab's opener and the dialog's confirmation
// by their owning region instead of by label alone.
export const setupReviewButton = () =>
  By.xpath(
    '//section[@aria-label="Finish setup"]//button[normalize-space(.)="Finish setup" and not(@hidden) and not(ancestor::*[@hidden or @inert])]',
  );
export const setupConfirmButton = () =>
  By.xpath(
    '//*[@aria-labelledby="preparation-review-title"]//button[normalize-space(.)="Finish setup"]',
  );

export function reviewControls(browser: WebDriver, options: ReviewClickOptions = {}) {
  return {
    button: (label: string) => By.xpath(exactButtonXPath(label)),
    click: async (locator: Locator) =>
      clickVisible(browser, await browser.wait(until.elementLocated(locator), 15_000), options),
  };
}

/** Open the exact Core review through its visible action; no update is applied here. */
export async function reviewGameUpdateDisposition(
  browser: WebDriver,
  choice: "install" | "prepare" | "download",
) {
  const section = await browser.wait(
    until.elementLocated(By.css('section[aria-label="Review game update"]')),
    15_000,
  );
  if (choice === "prepare") {
    const summary = await section.findElement(
      By.xpath('.//summary[normalize-space(.)="Advanced update choice"]'),
    );
    const details = await summary.findElement(By.xpath(".."));
    if ((await details.getAttribute("open")) === null) await clickVisible(browser, summary);
  }
  const label = {
    install: "Update now",
    prepare: "Prepare for later",
    download: "Download for later",
  }[choice];
  await clickVisible(
    browser,
    await section.findElement(By.xpath(`.//button[normalize-space(.)="${label}"]`)),
  );
}

/** Settings panels stay mounted while hidden; locating their controls is insufficient. */
export async function selectGameFilesSettings(
  browser: WebDriver,
  options: ReviewClickOptions = {},
) {
  await reviewControls(browser, options).click(
    By.xpath('//nav[@aria-label="Settings categories"]//button[normalize-space(.)="Game files"]'),
  );
  const heading = await browser.wait(
    until.elementLocated(By.id("game-file-libraries-heading")),
    5_000,
  );
  await browser.wait(until.elementIsVisible(heading), 5_000);
}

export async function assertCompactReview(browser: WebDriver, selector: string) {
  await browser.manage().window().setRect({ width: 960, height: 640 });
  await waitForEntrance(browser, await browser.findElement(By.css(selector)));
  const layout = await executeBrowserScript(
    browser,
    (selector) => {
      const review = document.querySelector(selector);
      if (!review) throw new Error(`Review not found: ${selector}`);
      const bounds = review.getBoundingClientRect();
      const geometry = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          class: element.getAttribute("class"),
          text: element.textContent?.slice(0, 100),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          rect: { left: rect.left, right: rect.right, width: rect.width },
          width: style.width,
          minWidth: style.minWidth,
          gridTemplateColumns: style.gridTemplateColumns,
          padding: style.padding,
          margin: style.margin,
          boxSizing: style.boxSizing,
          overflowX: style.overflowX,
          overflowWrap: style.overflowWrap,
          whiteSpace: style.whiteSpace,
          fontSize: style.fontSize,
        };
      };
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        dialogOverflow: review.scrollWidth > review.clientWidth + 1,
        inView: bounds.left >= 0 && bounds.right <= window.innerWidth,
        diagnostics: {
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          review: geometry(review),
          children: [...review.children].map(geometry),
          overflowing: [...review.querySelectorAll("*")]
            .filter(
              (element) =>
                element.scrollWidth > element.clientWidth + 1 ||
                element.getBoundingClientRect().right > bounds.right + 1,
            )
            .slice(0, 30)
            .map(geometry),
          // Outermost page elements past the viewport, outside the review, so a
          // page-level reflow failure names its source.
          pageOverflowing: [...document.body.querySelectorAll("*")]
            .filter(
              (element) =>
                !review.contains(element) &&
                element.getBoundingClientRect().right > window.innerWidth + 1 &&
                !(
                  element.parentElement &&
                  element.parentElement.getBoundingClientRect().right > window.innerWidth + 1
                ),
            )
            .slice(0, 10)
            .map(geometry),
        },
      };
    },
    selector,
  );
  const { pageOverflow, dialogOverflow, inView } = layout;
  assert.deepEqual(
    { pageOverflow, dialogOverflow, inView },
    {
      pageOverflow: false,
      dialogOverflow: false,
      inView: true,
    },
    JSON.stringify(layout.diagnostics),
  );
}

async function assertSemanticReviewAction(
  browser: WebDriver,
  action: WebElement,
  neutral: WebElement,
  variant: string,
  description: string,
) {
  await waitForEntrance(browser, action);
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        (action, neutral) =>
          ![...action.getAnimations(), ...neutral.getAnimations()].some(
            (animation) => animation.playState === "running",
          ),
        action,
        neutral,
      ),
    5_000,
    "Review controls must finish their style transitions before visual measurement",
  );
  const styles = await executeBrowserScript(
    browser,
    (action, neutral) => {
      const snapshot = (element: Element) => {
        const computed = getComputedStyle(element);
        return {
          background: computed.backgroundColor,
          border: computed.borderColor,
          color: computed.color,
        };
      };
      return {
        action: snapshot(action),
        neutral: snapshot(neutral),
        variant: action.getAttribute("data-variant") ?? undefined,
      };
    },
    action,
    neutral,
  );
  assert.equal(styles.variant, variant);
  assert.notDeepEqual(
    styles.action,
    styles.neutral,
    `${description} must remain visually distinct from its neutral dismissal: ${JSON.stringify(styles)}`,
  );
  return styles;
}

export async function assertDestructiveReviewAction(
  browser: WebDriver,
  destructive: WebElement,
  neutral: WebElement,
) {
  return assertSemanticReviewAction(
    browser,
    destructive,
    neutral,
    "destructive",
    "A destructive review action",
  );
}

export async function assertPrimaryReviewAction(
  browser: WebDriver,
  primary: WebElement,
  neutral: WebElement,
) {
  return assertSemanticReviewAction(
    browser,
    primary,
    neutral,
    "primary",
    "A primary review action",
  );
}

/** Reads the already injected engine without claiming a clean report. */
export async function observeAccessibility(browser: WebDriver): Promise<unknown> {
  return browser.executeAsyncScript<unknown>((done: (value: unknown) => void) => {
    const injected: unknown = Reflect.get(window, "axe");
    if (
      !injected ||
      typeof injected !== "object" ||
      !("run" in injected) ||
      typeof injected.run !== "function"
    )
      throw new Error("Accessibility engine was not injected");
    // Full node detail only where a finding is reported: passing rules keep one
    // example node each, so a whole-catalog page stays inside the evidence bound.
    const result: unknown = Reflect.apply(injected.run, injected, [
      document,
      { resultTypes: ["violations", "incomplete"] },
    ]);
    return Promise.resolve(result).then(done);
  });
}

export function assertNoAccessibilityViolations(accessibility: unknown): void {
  assert(isRecord(accessibility) && Array.isArray(accessibility.violations));
  const violations = accessibility.violations.map((item: unknown) => {
    assert(isRecord(item) && typeof item.id === "string");
    return item.id;
  });
  assert.deepEqual(violations, []);
}

export async function captureAccessibilityReport(
  browser: WebDriver,
  report: string,
  artifacts: string[],
) {
  await executeBrowserScript(browser, axe.source);
  const accessibility = await observeAccessibility(browser);
  const serialized = JSON.stringify(accessibility, null, 2);
  if (serialized === undefined) throw new Error("Accessibility engine returned no JSON result");
  await writeFile(report, serialized, { flag: "wx" });
  artifacts.push(report);
  assertNoAccessibilityViolations(accessibility);
}

export { assertReviewFieldPresentation } from "./desktop-review-presentation.mts";
