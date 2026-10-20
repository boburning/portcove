import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import type { Locator, IRectangle, WebElement } from "selenium-webdriver";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type {
  PortDefinition,
  PortStatus,
  InstallRecord,
  ActivityRecord,
  FailureReport,
  MutationState,
  Platform,
  TransportOutputs,
  SourceRecord,
  OutputGameUpdatePlan,
} from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
export interface PreparationContext {
  browser: WebDriver;
  invoke: ScenarioInvoke;
  scenario: ScenarioContext["scenario"];
  library: string;
  output: string;
  artifacts: string[];
  cli: string;
  tool: string;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  restartApplication: (
    name: string,
    prepareWhileStopped?: () => Promise<void>,
    environment?: NodeJS.ProcessEnv,
  ) => Promise<WebDriver>;
  interruptApplication: (
    name: string,
    executable: string,
    assertPreparing: () => Promise<void>,
  ) => Promise<WebDriver>;
  closeApplication: (
    name: string,
    executable: string,
    assertPreparing: () => Promise<void>,
  ) => Promise<WebDriver>;
  captureLivePreparation: (executable: string) => unknown;
  chooseOwnedLibrary: ReturnType<typeof nativeConfirmation>;
}
// Preserve original error identity, including deliberate non-Error boundary failures.
function rethrowFailure(error: unknown): never {
  throw error;
}
import { executeBrowserScript } from "./browser-script.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
// Optional owned-fixture scenarios; all state stays under desktop-test's new output directory.
import assert from "node:assert/strict";
import type { ProbeCleanup } from "./desktop-owned-ipc-probe.mts";
import {
  beginReviewedUpdateProbe,
  requireTrustedProbeCleanup,
} from "./desktop-owned-ipc-probe.mts";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { By, Key, until, WebDriver, Session, Capabilities } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { backupReviewScenario } from "./desktop-backup-review-test.mts";
import { removalReviewScenario } from "./desktop-removal-review-test.mts";
import { cliHandoffScenario } from "./desktop-cli-handoff-test.mts";
import { artworkScenario } from "./desktop-artwork-test.mts";
import { artworkCorrectionScenario } from "./desktop-artwork-correction-test.mts";
import { libraryHandoffScenario } from "./desktop-library-handoff-test.mts";
import { adoptionReviewScenario } from "./desktop-adoption-review-test.mts";
import { sourceRemovalScenario } from "./desktop-source-removal-test.mts";
import {
  interruptedPreparationScenario,
  liveInterruptedPreparationScenario,
  closedPreparationScenario,
  minimizedPreparationScenario,
} from "./desktop-preparation-recovery-test.mts";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible,
} from "./desktop-review-controls.mts";
import { readinessScenario } from "./desktop-readiness-test.mts";
import { steamEntryScenario } from "./desktop-steam-entry-test.mts";
import { sourceDialogScenario } from "./desktop-source-dialog-test.mts";
import { primaryFilePickerScenario } from "./desktop-primary-file-picker-test.mts";
import { listenerLifetimeScenario } from "./desktop-listener-lifetime-test.mts";

// Qualification witness guard only; Core retains filesystem ownership and symlink authority.
export function rollbackWitnessWithinLibrary(library: string, owned: string) {
  if (!path.isAbsolute(library) || !path.isAbsolute(owned)) return false;
  const relative = path.relative(
    path.toNamespacedPath(path.resolve(library)),
    path.toNamespacedPath(path.resolve(owned)),
  );
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function rgbLuminance(color: string) {
  const channels = required(color.match(/[\d.]+/g))
    .slice(0, 3)
    .map(Number);
  const linear = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * required(linear[0]) + 0.7152 * required(linear[1]) + 0.0722 * required(linear[2]);
}

function contrastRatio(foreground: string, background: string) {
  const values = [rgbLuminance(foreground), rgbLuminance(background)].sort((a, b) => b - a);
  return (required(values[0]) + 0.05) / (required(values[1]) + 0.05);
}

async function assertActivityLabelSeparation(browser: WebDriver, width: number) {
  const gap = await executeBrowserScript(
    browser,
    (compact) => {
      const activity = document.querySelector(".activity-row");
      const previous = activity?.querySelector(compact ? ".activity-main" : ".activity-time");
      const status = activity?.querySelector(".activity-status");
      if (!previous || !status) return null;
      const textBounds = (element: Element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let left = Infinity;
        let right = -Infinity;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          left = Math.min(left, rect.left);
          right = Math.max(right, rect.right);
        }
        return { left, right };
      };
      const preceding = textBounds(previous);
      const outcome = textBounds(status);
      if (!Number.isFinite(preceding.right) || !Number.isFinite(outcome.left)) return null;
      return outcome.left - preceding.right;
    },
    width === 960,
  );
  assert.ok(
    gap !== null && gap >= 8,
    `Activity outcome overlaps preceding content at ${width}px (gap ${gap}px)`,
  );
}

const updateReviewWindows = [
  { width: 960, height: 640 },
  { width: 1280, height: 800 },
];

async function openUpdateTheme(browser: WebDriver, theme: string) {
  await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
  await browser
    .findElement(
      By.css('nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]'),
    )
    .click();
  await browser
    .findElement(By.xpath(`//button[normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`))
    .click();
  assert.equal(
    await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
    theme,
  );
  await browser
    .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
    .click();
  await selectActivitySection(browser, "Updates");
}

async function selectActivitySection(browser: WebDriver, label: "Updates" | "Tasks & history") {
  const button = await browser.findElement(
    By.xpath(`//nav[@aria-label="Activity sections"]//button[normalize-space(.)="${label}"]`),
  );
  await clickVisible(browser, button);
  await browser.wait(async () => (await button.getAttribute("aria-pressed")) === "true", 5000);
}

async function assertIndividualUpdateFailure({
  browser,
  port,
  command,
  output,
  artifacts,
}: Pick<PreparationContext, "browser" | "output" | "artifacts"> & {
  port: Pick<PortDefinition, "id" | "name">;
  command: FixtureCommand;
}) {
  const failure: FailureReport = {
    code: "network",
    message: "owned-raw-private-diagnostic",
    details: { token: "owned-raw-private-token" },
    presentation: {
      presentation_key: "synthetic_update_check",
      summary:
        "Synthetic update check could not reach the owned release endpoint. Check the connection before checking again. The installed game remains available for review in its details.",
      tone: "error",
      mutation_state: "unknown",
      phase: "release.check",
      recovery_actions: ["review_current_state", "view_technical_details"],
      technical_message: "Owned synthetic endpoint unavailable; token=[REDACTED].",
      technical_context: { fixture: "owned synthetic diagnostics", token: "[REDACTED]" },
    },
  };
  interface FailureLayout {
    theme: string;
    window: IRectangle;
    viewport: { width: number; height: number };
    overflow: boolean;
    documentOverflow: boolean;
    summaryWhiteSpace: string;
    summaryOverflow: boolean;
    detailNavigationNested: boolean;
  }
  const observations: {
    synthetic: boolean;
    scope: string;
    before: PortStatus;
    sources_before: SourceRecord[];
    layouts: FailureLayout[];
    copy_acknowledged?: boolean;
    navigation_verified?: boolean;
    after?: PortStatus;
    sources_after?: SourceRecord[];
    failure?: string;
    probe?: { installed: boolean; restored: boolean; intercepted?: number };
  } = {
    synthetic: true,
    scope: "Normal-app presentation of supplied diagnostics; no provider or Core failure claim.",
    before: transportValue("status", command(["status", port.id])),
    sources_before: transportValues("source", command(["source", "list"])),
    layouts: [],
  };
  try {
    await executeBrowserScript(
      browser,
      (portId, error) => {
        const ownedWindow = window as Window & {
          __TAURI_INTERNALS__?: Pick<
            import("./desktop-owned-ipc-probe.mts").ProbeNative,
            "convertFileSrc"
          >;
          __portcoveUpdateFailureProbe?: { original: typeof fetch; intercepted: number };
        };
        const original = window.fetch;
        if (!ownedWindow.__TAURI_INTERNALS__) throw new Error("Pinned Tauri transport is missing");
        const target = ownedWindow.__TAURI_INTERNALS__.convertFileSrc("check_installed", "ipc");
        const probe = { original, intercepted: 0 };
        ownedWindow.__portcoveUpdateFailureProbe = probe;
        window.fetch = function (input, ...args) {
          // Native fetch also accepts string-coercible cross-realm input.
          /* oxlint-disable typescript/no-base-to-string */
          const url =
            typeof input === "string"
              ? input
              : ((input !== null && typeof input === "object" && "url" in input
                  ? input.url
                  : undefined) ?? String(input));
          /* oxlint-enable typescript/no-base-to-string */
          if (url !== target) return original.call(window, input, ...args);
          probe.intercepted++;
          return Promise.resolve(
            new Response(JSON.stringify([{ port_id: portId, ok: false, result: null, error }]), {
              status: 200,
              headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
            }),
          );
        };
      },
      port.id,
      failure,
    );
    for (const theme of ["dark", "light"]) {
      await openUpdateTheme(browser, theme);
      const check = await browser.wait(
        until.elementLocated(
          By.xpath('//button[normalize-space(.)="Check installed ports for updates"]'),
        ),
        15_000,
      );
      await browser.wait(until.elementIsEnabled(check), 5_000);
      await clickVisible(browser, check);
      const region = await browser.wait(
        until.elementLocated(By.css(`[data-update-check-failure="${port.id}"]`)),
        15_000,
      );
      assert.equal(
        await region.getAttribute("aria-label"),
        `Update check failure for ${port.name}`,
      );
      assert.ok((await region.getText()).includes(failure.presentation.summary));
      assert.doesNotMatch(await region.getText(), /owned-raw-private/);
      const summary = await region.findElement(By.css("summary"));
      assert.equal(
        await executeBrowserScript(
          browser,
          (element) => element.closest("button") === null,
          summary,
        ),
        true,
      );
      assert.equal(await region.findElement(By.css("details")).getAttribute("open"), null);
      for (const { width, height } of updateReviewWindows) {
        await browser.manage().window().setRect({ width, height });
        const actualWindow = await browser.manage().window().getRect();
        assert.equal(actualWindow.width, width);
        assert.equal(actualWindow.height, height);
        await executeBrowserScript(
          browser,
          (element) => element.scrollIntoView({ block: "center" }),
          region,
        );
        await clickVisible(browser, summary);
        assert.equal(await region.findElement(By.css("details")).getAttribute("open"), "true");
        const technical: unknown = JSON.parse(await region.findElement(By.css("pre")).getText());
        assert.deepEqual(technical, {
          code: failure.code,
          mutation_state: failure.presentation.mutation_state,
          phase: failure.presentation.phase,
          message: failure.presentation.technical_message,
          context: failure.presentation.technical_context,
        });
        const layout = await executeBrowserScript(
          browser,
          (element) => {
            const paragraph = element.querySelector("p");
            if (!paragraph) throw new Error("Update failure summary is missing");
            return {
              viewport: { width: window.innerWidth, height: window.innerHeight },
              overflow: element.scrollWidth > element.clientWidth + 1,
              documentOverflow:
                document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
              summaryWhiteSpace: getComputedStyle(paragraph).whiteSpace,
              summaryOverflow: paragraph.scrollWidth > paragraph.clientWidth + 1,
              detailNavigationNested: element.closest("button") !== null,
            };
          },
          region,
        );
        assert.equal(layout.overflow, false);
        assert.equal(layout.documentOverflow, false);
        assert.equal(layout.summaryOverflow, false);
        assert.notEqual(layout.summaryWhiteSpace, "nowrap");
        assert.equal(layout.detailNavigationNested, false);
        observations.layouts.push({ theme, window: actualWindow, ...layout });
        const report = path.join(output, `update-failure-${theme}-${width}-accessibility.json`);
        await captureAccessibilityReport(browser, report, artifacts);
        const screenshot = path.join(
          output,
          `native-update-failure-${theme}-${width}x${height}.png`,
        );
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
        await clickVisible(browser, summary);
        assert.equal(await region.findElement(By.css("details")).getAttribute("open"), null);
      }
    }
    const region = await browser.findElement(By.css(`[data-update-check-failure="${port.id}"]`));
    await clickVisible(browser, await region.findElement(By.css("summary")));
    await clickVisible(browser, await region.findElement(By.css("button")));
    await browser.wait(
      async () => (await region.findElement(By.css("button")).getText()) === "Copied",
      5_000,
    );
    observations.copy_acknowledged = true;
    assert.equal((await browser.findElements(By.css("[data-detail-workspace]"))).length, 0);
    await clickVisible(
      browser,
      await browser.findElement(By.css(`[data-detail-origin="updates:installed:${port.id}"]`)),
    );
    await browser.wait(until.elementLocated(By.css("[data-detail-workspace]")), 15_000);
    assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
    observations.navigation_verified = true;
    observations.after = transportValue("status", command(["status", port.id]));
    observations.sources_after = transportValues("source", command(["source", "list"]));
    assert.deepEqual(observations.after, observations.before);
    assert.deepEqual(observations.sources_after, observations.sources_before);
  } catch (error) {
    observations.failure = errorMessage(error);
    throw error;
  } finally {
    observations.probe = await executeBrowserScript(browser, () => {
      const ownedWindow = window as Window & {
        __portcoveUpdateFailureProbe?: { original: typeof fetch; intercepted: number };
      };
      const probe = ownedWindow.__portcoveUpdateFailureProbe;
      if (!probe) return { installed: false, restored: false };
      window.fetch = probe.original;
      delete ownedWindow.__portcoveUpdateFailureProbe;
      return {
        installed: true,
        intercepted: probe.intercepted,
        restored: window.fetch === probe.original,
      };
    });
    const report = path.join(output, "update-check-failure-observations.json");
    await writeFile(report, JSON.stringify(observations, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    artifacts.push(report);
    assert.equal(observations.probe.restored, true);
    assert.equal(observations.probe.intercepted, 2);
  }
}

function controlledUpdateFailure(mutation: MutationState): FailureReport {
  const cancelled = mutation === "no_changes";
  return {
    code: cancelled ? "cancelled" : "state",
    message: "Owned controlled update outcome.",
    details: {},
    presentation: {
      presentation_key: "owned_update_outcome",
      summary: cancelled
        ? "The controlled update was cancelled."
        : "Review the supplied update outcome.",
      tone: cancelled ? "neutral" : "error",
      mutation_state: mutation,
      phase: "update",
      recovery_actions: ["review_current_state", "view_technical_details"],
      technical_message: "Owned presentation fixture; token=[REDACTED].",
      technical_context: { fixture: "controlled reviewed update" },
    },
  };
}

export type ReviewElement = Pick<WebElement, "getText" | "isDisplayed" | "isEnabled" | "click">;
export interface ReviewContainer<Element extends ReviewElement = ReviewElement> {
  getText: () => Promise<string>;
  isDisplayed: () => Promise<boolean>;
  findElements: (locator: Locator) => Promise<Element[]>;
}
export interface ReviewWaiter {
  wait: <Value>(
    condition: () => Promise<Value>,
    timeout: number,
    message: string,
  ) => Promise<Value>;
}
export interface ReviewSnapshot {
  text: string;
  displayed: boolean;
  version_count: number;
  version: string | null;
  version_displayed: boolean;
  action_count: number;
  action_displayed: boolean;
  action_enabled: boolean;
}
export interface ReviewObservation {
  review?: {
    expected_version: string;
    polls: number;
    first: ReviewSnapshot | null;
    latest: ReviewSnapshot | null;
  };
}
async function reviewedUpdateState<Element extends ReviewElement>(
  review: ReviewContainer<Element>,
) {
  const [text, displayed, versions, actions] = await Promise.all([
    review.getText(),
    review.isDisplayed(),
    review.findElements(By.css(".install-plan > p:first-child strong")),
    review.findElements(By.xpath('.//button[normalize-space(.)="Keep saved update for later"]')),
  ]);
  const version = versions.length === 1 ? versions[0] : null;
  const action = actions.length === 1 ? actions[0] : null;
  const [versionText, versionDisplayed, actionDisplayed, actionEnabled] = await Promise.all([
    version?.getText() ?? null,
    version?.isDisplayed() ?? false,
    action?.isDisplayed() ?? false,
    action?.isEnabled() ?? false,
  ]);
  return {
    action,
    snapshot: {
      text,
      displayed,
      version_count: versions.length,
      version: versionText,
      version_displayed: versionDisplayed,
      action_count: actions.length,
      action_displayed: actionDisplayed,
      action_enabled: actionEnabled,
    },
  };
}

function confirmsReviewedRelease(snapshot: ReviewSnapshot, expectedVersion: string) {
  return (
    snapshot.displayed &&
    snapshot.text.includes("Confirm the release and what happens to your active version") &&
    snapshot.version_count === 1 &&
    snapshot.version === expectedVersion &&
    snapshot.version_displayed
  );
}

function hasAvailableReviewedAction(snapshot: ReviewSnapshot) {
  return snapshot.action_count === 1 && snapshot.action_displayed && snapshot.action_enabled;
}

export async function waitForReviewedUpdateAction<Element extends ReviewElement>(
  browser: ReviewWaiter,
  review: ReviewContainer<Element>,
  expectedVersion: string,
  observation: ReviewObservation,
) {
  const state: NonNullable<ReviewObservation["review"]> = {
    expected_version: expectedVersion,
    polls: 0,
    first: null,
    latest: null,
  };
  observation.review = state;
  const action = await browser.wait(
    async () => {
      const { action, snapshot } = await reviewedUpdateState(review);
      state.polls++;
      state.first ??= snapshot;
      state.latest = snapshot;
      return confirmsReviewedRelease(snapshot, expectedVersion) &&
        hasAvailableReviewedAction(snapshot)
        ? action
        : false;
    },
    5_000,
    "The controlled review must show its exact release and available action",
  );
  assert.ok(action);
  return action;
}

async function assertReviewedUpdateOutcomes({
  browser,
  port,
  candidate,
  generation,
  command,
  invoke,
  output,
  artifacts,
}: Pick<PreparationContext, "browser" | "invoke" | "output" | "artifacts"> & {
  port: Pick<PortDefinition, "id" | "name">;
  candidate: OutputGameUpdatePlan;
  generation: number;
  command: FixtureCommand;
}) {
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  const dialog = By.css('[aria-labelledby="game-update-review-title"]');
  interface CaseObservation extends ReviewObservation, Partial<ProbeCleanup> {
    availability?: string;
    reason?: string;
    synthetic?: boolean;
    mutation?: MutationState;
    cancelled?: boolean;
    expected_version?: string;
    failure?: string;
    failure_capture_error?: string;
    review_cancelled_without_reapply?: boolean;
  }
  const readActivities = async () => {
    const result = object(await invoke("get_activities"));
    assert.equal(result.ok, true);
    return transportValue("activity", result.value);
  };
  const observations: {
    synthetic: boolean;
    scope: string;
    before: PortStatus;
    sources_before: SourceRecord[];
    activities_before: TransportOutputs["activity"];
    cases: CaseObservation[];
    ordinary_review_restored?: boolean;
    after?: PortStatus;
    sources_after?: SourceRecord[];
    activities_after?: TransportOutputs["activity"];
  } = {
    synthetic: true,
    scope: "Supplied structured outcomes in the normal app; no Core failure or mutation claim.",
    before: transportValue("status", command(["status", port.id])),
    sources_before: transportValues("source", command(["source", "list"])),
    activities_before: await readActivities(),
    cases: [],
  };
  let primaryError;
  let reportError;
  try {
    for (const [availability, reason, action, explanation] of [
      ["waiting", "missing_source", "download", "Add the required game files"],
      ["waiting", "missing_bios", "download", "Add the required BIOS"],
      ["held", "invalid_installation", "blocked_unverified", "An unverified local copy"],
    ] as const) {
      const observation: CaseObservation = {
        availability,
        reason,
        synthetic: true,
        restored: false,
      };
      observations.cases.push(observation);
      const suppliedPlan = {
        ...candidate,
        activate: false,
        plan_sha256: "owned-controlled-update-plan",
        assessment: { action: "update", availability, reason, definition: null },
        plan: { ...candidate.plan, action },
      };
      const probe = await beginReviewedUpdateProbe(browser, {
        portId: port.id,
        generation,
        plan: suppliedPlan,
        failure: controlledUpdateFailure("no_changes"),
      });
      let scenarioError;
      try {
        await clickVisible(browser, await browser.findElement(button("Review game update")));
        const review = await browser.wait(until.elementLocated(dialog), 15_000);
        await browser.wait(async () => (await review.getText()).includes(explanation), 5_000);
        assert.equal(
          (
            await review.findElements(
              By.xpath(
                './/button[contains(., "for later") or contains(., "install update") or normalize-space(.)="Use saved update"]',
              ),
            )
          ).length,
          0,
          "Held or waiting assessment must offer no update execution action",
        );
        const admitted = required(await probe.capture());
        assert.equal(admitted.plans, 1);
        assert.equal(admitted.applies, 0);
        assert.deepEqual(admitted.mismatches, []);
        const image = path.join(output, `native-reviewed-update-${reason}.png`);
        await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
        artifacts.push(image);
        await clickVisible(browser, await browser.findElement(button("Cancel review")));
        await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
      } catch (error) {
        scenarioError = error;
        observation.failure = errorMessage(error);
        throw error;
      } finally {
        const cleanup = await probe.restore();
        Object.assign(observation, cleanup);
        requireTrustedProbeCleanup(cleanup, scenarioError);
      }
      assert.equal(observation.plans, 1);
      assert.equal(observation.applies, 0);
      assert.equal(observation.restored, true);
    }
    for (const mutation of ["committed", "unknown", "no_changes"] as const) {
      const cancelled = mutation === "no_changes";
      const failure = controlledUpdateFailure(mutation);
      const suppliedPlan = {
        ...candidate,
        activate: false,
        // A real Core authorization compares a canonical SHA-256 plan digest.
        // Even a later transport fallback cannot authorize this supplied plan.
        plan_sha256: "owned-controlled-update-plan",
        assessment: {
          action: "update",
          availability: "allowed",
          reason: "available",
          definition: null,
        },
        plan: { ...candidate.plan, action: "use_staged" },
      };
      const observation: CaseObservation = {
        mutation,
        cancelled,
        expected_version: candidate.plan.release.version,
        restored: false,
      };
      observations.cases.push(observation);
      const probe = await beginReviewedUpdateProbe(browser, {
        portId: port.id,
        generation,
        plan: suppliedPlan,
        failure,
      });
      let scenarioError;
      try {
        await clickVisible(browser, await browser.findElement(button("Review game update")));
        const review = await browser.wait(until.elementLocated(dialog), 15_000);
        const applyAction = await waitForReviewedUpdateAction(
          browser,
          review,
          candidate.plan.release.version,
          observation,
        );
        const admitted = required(await probe.capture());
        assert.equal(admitted.plans, 1, "The supplied review must be intercepted before Apply");
        assert.deepEqual(admitted.mismatches, []);
        assert.equal(/^[a-f0-9]{64}$/.test(suppliedPlan.plan_sha256), false);

        await clickVisible(browser, applyAction);
        const outcome = await browser.wait(
          until.elementLocated(By.css("[data-game-update-outcome]")),
          5_000,
        );
        await browser.wait(
          async () => (await outcome.getText()).includes(failure.presentation.summary),
          5_000,
        );
        assert.equal(await outcome.getAttribute("role"), cancelled ? "status" : "alert");
        const consequence =
          mutation === "committed"
            ? "The change was saved"
            : mutation === "unknown"
              ? "couldn't confirm whether anything changed"
              : "No files were changed";
        assert.ok((await outcome.getText()).includes(consequence));
        assert.equal((await browser.findElements(dialog)).length, 0);
        assert.ok(
          !(
            await browser.findElement(By.css('section[aria-label="Review game update"]')).getText()
          ).includes("Update did not complete"),
        );
        const details = await outcome.findElement(By.css("details"));
        assert.equal(await details.getAttribute("open"), null);
        await clickVisible(browser, await details.findElement(By.css("summary")));
        const diagnostic = object(JSON.parse(await details.findElement(By.css("pre")).getText()));
        assert.equal(diagnostic.mutation_state, mutation);
        assert.equal(diagnostic.message, failure.presentation.technical_message);
        await executeBrowserScript(
          browser,
          (element) => element.scrollIntoView({ block: "center" }),
          outcome,
        );
        const image = path.join(output, `native-reviewed-update-outcome-${mutation}.png`);
        await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
        artifacts.push(image);
        await captureAccessibilityReport(
          browser,
          path.join(output, `reviewed-update-outcome-${mutation}-accessibility.json`),
          artifacts,
        );
        await clickVisible(browser, await browser.findElement(button("Review game update")));
        await browser.wait(until.elementLocated(dialog), 5_000);
        await clickVisible(browser, await browser.findElement(button("Cancel review")));
        await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
        observation.review_cancelled_without_reapply = true;
      } catch (error) {
        scenarioError = error;
        observation.failure = errorMessage(error);
        try {
          const image = path.join(
            output,
            `reviewed-update-outcome-${mutation}-failure-before-restoration.png`,
          );
          await writeFile(image, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(image);
        } catch (captureError) {
          observation.failure_capture_error = errorMessage(captureError);
        }
        throw error;
      } finally {
        const cleanup = await probe.restore();
        Object.assign(observation, cleanup);
        requireTrustedProbeCleanup(cleanup, scenarioError);
      }
      assert.deepEqual(observation.mismatches, []);
      assert.equal(observation.plans, 2);
      assert.equal(observation.applies, 1);
      assert.equal(observation.channels, 1);
      assert.equal(observation.restored, true);
    }
    await clickVisible(browser, await browser.findElement(button("Review game update")));
    await browser.wait(until.elementLocated(dialog), 5_000);
    await clickVisible(browser, await browser.findElement(button("Cancel review")));
    await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5_000);
    observations.ordinary_review_restored = true;
    observations.after = transportValue("status", command(["status", port.id]));
    observations.sources_after = transportValues("source", command(["source", "list"]));
    observations.activities_after = await readActivities();
    assert.deepEqual(observations.after, observations.before);
    assert.deepEqual(observations.sources_after, observations.sources_before);
    assert.deepEqual(observations.activities_after, observations.activities_before);
  } catch (error) {
    primaryError = error;
  } finally {
    const report = path.join(output, "reviewed-update-outcome-observations.json");
    try {
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
      artifacts.push(report);
    } catch (error) {
      reportError = error;
      console.error("Owned update observation report failed:", errorMessage(error));
    }
  }
  if (primaryError) rethrowFailure(primaryError);
  if (reportError) rethrowFailure(reportError);
}

interface SummaryStatus {
  port_id: string;
  active?: unknown;
  external_runtime?: unknown;
  staged?: unknown;
  readiness?: { launchable: boolean; pending_setup: boolean; blockers: readonly unknown[] } | null;
}
export function assertPreparedLibrarySummary(
  text: string,
  statuses: readonly SummaryStatus[],
  preparedPortId: string,
) {
  const installed = statuses.filter((item) => item.active || item.external_runtime);
  assert.ok(installed.some((item) => item.port_id === preparedPortId));
  for (const item of installed) {
    assert.equal(item.readiness?.launchable, true, `${item.port_id} must be ready`);
    assert.equal(required(item.readiness).pending_setup, false);
    assert.deepEqual(required(item.readiness).blockers, []);
    assert.ok(!item.staged, `${item.port_id} must have no downloaded update`);
  }
  assert.equal(text.replace(/\s+/gu, " ").trim(), `${installed.length} in library All can launch`);
}

export async function preparationScenarios({
  browser,
  invoke: invokeRaw,
  scenario,
  library,
  output,
  artifacts,
  cli,
  tool,
  confirmNative,
  restartApplication,
  interruptApplication,
  closeApplication,
  captureLivePreparation,
  chooseOwnedLibrary,
}: PreparationContext) {
  const invoke = async (name: string, args?: Record<string, unknown>) =>
    object(await invokeRaw(name, args));
  const read = async <Contract extends keyof TransportOutputs>(
    contract: Contract,
    name: string,
    args?: Record<string, unknown>,
  ) => {
    const response = await invoke(name, args);
    assert.equal(response.ok, true);
    return transportValue(contract, response.value);
  };
  const command = ownedFixtureCommand({ cli, library, output });
  const host: Platform =
    process.platform === "win32"
      ? "windows-x86-64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "macos-aarch64"
          : "macos-x86-64"
        : "linux-x86-64";
  const seeded = new Map<
    string,
    {
      mode: string;
      chd: boolean;
      value: { port: PortDefinition; install: Pick<InstallRecord, "id"> };
    }
  >();
  async function seed(portId: string, mode: string, chd = false) {
    const previous = seeded.get(portId);
    if (previous) {
      assert.equal(previous.mode, mode, `Fixture mode changed for ${portId}`);
      assert.equal(previous.chd, chd, `Fixture source kind changed for ${portId}`);
      return previous.value;
    }
    const port = transportValue("port", command(["catalog", "show", portId]));
    const original = path.join(output, `owned-${portId}`);
    await mkdir(original);
    for (const relative of [
      required(required(port.executable_hints[host])[0]),
      required(required(port.setup_executable_hints[host])[0]),
    ]) {
      const destination = path.join(original, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(tool, destination);
    }
    await writeFile(path.join(original, "owned-setup-mode"), mode);
    // Adoption has no exported root schema. Consume only its validated ID,
    // retaining the complete response without claiming other fields were checked.
    const adopted = object(command(["adopt", original, "--port", portId, "--yes"]));
    const id = adopted.id;
    assert.equal(typeof id, "string");
    assert.ok(typeof id === "string");
    const install = { ...adopted, id };
    if (chd) command(["tool", "set-path", "chdman", tool]);
    const source = path.join(output, `${portId}.${chd ? "chd" : "iso"}`);
    await writeFile(source, "owned source awaiting upstream validation");
    command(["source", "add", required(port.source_profile), source]);
    const value = { port, install };
    seeded.set(portId, { mode, chd, value });
    return value;
  }
  const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
  async function dismissApplicationUpdateChoice() {
    const preferences = await invoke("get_application_update_preferences");
    assert.equal(preferences.ok, true);
    if (transportValue("desktop_application_update_preferences", preferences.value).choice !== null)
      return;
    const choice = By.xpath(
      '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]',
    );
    await browser.wait(until.elementLocated(choice), 15_000);
    await browser
      .findElement(
        By.xpath(
          '//section[@role="status" and .//strong[normalize-space(.)="Choose how Portcove updates"]]//button[normalize-space(.)="Not now"]',
        ),
      )
      .click();
    await browser.wait(async () => (await browser.findElements(choice)).length === 0, 15_000);
  }
  async function open(port: PortDefinition, waitForPreparation = true) {
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(`//button[@data-detail-game-id="${port.id}"]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    if (waitForPreparation)
      await browser.wait(until.elementLocated(button("Review game preparation")), 15_000);
  }
  async function status(portId: string) {
    const result = await invoke("get_statuses");
    assert.equal(result.ok, true);
    return required(
      transportValues("status", result.value).find((item) => item.port_id === portId),
    );
  }
  async function activities() {
    const result = await invoke("get_activities");
    assert.equal(result.ok, true);
    return transportValue("activity", result.value).records;
  }
  await scenario("native-preparation-review-and-play", async () => {
    const { port, install } = await seed("opengoal-jak1", "success");
    await open(port);
    assert.equal(required((await status(port.id)).readiness).launchable, false);
    const preparationHierarchy = await executeBrowserScript(browser, () => {
      const actions = document.querySelector('section[aria-label="Game actions"]');
      return {
        heading: actions?.querySelector("h2")?.textContent,
        firstAction: actions?.querySelector("button:not(:disabled)")?.textContent?.trim(),
        disabledPlaceholder: actions?.textContent?.includes("Prepare game data first"),
        owner: actions?.getAttribute("data-task-owner"),
      };
    });
    assert.equal(preparationHierarchy.heading, "Next step: prepare game data");
    assert.equal(preparationHierarchy.firstAction, "Review game preparation");
    assert.equal(preparationHierarchy.disabledPlaceholder, false);
    assert.ok(preparationHierarchy.owner?.startsWith(`${port.id}:`));
    const outputLocationInput = await browser.findElement(By.id(`output-location-path-${port.id}`));
    const reviewedOutput = path.join(output, "reviewed-future-output");
    await outputLocationInput.sendKeys(
      Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
      reviewedOutput,
    );
    const outputLocationTrigger = await browser.findElement(button("Review future folder"));
    await clickVisible(browser, outputLocationTrigger);
    const outputLocationDialog = By.css('[aria-labelledby="output-location-review-title"]');
    const review = await browser.wait(until.elementLocated(outputLocationDialog), 15_000);
    const reviewText = await review.getText();
    assert.ok(reviewText.includes(reviewedOutput));
    assert.ok(reviewText.includes("Future placement only"));
    assert.ok(reviewText.includes("does not move an existing installation"));
    await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Use this folder for future installs")),
      await browser.findElement(button("Cancel review")),
    );
    await assertCompactReview(browser, '[aria-labelledby="output-location-review-title"]');
    const outputLocationAccessibility = path.join(
      output,
      "output-location-review-accessibility.json",
    );
    await captureAccessibilityReport(browser, outputLocationAccessibility, artifacts);
    const outputLocationImage = path.join(output, "native-output-location-review.png");
    await writeFile(outputLocationImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(outputLocationImage);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(outputLocationDialog)).length === 0,
      5_000,
      "Output location review did not close after Escape",
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0];",
          outputLocationTrigger,
        ),
      5_000,
      "Output location review trigger did not regain focus after Escape",
    );
    assert.equal(
      required((await status(port.id)).active).id,
      install.id,
      "review must not move versions",
    );
    await browser.findElement(button("Review game preparation")).click();
    const preparationDialog = By.css('[aria-labelledby="preparation-review-title"]');
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
    assert.equal(
      required((await status(port.id)).active).id,
      install.id,
      "review must not prepare",
    );
    const preparationText = await browser.findElement(preparationDialog).getText();
    for (const expected of [
      "Prepare game data",
      "Selected game files",
      "of free space before the game generates output",
      "previous version remains available for rollback",
      "unfinished setup files kept for review",
      "Do not launch the game from that window",
    ])
      assert.ok(preparationText.includes(expected), `preparation review omitted ${expected}`);
    const preparationLayout = await executeBrowserScript(browser, () => {
      const plan = document.querySelector(
        '[aria-labelledby="preparation-review-title"] .preparation-plan',
      );
      const paragraph = plan?.querySelector("p");
      return {
        planWidth: plan?.getBoundingClientRect().width ?? 0,
        paragraphWidth: paragraph?.getBoundingClientRect().width ?? 0,
      };
    });
    assert.ok(
      preparationLayout.planWidth > 300 &&
        preparationLayout.paragraphWidth > preparationLayout.planWidth * 0.8,
      `preparation review text is cramped: ${JSON.stringify(preparationLayout)}`,
    );
    await assertPrimaryReviewAction(
      browser,
      await browser.findElement(button("Prepare game data")),
      await browser.findElement(button("Cancel review")),
    );
    await assertCompactReview(browser, '[aria-labelledby="preparation-review-title"]');
    const reviewImage = path.join(output, "native-preparation-review.png");
    await writeFile(reviewImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(reviewImage);
    const accessibilityReport = path.join(output, "preparation-accessibility.json");
    await captureAccessibilityReport(browser, accessibilityReport, artifacts);
    const reviewWindow = await browser.manage().window().getRect();
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = async (key: string) =>
      browser.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
      for (let step = 0; step < 7; step++) await shortcut("+");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () =>
              localStorage.getItem("portcove.appearance.interface-size") === "400" &&
              innerWidth <= 240,
          ),
        10_000,
        "Preparation review did not reach actual native 400% enlargement",
      );
      await assertCompactReview(browser, '[aria-labelledby="preparation-review-title"]');
      const confirm = await browser.findElement(button("Prepare game data"));
      await executeBrowserScript(
        browser,
        (element) => {
          element.scrollIntoView({ block: "center" });
          (element as HTMLElement).focus();
        },
        confirm,
      );
      assert.equal(await confirm.isDisplayed(), true);
      assert.equal(await confirm.isEnabled(), true);
      const visibleAction = async (element: WebElement) => {
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (control) => {
                const bounds = control.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                );
                return (
                  document.activeElement === control &&
                  bounds.top >= 0 &&
                  bounds.bottom <= innerHeight + 1 &&
                  bounds.left >= 0 &&
                  bounds.right <= innerWidth + 1 &&
                  (hit === control || (hit !== null && control.contains(hit)))
                );
              },
              element,
            ),
          5_000,
          "Enlarged review action is not focused, in the viewport and unobscured",
        );
      };
      await visibleAction(confirm);
      await browser.actions().sendKeys(Key.TAB).perform();
      const cancel = await browser.findElement(button("Cancel review"));
      await visibleAction(cancel);
      const enlarged = path.join(output, "preparation-native-400-observation.json");
      await writeFile(
        enlarged,
        JSON.stringify(
          await executeBrowserScript(browser, () => ({
            width: innerWidth,
            height: innerHeight,
            zoomPreference: localStorage.getItem("portcove.appearance.interface-size"),
            focus: document.activeElement?.textContent?.trim(),
            dialog: document.querySelector('[aria-labelledby="preparation-review-title"]')
              ?.textContent,
          })),
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(enlarged);
      // Exercise the real dismissal at enlargement; focus and geometry alone
      // do not establish that the action can actually be used.
      await cancel.click();
      await browser.wait(
        async () => (await browser.findElements(preparationDialog)).length === 0,
        5_000,
      );
      assert.equal(
        required((await status(port.id)).active).id,
        install.id,
        "Enlarged dismissal must not prepare",
      );
    } finally {
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => localStorage.getItem("portcove.appearance.interface-size") === "100",
          ),
        10_000,
      );
      await browser.manage().window().setRect(reviewWindow);
    }
    await clickVisible(browser, await browser.findElement(button("Review game preparation")));
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(preparationDialog)).length === 0,
      5_000,
      "Preparation review did not close after Escape",
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          'return document.activeElement?.textContent?.trim() === "Review game preparation";',
        ),
      5_000,
      "Preparation review trigger did not regain focus after Escape",
    );
    assert.equal(
      required((await status(port.id)).active).id,
      install.id,
      "dismissal must not prepare",
    );
    await browser.findElement(button("Review game preparation")).click();
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.findElement(button("Prepare game data")).click();
    await browser.wait(async () => required((await status(port.id)).readiness).launchable, 15_000);
    const prepared = await status(port.id);
    assert.notEqual(required(prepared.active).id, install.id);
    assert.equal(required(prepared.previous).id, install.id);
    const log = path.join(required(prepared.active).path, "data/log/setup.log");
    await writeFile(log, "setup must not run during desktop Play");
    // This fixture's preliminary source is available but has no exact identity.
    // Preparation does not upgrade that evidence into confirmed compatibility.
    const trialLaunch = By.css("section[data-detail-workspace] .primary-actions button");
    const trial = await browser.wait(
      async () => {
        const current = (await browser.findElements(trialLaunch))[0];
        return current &&
          (await current.isDisplayed()) &&
          (await current.getText()) === "Try launch" &&
          (await current.isEnabled())
          ? current
          : false;
      },
      15_000,
      "Prepared Core state did not reach the rendered trial-launch action",
    );
    assert.ok(trial, "Rendered trial-launch action must be available");
    assert.equal(await trial.getText(), "Try launch");
    await browser.wait(until.elementIsEnabled(trial), 15_000);
    await browser.wait(
      () => executeBrowserScript(browser, (element) => document.activeElement === element, trial),
      5_000,
      "Successful preparation did not hand focus to the available launch action",
    );
    await trial.click();
    await browser.wait(async () => (await status(port.id)).successful_launches > 0, 15_000);
    assert.equal(await readFile(log, "utf8"), "setup must not run during desktop Play");
    await browser.findElement(By.css(".detail-back")).click();
    const readinessSummary = await browser.wait(
      until.elementLocated(By.css('[aria-label="Library readiness"]')),
      15_000,
    );
    const readinessText = await readinessSummary.getText();
    const libraryStatuses = await invoke("get_statuses");
    assert.equal(libraryStatuses.ok, true);
    assertPreparedLibrarySummary(
      readinessText,
      transportValues("status", libraryStatuses.value),
      port.id,
    );
    assert.doesNotMatch(readinessText, /0 (?:needs? attention|updates? downloaded)/iu);
    const card = await browser.wait(
      until.elementLocated(By.xpath(`//article[.//button[@data-detail-game-id="${port.id}"]]`)),
      15_000,
    );
    const cardActions = await executeBrowserScript(
      browser,
      (element) => {
        const details = element.querySelector<HTMLButtonElement>(
          '[data-detail-origin^="library:card:"]',
        );
        const play = [...element.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Try launch",
        );
        const more = element.querySelector('button[aria-label^="More actions for "]');
        const workspace = element.closest("main");
        if (!details || !play || !more || !workspace)
          throw new Error("Library card controls are missing");
        const cardBounds = element.getBoundingClientRect();
        const detailsBounds = details.getBoundingClientRect();
        const playBounds = play.getBoundingClientRect();
        const moreBounds = more.getBoundingClientRect();
        const detailsStyle = getComputedStyle(details);
        details.focus();
        return {
          tag: element.tagName,
          details: (details.textContent ?? "").trim(),
          details_tag: details.tagName,
          details_label: details.getAttribute("aria-label"),
          details_slot: details.getAttribute("data-slot"),
          details_variant: details.getAttribute("data-variant"),
          play: play.textContent.trim(),
          play_disabled: play.disabled,
          play_slot: play.getAttribute("data-slot"),
          play_variant: play.getAttribute("data-variant"),
          more_label: more.getAttribute("aria-label"),
          more_popup: more.getAttribute("aria-haspopup"),
          workspace_horizontal_overflow: workspace.scrollWidth > workspace.clientWidth + 1,
          card_horizontal_overflow: element.scrollWidth > element.clientWidth + 1,
          actions_fit_card:
            detailsBounds.left >= cardBounds.left &&
            playBounds.right <= cardBounds.right &&
            moreBounds.right <= cardBounds.right,
          details_color: detailsStyle.color,
          details_background: getComputedStyle(element).backgroundColor,
          nested_interactive: element.querySelectorAll("button button, button a, a button, a a")
            .length,
          details_focused: document.activeElement === details,
        };
      },
      card,
    );
    const {
      details_color: detailsColor,
      details_background: detailsBackground,
      ...cardStructure
    } = cardActions;
    assert.deepEqual(cardStructure, {
      tag: "ARTICLE",
      details: "Jak and Daxter: The Precursor Legacy",
      details_tag: "BUTTON",
      details_label: `View details for Jak and Daxter: The Precursor Legacy · ${port.name}`,
      details_slot: null,
      details_variant: null,
      play: "Try launch",
      play_disabled: false,
      play_slot: "button",
      play_variant: "primary",
      more_label: `More actions for Jak and Daxter: The Precursor Legacy · ${port.name}`,
      more_popup: "menu",
      workspace_horizontal_overflow: false,
      card_horizontal_overflow: false,
      actions_fit_card: true,
      nested_interactive: 0,
      details_focused: true,
    });
    assert.match(detailsBackground, /^rgb\(/u, "Card contrast requires its opaque painted surface");
    const detailsContrast = contrastRatio(detailsColor, detailsBackground);
    assert.ok(
      detailsContrast >= 4.5,
      `Library View details contrast ${detailsContrast} is below AA`,
    );
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "center" }),
      card,
    );
    const actionsImage = path.join(output, "library-distinct-card-actions.png");
    await writeFile(actionsImage, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(actionsImage);

    const more = await card.findElement(By.css('button[aria-label^="More actions for "]'));
    await more.click();
    await browser.wait(until.elementLocated(By.css('[role="menu"]')), 5000);
    const menuImage = path.join(output, "library-overflow-menu.png");
    await writeFile(menuImage, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(menuImage);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(By.css('[role="menu"]'))).length === 0,
      5000,
      "Library overflow did not close after Escape",
    );
    await browser.wait(
      () => executeBrowserScript(browser, (element) => document.activeElement === element, more),
      5000,
      "Closing Library overflow must restore its trigger",
    );
    await more.click();
    await browser
      .wait(
        until.elementLocated(
          By.xpath('//*[@role="menuitem" and normalize-space()="Updates and activity"]'),
        ),
        5000,
      )
      .click();
    const updatesHeading = await browser.wait(
      until.elementLocated(By.css("#detail-updates")),
      5000,
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          updatesHeading,
        ),
      5000,
      "Overflow update navigation must focus its detail heading",
    );
    await browser.findElement(By.css(".detail-back")).click();
    const returnMore = await browser.wait(
      until.elementLocated(By.css(`button[data-detail-origin="library:card-more:${port.id}"]`)),
      5000,
    );
    await browser.wait(
      () =>
        executeBrowserScript(browser, (element) => document.activeElement === element, returnMore),
      5000,
      "Returning from overflow details must focus the originating card menu",
    );
  });
  await scenario("native-ready-detail-composition", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const readyStatus = await status(port.id);
    assert.equal(required(readyStatus.readiness).launchable, true);
    assert.ok(readyStatus.active);
    assert.equal(readyStatus.channel, "stable");
    assert.equal(readyStatus.active.channel, "stable");
    assert.ok(!readyStatus.last_update_check);
    const originalWindow = await browser.manage().window().getRect();
    try {
      for (const theme of ["dark", "light"]) {
        await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
        await browser
          .findElement(
            By.css(
              'nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]',
            ),
          )
          .click();
        await browser.findElement(button(theme === "dark" ? "Dark" : "Light")).click();
        await open(port, false);
        assert.equal(
          await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
          theme,
        );
        const play = await browser.wait(until.elementLocated(button("Play")), 15_000);
        assert.equal(await play.isEnabled(), true);
        assert.equal(await play.getAttribute("data-variant"), "primary");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              () =>
                document.querySelector(".detail-cover.artwork-image > span")?.textContent === "OJ",
            ),
          15_000,
          "The owned port cover fallback did not settle before visual capture",
        );
        for (const { width, height } of [
          { width: 960, height: 640 },
          { width: 1280, height: 800 },
        ]) {
          await browser.manage().window().setRect({ width, height });
          const actualWindow = await browser.manage().window().getRect();
          assert.deepEqual(
            { width: actualWindow.width, height: actualWindow.height },
            { width, height },
            `Ready detail window was clamped: ${JSON.stringify(actualWindow)}`,
          );
          const hierarchy = await executeBrowserScript(
            browser,
            (action) => {
              const bounds = action.getBoundingClientRect();
              const main = document.querySelector("main");
              return {
                title: document.querySelector("#port-detail-title")?.textContent?.trim(),
                state: document.querySelector(".detail-hero .hero-state")?.textContent?.trim(),
                groups: [...document.querySelectorAll(".detail-body .detail-group > h2")].map(
                  (heading) => heading.textContent?.trim(),
                ),
                action: {
                  top: bounds.top,
                  bottom: bounds.bottom,
                  left: bounds.left,
                  right: bounds.right,
                },
                viewport: { width: window.innerWidth, height: window.innerHeight },
                horizontalOverflow: Boolean(main && main.scrollWidth > main.clientWidth + 1),
              };
            },
            play,
          );
          const screenshot = path.join(output, `game-details-ready-${theme}-${width}.png`);
          await writeFile(screenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(screenshot);
          assert.equal(hierarchy.title, port.name);
          assert.match(required(hierarchy.state), /Ready to play/);
          assert.deepEqual(hierarchy.groups, [
            "Status and actions",
            "Requirements",
            "Installation and version",
            "Updates",
            "Saves and storage",
            "Compatibility and testing",
            "Project and release",
          ]);
          assert.equal(hierarchy.horizontalOverflow, false);
          assert.ok(
            hierarchy.action.top >= 0 &&
              hierarchy.action.bottom <= hierarchy.viewport.height &&
              hierarchy.action.left >= 0 &&
              hierarchy.action.right <= hierarchy.viewport.width,
            `Play must remain visible at ${actualWindow.width}x${actualWindow.height}: ${JSON.stringify(hierarchy)}`,
          );
          const facts = await executeBrowserScript(browser, () => {
            const strip = document.querySelector(".installation-facts");
            strip?.scrollIntoView({ block: "center", behavior: "instant" });
            return {
              items: [...(strip?.querySelectorAll(":scope > div") ?? [])].map((item) => [
                item.querySelector("dt")?.textContent?.trim(),
                item.querySelector("dd")?.textContent?.trim(),
              ]),
              horizontalOverflow: Boolean(strip && strip.scrollWidth > strip.clientWidth + 1),
            };
          });
          assert.deepEqual(facts.items, [
            ["Installed version", readyStatus.active.version],
            ["Selected channel", "Stable"],
            ["Installed channel", "Stable"],
            ["Latest eligible release", "No current check"],
            ["Installed folder", readyStatus.active.path],
          ]);
          assert.equal(facts.horizontalOverflow, false);
          const factsScreenshot = path.join(output, `game-details-facts-${theme}-${width}.png`);
          await writeFile(factsScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(factsScreenshot);
          await executeBrowserScript(browser, () =>
            document.querySelector("main")?.scrollTo({ top: 0 }),
          );
        }
      }
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
  });
  await scenario("native-game-return-continuity", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const before = await status(port.id);
    assert.equal(required(before.readiness).launchable, true);
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const originalWindow = await browser.manage().window().getRect();
    try {
      await browser.manage().window().setRect({ width: 720, height: 560 });
      const query = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
      await query.sendKeys(port.name);
      const ready = await browser.findElement(
        By.xpath('//div[@aria-label="Library filters"]//button[normalize-space(.)="Ready"]'),
      );
      await ready.click();
      const card = await browser.wait(
        until.elementLocated(By.xpath(`//article[.//button[@data-detail-game-id="${port.id}"]]`)),
        15_000,
      );
      const play = await card.findElement(By.xpath('.//button[normalize-space(.)="Play"]'));
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center" }),
        play,
      );
      const scrollBefore = await executeBrowserScript(browser, () => {
        const workspace = document.querySelector('main[data-focus-region="workspace"]');
        if (!workspace) throw new Error("Library workspace is missing");
        return workspace.scrollTop;
      });
      assert.ok(scrollBefore > 0, "The compact Library fixture must exercise a real scroll");
      await play.click();
      await browser.wait(
        async () => (await status(port.id)).successful_launches > before.successful_launches,
        15_000,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (portName, launches) => {
              const recent = document.querySelector<HTMLElement>(".continue-card");
              return (
                recent?.getAttribute("aria-label") === `Continue ${portName}` &&
                Number(recent.dataset.successfulLaunches ?? 0) > launches
              );
            },
            port.name,
            before.successful_launches,
          ),
        15_000,
        "Library did not render the completed launch after the game exited",
      );
      const returned = await executeBrowserScript(
        browser,
        (element) => {
          const workspace = document.querySelector('main[data-focus-region="workspace"]');
          const search = document.querySelector<HTMLInputElement>("#port-search");
          const ready = document.querySelector(
            '[aria-label="Library filters"] button[aria-pressed="true"]',
          );
          const card = element.closest("article.port-card");
          const bounds = card?.getBoundingClientRect();
          const workspaceBounds = workspace?.getBoundingClientRect();
          return {
            query: search?.value,
            filter: ready?.textContent?.trim(),
            scrollTop: workspace?.scrollTop,
            playFocused: document.activeElement === element,
            playConnected: element.isConnected,
            cardVisible:
              bounds && workspaceBounds
                ? bounds.bottom > workspaceBounds.top && bounds.top < workspaceBounds.bottom
                : false,
          };
        },
        play,
      );
      assert.equal(returned.query, port.name);
      assert.equal(returned.filter, "Ready");
      assert.equal(returned.playConnected, true);
      assert.equal(returned.playFocused, true);
      assert.equal(returned.cardVisible, true);
      assert.ok(
        Math.abs(required(returned.scrollTop) - scrollBefore) <= 2,
        `Library scroll changed after game return: ${scrollBefore} -> ${returned.scrollTop}`,
      );
      const screenshot = path.join(output, "native-game-return-continuity.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
  });
  await scenario("native-game-update-review", async () => {
    const { port } = await seed("opengoal-jak1", "success");
    await open(port, false);
    const updateControl = await browser.findElement(
      By.css('section[aria-label="Review game update"]'),
    );
    await clickVisible(
      browser,
      await updateControl.findElement(By.css('[data-slot="select-trigger"]')),
    );
    await clickVisible(
      browser,
      await browser.findElement(
        By.xpath('//*[@role="option" and normalize-space(.)="Keep update for later"]'),
      ),
    );
    assert.ok((await updateControl.getText()).includes("Keep update for later"));
    const before = await status(port.id);
    const activityBefore = (await invoke("get_activities")).value;
    const trigger = await browser.findElement(button("Review game update"));
    await clickVisible(browser, trigger);
    const dialog = By.css('[aria-labelledby="game-update-review-title"]');
    const review = await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.wait(
      async () => (await review.getText()).includes("Confirm the release"),
      5_000,
      "Game update review did not show its release confirmation",
    );
    const reviewText = await review.getText();
    const bootstrap = await read("desktop_bootstrap_status", "get_bootstrap_status");
    const candidate = await read("game_update_plan", "plan_game_update", {
      portId: port.id,
      activate: false,
      generation: bootstrap.generation,
    });
    assert.ok(reviewText.includes("Confirm the release"));
    assert.ok(reviewText.includes(candidate.plan.release.version));
    if (["download", "use_staged", "reuse_retained"].includes(candidate.plan.action))
      assert.ok(
        reviewText.includes(
          "This keeps the verified update for later. Your current version stays unchanged.",
        ),
      );
    assert.ok(
      reviewText.includes("Saved update settings are unchanged") ||
        reviewText.includes("already active") ||
        reviewText.includes("unverified local copy"),
    );
    await assertCompactReview(browser, '[aria-labelledby="game-update-review-title"]');
    const accessibility = path.join(output, "game-update-review-accessibility.json");
    await captureAccessibilityReport(browser, accessibility, artifacts);
    const screenshot = path.join(output, "native-game-update-review.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
    assert.deepEqual((await status(port.id)).active, before.active);
    assert.deepEqual((await invoke("get_activities")).value, activityBefore);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(dialog)).length === 0,
      5_000,
      "Game update review did not close after Escape",
    );
    await browser.wait(
      () =>
        executeBrowserScript(browser, "return document.activeElement === arguments[0];", trigger),
      5_000,
      "Game update review trigger did not regain focus after Escape",
    );
    await assertReviewedUpdateOutcomes({
      browser,
      port,
      candidate,
      generation: bootstrap.generation,
      command,
      invoke,
      output,
      artifacts,
    });
    const originalWindow = await browser.manage().window().getRect();
    try {
      for (const theme of ["dark", "light"]) {
        await openUpdateTheme(browser, theme);
        const row = await browser.wait(
          until.elementLocated(By.css(`[data-detail-origin="updates:installed:${port.id}"]`)),
          15_000,
        );
        for (const { width, height } of updateReviewWindows) {
          await browser.manage().window().setRect({ width, height });
          await executeBrowserScript(browser, (element) => element.scrollIntoView(), row);
          const comparison = await executeBrowserScript(
            browser,
            (element) => {
              const blocks = [...element.querySelectorAll(".update-version")];
              return {
                rowOverflow: element.scrollWidth > element.clientWidth + 1,
                documentOverflow:
                  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                blocks: blocks.map((block) => {
                  const label = block.querySelector("small");
                  const value = block.querySelector("span");
                  const rect = block.getBoundingClientRect();
                  return {
                    label: label?.textContent?.trim(),
                    value: value?.textContent?.trim(),
                    visible: getComputedStyle(block).display !== "none" && rect.width > 0,
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                  };
                }),
              };
            },
            row,
          );
          assert.equal(comparison.rowOverflow, false);
          assert.equal(comparison.documentOverflow, false);
          assert.deepEqual(
            comparison.blocks.map(({ label }) => label),
            ["Installed", "Latest eligible"],
          );
          assert.ok(comparison.blocks.every(({ visible, value }) => visible && value));
          if (width === 960)
            assert.ok(
              required(comparison.blocks[0]).bottom <= required(comparison.blocks[1]).top + 1,
            );
          else
            assert.ok(
              required(comparison.blocks[0]).right <= required(comparison.blocks[1]).left + 1,
            );
          const comparisonScreenshot = path.join(
            output,
            `native-game-update-comparison-${theme}-${width}x${height}.png`,
          );
          await writeFile(comparisonScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(comparisonScreenshot);
          await selectActivitySection(browser, "Tasks & history");
          await assertActivityLabelSeparation(browser, width);
          const historyScreenshot = path.join(
            output,
            `native-task-history-${theme}-${width}x${height}.png`,
          );
          await writeFile(historyScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(historyScreenshot);
          await selectActivitySection(browser, "Updates");
        }
      }
      await assertIndividualUpdateFailure({ browser, port, command, output, artifacts });
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
  });
  await readinessScenario({
    browser,
    scenario,
    output,
    artifacts,
    command,
    open,
  });
  await scenario("native-retained-contract-repair-state", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const active = required((await status(port.id)).active);
    const manifest = path.join(active.path, ".portcove-manifest.json");
    const original = await readFile(manifest);
    assert.equal(object(JSON.parse(original.toString("utf8"))).schema_version, 6);
    try {
      await writeFile(manifest, "owned corrupt contract fixture");
      await open(port, false);
      const damaged = await status(port.id);
      assert.equal(required(damaged.readiness).launchable, false);
      assert.deepEqual(required(damaged.readiness).blockers, ["invalid_installation"]);
      await browser.wait(
        until.elementLocated(By.xpath('//*[normalize-space(.)="Installation needs repair"]')),
        15_000,
      );
      assert.equal((await browser.findElements(button("Play"))).length, 0);
      assert.equal((await browser.findElements(button("Choose required source"))).length, 0);
      const verify = await browser.findElement(By.css(".primary-actions button"));
      assert.equal(await verify.getText(), "Verify installation");
      assert.equal(await verify.isEnabled(), true);
      assert.equal((await browser.findElements(button("Verify installation"))).length, 1);
      await clickVisible(browser, verify);
      await browser.wait(
        until.elementLocated(By.css('.error-banner[role="alert"]')),
        15_000,
        "Damaged installation verification did not expose its actual failure",
      );
      await browser.wait(
        async () => (await browser.findElement(By.css(".primary-actions button"))).isEnabled(),
        5_000,
      );
      assert.deepEqual(required((await status(port.id)).readiness).blockers, [
        "invalid_installation",
      ]);
      assert.deepEqual(
        transportValue("status", command(["status", port.id])).readiness,
        damaged.readiness,
      );
      const report = path.join(output, "retained-contract-accessibility.json");
      await captureAccessibilityReport(browser, report, artifacts);
      const screenshot = path.join(output, "native-retained-contract-repair.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    } finally {
      await writeFile(manifest, original);
    }
    await open(port, false);
    assert.equal(required((await status(port.id)).readiness).launchable, true);

    const before = transportValue("status", command(["status", port.id]));
    assert.ok(before.previous, "The preparation dependency must retain the original version");
    const previousManifest = path.join(required(before.previous).path, ".portcove-manifest.json");
    const previousOriginal = await readFile(previousManifest);
    const retainedManifest = path.join(output, "rollback-previous-manifest.before.json");
    await writeFile(retainedManifest, previousOriginal, { flag: "wx" });
    artifacts.push(retainedManifest);
    const sources = transportValues("source", command(["source", "list"]));
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const activityBefore = await activities();
    assert.ok(port.persistent_paths.length > 0);
    const save = path.join(
      paths.user_data_root,
      required(port.persistent_paths[0]),
      "owned-rollback-preserved.bin",
    );
    const activeSave = path.join(
      required(before.active).path,
      required(port.persistent_paths[0]),
      "owned-rollback-preserved.bin",
    );
    for (const owned of [save, activeSave, previousManifest])
      assert.ok(
        rollbackWitnessWithinLibrary(library, owned),
        "Rollback witnesses stay in the isolated library",
      );
    await mkdir(path.dirname(save), { recursive: true });
    await mkdir(path.dirname(activeSave), { recursive: true });
    await writeFile(save, "owned rollback preservation witness");
    await writeFile(activeSave, "owned rollback preservation witness");
    const witness = await Promise.all(
      [save, path.join(output, `${port.id}.iso`)].map((file) => fileIdentity(file)),
    );
    const originalActiveSave = await fileIdentity(activeSave);
    assert.equal(originalActiveSave.bytes, required(witness[0]).bytes);
    assert.equal(originalActiveSave.sha256, required(witness[0]).sha256);
    async function restoredActiveSave(value: PortStatus) {
      const restored = await fileIdentity(
        path.join(
          required(value.active).path,
          required(port.persistent_paths[0]),
          "owned-rollback-preserved.bin",
        ),
      );
      assert.equal(restored.bytes, required(witness[0]).bytes);
      assert.equal(restored.sha256, required(witness[0]).sha256);
      return restored;
    }
    const rollbackDecision = (value: PortStatus) =>
      required(value.port_actions).find((item) => item.action === "rollback");
    type Rectangle = Pick<
      DOMRectReadOnly,
      "x" | "y" | "width" | "height" | "top" | "right" | "bottom" | "left"
    >;
    interface Geometry {
      bounds: Rectangle;
      fragments: Rectangle[];
      clipping: { left: number; top: number; right: number; bottom: number };
      settled: boolean;
    }
    const observations: {
      before: { active: string; previous: string };
      witness: FileIdentity[];
      original_active_save: FileIdentity;
      sources: SourceRecord[];
      held?: {
        decision: ReturnType<typeof rollbackDecision>;
        window: IRectangle;
        viewport: { width: number; height: number; device_scale: number };
        action: Geometry;
        reason: Geometry;
      };
      refusal?: Record<string, unknown>;
      previous_active_save?: FileIdentity;
      returned_active_save?: FileIdentity;
      after?: PortStatus;
      activity?: ActivityRecord[];
    } = {
      before: { active: required(before.active).id, previous: required(before.previous).id },
      witness,
      original_active_save: originalActiveSave,
      sources,
    };
    async function rollbackButton() {
      const target = await browser.findElement(button("Restore previous version"));
      if (!(await target.isDisplayed()))
        await clickVisible(
          browser,
          await browser.findElement(By.xpath('//summary[contains(., "Commands and maintenance")]')),
        );
      await browser.wait(until.elementIsVisible(target), 5_000);
      return target;
    }
    try {
      await writeFile(previousManifest, "owned corrupt previous contract fixture");
      await open(port, false);
      const held = await status(port.id);
      assert.deepEqual(rollbackDecision(held), {
        action: "rollback",
        availability: "held",
        reason: "invalid_installation",
      });
      assert.deepEqual(
        rollbackDecision(transportValue("status", command(["status", port.id]))),
        rollbackDecision(held),
      );
      const target = await rollbackButton();
      assert.equal(await target.isEnabled(), false);
      const reason = await browser.findElement(By.css("[data-rollback-assessment]"));
      assert.equal(
        await reason.getText(),
        "Portcove could not verify the previous version. Restore previous version is on hold.",
      );
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
        target,
      );
      const geometry = await executeBrowserScript(
        browser,
        (action, explanation) => {
          const viewport = {
            width: innerWidth,
            height: innerHeight,
            device_scale: devicePixelRatio,
          };
          const measure = (element: Element) => {
            const clipping = {
              left: 0,
              top: 0,
              right: document.documentElement.clientWidth,
              bottom: document.documentElement.clientHeight,
            };
            let settled = element.isConnected;
            for (let current: Element | null = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              settled &&=
                style.display !== "none" &&
                style.visibility === "visible" &&
                Number(style.opacity) > 0 &&
                !current
                  .getAnimations()
                  .some(
                    (animation) =>
                      animation.playState === "running" &&
                      Number.isFinite(animation.effect?.getComputedTiming().endTime),
                  );
              if (current === element) continue;
              const rect = current.getBoundingClientRect();
              if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
                clipping.left = Math.max(clipping.left, rect.left + current.clientLeft);
                clipping.right = Math.min(
                  clipping.right,
                  rect.left + current.clientLeft + current.clientWidth,
                );
              }
              if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
                clipping.top = Math.max(clipping.top, rect.top + current.clientTop);
                clipping.bottom = Math.min(
                  clipping.bottom,
                  rect.top + current.clientTop + current.clientHeight,
                );
              }
            }
            return {
              // lib.dom declares toJSON as any; DOMRect owns this fixed numeric projection.
              bounds: element.getBoundingClientRect().toJSON() as Rectangle,
              fragments: [...element.getClientRects()].map((rect) => rect.toJSON() as Rectangle),
              clipping,
              settled,
            };
          };
          return { viewport, action: measure(action), reason: measure(explanation) };
        },
        target,
        reason,
      );
      for (const measured of [geometry.action, geometry.reason]) {
        assert.equal(measured.settled, true);
        assert.ok(measured.fragments.length > 0);
        for (const bounds of [measured.bounds, ...measured.fragments])
          assert.ok(
            bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.left >= measured.clipping.left &&
              bounds.top >= measured.clipping.top &&
              bounds.right <= measured.clipping.right &&
              bounds.bottom <= measured.clipping.bottom,
          );
      }
      observations.held = {
        decision: rollbackDecision(held),
        window: await browser.manage().window().getRect(),
        ...geometry,
      };
      const screenshot = path.join(output, "native-rollback-held.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      const refused = spawnCommand(
        cli,
        ["--library", library, "--json", "--non-interactive", "rollback", port.id],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, PORTCOVE_PREFERENCES: path.join(output, "preferences.json") },
        },
      );
      assert.notEqual(refused.status, 0);
      const refusal = object(JSON.parse(refused.stdout));
      assert.equal(refusal.ok, false);
      assert.equal(object(refusal.error).code, "verification");
      observations.refusal = refusal;
      const unchanged = transportValue("status", command(["status", port.id]));
      assert.equal(required(unchanged.active).id, required(before.active).id);
      assert.equal(required(unchanged.previous).id, required(before.previous).id);
      assert.deepEqual(transportValues("source", command(["source", "list"])), sources);
      assert.deepEqual(await Promise.all(witness.map((item) => fileIdentity(item.path))), witness);
    } finally {
      await writeFile(previousManifest, previousOriginal);
    }
    await open(port, false);
    assert.deepEqual(rollbackDecision(await status(port.id)), {
      action: "rollback",
      availability: "allowed",
      reason: "available",
    });
    await clickVisible(browser, await rollbackButton());
    await browser.wait(
      async () => required((await status(port.id)).active).id === required(before.previous).id,
      15_000,
    );
    observations.previous_active_save = await restoredActiveSave(await status(port.id));
    await open(port, false);
    assert.deepEqual(rollbackDecision(await status(port.id)), {
      action: "rollback",
      availability: "allowed",
      reason: "available",
    });
    await clickVisible(browser, await rollbackButton());
    await browser.wait(
      async () => required((await status(port.id)).active).id === required(before.active).id,
      15_000,
    );
    observations.returned_active_save = await restoredActiveSave(await status(port.id));
    assert.deepEqual(observations.returned_active_save, originalActiveSave);
    assert.deepEqual(transportValues("source", command(["source", "list"])), sources);
    assert.deepEqual(await Promise.all(witness.map((item) => fileIdentity(item.path))), witness);
    observations.after = transportValue("status", command(["status", port.id]));
    observations.activity = await activities();
    const oldIds = new Set(activityBefore.map((item) => item.id));
    const rollbacks = observations.activity.filter(
      (item) => !oldIds.has(item.id) && item.operation === "rollback" && item.target_id === port.id,
    );
    assert.equal(rollbacks.filter((item) => item.status === "failed").length, 1);
    assert.equal(rollbacks.filter((item) => item.status === "succeeded").length, 2);
    const report = path.join(output, "rollback-assessment-recovery.json");
    await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
    artifacts.push(report);
  });

  await scenario("native-direct-preparation-recovery", async () => {
    const { port, install: seededInstall } = await seed("opengoal-jak1", "failure");
    const install = required((await status(port.id)).active);
    assert.equal(install.id, seededInstall.id);
    await open(port);
    const before = await activities();
    const observations: {
      port_id: string;
      active_installation_id: string;
      inputs: { path: string; sha256: string; bytes: number }[];
      failed_activity?: ActivityRecord;
      after_review?: PortStatus;
      failure?: string;
    } = { port_id: port.id, active_installation_id: install.id, inputs: [] };
    try {
      for (const input of [
        path.join(output, `${port.id}.iso`),
        path.join(install.path, required(port.executable_hints[host]?.[0])),
        path.join(install.path, required(port.setup_executable_hints[host]?.[0])),
        path.join(install.path, ".portcove-manifest.json"),
      ]) {
        const bytes = await readFile(input);
        observations.inputs.push({
          path: input,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        });
      }
      await browser.findElement(button("Review game preparation")).click();
      await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
      await browser.findElement(button("Prepare game data")).click();
      let observedFailure: ActivityRecord | undefined;
      await browser.wait(
        async () => {
          observedFailure = (await activities()).find(
            (item) =>
              item.operation === "prepare" &&
              item.target_id === port.id &&
              !before.some((old) => old.id === item.id) &&
              item.status === "failed",
          );
          return Boolean(observedFailure);
        },
        15_000,
        "The actual owned setup must fail and retain its Core report",
      );
      const failed = required(observedFailure);
      const failure = required(failed.failure);
      assert.equal(failure.code, "source_invalid");
      assert.equal(failure.presentation.mutation_state, "recovery_required");
      assert.equal(failure.presentation.phase, "preparation.setup");
      assert.deepEqual(failure.presentation.recovery_target, {
        kind: "preparation",
        port_id: port.id,
      });
      assert.ok(failure.presentation.recovery_actions.includes("review_preparation"));
      observations.failed_activity = failed;
      const action = By.css('[data-detail-origin="error:preparation-review"]');
      await browser.wait(until.elementLocated(action), 15_000);
      await browser
        .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
        .click();
      await browser.wait(
        async () =>
          (await browser.findElements(By.css("section[data-detail-workspace]"))).length === 0,
        15_000,
      );
      const inventory = await activities();
      const readOnlyReview = By.xpath(
        '//div[contains(@class,"error-actions")]//button[normalize-space(.)="Review current state"]',
      );
      await browser.findElement(readOnlyReview).click();
      assert.deepEqual(
        (await activities()).map((item) => item.id).sort(),
        inventory.map((item) => item.id).sort(),
      );
      await browser.findElement(action).click();
      await browser.wait(
        async () => {
          const titles = await browser.findElements(By.css("#port-detail-title"));
          return titles.length === 1 && (await required(titles[0]).getText()) === port.name;
        },
        15_000,
        "The direct error action must open its actual affected game",
      );
      assert.deepEqual(
        (await activities()).map((item) => item.id).sort(),
        inventory.map((item) => item.id).sort(),
      );
      assert.equal(required((await status(port.id)).active).id, install.id);
      assert.deepEqual(
        required((await activities()).find((item) => item.id === failed.id)).failure,
        failure,
      );
      for (const input of observations.inputs) {
        const bytes = await readFile(input.path);
        assert.equal(bytes.length, input.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256);
      }
      observations.after_review = await status(port.id);
      const image = path.join(output, "native-direct-preparation-recovery.png");
      await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(image);
    } catch (error) {
      observations.failure = String(error);
      throw error;
    } finally {
      const report = path.join(output, "direct-preparation-recovery.json");
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
      artifacts.push(report);
    }
  });
  const livePreparationCancellation = async (probeListener?: "late" | "reject") => {
    const { port, install } = await seed("opengoal-jak2", "wait", true);
    const other = !probeListener ? await seed("opengoal-jak1", "success") : undefined;
    await open(port);
    interface PhaseObservation {
      phase: string;
      observed_at: string;
      bootstrap_response?: Record<string, unknown>;
      bootstrap?: TransportOutputs["desktop_bootstrap_status"];
      activities?: ActivityRecord[];
      status?: PortStatus;
    }
    const observations: {
      port_id: string;
      phases: PhaseObservation[];
      inputs: {
        path: string;
        retained: string;
        size: number;
        sha256: string;
        after_sha256?: string;
      }[];
      failure?: { message: string; observed_at: string };
      listener_lifetime?: Awaited<ReturnType<typeof listenerLifetimeScenario>>;
      overlap?: { cli_refusal: unknown; unrelated_verification?: ActivityRecord };
    } = { port_id: port.id, phases: [], inputs: [] };
    const preparationIds = (items: readonly ActivityRecord[]) =>
      items
        .filter((item) => item.operation === "prepare" && item.target_id === port.id)
        .map((item) => item.id)
        .sort();
    const observe = async (phase: string) => {
      const observation: PhaseObservation = {
        phase,
        observed_at: new Date().toISOString(),
      };
      observations.phases.push(observation);
      const bootstrap = await invoke("get_bootstrap_status");
      observation.bootstrap_response = bootstrap;
      assert.equal(bootstrap.ok, true);
      const checkedBootstrap = transportValue("desktop_bootstrap_status", bootstrap.value);
      assert.equal(checkedBootstrap.ready, true);
      observation.bootstrap = checkedBootstrap;
      const activityRecords = await activities();
      observation.activities = activityRecords;
      const currentStatus = await status(port.id);
      observation.status = currentStatus;
      return {
        ...observation,
        bootstrap: checkedBootstrap,
        activities: activityRecords,
        status: currentStatus,
      };
    };
    let originalFailure;
    let evidenceFailure;
    try {
      const before = await observe("before-start");
      const baselineIds = preparationIds(before.activities);
      const activePath = required(before.status.active).path;
      for (const [index, input] of [
        path.join(output, `${port.id}.chd`),
        path.join(activePath, required(required(port.executable_hints[host])[0])),
        path.join(activePath, required(required(port.setup_executable_hints[host])[0])),
        path.join(activePath, "owned-setup-mode"),
        path.join(activePath, ".portcove-manifest.json"),
        ...(other ? [path.join(output, `${other.port.id}.iso`)] : []),
      ].entries()) {
        const bytes = await readFile(input);
        const retained = path.join(output, `live-reload-input-${index}.original`);
        await writeFile(retained, bytes, { flag: "wx" });
        artifacts.push(retained);
        observations.inputs.push({
          path: input,
          retained,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      await browser.findElement(button("Review game preparation")).click();
      await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
      await browser.findElement(button("Prepare game data")).click();
      let activity: ActivityRecord | undefined;
      await browser.wait(
        async () => {
          activity = (await activities()).find(
            (item) =>
              item.operation === "prepare" &&
              item.target_id === port.id &&
              item.status === "running",
          );
          return (
            activity &&
            (await stat(
              path.join(library, "staging", activity.id, "payload/data/out/setup-ready"),
            ).then(
              (value) => value.isFile(),
              () => false,
            ))
          );
        },
        15_000,
        "Preparation must reach its owned cancellation checkpoint",
      );
      const running = await observe("live-before-reload");
      assert.equal(
        running.activities.find((item) => item.id === required(activity).id)?.status,
        "running",
      );
      if (other) {
        // A separate CLI process must still refuse this target while the native
        // host owns preparation. Availability never grants a filesystem lock.
        const refused = spawnCommand(
          cli,
          ["--library", library, "--json", "--non-interactive", "verify", port.id],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
            env: { ...process.env, PORTCOVE_PREFERENCES: path.join(output, "preferences.json") },
          },
        );
        assert.notEqual(refused.status, 0);
        assert.equal(typeof refused.stdout, "string");
        const refusal = object(JSON.parse(String(refused.stdout)));
        assert.equal(refusal.ok, false);
        assert.equal(object(refusal.error).code, "conflict");
        observations.overlap = { cli_refusal: refusal };
        // Reload discards renderer continuations, but the same Core preparation
        // remains running. Perform a real unrelated native UI verification.
        await open(other.port, false);
        const verify = await browser.findElement(button("Verify installation"));
        if (!(await verify.isDisplayed()))
          await clickVisible(
            browser,
            await browser.findElement(
              By.xpath('//summary[contains(., "Commands and maintenance")]'),
            ),
          );
        await browser.wait(until.elementIsEnabled(verify), 5000);
        const otherActiveBefore = required((await status(other.port.id)).active).id;
        const previousActivityIds = new Set((await activities()).map((item) => item.id));
        await clickVisible(browser, verify);
        const verified = await browser.wait(
          async () =>
            (await activities()).find(
              (item) =>
                !previousActivityIds.has(item.id) &&
                item.operation === "verify_install" &&
                item.target_id === other.port.id &&
                item.status === "succeeded",
            ),
          15_000,
        );
        observations.overlap.unrelated_verification = required(verified);
        assert.equal(required((await status(other.port.id)).active).id, otherActiveBefore);
        assert.equal(
          (await activities()).find((item) => item.id === required(activity).id)?.status,
          "running",
        );
        await browser
          .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Library"]]'))
          .click();
        await browser.findElement(By.xpath(`//button[@data-detail-game-id="${port.id}"]`)).click();
        await browser.wait(until.elementLocated(By.css("section[data-detail-workspace]")), 15_000);
      } else await open(port, false);
      const restored = await observe("live-after-reload");
      assert.equal(restored.bootstrap.library_root, before.bootstrap.library_root);
      assert.equal(restored.bootstrap.generation, before.bootstrap.generation);
      assert.equal(required(restored.status.active).id, install.id);
      assert.deepEqual(
        preparationIds(restored.activities),
        [...baselineIds, required(activity).id].sort(),
      );
      assert.equal(
        restored.activities.find((item) => item.id === required(activity).id)?.status,
        "running",
      );
      assert.equal(required(restored.status.readiness).launchable, false);
      if (probeListener) {
        const runningActivity = required(activity);
        observations.listener_lifetime = await listenerLifetimeScenario({
          mode: probeListener,
          browser,
          invoke,
          output,
          artifacts,
          chooseOwnedLibrary,
          observeRunning: async (index) => {
            const current = await observe(`live-listener-generation-${index + 1}`);
            assert.equal(required(current.status.active).id, install.id);
            assert.deepEqual(
              current.activities.map((item) => item.id).sort(),
              restored.activities.map((item) => item.id).sort(),
            );
            assert.equal(
              current.activities.find((item) => item.id === runningActivity.id)?.status,
              "running",
            );
            return {
              activity_id: runningActivity.id,
              active_installation_id: required(current.status.active).id,
              activity_ids: current.activities.map((item) => item.id).sort(),
            };
          },
        });
        const remounted = await observe("live-after-listener-disposal");
        assert.equal(remounted.bootstrap.library_root, before.bootstrap.library_root);
        assert.equal(remounted.bootstrap.generation, before.bootstrap.generation + 2);
        assert.equal(required(remounted.status.active).id, install.id);
        assert.deepEqual(
          preparationIds(remounted.activities),
          [...baselineIds, runningActivity.id].sort(),
        );
        assert.equal(
          remounted.activities.find((item) => item.id === runningActivity.id)?.status,
          "running",
        );
        // Same-document navigation preserves interception custody during the probe.
        await browser
          .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Library"]]'))
          .click();
        const card = By.xpath(`//button[@data-detail-game-id="${port.id}"]`);
        await browser.wait(until.elementLocated(card), 15_000);
        await browser.findElement(card).click();
        await browser.wait(until.elementLocated(By.css("section[data-detail-workspace]")), 15_000);
      }
      const cancel = await browser.wait(
        async () => {
          const candidates = await browser.findElements(
            By.xpath(
              '//section[@data-detail-workspace]//button[normalize-space(.)="Cancel operation"]',
            ),
          );
          if (candidates.length !== 1) return false;
          const candidate = required(candidates[0]);
          return (await candidate.isDisplayed()) && (await candidate.isEnabled())
            ? candidate
            : false;
        },
        15_000,
        "The restored detail must expose one enabled cancellation control",
      );
      assert.equal((await browser.findElements(button("Prepare game data"))).length, 0);
      const cancellable = (await activities()).filter(
        (item) => item.target_id === port.id && item.cancellation,
      );
      assert.equal(cancellable.length, 1);
      assert.equal(required(cancellable[0]).id, required(activity).id);
      assert.equal(required(cancellable[0]).status, "running");
      assert.ok(cancel);
      await cancel.click();
      await browser.wait(
        async () => {
          return (
            (await activities()).find((item) => item.id === required(activity).id)?.status ===
            "cancelled"
          );
        },
        15_000,
        "Preparation cancellation must become durable",
      );
      const terminal = await observe("terminal-cancelled");
      assert.deepEqual(
        preparationIds(terminal.activities),
        [...baselineIds, required(activity).id].sort(),
      );
      for (const input of observations.inputs) {
        const bytes = await readFile(input.path);
        input.after_sha256 = createHash("sha256").update(bytes).digest("hex");
        assert.equal(input.after_sha256, input.sha256, `Owned input changed: ${input.path}`);
      }
      await browser.findElement(By.css(".detail-back")).click();
      await browser
        .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
        .click();
      const cancelledRow = await browser.wait(
        until.elementLocated(
          By.xpath(
            '//div[contains(@class, "activity-row") and contains(@class, "cancelled")][.//strong[normalize-space(.)="Game-data setup"]]',
          ),
        ),
        15_000,
        "Cancelled preparation must remain discoverable after navigating away",
      );
      const cancelledText = await cancelledRow.getText();
      assert.ok(cancelledText.includes(port.name));
      assert.match(cancelledText, /Cancelled/i);
      assert.equal(required((await status(port.id)).active).id, install.id);
      assert.equal(required((await status(port.id)).readiness).launchable, false);
      const recorded = (await activities()).find((item) => item.id === required(activity).id);
      assert.equal(required(required(recorded).failure).code, "cancelled");
      assert.equal(required(required(recorded).failure).presentation.tone, "neutral");
      assert.equal(
        required(required(recorded).failure).presentation.mutation_state,
        "recovery_required",
      );
      assert.equal(required(required(recorded).failure).presentation.phase, "preparation.setup");
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
      await browser.wait(
        until.elementLocated(By.xpath('//h1[normalize-space(.)="Settings"]')),
        15_000,
      );
      await browser
        .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
        .click();
      await browser.wait(
        until.elementLocated(By.css(".activity-row.cancelled .failure-details")),
        15_000,
        "Cancelled preparation must remain discoverable after navigating away and returning",
      );
      await browser.navigate().refresh();
      await browser.wait(
        until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
        15_000,
      );
      assert.deepEqual(
        required((await activities()).find((item) => item.id === required(activity).id)).failure,
        required(recorded).failure,
      );
      await browser
        .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
        .click();
      await browser.wait(
        until.elementLocated(By.css(".activity-row.cancelled .failure-details")),
        15_000,
      );
      const row = await browser.findElement(By.css(".activity-row.cancelled"));
      assert.match(await row.getText(), /An earlier attempt left unfinished work/);
      assert.doesNotMatch(await row.getText(), /No files were changed/);
      await row.findElement(By.css("summary")).click();
      const generation = (await read("desktop_bootstrap_status", "get_bootstrap_status"))
        .generation;
      const retained = await read("activity_diagnostic", "get_activity_diagnostic", {
        activityId: required(activity).id,
        generation,
      });
      assert.deepEqual(
        retained.map((item) => item.phase),
        ["preparation.extract", "preparation.setup"],
      );
      assert.equal(required(retained[0]).complete, true);
      assert.match(required(retained[0]).stdout.text, /owned conversion began/);
      assert.doesNotMatch(JSON.stringify(retained), /owned-conversion-secret/);
      assert.equal(required(retained[1]).complete, true);
      assert.match(required(retained[1]).stdout.text, /owned setup began/);
      assert.match(required(retained[1]).stderr.text, /owned setup diagnostic on stderr/);
      assert.doesNotMatch(JSON.stringify(retained), /owned-fixture-private-value/);
      assert.deepEqual(command(["activity", "log", required(activity).id]), retained);
      const staleLog = await invoke("get_activity_diagnostic", {
        activityId: required(activity).id,
        generation: generation + 1,
      });
      assert.equal(staleLog.ok, false);
      assert.equal(object(staleLog.error).code, "conflict");
      await row
        .findElement(By.xpath('.//summary[normalize-space(.)="View preparation log"]'))
        .click();
      await browser.wait(
        async () => (await row.getText()).includes("owned setup diagnostic on stderr"),
        15_000,
        "The retained preparation log must render after expansion",
      );
      assert.match(await row.getText(), /Preparing source data/);
      assert.match(await row.getText(), /owned conversion began/);
      assert.doesNotMatch(
        await row.getText(),
        /owned-fixture-private-value|owned-conversion-secret/,
      );
      const bundle = await invoke("create_support_bundle");
      assert.equal(bundle.ok, true);
      assert.ok(typeof bundle.value === "string");
      artifacts.push(bundle.value);
      const capture = path.join(output, "retained-preparation-log.json");
      await writeFile(capture, JSON.stringify(retained, null, 2), {
        flag: "wx",
      });
      artifacts.push(capture);

      const report = path.join(output, "recovery-details-accessibility.json");
      await captureAccessibilityReport(browser, report, artifacts);
      await executeBrowserScript(browser, 'arguments[0].scrollIntoView({ block: "center" });', row);
      const screenshot = path.join(output, "native-preparation-retained-outcome.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    } catch (error) {
      originalFailure = error;
      observations.failure = {
        message: errorMessage(error),
        observed_at: new Date().toISOString(),
      };
      throw error;
    } finally {
      const capture = path.join(output, "live-preparation-reload-observations.json");
      try {
        await writeFile(capture, JSON.stringify(observations, null, 2), { flag: "wx" });
        artifacts.push(capture);
      } catch (error) {
        console.error("Live preparation evidence write failed:", error);
        console.error(JSON.stringify(observations));
        if (!originalFailure) evidenceFailure = error;
      }
    }
    if (evidenceFailure) rethrowFailure(evidenceFailure);
  };
  await scenario("native-preparation-cancellation", () => livePreparationCancellation());
  await scenario("native-late-listener-disposal", () => livePreparationCancellation("late"));
  await scenario("native-rejected-listener-registration", () =>
    livePreparationCancellation("reject"),
  );
  browser = await interruptedPreparationScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    activities,
    confirmNative,
    restartApplication,
  });
  browser = await liveInterruptedPreparationScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    activities,
    seed,
    open,
    status,
    interruptApplication,
  });
  browser = await closedPreparationScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    activities,
    seed,
    open,
    status,
    closeApplication,
  });
  browser = await minimizedPreparationScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    activities,
    seed,
    open,
    status,
    captureLivePreparation,
  });
  await scenario("native-update-settings-save-without-execution", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const cliBefore = transportValue("status", command(["status", port.id]));
    const cliActivities = transportValue("activity", command(["activity"]));
    const cliSaved = transportValue("status", command(["policy", "set", port.id, "stage"]));
    assert.equal(cliSaved.update_policy, "stage");
    for (const key of ["active", "staged", "previous"] as const)
      assert.deepEqual(cliSaved[key], cliBefore[key]);
    assert.deepEqual(transportValue("activity", command(["activity"])), cliActivities);
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
    const card = By.xpath(`//button[@data-detail-game-id="${port.id}"]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await clickVisible(
      browser,
      await browser.findElement(By.css("details.advanced-settings > summary")),
    );
    const before = await status(port.id);
    const activities = await invoke("get_activities");
    const policyTrigger = By.xpath('//button[contains(., "Game update behavior")]');
    await browser.findElement(policyTrigger).sendKeys(Key.ENTER);
    const policyPopup = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(
      until.elementLocated(policyPopup),
      5_000,
      "saved update policy options did not open",
    );
    assert.equal(
      await executeBrowserScript(
        browser,
        "return arguments[0].contains(arguments[1]);",
        await browser.findElement(By.css('section[aria-label="Game update settings"]')),
        await browser.findElement(policyPopup),
      ),
      false,
      "saved update policy options must use the shared portal",
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(policyPopup)).length === 0,
      5_000,
      "saved update policy options remained open after Escape",
    );
    const restoredPolicyTrigger = await browser.wait(
      async () => {
        const candidate = await browser.findElement(policyTrigger);
        return (await executeBrowserScript(
          browser,
          "return document.activeElement === arguments[0];",
          candidate,
        ))
          ? candidate
          : false;
      },
      5_000,
      "saved update policy trigger must regain focus after Escape",
    );
    assert.ok(restoredPolicyTrigger);
    await restoredPolicyTrigger.sendKeys(Key.ENTER);
    const automaticOption = By.xpath(
      '//*[@role="option" and normalize-space(.)="Install when I run updates"]',
    );
    await browser.wait(
      until.elementLocated(automaticOption),
      5_000,
      "automatic update policy option did not open",
    );
    await browser.findElement(automaticOption).sendKeys(Key.ENTER);
    assert.equal(
      (await status(port.id)).update_policy,
      before.update_policy,
      "editing a choice is not saving",
    );
    await browser.findElement(button("Save update settings")).click();
    await browser.wait(async () => (await status(port.id)).update_policy === "automatic", 15_000);
    const after = await status(port.id);
    assert.deepEqual(after.active, before.active);
    assert.deepEqual(after.staged, before.staged);
    assert.deepEqual(after.previous, before.previous);
    assert.deepEqual((await invoke("get_activities")).value, activities.value);
    await browser.wait(
      until.elementLocated(
        By.xpath(
          '//p[@role="status" and contains(., "Update settings saved. No update was run.")]',
        ),
      ),
      15_000,
    );
    const report = path.join(output, "update-settings-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center" });',
      await browser.findElement(By.css('section[aria-label="Game update settings"]')),
    );
    const screenshot = path.join(output, "native-update-settings-saved.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  });
  await scenario("native-release-channel-selection-and-restart", async () => {
    await browser.findElement(By.css(".detail-back")).click();
    await browser.findElement(By.xpath('//nav//button[contains(., "Find games")]')).click();
    const openCatalogPort = async (id: string) => {
      const port = transportValue("port", command(["catalog", "show", id]));
      const search = await browser.findElement(By.id("port-search"));
      await search.sendKeys(
        Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
        Key.BACK_SPACE,
        port.name,
      );
      await browser.wait(
        async () => (await search.getAttribute("value")) === port.name,
        5_000,
        `catalog search did not settle on ${port.name}`,
      );
      const card = By.xpath(`//button[@data-detail-origin="catalog:card:${port.id}"]`);
      await browser.wait(until.elementLocated(card), 15_000, `${port.name} card did not appear`);
      await browser.findElement(card).click();
      await clickVisible(
        browser,
        await browser.findElement(By.css("details.advanced-settings > summary")),
      );
      const channel = await browser.findElement(
        By.css('section[aria-label="Game release channel"]'),
      );
      await browser.wait(
        until.elementIsVisible(channel),
        5_000,
        `${port.name} release-channel section did not become visible`,
      );
      return channel;
    };
    const single = await openCatalogPort("ghostship");
    assert.ok((await single.getText()).includes("Stable only"));
    assert.equal((await single.findElements(By.css("button"))).length, 0);
    await browser.findElement(By.css(".detail-back")).click();
    command(["channel", "set", "re-blue", "stable"]);
    const multi = await openCatalogPort("re-blue");
    const before = await status("re-blue");
    const generation = (await read("desktop_bootstrap_status", "get_bootstrap_status")).generation;
    const stale = await invoke("set_channel", {
      portId: "re-blue",
      channel: "rolling",
      generation: generation + 1,
    });
    assert.equal(stale.ok, false);
    assert.equal(object(stale.error).code, "conflict");
    assert.equal((await status("re-blue")).channel, "stable");
    const staleCheck = await invoke("check_port", {
      portId: "re-blue",
      generation: generation + 1,
    });
    assert.equal(staleCheck.ok, false);
    assert.equal(object(staleCheck.error).code, "conflict");
    const trigger = await multi.findElement(By.css('button[data-slot="select-trigger"]'));
    await trigger.sendKeys(Key.ENTER);
    const popup = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(
      until.elementLocated(popup),
      5_000,
      "release-channel popup did not open for the Escape probe",
    );
    assert.equal(
      await executeBrowserScript(
        browser,
        "return arguments[0].contains(document.querySelector('[data-slot=\"select-content\"][data-open]'));",
        multi,
      ),
      false,
      "the release-channel popup is portaled outside the details section",
    );
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(popup)).length === 0,
      5_000,
      "release-channel popup did not close after Escape",
    );
    const releaseChannelTrigger = By.css(
      'section[aria-label="Game release channel"] button[data-slot="select-trigger"]',
    );
    const restoredTrigger = await browser.wait(
      until.elementLocated(releaseChannelTrigger),
      5_000,
      "release-channel trigger did not return after Escape",
    );
    assert.equal(
      await executeBrowserScript(
        browser,
        "return document.activeElement === arguments[0];",
        restoredTrigger,
      ),
      true,
      "Escape restores focus to the release-channel trigger",
    );
    await restoredTrigger.sendKeys(Key.ENTER);
    await browser.wait(
      until.elementLocated(popup),
      5_000,
      "release-channel popup did not reopen for selection",
    );
    await browser
      .findElement(By.xpath('//*[@role="option" and normalize-space(.)="Rolling"]'))
      .click();
    await browser.wait(
      async () => (await status("re-blue")).channel === "rolling",
      15_000,
      "rolling channel was not persisted",
    );
    await browser.wait(
      async () => (await browser.findElement(releaseChannelTrigger)).isEnabled(),
      90_000,
      "release-channel trigger did not re-enable after refresh",
    );
    const after = transportValue("status", command(["status", "re-blue"]));
    for (const key of ["active", "staged", "previous"] as const)
      assert.deepEqual(after[key], before[key]);
    assert.equal(after.channel, "rolling");
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await browser.findElement(By.xpath('//nav//button[contains(., "Find games")]')).click();
    const restarted = await openCatalogPort("re-blue");
    assert.ok((await restarted.getText()).includes("Rolling"));
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center" });',
      restarted,
    );
    const report = path.join(output, "release-channel-accessibility.json");
    await captureAccessibilityReport(browser, report, artifacts);
    const screenshot = path.join(output, "native-release-channel-restarted.png");
    await writeFile(screenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(screenshot);
  });

  await backupReviewScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    seed,
    open,
    confirmNative,
  });
  await steamEntryScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    command,
    seed,
    open,
    confirmNative,
  });
  await sourceDialogScenario({ browser, scenario, output, artifacts, command });
  await primaryFilePickerScenario({
    browser,
    scenario,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await removalReviewScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    open,
    confirmNative,
  });
  await sourceRemovalScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await adoptionReviewScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    tool,
    host,
    confirmNative,
  });
  await libraryHandoffScenario({
    browser,
    invoke,
    scenario,
    library,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await cliHandoffScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    cli,
    command,
  });
  await artworkScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    command,
    confirmNative,
  });
  await artworkCorrectionScenario({
    browser,
    invoke,
    scenario,
    output,
    artifacts,
    command,
    confirmNative,
    restartApplication,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--context-preflight")
    throw new Error("Usage: node desktop-preparation-test.mts --context-preflight");
  // Both frontend lanes run this installed-dependency preflight.
  // Register actual callers without executing browser, CLI, or consent callbacks.
  const { planDesktopExecution } = await import("../../../scripts/desktop-execution-plan.mts");
  const { resolveDesktopSelection } = await import("../../../scripts/desktop-scenarios.mts");
  const { runOwnedFixtureJourneys } = await import("./desktop-owned-fixture-journeys.mts");
  const { installScenarios } = await import("./desktop-install-test.mts");
  const { selectedSetupScenario } = await import("./desktop-source-dialog-test.mts");
  const { selectedSetupCompletionScenario } =
    await import("./desktop-selected-setup-completion-test.mts");
  const plan = planDesktopExecution(
    resolveDesktopSelection({ profile: "full", platform: "win32" }),
  );
  const attempts: string[] = [];
  const context = {
    browser: new WebDriver(new Session("context-preflight", new Capabilities()), {
      execute: async () => assert.fail("Context preflight must not execute WebDriver commands"),
    }),
    invoke: async () => assert.fail("Context preflight must not invoke IPC"),
    scenario: async (id: string, _execute: () => unknown) => {
      attempts.push(id);
    },
    library: "<preflight-library>",
    output: "<preflight-output>",
    artifacts: [],
    cli: "<preflight-cli>",
    tool: "<preflight-tool>",
    inputs: [],
    // Registration passes this sentinel unchanged. Accessing any fixture member
    // proves a scenario escaped its non-executing preflight callback.
    // Absent optional journeys retain their owning null/false discriminants.
    installFixture: {
      get artifact(): never {
        return assert.fail("Preflight must not read fixture artifacts");
      },
      get artifactPath(): never {
        return assert.fail("Preflight must not read fixture paths");
      },
      get catalogPath(): never {
        return assert.fail("Preflight must not read fixture catalogs");
      },
      get port(): never {
        return assert.fail("Preflight must not read fixture ports");
      },
      get refreshPort(): never {
        return assert.fail("Preflight must not read fixture ports");
      },
      get requests(): never {
        return assert.fail("Preflight must not read fixture requests");
      },
      sourceJourney: null,
      preliminaryJourney: null,
      completionJourney: false as const,
      get url(): never {
        return assert.fail("Preflight must not read fixture URLs");
      },
      publishRelease: async () => assert.fail("Preflight must not publish fixtures"),
      close: async () => assert.fail("Preflight must not close fixtures"),
    },
    restartApplication: async () => assert.fail("Context preflight must not restart"),
    interruptApplication: async () => assert.fail("Context preflight must not interrupt"),
    closeApplication: async () => assert.fail("Context preflight must not close"),
    captureLivePreparation: () => assert.fail("Context preflight must not capture"),
    chooseOwnedLibrary: async () => assert.fail("Context preflight must not choose a library"),
    chooseGameFileFolder: undefined,
  };
  await runOwnedFixtureJourneys(
    {
      plan,
      runtime: {
        context: () => context,
        confirmNative: () => async () => assert.fail("Context preflight must not consent"),
        recordKnownGap: () => {},
      },
    },
    {
      install: installScenarios,
      selectedSetup: selectedSetupScenario,
      selectedSetupCompletion: selectedSetupCompletionScenario,
      preparation: preparationScenarios,
    },
  );
  assert(attempts.includes("install-progress-cancellation"));
  assert(attempts.includes("native-preparation-review-and-play"));
  for (const family of plan.fixtureFamilies.filter((entry) => entry.family))
    for (const member of required(family.members)) assert(attempts.includes(member.id), member.id);
  const { verifyOwnedProbeTransport } = await import("./desktop-owned-ipc-probe-check.mts");
  await verifyOwnedProbeTransport();
  console.log("Native scenario context preflight and pinned probe transport passed.");
}
