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
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
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
    [...immutable.keys(), "general.json"].map((name: string) =>
      fileIdentity(path.join(directory, name)),
    ),
  );
  return { directory, port, catalogPath, identities };
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
  async function selectFolder(name: string) {
    await browser.findElement(choose).click();
    const selection = object(await selectPicker(name, fixture.directory));
    assert.equal(selection.selected, true);
    assert.equal(selection.supplied_directory, true);
    assert.equal(selection.cancelled, false);
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
  const sameDirectory = (value: string) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase() ===
    path.resolve(fixture.directory).toLowerCase();
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
    await browser.findElement(By.css('button[aria-label="Back to previous workspace"]')).click();
    await selectCatalogPort(browser, fixture.port.id);
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
      assert.ok((await rendered.getText()).includes(error.presentation.summary));
      await rendered.findElement(By.css("summary")).click();
      const technical = object(JSON.parse(await rendered.findElement(By.css("pre")).getText()));
      assert.equal(technical.code, error.code);
      assert.equal(technical.mutation_state, error.presentation.mutation_state);
      assert.equal(technical.phase, error.presentation.phase);
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
