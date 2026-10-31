import type { WebDriver, WebElement, Locator } from "selenium-webdriver";
import type { PortDefinition } from "../src/transport-types.generated.js";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { decodeDiscoverPortIds } from "./desktop-review-presentation.mts";
// Shared native review interactions; visibility waits never bypass product consent.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, Key, until } from "selenium-webdriver";

/** Reveal the retained log through its real enclosing disclosure. */
export async function preparationLogControl(browser: WebDriver, row: WebElement) {
  const taskDetails = await row.findElement(
    By.xpath('.//summary[normalize-space(.)="Task details"]'),
  );
  const details = await taskDetails.findElement(By.xpath(".."));
  if ((await details.getAttribute("open")) === null) await clickVisible(browser, taskDetails);
  const log = await row.findElement(
    By.xpath('.//summary[normalize-space(.)="View preparation log"]'),
  );
  await browser.wait(until.elementIsVisible(log), 5_000);
  return log;
}

/** Reveal the real panel through its tab; scrolling cannot reveal hidden content. */
export async function revealDetailSection(
  browser: WebDriver,
  label: "Overview" | "Game files" | "Saves & backups" | "Versions & updates" | "Manage",
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
  await search.sendKeys(
    Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
    Key.BACK_SPACE,
    query,
  );
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
export async function selectCatalogPort(browser: WebDriver, portId: string) {
  const group = await catalogPortGroup(browser, portId);
  const matching = decodeDiscoverPortIds(
    await group.getAttribute("data-discover-matching-port-ids"),
  );
  if (matching.length === 1 && matching[0] === portId) {
    await clickVisible(browser, await group.findElement(By.css(".discover-game-identity")));
  } else {
    const compare = await group.findElement(
      By.xpath('.//button[starts-with(normalize-space(.),"Compare")]'),
    );
    await clickVisible(browser, compare);
    const target = await browser.wait(
      until.elementLocated(By.css(`[role="dialog"] button[data-discover-port-id="${portId}"]`)),
      5_000,
    );
    await clickVisible(browser, target);
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

export async function openCatalogFilters(browser: WebDriver) {
  const trigger = await browser.wait(
    until.elementLocated(By.xpath('//button[starts-with(normalize-space(.),"Filters (")]')),
    15_000,
  );
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await clickVisible(browser, trigger);
  const panel = await browser.wait(
    until.elementLocated(By.css('section[aria-label="Filter options"]')),
    5_000,
  );
  await browser.wait(until.elementIsVisible(panel), 5_000);
  return panel;
}

export async function clearCatalogFilters(browser: WebDriver) {
  const panel = await openCatalogFilters(browser);
  await clickVisible(
    browser,
    await panel.findElement(By.xpath('.//button[normalize-space(.)="Clear filters"]')),
  );
  await clickVisible(
    browser,
    await panel.findElement(By.xpath('.//button[normalize-space(.)="Done"]')),
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

export async function clickVisible(
  browser: WebDriver,
  element: WebElement,
  { dispatch = "webdriver" }: { dispatch?: "webdriver" | "dom" } = {},
) {
  try {
    await waitForEntrance(browser, element);
    await executeBrowserScript(browser, "arguments[0].focus({ preventScroll: true });", element);
    // Native visibility can reject an offscreen control before WebDriver's
    // eventual click has a chance to scroll it. Reveal the target first;
    // hidden/disabled/occluded controls still fail the existing gates below.
    await executeBrowserScript(
      browser,
      (element) =>
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
      element,
    );
    await browser.wait(until.elementIsVisible(element), 5_000);
    await browser.wait(until.elementIsEnabled(element), 5_000);
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => {
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            const bounds = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return hit === element || element.contains(hit);
          },
          element,
        ),
      5_000,
      "The reviewed control must receive the pointer before clicking",
    );
    if (dispatch === "dom") await executeBrowserScript(browser, "arguments[0].click();", element);
    else {
      assert.equal(dispatch, "webdriver", `Unsupported click dispatch: ${dispatch}`);
      await element.click();
    }
  } catch (error) {
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
    throw new Error(`${errorMessage(error)}\nReview control: ${JSON.stringify(context)}`, {
      cause: error,
    });
  }
}

/** Use the shipping narrow navigation sheet when the desktop navigation is hidden. */
export async function selectPrimaryNavigation(
  browser: WebDriver,
  label: "Library" | "Discover" | "Activity" | "Settings",
) {
  const locator = By.xpath(
    `//nav[@aria-label="Primary navigation"]//button[.//span[normalize-space(.)="${label}"]]`,
  );
  const renderedDestination = async () => {
    for (const candidate of await browser.findElements(locator)) {
      // A wide navigation item can be clipped by document scrolling. Choose its
      // rendered route before clickVisible reveals it; responsive display:none
      // destinations still require the shipping narrow sheet.
      if (
        await executeBrowserScript(
          browser,
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden" &&
            !element.closest("[hidden], [inert]"),
          candidate,
        )
      )
        return candidate;
    }
    return undefined;
  };
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  let destination = await renderedDestination();
  if (!destination) {
    const trigger = await browser.wait(
      until.elementLocated(By.css('button[aria-label="Open navigation"]')),
      5_000,
    );
    await clickVisible(browser, trigger);
    await browser.wait(async () => {
      destination = await renderedDestination();
      return Boolean(destination);
    }, 5_000);
  }
  assert.ok(destination, `Visible primary navigation destination missing: ${label}`);
  await clickVisible(browser, destination);
  await browser.wait(
    async () => {
      const sheets = await browser.findElements(By.css(".navigation-sheet"));
      return !(await Promise.all(sheets.map((sheet) => sheet.isDisplayed()))).some(Boolean);
    },
    5_000,
    "The narrow navigation sheet must close after choosing a destination",
  );
}

export function reviewControls(browser: WebDriver) {
  return {
    button: (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`),
    click: async (locator: Locator) =>
      clickVisible(browser, await browser.wait(until.elementLocated(locator), 15_000)),
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
export async function selectGameFilesSettings(browser: WebDriver) {
  await reviewControls(browser).click(
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
    const result: unknown = Reflect.apply(injected.run, injected, []);
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
