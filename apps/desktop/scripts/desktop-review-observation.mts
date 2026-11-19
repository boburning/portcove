import type { WebDriver } from "selenium-webdriver";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { OutputDesktopBootstrapStatus } from "../src/transport-types.generated.d.ts";

/** Follow Core's explicit stale-read signal without replaying actions or changing scope. */
export async function readWorkspaceSnapshotObservation(
  invoke: ScenarioInvoke,
  binding: Pick<OutputDesktopBootstrapStatus, "generation" | "library_root">,
  readbacks: unknown[],
) {
  const initial = { generation: binding.generation, library_root: binding.library_root };
  const started = Date.now();
  // Keep ordinary settlement observation imports independent of Desktop packages.
  const { transportValue } = await import("./transport-values.mts");
  const { fixtureSuccess, fixtureObject } = await import("./desktop-scenario-state.mts");
  assert.ok(initial.library_root !== null);
  const withinBudget = () => {
    assert.ok(Date.now() - started < 60_000, "Workspace observation exceeded its 60-second budget");
  };
  const confirmScope = async () => {
    withinBudget();
    const current = transportValue(
      "desktop_bootstrap_status",
      fixtureSuccess(await invoke("get_bootstrap_status")),
    );
    withinBudget();
    assert.equal(current.ready, true);
    assert.equal(current.error, null);
    assert.equal(
      current.generation,
      initial.generation,
      "Workspace observation generation changed",
    );
    assert.equal(current.library_root, initial.library_root, "Workspace observation root changed");
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await confirmScope();
    // Await the owned read even if it crosses the acceptance budget. Never
    // detach it and race cleanup or another IPC call against its settlement.
    let response: unknown;
    try {
      response = await invoke("get_workspace_snapshot", { generation: initial.generation });
    } catch (error) {
      const refusal = {
        attempt,
        generation: initial.generation,
        elapsed_ms: Date.now() - started,
        outcome: "transport-rejected",
        error: String(error),
      };
      readbacks.push(refusal);
      console.info("Workspace observation:", JSON.stringify(refusal));
      throw error;
    }
    const reply = fixtureObject(response);
    const observation = {
      attempt,
      generation: initial.generation,
      elapsed_ms: Date.now() - started,
      outcome: reply.ok === false ? "refused" : "returned",
      ...(reply.ok === false ? { error: reply.error } : {}),
    };
    readbacks.push(observation);
    console.info("Workspace observation:", JSON.stringify(observation));
    withinBudget();
    const failure =
      reply.ok === false ? transportValue("desktop_desktop_error", reply.error) : undefined;
    if (
      failure?.code === "conflict" &&
      failure.details.workspace_snapshot_stale === "true" &&
      failure.details.retryable === "true"
    ) {
      await confirmScope();
      continue;
    }
    const workspace = transportValue("desktop_workspace_snapshot", fixtureSuccess(reply));
    await confirmScope();
    return workspace;
  }
  throw new Error("Workspace snapshot remained explicitly stale after 3 read attempts");
}

/** Observe one real interaction without changing its dispatch, assertions or deadline. */
export async function observeReviewSettlement(
  browser: WebDriver,
  selector: string,
  destination: string,
  artifacts: string[],
  interact: () => Promise<void>,
) {
  const key = `portcove-review-${randomUUID()}`;
  let installationFailure: string | undefined;
  try {
    await executeBrowserScript(
      browser,
      (key, selector) => {
        const records: unknown[] = [];
        let previous = "";
        let latest: unknown;
        let omitted = 0;
        const capture = (event?: Event) => {
          const dialog = document.querySelector(selector);
          const state = {
            connected: Boolean(dialog),
            text: dialog?.textContent?.slice(0, 3000),
            buttons: [...(dialog?.querySelectorAll("button") ?? [])].slice(0, 32).map((button) => ({
              label: button.textContent?.slice(0, 200),
              disabled: button.disabled,
              variant: button.getAttribute("data-variant"),
            })),
            failures: [...document.querySelectorAll(".error-banner")]
              .slice(0, 16)
              .map((element) => element.textContent?.slice(0, 3000)),
          };
          const serialized = JSON.stringify(state);
          latest = state;
          if (!event && serialized === previous) return;
          previous = serialized;
          if (records.length === 64) {
            omitted += 1;
            return;
          }
          records.push({
            milliseconds: performance.now(),
            event: event?.type ?? "state",
            trusted: event?.isTrusted,
            target:
              event?.target instanceof Element ? event.target.textContent?.slice(0, 200) : null,
            ...state,
          });
        };
        const click = (event: Event) => {
          if (event.target instanceof Element && event.target.closest(selector)) capture(event);
        };
        const observer = new MutationObserver(() => capture());
        Reflect.set(window, key, () => {
          observer.disconnect();
          document.removeEventListener("click", click, true);
          capture();
          return { available: true, records, omitted, latest };
        });
        document.addEventListener("click", click, true);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        capture();
      },
      key,
      selector,
    );
  } catch (error) {
    installationFailure = String(error).slice(0, 3000);
    console.error(`Could not start review settlement observations: ${installationFailure}`);
  }
  try {
    await interact();
  } finally {
    try {
      const observation = await executeBrowserScript(
        browser,
        (key) => {
          const finish: unknown = Reflect.get(window, key);
          if (typeof finish !== "function") return { available: false };
          Reflect.deleteProperty(window, key);
          const observed: unknown = Reflect.apply(finish, undefined, []);
          return observed;
        },
        key,
      );
      await writeFile(destination, JSON.stringify({ installationFailure, observation }, null, 2), {
        flag: "wx",
      });
      artifacts.push(destination);
    } catch (error) {
      // A vanished window or unavailable diagnostics cannot replace the original outcome.
      console.error(`Could not retain review settlement observations: ${String(error)}`);
    }
  }
}
