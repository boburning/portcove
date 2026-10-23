import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { executeBrowserScript } from "./browser-script.mts";
import { transportValue } from "./transport-values.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { requireTrustedProbeCleanup } from "./desktop-owned-ipc-probe.mts";

import {
  activateManualRefresh,
  installListenerLifetimeProbe,
  type ListenerSnapshot,
  type ListenerProbe,
} from "./desktop-listener-lifetime-probe.mts";

interface ListenerContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  output: string;
  artifacts: string[];
  chooseOwnedLibrary: ReturnType<typeof nativeConfirmation>;
  observeRunning: (index: number) => Promise<unknown>;
  mode?: "late" | "reject";
}

// Qualification-only bridge-input and response-delay control. Core responses,
// generations, running work and event registrations are always real.
export async function listenerLifetimeScenario({
  browser,
  invoke,
  output,
  artifacts,
  chooseOwnedLibrary,
  observeRunning,
  mode = "late",
}: ListenerContext) {
  assert.equal(typeof chooseOwnedLibrary, "function", "Owned picker must survive journey dispatch");
  const alternate = path.join(output, "listener-reviewed-alternate");
  await mkdir(alternate);
  const key = `__portcoveListenerProbe_${randomUUID()}`;
  const bootstrap = await invoke("get_bootstrap_status");
  assert.equal(bootstrap.ok, true);
  const before = transportValue("desktop_bootstrap_status", bootstrap.value);
  const originalIdentity = await invoke("get_library_identity", { generation: before.generation });
  assert.equal(originalIdentity.ok, true);
  const identity = transportValue("library_identity", originalIdentity.value);
  assert.equal(typeof before.library_root, "string");
  assert.ok(before.library_root);
  await executeBrowserScript(
    browser,
    installListenerLifetimeProbe,
    key,
    alternate,
    before.library_root,
    mode,
  );
  const capture = () =>
    executeBrowserScript(
      browser,
      (key) => {
        const probe = Reflect.get(window, key) as ListenerProbe | undefined;
        if (!probe) throw new Error("Listener probe is unavailable");
        return probe.capture();
      },
      key,
    );
  let primary: unknown;
  const observations: {
    control: string;
    before: typeof before;
    identity: typeof identity;
    switches: unknown[];
    last_bootstrap?: Record<string, unknown>;
    after_release?: ListenerSnapshot;
    cleanup?: unknown;
  } = {
    control:
      mode === "late"
        ? "owned same-root bridge input; actual listen response delayed"
        : "owned same-root bridge input; one invalid event argument, actual native rejection",
    before,
    identity,
    switches: [],
  };
  try {
    for (let index = 0; index < 2; index++) {
      await browser.findElement(By.xpath('//nav//button[contains(., "Settings")]')).click();
      await browser.wait(
        until.elementLocated(By.xpath('//button[normalize-space(.)="Choose another library"]')),
        15_000,
      );
      await browser
        .findElement(By.xpath('//button[normalize-space(.)="Choose another library"]'))
        .click();
      const picker = await chooseOwnedLibrary(
        "Choose Portcove library",
        "Select Folder",
        "Folder",
        `listener-picker-${index}`,
        undefined,
        alternate,
      );
      assert.ok(
        picker !== null &&
          typeof picker === "object" &&
          "selected_directory" in picker &&
          typeof picker.selected_directory === "string",
      );
      assert.equal(path.resolve(picker.selected_directory), path.resolve(alternate));
      const review = await browser.wait(
        until.elementLocated(By.css('[aria-labelledby="library-selection-review-title"]')),
        15_000,
      );
      assert.ok((await review.getText()).includes(alternate));
      await review.findElement(By.xpath('.//button[normalize-space(.)="Switch library"]')).click();
      await browser.wait(
        async () => {
          const current = await invoke("get_bootstrap_status");
          observations.last_bootstrap = current;
          return (
            current.ok &&
            transportValue("desktop_bootstrap_status", current.value).generation ===
              before.generation + index + 1
          );
        },
        15_000,
        "Core must advance the genuine generation",
      );
      await browser.wait(
        async () => {
          const entries = (await capture()).listeners;
          const current = entries[index];
          return (
            entries.length === index + 1 &&
            (mode === "reject" && index === 0
              ? current?.rejected &&
                !current.callback_present &&
                (await capture()).responses.every((entry) => entry.settled)
              : Number.isSafeInteger(current?.event_id))
          );
        },
        15_000,
        "Each new owner must complete one actual operation registration",
      );
      if (mode === "reject") {
        const notice = By.xpath('//*[normalize-space(.)="Live workspace updates are unavailable"]');
        if (index === 0) {
          await browser.wait(until.elementLocated(notice), 15_000);
          await browser.wait(
            () => executeBrowserScript(browser, activateManualRefresh, key),
            15_000,
            "The current degraded owner must expose an idle, enabled refresh action",
          );
          await browser.wait(
            async () => (await capture()).manual_refresh?.accepted === true,
            15_000,
          );
          await browser.wait(
            until.elementLocated(By.xpath('//button[normalize-space(.)="Refreshing library…"]')),
            15_000,
          );
          const refresh = (await capture()).manual_refresh;
          assert.ok(refresh);
          assert.equal(refresh.accepted, true);
          assert.equal(refresh.generation, before.generation + 1);
          transportValue("desktop_workspace_snapshot", refresh.value);
          await executeBrowserScript(
            browser,
            (key) => (Reflect.get(window, key) as ListenerProbe).release(),
            key,
          );
          await browser.wait(
            async () => (await capture()).responses.every((entry) => entry.settled),
            15_000,
          );
          await browser.wait(
            until.elementLocated(By.xpath('//button[normalize-space(.)="Refresh now"]')),
            15_000,
          );
        } else
          await browser.wait(async () => (await browser.findElements(notice)).length === 0, 15_000);
      }
      const response = await invoke("get_bootstrap_status");
      assert.equal(response.ok, true);
      const current = transportValue("desktop_bootstrap_status", response.value);
      assert.equal(current.library_root, before.library_root);
      const currentIdentity = await invoke("get_library_identity", {
        generation: current.generation,
      });
      assert.equal(currentIdentity.ok, true);
      assert.deepEqual(transportValue("library_identity", currentIdentity.value), identity);
      observations.switches.push({
        picker,
        bootstrap: current,
        probe: await capture(),
        running: await observeRunning(index),
      });
    }
    const held = await capture();
    assert.equal(held.rewrites, 2);
    assert.equal(held.listeners[0]?.held, mode === "late");
    assert.equal(held.listeners[0]?.callback_present, mode === "late");
    assert.equal(held.listeners[1]?.callback_present, true);
    if (mode === "late") {
      await executeBrowserScript(
        browser,
        (key) => (Reflect.get(window, key) as ListenerProbe).release(),
        key,
      );
      await browser.wait(
        async () => {
          const current = await capture();
          return current.listeners[0]?.unlistened && !current.listeners[0].callback_present;
        },
        15_000,
        "The disposed owner must unlisten after its real delayed registration settles",
      );
    } else {
      assert.equal(held.listeners[0]?.rejected, true);
      assert.equal(held.listeners[0]?.event_id, null);
      assert.equal(held.listeners[0]?.unlisten_count ?? 0, 0);
      assert.equal(held.responses[0]?.outcome, "error");
    }
    observations.after_release = await capture();
    assert.equal(observations.after_release.listeners[1]?.callback_present, true);
    assert.equal(observations.after_release.listeners[1]?.unlistened, false);
    assert.deepEqual(observations.after_release.mismatches, []);
    assert.equal(observations.after_release.privileged_requests, 0);
    return observations;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cleanup = await executeBrowserScript(
      browser,
      async (key) => (Reflect.get(window, key) as ListenerProbe | undefined)?.restore(),
      key,
    ).catch((error: unknown) => ({ trustworthy: false, error: String(error) }));
    observations.cleanup = cleanup;
    const report = path.join(
      output,
      mode === "late" ? "late-listener-lifetime.json" : "rejected-listener-lifetime.json",
    );
    try {
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
      artifacts.push(report);
    } finally {
      requireTrustedProbeCleanup(cleanup ?? { trustworthy: false }, primary);
    }
  }
}
