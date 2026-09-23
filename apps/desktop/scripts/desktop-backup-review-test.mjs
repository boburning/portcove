// Reviewed backup actions in the desktop-test harness's owned library.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import {
  assertDestructiveReviewAction,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible as clickReviewControl,
} from "./desktop-review-controls.mjs";

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
}) {
  await scenario("native-reviewed-backup-restore-and-delete", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { port, install } = await seed("opengoal-jak3", "success");
    const paths = command(["paths", port.id]);
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const save = path.join(paths.user_data_root, "owned-review-save.bin");
    await mkdir(paths.user_data_root, { recursive: true });
    await writeFile(save, "selected snapshot data");
    const selected = command(["backup", "create", port.id]);
    await writeFile(save, "other snapshot data");
    const other = command(["backup", "create", port.id]);
    await writeFile(save, "current data before review");
    await open(port);
    const clickVisible = (element) => clickReviewControl(browser, element);
    await clickVisible(await browser.findElement(By.css("summary.advanced-summary")));
    const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const row = (id) =>
      browser.wait(until.elementLocated(By.css(`[data-backup-id="${id}"]`)), 15_000);
    const list = () => command(["backup", "list", port.id]).backups;
    const restoreTrigger = async () =>
      (await row(selected.id)).findElement(By.xpath('.//button[normalize-space(.)="Restore"]'));
    const clickRestore = async () => clickVisible(await restoreTrigger());
    const capture = async (name, selector = '[aria-labelledby="backup-review-title"]') => {
      const target = await browser.findElement(By.css(selector));
      await browser.executeScript(
        "arguments[0].scrollIntoView({ block: arguments[1] });",
        target,
        selector === ".backup-inventory-notice" ? "center" : "start",
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
        return browser.executeScript("return document.activeElement === arguments[0];", trigger);
      },
      5_000,
      "Backup restore trigger did not regain focus after Escape",
    );
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    const restoreActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Restore this backup")),
      await browser.findElement(button("Keep current state")),
    );
    const text = await browser
      .findElement(By.css('[aria-labelledby="backup-review-title"]'))
      .getText();
    assert.ok(text.includes(selected.path) && text.includes(paths.user_data_root));
    assert.ok(text.includes("new safety backup") && text.includes("retains recovery data"));
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    await capture("native-backup-restore-review");
    await browser.findElement(button("Keep current state")).click();
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
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    for (const [commandName, action] of [
      ["restore_backup", "restore"],
      ["delete_backup", "delete"],
    ]) {
      const preview = await invoke("preview_backup_action", {
        portId: port.id,
        backupId: selected.id,
        action,
        generation,
      });
      assert.equal(preview.ok, true);
      const rejected = await invoke(commandName, {
        portId: port.id,
        backupId: selected.id,
        expectedPreview: preview.value.preview.preview_sha256,
        generation: generation + 1,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "conflict");
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
      "Restore reviewed backup",
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
      await browser.findElement(button("Keep current state")),
    );
    await capture("native-backup-delete-review");
    await browser.findElement(button("Delete this backup permanently")).click();
    await confirmNative(
      "Confirm backup deletion",
      "__observe__",
      selected.path,
      "backup-native-delete-before-consent",
    );
    assert.equal(list().length, 3);
    await confirmNative(
      "Confirm backup deletion",
      "Delete reviewed backup",
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
    assert.equal(command(["status", port.id]).active.id, install.id);
    await writeFile(path.join(safety.path, "backup.json"), "{invalid owned backup manifest");
    const degraded = command(["backup", "list", port.id]);
    assert.equal(degraded.state, "degraded");
    assert.deepEqual(
      degraded.backups.map((item) => item.id),
      [other.id],
    );
    assert.equal(degraded.problems.length, 1);
    await open(port);
    await clickVisible(await browser.findElement(By.css("summary.advanced-summary")));
    const degradedNotice = await browser.wait(
      until.elementLocated(By.css(".backup-inventory-notice")),
      15_000,
    );
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
    await capture("native-degraded-backup-inventory", ".backup-inventory-notice");

    await writeFile(path.join(other.path, "backup.json"), "{invalid owned backup manifest");
    const unavailable = command(["backup", "list", port.id]);
    assert.equal(unavailable.state, "degraded");
    assert.equal(unavailable.backups.length, 0);
    assert.equal(unavailable.problems.length, 2);
    await open(port);
    await clickVisible(await browser.findElement(By.css("summary.advanced-summary")));
    const emptyNotice = await browser.wait(
      until.elementLocated(By.css(".backup-inventory-notice")),
      15_000,
    );
    const emptyText = await emptyNotice.getText();
    assert.equal(
      await browser.findElement(By.css(".backup-heading small")).getText(),
      "Backups need attention",
    );
    assert.ok(emptyText.includes("No backup is currently available to restore"));
    assert.ok(emptyText.includes(unavailable.problems[0].proposed_action));
    const recoveryActions = await browser.findElements(By.css(".backup-inventory-notice ul li"));
    assert.equal(recoveryActions.length, unavailable.problems.length);
    assert.equal((await browser.findElements(By.css(".backup-row"))).length, 0);
    assert.ok(
      !(await browser.findElement(By.css(".backup-history")).getText()).includes("No backups yet"),
    );
    await capture("native-unusable-backup-inventory", ".backup-inventory-notice");

    const report = path.join(output, "backup-review-result.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          port_id: port.id,
          selected,
          other,
          safety,
          unchanged_install_id: install.id,
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
}
