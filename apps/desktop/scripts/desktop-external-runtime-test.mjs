import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";

const EXTERNAL_FIXTURE_ID = "portcove-external-runtime-fixture";

export function externalFixtureTreeDigest(files) {
  const digest = createHash("sha256").update("portcove-external-tree-v1\n");
  for (const [name, bytes] of [...files].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    assert.match(name, /^[a-z0-9_.-]+$/u);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    digest
      .update(name)
      .update(Buffer.from([0]))
      .update(size);
    digest.update(createHash("sha256").update(bytes).digest());
  }
  return digest.digest("hex");
}

export async function createExternalRuntimeFixture(output) {
  assert.ok(path.isAbsolute(output), "External fixture output must be absolute");
  const outputStat = await lstat(output);
  assert.ok(
    outputStat.isDirectory() && !outputStat.isSymbolicLink(),
    "External fixture needs a regular owned output directory",
  );
  const directory = path.join(output, "player-owned-runtime");
  await mkdir(directory);
  const immutable = new Map([
    ["game.exe", Buffer.from("Inert qualification bytes; never execute.\n")],
    ["unknown-save.bin", Buffer.from("Retained unknown player save.\n")],
  ]);
  for (const [name, bytes] of immutable)
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
  await writeFile(path.join(directory, "general.json"), "{}\n", { flag: "wx" });
  const port = {
    id: EXTERNAL_FIXTURE_ID,
    name: "Portcove External Runtime Fixture",
    summary: "Private inert prepared runtime for non-owning native qualification.",
    project_url: "https://example.invalid/portcove-external-runtime-fixture",
    support_tier: "beta",
    channels: ["stable"],
    platforms: ["windows-x86-64"],
    adapter: "n64-recomp-portable",
    release: {
      provider: "user-prepared",
      user_prepared: {
        "windows-x86-64": {
          version: "1.0.0-fixture",
          archive_name: "inert-fixture.zip",
          archive_size: 1,
          archive_sha256: "a".repeat(64),
          executable: "game.exe",
          immutable_tree_sha256: externalFixtureTreeDigest(immutable),
          mutable_paths: ["general.json"],
        },
      },
    },
    executable_hints: { "windows-x86-64": ["game.exe"] },
    persistent_paths: [],
  };
  const catalogPath = path.join(output, "external-runtime-qualification-catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema_version: 2,
      source_catalog: { evidence: [], identities: [], contracts: [], validators: [] },
      ports: [port],
    }),
    { flag: "wx" },
  );
  const identities = await Promise.all(
    [...immutable.keys(), "general.json"].map((name) => fileIdentity(path.join(directory, name))),
  );
  return { directory, port, catalogPath, identities };
}

export async function externalRuntimePickerObservation({ browser, fixture, observePicker }) {
  await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
  const search = await browser.findElement(By.id("port-search"));
  await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, fixture.port.name);
  const card = By.xpath(
    `//button[contains(@class,"port-card") and starts-with(@aria-label,"${fixture.port.name}.")]`,
  );
  await browser.wait(until.elementLocated(card), 15_000);
  await browser.findElement(card).click();
  const choose = By.xpath('//button[normalize-space(.)="Choose game folder"]');
  await browser.wait(until.elementLocated(choose), 15_000);
  await browser.findElement(choose).click();
  const observation = await observePicker("external-runtime-picker-observation");
  assert.equal(observation.cancelled, true);
  for (const before of fixture.identities) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.sha256, before.sha256);
  }
  assert.equal(await browser.findElement(choose).isEnabled(), true);
  return observation;
}

export async function externalRuntimeReviewScenario(context) {
  const {
    browser,
    fixture,
    pickerObservation,
    selectPicker,
    confirmNative,
    invoke,
    output,
    artifacts,
  } = context;
  const report = {
    scope: "Private inert external runtime; no executable launch or production artifact",
    steps: [],
  };
  const choose = By.xpath('//button[normalize-space(.)="Choose game folder"]');
  const stop = By.xpath('//button[normalize-space(.)="Stop using this installation"]');
  const dialogFor = (kind) =>
    By.css(`[role="dialog"][aria-describedby="external-${kind}-description"]`);
  const buttonFor = (text) => By.xpath(`.//button[normalize-space(.)="${text}"]`);
  async function status() {
    const result = await invoke("get_statuses");
    assert.equal(result.ok, true);
    const value = result.value.find((item) => item.port_id === fixture.port.id);
    assert.ok(value);
    assert.equal(value.active, null);
    return value;
  }
  async function reviewed(kind, action) {
    return browser.wait(
      async () => {
        const matches = await browser.findElements(dialogFor(kind));
        assert.ok(matches.length <= 1, "External review must be unique");
        if (!matches.length || !(await matches[0].isDisplayed())) return false;
        const buttons = await matches[0].findElements(buttonFor(action));
        assert.ok(buttons.length <= 1, "External review action must be unique");
        if (!buttons.length || !(await buttons[0].isDisplayed()) || !(await buttons[0].isEnabled()))
          return false;
        return { dialog: matches[0], action: buttons[0] };
      },
      15_000,
      `The ${kind} review must settle on its exact enabled action`,
    );
  }
  async function closed(kind) {
    await browser.wait(
      async () => (await browser.findElements(dialogFor(kind))).length === 0,
      15_000,
    );
  }
  async function retainFiles(identities = fixture.identities) {
    for (const before of identities) {
      const after = await fileIdentity(before.path);
      assert.equal(after.bytes, before.bytes);
      assert.equal(after.sha256, before.sha256);
    }
  }
  async function selectFolder(name) {
    await browser.findElement(choose).click();
    const selection = await selectPicker(name, fixture.directory);
    assert.equal(selection.selected, true);
    assert.equal(selection.supplied_directory, true);
    assert.equal(selection.cancelled, false);
    const review = await reviewed("register", "Use this installation");
    const text = await review.dialog.getText();
    assert.ok(text.includes(fixture.port.release.user_prepared["windows-x86-64"].version));
    assert.ok(text.includes("game.exe"));
    return review;
  }
  async function screenshot(name) {
    const file = path.join(output, `${name}.png`);
    await writeFile(file, Buffer.from(await browser.takeScreenshot(), "base64"), { flag: "wx" });
    artifacts.push(file);
  }
  const sameDirectory = (value) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase() ===
    path.resolve(fixture.directory).toLowerCase();
  try {
    report.picker_cancel = await pickerObservation;
    assert.equal(report.picker_cancel?.cancelled, true);
    report.before = await status();
    assert.ok(!report.before.external_runtime);
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    report.stale_generation = await invoke("preview_external_runtime", {
      portId: fixture.port.id,
      path: fixture.directory,
      generation: bootstrap.value.generation + 1,
    });
    assert.equal(report.stale_generation.ok, false);
    assert.equal(report.stale_generation.error.code, "conflict");
    let review = await selectFolder("external-runtime-review-dismiss-picker");
    await screenshot("external-runtime-register-review");
    await review.dialog.findElement(buttonFor("Cancel")).click();
    await closed("register");
    assert.ok(!(await status()).external_runtime);
    await retainFiles();
    report.steps.push("review-dismissed-without-registration");
    // Reachable ordinary context transition after dismissal; no forced navigation
    // through a native modal or claim about delayed A-B-A picker responses.
    await browser.findElement(By.css('button[aria-label="Back to previous workspace"]')).click();
    const card = By.xpath(
      `//button[contains(@class,"port-card") and starts-with(@aria-label,"${fixture.port.name}.")]`,
    );
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    assert.equal((await browser.findElements(dialogFor("register"))).length, 0);
    report.steps.push("ordinary-workspace-return-has-no-old-review");
    review = await selectFolder("external-runtime-native-cancel-picker");
    await review.action.click();
    await confirmNative(
      "Confirm external runtime",
      "Cancel",
      fixture.port.id,
      "external-runtime-registration-cancel",
    );
    await closed("register");
    assert.ok(!(await status()).external_runtime);
    await retainFiles();
    report.steps.push("native-registration-consent-cancelled-without-registration");
    review = await selectFolder("external-runtime-register-picker");
    await review.action.click();
    await confirmNative(
      "Confirm external runtime",
      "Register runtime",
      fixture.port.id,
      "external-runtime-registration-accept",
    );
    await closed("register");
    await browser.wait(until.elementLocated(stop), 15_000);
    report.registered = await status();
    const record = report.registered.external_runtime;
    assert.ok(record);
    assert.equal(record.port_id, fixture.port.id);
    assert.equal(sameDirectory(record.path), true);
    assert.equal(path.basename(record.executable), "game.exe");
    assert.equal(sameDirectory(path.dirname(record.executable)), true);
    assert.equal(
      record.immutable_tree_sha256,
      fixture.port.release.user_prepared["windows-x86-64"].immutable_tree_sha256,
    );
    await retainFiles();
    const unknown = path.join(fixture.directory, "new-user-save.dat");
    await writeFile(unknown, "New external save written after registration.\n", { flag: "wx" });
    const protectedFiles = [...fixture.identities, await fileIdentity(unknown)];
    artifacts.push(unknown);
    report.protected_files = protectedFiles;
    await browser.findElement(stop).click();
    review = await reviewed("remove", "Stop using this installation");
    await screenshot("external-runtime-remove-review");
    await review.dialog.findElement(buttonFor("Cancel")).click();
    await closed("remove");
    assert.deepEqual((await status()).external_runtime, record);
    await retainFiles(protectedFiles);
    await browser.findElement(stop).click();
    review = await reviewed("remove", "Stop using this installation");
    await review.action.click();
    await confirmNative(
      "Confirm registration removal",
      "Cancel",
      fixture.port.id,
      "external-runtime-removal-cancel",
    );
    await closed("remove");
    assert.deepEqual((await status()).external_runtime, record);
    await retainFiles(protectedFiles);
    report.steps.push("renderer-and-native-removal-cancellation-retain-registration-and-files");
    await browser.findElement(stop).click();
    review = await reviewed("remove", "Stop using this installation");
    await review.action.click();
    await confirmNative(
      "Confirm registration removal",
      "Remove registration",
      fixture.port.id,
      "external-runtime-removal-accept",
    );
    await closed("remove");
    await browser.wait(until.elementLocated(choose), 15_000);
    report.removed = await status();
    assert.ok(!report.removed.external_runtime);
    await retainFiles(protectedFiles);
    report.steps.push("non-owning-removal-retains-all-original-and-new-unknown-save-files");
    await screenshot("external-runtime-after-removal");
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    const file = path.join(output, "external-runtime-review.json");
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    artifacts.push(file);
  }
}
