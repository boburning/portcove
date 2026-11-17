// Actual Desktop/Core batch flow with inert, CLI-seeded originals. No game qualification.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { By, until, type WebDriver } from "selenium-webdriver";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import type { createInstallFixture } from "./desktop-install-fixture.mts";
import {
  fixtureObject as object,
  fixtureSuccess as success,
  requiredFixtureValue as required,
} from "./desktop-scenario-state.mts";
import {
  clickVisible,
  reviewControls,
  selectGameFilesSettings,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import {
  assertOwnedSelectedSetupPath,
  selectedSetupGeneration,
} from "./desktop-source-dialog-test.mts";
import { transportValue, transportValues } from "./transport-values.mts";

interface BatchContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  fixture: Awaited<ReturnType<typeof createInstallFixture>>;
  restartApplication: (name: string) => Promise<WebDriver>;
}

// Observation only: never use the database to construct or repair product state.
function batchFacts(library: string) {
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

export async function setupBatchScenario(context: BatchContext) {
  const { invoke, scenario, library, output, artifacts, fixture, restartApplication } = context;
  let browser = context.browser;
  await scenario("native-reviewed-discovery-setup-batch", async () => {
    const owned = required(fixture.sourceJourney);
    const ports = [fixture.port.id, fixture.refreshPort.id];
    const report: Record<string, unknown> = {
      scope: "Native Desktop reviewed two-game batch with real Core lifecycle and inert inputs",
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
      const facts = batchFacts(library);
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
        [...owned.profiles].sort(),
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
      await browser.wait(until.elementLocated(By.id("game-file-libraries-heading")), 15_000);
      await click(button("Refresh folders"));
      await browser.wait(
        async () => (await browser.findElement(button("Scan saved folders"))).isEnabled(),
        15_000,
      );
      await click(button("Scan saved folders"));
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
        assert.deepEqual(plans.items.map((item) => item.port_id).sort(), [...ports].sort());
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
      assert.equal(completed.items.length, 2);
      assert.deepEqual(completed.items.map((item) => item.port_id).sort(), [...ports].sort());
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
