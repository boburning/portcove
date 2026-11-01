import assert from "node:assert/strict";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until } from "selenium-webdriver";
import type { WebDriver, Locator } from "selenium-webdriver";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import type {
  nativeConfirmation,
  nativeGameFileFolderPicker,
} from "./desktop-native-confirmation.mts";
import type { InstallRecord, LaunchSessionRecord } from "../src/transport-types.generated.d.ts";
import type {
  NativeManagedGame,
  NativeProcessSnapshot,
  NativeSessionMode,
  NativeSessionObservations,
} from "./desktop-owned-native-session.mts";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import type { GameFirstInstalledInputPaths } from "../../../scripts/desktop-game-first-installed-inputs.mts";
import {
  prepareGameFirstInstalledInputs,
  verifyGameFirstInstalledInputs,
} from "../../../scripts/desktop-game-first-installed-inputs.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import {
  fixtureSuccess,
  ownedFixtureCommand,
  requiredFixtureValue as required,
} from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import {
  nativeSessionScript,
  readNativeSessionObservation,
} from "./desktop-owned-native-session.mts";
import { requestRealRuntimeClose } from "./desktop-real-runtime-test.mts";
import { observeRegisteredRuntimeExit } from "./desktop-runtime-exit-observation.mts";
import { createImageRefusal } from "./desktop-cover-observations.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import {
  catalogResultPortIds,
  captureAccessibilityReport,
  clearCatalogFilters,
  clickVisible,
  selectCatalogPort,
  selectGameFilesSettings,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { gameIdentityLabel, gameTitle } from "../src/port-identity.ts";
import { INTERFACE_SIZES } from "../src/interface-size-controller.ts";

export const gameFirstInstalledScenarioId = "native-game-first-installed-picori";
const portId = "project-picori";
const sourceProfile = "minish-cap-gba";
export interface GameFirstInstalledContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  library: string;
  cli: string;
  application: string;
  inputPaths: GameFirstInstalledInputPaths;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  chooseGameFileFolder: ReturnType<typeof nativeGameFileFolderPicker>;
  operatorObservation?: boolean;
  restartApplication: (
    name: string,
    prepareWhileStopped?: () => Promise<void>,
    childEnvironment?: NodeJS.ProcessEnv,
  ) => Promise<WebDriver>;
  onManagedGame: (game: NativeManagedGame) => void;
  /** The owner must bind actual runtime pixels to the verified game identity. */
  captureGameFrame?: (request: {
    name: string;
    session: LaunchSessionRecord;
    executable: string;
    executableSha256: string;
    game: NativeProcessSnapshot;
    output: string;
    artifacts: string[];
  }) => Promise<
    { status: "captured"; artifact: string } | { status: "unavailable"; reason: string }
  >;
}
function retainedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
}
function samePath(left: string, right: string) {
  const normalized = (value: string) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase();
  return normalized(left) === normalized(right);
}
function sessionIds(library: string) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare("SELECT id FROM launch_sessions WHERE port_id = ? ORDER BY started_at, id")
      .all(portId)
      .map((row) => {
        assert.equal(typeof row.id, "string");
        return String(row.id);
      });
  } finally {
    database.close();
  }
}
async function userDataInventory(root: string) {
  const files: { name: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  async function visit(directory: string, depth: number) {
    assert.ok(depth <= 12 && !(await lstat(directory)).isSymbolicLink());
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(entries.length <= 4096 && files.length + entries.length <= 10_000);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      assert.ok(!metadata.isSymbolicLink(), "Owned Picori data must not traverse links");
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
  return files.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Real normal managed adoption and launch. This scenario never manufactures an install. */
export async function gameFirstInstalledScenario(context: GameFirstInstalledContext) {
  const {
    invoke,
    scenario,
    library,
    cli,
    output,
    artifacts,
    inputPaths,
    confirmNative,
    chooseGameFileFolder,
    onManagedGame,
  } = context;
  let browser = context.browser;
  await scenario(gameFirstInstalledScenarioId, async () => {
    assert.equal(process.platform, "win32");
    assert.equal(process.env.PORTCOVE_QUALIFICATION_CATALOG, undefined, "Normal catalog required");
    const report: Record<string, unknown> = {
      scope:
        "Real Picori ordinary source review, managed adoption and managed launch in an owned library",
      provider_unavailable: {
        status: "held",
        reason:
          "No demonstrated scoped provider-denial route was supplied; total network offline is unexecuted",
      },
      game_frame: { status: "unavailable", reason: "No genuine game-frame observation retained" },
      held: [
        "MM installed alternatives, ambiguity, same-implementation native filter case and real MM Play",
        "Gameplay, save compatibility, total network offline, definition withdrawal and full #4154 acceptance",
      ],
    };
    const coreRaw = ownedFixtureCommand({ cli, library, output });
    const core = (args: readonly string[]) => {
      assert.ok(
        (args.length === 2 &&
          ["status", "paths"].includes(String(args[0])) &&
          args[1] === portId) ||
          (args.length === 3 && args[0] === "launch" && args[1] === "show"),
        "Read-only normal CLI observations only",
      );
      return coreRaw(args);
    };
    const status = async () =>
      required(
        transportValues("status", fixtureSuccess(await invoke("get_statuses"))).find(
          (row) => row.port_id === portId,
        ),
      );
    const sources = async () =>
      transportValues("source", fixtureSuccess(await invoke("get_sources")));
    const organization = async () => {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      return transportValue(
        "desktop_library_organization",
        fixtureSuccess(
          await invoke("get_library_organization", { generation: bootstrap.generation }),
        ),
      );
    };
    const favorites = async () => {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      const value = fixtureSuccess(
        await invoke("get_favorite_ports", { generation: bootstrap.generation }),
      );
      assert.ok(Array.isArray(value) && value.every((id) => typeof id === "string"));
      return value;
    };
    const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const click = async (locator: Locator, timeout = 15_000) => {
      const element = await browser.wait(until.elementLocated(locator), timeout);
      await browser.wait(until.elementIsVisible(element), timeout);
      await browser.wait(until.elementIsEnabled(element), timeout);
      await clickVisible(browser, element);
    };
    const originalWindow = await browser.manage().window().getRect();
    const originalSize = await executeBrowserScript(browser, () => {
      const value = [...document.querySelectorAll('[role="status"]')]
        .map((node) => node.textContent ?? "")
        .find((text) => /^Interface size \d+%\./u.test(text));
      if (!value) throw new Error("Applied interface size is unavailable");
      return Number(value.match(/^Interface size (\d+)%\./u)?.[1]);
    });
    assert.ok(INTERFACE_SIZES.some((size) => size === originalSize));
    const shortcut = (key: string) =>
      browser.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
    const size = async (requested: number) => {
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.body.textContent?.includes("Interface size 100%.") === true,
          ),
        10_000,
      );
      for (const next of INTERFACE_SIZES.filter((item) => item > 100 && item <= requested)) {
        await shortcut("+");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (next) => document.body.textContent?.includes(`Interface size ${next}%.`) === true,
              next,
            ),
          10_000,
        );
      }
    };
    let failure: Error | undefined;
    let secondary: Error | undefined;
    try {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.equal(bootstrap.ready, true);
      assert.ok(samePath(required(bootstrap.library_root), library));
      const relative = path.relative(output, library);
      assert.ok(
        relative && !relative.startsWith("..") && !path.isAbsolute(relative),
        "Fresh owned library required",
      );
      assert.deepEqual(await sources(), []);
      assert.equal((await status()).active, null);
      assert.deepEqual(sessionIds(library), []);
      const prepared = await prepareGameFirstInstalledInputs(inputPaths, output);
      report.inputs = { metadata: prepared.metadata, captured_identities: prepared.identities };
      const port = required(
        transportValue("catalog", fixtureSuccess(await invoke("get_catalog"))).ports.find(
          (item) => item.id === portId,
        ),
      );
      assert.equal(port.adapter, "staged-source-portable");
      assert.equal(port.source_profile, sourceProfile);
      assert.equal(port.runtime_source_filename, "baserom.gba");
      assert.equal(port.runtime_source_materialization, "copy");
      const search = async (query: string) => {
        await selectPrimaryNavigation(browser, "Discover");
        await clearCatalogFilters(browser);
        const field = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
        await field.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, query);
        await browser.wait(
          async () => (await catalogResultPortIds(browser)).includes(portId),
          15_000,
        );
      };
      for (const query of [gameTitle(port), port.name]) {
        await search(query);
        assert.deepEqual(await catalogResultPortIds(browser), [portId]);
        const group = await browser.findElement(
          By.css('[data-detail-return-group="game:the-legend-of-zelda-the-minish-cap"]'),
        );
        assert.deepEqual(
          JSON.parse(required(await group.getAttribute("data-discover-matching-port-ids"))),
          [portId],
        );
        await selectCatalogPort(browser, portId);
        assert.equal((await browser.findElements(By.css(".port-comparison-dialog"))).length, 0);
        await browser.wait(
          until.elementLocated(By.css(`[data-detail-workspace][data-detail-port-id="${portId}"]`)),
          15_000,
        );
        await click(By.css(".detail-back"));
      }
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      await click(button("Add folder"));
      const picker = await chooseGameFileFolder("picori-original-folder", prepared.sourceDirectory);
      assert.ok(isRecord(picker) && picker.selected === true);
      // The registered roots and scanned candidates remain ordinary Core reads.
      await browser.wait(async () => {
        const value = transportValue(
          "desktop_game_file_roots",
          fixtureSuccess(await invoke("get_game_file_roots", { generation: bootstrap.generation })),
        );
        return value.some((root) => samePath(root.path, prepared.sourceDirectory));
      }, 15_000);
      await click(button("Refresh folders"));
      // Refresh reads saved state; the scan starts through its separate action.
      await click(button("Scan saved folders"));
      const candidate = By.css(
        `[data-completed-candidate][data-profile-id="${sourceProfile}"] [data-candidate-review]`,
      );
      await browser.wait(until.elementLocated(candidate), 180_000);
      assert.deepEqual(await sources(), [], "Scanning must not register an original");
      await click(candidate);
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      assert.deepEqual(await sources(), [], "Review must not register before consent");
      await click(button("Use current location"));
      await browser.wait(
        async () => (await sources()).some((item) => item.profile_id === sourceProfile),
        180_000,
      );
      const registered = required(
        (await sources()).find((item) => item.profile_id === sourceProfile),
      );
      assert.ok(samePath(registered.path, prepared.source));
      assert.equal(registered.sha256, prepared.metadata.source.sha256);
      assert.equal(registered.size, prepared.metadata.source.bytes);
      report.registered_source = registered;
      await selectPrimaryNavigation(browser, "Library");
      await click(button("Add games"));
      await click(By.css('button[aria-label="Use an existing installation"]'));
      await click(button("Copy an existing installation"));
      const dialog = By.css('[aria-labelledby="adopt-title"]');
      await browser.wait(until.elementLocated(dialog), 15_000);
      const field = await browser.findElement(By.id("adopt-path"));
      await field.clear();
      await field.sendKeys(prepared.runtimeDirectory);
      await click(button("Review copy plan"));
      const identity = await browser.wait(
        until.elementLocated(By.id("adopt-port-identity")),
        180_000,
      );
      assert.ok(
        (await identity.getText()).includes(portId),
        "The copy plan must name exact Picori",
      );
      await click(button("Continue to copy confirmation"), 180_000);
      await confirmNative(
        "Confirm existing installation copy",
        "Copy into Portcove",
        portId,
        "picori-real-adoption",
      );
      await browser.wait(async () => (await status()).active !== null, 180_000);
      await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 180_000);
      const installed = required((await status()).active);
      assert.equal(installed.port_id, portId);
      assert.match(installed.version, /^adopted-/u);
      assert.deepEqual(transportValue("status", core(["status", portId])), await status());
      const paths = transportValue("port_paths", core(["paths", portId]));
      assert.ok(samePath(required(paths.active_install_root), installed.path));
      const executable = path.resolve(installed.path, installed.selected_executable);
      assert.ok(samePath(executable, path.join(installed.path, "tmc_pc.exe")));
      const executableIdentity = await fileIdentity(executable, { maxBytes: 128 * 1024 ** 2 });
      assert.equal(
        executableIdentity.sha256,
        required(prepared.metadata.runtime_files.find((item) => item.path === "tmc_pc.exe")).sha256,
      );
      report.installation = {
        upstream_release: prepared.metadata.upstream_release,
        active: installed,
        paths,
        executableIdentity,
      };
      onManagedGame({ executable, installation: installed });
      const libraryCard = `[data-detail-origin="library:card:${portId}"]`;
      const libraryView = async () => {
        await selectPrimaryNavigation(browser, "Library");
        const query = await browser.findElement(By.id("port-search"));
        await query.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, port.name);
        await browser.wait(until.elementLocated(By.css(libraryCard)), 15_000);
        assert.equal(
          (await browser.findElements(By.css(`[data-detail-game-id="${portId}"]`))).length,
          1,
        );
      };
      await libraryView();
      const favorite = By.css(`button[aria-label="Favorite ${gameIdentityLabel(port)}"]`);
      assert.equal((await favorites()).includes(portId), false);
      await click(favorite);
      await browser.wait(async () => (await favorites()).includes(portId), 15_000);
      await click(By.css(libraryCard));
      await browser.wait(until.elementLocated(By.css(`[data-detail-port-id="${portId}"]`)), 15_000);
      await click(By.css(".detail-back"));
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (id) => document.activeElement?.getAttribute("data-detail-game-id") === id,
            portId,
          ),
        10_000,
      );
      const capture = async (name: string, selector: string, expectedSize: number) => {
        const target = await browser.wait(until.elementLocated(By.css(selector)), 15_000);
        const preparedTarget = await prepareCaptureTarget({
          target: selector,
          label: name,
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
          name,
          scenario: gameFirstInstalledScenarioId,
          target: selector,
          observeTarget: async () => {
            const observed = await executeBrowserScript(
              browser,
              observeVisibleTarget,
              selector,
              "visual" as const,
            );
            requireUnchangedCaptureTarget(preparedTarget.observation, observed);
            return observed;
          },
          readiness: () =>
            executeBrowserScript(
              browser,
              (expected) => ({
                ready:
                  document.fonts.status === "loaded" &&
                  document.body.textContent?.includes(`Interface size ${expected}%.`) === true,
              }),
              expectedSize,
            ),
        });
        artifacts.push(captured.image.path, captured.receipt);
      };
      const playTarget = `article:has(${libraryCard}) button.library-card-play`;
      const playControl = await browser.findElement(By.css(playTarget));
      assert.equal(await playControl.getText(), "Play");
      assert.equal(await playControl.isEnabled(), true);
      for (const layout of [
        { name: "ordinary", width: 1280, height: 900, size: 100 },
        { name: "narrow", width: 960, height: 640, size: 100 },
        { name: "enlarged-200", width: 960, height: 640, size: 200 },
      ]) {
        await size(layout.size);
        await browser.manage().window().setRect({ width: layout.width, height: layout.height });
        await capture(
          `picori-library-title-${layout.name}`,
          `${libraryCard} .collection-title`,
          layout.size,
        );
        await capture(`picori-library-play-${layout.name}`, playTarget, layout.size);
      }
      await size(100);
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      await captureAccessibilityReport(
        browser,
        path.join(output, "picori-installed-accessibility.json"),
        artifacts,
      );
      const launch = await launchManagedPicori({
        context: { ...context, browser },
        installed,
        executableIdentity,
        play: () => click(By.css(playTarget)),
        core,
        prefix: "picori",
      });
      report.launch = launch;
      report.game_frame = launch.game_frame;
      const afterGame = await status();
      assert.ok(afterGame.successful_launches >= 1 && afterGame.last_launched_at !== null);
      const saved = {
        status: afterGame,
        sources: await sources(),
        organization: await organization(),
        favorites: await favorites(),
        sessions: sessionIds(library),
        userData: await userDataInventory(paths.user_data_root),
      };
      report.before_restart = saved;
      browser = await context.restartApplication("picori-real-managed-restart");
      await libraryView();
      assert.deepEqual(await status(), saved.status);
      assert.deepEqual(await sources(), saved.sources);
      assert.deepEqual(await organization(), saved.organization);
      assert.deepEqual(await favorites(), saved.favorites);
      assert.deepEqual(sessionIds(library), saved.sessions);
      assert.deepEqual(await userDataInventory(paths.user_data_root), saved.userData);
      assert.equal(
        await (await browser.findElement(favorite)).getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(await (await browser.findElement(By.css(playTarget))).isEnabled(), true);
      // Refuse only proxy-aware provider traffic in this application's child
      // environment. Definition traffic deliberately bypasses these proxies.
      const provider: Record<string, unknown> = {
        scope: "Scoped loopback proxy refusal of proxy-aware provider requests",
        total_network_offline: "not-evaluated",
        definition_unavailable: "not-evaluated",
      };
      report.provider_unavailable = provider;
      let providerFailure: Error | undefined;
      let providerCleanupFailure: Error | undefined;
      let afterProviderLaunch: typeof saved | undefined;
      let providerDenialObserved = false;
      const durableState = async () => {
        const current = await status();
        return {
          active: current.active,
          previous: current.previous,
          staged: current.staged,
          channel: current.channel,
          update_policy: current.update_policy,
          sources: await sources(),
          organization: await organization(),
          favorites: await favorites(),
        };
      };
      const durableBefore = await durableState();
      const refusal = await createImageRefusal();
      try {
        browser = await context.restartApplication(
          "picori-provider-refused",
          undefined,
          refusal.environment,
        );
        await libraryView();
        assert.deepEqual(await durableState(), durableBefore);
        assert.deepEqual(await userDataInventory(paths.user_data_root), saved.userData);
        const beforeChecks = new Set(
          transportValue("activity", fixtureSuccess(await invoke("get_activities"))).records.map(
            (record) => record.id,
          ),
        );
        await selectPrimaryNavigation(browser, "Activity");
        const updatesTab = await browser.findElement(
          By.xpath(
            '//*[@role="tablist" and @aria-label="Activity sections"]//*[@role="tab" and text()[normalize-space(.)="Game updates"]]',
          ),
        );
        await clickVisible(browser, updatesTab);
        await browser.wait(
          async () => (await updatesTab.getAttribute("aria-selected")) === "true",
          5000,
        );
        const beforeTraffic = refusal.origins.length;
        await click(button("Check installed ports for updates"));
        const failureRegion = await browser.wait(
          until.elementLocated(By.css(`[data-update-check-failure="${portId}"]`)),
          60_000,
        );
        assert.equal(
          await failureRegion.getAttribute("aria-label"),
          `Update check failure for ${port.name}`,
        );
        const failedCheck = await browser.wait(async () => {
          const records = transportValue(
            "activity",
            fixtureSuccess(await invoke("get_activities")),
          ).records;
          return (
            records.find(
              (record) =>
                !beforeChecks.has(record.id) &&
                record.operation === "check_update" &&
                record.target_id === portId &&
                record.status === "failed" &&
                record.finished_at !== null,
            ) || false
          );
        }, 60_000);
        assert.ok(failedCheck);
        const refusedRequests = refusal.origins.slice(beforeTraffic);
        providerDenialObserved =
          required(failedCheck.failure).code === "network" &&
          refusedRequests.includes("other-origin");
        provider.failed_check = failedCheck;
        provider.refused_origins_during_check = refusedRequests;
        provider.failure_ui = await failureRegion.getText();
        assert.deepEqual(await durableState(), durableBefore);
        assert.deepEqual(sessionIds(library), saved.sessions);
        assert.deepEqual(await userDataInventory(paths.user_data_root), saved.userData);
        if (providerDenialObserved) {
          await libraryView();
          assert.equal(await (await browser.findElement(By.css(playTarget))).isEnabled(), true);
          await capture("picori-provider-unavailable-play", playTarget, 100);
          provider.launch = await launchManagedPicori({
            context: { ...context, browser, operatorObservation: false },
            installed,
            executableIdentity,
            play: () => click(By.css(playTarget)),
            core,
            prefix: "picori-provider-unavailable",
          });
          assert.deepEqual(await durableState(), durableBefore);
          const current = await status();
          assert.equal(current.successful_launches, saved.status.successful_launches + 1);
          assert.ok(required(current.last_launched_at) >= required(saved.status.last_launched_at));
          const ids = sessionIds(library);
          assert.equal(ids.length, saved.sessions.length + 1);
          assert.ok(saved.sessions.every((id) => ids.includes(id)));
        } else {
          provider.status = "held";
          provider.reason =
            "The adopted installation did not establish a provider network failure with matching scoped proxy traffic; a normal GitHub-installed artifact may be required. No policy change or retry was performed.";
          assert.equal((await status()).successful_launches, saved.status.successful_launches);
        }
        afterProviderLaunch = {
          status: await status(),
          sources: await sources(),
          organization: await organization(),
          favorites: await favorites(),
          sessions: sessionIds(library),
          userData: await userDataInventory(paths.user_data_root),
        };
        provider.after_observation = afterProviderLaunch;
      } catch (error) {
        providerFailure = retainedError(error);
        provider.failure = errorMessage(error);
      } finally {
        // Restore the real application environment even when the refused request
        // or launch failed; closing this listener alone cannot restore the child.
        try {
          browser = await context.restartApplication("picori-provider-environment-restored");
        } catch (error) {
          providerCleanupFailure = retainedError(error);
          provider.restore_failure = errorMessage(error);
          console.error("Picori provider environment restoration failed:", errorMessage(error));
        }
        try {
          await refusal.close();
        } catch (error) {
          providerCleanupFailure ??= retainedError(error);
          provider.refusal_close_failure = errorMessage(error);
          console.error("Picori scoped refusal cleanup failed:", errorMessage(error));
        }
      }
      if (providerFailure) throw providerFailure;
      if (providerCleanupFailure) throw providerCleanupFailure;
      const preserved = required(afterProviderLaunch);
      await libraryView();
      assert.deepEqual(await status(), preserved.status);
      assert.deepEqual(await durableState(), durableBefore);
      assert.deepEqual(await sources(), preserved.sources);
      assert.deepEqual(await organization(), preserved.organization);
      assert.deepEqual(await favorites(), preserved.favorites);
      assert.deepEqual(sessionIds(library), preserved.sessions);
      assert.deepEqual(await userDataInventory(paths.user_data_root), preserved.userData);
      assert.equal(await (await browser.findElement(By.css(playTarget))).isEnabled(), true);
      if (providerDenialObserved)
        provider.status = "scoped-provider-unavailable-preservation-observed";
      provider.restored_environment_restart_preserved_state = true;
      await verifyGameFirstInstalledInputs(
        inputPaths,
        prepared.metadata,
        prepared.metadataIdentity,
      );
      for (const file of prepared.metadata.runtime_files) {
        for (const directory of [prepared.runtimeDirectory, installed.path]) {
          const current = await fileIdentity(path.join(directory, file.path), {
            maxBytes: file.bytes,
          });
          assert.equal(current.sha256, file.sha256);
        }
      }
      assert.equal(
        (await fileIdentity(prepared.source, { maxBytes: prepared.metadata.source.bytes })).sha256,
        prepared.metadata.source.sha256,
      );
      assert.equal(
        (
          await fileIdentity(path.join(prepared.runtimeDirectory, "baserom.gba"), {
            maxBytes: prepared.metadata.source.bytes,
          })
        ).sha256,
        prepared.metadata.source.sha256,
      );
      report.restart_preserved_observed_state = true;
      report.outcome = "bounded-managed-journey-complete";
    } catch (error) {
      failure = retainedError(error);
      report.outcome = "failed";
      report.failure = errorMessage(error);
    } finally {
      try {
        await size(originalSize);
        await browser.manage().window().setRect(originalWindow);
      } catch (error) {
        secondary = retainedError(error);
        report.appearance_cleanup_failure = errorMessage(error);
        if (failure)
          console.error(
            "Picori appearance restoration failed while preserving the original scenario failure:",
            errorMessage(error),
          );
      }
      try {
        const file = path.join(output, "game-first-installed-picori.json");
        await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        artifacts.push(file);
      } catch (error) {
        secondary ??= retainedError(error);
        console.error("Picori result retention failed; original failure retained");
      }
    }
    if (failure) throw failure;
    if (secondary) throw secondary;
  });
}

async function launchManagedPicori({
  context,
  installed,
  executableIdentity,
  play,
  core,
  prefix,
}: {
  context: GameFirstInstalledContext;
  installed: InstallRecord;
  executableIdentity: FileIdentity;
  play: () => Promise<void>;
  core: (args: readonly string[]) => unknown;
  prefix: string;
}) {
  const { browser, application, library, output, artifacts } = context;
  assert.match(prefix, /^[a-z0-9-]+$/u);
  const route: Record<string, unknown> = {
    gameplay: "not-evaluated",
    game_frame: { status: "unavailable" },
  };
  const appIdentity = await fileIdentity(application);
  const native = <Mode extends NativeSessionMode>(
    mode: Mode,
    snapshot: string,
    extra: string[] = [],
  ): NativeSessionObservations[Mode] => {
    const result = spawnCommand(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        nativeSessionScript,
        "-Mode",
        mode,
        "-SnapshotPath",
        snapshot,
        ...extra,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return readNativeSessionObservation(mode, JSON.parse(result.stdout));
  };
  const before = new Set(sessionIds(library));
  const earliest = Date.now();
  let failure: Error | undefined;
  let secondary: Error | undefined;
  let closeFile: string | undefined;
  let closeAttempted = false;
  let observedExit = false;
  try {
    await play();
    const session = await browser.wait(async () => {
      const fresh = sessionIds(library).filter((id) => !before.has(id));
      assert.ok(fresh.length <= 1, "One Play must create exactly one managed session");
      if (!fresh[0]) return false;
      const current = required(
        transportValue("launch_request", core(["launch", "show", fresh[0]])),
      );
      assert.equal(current.owner_kind, "managed");
      assert.equal(current.port_id, portId);
      assert.equal(current.install_id, installed.id);
      assert.ok(samePath(current.install_root, installed.path));
      assert.equal(current.outcome, null, "Retain early game failures");
      return current.phase === "running" &&
        current.child_pid &&
        current.child_identity &&
        current.supervisor_identity
        ? current
        : false;
    }, 30_000);
    assert.ok(
      session && session.child_pid && session.child_identity && session.supervisor_identity,
    );
    route.session = session;
    const supervisorFile = path.join(output, `${prefix}-supervisor-identity.json`);
    const supervisor = native("SnapshotDriver", supervisorFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
    ]);
    artifacts.push(supervisorFile);
    assert.equal(supervisor.driver.pid, session.supervisor_pid);
    assert.ok(samePath(supervisor.driver.path, application));
    assert.equal(
      `windows-filetime:${supervisor.driver.started_filetime}`,
      session.supervisor_identity,
    );
    assert.equal((await fileIdentity(supervisor.driver.path)).sha256, appIdentity.sha256);
    const gameFile = path.join(output, `${prefix}-game-identity.json`);
    const game = native("SnapshotApplication", gameFile, [
      "-DriverProcessId",
      String(session.child_pid),
      "-ExpectedParentProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executableIdentity.path,
      "-ExpectedApplicationSha256",
      executableIdentity.sha256,
    ]);
    artifacts.push(gameFile);
    assert.equal(game.driver.pid, session.child_pid);
    assert.equal(`windows-filetime:${game.driver.started_filetime}`, session.child_identity);
    assert.ok(samePath(game.driver.path, executableIdentity.path));
    const ticks = (value: string) => Number((BigInt(value) - 116444736000000000n) / 10000n);
    assert.ok(ticks(supervisor.driver.started_filetime) >= earliest - 1000);
    assert.ok(BigInt(game.driver.started_filetime) >= BigInt(supervisor.driver.started_filetime));
    closeFile = path.join(output, `${prefix}-game-close-identity.json`);
    const close = native("Snapshot", closeFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executableIdentity.path,
    ]);
    artifacts.push(closeFile);
    assert.deepEqual(close.driver, supervisor.driver);
    assert.equal(close.application_pid, session.child_pid);
    assert.deepEqual(
      close.processes.filter((item) => item.pid === session.child_pid),
      [game.driver],
    );
    route.live_game = { supervisor, game, close, executableIdentity };
    if (context.captureGameFrame) {
      const frame = await context.captureGameFrame({
        name: `${prefix}-real-runtime`,
        session,
        executable: executableIdentity.path,
        executableSha256: executableIdentity.sha256,
        game,
        output,
        artifacts,
      });
      if (frame.status === "captured") {
        const relative = path.relative(output, frame.artifact);
        assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
        route.game_frame = {
          ...frame,
          identity: await fileIdentity(frame.artifact, { maxBytes: 32 * 1024 ** 2 }),
        };
        if (!artifacts.includes(frame.artifact)) artifacts.push(frame.artifact);
      } else route.game_frame = frame;
    }
    if (context.operatorObservation) {
      await observeRegisteredRuntimeExit({
        session,
        snapshot: gameFile,
        native,
        wait: (observe, timeout) => browser.wait(observe, timeout, undefined, 2000),
        route,
      });
      observedExit = true;
    } else {
      closeAttempted = true;
      await requestRealRuntimeClose({
        native,
        closeFile,
        executable: executableIdentity.path,
        requestFile: path.join(output, `${prefix}-ordinary-game-close.json`),
        route,
        artifacts,
        write: writeFile,
      });
    }
    const terminal = await browser.wait(() => {
      const value = required(
        transportValue("launch_request", core(["launch", "show", session.id])),
      );
      return value.outcome !== null && value.finished_at ? value : false;
    }, 30_000);
    assert.ok(terminal);
    route.terminal = terminal;
    assert.equal(terminal.outcome, "succeeded");
    assert.equal(terminal.exit_code, 0);
    const supervisorExit = path.join(output, `${prefix}-supervisor-exit-identity.json`);
    await writeFile(
      supervisorExit,
      JSON.stringify({
        ...supervisor,
        processes: [supervisor.driver],
        source_snapshot: supervisorFile,
        derivation: "verified-supervisor-only-exit-observation",
      }),
      { flag: "wx" },
    );
    artifacts.push(supervisorExit);
    const supervisorExited = native("Wait", supervisorExit);
    assert.equal(supervisorExited.observed_processes, 1);
    route.supervisor_exit = supervisorExited;
    assert.deepEqual(sessionIds(library).toSorted(), [...before, session.id].sort());
  } catch (error) {
    failure = retainedError(error);
    route.failure = errorMessage(error);
  } finally {
    try {
      if (closeFile && !closeAttempted && !observedExit) {
        const observation = native("Observe", closeFile);
        route.failure_exit_observation = observation;
        const liveGame = observation.processes.find((entry) =>
          samePath(entry.path, executableIdentity.path),
        );
        assert.ok(liveGame, "Failure cleanup requires the already verified game identity");
        if (liveGame.state === "running")
          await requestRealRuntimeClose({
            native,
            closeFile,
            executable: executableIdentity.path,
            requestFile: path.join(output, `${prefix}-failure-ordinary-close.json`),
            route,
            artifacts,
            write: writeFile,
          });
      }
    } catch (error) {
      route.secondary_close_failure = errorMessage(error);
      secondary = retainedError(error);
      console.error(
        "Picori ordinary close failed while preserving the original scenario failure:",
        errorMessage(error),
      );
    } finally {
      try {
        const file = path.join(output, `${prefix}-managed-launch.json`);
        await writeFile(file, JSON.stringify(route, null, 2), { flag: "wx" });
        artifacts.push(file);
      } catch (error) {
        secondary ??= retainedError(error);
        console.error("Picori launch retention failed; original failure retained");
      }
    }
  }
  if (failure) throw failure;
  if (secondary) throw secondary;
  return route;
}
