import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";

import type {
  WebDriver,
  By as SeleniumBy,
  Key as SeleniumKey,
  until as seleniumUntil,
} from "selenium-webdriver";
interface DesignCompatibilityOptions {
  browser: Pick<WebDriver, "wait" | "findElement" | "findElements" | "executeScript" | "actions">;
  By: typeof SeleniumBy;
  Key: typeof SeleniumKey;
  until: typeof seleniumUntil;
}
export async function assertDesignCompatibility({
  browser,
  By,
  Key,
  until,
}: DesignCompatibilityOptions) {
  const fixtureLocator = By.css(".design-compatibility-fixture");
  await browser.wait(until.elementLocated(fixtureLocator), 15_000);
  const fixtureElement = await browser.findElement(fixtureLocator);
  const cachedFixtureId = await fixtureElement.getId();
  const observeStep = async <Result,>(phase: string, operation: () => Promise<Result>) => {
    try {
      return await operation();
    } catch (error) {
      let state;
      try {
        state = await executeBrowserScript(browser, () => {
          const root = document.querySelector(".design-compatibility-fixture");
          const trigger = document.querySelector("#fixture-open-dialog");
          return {
            url: location.href,
            readyState: document.readyState,
            fixtureConnected: root?.isConnected ?? false,
            fixture:
              root instanceof HTMLElement ? Object.fromEntries(Object.entries(root.dataset)) : null,
            dialogCount: document.querySelectorAll('[data-slot="dialog-content"]').length,
            triggerExpanded: trigger?.getAttribute("aria-expanded"),
            activeElement: document.activeElement?.id ?? null,
          };
        });
      } catch (probeError) {
        state = { probeFailure: String(probeError) };
      }
      throw new Error(
        `design compatibility ${phase} failed: ${String(error)}; cached fixture ${cachedFixtureId}; state: ${JSON.stringify(state)}`,
        { cause: error },
      );
    }
  };
  const fixture = {
    getAttribute: (name: string) =>
      observeStep(`read ${name}`, () => fixtureElement.getAttribute(name)),
  };
  const environment = await executeBrowserScript(browser, () => {
    const browserNavigator: Navigator & { userAgentData?: { architecture?: string } } = navigator;
    return {
      architecture: browserNavigator.userAgentData?.architecture ?? null,
      platform: navigator.platform,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      supportsColorMix: CSS.supports("color", "color-mix(in oklch, red, blue)"),
      supportsOklch: CSS.supports("color", "oklch(0.5 0.1 30)"),
      userAgent: navigator.userAgent,
    };
  });
  assert.equal(environment.supportsColorMix, true);
  assert.equal(environment.supportsOklch, true);

  await browser.wait(
    async () =>
      executeBrowserScript(browser, () => {
        const asset = document.querySelector("[data-offline-asset]");
        return asset instanceof HTMLImageElement && asset.complete && asset.naturalWidth > 0;
      }),
    15_000,
  );
  assert.deepEqual(
    await executeBrowserScript(browser, () =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => {
          const resource = new URL(name);
          return (
            ["http:", "https:"].includes(resource.protocol) &&
            !["tauri.localhost", "asset.localhost"].includes(resource.hostname)
          );
        }),
    ),
    [],
  );

  const darkColors = await executeBrowserScript(browser, () => {
    const root = document.querySelector(".design-compatibility-fixture");
    const probe = document.querySelector("[data-theme-variant-probe]");
    if (!(root instanceof HTMLElement) || !(probe instanceof HTMLElement)) return null;
    return {
      background: getComputedStyle(root).backgroundColor,
      variantOpacity: getComputedStyle(probe).opacity,
      theme: root.dataset.theme,
    };
  });
  assert.ok(darkColors);
  assert.equal(darkColors.theme, "dark");
  assert.equal(darkColors.variantOpacity, "0.5");
  await browser.findElement(By.id("fixture-theme-light")).click();
  await browser.wait(
    async () =>
      (await fixture.getAttribute("data-theme")) === "light" &&
      (await executeBrowserScript(browser, () =>
        document.documentElement.style.getPropertyValue("--portcove-theme-invalidation"),
      )) === "light",
    15_000,
  );
  assert.notEqual(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector(".design-compatibility-fixture");
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).backgroundColor;
    }),
    darkColors.background,
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector("[data-theme-variant-probe]");
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).opacity;
    }),
    "1",
    "a generated dark: utility changes an actual computed control property under data-theme",
  );
  await browser.findElement(By.id("fixture-theme-dark")).click();
  await browser.wait(
    async () =>
      (await fixture.getAttribute("data-theme")) === "dark" &&
      (await executeBrowserScript(browser, () =>
        document.documentElement.style.getPropertyValue("--portcove-theme-invalidation"),
      )) === "dark",
    15_000,
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector("[data-theme-variant-probe]");
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).opacity;
    }),
    "0.5",
    "a mounted control regains its generated dark: style when returning to dark",
  );
  await browser.findElement(By.id("fixture-theme-light")).click();
  await browser.wait(
    async () =>
      (await fixture.getAttribute("data-theme")) === "light" &&
      (await executeBrowserScript(browser, () =>
        document.documentElement.style.getPropertyValue("--portcove-theme-invalidation"),
      )) === "light",
    15_000,
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector("[data-theme-variant-probe]");
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).opacity;
    }),
    "1",
    "a mounted control returns to its light style on the next switch",
  );

  await browser.findElement(By.id("fixture-direction")).click();
  await browser.wait(async () => (await fixture.getAttribute("data-direction")) === "rtl", 15_000);
  assert.equal(
    await executeBrowserScript(browser, () => document.documentElement.getAttribute("dir")),
    "rtl",
  );

  await observeStep("dialog-trigger-click", () =>
    browser.findElement(By.id("fixture-open-dialog")).click(),
  );
  const dialogLocator = By.css('[data-slot="dialog-content"]');
  await browser.wait(
    async () => (await fixture.getAttribute("data-dialog-open")) === "true",
    15_000,
    "opening the dialog publishes its controlled state",
  );
  assert.equal(
    await executeBrowserScript(
      browser,
      () => document.querySelector('[data-slot="dialog-content"]')?.closest("main") === null,
    ),
    true,
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector('[data-slot="dialog-content"]');
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).direction;
    }),
    "rtl",
    "portaled dialog content inherits the active direction",
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      if (!(dialog instanceof HTMLElement)) return false;
      const bounds = dialog.getBoundingClientRect();
      return Math.abs(bounds.left + bounds.width / 2 - window.innerWidth / 2) <= 1;
    }),
    true,
    "the dialog remains centered in right-to-left direction",
  );
  const selectTrigger = await browser.findElement(By.id("fixture-channel"));
  // Element sendKeys refocuses the trigger and dismisses an aligned open Select.
  // Deliver Escape to the current popup focus, as a keyboard user does.
  const sendEscape = () => browser.actions().sendKeys(Key.ESCAPE).perform();
  await selectTrigger.sendKeys(Key.ENTER);
  try {
    await browser.wait(
      async () => (await fixture.getAttribute("data-select-open")) === "true",
      15_000,
      "keyboard activation opens the nested select",
    );
  } catch (error) {
    let state = "unavailable";
    try {
      state = JSON.stringify(
        await executeBrowserScript(browser, () => {
          const trigger = document.querySelector("#fixture-channel");
          return {
            activeElement: document.activeElement?.id ?? null,
            dialogOpen: (() => {
              const root = document.querySelector(".design-compatibility-fixture");
              return root instanceof HTMLElement ? root.dataset.dialogOpen : undefined;
            })(),
            triggerExpanded: trigger?.getAttribute("aria-expanded"),
            triggerDisabled: trigger?.getAttribute("aria-disabled"),
          };
        }),
      );
    } catch {
      // Preserve the activation failure if the driver can no longer inspect the page.
    }
    throw new Error(`keyboard activation failed: ${String(error)}; state: ${state}`, {
      cause: error,
    });
  }
  assert.equal(
    (await browser.findElements(dialogLocator)).length,
    1,
    "opening the nested select keeps its dialog open",
  );
  assert.equal(
    await executeBrowserScript(
      browser,
      () =>
        document.querySelector('[data-slot="select-content"]')?.closest('[role="dialog"]') === null,
    ),
    true,
  );
  assert.equal(
    await executeBrowserScript(browser, () => {
      const element = document.querySelector('[data-slot="select-content"]');
      if (!element) throw new Error("required design fixture element missing");
      return getComputedStyle(element).direction;
    }),
    "rtl",
    "portaled select content inherits the active direction",
  );
  await sendEscape();
  await browser.wait(
    async () => (await fixture.getAttribute("data-select-open")) === "false",
    15_000,
    "the first Escape closes the nested select",
  );
  assert.equal(
    (await browser.findElements(dialogLocator)).length,
    1,
    "the first Escape closes only the nested select",
  );
  await browser.wait(
    async () =>
      (await executeBrowserScript(browser, () => document.activeElement?.id)) === "fixture-channel",
    15_000,
    "closing the nested select restores focus to its trigger",
  );
  await sendEscape();
  await browser.wait(
    async () => (await fixture.getAttribute("data-dialog-open")) === "false",
    15_000,
    "the second Escape closes the dialog",
  );
  await browser.wait(
    async () =>
      (await executeBrowserScript(browser, () => document.activeElement?.id)) ===
      "fixture-open-dialog",
    15_000,
    "closing the dialog restores focus to its trigger",
  );

  await browser.findElement(By.id("fixture-reduced-motion")).click();
  assert.equal(await fixture.getAttribute("data-reduced-motion"), "true");
  const motionDuration = await executeBrowserScript(browser, () => {
    const element = document.querySelector("#fixture-open-dialog");
    if (!element) throw new Error("required design fixture element missing");
    return getComputedStyle(element).transitionDuration;
  });
  assert.ok(Number.parseFloat(motionDuration) <= 0.000001, motionDuration);
  return environment;
}
