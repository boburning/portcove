import assert from "node:assert/strict";

export async function assertDesignCompatibility({ browser, By, Key, until }) {
  const fixtureLocator = By.css(".design-compatibility-fixture");
  await browser.wait(until.elementLocated(fixtureLocator), 15_000);
  const fixture = await browser.findElement(fixtureLocator);
  const environment = await browser.executeScript(() => ({
    architecture: navigator.userAgentData?.architecture ?? null,
    platform: navigator.platform,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    supportsColorMix: CSS.supports("color", "color-mix(in oklch, red, blue)"),
    supportsOklch: CSS.supports("color", "oklch(0.5 0.1 30)"),
    userAgent: navigator.userAgent,
  }));
  assert.equal(environment.supportsColorMix, true);
  assert.equal(environment.supportsOklch, true);

  await browser.wait(
    async () =>
      browser.executeScript(() => {
        const asset = document.querySelector("[data-offline-asset]");
        return asset instanceof HTMLImageElement && asset.complete && asset.naturalWidth > 0;
      }),
    15_000,
  );
  assert.deepEqual(
    await browser.executeScript(() =>
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

  const darkColors = await browser.executeScript(() => {
    const root = document.querySelector(".design-compatibility-fixture");
    const button = document.querySelector("#fixture-open-dialog");
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
    return {
      background: getComputedStyle(root).backgroundColor,
      button: getComputedStyle(button).backgroundColor,
      theme: root.dataset.theme,
    };
  });
  assert.equal(darkColors.theme, "dark");
  assert.notEqual(darkColors.button, "rgba(0, 0, 0, 0)");
  await browser.findElement(By.id("fixture-theme-light")).click();
  await browser.wait(async () => (await fixture.getAttribute("data-theme")) === "light", 15_000);
  assert.notEqual(
    await browser.executeScript(
      () =>
        getComputedStyle(document.querySelector(".design-compatibility-fixture")).backgroundColor,
    ),
    darkColors.background,
  );

  await browser.findElement(By.id("fixture-open-dialog")).click();
  const dialogLocator = By.css('[data-slot="dialog-content"]');
  await browser.wait(
    async () => (await fixture.getAttribute("data-dialog-open")) === "true",
    15_000,
  );
  assert.equal(
    await browser.executeScript(
      () => document.querySelector('[data-slot="dialog-content"]')?.closest("main") === null,
    ),
    true,
  );
  await browser.findElement(By.id("fixture-channel")).click();
  await browser.wait(
    async () => (await fixture.getAttribute("data-select-open")) === "true",
    15_000,
  );
  assert.equal(
    (await browser.findElements(dialogLocator)).length,
    1,
    "opening the nested select keeps its dialog open",
  );
  assert.equal(
    await browser.executeScript(
      () =>
        document.querySelector('[data-slot="select-content"]')?.closest('[role="dialog"]') === null,
    ),
    true,
  );
  await browser.findElement(By.id("fixture-channel")).sendKeys(Key.ESCAPE);
  await browser.wait(
    async () => (await fixture.getAttribute("data-select-open")) === "false",
    15_000,
  );
  assert.equal(
    (await browser.findElements(dialogLocator)).length,
    1,
    "the first Escape closes only the nested select",
  );
  await browser.wait(
    async () =>
      (await browser.executeScript(() => document.activeElement?.id)) === "fixture-channel",
    15_000,
    "closing the nested select restores focus to its trigger",
  );
  await browser.actions().sendKeys(Key.ESCAPE).perform();
  await browser.wait(
    async () => (await fixture.getAttribute("data-dialog-open")) === "false",
    15_000,
  );
  await browser.wait(
    async () =>
      (await browser.executeScript(() => document.activeElement?.id)) === "fixture-open-dialog",
    15_000,
    "closing the dialog restores focus to its trigger",
  );

  await browser.findElement(By.id("fixture-reduced-motion")).click();
  assert.equal(await fixture.getAttribute("data-reduced-motion"), "true");
  const motionDuration = await browser.executeScript(
    () => getComputedStyle(document.querySelector("#fixture-open-dialog")).transitionDuration,
  );
  assert.ok(Number.parseFloat(motionDuration) <= 0.000001, motionDuration);
  return environment;
}
