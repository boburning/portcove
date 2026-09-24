// An isolated durable-state fixture followed by real core recovery and native rendering.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until } from "selenium-webdriver";
import {
  assertDestructiveReviewAction,
  captureAccessibilityReport,
  clickVisible,
  reviewControls,
} from "./desktop-review-controls.mjs";

function insertOwnedRow(database, table, source, overrides = {}) {
  const tableName =
    table === "lifecycle_operations"
      ? '"lifecycle_operations"'
      : table === "activity_history"
        ? '"activity_history"'
        : undefined;
  assert.ok(tableName, `unsupported fixture table: ${table}`);
  assert.ok(source, `${table} source row`);
  const columns = Object.keys(source);
  const quotedColumns = columns.map((name) => `"${name.replaceAll('"', '""')}"`);
  const clone = { ...source, ...overrides };
  database
    .prepare(
      `INSERT INTO ${tableName}(${quotedColumns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...columns.map((name) => clone[name]));
  return clone;
}

function setPreparationProcessQuiescence(library, operationId, value) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"));
  try {
    database.exec("PRAGMA busy_timeout=1000");
    const changed = database
      .prepare(
        "UPDATE lifecycle_operations SET preparation_process_quiesced=? WHERE id=? AND kind='prepare' AND phase='preparing'",
      )
      .run(value, operationId);
    assert.equal(changed.changes, 1);
  } finally {
    database.close();
  }
}

export async function interruptedPreparationScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  activities,
  confirmNative,
  restartApplication,
}) {
  await scenario("native-interrupted-preparation-recovery", async () => {
    browser = await restartApplication("interrupted-preparation-recovery");
    const applicationUpdateChoice = By.xpath(
      '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
    );
    const dismissApplicationUpdateChoice = async () => {
      const preferences = await invoke("get_application_update_preferences");
      assert.equal(preferences.ok, true);
      if (preferences.value.choice !== null) return;
      await browser.wait(until.elementLocated(applicationUpdateChoice), 15_000);
      await browser
        .findElement(
          By.xpath(
            '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]//button[normalize-space(.)="Not now"]',
          ),
        )
        .click();
      await browser.wait(
        async () => (await browser.findElements(applicationUpdateChoice)).length === 0,
        15_000,
      );
    };
    await dismissApplicationUpdateChoice();
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const cliActivities = () => {
      const feed = command(["activity"]);
      assert.ok(Array.isArray(feed.records));
      return feed.records;
    };
    const before = command(["status", "opengoal-jak2"]);
    const activity = cliActivities().find(
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
    let privatePath;
    let journalOnlyId;
    let journalOnlyPath;
    let journalOnlyActivityRow;
    let journalOnlyOperationRow;
    browser = await restartApplication("interrupted-preparation-fixture", async () => {
      const database = new DatabaseSync(path.join(library, "portcove.sqlite3"));
      try {
        database.exec("PRAGMA busy_timeout=1000");
        const operation = database
          .prepare(
            "SELECT * FROM lifecycle_operations WHERE id=? AND kind='prepare' AND phase='preparing'",
          )
          .get(activity.id);
        const activityRow = database
          .prepare("SELECT * FROM activity_history WHERE id=? AND operation='prepare'")
          .get(activity.id);
        assert.ok(operation?.staging_path);
        assert.ok(activityRow);
        assert.notEqual(operation.staging_path, operation.final_path);
        privatePath = operation.staging_path;
        journalOnlyId = randomUUID();
        journalOnlyPath = path.join(path.dirname(privatePath), journalOnlyId);
        const plan = JSON.parse(operation.preparation_json);
        const journalOnlyDestination = createHash("sha256")
          .update(
            JSON.stringify(["Portcove prepared derivative v1", plan.plan_sha256, journalOnlyId]),
          )
          .digest("hex");
        database.exec("BEGIN IMMEDIATE");
        const changed = database
          .prepare(
            "UPDATE activity_history SET status='running',finished_at=NULL,message=NULL,failure_json=NULL,cancellation_phase='preparing',cancel_requested=1 WHERE id=? AND operation='prepare' AND status='cancelled'",
          )
          .run(activity.id);
        assert.equal(changed.changes, 1);
        journalOnlyActivityRow = {
          ...activityRow,
          id: journalOnlyId,
          status: "running",
          message: null,
          finished_at: null,
          failure_json: null,
          cancellation_phase: "preparing",
          cancel_requested: 1,
          cancellation_owner: null,
        };
        journalOnlyOperationRow = {
          ...operation,
          id: journalOnlyId,
          phase: "preparing",
          staging_path: journalOnlyPath,
          final_path: path.join(path.dirname(operation.final_path), journalOnlyDestination),
          quarantine_path: null,
          install_json: null,
          last_error: "owned journal-only preparation fixture",
          preparation_process_quiesced: 1,
        };
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
      await assert.rejects(access(journalOnlyPath));
      const pendingDoctor = command(["doctor"]);
      assert.equal(cliActivities().find((item) => item.id === activity.id).status, "running");
      assert.ok(pendingDoctor.repair.items.some((item) => item.operation_id === activity.id));
    });
    // Desktop startup performs locked recovery; later CLI observations remain read-only.
    const doctor = command(["doctor"]);
    const recovered = cliActivities().find((item) => item.id === activity.id);
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
    // Qualification-only negative state: the retained process outcome is
    // unknown, so the actual cleanup consumer must refuse before inventory or
    // consent. This does not claim that a real external process is still live.
    const unprovenQuiescenceError =
      "retained preparation process quiescence is not proven; cleanup is refused";
    const unprovenQuiescenceSummary =
      "The selection changed or another operation is using it. Review its current state.";
    setPreparationProcessQuiescence(library, activity.id, null);
    const cleanupGeneration = (await invoke("get_bootstrap_status")).value.generation;
    const refusedPreview = await invoke("preview_preparation_cleanup", {
      operationId: activity.id,
      generation: cleanupGeneration,
    });
    assert.equal(refusedPreview.ok, false);
    assert.equal(refusedPreview.error.code, "conflict");
    assert.equal(refusedPreview.error.message, unprovenQuiescenceError);
    assert.equal(refusedPreview.error.details.recovery_action, "manual_review");
    assert.equal(refusedPreview.error.presentation.summary, unprovenQuiescenceSummary);
    const interruptedRows = By.css(".activity-row.failed");
    const findInterruptedRow = async () => {
      const candidates = await browser.findElements(interruptedRows);
      for (const candidate of candidates) {
        const text = await candidate.getText();
        if (
          text.includes("Game-data setup") &&
          text.includes("Game preparation stopped before its outcome could be recorded") &&
          text.toLowerCase().includes("failed") &&
          text.includes("Review game preparation")
        ) {
          return candidate;
        }
      }
      return false;
    };
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
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
    await browser.wait(
      findInterruptedRow,
      15_000,
      "Recovered failed preparation must appear after renderer bootstrap",
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.wait(
      until.elementLocated(By.xpath('//h1[normalize-space(.)="Settings"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    const beforeRestart = await browser.wait(
      findInterruptedRow,
      15_000,
      "Failed preparation must remain discoverable after navigating away and returning",
    );
    const beforeRestartLog = await beforeRestart.findElement(
      By.xpath('.//summary[normalize-space(.)="View preparation log"]'),
    );
    await beforeRestartLog.click();
    const beforeRestartText = await browser.wait(async () => {
      const text = await beforeRestart.getText();
      return text.includes("Capture is incomplete") ? text : false;
    }, 15_000);
    assert.match(beforeRestartText, /Running game setup/);
    assert.doesNotMatch(beforeRestartText, /No files were changed|The operation was cancelled/);
    await beforeRestartLog.click();
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    const restartedNavigationStatus = await browser.wait(
      until.elementLocated(
        By.xpath('//nav//button[contains(., "Updates")]//*[contains(@class,"nav-status")]'),
      ),
      10_000,
    );
    assert.equal(
      await restartedNavigationStatus.getAttribute("aria-label"),
      "Activity needs attention",
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    const rows = await browser.wait(async () => {
      const candidates = await browser.findElements(interruptedRows);
      const matches = [];
      for (const candidate of candidates) {
        const text = await candidate.getText();
        if (
          text.includes("Game-data setup") &&
          text.includes("Game preparation stopped before its outcome could be recorded") &&
          text.toLowerCase().includes("failed") &&
          text.includes("Review game preparation")
        ) {
          matches.push(candidate);
        }
      }
      return matches.length === 1 ? matches : false;
    }, 15_000);
    let row;
    for (const candidate of rows) {
      const text = await candidate.getText();
      assert.match(text, /Review game preparation/);
      assert.doesNotMatch(text, /No files were changed|The operation was cancelled/);
      const log = await candidate.findElement(
        By.xpath('.//summary[normalize-space(.)="View preparation log"]'),
      );
      await log.click();
      const loadedText = await browser.wait(async () => {
        const current = await candidate.getText();
        return current.includes("Reading the retained log")
          ? false
          : current.includes("Capture reached the end") ||
              current.includes("Capture is incomplete") ||
              current.includes("No retained diagnostic capture")
            ? current
            : false;
      }, 15_000);
      if (loadedText.includes("Capture is incomplete")) {
        row = candidate;
        break;
      }
      await log.click();
    }
    assert.ok(row, "original retained preparation row with incomplete diagnostic capture");
    assert.match(await row.getText(), /Running game setup/);
    assert.deepEqual(
      (await activities()).find((item) => item.id === activity.id),
      recovered,
    );
    const report = path.join(output, "interrupted-preparation-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const evidence = path.join(output, "interrupted-preparation-recovery.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          method:
            "simulated durable interruption with read-only CLI checks, Desktop startup recovery, and native UI",
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
    const review = await browser.wait(
      until.elementLocated(By.css(`[data-recovery-operation="${activity.id}"]`)),
      15_000,
    );
    await review.findElement(By.css("summary")).click();
    assert.match(await review.getText(), /Retained preparation files/);
    assert.ok((await review.getText()).includes(privatePath));
    assert.match(await review.getText(), /cannot be resumed/);
    let controls = reviewControls(browser);
    const cleanupReview = await review.findElement(
      By.xpath('.//button[normalize-space(.)="Review unfinished setup files"]'),
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
      async () =>
        (await browser.findElement(cleanupDialog).getText()).includes(unprovenQuiescenceSummary),
      15_000,
      "Cleanup review must refuse when process-tree quiescence is unproven",
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      5_000,
      "Preparation cleanup review did not close after Escape",
    );
    await browser.wait(
      () => browser.executeScript("return document.activeElement === arguments[0];", cleanupReview),
      5_000,
      "Preparation cleanup trigger did not regain focus after Escape",
    );
    await clickVisible(browser, cleanupReview);
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      async () =>
        (await browser.findElement(cleanupDialog).getText()).includes(unprovenQuiescenceSummary),
      15_000,
    );
    const refusedCleanupText = await browser.findElement(cleanupDialog).getText();
    assert.ok(refusedCleanupText.includes(unprovenQuiescenceSummary));
    assert.deepEqual(
      await Promise.all(
        (await browser.findElement(cleanupDialog).findElements(By.css("button"))).map((button) =>
          button.getText(),
        ),
      ),
      ["Keep retained files", "Review again"],
    );
    await access(privatePath);
    assert.ok(command(["doctor"]).repair.items.some((item) => item.operation_id === activity.id));
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    const refusedCleanupAccessibility = path.join(
      output,
      "preparation-cleanup-unproven-quiescence-accessibility.json",
    );
    await captureAccessibilityReport(browser, refusedCleanupAccessibility, artifacts);
    const refusedCleanupImage = path.join(
      output,
      "native-preparation-cleanup-unproven-quiescence.png",
    );
    await writeFile(refusedCleanupImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(refusedCleanupImage);
    const refusedCleanupEvidence = path.join(
      output,
      "preparation-cleanup-unproven-quiescence.json",
    );
    await writeFile(
      refusedCleanupEvidence,
      JSON.stringify(
        {
          method:
            "controlled unknown process-quiescence state through actual native cleanup review",
          operation_id: activity.id,
          technical_refusal: unprovenQuiescenceError,
          player_summary: unprovenQuiescenceSummary,
          retained_private_path_preserved: true,
          recovery_journal_preserved: true,
          activity_and_diagnostics_preserved: true,
          active_install_preserved: true,
          actual_live_process_observed: false,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(refusedCleanupEvidence);

    // Controlled positive state for the same operation: once durable
    // quiescence is explicitly present, the same consumer may load the exact
    // review. Later stale-review, cancellation, restart, and accepted-cleanup
    // checks remain unchanged.
    setPreparationProcessQuiescence(library, activity.id, 1);
    await controls.click(controls.button("Review again"));
    await browser.wait(
      async () => (await browser.findElement(cleanupDialog).getText()).includes(privatePath),
      15_000,
    );
    const cleanupActionStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(controls.button("Delete setup working files")),
      await browser.findElement(controls.button("Keep retained files")),
    );
    const cleanupText = await browser.findElement(cleanupDialog).getText();
    for (const expected of [
      "Delete files left by unfinished setup?",
      privatePath,
      "Original installation preserved",
      "Registered source preserved",
      "Saved data preserved",
      "Backups preserved",
      "Logs preserved",
      "cannot be recovered",
      "setup and any programs it started have stopped",
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
    await browser.wait(until.elementLocated(controls.button("Delete setup working files")), 15_000);
    await writeFile(path.join(privatePath, "changed-after-review.bin"), "owned stale review");
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(controls.button("Delete setup working files")),
        15_000,
      ),
      { dispatch: "dom" },
    );
    await browser.wait(until.elementLocated(controls.button("Review again")), 15_000);
    await access(privatePath);
    await controls.click(controls.button("Review again"));
    await browser.wait(until.elementLocated(controls.button("Delete setup working files")), 15_000);
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(controls.button("Delete setup working files")),
        15_000,
      ),
      { dispatch: "dom" },
    );
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
    browser = await restartApplication("interrupted-preparation-recovery-after-cancel");
    controls = reviewControls(browser);
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();

    const recoveredReviewLocator = By.css(`[data-recovery-operation="${activity.id}"]`);
    let recoveredReview = await browser.wait(until.elementLocated(recoveredReviewLocator), 15_000);
    await recoveredReview.findElement(By.css("summary")).click();
    await browser.wait(
      async () => (await recoveredReview.getAttribute("open")) !== null,
      5_000,
      "The recovered preparation disclosure must be open before cleanup review",
    );
    recoveredReview = await browser.findElement(recoveredReviewLocator);
    if ((await recoveredReview.getAttribute("open")) === null) {
      await recoveredReview.findElement(By.css("summary")).click();
      await browser.wait(
        async () => (await recoveredReview.getAttribute("open")) !== null,
        5_000,
        "The current recovered preparation disclosure must be open before cleanup review",
      );
    }
    await clickVisible(
      browser,
      await recoveredReview.findElement(
        By.xpath('.//button[normalize-space(.)="Review unfinished setup files"]'),
      ),
    );
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      async () => (await browser.findElement(cleanupDialog).getText()).includes(privatePath),
      15_000,
    );
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(controls.button("Delete setup working files")),
        15_000,
      ),
      { dispatch: "dom" },
    );
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
    browser = await restartApplication("journal-only-preparation-recovery", async () => {
      const journalDatabase = new DatabaseSync(path.join(library, "portcove.sqlite3"));
      try {
        journalDatabase.exec("PRAGMA busy_timeout=1000");
        journalDatabase.exec("BEGIN IMMEDIATE");
        insertOwnedRow(journalDatabase, "activity_history", journalOnlyActivityRow);
        insertOwnedRow(journalDatabase, "lifecycle_operations", journalOnlyOperationRow);
        journalDatabase.exec("COMMIT");
      } finally {
        journalDatabase.close();
      }
      await assert.rejects(access(journalOnlyPath));
      const pendingDoctor = command(["doctor"]);
      assert.equal(cliActivities().find((item) => item.id === journalOnlyId).status, "running");
      assert.ok(pendingDoctor.repair.items.some((item) => item.operation_id === journalOnlyId));
    });
    const journalOnlyDoctor = command(["doctor"]);
    const journalOnlyActivity = cliActivities().find((item) => item.id === journalOnlyId);
    assert.equal(journalOnlyActivity.status, "failed");
    assert.equal(
      journalOnlyActivity.failure.presentation.presentation_key,
      "preparation_interrupted",
    );
    assert.equal(journalOnlyActivity.failure.presentation.mutation_state, "recovery_required");
    const journalOnlyRepair = journalOnlyDoctor.repair.items.find(
      (item) => item.operation_id === journalOnlyId,
    );
    assert.equal(journalOnlyRepair.kind, "retained_preparation");
    assert.equal(journalOnlyRepair.path, journalOnlyPath);
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    controls = reviewControls(browser);
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    const journalOnlyReviewLocator = By.css(`[data-recovery-operation="${journalOnlyId}"]`);
    await browser.wait(until.elementLocated(journalOnlyReviewLocator), 15_000);
    await browser.wait(
      async () =>
        (
          await browser.findElements(
            By.xpath(
              '//section[@aria-label="Retained work and repairs"]//p[@role="status" and starts-with(normalize-space(.), "Refreshing recovery information")]',
            ),
          )
        ).length === 0,
      15_000,
      "Recovery diagnostics must settle before journal-only cleanup review",
    );
    let journalOnlyReview = await browser.findElement(journalOnlyReviewLocator);
    await journalOnlyReview.findElement(By.css("summary")).click();
    await browser.wait(
      async () => (await journalOnlyReview.getAttribute("open")) !== null,
      5_000,
      "The journal-only recovery disclosure must be open before cleanup review",
    );
    journalOnlyReview = await browser.findElement(journalOnlyReviewLocator);
    if ((await journalOnlyReview.getAttribute("open")) === null) {
      await journalOnlyReview.findElement(By.css("summary")).click();
      await browser.wait(
        async () => (await journalOnlyReview.getAttribute("open")) !== null,
        5_000,
        "The current journal-only recovery disclosure must be open before cleanup review",
      );
    }
    const journalOnlyCleanupReview = await journalOnlyReview.findElement(
      By.xpath('.//button[normalize-space(.)="Review unfinished setup files"]'),
    );
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "center", inline: "nearest" });',
      journalOnlyCleanupReview,
    );
    await clickVisible(browser, journalOnlyCleanupReview);
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      async () => (await browser.findElement(cleanupDialog).getText()).includes(journalOnlyPath),
      15_000,
    );
    const journalOnlyText = await browser.findElement(cleanupDialog).getText();
    assert.ok(journalOnlyText.includes("Clear unfinished setup record?"));
    assert.ok(journalOnlyText.includes("Cancel"));
    assert.ok(!journalOnlyText.includes("Keep retained files"));
    assert.match(journalOnlyText, /0 files/);
    assert.match(
      journalOnlyText,
      /No setup working files were found\. Cleanup clears the recorded setup path if it exists and its stale recovery journal/,
    );
    await assert.rejects(access(journalOnlyPath));
    const journalOnlyAccessibility = path.join(
      output,
      "journal-only-preparation-cleanup-accessibility.json",
    );
    await captureAccessibilityReport(browser, journalOnlyAccessibility, artifacts);
    const journalOnlyImage = path.join(
      output,
      "native-journal-only-preparation-cleanup-review.png",
    );
    await writeFile(journalOnlyImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(journalOnlyImage);
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(controls.button("Clear unfinished setup record")),
        15_000,
      ),
      { dispatch: "dom" },
    );
    await confirmNative(
      "Confirm retained preparation cleanup",
      "Remove empty private state",
      journalOnlyPath,
      "journal-only-preparation-cleanup-confirmed",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await assert.rejects(access(journalOnlyPath));
    assert.equal(
      command(["doctor"]).repair.items.some((item) => item.operation_id === journalOnlyId),
      false,
    );
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.equal(cliActivities().find((item) => item.id === journalOnlyId).status, "failed");
    const journalOnlyEvidence = path.join(output, "journal-only-preparation-cleanup.json");
    await writeFile(
      journalOnlyEvidence,
      JSON.stringify(
        {
          method:
            "journal-only durable fixture with read-only CLI checks, Desktop startup recovery, and native reviewed cleanup",
          operation_id: journalOnlyId,
          absent_private_path: journalOnlyPath,
          private_path_absent_before_review: true,
          accepted_cleanup_removed_only_stale_journal: true,
          active_install_preserved: true,
          failed_activity_preserved: true,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(journalOnlyEvidence);
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
          escape_dismissal_and_focus_restoration: true,
          cleanup_action_styles: cleanupActionStyles,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(cleanupEvidence);
    const finalInterruptedRow = await browser.wait(until.elementLocated(interruptedRows), 15_000);
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "start", inline: "nearest" });',
      finalInterruptedRow,
    );
  });
  return browser;
}
