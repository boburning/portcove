import { captureNativeEnlargement } from "./native-enlargement.mts";
import type { WebDriver } from "selenium-webdriver";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { transportValue, transportValues } from "./transport-values.mts";
interface SourceRemovalContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  scenario: (name: string, execute: () => Promise<void>) => Promise<unknown>;
  library: string;
  output: string;
  artifacts: string[];
  command: FixtureCommand;
  confirmNative: ReturnType<typeof nativeConfirmation>;
}
import { executeBrowserScript } from "./browser-script.mts";
// Source-reference removal uses the existing owned preparation fixture; no game files are acquired.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { By, Key, until } from "selenium-webdriver";
import { installedPreservationWitness } from "./desktop-scenario-state.mts";
import {
  reviewControls,
  assertCompactReview,
  assertDestructiveReviewAction,
  captureAccessibilityReport,
} from "./desktop-review-controls.mts";

export async function sourceRemovalScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  command,
  confirmNative,
}: SourceRemovalContext) {
  await scenario("native-reviewed-source-reference-removal", async () => {
    assert.equal(path.resolve(library), path.resolve(output, "library"));
    const { portId, install } = installedPreservationWitness((args) =>
      transportValue("status", command(args)),
    );
    const port = transportValue("port", command(["catalog", "show", portId]));
    const sources = () => transportValues("source", command(["source", "list"]));
    const source = sources().find((item) => item.profile_id === port.source_profile);
    assert.ok(source);
    const paths = transportValue("port_paths", command(["paths", port.id]));
    const relative = path.relative(library, paths.user_data_root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await mkdir(paths.user_data_root, { recursive: true });
    const save = path.join(paths.user_data_root, "owned-source-review-save.bin");
    await writeFile(save, "source removal must preserve this save", {
      flag: "wx",
    });
    const backup = transportValue("backup", command(["backup", "create", port.id]));
    const preserved = await Promise.all(
      [source.path, save, path.join(backup.path, "data/owned-source-review-save.bin")].map((file) =>
        fileIdentity(file),
      ),
    );
    const others = () => sources().filter((item) => item.profile_id !== source.profile_id);
    const otherSources = others();
    await browser.navigate().refresh();
    const updatePreference = await invoke("get_application_update_preferences");
    assert(isRecord(updatePreference));
    assert.equal(updatePreference.ok, true);
    const preferences = transportValue(
      "desktop_application_update_preferences",
      updatePreference.value,
    );
    if (preferences.choice === null) {
      const defer = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Not now"]')),
        15_000,
      );
      await defer.click();
      await browser.wait(until.stalenessOf(defer), 15_000);
    }
    const { button, click } = reviewControls(browser);
    await click(By.xpath('//nav//button[contains(., "Settings")]'));
    await click(
      By.xpath('//nav[@aria-label="Settings categories"]//button[normalize-space(.)="Game files"]'),
    );
    const row = By.css(`.source-health-row[data-source-profile="${source.profile_id}"]`);
    const impactSelector = '[aria-label="Saved-location removal impact"]';
    const dialog = By.css(impactSelector);
    const trigger = By.xpath(
      `//*[@data-source-profile="${source.profile_id}"]//button[normalize-space(.)="Review saved location removal"]`,
    );
    await browser.wait(until.elementLocated(row), 15_000);
    const rowLayout = await executeBrowserScript(
      browser,
      (element) => {
        const title = element.querySelector("strong");
        const actions = element.querySelector(".source-health-actions");
        const bounds = element.getBoundingClientRect();
        const titleBounds = title?.getBoundingClientRect();
        const actionBounds = actions?.getBoundingClientRect();
        return {
          rowWidth: bounds.width,
          titleColumnWidth: title?.parentElement?.getBoundingClientRect().width ?? 0,
          titleHeight: titleBounds?.height ?? 0,
          actionsTop: actionBounds?.top ?? 0,
          titleBottom: titleBounds?.bottom ?? 0,
        };
      },
      await browser.findElement(row),
    );
    assert.ok(
      rowLayout.titleColumnWidth > rowLayout.rowWidth * 0.7 &&
        rowLayout.titleHeight < 80 &&
        rowLayout.actionsTop >= rowLayout.titleBottom,
      `saved source title is cramped: ${JSON.stringify(rowLayout)}`,
    );
    const originalWindow = await browser.manage().window().getRect();
    const modifier = process.platform === "darwin" ? Key.COMMAND : Key.CONTROL;
    const shortcut = (key: string) =>
      browser.actions().keyDown(modifier).sendKeys(key).keyUp(modifier).perform();
    let baselineWidth = 0;
    const enlargedStage = async (stage: string) => {
      artifacts.push(
        await captureNativeEnlargement(browser, {
          output,
          prefix: "source-removal",
          stage,
          baselineWidth,
        }),
      );
    };
    let failure: { error: unknown } | undefined;
    try {
      await browser.manage().window().setRect({ width: 960, height: 640 });
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
      const baselineFile = path.join(output, "source-removal-100-baseline.json");
      await writeFile(baselineFile, JSON.stringify(baseline, null, 2), { flag: "wx" });
      artifacts.push(baselineFile);
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
      );
      await enlargedStage("saved-location");
      const openReview = async () => {
        await click(trigger);
        await browser.wait(until.elementLocated(button("Remove saved location…")), 15_000);
      };
      await openReview();
      await enlargedStage("inline-impact");
      assert.equal(
        (await browser.findElements(By.css('[role="dialog"]'))).length,
        0,
        "inline impact must not create renderer approval",
      );
      await click(button("Keep location"));
      await browser.wait(
        async () => (await browser.findElements(dialog)).length === 0,
        5_000,
        "source removal inline impact did not close after Keep location",
      );
      await browser.wait(
        async () => {
          const candidate = await browser.findElement(trigger);
          return await executeBrowserScript(
            browser,
            "return document.activeElement === arguments[0];",
            candidate,
          );
        },
        5_000,
        "source removal trigger did not regain focus after Keep location",
      );
      await openReview();
      const destructiveStyles = await assertDestructiveReviewAction(
        browser,
        await browser.findElement(button("Remove saved location…")),
        await browser.findElement(button("Keep location")),
      );
      let text = await browser.findElement(dialog).getText();
      assert.ok(
        text.includes(source.path) &&
          text.includes(port.name) &&
          text.includes("does not move or delete files at") &&
          text.includes("If interrupted, reopen Settings"),
      );
      await click(button("Keep location"));
      assert.deepEqual(
        sources().find((item) => item.profile_id === source.profile_id),
        source,
      );
      await openReview();
      await click(button("Remove saved location…"));
      await confirmNative(
        "Remove saved location?",
        "__observe__",
        source.path,
        "source-native-before-consent",
      );
      assert.deepEqual(
        sources().find((item) => item.profile_id === source.profile_id),
        source,
      );
      await confirmNative(
        "Remove saved location?",
        "Cancel",
        source.path,
        "source-native-cancelled",
      );
      await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 15_000);
      await enlargedStage("native-cancelled");
      await openReview();
      const bootstrapBeforeChange = await invoke("get_bootstrap_status");
      assert(isRecord(bootstrapBeforeChange) && bootstrapBeforeChange.ok === true);
      const removalGeneration = transportValue(
        "desktop_bootstrap_status",
        bootstrapBeforeChange.value,
      ).generation;
      const beforeChange = await invoke("preview_source_removal", {
        profileId: source.profile_id,
        generation: removalGeneration,
      });
      assert(isRecord(beforeChange) && beforeChange.ok === true);
      const oldPreview = transportValue("source_removal_preview", beforeChange.value);
      const replacement = path.join(output, `owned-replacement-${port.id}.iso`);
      await writeFile(replacement, "changed owned source registration", {
        flag: "wx",
      });
      command(["source", "add", source.profile_id, replacement]);
      preserved.push(await fileIdentity(replacement));
      // Exercise the stale host plan directly: renderer reconciliation can remove
      // its old action before a synthetic click, which is valid invalidation.
      const changed = await invoke("remove_source", {
        profileId: source.profile_id,
        previewSha256: oldPreview.preview_sha256,
        generation: removalGeneration,
      });
      assert(isRecord(changed) && changed.ok === false);
      assert(isRecord(changed.error) && changed.error.code === "conflict");
      await enlargedStage("stale-plan-refused");
      await browser.wait(
        async () => {
          const currentRow = (await browser.findElements(row))[0];
          return (
            currentRow &&
            (await executeBrowserScript(
              browser,
              (element, expected) =>
                element.querySelector("code")?.textContent?.trim() === expected,
              currentRow,
              replacement,
            ))
          );
        },
        15_000,
        "Renderer did not accept the replacement source identity",
      );
      await browser.wait(
        async () => !(await browser.findElements(dialog)).length,
        5_000,
        "Changed identity must retire the old inline intent",
      );
      const bootstrap = await invoke("get_bootstrap_status");
      assert(isRecord(bootstrap) && bootstrap.ok === true);
      const generation = transportValue("desktop_bootstrap_status", bootstrap.value).generation;
      const reviewed = await invoke("preview_source_removal", {
        profileId: source.profile_id,
        generation,
      });
      assert(isRecord(reviewed));
      assert.equal(reviewed.ok, true);
      const preview = transportValue("source_removal_preview", reviewed.value);
      const stale = await invoke("remove_source", {
        profileId: source.profile_id,
        previewSha256: preview.preview_sha256,
        generation: generation + 1,
      });
      assert(isRecord(stale));
      assert.equal(stale.ok, false);
      assert(isRecord(stale.error));
      assert.equal(stale.error.code, "conflict");
      await click(trigger);
      await browser.wait(until.elementLocated(button("Remove saved location…")), 15_000);
      text = await browser.findElement(dialog).getText();
      assert.ok(text.includes(replacement));
      await executeBrowserScript(
        browser,
        'arguments[0].scrollIntoView({ block: "start" });',
        await browser.findElement(dialog),
      );
      const report = path.join(output, "source-removal-accessibility.json");
      await captureAccessibilityReport(browser, report, artifacts);
      const screenshot = path.join(output, "native-source-removal-review.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await assertCompactReview(browser, impactSelector);
      await enlargedStage("renewed-impact");
      const compact = path.join(output, "native-source-removal-compact.png");
      await writeFile(compact, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(compact);
      // Diagnostic reads only: a native click is not an authoritative commit.
      // No transport interception, mutation retry or reads inside the DOM poll.
      const baselineActivityIds = new Set<string>();
      let baselineAvailable = false;
      const observe = async <Value,>(read: () => Promise<Value>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            read(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Read-only witness exceeded 3000ms")),
                3_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const retainRemovalWitness = async (
        stage: "before-consent" | "after-consent" | "wait-failed",
      ) => {
        try {
          const [bootstrapRead, sourceRead, activityRead, rowsRead] = await Promise.allSettled([
            observe(async () => {
              const reply = await invoke("get_bootstrap_status");
              assert(isRecord(reply) && reply.ok === true);
              const value = transportValue("desktop_bootstrap_status", reply.value);
              return {
                ready: value.ready,
                generation: value.generation,
                library_root: value.library_root,
              };
            }),
            observe(async () => {
              const reply = await invoke("get_sources");
              assert(isRecord(reply) && reply.ok === true);
              return transportValues("source", reply.value)
                .filter((item) => item.profile_id === source.profile_id)
                .map((item) => ({
                  profile_id: item.profile_id,
                  path: item.path,
                  sha256: item.sha256,
                }));
            }),
            observe(async () => {
              const reply = await invoke("get_activities");
              assert(isRecord(reply) && reply.ok === true);
              return transportValue("activity", reply.value);
            }),
            observe(() =>
              executeBrowserScript(
                browser,
                (profileId) => {
                  const matches = [
                    ...document.querySelectorAll<HTMLElement>(
                      ".source-health-row[data-source-profile]",
                    ),
                  ].filter((row) => row.dataset.sourceProfile === profileId);
                  return {
                    total_matches: matches.length,
                    rows: matches.slice(0, 4).map((row) => {
                      const impact = row.querySelector(
                        '[aria-label="Saved-location removal impact"]',
                      );
                      const owner = row.closest(
                        "[data-saved-folders-workspace], section[aria-label], section[aria-labelledby]",
                      );
                      return {
                        connected: row.isConnected,
                        visible:
                          row.getClientRects().length > 0 &&
                          !row.closest("[hidden], [inert], [aria-hidden=true]") &&
                          getComputedStyle(row).visibility !== "hidden",
                        path: row.querySelector("code")?.textContent?.trim().slice(0, 240) ?? null,
                        owner_label: owner?.getAttribute("aria-label")?.slice(0, 120) ?? null,
                        owner_labelledby:
                          owner?.getAttribute("aria-labelledby")?.slice(0, 120) ?? null,
                        owner_origin:
                          owner?.getAttribute("data-detail-origin")?.slice(0, 120) ?? null,
                        impact_busy: impact?.getAttribute("aria-busy") ?? null,
                        actions: [...row.querySelectorAll("button")]
                          .slice(0, 4)
                          .map((item) => item.textContent?.trim().slice(0, 100)),
                        alerts: [...row.querySelectorAll('[role="alert"]')]
                          .slice(0, 3)
                          .map((item) => item.textContent?.trim().slice(0, 160)),
                        statuses: [...row.querySelectorAll('[role="status"]')]
                          .slice(0, 3)
                          .map((item) => item.textContent?.trim().slice(0, 160)),
                      };
                    }),
                  };
                },
                source.profile_id,
              ),
            ),
          ]);
          const observation = <Value,>(result: PromiseSettledResult<Value>) =>
            result.status === "fulfilled"
              ? { state: "observed" as const, value: result.value }
              : { state: "unknown" as const, error: String(result.reason).slice(0, 280) };
          let activityObservation: unknown;
          if (activityRead.status === "fulfilled") {
            const feed = activityRead.value;
            if (stage === "before-consent") {
              for (const record of feed.records) baselineActivityIds.add(record.id);
              baselineAvailable = true;
            }
            const candidates = feed.records.filter(
              (record) =>
                record.operation === "remove_source" &&
                record.target_kind === "source" &&
                record.target_id === source.profile_id &&
                !baselineActivityIds.has(record.id),
            );
            activityObservation = {
              state: baselineAvailable ? "observed" : "baseline-unavailable",
              relation: !baselineAvailable
                ? "unavailable"
                : candidates.length === 0
                  ? "not-observed-or-not-emitted"
                  : candidates.length === 1
                    ? "single-unattributed-candidate"
                    : "ambiguous-unattributed-candidates",
              exact_invocation_correlation: false,
              active_and_actionable_complete: feed.active_and_actionable_complete,
              terminal_history_complete: feed.terminal_history_complete,
              candidate_count: candidates.length,
              candidates: candidates.slice(0, 4).map((record) => ({
                id: record.id,
                status: record.status,
                cancellation: record.cancellation,
                failure: record.failure
                  ? {
                      code: record.failure.code,
                      presentation_key: record.failure.presentation.presentation_key,
                      summary: record.failure.presentation.summary.slice(0, 280),
                      mutation_state: record.failure.presentation.mutation_state,
                    }
                  : null,
              })),
            };
          } else activityObservation = observation(activityRead);
          const witness = path.join(output, `source-removal-${stage}-read-only-witness.json`);
          await writeFile(
            witness,
            JSON.stringify(
              {
                stage,
                sampled_at: new Date().toISOString(),
                reviewed_context: {
                  profile_id: source.profile_id,
                  path: replacement,
                  generation,
                  library_root: library,
                  preview_sha256: preview.preview_sha256,
                },
                atomic_snapshot: false,
                bootstrap: observation(bootstrapRead),
                sources: observation(sourceRead),
                activities: activityObservation,
                renderer: observation(rowsRead),
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
          artifacts.push(witness);
        } catch (witnessError) {
          // Diagnostic failure never replaces the original action/wait result.
          process.stderr.write(
            `Source-removal witness ${stage} unavailable: ${String(witnessError).slice(0, 280)}\n`,
          );
        }
      };
      await retainRemovalWitness("before-consent");
      await click(button("Remove saved location…"));
      await confirmNative(
        "Remove saved location?",
        "Remove saved location",
        replacement,
        "source-native-confirmed",
      );
      await retainRemovalWitness("after-consent");
      try {
        await browser.wait(async () => (await browser.findElements(row)).length === 0, 15_000);
      } catch (waitError) {
        await retainRemovalWitness("wait-failed");
        throw waitError;
      }
      await enlargedStage("removed-location");
      assert.ok(!sources().some((item) => item.profile_id === source.profile_id));
      assert.deepEqual(others(), otherSources);
      assert.deepEqual(
        await Promise.all(preserved.map((item) => fileIdentity(item.path))),
        preserved,
      );
      assert.deepEqual(transportValue("status", command(["status", port.id])).active, install);
      assert.ok(
        transportValue("backup_inventory", command(["backup", "list", port.id])).backups.some(
          (item) => item.id === backup.id,
        ),
      );
      const result = path.join(output, "source-removal-result.json");
      await writeFile(
        result,
        JSON.stringify(
          {
            profile_id: source.profile_id,
            preserved_files: preserved,
            preserved_install: install.id,
            preserved_backup: backup.id,
            preserved_other_sources: otherSources,
            dismissal_and_native_cancel_preserved_reference: true,
            changed_registration_rejected: true,
            stale_generation_rejected: true,
            inline_keep_and_focus_restoration: true,
            destructive_action_styles: destructiveStyles,
            evidence:
              "native owned-file reference removal; no game compatibility or human-comprehension claim",
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      artifacts.push(result);
    } catch (error) {
      failure = { error };
      try {
        const image = path.join(output, "source-removal-enlargement-failure.png");
        await writeFile(image, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
        artifacts.push(image);
      } catch (captureError) {
        failure = {
          error: new AggregateError(
            [error, captureError],
            "Source removal and failure capture failed",
          ),
        };
      }
    }
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
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, error],
              "Source removal and enlargement cleanup failed",
            )
          : error,
      };
    }
    try {
      await browser.manage().window().setRect(originalWindow);
    } catch (error) {
      failure = {
        error: failure
          ? new AggregateError(
              [failure.error, error],
              "Source removal and window restoration failed",
            )
          : error,
      };
    }
    if (failure) throw failure.error;
  });
}
