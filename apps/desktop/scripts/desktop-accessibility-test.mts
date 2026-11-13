import type { ScenarioContext } from "./desktop-scenario-context.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";
// Presentation-only fixtures supplement actual native keyboard interaction.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  captureAccessibilityReport,
  observeAccessibility,
  assertNoAccessibilityViolations,
} from "./desktop-review-controls.mts";

export async function accessibleNavigationScenario({
  browser,
  scenario,
  output,
  artifacts,
}: ScenarioContext) {
  await scenario("native-expanded-navigation-copy", async () => {
    const originalWindow = await browser.manage().window().getRect();
    const originalPresentation = await executeBrowserScript(browser, () => ({
      fontSize: document.documentElement.style.getPropertyValue("font-size"),
      fontPriority: document.documentElement.style.getPropertyPriority("font-size"),
      inputMode: document.documentElement.dataset.inputMode,
      nativeKeyboardInputMode: document.documentElement.dataset.nativeKeyboardInputMode,
    }));
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
      const commandTrigger = await browser.findElement(
        By.css('[data-detail-origin^="command-trigger:"]'),
      );
      await executeBrowserScript(
        browser,
        (element) => {
          if (!(element instanceof HTMLElement))
            throw new Error("Command trigger is not an HTML control");
          element.focus();
        },
        commandTrigger,
      );
      await browser.actions().keyDown(modifier).sendKeys("k").keyUp(modifier).perform();
      await browser.wait(until.elementLocated(By.css(".command-palette")), 5000);
      const search = await browser.findElement(
        By.css('.command-palette input[aria-label="Search commands"]'),
      );
      assert.equal(
        await search.getAttribute("value"),
        "",
        "A freshly opened palette must start with an empty query",
      );
      await browser.wait(
        () =>
          executeBrowserScript(browser, (element) => document.activeElement === element, search),
        5000,
        "A freshly opened palette did not focus its search field",
      );
      assert.equal(
        await executeBrowserScript(
          browser,
          () => document.querySelector(".command-palette")?.closest("main") === null,
        ),
        true,
        "The command palette must use the shared portal",
      );
      const help = await browser.findElement(By.css(".palette-footer .controller-hint"));
      if ((await help.getAttribute("open")) === null)
        await help.findElement(By.css("summary")).click();
      const hints = async (inputMode: "keyboard" | "controller") =>
        executeBrowserScript(
          browser,
          (nextInputMode) => {
            document.documentElement.dataset.inputMode = nextInputMode;
            return [...document.querySelectorAll(".palette-footer .controller-hint span")]
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => element.textContent);
          },
          inputMode,
        );
      assert.deepEqual(
        await hints("keyboard"),
        ["Arrow keys: Move", "Enter: Select", "Esc: Back"],
        "Keyboard presentation must show keyboard navigation help",
      );
      assert.deepEqual(await hints("controller"), [
        "D-pad or stick: Move",
        "Confirm button: Select",
        "Back button: Back",
      ]);
      await executeBrowserScript(browser, () => {
        delete document.documentElement.dataset.nativeKeyboardInputMode;
        window.addEventListener(
          "keydown",
          () => {
            queueMicrotask(() => {
              document.documentElement.dataset.nativeKeyboardInputMode =
                document.documentElement.dataset.inputMode ?? "";
            });
          },
          { capture: true, once: true },
        );
      });
      await search.sendKeys(Key.ARROW_DOWN);
      assert.equal(
        await executeBrowserScript(
          browser,
          () => document.documentElement.dataset.nativeKeyboardInputMode,
        ),
        "keyboard",
        "ArrowDown must return input handling to keyboard mode",
      );
      assert.equal(await search.getAttribute("aria-activedescendant"), "command-catalog");
      for (const id of [
        "command-search-library",
        "command-search",
        "command-updates",
        "command-game-updates",
      ]) {
        await search.sendKeys(Key.ARROW_DOWN);
        assert.equal(await search.getAttribute("aria-activedescendant"), id);
      }
      const unavailableCheck = await browser.findElement(By.css("#command-check"));
      assert.notEqual(await unavailableCheck.getAttribute("disabled"), null);
      assert.match(await unavailableCheck.getText(), /Install a port before checking/);
      await search.sendKeys(Key.ARROW_DOWN);
      assert.equal(
        await search.getAttribute("aria-activedescendant"),
        "command-adopt",
        "Keyboard movement must skip an unavailable command",
      );
      // Expand the visible copy the way a longer, accented translation would. React
      // owns these nodes, so only each existing text node's value changes and the
      // original values are restored right after measuring. Replacing textContent
      // would swap nodes React holds and crash its next update (insertBefore).
      const expansion = await executeBrowserScript(browser, () => {
        document.documentElement.style.fontSize = "125%";
        const samples = [];
        const restore: [Text, string][] = [];
        const vowels: Readonly<Record<string, string>> = { a: "á", e: "ë", i: "ï", o: "ö", u: "ü" };
        for (const element of document.querySelectorAll(
          ".palette-command strong, .palette-command small, .palette-footer span",
        )) {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let originalLength = 0;
          let expandedLength = 0;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node as Text;
            const original = text.data;
            if (!original.trim()) continue;
            const expanded =
              original.replace(
                /[aeiou]/gi,
                (letter: string) => vowels[letter.toLowerCase()] ?? letter,
              ) +
              " " +
              "ľ".repeat(Math.max(0, Math.ceil(original.length * 0.35) - 1));
            restore.push([text, original]);
            text.data = expanded;
            originalLength += original.length;
            expandedLength += expanded.length;
          }
          if (originalLength > 0)
            samples.push({ original_length: originalLength, expanded_length: expandedLength });
        }
        (window as unknown as { restoreExpandedText?: () => void }).restoreExpandedText = () => {
          for (const [node, original] of restore) node.data = original;
        };
        return samples;
      });
      await assertCompactReview(browser, ".command-palette");
      const layout = await executeBrowserScript(browser, () => {
        const dialog = document.querySelector(".command-palette");
        if (!dialog) throw new Error("Command palette is unavailable");
        const bounds = dialog.getBoundingClientRect();
        return {
          font_size: getComputedStyle(document.documentElement).fontSize,
          clipped_controls: [...dialog.querySelectorAll("button")].filter((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.left < bounds.left - 1 ||
              rect.right > bounds.right + 1 ||
              button.scrollWidth > button.clientWidth + 1
            );
          }).length,
        };
      });
      assert.equal(layout.clipped_controls, 0);
      const report = path.join(output, "expanded-navigation-accessibility.json");
      await captureAccessibilityReport(browser, report, artifacts);
      const screenshot = path.join(output, "native-expanded-navigation.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await executeBrowserScript(browser, () =>
        (window as unknown as { restoreExpandedText?: () => void }).restoreExpandedText?.(),
      );
      // The palette re-renders while the layout probes run, so the earlier input
      // reference can be stale. Locate the current search field again.
      const emptySearch = await browser.findElement(
        By.css('.command-palette input[aria-label="Search commands"]'),
      );
      await emptySearch.sendKeys("owned-no-matching-command");
      await browser.wait(until.elementLocated(By.css(".palette-empty")), 5000);
      assert.equal(
        (await browser.findElements(By.css('.command-palette [role="listbox"]'))).length,
        0,
      );
      assert.equal(await emptySearch.getAttribute("aria-expanded"), "false");
      const emptyAccessibility = await observeAccessibility(browser);
      const emptyReport = path.join(output, "empty-command-search-accessibility.json");
      const serializedEmpty = JSON.stringify(emptyAccessibility, null, 2);
      if (serializedEmpty === undefined)
        throw new Error("Accessibility engine returned no JSON result");
      await writeFile(emptyReport, serializedEmpty, {
        flag: "wx",
      });
      artifacts.push(emptyReport);
      const emptyImage = path.join(output, "native-empty-command-search.png");
      await writeFile(emptyImage, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(emptyImage);
      assertNoAccessibilityViolations(emptyAccessibility);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(By.css(".command-palette"))).length === 0,
        5000,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element) => document.activeElement === element,
            commandTrigger,
          ),
        5000,
        "Command palette trigger did not regain focus after Escape",
      );
      const evidence = path.join(output, "expanded-navigation-result.json");
      await writeFile(
        evidence,
        JSON.stringify(
          {
            method: "Native keyboard and synthetic input-mode/expanded-text presentation",
            expansion,
            layout,
            shared_dialog_portal: true,
            search_autofocus: true,
            escape_restored_focus: true,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(evidence);
    } catch (error) {
      // A render crash replaces the page with the app's recovery screen, which
      // turns every later lookup into "no such element". Keep the original cause.
      const renderError = await executeBrowserScript(
        browser,
        () =>
          document.querySelector<HTMLTextAreaElement>(".bootstrap-recovery-details textarea")
            ?.value ?? null,
      ).catch(() => null);
      failure = {
        error: renderError
          ? new Error(
              `${errorMessage(error)}; the app showed its render-error screen: ${renderError}`,
              { cause: error },
            )
          : error,
      };
      const screenshot = path.join(output, "expanded-navigation-failure-before-cleanup.png");
      await browser
        .takeScreenshot()
        .then((data) => writeFile(screenshot, data, { encoding: "base64", flag: "wx" }))
        .then(() => artifacts.push(screenshot))
        .catch((captureError) =>
          console.error("Palette failure capture:", errorMessage(captureError)),
        );
    } finally {
      try {
        if ((await browser.findElements(By.css(".command-palette"))).length > 0) {
          await browser.actions().sendKeys(Key.ESCAPE).perform();
          await browser.wait(
            async () => (await browser.findElements(By.css(".command-palette"))).length === 0,
            5_000,
            "Owned command palette did not close during scenario restoration",
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await executeBrowserScript(
          browser,
          (original) => {
            const root = document.documentElement;
            if (original.fontSize)
              root.style.setProperty("font-size", original.fontSize, original.fontPriority);
            else root.style.removeProperty("font-size");
            for (const key of ["inputMode", "nativeKeyboardInputMode"] as const) {
              const value = original[key];
              if (value === undefined) delete root.dataset[key];
              else root.dataset[key] = value;
            }
          },
          originalPresentation,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await browser.manage().window().setRect(originalWindow);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        // Reload only this owned renderer to restore expanded text and the
        // one-shot fixture listener, including when a preceding assertion failed.
        await browser.navigate().refresh();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          15_000,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        `Command palette restoration failed${failure ? ` after: ${errorMessage(failure.error)}` : ""}`,
      );
    if (failure) throw failure.error;
  });
}
