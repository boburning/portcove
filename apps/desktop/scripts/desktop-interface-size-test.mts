import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, Key, until, type WebDriver, type WebElement } from "selenium-webdriver";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import { executeBrowserScript } from "./browser-script.mts";

type Context = Omit<ScenarioContext, "browser"> & {
  browser: () => WebDriver;
  restart: (name: string) => Promise<WebDriver>;
  setTheme: (theme: "dark" | "light") => Promise<unknown>;
  capture: (name: string, required: boolean) => Promise<unknown>;
  captureTarget: (name: string, target: WebElement) => Promise<unknown>;
};
const sizes = [100, 125, 150, 175, 200, 250, 300, 400];
const preference = "portcove.appearance.interface-size";

// Uses the production WebView API and actual viewport dimensions. Browser
// fixtures and authored-text enlargement are deliberately separate evidence.
export async function interfaceSizeScenario(context: Context) {
  await context.scenario("native-interface-size", async () => {
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = async (key: string) =>
      context.browser().actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    const measure = () =>
      executeBrowserScript(context.browser(), () => ({
        width: innerWidth,
        height: innerHeight,
        contentWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        dpr: devicePixelRatio,
        userAgent: navigator.userAgent,
        theme: document.documentElement.dataset.theme,
        preference: localStorage.getItem("portcove.appearance.interface-size"),
      }));
    const observations: (Awaited<ReturnType<typeof measure>> & { size: number })[] = [];
    const sizePicker = async () => {
      const candidates = await context.browser().findElements(By.css('[role="combobox"]'));
      const matches: WebElement[] = [];
      for (const candidate of candidates) {
        if (
          (await candidate.isDisplayed()) &&
          /^Interface size \d+%$/u.test(
            (await candidate.getAccessibleName()).replace(/\s+/gu, " ").trim(),
          )
        )
          matches.push(candidate);
      }
      assert.equal(
        matches.length,
        1,
        "Exactly one visible combobox must be labelled Interface size with its selected percentage",
      );
      return matches[0]!;
    };
    let attemptedSize = 100;
    const browser = context.browser();
    const originalWindow = await browser.manage().window().getRect();
    await browser.manage().window().setRect({ width: 960, height: 640 });
    const actual = await browser.manage().window().getRect();
    assert.equal(actual.width, 960);
    assert.equal(actual.height, 640);
    await shortcut("0");
    await browser.wait(async () => (await measure()).preference === "100", 10_000);
    const baseline = await measure();
    const settled = async (size: number) => {
      await context.browser().wait(
        async () => {
          const state = await measure();
          return (
            state.preference === String(size) &&
            Math.abs(state.width - (baseline.width * 100) / size) <= 2
          );
        },
        10_000,
        `Native interface size ${size}% did not settle`,
      );
      const state = await measure();
      assert.ok(state.scrollWidth <= state.contentWidth + 1, JSON.stringify(state));
      observations.push({ size, ...state });
      return state;
    };
    const select = async (size: number) => {
      attemptedSize = size;
      const picker = await sizePicker();
      await executeBrowserScript(
        context.browser(),
        (element) => {
          (element as HTMLElement).scrollIntoView({ block: "center" });
        },
        picker,
      );
      await picker.click();
      await context
        .browser()
        .wait(async () => Boolean(await picker.getAttribute("aria-controls")), 5000);
      const listId = await picker.getAttribute("aria-controls");
      assert.ok(listId, "Interface-size control must identify its popup");
      const list = await context.browser().wait(until.elementLocated(By.id(listId)), 5000);
      assert.equal(await list.getAttribute("role"), "listbox");
      await context
        .browser()
        .wait(
          () =>
            executeBrowserScript(
              context.browser(),
              (element) => element.contains(document.activeElement),
              list,
            ),
          5000,
          "Interface-size popup must own focus before keyboard selection",
        );
      await context.browser().actions().sendKeys(Key.HOME).perform();
      const highlighted = (expected: number) =>
        context
          .browser()
          .wait(
            () =>
              executeBrowserScript(
                context.browser(),
                (element, label) =>
                  element
                    .querySelector('[role="option"][data-highlighted]')
                    ?.textContent?.trim() === label,
                list,
                `${expected}%`,
              ),
            5000,
            `Interface-size keyboard highlight must reach ${expected}% before selection`,
          );
      await highlighted(100);
      await context
        .browser()
        .actions()
        .sendKeys(...Array.from({ length: sizes.indexOf(size) }, () => Key.ARROW_DOWN))
        .perform();
      await highlighted(size);
      await context.browser().actions().sendKeys(Key.ENTER).perform();
      return settled(size);
    };
    const capturePicker = async (name: string) => {
      const picker = await sizePicker();
      await context.captureTarget(name, picker);
    };
    try {
      for (const theme of ["dark", "light"] as const) {
        await shortcut("0");
        await settled(100);
        await context.setTheme(theme);
        for (const size of sizes.slice(1)) {
          await select(size);
          if (size === 125 || size === 200) await capturePicker(`interface-size-${theme}-${size}`);
          if (size === 300) await capturePicker(`interface-size-${theme}-300-320css`);
        }
        const enlarged = await settled(400);
        const picker = await sizePicker();
        const lines = await executeBrowserScript(
          context.browser(),
          (element) => {
            const value = element.querySelector('[data-slot="select-value"]')!;
            const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode()!;
            const range = document.createRange();
            range.selectNodeContents(text);
            return { text: value.textContent, lines: range.getClientRects().length };
          },
          picker,
        );
        assert.deepEqual(lines, { text: "400%", lines: 1 });
        assert.ok(enlarged.width <= 240 && enlarged.height <= 160, JSON.stringify(enlarged));
        await capturePicker(`interface-size-${theme}-400-minimum-window`);
        await shortcut("k");
        const search = await context
          .browser()
          .wait(
            until.elementLocated(By.css('.command-palette input[aria-label="Search commands"]')),
            5000,
          );
        await search.sendKeys("retained enlargement draft");
        await shortcut("-");
        await settled(300);
        await shortcut("+");
        await settled(400);
        const bounds = await executeBrowserScript(context.browser(), () => {
          const rect = document.querySelector(".command-palette")!.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: innerWidth,
            height: innerHeight,
          };
        });
        assert.ok(
          bounds.left >= 0 &&
            bounds.right <= bounds.width + 1 &&
            bounds.top >= 0 &&
            bounds.bottom <= bounds.height + 1,
          JSON.stringify(bounds),
        );
        await context.capture(`interface-size-${theme}-400-command-palette`, true);
        await shortcut("0");
        await settled(100);
        assert.equal(await search.getAttribute("value"), "retained enlargement draft");
        assert.equal(
          await executeBrowserScript(
            context.browser(),
            (element) => document.activeElement === element,
            search,
          ),
          true,
        );
        await search.sendKeys(Key.ESCAPE);
      }
      await select(175);
      await context.restart("interface-size-preference");
      await context.browser().manage().window().setRect({ width: 960, height: 640 });
      await settled(175);
      await context.capture("interface-size-175-after-full-restart", true);
      await shortcut("0");
      await settled(100);
      // A malformed preference must reapply 100%, even if WebView2 retained an
      // earlier zoom. This mutation belongs only to the runner's isolated profile.
      await executeBrowserScript(
        context.browser(),
        (key) => localStorage.setItem(key, "invalid"),
        preference,
      );
      await context.browser().navigate().refresh();
      await settled(100);
      const file = path.join(context.output, "native-interface-size-observations.json");
      await writeFile(file, JSON.stringify({ baseline, observations }, null, 2) + "\n", {
        flag: "wx",
      });
      context.artifacts.push(file);
    } catch (error) {
      // Retain the actual failure state before reset/resize cleanup changes it.
      const file = path.join(context.output, "native-interface-size-failure.json");
      try {
        await writeFile(
          file,
          JSON.stringify({ attemptedSize, state: await measure(), observations }, null, 2) + "\n",
          { flag: "wx" },
        );
        context.artifacts.push(file);
        await context.capture("native-interface-size-before-reset", true);
      } catch (captureError) {
        console.error("Could not retain interface-size failure diagnostics", captureError);
      }
      throw error;
    } finally {
      await shortcut("0");
      await context.browser().manage().window().setRect(originalWindow);
    }
  });
}
