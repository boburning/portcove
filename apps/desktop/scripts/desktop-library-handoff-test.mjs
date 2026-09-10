// Copy the harness-owned library, preserve its originals, and observe the new desktop generation.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, realpath } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import { reviewControls } from "./desktop-review-controls.mjs";

export async function libraryHandoffScenario({ browser, invoke, scenario, library, output, artifacts, command }) {
  await scenario("native-library-move-invalidates-prior-reviews", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    // Existing preparation scenarios retain recovery work intentionally. Use a
    // separate owned library, without clearing or bypassing those journals.
    const source = path.join(output, "handoff-library");
    const ownedCommand = args => command(args, source);
    const destination = path.join(output, "moved-library");
    const portId = "zelda64-recomp";
    ownedCommand(["adopt", path.join(output, "owned-adoption-review"), "--port", portId, "--yes"]);
    const paths = ownedCommand(["paths", portId]);
    await writeFile(path.join(paths.user_data_root, "unrelated-save.bin"), "preserved handoff save", { flag: "wx" });
    const backup = ownedCommand(["backup", "create", portId]);
    const profile = command(["catalog", "show", "opengoal-jak1"]).source_profile;
    ownedCommand(["source", "add", profile, path.join(output, "opengoal-jak1.iso")]);
    const selected = await invoke("set_default_library", { path: source });
    assert.equal(selected.ok, true);
    const before = (await invoke("get_bootstrap_status")).value;
    const active = ownedCommand(["status", portId]).active;
    const preserved = await Promise.all([path.join(paths.user_data_root, "general.json"), path.join(paths.user_data_root, "unrelated-save.bin"), path.join(backup.path, "data/general.json")].map(fileIdentity));
    const sources = ownedCommand(["source", "list"]);
    const { click, button } = reviewControls(browser);
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(button("Move library"));
    await browser.findElement(By.id("library-destination")).sendKeys(destination);
    await click(button("Review move"));
    await browser.wait(until.elementLocated(button("Move to this folder")), 15_000);
    const plan = await browser.findElement(By.css('[aria-label="Library move plan"]')).getText();
    assert.ok(plan.includes(destination) && plan.includes(source));
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "library-move-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    const reviewImage = path.join(output, "native-library-move-review.png");
    await writeFile(reviewImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(reviewImage);
    await click(button("Move to this folder"));
    let after;
    await browser.wait(async () => {
      after = (await invoke("get_bootstrap_status")).value;
      return after?.ready && after.generation > before.generation;
    }, 15_000);
    assert.equal(await realpath(after.library_root), await realpath(destination));
    const stale = await invoke("get_output_location", { portId, generation: before.generation });
    assert.equal(stale.ok, false); assert.equal(stale.error.code, "conflict");
    const current = await invoke("get_output_location", { portId, generation: after.generation });
    assert.equal(current.ok, true);
    assert.equal(await realpath(current.value.library_root), await realpath(destination));
    const statuses = await invoke("get_statuses"); assert.equal(statuses.ok, true);
    const moved = statuses.value.find(item => item.port_id === portId).active;
    assert.equal(moved.id, active.id);
    assert.equal(await realpath(moved.path), await realpath(path.join(destination, "versions", portId, path.basename(active.path))));
    const copied = [];
    for (const original of preserved) {
      assert.deepEqual(await fileIdentity(original.path), original);
      const copy = await fileIdentity(path.join(destination, path.relative(paths.library_root, original.path)));
      assert.equal(copy.sha256, original.sha256); copied.push(copy);
    }
    assert.deepEqual((await invoke("get_sources")).value, sources);
    const result = path.join(output, "library-handoff-result.json");
    await writeFile(result, JSON.stringify({ before, after, preserved_originals: preserved, copied, preserved_active_identity: active.id, stale_generation_rejected: true, evidence: "native owned-library copy and frontend handoff; no physical interruption claim" }, null, 2), { flag: "wx" }); artifacts.push(result);
  });
}
