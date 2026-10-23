import {
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { InstallRecord, ActivityRecord } from "../src/transport-types.generated.d.ts";
import { transportValue } from "./transport-values.mts";
interface RefreshContext extends ScenarioContext {
  invoke: (command: string) => Promise<unknown>;
  library: string;
  cli: string | undefined;
  tool: string | undefined;
}
interface RefreshWindow extends Window {
  __TAURI_INTERNALS__?: {
    convertFileSrc(command: string, protocol: string): string;
    invoke(command: string, args: unknown): Promise<unknown>;
  };
  __portcoveRefreshProbe?: {
    original: typeof fetch;
    calls: string[];
    remaining: number;
    injected: number;
  };
  __portcoveExternalReconciliationProbe?: {
    originalFetch: typeof fetch;
    commands: string[];
    formatFetch?: typeof fetch;
    formatInjections?: number;
    supportRequests?: number;
    supportGate?: Promise<void>;
    releaseSupport?: () => void;
  };
}
interface RefreshObservations {
  injection: string;
  before_cards: number;
  failure_text?: string;
  after_cards?: number;
  commands?: string[];
  failure?: string;
  probe?: { installed: false } | { injected: number; commands: string[]; restored: boolean };
}
interface SourceFormatObservations {
  injection: string;
  before: unknown;
  guidance?: string;
  injections?: number;
  after?: unknown;
  restored?: boolean;
}
interface ReconciliationObservations {
  source_format?: SourceFormatObservations;
  commit_convergence_synthetic_desktop_events: number;
  progress_reconciliation?: {
    injection: string;
    activity_id: string;
    durable_status: string;
    next_task_label: string | null;
    next_task_indeterminate: boolean;
    support_requests: number;
  };
  mutation_process: string;
  synthetic_desktop_events: number;
  intervals_ms: { visible_idle_database: number; visible_filesystem_fallback: number };
  commands: string[];
  install?: Pick<InstallRecord, "id" | "version"> & {
    converged_ms: number;
    card_before_source: string | null;
  };
  source?: { profile_id: string; converged_ms: number; card_after_source: string | null };
  policy?: {
    before: string;
    displayed_before: string;
    value: string;
    converged_ms: number;
    activity_rows_before: number;
    activity_rows_after: number;
  };
}
function activity(value: unknown) {
  const reply = object(value);
  assert.equal(reply.ok, true);
  return transportValue("activity", reply.value);
}
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import { revealDetailSection, captureAccessibilityReport } from "./desktop-review-controls.mts";

export async function workspaceRefreshScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  tool,
}: RefreshContext) {
  await scenario("native-workspace-refresh-recovery", async () => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Find games")]')).click();
    await browser.wait(until.elementLocated(By.css(".port-card")), 10_000);
    const before = await browser.findElements(By.css(".port-card"));
    const observations: RefreshObservations = {
      injection:
        "one synthetic get_workspace_snapshot rejection; subsequent requests use actual native IPC",
      before_cards: before.length,
    };
    try {
      await browser
        .executeAsyncScript<unknown>((done: (value: unknown) => void) => {
          const runtime = window as RefreshWindow;
          const native = runtime.__TAURI_INTERNALS__;
          if (!native) throw new Error("Native bridge unavailable");
          const original = window.fetch;
          const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
          runtime.__portcoveRefreshProbe = {
            original,
            calls: [],
            remaining: 1,
            injected: 0,
          };
          window.fetch = function (input, ...args) {
            const probe = runtime.__portcoveRefreshProbe;
            if (!probe) throw new Error("Refresh probe unavailable");
            // Preserve the fetch probe's existing coercion of cross-realm request-like inputs.
            const url =
              typeof input === "string"
                ? input
                : ((typeof input === "object" && input !== null && "url" in input
                    ? input.url
                    : undefined) ??
                  // oxlint-disable-next-line typescript/no-base-to-string
                  String(input));
            const parsed = new URL(url, location.href);
            if (parsed.hostname === "ipc.localhost")
              probe.calls.push(decodeURIComponent(parsed.pathname.slice(1)));
            if (url === target && probe.remaining-- > 0) {
              probe.injected++;
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    code: "state",
                    message: "synthetic-native-refresh-failure",
                    details: {},
                    presentation: {
                      presentation_key: "state_unavailable",
                      summary: "Library information is temporarily unavailable.",
                      tone: "error",
                      mutation_state: "unknown",
                      phase: null,
                      recovery_actions: ["review_current_state", "view_technical_details"],
                      technical_message:
                        "Synthetic refresh rejection for presentation verification.",
                      technical_context: {},
                    },
                  }),
                  {
                    headers: {
                      "Content-Type": "application/json",
                      "Tauri-Response": "error",
                    },
                  },
                ),
              );
            }
            return original.call(window, input, ...args);
          };
          void native
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: "refresh-probe",
            })
            .then(
              () => done({ ok: true }),
              (error: unknown) => done({ error }),
            );
        })
        .then((result) => assert.equal(object(result).ok, true, JSON.stringify(result)));
      const retry = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Retry refresh"]')),
        10_000,
      );
      assert.equal(await retry.getAttribute("data-slot"), "button");
      assert.equal(await retry.getAttribute("data-variant"), "outline");
      observations.failure_text = await executeBrowserScript(
        browser,
        (button) => button.closest(".error-banner")?.textContent ?? "",
        retry,
      );
      assert.match(observations.failure_text, /Showing the last loaded information/);
      assert.match(observations.failure_text, /View technical details/);
      assert.doesNotMatch(
        observations.failure_text,
        /No files were changed|couldn't confirm whether anything changed|synthetic-native-refresh-failure/,
      );
      assert.equal((await browser.findElements(By.css(".port-card"))).length, before.length);
      const accessibilityPath = path.join(output, "workspace-refresh-accessibility.json");
      await captureAccessibilityReport(browser, accessibilityPath, artifacts);
      const screenshot = path.join(output, "native-workspace-refresh-failure.png");
      await writeFile(screenshot, await browser.takeScreenshot(), {
        encoding: "base64",
        flag: "wx",
      });
      artifacts.push(screenshot);
      await retry.click();
      await browser.wait(until.stalenessOf(retry), 10_000);
      await browser.wait(
        async () =>
          executeBrowserScript(
            browser,
            () =>
              document.activeElement !== document.body &&
              Boolean(document.activeElement?.closest('[data-focus-region="workspace"]')),
          ),
        5000,
      );
      observations.after_cards = (await browser.findElements(By.css(".port-card"))).length;
      assert.equal(observations.after_cards, before.length);
      observations.commands = await executeBrowserScript(browser, () => {
        const runtime = window as RefreshWindow;
        if (!runtime.__portcoveRefreshProbe) throw new Error("Refresh probe unavailable");
        return runtime.__portcoveRefreshProbe.calls;
      });
      assert.equal(
        await executeBrowserScript(browser, () => {
          const runtime = window as RefreshWindow;
          if (!runtime.__portcoveRefreshProbe) throw new Error("Refresh probe unavailable");
          return runtime.__portcoveRefreshProbe.injected;
        }),
        1,
      );
      assert.equal(
        observations.commands.filter((command) => command === "get_workspace_snapshot").length,
        2,
      );
      assert.equal(
        observations.commands.filter((command) => command === "discover_orphaned_operations")
          .length,
        1,
      );
      assert.ok(
        observations.commands.every(
          (command: string) =>
            command.startsWith("get_") ||
            command.startsWith("plugin:") ||
            command === "discover_orphaned_operations",
        ),
        JSON.stringify(observations.commands),
      );
    } catch (error) {
      observations.failure = errorMessage(error);
      throw error;
    } finally {
      try {
        observations.probe = await executeBrowserScript(browser, () => {
          const runtime = window as RefreshWindow;
          const probe = runtime.__portcoveRefreshProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            injected: probe.injected,
            commands: probe.calls,
            restored: window.fetch === probe.original,
          };
          delete runtime.__portcoveRefreshProbe;
          return result;
        });
        assert.ok("restored" in observations.probe);
        assert.equal(observations.probe.restored, true);
      } finally {
        const report = path.join(output, "workspace-refresh-observations.json");
        await writeFile(report, JSON.stringify(observations, null, 2), {
          flag: "wx",
        });
        artifacts.push(report);
      }
    }
  });

  await scenario("native-external-cli-reconciliation", async () => {
    assert.ok(cli && tool, "external CLI reconciliation requires owned fixture inputs");
    const command = ownedFixtureCommand({ cli, library, output });
    const platform =
      process.platform === "win32"
        ? "windows-x86-64"
        : process.platform === "darwin"
          ? process.arch === "arm64"
            ? "macos-aarch64"
            : "macos-x86-64"
          : "linux-x86-64";
    const port = transportValue("port", command(["catalog", "show", "opengoal-jak1"]));
    const original = path.join(output, "external-cli-owned-install");
    await mkdir(original);
    for (const relative of [
      required(required(port.executable_hints[platform])[0]),
      required(required(port.setup_executable_hints[platform])[0]),
    ]) {
      const destination = path.join(original, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(tool, destination);
    }
    const observations: ReconciliationObservations = {
      mutation_process: "standalone CLI",
      commit_convergence_synthetic_desktop_events: 0,
      synthetic_desktop_events: 0,
      intervals_ms: { visible_idle_database: 10_000, visible_filesystem_fallback: 60_000 },
      commands: [],
    };
    await executeBrowserScript(browser, () => {
      const runtime = window as RefreshWindow;
      const originalFetch = window.fetch;
      runtime.__portcoveExternalReconciliationProbe = { originalFetch, commands: [] };
      window.fetch = function (input, ...args) {
        // Preserve the fetch probe's existing coercion of cross-realm request-like inputs.
        const url =
          typeof input === "string"
            ? input
            : ((typeof input === "object" && input !== null && "url" in input
                ? input.url
                : undefined) ??
              // oxlint-disable-next-line typescript/no-base-to-string
              String(input));
        const parsed = new URL(url, location.href);
        if (parsed.hostname === "ipc.localhost") {
          const probe = runtime.__portcoveExternalReconciliationProbe;
          if (!probe) throw new Error("Reconciliation probe unavailable");
          probe.commands.push(decodeURIComponent(parsed.pathname.slice(1)));
        }
        return originalFetch.call(window, input, ...args);
      };
    });
    try {
      const started = Date.now();
      const install = object(command(["adopt", original, "--port", port.id, "--yes"]));
      assert.ok(typeof install.id === "string" && typeof install.version === "string");
      await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
      await browser.wait(until.elementLocated(By.css('b[aria-label="1 in library"]')), 15_000);
      const cardLocator = By.xpath(
        `//article[contains(@class,"port-card") and .//button[@data-detail-game-id="${port.id}"]]`,
      );
      const card = await browser.wait(until.elementLocated(cardLocator), 15_000);
      const beforeSource = await card.getAttribute("aria-label");
      observations.install = {
        id: install.id,
        version: install.version,
        converged_ms: Date.now() - started,
        card_before_source: beforeSource,
      };

      const source = path.join(output, "external-cli-source.iso");
      await writeFile(source, "owned source awaiting upstream validation");
      const sourceStarted = Date.now();
      command(["source", "add", required(port.source_profile), source]);
      await browser.wait(
        async () => (await card.getAttribute("aria-label")) !== beforeSource,
        15_000,
      );
      observations.source = {
        profile_id: required(port.source_profile),
        converged_ms: Date.now() - sourceStarted,
        card_after_source: await card.getAttribute("aria-label"),
      };

      await card.findElement(By.css("button[data-detail-origin]")).click();
      await revealDetailSection(browser, "Versions");
      const preferences = await browser.wait(
        until.elementLocated(By.xpath('//summary[normalize-space(.)="Future update preferences"]')),
        15_000,
      );
      await preferences.click();
      const policyControl = By.xpath('//button[contains(., "Game update behavior")]');
      await browser.wait(until.elementIsVisible(await browser.findElement(policyControl)), 10_000);
      const policyBefore = transportValue("status", command(["status", port.id])).update_policy;
      assert.notEqual(policyBefore, "automatic", "Policy reconciliation requires a real change");
      const expectedBefore = policyBefore === "notify" ? "Notify me" : "Keep update for later";
      await browser.wait(
        async () => (await browser.findElement(policyControl).getText()).includes(expectedBefore),
        15_000,
        "Displayed policy must match the different Core preimage before the external mutation",
      );
      const displayedBefore = await browser.findElement(policyControl).getText();
      const activityBefore = activity(await invoke("get_activities"));
      const policyStarted = Date.now();
      command(["policy", "set", port.id, "automatic"]);
      assert.equal(
        transportValue("status", command(["status", port.id])).update_policy,
        "automatic",
      );
      await browser.wait(
        async () =>
          (await browser.findElement(policyControl).getText()).includes(
            "Install when I run updates",
          ),
        15_000,
      );
      const activityAfter = activity(await invoke("get_activities"));
      assert.ok(Array.isArray(activityBefore.records));
      assert.ok(Array.isArray(activityAfter.records));
      assert.equal(
        activityAfter.records.length,
        activityBefore.records.length,
        "policy mutation must exercise reconciliation without a new activity row",
      );
      const adoptedActivity = activityAfter.records.find(
        (activity) => activity.operation === "adopt" && activity.target_id === port.id,
      );
      assert.ok(adoptedActivity);
      assert.equal(adoptedActivity.status, "succeeded");
      observations.policy = {
        before: policyBefore,
        displayed_before: displayedBefore,
        value: "automatic",
        converged_ms: Date.now() - policyStarted,
        activity_rows_before: activityBefore.records.length,
        activity_rows_after: activityAfter.records.length,
      };
      // The preceding commits converge without injected notifications. Separately
      // replay one delayed progress event for the actual terminal Core activity.
      await browser
        .executeAsyncScript<unknown>(
          (
            activity: Pick<ActivityRecord, "id" | "operation" | "target_kind" | "target_id">,
            done: (value: unknown) => void,
          ) => {
            const native = (window as RefreshWindow).__TAURI_INTERNALS__;
            if (!native) throw new Error("Native bridge unavailable");
            native
              .invoke("plugin:event|emit", {
                event: "portcove://operation",
                payload: {
                  schema_version: 3,
                  operation_id: activity.id,
                  parent_operation_id: null,
                  sequence: 100,
                  timestamp_ms: Date.now(),
                  operation: activity.operation,
                  target: { kind: activity.target_kind, id: activity.target_id },
                  type: "progress",
                  phase: "copy",
                  completed: 1,
                  total: 10,
                },
              })
              .then(
                () => done({ ok: true }),
                (error: unknown) => done({ error }),
              );
          },
          adoptedActivity,
        )
        .then((result) => assert.equal(object(result).ok, true, JSON.stringify(result)));
      observations.synthetic_desktop_events = 1;
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
      const advanced = await browser.wait(
        until.elementLocated(By.xpath('//button[@aria-controls="settings-advanced"]')),
        10_000,
      );
      await advanced.click();
      await browser.wait(
        until.elementIsVisible(await browser.findElement(By.id("settings-advanced"))),
        10_000,
      );
      await executeBrowserScript(browser, () => {
        const runtime = window as RefreshWindow;
        const probe = runtime.__portcoveExternalReconciliationProbe;
        const native = runtime.__TAURI_INTERNALS__;
        if (!probe || !native) throw new Error("Reconciliation native probe unavailable");
        const previous = window.fetch;
        probe.supportRequests = 0;
        probe.supportGate = new Promise<void>((resolve) => {
          probe.releaseSupport = resolve;
        });
        window.fetch = async function (input, ...args) {
          const url =
            typeof input === "string"
              ? input
              : ((typeof input === "object" && input !== null && "url" in input
                  ? input.url
                  : undefined) ??
                // Preserve existing request-like URL coercion for cross-realm inputs.
                // oxlint-disable-next-line typescript/no-base-to-string
                String(input));
          if (url === native.convertFileSrc("create_support_bundle", "ipc")) {
            if (typeof probe.supportRequests !== "number")
              throw new Error("Support probe counter unavailable");
            probe.supportRequests++;
            await probe.supportGate;
          }
          return previous.call(window, input, ...args);
        };
      });
      try {
        await browser
          .findElement(By.xpath('//button[normalize-space(.)="Create support bundle"]'))
          .click();
        await browser.wait(
          async () =>
            executeBrowserScript(browser, () => {
              const probe = (window as RefreshWindow).__portcoveExternalReconciliationProbe;
              if (!probe) throw new Error("Reconciliation probe unavailable");
              return probe.supportRequests === 1;
            }),
          10_000,
        );
        const progress = await browser.wait(
          until.elementLocated(By.css('.operation-bar [role="progressbar"]')),
          10_000,
        );
        const label = await progress.getAttribute("aria-label");
        assert.equal(label, "Working");
        assert.equal(await progress.getAttribute("aria-valuenow"), null);
        observations.progress_reconciliation = {
          injection:
            "one delayed synthetic progress event for an actual Core terminal activity; support-bundle IPC held before dispatch",
          activity_id: adoptedActivity.id,
          durable_status: adoptedActivity.status,
          next_task_label: label,
          next_task_indeterminate: true,
          support_requests: 1,
        };
        const screenshot = path.join(output, "terminal-snapshot-next-task.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
      } finally {
        await executeBrowserScript(browser, () => {
          const probe = (window as RefreshWindow).__portcoveExternalReconciliationProbe;
          if (!probe) throw new Error("Reconciliation probe unavailable");
          probe.releaseSupport?.();
        });
      }
      await browser.wait(
        async () => (await browser.findElements(By.css(".operation-bar"))).length === 0,
        15_000,
      );
      const reconciledActivity = activity(await invoke("get_activities"));
      assert.equal(
        reconciledActivity.records.find((activity) => activity.id === adoptedActivity.id)?.status,
        "succeeded",
      );
      observations.commands = await executeBrowserScript(browser, () => {
        const probe = (window as RefreshWindow).__portcoveExternalReconciliationProbe;
        if (!probe) throw new Error("Reconciliation probe unavailable");
        return probe.commands;
      });
      assert.ok(observations.commands.includes("get_workspace_changed"));
      assert.ok(observations.commands.includes("get_workspace_snapshot"));
      // Controlled native presentation only: the real Core status remains
      // unchanged; actual incompatible-source execution is covered separately.
      await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
      const sourceFormatCard = await browser.wait(until.elementLocated(cardLocator), 15_000);
      await sourceFormatCard.findElement(By.css("button[data-detail-origin]")).click();
      await browser.wait(until.elementLocated(By.css(".detail-panel")), 15_000);
      const sourceFormat: SourceFormatObservations = {
        injection:
          "replace one rendered launch assessment/readiness with incompatible_source and required extension z64; Core unchanged",
        before: command(["status", port.id]),
      };
      try {
        await executeBrowserScript(
          browser,
          (portId) => {
            const previous = window.fetch;
            const runtime = window as RefreshWindow;
            const probe = runtime.__portcoveExternalReconciliationProbe;
            const native = runtime.__TAURI_INTERNALS__;
            if (!probe || !native) throw new Error("Reconciliation probe unavailable");
            probe.formatFetch = previous;
            probe.formatInjections = 0;
            const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
            window.fetch = async function (input, ...args) {
              const response = await previous.call(window, input, ...args);
              const inputValue: unknown = input;
              const url =
                typeof inputValue === "string"
                  ? inputValue
                  : ((inputValue !== null &&
                    (typeof inputValue === "object" || typeof inputValue === "function") &&
                    "url" in inputValue
                      ? inputValue.url
                      : undefined) ??
                    // Preserve fetch's existing coercion of cross-realm request-like values.
                    // oxlint-disable-next-line typescript/no-base-to-string
                    String(input));
              if (url !== target || !response.ok) return response;
              const record = (value: unknown): value is Record<string, unknown> =>
                value !== null && typeof value === "object" && !Array.isArray(value);
              const snapshot: unknown = await response.clone().json();
              if (!record(snapshot) || !Array.isArray(snapshot.statuses))
                throw new Error("Workspace snapshot statuses unavailable");
              const statuses: unknown[] = snapshot.statuses;
              if (!statuses.every(record)) throw new Error("Workspace status must be an object");
              if (!statuses.some((status) => status.port_id === portId)) return response;
              if (typeof probe.formatInjections !== "number")
                throw new Error("Source format probe counter unavailable");
              probe.formatInjections++;
              return new Response(
                JSON.stringify({
                  ...snapshot,
                  statuses: statuses.map((status) => {
                    if (status.port_id !== portId) return status;
                    if (!record(status.readiness) || !Array.isArray(status.port_actions))
                      throw new Error("Workspace readiness/actions unavailable");
                    const assessments: unknown[] = status.port_actions;
                    if (!assessments.every(record))
                      throw new Error("Workspace action assessment must be an object");
                    return {
                      ...status,
                      readiness: {
                        ...status.readiness,
                        launchable: false,
                        source: "current",
                        blockers: ["incompatible_source"],
                        required_source_extension: "z64",
                      },
                      port_actions: assessments.map((assessment) =>
                        assessment.action === "launch"
                          ? {
                              action: "launch",
                              availability: "waiting",
                              reason: "incompatible_source",
                            }
                          : assessment,
                      ),
                    };
                  }),
                }),
                {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                },
              );
            };
            window.dispatchEvent(new Event("focus"));
          },
          port.id,
        );
        const expected =
          "This runtime requires an uncompressed .z64 game file. Select and validate that file before playing.";
        await browser.wait(
          async () =>
            (await browser.findElement(By.css(".detail-panel")).getText()).includes(expected),
          10_000,
        );
        const launchControls = await browser.findElements(
          By.xpath(
            '//section[contains(@class,"detail-panel")]//div[contains(@class,"primary-actions")]//button[normalize-space(.)="Play" or normalize-space(.)="Try launch"]',
          ),
        );
        for (const launch of launchControls) assert.equal(await launch.isEnabled(), false);
        const locate = await browser.findElement(
          By.xpath(
            '//section[contains(@class,"detail-panel")]//div[contains(@class,"primary-actions")]//button[normalize-space(.)="Locate game files"]',
          ),
        );
        assert.equal(
          await locate.isEnabled(),
          true,
          "The specific file recovery must remain actionable",
        );
        sourceFormat.guidance = expected;
        sourceFormat.injections = await executeBrowserScript(browser, () => {
          const probe = (window as RefreshWindow).__portcoveExternalReconciliationProbe;
          if (typeof probe?.formatInjections !== "number")
            throw new Error("Source format probe counter unavailable");
          return probe.formatInjections;
        });
        assert.ok(sourceFormat.injections > 0);
        const screenshot = path.join(output, "native-source-format-guidance.png");
        await writeFile(screenshot, await browser.takeScreenshot(), {
          encoding: "base64",
          flag: "wx",
        });
        artifacts.push(screenshot);
        await captureAccessibilityReport(
          browser,
          path.join(output, "source-format-accessibility.json"),
          artifacts,
        );
        sourceFormat.after = command(["status", port.id]);
        assert.deepEqual(sourceFormat.after, sourceFormat.before);
      } finally {
        sourceFormat.restored = await executeBrowserScript(browser, () => {
          const probe = (window as RefreshWindow).__portcoveExternalReconciliationProbe;
          if (!probe?.formatFetch) return false;
          window.fetch = probe.formatFetch;
          window.dispatchEvent(new Event("focus"));
          return window.fetch === probe.formatFetch;
        });
        observations.source_format = sourceFormat;
      }
      assert.equal(sourceFormat.restored, true);
      await browser.wait(
        async () =>
          !(await browser.findElement(By.css(".detail-panel")).getText()).includes(
            "This runtime requires an uncompressed .z64 game file.",
          ),
        10_000,
      );
    } finally {
      const probe = await executeBrowserScript(browser, () => {
        const runtime = window as RefreshWindow;
        const current = runtime.__portcoveExternalReconciliationProbe;
        if (!current) return { restored: false, commands: [] };
        window.fetch = current.originalFetch;
        delete runtime.__portcoveExternalReconciliationProbe;
        return { restored: window.fetch === current.originalFetch, commands: current.commands };
      });
      assert.equal(probe.restored, true);
      observations.commands = probe.commands;
      const report = path.join(output, "external-cli-reconciliation-observations.json");
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
      artifacts.push(report);
    }
  });
}
