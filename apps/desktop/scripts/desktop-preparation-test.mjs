// Optional owned-fixture scenarios; all state stays under desktop-test's new output directory.
import assert from "node:assert/strict";
import axe from "axe-core";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

export async function preparationScenarios({ browser, invoke, scenario, library, output, artifacts, cli, tool }) {
  const command = args => {
    const result = spawnCommand(cli, ["--library", library, "--json", "--non-interactive", ...args], {
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
  async function seed(portId, mode) {
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
    const source = path.join(output, `${portId}.iso`);
    await writeFile(source, "owned source awaiting upstream validation");
    command(["source", "add", port.source_profile, source]);
    return { port, install };
  }
  const button = label => By.xpath(`//button[normalize-space(.)="${label}"]`);
  async function open(port) {
    await browser.navigate().refresh();
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 15_000);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await browser.wait(until.elementLocated(button("Review game preparation")), 15_000);
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
    await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
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
    await browser.findElement(button("Prepare game data")).click();
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
  await scenario("native-preparation-cancellation", async () => {
    const { port, install } = await seed("opengoal-jak2", "wait");
    await open(port);
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
    await browser.findElement(button("Prepare game data")).click();
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
  });
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
    await browser.findElement(By.css("details.advanced-settings > summary")).click();
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
      await search.clear(); await search.sendKeys(port.name);
      const card = By.xpath(`//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`);
      await browser.wait(until.elementLocated(card), 15_000);
      await browser.findElement(card).click();
      await browser.findElement(By.css("details.advanced-settings > summary")).click();
      return browser.findElement(By.css('section[aria-label="Game release channel"]'));
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

}
