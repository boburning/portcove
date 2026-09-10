// Shared native review interactions; visibility waits never bypass product consent.
import assert from "node:assert/strict";
import { By, until } from "selenium-webdriver";

async function waitForEntrance(browser, element) {
  await browser.wait(() => browser.executeScript(element => {
    const dialog = element.closest('[role="dialog"]') ?? element;
    return !dialog.getAnimations().some(animation => animation.playState === "running");
  }, element), 5_000, "The review must finish its entrance animation before interaction or measurement");
}

export async function clickVisible(browser, element) {
  try {
    await waitForEntrance(browser, element);
    await browser.executeScript('arguments[0].focus({ preventScroll: true }); arguments[0].scrollIntoView({ block: "center" });', element);
    await browser.wait(until.elementIsVisible(element), 5_000);
    await browser.wait(until.elementIsEnabled(element), 5_000);
    await browser.wait(() => browser.executeScript(element => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit === element || element.contains(hit);
    }, element), 5_000, "The reviewed control must receive the pointer before clicking");
    await element.click();
  } catch (error) {
    const context = await browser.executeScript(element => ({
      target: element.outerHTML,
      expanded: element.closest("details")?.open,
      focused: document.activeElement?.outerHTML,
    }), element);
    throw new Error(`${error.message}\nReview control: ${JSON.stringify(context)}`, { cause: error });
  }
}

export function reviewControls(browser) {
  return {
    button: label => By.xpath(`//button[normalize-space(.)="${label}"]`),
    click: async locator => clickVisible(browser, await browser.wait(until.elementLocated(locator), 15_000)),
  };
}

export async function assertCompactReview(browser, selector) {
  await browser.manage().window().setRect({ width: 960, height: 640 });
  await waitForEntrance(browser, await browser.findElement(By.css(selector)));
  const layout = await browser.executeScript(selector => {
    const review = document.querySelector(selector);
    const bounds = review.getBoundingClientRect();
    return { pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, dialogOverflow: review.scrollWidth > review.clientWidth + 1, inView: bounds.left >= 0 && bounds.right <= window.innerWidth };
  }, selector);
  assert.deepEqual(layout, { pageOverflow: false, dialogOverflow: false, inView: true });
}
