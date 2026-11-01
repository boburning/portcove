import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { fixtureSuccess, requiredFixtureValue as required } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";
import {
  catalogResultPortIds,
  clearCatalogFilters,
  clickVisible,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { gameProjectLabel, gameTitle } from "../src/port-identity.ts";
import { INTERFACE_SIZES } from "../src/interface-size-controller.ts";
import { errorMessage } from "../../../scripts/runtime-values.mts";

/** The dispatcher owns normal application startup, isolated output and positive-exit restart. */
export interface GameFirstContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  restartApplication: (name: string) => Promise<WebDriver>;
}

const scenarioId = "native-game-first-choice-and-restart";
const gameId = "the-legend-of-zelda-majoras-mask";
const pair = ["2ship2harkinian", "zelda64-recomp"] as const;
const groupSelector = `[data-detail-return-group="game:${gameId}"]`;

/** Serialized read-only observation; optional metadata failure does not block choice. */
export function observeGameFirstCaptureReadiness(size: number) {
  return {
    ready:
      document.fonts.status === "loaded" &&
      document.body.textContent?.includes(`Interface size ${size}%.`) === true,
    alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
      (element) => element.textContent?.trim() ?? "",
    ),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    documentWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
}

/** Normal controls and read-only IPC only; no qualification catalog or installation fixture. */
export async function gameFirstScenarios({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  restartApplication,
}: GameFirstContext) {
  await scenario(scenarioId, async () => {
    const originalWindow = await browser.manage().window().getRect();
    const originalSize = await executeBrowserScript(browser, () => {
      const status = Array.from(document.querySelectorAll('[role="status"]'))
        .map((element) => element.textContent ?? "")
        .find((text) => /^Interface size \d+%\./u.test(text));
      if (!status) throw new Error("Applied native interface size is unavailable");
      return Number(status.match(/^Interface size (\d+)%\./u)?.[1]);
    });
    assert.ok(INTERFACE_SIZES.some((size) => size === originalSize));
    const captures: unknown[] = [];
    const readbacks: unknown[] = [];
    const read = async () => {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.equal(bootstrap.ready, true);
      const generation = bootstrap.generation;
      const organization = transportValue(
        "desktop_library_organization",
        fixtureSuccess(await invoke("get_library_organization", { generation })),
      );
      const workspace = transportValue(
        "desktop_workspace_snapshot",
        fixtureSuccess(await invoke("get_workspace_snapshot", { generation })),
      );
      // get_statuses has no generation argument. Bracket it with bootstrap and
      // join its rows to the generation-bound workspace instead of inventing one.
      const statuses = transportValues("status", fixtureSuccess(await invoke("get_statuses")));
      const after = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.equal(after.ready, true);
      assert.equal(after.generation, generation, "Readbacks must belong to one library generation");
      assert.equal(after.library_root, bootstrap.library_root);
      for (const id of pair)
        assert.deepEqual(
          required(statuses.find((row) => row.port_id === id)),
          required(workspace.statuses.find((row) => row.port_id === id)),
          `Ordinary status and workspace disagree for ${id}`,
        );
      return { bootstrap, organization, workspace, statuses };
    };
    const before = await read();
    readbacks.push({
      phase: "before",
      generation: before.bootstrap.generation,
      organization: before.organization,
      statuses: before.statuses.filter((row) => pair.some((id) => id === row.port_id)),
    });
    const relative = path.relative(
      await realpath(output),
      await realpath(required(before.bootstrap.library_root)),
    );
    assert.ok(
      relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      "Game-first scenario requires the harness-owned library beneath this output scope",
    );
    const ports = pair.map((id) =>
      required(before.workspace.catalog.ports.find((port) => port.id === id)),
    );
    const [ship, recompiled] = ports.map((port) => required(port.presentation?.original_game));
    assert.equal(required(ship).id, gameId);
    assert.equal(required(recompiled).id, gameId);
    assert.deepEqual(
      required(ship).source_editions.map((edition) => edition.id),
      ["majoras-mask-n64-usa-1-0", "majoras-mask-gamecube-usa"],
    );
    assert.deepEqual(
      required(recompiled).source_editions.map((edition) => edition.id),
      ["majoras-mask-n64-usa-1-0"],
    );
    const picori = required(
      before.workspace.catalog.ports.find((port) => port.id === "project-picori"),
    );
    assert.equal(picori.presentation?.original_game?.id, "the-legend-of-zelda-the-minish-cap");
    const gzdoom = required(
      before.workspace.listing_catalog?.listings.find((port) => port.id === "zdoom-gzdoom"),
    );
    assert.equal(
      gzdoom.original_game ?? null,
      null,
      "Unresolved engine identity must remain ungrouped",
    );
    const click = async (selector: string) => {
      const element = await browser.wait(until.elementLocated(By.css(selector)), 15_000);
      await clickVisible(browser, element);
    };
    const search = async (query: string) => {
      await selectPrimaryNavigation(browser, "Discover");
      await clearCatalogFilters(browser);
      const field = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
      await field.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, query);
    };
    const expectSearch = async (query: string, expected: readonly string[]) => {
      await search(query);
      await browser.wait(
        async () =>
          JSON.stringify(await catalogResultPortIds(browser)) ===
          JSON.stringify([...expected].sort()),
        15_000,
        `Search ${query} must retain the exact authored project identities`,
      );
    };
    const detail = async (id: string) => {
      await browser.wait(
        until.elementLocated(By.css(`[data-detail-workspace][data-detail-port-id="${id}"]`)),
        15_000,
      );
      assert.equal(
        (await browser.findElements(By.css('[role="dialog"]'))).length,
        0,
        "Comparison must close before detail continuation",
      );
    };
    const back = async () => {
      await click(".detail-back");
      await browser.wait(
        async () => (await browser.findElements(By.css("[data-detail-workspace]"))).length === 0,
        15_000,
      );
    };
    const openComparison = async () => {
      const group = await browser.wait(
        until.elementLocated(By.css(`.discover-game${groupSelector}`)),
        15_000,
      );
      await clickVisible(
        browser,
        await group.findElement(By.xpath('.//button[starts-with(normalize-space(.),"Compare")]')),
      );
      const dialog = await browser.wait(
        until.elementLocated(By.css(".port-comparison-dialog")),
        15_000,
      );
      await browser.wait(until.elementIsVisible(dialog), 5_000);
      for (const port of ports)
        assert.ok((await dialog.getText()).includes(gameProjectLabel(port) || port.name));
      return dialog;
    };
    const capture = async (name: string, selector: string, size: number) => {
      const target = await browser.wait(until.elementLocated(By.css(selector)), 15_000);
      const prepared = await prepareCaptureTarget({
        target: selector,
        label: `Game-first ${name}`,
        scroll: () =>
          executeBrowserScript(
            browser,
            (element) =>
              element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
            target,
          ),
        observe: () =>
          executeBrowserScript(browser, observeVisibleTarget, selector, "visual" as const),
      });
      const captured = await captureSettledVisual({
        browser,
        output,
        name: `game-first-${name}`,
        scenario: scenarioId,
        target: selector,
        observeTarget: async () => {
          const observation = await executeBrowserScript(
            browser,
            observeVisibleTarget,
            selector,
            "visual" as const,
          );
          requireUnchangedCaptureTarget(prepared.observation, observation);
          return observation;
        },
        readiness: () => executeBrowserScript(browser, observeGameFirstCaptureReadiness, size),
      });
      artifacts.push(captured.image.path, captured.receipt);
      captures.push({
        name,
        window: await browser.manage().window().getRect(),
        image: captured.image.path,
      });
    };
    const shortcut = (key: string) =>
      browser.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
    const resetSize = async () => {
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.body.textContent?.includes("Interface size 100%.") === true,
          ),
        10_000,
      );
    };
    let failed = true;
    let failure: unknown;
    let cleanupFailure: unknown;
    try {
      await resetSize();
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      await expectSearch(gameTitle(required(ports[0])), pair);
      assert.equal(
        (await browser.findElements(By.css(`.discover-game${groupSelector}`))).length,
        1,
      );
      for (const port of ports) await expectSearch(port.name, [port.id]);
      await expectSearch(picori.name, [picori.id]);
      assert.equal(
        (
          await browser.findElements(
            By.css('[data-detail-return-group="game:the-legend-of-zelda-the-minish-cap"]'),
          )
        ).length,
        1,
      );
      await expectSearch(gzdoom.id, [gzdoom.id]);
      assert.equal(
        (await browser.findElements(By.css('[data-detail-return-group="port:zdoom-gzdoom"]')))
          .length,
        1,
      );
      await expectSearch(gameTitle(required(ports[0])), pair);
      await openComparison();
      const chosen = required(
        ports.find((port) => port.id !== before.organization.preferred_port_by_game?.[gameId]),
      );
      const alternative = required(ports.find((port) => port.id !== chosen.id));
      const use = await browser.findElement(
        By.xpath(
          `//*[@role="dialog"]//button[normalize-space(.)="Use ${gameProjectLabel(chosen) || chosen.name}"]`,
        ),
      );
      await capture(
        "comparison-ordinary",
        `[role="dialog"] button[data-discover-port-id="${chosen.id}"]`,
        100,
      );
      await use.sendKeys(Key.ENTER);
      await detail(chosen.id);
      await browser.wait(
        async () => (await read()).organization.preferred_port_by_game?.[gameId] === chosen.id,
        15_000,
      );
      const saved = await read();
      readbacks.push({
        phase: "chosen",
        generation: saved.bootstrap.generation,
        organization: saved.organization,
        statuses: saved.statuses.filter((row) => pair.some((id) => id === row.port_id)),
      });
      await clickVisible(
        browser,
        await browser.findElement(By.xpath('//summary[normalize-space(.)="Implementations (2)"]')),
      );
      for (const port of ports) {
        const alternativeControl = await browser.findElement(
          By.css(`[data-detail-origin="detail:alternative:${port.id}"]`),
        );
        const facts = await alternativeControl.findElement(By.xpath("..")).getText();
        for (const edition of required(port.presentation?.original_game).source_editions)
          assert.ok(
            facts.includes(edition.title),
            `${port.id} must present its own source editions`,
          );
        if (port.id === "zelda64-recomp")
          assert.ok(
            !facts.includes("GameCube USA re-release ROM"),
            "Shared game identity must not broaden Zelda64's admitted source edition",
          );
      }
      await click(`[data-detail-origin="detail:alternative:${alternative.id}"]`);
      await detail(alternative.id);
      assert.equal(
        (await read()).organization.preferred_port_by_game?.[gameId],
        chosen.id,
        "Viewing an alternative must not silently replace the deliberate choice",
      );
      await back();
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (id) => document.activeElement?.getAttribute("data-detail-game-id") === id,
            chosen.id,
          ),
        10_000,
        "Back from an alternative must restore the chosen game identity focus",
      );
      await browser.wait(until.elementLocated(By.css(`.discover-game${groupSelector}`)), 15_000);
      await browser.wait(
        async () =>
          (await browser
            .findElement(By.css(`.discover-game${groupSelector}`))
            .getAttribute("data-discover-primary-port-id")) === chosen.id,
        15_000,
      );
      await capture(
        "choice-ordinary",
        `.discover-game${groupSelector} .discover-game-identity`,
        100,
      );
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await capture("choice-narrow", `.discover-game${groupSelector} .discover-game-identity`, 100);
      for (const size of INTERFACE_SIZES.filter((size) => size > 100 && size <= 200)) {
        await shortcut("+");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (size) => document.body.textContent?.includes(`Interface size ${size}%.`) === true,
              size,
            ),
          10_000,
        );
      }
      await capture(
        "choice-enlarged-200",
        `.discover-game${groupSelector} .discover-game-identity`,
        200,
      );
      await resetSize();
      browser = await restartApplication(scenarioId);
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      const restarted = await read();
      readbacks.push({
        phase: "restarted",
        generation: restarted.bootstrap.generation,
        organization: restarted.organization,
        statuses: restarted.statuses.filter((row) => pair.some((id) => id === row.port_id)),
      });
      assert.deepEqual(
        restarted.organization,
        saved.organization,
        "Core organization survives actual host restart",
      );
      assert.deepEqual(
        restarted.workspace.sources,
        before.workspace.sources,
        "Choosing a project creates no source registrations",
      );
      for (const id of pair)
        assert.deepEqual(
          restarted.statuses.find((row) => row.port_id === id),
          before.statuses.find((row) => row.port_id === id),
          "Choice preserves independent installation/readiness state",
        );
      await expectSearch(gameTitle(required(ports[0])), pair);
      await browser.wait(
        async () =>
          (await browser
            .findElement(By.css(`.discover-game${groupSelector}`))
            .getAttribute("data-discover-primary-port-id")) === chosen.id,
        15_000,
      );
      await capture(
        "choice-restarted",
        `.discover-game${groupSelector} .discover-game-identity`,
        100,
      );
      await (
        await browser.findElement(By.css(`.discover-game${groupSelector} .discover-game-identity`))
      ).sendKeys(Key.ENTER);
      await detail(chosen.id);
      await back();
      failed = false;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // The scenario wrapper retains the original failure. Evidence/appearance
      // cleanup must not replace it with a secondary persistence or UI error.
      try {
        const report = path.join(output, "game-first-choice-result.json");
        await writeFile(
          report,
          `${JSON.stringify(
            {
              scenario: scenarioId,
              outcome: failed ? "failed" : "interactions-complete",
              captures,
              readbacks,
              failure: failure === undefined ? null : errorMessage(failure),
              identity: {
                game_id: gameId,
                port_ids: pair,
                independent_source_editions: ports.map((port) => ({
                  port_id: port.id,
                  editions: port.presentation?.original_game?.source_editions,
                })),
                picori_game_id: picori.presentation?.original_game?.id,
                gzdoom_game_id: null,
              },
              evidence:
                "Normal application controls and ordinary Core IPC in an owned isolated library; screenshots require separate image inspection.",
              held: [
                "Library membership and installed-alternative actions: requires separately admitted normal installations; no installations are seeded here.",
                "Original-file compatibility, preparation, real upstream runtime launch, gameplay, save compatibility and removal: unexecuted; lawful originals and complete upstream runtime inputs were not supplied to this module.",
              ],
            },
            null,
            2,
          )}\n`,
          { flag: "wx" },
        );
        artifacts.push(report);
        await resetSize();
        for (const size of INTERFACE_SIZES) {
          if (size === 100 || size > originalSize) continue;
          await shortcut("+");
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                (size) => document.body.textContent?.includes(`Interface size ${size}%.`) === true,
                size,
              ),
            10_000,
          );
        }
        await browser.manage().window().setRect(originalWindow);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        if (failed)
          console.error(
            `${scenarioId}: secondary evidence/appearance cleanup failed; original scenario failure retained`,
            cleanupError,
          );
      }
    }
    if (cleanupFailure !== undefined) throw new Error(errorMessage(cleanupFailure));
  });
}
