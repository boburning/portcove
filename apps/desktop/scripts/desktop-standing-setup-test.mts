// Native standing consent/catch-up with owned inert inputs, not real-game acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { readSetupBatchFacts, type BatchContext } from "./desktop-setup-batch-test.mts";
import {
  fixtureObject as object,
  fixtureSuccess as success,
  requiredFixtureValue as required,
} from "./desktop-scenario-state.mts";
import {
  assertOwnedSelectedSetupPath,
  selectedSetupGeneration,
} from "./desktop-source-dialog-test.mts";
import {
  clickVisible,
  openCatalogPortAfterRefresh,
  revealDetailSection,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import {
  installStandingPassObserver,
  readStandingPassObservations,
  restoreStandingPassObserver,
} from "./desktop-standing-pass-observer.mts";
import { transportValue, transportValues } from "./transport-values.mts";

export async function standingSetupScenario(context: BatchContext) {
  const { invoke, scenario, library, output, artifacts, fixture, restartApplication } = context;
  let browser = context.browser;
  await scenario("native-standing-setup-source-return", async () => {
    const owned = required(fixture.sourceJourney);
    const offline = `${owned.directory}-unavailable`;
    const portId = fixture.port.id;
    const report: Record<string, unknown> = {
      scope: "Native Desktop standing consent, unavailable original and startup catch-up",
      limitations: [
        "CLI-seeded inert registrations and loopback artifacts; no real-game or gameplay claim",
        "Owned local path renamed while the app is stopped; no SMB or physical disconnect claim",
        "HTTP IPC observation forwards the original Promise/Response/error without injected results",
      ],
      port_id: portId,
    };
    const reportPath = path.join(output, "native-standing-setup-source-return.json");
    const sources = async () => transportValues("source", success(await invoke("get_sources")));
    const intents = async () =>
      transportValue(
        "desktop_port_intents",
        success(
          await invoke("get_port_intents", { generation: await selectedSetupGeneration(invoke) }),
        ),
      );
    const statuses = async () => transportValues("status", success(await invoke("get_statuses")));
    const capture = async (name: string) => {
      const target = path.join(output, `${name}.png`);
      await writeFile(target, await browser.takeScreenshot(), "base64");
      artifacts.push(target);
    };
    const noLaunch = () => {
      const facts = readSetupBatchFacts(library);
      assert.equal(facts.launches, 0);
      assert.equal(facts.history, 0);
      return facts;
    };
    let restored = false;
    try {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        success(await invoke("get_bootstrap_status")),
      );
      assertOwnedSelectedSetupPath(required(bootstrap.library_root), library);
      assert.equal(
        await lstat(owned.directory).then(
          () => false,
          (error: unknown) => {
            assert.equal(object(error).code, "ENOENT");
            return true;
          },
        ),
        true,
      );
      assert.ok((await lstat(offline)).isDirectory());
      const initialSources = await sources();
      assert.equal(initialSources.length, 2);
      assert.deepEqual(
        initialSources.map((source) => source.profile_id).sort(),
        owned.profiles.toSorted(),
      );
      for (const [profile, originalPath, beforePath] of [
        [owned.profiles[0], owned.gamePath, owned.gameBefore],
        [owned.profiles[1], owned.biosPath, owned.biosBefore],
      ] as const) {
        const source = required(
          initialSources.find((candidate) => candidate.profile_id === profile),
        );
        assertOwnedSelectedSetupPath(source.path, originalPath);
        assert.equal(
          source.sha256,
          createHash("sha256")
            .update(await readFile(beforePath))
            .digest("hex"),
        );
      }
      const sourceIdentity = (records: typeof initialSources) =>
        records.map(({ profile_id, path: location, sha256 }) => ({
          profile_id,
          path: location,
          sha256,
        }));
      const roots = async () =>
        transportValue(
          "game_file_roots",
          success(
            await invoke("get_game_file_roots", {
              generation: await selectedSetupGeneration(invoke),
            }),
          ),
        );
      const initialRoots = await roots();
      assert.equal(initialRoots.length, 1);
      assertOwnedSelectedSetupPath(required(initialRoots[0]).path, owned.directory);
      report.initial_sources = initialSources;
      report.initial_roots = initialRoots;
      assert.deepEqual(await intents(), []);
      assert.deepEqual(noLaunch().batches, []);
      assert.equal(fixture.requests.length, 0);
      await openCatalogPortAfterRefresh(browser, fixture.port, fixture.port.name);
      await revealDetailSection(browser, "Game files");
      const radio = await browser.wait(
        until.elementLocated(By.css('[data-detail-workspace] input[value="set_up_when_ready"]')),
        15_000,
      );
      await browser.wait(until.elementIsEnabled(radio), 15_000);
      assert.equal(await radio.isSelected(), false);
      await executeBrowserScript(browser, installStandingPassObserver);
      await clickVisible(browser, radio);
      const waiting = await browser.wait(
        async () => {
          const observations = await executeBrowserScript(browser, readStandingPassObservations);
          assert.equal(observations.omitted, 0);
          report.offline_pass_observations = observations;
          for (const sample of observations.samples) {
            if (!sample.complete) continue;
            assert.equal(sample.error, undefined, JSON.stringify(sample));
            const pass = transportValue("desktop_standing_setup", sample.value);
            if (pass.already_running) continue;
            const assessment = pass.assessments.find((item) => item.port_id === portId);
            if (!assessment || assessment.mode !== "set_up_when_ready") continue;
            assert.ok(assessment.readiness.state === "waiting", JSON.stringify(pass));
            assert.match(assessment.readiness.reason, /^Connect .+ to set up this game\.$/);
            assert.ok(
              assessment.readiness.reason.includes(required(initialRoots[0]).path),
              "The offline pass must name the exact saved folder, not an unrelated prerequisite",
            );
            assert.deepEqual(pass.batches, []);
            assert.deepEqual(pass.failures, []);
            assert.ok(!pass.game_setup_unavailable, JSON.stringify(pass));
            return pass;
          }
          return false;
        },
        45_000,
        "The ordinary UI must complete a real standing pass while its source is unavailable",
      );
      report.waiting = waiting;
      const savedIntent = required((await intents()).find((item) => item.port_id === portId));
      assert.equal(savedIntent.mode, "set_up_when_ready");
      assert.equal(savedIntent.failed_attempts ?? 0, 0);
      assert.deepEqual(
        savedIntent.sources,
        initialSources
          .filter((item) => item.profile_id === fixture.port.source_profile)
          .map(({ profile_id, sha256 }) => ({ profile_id, sha256 })),
      );
      assert.equal((await intents()).length, 1, "The alternative integration has no consent");
      assert.deepEqual(noLaunch().batches, []);
      assert.equal(fixture.requests.length, 0);
      report.saved_intent = savedIntent;
      report.waiting_detail = await browser
        .findElement(By.css("[data-detail-workspace]"))
        .getText();
      await capture("native-standing-offline");
      assert.equal(await executeBrowserScript(browser, restoreStandingPassObserver), true);
      // The restart owner publishes positive app/driver/WebView exit before this
      // one fixture mutation. Never restore the source while consent is live.
      browser = await restartApplication("standing-original-return", async () => {
        assert.ok((await lstat(offline)).isDirectory());
        await rename(offline, owned.directory);
        restored = true;
      });
      const completed = await browser.wait(
        () => {
          const facts = noLaunch();
          assert.ok(facts.batches.length <= 1, "Standing consent must create at most one batch");
          const batch = facts.batches[0];
          return batch && batch.items.every((item) => !["queued", "running"].includes(item.state))
            ? batch
            : false;
        },
        120_000,
        "Normal startup catch-up must install the same consented game",
      );
      assert.ok(completed, "Startup must return the completed standing batch");
      assert.equal(completed.items.length, 1);
      const item = required(completed.items[0]);
      assert.equal(item.port_id, portId);
      assert.equal(item.state, "ready", JSON.stringify(completed));
      assert.ok(item.install_id);
      report.completed = completed;
      const verified = object(
        success(
          await invoke("verify_port", {
            portId,
            generation: await selectedSetupGeneration(invoke),
          }),
        ),
      );
      assert.equal(verified.install_id, item.install_id);
      assert.equal(verified.valid, true, JSON.stringify(verified));
      assert.ok(typeof verified.checked_files === "number" && verified.checked_files > 0);
      report.verification = verified;
      const after = await statuses();
      assert.equal(
        required(after.find((status) => status.port_id === portId)?.active).id,
        item.install_id,
      );
      assert.equal(
        required(after.find((status) => status.port_id === fixture.refreshPort.id)).active,
        null,
      );
      await selectPrimaryNavigation(browser, "Library");
      const card = await browser.wait(
        until.elementLocated(By.css(`[data-detail-game-id="${portId}"]`)),
        15_000,
      );
      await clickVisible(browser, card);
      await capture("native-standing-installed");
      const requests = structuredClone(fixture.requests);
      assert.ok(requests.some((request) => request.completed && request.bytes_sent > 0));
      report.requests = requests;
      browser = await restartApplication("standing-retained");
      await selectedSetupGeneration(invoke);
      assert.deepEqual(noLaunch().batches, [completed]);
      const retained = await statuses();
      assert.equal(
        required(retained.find((status) => status.port_id === portId)?.active).id,
        item.install_id,
      );
      assert.equal(
        required(retained.find((status) => status.port_id === fixture.refreshPort.id)).active,
        null,
      );
      assert.deepEqual(fixture.requests, requests);
      const retainedIntent = required(
        (await intents()).find((intent) => intent.port_id === portId),
      );
      assert.equal(retainedIntent.mode, savedIntent.mode);
      assert.deepEqual(retainedIntent.sources, savedIntent.sources);
      assert.equal(retainedIntent.failed_attempts ?? 0, 0);
      assert.equal((await intents()).length, 1);
      assert.deepEqual(sourceIdentity(await sources()), sourceIdentity(initialSources));
      assert.deepEqual(
        (await roots()).map(({ id, path: location }) => ({ id, path: location })),
        initialRoots.map(({ id, path: location }) => ({ id, path: location })),
      );
      assert.deepEqual(await readFile(owned.gamePath), await readFile(owned.gameBefore));
      assert.deepEqual(await readFile(owned.biosPath), await readFile(owned.biosBefore));
      report.final_facts = noLaunch();
      report.retained_intent = retainedIntent;
      report.outcome = "passed";
    } catch (error) {
      report.failure = errorMessage(error);
      try {
        await capture("native-standing-failure");
      } catch (captureError) {
        report.failure_capture = errorMessage(captureError);
      }
      throw error;
    } finally {
      // Failure preserves the unavailable fixture for custody, rather than
      // making it eligible again while the consented application is still live.
      report.source_restored_after_stopped_session = restored;
      try {
        await executeBrowserScript(browser, restoreStandingPassObserver);
      } catch (error) {
        report.observer_cleanup_failure = errorMessage(error);
      }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(reportPath);
    }
  });
}
