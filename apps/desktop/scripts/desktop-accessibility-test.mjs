// Presentation-only fixtures supplement actual native keyboard interaction.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import axe from "axe-core";
import { assertCompactReview } from "./desktop-review-controls.mjs";

export async function accessibleNavigationScenario({ browser, scenario, output, artifacts }) {
  await scenario("native-expanded-navigation-copy", async () => {
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    await browser.actions().keyDown(modifier).sendKeys("k").keyUp(modifier).perform();
    await browser.wait(until.elementLocated(By.css(".command-palette")), 5000);
    const search = await browser.findElement(By.css('.command-palette input[aria-label="Search commands"]'));
    assert.equal((await search.getAttribute("value")).length, 0, "A freshly opened palette must start with an empty query");
    const hints = async () => browser.executeScript(() => [...document.querySelectorAll(".palette-footer .controller-hint > span")]
      .filter(element => element.getClientRects().length > 0).map(element => element.textContent));
    assert.deepEqual(await hints(), ["Arrow keys: Move", "Enter: Select", "Esc: Back"]);
    await browser.executeScript(() => { document.documentElement.dataset.inputMode = "controller"; });
    assert.deepEqual(await hints(), ["D-pad or stick: Move", "Confirm button: Select", "Back button: Back"]);
    await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
    assert.deepEqual(await hints(), ["Arrow keys: Move", "Enter: Select", "Esc: Back"]);
    const expansion = await browser.executeScript(() => {
      document.documentElement.style.fontSize = "125%";
      const samples = [];
      for (const element of document.querySelectorAll(".palette-command strong, .palette-command small, .palette-footer span")) {
        const original = element.textContent;
        if (!original) continue;
        const expanded = original.replace(/[aeiou]/gi, letter => ({ a: "á", e: "ë", i: "ï", o: "ö", u: "ü" })[letter.toLowerCase()])
          + " " + "ľ".repeat(Math.max(0, Math.ceil(original.length * 0.35) - 1));
        element.textContent = expanded;
        samples.push({ original_length: original.length, expanded_length: expanded.length });
      }
      return samples;
    });
    await assertCompactReview(browser, ".command-palette");
    const layout = await browser.executeScript(() => {
      const dialog = document.querySelector(".command-palette");
      const bounds = dialog.getBoundingClientRect();
      return { font_size: getComputedStyle(document.documentElement).fontSize,
        clipped_controls: [...dialog.querySelectorAll("button")].filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || button.scrollWidth > button.clientWidth + 1;
        }).length };
    });
    assert.equal(layout.clipped_controls, 0);
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "expanded-navigation-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    const screenshot = path.join(output, "native-expanded-navigation.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
    const evidence = path.join(output, "expanded-navigation-result.json");
    await writeFile(evidence, JSON.stringify({ method: "Native keyboard and synthetic input-mode/expanded-text presentation", expansion, layout }, null, 2), { flag: "wx" }); artifacts.push(evidence);
    await search.sendKeys("owned-no-matching-command");
    await browser.wait(until.elementLocated(By.css(".palette-empty")), 5000);
    assert.equal((await browser.findElements(By.css('.command-palette [role="listbox"]'))).length, 0);
    assert.equal(await search.getAttribute("aria-expanded"), "false");
    const emptyAccessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const emptyReport = path.join(output, "empty-command-search-accessibility.json");
    await writeFile(emptyReport, JSON.stringify(emptyAccessibility, null, 2), { flag: "wx" }); artifacts.push(emptyReport);
    const emptyImage = path.join(output, "native-empty-command-search.png");
    await writeFile(emptyImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(emptyImage);
    assert.deepEqual(emptyAccessibility.violations.map(item => item.id), []);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(By.css(".command-palette"))).length === 0, 5000);
    await browser.navigate().refresh();
  });
}
