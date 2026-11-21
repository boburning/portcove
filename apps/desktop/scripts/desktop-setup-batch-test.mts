// Actual Desktop/Core batch flow with inert, CLI-seeded originals. No game qualification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until, type WebDriver } from "selenium-webdriver";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import type {
  createInstallFixture,
  prepareLargeSetupReviewFixture,
} from "./desktop-install-fixture.mts";
import {
  fixtureObject as object,
  fixtureSuccess as success,
  requiredFixtureValue as required,
} from "./desktop-scenario-state.mts";
import {
  clickVisible,
  reviewControls,
  selectGameFilesSettings,
  openGameFileScan,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import {
  assertOwnedSelectedSetupPath,
  selectedSetupGeneration,
} from "./desktop-source-dialog-test.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { observeSetupReviewFocus } from "./desktop-completion-focus.mts";

export interface BatchContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  fixture: Awaited<ReturnType<typeof createInstallFixture>>;
  restartApplication: (name: string, prepare?: () => Promise<void>) => Promise<WebDriver>;
}

// Observation only: never use the database to construct or repair product state.
export function readSetupBatchFacts(library: string) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return {
      batches: database
        .prepare("SELECT record_json FROM install_batches ORDER BY id")
        .all()
        .map((row) => {
          assert.equal(typeof row.record_json, "string");
          return transportValue("desktop_install_batch", JSON.parse(String(row.record_json)));
        }),
      launches: database.prepare("SELECT count(*) AS count FROM launch_sessions").get()?.count,
      history: database.prepare("SELECT count(*) AS count FROM launch_history").get()?.count,
    };
  } finally {
    database.close();
  }
}

export async function largeSetupReviewScenario(
  context: BatchContext & {
    largeReview: Awaited<ReturnType<typeof prepareLargeSetupReviewFixture>>;
  },
) {
  const { browser, invoke, scenario, library, output, artifacts, fixture, largeReview } = context;
  await scenario("native-large-discovery-setup-review", async () => {
    const report: Record<string, unknown> = {
      scope: "Native Desktop retained-page selection and cancelled twenty-game review",
      limitations: [
        "CLI-seeded inert registrations; no native picker, retail or gameplay claim",
        "Review is cancelled; installation execution is qualified separately",
        "Owned local paths do not establish physical removable or NAS behavior",
      ],
      expected_port_ids: largeReview.eligiblePorts,
      unresolved_implementation_ids: largeReview.choicePorts,
    };
    const evidenceFile = path.join(output, "native-large-setup-review.json");
    const screenshot = async (name: string) => {
      const target = path.join(output, `${name}.png`);
      await writeFile(target, await browser.takeScreenshot(), "base64");
      artifacts.push(target);
    };
    const generation = () => selectedSetupGeneration(invoke);
    const sources = async () => transportValues("source", success(await invoke("get_sources")));
    const roots = async () =>
      transportValue(
        "game_file_roots",
        success(await invoke("get_game_file_roots", { generation: await generation() })),
      );
    const snapshot = async () => {
      const value = success(
        await invoke("get_game_file_scan_snapshot", { generation: await generation() }),
      );
      return value === null ? null : transportValue("game_file_scan_snapshot", value);
    };
    const facts = () => {
      const value = readSetupBatchFacts(library);
      assert.deepEqual(value.batches, []);
      assert.equal(value.launches, 0);
      assert.equal(value.history, 0);
      assert.equal(fixture.requests.length, 0, "Review must not download a package");
      return value;
    };
    const keyboardActivate = async (locator: ReturnType<typeof By.css>) => {
      const control = await browser.wait(until.elementLocated(locator), 30_000);
      await control.sendKeys(Key.SPACE);
    };
    try {
      const initialSources = await sources();
      assert.equal(initialSources.length, 21);
      assert.deepEqual(
        initialSources.map((source) => source.profile_id).sort(),
        largeReview.originals.map((source) => source.profile).sort(),
      );
      const initialRoots = await roots();
      facts();
      const { button, click } = reviewControls(browser);
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      await openGameFileScan(browser);
      await click(button("Refresh folders"));
      await browser.wait(
        async () => (await browser.findElement(button("Scan saved folders"))).isEnabled(),
        15_000,
      );
      await keyboardActivate(button("Scan saved folders"));
      const partial = await browser.wait(async () => {
        const value = await snapshot();
        return value?.coverage?.can_resume ? value : false;
      }, 30_000);
      assert.ok(partial);
      assert.equal(partial.report.candidates.length, 64);
      await keyboardActivate(button("Finish scanning these folders"));
      const complete = await browser.wait(async () => {
        const value = await snapshot();
        return value &&
          !value.coverage?.can_resume &&
          value.matches?.exact_matches === largeReview.exactMatches
          ? value
          : false;
      }, 60_000);
      assert.ok(complete);
      assert.equal(complete.matches?.scan_id, partial.matches?.scan_id);
      assert.ok((complete.coverage?.batches ?? 0) > 1);
      // Continuation accumulates the bounded Core preview; UI pages follow that preview.
      assert.deepEqual(complete.limits, partial.limits);
      assert.equal(complete.report.candidates.length, 512);
      const preview = await browser.wait(
        until.elementLocated(By.css("[data-match-preview-notice]")),
        30_000,
      );
      assert.match(
        await preview.getText(),
        new RegExp(`Showing 512 of ${largeReview.exactMatches} matches`, "u"),
      );
      await keyboardActivate(button("Select all 20 eligible"));
      await browser.wait(until.elementLocated(button("Review installing 20 selected")), 30_000);
      for (const id of largeReview.choicePorts)
        assert.equal(
          await browser
            .findElement(By.css(`[data-setup-review-port="${id}"]`))
            .getAttribute("aria-checked"),
          "false",
        );
      assert.equal(
        await browser.executeScript<boolean>(
          "return Boolean(document.activeElement?.closest('section')?.querySelector('[data-setup-review-port]'))",
        ),
        true,
      );
      const rows = By.css('[aria-label="Saved folder scan results"] [data-completed-candidate]');
      assert.equal((await browser.findElements(rows)).length, 512);
      const previewNames = new Set(
        complete.report.candidates.map((item) => path.basename(item.path)),
      );
      const omittedName = largeReview.originals
        .flatMap((original) => original.copies)
        .map((file) => path.basename(file))
        .find((name) => !previewNames.has(name));
      assert.ok(omittedName);
      assert.match(omittedName, /^large-\d{2}-copy-\d+\.pcgame$/u);
      const omittedRow = By.css(`[data-completed-candidate][data-path$="${omittedName}"]`);
      assert.equal((await browser.findElements(omittedRow)).length, 0);
      await screenshot("native-large-selected-before-paging");
      await keyboardActivate(button("Show more matches"));
      await browser.wait(
        async () =>
          (await browser.findElements(By.css("[data-match-preview-notice]"))).length === 0,
        30_000,
      );
      assert.equal((await browser.findElements(rows)).length, largeReview.exactMatches);
      assert.equal((await browser.findElements(omittedRow)).length, 1);
      assert.equal((await browser.findElements(button("Review installing 20 selected"))).length, 1);
      await keyboardActivate(button("Review installing 20 selected"));
      const panel = await browser.wait(
        until.elementLocated(By.css('[aria-label="Install selected games"]')),
        30_000,
      );
      await browser.wait(
        async () => /20 ready to install, 0 waiting/u.test(await panel.getText()),
        30_000,
      );
      const plans = transportValue(
        "desktop_install_batch_review",
        success(
          await invoke("plan_install_batch", {
            portIds: largeReview.eligiblePorts,
            generation: await generation(),
          }),
        ),
      );
      assert.deepEqual(
        plans.items.map((item) => item.port_id).sort(),
        largeReview.eligiblePorts.toSorted(),
      );
      for (const item of plans.items) assert.ok(item.plan && !item.hold);
      for (const id of largeReview.choicePorts)
        assert.ok(!plans.items.some((item) => item.port_id === id));
      const panelText = await panel.getText();
      for (let index = 0; index < 20; index++)
        assert.ok(panelText.includes(`Large review game ${String(index).padStart(2, "0")} only`));
      assert.ok(!panelText.includes("Large review game 20"));
      facts();
      report.review_entry_focus = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            observeSetupReviewFocus,
            '[aria-label="Install selected games"]',
          ),
        15_000,
      );
      await screenshot("native-large-twenty-game-review");
      // Send ordinary keys to the current focus. Targeted element.sendKeys would
      // focus Cancel itself and hide a broken review-entry handoff.
      for (let step = 0; step < 4; step++) {
        if ((await (await browser.switchTo().activeElement()).getText()).trim() === "Cancel") break;
        await browser.actions().sendKeys(Key.TAB).perform();
      }
      const cancelFocus = await executeBrowserScript(
        browser,
        observeSetupReviewFocus,
        '[aria-label="Install selected games"]',
      );
      assert.ok(cancelFocus);
      assert.equal(cancelFocus.tag, "BUTTON");
      assert.equal(cancelFocus.text, "Cancel");
      report.cancel_focus = cancelFocus;
      await browser.actions().sendKeys(Key.SPACE).perform();
      await browser.wait(
        async () =>
          (await browser.findElements(By.css('[aria-label="Install selected games"]'))).length ===
          0,
        15_000,
      );
      report.review_return_focus = await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            observeSetupReviewFocus,
            '[aria-label="Selected setup reviews"]',
          ),
        15_000,
      );
      assert.deepEqual(await sources(), initialSources);
      assert.deepEqual(await roots(), initialRoots);
      assert.deepEqual(
        transportValues("status", success(await invoke("get_statuses"))).filter(
          (status) => status.active,
        ),
        [],
      );
      for (const original of largeReview.originals)
        for (const file of original.copies)
          assert.equal(
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
            original.sha256,
          );
      report.partial_scan = partial;
      report.completed_scan = complete;
      report.reviewed_plans = plans;
      report.initial_sources = initialSources;
      report.saved_roots = initialRoots;
      report.final_facts = facts();
      report.native_actions = [
        "scan",
        "finish bounded scan",
        "select all20 eligible",
        "show retained match page",
        "review20 with visible entry focus",
        "ordinary Tab to Cancel and Space",
        "visible focus returned to setup choices",
      ];
      report.outcome = "passed";
      await screenshot("native-large-cancelled-preserved");
    } catch (error) {
      report.outcome = "failed";
      report.error = errorMessage(error);
      throw error;
    } finally {
      await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(evidenceFile);
    }
  });
}

export async function setupBatchScenario(context: BatchContext) {
  const { invoke, scenario, library, output, artifacts, fixture, restartApplication } = context;
  let browser = context.browser;
  await scenario("native-reviewed-discovery-setup-batch", async () => {
    const owned = required(fixture.sourceJourney);
    const ports = [fixture.port.id, fixture.refreshPort.id];
    assert.equal(fixture.port.adapter, "libultraship-portable");
    assert.equal(fixture.refreshPort.adapter, "libultraship-portable");
    assert.equal(fixture.refreshPort.source_profile, fixture.port.source_profile);
    assert.equal(fixture.refreshPort.bios_source_profile, undefined);
    const report: Record<string, unknown> = {
      scope:
        "Native Desktop reviewed two portable integrations with real Core lifecycle and inert inputs",
      limitations: [
        "First-party CLI seeded the saved folder and original registrations; no picker claim",
        "Loopback artifacts and inert originals; no retail, upstream runtime or gameplay claim",
      ],
      port_ids: ports,
    };
    const file = path.join(output, "native-discovery-setup-batch.json");
    const screenshot = async (name: string) => {
      const target = path.join(output, `${name}.png`);
      await writeFile(target, await browser.takeScreenshot(), "base64");
      artifacts.push(target);
    };
    const sources = async () => transportValues("source", success(await invoke("get_sources")));
    const statuses = async () => transportValues("status", success(await invoke("get_statuses")));
    const assertNoLaunch = () => {
      const facts = readSetupBatchFacts(library);
      assert.equal(facts.launches, 0);
      assert.equal(facts.history, 0);
      return facts;
    };
    try {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        success(await invoke("get_bootstrap_status")),
      );
      assertOwnedSelectedSetupPath(required(bootstrap.library_root), library);
      const initialSources = await sources();
      assert.equal(initialSources.length, 2);
      assert.deepEqual(
        initialSources.map((source) => source.profile_id).sort(),
        owned.profiles.toSorted(),
      );
      const initial = assertNoLaunch();
      assert.deepEqual(initial.batches, []);
      assert.equal(fixture.requests.length, 0, "Fixture setup must not acquire game artifacts");
      report.initial_sources = initialSources;
      report.initial_roots = transportValue(
        "game_file_roots",
        success(
          await invoke("get_game_file_roots", {
            generation: await selectedSetupGeneration(invoke),
          }),
        ),
      );
      const { button, click } = reviewControls(browser);
      await selectPrimaryNavigation(browser, "Settings");
      await selectGameFilesSettings(browser);
      await openGameFileScan(browser);
      await browser.wait(until.elementLocated(By.id("add-games-folders-heading")), 15_000);
      await click(button("Refresh folders"));
      await browser.wait(
        async () => (await browser.findElement(button("Scan saved folders"))).isEnabled(),
        15_000,
      );
      await click(button("Scan saved folders"));
      const scanned = await browser.wait(async () => {
        const value = success(
          await invoke("get_game_file_scan_snapshot", {
            generation: await selectedSetupGeneration(invoke),
          }),
        );
        if (value === null) return false;
        const snapshot = transportValue("game_file_scan_snapshot", value);
        return snapshot?.matches?.exact_matches === 2 ? snapshot : false;
      }, 30_000);
      assert.ok(scanned);
      report.scanned = scanned;
      report.statuses_before_selection = (await statuses()).filter((status) =>
        ports.includes(status.port_id),
      );
      const registeredMatches = transportValue(
        "desktop_game_file_scan_registered_matches",
        success(
          await invoke("get_game_file_scan_registered_matches", {
            expected: required(scanned.matches),
            generation: await selectedSetupGeneration(invoke),
          }),
        ),
      );
      report.registered_matches = registeredMatches;
      const selectedIdentities = (records: typeof initialSources) =>
        records
          .map((source) => ({
            profile_id: source.profile_id,
            path: source.path,
            sha256: source.sha256,
          }))
          .sort((a, b) => a.profile_id.localeCompare(b.profile_id));
      assert.deepEqual(
        selectedIdentities(registeredMatches.candidates),
        selectedIdentities(initialSources),
      );
      assert.deepEqual(await sources(), initialSources);
      const choosePorts = async () => {
        for (const port of ports) {
          const choice = await browser.wait(
            until.elementLocated(By.css(`[data-setup-review-port="${port}"]`)),
            30_000,
          );
          assert.equal(
            await choice.getAttribute("aria-checked"),
            "false",
            "Shared originals must not choose both implementations",
          );
          await clickVisible(browser, choice);
        }
      };
      await choosePorts();
      const reviewButton = button("Review installing 2 selected");
      const batchPanel = By.css('[aria-label="Install selected games"]');
      const openReview = async () => {
        await click(reviewButton);
        await browser.wait(
          until.elementLocated(
            By.xpath(
              '//section[@aria-label="Install selected games"]//h3[normalize-space(.)="Review installing selected games"]',
            ),
          ),
          30_000,
        );
        const panel = await browser.findElement(batchPanel);
        assert.match(await panel.getText(), /2 ready to install, 0 waiting/);
        const generation = await selectedSetupGeneration(invoke);
        const plans = transportValue(
          "desktop_install_batch_review",
          success(await invoke("plan_install_batch", { portIds: ports, generation })),
        );
        assert.deepEqual(plans.items.map((item) => item.port_id).sort(), ports.toSorted());
        for (const item of plans.items) {
          assert.ok(
            item.plan && !item.hold,
            `Both reviewed fixtures must be eligible: ${JSON.stringify(item)}`,
          );
        }
        assert.deepEqual(assertNoLaunch().batches, []);
        assert.equal(fixture.requests.length, 0);
        return plans;
      };
      report.cancelled_review = await openReview();
      await screenshot("native-batch-review-cancel");
      await clickVisible(
        browser,
        await browser
          .findElement(batchPanel)
          .findElement(By.xpath('.//button[normalize-space(.)="Cancel"]')),
      );
      await browser.wait(
        async () =>
          (
            await browser.findElements(
              By.xpath('//section[@aria-label="Install selected games"]//h3'),
            )
          ).length === 0,
        15_000,
      );
      assert.deepEqual(assertNoLaunch().batches, []);
      assert.equal(fixture.requests.length, 0);
      assert.deepEqual(await sources(), initialSources);
      await choosePorts();
      const reviewed = await openReview();
      report.confirmed_review = reviewed;
      await screenshot("native-batch-review-confirm");
      await clickVisible(
        browser,
        await browser
          .findElement(batchPanel)
          .findElement(By.xpath('.//button[normalize-space(.)="Add 2 to Library and install 2"]')),
      );
      const completed = await browser.wait(
        () => {
          const facts = assertNoLaunch();
          assert.ok(facts.batches.length <= 1, "One confirmation must create at most one batch");
          const batch = facts.batches[0];
          return batch && batch.items.every((item) => !["queued", "running"].includes(item.state))
            ? batch
            : false;
        },
        120_000,
        "The reviewed batch must reach a retained terminal outcome",
      );
      assert.ok(completed, "The native wait must return a terminal batch");
      assert.equal(completed.items.length, 2);
      assert.deepEqual(completed.items.map((item) => item.port_id).sort(), ports.toSorted());
      for (const item of completed.items) {
        assert.equal(item.state, "ready", JSON.stringify(completed));
        assert.ok(item.install_id);
        assert.equal(
          item.expected_plan_sha256,
          required(reviewed.items.find((review) => review.port_id === item.port_id)?.plan)
            .plan_sha256,
        );
      }
      await browser.wait(
        until.elementLocated(
          By.xpath(
            '//section[@aria-label="Install selected games"]//h3[normalize-space(.)="Setup batch results"]',
          ),
        ),
        15_000,
      );
      await screenshot("native-batch-complete");
      report.completed = completed;
      const verification = [];
      for (const item of completed.items) {
        const checked = object(
          success(
            await invoke("verify_port", {
              portId: item.port_id,
              generation: await selectedSetupGeneration(invoke),
            }),
          ),
        );
        assert.equal(checked.install_id, item.install_id);
        assert.equal(checked.valid, true, JSON.stringify(checked));
        assert.ok(typeof checked.checked_files === "number" && checked.checked_files > 0);
        verification.push(checked);
      }
      report.verification = verification;
      report.statuses = (await statuses()).filter((status) => ports.includes(status.port_id));
      const requestsAfter = structuredClone(fixture.requests);
      assert.ok(
        requestsAfter.some((request) => request.completed && request.bytes_sent > 0),
        "The confirmed batch must consume an owned checksum-pinned artifact",
      );
      report.requests = requestsAfter;
      browser = await restartApplication("native-batch-retained");
      // Real fresh-session read verifies durable identities, not renderer memory.
      await selectedSetupGeneration(invoke);
      assert.deepEqual(assertNoLaunch().batches, [completed]);
      const retained = await statuses();
      for (const item of completed.items) {
        const status = required(retained.find((status) => status.port_id === item.port_id));
        assert.equal(required(status.active).id, item.install_id);
        assert.equal(status.successful_launches, 0);
        assert.equal(status.last_launched_at, null);
      }
      assert.deepEqual(
        fixture.requests,
        requestsAfter,
        "Restart must not repeat a finished acquisition",
      );
      const finalSources = await sources();
      // Runtime assessment timestamps may advance; source custody cannot change.
      const identities = (records: typeof finalSources) =>
        records.map(({ profile_id, path: location, sha256 }) => ({
          profile_id,
          path: location,
          sha256,
        }));
      assert.deepEqual(identities(finalSources), identities(initialSources));
      const finalRoots = transportValue(
        "game_file_roots",
        success(
          await invoke("get_game_file_roots", {
            generation: await selectedSetupGeneration(invoke),
          }),
        ),
      );
      assert.deepEqual(
        finalRoots.map(({ id, path: location }) => ({ id, path: location })),
        transportValue("game_file_roots", report.initial_roots).map(({ id, path: location }) => ({
          id,
          path: location,
        })),
      );
      assert.deepEqual(await readFile(owned.gamePath), await readFile(owned.gameBefore));
      assert.deepEqual(await readFile(owned.biosPath), await readFile(owned.biosBefore));
      report.retained_statuses = retained.filter((status) => ports.includes(status.port_id));
      report.final_facts = assertNoLaunch();
      report.outcome = "passed";
    } catch (error) {
      report.failure = errorMessage(error);
      try {
        await screenshot("native-batch-failure");
      } catch (captureError) {
        report.failure_capture = errorMessage(captureError);
      }
      throw error;
    } finally {
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(file);
    }
  });
}
