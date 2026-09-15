import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { captureAccessibilityReport } from "./desktop-review-controls.mjs";

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

export async function installProgressCancellationScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  fixture,
}) {
  await scenario("install-progress-cancellation", async () => {
    assert.ok(fixture, "install fixture must be initialized before the Desktop starts");
    const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const buttonStarting = (label) =>
      By.xpath(`//button[starts-with(normalize-space(.),"${label}")]`);
    const openFixture = async () => {
      await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
      const search = await browser.findElement(By.id("port-search"));
      await search.sendKeys(
        Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
        Key.BACK_SPACE,
        fixture.port.name,
      );
      const card = By.xpath(
        `//button[contains(@class,"port-card") and starts-with(@aria-label,"${fixture.port.name}.")]`,
      );
      await browser.wait(until.elementLocated(card), 15_000);
      await browser.findElement(card).click();
      await browser.wait(until.elementLocated(button("Review install")), 15_000);
    };
    const reviewAndStart = async () => {
      await browser.findElement(button("Review install")).click();
      const install = buttonStarting("Install ·");
      await browser.wait(until.elementLocated(install), 15_000);
      await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
      await browser.findElement(install).click();
    };
    const installActivity = async (status) => {
      const result = await invoke("get_activities");
      assert.equal(result.ok, true);
      return result.value.find(
        (item) =>
          item.operation === "install" &&
          item.target_id === fixture.port.id &&
          item.status === status,
      );
    };

    await openFixture();
    await reviewAndStart();
    await waitForFixture(
      () => fixture.requests[0]?.bytes_sent > 0,
      "reviewed install never requested the fixture artifact",
    );
    const cancel = button("Cancel operation");
    await browser.wait(until.elementLocated(cancel), 15_000);
    const running = await browser.wait(async () => installActivity("running"), 15_000);
    assert.equal(running.cancellation.phase, "preparing");
    assert.equal(running.cancellation.requested, false);
    await browser.findElement(cancel).click();
    const cancelled = await browser.wait(async () => installActivity("cancelled"), 15_000);
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
    const afterCancellation = cancelledStatuses.value.find(
      (item) => item.port_id === fixture.port.id,
    );
    assert.ok(afterCancellation);
    assert.equal(afterCancellation.active, null);
    assert.equal(afterCancellation.staged, null);
    assert.equal(afterCancellation.previous, null);

    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await openFixture();
    await reviewAndStart();
    await waitForFixture(
      () => fixture.requests.length >= 2,
      "freshly reviewed retry never requested the fixture artifact",
    );
    const succeeded = await browser.wait(async () => installActivity("succeeded"), 30_000);
    assert.notEqual(succeeded.id, cancelled.id);
    assert.equal(fixture.requests[1].completed, true);
    assert.equal(fixture.requests[1].bytes_sent, fixture.artifact.length);
    const succeededStatuses = await invoke("get_statuses");
    assert.equal(succeededStatuses.ok, true);
    const installed = succeededStatuses.value.find((item) => item.port_id === fixture.port.id);
    assert.ok(installed.active);
    assert.equal(
      installed.active.artifact.sha256,
      fixture.port.release.direct[fixture.port.platforms[0]].sha256,
    );
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
          port_id: fixture.port.id,
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
}
