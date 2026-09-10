// Optional owned-fixture scenarios; all state stays under desktop-test's new output directory.
import assert from "node:assert/strict";
import axe from "axe-core";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { backupReviewScenario } from "./desktop-backup-review-test.mjs";
import { removalReviewScenario } from "./desktop-removal-review-test.mjs";
import { cliHandoffScenario } from "./desktop-cli-handoff-test.mjs";
import { libraryHandoffScenario } from "./desktop-library-handoff-test.mjs";
import { adoptionReviewScenario } from "./desktop-adoption-review-test.mjs";
import { sourceRemovalScenario } from "./desktop-source-removal-test.mjs";
import { interruptedPreparationScenario } from "./desktop-preparation-recovery-test.mjs";
import { clickVisible } from "./desktop-review-controls.mjs";

export async function preparationScenarios({ browser, invoke, scenario, library, output, artifacts, cli, tool, confirmNative }) {
  const command = (args, selectedLibrary = library) => {
    const result = spawnCommand(cli, ["--library", selectedLibrary, "--json", "--non-interactive", ...args], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, PORTCOVE_PREFERENCES: path.join(output, "preferences.json") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    return response.data;
  };
  const host = process.platform === "win32" ? "windows-x86-64"
    : process.platform === "darwin" ? (process.arch === "arm64" ? "macos-aarch64" : "macos-x86-64") : "linux-x86-64";
  async function seed(portId, mode, chd = false) {
    const port = command(["catalog", "show", portId]);
    const original = path.join(output, `owned-${portId}`);
    await mkdir(original);
    for (const relative of [port.executable_hints[host][0], port.setup_executable_hints[host][0]]) {
      const destination = path.join(original, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(tool, destination);
    }
    await writeFile(path.join(original, "owned-setup-mode"), mode);
    const install = command(["adopt", original, "--port", portId, "--yes"]);
    if (chd) command(["tool", "set-path", "chdman", tool]);
    const source = path.join(output, `${portId}.${chd ? "chd" : "iso"}`);
    await writeFile(source, "owned source awaiting upstream validation");
    command(["source", "add", port.source_profile, source]);
    return { port, install };
  }
  const button = label => By.xpath(`//button[normalize-space(.)="${label}"]`);
  async function open(port, waitForPreparation = true) {
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    if (waitForPreparation) await browser.wait(until.elementLocated(button("Review game preparation")), 15_000);
  }
  async function status(portId) {
    const result = await invoke("get_statuses");
    assert.equal(result.ok, true);
    return result.value.find(item => item.port_id === portId);
  }
  await scenario("native-preparation-review-and-play", async () => {
    const { port, install } = await seed("opengoal-jak1", "success");
    await open(port);
    assert.equal((await status(port.id)).readiness.launchable, false);
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(button("Start new preparation")), 15_000);
    assert.equal((await status(port.id)).active.id, install.id, "review must not prepare");
    const reviewImage = path.join(output, "native-preparation-review.png");
    await writeFile(reviewImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(reviewImage);
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const accessibilityReport = path.join(output, "preparation-accessibility.json");
    await writeFile(accessibilityReport, JSON.stringify(accessibility, null, 2), { flag: "wx" });
    artifacts.push(accessibilityReport);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    await browser.findElement(button("Start new preparation")).click();
    await browser.wait(async () => (await status(port.id)).readiness.launchable, 15_000);
    const prepared = await status(port.id);
    assert.notEqual(prepared.active.id, install.id);
    assert.equal(prepared.previous.id, install.id);
    const log = path.join(prepared.active.path, "data/log/setup.log");
    await writeFile(log, "setup must not run during desktop Play");
    await browser.wait(until.elementLocated(button("Play now")), 15_000);
    await browser.wait(until.elementIsEnabled(await browser.findElement(button("Play now"))), 15_000);
    await browser.findElement(button("Play now")).click();
    await browser.wait(async () => (await status(port.id)).successful_launches > 0, 15_000);
    assert.equal(await readFile(log, "utf8"), "setup must not run during desktop Play");
  });
  await scenario("native-retained-contract-repair-state", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const active = (await status(port.id)).active;
    const manifest = path.join(active.path, ".portcove-manifest.json");
    const original = await readFile(manifest);
    assert.equal(JSON.parse(original).schema_version, 6);
    try {
      await writeFile(manifest, "owned corrupt contract fixture");
      await open(port, false);
      const damaged = await status(port.id);
      assert.equal(damaged.readiness.launchable, false);
      assert.deepEqual(damaged.readiness.blockers, ["invalid_installation"]);
      await browser.wait(until.elementLocated(By.xpath('//*[normalize-space(.)="Installation needs repair"]')), 15_000);
      assert.equal((await browser.findElements(button("Play now"))).length, 0);
      assert.equal((await browser.findElements(button("Choose required source"))).length, 0);
      assert.deepEqual(command(["status", port.id]).readiness, damaged.readiness);
      await browser.executeScript(axe.source);
      const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
      const report = path.join(output, "retained-contract-accessibility.json");
      await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
      assert.deepEqual(accessibility.violations.map(item => item.id), []);
      const screenshot = path.join(output, "native-retained-contract-repair.png");
      await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
    } finally {
      await writeFile(manifest, original);
    }
    await open(port, false);
    assert.equal((await status(port.id)).readiness.launchable, true);
  });

  await scenario("native-preparation-cancellation", async () => {
    const { port, install } = await seed("opengoal-jak2", "wait", true);
    await open(port);
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(button("Start new preparation")), 15_000);
    await browser.findElement(button("Start new preparation")).click();
    let activity;
    await browser.wait(async () => {
      const result = await invoke("get_activities");
      activity = result.value?.find(item => item.operation === "prepare" && item.target_id === port.id && item.status === "running");
      return activity && await stat(path.join(library, "staging", activity.id, "payload/data/out/setup-ready")).then(value => value.isFile(), () => false);
    }, 5_000);
    await browser.findElement(button("Cancel preparation")).click();
    await browser.wait(async () => {
      const result = await invoke("get_activities");
      return result.value?.find(item => item.id === activity.id)?.status === "cancelled";
    }, 5_000);
    assert.equal((await status(port.id)).active.id, install.id);
    assert.equal((await status(port.id)).readiness.launchable, false);
    const recorded = (await invoke("get_activities")).value.find(item => item.id === activity.id);
    assert.equal(recorded.failure.code, "cancelled");
    assert.equal(recorded.failure.presentation.tone, "neutral");
    assert.equal(recorded.failure.presentation.mutation_state, "recovery_required");
    assert.equal(recorded.failure.presentation.phase, "preparation.setup");
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
    assert.deepEqual((await invoke("get_activities")).value.find(item => item.id === activity.id).failure, recorded.failure);
    await browser.findElement(By.xpath('//nav//button[contains(., "Updates")]')).click();
    await browser.wait(until.elementLocated(By.css(".activity-row.cancelled .failure-details")), 15_000);
    const row = await browser.findElement(By.css(".activity-row.cancelled"));
    assert.match(await row.getText(), /Retained work needs recovery review/);
    assert.doesNotMatch(await row.getText(), /No files were changed/);
    await row.findElement(By.css("summary")).click();
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const retained = await invoke("get_activity_diagnostic", { activityId: activity.id, generation });
    assert.equal(retained.ok, true);
    assert.deepEqual(retained.value.map(item => item.phase), ["preparation.extract", "preparation.setup"]);
    assert.equal(retained.value[0].complete, true);
    assert.match(retained.value[0].stdout.text, /owned conversion began/);
    assert.doesNotMatch(JSON.stringify(retained.value), /owned-conversion-secret/);
    assert.equal(retained.value[1].complete, true);
    assert.match(retained.value[1].stdout.text, /owned setup began/);
    assert.match(retained.value[1].stderr.text, /owned setup diagnostic on stderr/);
    assert.doesNotMatch(JSON.stringify(retained.value), /owned-fixture-private-value/);
    assert.deepEqual(command(["activity", "log", activity.id]), retained.value);
    const staleLog = await invoke("get_activity_diagnostic", { activityId: activity.id, generation: generation + 1 });
    assert.equal(staleLog.ok, false); assert.equal(staleLog.error.code, "conflict");
    await row.findElement(By.xpath('.//summary[normalize-space(.)="View preparation log"]')).click();
    await browser.wait(async () => (await row.getText()).includes("owned setup diagnostic on stderr"), 5_000);
    assert.match(await row.getText(), /Preparing source data/);
    assert.match(await row.getText(), /owned conversion began/);
    assert.doesNotMatch(await row.getText(), /owned-fixture-private-value|owned-conversion-secret/);
    const bundle = await invoke("create_support_bundle");
    assert.equal(bundle.ok, true);
    artifacts.push(bundle.value);
    const capture = path.join(output, "retained-preparation-log.json");
    await writeFile(capture, JSON.stringify(retained.value, null, 2), { flag: "wx" }); artifacts.push(capture);

    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "recovery-details-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', row);
    const screenshot = path.join(output, "native-preparation-retained-outcome.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
  });
  await interruptedPreparationScenario({ browser, invoke, scenario, library, output, artifacts, command });
  await scenario("native-update-settings-save-without-execution", async () => {
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const cliBefore = command(["status", port.id]);
    const cliActivities = command(["activity"]);
    const cliSaved = command(["policy", "set", port.id, "stage"]);
    assert.equal(cliSaved.update_policy, "stage");
    for (const key of ["active", "staged", "previous"]) assert.deepEqual(cliSaved[key], cliBefore[key]);
    assert.deepEqual(command(["activity"]), cliActivities);
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await clickVisible(browser, await browser.findElement(By.css("details.advanced-settings > summary")));
    const before = await status(port.id);
    const activities = await invoke("get_activities");
    await browser.findElement(By.xpath('//button[contains(., "Saved update policy")]')).click();
    await browser.findElement(button("Install when running updates")).click();
    assert.equal((await status(port.id)).update_policy, before.update_policy, "editing a choice is not saving");
    await browser.findElement(button("Save update settings")).click();
    await browser.wait(async () => (await status(port.id)).update_policy === "automatic", 15_000);
    const after = await status(port.id);
    assert.deepEqual(after.active, before.active);
    assert.deepEqual(after.staged, before.staged);
    assert.deepEqual(after.previous, before.previous);
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(until.elementLocated(By.xpath('//p[@role="status" and contains(., "Update settings saved. No update was run.")]')), 15_000);
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "update-settings-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', await browser.findElement(By.css('section[aria-label="Game update settings"]')));
    const screenshot = path.join(output, "native-update-settings-saved.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
  });
  await scenario("native-release-channel-selection-and-restart", async () => {
    await browser.findElement(By.css('button[aria-label="Close port details"]')).click();
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const openCatalogPort = async id => {
      const port = command(["catalog", "show", id]);
      const search = await browser.findElement(By.id("port-search"));
      await search.sendKeys(Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"), Key.BACK_SPACE, port.name);
      await browser.wait(async () => await search.getAttribute("value") === port.name, 5_000);
      const card = By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`);
      await browser.wait(until.elementLocated(card), 15_000);
      await browser.findElement(card).click();
      await clickVisible(browser, await browser.findElement(By.css("details.advanced-settings > summary")));
      const channel = await browser.findElement(By.css('section[aria-label="Game release channel"]'));
      await browser.wait(until.elementIsVisible(channel), 5_000);
      return channel;
    };
    const single = await openCatalogPort("ghostship");
    assert.ok((await single.getText()).includes("Stable only"));
    assert.equal((await single.findElements(By.css("button"))).length, 0);
    await browser.findElement(By.css('button[aria-label="Close port details"]')).click();
    command(["channel", "set", "re-blue", "stable"]);
    const multi = await openCatalogPort("re-blue");
    const before = await status("re-blue");
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const stale = await invoke("set_channel", { portId: "re-blue", channel: "rolling", generation: generation + 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
    assert.equal((await status("re-blue")).channel, "stable");
    const staleCheck = await invoke("check_port", { portId: "re-blue", generation: generation + 1 });
    assert.equal(staleCheck.ok, false);
    assert.equal(staleCheck.error.code, "conflict");
    const trigger = await multi.findElement(By.css("button"));
    await trigger.click();
    await browser.findElement(button("Rolling")).click();
    await browser.wait(async () => (await status("re-blue")).channel === "rolling", 15_000);
    await browser.wait(until.elementIsEnabled(trigger), 90_000);
    const after = command(["status", "re-blue"]);
    for (const key of ["active", "staged", "previous"]) assert.deepEqual(after[key], before[key]);
    assert.equal(after.channel, "rolling");
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const restarted = await openCatalogPort("re-blue");
    assert.ok((await restarted.getText()).includes("Rolling"));
    await browser.executeScript('arguments[0].scrollIntoView({ block: "center" });', restarted);
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript(done => window.axe.run().then(done));
    const report = path.join(output, "release-channel-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), { flag: "wx" }); artifacts.push(report);
    assert.deepEqual(accessibility.violations.map(item => item.id), []);
    const screenshot = path.join(output, "native-release-channel-restarted.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" }); artifacts.push(screenshot);
  });

  await backupReviewScenario({ browser, invoke, scenario, library, output, artifacts, command, seed, open, confirmNative });
  await removalReviewScenario({ browser, invoke, scenario, library, output, artifacts, command, open, confirmNative });
  await sourceRemovalScenario({ browser, invoke, scenario, library, output, artifacts, command, confirmNative });
  await adoptionReviewScenario({ browser, invoke, scenario, library, output, artifacts, command, tool, host, confirmNative });
  await libraryHandoffScenario({ browser, invoke, scenario, library, output, artifacts, command });
  await cliHandoffScenario({ browser, invoke, scenario, output, artifacts, cli, command });

}
