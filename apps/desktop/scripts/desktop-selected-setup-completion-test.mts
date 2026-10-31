import { captureNativeEnlargement } from "./native-enlargement.mts";
import { fixtureObject as object } from "./desktop-scenario-state.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { gameIdentityLabel } from "../src/port-identity.ts";
import {
  captureSettledVisual,
  observePreparationCompletion,
} from "../../../scripts/native-readiness.mts";
// Actual Tauri/Core journey; synthetic source and first-party probe, never a game qualification.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import {
  assertOwnedSelectedSetupPath,
  selectedSetupGeneration,
} from "./desktop-source-dialog-test.mts";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
  selectPrimaryNavigation,
  selectGameFilesSettings,
} from "./desktop-review-controls.mts";

import {
  observeCompletionResultFocus,
  observeCompletionReturnFocus,
} from "./desktop-completion-focus.mts";

import type { WebDriver } from "selenium-webdriver";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import type { nativeGameFileFolderPicker } from "./desktop-native-confirmation.mts";
import type { PreparationObservation } from "../../../scripts/native-readiness.mts";
import type {
  ActivityFeed,
  ActivityRecord,
  ActivityOperation,
  ActivityStatus,
  PortStatus,
  LaunchReadiness,
  SourceRecord,
  GameFileRoot,
  GameFileScanSnapshot,
  InstallPlan,
} from "../src/transport-types.generated.d.ts";
import { transportValue, transportValues } from "./transport-values.mts";
type Picker = ReturnType<typeof nativeGameFileFolderPicker>;
type PickerResult = Awaited<ReturnType<Picker>>;
interface CompletionContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  cli: string;
  fixture: Awaited<ReturnType<typeof createInstallFixture>> & { nativeConnectionJourney?: boolean };
  restartApplication: (name: string) => Promise<WebDriver>;
  chooseGameFileFolder?: Picker | undefined;
}
type CompletionStatus = PortStatus & { readiness: LaunchReadiness };
type PreparedActivity = Exclude<
  Awaited<ReturnType<typeof observePreparationCompletion<CompletionStatus>>>,
  false
>["activity"];
type CompletionCapture = Awaited<
  ReturnType<
    typeof captureSettledVisual<
      ReturnType<typeof observeVisibleTarget>,
      { ready: boolean; phase: string }
    >
  >
>;
interface CompletionObservations {
  sources: SourceRecord[] | undefined;
  completed_sources?: unknown;
  geometry?: Record<string, CompletionCapture["observation"]>;
  folder_picker_cancel?: PickerResult;
  folder_picker_add?: PickerResult;
  folder_picker_second?: PickerResult;
  folder_picker_relink?: PickerResult;
  connected_folders?: {
    first: GameFileRoot;
    second: GameFileRoot;
    relinked: GameFileRoot;
    remaining: GameFileRoot[];
  };
  initial_bounded_scan?: GameFileScanSnapshot;
  continued_scan?: GameFileScanSnapshot;
  setup_selection?: string[];
  plan?: InstallPlan;
  controller_review?: Record<string, unknown>;
  cancelled?: { activity: ActivityRecord; status: PortStatus };
  installed?: { activity: ActivityRecord; status: PortStatus };
  preparation_wait?: PreparationObservation & { requested_at: string };
  prepared?: { activity: PreparedActivity; status: PortStatus };
  result_focus?:
    | false
    | { tag: string; id: string; text: string | undefined; ariaLabel: string | null };
  return_focus?: ReturnType<typeof observeCompletionReturnFocus>;
  returned_choices?: string[];
  returned_alternative_review?: {
    status: PortStatus;
    snapshot: GameFileScanSnapshot;
    review_enabled: boolean;
  };
  source_result_accessibility?: { rule: string; unresolved: number };
  bios_only_scan?: { snapshot: GameFileScanSnapshot; activity: ActivityRecord };
  bios_completed_review?: { sources: SourceRecord[]; plan: InstallPlan; statuses: PortStatus[] };
  bios_return_focus?: ReturnType<typeof observeCompletionReturnFocus>;
  bios_settled_return?: {
    snapshot: GameFileScanSnapshot;
    review_enabled: boolean;
    selected_count: number;
  };
  bios_restart?: {
    roots: GameFileRoot[];
    sources: SourceRecord[];
    snapshot: GameFileScanSnapshot;
    status: PortStatus;
    plan: InstallPlan;
    selection_restored: boolean;
  };
}
interface CompletionReport extends CompletionReportDiagnostics {
  scope: string;
  limitations: string[];
  port_id: string;
  observations: CompletionObservations;
  failure?: { message: string; stack: string | undefined };
  original_inputs_preserved?: boolean;
  preservation_failure?: string;
}
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined, "Required completion observation missing");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

export interface CompletionParityObservations {
  sources: unknown;
  completed_sources?: unknown;
}
export async function assertCompletionCoreParity({
  read,
  core,
  portId,
  prepared,
  observations,
}: {
  read: (command: "get_sources") => Promise<unknown>;
  core: (args: string[]) => unknown;
  portId: string;
  prepared: unknown;
  observations: CompletionParityObservations;
}) {
  // Installation reinspects the source; retain both snapshots and compare the current record.
  observations.completed_sources = await read("get_sources");
  assert.ok(Array.isArray(observations.sources) && observations.sources.length > 0);
  assert.ok(Array.isArray(observations.completed_sources));
  assert.equal(observations.completed_sources.length, observations.sources.length);
  assert.deepEqual(core(["status", portId]), prepared);
  assert.deepEqual(core(["source", "list"]), observations.completed_sources);
}

export interface CompletionReportDiagnostics {
  artifact_write_failure?: string;
  fallback_log_failure?: string;
  enlargement_cleanup_failure?: string;
  enlargement_capture_failure?: string;
}
export async function retainCompletionReport<T extends object>(options: {
  file: string;
  report: T & CompletionReportDiagnostics;
  artifacts: string[];
  // Presence represents a failed journey, including an explicit undefined throw.
  failure?: unknown;
  write?: (file: string, bytes: string, options: { flag: "wx" }) => Promise<unknown>;
  log?: (message: string) => unknown;
}) {
  const { file, report, artifacts, write = writeFile, log = console.error } = options;
  let artifactFailure: { error: unknown } | undefined;
  try {
    await write(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    artifacts.push(file);
  } catch (error) {
    artifactFailure = { error };
    report.artifact_write_failure = String(error);
    try {
      log(JSON.stringify({ report, artifact_write_failure: String(error) }));
    } catch (logError) {
      report.fallback_log_failure = String(logError);
    }
  }
  // Artifact or fallback failures never replace the original journey error.
  if (Object.hasOwn(options, "failure")) throw options.failure;
  if (artifactFailure) throw artifactFailure.error;
}

export async function selectedSetupCompletionScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  fixture,
  restartApplication,
  chooseGameFileFolder,
}: CompletionContext) {
  await scenario("native-selected-setup-completion", async () => {
    assert.equal(fixture?.completionJourney, true);
    assert.equal(typeof restartApplication, "function");
    const owned = required(fixture.sourceJourney);
    const reviewPort = required(owned.reviewPort);
    const port = fixture.port;
    const setupOrigin = "add-games-folders-setup";
    const setupHeading = "add-games-folders-heading";
    let generation: number;
    const { button, click } = reviewControls(browser);
    const coreEnvironment = {
      ...process.env,
      PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
      PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
    };
    const coreArguments = ["--library", library, "--json", "--non-interactive"];
    const requireSuccess = (value: unknown, payload: "data" | "value", details: string) => {
      const envelope = object(value);
      assert.equal(envelope.ok, true, details);
      return envelope[payload];
    };
    const core = (args: readonly string[]) => {
      const execution = spawnCommand(cli, coreArguments.concat(args), {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: coreEnvironment,
      });
      assert.equal(execution.error, undefined);
      assert.equal(execution.status, 0, execution.stderr || execution.stdout);
      const value: unknown = JSON.parse(execution.stdout);
      return requireSuccess(value, "data", execution.stderr);
    };
    function read(name: "get_sources", args?: Record<string, unknown>): Promise<SourceRecord[]>;
    function read(name: "get_statuses", args?: Record<string, unknown>): Promise<PortStatus[]>;
    function read(name: "get_activities", args?: Record<string, unknown>): Promise<ActivityFeed>;
    function read(
      name: "get_game_file_roots",
      args?: Record<string, unknown>,
    ): Promise<GameFileRoot[]>;
    function read(
      name: "get_game_file_scan_snapshot",
      args?: Record<string, unknown>,
    ): Promise<GameFileScanSnapshot | null>;
    function read(name: "plan_port", args?: Record<string, unknown>): Promise<InstallPlan>;
    async function read(
      name:
        | "get_sources"
        | "get_statuses"
        | "get_activities"
        | "get_game_file_roots"
        | "get_game_file_scan_snapshot"
        | "plan_port",
      args?: Record<string, unknown>,
    ) {
      const envelope = object(
        await invoke(
          name,
          name === "get_game_file_roots" || name === "get_game_file_scan_snapshot"
            ? { ...args, generation }
            : args,
        ),
      );
      const value = requireSuccess(envelope, "value", JSON.stringify(envelope.error));
      switch (name) {
        case "get_sources":
          return transportValues("source", value);
        case "get_statuses":
          return transportValues("status", value);
        case "get_activities":
          return transportValue("activity", value);
        case "get_game_file_roots":
          return transportValue("desktop_game_file_roots", value);
        case "get_game_file_scan_snapshot":
          return transportValue("desktop_game_file_scan_snapshot", value);
        case "plan_port":
          return transportValue("install_plan", value);
      }
    }
    const status = async () =>
      required((await read("get_statuses")).find((item) => item.port_id === port.id));
    const activity = async (operation: ActivityOperation, terminal: ActivityStatus) =>
      (await read("get_activities")).records.find(
        (item) =>
          item.operation === operation && item.target_id === port.id && item.status === terminal,
      );
    const screenshot = async (name: string) => {
      const targets: Readonly<Record<string, string>> = {
        "initial-folder-connection": '[aria-label="Connect your game files"]',
        "connected-folder-management": "#game-file-libraries-heading",
        "selected-setup-prepared": "[data-detail-workspace]",
        "selected-setup-queue-return": '[aria-label="Selected setup reviews"]',
        "selected-setup-bios-queue-return": '[aria-label="Selected setup reviews"]',
        "selected-setup-bios-settled-return": '[aria-label="Selected setup reviews"]',
      };
      const target = targets[name] ?? '[aria-labelledby="install-review-title"]';
      const enlargedTargets: Readonly<Record<string, string>> = {
        "initial-folder-connection": '[aria-label="Connect your game files"] h2',
        "connected-folder-management": "#game-file-libraries-heading",
        "selected-setup-prepared": '[data-task-owner] > [data-slot="current-state-summary"] h3',
        "selected-setup-queue-return": '[aria-label="Selected setup reviews"] > h3',
        "selected-setup-bios-queue-return": '[aria-label="Selected setup reviews"] > h3',
        "selected-setup-bios-settled-return": '[aria-label="Selected setup reviews"] > h3',
      };
      // Full panels deliberately scroll at 400%. Capture an identified bounded
      // heading; retain the full-panel readiness and complete-target validator.
      const captureTarget = enlargedTargets[name] ?? "#install-review-title";
      const preparedTarget = await prepareCaptureTarget({
        target: captureTarget,
        label: `400% ${name} heading`,
        scroll: () =>
          executeBrowserScript(
            browser,
            (selector) => {
              document
                .querySelector(selector)
                ?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            },
            captureTarget,
          ),
        observe: () =>
          executeBrowserScript(browser, observeVisibleTarget, captureTarget, "visual" as const),
      });
      const capture = await captureSettledVisual({
        browser,
        output,
        name,
        scenario: "native-selected-setup-completion",
        target: captureTarget,
        observeTarget: async () => {
          const state = await executeBrowserScript(
            browser,
            observeVisibleTarget,
            captureTarget,
            "visual" as const,
          );
          requireUnchangedCaptureTarget(preparedTarget.observation, state);
          return state;
        },
        readiness: () =>
          executeBrowserScript(
            browser,
            (phase, selector) => {
              const node = document.querySelector(selector);
              const controls = [...(node?.querySelectorAll("button") ?? [])];
              const enabled = (label: string) =>
                controls.some(
                  (control) => (control.textContent ?? "").trim() === label && !control.disabled,
                );
              const ready =
                phase === "initial-folder-connection"
                  ? controls.some((control) => !control.disabled)
                  : phase === "connected-folder-management"
                    ? Boolean(
                        node && !document.querySelector('[aria-label="Source import review"]'),
                      )
                    : phase === "selected-setup-prepared"
                      ? enabled("Try launch")
                      : phase.includes("queue-return") || phase.includes("settled-return")
                        ? Boolean(
                            node &&
                            !document.querySelector(
                              '[aria-labelledby="install-review-title"], [aria-labelledby="preparation-review-title"]',
                            ),
                          )
                        : enabled("Cancel review") &&
                          Boolean(document.querySelector("#install-review-title"));
              return { ready, phase };
            },
            name,
            target,
          ),
      });
      artifacts.push(capture.image.path, capture.receipt);
      (report.observations.geometry ??= {})[name] = capture.observation;
    };
    const report: CompletionReport = {
      scope: `${process.platform} synthetic selected setup: ordinary install, inert N64 preparation, BIOS-plus-game review and saved-input restart`,
      limitations: [
        fixture.nativeConnectionJourney
          ? "Folder connections use the actual native picker; the bounded scan pre-state uses the CLI"
          : "Saved root seeded by the existing CLI; native picker credited separately",
        "No real game, BIOS preparation, gameplay, full representation matrix or other platform qualification",
        "400% viewport captures target identified headings; scrollable full panels are exercised through their controls, not claimed wholly visible",
      ],
      port_id: port.id,
      observations: { sources: undefined },
    };
    let failure: { error: unknown } | undefined;
    let originalWindow: { x: number; y: number; width: number; height: number } | undefined;
    let zoomAttempted = false;
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = (key: string) =>
      browser.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    let enlargedJourney = false;
    let baselineWidth = 0;
    const enlargedStage = async (stage: string) => {
      if (!enlargedJourney) return;
      artifacts.push(
        await captureNativeEnlargement(browser, {
          output,
          prefix: "selected-setup",
          stage,
          baselineWidth,
          artifacts,
        }),
      );
    };
    try {
      generation = await selectedSetupGeneration(invoke);
      originalWindow = await browser.manage().window().getRect();
      await browser.manage().window().setRect({ width: 960, height: 640 });
      zoomAttempted = true;
      await shortcut("0");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () => localStorage.getItem("portcove.appearance.interface-size") === "100",
          ),
        10_000,
      );
      const baseline = await executeBrowserScript(browser, () => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        theme: document.documentElement.dataset.theme,
        userAgent: navigator.userAgent,
      }));
      baselineWidth = baseline.width;
      const baselineFile = path.join(output, "selected-setup-100-baseline.json");
      await writeFile(baselineFile, JSON.stringify(baseline, null, 2), { flag: "wx" });
      artifacts.push(baselineFile);
      // Retain the actual viewport if even the first enlargement attempt fails.
      enlargedJourney = true;
      for (let step = 0; step < 7; step++) await shortcut("+");
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (width) =>
              localStorage.getItem("portcove.appearance.interface-size") === "400" &&
              Math.abs(innerWidth - width / 4) <= 2,
            baselineWidth,
          ),
        10_000,
      );
      await enlargedStage("folder-connection");
      assert.deepEqual(await read("get_sources"), []);
      assert.equal((await status()).active, null, "No adopted installation may seed completion");

      async function connectSetupFolderWithNativePicker() {
        assert.ok(typeof chooseGameFileFolder === "function");
        assert.deepEqual(await read("get_game_file_roots"), []);
        const connection = By.css('[aria-label="Connect your game files"] button');
        await browser.wait(until.elementLocated(connection), 5_000);
        await screenshot("initial-folder-connection");
        await click(connection);
        await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
        await browser.wait(
          async () =>
            executeBrowserScript(
              browser,
              () =>
                document.activeElement?.getAttribute("data-settings-control") ===
                "add-game-file-root",
            ),
          5_000,
        );
        await click(button("Add folder"));
        report.observations.folder_picker_cancel =
          await chooseGameFileFolder("game-file-picker-cancel");
        assert.equal(object(report.observations.folder_picker_cancel).cancelled, true);
        assert.deepEqual(await read("get_game_file_roots"), []);
        assert.deepEqual(await read("get_sources"), []);
        await browser.wait(
          until.elementIsEnabled(await browser.findElement(button("Add folder"))),
          5_000,
        );
        await click(button("Add folder"));
        report.observations.folder_picker_add = await chooseGameFileFolder(
          "game-file-picker-add",
          owned.directory,
        );
        await browser.wait(async () => (await read("get_game_file_roots")).length === 1, 5_000);
        const first = required((await read("get_game_file_roots"))[0]);
        assertOwnedSelectedSetupPath(first.path, owned.directory);
        const extra = path.join(output, "connected-folder-extra");
        const replacement = path.join(output, "connected-folder-replacement");
        for (const directory of [extra, replacement]) {
          await mkdir(directory);
          await writeFile(path.join(directory, "keep.txt"), "owned connection sentinel", {
            flag: "wx",
          });
        }
        await browser.wait(
          until.elementIsEnabled(await browser.findElement(button("Add folder"))),
          5_000,
        );
        await click(button("Add folder"));
        report.observations.folder_picker_second = await chooseGameFileFolder(
          "game-file-picker-second",
          extra,
        );
        await browser.wait(async () => (await read("get_game_file_roots")).length === 2, 5_000);
        const second = required(
          (await read("get_game_file_roots")).find((root) => root.id !== first.id),
        );
        assertOwnedSelectedSetupPath(second.path, extra);
        const rootAction = (name: string) =>
          By.xpath(
            `//*[@data-game-file-root="${second.id}"]//button[normalize-space(.)="${name}"]`,
          );
        await click(rootAction("Relink"));
        report.observations.folder_picker_relink = await chooseGameFileFolder(
          "game-file-picker-relink",
          replacement,
        );
        await browser.wait(async () => {
          const roots = await read("get_game_file_roots");
          return (
            roots.length === 2 && roots.find((root) => root.id === second.id)?.path !== second.path
          );
        }, 5_000);
        const relinked = required(
          (await read("get_game_file_roots")).find((root) => root.id === second.id),
        );
        assertOwnedSelectedSetupPath(relinked.path, replacement);
        assert.deepEqual(
          (await read("get_game_file_roots")).find((root) => root.id === first.id),
          first,
        );
        await click(rootAction("Remove"));
        assert.equal((await read("get_game_file_roots")).length, 2);
        await click(rootAction("Keep folder"));
        assert.equal((await read("get_game_file_roots")).length, 2);
        await click(rootAction("Remove"));
        await click(rootAction("Remove saved folder"));
        await browser.wait(async () => (await read("get_game_file_roots")).length === 1, 5_000);
        assert.deepEqual(await read("get_game_file_roots"), [first]);
        for (const directory of [extra, replacement])
          assert.equal(
            await readFile(path.join(directory, "keep.txt"), "utf8"),
            "owned connection sentinel",
          );
        assert.deepEqual(await read("get_sources"), []);
        report.observations.connected_folders = {
          first,
          second,
          relinked,
          remaining: await read("get_game_file_roots"),
        };
        // Preserve the existing two-entry progressive scan assertions after native connection.
        const initial = required(
          transportValue(
            "game_file_scan_snapshot",
            core(["source", "roots", "scan", "--max-entries", "2"]),
          ),
        );
        assert.equal(required(initial.coverage).batches, 1);
        assert.equal(required(initial.coverage).can_resume, true);
        await screenshot("connected-folder-management");
      }
      if (fixture.nativeConnectionJourney) {
        await connectSetupFolderWithNativePicker();
      }
      {
        await selectPrimaryNavigation(browser, "Library");
        await click(button("Add games"));
        await browser.wait(
          until.elementLocated(By.xpath('//h1[normalize-space(.)="Add games"]')),
          5_000,
        );
        await enlargedStage("choose-inputs");
        await click(By.css('button[aria-label="Choose a game or port"]'));
        const query = await browser.findElement(By.id("port-search"));
        await query.sendKeys(port.name);
        await browser.wait(until.elementLocated(By.css('[role="option"]')), 5_000);
        const options = await browser.findElements(By.css('[role="option"]'));
        const projectDescription = `Port project: ${port.name} · ${port.id}`;
        const descriptions = await Promise.all(options.map((option) => option.getText()));
        assert.equal(
          descriptions.filter((text) => text.split(/\r?\n/u).includes(projectDescription)).length,
          1,
        );
        async function highlightExactSetupProject() {
          let highlightedExactPort = false;
          for (let index = 0; index <= options.length; index++) {
            await query.sendKeys(Key.ARROW_DOWN);
            const activeId = await query.getAttribute("aria-activedescendant");
            if (!activeId) continue;
            const active = await browser.findElement(By.id(activeId));
            if ((await active.getText()).split(/\r?\n/u).includes(projectDescription)) {
              highlightedExactPort = true;
              break;
            }
          }
          assert.equal(
            highlightedExactPort,
            true,
            "Keyboard selection must highlight the exact stable port project",
          );
        }
        await highlightExactSetupProject();
        await query.sendKeys(Key.ENTER);
        await browser.wait(
          async () => (await query.getAttribute("aria-expanded")) === "false",
          5_000,
        );
        assert.equal(await query.getAttribute("value"), gameIdentityLabel(port));
        // Reopen to observe the committed ID through the selected option, rather
        // than inferring identity from a possibly duplicated display title.
        await query.sendKeys(Key.ARROW_DOWN);
        await browser.wait(
          async () => (await query.getAttribute("aria-expanded")) === "true",
          5_000,
        );
        {
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                () => localStorage.getItem("portcove.appearance.interface-size") === "400",
              ),
            10_000,
          );
          const enlarged = await executeBrowserScript(browser, () => {
            const input = document.querySelector<HTMLInputElement>("#port-search");
            const list = document.getElementById(input?.getAttribute("aria-controls") ?? "");
            const selectedOption = list?.querySelector('[role="option"][aria-selected="true"]');
            const project = [...(selectedOption?.querySelectorAll("span") ?? [])]
              .map((span) => span.textContent ?? "")
              .find((text) => text.startsWith("Port project: "));
            return {
              width: innerWidth,
              height: innerHeight,
              client: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
              query: input?.value,
              selected: project?.slice(project.lastIndexOf(" · ") + 3),
              selected_project: project,
            };
          });
          assert.ok(enlarged.width <= 240 && enlarged.scroll <= enlarged.client + 1);
          assert.equal(enlarged.query, gameIdentityLabel(port));
          assert.equal(enlarged.selected, port.id);
          assert.equal(enlarged.selected_project, projectDescription);
          const receipt = path.join(output, "add-games-native-400.json");
          await writeFile(receipt, JSON.stringify(enlarged, null, 2), { flag: "wx" });
          artifacts.push(receipt);
        }
        await query.sendKeys(Key.ESCAPE);
        await selectPrimaryNavigation(browser, "Settings");
        await selectPrimaryNavigation(browser, "Library");
        assert.equal(
          await browser.findElement(By.id("port-search")).getAttribute("value"),
          gameIdentityLabel(port),
        );
        await click(By.css('button[aria-label="Find games in a folder"]'));
      }
      await browser.wait(until.elementLocated(By.id(setupHeading)), 5_000);
      await enlargedStage("scan-and-recognize");
      await click(button("Refresh folders"));
      const initialSnapshot = required(await read("get_game_file_scan_snapshot"));
      assert.equal(required(initialSnapshot.coverage).batches, 1);
      assert.equal(required(initialSnapshot.coverage).can_resume, true);
      assert.equal(required(initialSnapshot.coverage).restart_required, false);
      assert.equal(required(initialSnapshot.limits).max_entries, 2);
      assert.ok(
        !initialSnapshot.report.candidates.some((item) => item.profile_id === owned.profiles[0]),
      );
      assert.deepEqual(core(["source", "roots", "snapshot"]), initialSnapshot);
      report.observations.initial_bounded_scan = initialSnapshot;
      const priorScans = new Set(
        (await read("get_activities")).records
          .filter((item) => item.operation === "discover_sources")
          .map((item) => item.id),
      );
      await click(button("Continue scan"));
      await browser.wait(
        async () =>
          (await read("get_activities")).records.some(
            (item) =>
              item.operation === "discover_sources" &&
              item.status === "succeeded" &&
              !priorScans.has(item.id),
          ),
        15_000,
        "A new actual Core scan must finish",
      );
      const snapshot = required(await read("get_game_file_scan_snapshot"));
      assert.equal(snapshot.freshness, "inputs_match");
      assert.equal(required(snapshot.coverage).batches, 2);
      assert.equal(required(snapshot.coverage).frontier_exhausted, true);
      assert.equal(required(snapshot.coverage).can_resume, false);
      assert.equal(required(snapshot.coverage).restart_required, false);
      assert.ok(snapshot.report.entries_examined > initialSnapshot.report.entries_examined);
      assert.ok(snapshot.report.files_hashed > initialSnapshot.report.files_hashed);
      assert.deepEqual(snapshot.limits, initialSnapshot.limits);
      assert.deepEqual(core(["source", "roots", "snapshot"]), snapshot);
      report.observations.continued_scan = snapshot;
      assert.deepEqual(
        snapshot.report.candidates.map((item) => item.profile_id).sort(),
        [...owned.profiles].sort(),
      );
      assert.deepEqual(await read("get_sources"), [], "Discovery must not register inputs");
      await click(
        By.css(
          `[data-completed-candidate][data-profile-id="${owned.profiles[0]}"] [data-candidate-review]`,
        ),
      );
      const sourceReview = By.css('[aria-label="Source import review"]');
      await browser.wait(until.elementLocated(sourceReview), 15_000);
      assert.deepEqual(await read("get_sources"), [], "Review must not register inputs");
      await click(button("Use current location"));
      const continuation = By.css('[aria-label="Continue to a game"]');
      const choices = [fixture.port, fixture.refreshPort, reviewPort]
        .map((item) => `Open ${item.name} details`)
        .sort();
      await browser.wait(
        async () =>
          executeBrowserScript(
            browser,
            (choices) => {
              const section = document.querySelector('[aria-label="Continue to a game"]');
              const buttons = [...(section?.querySelectorAll("button") ?? [])];
              return (
                !document.querySelector('[aria-label="Source import review"]') &&
                buttons.length === choices.length &&
                buttons.every(
                  (item) => !item.disabled && choices.includes((item.textContent ?? "").trim()),
                ) &&
                Boolean(section?.contains(document.activeElement))
              );
            },
            choices,
          ),
        15_000,
        "Registration must focus the independent port choices",
      );
      report.observations.sources = await read("get_sources");
      assert.equal(report.observations.sources.length, 1);
      assert.equal(required(report.observations.sources[0]).profile_id, owned.profiles[0]);
      assert.deepEqual(core(["source", "list"]), report.observations.sources);
      const incomplete = required(
        (await read("get_statuses")).find((item) => item.port_id === fixture.refreshPort.id),
      );
      assert.ok(required(incomplete.readiness).blockers.includes("missing_bios"));
      const queue = By.css('[aria-label="Selected setup reviews"]');
      await browser.wait(until.elementLocated(queue), 5_000);
      const beforeSelection = await read("get_statuses");
      for (const id of [port.id, reviewPort.id])
        await click(By.css(`[role="checkbox"][data-setup-review-port="${id}"]`));
      assert.deepEqual(await read("get_statuses"), beforeSelection, "Selection grants no mutation");
      report.observations.setup_selection = [port.id, reviewPort.id];
      await click(button(`Review ${port.name} setup`));
      // The review may already hide its background from accessibility. Verify the
      // selected detail's DOM identity, then require the actual review below.
      await browser.wait(
        async () =>
          (await executeBrowserScript(browser, () =>
            document.getElementById("port-detail-title")?.textContent?.trim(),
          )) === port.name,
        5_000,
        "Selected setup must open the expected game details",
      );
      await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="install-review-title"]')),
        15_000,
      );
      assert.deepEqual(
        await read("get_statuses"),
        beforeSelection,
        "Core planning grants no mutation",
      );
      await screenshot("selected-setup-queue-review");
      await click(button("Cancel review"));
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-labelledby="install-review-title"]')))
            .length === 0,
        5_000,
      );

      const installDialog = By.css('[aria-labelledby="install-review-title"]');
      const install = By.xpath('//button[starts-with(normalize-space(.),"Install ·")]');
      const openInstall = async () => {
        await click(button("Review installation"));
        await browser.wait(until.elementLocated(installDialog), 15_000);
        await browser.wait(until.elementIsEnabled(await browser.findElement(install)), 15_000);
      };
      const beforeReview = await status();
      await openInstall();
      report.observations.plan = await read("plan_port", { portId: port.id, channel: "stable" });
      assert.ok(report.observations.plan.source_requirements.every((item) => item.registered));
      await assertCompactReview(browser, '[aria-labelledby="install-review-title"]');
      await assertPrimaryReviewAction(
        browser,
        await browser.findElement(install),
        await browser.findElement(button("Cancel review")),
      );
      await screenshot("selected-setup-install-review");
      await enlargedStage("install-review");
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(installDialog)).length === 0,
        5_000,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            'return document.activeElement?.textContent?.trim() === "Review installation";',
          ),
        5_000,
      );
      assert.deepEqual(await status(), beforeReview, "Dismissal must preserve authoritative state");
      assert.equal(fixture.requests.length, 0);

      async function reviewSetupWithController() {
        await openInstall();
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              () => document.activeElement === document.getElementById("install-review-title"),
            ),
          5_000,
          "The installation review must initially focus its heading",
        );
        // Enter the first action through native keyboard navigation before the
        // existing action-to-action controller probe; never assign focus in JS.
        await browser.actions().sendKeys(Key.TAB).perform();
        await browser.wait(
          async () =>
            executeBrowserScript(
              browser,
              (control) => document.activeElement === control,
              await browser.findElement(install),
            ),
          5_000,
          "Tab from the review heading must reach the actual Install control",
        );
        report.observations.controller_review = object(
          await browser.executeAsyncScript(
            async (
              installControl: Element,
              cancelControl: Element,
              done: (value: unknown) => void,
            ) => {
              // The actual components consume these four Gamepad fields. Keep the
              // injected adapter honest without inventing extra hardware observations.
              const controllerNavigator: {
                getGamepads: (
                  this: void,
                ) => readonly (Pick<Gamepad, "index" | "id" | "axes" | "buttons"> | null)[];
              } = navigator;
              const originalPads = controllerNavigator.getGamepads;
              const originalMode = document.documentElement.dataset.inputMode;
              let pressed: number[] = [];
              let adapterSamples = 0;
              const frames = async (count: number) => {
                for (let frame = 0; frame < count; frame++)
                  await new Promise<number>(requestAnimationFrame);
              };
              function directionBetween(from: DOMRect, to: DOMRect) {
                const dx = to.left + to.width / 2 - (from.left + from.width / 2);
                const dy = to.top + to.height / 2 - (from.top + from.height / 2);
                return Math.abs(dy) > Math.abs(dx)
                  ? dy > 0
                    ? "down"
                    : "up"
                  : dx > 0
                    ? "right"
                    : "left";
              }
              function visibleCancel(control: Element, rect: DOMRect) {
                const hit = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
                return (
                  document.activeElement === control &&
                  rect.left >= 0 &&
                  rect.right <= innerWidth &&
                  rect.top >= 0 &&
                  rect.bottom <= innerHeight &&
                  (hit === control || control.contains(hit))
                );
              }
              let observation;
              try {
                const review = document.querySelector('[aria-labelledby="install-review-title"]');
                if (!review || !document.hasFocus())
                  throw new Error("Actual setup review must own native focus");
                controllerNavigator.getGamepads = () => {
                  adapterSamples++;
                  return [
                    {
                      index: 0,
                      id: "Owned connected-folder input adapter",
                      axes: [0, 0],
                      buttons: Array.from({ length: 16 }, (_, index) => ({
                        pressed: pressed.includes(index),
                        touched: pressed.includes(index),
                        value: pressed.includes(index) ? 1 : 0,
                      })),
                    },
                  ];
                };
                await frames(2);
                const beforeDirection = document.activeElement;
                if (beforeDirection !== installControl || !review.contains(installControl))
                  throw new Error(
                    "Actual primary Install control must retain keyboard entry focus",
                  );
                const from = installControl.getBoundingClientRect();
                const to = cancelControl.getBoundingClientRect();
                if (
                  !from.width ||
                  !from.height ||
                  !to.width ||
                  !to.height ||
                  !review.contains(cancelControl)
                )
                  throw new Error("Both actual review actions must have layout geometry");
                const direction = directionBetween(from, to);
                const directionButton = { up: 12, down: 13, left: 14, right: 15 }[direction];
                pressed = [directionButton];
                await frames(2);
                const stayedInReview = review.contains(document.activeElement);
                const movedToCancel =
                  document.activeElement !== beforeDirection &&
                  document.activeElement?.textContent?.trim() === "Cancel review";
                pressed = [];
                await frames(2);
                let cancelRevealed = false;
                let cancelAfter = cancelControl.getBoundingClientRect();
                for (let frame = 0; frame < 30; frame++) {
                  cancelAfter = cancelControl.getBoundingClientRect();
                  cancelRevealed = visibleCancel(cancelControl, cancelAfter);
                  if (cancelRevealed) break;
                  await frames(1);
                }
                pressed = [1];
                await frames(4);
                observation = {
                  method: "injected controller adapter on actual setup components",
                  original_api_type: typeof originalPads,
                  adapter_samples: adapterSamples,
                  stayed_in_top_review: stayedInReview,
                  moved_to_cancel_review: movedToCancel,
                  direction,
                  direction_button: directionButton,
                  cancel_revealed: cancelRevealed,
                  cancel_geometry_after_direction: {
                    left: cancelAfter.left,
                    top: cancelAfter.top,
                    width: cancelAfter.width,
                    height: cancelAfter.height,
                  },
                  action_geometry: {
                    from: {
                      left: from.left,
                      top: from.top,
                      width: from.width,
                      height: from.height,
                    },
                    to: { left: to.left, top: to.top, width: to.width, height: to.height },
                  },
                  dismissed_review: !document.querySelector(
                    '[aria-labelledby="install-review-title"]',
                  ),
                  stayed_in_game_details: Boolean(document.querySelector("#port-detail-title")),
                  focus: document.activeElement?.textContent?.trim(),
                };
              } catch (error) {
                observation = { error: String(error) };
              } finally {
                controllerNavigator.getGamepads = originalPads;
                if (originalMode === undefined) delete document.documentElement.dataset.inputMode;
                else document.documentElement.dataset.inputMode = originalMode;
              }
              done(observation);
            },
            await browser.findElement(install),
            await browser.findElement(button("Cancel review")),
          ),
        );
        assert.equal(report.observations.controller_review.error, undefined);
        assert.equal(report.observations.controller_review.stayed_in_top_review, true);
        assert.equal(report.observations.controller_review.moved_to_cancel_review, true);
        assert.equal(report.observations.controller_review.cancel_revealed, true);
        assert.equal(report.observations.controller_review.dismissed_review, true);
        assert.equal(report.observations.controller_review.stayed_in_game_details, true);
        await browser.wait(
          () =>
            executeBrowserScript(
              browser,
              'return document.activeElement?.textContent?.trim() === "Review installation";',
            ),
          5_000,
        );
        assert.deepEqual(await status(), beforeReview);
        assert.equal(fixture.requests.length, 0);
      }
      if (fixture.nativeConnectionJourney) {
        await reviewSetupWithController();
      }

      await openInstall();
      await browser.findElement(install).click();
      await browser.wait(() => (fixture.requests[0]?.bytes_sent ?? 0) > 0, 15_000);
      const running = required(await browser.wait(() => activity("install", "running"), 15_000));
      assert.equal(required(running.cancellation).requested, false);
      await click(button("Cancel operation"));
      const cancelled = required(
        await browser.wait(() => activity("install", "cancelled"), 15_000),
      );
      assert.equal(cancelled.id, running.id);
      assert.equal(required(cancelled.failure).code, "cancelled");
      await browser.wait(() => required(fixture.requests[0]).connection_closed, 10_000);
      assert.equal(required(fixture.requests[0]).completed, false);
      assert.ok(required(fixture.requests[0]).bytes_sent < fixture.artifact.length);
      const cancelledStatus = await status();
      assert.equal(cancelledStatus.active, null);
      assert.equal(cancelledStatus.staged, null);
      await assert.rejects(stat(path.join(library, "staging", running.id)), { code: "ENOENT" });
      report.observations.cancelled = { activity: cancelled, status: cancelledStatus };
      await enlargedStage("cancelled-install");

      await browser.wait(until.elementLocated(button("Review installation")), 15_000);
      await openInstall();
      await browser.findElement(install).click();
      const installedActivity = required(
        await browser.wait(() => activity("install", "succeeded"), 30_000),
      );
      assert.notEqual(installedActivity.id, cancelled.id);
      assert.equal(fixture.requests.length, 2);
      assert.equal(required(fixture.requests[1]).completed, true);
      assert.equal(required(fixture.requests[1]).bytes_sent, fixture.artifact.length);
      const installed = await status();
      assert.ok(installed.active);
      assert.equal(
        installed.active.artifact.sha256,
        required(port.release.direct[required(port.platforms[0])]).sha256,
      );
      assert.equal(
        required(installed.readiness).launchable,
        false,
        "Installation must not imply prepared game data",
      );
      report.observations.installed = { activity: installedActivity, status: installed };
      await enlargedStage("installed-next-step");

      await click(button("Review setup"));
      const preparationDialog = By.css('[aria-labelledby="preparation-review-title"]');
      await browser.wait(until.elementLocated(preparationDialog), 15_000);
      await browser.wait(
        until.elementIsEnabled(await browser.findElement(button("Prepare game data"))),
        15_000,
      );
      await assertCompactReview(browser, '[aria-labelledby="preparation-review-title"]');
      await enlargedStage("preparation-review");
      assert.equal(
        required((await status()).active).id,
        installed.active.id,
        "Preparation review must not mutate",
      );
      const priorPreparationIds = new Set(
        (await read("get_activities")).records
          .filter((item) => item.operation === "prepare" && item.target_id === port.id)
          .map((item) => item.id),
      );
      const preparationWait: PreparationObservation & { requested_at: string } = {
        requested_at: new Date().toISOString(),
      };
      report.observations.preparation_wait = preparationWait;
      await click(button("Prepare game data"));
      const completion = await browser.wait(
        () =>
          observePreparationCompletion({
            readActivities: () => read("get_activities"),
            readStatus: async (): Promise<CompletionStatus> => {
              const value = await status();
              return { ...value, readiness: required(value.readiness) };
            },
            isReviewClosed: async () =>
              (await browser.findElements(preparationDialog)).length === 0,
            portId: port.id,
            priorPreparationIds,
            observation: preparationWait,
          }),
        15_000,
        "The new Core preparation must reach terminal success, readiness and a closed review",
      );
      assert.ok(completion);
      const { status: prepared, activity: completedPreparation } = completion;
      assert.ok(prepared.active && prepared.previous);
      assert.notEqual(prepared.active.id, installed.active.id);
      assert.equal(prepared.previous.id, installed.active.id);
      assert.equal(
        await readFile(path.join(prepared.active.path, text(object(port).setup_marker)), "utf8"),
        "owned validated output",
      );
      report.observations.prepared = {
        activity: completedPreparation,
        status: prepared,
      };
      assert.ok(report.observations.prepared.activity);
      await assertCompletionCoreParity({
        read,
        core,
        portId: port.id,
        prepared,
        observations: report.observations,
      });
      // Ordinary status inspects metadata only; it does not verify current
      // source bytes or evaluate a release compatibility contract.
      const passiveReadiness = required(prepared.readiness);
      assert.equal(passiveReadiness.launchable, true);
      assert.deepEqual(passiveReadiness.blockers, []);
      assert.equal(passiveReadiness.pending_setup, false);
      assert.equal(passiveReadiness.source, "not_checked");
      assert.deepEqual(passiveReadiness.source_assessment, {
        health: "not_checked",
        classification: { state: "not_evaluated" },
        contract: { state: "not_evaluated" },
        admission: { state: "not_evaluated" },
        evidence: [],
      });
      await browser.wait(until.elementLocated(button("Try launch")), 15_000);
      await browser.wait(
        until.elementIsEnabled(await browser.findElement(button("Try launch"))),
        15_000,
      );
      report.observations.result_focus = await browser.wait(
        () => executeBrowserScript(browser, observeCompletionResultFocus, port.name),
        5_000,
        "Preparation must restore natural focus to the current file summary when compatibility is unconfirmed",
      );
      assert.ok(report.observations.result_focus);
      assert.equal(report.observations.result_focus.tag, "H3");
      assert.equal(report.observations.result_focus.text, "Files need checking");
      await screenshot("selected-setup-prepared");
      await enlargedStage("prepared-completion");
      await click(By.css("[data-detail-back]"));
      await browser.wait(until.elementLocated(continuation), 5_000);
      report.observations.return_focus = await browser.wait(
        () => executeBrowserScript(browser, observeCompletionReturnFocus, setupOrigin),
        5_000,
        "Return must restore focus to the authoritative setup continuation",
      );
      assert.deepEqual(await read("get_sources"), report.observations.completed_sources);
      for (const label of choices)
        assert.equal(await browser.findElement(button(label)).isEnabled(), true);
      report.observations.returned_choices = choices;
      assert.equal(
        await browser.findElement(button(`Review ${port.name} setup`)).isEnabled(),
        false,
      );
      const returnedAlternative = required(
        (await read("get_statuses")).find((item) => item.port_id === reviewPort.id),
      );
      assert.equal(returnedAlternative.active, null);
      assert.equal(Boolean(returnedAlternative.external_runtime), false);
      assert.ok(
        required(returnedAlternative.port_actions).some(
          (item) => item.action === "install" && item.availability === "allowed",
        ),
      );
      const returnedSnapshot = required(await read("get_game_file_scan_snapshot"));
      assert.equal(returnedSnapshot.freshness, "inputs_match");
      await browser.wait(
        async () => {
          const controls = await browser.findElements(button(`Review ${reviewPort.name} setup`));
          return controls.length === 1 && (await required(controls[0]).isEnabled());
        },
        15_000,
        "The fresh return read must restore the Core-eligible alternative review",
      );
      report.observations.returned_alternative_review = {
        status: returnedAlternative,
        snapshot: returnedSnapshot,
        review_enabled: true,
      };
      const afterCompletion = await read("get_statuses");
      await click(button(`Review ${reviewPort.name} setup`));
      await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="install-review-title"]')),
        15_000,
      );
      assert.equal(
        await browser.findElement(By.id("port-detail-title")).getText(),
        reviewPort.name,
      );
      await click(button("Cancel review"));
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-labelledby="install-review-title"]')))
            .length === 0,
        5_000,
      );
      assert.deepEqual(
        await read("get_statuses"),
        afterCompletion,
        "Alternative review dismissal preserves installations",
      );
      await click(By.css("[data-detail-back]"));
      await browser.wait(until.elementLocated(queue), 5_000);
      assert.match(await browser.findElement(queue).getText(), /2 of 16 ports selected/);
      await screenshot("selected-setup-queue-return");
      await enlargedStage("returned-selection");
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      const sourceHealthRow = `.source-health-row[data-source-profile="${owned.profiles[0]}"]`;
      await click(
        By.xpath(
          `//*[@data-source-profile="${owned.profiles[0]}" and contains(@class,"source-health-row")]//button[normalize-space(.)="Check file"]`,
        ),
      );
      await browser.wait(
        async () => {
          const resultBadges = await browser.findElements(
            By.css(`${sourceHealthRow} .source-result`),
          );
          const displayed = await Promise.all(resultBadges.map((badge) => badge.isDisplayed()));
          return displayed.some(Boolean);
        },
        15_000,
        "The explicitly requested source inspection must display its actual result for axe",
      );
      const accessibilityFile = path.join(output, "selected-setup-completion-accessibility.json");
      await captureAccessibilityReport(browser, accessibilityFile, artifacts);
      const accessibilityValue: unknown = JSON.parse(await readFile(accessibilityFile, "utf8"));
      const accessibility = object(accessibilityValue);
      assert.ok(Array.isArray(accessibility.violations) && Array.isArray(accessibility.incomplete));
      const resultBadges = await browser.findElements(By.css(`${sourceHealthRow} .source-result`));
      const displayedBadges = await Promise.all(resultBadges.map((badge) => badge.isDisplayed()));
      assert.ok(displayedBadges.some(Boolean), "An actual source result must be displayed for axe");
      const violations: unknown[] = accessibility.violations,
        incompleteEntries: unknown[] = accessibility.incomplete;
      const accessibilityEntries = [...violations, ...incompleteEntries];
      const prohibitedAttributes = accessibilityEntries.filter(
        (item) => object(item).id === "aria-prohibited-attr",
      );
      report.observations.source_result_accessibility = {
        rule: "aria-prohibited-attr",
        unresolved: prohibitedAttributes.length,
      };
      assert.deepEqual(
        prohibitedAttributes,
        [],
        "The visible source result must not retain prohibited or unresolved ARIA attributes",
      );
      await selectPrimaryNavigation(browser, "Library");
      await browser.wait(until.elementLocated(By.id(setupHeading)), 5_000);
      assert.match(await browser.findElement(queue).getText(), /2 of 16 ports selected/);
      // The game remains registered outside this new root. Only a newly found
      // BIOS can associate the incomplete port with the next setup selection.
      const biosOnly = path.join(owned.directory, "bios-only");
      const biosOnlyPath = path.join(biosOnly, "bios.pcbios");
      await mkdir(biosOnly);
      await writeFile(biosOnlyPath, await readFile(owned.biosBefore), { flag: "wx" });
      const rootsBefore = await read("get_game_file_roots");
      assert.equal(rootsBefore.length, 1);
      assertOwnedSelectedSetupPath(required(rootsBefore[0]).path, owned.directory);
      const relinked = required(
        object(core(["source", "roots", "relink", required(rootsBefore[0]).id, biosOnly])),
      );
      assert.equal(relinked.id, required(rootsBefore[0]).id);
      assert.deepEqual(await read("get_sources"), report.observations.completed_sources);
      await click(button("Refresh folders"));
      const beforeBiosScans = new Set(
        (await read("get_activities")).records.map((item) => item.id),
      );
      await click(button("Scan saved folders"));
      await browser.wait(
        async () => {
          const observations = await read("get_game_file_scan_snapshot");
          const activity = (await read("get_activities")).records.find(
            (item) =>
              item.operation === "discover_sources" &&
              item.status === "succeeded" &&
              !beforeBiosScans.has(item.id),
          );
          if (!activity || observations?.freshness !== "inputs_match") return false;
          assert.deepEqual(
            observations.report.candidates.map((item) => item.profile_id),
            [owned.profiles[1]],
          );
          assertOwnedSelectedSetupPath(
            required(observations.report.candidates[0]).path,
            biosOnlyPath,
          );
          report.observations.bios_only_scan = { snapshot: observations, activity };
          return (
            (await browser.findElements(By.css("[data-completed-candidate]"))).length === 1 &&
            (
              await browser.findElements(
                By.css(`[data-completed-candidate][data-profile-id="${owned.profiles[1]}"]`),
              )
            ).length === 1
          );
        },
        15_000,
        "The fresh real Core scan must contain only the BIOS candidate",
      );
      const beforeBiosRegistration = await read("get_statuses");
      const blocked = required(
        beforeBiosRegistration.find((item) => item.port_id === fixture.refreshPort.id),
      );
      assert.equal(
        required(required(blocked.port_actions).find((item) => item.action === "install")).reason,
        "missing_bios",
      );
      assert.equal(
        (
          await browser.findElements(
            By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`),
          )
        ).length,
        0,
      );
      await click(
        By.css(
          `[data-completed-candidate][data-profile-id="${owned.profiles[1]}"] [data-candidate-review]`,
        ),
      );
      await browser.wait(until.elementLocated(sourceReview), 15_000);
      assert.deepEqual(
        await read("get_sources"),
        report.observations.completed_sources,
        "BIOS review alone grants no registration",
      );
      await click(button("Use current location"));
      await browser.wait(
        async () => {
          const statuses = await read("get_statuses");
          const completed = required(
            statuses.find((item) => item.port_id === fixture.refreshPort.id),
          );
          const allowed = required(completed.port_actions).some(
            (item) => item.action === "install" && item.availability === "allowed",
          );
          const choices = await browser.findElements(
            By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`),
          );
          return (
            allowed &&
            choices.length === 1 &&
            (await required(choices[0]).getAttribute("aria-disabled")) !== "true"
          );
        },
        15_000,
        "Explicit BIOS registration must expose the actual Core-eligible selection",
      );
      const biosSources = await read("get_sources");
      assert.equal(biosSources.length, 2);
      assertOwnedSelectedSetupPath(
        required(biosSources.find((item) => item.profile_id === owned.profiles[0])).path,
        owned.gamePath,
      );
      assertOwnedSelectedSetupPath(
        required(biosSources.find((item) => item.profile_id === owned.profiles[1])).path,
        biosOnlyPath,
      );
      assert.deepEqual(core(["source", "list"]), biosSources);
      await click(By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`));
      const statusesBeforeBiosPlan = await read("get_statuses");
      const acquisitionsBeforeBiosPlan = fixture.requests.length;
      await click(button(`Review ${fixture.refreshPort.name} setup`));
      await browser.wait(until.elementLocated(installDialog), 15_000);
      assert.equal(
        await browser.findElement(By.id("port-detail-title")).getText(),
        fixture.refreshPort.name,
      );
      const biosPlan = await read("plan_port", {
        portId: fixture.refreshPort.id,
        channel: "stable",
      });
      assert.deepEqual(biosPlan.source_requirements.map((item) => item.role).sort(), [
        "bios",
        "game_source",
      ]);
      assert.deepEqual(
        biosPlan.source_requirements.map((item) => item.profile_id).sort(),
        [...owned.profiles].sort(),
      );
      assert.ok(biosPlan.source_requirements.every((item) => item.registered));
      assert.deepEqual(await read("get_statuses"), statusesBeforeBiosPlan);
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.equal(
        fixture.requests.length,
        acquisitionsBeforeBiosPlan,
        "Planning must not acquire the package",
      );
      report.observations.bios_completed_review = {
        sources: biosSources,
        plan: biosPlan,
        statuses: statusesBeforeBiosPlan,
      };
      await screenshot("selected-setup-bios-completed-review");
      await click(button("Cancel review"));
      await browser.wait(
        async () => (await browser.findElements(installDialog)).length === 0,
        5_000,
      );
      assert.deepEqual(await read("get_statuses"), statusesBeforeBiosPlan);
      await click(By.css("[data-detail-back]"));
      await browser.wait(until.elementLocated(queue), 5_000);
      assert.match(await browser.findElement(queue).getText(), /3 of 16 ports selected/);
      report.observations.bios_return_focus = await browser.wait(
        () => executeBrowserScript(browser, observeCompletionReturnFocus, setupOrigin),
        5_000,
        "The BIOS-only journey must return focus to its current setup continuation",
      );
      await screenshot("selected-setup-bios-queue-return");
      await captureAccessibilityReport(
        browser,
        path.join(output, "selected-setup-bios-completion-accessibility.json"),
        artifacts,
      );
      await browser.wait(
        async () => {
          const controls = await browser.findElements(
            button(`Review ${fixture.refreshPort.name} setup`),
          );
          return controls.length === 1 && (await required(controls[0]).isEnabled());
        },
        15_000,
        "The fresh return read must restore the Core-eligible BIOS review",
      );
      report.observations.bios_settled_return = {
        snapshot: required(await read("get_game_file_scan_snapshot")),
        review_enabled: true,
        selected_count: 3,
      };
      assert.equal(report.observations.bios_settled_return.snapshot.freshness, "inputs_match");
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.equal(fixture.requests.length, acquisitionsBeforeBiosPlan);
      await screenshot("selected-setup-bios-settled-return");

      const rootsBeforeRestart = await read("get_game_file_roots");
      browser = await restartApplication("selected-setup-inputs");
      await browser.manage().window().setRect({ width: 960, height: 640 });
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            () =>
              localStorage.getItem("portcove.appearance.interface-size") === "400" &&
              innerWidth <= 240,
          ),
        10_000,
        "Restart did not restore native enlargement",
      );
      generation = await selectedSetupGeneration(invoke);
      const { button: restartButton, click: restartClick } = reviewControls(browser);
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.deepEqual(await read("get_game_file_roots"), rootsBeforeRestart);
      const restoredSnapshot = required(await read("get_game_file_scan_snapshot"));
      assert.equal(restoredSnapshot.freshness, "inputs_match");
      assert.deepEqual(
        restoredSnapshot.report.candidates,
        required(report.observations.bios_only_scan).snapshot.report.candidates,
      );
      const restoredStatus = required(
        (await read("get_statuses")).find((item) => item.port_id === fixture.refreshPort.id),
      );
      assert.equal(restoredStatus.active, null);
      assert.ok(
        required(restoredStatus.port_actions).some(
          (item) => item.action === "install" && item.availability === "allowed",
        ),
      );
      assert.deepEqual(core(["source", "list"]), biosSources);
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await browser.wait(
        async () => {
          const controls = await browser.findElements(
            By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`),
          );
          return (
            controls.length === 1 &&
            (await required(controls[0]).getAttribute("aria-disabled")) !== "true"
          );
        },
        15_000,
        "Restart must recover the saved BIOS match and actual eligible setup choice",
      );
      const restoredChoice = await browser.findElement(
        By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`),
      );
      assert.equal(
        await restoredChoice.getAttribute("aria-checked"),
        "false",
        "Selection is ephemeral across restart",
      );
      assert.doesNotMatch(await browser.findElement(queue).getText(), /3 of 16 ports selected/);
      await restartClick(
        By.css(`[role="checkbox"][data-setup-review-port="${fixture.refreshPort.id}"]`),
      );
      await restartClick(restartButton(`Review ${fixture.refreshPort.name} setup`));
      await browser.wait(until.elementLocated(installDialog), 15_000);
      const restoredPlan = await read("plan_port", {
        portId: fixture.refreshPort.id,
        channel: "stable",
      });
      assert.deepEqual(restoredPlan.source_requirements, biosPlan.source_requirements);
      report.observations.bios_restart = {
        roots: rootsBeforeRestart,
        sources: biosSources,
        snapshot: restoredSnapshot,
        status: restoredStatus,
        plan: restoredPlan,
        selection_restored: false,
      };
      await screenshot("selected-setup-bios-restarted-review");
      await enlargedStage("restarted-review");
      await restartClick(restartButton("Cancel review"));
      await browser.wait(
        async () => (await browser.findElements(installDialog)).length === 0,
        5_000,
      );
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.equal(fixture.requests.length, acquisitionsBeforeBiosPlan);
      assert.equal(
        required(
          (await read("get_statuses")).find((item) => item.port_id === fixture.refreshPort.id),
        ).active,
        null,
      );
      await captureAccessibilityReport(
        browser,
        path.join(output, "selected-setup-bios-restart-accessibility.json"),
        artifacts,
      );
    } catch (error) {
      failure = { error };
      report.failure = {
        message: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      if (zoomAttempted) {
        try {
          const image = path.join(output, "selected-setup-enlargement-failure.png");
          await writeFile(image, await browser.takeScreenshot(), {
            encoding: "base64",
            flag: "wx",
          });
          artifacts.push(image);
        } catch (captureError) {
          failure = {
            error: new AggregateError([error, captureError], "Setup and failure capture failed"),
          };
          report.enlargement_capture_failure = errorMessage(captureError);
        }
      }
    }
    async function restoreSetupViewport() {
      if (zoomAttempted) {
        try {
          await shortcut("0");
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                () => localStorage.getItem("portcove.appearance.interface-size") === "100",
              ),
            10_000,
          );
        } catch (error) {
          const previous = failure;
          failure = {
            error: previous
              ? new AggregateError(
                  [previous.error, error],
                  "Setup journey and enlargement cleanup failed",
                )
              : error,
          };
          report.enlargement_cleanup_failure = errorMessage(error);
        }
      }
      if (originalWindow) {
        try {
          await browser.manage().window().setRect(originalWindow);
        } catch (error) {
          failure = {
            error: failure
              ? new AggregateError([failure.error, error], "Setup and window restoration failed")
              : error,
          };
          report.enlargement_cleanup_failure = [
            report.enlargement_cleanup_failure,
            errorMessage(error),
          ]
            .filter(Boolean)
            .join("; ");
        }
      }
    }
    await restoreSetupViewport();
    async function checkSetupOriginalsPreserved() {
      let preservationFailure: { error: unknown } | undefined;
      try {
        for (const [actual, original] of [
          ["gamePath", "gameBefore"],
          ["biosPath", "biosBefore"],
        ] as const)
          assert.deepEqual(
            await readFile(owned[actual]),
            await readFile(owned[original]),
            "Original player inputs must remain unchanged",
          );
        report.original_inputs_preserved = true;
      } catch (error) {
        preservationFailure = { error };
        report.preservation_failure = errorMessage(error);
      }
      return preservationFailure;
    }
    const preservationFailure = await checkSetupOriginalsPreserved();
    const file = path.join(output, "selected-setup-completion.json");
    const primaryFailure = failure ?? preservationFailure;
    await retainCompletionReport({
      file,
      report,
      artifacts,
      ...(primaryFailure ? { failure: primaryFailure.error } : {}),
    });
  });
}
