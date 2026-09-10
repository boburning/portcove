import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import { captureAccessibilityReport } from "./desktop-review-controls.mjs";

export async function workspaceRefreshScenario({
  browser,
  scenario,
  output,
  artifacts,
}) {
  await scenario("native-workspace-refresh-recovery", async () => {
    await browser
      .findElement(By.xpath('//nav//button[contains(., "Port catalog")]'))
      .click();
    await browser.wait(until.elementLocated(By.css(".port-card")), 10_000);
    const before = await browser.findElements(By.css(".port-card"));
    const observations = {
      injection:
        "one synthetic get_catalog rejection; subsequent requests use actual native IPC",
      before_cards: before.length,
    };
    try {
      await browser
        .executeAsyncScript((done) => {
          const native = window.__TAURI_INTERNALS__;
          const original = window.fetch;
          const target = native.convertFileSrc("get_catalog", "ipc");
          window.__portcoveRefreshProbe = {
            original,
            calls: [],
            remaining: 1,
            injected: 0,
          };
          window.fetch = function (input, ...args) {
            const probe = window.__portcoveRefreshProbe;
            const url =
              typeof input === "string" ? input : (input.url ?? String(input));
            const parsed = new URL(url, location.href);
            if (parsed.hostname === "ipc.localhost")
              probe.calls.push(decodeURIComponent(parsed.pathname.slice(1)));
            if (url === target && probe.remaining-- > 0) {
              probe.injected++;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    code: "state",
                    message: "synthetic-native-refresh-failure",
                    details: {},
                    presentation: {
                      presentation_key: "state_unavailable",
                      summary:
                        "Library information is temporarily unavailable.",
                      tone: "error",
                      mutation_state: "unknown",
                      phase: null,
                      recovery_actions: [
                        "review_current_state",
                        "view_technical_details",
                      ],
                      technical_message:
                        "Synthetic refresh rejection for presentation verification.",
                      technical_context: {},
                    },
                  }),
                  {
                    headers: {
                      "Content-Type": "application/json",
                      "Tauri-Response": "error",
                    },
                  },
                ),
              );
            }
            return original.call(window, input, ...args);
          };
          native
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: "refresh-probe",
            })
            .then(
              () => done({ ok: true }),
              (error) => done({ error }),
            );
        })
        .then((result) =>
          assert.equal(result.ok, true, JSON.stringify(result)),
        );
      const retry = await browser.wait(
        until.elementLocated(
          By.xpath('//button[normalize-space(.)="Retry refresh"]'),
        ),
        10_000,
      );
      observations.failure_text = await browser
        .findElement(By.css(".error-banner"))
        .getText();
      assert.match(
        observations.failure_text,
        /Showing the last loaded information/,
      );
      assert.doesNotMatch(
        observations.failure_text,
        /No files were changed|synthetic-native-refresh-failure/,
      );
      assert.equal(
        (await browser.findElements(By.css(".port-card"))).length,
        before.length,
      );
      const accessibilityPath = path.join(
        output,
        "workspace-refresh-accessibility.json",
      );
      await captureAccessibilityReport(browser, accessibilityPath, artifacts);
      const screenshot = path.join(
        output,
        "native-workspace-refresh-failure.png",
      );
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await retry.click();
      await browser.wait(
        async () =>
          (await browser.findElements(By.css(".error-banner"))).length === 0,
        10_000,
      );
      await browser.wait(
        async () =>
          browser.executeScript(
            () =>
              document.activeElement !== document.body &&
              Boolean(
                document.activeElement.closest(
                  '[data-focus-region="workspace"]',
                ),
              ),
          ),
        5000,
      );
      observations.after_cards = (
        await browser.findElements(By.css(".port-card"))
      ).length;
      assert.equal(observations.after_cards, before.length);
      observations.commands = await browser.executeScript(
        () => window.__portcoveRefreshProbe.calls,
      );
      assert.equal(
        await browser.executeScript(
          () => window.__portcoveRefreshProbe.injected,
        ),
        1,
      );
      assert.equal(
        observations.commands.filter((command) => command === "get_catalog")
          .length,
        2,
      );
      assert.ok(
        observations.commands.every(
          (command) =>
            command.startsWith("get_") || command.startsWith("plugin:"),
        ),
        JSON.stringify(observations.commands),
      );
    } catch (error) {
      observations.failure = error.message;
      throw error;
    } finally {
      try {
        observations.probe = await browser.executeScript(() => {
          const probe = window.__portcoveRefreshProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            injected: probe.injected,
            commands: probe.calls,
            restored: window.fetch === probe.original,
          };
          delete window.__portcoveRefreshProbe;
          return result;
        });
        assert.equal(observations.probe.restored, true);
      } finally {
        const report = path.join(output, "workspace-refresh-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        artifacts.push(report);
      }
    }
  });
}
