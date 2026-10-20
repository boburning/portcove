import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { Locator } from "selenium-webdriver";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { transportValue, transportValues } from "./transport-values.mts";
interface HandoffContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  library: string;
  command: FixtureCommand;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
function success(value: unknown) {
  const result = object(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
import { executeBrowserScript } from "./browser-script.mts";
// Copy the harness-owned library, preserve its originals, and observe the new desktop generation.
import assert from "node:assert/strict";
import path from "node:path";
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mts";

export async function libraryHandoffScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}: HandoffContext) {
  const bootstrap = async () =>
    transportValue("desktop_bootstrap_status", success(await invoke("get_bootstrap_status")));
  await scenario("native-library-move-invalidates-prior-reviews", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    // Existing preparation scenarios retain recovery work intentionally. Use a
    // separate owned library, without clearing or bypassing those journals.
    const source = path.join(output, "handoff-library");
    const ownedCommand = (args: readonly string[]) => command(args, source);
    const destination = path.join(output, "moved-library");
    const portId = "zelda64-recomp";
    ownedCommand(["adopt", path.join(output, "owned-adoption-review"), "--port", portId, "--yes"]);
    const paths = transportValue("port_paths", ownedCommand(["paths", portId]));
    await writeFile(
      path.join(paths.user_data_root, "unrelated-save.bin"),
      "preserved handoff save",
      { flag: "wx" },
    );
    const backup = transportValue("backup", ownedCommand(["backup", "create", portId]));
    const profile = required(
      transportValue("port", command(["catalog", "show", "opengoal-jak1"])).source_profile,
    );
    ownedCommand(["source", "add", profile, path.join(output, "opengoal-jak1.iso")]);
    const selected = object(await invoke("set_default_library", { path: source }));
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const before = await bootstrap();
    const identityBefore = transportValue(
      "library_identity",
      success(
        await invoke("get_library_identity", {
          generation: before.generation,
        }),
      ),
    );
    assert.deepEqual(identityBefore, ownedCommand(["library", "identity"]));
    const active = required(transportValue("status", ownedCommand(["status", portId])).active);
    const preserved = await Promise.all(
      [
        path.join(paths.user_data_root, "general.json"),
        path.join(paths.user_data_root, "unrelated-save.bin"),
        path.join(backup.path, "data/general.json"),
      ].map((file) => fileIdentity(file)),
    );
    const sources = transportValues("source", ownedCommand(["source", "list"]));
    const { click, button } = reviewControls(browser);
    const assertEscapeRestoresFocus = async (trigger: Locator, dialog: Locator, name: string) => {
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(dialog)).length === 0,
        5_000,
        `${name} Dialog did not close after Escape`,
      );
      await browser.wait(
        async () => {
          const candidate = await browser.findElement(trigger);
          return await executeBrowserScript(
            browser,
            "return document.activeElement === arguments[0];",
            candidate,
          );
        },
        5_000,
        `${name} trigger did not regain focus after Escape`,
      );
    };
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(button("Library and storage"));
    await click(By.xpath('//summary[normalize-space(.)="Prepare a recovery copy"]'));
    const guide = await browser.findElement(By.css(".library-recovery")).getText();
    assert.ok(guide.includes("A manual copy is unverified"));
    assert.ok(guide.includes("retroachievements.credentials"));
    for (const root of ["versions", "user", "source-inbox", "backups", "toolchains", "artwork"])
      assert.ok(guide.includes(root));
    const guideImage = path.join(output, "native-library-recovery-guide.png");
    await writeFile(guideImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(guideImage);
    const moveTrigger = button("Move library");
    const moveDialog = By.css('[aria-labelledby="move-library-title"]');
    await click(moveTrigger);
    await browser.wait(until.elementLocated(moveDialog), 15_000);
    await assertEscapeRestoresFocus(moveTrigger, moveDialog, "library move");
    await click(moveTrigger);
    await browser.findElement(By.id("library-destination")).sendKeys(destination);
    await click(button("Review move"));
    await browser.wait(until.elementLocated(button("Move to this folder")), 15_000);
    const moveActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Move to this folder")),
      await browser.findElement(button("Close")),
    );
    const plan = await browser.findElement(By.css('[aria-label="Library move plan"]')).getText();
    assert.ok(plan.includes(destination) && plan.includes(source));
    assert.ok(plan.includes(portId) && plan.includes(active.version));
    assert.ok(plan.includes("Saved game-file locations"));
    assert.ok(plan.includes("1 saved file location will stay unchanged."));
    assert.ok(
      plan.includes(
        "Copying Portcove game-file folder contents does not redirect these saved locations.",
      ),
    );
    assert.ok(plan.includes("this dialog cannot cancel it"));
    await click(
      By.xpath(
        '//section[@aria-label="Library move plan"]//summary[starts-with(normalize-space(.), "Saved data")]',
      ),
    );
    const files = await browser.wait(
      until.elementLocated(By.css('[aria-label="Files in user"]')),
      5_000,
    );
    assert.ok((await files.getText()).includes("unrelated-save.bin"));
    await assertCompactReview(browser, '[role="dialog"]');
    const report = path.join(output, "library-move-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const reviewImage = path.join(output, "native-library-move-review.png");
    await writeFile(reviewImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(reviewImage);
    await click(button("Move to this folder"));
    const after = await browser.wait(async () => {
      const observed = await bootstrap();
      const expected = await realpath(destination).catch(() => undefined);
      const actual = observed.library_root
        ? await realpath(observed.library_root).catch(() => undefined)
        : undefined;
      return observed.ready &&
        observed.generation > before.generation &&
        expected !== undefined &&
        actual === expected
        ? observed
        : false;
    }, 15_000);
    assert.ok(after);
    assert.equal(await realpath(required(after.library_root)), await realpath(destination));
    const identityAfter = transportValue(
      "library_identity",
      success(
        await invoke("get_library_identity", {
          generation: after.generation,
        }),
      ),
    );
    assert.equal(identityAfter.id, identityBefore.id);
    assert.equal(await realpath(identityAfter.root), await realpath(destination));
    assert.deepEqual(identityAfter, ownedCommand(["library", "identity"]));
    assert.deepEqual(identityAfter, command(["library", "identity"], destination));
    const staleIdentity = object(
      await invoke("get_library_identity", {
        generation: before.generation,
      }),
    );
    assert.equal(staleIdentity.ok, false);
    assert.equal(object(staleIdentity.error).code, "conflict");
    const stale = object(
      await invoke("get_output_location", {
        portId,
        generation: before.generation,
      }),
    );
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    const current = transportValue(
      "port_output_location",
      success(
        await invoke("get_output_location", {
          portId,
          generation: after.generation,
        }),
      ),
    );
    assert.equal(await realpath(current.library_root), await realpath(destination));
    const statuses = transportValues("status", success(await invoke("get_statuses")));
    const moved = required(required(statuses.find((item) => item.port_id === portId)).active);
    assert.equal(moved.id, active.id);
    assert.equal(
      await realpath(moved.path),
      await realpath(path.join(destination, "versions", portId, path.basename(active.path))),
    );
    const copied = [];
    for (const original of preserved) {
      assert.deepEqual(await fileIdentity(original.path), original);
      const copy = await fileIdentity(
        path.join(destination, path.relative(paths.library_root, original.path)),
      );
      assert.equal(copy.sha256, original.sha256);
      copied.push(copy);
    }
    assert.deepEqual(transportValues("source", success(await invoke("get_sources"))), sources);

    const metadata = path.join(output, "library-restore-export.json");
    command(["library", "export", "--output", metadata], destination);
    const exportedMetadata = await fileIdentity(metadata);
    const exportedSave = await fileIdentity(
      path.join(destination, path.relative(paths.library_root, required(preserved[0]).path)),
    );
    const restoreRoot = path.join(output, "restored-library");
    await mkdir(restoreRoot);
    const restoreSelection = object(await invoke("set_default_library", { path: restoreRoot }));
    assert.equal(restoreSelection.ok, true, JSON.stringify(restoreSelection));
    // The owned source has no open game, and switching releases its desktop
    // handles. Simulate the documented manual content copy without inventing
    // a production copy API or copying an open database.
    const contentCopy = path.join(output, "manual-recovery-content");
    await mkdir(contentCopy);
    for (const root of ["versions", "user", "source-inbox", "backups", "toolchains", "artwork"]) {
      const sourceRoot = path.join(destination, root);
      const exists = await access(sourceRoot).then(
        () => true,
        () => false,
      );
      if (exists)
        await cp(sourceRoot, path.join(contentCopy, root), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
    }
    const originalSource = path.join(output, "opengoal-jak1.iso");
    const offlineOriginal = path.join(output, "disconnected-original.iso");
    const originalSourceIdentity = await fileIdentity(originalSource);
    await rename(originalSource, offlineOriginal);
    assert.equal((await fileIdentity(offlineOriginal)).sha256, originalSourceIdentity.sha256);
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(button("Library and storage"));
    const restoreTrigger = button("Restore from a library copy");
    const restoreDialog = By.css('[aria-labelledby="import-library-title"]');
    await click(restoreTrigger);
    await browser.wait(until.elementLocated(restoreDialog), 15_000);
    await assertEscapeRestoresFocus(restoreTrigger, restoreDialog, "library restore");
    await click(restoreTrigger);
    await browser.findElement(By.id("import-metadata")).sendKeys(metadata);
    const missingContent = path.join(output, "missing-recovery-content");
    await browser.findElement(By.id("import-content")).sendKeys(missingContent);
    await click(button("Review restore"));
    await browser.wait(until.elementLocated(By.css('[role="dialog"] [role="alert"]')), 15_000);
    assert.equal((await browser.findElements(button("Restore this library"))).length, 0);
    // An existing empty root is reviewable; review is not payload verification.
    // Core's separate missing-payload execution refusal is retained in the
    // qualification receipt. Do not execute an incomplete copy in this UI root.
    await mkdir(missingContent);
    await click(button("Review restore"));
    await browser.wait(until.elementLocated(button("Restore this library")), 15_000);
    const emptyContentImage = path.join(output, "native-empty-content-review.png");
    await writeFile(emptyContentImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(emptyContentImage);
    await browser.findElement(By.id("import-content")).clear();
    await browser.findElement(By.id("import-content")).sendKeys(contentCopy);
    await click(button("Review restore"));
    await browser.wait(until.elementLocated(button("Restore this library")), 15_000);
    const restoreActionStyles = await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Restore this library")),
      await browser.findElement(button("Close")),
    );
    const restoreReview = await browser
      .findElement(By.css('[aria-label="Library restore plan"]'))
      .getText();
    assert.ok(restoreReview.includes(contentCopy) && restoreReview.includes(restoreRoot));
    assert.ok(restoreReview.includes("Saved game-file locations"));
    await assertCompactReview(browser, '[role="dialog"]');
    const restoreAccessibility = path.join(output, "library-restore-accessibility.json");
    await captureAccessibilityReport(browser, restoreAccessibility, artifacts);
    const restoreImage = path.join(output, "native-library-restore-review.png");
    await writeFile(restoreImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(restoreImage);
    const beforeRestore = await bootstrap();
    await click(button("Restore this library"));
    await confirmNative(
      "Confirm library restore",
      "__observe__",
      "Only restore a Portcove export you trust.",
      "library-native-restore-before-consent",
    );
    assert.deepEqual(await fileIdentity(metadata), exportedMetadata);
    assert.deepEqual(await fileIdentity(exportedSave.path), exportedSave);

    await confirmNative(
      "Confirm library restore",
      "Restore library",
      "Only restore a Portcove export you trust.",
      "library-native-restore-confirmed",
    );
    const afterRestore = await browser.wait(async () => {
      const observed = await bootstrap();
      const expected = await realpath(restoreRoot).catch(() => undefined);
      const actual = observed.library_root
        ? await realpath(observed.library_root).catch(() => undefined)
        : undefined;
      return observed.ready &&
        observed.generation > beforeRestore.generation &&
        expected !== undefined &&
        actual === expected
        ? observed
        : false;
    }, 15_000);
    assert.ok(afterRestore);
    assert.equal(await realpath(required(afterRestore.library_root)), await realpath(restoreRoot));
    assert.equal(
      required(transportValue("status", command(["status", portId], restoreRoot)).active).id,
      active.id,
    );
    assert.deepEqual(await fileIdentity(metadata), exportedMetadata);
    assert.deepEqual(await fileIdentity(exportedSave.path), exportedSave);

    const restoredSave = await fileIdentity(
      path.join(restoreRoot, path.relative(destination, exportedSave.path)),
    );
    assert.equal(restoredSave.sha256, exportedSave.sha256);
    const backupSource = required(preserved[2]);
    const restoredBackup = await fileIdentity(
      path.join(restoreRoot, path.relative(paths.library_root, backupSource.path)),
    );
    assert.equal(restoredBackup.sha256, backupSource.sha256);
    assert.ok(
      transportValue(
        "backup_inventory",
        command(["backup", "list", portId], restoreRoot),
      ).backups.some((item) => item.id === backup.id),
    );
    // Restore retained the disconnected original reference, rather than
    // silently adopting the copied managed content as another original.
    assert.deepEqual(transportValues("source", success(await invoke("get_sources"))), sources);
    assert.equal(
      await access(originalSource).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal((await fileIdentity(offlineOriginal)).sha256, originalSourceIdentity.sha256);
    await rename(offlineOriginal, originalSource);

    // After review, wait for core's pending authority marker before changing an
    // owned save. This deterministically exercises the actual pre-activation
    // recovery surface without manufacturing a journal or production state.
    const recoveryDestination = path.join(output, "retained-recovery-copy");
    const recoverySave = path.join(
      restoreRoot,
      path.relative(paths.library_root, required(preserved[0]).path),
    );
    const recoveryPaths = transportValue("port_paths", command(["paths", portId], restoreRoot));
    await writeFile(
      path.join(recoveryPaths.user_data_root, "owned-recovery-copy-window.bin"),
      Buffer.alloc(256 * 1024 * 1024, 0x5a),
    );
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(button("Library and storage"));
    await click(button("Move library"));
    await browser.findElement(By.id("library-destination")).sendKeys(recoveryDestination);
    await click(button("Review move"));
    await browser.wait(until.elementLocated(button("Move to this folder")), 15_000);
    const beforeRecovery = await bootstrap();
    await click(button("Move to this folder"));
    await waitForFile(path.join(restoreRoot, ".portcove-authority.json"));
    await writeFile(recoverySave, `${await readFile(recoverySave, "utf8")}\nchanged after review`);
    await browser.wait(until.elementLocated(button("Keep using original library")), 15_000);
    assert.ok(
      (
        await browser.findElement(By.css('[aria-label="Library move recovery"]')).getText()
      ).includes("before the new copy is activated"),
    );
    await assertCompactReview(browser, '[role="dialog"]');
    const recoveryAccessibility = path.join(output, "library-move-recovery-accessibility.json");
    await captureAccessibilityReport(browser, recoveryAccessibility, artifacts);
    const recoveryImage = path.join(output, "native-library-move-recovery.png");
    await writeFile(recoveryImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(recoveryImage);
    await click(button("Keep using original library"));
    const afterRecovery = await browser.wait(async () => {
      const observed = await bootstrap();
      const expected = await realpath(restoreRoot).catch(() => undefined);
      const actual = observed.library_root
        ? await realpath(observed.library_root).catch(() => undefined)
        : undefined;
      return observed.ready &&
        observed.generation > beforeRecovery.generation &&
        expected !== undefined &&
        actual === expected
        ? observed
        : false;
    }, 15_000);
    assert.ok(afterRecovery);
    assert.equal(await realpath(required(afterRecovery.library_root)), await realpath(restoreRoot));
    await access(recoveryDestination);
    const result = path.join(output, "library-handoff-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          before,
          after,
          identity_before: identityBefore,
          identity_after: identityAfter,
          stale_identity_generation_rejected: true,
          preserved_originals: preserved,
          copied,
          restore: {
            restored_save: restoredSave,
            restored_backup_snapshot: restoredBackup,
            manually_copied_content: contentCopy,
            missing_content_root_refused_during_review: true,
            existing_empty_root_review_is_not_payload_verification: true,
            disconnected_original_reference_retained: true,
            original_source_identity: originalSourceIdentity,
            before: beforeRestore,
            after: afterRestore,
            trusted_native_confirmation: true,
            unchanged_export_metadata: exportedMetadata,
            unchanged_export_content: exportedSave,
          },
          recovery: {
            before: beforeRecovery,
            after: afterRecovery,
            pre_activation_abort_offered: true,
            copied_destination_retained: recoveryDestination,
          },
          preserved_active_identity: active.id,
          stale_generation_rejected: true,
          move_and_restore_escape_dismissal_and_focus_restoration: true,
          primary_action_styles: {
            move: moveActionStyles,
            restore: restoreActionStyles,
          },
          evidence:
            "native owned-library move, trusted-export restore confirmation, and controlled pre-activation recovery; no physical interruption or production-feed claim",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(result);
  });
}

async function waitForFile(file: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
