import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, rename, stat, realpath } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { transportValue } from "./transport-values.mts";
import type { BoundaryInvoke } from "./desktop-main-webview-boundary.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { CapturedNativeProcess } from "./desktop-owned-native-session.mts";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";

interface Context {
  browser: WebDriver;
  output: string;
  library: string;
  artifacts: string[];
  fixture: Awaited<ReturnType<typeof createInstallFixture>>;
  command: FixtureCommand;
  invoke: BoundaryInvoke;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  interruptHost: (
    name: string,
    assertHeld: (application: CapturedNativeProcess) => Promise<void>,
    afterStopped: () => Promise<void>,
    bootstrapRecovery: boolean,
  ) => Promise<WebDriver>;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function success(value: unknown) {
  const reply = object(value);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}
function samePath(left: string, right: string) {
  const ordinary = (value: string) => path.resolve(value.replace(/^\\\\\?\\/u, "")).toLowerCase();
  return ordinary(left) === ordinary(right);
}
function journal(library: string, kind: string, portId: string) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare("SELECT * FROM lifecycle_operations WHERE kind=? AND port_id=? ORDER BY id")
      .all(kind, portId);
  } finally {
    database.close();
  }
}

function heldActivity(library: string, id: unknown) {
  assert.ok(typeof id === "string");
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    const activity = database.prepare("SELECT * FROM activity_history WHERE id=?").get(id);
    assert.ok(activity);
    assert.equal(
      activity.status,
      "running",
      "The actual operation must remain unfinished through forced host loss",
    );
    return activity;
  } finally {
    database.close();
  }
}

export async function hostPublicationScenario(context: Context) {
  const { output, library, artifacts, fixture, command, invoke, confirmNative, interruptHost } =
    context;
  assert.equal(process.platform, "win32");
  assert.equal(path.resolve(library), path.resolve(output, "library"));
  const controlRoot = path.join(output, ".qualification-lifecycle");
  // This directory deliberately stays outside every library and transfer payload.
  await mkdir(controlRoot);
  const controlPath = path.join(controlRoot, "armed.json");
  let browser = context.browser;
  const cases: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    scope:
      "Instrumented Windows app-only forced process loss at actual Core boundaries; no graceful-handler, OS-shutdown, installed or Linux claim",
    cases,
  };
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const capture = async (name: string) => {
    const file = path.join(output, `${name}.png`);
    await writeFile(file, Buffer.from(await browser.takeScreenshot(), "base64"), { flag: "wx" });
    artifacts.push(file);
  };
  async function open(name: string) {
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, name);
    const card = By.xpath(
      `//button[contains(@class,"port-card") and starts-with(@aria-label,"${name}.")]`,
    );
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
  }
  async function arm(checkpoint: string) {
    const nonce = randomUUID();
    const control = {
      format_version: 1,
      nonce,
      library_root: await realpath(library),
      checkpoint,
      expires_unix_ms: Date.now() + 300_000,
    };
    const bytes = JSON.stringify(control);
    await writeFile(controlPath, bytes, { flag: "wx" });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const markerPath = path.join(controlRoot, `entered-${nonce}.json`);
    const result: Record<string, unknown> = { checkpoint, control, control_sha256: sha256 };
    cases.push(result);
    async function held(application?: CapturedNativeProcess) {
      const metadata = await stat(markerPath);
      assert.ok(metadata.isFile() && metadata.size <= 16_384);
      const marker = object(JSON.parse(await readFile(markerPath, "utf8")));
      assert.equal(marker.format_version, 1);
      assert.equal(marker.nonce, nonce);
      assert.equal(marker.checkpoint, checkpoint);
      assert.equal(marker.control_sha256, sha256);
      assert.ok(typeof marker.library_root === "string" && samePath(marker.library_root, library));
      assert.ok(typeof marker.entered_unix_ms === "number" && marker.entered_unix_ms <= Date.now());
      assert.ok(
        typeof marker.deadline_unix_ms === "number" &&
          marker.deadline_unix_ms > Date.now() + 30_000,
      );
      assert.ok(Number.isSafeInteger(marker.process_id) && Number(marker.process_id) > 0);
      if (application) assert.equal(marker.process_id, application.pid);
      result.marker = marker;
      return marker;
    }
    async function wait() {
      await browser.wait(
        async () => {
          try {
            return await held();
          } catch (error) {
            if ((isRecord(error) && error.code === "ENOENT") || error instanceof SyntaxError)
              return false;
            throw error;
          }
        },
        30_000,
        `No actual ${checkpoint} checkpoint entered`,
      );
      artifacts.push(markerPath);
    }
    async function disarm() {
      const archived = path.join(controlRoot, `armed-${nonce}.json`);
      await rename(controlPath, archived);
      artifacts.push(archived);
      assert.equal((await fileIdentity(archived)).sha256, sha256);
      result.disarmed_after_positive_host_exit = true;
    }
    return { result, held, wait, disarm };
  }
  const assertIdentity = async (identity: Awaited<ReturnType<typeof fileIdentity>>) =>
    assert.deepEqual(await fileIdentity(identity.path), identity);
  const archive = await fileIdentity(fixture.artifactPath);
  try {
    for (const [port, checkpoint, phase] of [
      [fixture.port, "install_prepared", "prepared"],
      [fixture.refreshPort, "install_published", "payload_published"],
    ] as const) {
      const paths = transportValue("port_paths", command(["paths", port.id]));
      const save = path.join(paths.user_data_root, "host-interruption-save.bin");
      await mkdir(paths.user_data_root, { recursive: true });
      await writeFile(save, `Existing player data for ${port.id}.`, { flag: "wx" });
      const original = await fileIdentity(save);
      assert.equal(transportValue("status", command(["status", port.id])).active, null);
      const probe = await arm(checkpoint);
      await open(port.name);
      await browser.findElement(button("Review installation")).click();
      const install = By.xpath('//button[starts-with(normalize-space(.),"Install ·")]');
      const action = await browser.wait(until.elementLocated(install), 15_000);
      await browser.wait(until.elementIsEnabled(action), 15_000);
      await action.click();
      await probe.wait();
      const rows = journal(library, "install", port.id);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.phase, phase);
      assert.ok(typeof row.id === "string");
      probe.result.before = row;
      probe.result.activity_before = heldActivity(library, row.id);
      await capture(`${checkpoint}-before-host-loss`);
      browser = await interruptHost(
        checkpoint,
        async (application) => {
          await probe.held(application);
          assert.deepEqual(journal(library, "install", port.id), rows);
          heldActivity(library, row.id);
        },
        async () => {
          await probe.held();
          assert.deepEqual(journal(library, "install", port.id), rows);
          probe.result.activity_after_forced_exit = heldActivity(library, row.id);
          await assertIdentity(original);
          await assertIdentity(archive);
          await probe.disarm();
        },
        false,
      );
      const current = transportValue("status", command(["status", port.id]));
      assert.ok(current.active);
      assert.equal(current.active.id, object(JSON.parse(String(row.install_json))).id);
      assert.equal(
        current.active.artifact.sha256,
        createHash("sha256").update(fixture.artifact).digest("hex"),
      );
      assert.deepEqual(journal(library, "install", port.id), []);
      const activities = transportValue("activity", command(["activity"])).records.filter(
        (entry) => entry.id === row.id,
      );
      assert.equal(activities.length, 1);
      assert.equal(activities[0]?.status, "succeeded");
      await assertIdentity(original);
      await assertIdentity(archive);
      probe.result.recovered = { current, activities };
      await capture(`${checkpoint}-fresh-start-recovered`);
    }

    const port = fixture.port;
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const save = path.join(paths.user_data_root, "host-interruption-save.bin");
    await writeFile(save, "Selected verified snapshot contents.");
    const selectedSave = await fileIdentity(save);
    const selected = transportValue("backup", command(["backup", "create", port.id]));
    await writeFile(save, "Newer data requiring a safety backup before restore.");
    const currentSave = await fileIdentity(save);
    const backupsBefore = transportValue("backup_inventory", command(["backup", "list", port.id]));
    const probe = await arm("restore_prepared");
    await open(port.name);
    const row = await browser.wait(
      until.elementLocated(By.css(`[data-backup-id="${selected.id}"]`)),
      15_000,
    );
    await row.findElement(By.xpath('.//button[normalize-space(.)="Restore"]')).click();
    const restore = await browser.wait(until.elementLocated(button("Restore this backup")), 15_000);
    await browser.wait(until.elementIsEnabled(restore), 15_000);
    await restore.click();
    await confirmNative(
      "Confirm backup restore",
      "Restore backup",
      selected.path,
      "host-loss-restore-consent",
    );
    await probe.wait();
    const restoreRows = journal(library, "restore", port.id);
    assert.equal(restoreRows.length, 1);
    assert.equal(restoreRows[0]?.phase, "prepared");
    probe.result.before = restoreRows;
    probe.result.activity_before = heldActivity(library, restoreRows[0]?.id);
    await capture("restore-prepared-before-host-loss");
    browser = await interruptHost(
      "restore-prepared",
      async (application) => {
        await probe.held(application);
        assert.deepEqual(journal(library, "restore", port.id), restoreRows);
        heldActivity(library, restoreRows[0]?.id);
      },
      async () => {
        await probe.held();
        await assertIdentity(currentSave);
        assert.deepEqual(journal(library, "restore", port.id), restoreRows);
        probe.result.activity_after_forced_exit = heldActivity(library, restoreRows[0]?.id);
        await probe.disarm();
      },
      false,
    );
    assert.equal((await fileIdentity(save)).sha256, selectedSave.sha256);
    assert.deepEqual(journal(library, "restore", port.id), []);
    const backupsAfter = transportValue("backup_inventory", command(["backup", "list", port.id]));
    for (const backup of backupsBefore.backups)
      assert.ok(
        backupsAfter.backups.some(
          (entry) => entry.id === backup.id && entry.sha256 === backup.sha256,
        ),
      );
    const safety = backupsAfter.backups.filter(
      (entry) => !backupsBefore.backups.some((before) => before.id === entry.id),
    );
    assert.equal(safety.length, 1);
    const retainedCurrent = path.join(safety[0]!.path, "data", path.basename(save));
    assert.equal((await fileIdentity(retainedCurrent)).sha256, currentSave.sha256);
    probe.result.recovered = {
      backupsAfter,
      retainedCurrent: await fileIdentity(retainedCurrent),
      restored: await fileIdentity(save),
    };
    await capture("restore-prepared-fresh-start-recovered");

    const destination = path.join(output, "published-move-destination");
    const original = await fileIdentity(save);
    const move = await arm("library_move_published");
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.findElement(button("Move library")).click();
    await browser.wait(until.elementLocated(By.id("library-destination")), 15_000);
    await browser.findElement(By.id("library-destination")).sendKeys(destination);
    await browser.findElement(button("Review move")).click();
    const publish = await browser.wait(until.elementLocated(button("Move to this folder")), 15_000);
    await browser.wait(until.elementIsEnabled(publish), 15_000);
    await capture("library-move-reviewed-before-host-loss");
    await publish.click();
    await move.wait();
    const moveJournalPath = path.join(library, "recovery", "library-move.json");
    const moveJournal = object(JSON.parse(await readFile(moveJournalPath, "utf8")));
    assert.equal(moveJournal.phase, "published");
    assert.ok(typeof moveJournal.transfer_id === "string");
    move.result.before = moveJournal;
    move.result.activity_before = heldActivity(library, moveJournal.transfer_id);
    const readAuthority = async (root: string) =>
      object(JSON.parse(await readFile(path.join(root, ".portcove-authority.json"), "utf8")));
    const sourceAuthority = await readAuthority(library);
    const destinationAuthority = await readAuthority(destination);
    assert.equal(sourceAuthority.state, "moved");
    assert.equal(destinationAuthority.state, "pending");
    assert.equal(sourceAuthority.transfer_id, moveJournal.transfer_id);
    assert.equal(destinationAuthority.transfer_id, moveJournal.transfer_id);
    move.result.authority_before = { sourceAuthority, destinationAuthority };
    browser = await interruptHost(
      "library-move-published",
      async (application) => {
        await move.held(application);
        assert.deepEqual(JSON.parse(await readFile(moveJournalPath, "utf8")), moveJournal);
        assert.deepEqual(await readAuthority(library), sourceAuthority);
        assert.deepEqual(await readAuthority(destination), destinationAuthority);
        heldActivity(library, moveJournal.transfer_id);
      },
      async () => {
        await move.held();
        await assertIdentity(original);
        move.result.activity_after_forced_exit = heldActivity(library, moveJournal.transfer_id);
        await move.disarm();
      },
      true,
    );
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    assert.equal(bootstrap.ready, false);
    await browser.wait(until.elementLocated(button("Resume move")), 15_000);
    assert.equal((await browser.findElements(button("Keep using original library"))).length, 0);
    move.result.fresh_start_gate = bootstrap;
    await capture("library-move-fresh-start-recovery-gate");
    await browser.findElement(button("Resume move")).click();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      30_000,
    );
    const ready = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    assert.equal(ready.ready, true);
    assert.ok(ready.library_root && samePath(ready.library_root, destination));
    await assertIdentity(original);
    const copied = path.join(destination, path.relative(library, save));
    assert.equal((await fileIdentity(copied)).sha256, original.sha256);
    // Repeated recovery is metadata-only after activation, preserving newer saves.
    await writeFile(copied, "New destination save after successful authority handoff.");
    const newer = await fileIdentity(copied);
    const repeated = success(
      await invoke("recover_library_move", { source: library, abort: false }),
    );
    await assertIdentity(newer);
    await assertIdentity(original);
    const sourceRoute = transportValue(
      "library_identity",
      command(["library", "identity"], library),
    );
    const destinationRoute = transportValue(
      "library_identity",
      command(["library", "identity"], destination),
    );
    assert.equal(sourceRoute.id, destinationRoute.id);
    assert.ok(
      samePath(sourceRoute.root, destination) && samePath(destinationRoute.root, destination),
    );
    const redirectedWrite = transportValue(
      "backup",
      command(["backup", "create", port.id], library),
    );
    const relative = path.relative(destination, redirectedWrite.path);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await assertIdentity(newer);
    await assertIdentity(original);
    assert.deepEqual(await readAuthority(library), sourceAuthority);
    move.result.recovered = {
      ready,
      repeated,
      original,
      newer,
      sourceRoute,
      destinationRoute,
      redirectedWrite,
    };
    await capture("library-move-recovered-with-newer-save-preserved");
  } catch (error) {
    report.failure = errorMessage(error);
    throw error;
  } finally {
    const file = path.join(output, "host-publication-recovery.json");
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    artifacts.push(file);
  }
}
