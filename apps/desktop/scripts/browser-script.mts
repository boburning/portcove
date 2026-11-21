import type { WebDriver, WebElement } from "selenium-webdriver";

/** Keep exact whole text; add aria-label and block primary labels without name overrides. */
export function exactButtonXPath(label: string) {
  if (label === "") return '//button[normalize-space(.)=""]';
  const value = label.includes('"')
    ? `concat(${label
        .split('"')
        .map((part) => `"${part}"`)
        .join(`, '"', `)})`
    : `"${label}"`;
  const primary = `(.//strong[contains(concat(' ', normalize-space(@class), ' '), ' block ') and not(ancestor-or-self::*[@aria-hidden='true'])])[1][normalize-space(.)=${value}]`;
  return `//button[normalize-space(.)=${value} or normalize-space(@aria-label)=${value} or (not(normalize-space(@aria-label)) and not(normalize-space(@aria-labelledby)) and ${primary})]`;
}

export function addGamesRouteXPath(label: "Browse games" | "Scan a folder") {
  return (
    '//section[@aria-label="Add games workspace" and not(@hidden)]//*[@role="group" and @aria-label="Ways to add games"]' +
    exactButtonXPath(label)
  );
}

// WebDriver encodes local element handles as DOM elements in script arguments.
type BrowserArgument<Value> = Value extends WebElement
  ? Element
  : Value extends readonly unknown[]
    ? { [Index in keyof Value]: BrowserArgument<Value[Index]> }
    : Value extends object
      ? { [Key in keyof Value]: BrowserArgument<Value[Key]> }
      : Value;
type BrowserArguments<Arguments extends unknown[]> = {
  [Index in keyof Arguments]: BrowserArgument<Arguments[Index]>;
};

type BrowserResult<Value> = Value extends Element
  ? WebElement
  : Value extends readonly unknown[]
    ? { [Index in keyof Value]: BrowserResult<Value[Index]> }
    : Value extends object
      ? { [Key in keyof Value]: BrowserResult<Value[Key]> }
      : Value;

/** Preserve Selenium's serialization boundary while checking callback arguments/results. */
export function executeBrowserScript<Arguments extends unknown[], Result>(
  browser: Pick<WebDriver, "executeScript">,
  script: (...args: BrowserArguments<Arguments>) => Result,
  ...args: Arguments
): Promise<BrowserResult<Awaited<Result>>>;
export function executeBrowserScript(
  browser: Pick<WebDriver, "executeScript">,
  script: string,
  ...args: unknown[]
): Promise<unknown>;
export function executeBrowserScript<Arguments extends unknown[], Result>(
  browser: Pick<WebDriver, "executeScript">,
  script: string | ((...args: BrowserArguments<Arguments>) => Result),
  ...args: Arguments
): Promise<BrowserResult<Awaited<Result>>> {
  return browser.executeScript<BrowserResult<Awaited<Result>>>(script, ...args);
}
