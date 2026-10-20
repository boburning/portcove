import type { WebDriver, WebElement, Locator } from "selenium-webdriver";
import type { PortDefinition } from "../src/transport-types.generated.js";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
// Shared native review interactions; visibility waits never bypass product consent.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, Key, until } from "selenium-webdriver";

export async function openCatalogPortAfterRefresh(
  browser: WebDriver,
  port: Pick<PortDefinition, "id">,
  query = "",
) {
  const { click } = reviewControls(browser);
  await browser.navigate().refresh();
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
  await click(By.xpath('//nav//button[contains(., "Find games")]'));
  const search = await browser.findElement(By.id("port-search"));
  await search.sendKeys(
    Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
    Key.BACK_SPACE,
    query,
  );
  await click(
    By.xpath('//div[@aria-label="Release channel filters"]//button[normalize-space(.)="All"]'),
  );
  await click(By.css(`[data-detail-origin="catalog:card:${port.id}"]`));
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

export function reviewControls(browser: WebDriver) {
  return {
    button: (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`),
    click: async (locator: Locator) =>
      clickVisible(browser, await browser.wait(until.elementLocated(locator), 15_000)),
  };
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
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        dialogOverflow: review.scrollWidth > review.clientWidth + 1,
        inView: bounds.left >= 0 && bounds.right <= window.innerWidth,
      };
    },
    selector,
  );
  assert.deepEqual(layout, {
    pageOverflow: false,
    dialogOverflow: false,
    inView: true,
  });
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

export async function assertReviewFieldPresentation(
  browser: WebDriver,
  field: WebElement,
  label: WebElement,
  dialog: WebElement,
) {
  const fieldPresentation = await executeBrowserScript(
    browser,
    (field, label, dialog) => {
      const fieldStyle = getComputedStyle(field);
      const labelStyle = getComputedStyle(label);
      const dialogStyle = getComputedStyle(dialog);
      return {
        width: fieldStyle.width,
        paddingLeft: fieldStyle.paddingLeft,
        borderStyle: fieldStyle.borderStyle,
        borderWidth: fieldStyle.borderWidth,
        backgroundColor: fieldStyle.backgroundColor,
        dialogBackgroundColor: dialogStyle.backgroundColor,
        color: fieldStyle.color,
        labelColor: labelStyle.color,
        labelFontWeight: labelStyle.fontWeight,
      };
    },
    field,
    label,
    dialog,
  );
  assert.ok(parseFloat(fieldPresentation.width) >= 200, JSON.stringify(fieldPresentation));
  assert.ok(parseFloat(fieldPresentation.paddingLeft) >= 10, JSON.stringify(fieldPresentation));
  assert.equal(fieldPresentation.borderStyle, "solid");
  assert.ok(parseFloat(fieldPresentation.borderWidth) >= 1, JSON.stringify(fieldPresentation));
  assert.notEqual(fieldPresentation.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.notEqual(fieldPresentation.backgroundColor, fieldPresentation.dialogBackgroundColor);
  assert.ok(Number(fieldPresentation.labelFontWeight) >= 700, JSON.stringify(fieldPresentation));
  return fieldPresentation;
}
