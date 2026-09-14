// An isolated durable-state fixture followed by real core recovery and native rendering.
import assert from "node:assert/strict";
import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { By, until } from "selenium-webdriver";
import {
  captureAccessibilityReport,
  clickVisible,
  reviewControls,
} from "./desktop-review-controls.mjs";

export async function interruptedPreparationScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}) {
  await scenario("native-interrupted-preparation-recovery", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const before = command(["status", "opengoal-jak2"]);
    const activity = command(["activity"]).find(
      (item) =>
        item.operation === "prepare" &&
        item.target_id === before.port_id &&
        item.status === "cancelled",
    );
    assert.ok(activity);
    const retained = command(["activity", "log", activity.id]);
    retained.at(-1).complete = false;
    // Simulate the durable state left before a worker's terminal update, only
    // in this harness's owned library. This is not a physical process-crash test.
    const database = new DatabaseSync(path.join(library, "portcove.sqlite3"));
    let privatePath;
    try {
      database.exec("PRAGMA busy_timeout=1000");
      const operation = database
        .prepare(
          "SELECT staging_path,final_path FROM lifecycle_operations WHERE id=? AND kind='prepare' AND phase='preparing'",
        )
        .get(activity.id);
      assert.ok(operation?.staging_path);
      assert.notEqual(operation.staging_path, operation.final_path);
      privatePath = operation.staging_path;
      database.exec("BEGIN IMMEDIATE");
      const changed = database
        .prepare(
          "UPDATE activity_history SET status='running',finished_at=NULL,message=NULL,failure_json=NULL,cancellation_phase='preparing',cancel_requested=1 WHERE id=? AND operation='prepare' AND status='cancelled'",
        )
        .run(activity.id);
      assert.equal(changed.changes, 1);
      for (const capture of retained) {
        const payload = JSON.stringify(capture);
        assert.equal(
          database
            .prepare(
              "UPDATE activity_diagnostics SET payload=?,payload_bytes=? WHERE activity_id=? AND phase=?",
            )
            .run(payload, Buffer.byteLength(payload), activity.id, capture.phase).changes,
          1,
        );
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const doctor = command(["doctor"]); // A fresh CLI executes real core startup recovery.
    const recovered = command(["activity"]).find((item) => item.id === activity.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.failure.presentation.presentation_key, "preparation_interrupted");
    assert.equal(recovered.failure.presentation.tone, "error");
    assert.equal(recovered.failure.presentation.mutation_state, "recovery_required");
    assert.equal(recovered.failure.details.cancel_requested, "true");
    const repair = doctor.repair.items.find((item) => item.operation_id === activity.id);
    assert.equal(repair.kind, "retained_preparation");
    assert.match(repair.proposed_action, /cannot be resumed/);
    assert.equal(repair.path, privatePath);
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    const updatesNavigation = await browser.findElement(
      By.xpath('//nav//button[contains(., "Updates")]'),
    );
    const navigationStatus = await browser.wait(
      until.elementLocated(
        By.xpath('//nav//button[contains(., "Updates")]//*[contains(@class,"nav-status")]'),
      ),
      10_000,
    );
    assert.equal(await navigationStatus.getAttribute("aria-label"), "Activity needs attention");
    await updatesNavigation.click();
    const row = await browser.wait(
      until.elementLocated(
        By.xpath(
          '//div[contains(@class,"activity-row")][.//p[contains(.,"Game preparation stopped before its outcome could be recorded")]]',
        ),
      ),
      10_000,
    );
    assert.match(await row.getText(), /Review game preparation/);
    assert.doesNotMatch(await row.getText(), /No files were changed|The operation was cancelled/);
    assert.deepEqual(
      (await invoke("get_activities")).value.find((item) => item.id === activity.id),
      recovered,
    );
    await row
      .findElement(By.xpath('.//summary[normalize-space(.)="View preparation log"]'))
      .click();
    await browser.wait(async () => (await row.getText()).includes("Capture is incomplete"), 5_000);
    const report = path.join(output, "interrupted-preparation-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const evidence = path.join(output, "interrupted-preparation-recovery.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          method: "simulated durable interruption with real CLI recovery and native UI",
          activity: recovered,
          repair,
          captures: retained,
          navigation_status: "Activity needs attention",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(evidence);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', row);
    const review = await browser.findElement(By.css(`[data-recovery-operation="${activity.id}"]`));
    await review.findElement(By.css("summary")).click();
    assert.match(await review.getText(), /Retained preparation files/);
    assert.ok((await review.getText()).includes(privatePath));
    assert.match(await review.getText(), /cannot be resumed/);
    const controls = reviewControls(browser);
    const cleanupReview = await review.findElement(
      By.xpath('.//button[normalize-space(.)="Review private-file cleanup"]'),
    );
    assert.equal((await review.findElements(By.css("button,a"))).length, 1);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', review);
    const recoveryAccessibility = await browser.executeAsyncScript((done) =>
      window.axe.run().then(done),
    );
    const recoveryReport = path.join(output, "recovery-review-accessibility.json");
    await writeFile(recoveryReport, JSON.stringify(recoveryAccessibility, null, 2), { flag: "wx" });
    artifacts.push(recoveryReport);
    assert.deepEqual(
      recoveryAccessibility.violations.map((item) => item.id),
      [],
    );
    const recoveryImage = path.join(output, "native-retained-work-review.png");
    await writeFile(recoveryImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(recoveryImage);
    await clickVisible(browser, cleanupReview);
    const cleanupDialog = By.css('[aria-labelledby="preparation-cleanup-title"]');
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      async () => (await browser.findElement(cleanupDialog).getText()).includes(privatePath),
      15_000,
    );
    const cleanupText = await browser.findElement(cleanupDialog).getText();
    for (const expected of [
      privatePath,
      "Original installation preserved",
      "Registered source preserved",
      "Saved data preserved",
      "Backups preserved",
      "Logs preserved",
      "cannot be recovered",
      "external setup process",
    ]) {
      assert.ok(cleanupText.includes(expected), expected);
    }
    const cleanupAccessibility = path.join(output, "preparation-cleanup-accessibility.json");
    await captureAccessibilityReport(browser, cleanupAccessibility, artifacts);
    const cleanupImage = path.join(output, "native-preparation-cleanup-review.png");
    await writeFile(cleanupImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(cleanupImage);
    await controls.click(controls.button("Keep retained files"));
    await access(privatePath);

    await clickVisible(browser, cleanupReview);
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      until.elementLocated(controls.button("Remove reviewed private files permanently")),
      15_000,
    );
    await writeFile(path.join(privatePath, "changed-after-review.bin"), "owned stale review");
    await controls.click(controls.button("Remove reviewed private files permanently"));
    await browser.wait(until.elementLocated(controls.button("Review again")), 15_000);
    await access(privatePath);
    await controls.click(controls.button("Review again"));
    await browser.wait(
      until.elementLocated(controls.button("Remove reviewed private files permanently")),
      15_000,
    );
    await controls.click(controls.button("Remove reviewed private files permanently"));
    await confirmNative(
      "Confirm retained preparation cleanup",
      "__observe__",
      privatePath,
      "preparation-cleanup-before-consent",
    );
    await access(privatePath);
    await confirmNative(
      "Confirm retained preparation cleanup",
      "Cancel",
      privatePath,
      "preparation-cleanup-cancelled",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await access(privatePath);

    const currentReview = await browser.findElement(
      By.css(`[data-recovery-operation="${activity.id}"]`),
    );
    await clickVisible(
      browser,
      await currentReview.findElement(
        By.xpath('.//button[normalize-space(.)="Review private-file cleanup"]'),
      ),
    );
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await controls.click(controls.button("Remove reviewed private files permanently"));
    await confirmNative(
      "Confirm retained preparation cleanup",
      "Remove reviewed private files",
      privatePath,
      "preparation-cleanup-confirmed",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await assert.rejects(access(privatePath));
    assert.equal(
      command(["doctor"]).repair.items.some((item) => item.operation_id === activity.id),
      false,
    );
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    const cleanupEvidence = path.join(output, "reviewed-preparation-cleanup.json");
    await writeFile(
      cleanupEvidence,
      JSON.stringify(
        {
          method: "native custom review plus backend-owned confirmation",
          operation_id: activity.id,
          removed_private_path: privatePath,
          stale_tree_rejected: true,
          native_decline_preserved_private_path: true,
          accepted_cleanup_removed_private_path: true,
          active_install_preserved: true,
          activity_diagnostics_preserved: true,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(cleanupEvidence);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', row);
  });
}
