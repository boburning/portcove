import { readStagedLayout, assertStagedActionPlacement } from "./desktop-staged-layout.mts";
import {
  fixtureSuccess as success,
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { WebDriver } from "selenium-webdriver";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { BoundaryInvoke } from "./desktop-main-webview-boundary.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type { CapturedNativeProcess, NativeManagedGame } from "./desktop-owned-native-session.mts";
import type {
  ActivityStatus,
  InstallRecord,
  GameUpdateAcquisition,
} from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
import { gameIdentityLabel } from "../src/port-identity.ts";
type InstallFixture = Awaited<ReturnType<typeof createInstallFixture>>;
type FixturePort = InstallFixture["port"];
export interface OwnedAcquisitionGame {
  identity: CapturedNativeProcess;
  snapshot: string;
}
export interface AcquisitionGameObserver {
  capture(game: NativeManagedGame, name: string): OwnedAcquisitionGame | null;
  observe(game: OwnedAcquisitionGame, name: string): "running" | "exited";
}
interface InstallContext extends ScenarioContext {
  invoke: BoundaryInvoke;
  library: string;
  inputs: FileIdentity[];
  fixture: InstallFixture | undefined;
  ownedGameProcess?: AcquisitionGameObserver | undefined;
  confirmNative?: ReturnType<typeof nativeConfirmation> | undefined;
  restartApplication: (name: string, prepare?: () => Promise<void>) => Promise<WebDriver>;
}
interface InstallWindow extends Window {
  __TAURI_INTERNALS__?: { convertFileSrc(command: string, protocol: string): string };
  __portcoveInstallRefreshProbe?: {
    original: typeof fetch;
    target: string;
    calls: string[];
    failing: boolean;
    injected: number;
  };
}
interface RefreshObservations {
  port_id: string;
  injection: string;
  failure_text?: string;
  activity_id?: string;
  installed?: InstallRecord;
  request?: InstallFixture["requests"][number];
  commands_before_retry?: string[];
  commands_after_retry?: string[];
  retry_commands?: string[];
  retry_did_not_repeat_install?: boolean;
  failure?: string;
  probe?:
    | { installed: false }
    | {
        installed: true;
        injected: number;
        failing: boolean;
        commands: string[];
        restored: boolean;
      };
}
function fixtureHash(port: FixturePort) {
  return required(port.release.direct[required(port.platforms[0])]).sha256;
}
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  revealDetailSection,
  chooseGameUpdateDisposition,
  selectCatalogPort,
} from "./desktop-review-controls.mts";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
} from "./desktop-review-controls.mts";

async function exists(candidate: string) {
  return stat(candidate).then(
    () => true,
    () => false,
  );
}

async function waitForFixture(predicate: () => boolean | undefined, message: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function selectInstallTheme(browser: WebDriver, theme: "dark" | "light") {
  await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
  await browser
    .findElement(
      By.css('nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]'),
    )
    .click();
  await browser
    .findElement(
      By.xpath(
        `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
      ),
    )
    .click();
  assert.equal(
    await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
    theme,
  );
}

export async function installScenarios({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  inputs,
  fixture,
  ownedGameProcess,
  confirmNative,
  restartApplication,
}: InstallContext) {
  const statuses = async () => transportValues("status", success(await invoke("get_statuses")));
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const buttonStarting = (label: string) =>
    By.xpath(`//button[starts-with(normalize-space(.),"${label}")]`);
  const openFixture = async (port: FixturePort, installed = false) => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      Key.BACK_SPACE,
      port.name,
    );
    await selectCatalogPort(browser, port.id);
    if (!installed) await browser.wait(until.elementLocated(button("Review installation")), 15_000);
  };
  const reviewAndStart = async ({ inspect = false } = {}) => {
    const trigger = await browser.findElement(button("Review installation"));
    await trigger.click();
    const dialog = By.css('[aria-labelledby="install-review-title"]');
    await browser.wait(until.elementLocated(dialog), 15_000);
    const install = buttonStarting("Install ·");
    await browser.wait(until.elementLocated(install), 15_000);
    await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
    if (inspect) {
      const reviewText = await browser.findElement(dialog).getText();
      const response = object(
        await invoke("plan_port", {
          portId: required(fixture).port.id,
          channel: "stable",
        }),
      );
      assert.equal(response.ok, true, `Plan inspection failed: ${JSON.stringify(response.error)}`);
      const reviewedPlan = transportValue("install_plan", response.value);
      assert.equal(reviewedPlan.action, "download");
      assert.match(reviewText, /Review the version, download size, and install folder\./);
      assert.match(reviewText, /Install folder/);
      assert.equal(
        await browser.findElement(By.css(".install-plan-destination code")).getText(),
        reviewedPlan.output_location.effective_output_directory,
        "Install review must show the planned output folder",
      );
      await assertPrimaryReviewAction(
        browser,
        await browser.findElement(install),
        await browser.findElement(button("Cancel review")),
      );
      await assertCompactReview(browser, '[aria-labelledby="install-review-title"]');
      const accessibility = path.join(output, "install-review-accessibility.json");
      await captureAccessibilityReport(browser, accessibility, artifacts);
      const screenshot = path.join(output, "native-install-review.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(dialog)).length === 0,
        5_000,
        "Install review did not close after Escape",
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            'return document.activeElement?.textContent?.trim() === "Review installation";',
          ),
        5_000,
        "Install review trigger did not regain focus after Escape",
      );
      await browser.findElement(button("Review installation")).click();
      await browser.wait(until.elementLocated(dialog), 15_000);
      await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
    }
    const previousInvocations = await executeBrowserScript(browser, () =>
      [...document.querySelectorAll<HTMLElement>("[data-invocation-id]")].map(
        (element) => element.dataset.invocationId,
      ),
    );
    await browser.findElement(install).click();
    const invocationId = await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (previous) => {
            const added = [...document.querySelectorAll<HTMLElement>("[data-invocation-id]")]
              .map((element) => element.dataset.invocationId)
              .filter((id) => id && !previous.includes(id));
            return added.length === 1 ? added[0] : false;
          },
          previousInvocations,
        ),
      5_000,
      "Reviewed install did not create exactly one owned invocation",
    );
    assert.ok(typeof invocationId === "string");
    return invocationId;
  };
  const installActivity = async (port: FixturePort, status: ActivityStatus) => {
    const feed = transportValue("activity", success(await invoke("get_activities")));
    assert.ok(Array.isArray(feed.records));
    return feed.records.find(
      (item) =>
        item.operation === "install" && item.target_id === port.id && item.status === status,
    );
  };

  await scenario("install-progress-cancellation", async () => {
    assert.ok(fixture, "install fixture must be initialized before the Desktop starts");
    const port = fixture.port;

    await openFixture(port);
    await reviewAndStart({ inspect: true });
    await waitForFixture(
      () => (fixture.requests[0]?.bytes_sent ?? 0) > 0,
      "reviewed install never requested the fixture artifact",
    );
    const cancel = button("Cancel operation");
    await browser.wait(until.elementLocated(cancel), 15_000);
    const running = required(
      await browser.wait(async () => installActivity(port, "running"), 15_000),
    );
    assert.equal(required(running.cancellation).phase, "preparing");
    assert.equal(required(running.cancellation).requested, false);
    await browser.findElement(cancel).click();
    const cancelled = required(
      await browser.wait(async () => installActivity(port, "cancelled"), 15_000),
    );
    assert.equal(cancelled.id, running.id);
    assert.equal(required(cancelled.failure).code, "cancelled");
    assert.equal(required(cancelled.failure).presentation.tone, "neutral");
    await waitForFixture(
      () => fixture.requests[0]?.connection_closed,
      "cancelled install did not close its fixture download",
    );
    assert.equal(required(fixture.requests[0]).completed, false);
    assert.ok(required(fixture.requests[0]).bytes_sent < fixture.artifact.length);
    assert.equal(await exists(path.join(library, "staging", running.id)), false);
    const cancelledStatuses = await statuses();
    const afterCancellation = cancelledStatuses.find((item) => item.port_id === port.id);
    assert.ok(afterCancellation);
    assert.equal(afterCancellation.active, null);
    assert.equal(afterCancellation.staged, null);
    assert.equal(afterCancellation.previous, null);

    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await openFixture(port);
    const completedInvocationId = await reviewAndStart();
    await waitForFixture(
      () => fixture.requests.length >= 2,
      "freshly reviewed retry never requested the fixture artifact",
    );
    const succeeded = required(
      await browser.wait(async () => installActivity(port, "succeeded"), 30_000),
    );
    assert.notEqual(succeeded.id, cancelled.id);
    assert.equal(required(fixture.requests[1]).completed, true);
    assert.equal(required(fixture.requests[1]).bytes_sent, fixture.artifact.length);
    const succeededStatuses = await statuses();
    const installed = succeededStatuses.find((item) => item.port_id === port.id);
    assert.ok(installed?.active);
    assert.equal(installed.active.artifact.sha256, fixtureHash(port));
    assert.equal(installed.active.artifact.size, fixture.artifact.length);
    assert.equal(installed.staged, null);
    assert.equal(await exists(path.join(library, "staging", succeeded.id)), false);
    assert.equal(
      await exists(path.join(installed.active.path, installed.active.selected_executable)),
      true,
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (id) => {
            const record = [...document.querySelectorAll<HTMLElement>("[data-invocation-id]")].find(
              (element) => element.dataset.invocationId === id,
            );
            return (
              record
                ?.querySelector('p[role="status"]')
                ?.textContent?.trim()
                .endsWith(": finished.") === true
            );
          },
          completedInvocationId,
        ),
      15_000,
      "Installed fixture's exact invocation did not settle before the next journey",
    );

    const report = path.join(output, "install-progress-cancellation.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          port_id: port.id,
          artifact: installed.active.artifact,
          cancelled_activity: cancelled.id,
          succeeded_activity: succeeded.id,
          succeeded_invocation_id: completedInvocationId,
          requests: fixture.requests,
          private_staging_absent: true,
          retry_installed_path: installed.active.path,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
    const accessibility = path.join(output, "install-cancellation-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
  });

  await scenario("install-commit-refresh-recovery", async () => {
    assert.ok(fixture, "install fixture must be initialized before the Desktop starts");
    const port = fixture.refreshPort;
    assert.ok(port, "install refresh fixture must be present in the isolated catalog");
    const requestIndex = fixture.requests.length;
    const observations: RefreshObservations = {
      port_id: port.id,
      injection:
        "a temporary get_workspace_snapshot failure window after the real install commit; explicit retry restores actual native IPC",
    };
    await openFixture(port);
    try {
      const installedProbe = await browser.executeAsyncScript<unknown>(
        (done: (value: unknown) => void) => {
          const runtime = window as InstallWindow;
          const native = runtime.__TAURI_INTERNALS__;
          if (!native) throw new Error("Native bridge unavailable");
          const original = window.fetch;
          const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
          runtime.__portcoveInstallRefreshProbe = {
            original,
            target,
            calls: [],
            failing: true,
            injected: 0,
          };
          window.fetch = function (input, ...args) {
            const probe = runtime.__portcoveInstallRefreshProbe;
            if (!probe) throw new Error("Install refresh probe unavailable");
            // Preserve the existing coercion for cross-realm request-like inputs.
            const url =
              typeof input === "string"
                ? input
                : ((typeof input === "object" && input !== null && "url" in input
                    ? input.url
                    : undefined) ??
                  // oxlint-disable-next-line typescript/no-base-to-string
                  String(input));
            const parsed = new URL(url, location.href);
            if (parsed.hostname === "ipc.localhost")
              probe.calls.push(decodeURIComponent(parsed.pathname.slice(1)));
            if (url === probe.target && probe.failing) {
              probe.injected++;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    code: "state",
                    message: "synthetic-post-install-refresh-failure",
                    details: {},
                    presentation: {
                      presentation_key: "state_unavailable",
                      summary: "Library information is temporarily unavailable.",
                      tone: "error",
                      mutation_state: "unknown",
                      phase: null,
                      recovery_actions: ["review_current_state", "view_technical_details"],
                      technical_message:
                        "Synthetic post-install refresh rejection for presentation verification.",
                      technical_context: {},
                    },
                  }),
                  {
                    headers: {
                      "Content-Type": "application/json",
                      "Tauri-Response": "error",
                    },
                  },
                ),
              );
            }
            return original.call(window, input, ...args);
          };
          done({ installed: true });
        },
      );
      assert.equal(object(installedProbe).installed, true);

      await reviewAndStart();
      const succeeded = required(
        await browser.wait(async () => installActivity(port, "succeeded"), 30_000),
      );
      const retry = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Retry refresh"]')),
        15_000,
      );
      observations.failure_text = await executeBrowserScript(
        browser,
        (element) => element.closest(".error-banner")?.textContent ?? "",
        retry,
      );
      assert.match(observations.failure_text, /Showing the last loaded information/);
      assert.match(observations.failure_text, /does not repeat your last install/i);
      assert.doesNotMatch(
        observations.failure_text,
        /No files were changed|synthetic-post-install-refresh-failure/,
      );
      assert.equal(
        (
          await browser.findElements(
            By.xpath('//*[contains(normalize-space(.),"Portcove couldn’t finish that action")]'),
          )
        ).length,
        0,
      );

      const statusResult = await statuses();
      const installed = statusResult.find((item) => item.port_id === port.id);
      assert.ok(installed?.active);
      assert.equal(installed.active.artifact.size, fixture.artifact.length);
      assert.equal(installed.active.artifact.sha256, fixtureHash(port));
      assert.equal(installed.staged, null);
      assert.equal(await exists(path.join(library, "staging", succeeded.id)), false);
      assert.equal(fixture.requests.length, requestIndex + 1);
      assert.equal(required(fixture.requests[requestIndex]).completed, true);
      assert.equal(required(fixture.requests[requestIndex]).bytes_sent, fixture.artifact.length);

      observations.activity_id = succeeded.id;
      observations.installed = installed.active;
      observations.request = required(fixture.requests[requestIndex]);
      observations.commands_before_retry = await executeBrowserScript(browser, () => {
        const runtime = window as InstallWindow;
        if (!runtime.__portcoveInstallRefreshProbe)
          throw new Error("Install refresh probe unavailable");
        return runtime.__portcoveInstallRefreshProbe.calls;
      });
      assert.equal(
        observations.commands_before_retry.filter((command) => command === "install_port").length,
        1,
      );
      assert.ok(
        (await executeBrowserScript(browser, () => {
          const runtime = window as InstallWindow;
          if (!runtime.__portcoveInstallRefreshProbe)
            throw new Error("Install refresh probe unavailable");
          return runtime.__portcoveInstallRefreshProbe.injected;
        })) > 0,
      );

      const failureScreenshot = path.join(output, "native-install-refresh-failure.png");
      await writeFile(failureScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(failureScreenshot);
      const accessibility = path.join(output, "install-refresh-failure-accessibility.json");
      await captureAccessibilityReport(browser, accessibility, artifacts);

      assert.equal(
        await executeBrowserScript(browser, () => {
          const runtime = window as InstallWindow;
          if (!runtime.__portcoveInstallRefreshProbe)
            throw new Error("Install refresh probe unavailable");
          const retryButton = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "Retry refresh",
          );
          if (!retryButton) return false;
          runtime.__portcoveInstallRefreshProbe.failing = false;
          retryButton.click();
          return true;
        }),
        true,
      );
      await browser.wait(async () => {
        const buttons = await browser.findElements(
          By.xpath('//button[normalize-space(.)="Retry refresh"]'),
        );
        return buttons.length === 0;
      }, 15_000);
      await browser.wait(
        until.elementLocated(By.xpath('//*[normalize-space(.)="Ready to play"]')),
        15_000,
      );
      observations.commands_after_retry = await executeBrowserScript(browser, () => {
        const runtime = window as InstallWindow;
        if (!runtime.__portcoveInstallRefreshProbe)
          throw new Error("Install refresh probe unavailable");
        return runtime.__portcoveInstallRefreshProbe.calls;
      });
      observations.retry_commands = observations.commands_after_retry.slice(
        observations.commands_before_retry.length,
      );
      const retryAndBackgroundCommands = new Set([
        "get_activities",
        "get_workspace_changed",
        "get_workspace_snapshot",
        "discover_orphaned_operations",
      ]);
      assert.ok(observations.retry_commands.includes("get_workspace_snapshot"));
      assert.ok(
        observations.retry_commands.every((command) => retryAndBackgroundCommands.has(command)),
        JSON.stringify(observations.retry_commands),
      );
      assert.equal(
        observations.commands_after_retry.filter((command) => command === "install_port").length,
        1,
      );
      assert.equal(fixture.requests.length, requestIndex + 1);
      observations.retry_did_not_repeat_install = true;
    } catch (error) {
      observations.failure = errorMessage(error);
      throw error;
    } finally {
      try {
        observations.probe = await executeBrowserScript(browser, () => {
          const runtime = window as InstallWindow;
          const probe = runtime.__portcoveInstallRefreshProbe;
          if (!probe) return { installed: false as const };
          window.fetch = probe.original;
          const result = {
            installed: true as const,
            injected: probe.injected,
            failing: probe.failing,
            commands: probe.calls,
            restored: window.fetch === probe.original,
          };
          delete runtime.__portcoveInstallRefreshProbe;
          return result;
        });
        assert.ok(observations.probe.installed);
        assert.equal(observations.probe.restored, true);
      } finally {
        const report = path.join(output, "install-commit-refresh-recovery.json");
        await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
        artifacts.push(report);
      }
    }
  });

  const captureStagedLayouts = async (port: FixturePort, version: string) => {
    const originalWindow = await browser.manage().window().getRect();
    const layouts = [];
    try {
      for (const theme of ["dark", "light"] as const) {
        await selectInstallTheme(browser, theme);
        await openFixture(port, true);
        for (const { width, height } of [
          { width: 960, height: 640 },
          { width: 1280, height: 800 },
        ]) {
          await browser.manage().window().setRect({ width, height });
          await revealDetailSection(browser, "Versions & updates");
          const layout = await executeBrowserScript(browser, readStagedLayout, version);
          const geometry = path.join(
            output,
            `native-staged-update-${theme}-${width}x${height}.json`,
          );
          await writeFile(geometry, JSON.stringify({ theme, width, height, ...layout }, null, 2), {
            flag: "wx",
          });
          artifacts.push(geometry);
          const screenshot = path.join(
            output,
            `native-staged-update-${theme}-${width}x${height}.png`,
          );
          await writeFile(screenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(screenshot);
          assert.ok(layout.play && layout.activate, JSON.stringify(layout));
          assert.equal(layout.play.enabled, true, JSON.stringify(layout));
          assert.equal(layout.activate.enabled, true, JSON.stringify(layout));
          assert.equal(layout.documentOverflow, false, JSON.stringify(layout));
          assert.equal(layout.state, "Ready to play");
          assert.equal(layout.reason ?? null, null);
          assert.ok(layout.attention?.includes(`Update saved for later · ${version}`));
          assert.ok(layout.activate.left >= 0 && layout.activate.right <= width + 1);
          assert.ok(layout.play.left >= 0 && layout.play.right <= width + 1);
          assertStagedActionPlacement(layout);
          layouts.push({ theme, width, height, ...layout });
        }
      }
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
    return layouts;
  };

  await scenario("native-staged-update-composition", async () => {
    assert.ok(fixture?.refreshPort, "isolated install fixture is required");
    assert.equal(typeof restartApplication, "function");
    const port = fixture.refreshPort;
    const beforeResult = await statuses();
    const before = beforeResult.find((item) => item.port_id === port.id);
    assert.ok(before?.active, "setup must install the first fixture release");
    assert.equal(before.staged, null);
    const firstVersion = before.active.version;
    const nextVersion = "2.0.0-fixture";
    let published: Awaited<ReturnType<InstallFixture["publishRelease"]>> | undefined;
    const fixtureRevisions: FileIdentity[] = [];
    browser = await restartApplication("native-staged-update-composition", async () => {
      for (const [original, snapshot] of [
        [fixture.artifactPath, path.join(output, "native-staged-update-initial-artifact.tar.gz")],
        [fixture.catalogPath, path.join(output, "native-staged-update-initial-catalog.json")],
      ] as const) {
        await copyFile(original, snapshot);
        const index = inputs.findIndex((item) => item.path === original);
        assert.ok(index >= 0, `fixture input identity missing: ${original}`);
        inputs[index] = await fileIdentity(snapshot);
        fixtureRevisions.push(inputs[index]);
      }
      try {
        published = await fixture.publishRelease(port.id, {
          version: nextVersion,
          publishedAt: "2026-09-26T00:00:00Z",
          seed: 0x43b9a607,
        });
      } finally {
        for (const file of [fixture.artifactPath, fixture.catalogPath]) {
          const identity = await fileIdentity(file);
          inputs.push(identity);
          fixtureRevisions.push(identity);
        }
      }
    });
    const afterRestart = await statuses();
    assert.equal(
      afterRestart.find((item) => item.port_id === port.id)?.active?.id,
      before.active.id,
    );

    await openFixture(port, true);
    await revealDetailSection(browser, "Versions & updates");
    await browser.findElement(button("Check for updates")).click();
    const updateControl = By.css('section[aria-label="Review game update"]');
    await browser.wait(until.elementLocated(updateControl), 15_000);
    await chooseGameUpdateDisposition(browser, "prepare");
    await browser.findElement(button("Review game update")).click();
    const review = By.css("[data-game-update-review]");
    await browser.wait(until.elementLocated(review), 15_000);
    assert.match(await browser.findElement(review).getText(), /current version stays unchanged/i);
    await browser.findElement(button("Prepare update for later")).click();
    const staged = await browser.wait(async () => {
      const result = object(await invoke("get_statuses"));
      if (!result.ok) return false;
      const status = transportValues("status", result.value).find(
        (item) => item.port_id === port.id,
      );
      return status?.staged?.version === nextVersion ? status : false;
    }, 30_000);
    assert.ok(staged && staged.active && staged.staged);
    assert.equal(staged.active.id, before.active.id);
    assert.equal(staged.active.version, firstVersion);
    assert.equal(staged.staged.artifact.sha256, required(published).sha256);
    assert.equal(staged.previous, null);
    const activation = await browser.wait(
      until.elementLocated(button(`Apply update · ${nextVersion}`)),
      15_000,
    );
    const play = await browser.wait(until.elementLocated(button("Play")), 15_000);
    await browser.wait(until.elementIsEnabled(activation), 15_000);
    await browser.wait(until.elementIsEnabled(play), 15_000);
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const libraryCard = await browser.wait(async () => {
      return executeBrowserScript(
        browser,
        (portId) => {
          const card = [...document.querySelectorAll("article.port-card")].find(
            (item) =>
              item.querySelector<HTMLButtonElement>("[data-detail-game-id]")?.dataset
                .detailGameId === portId,
          );
          if (!card || card.querySelector(".readiness")?.textContent?.trim() !== "Ready to play")
            return null;
          return {
            label: card.getAttribute("aria-label"),
            state: card.querySelector(".readiness")?.textContent?.trim(),
            attention: [
              ...card.querySelectorAll(".collection-state button, .collection-state p"),
            ].map((item) => item.textContent?.trim()),
          };
        },
        port.id,
      );
    }, 15_000);
    assert.ok(libraryCard);
    assert.equal(libraryCard.state, "Ready to play");
    assert.equal(libraryCard.label, `${gameIdentityLabel(port)}. Ready to play.`);
    assert.ok(libraryCard.attention.includes("Review prepared update"));
    assert.equal(
      libraryCard.attention.includes("Another update available at last check"),
      false,
      "the available target already matches the verified downloaded update",
    );
    const stagedLink = await browser.findElement(
      By.xpath(
        `//article[.//button[@data-detail-game-id="${port.id}"]]//button[normalize-space(.)="Review prepared update"]`,
      ),
    );
    await stagedLink.click();
    await browser.wait(
      async () => {
        const section = await browser.findElement(
          By.css(
            `.detail-panel[data-detail-port-id="${port.id}"] section[aria-label="Apply saved update"]`,
          ),
        );
        return (await section.getText()).includes(nextVersion);
      },
      5000,
      "Downloaded-update link must open the same game's saved update",
    );
    const layouts = await captureStagedLayouts(port, nextVersion);
    const finalResult = await statuses();
    const finalStatus = finalResult.find((item) => item.port_id === port.id);
    assert.ok(finalStatus?.active && finalStatus.staged);
    assert.equal(finalStatus.active.id, before.active.id);
    assert.equal(finalStatus.staged.id, staged.staged.id);
    const report = path.join(output, "native-staged-update-composition.json");
    await writeFile(
      report,
      `${JSON.stringify({ port_id: port.id, before, published, fixture_revisions: fixtureRevisions, staged: finalStatus, library_card: libraryCard, layouts }, null, 2)}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });

  await scenario("native-update-acquisition-lifecycle", async () => {
    assert.equal(process.platform, "win32");
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const ownedFixture = required(fixture);
    const observer = required(ownedGameProcess);
    const consent = required(confirmNative);
    const marker = required(ownedFixture.acquisitionWaitPath);
    const port = ownedFixture.refreshPort;
    const observations: Record<string, unknown> = {
      port_id: port.id,
      scope: "Owned first-party probe and isolated library; no gameplay acceptance",
    };
    const gates: ReturnType<InstallFixture["holdArtifact"]>[] = [];
    let liveGame: OwnedAcquisitionGame | undefined;
    let pendingGame: NativeManagedGame | undefined;
    let observationIndex = 0;
    const evidenceName = (name: string) => `acquisition-${name}-${++observationIndex}`;
    const status = async () =>
      required((await statuses()).find((item) => item.port_id === port.id));
    const bootstrap = async () =>
      transportValue("desktop_bootstrap_status", success(await invoke("get_bootstrap_status")));
    const visibleButton = async (label: string) => {
      const found = await browser.wait(
        async () => {
          for (const element of await browser.findElements(button(label)))
            if (await element.isDisplayed()) return element;
          return false;
        },
        15_000,
        `Missing visible ${label} action`,
      );
      assert.ok(found);
      return found;
    };
    const click = async (label: string) => {
      const element = await visibleButton(label);
      await browser.wait(until.elementIsEnabled(element), 15_000);
      await executeBrowserScript(
        browser,
        'arguments[0].scrollIntoView({block:"center"});',
        element,
      );
      await element.click();
    };
    const files = async (root: string): Promise<FileIdentity[]> => {
      const result: FileIdentity[] = [];
      const walk = async (directory: string) => {
        for (const name of (await readdir(directory)).sort()) {
          const file = path.join(directory, name);
          const info = await lstat(file);
          assert.equal(info.isSymbolicLink(), false, "Owned witness inventory refuses links");
          if (info.isDirectory()) await walk(file);
          else {
            assert.ok(info.isFile());
            assert.ok(result.length < 128, "Owned fixture inventory must remain bounded");
            result.push(await fileIdentity(file, { maxBytes: 64 * 1024 * 1024 }));
          }
        }
      };
      await walk(root);
      return result;
    };
    const outputLocation = async () =>
      transportValue(
        "port_output_location",
        success(
          await invoke("get_output_location", {
            portId: port.id,
            generation: (await bootstrap()).generation,
          }),
        ),
      );
    const first = await status();
    assert.ok(first.active, "Setup must install the owned executable fixture");
    assert.equal(first.staged, null);
    const location = await outputLocation();
    await mkdir(location.user_data_root, { recursive: true });
    const save = path.join(location.user_data_root, "owned-acquisition-save.bin");
    await writeFile(save, "Owned acquisition preservation witness; no player data\n", {
      flag: "wx",
    });
    const saveBefore = await fileIdentity(save);
    const preserve = async () => {
      const current = await status();
      return {
        active: current.active,
        previous: current.previous,
        staged: current.staged,
        output: await outputLocation(),
        runtime: await files(required(current.active).path),
        output_files: await files(location.effective_output_directory),
        saved_data: await files(location.user_data_root),
      };
    };
    const assertPreserved = async (before: Awaited<ReturnType<typeof preserve>>) => {
      assert.deepEqual(
        await preserve(),
        before,
        "Immutable transfer must preserve active/previous/staged runtime, output and saved bytes",
      );
      assert.deepEqual(await fileIdentity(save), saveBefore);
    };
    const assertLive = (name: string) => {
      assert.ok(liveGame);
      assert.equal(
        observer.observe(liveGame, evidenceName(name)),
        "running",
        "The exact captured game PID and creation identity must still be alive",
      );
    };
    const stopGame = async () => {
      await writeFile(marker, "release owned game\n");
      if (!liveGame && pendingGame) {
        liveGame = observer.capture(pendingGame, evidenceName("cleanup-capture")) ?? undefined;
        assert.ok(
          liveGame,
          "Launch was attempted without a captured identity; marker released, but positive game-exit evidence is inconclusive",
        );
      }
      if (!liveGame) return;
      const captured = liveGame;
      await browser.wait(
        () => observer.observe(captured, evidenceName("game-exit")) === "exited",
        20_000,
        "Owned game did not positively exit after its release signal",
      );
      // The OS identity exiting precedes Core's supervised completion reconciliation.
      await browser.wait(
        async () => {
          const activities = transportValue("activity", success(await invoke("get_activities")));
          return !activities.records.some(
            (record) =>
              record.operation === "launch" &&
              record.target_id === port.id &&
              record.status === "running",
          );
        },
        20_000,
        "Core launch activity did not settle after owned game exit",
      );
      liveGame = undefined;
      pendingGame = undefined;
    };
    const play = async () => {
      assert.equal(await exists(marker), false, "Each owned launch requires an unreleased marker");
      const current = await status();
      const active = required(current.active);
      const executable = path.resolve(active.path, active.selected_executable);
      const game = {
        executable,
        installation: { id: active.id, port_id: active.port_id, path: active.path },
      };
      pendingGame = game;
      await click("Play");
      const captured = await browser.wait(
        () => observer.capture(game, evidenceName("live-game")),
        60_000,
        "Play did not start the exact owned installed executable",
      );
      assert.ok(captured);
      liveGame = captured;
      // Core records a managed launch after spawning the child. Process liveness
      // alone cannot establish the file baseline used by acquisition assertions.
      const launchMarker = path.join(active.path, ".portcove-launched");
      await browser.wait(
        async () => (await exists(launchMarker)) && (await readFile(launchMarker, "utf8")) === "1",
        15_000,
        "Core did not finish recording the owned managed launch",
      );
      assertLive("play-started");
    };
    const publish = async (version: string, seed: number) => {
      let published: Awaited<ReturnType<InstallFixture["publishRelease"]>> | undefined;
      browser = await restartApplication(`acquisition-${version}`, async () => {
        assert.equal(liveGame, undefined, "No live game may survive fixture publication");
        for (const original of [ownedFixture.artifactPath, ownedFixture.catalogPath]) {
          const snapshot = path.join(
            output,
            `acquisition-${version}-before-${path.basename(original)}`,
          );
          await copyFile(original, snapshot);
          const index = inputs.findIndex((item) => item.path === original);
          assert.ok(index >= 0, `Fixture identity missing for ${original}`);
          inputs[index] = await fileIdentity(snapshot);
        }
        try {
          published = await ownedFixture.publishRelease(port.id, {
            version,
            publishedAt: `2026-10-${version.startsWith("2") ? "20" : version.startsWith("3") ? "21" : "22"}T00:00:00Z`,
            seed,
          });
        } finally {
          for (const file of [ownedFixture.artifactPath, ownedFixture.catalogPath])
            inputs.push(await fileIdentity(file));
        }
      });
      await rm(marker, { force: true });
      await openFixture(port, true);
      await revealDetailSection(browser, "Versions & updates");
      await click("Check for updates");
      await browser.wait(
        until.elementLocated(By.css('section[aria-label="Review game update"]')),
        15_000,
      );
      const release = required(published);
      const gate = ownedFixture.holdArtifact(release.url);
      gates.push(gate);
      return { release, gate };
    };
    const acquire = async (release: Awaited<ReturnType<InstallFixture["publishRelease"]>>) => {
      const generation = (await bootstrap()).generation;
      const plan = transportValue(
        "game_update_plan",
        success(await invoke("plan_game_update_acquisition", { portId: port.id, generation })),
      );
      assert.equal(plan.activate, false);
      assert.equal(plan.plan.release.asset.sha256, release.sha256);
      await chooseGameUpdateDisposition(browser, "download");
      await click("Review game update");
      await browser.wait(until.elementLocated(By.css("[data-game-update-review]")), 15_000);
      await click("Download archive for later");
      const pathname = new URL(release.url).pathname;
      await waitForFixture(
        () =>
          ownedFixture.requests.some(
            (request) =>
              request.request_path === pathname && request.bytes_sent > 0 && !request.completed,
          ),
        "Real acquisition did not enter the owned held HTTP transfer",
      );
      const transferring = await browser.wait(async () => {
        const value = await status();
        return value.acquisition?.phase === "acquiring" ? value.acquisition : false;
      }, 15_000);
      assert.ok(transferring);
      assert.equal(transferring.release.asset.sha256, release.sha256);
      return { plan, transferring };
    };
    const finish = async (
      transfer: Awaited<ReturnType<typeof acquire>>,
      published: Awaited<ReturnType<typeof publish>>,
    ) => {
      assertLive("before-release");
      published.gate.release();
      const acquired = await browser.wait(
        async () => {
          const current = await status();
          return current.acquisition?.phase === "acquired" ? current.acquisition : false;
        },
        60_000,
        "Archive did not reach Core's acquired state",
      );
      assert.ok(acquired);
      await browser.wait(
        async () => {
          const feed = transportValue("activity", success(await invoke("get_activities")));
          return feed.records.some(
            (record) => record.id === acquired.id && record.status === "succeeded",
          );
        },
        15_000,
        "Exact acquisition activity did not settle successfully",
      );
      assertLive("archive-acquired");
      await browser.wait(
        async () => {
          for (const section of await browser.findElements(
            By.css('section[aria-label="Retained update archive"]'),
          ))
            if (
              (await section.isDisplayed()) &&
              (await section.getText()).includes("Archive downloaded")
            )
              return true;
          return false;
        },
        15_000,
        "Fresh Core acquisition status did not reach the production archive controls",
      );
      assert.equal(
        published.gate.expired,
        false,
        "Fixture transfer expired instead of being explicitly released",
      );
      assert.equal(acquired.id, transfer.transferring.id);
      assert.equal(acquired.release.asset.sha256, published.release.sha256);
      const archive = await fileIdentity(
        path.join(library, "downloads", "update-acquisition-v1", acquired.id, "0.archive"),
      );
      assert.equal(archive.sha256, published.release.sha256);
      assert.equal(archive.bytes, published.release.size);
      return { acquired, archive };
    };
    const discardExact = async (acquisition: GameUpdateAcquisition) => {
      await click("Discard archive…");
      const discard = await browser.wait(
        until.elementLocated(By.css("[data-game-update-discard-review]")),
        15_000,
      );
      const review = await discard.getText();
      assert.ok(
        review.includes(acquisition.id) && review.includes(acquisition.release.asset.sha256),
        "Discard review must name the retained exact ID and digest",
      );
      await click("Discard archive");
      await browser.wait(
        async () => !(await statuses()).find((item) => item.port_id === port.id)?.acquisition,
        15_000,
      );
      await browser.wait(
        async () =>
          (await browser.findElements(By.css("[data-game-update-discard-review]"))).length === 0,
        15_000,
      );
      await assert.rejects(
        stat(path.join(library, "downloads", "update-acquisition-v1", acquisition.id)),
        { code: "ENOENT" },
      );
      return review;
    };
    const freshApply = async (
      activate: boolean,
      acquired: Awaited<ReturnType<typeof finish>>,
      release: Awaited<ReturnType<InstallFixture["publishRelease"]>>,
    ) => {
      const generation = (await bootstrap()).generation;
      const fresh = transportValue(
        "game_update_plan",
        success(await invoke("plan_game_update", { portId: port.id, activate, generation })),
      );
      assert.ok(fresh.acquisition);
      assert.equal(fresh.acquisition.id, acquired.acquired.id);
      assert.equal(fresh.acquisition.release.asset.sha256, release.sha256);
      await chooseGameUpdateDisposition(browser, activate ? "install" : "prepare");
      await click("Review game update");
      const review = await browser.wait(
        until.elementLocated(By.css("[data-game-update-review]")),
        15_000,
      );
      const reviewText = await review.getText();
      assert.ok(
        reviewText.includes(acquired.acquired.id) && reviewText.includes(release.sha256),
        "Fresh UI review must bind the exact acquired archive",
      );
      await click(activate ? "Update now" : "Prepare update for later");
      const applied = await browser.wait(
        async () => {
          const current = await status();
          return (activate ? current.active : current.staged)?.artifact.sha256 === release.sha256 &&
            current.acquisition?.id === acquired.acquired.id
            ? current
            : false;
        },
        30_000,
        "Fresh exclusive update did not publish the selected archive",
      );
      assert.ok(applied);
      await browser.wait(
        async () => {
          const feed = transportValue("activity", success(await invoke("get_activities")));
          return !feed.records.some(
            (record) =>
              record.operation === "update" &&
              record.target_id === port.id &&
              record.status === "running",
          );
        },
        15_000,
        "Exclusive update worker did not settle before fixture publication",
      );
      const requests = ownedFixture.requests.filter(
        (request) => request.request_path === new URL(release.url).pathname,
      );
      assert.equal(
        requests.length,
        1,
        "Fresh Prepare/Apply must reuse the exact archive without another HTTP request",
      );
      assert.equal(requests[0]?.completed, true);
      assert.deepEqual(await fileIdentity(save), saveBefore);
      assert.equal(applied.acquisition?.release.asset.sha256, release.sha256);
      assert.deepEqual(
        await fileIdentity(acquired.archive.path),
        acquired.archive,
        "Prepare/Apply must retain the exact immutable archive until explicit discard",
      );
      await browser.wait(
        async () => (await browser.findElements(By.css("[data-game-update-review]"))).length === 0,
        15_000,
      );
      const beforeDiscard = await preserve();
      const discardReview = await discardExact(acquired.acquired);
      await assertPreserved(beforeDiscard);
      return {
        fresh_plan: fresh,
        review_text: reviewText,
        applied,
        requests,
        explicit_discard: {
          review: discardReview,
          preserved_runtime_output_and_saves: beforeDiscard,
        },
      };
    };
    let primaryFailure: Error | undefined;
    try {
      const v2 = await publish("2.0.0-acquisition", 0x43b9a607);
      // A first launch records Core's .portcove-launched bookkeeping. Establish
      // that real pre-state before testing byte preservation during acquisition.
      await play();
      await stopGame();
      await rm(marker);
      const beforeV2 = await preserve();
      observations.initial_launch = { preserved_baseline: beforeV2 };
      observations.acquire_then_play = { release: v2.release, before: beforeV2 };
      const transferV2 = await acquire(v2.release);
      observations.acquire_then_play = {
        release: v2.release,
        before: beforeV2,
        transfer: transferV2,
      };
      await click("Continue browsing");
      await play();
      assertLive("during-acquire-first");
      await assertPreserved(beforeV2);
      const ordinaryWhilePlaying = object(
        await invoke("plan_game_update", {
          portId: port.id,
          activate: true,
          generation: (await bootstrap()).generation,
        }),
      );
      assert.equal(
        ordinaryWhilePlaying.ok,
        false,
        "Playing must still block ordinary exclusive review",
      );
      assert.equal(object(ordinaryWhilePlaying.error).code, "conflict");
      const archiveV2 = await finish(transferV2, v2);
      await assertPreserved(beforeV2);
      observations.acquire_then_play = {
        before: beforeV2,
        transfer: transferV2,
        archive: archiveV2,
        game: liveGame,
        exclusive_review: ordinaryWhilePlaying,
      };
      await stopGame();
      observations.fresh_apply = await freshApply(true, archiveV2, v2.release);
      assert.equal((await status()).previous?.id, first.active.id);
      assert.equal((await status()).staged, null);

      const v3 = await publish("3.0.0-acquisition", 0x7249b309);
      await play();
      // This ordering tests acquisition of an already-running installation;
      // launch preparation is complete before the preservation baseline.
      const beforeV3 = await preserve();
      observations.play_then_acquire = { release: v3.release, before: beforeV3, game: liveGame };
      const transferV3 = await acquire(v3.release);
      observations.play_then_acquire = {
        release: v3.release,
        before: beforeV3,
        game: liveGame,
        transfer: transferV3,
      };
      assertLive("during-playing-first");
      await assertPreserved(beforeV3);
      await click("Continue browsing");
      const archiveV3 = await finish(transferV3, v3);
      await assertPreserved(beforeV3);
      observations.play_then_acquire = {
        before: beforeV3,
        transfer: transferV3,
        archive: archiveV3,
        game: liveGame,
      };
      await stopGame();
      const prepared = await freshApply(false, archiveV3, v3.release);
      assert.deepEqual(prepared.applied.active, beforeV3.active);
      assert.deepEqual(prepared.applied.previous, beforeV3.previous);
      observations.fresh_prepare = prepared;

      const v4 = await publish("4.0.0-acquisition", 0x19072a5d);
      const beforeCancellation = await preserve();
      const transferV4 = await acquire(v4.release);
      observations.retained_discard = {
        release: v4.release,
        before: beforeCancellation,
        transfer: transferV4,
      };
      await click("Cancel archive download");
      const cancelled = await browser.wait(
        async () => {
          const current = await status();
          return current.acquisition?.phase === "attention_required" ? current.acquisition : false;
        },
        20_000,
        "Cancelled acquisition did not retain its recoverable exact identity",
      );
      assert.ok(cancelled);
      await waitForFixture(
        () =>
          ownedFixture.requests.some(
            (request) =>
              request.request_path === new URL(v4.release.url).pathname &&
              request.connection_closed,
          ),
        "Cancelled transfer socket did not close before retained recovery",
      );
      v4.gate.release();
      assert.equal(v4.gate.expired, false);
      assert.equal(cancelled.id, transferV4.transferring.id);
      await assertPreserved(beforeCancellation);
      await browser.wait(
        async () => (await browser.findElements(By.css("[data-game-update-review]"))).length === 0,
        15_000,
      );
      await revealDetailSection(browser, "Manage");
      await click(`Uninstall ${port.name}`);
      await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="removal-review-title"]')),
        15_000,
      );
      await click("Uninstall all versions");
      const nativeConsent = await consent(
        "Confirm uninstall",
        "Uninstall port",
        location.user_data_root,
        "acquisition-reviewed-uninstall",
      );
      const consentText = object(nativeConsent).text;
      assert.ok(typeof consentText === "string" && consentText.includes(port.id));
      const removed = await browser.wait(async () => {
        const current = await status();
        return !current.active && !current.previous && !current.staged ? current : false;
      }, 30_000);
      assert.ok(removed);
      assert.equal(
        removed.acquisition?.id,
        cancelled.id,
        "Uninstall must leave retained archive recovery reachable",
      );
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-labelledby="removal-review-title"]')))
            .length === 0,
        15_000,
      );
      await browser.findElement(By.xpath('//nav//button[contains(., "Activity")]')).click();
      await click("Game updates");
      const row = await browser.wait(
        until.elementLocated(By.css(`[data-retained-update-archive-port-id="${port.id}"]`)),
        15_000,
      );
      assert.equal(
        await row
          .findElements(By.xpath('.//button[normalize-space(.)="Review game update"]'))
          .then((items) => items.length),
        0,
        "An orphan archive must never offer Apply",
      );
      const discardText = await discardExact(cancelled);
      await browser.wait(
        async () =>
          (
            await browser.findElements(
              By.css(`[data-retained-update-archive-port-id="${port.id}"]`),
            )
          ).length === 0,
        15_000,
      );
      assert.deepEqual(await fileIdentity(save), saveBefore);
      const cancelRequests = ownedFixture.requests.filter(
        (request) => request.request_path === new URL(v4.release.url).pathname,
      );
      assert.equal(cancelRequests.length, 1);
      assert.equal(
        cancelRequests[0]?.completed,
        false,
        "Cancellation must interrupt the actual fixture stream",
      );
      observations.retained_discard = {
        cancelled,
        removed,
        native_consent: nativeConsent,
        discard_review: discardText,
        requests: cancelRequests,
        preserved_save: await fileIdentity(save),
      };
    } catch (error) {
      primaryFailure =
        error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
      observations.failure = errorMessage(error);
    } finally {
      for (const gate of gates) gate.release();
      try {
        await stopGame();
        observations.cleanup = {
          game_exited: true,
          transfer_gates_released: true,
          release_marker: marker,
        };
        artifacts.push(marker);
      } catch (error) {
        observations.cleanup_failure = errorMessage(error);
        primaryFailure = primaryFailure
          ? new AggregateError(
              [primaryFailure, error],
              "Acquisition verification and owned cleanup both failed",
            )
          : error instanceof Error
            ? error
            : new Error(errorMessage(error), { cause: error });
      }
      const report = path.join(output, "native-update-acquisition-lifecycle.json");
      await writeFile(
        report,
        `${JSON.stringify({ ...observations, request_receipts: ownedFixture.requests, gates: gates.map(({ released, expired }) => ({ released, expired })) }, null, 2)}\n`,
        { flag: "wx" },
      );
      artifacts.push(report);
    }
    if (primaryFailure) throw primaryFailure;
  });
}
