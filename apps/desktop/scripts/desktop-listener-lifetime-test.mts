import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import type { WebDriver } from "selenium-webdriver";
import { executeBrowserScript } from "./browser-script.mts";
import { transportValue } from "./transport-values.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { requireTrustedProbeCleanup, type ProbeNative } from "./desktop-owned-ipc-probe.mts";

interface ListenerEntry {
  handler: unknown;
  binding: ((value: unknown) => void) | undefined;
  held: boolean;
  event_id: unknown;
  unlistened: boolean;
  unlisten_count?: number;
  unlisten_response?: { http_ok: boolean; outcome: string | null; value: unknown };
}
interface ResponseEntry {
  command: string;
  ids: (number | null)[];
  completed: boolean;
  outcome: "ok" | "error" | null;
}
export interface ListenerSnapshot {
  rewrites: number;
  privileged_requests: number;
  mismatches: string[];
  released: boolean;
  responses: (ResponseEntry & { settled: boolean })[];
  listeners: (Omit<ListenerEntry, "binding"> & { callback_present: boolean })[];
}
interface ListenerCleanup extends ListenerSnapshot {
  restored: boolean;
  trustworthy: boolean;
}
interface ListenerProbe {
  capture(): ListenerSnapshot;
  release(): void;
  restore(): Promise<ListenerCleanup>;
}
interface ListenerContext {
  browser: WebDriver;
  invoke: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  output: string;
  artifacts: string[];
  chooseOwnedLibrary: ReturnType<typeof nativeConfirmation>;
  observeRunning: (index: number) => Promise<unknown>;
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
  await executeBrowserScript(browser, install, key, alternate, before.library_root);
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
    control: "owned same-root bridge input; actual listen response delayed",
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
          return entries.length === index + 1 && Number.isSafeInteger(entries[index]?.event_id);
        },
        15_000,
        "Each new owner must complete one actual operation registration",
      );
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
    assert.equal(held.listeners[0]?.held, true);
    assert.equal(held.listeners[0]?.callback_present, true);
    assert.equal(held.listeners[1]?.callback_present, true);
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
    const report = path.join(output, "late-listener-lifetime.json");
    try {
      await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
      artifacts.push(report);
    } finally {
      requireTrustedProbeCleanup(cleanup ?? { trustworthy: false }, primary);
    }
  }
}

// Serialized by Selenium; never unregisters or deletes arbitrary callbacks.
function install(key: string, reviewed: string, currentRoot: string) {
  const rawNative: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
  if (
    rawNative === null ||
    typeof rawNative !== "object" ||
    !("callbacks" in rawNative) ||
    !(rawNative.callbacks instanceof Map) ||
    !("convertFileSrc" in rawNative) ||
    typeof rawNative.convertFileSrc !== "function"
  )
    throw new Error("Pinned Tauri probe transport unavailable");
  const native = rawNative as ProbeNative;
  const original = window.fetch;
  const url = (command: string) => native.convertFileSrc(command, "ipc");
  const listen = url("plugin:event|listen");
  const unlisten = url("plugin:event|unlisten");
  const select = url("set_default_library");
  const privileged = ["prepare_port", "install_port", "adopt_port"].map(url);
  const initial = new Set(native.callbacks.keys());
  const listeners: ListenerEntry[] = [];
  const responses: ResponseEntry[] = [];
  const mismatches: string[] = [];
  let rewrites = 0;
  let privilegedRequests = 0;
  let release: () => void = () => {
    throw new Error("Listener gate not initialized");
  };
  let released = false;
  let restored: Promise<ListenerCleanup> | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = (request: RequestInit | undefined): Record<string, unknown> => {
    const payload: unknown = JSON.parse(
      typeof request?.body === "string"
        ? request.body
        : new TextDecoder().decode(request?.body as AllowSharedBufferSource | undefined),
    );
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Native request body is not an object");
    return Object.fromEntries(Object.entries(payload));
  };
  const present = (entry: ListenerEntry) =>
    typeof entry.handler === "number" &&
    typeof entry.binding === "function" &&
    native.callbacks.get(entry.handler) === entry.binding;
  const responseSettled = (entry: ResponseEntry) =>
    entry.completed && entry.ids.every((id) => id !== null && !native.callbacks.has(id));
  function observeResponse(request: RequestInit | undefined, command: string) {
    const headers = new Headers(request?.headers);
    const ids = ["Tauri-Callback", "Tauri-Error"].map((name) => {
      const raw = headers.get(name);
      return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    });
    const entry: ResponseEntry = { command, ids, completed: false, outcome: null };
    responses.push(entry);
    if (
      ids[0] === ids[1] ||
      ids.some(
        (id) =>
          id === null ||
          !Number.isSafeInteger(id) ||
          initial.has(id) ||
          typeof native.callbacks.get(id) !== "function",
      )
    ) {
      mismatches.push("Invoke response callback identity unavailable");
      return;
    }
    ids.forEach((id, index) => {
      if (id === null) return;
      const callback = native.callbacks.get(id);
      if (typeof callback !== "function") return;
      const observer = (value: unknown) => {
        if (native.callbacks.get(id) !== observer)
          throw new Error("Owned invoke callback identity changed");
        callback(value);
        entry.completed = true;
        entry.outcome = index === 0 ? "ok" : "error";
      };
      native.callbacks.set(id, observer);
    });
  }
  const snapshot = () => ({
    rewrites,
    privileged_requests: privilegedRequests,
    mismatches: [...mismatches],
    released,
    responses: responses.map((entry) => ({ ...entry, settled: responseSettled(entry) })),
    listeners: listeners.map((entry) => {
      const { binding: _binding, ...observation } = entry;
      return { ...observation, callback_present: present(entry) };
    }),
  });
  const wrapper: typeof fetch = async function (this: unknown, input, request) {
    if (typeof input === "string" && privileged.includes(input)) privilegedRequests++;
    if (input === select) {
      const body = decode(request);
      if (body.path !== reviewed || Object.keys(body).length !== 1 || rewrites >= 2) {
        mismatches.push("Unexpected library-selection input");
        throw new Error("Controlled library-selection input mismatch");
      }
      rewrites++;
      return original.call(this, input, {
        ...request,
        body: JSON.stringify({ path: currentRoot }),
      });
    }
    if (input === listen) {
      const body = decode(request);
      if (body.event === "portcove://operation") {
        const entry: ListenerEntry = {
          handler: body.handler,
          binding:
            typeof body.handler === "number" ? native.callbacks.get(body.handler) : undefined,
          held: listeners.length === 0,
          event_id: null,
          unlistened: false,
        };
        if (
          !Number.isSafeInteger(entry.handler) ||
          (typeof entry.handler === "number" && initial.has(entry.handler)) ||
          typeof entry.binding !== "function"
        )
          mismatches.push("Listener callback identity unavailable");
        listeners.push(entry);
        observeResponse(request, "listen");
        const response = await original.call(this, input, request);
        entry.event_id = await response.clone().json();
        if (
          !response.ok ||
          response.headers.get("Tauri-Response") !== "ok" ||
          !Number.isSafeInteger(entry.event_id)
        )
          mismatches.push("Actual event registration did not return an ID");
        if (entry.held) await gate;
        return response;
      }
    }
    if (input === unlisten) {
      const body = decode(request);
      const entry = listeners.find((item) => item.event_id === body.eventId);
      if (entry) {
        entry.unlisten_count = (entry.unlisten_count ?? 0) + 1;
        if (body.event !== "portcove://operation" || entry.unlisten_count !== 1)
          mismatches.push("Unexpected owned unlisten identity/count");
        observeResponse(request, "unlisten");
      }
      const response = await original.call(this, input, request);
      if (entry) {
        entry.unlisten_response = {
          http_ok: response.ok,
          outcome: response.headers.get("Tauri-Response"),
          value: await response.clone().json(),
        };
        entry.unlistened =
          response.ok &&
          entry.unlisten_response.outcome === "ok" &&
          entry.unlisten_response.value === null;
        if (!entry.unlistened || present(entry))
          mismatches.push("Owned unlisten did not remove its callback");
      }
      return response;
    }
    return original.call(this, input, request);
  };
  window.fetch = wrapper;
  const releaseResponse = () => {
    released = true;
    release();
  };
  const probe: ListenerProbe = {
    capture: snapshot,
    release: releaseResponse,
    restore() {
      restored ??= (async () => {
        releaseResponse();
        const deadline = Date.now() + 5_000;
        while (
          Date.now() < deadline &&
          (!listeners[0]?.unlistened || !responses.every(responseSettled))
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        const ownsFetch = window.fetch === wrapper;
        if (ownsFetch) window.fetch = original;
        const report = snapshot();
        return {
          ...report,
          restored: ownsFetch,
          trustworthy:
            ownsFetch &&
            mismatches.length === 0 &&
            listeners.length === 2 &&
            listeners[0]?.unlistened === true &&
            listeners[0].unlisten_count === 1 &&
            !present(listeners[0]) &&
            listeners[1] !== undefined &&
            present(listeners[1]) &&
            responses.length === 3 &&
            responses.every((entry) => responseSettled(entry) && entry.outcome === "ok"),
        };
      })();
      return restored;
    },
  };
  Reflect.set(window, key, probe);
}
