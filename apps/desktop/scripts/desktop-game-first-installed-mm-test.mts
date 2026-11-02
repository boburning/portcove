import assert from "node:assert/strict";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until } from "selenium-webdriver";
import type { Locator } from "selenium-webdriver";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import type { GameFirstInstalledContext } from "./desktop-game-first-installed-test.mts";
import { launchInstalledManagedGame } from "./desktop-game-first-installed-test.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { errorCode, errorMessage } from "../../../scripts/runtime-values.mts";
import {
  fixtureSuccess,
  ownedFixtureCommand,
  requiredFixtureValue as required,
} from "./desktop-scenario-state.mts";
import { transportValue } from "./transport-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import {
  readGameFirstObservation,
  observeGameFirstCaptureReadiness,
} from "./desktop-game-first-test.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import { INTERFACE_SIZES } from "../src/interface-size-controller.ts";
import {
  captureAccessibilityReport,
  clearCatalogFilters,
  clickVisible,
  openCatalogFilters,
  selectCatalogPort,
  revealDetailSection,
  selectGameFilesSettings,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { gameIdentityLabel, gameProjectLabel } from "../src/port-identity.ts";

const scenarioId = "native-game-first-installed-mm";
import { gameFirstMMHarnessDeadlineMs } from "../../../scripts/desktop-scenarios.mts";
export const mmInstalledScenarioTimeoutMs = gameFirstMMHarnessDeadlineMs;
const gameId = "the-legend-of-zelda-majoras-mask";
const pair = ["2ship2harkinian", "zelda64-recomp"] as const;
// Launch ONE representative implementation; two installs do not imply two gameplay gates.
const portId = "zelda64-recomp";
const groupSelector = `[data-library-game-id="game:${gameId}"]`;
export interface MMInstalledContext extends Omit<GameFirstInstalledContext, "inputPaths"> {
  sourceDirectory: string;
  inputBaseline: {
    /** Captured canonical N64 fixture from the input adapter; normal Core still establishes compatibility. */
    source: FileIdentity;
    /** Same existing retained-input custody check; no new archive/ROM protocol here. */
    verify: () => Promise<void>;
  };
}
function retainedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
}
function samePath(left: string, right: string) {
  const normalized = (value: string) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase();
  return normalized(left) === normalized(right);
}
function sessionIds(library: string, selectedPort: (typeof pair)[number]) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare("SELECT id FROM launch_sessions WHERE port_id = ? ORDER BY started_at, id")
      .all(selectedPort)
      .map((row) => {
        assert.equal(typeof row.id, "string");
        return String(row.id);
      });
  } finally {
    database.close();
  }
}
function sessionInventory(library: string) {
  return {
    "2ship2harkinian": sessionIds(library, "2ship2harkinian"),
    "zelda64-recomp": sessionIds(library, "zelda64-recomp"),
  };
}
function assertNoManagedLaunches(library: string) {
  assert.deepEqual(
    sessionInventory(library),
    { "2ship2harkinian": [], "zelda64-recomp": [] },
    "Source review, installs, filters, captures and alternatives must not launch either player runtime",
  );
}
async function userDataInventory(root: string) {
  try {
    assert.ok((await lstat(root)).isDirectory());
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false as const, files: [] };
    throw error;
  }
  const files: { name: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  async function visit(directory: string, depth: number) {
    assert.ok(depth <= 12 && !(await lstat(directory)).isSymbolicLink());
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(entries.length <= 4096 && files.length + entries.length <= 10_000);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      assert.ok(!metadata.isSymbolicLink(), "Owned MM data must not traverse links");
      if (metadata.isDirectory()) await visit(file, depth + 1);
      else {
        assert.ok(metadata.isFile());
        total += metadata.size;
        assert.ok(total <= 256 * 1024 ** 2);
        const identity = await fileIdentity(file, { maxBytes: 64 * 1024 ** 2 });
        files.push({
          name: path.relative(root, file),
          bytes: identity.bytes,
          sha256: identity.sha256,
        });
      }
    }
  }
  await visit(root, 0);
  return { exists: true as const, files: files.sort((a, b) => a.name.localeCompare(b.name, "en")) };
}

export async function gameFirstInstalledMMScenario(context: MMInstalledContext) {
  const { invoke, scenario, library, cli, output, artifacts, inputBaseline, sourceDirectory } =
    context;
  let browser = context.browser;
  await scenario(scenarioId, async () => {
    assert.equal(process.platform, "win32");
    assert.equal(
      context.operatorObservation,
      true,
      "MM acceptance requires exact runtime exit observation; Root retains separate Sky/Close evidence",
    );
    assert.equal(process.env.PORTCOVE_QUALIFICATION_CATALOG, undefined);
    assert.equal(path.basename(sourceDirectory), "selected-setup-inputs");
    assert.equal(path.relative(output, sourceDirectory), "selected-setup-inputs");
    assert.equal(path.dirname(inputBaseline.source.path), sourceDirectory);
    assert.equal(path.extname(inputBaseline.source.path).toLowerCase(), ".z64");
    await inputBaseline.verify();
    const readbacks: unknown[] = [];
    const report: Record<string, unknown> = {
      scope: "One real managed MM setup/Play journey with both installed alternatives",
      held: [
        "Gameplay/save compatibility",
        "Total-network offline and definition unavailability",
        "Update/recovery mutations unless an actual offered state is supplied; no manufactured update/failure state",
      ],
      readbacks,
    };
    const read = async () => {
      const value = await readGameFirstObservation(invoke, readbacks);
      assert.ok(samePath(required(value.bootstrap.library_root), library));
      return value;
    };
    const row = async (id: string) =>
      required((await read()).statuses.find((item) => item.port_id === id));
    const coreRaw = ownedFixtureCommand({ cli, library, output });
    const core = (args: readonly string[]) => {
      assert.ok(
        (args.length === 2 &&
          ["status", "paths"].includes(String(args[0])) &&
          pair.some((id) => id === args[1])) ||
          (args.length === 3 && args[0] === "launch" && args[1] === "show"),
        "Read-only normal CLI only",
      );
      return coreRaw(args);
    };
    const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const click = async (locator: Locator, timeout = 15_000) => {
      const element = await browser.wait(until.elementLocated(locator), timeout);
      await browser.wait(until.elementIsVisible(element), timeout);
      await browser.wait(until.elementIsEnabled(element), timeout);
      await clickVisible(browser, element);
    };
    const captureInstalledState = async (
      state: string,
      title: string,
      action: string,
      expectedAction: string,
    ) => {
      const priorWindow = await browser.manage().window().getRect();
      const priorSize = await executeBrowserScript(browser, () => {
        const text = Array.from(document.querySelectorAll('[role="status"]'))
          .map((node) => node.textContent ?? "")
          .find((value) => /^Interface size \d+%\./u.test(value));
        if (!text) throw new Error("Real interface-size status is unavailable");
        return Number(text.match(/^Interface size (\d+)%\./u)?.[1]);
      });
      assert.ok(INTERFACE_SIZES.some((value) => value === priorSize));
      const shortcut = (key: string) =>
        browser.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
      const setSize = async (size: number) => {
        await shortcut("0");
        await browser.wait(
          () =>
            executeBrowserScript(browser, observeGameFirstCaptureReadiness, 100).then(
              (value) => value.ready,
            ),
          10_000,
        );
        for (const next of INTERFACE_SIZES.filter((value) => value > 100 && value <= size)) {
          await shortcut("+");
          await browser.wait(
            () =>
              executeBrowserScript(browser, observeGameFirstCaptureReadiness, next).then(
                (value) => value.ready,
              ),
            10_000,
          );
        }
      };
      let primary: Error | undefined;
      let restoration: Error | undefined;
      try {
        // The implementation-choice prompt has no port ID attribute on its Use
        // button. Its stable closed-pair position is guarded by exact visible
        // action text; a changed DOM/action fails instead of crediting another CTA.
        assert.equal((await browser.findElements(By.css(action))).length, 1);
        assert.equal(await (await browser.findElement(By.css(action))).getText(), expectedAction);
        for (const layout of [
          { name: "ordinary", width: 1280, height: 900, size: 100 },
          { name: "narrow", width: 960, height: 640, size: 100 },
          { name: "enlarged-200", width: 960, height: 640, size: 200 },
        ]) {
          await setSize(layout.size);
          await browser.manage().window().setRect({ width: layout.width, height: layout.height });
          for (const target of [
            { name: "title", selector: title },
            { name: "action", selector: action },
          ]) {
            const name = `mm-${state}-${target.name}-${layout.name}`;
            const element = await browser.wait(
              until.elementLocated(By.css(target.selector)),
              15_000,
            );
            if (target.name === "action") assert.equal(await element.getText(), expectedAction);
            const prepared = await prepareCaptureTarget({
              target: target.selector,
              label: name,
              scroll: () =>
                executeBrowserScript(
                  browser,
                  (element) =>
                    element.scrollIntoView({
                      block: "center",
                      inline: "nearest",
                      behavior: "instant",
                    }),
                  element,
                ),
              observe: () =>
                executeBrowserScript(
                  browser,
                  observeVisibleTarget,
                  target.selector,
                  "visual" as const,
                ),
            });
            const image = await captureSettledVisual({
              browser,
              output,
              name,
              scenario: scenarioId,
              target: target.selector,
              observeTarget: async () => {
                const observed = await executeBrowserScript(
                  browser,
                  observeVisibleTarget,
                  target.selector,
                  "visual" as const,
                );
                requireUnchangedCaptureTarget(prepared.observation, observed);
                return observed;
              },
              readiness: () =>
                executeBrowserScript(browser, observeGameFirstCaptureReadiness, layout.size),
            });
            artifacts.push(image.image.path, image.receipt);
          }
        }
      } catch (error) {
        primary = retainedError(error);
      } finally {
        try {
          await setSize(priorSize);
          await browser.manage().window().setRect(priorWindow);
        } catch (error) {
          restoration = retainedError(error);
          console.error("MM UI appearance restoration failed:", errorMessage(error));
        }
      }
      if (primary) throw primary;
      if (restoration) throw restoration;
      report[`captures_${state}`] = {
        layouts: ["ordinary", "narrow", "enlarged-200"],
        targets: { title, action },
        scope:
          "Individual installed UI title/action only; no whole-card fit or game-pixel inference",
      };
      assertNoManagedLaunches(library);
    };
    const discover = async (id: string) => {
      await selectPrimaryNavigation(browser, "Discover");
      await clearCatalogFilters(browser);
      const query = await browser.findElement(By.id("port-search"));
      await query.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, id);
      await selectCatalogPort(browser, id);
    };
    const libraryView = async () => {
      await selectPrimaryNavigation(browser, "Library");
      await clearCatalogFilters(browser);
      const query = await browser.findElement(By.id("port-search"));
      await query.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, "Majora's Mask");
      await browser.wait(until.elementLocated(By.css(groupSelector)), 15_000);
    };
    const favorites = async () => {
      const value = fixtureSuccess(
        await invoke("get_favorite_ports", { generation: (await read()).bootstrap.generation }),
      );
      assert.ok(Array.isArray(value) && value.every((id) => typeof id === "string"));
      return value;
    };
    const baseline = async () => {
      const value = await read();
      const statuses = pair.map((id) =>
        required(value.statuses.find((item) => item.port_id === id)),
      );
      const data = [];
      for (const id of pair) {
        const paths = transportValue("port_paths", core(["paths", id]));
        data.push({
          port_id: id,
          root: paths.user_data_root,
          files: await userDataInventory(paths.user_data_root),
        });
      }
      return {
        statuses,
        organization: value.organization,
        sources: value.workspace.sources,
        favorites: await favorites(),
        sessions: sessionInventory(library),
        userData: data,
      };
    };
    const choose = async (id: (typeof pair)[number]) => {
      const value = await read();
      const port = required(value.workspace.catalog.ports.find((item) => item.id === id));
      await click(button(`Use ${gameProjectLabel(port) || port.name}`));
      await browser.wait(
        async () => (await read()).organization.preferred_port_by_game?.[gameId] === id,
        15_000,
      );
    };
    let failure: Error | undefined;
    try {
      const before = await read();
      assert.equal(before.organization.preferred_port_by_game?.[gameId], undefined);
      assert.deepEqual(before.workspace.sources, []);
      for (const id of pair) assert.equal((await row(id)).active, null);
      assertNoManagedLaunches(library);
      assert.deepEqual(await favorites(), []);
      report.source_input = inputBaseline.source;
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      await click(button("Add folder"));
      const picker = await context.chooseGameFileFolder("mm-source-folder", sourceDirectory);
      report.folder_picker = picker;
      await browser.wait(
        async () =>
          transportValue(
            "desktop_game_file_roots",
            fixtureSuccess(
              await invoke("get_game_file_roots", {
                generation: (await read()).bootstrap.generation,
              }),
            ),
          ).some((item) => samePath(item.path, sourceDirectory)),
        15_000,
      );
      await click(button("Refresh folders"));
      // Refresh reads saved-folder state; this ordinary action actually starts hashing.
      const scanActivitiesBefore = new Set(
        transportValue("activity", fixtureSuccess(await invoke("get_activities"))).records.map(
          (item) => item.id,
        ),
      );
      await click(button("Scan saved folders"));
      const candidate = By.css(
        '[data-completed-candidate][data-profile-id="majoras-mask"] [data-candidate-review]',
      );
      await browser.wait(until.elementLocated(candidate), 180_000);
      report.completed_scan = await browser.wait(
        async () =>
          transportValue("activity", fixtureSuccess(await invoke("get_activities"))).records.find(
            (item) =>
              !scanActivitiesBefore.has(item.id) &&
              item.operation === "discover_sources" &&
              item.status === "succeeded",
          ) || false,
        180_000,
      );
      assert.deepEqual((await read()).workspace.sources, []);
      await click(candidate);
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      assert.deepEqual((await read()).workspace.sources, []);
      await click(button("Use current location"));
      const source = await browser.wait(
        async () =>
          (await read()).workspace.sources.find((item) => item.profile_id === "majoras-mask") ||
          false,
        180_000,
      );
      assert.ok(source);
      assert.ok(samePath(source.path, inputBaseline.source.path));
      assert.equal(source.sha256, inputBaseline.source.sha256);
      assert.equal(source.size, inputBaseline.source.bytes);
      report.registered_source = source;
      assertNoManagedLaunches(library);
      for (const id of pair) {
        await discover(id);
        await revealDetailSection(browser, "Game files");
        await click(button("Review installation"));
        const dialog = await browser.wait(
          until.elementLocated(By.css('[aria-labelledby="install-review-title"]')),
          180_000,
        );
        // Core's actual read-only plan supplies identity, source admission and genuine release artifact.
        const plan = transportValue(
          "install_plan",
          fixtureSuccess(
            await invoke("plan_port", { portId: id, channel: (await row(id)).channel }),
          ),
        );
        assert.equal(plan.port_id, id);
        assert.ok(
          plan.source_requirements.length > 0 &&
            plan.source_requirements.every((item) => item.registered),
        );
        assert.ok(
          plan.release.version &&
            plan.release.asset.name &&
            plan.release.asset.url.startsWith("https://") &&
            plan.release.asset.size > 0,
          "A real Core-selected upstream release/package is required",
        );
        report[`plan_${id}`] = plan;
        const install = await dialog.findElement(By.css('button[data-variant="primary"]'));
        await browser.wait(until.elementIsEnabled(install), 15_000);
        await clickVisible(browser, install);
        // MM uses ordinary InstallReviewDialog consent. Native destructive consent
        // in install_port is ReGaiden-specific, and must not be fabricated here.
        const active = await browser.wait(async () => (await row(id)).active || false, 600_000);
        assert.ok(active);
        await browser.wait(
          async () =>
            (await browser.findElements(By.css('[aria-labelledby="install-review-title"]')))
              .length === 0,
          15_000,
          "Completed installation review did not close",
        );
        assert.equal(active.port_id, id);
        assert.doesNotMatch(active.version, /^adopted-/u);
        assert.equal(active.version, plan.release.version);
        assert.equal(active.artifact.asset_name, plan.release.asset.name);
        assert.equal(active.verified, true);
        assert.match(active.artifact.sha256, /^[a-f0-9]{64}$/u);
        if (plan.release.asset.sha256)
          assert.equal(active.artifact.sha256, plan.release.asset.sha256);
        assert.deepEqual(transportValue("status", core(["status", id])), await row(id));
        report[`installed_${id}`] = await row(id);
        assert.deepEqual(
          (await read()).workspace.sources,
          [source],
          "Second installation reuses the same registered source",
        );
        assert.equal((await read()).organization.preferred_port_by_game?.[gameId], undefined);
        assertNoManagedLaunches(library);
        await libraryView();
        if (id === pair[0]) {
          const card = `[data-detail-origin="library:card:${id}"]`;
          await browser.wait(until.elementLocated(By.css(card)), 15_000);
          assert.equal(
            await (
              await browser.findElement(By.css(`article:has(${card}) button.library-card-play`))
            ).getText(),
            "Play",
          );
          await captureInstalledState(
            "implicit",
            `${card} .collection-title`,
            `article:has(${card}) button.library-card-play`,
            "Play",
          );
          report.single_installed_direct_play = active;
        }
      }
      await libraryView();
      const group = await browser.findElement(By.css(groupSelector));
      assert.ok((await group.getText()).includes("Choose an implementation"));
      assert.equal((await group.findElements(By.css("button.library-card-play"))).length, 0);
      report.ambiguous_without_preference = true;
      const chosenDefinition = required(
        (await read()).workspace.catalog.ports.find((item) => item.id === portId),
      );
      await captureInstalledState(
        "ambiguous",
        `${groupSelector} > article .collection-title`,
        `${groupSelector} > article .collection-actions > div:nth-child(2) > button`,
        `Use ${gameProjectLabel(chosenDefinition) || chosenDefinition.name}`,
      );
      await choose(portId);
      await captureInstalledState(
        "chosen",
        `[data-detail-origin="library:card:${portId}"] .collection-title`,
        `article:has([data-detail-origin="library:card:${portId}"]) button.library-card-play`,
        "Play",
      );
      const alternatives = async () => {
        const details = await browser.findElement(By.css(`${groupSelector} details`));
        if ((await details.getAttribute("open")) === null)
          await clickVisible(browser, await details.findElement(By.css("summary")));
      };
      for (const id of pair) {
        await alternatives();
        await click(By.css(`[data-detail-origin="library:alternative:${id}"]`));
        await browser.wait(
          until.elementLocated(By.css(`[data-detail-workspace][data-detail-port-id="${id}"]`)),
          15_000,
        );
        await click(By.css(".detail-back"));
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (game, port) =>
                document.activeElement?.getAttribute("data-detail-return-group") ===
                  `game:${game}` ||
                document.activeElement?.getAttribute("data-detail-origin") ===
                  `library:alternative:${port}`,
              gameId,
              id,
            ),
          10_000,
        );
      }
      const chosen = required(
        (await read()).workspace.catalog.ports.find((item) => item.id === portId),
      );
      await click(By.css(`button[aria-label="Favorite ${gameIdentityLabel(chosen)}"]`));
      await browser.wait(async () => (await favorites()).includes(portId), 15_000);
      const installedBeforeFilters = pair.map(async (id) => required((await row(id)).active));
      const activeRecords = await Promise.all(installedBeforeFilters);
      const filter = async (method: "portable-package" | "portable-recompilation") => {
        await clearCatalogFilters(browser);
        await openCatalogFilters(browser);
        await click(By.css('button[aria-label^="Original system:"]'));
        await click(By.css('[id$=":originalSystems:nintendo-gamecube"]'));
        await click(By.css('button[aria-label="Close Original system choices"]'));
        const advanced = await browser.findElement(
          By.xpath(
            '//section[@aria-label="Filter options"]//summary[normalize-space(.)="Advanced filters"]',
          ),
        );
        if (
          (await (await advanced.findElement(By.xpath("parent::details"))).getAttribute("open")) ===
          null
        )
          await clickVisible(browser, advanced);
        await click(By.css('button[aria-label^="Setup methods:"]'));
        await click(By.css(`[id$=":installationMethods:${method}"]`));
        await click(By.css('button[aria-label="Close Setup methods choices"]'));
        await click(button("Done"));
      };
      assertNoManagedLaunches(library);
      await filter("portable-recompilation");
      await browser.wait(
        async () => (await browser.findElements(By.css(groupSelector))).length === 0,
        15_000,
      );
      assert.equal((await read()).organization.preferred_port_by_game?.[gameId], portId);
      await filter("portable-package");
      const filtered = await browser.wait(until.elementLocated(By.css(groupSelector)), 15_000);
      assert.ok(
        (await filtered.getText()).includes("Your usual implementation is outside these filters"),
      );
      const available = await read();
      const first = required(available.workspace.catalog.ports.find((item) => item.id === pair[0]));
      await browser.wait(
        until.elementLocated(button(`Use ${gameProjectLabel(first) || first.name}`)),
        15_000,
      );
      await captureInstalledState(
        "qualifying-filtered",
        `${groupSelector} > article .collection-title`,
        `${groupSelector} > article .collection-actions > div:first-child > button`,
        `Use ${gameProjectLabel(first) || first.name}`,
      );
      await alternatives();
      await click(By.css(`[data-detail-origin="library:alternative:${portId}"]`));
      await browser.wait(until.elementLocated(By.css(`[data-detail-port-id="${portId}"]`)), 15_000);
      await click(By.css(".detail-back"));
      assert.equal((await read()).organization.preferred_port_by_game?.[gameId], portId);
      report.same_implementation_filters = {
        negative: ["nintendo-gamecube", "portable-recompilation"],
        positive: ["nintendo-gamecube", "portable-package"],
        manual_alternative: portId,
      };
      await libraryView();
      const installed = required((await row(portId)).active);
      const executable = path.resolve(installed.path, installed.selected_executable);
      assert.ok(
        path.relative(installed.path, executable) &&
          !path.relative(installed.path, executable).startsWith("..") &&
          !path.isAbsolute(path.relative(installed.path, executable)),
      );
      const executableIdentity = await fileIdentity(executable, { maxBytes: 256 * 1024 ** 2 });
      context.onManagedGame({ executable, installation: installed });
      const playTarget = `article:has([data-detail-origin="library:card:${portId}"]) button.library-card-play`;
      assert.equal(await (await browser.findElement(By.css(playTarget))).isEnabled(), true);
      await captureAccessibilityReport(
        browser,
        path.join(output, "mm-installed-accessibility.json"),
        artifacts,
      );
      assertNoManagedLaunches(library);
      const prePlay = await baseline();
      report.before_play = prePlay;
      report.launch = await launchInstalledManagedGame({
        context: { ...context, browser },
        installed,
        executableIdentity,
        play: () => click(By.css(playTarget)),
        core,
        prefix: "mm-chosen-zelda64",
        expectedPortId: portId,
      });
      const afterPlay = sessionInventory(library);
      assert.deepEqual(afterPlay["2ship2harkinian"], prePlay.sessions["2ship2harkinian"]);
      assert.equal(afterPlay[portId].length, prePlay.sessions[portId].length + 1);
      const freshChosenIds = afterPlay[portId].filter(
        (id) => !prePlay.sessions[portId].includes(id),
      );
      assert.equal(freshChosenIds.length, 1);
      assert.deepEqual(
        afterPlay[portId].toSorted(),
        [...prePlay.sessions[portId], required(freshChosenIds[0])].sort(),
      );
      report.managed_session_inventory_after_play = afterPlay;
      for (const id of pair) {
        const beforeStatus = required(prePlay.statuses.find((item) => item.port_id === id));
        assert.equal(
          (await row(id)).successful_launches,
          beforeStatus.successful_launches + (id === portId ? 1 : 0),
        );
      }
      for (let i = 0; i < pair.length; i++)
        assert.deepEqual((await row(required(pair[i]))).active, activeRecords[i]);
      assert.deepEqual((await read()).workspace.sources, prePlay.sources);
      assert.deepEqual(await favorites(), prePlay.favorites);
      const saved = await baseline();
      report.before_restart = saved;
      browser = await context.restartApplication("mm-installed-choice-restart");
      await libraryView();
      assert.deepEqual(await baseline(), saved);
      assert.equal(await (await browser.findElement(By.css(playTarget))).isEnabled(), true);
      await inputBaseline.verify();
      report.outcome = "bounded-mm-installed-choice-journey-complete";
    } catch (error) {
      failure = retainedError(error);
      report.failure = errorMessage(error);
    } finally {
      try {
        const file = path.join(output, "game-first-installed-mm.json");
        await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
        artifacts.push(file);
      } catch (error) {
        if (!failure) failure = retainedError(error);
        else
          console.error(
            "MM report retention failed while preserving the original failure:",
            errorMessage(error),
          );
      }
    }
    if (failure) throw failure;
  });
}
