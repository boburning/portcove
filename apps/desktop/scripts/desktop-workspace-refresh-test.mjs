import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";

export async function workspaceRefreshScenario({ browser, scenario, output, artifacts }) {
  await scenario("native-workspace-refresh-recovery", async () => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    await browser.wait(until.elementLocated(By.css(".port-card")), 10_000);
    const before = await browser.findElements(By.css(".port-card"));
    const observations = { injection: "one synthetic get_catalog rejection; subsequent requests use actual native IPC", before_cards: before.length };
    try {
      await browser.executeAsyncScript(done => {
        const native = window.__TAURI_INTERNALS__;
        const original = native.invoke;
        window.__portcoveRefreshProbe = { original, calls: [], remaining: 1 };
        native.invoke = function(command, ...args) {
          const probe = window.__portcoveRefreshProbe;
          probe.calls.push(command);
          if (command === "get_catalog" && probe.remaining-- > 0) return Promise.reject({
            code: "state", message: "synthetic-native-refresh-failure", details: {},
            presentation: { presentation_key: "state_unavailable", summary: "Library information is temporarily unavailable.", tone: "error", mutation_state: "unknown", phase: null,
              recovery_actions: ["review_current_state", "view_technical_details"], technical_message: "Synthetic refresh rejection for presentation verification.", technical_context: {} },
          });
          return original.call(native, command, ...args);
        };
        native.invoke("plugin:event|emit", { event: "portcove://library-changed", payload: "refresh-probe" }).then(() => done({ ok: true }), error => done({ error }));
      }).then(result => assert.equal(result.ok, true, JSON.stringify(result)));
      const retry = await browser.wait(until.elementLocated(By.xpath('//button[normalize-space(.)="Retry refresh"]')), 10_000);
      observations.failure_text = await browser.findElement(By.css(".error-banner")).getText();
      assert.match(observations.failure_text, /Showing the last loaded information/);
      assert.doesNotMatch(observations.failure_text, /No files were changed|synthetic-native-refresh-failure/);
      assert.equal((await browser.findElements(By.css(".port-card"))).length, before.length);
      await browser.executeScript(axe.source);
      const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
      const accessibilityPath = path.join(output, "workspace-refresh-accessibility.json");
      await writeFile(accessibilityPath, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(accessibilityPath);
      assert.deepEqual(accessibility.violations.map(item => item.id), []);
      const screenshot = path.join(output, "native-workspace-refresh-failure.png");
      await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
      await retry.click();
      await browser.wait(async () => (await browser.findElements(By.css(".error-banner"))).length === 0, 10_000);
      await browser.wait(async () => browser.executeScript(() => document.activeElement !== document.body && Boolean(document.activeElement.closest('[data-focus-region="workspace"]'))), 5000);
      observations.after_cards = (await browser.findElements(By.css(".port-card"))).length;
      assert.equal(observations.after_cards, before.length);
      observations.commands = await browser.executeScript(() => window.__portcoveRefreshProbe.calls);
      assert.equal(observations.commands.filter(command => command === "get_catalog").length, 2);
      assert.ok(observations.commands.every(command => command.startsWith("get_") || command.startsWith("plugin:")), JSON.stringify(observations.commands));
    } catch (error) {
      observations.failure = error.message;
      throw error;
    } finally {
      try {
        await browser.executeScript(() => {
          const probe = window.__portcoveRefreshProbe;
          if (probe) { window.__TAURI_INTERNALS__.invoke = probe.original; delete window.__portcoveRefreshProbe; }
        });
        observations.interception_restored = true;
      } finally {
        const report = path.join(output, "workspace-refresh-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" }); artifacts.push(report);
      }
    }
  });
}
