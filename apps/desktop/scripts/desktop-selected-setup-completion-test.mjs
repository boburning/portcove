// Actual Tauri/Core journey; synthetic source and first-party probe, never a game qualification.
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
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
}) {
  await scenario("native-selected-setup-completion", async () => {
    assert.equal(fixture?.completionJourney, true);
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
      scope:
        "Windows ordinary install and isolated preparation of a first-party probe with synthetic N64 input",
      limitations: [
        "Saved root seeded by the existing CLI; native picker credited separately",
        "No real game, BIOS preparation, gameplay, full representation matrix or other platform qualification",
      ],
      port_id: port.id,
      observations: {},
    };
    let failure;
    try {
      assert.deepEqual(await read("get_sources"), []);
      assert.equal((await status()).active, null, "No adopted installation may seed completion");
      await click(By.xpath('//nav//button[contains(., "Settings")]'));
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 5_000);
      await click(button("Refresh folders"));
      const priorScans = new Set(
        (await read("get_activities")).records
          .filter((item) => item.operation === "discover_sources")
          .map((item) => item.id),
      );
      await click(button("Scan saved folders"));
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
      const choices = [fixture.port, fixture.refreshPort]
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
      await click(button(`Open ${port.name} details`));
      await browser.wait(until.elementLocated(By.id("port-detail-title")), 5_000);
      assert.equal(await browser.findElement(By.id("port-detail-title")).getText(), port.name);

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
      await captureAccessibilityReport(
        browser,
        path.join(output, "selected-setup-completion-accessibility.json"),
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
