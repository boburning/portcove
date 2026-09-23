// Copy the harness-owned library, preserve its originals, and observe the new desktop generation.
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mjs";

export async function libraryHandoffScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}) {
  await scenario("native-library-move-invalidates-prior-reviews", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    // Existing preparation scenarios retain recovery work intentionally. Use a
    // separate owned library, without clearing or bypassing those journals.
    const source = path.join(output, "handoff-library");
    const ownedCommand = (args) => command(args, source);
    const destination = path.join(output, "moved-library");
    const portId = "zelda64-recomp";
    ownedCommand(["adopt", path.join(output, "owned-adoption-review"), "--port", portId, "--yes"]);
    const paths = ownedCommand(["paths", portId]);
    await writeFile(
      path.join(paths.user_data_root, "unrelated-save.bin"),
      "preserved handoff save",
      { flag: "wx" },
    );
    const backup = ownedCommand(["backup", "create", portId]);
    const profile = command(["catalog", "show", "opengoal-jak1"]).source_profile;
    ownedCommand(["source", "add", profile, path.join(output, "opengoal-jak1.iso")]);
    const selected = await invoke("set_default_library", { path: source });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const before = (await invoke("get_bootstrap_status")).value;
    const identityBefore = await invoke("get_library_identity", {
      generation: before.generation,
    });
    assert.equal(identityBefore.ok, true, JSON.stringify(identityBefore));
    assert.deepEqual(identityBefore.value, ownedCommand(["library", "identity"]));
    const active = ownedCommand(["status", portId]).active;
    const preserved = await Promise.all(
      [
        path.join(paths.user_data_root, "general.json"),
        path.join(paths.user_data_root, "unrelated-save.bin"),
        path.join(backup.path, "data/general.json"),
      ].map(fileIdentity),
    );
    const sources = ownedCommand(["source", "list"]);
    const { click, button } = reviewControls(browser);
    const assertEscapeRestoresFocus = async (trigger, dialog, name) => {
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(dialog)).length === 0,
        5_000,
        `${name} Dialog did not close after Escape`,
      );
      await browser.wait(
        async () => {
          const candidate = await browser.findElement(trigger);
          return await browser.executeScript(
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
    assert.ok(plan.includes("1 saved game-file location will stay unchanged."));
    assert.ok(plan.includes("Copying Source Inbox files does not redirect these saved locations."));
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
    let after;
    await browser.wait(async () => {
      after = (await invoke("get_bootstrap_status")).value;
      return after?.ready && after.generation > before.generation;
    }, 15_000);
    assert.equal(await realpath(after.library_root), await realpath(destination));
    const identityAfter = await invoke("get_library_identity", {
      generation: after.generation,
    });
    assert.equal(identityAfter.ok, true);
    assert.equal(identityAfter.value.id, identityBefore.value.id);
    assert.equal(await realpath(identityAfter.value.root), await realpath(destination));
    assert.deepEqual(identityAfter.value, ownedCommand(["library", "identity"]));
    assert.deepEqual(identityAfter.value, command(["library", "identity"], destination));
    const staleIdentity = await invoke("get_library_identity", {
      generation: before.generation,
    });
    assert.equal(staleIdentity.ok, false);
    assert.equal(staleIdentity.error.code, "conflict");
    const stale = await invoke("get_output_location", {
      portId,
      generation: before.generation,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
    const current = await invoke("get_output_location", {
      portId,
      generation: after.generation,
    });
    assert.equal(current.ok, true);
    assert.equal(await realpath(current.value.library_root), await realpath(destination));
    const statuses = await invoke("get_statuses");
    assert.equal(statuses.ok, true);
    const moved = statuses.value.find((item) => item.port_id === portId).active;
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
    assert.deepEqual((await invoke("get_sources")).value, sources);

    const metadata = path.join(output, "library-restore-export.json");
    command(["library", "export", "--output", metadata], destination);
    const exportedMetadata = await fileIdentity(metadata);
    const exportedSave = await fileIdentity(
      path.join(destination, path.relative(paths.library_root, preserved[0].path)),
    );
    const restoreRoot = path.join(output, "restored-library");
    await mkdir(restoreRoot);
    const restoreSelection = await invoke("set_default_library", { path: restoreRoot });
    assert.equal(restoreSelection.ok, true, JSON.stringify(restoreSelection));
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    const restoreTrigger = button("Restore from a library copy");
    const restoreDialog = By.css('[aria-labelledby="import-library-title"]');
    await click(restoreTrigger);
    await browser.wait(until.elementLocated(restoreDialog), 15_000);
    await assertEscapeRestoresFocus(restoreTrigger, restoreDialog, "library restore");
    await click(restoreTrigger);
    await browser.findElement(By.id("import-metadata")).sendKeys(metadata);
    await browser.findElement(By.id("import-content")).sendKeys(destination);
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
    assert.ok(restoreReview.includes(destination) && restoreReview.includes(restoreRoot));
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
    const beforeRestore = (await invoke("get_bootstrap_status")).value;
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
    let afterRestore;
    await browser.wait(async () => {
      afterRestore = (await invoke("get_bootstrap_status")).value;
      return afterRestore?.ready && afterRestore.generation > beforeRestore.generation;
    }, 15_000);
    assert.equal(await realpath(afterRestore.library_root), await realpath(restoreRoot));
    assert.equal(command(["status", portId], restoreRoot).active.id, active.id);
    assert.deepEqual(await fileIdentity(metadata), exportedMetadata);
    assert.deepEqual(await fileIdentity(exportedSave.path), exportedSave);

    // After review, wait for core's pending authority marker before changing an
    // owned save. This deterministically exercises the actual pre-activation
    // recovery surface without manufacturing a journal or production state.
    const recoveryDestination = path.join(output, "retained-recovery-copy");
    const recoverySave = path.join(
      restoreRoot,
      path.relative(paths.library_root, preserved[0].path),
    );
    const recoveryPaths = command(["paths", portId], restoreRoot);
    await writeFile(
      path.join(recoveryPaths.user_data_root, "owned-recovery-copy-window.bin"),
      Buffer.alloc(256 * 1024 * 1024, 0x5a),
    );
    await browser.navigate().refresh();
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(button("Move library"));
    await browser.findElement(By.id("library-destination")).sendKeys(recoveryDestination);
    await click(button("Review move"));
    await browser.wait(until.elementLocated(button("Move to this folder")), 15_000);
    const beforeRecovery = (await invoke("get_bootstrap_status")).value;
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
    let afterRecovery;
    await browser.wait(async () => {
      afterRecovery = (await invoke("get_bootstrap_status")).value;
      return afterRecovery?.ready && afterRecovery.generation > beforeRecovery.generation;
    }, 15_000);
    assert.equal(await realpath(afterRecovery.library_root), await realpath(restoreRoot));
    await access(recoveryDestination);
    const result = path.join(output, "library-handoff-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          before,
          after,
          identity_before: identityBefore.value,
          identity_after: identityAfter.value,
          stale_identity_generation_rejected: true,
          preserved_originals: preserved,
          copied,
          restore: {
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

async function waitForFile(file, timeout = 15_000) {
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
