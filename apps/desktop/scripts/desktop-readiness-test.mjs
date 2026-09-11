import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";
import { reviewControls } from "./desktop-review-controls.mjs";

export async function readinessScenario({ browser, scenario, output, artifacts, command, open }) {
  await scenario("native-missing-readiness-recovery", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const before = command(["status", port.id]);
    assert.equal(before.readiness.launchable, true);
    const observations = {
      injection:
        "omit one owned port's readiness from actual get_statuses responses; core remains launchable",
      before,
    };
    const controls = reviewControls(browser);
    try {
      await browser
        .executeAsyncScript((portId, done) => {
          const native = window.__TAURI_INTERNALS__;
          const original = window.fetch;
          const target = native.convertFileSrc("get_statuses", "ipc");
          window.__portcoveReadinessProbe = { original, injected: 0 };
          window.fetch = async function (input, ...args) {
            const url = typeof input === "string" ? input : (input.url ?? String(input));
            const response = await original.call(window, input, ...args);
            if (url !== target) return response;
            const statuses = await response.clone().json();
            if (
              !Array.isArray(statuses) ||
              !statuses.some(
                (status) => status.port_id === portId && status.readiness?.launchable === true,
              )
            )
              return response;
            window.__portcoveReadinessProbe.injected++;
            return new Response(
              JSON.stringify(
                statuses.map((status) =>
                  status.port_id === portId ? { ...status, readiness: null } : status,
                ),
              ),
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              },
            );
          };
          native
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: "readiness-probe",
            })
            .then(
              () => done({ ok: true }),
              (error) => done({ error }),
            );
        }, port.id)
        .then((result) => assert.equal(result.ok, true, JSON.stringify(result)));
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes(
            "Readiness unavailable",
          ),
        10_000,
      );
      const primary = await browser.findElement(By.css(".detail-panel .primary-actions button"));
      assert.equal(await primary.isEnabled(), false);
      assert.equal(await primary.getText(), "Play unavailable");
      await browser.executeScript(axe.source);
      const accessibility = await browser.executeAsyncScript((done) => window.axe.run().then(done));
      const report = path.join(output, "readiness-accessibility.json");
      await writeFile(report, JSON.stringify(accessibility, null, 2), {
        flag: "wx",
      });
      artifacts.push(report);
      assert.deepEqual(
        accessibility.violations.map((item) => item.id),
        [],
      );
      const screenshot = path.join(output, "native-readiness-unavailable.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await controls.click(By.css('[aria-label="Close port details"]'));
      await controls.click(controls.button("Review launch"));
      await browser.wait(until.elementLocated(By.css(".detail-panel")), 10_000);
      await browser.wait(
        async () =>
          (await browser.findElement(By.css(".detail-panel")).getText()).includes(
            "Readiness unavailable",
          ),
        10_000,
      );
      observations.after_review = command(["status", port.id]);
      assert.equal(observations.after_review.readiness.launchable, true);
      assert.equal(observations.after_review.active.id, before.active.id);
      assert.equal(observations.after_review.successful_launches, before.successful_launches);
    } catch (error) {
      observations.failure = error.message;
      throw error;
    } finally {
      try {
        observations.probe = await browser.executeScript(() => {
          const probe = window.__portcoveReadinessProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            injected: probe.injected,
            restored: window.fetch === probe.original,
          };
          delete window.__portcoveReadinessProbe;
          return result;
        });
        assert.equal(observations.probe.restored, true);
        assert.ok(
          observations.probe.injected > 0,
          "The native omission must actually reach the renderer",
        );
      } finally {
        const report = path.join(output, "readiness-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        artifacts.push(report);
      }
    }
    await open(port, false);
    await browser.wait(
      until.elementLocated(By.css(".detail-panel .primary-actions button")),
      10_000,
    );
    await browser.wait(
      async () =>
        (await browser.findElement(By.css(".detail-panel .primary-actions button")).getText()) ===
        "Play now",
      10_000,
    );
    assert.equal(
      await browser.findElement(By.css(".detail-panel .primary-actions button")).isEnabled(),
      true,
    );
    assert.equal(command(["status", port.id]).successful_launches, before.successful_launches);
  });
}
