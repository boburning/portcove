// Source-reference removal uses the existing owned preparation fixture; no game files are acquired.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";
import { By, until } from "selenium-webdriver";
import {
  reviewControls,
  assertCompactReview,
  captureAccessibilityReport,
} from "./desktop-review-controls.mjs";

export async function sourceRemovalScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}) {
  await scenario("native-reviewed-source-reference-removal", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const source = command(["source", "list"]).find(
      (item) => item.profile_id === port.source_profile,
    );
    assert.ok(source);
    const install = command(["status", port.id]).active;
    const paths = command(["paths", port.id]);
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await mkdir(paths.user_data_root, { recursive: true });
    const save = path.join(
      paths.user_data_root,
      "owned-source-review-save.bin",
    );
    await writeFile(save, "source removal must preserve this save", {
      flag: "wx",
    });
    const backup = command(["backup", "create", port.id]);
    const preserved = await Promise.all(
      [
        source.path,
        save,
        path.join(backup.path, "data/owned-source-review-save.bin"),
      ].map(fileIdentity),
    );
    const others = () =>
      command(["source", "list"]).filter(
        (item) => item.profile_id !== source.profile_id,
      );
    const otherSources = others();
    await browser.navigate().refresh();
    const { button, click } = reviewControls(browser);
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    const row = By.css(`[data-source-profile="${source.profile_id}"]`);
    const dialog = By.css('[aria-labelledby="source-removal-title"]');
    const openReview = async () => {
      await click(
        By.css(`[data-source-profile="${source.profile_id}"] .danger`),
      );
      await browser.wait(
        until.elementLocated(button("Continue to removal confirmation")),
        15_000,
      );
    };
    await openReview();
    let text = await browser.findElement(dialog).getText();
    assert.ok(
      text.includes(source.path) &&
        text.includes(port.name) &&
        text.includes("never schedules deletion"),
    );
    await click(button("Keep source reference"));
    assert.deepEqual(
      command(["source", "list"]).find(
        (item) => item.profile_id === source.profile_id,
      ),
      source,
    );
    await openReview();
    await click(button("Continue to removal confirmation"));
    await confirmNative(
      "Confirm source removal",
      "__observe__",
      source.path,
      "source-native-before-consent",
    );
    assert.deepEqual(
      command(["source", "list"]).find(
        (item) => item.profile_id === source.profile_id,
      ),
      source,
    );
    await confirmNative(
      "Confirm source removal",
      "Cancel",
      source.path,
      "source-native-cancelled",
    );
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      15_000,
    );
    await openReview();
    const replacement = path.join(output, "owned-replacement-jak1.iso");
    await writeFile(replacement, "changed owned source registration", {
      flag: "wx",
    });
    command(["source", "add", source.profile_id, replacement]);
    preserved.push(await fileIdentity(replacement));
    await click(button("Continue to removal confirmation"));
    await browser.wait(
      until.elementLocated(button("Review source removal again")),
      15_000,
    );
    const generation = (await invoke("get_bootstrap_status")).value.generation;
    const reviewed = await invoke("preview_source_removal", {
      profileId: source.profile_id,
      generation,
    });
    assert.equal(reviewed.ok, true);
    const stale = await invoke("remove_source", {
      profileId: source.profile_id,
      previewSha256: reviewed.value.preview_sha256,
      generation: generation + 1,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
    await click(button("Review source removal again"));
    await browser.wait(
      until.elementLocated(button("Continue to removal confirmation")),
      15_000,
    );
    text = await browser.findElement(dialog).getText();
    assert.ok(text.includes(replacement));
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "start" });',
      await browser.findElement(dialog),
    );
    const report = path.join(output, "source-removal-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const screenshot = path.join(output, "native-source-removal-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await assertCompactReview(
      browser,
      '[aria-labelledby="source-removal-title"]',
    );
    const compact = path.join(output, "native-source-removal-compact.png");
    await writeFile(compact, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(compact);
    await click(button("Continue to removal confirmation"));
    await confirmNative(
      "Confirm source removal",
      "Remove source reference",
      replacement,
      "source-native-confirmed",
    );
    await browser.wait(
      async () => (await browser.findElements(row)).length === 0,
      15_000,
    );
    assert.ok(
      !command(["source", "list"]).some(
        (item) => item.profile_id === source.profile_id,
      ),
    );
    assert.deepEqual(others(), otherSources);
    assert.deepEqual(
      await Promise.all(preserved.map((item) => fileIdentity(item.path))),
      preserved,
    );
    assert.equal(command(["status", port.id]).active.id, install.id);
    assert.ok(
      command(["backup", "list", port.id]).backups.some(
        (item) => item.id === backup.id,
      ),
    );
    const result = path.join(output, "source-removal-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          profile_id: source.profile_id,
          preserved_files: preserved,
          preserved_install: install.id,
          preserved_backup: backup.id,
          preserved_other_sources: otherSources,
          dismissal_and_native_cancel_preserved_reference: true,
          changed_registration_rejected: true,
          stale_generation_rejected: true,
          evidence:
            "native owned-file reference removal; no game compatibility or human-comprehension claim",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(result);
  });
}
