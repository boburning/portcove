// Actual-Tauri proof that the primary setup action owns the Windows file pickers.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { reviewControls } from "./desktop-review-controls.mjs";

export async function primaryFilePickerScenario({
  browser,
  scenario,
  output,
  artifacts,
  command,
  open,
  confirmNative,
}) {
  await scenario("native-primary-file-pickers", async () => {
    const port = command(["catalog", "show", "mortal-kombat-4-recompiled"]);
    const { button, click } = reviewControls(browser);
    await open(port, false);
    const primary = () => By.css(".actions.primary-actions > button");
    const game = await browser.wait(until.elementLocated(primary()), 15_000);
    assert.match(await game.getText(), /Choose game files and BIOS/);
    assert.equal(await game.isEnabled(), true);
    await click(primary());
    await confirmNative("Choose game files", "Cancel", "File name:", "primary-game-cancel");
    await browser.wait(
      () => browser.executeScript((element) => document.activeElement === element, game),
      5_000,
      "Game picker cancellation did not return focus to the primary action",
    );

    const gameFile = path.join(output, "owned-game.chd");
    const biosFile = path.join(output, "owned-bios.bin");
    await writeFile(gameFile, "isolated game picker fixture", { flag: "wx" });
    await writeFile(biosFile, "isolated BIOS picker fixture", { flag: "wx" });
    artifacts.push(gameFile, biosFile);
    await click(primary());
    await confirmNative("Choose game files", "Open", "File name:", "primary-game-open", gameFile);
    const bios = await browser.wait(until.elementLocated(primary()), 10_000);
    assert.equal(await bios.getText(), "Choose BIOS file");
    await browser.wait(
      async () =>
        (await bios.isEnabled()) &&
        (await browser.executeScript((element) => document.activeElement === element, bios)),
      10_000,
      "Game file selection did not focus the next required BIOS action",
    );
    await click(primary());
    await confirmNative("Choose BIOS file", "Open", "File name:", "primary-bios-open", biosFile);
    const review = await browser.wait(until.elementLocated(button("Review install")), 10_000);
    await browser.wait(
      async () =>
        (await review.isEnabled()) &&
        (await browser.executeScript((element) => document.activeElement === element, review)),
      10_000,
      "BIOS selection did not focus Review install",
    );
    const screenshot = path.join(output, "native-primary-file-pickers.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
    const report = path.join(output, "primary-file-pickers.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          port_id: port.id,
          game_picker_cancel_focus: true,
          game_picker_selected_next_focus: true,
          bios_picker_selected_review_focus: true,
          installation_reviewed_or_committed: false,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
