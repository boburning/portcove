import { fixtureObject as object } from "./desktop-scenario-state.mts";
import { executeBrowserScript } from "./browser-script.mts";
import type { WebDriver } from "selenium-webdriver";
import type {
  BackupRecord,
  InstallRecord,
  PortDefinition,
} from "../src/transport-types.generated.d.ts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { transportValue } from "./transport-values.mts";
interface BackupReviewContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
  seed: (
    portId: string,
    mode: "success",
  ) => Promise<{ port: PortDefinition; install: Pick<InstallRecord, "id"> }>;
  open: (port: PortDefinition, refresh?: boolean) => Promise<unknown>;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
function text(value: unknown) {
  assert.ok(typeof value === "string");
  return value;
}
async function consentText(file: string) {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  return text(object(value).text);
}
// Reviewed backup actions in the desktop-test harness's owned library.
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import {
  revealDetailSection,
  assertDestructiveReviewAction,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible as clickReviewControl,
  openCatalogPortAfterRefresh,
} from "./desktop-review-controls.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";

const backupSectionSelector = '[aria-labelledby="detail-saves-and-storage"]';
import {
  degradedInventorySelector,
  waitForDegradedInventory,
} from "./desktop-backup-inventory-observer.mts";

export async function backupReviewScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  seed,
  open,
  confirmNative,
}: BackupReviewContext) {
  const ipc = async (name: string, args?: Record<string, unknown>) =>
    object(await invoke(name, args));
  const readStatus = (portId: string) => transportValue("status", command(["status", portId]));
  const inventory = (portId: string) =>
    transportValue("backup_inventory", command(["backup", "list", portId]));
  await scenario("native-reviewed-backup-restore-and-delete", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { port, install } = await seed("opengoal-jak3", "success");
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const save = path.join(paths.user_data_root, "owned-review-save.bin");
    await mkdir(paths.user_data_root, { recursive: true });
    await writeFile(save, "selected snapshot data");
    const selected = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(save, "other snapshot data");
    const other = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(save, "current data before review");
    await open(port);
    await revealDetailSection(browser, "Saves & backups");
    const clickVisible = (element: Parameters<typeof clickReviewControl>[1]) =>
      clickReviewControl(browser, element);
    const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const row = (id: string) =>
      browser.wait(
        until.elementLocated(By.css(`${backupSectionSelector} [data-backup-id="${id}"]`)),
        15_000,
      );
    const list = () => inventory(port.id).backups;
    const degradedInventory = (problemCount: number) =>
      waitForDegradedInventory(
        {
          readNotices: () => browser.findElements(By.css(degradedInventorySelector)),
          readProblems: (notice) => notice.findElements(By.css("ul li")),
          wait: (probe, timeout, message) => browser.wait(probe, timeout, message),
        },
        problemCount,
      );
    const restoreTrigger = async () =>
      (await row(selected.id)).findElement(By.xpath('.//button[normalize-space(.)="Restore"]'));
    const clickRestore = async () => clickVisible(await restoreTrigger());
    const capture = async (name: string, selector = '[aria-labelledby="backup-review-title"]') => {
      const target = await browser.findElement(By.css(selector));
      await executeBrowserScript(
        browser,
        "arguments[0].scrollIntoView({ block: arguments[1] });",
        target,
        selector === degradedInventorySelector ? "center" : "start",
      );
      const report = path.join(output, `${name}-accessibility.json`);
      await captureAccessibilityReport(browser, report, artifacts);
      const screenshot = path.join(output, `${name}.png`);
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    };
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () =>
        (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length ===
        0,
      5_000,
      "Backup review did not close after Escape",
    );
    await browser.wait(
      async () => {
        const trigger = await restoreTrigger();
        return executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0];",
          trigger,
        );
      },
      5_000,
      "Backup restore trigger did not regain focus after Escape",
    );
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    const restoreActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Restore this backup")),
      await browser.findElement(button("Cancel")),
    );
    const text = await browser
      .findElement(By.css('[aria-labelledby="backup-review-title"]'))
      .getText();
    assert.ok(text.includes(selected.path) && text.includes(paths.user_data_root));
    assert.ok(
      text.includes("Portcove will back up the current saved data before replacing it") &&
        text.includes("retains recovery data"),
    );
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    await capture("native-backup-restore-review");
    await browser.findElement(button("Cancel")).click();
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    await browser.findElement(button("Restore this backup")).click();
    await confirmNative(
      "Confirm backup restore",
      "__observe__",
      selected.path,
      "backup-native-restore-before-consent",
    );
    const restoreConsent = await consentText(
      path.join(output, "backup-native-restore-before-consent.json"),
    );
    for (const expected of [
      new Date(selected.created_at * 1000).toISOString().slice(0, 10),
      port.name,
      port.id,
      paths.user_data_root,
      "This will replace the current saved data",
      "Portcove will back up the current saved data before replacing it",
    ])
      assert.ok(restoreConsent.includes(expected), expected);
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    await confirmNative(
      "Confirm backup restore",
      "Cancel",
      selected.path,
      "backup-native-restore-cancelled",
    );
    await browser.wait(
      async () =>
        (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length ===
        0,
      15_000,
    );
    assert.equal(await readFile(save, "utf8"), "current data before review");
    const generation = transportValue(
      "desktop_bootstrap_status",
      (await ipc("get_bootstrap_status")).value,
    ).generation;
    for (const [commandName, action] of [
      ["restore_backup", "restore"],
      ["delete_backup", "delete"],
    ] as const) {
      const preview = await ipc("preview_backup_action", {
        portId: port.id,
        backupId: selected.id,
        action,
        generation,
      });
      assert.equal(preview.ok, true);
      const rejected = await ipc(commandName, {
        portId: port.id,
        backupId: selected.id,
        expectedPreview: transportValue("desktop_backup_review", preview.value).preview
          .preview_sha256,
        generation: generation + 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(object(rejected.error).code, "conflict");
    }
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    await writeFile(save, "changed after review");
    await browser.findElement(button("Restore this backup")).click();
    await browser.wait(until.elementLocated(button("Review again")), 15_000);
    assert.equal(await readFile(save, "utf8"), "changed after review");
    assert.equal(list().length, 2);
    await browser.findElement(button("Review again")).click();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    await browser.findElement(button("Restore this backup")).click();
    await confirmNative(
      "Confirm backup restore",
      "Restore backup",
      selected.path,
      "backup-native-restore-confirmed",
    );
    await browser.wait(
      async () =>
        (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length ===
        0,
      15_000,
    );
    assert.equal(await readFile(save, "utf8"), "selected snapshot data");
    const afterRestore = list();
    assert.equal(afterRestore.length, 3);
    const safety = afterRestore.find((item) => item.id !== selected.id && item.id !== other.id);
    assert.ok(safety);
    assert.equal(
      await readFile(path.join(safety.path, "data/owned-review-save.bin"), "utf8"),
      "changed after review",
    );
    await clickVisible(
      await (await row(selected.id)).findElement(By.css('button[aria-label^="Delete backup"]')),
    );
    await browser.wait(until.elementLocated(button("Delete this backup permanently")), 15_000);
    const deleteActionStyles = await assertDestructiveReviewAction(
      browser,
      await browser.findElement(button("Delete this backup permanently")),
      await browser.findElement(button("Cancel")),
    );
    await capture("native-backup-delete-review");
    await browser.findElement(button("Delete this backup permanently")).click();
    await confirmNative(
      "Confirm backup deletion",
      "__observe__",
      selected.path,
      "backup-native-delete-before-consent",
    );
    const deleteConsent = await consentText(
      path.join(output, "backup-native-delete-before-consent.json"),
    );
    for (const expected of [
      new Date(selected.created_at * 1000).toISOString().slice(0, 10),
      port.name,
      port.id,
      paths.user_data_root,
      "This cannot be undone",
      "Current saved data and other backups remain",
    ])
      assert.ok(deleteConsent.includes(expected), expected);
    assert.equal(list().length, 3);
    await confirmNative(
      "Confirm backup deletion",
      "Delete backup permanently",
      selected.path,
      "backup-native-delete-confirmed",
    );
    await browser.wait(
      async () =>
        (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length ===
        0,
      15_000,
    );
    assert.deepEqual(
      list()
        .map((item) => item.id)
        .sort(),
      [other.id, safety.id].sort(),
    );
    assert.equal(await readFile(save, "utf8"), "selected snapshot data");
    assert.equal(
      await readFile(path.join(other.path, "data/owned-review-save.bin"), "utf8"),
      "other snapshot data",
    );
    assert.equal(
      await readFile(path.join(safety.path, "data/owned-review-save.bin"), "utf8"),
      "changed after review",
    );
    assert.equal(readStatus(port.id).active?.id, install.id);
    await writeFile(path.join(safety.path, "backup.json"), "{invalid owned backup manifest");
    const degraded = inventory(port.id);
    assert.equal(degraded.state, "degraded");
    assert.deepEqual(
      degraded.backups.map((item) => item.id),
      [other.id],
    );
    assert.equal(degraded.problems.length, 1);
    assert.ok(degraded.problems[0]);
    await open(port);
    await revealDetailSection(browser, "Saves & backups");
    const degradedNotice = await degradedInventory(degraded.problems.length);
    assert.ok(degradedNotice);
    assert.ok((await degradedNotice.getText()).includes("What to do next"));
    assert.ok((await degradedNotice.getText()).includes(degraded.problems[0].proposed_action));
    const usableRow = await row(other.id);
    assert.equal(
      await usableRow.findElement(By.xpath('.//button[normalize-space(.)="Restore"]')).isEnabled(),
      true,
    );
    assert.equal(
      await usableRow.findElement(By.css('button[aria-label^="Delete backup"]')).isEnabled(),
      true,
    );
    await capture("native-degraded-backup-inventory", degradedInventorySelector);

    await writeFile(path.join(other.path, "backup.json"), "{invalid owned backup manifest");
    const unavailable = inventory(port.id);
    assert.equal(unavailable.state, "degraded");
    assert.equal(unavailable.backups.length, 0);
    assert.equal(unavailable.problems.length, 2);
    await open(port);
    await revealDetailSection(browser, "Saves & backups");
    const emptyNotice = await degradedInventory(unavailable.problems.length);
    assert.ok(emptyNotice);
    assert.ok(unavailable.problems[0]);
    const emptyText = await emptyNotice.getText();
    assert.equal(
      await browser.findElement(By.css(".backup-heading small")).getText(),
      "Backups need attention",
    );
    assert.ok(emptyText.includes("No backup is currently available to restore"));
    assert.ok(emptyText.includes(unavailable.problems[0].proposed_action));
    const recoveryActions = await emptyNotice.findElements(By.css("ul li"));
    assert.equal(recoveryActions.length, unavailable.problems.length);
    assert.equal((await browser.findElements(By.css(".backup-row"))).length, 0);
    assert.ok(
      !(await browser.findElement(By.css(".backup-history")).getText()).includes("No backups yet"),
    );
    await capture("native-unusable-backup-inventory", degradedInventorySelector);

    assert.deepEqual(unavailable.create_assessment, {
      action: "backup_create",
      availability: "allowed",
      reason: "available",
    });
    const preservedSave = await fileIdentity(save);
    const damagedManifests = await Promise.all(
      [other, safety].map((backup) => fileIdentity(path.join(backup.path, "backup.json"))),
    );
    // Controlled CLI fixture setup; this does not qualify native uninstall.
    command(["remove", port.id, "--yes"]);
    assert.equal(readStatus(port.id).active, null);
    const retainedAssessment = inventory(port.id).create_assessment;
    assert.deepEqual(retainedAssessment, unavailable.create_assessment);
    await openCatalogPortAfterRefresh(browser, port, port.name);
    const create = await browser.wait(
      until.elementLocated(
        By.css(`${backupSectionSelector} button[aria-describedby="backup-create-explanation"]`),
      ),
      15_000,
    );
    await browser.wait(
      async () => create.isEnabled(),
      15_000,
      "Fresh Core assessment must enable backup of retained owned data",
    );
    await capture("native-retained-data-backup-create", "#backup-create-explanation");
    await clickVisible(create);
    await browser.wait(
      async () => list().length === 1,
      15_000,
      "Native creation must publish an actual new usable backup",
    );
    const createdFromRetainedData = list()[0];
    assert.ok(createdFromRetainedData);
    assert.equal(
      await readFile(path.join(createdFromRetainedData.path, "data/owned-review-save.bin"), "utf8"),
      "selected snapshot data",
    );
    assert.equal(readStatus(port.id).active, null);
    assert.equal((await fileIdentity(save)).sha256, preservedSave.sha256);
    for (const identity of damagedManifests) {
      assert.equal((await fileIdentity(identity.path)).sha256, identity.sha256);
    }
    const createdInventory = inventory(port.id);
    assert.equal(createdInventory.problems.length, 2);
    assert.equal(createdInventory.state, "degraded");
    const createdRow = await row(createdFromRetainedData.id);
    assert.equal(
      await createdRow.findElement(By.xpath('.//button[normalize-space(.)="Restore"]')).isEnabled(),
      true,
    );
    await capture("native-retained-data-backup-created", ".backup-history");

    // Controlled retained-record fixture in this harness's private library.
    // Do not launch CLI after insertion: its startup recovery could mutate it.
    const operationId = randomUUID();
    const recoveryRoot = path.join(library, "recovery", operationId);
    const stagedSave = path.join(recoveryRoot, "staged-data/owned-review-save.bin");
    await mkdir(path.dirname(stagedSave), { recursive: true });
    await writeFile(stagedSave, await readFile(save), { flag: "wx" });
    const databasePath = path.join(library, "portcove.sqlite3");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout=1000");
      const now = Math.floor(Date.now() / 1000);
      const inserted = database
        .prepare(
          "INSERT INTO lifecycle_operations (id,kind,port_id,phase,staging_path,final_path,quarantine_path,activate,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          operationId,
          "restore",
          port.id,
          "prepared",
          recoveryRoot,
          paths.user_data_root,
          path.join(recoveryRoot, "previous-data"),
          1,
          now,
          now,
        );
      assert.equal(inserted.changes, 1);
    } finally {
      database.close();
    }
    const readJournal = () => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return database.prepare("SELECT * FROM lifecycle_operations WHERE id=?").get(operationId);
      } finally {
        database.close();
      }
    };
    const journalBefore = readJournal();
    const heldFiles = await Promise.all(
      [save, stagedSave, path.join(createdFromRetainedData.path, "data/owned-review-save.bin")].map(
        (file) => fileIdentity(file),
      ),
    );
    const heldInventory = await ipc("get_backups", { portId: port.id });
    assert.equal(heldInventory.ok, true);
    const heldBackupInventory = transportValue("backup_inventory", heldInventory.value);
    assert.deepEqual(heldBackupInventory.restore_assessment, {
      action: "backup_restore",
      availability: "held",
      reason: "recovery_required",
    });
    assert.equal(heldBackupInventory.state, "degraded");
    const currentGeneration = transportValue(
      "desktop_bootstrap_status",
      (await ipc("get_bootstrap_status")).value,
    ).generation;
    const rejectedPreview = await ipc("preview_backup_action", {
      portId: port.id,
      backupId: createdFromRetainedData.id,
      action: "restore",
      generation: currentGeneration,
    });
    assert.equal(rejectedPreview.ok, false);
    assert.equal(object(rejectedPreview.error).code, "conflict");
    const deletePreview = await ipc("preview_backup_action", {
      portId: port.id,
      backupId: createdFromRetainedData.id,
      action: "delete",
      generation: currentGeneration,
    });
    assert.equal(deletePreview.ok, true);
    // WebView refresh keeps the same native host; its service adapter is read-only.
    await openCatalogPortAfterRefresh(browser, port, port.name);
    await browser.wait(
      async () => {
        const history = await browser.findElements(
          By.css('.backup-history[data-backup-read-state="current"]'),
        );
        return (
          history.length === 1 &&
          history[0] !== undefined &&
          (await history[0].getText()).includes("Restoring requires recovery to finish")
        );
      },
      15_000,
      "Fresh native Restore assessment must expose its recovery hold",
    );
    const heldRow = await row(createdFromRetainedData.id);
    assert.equal(
      await heldRow.findElement(By.css('button[data-backup-action="restore"]')).isEnabled(),
      false,
    );
    assert.equal(
      await heldRow.findElement(By.css('button[data-backup-action="delete"]')).isEnabled(),
      true,
    );
    await capture("native-restore-assessment-recovery-held", ".backup-history");
    assert.deepEqual(readJournal(), journalBefore);
    for (const identity of heldFiles) assert.deepEqual(await fileIdentity(identity.path), identity);
    const restoreAssessmentEvidence = {
      setup: "private retained Prepared-record fixture; not an observed interruption",
      operationId,
      journalBefore,
      journalAfter: readJournal(),
      heldFiles,
      assessment: heldBackupInventory.restore_assessment,
      restore_preview_refused_before_consent: true,
      delete_preview_available: true,
      native_restore_disabled_delete_enabled: true,
      retained_fixture_preserved: true,
    };

    const report = path.join(output, "backup-review-result.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          port_id: port.id,
          selected,
          other,
          safety,
          restore_assessment: restoreAssessmentEvidence,
          review_install_id: install.id,
          retained_data_creation: {
            assessment: retainedAssessment,
            created: createdFromRetainedData,
            preservedSave,
            damagedManifests,
            installed: false,
            degraded_history_preserved: true,
          },
          stale_generation_rejected: true,
          changed_data_rejected: true,
          escape_dismissal_and_focus_restoration: true,
          action_styles: {
            restore: restoreActionStyles,
            delete: deleteActionStyles,
          },
          degraded_inventory: {
            valid_backup_remains_actionable: other.id,
            empty_inventory_problem_count: unavailable.problems.length,
            next_actions_visible: true,
          },
          evidence:
            "owned fixture backup lifecycle through native review UI and actual core authorization",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  });
  await scenario("native-backup-delete-focus", async () => {
    assert.equal(process.platform, "win32", "This consent observation requires Windows");
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { port, install } = await seed("opengoal-jak3", "success");
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const save = path.join(paths.user_data_root, "owned-focus-save.bin");
    await mkdir(paths.user_data_root, { recursive: true });
    await writeFile(save, "first owned focus snapshot");
    const first = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(save, "second owned focus snapshot");
    const second = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(save, "current owned focus data");
    const immutable = await Promise.all(
      [save, path.join(second.path, "data/owned-focus-save.bin")].map((file) => fileIdentity(file)),
    );
    assert.ok(immutable[0]);
    const list = () => inventory(port.id).backups;
    const row = (id: string) => By.css(`[data-backup-id="${id}"]`);
    const review = By.css('[aria-labelledby="backup-review-title"]');
    const action = By.xpath('//button[normalize-space(.)="Delete this backup permanently"]');
    const focused = () =>
      executeBrowserScript(browser, () => {
        const element = document.activeElement;
        return {
          tag: element?.tagName,
          text: element?.textContent?.trim(),
          label: element?.getAttribute("aria-label"),
          backup: element?.closest("[data-backup-id]")?.getAttribute("data-backup-id"),
          connected: element?.isConnected,
        };
      });
    const screenshot = async (name: string) => {
      // Read settled state only; never repair focus or scroll after the mutation.
      await browser.wait(
        () =>
          executeBrowserScript(browser, () => {
            const target =
              document.querySelector('[aria-labelledby="backup-review-title"]') ??
              document.activeElement?.closest(".detail-group");
            return (
              target &&
              !target
                .getAnimations({ subtree: true })
                .some(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getTiming().iterations !== Infinity,
                )
            );
          }),
        5_000,
        "The changed review/focus surface must settle before capture",
      );
      const state = await focused();
      const frame = path.join(output, `${name}-frame.json`);
      await writeFile(
        frame,
        JSON.stringify(
          {
            focus: state,
            outer: await browser.manage().window().getRect(),
            viewport: await executeBrowserScript(browser, () => ({
              width: innerWidth,
              height: innerHeight,
              scale: devicePixelRatio,
            })),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(frame);
      const report = path.join(output, `${name}-accessibility.json`);
      await captureAccessibilityReport(browser, report, artifacts);
      const image = path.join(output, `${name}.png`);
      await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(image);
      assert.deepEqual(await focused(), state, "Evidence capture must not change natural focus");
    };
    const deleteReviewed = async (backup: BackupRecord, name: string) => {
      await browser.wait(until.elementLocated(row(backup.id)), 15_000);
      await (
        await browser.findElement(row(backup.id))
      )
        .findElement(By.css('button[aria-label^="Delete backup"]'))
        .click();
      await browser.wait(until.elementLocated(action), 15_000);
      await screenshot(`${name}-review`);
      const before = list()
        .map((item) => item.id)
        .sort();
      const beforeFiles = await Promise.all(
        [save, path.join(backup.path, "data/owned-focus-save.bin")].map((file) =>
          fileIdentity(file),
        ),
      );
      const beforeReport = path.join(output, `${name}-before-files.json`);
      const beforeCopies = await Promise.all(
        beforeFiles.map(async (identity) => ({
          ...identity,
          base64: (await readFile(identity.path)).toString("base64"),
        })),
      );
      await writeFile(
        beforeReport,
        JSON.stringify({ inventory: before, backup, files: beforeCopies }, null, 2),
        { flag: "wx" },
      );
      artifacts.push(beforeReport);
      await browser.findElement(action).click();
      const observed = await confirmNative(
        "Confirm backup deletion",
        "__observe__",
        backup.path,
        `${name}-before-consent`,
        undefined,
        undefined,
        true,
      );
      for (const expected of [port.name, port.id, paths.user_data_root, "This cannot be undone"])
        assert.ok(text(object(observed).text).includes(expected), expected);
      assert.deepEqual(
        list()
          .map((item) => item.id)
          .sort(),
        before,
      );
      for (const identity of beforeFiles)
        assert.equal((await fileIdentity(identity.path)).sha256, identity.sha256);
      await confirmNative(
        "Confirm backup deletion",
        "Delete backup permanently",
        backup.path,
        `${name}-consented`,
      );
      await browser.wait(async () => (await browser.findElements(review)).length === 0, 15_000);
      assert.deepEqual(
        list()
          .map((item) => item.id)
          .sort(),
        before.filter((id) => id !== backup.id),
      );
      await browser.wait(
        async () => (await browser.findElements(row(backup.id))).length === 0,
        15_000,
      );
    };
    await open(port, false);
    await revealDetailSection(browser, "Saves & backups");
    await deleteReviewed(first, "backup-focus-remaining");
    await browser.wait(
      async () => {
        const state = await focused();
        return (
          state.connected && state.backup === second.id && state.label?.startsWith("Delete backup")
        );
      },
      15_000,
      "Successful deletion must focus the remaining matching action naturally",
    );
    const remainingFocus = await focused();
    await screenshot("backup-focus-remaining-success");
    assert.equal(readStatus(port.id).active?.id, install.id);
    for (const identity of immutable)
      assert.equal((await fileIdentity(identity.path)).sha256, identity.sha256);

    // Supported core fixture setup, not a native uninstall acceptance claim.
    command(["remove", port.id, "--yes"]);
    assert.equal(readStatus(port.id).active, null);
    assert.deepEqual(
      list().map((item) => item.id),
      [second.id],
    );
    await openCatalogPortAfterRefresh(browser, port, port.name);
    await deleteReviewed(second, "backup-focus-final");
    await browser.wait(
      async () => {
        const state = await focused();
        return state.connected && state.tag === "H2" && state.text === "Saves and storage";
      },
      15_000,
      "History disappearance must focus the stable parent heading naturally",
    );
    assert.equal((await browser.findElements(By.css(".backup-history"))).length, 0);
    assert.deepEqual(list(), []);
    assert.equal(readStatus(port.id).active, null);
    assert.equal((await fileIdentity(save)).sha256, immutable[0].sha256);
    const finalFocus = await focused();
    await screenshot("backup-focus-final-success");
    const report = path.join(output, "backup-focus-results.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          port: port.id,
          first,
          second,
          immutable,
          remainingFocus,
          finalFocus,
          setup:
            "supported CLI adoption/removal of owned fixtures; not native uninstall acceptance",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
