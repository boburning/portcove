import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";

export async function reloadScenario({
  browser,
  scenario,
  output,
  artifacts,
  cycles,
}) {
  await scenario("native-repeated-library-reload", async () => {
    const observations = [];
    const commands = [
      "get_catalog",
      "get_statuses",
      "get_sources",
      "get_activities",
      "get_doctor_report",
    ];
    try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const observation = {
          cycle: cycle + 1,
          started_at: new Date().toISOString(),
        };
        observations.push(observation);
        await browser.navigate().refresh();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          10_000,
        );
        // Match the actual five concurrent refresh calls while the renderer also
        // loads. Fail on the first rejected batch; no hidden retry of a failure.
        observation.commands = await browser.executeAsyncScript(
          (commands, done) => {
            void Promise.all(
              commands.map((command) =>
                window.__TAURI_INTERNALS__.invoke(command).then(
                  () => ({ command, ok: true }),
                  (error) => ({ command, ok: false, error }),
                ),
              ),
            ).then(done);
          },
          commands,
        );
        assert.ok(
          observation.commands.every((result) => result.ok),
          JSON.stringify(observation),
        );
        await browser.wait(
          async () =>
            (await browser.findElements(By.css(".loading-state"))).length === 0,
          10_000,
        );
        observation.errors = await browser.executeScript(() =>
          Array.from(
            document.querySelectorAll(".error-banner, .bootstrap-error"),
            (element) => element.textContent,
          ),
        );
        assert.deepEqual(observation.errors, []);
        observation.completed_at = new Date().toISOString();
      }
    } finally {
      const report = path.join(output, "reload-observations.json");
      await writeFile(report, JSON.stringify(observations, null, 2), {
        flag: "wx",
      });
      artifacts.push(report);
    }
  });
}
