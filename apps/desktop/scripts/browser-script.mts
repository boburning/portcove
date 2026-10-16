import type { WebDriver } from "selenium-webdriver";

/** Preserve Selenium's serialization boundary while checking callback arguments/results. */
export function executeBrowserScript<Arguments extends unknown[], Result>(
  browser: Pick<WebDriver, "executeScript">,
  script: (...args: Arguments) => Result,
  ...args: Arguments
): Promise<Awaited<Result>>;
export function executeBrowserScript(
  browser: Pick<WebDriver, "executeScript">,
  script: string,
  ...args: unknown[]
): Promise<unknown>;
export function executeBrowserScript<Arguments extends unknown[], Result>(
  browser: Pick<WebDriver, "executeScript">,
  script: string | ((...args: Arguments) => Result),
  ...args: Arguments
): Promise<Awaited<Result>> {
  return browser.executeScript<Awaited<Result>>(script, ...args);
}
