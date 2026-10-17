import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { InstallRecord } from "../src/transport-types.generated.d.ts";
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
  __portcoveExternalReconciliationProbe?: { originalFetch: typeof fetch; commands: string[] };
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
interface ReconciliationObservations {
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
    value: string;
    converged_ms: number;
    activity_rows_before: number;
    activity_rows_after: number;
  };
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function activity(value: unknown) {
  const reply = object(value);
  assert.equal(reply.ok, true);
  return transportValue("activity", reply.value);
}
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import { captureAccessibilityReport } from "./desktop-review-controls.mts";

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
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
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
      await browser.wait(until.elementLocated(By.css('b[aria-label="1 installed"]')), 15_000);
      const cardLocator = By.xpath(
        `//article[contains(@class,"port-card") and starts-with(@aria-label,"${port.name}.")]`,
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
      const activityBefore = activity(await invoke("get_activities"));
      const policyStarted = Date.now();
      command(["policy", "set", port.id, "automatic"]);
      const policyControl = By.xpath('//button[contains(., "Game update behavior")]');
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
      assert.equal(adoptedActivity?.status, "succeeded");
      observations.policy = {
        value: "automatic",
        converged_ms: Date.now() - policyStarted,
        activity_rows_before: activityBefore.records.length,
        activity_rows_after: activityAfter.records.length,
      };
      observations.commands = await executeBrowserScript(browser, () => {
        const runtime = window as RefreshWindow;
        if (!runtime.__portcoveExternalReconciliationProbe)
          throw new Error("Reconciliation probe unavailable");
        return runtime.__portcoveExternalReconciliationProbe.commands;
      });
      assert.ok(observations.commands.includes("get_workspace_changed"));
      assert.ok(observations.commands.includes("get_workspace_snapshot"));
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
