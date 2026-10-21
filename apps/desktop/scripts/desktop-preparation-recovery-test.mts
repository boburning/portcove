import { fixtureObject as object } from "./desktop-scenario-state.mts";
import type { PreparationContext } from "./desktop-preparation-test.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type {
  ActivityRecord,
  PortDefinition,
  PortStatus,
  InstallRecord,
  TransportOutputs,
} from "../src/transport-types.generated.d.ts";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { transportValue } from "./transport-values.mts";
type RecoveryBase = Pick<
  PreparationContext,
  "browser" | "invoke" | "scenario" | "library" | "output" | "artifacts"
> & {
  command: FixtureCommand;
  activities: () => Promise<ActivityRecord[]>;
};
type InterruptedContext = RecoveryBase &
  Pick<PreparationContext, "confirmNative" | "restartApplication">;
type LiveFixture = {
  seed: (
    portId: string,
    mode: string,
    chd?: boolean,
  ) => Promise<{ port: PortDefinition; install: Pick<InstallRecord, "id"> }>;
  open: (port: PortDefinition, refresh?: boolean) => Promise<unknown>;
  status: (portId: string) => Promise<PortStatus>;
};
type LiveRecoveryContext = RecoveryBase &
  LiveFixture &
  Pick<PreparationContext, "interruptApplication"> & {
    scenarioId?: string;
    ordinaryClose?: boolean;
  };
type SQLRow = Record<string, SQLOutputValue>;
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function recoveryInvoke(invoke: PreparationContext["invoke"]) {
  return async (name: string, args?: Record<string, unknown>) => object(await invoke(name, args));
}
function recoveryCommand(command: FixtureCommand) {
  function read(args: ["doctor"]): TransportOutputs["doctor"];
  function read(args: ["status", string]): PortStatus;
  function read(args: ["activity"]): TransportOutputs["activity"];
  function read(args: ["activity", "log", string]): TransportOutputs["activity_diagnostic"];
  function read(args: string[]) {
    const value = command(args);
    if (args[0] === "doctor") return transportValue("doctor", value);
    if (args[0] === "status") return transportValue("status", value);
    if (args[0] === "activity" && args[1] === "log")
      return transportValue("activity_diagnostic", value);
    if (args[0] === "activity") return transportValue("activity", value);
    throw new Error("Unknown recovery observation command");
  }
  return read;
}
import type { WebDriver } from "selenium-webdriver";
import { executeBrowserScript } from "./browser-script.mts";
// An isolated durable-state fixture followed by real core recovery and native rendering.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until } from "selenium-webdriver";
import {
  assertDestructiveReviewAction,
  observeAccessibility,
  assertNoAccessibilityViolations,
  captureAccessibilityReport,
  clickVisible,
  reviewControls,
} from "./desktop-review-controls.mts";

function insertOwnedRow(
  database: DatabaseSync,
  table: string,
  source: SQLRow,
  overrides: Record<string, SQLInputValue> = {},
) {
  const tableName =
    table === "lifecycle_operations"
      ? '"lifecycle_operations"'
      : table === "activity_history"
        ? '"activity_history"'
        : undefined;
  assert.ok(tableName, `unsupported fixture table: ${table}`);
  assert.ok(source, `${table} source row`);
  const columns = Object.keys(source);
  const quotedColumns = columns.map((name: string) => `"${name.replaceAll('"', '""')}"`);
  const clone: Record<string, SQLInputValue> = { ...source, ...overrides };
  database
    .prepare(
      `INSERT INTO ${tableName}(${quotedColumns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(
      ...columns.map((name) => {
        const value = clone[name];
        assert.ok(value !== undefined);
        return value;
      }),
    );
  return clone;
}

function setPreparationProcessQuiescence(
  library: string,
  operationId: string,
  value: number | null,
) {
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
  invoke: invokeRaw,
  scenario,
  library,
  output,
  artifacts,
  command: commandRaw,
  activities,
  confirmNative,
  restartApplication,
}: InterruptedContext): Promise<WebDriver> {
  const invoke = recoveryInvoke(invokeRaw);
  const command = recoveryCommand(commandRaw);
  await scenario("native-interrupted-preparation-recovery", async () => {
    browser = await restartApplication("interrupted-preparation-recovery");
    const applicationUpdateChoice = By.xpath(
      '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
    );
    const dismissApplicationUpdateChoice = async () => {
      const preferences = await invoke("get_application_update_preferences");
      assert.equal(preferences.ok, true);
      if (
        transportValue("desktop_application_update_preferences", preferences.value).choice !== null
      )
        return;
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
    const port = required(
      transportValue("catalog", (await invoke("get_catalog")).value).ports.find(
        (candidate) => candidate.id === before.port_id,
      ),
    );
    const activity = cliActivities().find(
      (item) =>
        item.operation === "prepare" &&
        item.target_id === before.port_id &&
        item.status === "cancelled",
    );
    assert.ok(activity);
    const retained = command(["activity", "log", activity.id]);
    required(retained.at(-1)).complete = false;
    // Simulate the durable state left before a worker's terminal update, only
    // in this harness's owned library. This is not a physical process-crash test.
    let privatePath: string | undefined;
    let journalOnlyId: string | undefined;
    let journalOnlyPath: string | undefined;
    let journalOnlyActivityRow: SQLRow | undefined;
    let journalOnlyOperationRow: SQLRow | undefined;
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
        privatePath = text(operation.staging_path);
        journalOnlyId = randomUUID();
        journalOnlyPath = path.join(path.dirname(required(privatePath)), required(journalOnlyId));
        const plan = object(JSON.parse(text(operation.preparation_json)));
        const journalOnlyDestination = createHash("sha256")
          .update(
            JSON.stringify([
              "Portcove prepared derivative v1",
              plan.plan_sha256,
              required(journalOnlyId),
            ]),
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
          id: required(journalOnlyId),
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
          id: required(journalOnlyId),
          phase: "preparing",
          staging_path: required(journalOnlyPath),
          final_path: path.join(path.dirname(text(operation.final_path)), journalOnlyDestination),
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
      await assert.rejects(access(required(journalOnlyPath)));
      const pendingDoctor = command(["doctor"]);
      assert.equal(
        required(cliActivities().find((item) => item.id === activity.id)).status,
        "running",
      );
      assert.ok(pendingDoctor.repair.items.some((item) => item.operation_id === activity.id));
    });
    // Desktop startup performs locked recovery; later CLI observations remain read-only.
    const doctor = command(["doctor"]);
    const recovered = cliActivities().find((item) => item.id === activity.id);
    assert.equal(required(recovered).status, "failed");
    assert.equal(
      required(required(recovered).failure).presentation.presentation_key,
      "preparation_interrupted",
    );
    assert.equal(required(required(recovered).failure).presentation.tone, "error");
    assert.equal(
      required(required(recovered).failure).presentation.mutation_state,
      "recovery_required",
    );
    assert.equal(required(required(recovered).failure).details.cancel_requested, "true");
    const repair = doctor.repair.items.find((item) => item.operation_id === activity.id);
    assert.equal(required(repair).kind, "retained_preparation");
    assert.match(required(repair).proposed_action, /this interrupted setup cannot resume/);
    assert.equal(required(repair).path, required(privatePath));
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    // Qualification-only negative state: the retained process outcome is
    // unknown, so the actual cleanup consumer must refuse before inventory or
    // consent. This does not claim that a real external process is still live.
    const unprovenQuiescenceError =
      "retained preparation process quiescence is not proven; cleanup is refused";
    const unprovenQuiescenceSummary = `Game preparation for ${port.name} (${port.id}): The selection changed or another operation is using it. Review its current state.`;
    setPreparationProcessQuiescence(library, activity.id, null);
    const cleanupGeneration = transportValue(
      "desktop_bootstrap_status",
      (await invoke("get_bootstrap_status")).value,
    ).generation;
    const refusedPreview = await invoke("preview_preparation_cleanup", {
      operationId: activity.id,
      generation: cleanupGeneration,
    });
    assert.equal(refusedPreview.ok, false);
    assert.equal(object(refusedPreview.error).code, "conflict");
    assert.equal(text(object(refusedPreview.error).message), unprovenQuiescenceError);
    assert.equal(object(object(refusedPreview.error).details).recovery_action, "manual_review");
    assert.equal(
      object(object(refusedPreview.error).presentation).summary,
      unprovenQuiescenceSummary,
    );
    // Durable identity and presentation key were checked above. Match that
    // recovered task and its current Core summary, not a historical sentence.
    const recoveredSummary = required(required(recovered).failure).presentation.summary;
    assert.ok(recoveredSummary.trim(), "Recovered failure must have a current Core summary");
    const interruptedRows = By.css(`.activity-row.failed[data-activity-id="${activity.id}"]`);
    const findInterruptedRow = async () => {
      const candidates = await browser.findElements(interruptedRows);
      for (const candidate of candidates) {
        const text = await candidate.getText();
        if (
          text.includes("Game-data setup") &&
          text.includes(recoveredSummary) &&
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
      By.xpath('//nav//button[contains(., "Activity")]'),
    );
    const navigationStatus = await browser.wait(
      until.elementLocated(
        By.xpath('//nav//button[contains(., "Activity")]//*[contains(@class,"nav-status")]'),
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
    await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();
    const beforeRestart = await browser.wait(
      findInterruptedRow,
      15_000,
      "Failed preparation must remain discoverable after navigating away and returning",
    );
    assert.ok(beforeRestart);
    const beforeRestartLog = await beforeRestart.findElement(
      By.xpath('.//summary[normalize-space(.)="View preparation log"]'),
    );
    await beforeRestartLog.click();
    const beforeRestartText = await browser.wait(async () => {
      const text = await beforeRestart.getText();
      return text.includes("Only the output saved before the last observation is available.")
        ? text
        : false;
    }, 15_000);
    assert.ok(beforeRestartText);
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
        By.xpath('//nav//button[contains(., "Activity")]//*[contains(@class,"nav-status")]'),
      ),
      10_000,
    );
    assert.equal(
      await restartedNavigationStatus.getAttribute("aria-label"),
      "Activity needs attention",
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();
    const rows = await browser.wait(async () => {
      const candidates = await browser.findElements(interruptedRows);
      const matches = [];
      for (const candidate of candidates) {
        const text = await candidate.getText();
        if (
          text.includes("Game-data setup") &&
          text.includes(recoveredSummary) &&
          text.toLowerCase().includes("failed") &&
          text.includes("Review game preparation")
        ) {
          matches.push(candidate);
        }
      }
      return matches.length === 1 ? matches : false;
    }, 15_000);
    assert.ok(rows);
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
          : current.includes("Both output streams ended. Saved output is shown below.") ||
              current.includes("Only the output saved before the last observation is available.") ||
              current.includes("No retained diagnostic capture")
            ? current
            : false;
      }, 15_000);
      assert.ok(loadedText);
      if (loadedText.includes("Only the output saved before the last observation is available.")) {
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
    await executeBrowserScript(browser, 'arguments[0].scrollIntoView({ block: "start" });', row);
    const review = await browser.wait(
      until.elementLocated(By.css(`[data-recovery-operation="${activity.id}"] > details`)),
      15_000,
    );
    await review.findElement(By.css("summary")).click();
    assert.match(await review.getText(), /Unfinished setup files/);
    assert.ok((await review.getText()).includes(required(privatePath)));
    assert.match(await review.getText(), /this interrupted setup cannot resume/);
    let controls = reviewControls(browser);
    const cleanupReview = await review.findElement(
      By.xpath('.//button[normalize-space(.)="Review unfinished setup files"]'),
    );
    assert.equal((await review.findElements(By.css("button,a"))).length, 1);
    await executeBrowserScript(browser, 'arguments[0].scrollIntoView({ block: "start" });', review);
    const recoveryAccessibility = await observeAccessibility(browser);
    const recoveryReport = path.join(output, "recovery-review-accessibility.json");
    await writeFile(recoveryReport, JSON.stringify(recoveryAccessibility, null, 2), { flag: "wx" });
    artifacts.push(recoveryReport);
    assertNoAccessibilityViolations(recoveryAccessibility);
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
      () =>
        executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0];",
          cleanupReview,
        ),
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
        (
          await browser
            .findElement(cleanupDialog)
            .findElements(By.css('[data-slot="dialog-footer"] button'))
        ).map((button) => button.getText()),
      ),
      ["Keep files", "Review again"],
    );
    await access(required(privatePath));
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
      async () =>
        (await browser.findElement(cleanupDialog).getText()).includes(required(privatePath)),
      15_000,
    );
    const cleanupActionStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(controls.button("Delete setup working files")),
      await browser.findElement(controls.button("Keep files")),
    );
    const cleanupText = await browser.findElement(cleanupDialog).getText();
    for (const expected of [
      "Delete files left by unfinished setup?",
      "Setup working folder to delete",
      privatePath,
      "Original installation preserved",
      "Registered source preserved",
      "Saved data preserved",
      "Backups preserved",
      "Logs preserved",
      "cannot be recovered",
      "setup and any programs it started have stopped",
    ]) {
      assert.ok(cleanupText.includes(required(expected)), expected);
    }
    const cleanupAccessibility = path.join(output, "preparation-cleanup-accessibility.json");
    await captureAccessibilityReport(browser, cleanupAccessibility, artifacts);
    const cleanupImage = path.join(output, "native-preparation-cleanup-review.png");
    await writeFile(cleanupImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(cleanupImage);
    await controls.click(controls.button("Keep files"));
    await access(required(privatePath));

    await clickVisible(browser, cleanupReview);
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(until.elementLocated(controls.button("Delete setup working files")), 15_000);
    await writeFile(
      path.join(required(privatePath), "changed-after-review.bin"),
      "owned stale review",
    );
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(controls.button("Delete setup working files")),
        15_000,
      ),
      { dispatch: "dom" },
    );
    await browser.wait(until.elementLocated(controls.button("Review again")), 15_000);
    await access(required(privatePath));
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
      required(privatePath),
      "preparation-cleanup-before-consent",
    );
    await access(required(privatePath));
    await confirmNative(
      "Confirm retained preparation cleanup",
      "Cancel",
      required(privatePath),
      "preparation-cleanup-cancelled",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await access(required(privatePath));
    browser = await restartApplication("interrupted-preparation-recovery-after-cancel");
    controls = reviewControls(browser);
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();

    const recoveredReviewLocator = By.css(`[data-recovery-operation="${activity.id}"] > details`);
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
      async () =>
        (await browser.findElement(cleanupDialog).getText()).includes(required(privatePath)),
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
      required(privatePath),
      "preparation-cleanup-confirmed",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await assert.rejects(access(required(privatePath)));
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
        insertOwnedRow(journalDatabase, "activity_history", required(journalOnlyActivityRow));
        insertOwnedRow(journalDatabase, "lifecycle_operations", required(journalOnlyOperationRow));
        journalDatabase.exec("COMMIT");
      } finally {
        journalDatabase.close();
      }
      await assert.rejects(access(required(journalOnlyPath)));
      const pendingDoctor = command(["doctor"]);
      assert.equal(
        required(cliActivities().find((item) => item.id === required(journalOnlyId))).status,
        "running",
      );
      assert.ok(
        pendingDoctor.repair.items.some((item) => item.operation_id === required(journalOnlyId)),
      );
    });
    const journalOnlyDoctor = command(["doctor"]);
    const journalOnlyActivity = cliActivities().find((item) => item.id === required(journalOnlyId));
    assert.equal(required(journalOnlyActivity).status, "failed");
    assert.equal(
      required(required(journalOnlyActivity).failure).presentation.presentation_key,
      "preparation_interrupted",
    );
    assert.equal(
      required(required(journalOnlyActivity).failure).presentation.mutation_state,
      "recovery_required",
    );
    const journalOnlyRepair = journalOnlyDoctor.repair.items.find(
      (item) => item.operation_id === required(journalOnlyId),
    );
    assert.equal(required(journalOnlyRepair).kind, "retained_preparation");
    assert.equal(required(journalOnlyRepair).path, required(journalOnlyPath));
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.deepEqual(command(["activity", "log", activity.id]), retained);
    controls = reviewControls(browser);
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();
    const journalOnlyReviewLocator = By.css(
      `[data-recovery-operation="${journalOnlyId}"] > details`,
    );
    await browser.wait(until.elementLocated(journalOnlyReviewLocator), 15_000);
    await browser.wait(
      async () =>
        (
          await browser.findElements(
            By.xpath(
              '//section[@aria-label="Unfinished work and recovery"]//p[@role="status" and starts-with(normalize-space(.), "Refreshing recovery information")]',
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
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center", inline: "nearest" });',
      journalOnlyCleanupReview,
    );
    await clickVisible(browser, journalOnlyCleanupReview);
    await browser.wait(until.elementLocated(cleanupDialog), 15_000);
    await browser.wait(
      async () =>
        (await browser.findElement(cleanupDialog).getText()).includes(required(journalOnlyPath)),
      15_000,
    );
    const journalOnlyText = await browser.findElement(cleanupDialog).getText();
    assert.ok(journalOnlyText.includes("Clear unfinished setup record?"));
    assert.ok(journalOnlyText.includes("Recorded setup path to clear"));
    assert.ok(journalOnlyText.includes("before clearing this record"));
    assert.ok(!journalOnlyText.includes("before deleting these files"));
    assert.ok(journalOnlyText.includes("Cancel"));
    assert.ok(!journalOnlyText.includes("Keep files"));
    assert.match(journalOnlyText, /0 files/);
    assert.match(
      journalOnlyText,
      /No setup working files were found\. Cleanup clears the recorded setup path if it exists and its stale recovery journal/,
    );
    await assert.rejects(access(required(journalOnlyPath)));
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
      required(journalOnlyPath),
      "journal-only-preparation-cleanup-confirmed",
    );
    await browser.wait(
      async () => (await browser.findElements(cleanupDialog)).length === 0,
      15_000,
    );
    await assert.rejects(access(required(journalOnlyPath)));
    assert.equal(
      command(["doctor"]).repair.items.some(
        (item) => item.operation_id === required(journalOnlyId),
      ),
      false,
    );
    assert.deepEqual(command(["status", before.port_id]).active, before.active);
    assert.equal(
      required(cliActivities().find((item) => item.id === required(journalOnlyId))).status,
      "failed",
    );
    const journalOnlyEvidence = path.join(output, "journal-only-preparation-cleanup.json");
    await writeFile(
      journalOnlyEvidence,
      JSON.stringify(
        {
          method:
            "journal-only durable fixture with read-only CLI checks, Desktop startup recovery, and native reviewed cleanup",
          operation_id: required(journalOnlyId),
          absent_private_path: required(journalOnlyPath),
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
          removed_private_path: required(privatePath),
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
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "start", inline: "nearest" });',
      finalInterruptedRow,
    );
  });
  return browser;
}

async function beginLivePreparation({
  browser,
  activities,
  library,
  port,
  message,
}: Pick<RecoveryBase, "browser" | "activities" | "library"> & {
  port: Pick<PortDefinition, "id">;
  message: string;
}) {
  await browser
    .findElement(By.xpath('//button[normalize-space(.)="Review game preparation"]'))
    .click();
  await browser.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="Prepare game data"]')),
    15_000,
  );
  await browser.findElement(By.xpath('//button[normalize-space(.)="Prepare game data"]')).click();
  let activity: ActivityRecord | undefined;
  let checkpoint: string | undefined;
  await browser.wait(
    async () => {
      activity = (await activities()).find(
        (item) =>
          item.operation === "prepare" && item.target_id === port.id && item.status === "running",
      );
      if (!activity) return false;
      checkpoint = path.join(library, "staging", activity.id, "payload/data/out/setup-ready");
      return stat(checkpoint).then(
        (entry) => entry.isFile(),
        () => false,
      );
    },
    15_000,
    message,
  );
  return { activity: required(activity), checkpoint: required(checkpoint) };
}

export async function minimizedPreparationScenario({
  browser,
  invoke: invokeRaw,
  scenario,
  library,
  output,
  artifacts,
  command: commandRaw,
  activities,
  seed,
  open,
  status,
  captureLivePreparation,
}: RecoveryBase &
  LiveFixture &
  Pick<PreparationContext, "captureLivePreparation">): Promise<WebDriver> {
  const invoke = recoveryInvoke(invokeRaw);
  const command = recoveryCommand(commandRaw);
  await scenario("native-minimized-preparation-continuity", async () => {
    assert.equal(process.platform, "win32", "This scenario qualifies Windows only");
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { port } = await seed("opengoal-jak3", "wait");
    const executableHint = required(required(port.setup_executable_hints["windows-x86-64"])[0]);
    const originalExecutable = path.join(output, `owned-${port.id}`, executableHint);
    const gameHint = required(required(port.executable_hints["windows-x86-64"])[0]);
    const originalGame = path.join(output, `owned-${port.id}`, gameHint);
    const source = path.join(output, `${port.id}.iso`);
    const active = required(command(["status", port.id]).active);
    const save = path.join(active.path, "OpenGOAL", "jak3", "save.bin");
    await mkdir(path.dirname(save), { recursive: true });
    await writeFile(save, "owned save must survive minimized preparation", { flag: "wx" });
    const digest = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const before = {
      active,
      source_sha256: await digest(source),
      original_executable_sha256: await digest(originalExecutable),
      active_setup_sha256: await digest(path.join(active.path, executableHint)),
      original_game_sha256: await digest(originalGame),
      active_game_sha256: await digest(path.join(active.path, gameHint)),
      save_sha256: await digest(save),
    };
    const windowState = async () => {
      const native = await invoke("plugin:window|is_minimized", { label: "main" });
      assert.equal(native.ok, true, "Existing native minimized read permission must work");
      assert.equal(typeof native.value, "boolean");
      const renderer = await executeBrowserScript(browser, () => {
        const owned = window as Window & {
          __TAURI_INTERNALS__?: { metadata: { currentWindow: { label: string } } };
        };
        if (!owned.__TAURI_INTERNALS__) throw new Error("Pinned native window metadata is missing");
        return {
          label: owned.__TAURI_INTERNALS__.metadata.currentWindow.label,
          hidden: document.hidden,
          visibility: document.visibilityState,
        };
      });
      assert.equal(renderer.label, "main", "Observe the owned main window");
      return { observed_at: new Date().toISOString(), minimized: native.value, ...renderer };
    };
    await open(port);
    const initialWindow = await windowState();
    assert.equal(initialWindow.minimized, false);
    assert.equal(initialWindow.hidden, false);
    const rect = await browser.manage().window().getRect();
    const contracts = {
      get_bootstrap_status: "desktop_bootstrap_status",
      get_library_identity: "library_identity",
      get_workspace_snapshot: "desktop_workspace_snapshot",
    } as const;
    const read = async <Name extends keyof typeof contracts>(
      name: Name,
      args?: Record<string, unknown>,
    ) => {
      const result = await invoke(name, args);
      assert.equal(result.ok, true, JSON.stringify(result));
      return transportValue(contracts[name], result.value);
    };
    const beforeBootstrap = await read("get_bootstrap_status");
    assert.equal(beforeBootstrap.ready, true);
    assert.equal(path.resolve(required(beforeBootstrap.library_root)), path.resolve(library));
    const beforeGeneration = beforeBootstrap.generation;
    const beforeIdentity = await read("get_library_identity", { generation: beforeGeneration });
    const { activity, checkpoint } = await beginLivePreparation({
      browser,
      activities,
      library,
      port,
      message: "Owned preparation must be running before minimization",
    });
    const preparationExecutable = path.join(
      library,
      "staging",
      activity.id,
      "payload",
      executableHint,
    );
    assert.equal(await digest(preparationExecutable), before.original_executable_sha256);
    const liveProcesses = captureLivePreparation(preparationExecutable);
    const beforeImage = path.join(output, "native-preparation-before-minimize.png");
    await writeFile(beforeImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(beforeImage);
    assert.ok(
      Date.now() - (await stat(checkpoint)).mtimeMs < 25_000,
      "Minimize within the unchanged 30-second owned fixture window",
    );
    await browser.manage().window().minimize();
    let minimizedWindow;
    await browser.wait(
      async () => {
        minimizedWindow = await windowState();
        return (
          minimizedWindow.minimized &&
          minimizedWindow.hidden &&
          minimizedWindow.visibility === "hidden"
        );
      },
      5_000,
      "Actual native minimization and renderer inactivity must agree",
    );
    assert.equal(
      command(["activity"]).records.find((item) => item.id === activity.id)?.status,
      "running",
    );
    assert.deepEqual(command(["status", port.id]).active, before.active);
    let completed: ActivityRecord | undefined;
    // Only public durable reads while minimized; no cancellation, restart,
    // synthetic visibility event or mutation of the journal on the host's behalf.
    await browser.wait(
      () => {
        completed = command(["activity"]).records.find((item) => item.id === activity.id);
        return completed !== undefined && completed.status !== "running";
      },
      40_000,
      "The same owned preparation must finish while minimized",
    );
    assert.equal(required(completed).status, "succeeded");
    const terminalWindow = await windowState();
    assert.equal(terminalWindow.minimized, true);
    assert.equal(terminalWindow.hidden, true);
    const prepared = command(["status", port.id]);
    assert.equal(required(prepared.readiness).launchable, true);
    assert.notEqual(required(prepared.active).id, before.active.id);
    assert.equal(required(prepared.previous).id, before.active.id);
    await browser.manage().window().setRect(rect);
    let restoredWindow;
    await browser.wait(
      async () => {
        restoredWindow = await windowState();
        return (
          !restoredWindow.minimized &&
          !restoredWindow.hidden &&
          restoredWindow.visibility === "visible"
        );
      },
      5_000,
      "Restore the actual native window without simulated visibility",
    );
    await browser.wait(
      until.elementLocated(By.xpath('//button[normalize-space(.)="Play"]')),
      15_000,
    );
    await browser.wait(
      until.elementIsEnabled(
        await browser.findElement(By.xpath('//button[normalize-space(.)="Play"]')),
      ),
      15_000,
    );
    assert.equal(
      (await browser.findElements(By.css('[aria-labelledby="preparation-review-title"]'))).length,
      0,
    );
    const restoredStatus = await status(port.id);
    assert.deepEqual(restoredStatus.active, prepared.active);
    assert.equal(required(restoredStatus.readiness).launchable, true);
    const restoredBootstrap = await read("get_bootstrap_status");
    assert.equal(restoredBootstrap.ready, true);
    assert.equal(path.resolve(required(restoredBootstrap.library_root)), path.resolve(library));
    assert.equal(restoredBootstrap.generation, beforeGeneration);
    assert.deepEqual(restoredBootstrap.selection, beforeBootstrap.selection);
    const restoredGeneration = restoredBootstrap.generation;
    const restoredIdentity = await read("get_library_identity", { generation: restoredGeneration });
    assert.deepEqual(restoredIdentity, beforeIdentity);
    const restoredWorkspace = await read("get_workspace_snapshot", {
      generation: restoredGeneration,
    });
    const workspaceStatus = restoredWorkspace.statuses.find((item) => item.port_id === port.id);
    assert.ok(workspaceStatus, "Generation-bound current library must contain the prepared port");
    assert.deepEqual(workspaceStatus.active, prepared.active);
    assert.equal(required(workspaceStatus.readiness).launchable, true);
    const workspaceActivity = restoredWorkspace.activities.records.find(
      (item) => item.id === activity.id,
    );
    assert.ok(workspaceActivity, "Generation-bound current library must retain the same operation");
    assert.equal(workspaceActivity.operation, "prepare");
    assert.equal(workspaceActivity.target_id, port.id);
    assert.equal(workspaceActivity.status, "succeeded");
    const preparations = command(["activity"]).records.filter(
      (item) => item.operation === "prepare" && item.target_id === port.id,
    );
    assert.equal(preparations.length, 1, "Restoration must not duplicate privileged preparation");
    assert.equal(required(preparations[0]).id, activity.id);
    assert.equal(required(preparations[0]).status, "succeeded");
    assert.equal(await digest(source), before.source_sha256);
    assert.equal(await digest(originalExecutable), before.original_executable_sha256);
    assert.equal(await digest(path.join(active.path, executableHint)), before.active_setup_sha256);
    assert.equal(await digest(originalGame), before.original_game_sha256);
    assert.equal(await digest(path.join(active.path, gameHint)), before.active_game_sha256);
    assert.equal(
      await digest(path.join(required(prepared.active).path, gameHint)),
      before.original_game_sha256,
    );
    assert.equal(await digest(save), before.save_sha256);
    assert.equal(
      await digest(path.join(required(prepared.active).path, "OpenGOAL", "jak3", "save.bin")),
      before.save_sha256,
    );
    const afterImage = path.join(output, "native-preparation-after-restore.png");
    await writeFile(afterImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(afterImage);
    const evidence = path.join(output, "minimized-preparation-continuity.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          method:
            "actual Windows minimize, natural owned preparation completion and native restore",
          operation_id: activity.id,
          before,
          live_processes: liveProcesses,
          initial_window: initialWindow,
          minimized_window: minimizedWindow,
          terminal_window: terminalWindow,
          restored_window: restoredWindow,
          completed_activity: completed,
          prepared_status: prepared,
          restored_status: restoredStatus,
          before_generation: beforeGeneration,
          restored_generation: restoredGeneration,
          before_bootstrap: beforeBootstrap,
          restored_bootstrap: restoredBootstrap,
          before_library_identity: beforeIdentity,
          restored_library_identity: restoredIdentity,
          restored_workspace_status: workspaceStatus,
          restored_workspace_activity: workspaceActivity,
          limits:
            "Owned development fixture; minimize/restore only, not suppressed events, OS shutdown, installed package, minimum OS or other platform proof",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(evidence);
  });
  return browser;
}

async function observeRecoveredPreparation({
  command: commandRaw,
  activities,
  status,
  invoke: invokeRaw,
  port,
  activity,
  ordinaryClose,
  before,
  library,
  privatePath,
  digest,
}: Pick<RecoveryBase, "command" | "activities" | "invoke" | "library"> &
  Pick<LiveFixture, "status"> & {
    port: PortDefinition;
    activity: Pick<ActivityRecord, "id">;
    ordinaryClose: boolean;
    before: { active: InstallRecord; original_game_sha256: string; save_sha256: string };
    privatePath: string;
    digest: (file: string) => Promise<string>;
  }) {
  const command = recoveryCommand(commandRaw);
  const invoke = recoveryInvoke(invokeRaw);
  const recovered = command(["activity"]).records.find((item) => item.id === activity.id);
  const platform = process.platform === "linux" ? "linux-x86-64" : "windows-x86-64";
  assert.ok(recovered, "Fresh startup must retain the exact operation identity");
  if (ordinaryClose) {
    assert.ok(["failed", "cancelled", "succeeded"].includes(required(recovered).status));
    assert.deepEqual(
      (await activities()).find((item) => item.id === activity.id),
      recovered,
      "Native activity must resynchronize to the authoritative retained operation",
    );
  } else {
    assert.equal(required(recovered).status, "failed");
  }
  if (required(recovered).status === "failed") {
    assert.equal(
      required(required(recovered).failure).presentation.presentation_key,
      "preparation_interrupted",
    );
    assert.equal(
      required(required(recovered).failure).presentation.mutation_state,
      "recovery_required",
    );
  }
  const repair = command(["doctor"]).repair.items.find((item) => item.operation_id === activity.id);
  const recoveredStatus = command(["status", port.id]);
  if (required(recovered).status !== "succeeded") {
    assert.equal(required(repair).kind, "retained_preparation");
    assert.equal(
      path.resolve(required(required(repair).path)),
      path.resolve(required(privatePath)),
    );
    assert.deepEqual(recoveredStatus.active, before.active);
  } else {
    assert.equal(repair, undefined);
    assert.equal(required(recoveredStatus.active).id, activity.id);
    assert.equal(required(recoveredStatus.active).port_id, port.id);
    assert.equal(required(recoveredStatus.readiness).launchable, true);
    assert.equal(
      await digest(
        path.join(
          required(recoveredStatus.active).path,
          required(required(port.executable_hints[platform])[0]),
        ),
      ),
      before.original_game_sha256,
    );
    assert.equal(
      await digest(
        path.join(required(recoveredStatus.active).path, "OpenGOAL", "jak3", "save.bin"),
      ),
      before.save_sha256,
    );
  }
  let recoveredWorkspace;
  if (ordinaryClose || process.platform === "linux") {
    const nativeStatus = await status(port.id);
    assert.deepEqual(nativeStatus.active, recoveredStatus.active);
    assert.deepEqual(nativeStatus.readiness, recoveredStatus.readiness);
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    const bootstrapValue = transportValue("desktop_bootstrap_status", bootstrap.value);
    assert.equal(bootstrapValue.ready, true);
    assert.equal(path.resolve(required(bootstrapValue.library_root)), path.resolve(library));
    const workspace = await invoke("get_workspace_snapshot", {
      generation: bootstrapValue.generation,
    });
    assert.equal(workspace.ok, true);
    recoveredWorkspace = transportValue("desktop_workspace_snapshot", workspace.value);
    const workspaceStatus = recoveredWorkspace.statuses.find((item) => item.port_id === port.id);
    assert.ok(workspaceStatus);
    assert.deepEqual(workspaceStatus.active, recoveredStatus.active);
    assert.deepEqual(workspaceStatus.readiness, recoveredStatus.readiness);
    assert.deepEqual(
      recoveredWorkspace.activities.records.find((item) => item.id === activity.id),
      recovered,
    );
  }
  return { recovered, repair, recoveredStatus, recoveredWorkspace };
}

async function previewRecoveredPreparationCleanup({
  invoke: invokeRaw,
  library,
  activity,
  repair,
  ordinaryClose,
}: Pick<RecoveryBase, "invoke" | "library"> & {
  activity: Pick<ActivityRecord, "id">;
  repair: TransportOutputs["doctor"]["repair"]["items"][number] | undefined;
  ordinaryClose: boolean;
}) {
  const invoke = recoveryInvoke(invokeRaw);
  const generation = transportValue(
    "desktop_bootstrap_status",
    (await invoke("get_bootstrap_status")).value,
  ).generation;
  const cleanup = await invoke("preview_preparation_cleanup", {
    operationId: activity.id,
    generation,
  });
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  let operation;
  try {
    operation = database
      .prepare("SELECT phase,preparation_process_quiesced FROM lifecycle_operations WHERE id=?")
      .get(activity.id);
  } finally {
    database.close();
  }
  if (!ordinaryClose || (repair && operation?.preparation_process_quiesced !== 1)) {
    assert.equal(cleanup.ok, false);
    assert.equal(object(cleanup.error).code, "conflict");
    assert.equal(object(object(cleanup.error).details).recovery_action, "manual_review");
    assert.match(text(object(cleanup.error).message), /process quiescence is not proven/);
  } else if (repair) {
    assert.equal(cleanup.ok, true, "Proven quiescence permits review without accepting cleanup");
  }
  return { cleanup, operation };
}

export async function liveInterruptedPreparationScenario(
  context: LiveRecoveryContext,
): Promise<WebDriver> {
  return livePreparationRecoveryScenario(
    process.platform === "linux"
      ? {
          ...context,
          scenarioId: "native-linux-interrupted-preparation",
        }
      : context,
  );
}

export async function closedPreparationScenario(
  context: Omit<LiveRecoveryContext, "interruptApplication"> &
    Pick<PreparationContext, "closeApplication">,
): Promise<WebDriver> {
  return livePreparationRecoveryScenario({
    ...context,
    interruptApplication: context.closeApplication,
    scenarioId: "native-closed-preparation-recovery",
    ordinaryClose: true,
  });
}

async function livePreparationRecoveryScenario({
  browser,
  invoke: invokeRaw,
  scenario,
  library,
  output,
  artifacts,
  command: commandRaw,
  activities,
  seed,
  open,
  status,
  interruptApplication,
  scenarioId = "native-host-interrupted-preparation",
  ordinaryClose = false,
}: LiveRecoveryContext): Promise<WebDriver> {
  const invoke = recoveryInvoke(invokeRaw);
  const command = recoveryCommand(commandRaw);
  await scenario(scenarioId, async () => {
    const linux = scenarioId === "native-linux-interrupted-preparation";
    assert.equal(process.platform, linux ? "linux" : "win32");
    const platform = linux ? "linux-x86-64" : "windows-x86-64";
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { port } = await seed("opengoal-jak3", "wait");
    const original = path.join(output, `owned-${port.id}`);
    const executableHint = required(required(port.setup_executable_hints[platform])[0]);
    const source = path.join(output, `${port.id}.iso`);
    const digest = async (file: string) =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    const originalExecutable = path.join(original, executableHint);
    const active = required(command(["status", port.id]).active);
    const save = path.join(active.path, "OpenGOAL", "jak3", "save.bin");
    await mkdir(path.dirname(save), { recursive: true });
    await writeFile(save, "owned save must survive interrupted preparation", { flag: "wx" });
    const before = {
      active,
      source_sha256: await digest(source),
      original_executable_sha256: await digest(originalExecutable),
      original_game_sha256: await digest(
        path.join(original, required(required(port.executable_hints[platform])[0])),
      ),
      active_setup_sha256: await digest(path.join(active.path, executableHint)),
      active_game_sha256: await digest(
        path.join(active.path, required(required(port.executable_hints[platform])[0])),
      ),
      save_sha256: await digest(save),
    };
    await open(port);
    const { activity, checkpoint } = await beginLivePreparation({
      browser,
      activities,
      library,
      port,
      message: "Owned setup child must be live before host interruption",
    });
    const privatePath = path.join(library, "staging", activity.id);
    const preparationExecutable = path.join(required(privatePath), "payload", executableHint);
    assert.equal(await digest(preparationExecutable), before.original_executable_sha256);
    const suffix = ordinaryClose ? "ordinary-close" : "interruption";
    const beforeImage = path.join(output, `native-live-preparation-before-${suffix}.png`);
    await writeFile(beforeImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(beforeImage);
    browser = await interruptApplication(
      `live-preparation-${suffix}`,
      preparationExecutable,
      async () => {
        assert.equal(
          (await activities()).find((item) => item.id === activity.id)?.status,
          "running",
        );
        assert.deepEqual((await status(port.id)).active, before.active);
        assert.equal(required((await status(port.id)).readiness).launchable, false);
        assert.ok(
          Date.now() - (await stat(checkpoint)).mtimeMs < 25_000,
          "Act before the owned fixture's 30-second completion window",
        );
      },
    );
    // Actual host startup owns recovery. These public CLI observations do not
    // repair SQLite or attest process quiescence on the product's behalf.
    const { recovered, repair, recoveredStatus, recoveredWorkspace } =
      await observeRecoveredPreparation({
        command: commandRaw,
        activities,
        status,
        invoke,
        port,
        activity,
        ordinaryClose,
        before,
        library,
        privatePath,
        digest,
      });
    assert.equal(await digest(source), before.source_sha256);
    assert.equal(await digest(originalExecutable), before.original_executable_sha256);
    assert.equal(await digest(path.join(active.path, executableHint)), before.active_setup_sha256);
    assert.equal(
      await digest(path.join(active.path, required(required(port.executable_hints[platform])[0]))),
      before.active_game_sha256,
    );
    assert.equal(await digest(save), before.save_sha256);
    if (required(recovered).status !== "succeeded") await access(checkpoint);
    const { cleanup, operation } = await previewRecoveredPreparationCleanup({
      invoke,
      library,
      activity,
      repair,
      ordinaryClose,
    });
    await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();
    const row = await browser.wait(
      async () => {
        for (const candidate of await browser.findElements(
          By.css(`.activity-row.${required(recovered).status}`),
        )) {
          const text = await candidate.getText();
          if (
            text.includes(port.name) &&
            (!recovered.failure ||
              text.includes(required(required(recovered).failure).presentation.summary))
          )
            return candidate;
        }
        return false;
      },
      15_000,
      "Fresh host must render the recovered durable activity",
    );
    assert.ok(row);
    if (repair) assert.ok((await row.getText()).includes("Review game preparation"));
    const afterImage = path.join(output, `native-live-preparation-after-${suffix}.png`);
    await writeFile(afterImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(afterImage);
    const evidence = path.join(
      output,
      ordinaryClose ? "closed-preparation-preservation.json" : "live-preparation-preservation.json",
    );
    await writeFile(
      evidence,
      JSON.stringify(
        {
          method: ordinaryClose
            ? "ordinary Windows native host close, distinct owned fixture cleanup, then fresh native startup"
            : linux
              ? "owned private Linux PID namespace init EOF, positive namespace join, then fresh native startup"
              : "actual Windows owned host and preparation-child termination followed by fresh native startup",
          operation_id: activity.id,
          before,
          recovered_activity: recovered,
          recovered_status: recoveredStatus,
          recovered_workspace: recoveredWorkspace,
          retained_private_path: required(privatePath),
          observed_operation: operation,
          cleanup_preview: cleanup,
          cleanup_refusal: cleanup.error,
          limits:
            "Owned development fixtures; no OS shutdown, installed package, other operation family, or other platform qualification",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(evidence);
  });
  return browser;
}
