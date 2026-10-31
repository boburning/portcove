import {
  fixtureSuccess as success,
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
interface CliHandoffContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  cli: string;
  command: FixtureCommand;
}
import { executeBrowserScript } from "./browser-script.mts";
// Read-only command handoff from the real native UI after owned move and restore.
import assert from "node:assert/strict";
import path from "node:path";
import { realpath, writeFile } from "node:fs/promises";
import { By, Key, until } from "selenium-webdriver";
import {
  revealDetailSection,
  reviewControls,
  assertCompactReview,
  captureAccessibilityReport,
  openCatalogPortAfterRefresh,
  clickVisible,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";

export async function cliHandoffScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  cli,
  command,
}: CliHandoffContext) {
  await scenario("native-contextual-cli-handoff", async () => {
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    assert.equal(
      await realpath(required(bootstrap.library_root)),
      await realpath(path.join(output, "restored-library")),
    );
    const context = object(
      await invoke("get_cli_command_context", {
        generation: bootstrap.generation,
      }),
    );
    assert.equal(context.ok, true);
    const cliContext = transportValue("desktop_cli_command_context", context.value);
    assert.equal(await realpath(required(cliContext.executable)), await realpath(cli));
    const stale = object(
      await invoke("get_cli_command_context", {
        generation: bootstrap.generation - 1,
      }),
    );
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    const { click } = reviewControls(browser);
    const open = async (portId: string, view: "Library" | "Discover") => {
      const port = transportValue("port", command(["catalog", "show", portId]));
      if (view === "Discover") await openCatalogPortAfterRefresh(browser, port);
      else {
        await browser.navigate().refresh();
        await selectPrimaryNavigation(browser, "Library");
        const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await search.sendKeys(
          Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
          Key.BACK_SPACE,
        );
        await clickVisible(
          browser,
          await browser.findElement(
            By.xpath(
              '//*[@aria-label="Library quick views"]//button[text()[normalize-space(.)="All games"]]',
            ),
          ),
        );
        await click(By.css(`[data-detail-game-id="${port.id}"]`));
      }
      await revealDetailSection(browser, "Manage");
      const technical = By.xpath(
        '//*[@data-detail-workspace]//*[@role="tabpanel" and not(@hidden)]/details/summary[starts-with(normalize-space(.), "Technical details")]',
      );
      const technicalControl = await browser.wait(until.elementLocated(technical), 10_000);
      const technicalText = await executeBrowserScript(
        browser,
        (element) => element.textContent?.trim(),
        technicalControl,
      );
      assert.ok(typeof technicalText === "string");
      assert.match(technicalText, /^Technical details/);
      await click(technical);
    };
    await open("zelda64-recomp", "Library");
    assert.deepEqual(
      await executeBrowserScript(browser, () =>
        Array.from(document.querySelectorAll("[data-detail-workspace] [role=tab]"), (tab) =>
          tab.textContent?.trim(),
        ),
      ),
      ["Overview", "Game files", "Saves & backups", "Versions & updates", "Manage"],
    );
    await revealDetailSection(browser, "Versions & updates");
    const versionSummary = await browser
      .findElement(By.css('[aria-label="Installation and release versions"]'))
      .getText();
    assert.match(versionSummary, /Installed version/);
    const installedStatus = required(
      transportValues("status", success(await invoke("get_statuses"))).find(
        (status) => status.port_id === "zelda64-recomp",
      ),
    );
    assert.equal(
      installedStatus.last_update_check,
      null,
      "The adopted handoff fixture has not checked for updates",
    );
    assert.equal(required(installedStatus.active).channel, "stable");
    assert.equal(
      await browser.findElement(By.css(".detail-version-current .identity-chip")).getText(),
      "Stable",
    );
    assert.ok(versionSummary.includes(required(installedStatus.active).version));
    assert.doesNotMatch(versionSummary, /Latest version at last check/);
    assert.match(
      await browser.findElement(By.css("#detail-updates")).findElement(By.xpath("..")).getText(),
      /No update check is saved for this installation and channel/,
    );
    await revealDetailSection(browser, "Manage");
    const launch = By.css('[aria-label="Launch from another app"]');
    await browser.wait(until.elementLocated(By.css('[aria-label="Copy launch command"]')), 10_000);
    await click(By.xpath('//summary[normalize-space(.)="Separate program and arguments"]'));
    const codes = await browser.findElement(launch).findElements(By.css(".command-line code"));
    const shell = await required(codes[0]).getText();
    const program = await required(codes[1]).getText();
    const args: unknown = JSON.parse(await required(codes[2]).getText());
    assert.equal(await realpath(program), await realpath(cli));
    assert.deepEqual(args, ["--library", cliContext.library_root, "exec", "zelda64-recomp", "--"]);
    assert.ok(shell.includes("--library") && shell.includes("restored-library"));
    await assertCompactReview(browser, ".detail-panel");
    const report = path.join(output, "cli-handoff-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center" });',
      await browser.findElement(launch),
    );
    const screenshot = path.join(output, "native-cli-handoff-compact.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    await open("opengoal-jak2", "Discover");
    await browser.wait(
      until.elementLocated(By.css('[aria-label="Copy command template"]')),
      10_000,
    );
    const setup = await browser
      .findElement(By.css('[aria-label="Set up from the command line"]'))
      .getText();
    assert.ok(setup.includes("source-path") && setup.includes("Template"));
    assert.equal(
      (await browser.findElements(By.css('[aria-label="Copy setup command"]'))).length,
      0,
    );
    const result = path.join(output, "cli-handoff-result.json");
    await writeFile(
      result,
      JSON.stringify(
        {
          context: cliContext,
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
