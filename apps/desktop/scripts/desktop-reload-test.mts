import type { ScenarioContext } from "./desktop-scenario-context.mts";
interface ReloadWindow extends Window {
  __TAURI_INTERNALS__?: { invoke(command: string, args?: object): Promise<unknown> };
}
interface CommandObservation {
  command: string;
  ok: boolean;
  error?: unknown;
}
interface ReloadObservation {
  cycle: number;
  started_at: string;
  commands?: CommandObservation[];
  errors?: (string | null)[];
  completed_at?: string;
}
function commandObservations(value: unknown): CommandObservation[] {
  assert.ok(Array.isArray(value));
  const entries: unknown[] = value;
  return entries.map((entry) => {
    assert.ok(entry !== null && typeof entry === "object" && "command" in entry && "ok" in entry);
    assert.ok(typeof entry.command === "string" && typeof entry.ok === "boolean");
    return {
      command: entry.command,
      ok: entry.ok,
      ...("error" in entry ? { error: entry.error } : {}),
    };
  });
}
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, until } from "selenium-webdriver";

export async function reloadScenario({
  browser,
  scenario,
  output,
  artifacts,
  cycles,
}: ScenarioContext & { cycles: number }) {
  await scenario("native-repeated-library-reload", async () => {
    const observations: ReloadObservation[] = [];
    const commands = ["get_workspace_snapshot", "get_doctor_report"];
    try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        const observation: ReloadObservation = {
          cycle: cycle + 1,
          started_at: new Date().toISOString(),
        };
        observations.push(observation);
        await browser.navigate().refresh();
        await browser.wait(
          until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
          10_000,
        );
        // Exercise the same separated essential and diagnostic reads as the renderer.
        // Fail on the first rejected batch; no hidden retry of a failure.
        observation.commands = commandObservations(
          await browser.executeAsyncScript<unknown>(
            (commands: string[], done: (value: unknown) => void) => {
              const native = (window as ReloadWindow).__TAURI_INTERNALS__;
              if (!native) throw new Error("Native bridge unavailable");
              void native
                .invoke("get_bootstrap_status")
                .then((value) => {
                  if (
                    value === null ||
                    typeof value !== "object" ||
                    !("generation" in value) ||
                    typeof value.generation !== "number"
                  )
                    throw new Error("Bootstrap generation unavailable");
                  const bootstrap = value;
                  return Promise.all(
                    commands.map((command) =>
                      native.invoke(command, { generation: bootstrap.generation }).then(
                        () => ({ command, ok: true }),
                        (error: unknown) => ({ command, ok: false, error }),
                      ),
                    ),
                  ).then(done);
                })
                .catch((error: unknown) =>
                  done([
                    {
                      command: "get_bootstrap_status",
                      ok: false,
                      error: error instanceof Error ? { message: error.message } : error,
                    },
                  ]),
                );
            },
            commands,
          ),
        );
        assert.ok(
          observation.commands.every((result) => result.ok),
          JSON.stringify(observation),
        );
        await browser.wait(
          async () => (await browser.findElements(By.css(".loading-state"))).length === 0,
          10_000,
        );
        observation.errors = await executeBrowserScript(browser, () =>
          Array.from(
            document.querySelectorAll('.error-banner[role="alert"], .bootstrap-error'),
            (element) => element.textContent,
          ),
        );
        assert.deepEqual(observation.errors, []);
        observation.completed_at = new Date().toISOString();
      }
    } finally {
      const report = path.join(output, "reload-observations.json");
      await writeFile(report, JSON.stringify(observations, null, 2), {
        flag: "wx",
      });
      artifacts.push(report);
    }
  });
}
