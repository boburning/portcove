import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
} from "./desktop-review-controls.mjs";

async function exists(candidate) {
  return stat(candidate).then(
    () => true,
    () => false,
  );
}

async function waitForFixture(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function installScenarios({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  fixture,
}) {
  const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const buttonStarting = (label) =>
    By.xpath(`//button[starts-with(normalize-space(.),"${label}")]`);
  const openFixture = async (port) => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      Key.BACK_SPACE,
      port.name,
    );
    const card = By.xpath(
      `//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
    );
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await browser.wait(until.elementLocated(button("Review install")), 15_000);
  };
  const reviewAndStart = async ({ inspect = false } = {}) => {
    const trigger = await browser.findElement(button("Review install"));
    await trigger.click();
    const dialog = By.css('[aria-labelledby="install-review-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    const install = buttonStarting("Install ·");
    await browser.wait(until.elementLocated(install), 15_000);
    await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
    if (inspect) {
      const reviewText = await browser.findElement(dialog).getText();
      const response = await invoke("plan_port", {
        portId: fixture.port.id,
        channel: "stable",
      });
      assert.equal(response.ok, true, `Plan inspection failed: ${JSON.stringify(response.error)}`);
      const reviewedPlan = response.value;
      assert.equal(reviewedPlan.action, "download");
      assert.match(reviewText, /Review the version, download size, and install folder\./);
      assert.match(reviewText, /Install folder/);
      assert.equal(
        await browser.findElement(By.css(".install-plan-destination code")).getText(),
        reviewedPlan.output_location.effective_output_directory,
        "Install review must show the planned output folder",
      );
      await assertPrimaryReviewAction(
        browser,
        await browser.findElement(install),
        await browser.findElement(button("Cancel review")),
      );
      await assertCompactReview(browser, '[aria-labelledby="install-review-title"]');
      const accessibility = path.join(output, "install-review-accessibility.json");
      await captureAccessibilityReport(browser, accessibility, artifacts);
      const screenshot = path.join(output, "native-install-review.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(dialog)).length === 0,
        5_000,
        "Install review did not close after Escape",
      );
      await browser.wait(
        () =>
          browser.executeScript(
            'return document.activeElement?.textContent?.trim() === "Review install";',
          ),
        5_000,
        "Install review trigger did not regain focus after Escape",
      );
      await browser.findElement(button("Review install")).click();
      await browser.wait(until.elementLocated(dialog), 15_000);
      await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
    }
    await browser.findElement(install).click();
  };
  const installActivity = async (port, status) => {
    const result = await invoke("get_activities");
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.value.records));
    return result.value.records.find(
      (item) =>
        item.operation === "install" && item.target_id === port.id && item.status === status,
    );
  };

  await scenario("install-progress-cancellation", async () => {
    assert.ok(fixture, "install fixture must be initialized before the Desktop starts");
    const port = fixture.port;

    await openFixture(port);
    await reviewAndStart({ inspect: true });
    await waitForFixture(
      () => fixture.requests[0]?.bytes_sent > 0,
      "reviewed install never requested the fixture artifact",
    );
    const cancel = button("Cancel operation");
    await browser.wait(until.elementLocated(cancel), 15_000);
    const running = await browser.wait(async () => installActivity(port, "running"), 15_000);
    assert.equal(running.cancellation.phase, "preparing");
    assert.equal(running.cancellation.requested, false);
    await browser.findElement(cancel).click();
    const cancelled = await browser.wait(async () => installActivity(port, "cancelled"), 15_000);
    assert.equal(cancelled.id, running.id);
    assert.equal(cancelled.failure.code, "cancelled");
    assert.equal(cancelled.failure.presentation.tone, "neutral");
    await waitForFixture(
      () => fixture.requests[0]?.connection_closed,
      "cancelled install did not close its fixture download",
    );
    assert.equal(fixture.requests[0].completed, false);
    assert.ok(fixture.requests[0].bytes_sent < fixture.artifact.length);
    assert.equal(await exists(path.join(library, "staging", running.id)), false);
    const cancelledStatuses = await invoke("get_statuses");
    assert.equal(cancelledStatuses.ok, true);
    const afterCancellation = cancelledStatuses.value.find((item) => item.port_id === port.id);
    assert.ok(afterCancellation);
    assert.equal(afterCancellation.active, null);
    assert.equal(afterCancellation.staged, null);
    assert.equal(afterCancellation.previous, null);

    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await openFixture(port);
    await reviewAndStart();
    await waitForFixture(
      () => fixture.requests.length >= 2,
      "freshly reviewed retry never requested the fixture artifact",
    );
    const succeeded = await browser.wait(async () => installActivity(port, "succeeded"), 30_000);
    assert.notEqual(succeeded.id, cancelled.id);
    assert.equal(fixture.requests[1].completed, true);
    assert.equal(fixture.requests[1].bytes_sent, fixture.artifact.length);
    const succeededStatuses = await invoke("get_statuses");
    assert.equal(succeededStatuses.ok, true);
    const installed = succeededStatuses.value.find((item) => item.port_id === port.id);
    assert.ok(installed.active);
    assert.equal(installed.active.artifact.sha256, port.release.direct[port.platforms[0]].sha256);
    assert.equal(installed.active.artifact.size, fixture.artifact.length);
    assert.equal(installed.staged, null);
    assert.equal(await exists(path.join(library, "staging", succeeded.id)), false);
    assert.equal(
      await exists(path.join(installed.active.path, installed.active.selected_executable)),
      true,
    );

    const report = path.join(output, "install-progress-cancellation.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          port_id: port.id,
          artifact: installed.active.artifact,
          cancelled_activity: cancelled.id,
          succeeded_activity: succeeded.id,
          requests: fixture.requests,
          private_staging_absent: true,
          retry_installed_path: installed.active.path,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
    const accessibility = path.join(output, "install-cancellation-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
  });

  await scenario("install-commit-refresh-recovery", async () => {
    assert.ok(fixture, "install fixture must be initialized before the Desktop starts");
    const port = fixture.refreshPort;
    assert.ok(port, "install refresh fixture must be present in the isolated catalog");
    const requestIndex = fixture.requests.length;
    const observations = {
      port_id: port.id,
      injection:
        "a temporary get_workspace_snapshot failure window after the real install commit; explicit retry restores actual native IPC",
    };
    await openFixture(port);
    try {
      const installedProbe = await browser.executeAsyncScript((done) => {
        const native = window.__TAURI_INTERNALS__;
        const original = window.fetch;
        const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
        window.__portcoveInstallRefreshProbe = {
          original,
          target,
          calls: [],
          failing: true,
          injected: 0,
        };
        window.fetch = function (input, ...args) {
          const probe = window.__portcoveInstallRefreshProbe;
          const url = typeof input === "string" ? input : (input.url ?? String(input));
          const parsed = new URL(url, location.href);
          if (parsed.hostname === "ipc.localhost")
            probe.calls.push(decodeURIComponent(parsed.pathname.slice(1)));
          if (url === probe.target && probe.failing) {
            probe.injected++;
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: "state",
                  message: "synthetic-post-install-refresh-failure",
                  details: {},
                  presentation: {
                    presentation_key: "state_unavailable",
                    summary: "Library information is temporarily unavailable.",
                    tone: "error",
                    mutation_state: "unknown",
                    phase: null,
                    recovery_actions: ["review_current_state", "view_technical_details"],
                    technical_message:
                      "Synthetic post-install refresh rejection for presentation verification.",
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
        done({ installed: true });
      });
      assert.equal(installedProbe.installed, true);

      await reviewAndStart();
      const succeeded = await browser.wait(async () => installActivity(port, "succeeded"), 30_000);
      const retry = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Retry refresh"]')),
        15_000,
      );
      observations.failure_text = await browser.executeScript(
        (element) => element.closest(".error-banner")?.textContent ?? "",
        retry,
      );
      assert.match(observations.failure_text, /Showing the last loaded information/);
      assert.match(observations.failure_text, /does not repeat your last install/i);
      assert.doesNotMatch(
        observations.failure_text,
        /No files were changed|synthetic-post-install-refresh-failure/,
      );
      assert.equal(
        (
          await browser.findElements(
            By.xpath('//*[contains(normalize-space(.),"Portcove couldn’t finish that action")]'),
          )
        ).length,
        0,
      );

      const statusResult = await invoke("get_statuses");
      assert.equal(statusResult.ok, true);
      const installed = statusResult.value.find((item) => item.port_id === port.id);
      assert.ok(installed?.active);
      assert.equal(installed.active.artifact.size, fixture.artifact.length);
      assert.equal(installed.active.artifact.sha256, port.release.direct[port.platforms[0]].sha256);
      assert.equal(installed.staged, null);
      assert.equal(await exists(path.join(library, "staging", succeeded.id)), false);
      assert.equal(fixture.requests.length, requestIndex + 1);
      assert.equal(fixture.requests[requestIndex].completed, true);
      assert.equal(fixture.requests[requestIndex].bytes_sent, fixture.artifact.length);

      observations.activity_id = succeeded.id;
      observations.installed = installed.active;
      observations.request = fixture.requests[requestIndex];
      observations.commands_before_retry = await browser.executeScript(
        () => window.__portcoveInstallRefreshProbe.calls,
      );
      assert.equal(
        observations.commands_before_retry.filter((command) => command === "install_port").length,
        1,
      );
      assert.ok(
        (await browser.executeScript(() => window.__portcoveInstallRefreshProbe.injected)) > 0,
      );

      const failureScreenshot = path.join(output, "native-install-refresh-failure.png");
      await writeFile(failureScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(failureScreenshot);
      const accessibility = path.join(output, "install-refresh-failure-accessibility.json");
      await captureAccessibilityReport(browser, accessibility, artifacts);

      assert.equal(
        await browser.executeScript(() => {
          const retryButton = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "Retry refresh",
          );
          if (!retryButton) return false;
          window.__portcoveInstallRefreshProbe.failing = false;
          retryButton.click();
          return true;
        }),
        true,
      );
      await browser.wait(async () => {
        const buttons = await browser.findElements(
          By.xpath('//button[normalize-space(.)="Retry refresh"]'),
        );
        return buttons.length === 0;
      }, 15_000);
      await browser.wait(
        until.elementLocated(By.xpath('//*[normalize-space(.)="Ready to play"]')),
        15_000,
      );
      observations.commands_after_retry = await browser.executeScript(
        () => window.__portcoveInstallRefreshProbe.calls,
      );
      observations.retry_commands = observations.commands_after_retry.slice(
        observations.commands_before_retry.length,
      );
      const retryReads = new Set([
        "get_activities",
        "get_workspace_changed",
        "get_workspace_snapshot",
      ]);
      assert.ok(observations.retry_commands.includes("get_workspace_snapshot"));
      assert.ok(
        observations.retry_commands.every((command) => retryReads.has(command)),
        JSON.stringify(observations.retry_commands),
      );
      assert.equal(
        observations.commands_after_retry.filter((command) => command === "install_port").length,
        1,
      );
      assert.equal(fixture.requests.length, requestIndex + 1);
      observations.retry_read_only = true;
    } catch (error) {
      observations.failure = error.message;
      throw error;
    } finally {
      try {
        observations.probe = await browser.executeScript(() => {
          const probe = window.__portcoveInstallRefreshProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            installed: true,
            injected: probe.injected,
            failing: probe.failing,
            commands: probe.calls,
            restored: window.fetch === probe.original,
          };
          delete window.__portcoveInstallRefreshProbe;
          return result;
        });
        assert.equal(observations.probe.restored, true);
      } finally {
        const report = path.join(output, "install-commit-refresh-recovery.json");
        await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
        artifacts.push(report);
      }
    }
  });
}
