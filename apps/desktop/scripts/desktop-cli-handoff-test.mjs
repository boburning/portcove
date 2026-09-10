// Read-only command handoff from the real native UI after the owned library move.
import assert from "node:assert/strict";
import path from "node:path";
import { realpath, writeFile } from "node:fs/promises";
import axe from "axe-core";
import { By, until } from "selenium-webdriver";
import {
  reviewControls,
  assertCompactReview,
} from "./desktop-review-controls.mjs";

export async function cliHandoffScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  cli,
  command,
}) {
  await scenario("native-contextual-cli-handoff", async () => {
    const bootstrap = (await invoke("get_bootstrap_status")).value;
    assert.equal(
      await realpath(bootstrap.library_root),
      await realpath(path.join(output, "moved-library")),
    );
    const context = await invoke("get_cli_command_context", {
      generation: bootstrap.generation,
    });
    assert.equal(context.ok, true);
    assert.equal(await realpath(context.value.executable), await realpath(cli));
    const stale = await invoke("get_cli_command_context", {
      generation: bootstrap.generation - 1,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "conflict");
    const { click } = reviewControls(browser);
    const open = async (portId, view) => {
      const port = command(["catalog", "show", portId]);
      await browser.navigate().refresh();
      await click(By.xpath(`//nav//button[contains(., "${view}")]`));
      await click(
        By.xpath(
          `//button[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
        ),
      );
      await click(
        By.xpath(
          '//summary[starts-with(normalize-space(.), "Release, sources & maintenance")]',
        ),
      );
    };
    await open("zelda64-recomp", "Library");
    const launch = By.css('[aria-label="Launch from another app"]');
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Copy launch command"]')),
      10_000,
    );
    await click(
      By.xpath(
        '//summary[normalize-space(.)="Separate program and arguments"]',
      ),
    );
    const codes = await browser
      .findElement(launch)
      .findElements(By.css(".command-line code"));
    const shell = await codes[0].getText();
    const program = await codes[1].getText();
    const args = JSON.parse(await codes[2].getText());
    assert.equal(await realpath(program), await realpath(cli));
    assert.deepEqual(args, [
      "--library",
      context.value.library_root,
      "exec",
      "zelda64-recomp",
      "--",
    ]);
    assert.ok(shell.includes("--library") && shell.includes("moved-library"));
    await assertCompactReview(browser, ".detail-panel");
    await browser.executeScript(axe.source);
    const accessibility = await browser.executeAsyncScript((done) =>
      window.axe.run().then(done),
    );
    const report = path.join(output, "cli-handoff-accessibility.json");
    await writeFile(report, JSON.stringify(accessibility, null, 2), {
      flag: "wx",
    });
    artifacts.push(report);
    assert.deepEqual(
      accessibility.violations.map((item) => item.id),
      [],
    );
    await browser.executeScript(
      'arguments[0].scrollIntoView({ block: "center" });',
      await browser.findElement(launch),
    );
    const screenshot = path.join(output, "native-cli-handoff-compact.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await open("opengoal-jak2", "Port catalog");
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Copy command template"]')),
      10_000,
    );
    const setup = await browser
      .findElement(By.css('[aria-label="Set up from the command line"]'))
      .getText();
    assert.ok(setup.includes("source-path") && setup.includes("Template"));
    assert.equal(
      (await browser.findElements(By.css('[aria-label="Copy setup command"]')))
        .length,
      0,
    );
    const result = path.join(output, "cli-handoff-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          context: context.value,
          shell,
          program,
          args,
          stale_generation_rejected: true,
          unresolved_setup_is_template: true,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(result);
  });
}
