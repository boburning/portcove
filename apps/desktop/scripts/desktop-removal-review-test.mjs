// Removal is confined to real managed versions in the harness's new owned library.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";

export async function removalReviewScenario({ browser, invoke, scenario, library, output, artifacts, command, open }) {
  await scenario("native-reviewed-installed-game-removal", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const port = command(["catalog", "show", "opengoal-jak3"]);
    const original = path.join(output, `owned-${port.id}`);
    const paths = command(["paths", port.id]);
    const save = path.join(paths.user_data_root, "owned-review-save.bin");
    const otherInstall = command(["status", "opengoal-jak1"]).active;
    const sources = command(["source", "list"]);
    const snapshots = command(["backup", "list", port.id]);
    const beforeSave = await readFile(save);
    const beforeSource = await readFile(path.join(output, `${port.id}.iso`));
    const snapshotContents = await Promise.all(snapshots.backups.map(item => readFile(path.join(item.path, "data/owned-review-save.bin"))));
    await open(port);
    const click = async locator => {
      const element = await browser.wait(until.elementLocated(locator), 15_000);
      await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', element);
      await browser.wait(until.elementIsVisible(element), 5_000);
      await browser.wait(until.elementIsEnabled(element), 5_000);
      await element.click();
    };
    const button = label => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const dialog = By.css('[aria-labelledby="removal-review-title"]');
    await click(By.css("summary.advanced-summary"));
    const review = async () => {
      await click(button("Remove managed files"));
      await browser.wait(until.elementLocated(button("Remove these managed folders")), 15_000);
    };
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const initial = await invoke("preview_removal", { portId: port.id, generation });
    assert.equal(initial.ok, true);
    await review();
    for (const affected of initial.value.managed_paths) assert.ok((await browser.findElement(dialog).getText()).includes(affected));
    await click(button("Keep installed files"));
    for (const affected of initial.value.managed_paths) assert.ok((await stat(affected)).isDirectory());
    assert.deepEqual(await readFile(save), beforeSave);
    await review();
    // A real new adoption changes the reviewed inventory; the old review must fail.
    await writeFile(path.join(original, "owned-new-version.bin"), "second reviewed version", { flag: "wx" });
    const added = command(["adopt", original, "--port", port.id, "--yes"]);
    assert.ok(!initial.value.managed_paths.includes(added.path));
    await click(button("Remove these managed folders"));
    await browser.wait(until.elementLocated(button("Review removal again")), 15_000);
    const current = await invoke("preview_removal", { portId: port.id, generation });
    assert.equal(current.ok, true); assert.equal(current.value.managed_paths.length, initial.value.managed_paths.length + 1);
    for (const affected of current.value.managed_paths) assert.ok((await stat(affected)).isDirectory());
    const stale = await invoke("remove_port", { portId: port.id, generation: generation + 1, expectedPreview: current.value.preview_sha256 });
    assert.equal(stale.ok, false); assert.equal(stale.error.code, "conflict");
    await click(button("Review removal again"));
    await browser.wait(until.elementLocated(button("Remove these managed folders")), 15_000);
    const text = await browser.findElement(dialog).getText();
    for (const affected of [...current.value.managed_paths, paths.user_data_root]) assert.ok(text.includes(affected));
    assert.ok(text.includes("settings will also be removed") && text.includes("interrupted deletion may finish"));
    const originalFiles = await readdir(original, { recursive: true, withFileTypes: true });
    const originalHashes = await Promise.all(originalFiles.filter(item => item.isFile()).map(async item => {
      const file = path.join(item.parentPath, item.name);
      return [file, createHash("sha256").update(await readFile(file)).digest("hex")];
    }));
    await browser.executeScript('arguments[0].scrollIntoView({ block: "start" });', await browser.findElement(dialog));
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const accessibilityPath = path.join(output, "removal-review-accessibility.json");
    await writeFile(accessibilityPath, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(accessibilityPath);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    const screenshot = path.join(output, "native-installed-game-removal-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
    await click(button("Remove these managed folders"));
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
    for (const affected of current.value.managed_paths) await assert.rejects(stat(affected), { code: "ENOENT" });
    assert.equal(command(["status", port.id]).active, null);
    assert.deepEqual(await readFile(save), beforeSave);
    assert.deepEqual(command(["backup", "list", port.id]), snapshots);
    for (const [index, item] of snapshots.backups.entries()) assert.deepEqual(await readFile(path.join(item.path, "data/owned-review-save.bin")), snapshotContents[index]);
    assert.deepEqual(command(["source", "list"]), sources);
    assert.deepEqual(await readFile(path.join(output, `${port.id}.iso`)), beforeSource);
    for (const [file, hash] of originalHashes) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash);
    assert.deepEqual(command(["status", "opengoal-jak1"]).active, otherInstall);
    const report = path.join(output, "removal-review-result.json");
    await writeFile(report, JSON.stringify({ port_id: port.id, removed_paths: current.value.managed_paths, saved_data_path: paths.user_data_root, preserved_backup_ids: snapshots.backups.map(item => item.id), preserved_original_files: originalHashes, preserved_other_install: otherInstall.id, dismissal_preserved_files: true, changed_inventory_rejected: true, stale_generation_rejected: true, evidence: "owned fixture removal through native UI and core authorization; no physical interruption or gameplay claim" }, null, 2), { flag: "wx" }); artifacts.push(report);
  });
}
