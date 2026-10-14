// Actual Tauri/Core journey; synthetic source and first-party probe, never a game qualification.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { assertOwnedSelectedSetupPath } from "./desktop-source-dialog-test.mjs";
import {
  assertCompactReview,
  assertPrimaryReviewAction,
  captureAccessibilityReport,
  reviewControls,
} from "./desktop-review-controls.mjs";

export function observeCompletionReturnFocus() {
  const origin = document.querySelector('[data-detail-origin="game-file-libraries-setup"]');
  const continuation = origin?.querySelector('[aria-label="Continue to a game"]');
  const control = document.activeElement;
  if (
    ![
      origin?.isConnected,
      continuation?.isConnected,
      control?.isConnected,
      origin?.contains(control),
    ].every(Boolean)
  )
    return false;
  const available = (element) =>
    ![
      element.matches(":disabled, [aria-disabled=true]"),
      Boolean(element.closest("[hidden], [inert], [aria-hidden=true]")),
      element.getClientRects().length === 0,
      getComputedStyle(element).visibility === "hidden",
    ].some(Boolean);
  if (![origin, continuation, control].every(available)) return false;
  if (
    ![
      control === origin,
      control.matches("button, a[href], input, select, textarea, summary, [tabindex]"),
    ].some(Boolean)
  )
    return false;
  return { tag: control.tagName, id: control.id, origin: control === origin };
}

export async function assertCompletionCoreParity({ read, core, portId, prepared, observations }) {
  // Installation reinspects the source; retain both snapshots and compare the current record.
  observations.completed_sources = await read("get_sources");
  assert.ok(Array.isArray(observations.sources) && observations.sources.length > 0);
  assert.ok(Array.isArray(observations.completed_sources));
  assert.equal(observations.completed_sources.length, observations.sources.length);
  assert.deepEqual(core(["status", portId]), prepared);
  assert.deepEqual(core(["source", "list"]), observations.completed_sources);
}

export async function retainCompletionReport({
  file,
  report,
  artifacts,
  failure,
  write = writeFile,
  log = console.error,
}) {
  let artifactFailure;
  try {
    await write(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    artifacts.push(file);
  } catch (error) {
    artifactFailure = error;
    report.artifact_write_failure = String(error);
    try {
      log(JSON.stringify({ report, artifact_write_failure: String(error) }));
    } catch (logError) {
      report.fallback_log_failure = String(logError);
    }
  }
  // Artifact or fallback failures never replace the original journey error.
  if (failure) throw failure;
  if (artifactFailure) throw artifactFailure;
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
}) {
  await scenario("native-selected-setup-completion", async () => {
    assert.equal(fixture?.completionJourney, true);
    assert.equal(typeof restartApplication, "function");
    const owned = fixture.sourceJourney;
    const port = fixture.port;
    const { button, click } = reviewControls(browser);
    const coreEnvironment = {
      ...process.env,
      PORTCOVE_QUALIFICATION_CATALOG: fixture.catalogPath,
      PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
    };
    const coreArguments = ["--library", library, "--json", "--non-interactive"];
    const requireSuccess = (envelope, payload, details) => {
      assert.equal(envelope.ok, true, details);
      return envelope[payload];
    };
    const core = (args) => {
      const execution = spawnCommand(cli, coreArguments.concat(args), {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: coreEnvironment,
      });
      assert.equal(execution.error, undefined);
      assert.equal(execution.status, 0, execution.stderr || execution.stdout);
      return requireSuccess(JSON.parse(execution.stdout), "data", execution.stderr);
    };
    const read = async (name, args) => {
      const envelope = await invoke(name, args);
      return requireSuccess(envelope, "value", JSON.stringify(envelope.error));
    };
    const status = async () =>
      (await read("get_statuses")).find((item) => item.port_id === port.id);
    const activity = async (operation, terminal) =>
      (await read("get_activities")).records.find(
        (item) =>
          item.operation === operation && item.target_id === port.id && item.status === terminal,
      );
    const screenshot = async (name) => {
      const file = path.join(output, `${name}.png`);
      await writeFile(file, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(file);
      const window = await browser.manage().window().getRect();
      const viewport = await browser.executeScript(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
      }));
      assert.ok(window.width > 0 && window.height > 0 && viewport.width > 0 && viewport.height > 0);
      (report.observations.geometry ??= {})[name] = { window, viewport };
    };
    const report = {
      scope: `${process.platform} synthetic selected setup: ordinary install, inert N64 preparation, BIOS-plus-game review and saved-input restart`,
      limitations: [
        fixture.nativeConnectionJourney
          ? "Folder connections use the actual native picker; the bounded scan pre-state uses the CLI"
          : "Saved root seeded by the existing CLI; native picker credited separately",
        "No real game, BIOS preparation, gameplay, full representation matrix or other platform qualification",
      ],
      port_id: port.id,
      observations: {},
    };
    let failure;
    try {
      assert.deepEqual(await read("get_sources"), []);
      assert.equal((await status()).active, null, "No adopted installation may seed completion");
      if (fixture.nativeConnectionJourney) {
        assert.equal(typeof chooseGameFileFolder, "function");
        assert.deepEqual(await read("get_game_file_roots"), []);
        const connection = By.css('[aria-label="Connect your game files"] button');
        await browser.wait(until.elementLocated(connection), 5_000);
        await screenshot("initial-folder-connection");
        await click(connection);
        await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
        await browser.wait(
          async () =>
            browser.executeScript(
              () =>
                document.activeElement?.getAttribute("data-settings-control") ===
                "add-game-file-root",
            ),
          5_000,
        );
        await click(button("Add folder"));
        report.observations.folder_picker_cancel =
          await chooseGameFileFolder("game-file-picker-cancel");
        assert.equal(report.observations.folder_picker_cancel.cancelled, true);
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
        const first = (await read("get_game_file_roots"))[0];
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
        const second = (await read("get_game_file_roots")).find((root) => root.id !== first.id);
        assertOwnedSelectedSetupPath(second.path, extra);
        const rootAction = (name) =>
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
        const relinked = (await read("get_game_file_roots")).find((root) => root.id === second.id);
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
        const initial = core(["source", "roots", "scan", "--max-entries", "2"]);
        assert.equal(initial.coverage.batches, 1);
        assert.equal(initial.coverage.can_resume, true);
        await screenshot("connected-folder-management");
      } else await click(By.xpath('//nav//button[contains(., "Settings")]'));
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      const initialSnapshot = await read("get_game_file_scan_snapshot");
      assert.equal(initialSnapshot.coverage.batches, 1);
      assert.equal(initialSnapshot.coverage.can_resume, true);
      assert.equal(initialSnapshot.coverage.restart_required, false);
      assert.equal(initialSnapshot.limits.max_entries, 2);
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
      const snapshot = await read("get_game_file_scan_snapshot");
      assert.equal(snapshot.freshness, "inputs_match");
      assert.equal(snapshot.coverage.batches, 2);
      assert.equal(snapshot.coverage.frontier_exhausted, true);
      assert.equal(snapshot.coverage.can_resume, false);
      assert.equal(snapshot.coverage.restart_required, false);
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
      const choices = [fixture.port, fixture.refreshPort, owned.reviewPort]
        .map((item) => `Open ${item.name} details`)
        .sort();
      await browser.wait(
        async () =>
          browser.executeScript((choices) => {
            const section = document.querySelector('[aria-label="Continue to a game"]');
            const buttons = [...(section?.querySelectorAll("button") ?? [])];
            return (
              !document.querySelector('[aria-label="Source import review"]') &&
              buttons.length === choices.length &&
              buttons.every(
                (item) => !item.disabled && choices.includes(item.textContent.trim()),
              ) &&
              section.contains(document.activeElement)
            );
          }, choices),
        15_000,
        "Registration must focus the independent port choices",
      );
      report.observations.sources = await read("get_sources");
      assert.equal(report.observations.sources.length, 1);
      assert.equal(report.observations.sources[0].profile_id, owned.profiles[0]);
      assert.deepEqual(core(["source", "list"]), report.observations.sources);
      const incomplete = (await read("get_statuses")).find(
        (item) => item.port_id === fixture.refreshPort.id,
      );
      assert.ok(incomplete.readiness.blockers.includes("missing_bios"));
      const queue = By.css('[aria-label="Selected setup reviews"]');
      await browser.wait(until.elementLocated(queue), 5_000);
      const beforeSelection = await read("get_statuses");
      for (const id of [port.id, owned.reviewPort.id])
        await click(By.css(`input[data-setup-review-port="${id}"]`));
      assert.deepEqual(await read("get_statuses"), beforeSelection, "Selection grants no mutation");
      report.observations.setup_selection = [port.id, owned.reviewPort.id];
      await click(button(`Review ${port.name} setup`));
      await browser.wait(until.elementLocated(By.id("port-detail-title")), 5_000);
      assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);
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
      await browser.actions().sendKeys(Key.ESCAPE).perform();
      await browser.wait(
        async () => (await browser.findElements(installDialog)).length === 0,
        5_000,
      );
      await browser.wait(
        () =>
          browser.executeScript(
            'return document.activeElement?.textContent?.trim() === "Review installation";',
          ),
        5_000,
      );
      assert.deepEqual(await status(), beforeReview, "Dismissal must preserve authoritative state");
      assert.equal(fixture.requests.length, 0);

      if (fixture.nativeConnectionJourney) {
        await openInstall();
        report.observations.controller_review = await browser.executeAsyncScript(
          async (installControl, done) => {
            const originalPads = navigator.getGamepads;
            const originalMode = document.documentElement.dataset.inputMode;
            let pressed = [];
            const frames = async (count) => {
              for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame);
            };
            let observation;
            try {
              const review = document.querySelector('[aria-labelledby="install-review-title"]');
              if (!review || !document.hasFocus())
                throw new Error("Actual setup review must own native focus");
              navigator.getGamepads = () => [
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
              await frames(2);
              const beforeDirection = document.activeElement;
              if (beforeDirection !== installControl || !review.contains(installControl))
                throw new Error("Actual primary Install control must own initial review focus");
              pressed = [15];
              await frames(2);
              const stayedInReview = review.contains(document.activeElement);
              const movedToCancel =
                document.activeElement !== beforeDirection &&
                document.activeElement?.textContent?.trim() === "Cancel review";
              pressed = [];
              await frames(2);
              pressed = [1];
              await frames(4);
              observation = {
                method: "injected controller adapter on actual setup components",
                stayed_in_top_review: stayedInReview,
                moved_to_cancel_review: movedToCancel,
                dismissed_review: !document.querySelector(
                  '[aria-labelledby="install-review-title"]',
                ),
                stayed_in_game_details: Boolean(document.querySelector("#port-detail-title")),
                focus: document.activeElement?.textContent?.trim(),
              };
            } catch (error) {
              observation = { error: String(error) };
            } finally {
              navigator.getGamepads = originalPads;
              if (originalMode === undefined) delete document.documentElement.dataset.inputMode;
              else document.documentElement.dataset.inputMode = originalMode;
            }
            done(observation);
          },
          await browser.findElement(install),
        );
        assert.equal(report.observations.controller_review.error, undefined);
        assert.equal(report.observations.controller_review.stayed_in_top_review, true);
        assert.equal(report.observations.controller_review.moved_to_cancel_review, true);
        assert.equal(report.observations.controller_review.dismissed_review, true);
        assert.equal(report.observations.controller_review.stayed_in_game_details, true);
        await browser.wait(
          () =>
            browser.executeScript(
              'return document.activeElement?.textContent?.trim() === "Review installation";',
            ),
          5_000,
        );
        assert.deepEqual(await status(), beforeReview);
        assert.equal(fixture.requests.length, 0);
      }

      await openInstall();
      await browser.findElement(install).click();
      await browser.wait(() => fixture.requests[0]?.bytes_sent > 0, 15_000);
      const running = await browser.wait(() => activity("install", "running"), 15_000);
      assert.equal(running.cancellation.requested, false);
      await click(button("Cancel operation"));
      const cancelled = await browser.wait(() => activity("install", "cancelled"), 15_000);
      assert.equal(cancelled.id, running.id);
      assert.equal(cancelled.failure.code, "cancelled");
      await browser.wait(() => fixture.requests[0].connection_closed, 10_000);
      assert.equal(fixture.requests[0].completed, false);
      assert.ok(fixture.requests[0].bytes_sent < fixture.artifact.length);
      const cancelledStatus = await status();
      assert.equal(cancelledStatus.active, null);
      assert.equal(cancelledStatus.staged, null);
      await assert.rejects(stat(path.join(library, "staging", running.id)), { code: "ENOENT" });
      report.observations.cancelled = { activity: cancelled, status: cancelledStatus };

      await browser.wait(until.elementLocated(button("Review installation")), 15_000);
      await openInstall();
      await browser.findElement(install).click();
      const installedActivity = await browser.wait(() => activity("install", "succeeded"), 30_000);
      assert.notEqual(installedActivity.id, cancelled.id);
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.requests[1].completed, true);
      assert.equal(fixture.requests[1].bytes_sent, fixture.artifact.length);
      const installed = await status();
      assert.ok(installed.active);
      assert.equal(installed.active.artifact.sha256, port.release.direct[port.platforms[0]].sha256);
      assert.equal(
        installed.readiness.launchable,
        false,
        "Installation must not imply prepared game data",
      );
      report.observations.installed = { activity: installedActivity, status: installed };

      await click(button("Review game preparation"));
      const preparationDialog = By.css('[aria-labelledby="preparation-review-title"]');
      await browser.wait(until.elementLocated(preparationDialog), 15_000);
      await browser.wait(
        until.elementIsEnabled(await browser.findElement(button("Prepare game data"))),
        15_000,
      );
      await assertCompactReview(browser, '[aria-labelledby="preparation-review-title"]');
      assert.equal(
        (await status()).active.id,
        installed.active.id,
        "Preparation review must not mutate",
      );
      const priorPreparationIds = new Set(
        (await read("get_activities")).records
          .filter((item) => item.operation === "prepare" && item.target_id === port.id)
          .map((item) => item.id),
      );
      await click(button("Prepare game data"));
      const { status: prepared, activity: completedPreparation } = await browser.wait(
        async () => {
          const value = await status();
          const records = (await read("get_activities")).records.filter(
            (item) =>
              item.operation === "prepare" &&
              item.target_id === port.id &&
              !priorPreparationIds.has(item.id),
          );
          const terminal = records.find((item) => item.status === "succeeded");
          const closed = (await browser.findElements(preparationDialog)).length === 0;
          if (!value.readiness.launchable || !terminal || !closed) return false;
          assert.equal(
            records.length,
            1,
            "One deliberate preparation must produce exactly one new operation",
          );
          return { status: value, activity: terminal };
        },
        15_000,
        "The new Core preparation must reach terminal success, readiness and a closed review",
      );
      assert.notEqual(prepared.active.id, installed.active.id);
      assert.equal(prepared.previous.id, installed.active.id);
      assert.equal(
        await readFile(path.join(prepared.active.path, port.setup_marker), "utf8"),
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
      await browser.wait(until.elementLocated(button("Play")), 15_000);
      await browser.wait(until.elementIsEnabled(await browser.findElement(button("Play"))), 15_000);
      report.observations.result_focus = await browser.wait(
        () =>
          browser.executeScript((name) => {
            const detail = document.querySelector("[data-detail-workspace]");
            const control = document.activeElement;
            const selectedDetail =
              document.querySelector("#port-detail-title")?.textContent?.trim() === name;
            const settled =
              document.querySelector('[aria-labelledby="preparation-review-title"]') === null;
            const belongs = [control?.isConnected, detail?.contains(control)].every(Boolean);
            if (![selectedDetail, settled, belongs].every(Boolean)) return false;
            const actionable = control.matches(
              "button, a[href], input, select, textarea, summary, [tabindex]",
            );
            const blocked = [
              control.matches(":disabled, [aria-disabled=true]"),
              Boolean(control.closest("[hidden], [inert], [aria-hidden=true]")),
              control.getClientRects().length === 0,
              getComputedStyle(control).visibility === "hidden",
            ].some(Boolean);
            if (!actionable || blocked) return false;
            return {
              tag: control.tagName,
              id: control.id,
              text: control.textContent?.trim(),
              ariaLabel: control.getAttribute("aria-label"),
            };
          }, port.name),
        5_000,
        "Preparation must restore natural focus to a visible enabled control in the selected detail workspace",
      );
      await screenshot("selected-setup-prepared");
      await click(By.css('[aria-label="Back to previous workspace"]'));
      await browser.wait(until.elementLocated(continuation), 5_000);
      report.observations.return_focus = await browser.wait(
        () => browser.executeScript(observeCompletionReturnFocus),
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
      const returnedAlternative = (await read("get_statuses")).find(
        (item) => item.port_id === owned.reviewPort.id,
      );
      assert.equal(returnedAlternative.active, null);
      assert.equal(Boolean(returnedAlternative.external_runtime), false);
      assert.ok(
        returnedAlternative.port_actions.some(
          (item) => item.action === "install" && item.availability === "allowed",
        ),
      );
      const returnedSnapshot = await read("get_game_file_scan_snapshot");
      assert.equal(returnedSnapshot.freshness, "inputs_match");
      await browser.wait(
        async () => {
          const controls = await browser.findElements(
            button(`Review ${owned.reviewPort.name} setup`),
          );
          return controls.length === 1 && (await controls[0].isEnabled());
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
      await click(button(`Review ${owned.reviewPort.name} setup`));
      await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="install-review-title"]')),
        15_000,
      );
      assert.equal(
        await browser.findElement(By.id("port-detail-title")).getText(),
        owned.reviewPort.name,
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
      await click(By.css('[aria-label="Back to previous workspace"]'));
      await browser.wait(until.elementLocated(queue), 5_000);
      assert.match(await browser.findElement(queue).getText(), /2 of 16 ports selected/);
      await screenshot("selected-setup-queue-return");
      const accessibilityFile = path.join(output, "selected-setup-completion-accessibility.json");
      await captureAccessibilityReport(browser, accessibilityFile, artifacts);
      const accessibility = JSON.parse(await readFile(accessibilityFile, "utf8"));
      const resultBadges = await browser.findElements(By.css(".source-result"));
      const displayedBadges = await Promise.all(resultBadges.map((badge) => badge.isDisplayed()));
      assert.ok(displayedBadges.some(Boolean), "An actual source result must be displayed for axe");
      const prohibitedAttributes = [
        ...accessibility.violations,
        ...accessibility.incomplete,
      ].filter((item) => item.id === "aria-prohibited-attr");
      report.observations.source_result_accessibility = {
        rule: "aria-prohibited-attr",
        unresolved: prohibitedAttributes.length,
      };
      assert.deepEqual(
        prohibitedAttributes,
        [],
        "The visible source result must not retain prohibited or unresolved ARIA attributes",
      );
      // The game remains registered outside this new root. Only a newly found
      // BIOS can associate the incomplete port with the next setup selection.
      const biosOnly = path.join(owned.directory, "bios-only");
      const biosOnlyPath = path.join(biosOnly, "bios.pcbios");
      await mkdir(biosOnly);
      await writeFile(biosOnlyPath, await readFile(owned.biosBefore), { flag: "wx" });
      const rootsBefore = await read("get_game_file_roots");
      assert.equal(rootsBefore.length, 1);
      assertOwnedSelectedSetupPath(rootsBefore[0].path, owned.directory);
      const relinked = core(["source", "roots", "relink", rootsBefore[0].id, biosOnly]);
      assert.equal(relinked.id, rootsBefore[0].id);
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
          assertOwnedSelectedSetupPath(observations.report.candidates[0].path, biosOnlyPath);
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
      const blocked = beforeBiosRegistration.find(
        (item) => item.port_id === fixture.refreshPort.id,
      );
      assert.equal(
        blocked.port_actions.find((item) => item.action === "install").reason,
        "missing_bios",
      );
      assert.equal(
        (
          await browser.findElements(
            By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`),
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
          const completed = statuses.find((item) => item.port_id === fixture.refreshPort.id);
          const allowed = completed.port_actions.some(
            (item) => item.action === "install" && item.availability === "allowed",
          );
          const choices = await browser.findElements(
            By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`),
          );
          return allowed && choices.length === 1 && (await choices[0].isEnabled());
        },
        15_000,
        "Explicit BIOS registration must expose the actual Core-eligible selection",
      );
      const biosSources = await read("get_sources");
      assert.equal(biosSources.length, 2);
      assertOwnedSelectedSetupPath(
        biosSources.find((item) => item.profile_id === owned.profiles[0]).path,
        owned.gamePath,
      );
      assertOwnedSelectedSetupPath(
        biosSources.find((item) => item.profile_id === owned.profiles[1]).path,
        biosOnlyPath,
      );
      assert.deepEqual(core(["source", "list"]), biosSources);
      await click(By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`));
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
      await click(By.css('[aria-label="Back to previous workspace"]'));
      await browser.wait(until.elementLocated(queue), 5_000);
      assert.match(await browser.findElement(queue).getText(), /3 of 16 ports selected/);
      report.observations.bios_return_focus = await browser.wait(
        () => browser.executeScript(observeCompletionReturnFocus),
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
          return controls.length === 1 && (await controls[0].isEnabled());
        },
        15_000,
        "The fresh return read must restore the Core-eligible BIOS review",
      );
      report.observations.bios_settled_return = {
        snapshot: await read("get_game_file_scan_snapshot"),
        review_enabled: true,
        selected_count: 3,
      };
      assert.equal(report.observations.bios_settled_return.snapshot.freshness, "inputs_match");
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.equal(fixture.requests.length, acquisitionsBeforeBiosPlan);
      await screenshot("selected-setup-bios-settled-return");

      const rootsBeforeRestart = await read("get_game_file_roots");
      browser = await restartApplication("selected-setup-inputs");
      const { button: restartButton, click: restartClick } = reviewControls(browser);
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.deepEqual(await read("get_game_file_roots"), rootsBeforeRestart);
      const restoredSnapshot = await read("get_game_file_scan_snapshot");
      assert.equal(restoredSnapshot.freshness, "inputs_match");
      assert.deepEqual(
        restoredSnapshot.report.candidates,
        report.observations.bios_only_scan.snapshot.report.candidates,
      );
      const restoredStatus = (await read("get_statuses")).find(
        (item) => item.port_id === fixture.refreshPort.id,
      );
      assert.equal(restoredStatus.active, null);
      assert.ok(
        restoredStatus.port_actions.some(
          (item) => item.action === "install" && item.availability === "allowed",
        ),
      );
      assert.deepEqual(core(["source", "list"]), biosSources);
      await restartClick(By.xpath('//nav//button[contains(., "Settings")]'));
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await browser.wait(
        async () => {
          const controls = await browser.findElements(
            By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`),
          );
          return controls.length === 1 && (await controls[0].isEnabled());
        },
        15_000,
        "Restart must recover the saved BIOS match and actual eligible setup choice",
      );
      const restoredChoice = await browser.findElement(
        By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`),
      );
      assert.equal(
        await restoredChoice.isSelected(),
        false,
        "Selection is ephemeral across restart",
      );
      assert.doesNotMatch(await browser.findElement(queue).getText(), /3 of 16 ports selected/);
      await restartClick(By.css(`input[data-setup-review-port="${fixture.refreshPort.id}"]`));
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
      await restartClick(restartButton("Cancel review"));
      await browser.wait(
        async () => (await browser.findElements(installDialog)).length === 0,
        5_000,
      );
      assert.deepEqual(await read("get_sources"), biosSources);
      assert.equal(fixture.requests.length, acquisitionsBeforeBiosPlan);
      assert.equal(
        (await read("get_statuses")).find((item) => item.port_id === fixture.refreshPort.id).active,
        null,
      );
      await captureAccessibilityReport(
        browser,
        path.join(output, "selected-setup-bios-restart-accessibility.json"),
        artifacts,
      );
    } catch (error) {
      failure = error;
      report.failure = { message: error.message, stack: error.stack };
    }
    let preservationFailure;
    try {
      for (const [actual, original] of [
        ["gamePath", "gameBefore"],
        ["biosPath", "biosBefore"],
      ])
        assert.deepEqual(
          await readFile(owned[actual]),
          await readFile(owned[original]),
          "Original player inputs must remain unchanged",
        );
      report.original_inputs_preserved = true;
    } catch (error) {
      preservationFailure = error;
      report.preservation_failure = error.message;
    }
    const file = path.join(output, "selected-setup-completion.json");
    await retainCompletionReport({
      file,
      report,
      artifacts,
      failure: failure ?? preservationFailure,
    });
  });
}
