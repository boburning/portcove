import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import type { WebDriver, Locator } from "selenium-webdriver";
import type { FixtureCommand, OwnedFixtureContext } from "./desktop-scenario-state.mts";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import type {
  PortDefinition,
  GameFileRoot,
  GameFileScanSnapshot,
  PortStatus,
  SourceRecord,
  OutputSourceImportPlan,
  InstallPlan,
  ActivityRecord,
  GameFileScanCoverage,
} from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
import type { ProbeCleanup, ProbeNative } from "./desktop-owned-ipc-probe.mts";
interface SourceDialogContext {
  browser: WebDriver;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
}
type InstallFixture = Awaited<ReturnType<typeof createInstallFixture>>;
type SetupFixture = Omit<InstallFixture, "sourceJourney"> & {
  sourceJourney: (NonNullable<InstallFixture["sourceJourney"]> & { root?: GameFileRoot }) | null;
  hashResumeInitial?: GameFileScanSnapshot;
};
interface SelectedSetupContext extends Omit<SourceDialogContext, "command">, OwnedFixtureContext {
  fixture: SetupFixture;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
}
/** Raw authoring catalogs precede Core defaults; only the consumed label is read. */
export function sourceProfileLabel(value: unknown, profile: string): string {
  const identities: unknown = object(object(value).source_catalog).identities;
  assert.ok(Array.isArray(identities), "raw source identities must be an array");
  const entries: unknown[] = identities;
  const identity = entries.map(object).find((entry) => entry.id === profile);
  assert.ok(
    identity && typeof identity.label === "string",
    "raw source profile must have a text label",
  );
  return identity.label;
}
export async function waitForDisabledSourceReview(browser: WebDriver, candidate: () => Locator) {
  await browser.wait(
    async () =>
      !(await browser
        .findElement(candidate())
        .findElement(By.css("[data-candidate-review]"))
        .isEnabled()),
    5_000,
    "Selected setup: stale review disabled after unavailable-root refresh",
  );
}

function gameFileRoot(value: unknown): GameFileRoot {
  return required(transportValue("game_file_roots", [value])[0]);
}
type SetupInvoke = SelectedSetupContext["invoke"];
export async function selectedSetupGeneration(invoke: SetupInvoke) {
  const response = object(await invoke("get_bootstrap_status"));
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return transportValue("desktop_bootstrap_status", response.value).generation;
}

export function selectedSetupRead(invoke: SetupInvoke, generation: number) {
  function read(
    name: "get_game_file_scan_snapshot",
    args?: Record<string, unknown>,
  ): Promise<GameFileScanSnapshot>;
  function read(
    name: "plan_source_import",
    args?: Record<string, unknown>,
  ): Promise<OutputSourceImportPlan>;
  function read(name: "get_sources", args?: Record<string, unknown>): Promise<SourceRecord[]>;
  function read(name: "get_statuses", args?: Record<string, unknown>): Promise<PortStatus[]>;
  function read(name: "plan_port", args?: Record<string, unknown>): Promise<InstallPlan>;
  async function read(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const response = object(
      await invoke(name, name === "get_game_file_scan_snapshot" ? { ...args, generation } : args),
    );
    assert.equal(response.ok, true, JSON.stringify(response.error));
    switch (name) {
      case "get_game_file_scan_snapshot":
        return required(transportValue("game_file_scan_snapshot", response.value));
      case "plan_source_import":
        return transportValue("source_import_plan", response.value);
      case "get_sources":
        return transportValues("source", response.value);
      case "get_statuses":
        return transportValues("status", response.value);
      case "plan_port":
        return transportValue("install_plan", response.value);
      default:
        throw new Error(`Unknown selected-setup read: ${name}`);
    }
  }
  return read;
}
// lib.dom declares DOMRect.toJSON() as any. These local assertions retain its
// standard numeric projection; real browser layout remains the observation source.
type Rectangle = Pick<
  DOMRectReadOnly,
  "x" | "y" | "width" | "height" | "top" | "right" | "bottom" | "left"
>;
interface MetadataPresentation {
  size: string;
  association: string;
  size_rects: Rectangle[];
  association_rects: Rectangle[];
  clipping: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number; device_scale: number };
  window?: { x: number; y: number; width: number; height: number };
}
interface SetupObservations {
  scan?: GameFileScanSnapshot;
  review_text?: string;
  source_review_text?: string;
  registration_unchanged?: boolean;
  input_unchanged?: boolean;
  no_setup_acquisition?: boolean;
  neutral_source_cancel_restored_opener_focus?: boolean;
  registered?: SourceRecord[];
  status?: PortStatus;
  setup_plan?: InstallPlan;
  independent_cli_plan?: InstallPlan;
  setup_review_text?: string;
  initial_keyboard_focus?: { document_focused: boolean; active_html: string | undefined };
  native_keyboard_focus?: unknown;
  neutral_setup_cancel_restored_opener_focus?: boolean;
  original_unchanged?: boolean;
  no_acquisition_or_installation?: boolean;
  returned_selection?: boolean;
  returned_owner_focus?: boolean;
  initial?: GameFileScanSnapshot;
  continued?: GameFileScanSnapshot;
  fresh_plan?: OutputSourceImportPlan;
  originals_unchanged?: boolean;
  no_acquisition?: boolean;
  initial_scan?: GameFileScanSnapshot;
  source_metadata_presentation?: MetadataPresentation;
  changed_input?: {
    reviewed_a: OutputSourceImportPlan;
    admitted_b: OutputSourceImportPlan;
    refusal?: string;
    activities?: ActivityRecord[];
    failed_import?: ActivityRecord;
  };
  rescan?: GameFileScanSnapshot;
  new_a_review?: OutputSourceImportPlan;
  game_registered?: SourceRecord[];
  continuation_geometry?: unknown;
  missing_bios_status?: PortStatus;
  missing_bios_plan?: InstallPlan;
  missing_bios_detail?: Awaited<ReturnType<typeof selectedSetupDetail>>;
  bios_review?: OutputSourceImportPlan;
  committed_registrations?: SourceRecord[];
  authoritative_ports?: unknown;
  registered_bios_detail?: Awaited<ReturnType<typeof selectedSetupDetail>>;
  unavailable?: {
    roots: GameFileRoot[];
    snapshot: GameFileScanSnapshot;
    inspection: unknown;
    registrations: SourceRecord[];
    controls: { text: string; disabled: boolean }[];
    scan_enabled?: boolean;
  };
  viewport?: { width: number; height: number };
  window?: { x: number; y: number; width: number; height: number };
}
interface SetupReport {
  scope: string;
  observations: SetupObservations;
  limitations?: string[];
  port_ids?: string[];
  seeded_saved_root?: GameFileRoot;
  checkpoint?: string;
  failure?: string;
  failure_details?: { checkpoint: string; name: unknown; message: unknown; stack: unknown };
  failure_state?: unknown;
  failure_state_error?: string;
  original_inputs_restored?: boolean;
  cleanup_failure?: string;
}
interface ProgressiveObservations extends Partial<ProbeCleanup> {
  evidence: string;
  port_id: string;
  source_profile: string;
  expected_associated_ports: { id: string; name: string }[];
  expected_association_text: string;
  injected: number;
  restored: boolean;
  detail_return_focus?: boolean;
  pending_scan_survived_detail_return?: boolean;
  association_presentation?: unknown;
  failure_capture_error?: string;
  failure?: string;
  owned_cleanup?: { action: string; attempted: boolean; completed: boolean; error?: string }[];
}
function rethrowFailure(error: unknown): never {
  throw error;
}
export async function selectedSetupScanCompleted(
  enabled: () => Promise<boolean>,
  activities: () => readonly Pick<ActivityRecord, "id" | "operation" | "status">[],
  completedBefore: ReadonlySet<string>,
) {
  return (
    (await enabled()) &&
    activities().some(
      (item) =>
        item.operation === "discover_sources" &&
        item.status === "succeeded" &&
        !completedBefore.has(item.id),
    )
  );
}
interface CoverageProbe {
  original: typeof fetch;
  reads: number;
  scans: number;
  snapshot: GameFileScanSnapshot & { coverage: GameFileScanCoverage };
  limits?: unknown;
}
interface FocusEventObservation {
  type: string;
  key: string | undefined;
  shift: boolean | undefined;
  inside: boolean;
  guard: boolean;
  html: string | undefined;
  document_focused: boolean;
}
interface FocusTrace {
  events: FocusEventObservation[];
  guards: string[];
  close(): void;
}
type OwnedWindow = Window & {
  __TAURI_INTERNALS__?: Pick<ProbeNative, "convertFileSrc" | "runCallback">;
  __portcoveCoverageProbe?: CoverageProbe;
  __portcove244FocusTrace?: FocusTrace;
};
import { executeBrowserScript } from "./browser-script.mts";
import { revealDetailSection, assertReviewFieldPresentation } from "./desktop-review-controls.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
// Actual-Tauri proof for the paired one-off intake and explicit-folder source journeys.
import assert from "node:assert/strict";
import {
  beginProgressiveScanProbe,
  requireTrustedProbeCleanup,
} from "./desktop-owned-ipc-probe.mts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  clickVisible,
  openCatalogPortAfterRefresh,
  reviewControls,
  selectGameFilesSettings,
} from "./desktop-review-controls.mts";

async function progressiveScanNavigation({
  browser,
  output,
  artifacts,
  command,
  port,
  searchRoot,
}: Omit<SourceDialogContext, "scenario"> & {
  port: Pick<PortDefinition, "id" | "name" | "source_profile">;
  searchRoot: string;
}) {
  const { button, click } = reviewControls(browser);
  const sourcesBefore = transportValues("source", command(["source", "list"]));
  const statusBefore = transportValue("status", command(["status", port.id]));
  const rootsBefore = transportValue("game_file_roots", command(["source", "roots", "list"]));
  const source = sourcesBefore.find((item) => item.profile_id === port.source_profile);
  assert.ok(source, "The ordinary preparation dependency must supply a registered source");
  const catalog = transportValues("port", command(["catalog", "list"]));
  assert.ok(Array.isArray(catalog), "The compiled CLI must return the effective catalog ports");
  const associatedPorts = catalog
    .filter(
      (item) =>
        item.source_profile === source.profile_id || item.bios_source_profile === source.profile_id,
    )
    .map(({ id, name }) => {
      assert.equal(typeof id, "string");
      assert.equal(typeof name, "string");
      return { id, name };
    });
  assert.ok(associatedPorts.some((item) => item.id === port.id));
  const associationText = `Catalog ports using this profile: ${associatedPorts.map((item) => item.name).join(", ")}`;
  assert.ok(Array.isArray(rootsBefore));
  assert.ok(!rootsBefore.some((item) => item.path === searchRoot));
  const root = gameFileRoot(command(["source", "roots", "add", searchRoot]));
  const observations: ProgressiveObservations = {
    evidence:
      "controlled pending scan and provisional registered-source event in normal Tauri; not an actual discovery or backend cancellation",
    port_id: port.id,
    source_profile: source.profile_id,
    expected_associated_ports: associatedPorts,
    expected_association_text: associationText,
    injected: 0,
    restored: false,
  };
  let probe;
  let scenarioError;
  let primaryError;
  let cleanupError;
  try {
    try {
      await click(button("Refresh folders"));
      await browser.wait(async () => {
        const scan = await browser.findElements(button("Scan saved folders"));
        return scan.length === 1 && scan[0] !== undefined && (await scan[0].isEnabled());
      }, 5_000);
      probe = await beginProgressiveScanProbe(browser, { source });
      assert.ok(probe);
      await click(button("Scan saved folders"));
      await browser.wait(until.elementLocated(button(`View ${port.name} details`)), 5_000);
      assert.equal(await browser.findElement(button("Scan saved folders")).isEnabled(), false);
      assert.equal(await browser.findElement(button("Cancel scan")).isEnabled(), true);
      await click(button(`View ${port.name} details`));
      await browser.wait(until.elementLocated(By.css("[data-detail-back]")), 5_000);
      assert.equal((await browser.findElements(By.id("game-file-libraries-heading"))).length, 0);
      await click(By.css("[data-detail-back]"));
      await browser.wait(until.elementLocated(button(`View ${port.name} details`)), 5_000);
      assert.equal(await browser.findElement(button("Scan saved folders")).isEnabled(), false);
      assert.equal(await browser.findElement(button("Cancel scan")).isEnabled(), true);
      const ownedRelink = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (rootPath) => {
              const row = [...document.querySelectorAll(".source-health-row")].find(
                (item) => item.querySelector("code")?.textContent === rootPath,
              );
              return (
                [...(row?.querySelectorAll("button") ?? [])].find(
                  (item) => item.textContent.trim() === "Relink",
                ) ?? null
              );
            },
            root.path,
          ),
        5_000,
        "The remounted saved-folder read must expose the owned root's Relink control",
      );
      assert.ok(ownedRelink);
      assert.equal(await ownedRelink.isEnabled(), false);
      assert.equal(required(await probe.capture()).injected, 1);
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () =>
              document.activeElement?.closest(
                '[data-detail-origin="game-file-libraries-setup"]',
              ) !== null,
          ),
        5_000,
        "Returning from details must restore the saved-folder origin focus",
      );
      observations.detail_return_focus = true;
      observations.pending_scan_survived_detail_return = true;
      const association = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (profile, sourcePath, expected) => {
              const row = [...document.querySelectorAll<HTMLElement>("[data-live-candidate]")].find(
                (item) => item.dataset.profileId === profile && item.dataset.path === sourcePath,
              );
              const spans = [...(row?.querySelectorAll("span") ?? [])].filter((item) =>
                item.textContent.trim().startsWith("Catalog ports using this profile:"),
              );
              return spans.length === 1 &&
                spans[0] !== undefined &&
                spans[0].textContent.trim() === expected
                ? spans[0]
                : null;
            },
            source.profile_id,
            source.path,
            associationText,
          ),
        5_000,
        "The live source row must show the exact effective catalog associations",
      );
      assert.ok(association);
      await executeBrowserScript(
        browser,
        (element) =>
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
        association,
      );
      const presentation = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element, expected) => {
              const viewport = {
                width: innerWidth,
                height: innerHeight,
                client_width: document.documentElement.clientWidth,
                client_height: document.documentElement.clientHeight,
                device_scale: devicePixelRatio,
              };
              const clipping = {
                left: 0,
                top: 0,
                right: Math.min(viewport.width, viewport.client_width),
                bottom: Math.min(viewport.height, viewport.client_height),
              };
              const ancestors = [];
              for (
                let current: Element | null = element;
                current;
                current = current.parentElement
              ) {
                const style = getComputedStyle(current);
                if (
                  style.display === "none" ||
                  style.visibility !== "visible" ||
                  Number(style.opacity) === 0 ||
                  current
                    .getAnimations()
                    .some(
                      (animation) =>
                        animation.playState === "running" &&
                        Number.isFinite(animation.effect?.getComputedTiming().endTime),
                    )
                )
                  return null;
                if (current === element) continue;
                const rect = current.getBoundingClientRect();
                const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
                const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
                if (!clipsX && !clipsY) continue;
                const bounds = {
                  left: rect.left + current.clientLeft,
                  top: rect.top + current.clientTop,
                  right: rect.left + current.clientLeft + current.clientWidth,
                  bottom: rect.top + current.clientTop + current.clientHeight,
                };
                ancestors.push({ tag: current.tagName, id: current.id, clipsX, clipsY, bounds });
                if (clipsX) {
                  clipping.left = Math.max(clipping.left, bounds.left);
                  clipping.right = Math.min(clipping.right, bounds.right);
                }
                if (clipsY) {
                  clipping.top = Math.max(clipping.top, bounds.top);
                  clipping.bottom = Math.min(clipping.bottom, bounds.bottom);
                }
              }
              const text = element.textContent.trim();
              const bounds = element.getBoundingClientRect().toJSON() as Rectangle;
              const fragments = [...element.getClientRects()].map(
                (rect) => rect.toJSON() as Rectangle,
              );
              const framed = (rect: Rectangle) =>
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >= clipping.left &&
                rect.top >= clipping.top &&
                rect.right <= clipping.right &&
                rect.bottom <= clipping.bottom;
              if (
                !element.isConnected ||
                text !== expected ||
                !Number.isFinite(viewport.device_scale) ||
                viewport.device_scale <= 0 ||
                !framed(bounds) ||
                !fragments.length ||
                !fragments.every(framed)
              )
                return null;
              return { text, viewport, bounds, fragments, clipping, clipping_ancestors: ancestors };
            },
            association,
            associationText,
          ),
        5_000,
        "The settled association span must be fully framed within the viewport and clipping ancestors",
      );
      const windowRect = await browser.manage().window().getRect();
      assert.ok(Number.isFinite(windowRect.width) && windowRect.width > 0);
      assert.ok(Number.isFinite(windowRect.height) && windowRect.height > 0);
      observations.association_presentation = { window: windowRect, ...presentation };
      const screenshot = path.join(output, "native-progressive-scan-return.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await captureAccessibilityReport(
        browser,
        path.join(output, "progressive-scan-return-accessibility.json"),
        artifacts,
      );
    } catch (error) {
      scenarioError = error;
      try {
        const dom = path.join(output, "progressive-scan-failure-before-cleanup.html");
        await writeFile(
          dom,
          await executeBrowserScript(browser, () => document.documentElement.outerHTML),
          {
            flag: "wx",
          },
        );
        artifacts.push(dom);
        const screenshot = path.join(output, "progressive-scan-failure-before-cleanup.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
      } catch (captureError) {
        observations.failure_capture_error = String(captureError);
      }
      throw error;
    } finally {
      if (probe) {
        const cleanup = await probe.restore();
        Object.assign(observations, cleanup);
        requireTrustedProbeCleanup(cleanup, scenarioError);
      }
    }
    assert.equal(observations.injected, 1);
    assert.equal(observations.restored, true);
    await browser.wait(
      async () => {
        const scan = await browser.findElements(button("Scan saved folders"));
        return scan.length === 1 && scan[0] !== undefined && (await scan[0].isEnabled());
      },
      5_000,
      "The released controlled scan must no longer block a new request",
    );
    assert.equal((await browser.findElements(button("Cancel scan"))).length, 0);
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[@role="alert" and contains(., "Controlled scan observation ended")]'),
      ),
      5_000,
    );
    await click(button("Refresh folders"));
    await browser.wait(
      async () => (await browser.findElements(By.css('[role="alert"]'))).length === 0,
      5_000,
    );
  } catch (error) {
    primaryError = error;
    observations.failure = errorMessage(error);
  } finally {
    observations.owned_cleanup = [];
    for (const [action, run] of [
      [
        "remove-owned-root",
        () => assert.equal(object(command(["source", "roots", "remove", root.id])).removed, true),
      ],
      [
        "roots-readback",
        () =>
          assert.deepEqual(
            transportValue("game_file_roots", command(["source", "roots", "list"])),
            rootsBefore,
          ),
      ],
      [
        "sources-readback",
        () =>
          assert.deepEqual(transportValues("source", command(["source", "list"])), sourcesBefore),
      ],
      [
        "status-readback",
        () =>
          assert.deepEqual(transportValue("status", command(["status", port.id])), statusBefore),
      ],
    ] as const) {
      try {
        run();
        observations.owned_cleanup.push({ action, attempted: true, completed: true });
      } catch (error) {
        cleanupError ??= error;
        observations.owned_cleanup.push({
          action,
          attempted: true,
          completed: false,
          error: errorMessage(error),
        });
      }
    }
    const report = path.join(output, "progressive-scan-navigation.json");
    try {
      await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
      artifacts.push(report);
    } catch (error) {
      cleanupError ??= error;
      console.error("Owned scan observation report failed:", errorMessage(error));
    }
  }
  if (primaryError) rethrowFailure(primaryError);
  if (cleanupError) rethrowFailure(cleanupError);
}

export async function sourceDialogScenario({
  browser,
  scenario,
  output,
  artifacts,
  command,
}: SourceDialogContext) {
  await scenario("native-source-intake-and-discovery-dialogs", async () => {
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const profileLabel = required(required(port.presentation).source_requirements[0]).label;
    const { button, click } = reviewControls(browser);

    await openCatalogPortAfterRefresh(browser, port);
    await revealDetailSection(browser, "Game files");
    const disclosure = await browser.findElement(By.css(".requirements-disclosure"));
    const detailsOpen = (element: Element) => {
      if (!(element instanceof HTMLDetailsElement))
        throw new Error("Expected requirements disclosure details element");
      return element.open;
    };
    if (!(await executeBrowserScript(browser, detailsOpen, disclosure))) {
      await click(By.css(".requirements-disclosure > .requirements-summary"));
    }
    assert.equal(await executeBrowserScript(browser, detailsOpen, disclosure), true);
    const intakeTrigger = await browser.findElement(button("Check game files"));
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center" });',
      intakeTrigger,
    );
    await click(button("Check game files"));
    const intakeDialog = By.css('[aria-labelledby="source-intake-title"]');
    await browser.wait(until.elementLocated(intakeDialog), 15_000);
    assert.ok(
      (await browser.findElement(intakeDialog).getText()).includes("Checking won't change them."),
    );
    const chooseFiles = await browser.findElement(button("Choose game files to check"));
    await browser.wait(until.elementIsEnabled(chooseFiles), 5_000);
    const intakeStyles = await assertPrimaryReviewAction(
      browser,
      chooseFiles,
      await browser.findElement(button("Close")),
    );
    await assertCompactReview(browser, '[aria-labelledby="source-intake-title"]');
    const intakeAccessibility = path.join(output, "source-intake-accessibility.json");
    await captureAccessibilityReport(browser, intakeAccessibility, artifacts);
    const intakeScreenshot = path.join(output, "native-source-intake-dialog.png");
    await writeFile(intakeScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(intakeScreenshot);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(async () => (await browser.findElements(intakeDialog)).length === 0, 5_000);
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          intakeTrigger,
        ),
      5_000,
      "Source intake trigger did not regain focus after Escape",
    );

    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await selectGameFilesSettings(browser);
    const discoveryTrigger = await browser.wait(
      until.elementLocated(button("Find required files")),
      15_000,
    );
    await executeBrowserScript(
      browser,
      'arguments[0].scrollIntoView({ block: "center" });',
      discoveryTrigger,
    );
    await click(button("Find required files"));
    const discoveryDialog = By.css('[aria-labelledby="source-discovery-title"]');
    await browser.wait(until.elementLocated(discoveryDialog), 15_000);
    assert.ok(
      (await browser.findElement(discoveryDialog).getText()).includes(
        "Portcove's game-file folder",
      ),
    );
    const searchField = await browser.findElement(By.id("source-search-root"));
    const searchLabel = await browser.findElement(By.css('label[for="source-search-root"]'));
    const fieldPresentation = await assertReviewFieldPresentation(
      browser,
      searchField,
      searchLabel,
      await browser.findElement(discoveryDialog),
    );
    const selectTrigger = await browser.findElement(
      By.xpath('//button[contains(., "Required files")]'),
    );
    await selectTrigger.sendKeys(Key.ENTER);
    const openSelect = By.css('[data-slot="select-content"][data-open]');
    await browser.wait(until.elementLocated(openSelect), 5_000);
    await selectTrigger.sendKeys(Key.ESCAPE);
    await browser.wait(
      async () => (await browser.findElements(openSelect)).length === 0,
      5_000,
      "First Escape did not close only the nested source-profile select",
    );
    assert.equal((await browser.findElements(discoveryDialog)).length, 1);
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          selectTrigger,
        ),
      5_000,
      "Source profile trigger did not regain focus after nested Escape",
    );
    await selectTrigger.sendKeys(Key.ENTER);
    await click(
      By.xpath(`//*[@role="option" and normalize-space(.)=${JSON.stringify(profileLabel)}]`),
    );

    const searchRoot = path.join(output, "owned-source-search");
    await mkdir(searchRoot, { recursive: true });
    await writeFile(path.join(searchRoot, "not-a-match.iso"), "owned unmatched source fixture", {
      flag: "wx",
    });
    await browser.findElement(By.id("source-search-root")).sendKeys(searchRoot);
    const searchFolder = await browser.findElement(button("Search this folder"));
    await browser.wait(until.elementIsEnabled(searchFolder), 5_000);
    const searchStyles = await assertPrimaryReviewAction(
      browser,
      searchFolder,
      await browser.findElement(button("Close")),
    );
    await click(button("Search this folder"));
    await browser.wait(
      until.elementLocated(By.xpath('//p[contains(., "Found no exact matches.")]')),
      15_000,
    );
    await assertCompactReview(browser, '[aria-labelledby="source-discovery-title"]');
    const discoveryAccessibility = path.join(output, "source-discovery-accessibility.json");
    await captureAccessibilityReport(browser, discoveryAccessibility, artifacts);
    const discoveryScreenshot = path.join(output, "native-source-discovery-dialog.png");
    await writeFile(discoveryScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(discoveryScreenshot);
    await browser.actions().sendKeys(Key.ESCAPE).perform();
    await browser.wait(
      async () => (await browser.findElements(discoveryDialog)).length === 0,
      5_000,
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          discoveryTrigger,
        ),
      5_000,
      "Source discovery trigger did not regain focus after Escape",
    );

    const activities = transportValue("activity", command(["activity"])).records;
    const sourceDiscovery = activities.find(
      (item) =>
        item.operation === "discover_sources" &&
        item.target_kind === "library" &&
        item.status === "succeeded",
    );
    assert.ok(sourceDiscovery, "Owned discovery search must record a library activity");
    const sourceRegistration = activities.find(
      (item) =>
        item.operation === "register_source" &&
        item.target_kind === "source" &&
        item.target_id === port.source_profile &&
        item.status === "succeeded",
    );
    assert.ok(sourceRegistration, "Owned setup must record this source registration");
    const sourceRegistrationIndex = activities.findIndex(
      (item) => item.id === sourceRegistration.id,
    );
    const sourceActivityInRecentPreview = sourceRegistrationIndex < 8;
    await click(By.xpath('//nav//button[contains(., "Activity")]'));
    await click(
      By.xpath(
        '//*[@role="tablist" and @aria-label="Activity sections"]//*[@role="tab" and normalize-space(.)="History"]',
      ),
    );
    const sourceActivity = By.xpath(
      `//div[contains(@class, "activity-row") and @data-activity-id=${JSON.stringify(sourceRegistration.id)}]//button[@aria-label=${JSON.stringify(`Open Game files settings for ${profileLabel}`)}]`,
    );
    await browser.wait(until.elementLocated(By.css(".activity-list")), 15_000);
    if (sourceActivityInRecentPreview)
      await browser.wait(until.elementLocated(sourceActivity), 15_000);
    assert.equal(
      (await browser.findElements(sourceActivity)).length,
      sourceActivityInRecentPreview ? 1 : 0,
      `source registration at history index ${sourceRegistrationIndex} must match the recent preview`,
    );
    if (sourceActivityInRecentPreview) {
      await click(sourceActivity);
      await browser.wait(until.elementLocated(By.id("settings-game-files-heading")), 5_000);
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (profileId) =>
              document.activeElement
                ?.closest("[data-source-profile]")
                ?.getAttribute("data-source-profile") === profileId &&
              document.activeElement?.textContent?.includes("Update file location"),
            port.source_profile,
          ),
        5_000,
        "Source activity did not focus its saved source control",
      );
      await browser.actions().sendKeys(Key.ARROW_DOWN).perform();
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => document.activeElement?.closest('[data-settings-group="game-files"]') !== null,
          ),
        5_000,
        "Directional navigation left Game files settings",
      );
      const settingsScreenshot = path.join(output, "native-source-activity-settings.png");
      await writeFile(settingsScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(settingsScreenshot);
    }

    await click(By.xpath('//nav//button[contains(., "Activity")]'));
    await click(
      By.xpath(
        '//*[@role="tablist" and @aria-label="Activity sections"]//*[@role="tab" and normalize-space(.)="History"]',
      ),
    );
    const discoveryActivity = By.xpath(
      `//div[contains(@class, "activity-row") and @data-activity-id=${JSON.stringify(sourceDiscovery.id)}]//button[@aria-label="Open Game files settings for Portcove library"]`,
    );
    await browser.wait(until.elementLocated(discoveryActivity), 15_000);
    await click(discoveryActivity);
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          () =>
            document.activeElement?.getAttribute("data-settings-control") === "discover-sources",
        ),
      5_000,
      "Library discovery activity did not focus game-file discovery",
    );
    const discoverySettingsScreenshot = path.join(output, "native-discovery-activity-settings.png");
    await writeFile(discoverySettingsScreenshot, await browser.takeScreenshot(), {
      encoding: "base64",
      flag: "wx",
    });
    artifacts.push(discoverySettingsScreenshot);

    await progressiveScanNavigation({ browser, output, artifacts, command, port, searchRoot });

    const report = path.join(output, "source-dialog-result.json");
    await writeFile(
      report,
      `${JSON.stringify(
        {
          port_id: port.id,
          profile_id: port.source_profile,
          profile_label: profileLabel,
          search_root: searchRoot,
          result: "no exact matches",
          nested_select_escape_preserved_dialog: true,
          intake_escape_restored_focus: true,
          discovery_escape_restored_focus: true,
          source_activity_history_index: sourceRegistrationIndex,
          source_activity_in_recent_preview: sourceActivityInRecentPreview,
          source_activity_opened_game_files_settings: sourceActivityInRecentPreview,
          source_activity_settings_control_focused: sourceActivityInRecentPreview,
          library_discovery_activity_opened_game_files_settings: true,
          library_discovery_settings_control_focused: true,
          directional_navigation_stayed_in_game_files: sourceActivityInRecentPreview,
          intake_action_styles: intakeStyles,
          search_action_styles: searchStyles,
          field_presentation: fieldPresentation,
          evidence:
            "owned unmatched file through the actual Tauri source-discovery adapter; no source registration, mutation, gameplay, or physical-storage claim",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}

function selectedSetupCommand({
  cli,
  library,
  output,
  fixture,
}: Pick<SelectedSetupContext, "cli" | "library" | "output" | "fixture">) {
  return ownedFixtureCommand({ cli, library, output, catalogPath: fixture.catalogPath });
}

// Fixture pre-state only: no native-picker or source-registration claim.
export function seedSelectedSetup(
  context: Pick<SelectedSetupContext, "cli" | "library" | "output" | "fixture">,
) {
  const command = selectedSetupCommand(context);
  assert.deepEqual(transportValues("source", command(["source", "list"])), []);
  assert.deepEqual(transportValue("game_file_roots", command(["source", "roots", "list"])), []);
  const owned = required(context.fixture.sourceJourney);
  const root = gameFileRoot(command(["source", "roots", "add", owned.directory]));
  if (context.fixture.hashResumeJourney) {
    const allowance = Math.max(
      readFileSync(owned.gameBefore).length,
      readFileSync(owned.biosBefore).length,
    );
    const initial = required(
      transportValue(
        "game_file_scan_snapshot",
        command(["source", "roots", "scan", "--max-hash-bytes", String(allowance)]),
      ),
    );
    assert.equal(required(initial.coverage).batches, 1);
    assert.equal(required(initial.coverage).can_resume, true);
    assert.equal(required(initial.coverage).restart_required, false);
    assert.ok(initial.report.limits_reached.includes("hash_bytes"));
    assert.equal(initial.report.candidates.length, 1);
    assert.ok(owned.profiles.includes(required(initial.report.candidates[0]).profile_id));
    context.fixture.hashResumeInitial = initial;
  }
  if (context.fixture.completionJourney) {
    const initial = required(
      transportValue(
        "game_file_scan_snapshot",
        command(["source", "roots", "scan", "--max-entries", "2"]),
      ),
    );
    assert.equal(required(initial.coverage).batches, 1);
    assert.equal(required(initial.coverage).can_resume, true);
    assert.equal(required(initial.coverage).restart_required, false);
    assert.equal(initial.report.entries_examined, 2);
    assert.ok(!initial.report.candidates.some((item) => item.profile_id === owned.profiles[0]));
  }
  assert.deepEqual(transportValues("source", command(["source", "list"])), []);
  return root;
}

// Same bounded Windows spelling equivalence used by the existing native fixtures.
export function assertOwnedSelectedSetupPath(actual: string, expected: string) {
  const normalize = (value: string) => {
    if (process.platform !== "win32") return path.resolve(value);
    const ordinary = value.startsWith("\\\\?\\UNC\\")
      ? "\\\\" + value.slice(8)
      : value.startsWith("\\\\?\\")
        ? value.slice(4)
        : value;
    return path.resolve(ordinary).toLowerCase();
  };
  assert.equal(normalize(actual), normalize(expected));
}

async function waitSelectedSetupCommit(browser: WebDriver, labels: string[]) {
  await browser.wait(
    async () => {
      const settled = await executeBrowserScript(
        browser,
        (labels) => {
          const section = document.querySelector('[aria-label="Continue to a game"]');
          const buttons = [...(section?.querySelectorAll("button") ?? [])];
          return (
            !document.querySelector('[aria-label="Source import review"]') &&
            buttons.length === labels.length &&
            buttons.every(
              (button) => !button.disabled && labels.includes(button.textContent.trim()),
            ) &&
            section?.contains(document.activeElement)
          );
        },
        labels,
      );
      return (
        settled &&
        (
          await browser.findElement(By.xpath('//button[normalize-space(.)="Refresh folders"]'))
        ).isEnabled()
      );
    },
    15_000,
    "Committed sources must finish workspace refresh and focus an enabled authoritative continuation",
  );
}

async function selectedSetupDetail(
  browser: WebDriver,
  port: Pick<PortDefinition, "name">,
  biosRegistered: boolean,
) {
  await browser.wait(until.elementLocated(By.id("port-detail-title")), 5_000);
  assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
  const state = await browser.findElement(By.css("[data-detail-readiness]")).getText();
  const reason = await browser.findElement(By.css("[data-detail-reason]")).getText();
  if (!biosRegistered) {
    assert.equal(state, "Required BIOS file needed");
    assert.ok(
      (
        await browser
          .findElement(By.css('[aria-label="Required game files and verification"]'))
          .getText()
      ).includes("Selected setup inert BIOS"),
    );
    assert.equal(
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Choose BIOS file"]'))
        .isEnabled(),
      true,
    );
    assert.equal(
      (await browser.findElements(By.xpath('//button[normalize-space(.)="Review installation"]')))
        .length,
      0,
    );
  } else {
    assert.equal(state, "Available to install");
    assert.equal(
      reason,
      "Portcove will check required game files and verify the release before it becomes active.",
    );
    // Requirements stay available in Game files after successful source registration.
    assert.equal(
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Review installation"]'))
        .isEnabled(),
      true,
    );
  }
  return { state, reason, bios_registered: biosRegistered };
}

// Preserve the original journey error even if read-only failure capture also fails.
async function recordSelectedSetupFailure(browser: WebDriver, report: SetupReport, error: unknown) {
  report.failure = String(error);
  report.failure_details = {
    checkpoint: report.checkpoint ?? "not recorded",
    name: isRecord(error) ? error.name : undefined,
    message: isRecord(error) ? error.message : undefined,
    stack: isRecord(error) ? error.stack : undefined,
  };
  try {
    report.failure_state = await executeBrowserScript(browser, () => ({
      candidates: [...document.querySelectorAll("[data-completed-candidate]")].map((row) => ({
        profile_id: row.getAttribute("data-profile-id"),
        controls: [...row.querySelectorAll("button")].map((button) => ({
          text: button.textContent.trim(),
          disabled: button.disabled,
          review: button.hasAttribute("data-candidate-review"),
        })),
      })),
      focus: document.activeElement?.getAttribute("aria-label") ?? null,
      viewport: { width: innerWidth, height: innerHeight },
    }));
  } catch (captureError) {
    report.failure_state_error = String(captureError);
  }
}

async function scanCoveragePresentation({
  browser,
  snapshot,
  output,
  artifacts,
}: Pick<SourceDialogContext, "browser" | "output" | "artifacts"> & {
  snapshot: GameFileScanSnapshot;
}) {
  const { button, click } = reviewControls(browser);
  let presentationFailure;
  let cleanupFailure;
  const observations: {
    scope: string;
    presentation?: unknown;
    failure?: string;
    reads?: number;
    scans?: number;
    limits?: unknown;
    restored?: boolean;
  } = {
    scope:
      "controlled completed-snapshot presentation in actual Tauri; not backend resume execution",
  };
  await executeBrowserScript(
    browser,
    (snapshot) => {
      const ownedWindow = window as OwnedWindow;
      const native = ownedWindow.__TAURI_INTERNALS__;
      if (!native || !snapshot.coverage)
        throw new Error("Owned scan coverage requires native IPC and completed coverage");
      const original = window.fetch;
      const readTarget = native.convertFileSrc("get_game_file_scan_snapshot", "ipc");
      const scanTarget = native.convertFileSrc("scan_game_file_roots", "ipc");
      const probe: CoverageProbe = {
        original,
        reads: 0,
        scans: 0,
        snapshot: {
          ...structuredClone(snapshot),
          coverage: {
            ...snapshot.coverage,
            batches: 2,
            can_resume: true,
            frontier_exhausted: false,
            remaining_entries: null,
            restart_required: false,
          },
        },
      };
      probe.snapshot.report.limits_reached = ["entries"];
      ownedWindow.__portcoveCoverageProbe = probe;
      window.fetch = function (input, ...args) {
        const url =
          typeof input === "string"
            ? input
            : input !== null && typeof input === "object" && "url" in input
              ? input.url
              : undefined;
        if (url !== readTarget && url !== scanTarget) return original.call(window, input, ...args);
        if (url === readTarget) probe.reads++;
        else {
          probe.scans++;
          const body = args[0]?.body;
          if (
            typeof body !== "string" &&
            !(body instanceof ArrayBuffer) &&
            !ArrayBuffer.isView(body)
          )
            throw new Error("Unexpected scan request body");
          const payload: unknown = JSON.parse(
            typeof body === "string" ? body : new TextDecoder().decode(body),
          );
          if (
            payload === null ||
            typeof payload !== "object" ||
            !("limits" in payload) ||
            !("onEvent" in payload) ||
            typeof payload.onEvent !== "string"
          )
            throw new Error("Unexpected scan Channel payload");
          probe.limits = payload.limits;
          if (!/^__CHANNEL__:\d+$/.test(payload.onEvent))
            throw new Error("Unexpected scan Channel");
          native.runCallback(Number(payload.onEvent.slice("__CHANNEL__:".length)), {
            index: 0,
            end: true,
          });
          Object.assign(probe.snapshot.coverage, {
            batches: 3,
            can_resume: false,
            frontier_exhausted: true,
            remaining_entries: 0,
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify(probe.snapshot), {
            headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
          }),
        );
      };
    },
    snapshot,
  );
  try {
    await click(button("Refresh folders"));
    const continueButton = await browser.wait(until.elementLocated(button("Continue scan")), 5_000);
    assert.equal(await continueButton.isEnabled(), true);
    const coverage = await browser.wait(
      until.elementLocated(
        By.xpath(
          '//section[@aria-label="Saved folder scan results"]//p[contains(., "These totals cover 2 scan batches.") and contains(., "The number of remaining entries is unknown.")]',
        ),
      ),
      5_000,
    );
    await executeBrowserScript(
      browser,
      (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
      coverage,
    );
    observations.presentation = await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          (element) => {
            const bounds = element.getBoundingClientRect().toJSON() as Rectangle;
            const style = getComputedStyle(element);
            if (
              !element.isConnected ||
              style.visibility !== "visible" ||
              Number(style.opacity) === 0 ||
              bounds.width <= 0 ||
              bounds.height <= 0 ||
              bounds.top < 0 ||
              bounds.bottom > innerHeight ||
              bounds.left < 0 ||
              bounds.right > document.documentElement.clientWidth ||
              element.getAnimations().some((animation) => animation.playState === "running")
            )
              return null;
            return {
              text: element.textContent.trim(),
              bounds,
              viewport: { width: innerWidth, height: innerHeight },
            };
          },
          coverage,
        ),
      5_000,
      "Coverage copy must be settled and framed",
    );
    const screenshot = path.join(output, "selected-setup-scan-coverage.png");
    await writeFile(screenshot, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
    artifacts.push(screenshot);
    await click(button("Continue scan"));
    await browser.wait(
      until.elementLocated(
        By.xpath('//p[contains(., "Skipped files and search limits still apply.")]'),
      ),
      5_000,
    );
    await browser.wait(until.elementLocated(button("Scan saved folders")), 5_000);
    await executeBrowserScript(browser, () => {
      const probe = (window as OwnedWindow).__portcoveCoverageProbe;
      if (!probe) throw new Error("Owned coverage probe is unavailable");
      probe.snapshot.freshness = "inputs_changed";
      Object.assign(probe.snapshot.coverage, {
        restart_required: true,
        frontier_exhausted: false,
      });
    });
    await click(button("Refresh folders"));
    assert.equal(
      await (await browser.wait(until.elementLocated(button("Start new scan")), 5_000)).isEnabled(),
      true,
    );
  } catch (error) {
    presentationFailure = error;
    observations.failure = String(error);
  } finally {
    try {
      Object.assign(
        observations,
        await executeBrowserScript(browser, () => {
          const probe = (window as OwnedWindow).__portcoveCoverageProbe;
          if (!probe) throw new Error("Owned coverage probe is unavailable");
          window.fetch = probe.original;
          return {
            reads: probe.reads,
            scans: probe.scans,
            limits: probe.limits,
            restored: window.fetch === probe.original,
          };
        }),
      );
      const report = path.join(output, "selected-setup-scan-coverage.json");
      await writeFile(report, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
      artifacts.push(report);
    } catch (error) {
      cleanupFailure = error;
      console.error(JSON.stringify({ observations, cleanup_failure: String(error) }));
    }
  }
  if (presentationFailure) rethrowFailure(presentationFailure);
  if (cleanupFailure) rethrowFailure(cleanupFailure);
  assert.equal(observations.scans, 1);
  assert.deepEqual(observations.limits, snapshot.limits);
  assert.equal(observations.restored, true);
  await click(button("Refresh folders"));
  await browser.wait(until.elementLocated(button("Scan saved folders")), 5_000);
}

async function preliminarySourceReviewScenario(context: SelectedSetupContext) {
  const { browser, invoke, scenario, library, output, artifacts, cli, fixture } = context;
  await scenario("native-preliminary-source-review", async () => {
    const owned = fixture.preliminaryJourney;
    assert.ok(owned, "Only the standalone selection supplies the inert disc fixture");
    const command = selectedSetupCommand({ cli, library, output, fixture });
    let generation: number;
    const { button, click } = reviewControls(browser);
    const before = await readFile(owned.before);
    const expectedHash = createHash("sha256").update(before).digest("hex");
    const report: SetupReport = {
      scope: "inert first-party disc selection; actual Core scan and deliberate review/cancel only",
      observations: {},
    };
    const artifact = path.join(output, "preliminary-source-review.json");
    try {
      generation = await selectedSetupGeneration(invoke);
      const sourcesBefore = transportValues("source", command(["source", "list"]));
      assert.deepEqual(sourcesBefore, []);
      const previousOperations = new Set(
        transportValue("activity", command(["activity"])).records.map((record) => record.id),
      );
      await click(
        By.xpath(
          '//nav[@aria-label="Primary navigation"]//button[./span[normalize-space(.)="Settings"]]',
        ),
      );
      await selectGameFilesSettings(browser);
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      await browser.wait(
        async () => (await browser.findElement(button("Scan saved folders"))).isEnabled(),
        5_000,
      );
      await click(button("Scan saved folders"));
      await browser.wait(
        async () =>
          transportValue("activity", command(["activity"])).records.some(
            (record) =>
              record.operation === "discover_sources" &&
              record.status === "succeeded" &&
              !previousOperations.has(record.id),
          ),
        15_000,
      );
      const response = object(await invoke("get_game_file_scan_snapshot", { generation }));
      assert.equal(response.ok, true);
      const snapshot = required(transportValue("game_file_scan_snapshot", response.value));
      const selection = required(snapshot.report.preliminary_selections).find(
        (item) => item.profile_id === owned.profile,
      );
      assert.ok(
        selection,
        "The completed real Core scan must discover the selected validator profile",
      );
      assert.equal(required(selection.validator).result, "not_run");
      assert.equal(selection.assessment.admission.mode, "structural_checks");
      assert.equal(selection.assessment.classification.state, "not_evaluated");
      assert.equal(selection.assessment.contract.state, "not_evaluated");
      assert.equal(required(selection.record).sha256, expectedHash);
      assert.deepEqual(transportValues("source", command(["source", "list"])), sourcesBefore);
      report.observations.scan = snapshot;
      const catalog: unknown = JSON.parse(await readFile(fixture.catalogPath, "utf8"));
      const label = sourceProfileLabel(catalog, owned.profile);
      assert.ok(!label.includes('"'), "The fixed catalog label must fit this exact XPath literal");
      const row = await browser.wait(
        until.elementLocated(
          By.xpath(
            `//section[@aria-label="Preliminary game-file selections"]//div[strong[normalize-space(.)="${label}"]]`,
          ),
        ),
        5_000,
      );
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
        row,
      );
      assert.match(await row.getText(), /Validation has not run\./);
      const reviewButton = await row.findElement(
        By.xpath('.//button[normalize-space(.)="Review preliminary selection"]'),
      );
      assert.equal(await reviewButton.isEnabled(), true);
      const resultScreenshot = path.join(output, "preliminary-selection.png");
      await writeFile(resultScreenshot, await browser.takeScreenshot(), "base64");
      artifacts.push(resultScreenshot);
      await clickVisible(browser, reviewButton);
      const review = await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      const reviewText = await review.getText();
      assert.match(reviewText, /validation.*not.*run|not.*validated|structural/i);
      report.observations.review_text = reviewText;
      await captureAccessibilityReport(
        browser,
        path.join(output, "preliminary-review-accessibility.json"),
        artifacts,
      );
      const reviewScreenshot = path.join(output, "preliminary-review.png");
      await writeFile(reviewScreenshot, await browser.takeScreenshot(), "base64");
      artifacts.push(reviewScreenshot);
      await clickVisible(
        browser,
        await review.findElement(By.xpath('.//button[normalize-space(.)="Cancel review"]')),
      );
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-label="Source import review"]'))).length === 0,
        5_000,
      );
      assert.deepEqual(transportValues("source", command(["source", "list"])), sourcesBefore);
      assert.deepEqual(await readFile(owned.path), before);
      assert.equal(fixture.requests.length, 0, "Review/cancel must not fetch the install fixture");
      report.observations.registration_unchanged = true;
      report.observations.input_unchanged = true;
      report.observations.no_setup_acquisition = true;
    } catch (error) {
      await recordSelectedSetupFailure(browser, report, error);
      throw error;
    } finally {
      await writeFile(artifact, JSON.stringify(report, null, 2), { flag: "wx" });
      artifacts.push(artifact);
    }
  });
}

async function preliminarySelectedSetupScenario(context: SelectedSetupContext) {
  const { browser, invoke, scenario, library, output, artifacts, cli, fixture } = context;
  await scenario("native-preliminary-selected-setup", async () => {
    const owned = fixture.preliminaryJourney;
    assert.ok(owned && fixture.preliminarySetupJourney);
    const command = selectedSetupCommand({ cli, library, output, fixture });
    const { button, click } = reviewControls(browser);
    let read: ReturnType<typeof selectedSetupRead>;
    const enabled = async (locator: Parameters<WebDriver["findElements"]>[0]) =>
      browser.wait(async () => {
        const matches = await browser.findElements(locator);
        return matches.length === 1 && matches[0] !== undefined && (await matches[0].isEnabled())
          ? matches[0]
          : false;
      }, 15_000);
    const screenshot = async (name: string) => {
      const file = path.join(output, `${name}.png`);
      await writeFile(file, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(file);
      await captureAccessibilityReport(
        browser,
        path.join(output, `${name}-accessibility.json`),
        artifacts,
      );
    };
    const before = await readFile(owned.before);
    const expectedHash = createHash("sha256").update(before).digest("hex");
    const report: SetupReport = {
      scope:
        "Inert Windows development fixture: actual discovery, deliberate NotRun registration, bounded selection, fresh Core setup review and cancellation; no validator, preparation or gameplay execution.",
      observations: {},
    };
    const artifact = path.join(output, "preliminary-selected-setup.json");
    try {
      read = selectedSetupRead(invoke, await selectedSetupGeneration(invoke));
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      await click(
        By.xpath(
          '//nav[@aria-label="Primary navigation"]//button[./span[normalize-space(.)="Settings"]]',
        ),
      );
      await selectGameFilesSettings(browser);
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      await enabled(button("Scan saved folders"));
      const activities = new Set(
        transportValue("activity", command(["activity"])).records.map((item) => item.id),
      );
      await click(button("Scan saved folders"));
      await browser.wait(
        () =>
          transportValue("activity", command(["activity"])).records.some(
            (item) =>
              item.operation === "discover_sources" &&
              item.status === "succeeded" &&
              !activities.has(item.id),
          ),
        15_000,
      );
      const snapshot = await read("get_game_file_scan_snapshot");
      const selection = required(snapshot.report.preliminary_selections).find(
        (item) => item.profile_id === owned.profile,
      );
      assert.ok(selection);
      assert.equal(required(selection.validator).result, "not_run");
      assert.equal(selection.assessment.admission.mode, "structural_checks");
      assert.equal(selection.assessment.classification.state, "not_evaluated");
      assert.equal(selection.assessment.contract.state, "not_evaluated");
      assert.equal(required(selection.record).sha256, expectedHash);
      report.observations.scan = snapshot;
      const rowLocator = By.css(`[data-preliminary-selection][data-profile-id="${owned.profile}"]`);
      const row = await browser.wait(until.elementLocated(rowLocator), 5_000);
      assert.match(await row.getText(), /Validation has not run\./);
      assert.equal(
        (await browser.findElements(By.css(`input[data-setup-review-port="${fixture.port.id}"]`)))
          .length,
        0,
      );
      const opener = await row.findElement(By.css("[data-candidate-review]"));
      await clickVisible(browser, opener);
      const sourceReview = await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      const sourceText = await sourceReview.getText();
      assert.match(sourceText, /validation.*not.*run|not.*validated|structural/i);
      assertOwnedSelectedSetupPath(
        await sourceReview.findElement(By.css("code")).getText(),
        owned.path,
      );
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      report.observations.source_review_text = sourceText;
      await screenshot("preliminary-registration-review");
      await click(button("Cancel review"));
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-label="Source import review"]'))).length === 0,
        5_000,
      );
      const returnedOpener = await (
        await browser.findElement(rowLocator)
      ).findElement(By.css("[data-candidate-review]"));
      assert.equal(await returnedOpener.isEnabled(), true);
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element) => document.activeElement === element,
            returnedOpener,
          ),
        5_000,
      );
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      report.observations.neutral_source_cancel_restored_opener_focus = true;
      await clickVisible(browser, returnedOpener);
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      await click(button("Use current location"));
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-label="Source import review"]'))).length === 0,
        15_000,
      );
      const checkboxLocator = By.css(`input[data-setup-review-port="${fixture.port.id}"]`);
      const checkbox = await enabled(checkboxLocator);
      assert.ok(checkbox);
      const registered = await read("get_sources");
      assert.deepEqual(registered, transportValues("source", command(["source", "list"])));
      assert.equal(registered.length, 1);
      assert.equal(required(registered[0]).profile_id, owned.profile);
      assert.equal(required(registered[0]).sha256, expectedHash);
      assertOwnedSelectedSetupPath(required(registered[0]).path, owned.path);
      assert.equal(
        required(required(required(registered[0]).observed_identity).validator).result,
        "not_run",
      );
      const statuses = await read("get_statuses");
      const status = statuses.find((item) => item.port_id === fixture.port.id);
      assert.deepEqual(status, transportValue("status", command(["status", fixture.port.id])));
      assert.equal(status.active, null);
      assert.ok(
        required(status.port_actions).some(
          (item) => item.action === "install" && item.availability === "allowed",
        ),
      );
      const queue = await browser.findElement(By.css('[aria-label="Selected setup reviews"]'));
      assert.match(await queue.getText(), /Validation has not run for a selected input/);
      report.observations.registered = registered;
      report.observations.status = status;
      await clickVisible(browser, checkbox);
      assert.match(await queue.getText(), /1 of 16 ports selected/);
      assert.deepEqual(await read("get_statuses"), statuses);
      await screenshot("preliminary-selected-queue");
      await click(button(`Review ${fixture.port.name} setup`));
      const installLocator = By.css('[aria-labelledby="install-review-title"]');
      const review = await browser.wait(until.elementLocated(installLocator), 15_000);
      assert.equal(
        await browser.findElement(By.id("port-detail-title")).getText(),
        fixture.port.name,
      );
      const plan = await read("plan_port", { portId: fixture.port.id, channel: "stable" });
      const corePlan = transportValue("install_plan", command(["plan", fixture.port.id]));
      const { storage: nativeStorage, ...nativePlan } = plan;
      const { storage: cliStorage, ...cliPlan } = corePlan;
      assert.deepEqual(nativePlan, cliPlan);
      for (const storage of [nativeStorage, cliStorage]) {
        assertOwnedSelectedSetupPath(storage.library_root, library);
        assert.ok(
          Number.isSafeInteger(storage.volume_total_bytes) && storage.volume_total_bytes > 0,
        );
        assert.ok(
          Number.isSafeInteger(storage.volume_available_bytes) &&
            storage.volume_available_bytes > 0,
        );
        assert.ok(storage.volume_available_bytes <= storage.volume_total_bytes);
      }
      assert.equal(plan.port_id, fixture.port.id);
      assert.equal(plan.source_requirements.length, 1);
      assert.equal(required(plan.source_requirements[0]).profile_id, owned.profile);
      assert.equal(required(plan.source_requirements[0]).registered, true);
      const reviewText = await review.getText();
      assert.ok(reviewText.includes(plan.release.version));
      assert.equal(plan.action, "download");
      assertOwnedSelectedSetupPath(
        await review.findElement(By.css(".install-plan-destination code")).getText(),
        plan.output_location.effective_output_directory,
      );
      assert.match(
        await review
          .findElement(By.xpath('.//button[starts-with(normalize-space(.),"Install ·")]'))
          .getText(),
        /^Install ·/,
      );
      report.observations.setup_plan = plan;
      report.observations.independent_cli_plan = corePlan;
      report.observations.setup_review_text = reviewText;
      assert.deepEqual(await read("get_statuses"), statuses);
      await screenshot("preliminary-setup-review");
      // Axe cannot determine the runtime tab trap for aria-hidden background
      // controls and Base UI focus guards. Observe actual native keyboard focus.
      const keyboardFocus = [];
      const installControl = await review.findElement(
        By.xpath('.//button[starts-with(normalize-space(.),"Install ·")]'),
      );
      const cancelControl = await review.findElement(
        By.xpath('.//button[normalize-space(.)="Cancel review"]'),
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element) => document.activeElement === element,
            installControl,
          ),
        5_000,
      );
      report.observations.initial_keyboard_focus = await executeBrowserScript(browser, () => ({
        document_focused: document.hasFocus(),
        active_html: document.activeElement?.outerHTML?.slice(0, 1200),
      }));
      for (const reverse of [false, true]) {
        for (let index = 0; index < 8; index += 1) {
          await executeBrowserScript(browser, () => {
            const ownedWindow = window as OwnedWindow;
            if (ownedWindow.__portcove244FocusTrace) throw new Error("Focus trace already owned");
            const events: FocusEventObservation[] = [];
            const dialog = document.querySelector('[aria-labelledby="install-review-title"]');
            const guards = [dialog?.previousElementSibling, dialog?.nextElementSibling];
            if (
              !guards.every(
                (guard): guard is HTMLElement =>
                  guard instanceof HTMLElement &&
                  guard.matches(
                    'span[data-base-ui-focus-guard][data-type="inside"][aria-hidden="true"]',
                  ) &&
                  guard.tabIndex === 0,
              )
            )
              throw new Error("The setup popup must have its two associated inside focus guards");
            const capture = (event: Event) => {
              const target = event.target;
              events.push({
                type: event.type,
                key: event instanceof KeyboardEvent ? event.key : undefined,
                shift: event instanceof KeyboardEvent ? event.shiftKey : undefined,
                inside: !!dialog && target instanceof Node && dialog.contains(target),
                guard: target instanceof HTMLElement && guards.includes(target),
                html: target instanceof Element ? target.outerHTML.slice(0, 1200) : undefined,
                document_focused: document.hasFocus(),
              });
            };
            document.addEventListener("focusin", capture, true);
            document.addEventListener("keydown", capture, true);
            ownedWindow.__portcove244FocusTrace = {
              events,
              guards: guards.map((guard) => guard.outerHTML),
              close() {
                document.removeEventListener("focusin", capture, true);
                document.removeEventListener("keydown", capture, true);
              },
            };
          });
          const keys = browser.actions();
          if (reverse) keys.keyDown(Key.SHIFT);
          keys.sendKeys(Key.TAB);
          if (reverse) keys.keyUp(Key.SHIFT);
          await keys.perform();
          await browser.executeAsyncScript((done: () => void) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          const focus = await executeBrowserScript(browser, () => {
            const trace = (window as OwnedWindow).__portcove244FocusTrace;
            if (!trace) throw new Error("Owned focus trace is unavailable");
            const dialog = document.querySelector('[aria-labelledby="install-review-title"]');
            const active = document.activeElement;
            return {
              inside: !!dialog && dialog.contains(active),
              label: active?.textContent?.trim(),
              disabled:
                active !== null && "disabled" in active && typeof active.disabled === "boolean"
                  ? active.disabled
                  : false,
              html: active?.outerHTML?.slice(0, 1200),
              document_focused: document.hasFocus(),
              events: trace.events,
              guards: trace.guards,
            };
          });
          await executeBrowserScript(browser, () => {
            const ownedWindow = window as OwnedWindow;
            const trace = ownedWindow.__portcove244FocusTrace;
            if (!trace) throw new Error("Owned focus trace is unavailable");
            trace.close();
            delete ownedWindow.__portcove244FocusTrace;
          });
          keyboardFocus.push({ reverse, index, ...focus });
          report.observations.native_keyboard_focus = keyboardFocus;
          assert.ok(
            focus.events.every((event) => event.inside || event.guard),
            "Native keyboard focus must not enter background controls",
          );
          assert.equal(focus.inside, true, "Native Tab must stay in the topmost setup review");
          assert.equal(focus.disabled, false);
          assert.ok(focus.label === "Cancel review" || focus.label?.startsWith("Install ·"));
          const expectedControl = index % 2 === 0 ? cancelControl : installControl;
          assert.equal(
            await executeBrowserScript(
              browser,
              (element) => document.activeElement === element,
              expectedControl,
            ),
            true,
            "Every native Tab must alternate between the two enabled review controls",
          );
        }
      }
      report.observations.native_keyboard_focus = keyboardFocus;
      await click(button("Cancel review"));
      await browser.wait(
        async () => (await browser.findElements(installLocator)).length === 0,
        5_000,
      );
      const setupOpener = await enabled(button("Review installation"));
      assert.ok(setupOpener);
      assert.equal(await setupOpener.isDisplayed(), true);
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element) => document.activeElement === element,
            setupOpener,
          ),
        5_000,
      );
      report.observations.neutral_setup_cancel_restored_opener_focus = true;
      await click(By.css("[data-detail-back]"));
      const returned = await enabled(checkboxLocator);
      assert.ok(returned);
      assert.equal(await returned.isSelected(), true);
      await enabled(button(`Review ${fixture.port.name} setup`));
      await browser.wait(
        () =>
          executeBrowserScript(browser, () => {
            const owner = document.querySelector(
              '[data-detail-origin="game-file-libraries-setup"]',
            );
            return !!owner && owner.contains(document.activeElement);
          }),
        5_000,
      );
      assert.deepEqual(await read("get_statuses"), statuses);
      assert.deepEqual(transportValues("source", command(["source", "list"])), registered);
      assert.deepEqual(await readFile(owned.path), before);
      assert.equal(fixture.requests.length, 0);
      report.observations.original_unchanged = true;
      report.observations.no_acquisition_or_installation = true;
      report.observations.returned_selection = true;
      report.observations.returned_owner_focus = true;
      report.checkpoint = "completed";
    } catch (error) {
      await recordSelectedSetupFailure(browser, report, error);
      throw error;
    } finally {
      await writeFile(artifact, JSON.stringify(report, null, 2), { flag: "wx" });
      artifacts.push(artifact);
    }
  });
}

async function hashResumeScenario(context: SelectedSetupContext) {
  const { browser, invoke, scenario, library, output, artifacts, cli, fixture } = context;
  await scenario("native-saved-folder-hash-resume", async () => {
    const owned = required(fixture.sourceJourney);
    assert.ok(fixture.hashResumeJourney && fixture.hashResumeInitial);
    assertOwnedSelectedSetupPath(required(owned.root).path, owned.directory);
    const command = selectedSetupCommand({ cli, library, output, fixture });
    const { button, click } = reviewControls(browser);
    let nativeRead: ReturnType<typeof selectedSetupRead>;
    const report: SetupReport = {
      scope: "Actual saved hash-batch continuation and fresh source review/cancel",
      limitations: [
        "Inert owned Windows development inputs; no gameplay, installed package, physical storage or Linux proof",
        "Root and initial batch seeded by first-party CLI; native picker not exercised",
        "No registration, installation or preparation authorized",
      ],
      observations: {},
    };
    const artifact = path.join(output, "saved-folder-hash-resume.json");
    const capture = async (name: string) => {
      const screenshot = path.join(output, `${name}.png`);
      await writeFile(screenshot, await browser.takeScreenshot(), "base64");
      artifacts.push(screenshot);
      await captureAccessibilityReport(
        browser,
        path.join(output, `${name}-accessibility.json`),
        artifacts,
      );
    };
    try {
      nativeRead = selectedSetupRead(invoke, await selectedSetupGeneration(invoke));
      report.checkpoint = "initial persisted batch";
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      await click(
        By.xpath(
          '//nav[@aria-label="Primary navigation"]//button[./span[normalize-space(.)="Settings"]]',
        ),
      );
      await selectGameFilesSettings(browser);
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      await browser.wait(async () => {
        const controls = await browser.findElements(button("Continue scan"));
        return (
          controls.length === 1 && controls[0] !== undefined && (await controls[0].isEnabled())
        );
      }, 5_000);
      const initial = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(initial.freshness, "inputs_match");
      assert.deepEqual(initial.report, fixture.hashResumeInitial.report);
      assert.deepEqual(initial.limits, fixture.hashResumeInitial.limits);
      assert.equal(required(initial.coverage).can_resume, true);
      const presentation = await browser
        .findElement(By.css('[aria-label="Saved folder scan results"]'))
        .getText();
      assert.match(presentation, /Continue the scan to check the next batch/);
      report.observations.initial = initial;
      await capture("hash-batch-initial");
      const previous = new Set(
        transportValue("activity", command(["activity"])).records.map((record) => record.id),
      );
      report.checkpoint = "keyboard continuation";
      const continueButton = await browser.findElement(button("Continue scan"));
      await executeBrowserScript(
        browser,
        (element) => {
          if (!(element instanceof HTMLElement))
            throw new Error("Expected focusable scan continuation");
          element.focus();
        },
        continueButton,
      );
      await continueButton.sendKeys(Key.SPACE);
      await browser.wait(
        async () =>
          transportValue("activity", command(["activity"])).records.some(
            (record) =>
              record.operation === "discover_sources" &&
              record.status === "succeeded" &&
              !previous.has(record.id),
          ),
        15_000,
      );
      await browser.wait(async () => {
        const controls = await browser.findElements(button("Scan saved folders"));
        return (
          controls.length === 1 && controls[0] !== undefined && (await controls[0].isEnabled())
        );
      }, 5_000);
      const continued = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(continued.freshness, "inputs_match");
      assert.equal(required(continued.coverage).batches, 2);
      assert.equal(required(continued.coverage).can_resume, false);
      assert.equal(required(continued.coverage).frontier_exhausted, true);
      assert.deepEqual(continued.limits, initial.limits);
      assert.ok(continued.report.hash_bytes > required(continued.limits).max_hash_bytes);
      assert.equal(continued.report.hash_bytes, owned.game.length + owned.bios.length);
      assert.equal(continued.report.files_hashed, 2);
      assert.deepEqual(
        continued.report.candidates.find(
          (item) => item.profile_id === required(initial.report.candidates[0]).profile_id,
        ),
        initial.report.candidates[0],
      );
      assert.deepEqual(
        continued.report.candidates.map((item) => item.profile_id).sort(),
        [...owned.profiles].sort(),
      );
      const newlyDiscovered = continued.report.candidates.find(
        (item) => item.profile_id !== required(initial.report.candidates[0]).profile_id,
      );
      assert.ok(newlyDiscovered);
      report.observations.continued = continued;
      await capture("hash-batch-complete");
      report.checkpoint = "fresh review and neutral cancel";
      const candidate = await browser.wait(
        until.elementLocated(
          By.css(`[data-completed-candidate][data-profile-id="${newlyDiscovered.profile_id}"]`),
        ),
        5_000,
      );
      const reviewButton = await candidate.findElement(By.css("[data-candidate-review]"));
      await clickVisible(browser, reviewButton);
      const review = await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15_000,
      );
      report.observations.review_text = await review.getText();
      const plan = await nativeRead("plan_source_import", {
        profileId: newlyDiscovered.profile_id,
        path: newlyDiscovered.path,
        mode: "use_current_location",
      });
      assert.equal(plan.profile_id, newlyDiscovered.profile_id);
      assertOwnedSelectedSetupPath(plan.source.path, newlyDiscovered.path);
      assert.equal(plan.source.sha256, newlyDiscovered.sha256);
      assert.equal(plan.mode, "use_current_location");
      assert.equal(plan.admission_mode, "exact_identity");
      const expectedLabel =
        newlyDiscovered.profile_id === owned.profiles[0]
          ? "Selected setup inert game"
          : "Selected setup inert BIOS";
      assert.ok(report.observations.review_text.includes(`File requirement: ${expectedLabel}`));
      assert.ok(report.observations.review_text.includes("Use current location"));
      assert.ok(report.observations.review_text.includes("Source check: Exact identity."));
      const displayedPath = await review
        .findElement(By.xpath('.//p[contains(.,"Selected location:")]/code'))
        .getText();
      assertOwnedSelectedSetupPath(displayedPath, plan.source.path);
      report.observations.fresh_plan = plan;
      await capture("hash-batch-review");
      await clickVisible(
        browser,
        await review.findElement(By.xpath('.//button[normalize-space(.)="Cancel review"]')),
      );
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-label="Source import review"]'))).length === 0,
        5_000,
      );
      assert.equal(
        await executeBrowserScript(
          browser,
          (element) => document.activeElement === element,
          reviewButton,
        ),
        true,
      );
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      assert.deepEqual(await readFile(owned.gamePath), await readFile(owned.gameBefore));
      assert.deepEqual(await readFile(owned.biosPath), await readFile(owned.biosBefore));
      assert.equal(fixture.requests.length, 0);
      report.observations.originals_unchanged = true;
      report.observations.registration_unchanged = true;
      report.observations.no_acquisition = true;
      report.checkpoint = "completed";
    } catch (error) {
      await recordSelectedSetupFailure(browser, report, error);
      throw error;
    } finally {
      await writeFile(artifact, JSON.stringify(report, null, 2), { flag: "wx" });
      artifacts.push(artifact);
    }
  });
}

export async function selectedSetupScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  fixture,
}: SelectedSetupContext) {
  if (fixture?.preliminarySetupJourney)
    return preliminarySelectedSetupScenario({
      browser,
      invoke,
      scenario,
      library,
      output,
      artifacts,
      cli,
      fixture,
    });
  if (fixture?.hashResumeJourney)
    return hashResumeScenario({
      browser,
      invoke,
      scenario,
      library,
      output,
      artifacts,
      cli,
      fixture,
    });
  if (fixture?.preliminaryJourney)
    return preliminarySourceReviewScenario({
      browser,
      invoke,
      scenario,
      library,
      output,
      artifacts,
      cli,
      fixture,
    });
  await scenario("native-saved-folder-selected-setup", async () => {
    assert.ok(fixture?.sourceJourney, "Only the exact opt-in selection supplies these identities");
    const owned = required(fixture.sourceJourney);
    assertOwnedSelectedSetupPath(required(owned.root).path, owned.directory);
    const command = selectedSetupCommand({ cli, library, output, fixture });
    const expectedGameSha256 = createHash("sha256")
      .update(await readFile(owned.gameBefore))
      .digest("hex");
    const expectedReplacementSha256 = createHash("sha256")
      .update(await readFile(owned.gameReplacement))
      .digest("hex");
    const expectedBiosSha256 = createHash("sha256")
      .update(await readFile(owned.biosBefore))
      .digest("hex");
    const { button, click } = reviewControls(browser);
    let nativeRead: ReturnType<typeof selectedSetupRead>;
    const report: SetupReport = {
      scope: "real saved-root scan and UI guarded registration; uninstalled requirements only",
      limitations: [
        "Saved root seeded by first-party CLI; native picker not exercised",
        "No installation, preparation, launch or runtime qualification",
        "Uninstalled status is NotChecked; missing path inspected separately",
      ],
      port_ids: [fixture.port.id, fixture.refreshPort.id],
      seeded_saved_root: required(owned.root),
      observations: {},
    };
    const review = By.css('[aria-label="Source import review"]');
    const row = (profile: string) =>
      By.css(`[data-completed-candidate][data-profile-id="${profile}"]`);
    const reviewCandidate = async (profile: string) => {
      const candidate = await browser.wait(until.elementLocated(row(profile)), 15_000);
      await clickVisible(browser, await candidate.findElement(By.css("[data-candidate-review]")));
      await browser.wait(until.elementLocated(review), 15_000);
    };
    const plan = (profileId: string, sourcePath: string) =>
      nativeRead("plan_source_import", {
        profileId,
        path: sourcePath,
        mode: "use_current_location",
      });
    const scan = async () => {
      const completedBefore = new Set(
        transportValue("activity", command(["activity"]))
          .records.filter(
            (item) => item.operation === "discover_sources" && item.status === "succeeded",
          )
          .map((item) => item.id),
      );
      await click(button("Scan saved folders"));
      await browser.wait(
        () =>
          selectedSetupScanCompleted(
            () => browser.findElement(button("Scan saved folders")).isEnabled(),
            () => transportValue("activity", command(["activity"])).records,
            completedBefore,
          ),
        15_000,
        "The UI scan must produce a new completed Core activity, not reuse a prior snapshot",
      );
      const snapshot = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(snapshot.freshness, "inputs_match");
      assert.deepEqual(
        snapshot.report.candidates.map((item) => item.profile_id).sort(),
        [...owned.profiles].sort(),
      );
      return snapshot;
    };
    let rootMoved = false;
    let journeyFailure: { error: unknown } | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    let artifactFailure: { error: unknown } | undefined;
    const missingRoot = `${owned.directory}-unavailable`;
    try {
      nativeRead = selectedSetupRead(invoke, await selectedSetupGeneration(invoke));
      assert.deepEqual(transportValues("source", command(["source", "list"])), []);
      await click(
        By.xpath(
          '//nav[@aria-label="Primary navigation"]//button[./span[normalize-space(.)="Settings"]]',
        ),
      );
      await selectGameFilesSettings(browser);
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      report.observations.initial_scan = await scan();
      assert.deepEqual(
        transportValues("source", command(["source", "list"])),
        [],
        "Discovery must never register sources",
      );
      const sourceRow = await browser.findElement(row(owned.profiles[1]));
      const associationText = `Catalog ports using this profile: ${transportValues(
        "port",
        command(["catalog", "list"]),
      )
        .filter((port) => port.bios_source_profile === owned.profiles[1])
        .map((port) => port.name)
        .join(", ")}`;
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
        sourceRow,
      );
      report.observations.source_metadata_presentation = required(
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              (element, expectedAssociation) => {
                const spans = [...element.querySelectorAll("span")];
                const size = spans.find((span) => span.textContent.trim() === "37 B");
                const association = spans.find(
                  (span) => span.textContent.trim() === expectedAssociation,
                );
                if (!size || !association) return null;
                const clipping = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
                for (
                  let ancestor: Element | null = element;
                  ancestor;
                  ancestor = ancestor.parentElement
                ) {
                  const style = getComputedStyle(ancestor);
                  if (
                    style.display === "none" ||
                    style.visibility !== "visible" ||
                    Number(style.opacity) === 0 ||
                    ancestor.getAnimations().some((animation) => animation.playState === "running")
                  )
                    return null;
                  const bounds = ancestor.getBoundingClientRect();
                  if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
                    clipping.left = Math.max(clipping.left, bounds.left + ancestor.clientLeft);
                    clipping.right = Math.min(
                      clipping.right,
                      bounds.left + ancestor.clientLeft + ancestor.clientWidth,
                    );
                  }
                  if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
                    clipping.top = Math.max(clipping.top, bounds.top + ancestor.clientTop);
                    clipping.bottom = Math.min(
                      clipping.bottom,
                      bounds.top + ancestor.clientTop + ancestor.clientHeight,
                    );
                  }
                }
                const textRects = (span: Element) => {
                  const range = document.createRange();
                  range.selectNodeContents(span);
                  return [...range.getClientRects()].map((rect) => rect.toJSON() as Rectangle);
                };
                const sizeRects = textRects(size);
                const associationRects = textRects(association);
                const framed = (rect: Rectangle) =>
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.left >= clipping.left &&
                  rect.top >= clipping.top &&
                  rect.right <= clipping.right &&
                  rect.bottom <= clipping.bottom;
                if (
                  !sizeRects.length ||
                  !associationRects.length ||
                  ![...sizeRects, ...associationRects].every(framed) ||
                  Math.min(...associationRects.map((rect) => rect.top)) <
                    Math.max(...sizeRects.map((rect) => rect.bottom))
                )
                  return null;
                return {
                  size: size.textContent.trim(),
                  association: association.textContent.trim(),
                  size_rects: sizeRects,
                  association_rects: associationRects,
                  clipping,
                  viewport: {
                    width: innerWidth,
                    height: innerHeight,
                    device_scale: devicePixelRatio,
                  },
                };
              },
              sourceRow,
              associationText,
            ),
          5_000,
          "The settled source size and Catalog association must be fully framed on separate lines",
        ),
      );
      report.observations.source_metadata_presentation.window = await browser
        .manage()
        .window()
        .getRect();
      const metadataScreenshot = path.join(output, "selected-setup-source-metadata.png");
      await writeFile(metadataScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(metadataScreenshot);
      await reviewCandidate(owned.profiles[0]);
      assertOwnedSelectedSetupPath(
        await browser.findElement(review).findElement(By.css("code")).getText(),
        owned.gamePath,
      );
      const reviewedA = await plan(owned.profiles[0], owned.gamePath);
      assert.match(reviewedA.plan_sha256, /^[a-f0-9]{64}$/);
      assert.equal(reviewedA.source.sha256, expectedGameSha256);
      assertOwnedSelectedSetupPath(reviewedA.source.path, owned.gamePath);
      assert.deepEqual(
        transportValues("source", command(["source", "list"])),
        [],
        "Review must remain non-mutating",
      );
      await writeFile(owned.gamePath, owned.replacement);
      const freshB = await plan(owned.profiles[0], owned.gamePath);
      assert.notEqual(freshB.plan_sha256, reviewedA.plan_sha256);
      assert.notEqual(freshB.source.sha256, reviewedA.source.sha256);
      assert.equal(freshB.source.sha256, expectedReplacementSha256);
      assert.equal(freshB.source.path, reviewedA.source.path);
      report.observations.changed_input = { reviewed_a: reviewedA, admitted_b: freshB };
      const reviewedInputs = path.join(output, "selected-setup-reviewed-inputs.json");
      await writeFile(
        reviewedInputs,
        `${JSON.stringify(report.observations.changed_input, null, 2)}\n`,
        { flag: "wx" },
      );
      artifacts.push(reviewedInputs);
      await click(button("Use current location"));
      const refusal = By.xpath(
        '//p[@role="alert" and normalize-space(.)="The selection changed or another operation is using it. Review its current state."]',
      );
      await browser.wait(until.elementLocated(refusal), 15_000);
      report.observations.changed_input = {
        reviewed_a: reviewedA,
        admitted_b: freshB,
        refusal: await browser.findElement(refusal).getText(),
        activities: transportValue("activity", command(["activity"])).records,
      };
      const failedImport = required(report.observations.changed_input.activities).find(
        (item) =>
          item.operation === "import_source" &&
          item.target_id === owned.profiles[0] &&
          item.status === "failed",
      );
      assert.equal(failedImport?.failure?.code, "conflict");
      assert.ok(failedImport.failure.message.includes("changed after review"));
      report.observations.changed_input.failed_import = failedImport;
      assert.deepEqual(
        transportValues("source", command(["source", "list"])),
        [],
        "Stale consent must not publish a registration",
      );
      await click(button("Cancel review"));
      await writeFile(owned.gamePath, owned.game);
      report.observations.rescan = await scan();
      await reviewCandidate(owned.profiles[0]);
      report.observations.new_a_review = await plan(owned.profiles[0], owned.gamePath);
      await click(button("Use current location"));
      const continuation = By.css('[aria-label="Continue to a game"]');
      await waitSelectedSetupCommit(
        browser,
        [fixture.port, fixture.refreshPort].map((port) => `Open ${port.name} details`),
      );
      const registeredGame = transportValues("source", command(["source", "list"]));
      assert.equal(registeredGame.length, 1);
      assert.equal(required(registeredGame[0]).profile_id, owned.profiles[0]);
      assert.equal(required(registeredGame[0]).path, reviewedA.source.path);
      assert.equal(required(registeredGame[0]).sha256, reviewedA.source.sha256);
      const expectedButtons = [fixture.port, fixture.refreshPort]
        .map((port) => `Open ${port.name} details`)
        .sort();
      const actualButtons = await Promise.all(
        (await browser.findElement(continuation).findElements(By.css("button"))).map((element) =>
          element.getText(),
        ),
      );
      assert.deepEqual(
        actualButtons.sort(),
        expectedButtons,
        "Shared game identity must preserve both distinct port choices",
      );
      report.observations.game_registered = registeredGame;
      await executeBrowserScript(
        browser,
        'arguments[0].scrollIntoView({ block: "center" });',
        await browser.findElement(continuation),
      );
      report.observations.continuation_geometry = await executeBrowserScript(browser, () => {
        const section = document.querySelector('[aria-label="Continue to a game"]');
        if (!section) throw new Error("Committed continuation section is unavailable");
        const bounds = section.getBoundingClientRect();
        return {
          text: section.textContent.trim(),
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          viewport: { width: innerWidth, height: innerHeight },
        };
      });
      const committedScreenshot = path.join(output, "selected-setup-game-registered.png");
      await writeFile(committedScreenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(committedScreenshot);
      report.observations.missing_bios_status = transportValue(
        "status",
        command(["status", fixture.refreshPort.id]),
      );
      assert.ok(
        required(report.observations.missing_bios_status.readiness).blockers.includes(
          "missing_bios",
        ),
      );
      report.observations.missing_bios_plan = transportValue(
        "install_plan",
        command(["plan", fixture.refreshPort.id]),
      );
      assert.equal(
        required(
          report.observations.missing_bios_plan.source_requirements.find(
            (item) => item.role === "bios",
          ),
        ).registered,
        false,
      );
      for (const port of [fixture.port, fixture.refreshPort]) {
        await click(button(`Open ${port.name} details`));
        await browser.wait(until.elementLocated(By.css("[data-detail-back]")), 5_000);
        assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
        if (port === fixture.refreshPort)
          report.observations.missing_bios_detail = await selectedSetupDetail(browser, port, false);
        await click(By.css("[data-detail-back]"));
        await browser.wait(until.elementLocated(continuation), 5_000);
      }
      await reviewCandidate(owned.profiles[1]);
      assertOwnedSelectedSetupPath(
        await browser.findElement(review).findElement(By.css("code")).getText(),
        owned.biosPath,
      );
      const reviewedBios = await plan(owned.profiles[1], owned.biosPath);
      assertOwnedSelectedSetupPath(reviewedBios.source.path, owned.biosPath);
      assert.equal(reviewedBios.source.sha256, expectedBiosSha256);
      report.observations.bios_review = reviewedBios;
      assert.equal(
        transportValues("source", command(["source", "list"])).length,
        1,
        "BIOS review must not commit it",
      );
      await click(button("Use current location"));
      await waitSelectedSetupCommit(browser, [`Open ${fixture.refreshPort.name} details`]);
      assert.equal(transportValues("source", command(["source", "list"])).length, 2);
      const registered = transportValues("source", command(["source", "list"]));
      for (const [profile, sourcePath, expectedHash] of [
        [owned.profiles[0], reviewedA.source.path, expectedGameSha256],
        [owned.profiles[1], reviewedBios.source.path, expectedBiosSha256],
      ]) {
        const source = registered.find((item) => item.profile_id === profile);
        assert.equal(source?.path, sourcePath);
        assert.equal(required(source).sha256, expectedHash);
      }
      report.observations.committed_registrations = registered;
      const statuses = await nativeRead("get_statuses");
      report.observations.authoritative_ports = [fixture.port, fixture.refreshPort].map((port) => {
        const status = transportValue("status", command(["status", port.id]));
        assert.deepEqual(
          status,
          statuses.find((item) => item.port_id === port.id),
        );
        assert.equal(status.active, null);
        assert.equal(required(status.readiness).launchable, false);
        assert.equal(required(status.readiness).source, "not_checked");
        assert.ok(!required(status.readiness).blockers.includes("missing_source"));
        if (port === fixture.refreshPort) {
          assert.equal(required(status.readiness).bios, "not_checked");
          assert.ok(!required(status.readiness).blockers.includes("missing_bios"));
        }
        const installPlan = transportValue("install_plan", command(["plan", port.id]));
        assert.ok(installPlan.source_requirements.every((item) => item.registered));
        assert.deepEqual(
          installPlan.source_requirements.map((item) => item.profile_id).sort(),
          (port === fixture.refreshPort ? owned.profiles : [owned.profiles[0]]).slice().sort(),
        );
        return { status, install_plan: installPlan };
      });
      await click(button(`Open ${fixture.refreshPort.name} details`));
      report.observations.registered_bios_detail = await selectedSetupDetail(
        browser,
        fixture.refreshPort,
        true,
      );
      report.checkpoint = "registered-bios-return-control";
      await click(By.css("[data-detail-back]"));
      report.checkpoint = "registered-bios-return-continuation";
      await browser.wait(
        until.elementLocated(continuation),
        5_000,
        "Selected setup: return continuation after registered BIOS details",
      );
      report.checkpoint = "controlled-coverage-presentation";
      const registrationsBeforeCoverage = transportValues("source", command(["source", "list"]));
      await scanCoveragePresentation({
        browser,
        snapshot: await nativeRead("get_game_file_scan_snapshot"),
        output,
        artifacts,
      });
      assert.deepEqual(
        transportValues("source", command(["source", "list"])),
        registrationsBeforeCoverage,
      );
      report.checkpoint = "unavailable-root-refresh";
      await rename(owned.directory, missingRoot);
      rootMoved = true;
      await click(button("Refresh folders"));
      report.checkpoint = "unavailable-root-disabled-review";
      await waitForDisabledSourceReview(browser, () => row(owned.profiles[0]));
      report.checkpoint = "unavailable-root-observations";
      const snapshot = await nativeRead("get_game_file_scan_snapshot");
      assert.equal(snapshot.freshness, "inputs_changed");
      const roots = transportValue("game_file_roots", command(["source", "roots", "list"]));
      const savedRoot = roots.find((item) => item.id === required(owned.root).id);
      assertOwnedSelectedSetupPath(required(savedRoot).path, owned.directory);
      assert.equal(required(savedRoot).availability, "unavailable");
      assert.deepEqual(transportValues("source", command(["source", "list"])), registered);
      const inspection = transportValue(
        "source_inspection",
        command(["source", "inspect", owned.profiles[0]]),
      );
      assert.equal(inspection.health, "missing");
      for (const profile of owned.profiles)
        assert.equal(
          await browser
            .findElement(row(profile))
            .findElement(By.css("[data-candidate-review]"))
            .isEnabled(),
          false,
        );
      report.observations.unavailable = {
        roots,
        snapshot,
        inspection,
        registrations: transportValues("source", command(["source", "list"])),
        controls: await executeBrowserScript(browser, () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>("[data-completed-candidate] button"),
          ].map((button) => ({
            text: button.textContent.trim(),
            disabled: button.disabled,
          })),
        ),
      };
      assert.ok(report.observations.unavailable.controls.every((item) => item.disabled));
      report.observations.unavailable.scan_enabled = await browser
        .findElement(button("Scan saved folders"))
        .isEnabled();
      assert.equal(await browser.findElement(button("Refresh folders")).isEnabled(), true);
      const screenshot = path.join(output, "selected-setup-unavailable.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      report.observations.viewport = await executeBrowserScript(browser, () => ({
        width: innerWidth,
        height: innerHeight,
      }));
      report.observations.window = await browser.manage().window().getRect();
      assert.equal(
        fixture.requests.length,
        0,
        "Read-only plans must not acquire or install the inert package",
      );
    } catch (error) {
      journeyFailure = { error };
      await recordSelectedSetupFailure(browser, report, error);
    } finally {
      try {
        if (rootMoved) await rename(missingRoot, owned.directory);
        await writeFile(owned.gamePath, owned.game);
        assert.deepEqual(await readFile(owned.gamePath), await readFile(owned.gameBefore));
        assert.deepEqual(await readFile(owned.biosPath), await readFile(owned.biosBefore));
        report.original_inputs_restored = true;
      } catch (error) {
        cleanupFailure = { error };
        report.cleanup_failure = String(error);
      }
      const artifact = path.join(output, "selected-setup-journey.json");
      try {
        await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        artifacts.push(artifact);
      } catch (error) {
        // Retain both observations in the harness log if its artifact cannot be written.
        console.error(JSON.stringify({ report, artifact_write_failure: String(error) }));
        artifactFailure = { error };
      }
    }
    // Cleanup/report failures must not replace the original journey error.
    if (journeyFailure) rethrowFailure(journeyFailure.error);
    if (cleanupFailure) rethrowFailure(cleanupFailure.error);
    if (artifactFailure) rethrowFailure(artifactFailure.error);
  });
}
