// An isolated durable-state fixture followed by real core recovery and native rendering.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { By, until } from "selenium-webdriver";
import { captureAccessibilityReport } from "./desktop-review-controls.mjs";

export async function interruptedPreparationScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
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
    assert.match(repair.proposed_action, /cannot be resumed/);
    assert.equal(repair.path, privatePath);
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
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
    assert.match(await review.getText(), /Unfinished operation/);
    assert.ok((await review.getText()).includes(privatePath));
    assert.match(await review.getText(), /cannot be resumed/);
    assert.equal((await review.findElements(By.css("button,a"))).length, 0);
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
    await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', row);
  });
}
