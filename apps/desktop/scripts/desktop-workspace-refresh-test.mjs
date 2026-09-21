import assert from "node:assert/strict";
import path from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { captureAccessibilityReport } from "./desktop-review-controls.mjs";

export async function workspaceRefreshScenario({
  browser,
  invoke,
  scenario,
  library,
  output,
  artifacts,
  cli,
  tool,
}) {
  await scenario("native-workspace-refresh-recovery", async () => {
    await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
    await browser.wait(until.elementLocated(By.css(".port-card")), 10_000);
    const before = await browser.findElements(By.css(".port-card"));
    const observations = {
      injection:
        "one synthetic get_workspace_snapshot rejection; subsequent requests use actual native IPC",
      before_cards: before.length,
    };
    try {
      await browser
        .executeAsyncScript((done) => {
          const native = window.__TAURI_INTERNALS__;
          const original = window.fetch;
          const target = native.convertFileSrc("get_workspace_snapshot", "ipc");
          window.__portcoveRefreshProbe = {
            original,
            calls: [],
            remaining: 1,
            injected: 0,
          };
          window.fetch = function (input, ...args) {
            const probe = window.__portcoveRefreshProbe;
            const url = typeof input === "string" ? input : (input.url ?? String(input));
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
          native
            .invoke("plugin:event|emit", {
              event: "portcove://library-changed",
              payload: "refresh-probe",
            })
            .then(
              () => done({ ok: true }),
              (error) => done({ error }),
            );
        })
        .then((result) => assert.equal(result.ok, true, JSON.stringify(result)));
      const retry = await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Retry refresh"]')),
        10_000,
      );
      observations.failure_text = await browser.executeScript(
        (button) => button.closest(".error-banner")?.textContent ?? "",
        retry,
      );
      assert.match(observations.failure_text, /Showing the last loaded information/);
      assert.doesNotMatch(
        observations.failure_text,
        /No files were changed|synthetic-native-refresh-failure/,
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
          browser.executeScript(
            () =>
              document.activeElement !== document.body &&
              Boolean(document.activeElement.closest('[data-focus-region="workspace"]')),
          ),
        5000,
      );
      observations.after_cards = (await browser.findElements(By.css(".port-card"))).length;
      assert.equal(observations.after_cards, before.length);
      observations.commands = await browser.executeScript(
        () => window.__portcoveRefreshProbe.calls,
      );
      assert.equal(await browser.executeScript(() => window.__portcoveRefreshProbe.injected), 1);
      assert.equal(
        observations.commands.filter((command) => command === "get_workspace_snapshot").length,
        2,
      );
      assert.ok(
        observations.commands.every(
          (command) => command.startsWith("get_") || command.startsWith("plugin:"),
        ),
        JSON.stringify(observations.commands),
      );
    } catch (error) {
      observations.failure = error.message;
      throw error;
    } finally {
      try {
        observations.probe = await browser.executeScript(() => {
          const probe = window.__portcoveRefreshProbe;
          if (!probe) return { installed: false };
          window.fetch = probe.original;
          const result = {
            injected: probe.injected,
            commands: probe.calls,
            restored: window.fetch === probe.original,
          };
          delete window.__portcoveRefreshProbe;
          return result;
        });
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
    const command = (args) => {
      const result = spawnCommand(
        cli,
        ["--library", library, "--json", "--non-interactive", ...args],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, PORTCOVE_PREFERENCES: path.join(output, "preferences.json") },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      return response.data;
    };
    const platform =
      process.platform === "win32"
        ? "windows-x86-64"
        : process.platform === "darwin"
          ? process.arch === "arm64"
            ? "macos-aarch64"
            : "macos-x86-64"
          : "linux-x86-64";
    const port = command(["catalog", "show", "opengoal-jak1"]);
    const original = path.join(output, "external-cli-owned-install");
    await mkdir(original);
    for (const relative of [
      port.executable_hints[platform][0],
      port.setup_executable_hints[platform][0],
    ]) {
      const destination = path.join(original, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(tool, destination);
    }
    const observations = {
      mutation_process: "standalone CLI",
      synthetic_desktop_events: 0,
      intervals_ms: { visible_idle_database: 10_000, visible_filesystem_fallback: 60_000 },
      commands: [],
    };
    await browser.executeScript(() => {
      const originalFetch = window.fetch;
      window.__portcoveExternalReconciliationProbe = { originalFetch, commands: [] };
      window.fetch = function (input, ...args) {
        const url = typeof input === "string" ? input : (input.url ?? String(input));
        const parsed = new URL(url, location.href);
        if (parsed.hostname === "ipc.localhost")
          window.__portcoveExternalReconciliationProbe.commands.push(
            decodeURIComponent(parsed.pathname.slice(1)),
          );
        return originalFetch.call(window, input, ...args);
      };
    });
    try {
      const started = Date.now();
      const install = command(["adopt", original, "--port", port.id, "--yes"]);
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
      command(["source", "add", port.source_profile, source]);
      await browser.wait(
        async () => (await card.getAttribute("aria-label")) !== beforeSource,
        15_000,
      );
      observations.source = {
        profile_id: port.source_profile,
        converged_ms: Date.now() - sourceStarted,
        card_after_source: await card.getAttribute("aria-label"),
      };

      await card.findElement(By.css("button[data-detail-origin]")).click();
      const activityBefore = await invoke("get_activities");
      assert.equal(activityBefore.ok, true);
      const policyStarted = Date.now();
      command(["policy", "set", port.id, "automatic"]);
      const policyControl = By.xpath('//button[contains(., "Saved update policy")]');
      await browser.wait(
        async () =>
          (await browser.findElement(policyControl).getText()).includes(
            "Install when running updates",
          ),
        15_000,
      );
      const activityAfter = await invoke("get_activities");
      assert.equal(activityAfter.ok, true);
      assert.equal(
        activityAfter.value.length,
        activityBefore.value.length,
        "policy mutation must exercise reconciliation without a new activity row",
      );
      const adoptedActivity = activityAfter.value.find(
        (activity) => activity.operation === "adopt" && activity.target_id === port.id,
      );
      assert.equal(adoptedActivity?.status, "succeeded");
      observations.policy = {
        value: "automatic",
        converged_ms: Date.now() - policyStarted,
        activity_rows_before: activityBefore.value.length,
        activity_rows_after: activityAfter.value.length,
      };
      observations.commands = await browser.executeScript(
        () => window.__portcoveExternalReconciliationProbe.commands,
      );
      assert.ok(observations.commands.includes("get_workspace_changed"));
      assert.ok(observations.commands.includes("get_workspace_snapshot"));
    } finally {
      const probe = await browser.executeScript(() => {
        const current = window.__portcoveExternalReconciliationProbe;
        if (!current) return { restored: false, commands: [] };
        window.fetch = current.originalFetch;
        delete window.__portcoveExternalReconciliationProbe;
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
