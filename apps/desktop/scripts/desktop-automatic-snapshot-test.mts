import { fixtureObject as object } from "./desktop-scenario-state.mts";
import {
  clickVisible,
  revealDetailSection,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
// Normal-app journey in the harness's owned library: the Settings control, a real
// rollback started from the Versions & updates tab, and the Automatic snapshot it
// leaves in backup history. No game is launched and no real saves are used.
import assert from "node:assert/strict";
import path from "node:path";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { InstallRecord, PortDefinition } from "../src/transport-types.generated.d.ts";
import { transportValue } from "./transport-values.mts";

interface AutomaticSnapshotContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
  seed: (
    portId: string,
    mode: "success",
  ) => Promise<{ port: PortDefinition; install: Pick<InstallRecord, "id"> }>;
  open: (port: PortDefinition, refresh?: boolean) => Promise<unknown>;
}

const backupSectionSelector = '[aria-labelledby="detail-saves-and-storage"]';
const settingText = "Snapshot saved data before each version change";

export async function automaticSnapshotScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  command,
  seed,
  open,
}: AutomaticSnapshotContext) {
  const ipc = async (name: string, args?: Record<string, unknown>) =>
    object(await invoke(name, args));
  const readStatus = (portId: string) => transportValue("status", command(["status", portId]));
  const inventory = (portId: string) =>
    transportValue("backup_inventory", command(["backup", "list", portId]));
  const capture = async (name: string) => {
    const screenshot = path.join(output, `${name}.png`);
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  };
  const generation = async () =>
    transportValue("desktop_bootstrap_status", (await ipc("get_bootstrap_status")).value)
      .generation;
  const coreSetting = async () => {
    const reply = await ipc("get_automatic_snapshots", { generation: await generation() });
    assert.equal(reply.ok, true);
    assert.equal(typeof reply.value, "boolean");
    return reply.value;
  };

  await scenario("native-automatic-snapshots", async () => {
    const { port } = await seed("opengoal-jak3", "success");
    const paths = transportValue("port_paths", command(["paths", port.id]));

    // A second retained version, so the real Restore previous version action is offered.
    const owned = path.join(output, `owned-${port.id}`);
    const second = path.join(output, `owned-${port.id}-second`);
    await cp(owned, second, { recursive: true });
    await writeFile(path.join(second, "owned-second-version"), "second version");
    // Adopted versions are named by the second, so keep the two apart.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    command(["adopt", second, "--port", port.id, "--yes"]);
    const before = readStatus(port.id);
    assert.ok(before.active && before.previous, "two retained versions are required");
    const fromVersion = before.active.version;
    const toVersion = before.previous.version;
    assert.notEqual(fromVersion, toVersion);

    await mkdir(paths.user_data_root, { recursive: true });
    const save = path.join(paths.user_data_root, "owned-snapshot-save.bin");
    await writeFile(save, "progress before the version change");
    const backupsBefore = inventory(port.id).backups;
    assert.equal(
      backupsBefore.filter((item) => item.automatic).length,
      0,
      "no automatic snapshot exists before the version change",
    );

    // Settings > Library: the control shows what Core stores and writes the choice back.
    await selectPrimaryNavigation(browser, "Settings");
    await clickVisible(
      browser,
      await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Library and storage"]')),
        15_000,
      ),
    );
    await browser.wait(
      until.elementLocated(
        By.xpath('//h3[normalize-space(.)="Snapshot saved data before version changes"]'),
      ),
      15_000,
    );
    const label = await browser.wait(
      until.elementLocated(By.xpath(`//label[normalize-space(.)="${settingText}"]`)),
      15_000,
    );
    const controlId = await label.getAttribute("for");
    assert.ok(controlId, "the setting label must name its control");
    const control = await browser.findElement(By.id(controlId));
    const checked = async () => (await control.getAttribute("aria-checked")) === "true";
    const settled = async (expected: boolean, message: string) =>
      browser.wait(
        async () => (await control.isEnabled()) && (await checked()) === expected,
        15_000,
        message,
      );
    await settled(true, "the setting must show Core's default (on) once Core has answered");
    assert.equal(await coreSetting(), true);
    await capture("native-automatic-snapshots-setting-on");
    await clickVisible(browser, label);
    await settled(false, "turning the setting off must reach the control");
    assert.equal(await coreSetting(), false, "Core must store the player's choice");
    await capture("native-automatic-snapshots-setting-off");
    await clickVisible(browser, label);
    await settled(true, "turning the setting back on must reach the control");
    assert.equal(await coreSetting(), true);

    // Version-change explanation, then the real rollback from the Desktop.
    await open(port);
    await revealDetailSection(browser, "Versions & updates");
    const explanation = await browser.wait(
      until.elementLocated(
        By.xpath('//p[contains(normalize-space(.), "first takes an automatic snapshot")]'),
      ),
      15_000,
    );
    const explanationText = await explanation.getText();
    assert.ok(
      explanationText.includes("Unless you turned it off in Settings") ||
        explanationText.includes("Settings"),
      explanationText,
    );
    await capture("native-automatic-snapshots-rollback-explanation");
    await clickVisible(
      browser,
      await browser.findElement(By.xpath('//button[normalize-space(.)="Restore previous version"]')),
    );
    await browser.wait(
      () => readStatus(port.id).active?.version === toVersion,
      60_000,
      "the rollback started in the Desktop did not complete",
    );

    // Core took exactly one labelled snapshot, holding the saves from before the change.
    const automatic = inventory(port.id).backups.filter((item) => item.automatic);
    assert.equal(automatic.length, 1, "one version change, one automatic snapshot");
    const snapshot = automatic[0];
    assert.ok(snapshot?.automatic);
    assert.equal(snapshot.automatic.operation, "rollback");
    assert.equal(snapshot.automatic.from_version, fromVersion);
    assert.equal(snapshot.automatic.to_version, toVersion);
    assert.equal(
      await readFile(path.join(snapshot.path, "data/owned-snapshot-save.bin"), "utf8"),
      "progress before the version change",
    );
    assert.equal(
      await readFile(save, "utf8"),
      "progress before the version change",
      "the rollback keeps current saved data",
    );

    // Backup history labels it Automatic and leaves the player's own snapshots unlabelled.
    await open(port);
    await revealDetailSection(browser, "Saves & backups");
    const row = await browser.wait(
      until.elementLocated(By.css(`${backupSectionSelector} [data-backup-id="${snapshot.id}"]`)),
      15_000,
    );
    const rowText = await row.getText();
    assert.ok(
      rowText.includes(
        `Automatic snapshot before restoring a previous version (${fromVersion} to ${toVersion})`,
      ),
      rowText,
    );
    for (const manual of backupsBefore) {
      const manualRow = await browser.findElement(
        By.css(`${backupSectionSelector} [data-backup-id="${manual.id}"]`),
      );
      assert.ok(!(await manualRow.getText()).includes("Automatic snapshot"), manual.id);
    }
    await capture("native-automatic-snapshots-history");

    const observation = path.join(output, "native-automatic-snapshots-core-inventory.json");
    await writeFile(observation, JSON.stringify(inventory(port.id), null, 2), { flag: "wx" });
    artifacts.push(observation);
  });
}
