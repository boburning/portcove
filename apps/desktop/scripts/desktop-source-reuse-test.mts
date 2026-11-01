// Real-input Windows journey. Automated process observations do not establish runtime rendering or gameplay.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, lstat, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity, type FileIdentity } from "../../../scripts/development-evidence.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import {
  captureAccessibilityReport,
  clickVisible,
  reviewControls,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { captureKeyboardTarget } from "./desktop-capture-target.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type {
  LaunchSessionRecord,
  PortDefinition,
  SourceRecord,
} from "../src/transport-types.generated.d.ts";

import { spawnCommand } from "../../../scripts/dev-storage.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { requestRealRuntimeClose } from "./desktop-real-runtime-test.mts";
import { assertOwnedSelectedSetupPath } from "./desktop-source-dialog-test.mts";
import {
  nativeSessionScript,
  readNativeSessionObservation,
  type NativeSessionMode,
  type NativeSessionObservations,
} from "./desktop-owned-native-session.mts";
import type { AcquisitionGameObserver } from "./desktop-install-test.mts";

const scenarioId = "native-registered-source-reuse";
const profileId = "majoras-mask";
const canonicalUsa10 = "d6133ace5afaa0882cf214cf88daba39e266c078";
const portIds = ["2ship2harkinian", "zelda64-recomp"] as const;

// Called only after positive game/supervisor exit and unchanged source records.
// A known nonzero game exit can leave later observations safe, never successful.
export function retainSettledRuntimeOutcome(
  route: Record<string, unknown>,
  terminal: LaunchSessionRecord,
) {
  route.terminal = terminal;
  if (
    terminal.outcome === "failed" &&
    Number.isSafeInteger(terminal.exit_code) &&
    terminal.exit_code !== 0 &&
    terminal.message === "the game process did not exit successfully"
  ) {
    route.failure = {
      stage:
        route.runtime_close_mode === "external-operator-observation"
          ? "operator-observed-exit"
          : "normal-close",
      message: `Core recorded failed game exit ${terminal.exit_code}`,
    };
    route.stage = "settled-with-play-failure";
    return;
  }
  assert.equal(terminal.outcome, "succeeded");
  assert.equal(terminal.exit_code, 0);
  route.stage = "settled";
}

export function requireSuccessfulRegisteredRuntimeRoutes(routes: Record<string, unknown>[]) {
  assert.deepEqual(
    routes.map((route) => route.port_id),
    [...portIds],
  );
  const failures = routes.filter((route) => route.failure !== undefined);
  assert.equal(
    failures.length,
    0,
    "Actual Play failures remain failed after the independent reuse observations",
  );
  for (const route of routes) {
    assert.equal(route.stage, "settled");
    assert.ok(isRecord(route.terminal));
    assert.equal(route.terminal.outcome, "succeeded");
    assert.equal(route.terminal.exit_code, 0);
  }
}

export async function observeRegisteredRuntimeExit({
  session,
  snapshot,
  native,
  wait,
  route,
}: {
  session: LaunchSessionRecord;
  snapshot: string;
  native: <Mode extends "Observe" | "Wait">(
    mode: Mode,
    snapshot: string,
  ) => NativeSessionObservations[Mode];
  wait: (observe: () => boolean, timeout: number) => Promise<boolean>;
  route: Record<string, unknown>;
}) {
  const exited = await wait(() => {
    const observation = native("Observe", snapshot);
    route.last_operator_exit_observation = observation;
    const game = observation.processes.find((entry) => entry.pid === session.child_pid);
    assert.ok(game);
    assert.equal(`windows-filetime:${game.started_filetime}`, session.child_identity);
    return game.state === "exited";
  }, 120_000);
  assert.equal(exited, true);
  route.observed_game_exit = native("Wait", snapshot);
}

// A generated archive is preparation evidence, never a rendered-frame claim.
// Two matching observations avoid closing on the first partial output copy.
export async function observeRegisteredRuntimeStartup({
  session,
  readSession,
  inspectArchive,
  wait,
}: {
  session: LaunchSessionRecord;
  readSession: () => LaunchSessionRecord | null | undefined;
  inspectArchive: () => Promise<FileIdentity | undefined>;
  wait: (
    observe: () => Promise<FileIdentity | false>,
    timeout: number,
  ) => Promise<FileIdentity | false>;
}) {
  let previous: FileIdentity | undefined;
  const requireLiveSession = () => {
    const current = readSession();
    assert.ok(current, "The observed runtime session disappeared during startup");
    for (const key of [
      "id",
      "port_id",
      "install_id",
      "supervisor_pid",
      "supervisor_identity",
      "child_pid",
      "child_identity",
    ] as const)
      assert.equal(current[key], session[key], `Runtime startup changed ${key}`);
    assert.equal(current.phase, "running", "Runtime ended before startup preparation was observed");
    assert.equal(current.outcome, null, "Runtime failed before startup preparation was observed");
  };
  const observed = await wait(async () => {
    requireLiveSession();
    const archive = await inspectArchive();
    requireLiveSession();
    const stable =
      archive &&
      archive.bytes > 0 &&
      previous &&
      archive.path === previous.path &&
      archive.bytes === previous.bytes &&
      archive.sha256 === previous.sha256;
    previous = archive;
    return stable ? archive : false;
  }, 120_000);
  assert.ok(observed, "No stable runtime preparation output was observed");
  return observed;
}

// The existing Core preview establishes identity. This helper copies only the
// explicitly supplied original into the new owned output; it never registers it.
export async function prepareRegisteredSourceReuseInputs({
  output,
  library,
  cli,
  original,
}: {
  output: string;
  library: string;
  cli: string;
  original: string;
}) {
  assert.equal(process.platform, "win32");
  assert.equal(process.env.PORTCOVE_QUALIFICATION_CATALOG, undefined);
  const runtimeObservation = process.env.PORTCOVE_SOURCE_REUSE_RUNTIME_OBSERVATION;
  assert.ok(runtimeObservation === undefined || runtimeObservation === "operator");
  assert.ok(path.isAbsolute(original), "An explicit absolute controlled original is required");
  assert.equal(path.extname(original).toLowerCase(), ".zip");
  let ancestor = original;
  for (;;) {
    assert.equal((await lstat(ancestor)).isSymbolicLink(), false);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const before = await fileIdentity(original);
  const owned = path.join(output, "d-majoras-mask-original.zip");
  await copyFile(original, owned, constants.COPYFILE_EXCL);
  const copy = await fileIdentity(owned);
  assert.equal(copy.sha256, before.sha256);
  assert.equal(copy.bytes, before.bytes);
  const command = ownedFixtureCommand({ cli, library, output });
  const preview = transportValue(
    "source_import_plan",
    command(
      ["source", "inbox", "import", profileId, owned, "--mode", "use-current-location"],
      undefined,
      { timeoutMs: 60_000 },
    ),
  );
  assert.equal(preview.existing_registration, null);
  assert.equal(preview.source.size, 33554432);
  assert.ok(
    preview.source.observed_identity?.digests.some(
      (digest) =>
        digest.algorithm === "sha1" &&
        digest.scope === "canonical-n64-big-endian" &&
        digest.value === canonicalUsa10,
    ),
  );
  assert.deepEqual(transportValues("source", command(["source", "list"])), []);
  const ports = portIds.map((id) => transportValue("port", command(["catalog", "show", id])));
  for (const port of ports) assert.equal(port.source_profile, profileId);
  assert.equal((await fileIdentity(original)).sha256, before.sha256);
  // Raw original/runtime files must not be added to public artifact lists.
  return {
    before,
    copy,
    owned,
    preview,
    ports,
    operatorRuntimeObservation: runtimeObservation === "operator",
  };
}

type Fixture = Awaited<ReturnType<typeof prepareRegisteredSourceReuseInputs>>;
interface Context extends ScenarioContext {
  library: string;
  cli: string;
  fixture: Fixture;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  application: string;
  ownedGameProcess: AcquisitionGameObserver;
  ownedLaunchSessions: () => LaunchSessionRecord[];
}

export async function registeredSourceReuseScenario(context: Context) {
  const { browser, output, artifacts, library, cli, fixture, confirmNative } = context;
  await context.scenario(scenarioId, async () => {
    const command = ownedFixtureCommand({ cli, library, output });
    const routes: Record<string, unknown>[] = [];
    const report: Record<string, unknown> = {
      scope: scenarioId,
      input: fixture.preview,
      runtime_observation_mode: fixture.operatorRuntimeObservation ? "operator" : "automatic",
      routes,
    };
    const { button, click } = reviewControls(browser);
    const snapshot = async (name: string, target: Parameters<typeof captureKeyboardTarget>[2]) =>
      captureKeyboardTarget({ browser, output, artifacts }, name, target, scenarioId);
    const sources = () => transportValues("source", command(["source", "list"]));
    try {
      assert.deepEqual(sources(), []);
      await selectPrimaryNavigation(browser, "Library");
      await click(button("Add games"));
      await click(By.css('button[aria-label="Choose a game or port"]'));
      const search = await browser.wait(until.elementLocated(By.id("port-search")), 15000);
      await search.sendKeys(fixture.ports[0]!.name);
      const projectDescription = `Port project: ${fixture.ports[0]!.name} · ${portIds[0]}`;
      const option = await browser.wait(
        until.elementLocated(
          By.xpath(`//*[@role="option"][.//*[normalize-space(.)="${projectDescription}"]]`),
        ),
        15000,
      );
      await clickVisible(browser, option);
      await click(By.id("add-games-check-files"));
      await click(button("Choose game files to check"));
      await confirmNative(
        "Choose game files",
        "Open",
        "File name:",
        "d-first-original-picker",
        fixture.owned,
      );
      await click(button("Use current location"));
      const review = await browser.wait(
        until.elementLocated(By.css('[aria-label="Source import review"]')),
        15000,
      );
      await snapshot("d-first-original-review", await review.findElement(By.css("h3")));
      await clickVisible(
        browser,
        await review.findElement(By.xpath('.//button[normalize-space(.)="Use current location"]')),
      );
      await browser.wait(() => sources().length === 1, 30000);
      await click(button("Return to game"));
      const initial = sources()[0]!;
      assert.equal(initial.sha256, fixture.preview.source.sha256);
      assert.equal(
        path.win32.toNamespacedPath(initial.path).toLowerCase(),
        path.win32.toNamespacedPath(fixture.owned).toLowerCase(),
      );
      report.registration = initial;
      // The first and alternative actual installation/Play decisions remain
      // required; no Core or IPC mutation may replace these Desktop operations.
      report.first = await installRegisteredSourceAndPlay(
        context,
        fixture.ports[0]!,
        initial,
        report,
        "first",
      );

      await selectPrimaryNavigation(browser, "Library");
      await click(button("Add games"));
      const saved = await browser.wait(
        until.elementLocated(By.css('[aria-label="Reuse saved game files"]')),
        15000,
      );
      const select = await saved.findElement(By.css("select"));
      await (await select.findElement(By.css(`option[value="${profileId}"]`))).click();
      assert.equal(await select.getAttribute("value"), profileId);
      await clickVisible(
        browser,
        await saved.findElement(By.xpath('.//button[normalize-space(.)="Check saved game files"]')),
      );
      const choiceHeading = await browser.wait(
        until.elementLocated(
          By.xpath(
            '//*[@aria-label="Reuse saved game files"]//h4[normalize-space(.)="Choose an implementation for these files"]',
          ),
        ),
        30000,
      );
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (element) => document.activeElement === element,
            choiceHeading,
          ),
        5000,
      );
      report.saved_choice_focus = "checked heading";
      const alternative = await browser.wait(
        until.elementLocated(button(`Review ${fixture.ports[1]!.name} setup using these files`)),
        30000,
      );
      await captureAccessibilityReport(
        browser,
        path.join(output, "d-saved-source-accessibility.json"),
        artifacts,
      );
      await snapshot("d-alternative-saved-original-choice", alternative);
      assert.deepEqual(sources(), [initial]);
      await alternative.sendKeys(Key.ENTER);
      report.alternative = await installRegisteredSourceAndPlay(
        context,
        fixture.ports[1]!,
        initial,
        report,
        "alternative",
      );
      assert.deepEqual(sources(), [initial]);
      report.original_preserved =
        (await fileIdentity(fixture.before.path)).sha256 === fixture.before.sha256;
      assert.equal(report.original_preserved, true);
      const installsBeforeRepair = fixture.ports.map(
        (port) => transportValue("status", command(["status", port.id])).active,
      );
      assert.ok(installsBeforeRepair.every(Boolean));
      // Both installRegisteredSourceAndPlay calls returned only after identity-bound game and supervisor exit.

      const ownedOriginal = await lstat(fixture.owned);
      assert.ok(ownedOriginal.isFile() && !ownedOriginal.isSymbolicLink());
      assert.equal(ownedOriginal.nlink, 1, "Only the independent owned copy may be moved");
      assertOwnedSelectedSetupPath(
        await realpath(fixture.owned),
        path.join(await realpath(output), "d-majoras-mask-original.zip"),
      );
      report.moved_file_ownership = {
        regular: true,
        symbolic_link: false,
        links: ownedOriginal.nlink,
      };
      const moved = path.join(output, "d-majoras-mask-moved.zip");
      await rename(fixture.owned, moved);
      await selectPrimaryNavigation(browser, "Library");
      await click(button("Add games"));
      const repairSection = await browser.wait(
        until.elementLocated(By.css('[aria-label="Reuse saved game files"]')),
        15000,
      );
      await (await repairSection.findElement(By.css(`option[value="${profileId}"]`))).click();
      await clickVisible(
        browser,
        await repairSection.findElement(
          By.xpath('.//button[normalize-space(.)="Check saved game files"]'),
        ),
      );
      const missing = transportValue(
        "source_reuse_review",
        command(["source", "reuse", profileId], undefined, { timeoutMs: 60_000 }),
      );
      assert.ok(missing.applications.every((app) => !app.can_review_setup));
      report.missing = missing;
      await clickVisible(
        browser,
        await repairSection.findElement(
          By.xpath('.//button[normalize-space(.)="Repair moved file location"]'),
        ),
      );
      await confirmNative(
        "Choose game files",
        "Open",
        "File name:",
        "d-moved-original-picker",
        moved,
      );
      await browser.wait(() => {
        const savedPath = sources()[0]?.path;
        return (
          savedPath !== undefined &&
          path.win32.toNamespacedPath(savedPath).toLowerCase() ===
            path.win32.toNamespacedPath(moved).toLowerCase()
        );
      }, 30000);
      const repaired = sources()[0]!;
      for (const key of ["profile_id", "sha256", "size", "storage_sha256", "storage_size"] as const)
        assert.equal(repaired[key], initial[key]);
      report.repaired = repaired;
      assert.deepEqual(
        fixture.ports.map((port) => transportValue("status", command(["status", port.id])).active),
        installsBeforeRepair,
      );
      const repairedNotice = await browser.wait(
        until.elementLocated(
          By.xpath(
            '//*[@aria-label="Reuse saved game files"]//*[@role="status"][contains(.,"Location repaired")]',
          ),
        ),
        15000,
      );
      await snapshot("d-moved-identical-repair", repairedNotice);

      const substituted = path.join(output, "d-controlled-substituted.z64");
      await writeFile(substituted, Buffer.from([0x80, 0x37, 0x12, 0x40, 0x01, 0x02, 0x03]), {
        flag: "wx",
      });
      const substitutedMetadata = await lstat(substituted);
      assert.ok(substitutedMetadata.isFile() && !substitutedMetadata.isSymbolicLink());
      assert.equal(substitutedMetadata.nlink, 1);
      assertOwnedSelectedSetupPath(
        await realpath(substituted),
        path.join(await realpath(output), "d-controlled-substituted.z64"),
      );
      await clickVisible(
        browser,
        await repairSection.findElement(
          By.xpath('.//button[normalize-space(.)="Repair moved file location"]'),
        ),
      );
      await confirmNative(
        "Choose game files",
        "Open",
        "File name:",
        "d-substituted-original-picker",
        substituted,
      );
      const refusal = await browser.wait(
        until.elementLocated(By.css('[aria-label="Reuse saved game files"] [role="alert"]')),
        15000,
      );
      report.substituted_refusal = await refusal.getText();
      assert.match(String(report.substituted_refusal), /identity|different|changed|match/i);
      assert.deepEqual(sources(), [repaired]);
      assert.deepEqual(
        fixture.ports.map((port) => transportValue("status", command(["status", port.id])).active),
        installsBeforeRepair,
      );
      await snapshot("d-substituted-input-refusal", refusal);
      await captureAccessibilityReport(
        browser,
        path.join(output, "d-repair-refusal-accessibility.json"),
        artifacts,
      );
      assert.equal((await fileIdentity(fixture.before.path)).sha256, fixture.before.sha256);
      assert.equal((await fileIdentity(moved)).sha256, fixture.copy.sha256);
      requireSuccessfulRegisteredRuntimeRoutes(routes);
    } finally {
      const receipt = path.join(output, "registered-source-reuse-desktop.json");
      await writeFile(receipt, JSON.stringify(report, null, 2), { flag: "wx" });
      artifacts.push(receipt);
    }
  });
}

function native<Mode extends NativeSessionMode>(
  mode: Mode,
  snapshot: string,
  extra: string[] = [],
) {
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
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return readNativeSessionObservation(mode, JSON.parse(result.stdout));
}

export async function installRegisteredSourceAndPlay(
  context: Context,
  port: PortDefinition,
  original: SourceRecord,
  report: Record<string, unknown>,
  role: "first" | "alternative",
) {
  const { browser, output, artifacts, cli, library } = context;
  const command = ownedFixtureCommand({ cli, library, output });
  const status = () => transportValue("status", command(["status", port.id]));
  const route: Record<string, unknown> = { port_id: port.id, role, stage: "review" };
  assert.ok(Array.isArray(report.routes));
  report.routes.push(route);
  try {
    const dialogSelector = By.css('[role="dialog"][aria-describedby="install-review-description"]');
    if (role === "first" && !(await browser.findElements(dialogSelector)).length) {
      const firstReview = await browser.wait(
        until.elementLocated(By.css('button[data-detail-origin="add-games:selected-setup"]')),
        15000,
      );
      await clickVisible(browser, firstReview);
    }
    const review = await browser.wait(until.elementLocated(dialogSelector), 30000);
    route.install_review = await review.getText();
    assert.ok(String(route.install_review).includes(port.name));
    await captureKeyboardTarget(
      { browser, output, artifacts },
      `${port.id}-d-install-review`,
      await review.findElement(By.id("install-review-title")),
      scenarioId,
    );
    const reviewTitle = await review.findElement(By.id("install-review-title"));
    await browser.wait(
      () =>
        executeBrowserScript(browser, (element) => document.activeElement === element, reviewTitle),
      5000,
    );
    route.review_focus = "install-review-title";
    const install = await review.findElement(By.css('button[data-variant="primary"]'));
    await browser.wait(until.elementIsEnabled(install), 5000);
    route.stage = "install";
    await clickVisible(browser, install);
    const installed = await browser.wait(() => status().active || false, 480000);
    assert.ok(installed);
    route.installed = installed;
    assert.deepEqual(transportValues("source", command(["source", "list"])), [original]);
    const executable = path.join(installed.path, installed.selected_executable);
    const generatedArchive = path.join(installed.path, "mm.o2r");
    const inspectGeneratedArchive = async () => {
      const metadata = await lstat(generatedArchive).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata) return undefined;
      assert.ok(
        metadata.isFile() && !metadata.isSymbolicLink(),
        "Owned generated archive must be a regular unlinked file",
      );
      return fileIdentity(generatedArchive);
    };
    if (port.id === "2ship2harkinian") {
      assert.equal(
        await inspectGeneratedArchive(),
        undefined,
        "First owned startup must not borrow a preexisting mm.o2r",
      );
      route.upstream_archive_preexisted = false;
    }
    const executableIdentity = await fileIdentity(executable);
    const appIdentity = await fileIdentity(context.application);
    const play = await browser.wait(async () => {
      const candidates = await browser.findElements(By.css(".actions.primary-actions > button"));
      const ready = [];
      for (const candidate of candidates)
        if (
          (await candidate.isDisplayed()) &&
          (await candidate.isEnabled()) &&
          /^(Play|Try launch)$/.test((await candidate.getText()).trim())
        )
          ready.push(candidate);
      assert.ok(ready.length <= 1);
      return ready[0] || false;
    }, 30000);
    assert.ok(play);
    route.actual_launch_label = await play.getText();
    route.stage = "launch";
    await clickVisible(browser, play);
    const game = { executable, installation: installed };
    let capture = 0;
    const running = await browser.wait(
      () => context.ownedGameProcess.capture(game, `${port.id}-d-running-${++capture}`) || false,
      30000,
    );
    assert.ok(running);
    // Core retains extended-length paths; the Windows process inventory reports
    // ordinary image paths. Bind both to the same image before passing the
    // observed spelling to the existing strict native snapshot/close checks.
    const observedExecutable = running.identity.path;
    assert.equal(
      path.win32.toNamespacedPath(observedExecutable).toLowerCase(),
      path.win32.toNamespacedPath(executable).toLowerCase(),
    );
    const observedExecutableIdentity = await fileIdentity(observedExecutable);
    assert.equal(observedExecutableIdentity.sha256, executableIdentity.sha256);
    assert.equal(observedExecutableIdentity.bytes, executableIdentity.bytes);
    const candidates = context
      .ownedLaunchSessions()
      .filter(
        (session) =>
          session.port_id === port.id &&
          session.install_id === installed.id &&
          session.child_pid === running.identity.pid &&
          session.child_identity === `windows-filetime:${running.identity.started_filetime}`,
      );
    assert.equal(candidates.length, 1);
    const session = candidates[0]!;
    assert.equal(session.owner_kind, "managed");
    assert.equal(session.phase, "running");
    assert.equal(session.outcome, null);
    assert.ok(session.supervisor_pid && session.supervisor_identity);
    route.running = session;
    const supervisorFile = path.join(output, `${port.id}-d-supervisor.json`);
    const supervisor = native("SnapshotDriver", supervisorFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
    ]);
    artifacts.push(supervisorFile);
    assert.equal(
      `windows-filetime:${supervisor.driver.started_filetime}`,
      session.supervisor_identity,
    );
    assert.equal((await fileIdentity(supervisor.driver.path)).sha256, appIdentity.sha256);
    const gameFile = path.join(output, `${port.id}-d-game.json`);
    const capturedGame = native("SnapshotApplication", gameFile, [
      "-DriverProcessId",
      String(session.child_pid),
      "-ExpectedParentProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      observedExecutable,
      "-ExpectedApplicationSha256",
      executableIdentity.sha256,
    ]);
    artifacts.push(gameFile);
    assert.equal(
      `windows-filetime:${capturedGame.driver.started_filetime}`,
      session.child_identity,
    );
    const closeFile = path.join(output, `${port.id}-d-close.json`);
    const close = native("Snapshot", closeFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      observedExecutable,
    ]);
    artifacts.push(closeFile);
    assert.deepEqual(close.driver, supervisor.driver);
    assert.equal(close.application_pid, session.child_pid);
    assert.deepEqual(
      close.processes.find((entry) => entry.pid === session.child_pid),
      capturedGame.driver,
    );
    route.actual_game = { executableIdentity, supervisor, capturedGame, close };
    if (port.id === "2ship2harkinian") {
      route.stage = "upstream-startup-preparation";
      route.upstream_generated_archive = await observeRegisteredRuntimeStartup({
        session,
        readSession: () =>
          transportValue("launch_request", command(["launch", "show", session.id])),
        inspectArchive: inspectGeneratedArchive,
        wait: (observe, timeout) => browser.wait(observe, timeout, undefined, 2000),
      });
    }
    // Actual runtime rendering/input observations remain separately identified;
    // neither an App screenshot nor these Core/process records imply gameplay.
    if (context.fixture.operatorRuntimeObservation) {
      route.stage = "operator-runtime-observation";
      route.runtime_close_mode = "external-operator-observation";
      await observeRegisteredRuntimeExit({
        session,
        snapshot: gameFile,
        native,
        route,
        wait: (observe, timeout) => browser.wait(observe, timeout, undefined, 2000),
      });
      // Operator intent and rendered frames require their separate actual UI
      // observations. Process exit alone cannot establish either claim.
    } else {
      route.stage = "normal-close";
      await requestRealRuntimeClose({
        native,
        closeFile,
        executable: observedExecutable,
        requestFile: path.join(output, `${port.id}-d-close-request.json`),
        route,
        artifacts,
        write: writeFile,
      });
    }
    const terminal = await browser.wait(() => {
      const current = transportValue("launch_request", command(["launch", "show", session.id]));
      return current?.outcome !== null && current?.finished_at ? current : false;
    }, 30000);
    assert.ok(terminal);
    route.terminal = terminal;
    const supervisorExitFile = path.join(output, `${port.id}-d-supervisor-exit-input.json`);
    await writeFile(
      supervisorExitFile,
      JSON.stringify(
        {
          ...supervisor,
          source_snapshot: path.basename(supervisorFile),
          derivation: "verified-supervisor-only-exit-observation",
          processes: [supervisor.driver],
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(supervisorExitFile);
    route.stage = "supervisor-exit";
    route.supervisor_exit = native("Wait", supervisorExitFile);
    assert.deepEqual(transportValues("source", command(["source", "list"])), [original]);
    const sourceAfterExit = await fileIdentity(original.path);
    assert.match(original.storage_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(sourceAfterExit.sha256, original.storage_sha256);
    assert.equal(sourceAfterExit.bytes, original.storage_size);
    route.original_storage_after_exit = sourceAfterExit;
    retainSettledRuntimeOutcome(route, terminal);
    return route;
  } catch (error) {
    route.failure = { stage: route.stage, message: errorMessage(error) };
    throw error;
  }
}
