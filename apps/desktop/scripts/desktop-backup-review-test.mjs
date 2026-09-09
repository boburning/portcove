// Reviewed backup actions in the desktop-test harness's owned library.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";

export async function backupReviewScenario({ browser, invoke, scenario, library, output, artifacts, command, seed, open }) {
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
    const clickVisible = async element => {
      await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', element);
      await browser.wait(until.elementIsVisible(element), 5_000);
      await browser.wait(until.elementIsEnabled(element), 5_000);
      await element.click();
    };
    await clickVisible(await browser.findElement(By.css("summary.advanced-summary")));
    const button = label => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const row = id => browser.findElement(By.css(`[data-backup-id="${id}"]`));
    const list = () => command(["backup", "list", port.id]).backups;
    const clickRestore = async () => clickVisible(await (await row(selected.id)).findElement(By.xpath('.//button[normalize-space(.)="Restore"]')));
    const capture = async name => {
      const dialog = await browser.findElement(By.css('[aria-labelledby="backup-review-title"]'));
      await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', dialog);
      await browser.executeScript(axe.source);
      const result = await browser.executeAsyncScript(done => window.axe.run().then(done));
      const report = path.join(output, `${name}-accessibility.json`);
      await writeFile(report, JSON.stringify(result, null, 2), { flag: "wx" }); artifacts.push(report);
      assert.deepEqual(result.violations.map(item => item.id), []);
      const screenshot = path.join(output, `${name}.png`);
      await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
    };
    await clickRestore();
    await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    const text = await browser.findElement(By.css('[aria-labelledby="backup-review-title"]')).getText();
    assert.ok(text.includes(selected.path) && text.includes(paths.user_data_root));
    assert.ok(text.includes("new safety backup") && text.includes("retains recovery data"));
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    await capture("native-backup-restore-review");
    await browser.findElement(button("Keep current state")).click();
    assert.equal(await readFile(save, "utf8"), "current data before review");
    assert.equal(list().length, 2);
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    for (const [commandName, action] of [["restore_backup", "restore"], ["delete_backup", "delete"]]) {
      const preview = await invoke("preview_backup_action", { portId: port.id, backupId: selected.id, action, generation });
      assert.equal(preview.ok, true);
      const rejected = await invoke(commandName, { portId: port.id, backupId: selected.id, expectedPreview: preview.value.preview.preview_sha256, generation: generation + 1 });
      assert.equal(rejected.ok, false); assert.equal(rejected.error.code, "conflict");
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
    await browser.wait(async () => (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length === 0, 15_000);
    assert.equal(await readFile(save, "utf8"), "selected snapshot data");
    const afterRestore = list();
    assert.equal(afterRestore.length, 3);
    const safety = afterRestore.find(item => item.id !== selected.id && item.id !== other.id);
    assert.ok(safety);
    assert.equal(await readFile(path.join(safety.path, "data/owned-review-save.bin"), "utf8"), "changed after review");
    await clickVisible(await (await row(selected.id)).findElement(By.css('button[aria-label^="Delete backup"]')));
    await browser.wait(until.elementLocated(button("Delete this backup permanently")), 15_000);
    await capture("native-backup-delete-review");
    await browser.findElement(button("Delete this backup permanently")).click();
    await browser.wait(async () => (await browser.findElements(By.css('[aria-labelledby="backup-review-title"]'))).length === 0, 15_000);
    assert.deepEqual(list().map(item => item.id).sort(), [other.id, safety.id].sort());
    assert.equal(await readFile(save, "utf8"), "selected snapshot data");
    assert.equal(await readFile(path.join(other.path, "data/owned-review-save.bin"), "utf8"), "other snapshot data");
    assert.equal(await readFile(path.join(safety.path, "data/owned-review-save.bin"), "utf8"), "changed after review");
    assert.equal(command(["status", port.id]).active.id, install.id);
    const report = path.join(output, "backup-review-result.json");
    await writeFile(report, JSON.stringify({ port_id: port.id, selected, other, safety, unchanged_install_id: install.id, stale_generation_rejected: true, changed_data_rejected: true, evidence: "owned fixture backup lifecycle through native review UI and actual core authorization" }, null, 2), { flag: "wx" }); artifacts.push(report);
  });
}
