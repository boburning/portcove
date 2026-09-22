// Presentation-only fixtures supplement actual native keyboard interaction.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import { assertCompactReview, captureAccessibilityReport } from "./desktop-review-controls.mjs";

export async function accessibleNavigationScenario({ browser, scenario, output, artifacts }) {
  await scenario("native-expanded-navigation-copy", async () => {
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const commandTrigger = await browser.findElement(By.css('[aria-label="Open command palette"]'));
    await browser.executeScript((element) => element.focus(), commandTrigger);
    await browser.actions().keyDown(modifier).sendKeys("k").keyUp(modifier).perform();
    await browser.wait(until.elementLocated(By.css(".command-palette")), 5000);
    const search = await browser.findElement(
      By.css('.command-palette input[aria-label="Search commands"]'),
    );
    assert.equal(
      (await search.getAttribute("value")).length,
      0,
      "A freshly opened palette must start with an empty query",
    );
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, search),
      5000,
      "A freshly opened palette did not focus its search field",
    );
    assert.equal(
      await browser.executeScript(
        () => document.querySelector(".command-palette")?.closest("main") === null,
      ),
      true,
      "The command palette must use the shared portal",
    );
    const hints = async (inputMode) =>
      browser.executeScript((nextInputMode) => {
        document.documentElement.dataset.inputMode = nextInputMode;
        return [...document.querySelectorAll(".palette-footer .controller-hint > span")]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.textContent);
      }, inputMode);
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
    await browser.executeScript(() => {
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
      await browser.executeScript(() => document.documentElement.dataset.nativeKeyboardInputMode),
      "keyboard",
      "ArrowDown must return input handling to keyboard mode",
    );
    const expansion = await browser.executeScript(() => {
      document.documentElement.style.fontSize = "125%";
      const samples = [];
      for (const element of document.querySelectorAll(
        ".palette-command strong, .palette-command small, .palette-footer span",
      )) {
        const original = element.textContent;
        if (!original) continue;
        const expanded =
          original.replace(
            /[aeiou]/gi,
            (letter) => ({ a: "á", e: "ë", i: "ï", o: "ö", u: "ü" })[letter.toLowerCase()],
          ) +
          " " +
          "ľ".repeat(Math.max(0, Math.ceil(original.length * 0.35) - 1));
        element.textContent = expanded;
        samples.push({
          original_length: original.length,
          expanded_length: expanded.length,
        });
      }
      return samples;
    });
    await assertCompactReview(browser, ".command-palette");
    const layout = await browser.executeScript(() => {
      const dialog = document.querySelector(".command-palette");
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
    await search.sendKeys("owned-no-matching-command");
    await browser.wait(until.elementLocated(By.css(".palette-empty")), 5000);
    assert.equal(
      (await browser.findElements(By.css('.command-palette [role="listbox"]'))).length,
      0,
    );
    assert.equal(await search.getAttribute("aria-expanded"), "false");
    const emptyAccessibility = await browser.executeAsyncScript((done) =>
      window.axe.run().then(done),
    );
    const emptyReport = path.join(output, "empty-command-search-accessibility.json");
    await writeFile(emptyReport, JSON.stringify(emptyAccessibility, null, 2), {
      flag: "wx",
    });
    artifacts.push(emptyReport);
    const emptyImage = path.join(output, "native-empty-command-search.png");
    await writeFile(emptyImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(emptyImage);
    assert.deepEqual(
      emptyAccessibility.violations.map((item) => item.id),
      [],
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(By.css(".command-palette"))).length === 0,
      5000,
    );
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, commandTrigger),
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
    await browser.navigate().refresh();
  });
}
