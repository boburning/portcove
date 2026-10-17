import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import { requireTrustedProbeCleanup } from "./desktop-owned-ipc-probe.mjs";

// Qualification-only bridge-input and response-delay control. Core responses,
// generations, running work and event registrations are always real.
export async function listenerLifetimeScenario({
  browser,
  invoke,
  output,
  artifacts,
  chooseOwnedLibrary,
  observeRunning,
}) {
  const alternate = path.join(output, "listener-reviewed-alternate");
  await mkdir(alternate);
  const key = `__portcoveListenerProbe_${randomUUID()}`;
  const bootstrap = await invoke("get_bootstrap_status");
  assert.equal(bootstrap.ok, true);
  const before = bootstrap.value;
  const originalIdentity = await invoke("get_library_identity", { generation: before.generation });
  assert.equal(originalIdentity.ok, true);
  const identity = originalIdentity.value;
  await browser.executeScript(install, key, alternate, before.library_root);
  const capture = () => browser.executeScript((key) => window[key].capture(), key);
  let primary;
  const observations = {
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
          return current.ok && current.value.generation === before.generation + index + 1;
        },
        15_000,
        "Core must advance the genuine generation",
      );
      await browser.wait(
        async () => {
          const entries = (await capture()).listeners;
          return entries.length === index + 1 && Number.isSafeInteger(entries[index].event_id);
        },
        15_000,
        "Each new owner must complete one actual operation registration",
      );
      const response = await invoke("get_bootstrap_status");
      assert.equal(response.ok, true);
      const current = response.value;
      assert.equal(current.library_root, before.library_root);
      const currentIdentity = await invoke("get_library_identity", {
        generation: current.generation,
      });
      assert.equal(currentIdentity.ok, true);
      assert.deepEqual(currentIdentity.value, identity);
      observations.switches.push({
        picker,
        bootstrap: current,
        probe: await capture(),
        running: await observeRunning(index),
      });
    }
    const held = await capture();
    assert.equal(held.rewrites, 2);
    assert.equal(held.listeners[0].held, true);
    assert.equal(held.listeners[0].callback_present, true);
    assert.equal(held.listeners[1].callback_present, true);
    await browser.executeScript((key) => window[key].release(), key);
    await browser.wait(
      async () => {
        const current = await capture();
        return current.listeners[0].unlistened && !current.listeners[0].callback_present;
      },
      15_000,
      "The disposed owner must unlisten after its real delayed registration settles",
    );
    observations.after_release = await capture();
    assert.equal(observations.after_release.listeners[1].callback_present, true);
    assert.equal(observations.after_release.listeners[1].unlistened, false);
    assert.deepEqual(observations.after_release.mismatches, []);
    assert.equal(observations.after_release.privileged_requests, 0);
    return observations;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const cleanup = await browser
      .executeScript(async (key) => window[key]?.restore(), key)
      .catch((error) => ({ trustworthy: false, error: String(error) }));
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
function install(key, reviewed, currentRoot) {
  const native = window.__TAURI_INTERNALS__;
  const original = window.fetch;
  const url = (command) => native.convertFileSrc(command, "ipc");
  const listen = url("plugin:event|listen");
  const unlisten = url("plugin:event|unlisten");
  const select = url("set_default_library");
  const privileged = ["prepare_port", "install_port", "adopt_port"].map(url);
  const initial = new Set(native.callbacks.keys());
  const listeners = [];
  const responses = [];
  const mismatches = [];
  let rewrites = 0;
  let privilegedRequests = 0;
  let release;
  let released = false;
  let restored;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const decode = (request) =>
    JSON.parse(
      typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
    );
  const present = (entry) => native.callbacks.get(entry.handler) === entry.binding;
  const responseSettled = (entry) =>
    entry.completed && entry.ids.every((id) => !native.callbacks.has(id));
  function observeResponse(request, command) {
    const headers = new Headers(request.headers);
    const ids = ["Tauri-Callback", "Tauri-Error"].map((name) => {
      const raw = headers.get(name);
      return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    });
    const entry = { command, ids, completed: false, outcome: null };
    responses.push(entry);
    if (
      ids[0] === ids[1] ||
      ids.some(
        (id) =>
          !Number.isSafeInteger(id) ||
          initial.has(id) ||
          typeof native.callbacks.get(id) !== "function",
      )
    ) {
      mismatches.push("Invoke response callback identity unavailable");
      return;
    }
    ids.forEach((id, index) => {
      const callback = native.callbacks.get(id);
      const observer = (value) => {
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
    listeners: listeners.map(({ binding: _binding, ...entry }) => ({
      ...entry,
      callback_present: present(entry),
    })),
  });
  const wrapper = async function (input, request) {
    if (privileged.includes(input)) privilegedRequests++;
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
        const entry = {
          handler: body.handler,
          binding: native.callbacks.get(body.handler),
          held: listeners.length === 0,
          event_id: null,
          unlistened: false,
        };
        if (
          !Number.isSafeInteger(entry.handler) ||
          initial.has(entry.handler) ||
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
  window[key] = {
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
            listeners[0].unlistened &&
            listeners[0].unlisten_count === 1 &&
            !present(listeners[0]) &&
            present(listeners[1]) &&
            responses.length === 3 &&
            responses.every((entry) => responseSettled(entry) && entry.outcome === "ok"),
        };
      })();
      return restored;
    },
  };
}
