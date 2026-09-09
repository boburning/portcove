// Shared native review interactions; visibility waits never bypass product consent.
import assert from "node:assert/strict";
import { By, until } from "selenium-webdriver";

export async function clickVisible(browser, element) {
  await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', element);
  await browser.wait(until.elementIsVisible(element), 5_000);
  await browser.wait(until.elementIsEnabled(element), 5_000);
  await element.click();
}

export function reviewControls(browser) {
  return {
    button: label => By.xpath(`//button[normalize-space(.)="${label}"]`),
    click: async locator => clickVisible(browser, await browser.wait(until.elementLocated(locator), 15_000)),
  };
}

export async function assertCompactReview(browser, selector) {
  await browser.manage().window().setRect({ width: 960, height: 640 });
  const layout = await browser.executeScript(selector => {
    const review = document.querySelector(selector);
    const bounds = review.getBoundingClientRect();
    return { pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, dialogOverflow: review.scrollWidth > review.clientWidth + 1, inView: bounds.left >= 0 && bounds.right <= window.innerWidth };
  }, selector);
  assert.deepEqual(layout, { pageOverflow: false, dialogOverflow: false, inView: true });
}
