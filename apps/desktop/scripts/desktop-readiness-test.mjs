import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";
import {
  captureAccessibilityReport,
  openCatalogPortAfterRefresh,
  reviewControls,
} from "./desktop-review-controls.mjs";

async function injectActionHold(browser, portId, action) {
  const result = await browser.executeAsyncScript(
    (portId, action, done) => {
      const native = window.__TAURI_INTERNALS__;
      const original = window.fetch;
      const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
      window.__portcoveActionHoldProbe = { original, injected: 0, originalAvailability: null };
      window.fetch = async function (input, ...args) {
        const response = await original.call(window, input, ...args);
        const url = typeof input === "string" ? input : (input.url ?? String(input));
        if (url !== target || !response.ok) return response;
        const snapshot = await response.clone().json();
        const status = snapshot.statuses?.find((item) => item.port_id === portId);
        const matches = status?.port_actions?.filter((item) => item.action === action);
        if (matches?.length !== 1) return response;
        const probe = window.__portcoveActionHoldProbe;
        probe.injected++;
        probe.originalAvailability ??= matches[0].availability;
        return new Response(
          JSON.stringify({
            ...snapshot,
            statuses: snapshot.statuses.map((item) =>
              item.port_id === portId
                ? {
                    ...item,
                    port_actions: item.port_actions.map((assessment) =>
                      assessment.action === action
                        ? {
                            ...assessment,
                            availability: "held",
                            reason: "definition_ineligible",
                            definition: { outcome: "hold", reason: "publisher_revoked" },
                          }
                        : assessment,
                    ),
                  }
                : item,
            ),
          }),
          { status: response.status, statusText: response.statusText, headers: response.headers },
        );
      };
      native
        .invoke("plugin:event|emit", {
          event: "portcove://library-changed",
          payload: `action-hold-probe-${action}`,
        })
        .then(
          () => done({ ok: true }),
          (error) => done({ error: String(error) }),
        );
    },
    portId,
    action,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function restoreActionHold(browser, expectedAvailability) {
  const result = await browser.executeAsyncScript((done) => {
    const probe = window.__portcoveActionHoldProbe;
    if (!probe) return done({ installed: false });
    window.fetch = probe.original;
    delete window.__portcoveActionHoldProbe;
    const observation = {
      injected: probe.injected,
      originalAvailability: probe.originalAvailability,
      restored: window.fetch === probe.original,
    };
    window.__TAURI_INTERNALS__
      .invoke("plugin:event|emit", {
        event: "portcove://library-changed",
        payload: "action-hold-probe-restored",
      })
      .then(
        () => done(observation),
        (error) => done({ ...observation, error: String(error) }),
      );
  });
  assert.equal(result.restored, true, JSON.stringify(result));
  assert.ok(result.injected > 0, "The held assessment must reach an actual native snapshot");
  assert.equal(result.originalAvailability, expectedAvailability);
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result;
}

async function observeHeldLaunch({ browser, output, artifacts, command, port, held }) {
  try {
    await injectActionHold(browser, port.id, "launch");
    await browser.wait(
      async () =>
        (await browser.findElement(By.css(".detail-panel")).getText()).includes(
          "Launch is on hold. The catalog publisher was revoked.",
        ),
      10_000,
    );
    const play = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    assert.equal(await play.getText(), "Play unavailable");
    assert.equal(await play.isEnabled(), false);
    const screenshot = path.join(output, "native-held-launch.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await captureAccessibilityReport(
      browser,
      path.join(output, "held-launch-accessibility.json"),
      artifacts,
    );
    held.launch_during = command(["status", port.id]);
    assert.equal(held.launch_during.active.id, held.launch_before.active.id);
    assert.equal(held.launch_during.successful_launches, held.launch_before.successful_launches);
  } finally {
    held.launch_probe = await restoreActionHold(browser, "allowed");
  }
  await browser.wait(async () => {
    const play = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    return (await play.getText()) === "Play" && (await play.isEnabled());
  }, 10_000);
}

async function observeHeldInstall({ browser, output, artifacts, command, port, held }) {
  const controls = reviewControls(browser);
  const openPete = command(["catalog", "show", "openpete"]);
  held.install_before = command(["status", openPete.id]);
  held.sources_before = command(["source", "list"]);
  assert.equal(held.install_before.active ?? null, null);
  const selectedSource = path.join(output, "owned-openpete-selection.iso");
  await writeFile(selectedSource, "inert source selection; no game data", { flag: "wx" });
  held.selected_source = selectedSource;
  await openCatalogPortAfterRefresh(browser, openPete, openPete.name);
  const sourceInput = await browser.findElement(By.id("source-spyro-dragon-openpete"));
  await sourceInput.clear();
  await sourceInput.sendKeys(selectedSource);
  await controls.click(controls.button("Review installation"));
  const installDialog = By.css('[aria-labelledby="install-review-title"]');
  await browser.wait(until.elementLocated(installDialog), 15_000);
  held.review_text = await browser.findElement(installDialog).getText();
  assert.match(held.review_text, /v0\.1\.4/);
  assert.match(held.review_text, /Install folder/);
  try {
    await injectActionHold(browser, openPete.id, "install");
    await browser.wait(
      async () =>
        (await browser.findElements(installDialog)).length === 0 &&
        (await browser.findElement(By.css(".detail-panel")).getText()).includes(
          "Setup is on hold. The catalog publisher was revoked.",
        ),
      10_000,
    );
    const primary = await browser.findElement(By.css(".detail-panel .primary-actions button"));
    assert.equal(await primary.getText(), "Installation unavailable");
    assert.equal(await primary.isEnabled(), false);
    const cancel = await browser.findElement(controls.button("Cancel review"));
    assert.equal(await cancel.isEnabled(), true);
    const screenshot = path.join(output, "native-held-install-review-dismissed.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await captureAccessibilityReport(
      browser,
      path.join(output, "held-install-accessibility.json"),
      artifacts,
    );
    await controls.click(controls.button("Cancel review"));
    await browser.wait(
      async () => (await browser.findElements(controls.button("Cancel review"))).length === 0,
      5_000,
    );
    held.install_during = command(["status", openPete.id]);
    assert.equal(held.install_during.active ?? null, null);
    assert.deepEqual(command(["source", "list"]), held.sources_before);
  } finally {
    held.install_probe = await restoreActionHold(browser, "waiting");
  }
  await browser.wait(async () => {
    const review = await browser.findElement(controls.button("Review installation"));
    return await review.isEnabled();
  }, 10_000);
  await controls.click(controls.button("Review installation"));
  await browser.wait(until.elementLocated(installDialog), 15_000);
  await controls.click(controls.button("Cancel review"));
  held.install_after = command(["status", openPete.id]);
  assert.equal(held.install_after.active ?? null, null);
  assert.deepEqual(command(["source", "list"]), held.sources_before);
  assert.equal(
    command(["status", port.id]).successful_launches,
    held.launch_before.successful_launches,
  );
}

async function observeActionHolds({ browser, output, artifacts, command, port }) {
  const held = {
    injection: "replace one assessed action in actual native workspace snapshots only",
    launch_before: command(["status", port.id]),
  };
  try {
    await observeHeldLaunch({ browser, output, artifacts, command, port, held });
    await observeHeldInstall({ browser, output, artifacts, command, port, held });
  } catch (error) {
    held.failure = error.message;
    throw error;
  } finally {
    const report = path.join(output, "native-action-hold-observations.json");
    await writeFile(report, JSON.stringify(held, null, 2), { flag: "wx" });
    artifacts.push(report);
  }
}

export async function readinessScenario({ browser, scenario, output, artifacts, command, open }) {
  await scenario("native-missing-readiness-recovery", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const before = command(["status", port.id]);
    assert.equal(before.readiness.launchable, true);
    const observations = {
      injection:
        "omit one owned port's readiness from actual get_workspace_snapshot responses; core remains launchable",
      before,
    };
    const controls = reviewControls(browser);
    await open(port, false);
    try {
      await browser
        .executeAsyncScript((portId, done) => {
          const native = window.__TAURI_INTERNALS__;
          const original = window.fetch;
          const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
          window.__portcoveReadinessProbe = { original, injected: 0 };
          window.fetch = async function (input, ...args) {
            const url = typeof input === "string" ? input : (input.url ?? String(input));
            const response = await original.call(window, input, ...args);
            if (url !== target) return response;
            const snapshot = await response.clone().json();
            if (
              !Array.isArray(snapshot.statuses) ||
              !snapshot.statuses.some(
                (status) => status.port_id === portId && status.readiness?.launchable === true,
              )
            )
              return response;
            window.__portcoveReadinessProbe.injected++;
            return new Response(
              JSON.stringify({
                ...snapshot,
                statuses: snapshot.statuses.map((status) =>
                  status.port_id === portId ? { ...status, readiness: null } : status,
                ),
              }),
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
      const blockerOrder = await browser.executeScript(() => {
        const bounds = (selector) =>
          document.querySelector(`.detail-panel ${selector}`)?.getBoundingClientRect();
        return {
          reasonBottom: bounds(".readiness-card")?.bottom,
          actionTop: bounds(".primary-actions button")?.top,
          summaryTop: bounds(".summary")?.top,
        };
      });
      assert.ok(
        blockerOrder.reasonBottom <= blockerOrder.actionTop &&
          blockerOrder.actionTop < blockerOrder.summaryTop,
        `blocker and next action must lead the detail summary: ${JSON.stringify(blockerOrder)}`,
      );
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
      await controls.click(By.css(".detail-back"));
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
      } finally {
        const report = path.join(output, "readiness-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        artifacts.push(report);
      }
    }
    assert.ok(
      observations.probe.injected > 0,
      "The native omission must actually reach the renderer",
    );
    await open(port, false);
    await browser.wait(
      until.elementLocated(By.css(".detail-panel .primary-actions button")),
      10_000,
    );
    await browser.wait(
      async () =>
        (await browser.findElement(By.css(".detail-panel .primary-actions button")).getText()) ===
        "Play",
      10_000,
    );
    assert.equal(
      await browser.findElement(By.css(".detail-panel .primary-actions button")).isEnabled(),
      true,
    );
    const readyLayout = await browser.executeScript(() => {
      const bounds = (selector) =>
        document.querySelector(`.detail-panel ${selector}`)?.getBoundingClientRect();
      return {
        heroBottom: bounds(".detail-hero")?.bottom,
        actionTop: bounds(".primary-actions button")?.top,
        actionBottom: bounds(".primary-actions button")?.bottom,
        summaryTop: bounds(".summary")?.top,
        artworkTop: bounds(".artwork-controls")?.top,
        viewportHeight: window.innerHeight,
        duplicateReadyCard: Boolean(document.querySelector(".detail-panel .readiness-card.ready")),
      };
    });
    const readyImage = path.join(output, "native-ready-next-action.png");
    await writeFile(readyImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(readyImage);
    assert.ok(
      readyLayout.actionTop >= readyLayout.heroBottom &&
        readyLayout.actionTop >= 0 &&
        readyLayout.actionBottom <= readyLayout.viewportHeight &&
        readyLayout.actionBottom <= readyLayout.summaryTop &&
        readyLayout.actionBottom < readyLayout.artworkTop &&
        !readyLayout.duplicateReadyCard,
      `the ready next action must follow the hero and remain visible before supporting content: ${JSON.stringify(readyLayout)}`,
    );
    assert.equal(command(["status", port.id]).successful_launches, before.successful_launches);
    if (process.platform === "win32")
      await observeActionHolds({ browser, output, artifacts, command, port });
  });
}
