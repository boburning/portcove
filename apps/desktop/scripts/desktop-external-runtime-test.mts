import type { WebDriver, By, Key, until } from "selenium-webdriver";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import type { FailureReport, PortStatus } from "../src/transport-types.generated.d.ts";
import type { BoundaryInvoke } from "./desktop-main-webview-boundary.mts";
import type {
  nativeConfirmation,
  nativePickerObservation,
  nativePreparedRuntimePicker,
} from "./desktop-native-confirmation.mts";
type ExternalFixture = Awaited<ReturnType<typeof createExternalRuntimeFixture>>;
interface PickerContext {
  browser: WebDriver;
  fixture: ExternalFixture;
  observePicker: ReturnType<typeof nativePickerObservation>;
  By: typeof By;
  Key: typeof Key;
  until: typeof until;
}
interface ReviewContext {
  browser: WebDriver;
  fixture: ExternalFixture;
  pickerObservation: ReturnType<typeof externalRuntimePickerObservation>;
  selectPicker: ReturnType<typeof nativePreparedRuntimePicker>;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  invoke: BoundaryInvoke;
  output: string;
  artifacts: string[];
  By: typeof By;
  until: typeof until;
}
interface ExternalReport {
  scope: string;
  steps: string[];
  picker_cancel?: unknown;
  before?: PortStatus;
  stale_generation?: unknown;
  rejected_preview?: Pick<FailureReport, "code"> &
    Pick<FailureReport["presentation"], "mutation_state" | "phase">;
  registered?: PortStatus;
  relinked?: PortStatus;
  protected_files?: FileIdentity[];
  removed?: PortStatus;
  error?: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function success(value: unknown) {
  const reply = object(value);
  assert.equal(reply.ok, true);
  return reply.value;
}
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileIdentity } from "../../../scripts/development-evidence.mts";

const EXTERNAL_FIXTURE_ID = "portcove-external-runtime-fixture";

export function externalFixtureTreeDigest(files: ReadonlyMap<string, Buffer>) {
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

export async function createExternalRuntimeFixture(output: string) {
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
  const selectedPort = {
    id: "portcove-external-launch-draft-fixture",
    name: "Portcove External Launch Draft Fixture",
    summary: "Private inert user-selected runtime for native launch review.",
    project_url: port.project_url,
    support_tier: port.support_tier,
    channels: port.channels,
    platforms: port.platforms,
    adapter: "staged-source-portable",
    release: {
      provider: "user-prepared",
      user_prepared: {
        "windows-x86-64": {
          trust: "user-selected",
          version: "user-managed",
          archive_name: "",
          archive_size: 0,
          archive_sha256: "",
          executable: "",
          immutable_tree_sha256: "",
          mutable_paths: [],
        },
      },
    },
  };
  const catalogPath = path.join(output, "external-runtime-qualification-catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema_version: 2,
      source_catalog: { evidence: [], identities: [], contracts: [], validators: [] },
      ports: [port, selectedPort],
    }),
    { flag: "wx" },
  );
  const identities = await Promise.all(
    [...immutable.keys(), "general.json"].map((name: string) =>
      fileIdentity(path.join(directory, name)),
    ),
  );
  return { directory, port, selectedPort, catalogPath, identities };
}

export async function externalRuntimePickerObservation({
  browser,
  fixture,
  observePicker,
  By,
  Key,
  until,
}: PickerContext) {
  const { selectCatalogPort } = await import("./desktop-review-controls.mts");
  await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
  const search = await browser.findElement(By.id("port-search"));
  await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, fixture.port.name);
  await selectCatalogPort(browser, fixture.port.id);
  const choose = By.xpath('//button[normalize-space(.)="Choose game folder"]');
  await browser.wait(until.elementLocated(choose), 15_000);
  await browser.findElement(choose).click();
  const observation = object(await observePicker("external-runtime-picker-observation"));
  assert.equal(observation.cancelled, true);
  for (const before of fixture.identities) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.sha256, before.sha256);
  }
  assert.equal(await browser.findElement(choose).isEnabled(), true);
  return observation;
}

async function verifyExternalLaunchDraft({
  browser,
  fixture,
  confirmNative,
  invoke,
  output,
  artifacts,
  By,
  until,
}: ReviewContext) {
  const { clickVisible, selectCatalogPort, replaceKeyboardText, revealDetailSection } =
    await import("./desktop-review-controls.mts");
  const { transportValues } = await import("./transport-values.mts");
  const port = fixture.selectedPort;
  const executable = path.join(fixture.directory, "game.exe");
  const missingFolder = path.join(output, "missing-owned-start-folder");
  const argumentsText = "--fullscreen\n\nOwned level with spaces";
  const review = By.css('[role="dialog"][aria-describedby="selected-runtime-description"]');
  const directory = By.css('input[aria-label="Start in folder"]');
  const argumentsField = By.xpath('//label[contains(., "Launch options (advanced)")]/textarea');
  const chooseExecutable = By.xpath('//button[normalize-space(.)="Choose game executable…"]');
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const inReview = (label: string) => By.xpath(`.//button[normalize-space(.)="${label}"]`);
  // A missing attribute is never the expected path.
  const samePath = (observed: string | null, expected: string) =>
    observed !== null && path.relative(observed.replace(/^\\\\\?\\/u, ""), expected) === "";
  const click = async (locator: import("selenium-webdriver").Locator) =>
    clickVisible(browser, await browser.wait(until.elementLocated(locator), 30_000));
  const assertUnregistered = async () => {
    const statuses = transportValues("status", success(await invoke("get_statuses")));
    const status = statuses.find((entry) => entry.port_id === port.id);
    assert.ok(status);
    assert.equal(status.active, null);
    assert.ok(!status.external_runtime);
  };
  const findEditor = async () => {
    await revealDetailSection(browser, "Game files");
    await browser.wait(until.elementLocated(chooseExecutable), 30_000);
  };
  const showArguments = async () => {
    const disclosure = await browser.findElement(
      By.xpath('//summary[normalize-space(.)="Advanced launch options"]'),
    );
    if (!(await browser.findElement(argumentsField).isDisplayed()))
      await clickVisible(browser, disclosure);
    return browser.findElement(argumentsField);
  };
  const closeReview = async () => {
    const dialog = await browser.findElement(review);
    await clickVisible(browser, await dialog.findElement(inReview("Cancel")));
    await browser.wait(async () => (await browser.findElements(review)).length === 0, 15_000);
  };
  const openReview = async () => {
    await click(button("Review launch details"));
    return browser.wait(until.elementLocated(review), 30_000);
  };
  const selectTarget = async () => {
    const search = await browser.findElement(By.id("port-search"));
    await replaceKeyboardText(browser, search, port.name);
    await selectCatalogPort(browser, port.id);
    await findEditor();
  };

  await click(By.xpath('//nav//button[contains(., "Discover")]'));
  await selectTarget();
  await assertUnregistered();
  await click(chooseExecutable);
  await confirmNative(
    "Locate game executable",
    "Open",
    "File name:",
    "external-launch-draft-picker",
    executable,
  );
  await browser.wait(
    async () =>
      samePath(
        await (await browser.findElement(directory)).getAttribute("value"),
        fixture.directory,
      ),
    30_000,
    "The exact selected program must set its own start folder",
  );
  await replaceKeyboardText(browser, await browser.findElement(directory), missingFolder);
  await replaceKeyboardText(browser, await showArguments(), argumentsText);
  const refused = await openReview();
  await browser.wait(
    async () => {
      const retry = await refused.findElement(inReview("Check again"));
      return (
        (await retry.isEnabled()) &&
        (await refused.findElements(By.css(".failure-details"))).length === 1 &&
        (await refused.findElements(inReview("Use this installation"))).length === 0
      );
    },
    45_000,
    "A nonexistent start folder must settle as a refused review",
  );
  assert.ok((await refused.getText()).includes("Empty argument"));
  await assertUnregistered();
  await closeReview();

  await click(By.css("[data-detail-back]"));
  await selectTarget();
  const retainedDirectory = await browser.findElement(directory);
  assert.equal(await retainedDirectory.getAttribute("value"), missingFolder);
  const retainedArguments = await showArguments();
  assert.equal(await retainedArguments.getAttribute("value"), argumentsText);
  const retainedProgram = await browser.findElement(
    By.xpath('//p[contains(normalize-space(.),"Game program:")]/code'),
  );
  assert.ok(samePath(await retainedProgram.getText(), executable));
  assert.equal((await browser.findElements(review)).length, 0);

  await replaceKeyboardText(browser, retainedDirectory, fixture.directory);
  const checked = await openReview();
  const use = await browser.wait(
    until.elementLocated(
      By.xpath(
        '//*[@role="dialog" and @aria-describedby="selected-runtime-description"]//button[normalize-space(.)="Use this installation"]',
      ),
    ),
    45_000,
    "The corrected launch target must receive fresh Core review",
  );
  assert.equal(await use.isEnabled(), true);
  const fact = (label: string) =>
    checked.findElement(By.xpath(`.//dt[normalize-space(.)="${label}"]/following-sibling::dd[1]`));
  const reviewedProgram = await fact("Game program");
  const reviewedFolder = await fact("Start in folder");
  assert.equal(await reviewedProgram.isDisplayed(), true);
  assert.equal(await reviewedFolder.isDisplayed(), true);
  assert.ok(samePath(await reviewedProgram.getAttribute("textContent"), executable));
  assert.ok(samePath(await reviewedFolder.getAttribute("textContent"), fixture.directory));
  const reviewedArgs = await (
    await fact("Launch options (advanced)")
  ).findElements(By.xpath("./div"));
  assert.deepEqual(
    await Promise.all(
      reviewedArgs.map((argument) =>
        argument.findElement(By.xpath("./*[last()]")).then((value) => value.getText()),
      ),
    ),
    ["--fullscreen", "Empty argument", "Owned level with spaces"],
  );
  assert.ok(
    (await checked.getText()).includes("Portcove has not authenticated it as an official package."),
  );
  await assertUnregistered();
  await closeReview();

  const receipt = path.join(output, "external-launch-draft-result.json");
  await writeFile(
    receipt,
    JSON.stringify({
      port_id: port.id,
      executable,
      refused_working_directory: missingFolder,
      reviewed_working_directory: fixture.directory,
      retained_arguments: argumentsText.split("\n"),
      fresh_review_required: true,
      registration_created: false,
    }),
    { flag: "wx" },
  );
  artifacts.push(receipt);
}

export async function externalRuntimeReviewScenario(context: ReviewContext) {
  const {
    browser,
    fixture,
    pickerObservation,
    selectPicker,
    confirmNative,
    invoke,
    output,
    artifacts,
    By,
    until,
  } = context;
  const report: ExternalReport = {
    scope: "Private inert external runtime; no executable launch or production artifact",
    steps: [],
  };
  const choose = By.xpath('//button[normalize-space(.)="Choose game folder"]');
  const changeFolder = By.xpath('//button[normalize-space(.)="Change game folder…"]');
  const stop = By.xpath('//button[normalize-space(.)="Stop using this installation"]');
  const dialogFor = (kind: string) =>
    By.css(`[role="dialog"][aria-describedby="external-${kind}-description"]`);
  const buttonFor = (text: string) => By.xpath(`.//button[normalize-space(.)="${text}"]`);
  async function status() {
    const { transportValues } = await import("./transport-values.mts");
    const statuses = transportValues("status", success(await invoke("get_statuses")));
    const value = statuses.find((item) => item.port_id === fixture.port.id);
    assert.ok(value);
    assert.equal(value.active, null);
    return value;
  }
  async function reviewed(kind: string, action: string) {
    const result = await browser.wait(
      async () => {
        const matches = await browser.findElements(dialogFor(kind));
        assert.ok(matches.length <= 1, "External review must be unique");
        const dialog = matches[0];
        if (!dialog || !(await dialog.isDisplayed())) return false;
        const buttons = await dialog.findElements(buttonFor(action));
        assert.ok(buttons.length <= 1, "External review action must be unique");
        const button = buttons[0];
        if (!button || !(await button.isDisplayed()) || !(await button.isEnabled())) return false;
        return { dialog, action: button };
      },
      15_000,
      `The ${kind} review must settle on its exact enabled action`,
    );
    assert.ok(result);
    return result;
  }
  async function closed(kind: string) {
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
  async function pickFolder(name: string, directory: string) {
    const selection = object(await selectPicker(name, directory));
    assert.equal(selection.selected, true);
    assert.equal(selection.supplied_directory, true);
    assert.equal(selection.cancelled, false);
  }
  async function selectFolder(name: string) {
    await browser.findElement(choose).click();
    await pickFolder(name, fixture.directory);
    const review = await reviewed("register", "Use this installation");
    const text = await review.dialog.getText();
    assert.ok(text.includes(fixture.port.release.user_prepared["windows-x86-64"].version));
    assert.ok(text.includes("game.exe"));
    return review;
  }
  async function screenshot(name: string) {
    const file = path.join(output, `${name}.png`);
    await writeFile(file, Buffer.from(await browser.takeScreenshot(), "base64"), { flag: "wx" });
    artifacts.push(file);
  }
  const sameDirectory = (value: string, expected = fixture.directory) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase() ===
    path.resolve(expected).toLowerCase();
  try {
    report.picker_cancel = await pickerObservation;
    assert.equal(object(report.picker_cancel).cancelled, true);
    const { selectCatalogPort } = await import("./desktop-review-controls.mts");
    report.before = await status();
    assert.ok(!report.before.external_runtime);
    const { transportValue } = await import("./transport-values.mts");
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    report.stale_generation = await invoke("preview_external_runtime", {
      portId: fixture.port.id,
      path: fixture.directory,
      generation: bootstrap.generation + 1,
    });
    const stale = object(report.stale_generation);
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    let review = await selectFolder("external-runtime-review-dismiss-picker");
    await screenshot("external-runtime-register-review");
    await review.dialog.findElement(buttonFor("Cancel")).click();
    await closed("register");
    assert.ok(!(await status()).external_runtime);
    await retainFiles();
    report.steps.push("review-dismissed-without-registration");
    // Reachable ordinary context transition after dismissal; no forced navigation
    // through a native modal or claim about delayed A-B-A picker responses.
    await browser.findElement(By.css("button[data-detail-back]")).click();
    await selectCatalogPort(browser, fixture.port.id);
    assert.equal((await browser.findElements(dialogFor("register"))).length, 0);
    report.steps.push("ordinary-workspace-return-has-no-old-review");
    review = await selectFolder("external-runtime-native-cancel-picker");
    const reviewedBeforeNativeCancel = await review.dialog.getText();
    await review.action.click();
    await confirmNative(
      "Use this installation?",
      "Cancel",
      fixture.port.id,
      "external-runtime-registration-cancel",
    );
    // Native consent cancellation preserves the exact reviewed folder for retry.
    review = await reviewed("register", "Use this installation");
    assert.equal(await review.dialog.getText(), reviewedBeforeNativeCancel);
    assert.equal((await review.dialog.findElements(By.css('[role="alert"]'))).length, 0);
    assert.ok(!(await status()).external_runtime);
    await retainFiles();
    report.steps.push("native-registration-consent-cancelled-with-review-and-files-preserved");
    await review.dialog.findElement(buttonFor("Cancel")).click();
    await closed("register");
    // Real Core preview refusal, rather than a supplied error payload. Only this
    // scenario's inert immutable fixture is changed, then restored before reuse.
    const rejectedFile = path.join(fixture.directory, "unknown-save.bin");
    const originalBytes = await readFile(rejectedFile);
    try {
      await writeFile(
        rejectedFile,
        Buffer.concat([originalBytes, Buffer.from("changed review\n")]),
      );
      const rejected = object(
        await invoke("preview_external_runtime", {
          portId: fixture.port.id,
          path: fixture.directory,
          generation: bootstrap.generation,
        }),
      );
      assert.equal(rejected.ok, false);
      const error = transportValue("desktop_desktop_error", rejected.error);
      await browser.findElement(choose).click();
      const selection = object(
        await selectPicker("external-runtime-rejected-review-picker", fixture.directory),
      );
      assert.equal(selection.selected, true);
      const alert = By.css('[aria-describedby="external-register-description"] [role="alert"]');
      await browser.wait(until.elementLocated(alert), 15_000);
      const rendered = await browser.findElement(alert);
      const feedback = await rendered.getText();
      assert.match(feedback, /The files in this folder don’t match the required release/u);
      assert.doesNotMatch(feedback, /couldn't confirm whether anything changed/u);
      await rendered.findElement(By.css("summary")).click();
      const technical = object(JSON.parse(await rendered.findElement(By.css("pre")).getText()));
      assert.equal(technical.code, error.code);
      assert.equal(technical.mutation_state, error.presentation.mutation_state);
      assert.equal(technical.phase, error.presentation.phase);
      assert.equal(technical.message, error.presentation.technical_message);
      assert.deepEqual(technical.context, error.presentation.technical_context);
      report.rejected_preview = {
        code: error.code,
        mutation_state: error.presentation.mutation_state,
        phase: error.presentation.phase,
      };
      await screenshot("external-runtime-structured-preview-failure");
      const dialog = await browser.findElement(dialogFor("register"));
      await dialog.findElement(buttonFor("Cancel")).click();
      await closed("register");
      assert.ok(!(await status()).external_runtime);
    } finally {
      await writeFile(rejectedFile, originalBytes);
    }
    await retainFiles();
    report.steps.push(
      "real-core-preview-refusal-retains-structured-outcome-and-diagnostics-without-registration",
    );
    review = await selectFolder("external-runtime-register-picker");
    await review.action.click();
    await confirmNative(
      "Use this installation?",
      "Add installation",
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
    const replacement = path.join(output, "replacement-player-owned-runtime");
    await mkdir(replacement);
    const replacementFiles = await Promise.all(
      fixture.identities.map(async (original) => {
        const target = path.join(replacement, path.basename(original.path));
        await copyFile(original.path, target);
        return fileIdentity(target);
      }),
    );
    await browser.findElement(changeFolder).click();
    await pickFolder("external-runtime-relink-picker", replacement);
    async function reviewedReplacement() {
      const result = await reviewed("register", "Change folder");
      const paths = await Promise.all(
        (await result.dialog.findElements(By.css("code.path-value"))).map((entry) =>
          entry.getText(),
        ),
      );
      assert.equal(paths.length, 3);
      const [previous, proposed, executable] = paths;
      assert.ok(previous && proposed && executable);
      assert.equal(sameDirectory(previous), true);
      assert.equal(sameDirectory(proposed, replacement), true);
      assert.equal(sameDirectory(path.dirname(executable), replacement), true);
      assert.equal(path.basename(executable), "game.exe");
      return result;
    }
    review = await reviewedReplacement();
    await screenshot("external-runtime-relink-review");
    await review.action.click();
    await confirmNative(
      "Change game folder",
      "Cancel",
      fixture.port.id,
      "external-runtime-relink-cancel",
    );
    review = await reviewedReplacement();
    assert.deepEqual((await status()).external_runtime, record);
    await retainFiles([...fixture.identities, ...replacementFiles]);
    report.steps.push("native-relink-cancellation-retains-the-checked-candidate-and-registration");

    const changedFile = path.join(replacement, "unknown-save.bin");
    const checkedBytes = await readFile(changedFile);
    try {
      await writeFile(changedFile, "Replacement bytes changed after review.\n");
      const changedIdentity = await fileIdentity(changedFile);
      await review.action.click();
      review = await reviewed("register", "Check again");
      assert.equal((await review.dialog.findElements(buttonFor("Change folder"))).length, 0);
      assert.deepEqual((await status()).external_runtime, record);
      await retainFiles([
        ...fixture.identities,
        ...replacementFiles.map((item) => (item.path === changedFile ? changedIdentity : item)),
      ]);
    } finally {
      await writeFile(changedFile, checkedBytes);
    }
    report.steps.push("changed-replacement-requires-a-new-core-check-before-it-can-be-used");
    await review.action.click();
    review = await reviewedReplacement();
    assert.deepEqual((await status()).external_runtime, record);
    await review.action.click();
    await confirmNative(
      "Change game folder",
      "Change folder",
      fixture.port.id,
      "external-runtime-relink-accept",
    );
    await closed("register");
    report.relinked = await status();
    const relinked = report.relinked.external_runtime;
    assert.ok(relinked);
    assert.equal(sameDirectory(relinked.path, replacement), true);
    assert.equal(sameDirectory(path.dirname(relinked.executable), replacement), true);
    assert.equal(path.basename(relinked.executable), "game.exe");
    assert.deepEqual(relinked, {
      ...record,
      path: relinked.path,
      executable: relinked.executable,
    });
    await retainFiles([...fixture.identities, ...replacementFiles]);
    report.steps.push("freshly-checked-replacement-requires-explicit-use-and-exact-core-readback");

    const unknown = path.join(fixture.directory, "new-user-save.dat");
    await writeFile(unknown, "New external save written after registration.\n", { flag: "wx" });
    const protectedFiles = [
      ...fixture.identities,
      ...replacementFiles,
      await fileIdentity(unknown),
    ];
    artifacts.push(unknown);
    report.protected_files = protectedFiles;
    // Independent Core readback above does not settle the renderer after relink.
    const hydratedStop = await browser.wait(
      async () => {
        const [button, duplicate] = await browser.findElements(stop);
        assert.equal(duplicate, undefined, "External removal opener must be unique");
        return button && (await button.isDisplayed()) && (await button.isEnabled())
          ? button
          : false;
      },
      60_000,
      "The relinked installation must expose the visible enabled removal action after readback",
    );
    assert.ok(hydratedStop);
    await hydratedStop.click();
    review = await reviewed("remove", "Stop using this installation");
    await screenshot("external-runtime-remove-review");
    await review.dialog.findElement(buttonFor("Cancel")).click();
    await closed("remove");
    assert.deepEqual((await status()).external_runtime, relinked);
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
    assert.deepEqual((await status()).external_runtime, relinked);
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
    await verifyExternalLaunchDraft(context);
    await retainFiles(protectedFiles);
    report.steps.push("selected-launch-draft-survived-validation-and-return-without-registration");
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    const file = path.join(output, "external-runtime-review.json");
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    artifacts.push(file);
  }
}
