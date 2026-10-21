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
import type { ActivityStatus, InstallRecord } from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
import { gameIdentityLabel } from "../src/port-identity.ts";
type InstallFixture = Awaited<ReturnType<typeof createInstallFixture>>;
type FixturePort = InstallFixture["port"];
interface InstallContext extends ScenarioContext {
  invoke: BoundaryInvoke;
  library: string;
  inputs: FileIdentity[];
  fixture: InstallFixture | undefined;
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
import { copyFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chooseGameUpdateDisposition } from "./desktop-review-controls.mts";
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

function readStagedLayout(version: string) {
  const detail = document.querySelector("[data-detail-workspace]");
  const buttons = [
    ...(detail?.querySelectorAll<HTMLButtonElement>(".primary-actions button") ?? []),
  ];
  const play = buttons.find((item) => item.textContent?.trim() === "Play");
  const activate = buttons.find((item) => item.textContent?.trim() === `Use update · ${version}`);
  const group = play?.closest(".primary-actions");
  const summary = group?.closest(".detail-summary");
  const controls = [
    ...(group?.querySelectorAll("button, a[href], input, select, textarea, [tabindex]") ?? []),
  ];
  const rect = (element: Element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  const visible = (element: Element) => {
    if (getComputedStyle(element).visibility !== "visible" || element.getClientRects().length === 0)
      return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const action = (element: HTMLButtonElement) => ({
    ...rect(element),
    enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
    visible: visible(element),
  });
  const spacing = group ? getComputedStyle(group) : undefined;
  const updates = [...(detail?.querySelectorAll("h2, h3") ?? [])].find(
    (item) => item.textContent?.trim() === "Updates",
  );
  return {
    play: play && action(play),
    activate: activate && action(activate),
    group: group && rect(group),
    orderedNeighbors: Boolean(
      play &&
      activate &&
      group &&
      activate.closest(".primary-actions") === group &&
      controls.indexOf(activate) === controls.indexOf(play) + 1,
    ),
    inSummary: Boolean(summary && activate && summary.contains(activate)),
    rowGap: Number.parseFloat(spacing?.rowGap ?? ""),
    columnGap: Number.parseFloat(spacing?.columnGap ?? ""),
    viewport: { width: innerWidth, height: innerHeight },
    updatesTop: updates?.getBoundingClientRect().top,
    state: detail?.querySelector(".detail-hero .hero-state")?.textContent?.trim(),
    reason: detail?.querySelector(".detail-hero .hero-reason")?.textContent?.trim(),
    attention: detail?.querySelector(".detail-hero [data-update-attention]")?.textContent?.trim(),
    documentOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
}

function assertStagedActionPlacement(layout: ReturnType<typeof readStagedLayout>) {
  const message = JSON.stringify(layout);
  assert.ok(layout.play && layout.activate && layout.group, message);
  const { play, activate, group, viewport } = layout;
  assert.equal(layout.orderedNeighbors, true, message);
  assert.equal(layout.inSummary, true, message);
  assert.equal(layout.documentOverflow, false, message);
  assert.ok(
    Number.isFinite(viewport.width) &&
      viewport.width > 0 &&
      Number.isFinite(viewport.height) &&
      viewport.height > 0,
    message,
  );
  for (const gap of [layout.rowGap, layout.columnGap]) {
    assert.ok(Number.isFinite(gap) && Math.abs(gap - 8) <= 1, message);
  }
  for (const box of [group, play, activate]) {
    assert.ok([box.left, box.right, box.top, box.bottom].every(Number.isFinite), message);
    assert.ok(box.right > box.left && box.bottom > box.top, message);
  }
  for (const action of [play, activate]) {
    assert.equal(action.enabled, true, message);
    assert.equal(action.visible, true, message);
    assert.ok(
      action.left >= Math.max(0, group.left) - 1 &&
        action.right <= Math.min(viewport.width, group.right) + 1,
      message,
    );
    assert.ok(
      action.top >= Math.max(0, group.top) - 1 &&
        action.bottom <= Math.min(viewport.height, group.bottom) + 1,
      message,
    );
  }
  assert.ok(
    layout.updatesTop !== undefined &&
      Number.isFinite(layout.updatesTop) &&
      Math.max(play.bottom, activate.bottom) <= layout.updatesTop + 1,
    message,
  );
  const horizontalGap = activate.left - play.right;
  const verticalGap = activate.top - play.bottom;
  const sameRow =
    Math.abs(activate.top - play.top) <= 1 &&
    horizontalGap >= -1 &&
    horizontalGap <= layout.columnGap + 1;
  const immediateWrap =
    Math.abs(activate.left - play.left) <= 1 &&
    verticalGap >= -1 &&
    verticalGap <= layout.rowGap + 1;
  assert.ok(sameRow || immediateWrap, message);
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
  restartApplication,
}: InstallContext) {
  const statuses = async () => transportValues("status", success(await invoke("get_statuses")));
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const buttonStarting = (label: string) =>
    By.xpath(`//button[starts-with(normalize-space(.),"${label}")]`);
  const selectTheme = async (theme: string) => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
    await browser.findElement(button(theme === "dark" ? "Dark" : "Light")).click();
    assert.equal(
      await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
      theme,
    );
  };
  const openFixture = async (port: FixturePort, installed = false) => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Find games")]')).click();
    const search = await browser.findElement(By.id("port-search"));
    await search.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      Key.BACK_SPACE,
      port.name,
    );
    const card = By.xpath(`//button[@data-detail-origin="catalog:card:${port.id}"]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
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
      for (const theme of ["dark", "light"]) {
        await selectTheme(theme);
        await openFixture(port, true);
        for (const { width, height } of [
          { width: 960, height: 640 },
          { width: 1280, height: 800 },
        ]) {
          await browser.manage().window().setRect({ width, height });
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
          assert.equal(
            layout.attention,
            `Play the installed version or use the saved update ${version}.`,
          );
          assert.ok(layout.activate.left >= 0 && layout.activate.right <= width + 1);
          assert.ok(layout.play.left >= 0 && layout.play.right <= width + 1);
          assert.ok(layout.play.top >= 0 && layout.play.bottom <= height);
          assert.ok(layout.activate.top >= 0 && layout.activate.bottom <= height);
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
    await browser.findElement(button("Check for updates")).click();
    const updateControl = By.css('section[aria-label="Review game update"]');
    await browser.wait(until.elementLocated(updateControl), 15_000);
    await chooseGameUpdateDisposition(browser, "download");
    await browser.findElement(button("Review game update")).click();
    const review = By.css("[data-game-update-review]");
    await browser.wait(until.elementLocated(review), 15_000);
    assert.match(await browser.findElement(review).getText(), /current version stays unchanged/i);
    await browser.findElement(button("Download update for later")).click();
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
      until.elementLocated(button(`Use update · ${nextVersion}`)),
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
    assert.ok(libraryCard.attention.includes("Review downloaded update"));
    assert.equal(
      libraryCard.attention.includes("Another update available at last check"),
      false,
      "the available target already matches the verified downloaded update",
    );
    const stagedLink = await browser.findElement(
      By.xpath(
        `//article[.//button[@data-detail-game-id="${port.id}"]]//button[normalize-space(.)="Review downloaded update"]`,
      ),
    );
    await stagedLink.click();
    await browser.wait(
      async () => {
        const section = await browser.findElement(
          By.css(
            `.detail-panel[data-detail-port-id="${port.id}"] section[aria-label="Use update saved for later"]`,
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
}
