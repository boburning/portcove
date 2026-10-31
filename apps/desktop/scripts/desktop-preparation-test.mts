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
import { gameTitle, gameIdentityLabel } from "../src/port-identity.ts";
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
function launchContinuityPoint(element: Element) {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Launch origin must be a button");
  const workspace = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]');
  const owner =
    workspace && getComputedStyle(workspace).overflowY !== "visible"
      ? workspace
      : document.scrollingElement;
  const active = document.activeElement;
  const rectangle = (item: Element | null) => {
    const bounds = item?.getBoundingClientRect();
    return bounds
      ? { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
      : null;
  };
  return {
    observedAt: new Date().toISOString(),
    documentFocused: document.hasFocus(),
    visibility: document.visibilityState,
    activeTag: active?.tagName,
    activeText: active?.textContent?.trim().slice(0, 160),
    originFocused: active === element,
    originConnected: element.isConnected,
    disabled: element.disabled,
    ariaDisabled: element.getAttribute("aria-disabled"),
    ariaBusy: element.getAttribute("aria-busy"),
    scrollTop: owner?.scrollTop,
    scrollHeight: owner?.scrollHeight,
    clientHeight: owner?.clientHeight,
    maximumScroll: owner ? owner.scrollHeight - owner.clientHeight : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    fontStatus: document.fonts.status,
    workspaceOverflowY: workspace ? getComputedStyle(workspace).overflowY : null,
    originRectangle: rectangle(element),
    cardRectangle: rectangle(element.closest("article")),
    continueRectangle: rectangle(document.querySelector(".continue-card")),
    workspaceRectangle: rectangle(workspace),
    workspaceChildren: workspace
      ? Array.from(workspace.children).map((item) => ({
          tag: item.tagName,
          className: item.className,
          rectangle: rectangle(item),
        }))
      : [],
  };
}

function rethrowFailure(error: unknown): never {
  throw error;
}
import { executeBrowserScript } from "./browser-script.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
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
  revealDetailSection,
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible,
  reviewGameUpdateDisposition,
  reviewControls,
  selectPrimaryNavigation,
  selectCatalogPort,
  openCatalogFilters,
  preparationLogControl,
} from "./desktop-review-controls.mts";
import { readinessScenario } from "./desktop-readiness-test.mts";
import { steamEntryScenario } from "./desktop-steam-entry-test.mts";
import { sourceDialogScenario } from "./desktop-source-dialog-test.mts";
import { primaryFilePickerScenario } from "./desktop-primary-file-picker-test.mts";
import { listenerLifetimeScenario } from "./desktop-listener-lifetime-test.mts";

export function assertPreparationReviewSummary(text: string) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  for (const expected of [
    "Prepare game data",
    "Selected game files",
    "Free space At least",
    "plus the output generated by the game.",
    "Your original files and current installation remain unchanged until the verified result becomes active.",
    "The previous version stays available for rollback.",
    "Cancellation or interruption may leave working files in Activity.",
    "Starting again keeps earlier unfinished work.",
  ])
    assert.ok(normalized.includes(expected), `preparation review omitted ${expected}`);
}

/** Read-only observation of the current overflow-navigation destination. */
export function overflowUpdateFocusPoint(target: Element) {
  const active = document.activeElement;
  const connected = target.isConnected;
  const hidden = Boolean(target.closest("[hidden], [inert]"));
  const disabled = target.matches(":disabled, [aria-disabled=true]");
  return {
    matches:
      connected &&
      !hidden &&
      !disabled &&
      target.id === "detail-section-versions" &&
      target.tagName === "H2" &&
      active === target,
    target_id: target.id,
    target_tag: target.tagName,
    connected,
    hidden,
    disabled,
    active_id: active?.id ?? null,
    active_tag: active?.tagName ?? null,
  };
}

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
  await selectPrimaryNavigation(browser, "Settings");
  await clickVisible(
    browser,
    await browser.findElement(
      By.css('nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]'),
    ),
  );
  await clickVisible(
    browser,
    await browser.findElement(
      By.xpath(
        `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
      ),
    ),
  );
  assert.equal(
    await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
    theme,
  );
  await selectPrimaryNavigation(browser, "Activity");
  await selectActivitySection(browser, "Game updates");
}

async function selectActivitySection(
  browser: WebDriver,
  label: "Game updates" | "Tasks" | "History",
) {
  const button = await browser.findElement(
    By.xpath(
      `//*[@role="tablist" and @aria-label="Activity sections"]//*[@role="tab" and text()[normalize-space(.)="${label}"]]`,
    ),
  );
  await clickVisible(browser, button);
  await browser.wait(async () => (await button.getAttribute("aria-selected")) === "true", 5000);
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
    assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), gameTitle(port));
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
  const button = (label: string) =>
    By.xpath(`//button[normalize-space(.)="${label}" and not(ancestor::*[@hidden or @inert])]`);
  const dialog = By.css("[data-game-update-review]");
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
        await reviewGameUpdateDisposition(browser, "prepare");
        const review = await browser.wait(until.elementLocated(dialog), 15_000);
        await browser.wait(async () => (await review.getText()).includes(explanation), 5_000);
        // Outline alternatives request a fresh review; only the primary action applies it.
        assert.equal(
          (
            await review.findElements(
              By.xpath(
                './/button[@data-variant="primary" and (normalize-space(.)="Download archive for later" or normalize-space(.)="Prepare update for later" or normalize-space(.)="Keep saved update for later" or normalize-space(.)="Download and install update" or normalize-space(.)="Update now" or normalize-space(.)="Use saved update")]',
              ),
            )
          ).length,
          0,
          "Held or waiting assessment must offer no primary update execution action",
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
        try {
          const image = path.join(
            output,
            `reviewed-update-${reason}-failure-before-restoration.png`,
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
        await reviewGameUpdateDisposition(browser, "prepare");
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
          until.elementLocated(
            cancelled
              ? By.css("[data-game-update-outcome]")
              : By.xpath(
                  '(//*[@data-invocation-id][starts-with(@aria-label,"Update game")]//*[@role="alert"])[last()]',
                ),
          ),
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
        await browser.wait(
          async () => (await browser.findElements(dialog)).length === 0,
          5_000,
          "Settled update outcome did not close its observation review",
        );
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
        await reviewGameUpdateDisposition(browser, "prepare");
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
    await reviewGameUpdateDisposition(browser, "prepare");
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
    assert.ok(!item.staged, `${item.port_id} must have no prepared update`);
  }
  assert.equal(
    text.replace(/\s+/gu, " ").trim(),
    `${installed.length} library ${installed.length === 1 ? "entry" : "entries"}`,
  );
}

/** Observe one owned Library action and retain its exact visual evidence. */
export async function captureLibraryAction(
  browser: WebDriver,
  more: WebElement,
  output: string,
  theme: string,
  layout: string,
  artifacts: string[],
) {
  const exactTarget = await more.getAttribute("data-detail-origin");
  assert.ok(exactTarget, "The focused menu must have a stable Library return identity");
  const selector = `button[data-detail-origin=${JSON.stringify(exactTarget)}]`;
  // Resize/focus recovery can leave a fractional edge at the viewport
  // boundary. Prepare the exact target inside its real scroll owner;
  // screenshot completeness remains stricter than usability checks.
  const preparedTarget = await prepareCaptureTarget({
    target: selector,
    label: `200% Library ${theme} ${layout} action`,
    scroll: () =>
      executeBrowserScript(
        browser,
        (element) =>
          element.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          }),
        more,
      ),
    observe: () => executeBrowserScript(browser, observeVisibleTarget, selector, "visual" as const),
  });
  const capture = await captureSettledVisual({
    browser,
    output,
    name: `library-${theme}-${layout === "Covers" ? "covers" : "rows"}-200`,
    scenario: "native-library-layout",
    target: selector,
    observeTarget: async () => {
      const state = await executeBrowserScript(
        browser,
        observeVisibleTarget,
        selector,
        "visual" as const,
      );
      requireUnchangedCaptureTarget(preparedTarget.observation, state);
      return { ...state, capture_target_preflight: preparedTarget };
    },
    readiness: () =>
      executeBrowserScript(
        browser,
        (element) => ({
          ready:
            document.fonts.status === "loaded" &&
            Array.from(document.images).every((image) => image.complete) &&
            document.activeElement === element &&
            localStorage.getItem("portcove.appearance.interface-size") === "200",
          feedbackFixture: "Owned DOM-only artwork feedback; imported artwork remains available",
        }),
        more,
      ),
  });
  artifacts.push(capture.image.path, capture.receipt);
}

export async function settleDirectPreparationRecovery(browser: WebDriver) {
  const action = By.css('[data-detail-origin="error:preparation-review"]');
  await browser.wait(until.elementLocated(action), 15_000);
  // The failure notice can render before the completed review's modal layer
  // unmounts. Wait for actual dismissal before exercising ordinary navigation;
  // never click through the overlay or dismiss it on the test's behalf.
  await browser.wait(
    async () => (await browser.findElements(By.css('[data-slot="dialog-overlay"]'))).length === 0,
    15_000,
    "The settled preparation review must release its modal overlay before navigation",
  );
  await browser
    .findElement(By.xpath('//nav//button[./span[normalize-space(.)="Activity"]]'))
    .click();
  await browser.wait(
    async () => (await browser.findElements(By.css("section[data-detail-workspace]"))).length === 0,
    15_000,
  );
  return action;
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
  const button = (label: string) =>
    By.xpath(`//button[normalize-space(.)="${label}" and not(ancestor::*[@hidden or @inert])]`);
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
    const card = By.xpath(`//button[@data-detail-game-id="${port.id}"]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await clickVisible(browser, await browser.findElement(card));
    if (waitForPreparation) {
      await revealDetailSection(browser, "Game files");
      await browser.wait(until.elementLocated(button("Review setup")), 15_000);
    }
  }
  async function openReadinessOptions(filters: WebElement) {
    const picker = await filters.findElement(By.css('[role="combobox"]'));
    assert.match(await picker.getAccessibleName(), /^Readiness\s/u);
    await clickVisible(browser, picker);
    await browser.wait(async () => Boolean(await picker.getAttribute("aria-controls")), 5_000);
    const listId = await picker.getAttribute("aria-controls");
    assert.ok(listId, "The readiness picker must name its owned listbox");
    const list = await browser.wait(until.elementLocated(By.id(listId)), 5_000);
    assert.equal(await list.getAttribute("role"), "listbox");
    return { picker, list, listId };
  }
  async function waitReadinessClosed(picker: WebElement, listId: string) {
    // Base UI may retain a hidden item collection for typeahead. Require its
    // owned popup to finish closing and its sibling shield to stop intercepting.
    await browser.wait(
      async () =>
        (await picker.getAttribute("aria-expanded")) === "false" &&
        (await executeBrowserScript(
          browser,
          (id) => {
            const list = document.getElementById(id);
            if (!list) return true;
            const popup = list.closest('[data-slot="select-content"]');
            const shield = popup?.parentElement?.previousElementSibling;
            const blocked =
              shield?.hasAttribute("data-base-ui-inert") &&
              !shield.hasAttribute("inert") &&
              shield.getClientRects().length > 0 &&
              getComputedStyle(shield).pointerEvents !== "none";
            return Boolean(
              popup?.hasAttribute("data-closed") && list.getClientRects().length === 0 && !blocked,
            );
          },
          listId,
        )),
      5_000,
      "The readiness listbox must finish closing before workspace interaction",
    );
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
        heading: actions?.querySelector('[data-slot="current-state-summary"] h3')?.textContent,
        firstAction: actions?.querySelector("button:not(:disabled)")?.textContent?.trim(),
        disabledPlaceholder: actions?.textContent?.includes("Prepare game data first"),
        owner: actions?.getAttribute("data-task-owner"),
      };
    });
    assert.equal(preparationHierarchy.heading, "Setup needed");
    assert.equal(preparationHierarchy.firstAction, "Review setup");
    assert.equal(preparationHierarchy.disabledPlaceholder, false);
    assert.ok(preparationHierarchy.owner?.startsWith(`${port.id}:`));
    await revealDetailSection(browser, "Manage");
    await clickVisible(
      browser,
      await browser.findElement(
        By.xpath('//summary[normalize-space(.)="Folder for a future install"]'),
      ),
    );
    const outputLocationInput = await browser.findElement(By.id(`output-location-path-${port.id}`));
    const reviewedOutput = path.join(output, "reviewed-future-output");
    await clickVisible(browser, outputLocationInput);
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
    await revealDetailSection(browser, "Game files");
    await browser.findElement(button("Review setup")).click();
    const preparationDialog = By.css('[aria-labelledby="preparation-review-title"]');
    await browser.wait(until.elementLocated(preparationDialog), 15_000);
    await browser.wait(until.elementLocated(button("Prepare game data")), 15_000);
    assert.equal(
      required((await status(port.id)).active).id,
      install.id,
      "review must not prepare",
    );
    const preparationText = await browser.findElement(preparationDialog).getText();
    assertPreparationReviewSummary(preparationText);
    const windowGuidance = await browser.findElement(
      By.xpath('//summary[normalize-space(.)="If setup opens another window"]'),
    );
    await windowGuidance.click();
    assert.ok(
      (await browser.findElement(preparationDialog).getText()).includes(
        "close it without launching the game",
      ),
    );
    await windowGuidance.click();
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
    await clickVisible(browser, await browser.findElement(button("Review setup")));
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
          'return document.activeElement?.textContent?.trim() === "Review setup";',
        ),
      5_000,
      "Preparation review trigger did not regain focus after Escape",
    );
    assert.equal(
      required((await status(port.id)).active).id,
      install.id,
      "dismissal must not prepare",
    );
    await browser.findElement(button("Review setup")).click();
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
          (await current.isEnabled()) &&
          (await current.getAttribute("aria-disabled")) !== "true" &&
          (await current.getAttribute("aria-busy")) !== "true" &&
          (await executeBrowserScript(browser, (element) => element.isConnected, current))
          ? current
          : false;
      },
      15_000,
      "Prepared Core state did not reach the rendered trial-launch action",
    );
    assert.ok(trial, "Rendered trial-launch action must be available");
    assert.equal(await trial.getText(), "Try launch");
    await browser.wait(until.elementIsEnabled(trial), 15_000);
    try {
      await browser.wait(
        () =>
          executeBrowserScript(browser, () => {
            const heading = document.querySelector(
              'section[aria-label="Game actions"] [data-slot="current-state-summary"] h3',
            );
            return (
              heading?.textContent?.trim() === "Files need checking" &&
              document.activeElement === heading
            );
          }),
        5_000,
        "Unconfirmed compatibility must leave completion focus on the next-step heading",
      );
    } catch (error) {
      const diagnostic = path.join(output, "preparation-completion-focus-failure.json");
      await writeFile(
        diagnostic,
        JSON.stringify(
          await executeBrowserScript(browser, () => ({
            active: document.activeElement?.outerHTML,
            actions: document.querySelector('[aria-label="Game actions"]')?.outerHTML,
            overlays: [
              ...document.querySelectorAll('[role="dialog"], [data-portcove-focus-scope]'),
            ].map((item) => item.outerHTML),
          })),
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(diagnostic);
      throw error;
    }

    await clickVisible(browser, trial);
    await browser.wait(async () => (await status(port.id)).successful_launches > 0, 15_000);
    assert.equal(await readFile(log, "utf8"), "setup must not run during desktop Play");
    await browser.findElement(By.css(".detail-back")).click();
    const libraryHeader = await browser.wait(
      until.elementLocated(By.css("[data-library-header] p")),
      15_000,
    );
    const headerText = await libraryHeader.getText();
    assert.equal(
      await executeBrowserScript(browser, () =>
        document.querySelector(".sidebar-library small")?.textContent?.trim(),
      ),
      "On this computer",
    );
    const libraryStatuses = await invoke("get_statuses");
    assert.equal(libraryStatuses.ok, true);
    assertPreparedLibrarySummary(
      headerText,
      transportValues("status", libraryStatuses.value),
      port.id,
    );
    const installedCount = transportValues("status", libraryStatuses.value).filter(
      (item) => item.active || item.external_runtime,
    ).length;
    const filterPanel = await openCatalogFilters(browser);
    const advanced = await filterPanel.findElement(
      By.xpath('.//summary[normalize-space(.)="Advanced filters"]'),
    );
    if ((await advanced.findElement(By.xpath("..")).getAttribute("open")) === null)
      await clickVisible(browser, advanced);
    const libraryFilters = await filterPanel.findElement(By.css('[aria-label="Library filters"]'));
    await browser.wait(until.elementIsVisible(libraryFilters), 5_000);
    const readinessButtons = await libraryFilters.findElements(
      By.xpath('.//button[not(@role="combobox")][starts-with(normalize-space(.),"All (")]'),
    );
    const wideReadiness = (
      await Promise.all(readinessButtons.map((filter) => filter.isDisplayed()))
    ).some(Boolean);
    const compactReadiness = wideReadiness ? undefined : await openReadinessOptions(libraryFilters);
    for (const label of [
      `All (${installedCount})`,
      `Ready (${installedCount})`,
      "Needs attention (0)",
    ]) {
      const filter = compactReadiness
        ? await compactReadiness.list.findElement(
            By.xpath(`.//*[@role="option"][normalize-space(.)="${label}"]`),
          )
        : await libraryFilters.findElement(By.xpath(`.//button[normalize-space(.)="${label}"]`));
      assert.equal(await filter.isDisplayed(), true, label);
    }
    if (compactReadiness) {
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await waitReadinessClosed(compactReadiness.picker, compactReadiness.listId);
    }
    await clickVisible(
      browser,
      await filterPanel.findElement(By.xpath('.//button[normalize-space(.)="Done"]')),
    );
    await browser.wait(until.stalenessOf(filterPanel), 5_000);
    const card = await browser.wait(
      until.elementLocated(By.xpath(`//article[.//button[@data-detail-game-id="${port.id}"]]`)),
      15_000,
    );
    // Core launch settlement can trigger a workspace refresh after navigation.
    // Observe the authoritative presentation becoming actionable; never bypass
    // its pending/conflict state to take the geometry measurement.
    await browser.wait(
      async () => {
        const current = await browser.findElement(
          By.xpath(`//article[.//button[@data-detail-game-id="${port.id}"]]`),
        );
        const launch = await current.findElements(
          By.xpath('.//button[normalize-space(.)="Try launch"]'),
        );
        return (
          launch.length === 1 &&
          (await launch[0]!.isEnabled()) &&
          (await launch[0]!.getAttribute("aria-disabled")) !== "true" &&
          (await launch[0]!.getAttribute("aria-busy")) !== "true"
        );
      },
      15_000,
      "Library launch must settle before the card composition check",
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
        // Cover entries use the collection's painted surface. Resolve the
        // actual opaque ancestor instead of treating transparency as a color.
        let painted: Element | null = element;
        while (
          painted &&
          getComputedStyle(painted).backgroundColor.replace(/\s/gu, "") === "rgba(0,0,0,0)"
        )
          painted = painted.parentElement;
        if (!painted || getComputedStyle(painted).backgroundImage !== "none")
          throw new Error("Card contrast needs an identified flat painted surface");
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
          details_background: getComputedStyle(painted).backgroundColor,
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
      details: `Jak and Daxter: The Precursor Legacy ${port.name}`,
      details_tag: "BUTTON",
      details_label: `View details for Jak and Daxter: The Precursor Legacy ${port.name}`,
      details_slot: null,
      details_variant: null,
      play: "Try launch",
      play_disabled: false,
      play_slot: "button",
      play_variant: "outline",
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
    const menuCapture = await captureSettledVisual({
      browser,
      output,
      name: "library-overflow-menu",
      scenario: "native-preparation-review-and-play",
      target: '[role="menu"]',
      observeTarget: () =>
        executeBrowserScript(browser, observeVisibleTarget, '[role="menu"]', "visual" as const),
      readiness: () =>
        executeBrowserScript(browser, () => {
          const menu = document.querySelector<HTMLElement>('[role="menu"]');
          if (!menu) return { ready: false };
          for (
            let ancestor: HTMLElement | null = menu;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            if (
              Number(getComputedStyle(ancestor).opacity) !== 1 ||
              ancestor
                .getAnimations()
                .some((animation) => animation.pending || animation.playState === "running")
            )
              return { ready: false };
          }
          return { ready: document.fonts.status === "loaded" };
        }),
    });
    artifacts.push(menuCapture.image.path, menuCapture.receipt);
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
      until.elementLocated(By.css("#detail-section-versions")),
      5000,
    );
    let overflowFocus: ReturnType<typeof overflowUpdateFocusPoint> | undefined;
    let focusFailure: { error: unknown } | undefined;
    try {
      await browser.wait(
        async () => {
          overflowFocus = await executeBrowserScript(
            browser,
            overflowUpdateFocusPoint,
            updatesHeading,
          );
          return overflowFocus.matches;
        },
        5000,
        "Overflow update navigation must focus its Versions heading",
      );
    } catch (error) {
      focusFailure = { error };
    }
    let captureFailure: { error: unknown } | undefined;
    try {
      const focusPath = path.join(output, "overflow-update-navigation-focus.json");
      await writeFile(focusPath, JSON.stringify({ latest: overflowFocus ?? null }, null, 2), {
        flag: "wx",
      });
      artifacts.push(focusPath);
    } catch (error) {
      captureFailure = { error };
    }
    if (focusFailure) {
      if (captureFailure) {
        console.warn(
          "Could not retain overflow focus observation:",
          errorMessage(captureFailure.error),
        );
      }
      throw focusFailure.error;
    }
    if (captureFailure) throw captureFailure.error;
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
  await scenario("native-library-layout", async () => {
    const first = await seed("opengoal-jak1", "success");
    const second = await seed("opengoal-jak2", "success");
    const before = [await status(first.port.id), await status(second.port.id)];
    // Geometry diagnostics use local reviewed test images, so late catalog
    // downloads or failure notices cannot change the focused row mid-resize.
    for (const [index, port] of [first.port, second.port].entries()) {
      const image = path.join(output, `library-layout-${port.id}.jpg`);
      await copyFile(
        new URL(`./testdata/catalog-artwork-${index === 0 ? "red" : "blue"}.jpg`, import.meta.url),
        image,
      );
      const imported = transportValue(
        "artwork_state",
        command(["artwork", "import", port.id, image, "--slot", "cover"]),
      );
      assert.equal(imported.availability, "available");
      assert.equal(imported.resolved_source.kind, "local_import");
      artifacts.push(image);
    }
    // Establish the post-seeding render before measuring. An in-flight
    // workspace read may legitimately have observed the two fixture commits.
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    const originalWindow = await browser.manage().window().getRect();
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = (key: string) =>
      browser.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    const observations: unknown[] = [];
    const measure = () =>
      executeBrowserScript(browser, () => ({
        width: innerWidth,
        height: innerHeight,
        contentWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        layout: document.querySelector(".collection-rows") ? "rows" : "covers",
        entries: document.querySelectorAll(".collection-entry").length,
        query: document.querySelector<HTMLInputElement>("#port-search")?.value,
        zoom: localStorage.getItem("portcove.appearance.interface-size"),
        theme: document.documentElement.dataset.theme,
      }));
    try {
      for (const theme of ["dark", "light"]) {
        await shortcut("0");
        await openUpdateTheme(browser, theme);
        await selectPrimaryNavigation(browser, "Library");
        await browser.wait(until.elementLocated(By.css(".collection-entry")), 15_000);
        const search = await browser.findElement(By.id("port-search"));
        await search.clear();
        await search.sendKeys("Jak");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (ids) => {
                const rendered = [
                  ...document.querySelectorAll<HTMLButtonElement>(
                    ".collection-entry button[data-detail-game-id]",
                  ),
                ].map((item) => item.dataset.detailGameId);
                return ids.every((id) => rendered.includes(id));
              },
              [first.port.id, second.port.id],
            ),
          15_000,
          "Both exact prepared Library entries must render before layout measurement",
        );
        await browser.wait(
          () =>
            executeBrowserScript(browser, () => {
              const frames = [
                ...document.querySelectorAll<HTMLElement>(".collection-entry .artwork-image"),
              ];
              return (
                document.fonts.status === "loaded" &&
                frames.length === 2 &&
                frames.every((frame) => {
                  const image = frame.querySelector("img");
                  return (
                    frame.dataset.artworkSource === "local_import" &&
                    image?.complete &&
                    image.naturalWidth > 0
                  );
                })
              );
            }),
          10_000,
          "Both owned local artwork images must load before the resize journey",
        );
        for (const layout of ["Covers", "Compact rows"]) {
          const viewControls = await browser.findElement(
            By.css('[role="group"][aria-label="Collection view"]'),
          );
          const layoutControl = await viewControls.findElement(
            layout === "Covers" ? button(layout) : By.css('button[aria-label="Compact rows"]'),
          );
          await clickVisible(browser, layoutControl);
          await browser.wait(
            async () => (await layoutControl.getAttribute("aria-pressed")) === "true",
            5_000,
            "The requested Library view must be selected before measuring",
          );
          for (const { width, height } of [
            { width: 960, height: 640 },
            { width: 1280, height: 800 },
            { width: 1366, height: 768 },
            { width: 1600, height: 1000 },
            { width: 1920, height: 1080 },
          ]) {
            await browser.manage().window().setRect({ width, height });
            const state = await measure();
            assert.ok(state.entries >= 2 && state.query === "Jak", JSON.stringify(state));
            assert.ok(state.scrollWidth <= state.contentWidth + 1, JSON.stringify(state));
            observations.push({
              requestedWindow: { width, height },
              window: await browser.manage().window().getRect(),
              ...state,
            });
            const file = path.join(
              output,
              `library-${theme}-${layout === "Covers" ? "covers" : "rows"}-${width}.png`,
            );
            await writeFile(file, await browser.takeScreenshot(), {
              encoding: "base64",
              flag: "wx",
            });
            artifacts.push(file);
          }
          await browser.manage().window().setRect({ width: 960, height: 640 });
          for (const size of [125, 150, 175, 200, 250, 300, 400]) {
            await shortcut("+");
            await browser.wait(async () => (await measure()).zoom === String(size), 10_000);
            if (size === 200) {
              async function checkFocusedResizeAt200() {
                await browser.manage().window().setRect({ width: 1366, height: 768 });
                const target = '.collection-entry button[aria-label^="More actions for "]';
                const more = await browser.findElement(By.css(target));
                const waitForVisibleAction = () =>
                  browser.wait(
                    () =>
                      executeBrowserScript(
                        browser,
                        (element) => {
                          const bounds = element.getBoundingClientRect();
                          return (
                            document.activeElement === element &&
                            bounds.top >= 0 &&
                            bounds.bottom <= innerHeight + 1 &&
                            bounds.left >= 0 &&
                            bounds.right <= innerWidth + 1
                          );
                        },
                        more,
                      ),
                    5000,
                    "The focused Library action must remain visible through feedback and resizing",
                  );
                await clickVisible(browser, more);
                await browser.wait(until.elementLocated(By.css('[role="menu"]')), 5000);
                const menuFocus = await browser.switchTo().activeElement();
                const feedbackBefore = await executeBrowserScript(
                  browser,
                  launchContinuityPoint,
                  more,
                );
                // Owned DOM-only geometry diagnostic: this does not report a Core
                // artwork failure or change either imported asset/selection.
                const insertFeedback = () =>
                  executeBrowserScript(
                    browser,
                    async (element) => {
                      const state = element
                        .closest(".collection-entry")
                        ?.querySelector(".collection-state");
                      if (!state) throw new Error("Owned Library state region missing");
                      const notice = document.createElement("p");
                      notice.dataset.ownedArtworkFeedback = "true";
                      notice.className = "m-0 text-pc-muted-foreground";
                      notice.textContent = "Image unavailable";
                      state.prepend(notice);
                      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    },
                    more,
                  );
                await insertFeedback();
                const feedbackWithMenu = await executeBrowserScript(
                  browser,
                  launchContinuityPoint,
                  more,
                );
                assert.equal(
                  await executeBrowserScript(
                    browser,
                    (element) => document.activeElement === element,
                    menuFocus,
                  ),
                  true,
                  "Library feedback must not take focus from the open menu",
                );
                assert.equal(feedbackWithMenu.scrollTop, feedbackBefore.scrollTop);
                observations.push({
                  phase: "owned-dom-artwork-feedback-with-menu",
                  limitation: "DOM-only geometry diagnostic; no Core artwork-failure claim",
                  before: feedbackBefore,
                  after: feedbackWithMenu,
                });
                await executeBrowserScript(
                  browser,
                  (element) => {
                    element
                      .closest(".collection-entry")
                      ?.querySelector("[data-owned-artwork-feedback]")
                      ?.remove();
                  },
                  more,
                );
                await browser.actions().sendKeys(Key.ESCAPE).perform();
                await browser.wait(
                  () =>
                    executeBrowserScript(
                      browser,
                      (element) => document.activeElement === element,
                      more,
                    ),
                  5000,
                  "Closing the enlarged Library menu must restore its exact trigger",
                );
                await insertFeedback();
                await waitForVisibleAction();
                observations.push({
                  phase: "owned-dom-artwork-feedback-after-menu",
                  limitation: "DOM-only geometry diagnostic; no Core artwork-failure claim",
                  ...(await measure()),
                  continuity: await executeBrowserScript(browser, launchContinuityPoint, more),
                });
                for (const requestedWindow of [
                  { width: 1366, height: 768 },
                  { width: 1920, height: 1080 },
                  { width: 960, height: 640 },
                  { width: 1366, height: 768 },
                ]) {
                  await browser.manage().window().setRect(requestedWindow);
                  const state = await measure();
                  const continuity = await executeBrowserScript(
                    browser,
                    launchContinuityPoint,
                    more,
                  );
                  observations.push({
                    phase: "focused-resize-200",
                    requestedWindow,
                    window: await browser.manage().window().getRect(),
                    ...state,
                    continuity,
                  });
                  await waitForVisibleAction();
                  observations.push({
                    phase: "settled-focused-resize-200",
                    requestedWindow,
                    window: await browser.manage().window().getRect(),
                    ...(await measure()),
                    continuity: await executeBrowserScript(browser, launchContinuityPoint, more),
                  });
                  assert.equal(state.zoom, "200");
                  assert.equal(state.query, "Jak");
                  assert.equal(state.layout, layout === "Covers" ? "covers" : "rows");
                  assert.equal(state.entries, 2);
                  assert.ok(state.scrollWidth <= state.contentWidth + 1, JSON.stringify(state));
                  assert.ok(
                    continuity.originFocused && continuity.originConnected,
                    JSON.stringify(continuity),
                  );
                  assert.ok(continuity.documentFocused, JSON.stringify(continuity));
                }
                // One scoped target avoids claiming that the whole scrollable collection
                // fits above the fold. The screenshot still retains the native viewport.
                await captureLibraryAction(browser, more, output, theme, layout, artifacts);
                await executeBrowserScript(
                  browser,
                  (element) => {
                    element
                      .closest(".collection-entry")
                      ?.querySelector("[data-owned-artwork-feedback]")
                      ?.remove();
                  },
                  more,
                );
                await browser.manage().window().setRect({ width: 960, height: 640 });
              }
              await checkFocusedResizeAt200();
            }
          }
          await browser.wait(async () => (await measure()).zoom === "400", 10_000);
          const enlarged = await measure();
          assert.ok(
            enlarged.width <= 240 && enlarged.scrollWidth <= enlarged.contentWidth + 1,
            JSON.stringify(enlarged),
          );
          observations.push(enlarged);
          const identity = await browser.findElement(
            By.css(".collection-entry button[data-detail-game-id]"),
          );
          await clickVisible(browser, identity);
          await clickVisible(
            browser,
            await browser.findElement(By.css("button[data-detail-back]")),
          );
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                () => document.activeElement?.hasAttribute("data-detail-game-id") === true,
              ),
            5000,
          );
          await shortcut("-");
          await browser.wait(async () => (await measure()).zoom === "300", 10_000);
          const narrow = await measure();
          assert.ok(
            narrow.width <= 320 && narrow.scrollWidth <= narrow.contentWidth + 1,
            JSON.stringify(narrow),
          );
          assert.equal(narrow.query, "Jak");
          observations.push(narrow);
          await shortcut("0");
          await browser.wait(async () => (await measure()).zoom === "100", 10_000);
        }
        await browser.navigate().refresh();
        await browser.wait(until.elementLocated(By.css(".collection-rows")), 15_000);
        assert.equal((await measure()).query, "Jak");
      }
      for (const [index, port] of [first.port, second.port].entries()) {
        assert.deepEqual((await status(port.id)).active, before[index]!.active);
      }
    } finally {
      try {
        const file = path.join(output, "native-library-layout-observations.json");
        await writeFile(file, JSON.stringify(observations, null, 2) + "\n", { flag: "wx" });
        artifacts.push(file);
      } finally {
        try {
          await shortcut("0");
        } finally {
          await browser.manage().window().setRect(originalWindow);
        }
      }
    }
  });
  await scenario("native-ready-detail-composition", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const readyStatus = await status(port.id);
    assert.equal(required(readyStatus.readiness).launchable, true);
    assert.ok(readyStatus.active);
    assert.equal(readyStatus.channel, "stable");
    assert.equal(readyStatus.active.channel, "stable");
    assert.ok(!readyStatus.last_update_check);
    // This scenario continues the preliminary-source fixture above. Launchable
    // bytes and successful preparation do not establish confirmed compatibility.
    assert.notEqual(readyStatus.readiness?.source_assessment?.admission.mode, "exact_identity");
    const artworkReply = await invoke("get_artwork", {
      portId: port.id,
      slot: "cover",
      generation: (await read("desktop_bootstrap_status", "get_bootstrap_status")).generation,
    });
    assert.equal(artworkReply.ok, true);
    const artwork = transportValue("artwork_state", artworkReply.value);
    const originalWindow = await browser.manage().window().getRect();
    try {
      for (const theme of ["dark", "light"]) {
        await selectPrimaryNavigation(browser, "Settings");
        await browser
          .findElement(
            By.css(
              'nav[aria-label="Settings categories"] button[aria-controls="settings-appearance"]',
            ),
          )
          .click();
        await clickVisible(
          browser,
          await browser.findElement(
            By.xpath(
              `//*[@role="radiogroup" and @aria-label="Color theme"]//*[@role="radio" and normalize-space(.)="${theme === "dark" ? "Dark" : "Light"}"]`,
            ),
          ),
        );
        await open(port, false);
        assert.equal(
          await executeBrowserScript(browser, () => document.documentElement.dataset.theme),
          theme,
        );
        const play = await browser.wait(until.elementLocated(button("Try launch")), 15_000);
        assert.equal(await play.isEnabled(), true);
        assert.equal(await play.getAttribute("data-variant"), "primary");
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (expected) => {
                const hero = document.querySelector<HTMLElement>(".game-hero-detail");
                const image = hero?.querySelector<HTMLImageElement>(".game-hero-image");
                if (image) return image.complete && image.naturalWidth > 0;
                return (
                  expected.resolved_source.kind === "generated_fallback" &&
                  hero?.dataset.heroIdentity === "text" &&
                  !hero.querySelector('[data-loading="true"]') &&
                  Boolean(hero.querySelector("#port-detail-title")?.textContent?.trim()) &&
                  Boolean(
                    hero.querySelector('.detail-header-actions button[data-variant="primary"]'),
                  )
                );
              },
              artwork,
            ),
          15_000,
          "The owned port cover image or identified fallback did not settle before visual capture",
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
                portId: document
                  .querySelector("[data-detail-port-id]")
                  ?.getAttribute("data-detail-port-id"),
                actionInHero: Boolean(action.closest(".detail-hero")),
                state: document
                  .querySelector(".detail-hero [data-detail-readiness]")
                  ?.textContent?.trim(),
                groups: [...document.querySelectorAll("[data-detail-workspace] [role=tab]")].map(
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
          assert.equal(hierarchy.title, gameTitle(port));
          assert.equal(hierarchy.portId, port.id);
          assert.equal(hierarchy.actionInHero, true);
          assert.match(required(hierarchy.state), /Compatibility unconfirmed/);
          assert.deepEqual(hierarchy.groups, [
            "Overview",
            "Game files",
            "Saves & backups",
            "Versions & updates",
            "Manage",
          ]);
          assert.equal(hierarchy.horizontalOverflow, false);
          assert.ok(
            hierarchy.action.top >= 0 &&
              hierarchy.action.bottom <= hierarchy.viewport.height &&
              hierarchy.action.left >= 0 &&
              hierarchy.action.right <= hierarchy.viewport.width,
            `Trial launch must remain visible at ${actualWindow.width}x${actualWindow.height}: ${JSON.stringify(hierarchy)}`,
          );
          await revealDetailSection(browser, "Versions & updates");
          const facts = await executeBrowserScript(browser, () => {
            const summary = document.querySelector(".detail-version-stage");
            if (!(summary instanceof HTMLElement)) throw new Error("Version summary is missing");
            summary.scrollIntoView({ block: "center", behavior: "instant" });
            const current = summary.querySelector(".detail-version-current");
            return {
              version: current?.querySelector("strong")?.textContent?.trim(),
              channel: current?.querySelector(".identity-chip")?.textContent?.trim(),
              horizontalOverflow: summary.scrollWidth > summary.clientWidth + 1,
            };
          });
          assert.equal(facts.version, readyStatus.active.version);
          assert.equal(readyStatus.active.channel, "stable");
          assert.equal(facts.channel, "Stable");
          assert.equal(facts.horizontalOverflow, false);
          const factsScreenshot = path.join(output, `game-details-facts-${theme}-${width}.png`);
          await writeFile(factsScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(factsScreenshot);
          await revealDetailSection(browser, "Manage");
          const installation = await browser.findElement(
            By.xpath(
              '//*[@data-slot="current-state-summary" and .//h3[normalize-space(.)="Managed installation"]]',
            ),
          );
          const folder = await executeBrowserScript(
            browser,
            (summary) => {
              summary.scrollIntoView({ block: "center", behavior: "instant" });
              return {
                path: summary.querySelector("p.select-text")?.textContent?.trim(),
                horizontalOverflow: summary.scrollWidth > summary.clientWidth + 1,
              };
            },
            installation,
          );
          assert.equal(folder.path, readyStatus.active.path);
          assert.equal(folder.horizontalOverflow, false);
          const folderScreenshot = path.join(
            output,
            `game-details-installation-folder-${theme}-${width}.png`,
          );
          await writeFile(folderScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(folderScreenshot);
          await executeBrowserScript(browser, () => {
            const workspace = document.querySelector('main[data-focus-region="workspace"]');
            const owner =
              workspace && getComputedStyle(workspace).overflowY === "visible"
                ? (document.scrollingElement ?? document.documentElement)
                : workspace;
            owner?.scrollTo({ top: 0 });
          });
        }
      }
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
  });
  await scenario("native-game-return-continuity", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const before = await status(port.id);
    const preimage = path.join(output, "game-return-continuity-before.json");
    await writeFile(preimage, JSON.stringify(before, null, 2), { flag: "wx" });
    artifacts.push(preimage);
    assert.equal(
      required(before.readiness).launchable,
      true,
      "Game return requires a launchable fixture",
    );
    assert.notEqual(before.readiness?.source_assessment?.admission.mode, "exact_identity");
    await browser.navigate().refresh();
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      15_000,
    );
    await dismissApplicationUpdateChoice();
    await selectPrimaryNavigation(browser, "Library");
    const originalWindow = await browser.manage().window().getRect();
    try {
      await browser.manage().window().setRect({ width: 720, height: 560 });
      const query = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
      await query.sendKeys(
        Key.chord(process.platform === "darwin" ? Key.COMMAND : Key.CONTROL, "a"),
        Key.BACK_SPACE,
        port.name,
      );
      const filters = await openCatalogFilters(browser);
      const advanced = await filters.findElement(
        By.xpath('.//summary[normalize-space(.)="Advanced filters"]'),
      );
      if ((await advanced.findElement(By.xpath("..")).getAttribute("open")) === null)
        await clickVisible(browser, advanced);
      const readiness = await filters.findElement(
        By.css('.collection-readiness [role="combobox"]'),
      );
      await browser.wait(until.elementIsVisible(readiness), 5_000);
      await clickVisible(browser, readiness);
      const ready = await browser.wait(
        until.elementLocated(
          By.xpath('//*[@role="option"][starts-with(normalize-space(.),"Ready (")]'),
        ),
        5_000,
      );
      await browser.wait(
        async () => /^Ready \([1-9][0-9]*\)$/u.test(await ready.getText()),
        15_000,
        "Library readiness counts did not settle",
      );
      await clickVisible(browser, ready);
      const selectedReadiness = await readiness.findElement(By.css('[data-slot="select-value"]'));
      await browser.wait(
        async () => /^Ready \([1-9][0-9]*\)$/u.test(await selectedReadiness.getText()),
        5_000,
        "Library Ready choice did not commit",
      );
      const readyLabel = await selectedReadiness.getText();
      const card = await browser.wait(
        until.elementLocated(By.xpath(`//article[.//button[@data-detail-game-id="${port.id}"]]`)),
        15_000,
      );
      const play = await card.findElement(By.xpath('.//button[normalize-space(.)="Try launch"]'));
      await executeBrowserScript(
        browser,
        (element) => {
          const workspace = document.querySelector<HTMLElement>(
            'main[data-focus-region="workspace"]',
          );
          if (!workspace) throw new Error("Library workspace is missing");
          const owner =
            getComputedStyle(workspace).overflowY === "visible"
              ? (document.scrollingElement ?? document.documentElement)
              : workspace;
          const viewportTop = owner === workspace ? workspace.getBoundingClientRect().top : 0;
          const target = element.getBoundingClientRect();
          // Position only the actual reading owner. All-ancestor scrollIntoView
          // can scroll hidden outer containers when the owner reaches its limit.
          owner.scrollTo({
            top:
              owner.scrollTop + target.top - viewportTop - (owner.clientHeight - target.height) / 2,
            behavior: "instant",
          });
        },
        play,
      );
      const scrollBefore = await executeBrowserScript(browser, () => {
        const workspace = document.querySelector('main[data-focus-region="workspace"]');
        if (!workspace) throw new Error("Library workspace is missing");
        const owner =
          getComputedStyle(workspace).overflowY === "visible"
            ? (document.scrollingElement ?? document.documentElement)
            : workspace;
        return owner.scrollTop;
      });
      assert.ok(scrollBefore > 0, "The compact Library fixture must exercise a real scroll");
      const beforeClick = await executeBrowserScript(browser, launchContinuityPoint, play);
      const beforeClickPath = path.join(output, "game-return-before-click.json");
      await writeFile(beforeClickPath, JSON.stringify(beforeClick, null, 2), { flag: "wx" });
      artifacts.push(beforeClickPath);
      const beforeImage = path.join(output, "native-game-return-before-click.png");
      await writeFile(beforeImage, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(beforeImage);
      assert.ok(
        required(beforeClick.workspaceRectangle).top >= -1,
        `Initial Library positioning must not scroll a hidden outer container: ${JSON.stringify(beforeClick)}`,
      );
      await play.click();
      const afterClick = await executeBrowserScript(browser, launchContinuityPoint, play);
      const afterClickPath = path.join(output, "game-return-after-click.json");
      await writeFile(afterClickPath, JSON.stringify(afterClick, null, 2), { flag: "wx" });
      artifacts.push(afterClickPath);
      await browser.wait(
        async () => (await status(port.id)).successful_launches > before.successful_launches,
        15_000,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (identity, launches) => {
              const recent = document.querySelector<HTMLElement>(".continue-card");
              return (
                recent?.getAttribute("aria-label") === `Continue ${identity}` &&
                Number(recent.dataset.successfulLaunches ?? 0) > launches
              );
            },
            gameIdentityLabel(port),
            before.successful_launches,
          ),
        15_000,
        "Library did not render the completed launch after the game exited",
      );
      await browser.wait(
        async () =>
          (await play.isEnabled()) && (await play.getAttribute("aria-disabled")) !== "true",
        15_000,
        "Launch origin remained excluded after game return and workspace readback",
      );
      const settled = await executeBrowserScript(browser, launchContinuityPoint, play);
      const returned = await executeBrowserScript(
        browser,
        (element) => {
          const workspace = document.querySelector('main[data-focus-region="workspace"]');
          const search = document.querySelector<HTMLInputElement>("#port-search");
          const ready = document.querySelector(
            '.collection-readiness [role="combobox"] [data-slot="select-value"]',
          );
          const card = element.closest("article.port-card");
          const bounds = card?.getBoundingClientRect();
          const workspaceBounds = workspace?.getBoundingClientRect();
          const owner =
            workspace && getComputedStyle(workspace).overflowY === "visible"
              ? (document.scrollingElement ?? document.documentElement)
              : workspace;
          return {
            query: search?.value,
            filter: ready?.textContent?.trim(),
            scrollTop: owner?.scrollTop,
            playFocused: document.activeElement === element,
            playConnected: element.isConnected,
            cardVisible:
              bounds && workspaceBounds
                ? bounds.bottom > Math.max(0, workspaceBounds.top) &&
                  bounds.top < Math.min(innerHeight, workspaceBounds.bottom)
                : false,
          };
        },
        play,
      );
      const observation = path.join(output, "game-return-continuity-observation.json");
      await writeFile(
        observation,
        JSON.stringify({ scrollBefore, beforeClick, afterClick, settled, returned }, null, 2),
        {
          flag: "wx",
        },
      );
      artifacts.push(observation);
      const settledImage = path.join(output, "native-game-return-settled-before-assert.png");
      await writeFile(settledImage, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(settledImage);
      assert.equal(returned.query, port.name);
      assert.equal(returned.filter, readyLabel);
      assert.equal(returned.playConnected, true, "Original Play control disconnected after return");
      assert.equal(returned.playFocused, true, "Play control lost focus after return");
      assert.equal(
        returned.cardVisible,
        true,
        "Launched card is outside the reading viewport after return",
      );
      assert.ok(
        Math.abs(
          required(settled.originRectangle).top - required(beforeClick.originRectangle).top,
        ) <= 2,
        `Library launch origin moved after game return: ${JSON.stringify({ before: beforeClick.originRectangle, settled: settled.originRectangle, scrollBefore, scrollAfter: returned.scrollTop })}`,
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
    await revealDetailSection(browser, "Versions & updates");
    await clickVisible(browser, await browser.findElement(button("Check for updates")));
    const updateControl = await browser.wait(
      until.elementLocated(By.css('section[aria-label="Review game update"]')),
      15_000,
    );
    assert.equal(
      (await updateControl.findElements(By.css('[data-slot="select-trigger"]'))).length,
      0,
    );
    const before = await status(port.id);
    const activityBefore = (await invoke("get_activities")).value;
    const trigger = await browser.findElement(button("Update now"));
    await clickVisible(browser, trigger);
    const dialog = By.css("[data-game-update-review]");
    const review = await browser.wait(until.elementLocated(dialog), 15_000);
    await browser.wait(
      async () => (await review.getText()).includes("Confirm the release"),
      5_000,
      "Game update review did not show its release confirmation",
    );
    // The immediate disposition is explicit; changing it requests a new bound plan.
    const initialReviewText = await review.getText();
    const keepForLater = [
      ...(await review.findElements(button("Prepare for later"))),
      ...(await review.findElements(button("Keep for later"))),
    ];
    if (keepForLater.length) {
      assert.ok(initialReviewText.includes("Confirm the release"));
      await clickVisible(browser, keepForLater[0]!);
      await browser.wait(
        async () => (await review.getText()).includes("Your current version stays unchanged"),
        5_000,
      );
    }
    const reviewText = await review.getText();
    const bootstrap = await read("desktop_bootstrap_status", "get_bootstrap_status");
    const candidate = await read("game_update_plan", "plan_game_update", {
      portId: port.id,
      activate: false,
      generation: bootstrap.generation,
    });
    assert.ok(reviewText.includes("Confirm the release"));
    assert.ok(reviewText.includes(candidate.plan.release.version));
    if (["download", "use_staged", "reuse_retained"].includes(candidate.plan.action)) {
      assert.equal(
        keepForLater.length,
        1,
        "A usable update must expose its real keep-for-later action",
      );
      assert.ok(
        reviewText.includes(
          "This keeps the prepared update for later. Your current version stays unchanged.",
        ),
      );
    }
    assert.ok(
      reviewText.includes("Saved update settings are unchanged") ||
        reviewText.includes("already active") ||
        reviewText.includes("unverified local copy"),
    );
    await assertCompactReview(browser, "[data-game-update-review]");
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
        browser
          .findElement(button("Update now"))
          .then((currentTrigger) =>
            executeBrowserScript(
              browser,
              "return document.activeElement === arguments[0];",
              currentTrigger,
            ),
          ),
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
              const versions = element.querySelector(".update-versions");
              if (!(versions instanceof HTMLElement))
                throw new Error("Update version comparison is missing");
              const offered = versions.querySelector("strong");
              const bounds = versions.getBoundingClientRect();
              const offeredBounds = offered?.getBoundingClientRect();
              return {
                rowOverflow: element.scrollWidth > element.clientWidth + 1,
                documentOverflow:
                  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
                labels: [...versions.querySelectorAll(".sr-only")].map((label) =>
                  label.textContent?.trim(),
                ),
                installed: [...versions.childNodes]
                  .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
                  ?.textContent?.trim(),
                offered: offered?.textContent?.trim(),
                visible:
                  getComputedStyle(versions).display !== "none" &&
                  bounds.width > 0 &&
                  bounds.height > 0 &&
                  Boolean(offeredBounds && offeredBounds.width > 0 && offeredBounds.height > 0),
                versionsOverflow: versions.scrollWidth > versions.clientWidth + 1,
              };
            },
            row,
          );
          assert.equal(comparison.rowOverflow, false);
          assert.equal(comparison.documentOverflow, false);
          assert.deepEqual(comparison.labels, ["Installed version:", "; offered version:"]);
          assert.equal(comparison.installed, required(before.active).version);
          assert.equal(comparison.offered, candidate.plan.release.version);
          assert.equal(comparison.visible, true);
          assert.equal(comparison.versionsOverflow, false);
          const comparisonScreenshot = path.join(
            output,
            `native-game-update-comparison-${theme}-${width}x${height}.png`,
          );
          await writeFile(comparisonScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(comparisonScreenshot);
          const details = await row
            .findElement(By.xpath(".."))
            .findElement(By.xpath('.//details[summary[normalize-space(.)="Update details"]]'));
          const wasOpen = (await details.getAttribute("open")) !== null;
          if (!wasOpen) await clickVisible(browser, await details.findElement(By.css("summary")));
          assert.equal(await details.isDisplayed(), true);
          const latest = await details.getText();
          assert.match(latest, /Latest eligible/);
          assert.ok(latest.includes(candidate.plan.release.version));
          assert.ok(latest.includes("Stable"));
          assert.equal(
            await executeBrowserScript(
              browser,
              (element) => element.scrollWidth > element.clientWidth + 1,
              details,
            ),
            false,
          );
          const latestScreenshot = path.join(
            output,
            `native-game-update-latest-eligible-${theme}-${width}x${height}.png`,
          );
          await writeFile(latestScreenshot, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(latestScreenshot);
          if (!wasOpen) await clickVisible(browser, await details.findElement(By.css("summary")));
          await selectActivitySection(browser, "History");
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
          await selectActivitySection(browser, "Game updates");
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
      assert.equal(await verify.getText(), "Check installed files");
      assert.equal(await verify.isEnabled(), true);
      assert.equal((await browser.findElements(button("Check installed files"))).length, 1);
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
      await revealDetailSection(browser, "Versions & updates");
      const target = await browser.findElement(button("Restore previous version"));
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
      await browser.findElement(button("Review setup")).click();
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
      const action = await settleDirectPreparationRecovery(browser);
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
          return titles.length === 1 && (await required(titles[0]).getText()) === gameTitle(port);
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
      await browser.findElement(button("Review setup")).click();
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
        await revealDetailSection(browser, "Manage");
        const verify = await browser.findElement(button("Check installed files"));
        assert.equal(
          await verify.isDisplayed(),
          true,
          "Manage must expose installation verification",
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
        await selectPrimaryNavigation(browser, "Library");
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
        await selectPrimaryNavigation(browser, "Library");
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
      await selectPrimaryNavigation(browser, "Activity");
      const cancelledRow = await browser.wait(
        until.elementLocated(
          By.css(`.activity-row.cancelled[data-activity-id="${required(activity).id}"]`),
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
      await selectPrimaryNavigation(browser, "Settings");
      await browser.wait(
        until.elementLocated(By.xpath('//h1[normalize-space(.)="Settings"]')),
        15_000,
      );
      await selectPrimaryNavigation(browser, "Activity");
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
      await selectPrimaryNavigation(browser, "Activity");
      await browser.wait(
        until.elementLocated(By.css(".activity-row.cancelled .failure-details")),
        15_000,
      );
      const row = await browser.findElement(By.css(".activity-row.cancelled"));
      assert.match(await row.getText(), /An earlier attempt left unfinished work/);
      assert.doesNotMatch(await row.getText(), /No files were changed/);
      await clickVisible(browser, await row.findElement(By.css(".failure-details summary")));
      const preparationLog = await preparationLogControl(browser, row);
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
      await clickVisible(browser, preparationLog);
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
      const exported = transportValue("desktop_support_bundle_export", bundle.value);
      artifacts.push(exported.path);
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
    await selectPrimaryNavigation(browser, "Library");
    const card = By.xpath(`//button[@data-detail-game-id="${port.id}"]`);
    await browser.wait(until.elementLocated(card), 15_000);
    await browser.findElement(card).click();
    await revealDetailSection(browser, "Versions & updates");

    await clickVisible(
      browser,
      await browser.findElement(
        By.xpath('//summary[normalize-space(.)="Future update preferences"]'),
      ),
    );
    const before = await status(port.id);
    const activities = await invoke("get_activities");
    const policyTrigger = By.css('section[aria-label="Game update settings"] [role="combobox"]');
    const policyControl = await browser.findElement(policyTrigger);
    assert.match(await policyControl.getAccessibleName(), /^Game update behavior\s/u);
    await policyControl.sendKeys(Key.ENTER);
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
    await selectPrimaryNavigation(browser, "Discover");
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
      await selectCatalogPort(browser, port.id);
      await revealDetailSection(browser, "Versions & updates");

      await clickVisible(
        browser,
        await browser.findElement(
          By.xpath('//summary[normalize-space(.)="Future update preferences"]'),
        ),
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
    await selectPrimaryNavigation(browser, "Discover");
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

  await scenario("native-library-organization-restart", async () => {
    const { port } = await seed("opengoal-jak1", "success");
    const before = await status(port.id);
    assert.ok(before.active, "Organization fixture must be an actual owned installation");
    const sourcesBefore = command(["source", "list"]);
    const backupsBefore = command(["backup", "list", port.id]);
    const originalWindow = await browser.manage().window().getRect();
    const collectionName = "Owned native collection";
    const click = (locator: Locator) => reviewControls(browser).click(locator);
    const organization = async () => {
      const bootstrap = await read("desktop_bootstrap_status", "get_bootstrap_status");
      return read("desktop_library_organization", "get_library_organization", {
        generation: bootstrap.generation,
      });
    };
    const favorites = async () => {
      const bootstrap = await read("desktop_bootstrap_status", "get_bootstrap_status");
      const response = await invoke("get_favorite_ports", { generation: bootstrap.generation });
      assert.equal(response.ok, true);
      const ids = response.value;
      assert.ok(Array.isArray(ids) && ids.every((id) => typeof id === "string"));
      return ids;
    };
    const capture = async (name: string) => {
      const screenshot = path.join(output, `native-organization-${name}.png`);
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
    };
    const libraryView = async () => {
      await open(port, false);
      await clickVisible(browser, await browser.findElement(By.css(".detail-back")));
      await selectPrimaryNavigation(browser, "Library");
      await browser.wait(
        until.elementLocated(By.css(`[data-detail-game-id="${port.id}"]`)),
        15_000,
      );
    };
    const manageCollections = async () => {
      await clickVisible(
        browser,
        await browser.findElement(By.css('button[aria-label="Manage collections"]')),
      );
      await browser.wait(
        until.elementLocated(
          By.xpath('//label[contains(normalize-space(.),"Collection name")]//input'),
        ),
        5_000,
      );
    };
    const more = () => By.xpath(`//button[@data-detail-origin="library:card-more:${port.id}"]`);
    const favorite = () => By.xpath(`//button[@aria-label="Favorite ${gameIdentityLabel(port)}"]`);
    const closeMembershipMenu = async () => {
      // Checkbox membership intentionally keeps the modal menu open.
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () =>
          (await browser.findElement(more()).getAttribute("aria-expanded")) === "false" &&
          (
            await browser.findElements(
              By.xpath(
                `//*[@role="menu" and @aria-label="More actions for ${gameIdentityLabel(port)}"]`,
              ),
            )
          ).length === 0,
        5_000,
        "Collection membership menu must close before another workspace control is used",
      );
    };
    try {
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      await libraryView();
      const initial = await organization();
      const initialFavorites = await favorites();
      assert.equal(initialFavorites.includes(port.id), false, "Owned fixture starts unfavorited");
      assert.ok(!Object.values(initial.collections).some((entry) => entry.name === collectionName));
      await manageCollections();
      await browser
        .findElement(By.xpath('//label[contains(normalize-space(.),"Collection name")]//input'))
        .sendKeys(collectionName);
      await click(button("Create collection"));
      await browser.wait(
        async () =>
          Object.values((await organization()).collections).some(
            (entry) => entry.name === collectionName,
          ),
        15_000,
      );
      const created = await organization();
      const collectionId = required(
        Object.entries(created.collections).find(([, entry]) => entry.name === collectionName),
      )[0];
      assert.deepEqual(required(created.collections[collectionId]).port_ids, []);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await click(more());
      const membership = By.xpath(
        `//*[@role="menuitemcheckbox" and normalize-space(.)="${collectionName}"]`,
      );
      await click(membership);
      await browser.wait(
        async () => (await organization()).collections[collectionId]?.port_ids.includes(port.id),
        15_000,
      );
      await closeMembershipMenu();
      await click(favorite());
      await browser.wait(async () => (await favorites()).includes(port.id), 15_000);
      await click(By.css(`button[aria-label="Collection: ${collectionName}"]`));
      await browser.wait(until.elementLocated(By.css(`[data-detail-game-id="${port.id}"]`)), 5_000);
      await capture("membership-favorite-saved");
      const persisted = await organization();
      const savedFavorites = await favorites();
      browser = await restartApplication("native-organization-persisted");
      await browser.manage().window().setRect({ width: 1280, height: 900 });
      await libraryView();
      assert.deepEqual(await organization(), persisted);
      assert.deepEqual(await favorites(), savedFavorites);
      await browser.wait(
        async () => (await browser.findElement(favorite()).getAttribute("aria-pressed")) === "true",
        5_000,
      );
      await click(By.css(`button[aria-label="Collection: ${collectionName}"]`));
      await browser.wait(until.elementLocated(By.css(`[data-detail-game-id="${port.id}"]`)), 5_000);
      await capture("restarted-selection");
      await click(more());
      await click(membership);
      await browser.wait(
        async () => (await organization()).collections[collectionId]?.port_ids.length === 0,
        15_000,
      );
      await closeMembershipMenu();
      await manageCollections();
      await click(button("All games"));
      await click(
        By.xpath(
          `//p[contains(normalize-space(.),"${collectionName}")]//button[normalize-space(.)="Remove collection"]`,
        ),
      );
      await browser.wait(async () => !(await organization()).collections[collectionId], 15_000);
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await click(favorite());
      await browser.wait(async () => !(await favorites()).includes(port.id), 15_000);
      const final = await organization();
      assert.deepEqual(final.collections, initial.collections);
      assert.deepEqual(await favorites(), initialFavorites);
      const after = await status(port.id);
      for (const key of ["active", "staged", "previous"] as const)
        assert.deepEqual(after[key], before[key]);
      assert.deepEqual(command(["source", "list"]), sourcesBefore);
      assert.deepEqual(command(["backup", "list", port.id]), backupsBefore);
      await capture("removed-with-installation-preserved");
      const report = path.join(output, "library-organization-result.json");
      await writeFile(
        report,
        `${JSON.stringify(
          {
            port_id: port.id,
            collection_id: collectionId,
            initial,
            persisted,
            final,
            favorites_before: initialFavorites,
            favorites_persisted: savedFavorites,
            host_restart_preserved_preferences: true,
            installed_versions_sources_backups_preserved: true,
            window: await browser.manage().window().getRect(),
            evidence:
              "Normal application controls and real preference IPC in an isolated owned fixture; no physical input or gameplay claim.",
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      artifacts.push(report);
    } finally {
      await browser.manage().window().setRect(originalWindow);
    }
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
      get acquisitionWaitPath(): never {
        return assert.fail("Preflight must not read acquisition fixture paths");
      },
      holdArtifact: (): never => assert.fail("Preflight must not hold an artifact transfer"),
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
    // Full-profile registration has no native acquisition observer authority.
    ownedGameProcess: undefined,
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
