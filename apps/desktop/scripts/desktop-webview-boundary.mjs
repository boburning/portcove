import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  beginEmbeddedEvidence,
  startEmbeddedInstalledSession,
} from "./desktop-windows-embedded-session.mjs";

import {
  assertMainWebviewAccess,
  assertMainWebviewContainment,
} from "./desktop-main-webview-boundary.mjs";

const { values, report } = await beginEmbeddedEvidence(
  "qualification-only-native-webview-boundary",
);
report.observations = {};
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>Owned untrusted origin fixture</title><h1>Owned untrusted content</h1>",
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const fixtureUrl = `http://127.0.0.1:${server.address().port}/untrusted`;
process.env.PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL = fixtureUrl;
process.env.PORTCOVE_LIBRARY = path.join(values.output, "library");
process.env.PORTCOVE_PREFERENCES = path.join(values.output, "preferences.json");
let session;
async function invoke(browser, command, arguments_ = {}, options = {}) {
  return browser.executeAsyncScript(
    (command_, arguments__, options_, done) => {
      if (typeof window.__TAURI_INTERNALS__?.invoke !== "function") {
        done({ unavailable: true });
        return;
      }
      window.__TAURI_INTERNALS__.invoke(command_, arguments__, options_).then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: String(error) }),
      );
    },
    command,
    arguments_,
    options,
  );
}
try {
  session = await startEmbeddedInstalledSession(values.app, values.output);
  const browser = await session.connect();
  await browser.manage().setTimeouts({ script: 10_000, pageLoad: 10_000 });
  report.executable = { path: values.app, ...session.identity };
  report.listener = session.listener;
  await browser.switchTo().window("main");
  const initialUrl = await browser.getCurrentUrl();
  await assertMainWebviewAccess({
    browser,
    invoke: (command, args, options) => invoke(browser, command, args, options),
    library: process.env.PORTCOVE_LIBRARY,
    observations: report.observations,
  });
  report.observations.createdFixtures = await invoke(browser, "create_boundary_windows");
  assert.equal(report.observations.createdFixtures.ok, true);
  await browser.switchTo().window("boundary-secondary");
  const secondary = await invoke(browser, "get_bootstrap_status");
  report.observations.secondary = secondary;
  assert.equal(secondary.ok, false);
  assert.match(secondary.error, /only to the main window/);
  report.observations.secondaryMutation = await invoke(browser, "set_locale_preference", {
    locale: null,
  });
  assert.equal(report.observations.secondaryMutation.ok, false);
  assert.match(report.observations.secondaryMutation.error, /only to the main window/);
  report.observations.secondaryDialog = await invoke(browser, "plugin:dialog|open", {
    options: {},
  });
  assert.equal(report.observations.secondaryDialog.ok, false);
  await browser.switchTo().window("boundary-remote");
  report.observations.remoteUrl = await browser.getCurrentUrl();
  const remote = await invoke(browser, "get_bootstrap_status");
  report.observations.remote = remote;
  assert.equal(remote.ok, false);
  report.observations.remoteMutation = await invoke(browser, "set_locale_preference", {
    locale: null,
  });
  assert.equal(report.observations.remoteMutation.ok, false);
  await browser.switchTo().window("main");
  await assertMainWebviewContainment({
    browser,
    invoke: (command, args, options) => invoke(browser, command, args, options),
    library: process.env.PORTCOVE_LIBRARY,
    observations: report.observations,
    fixtureUrl,
    initialUrl,
  });
  // Hold only the owner's real IPC fetch transport. Rust still queues the real
  // payload; foreign and unknown requests reach Tauri's unmodified fetch handler.
  const armOwner = async () => {
    await browser.switchTo().window("boundary-secondary");
    return browser.executeScript(() => {
      window.__boundaryDelivery = null;
      window.__boundaryHeld = null;
      const originalFetch = window.fetch;
      window.fetch = (input, options) => {
        const id = new Headers(options?.headers).get("Tauri-Channel-Id");
        if (id !== null && window.__boundaryHeld === null) {
          window.__boundaryHeld = { id, input: String(input) };
          return new Promise((resolve, reject) => {
            window.__boundaryRelease = () => {
              window.fetch = originalFetch;
              originalFetch(input, options).then(resolve, reject);
            };
          });
        }
        return originalFetch(input, options);
      };
      return window.__TAURI_INTERNALS__.transformCallback((value) => {
        if (value.message) window.__boundaryDelivery = value.message;
      });
    });
  };
  const queueOwner = async (callback) => {
    await browser.switchTo().window("main");
    const queued = await invoke(browser, "queue_boundary_reply", {
      callback: `__CHANNEL__:${callback}`,
    });
    assert.equal(queued.ok, true);
    await browser.switchTo().window("boundary-secondary");
    await browser.wait(
      () => browser.executeScript(() => window.__boundaryHeld !== null),
      10_000,
      "real queued fetch was not intercepted",
    );
    return browser.executeScript(() => window.__boundaryHeld);
  };
  const fetchQueued = (id) =>
    invoke(browser, "plugin:__TAURI_CHANNEL__|fetch", null, {
      headers: { "Tauri-Channel-Id": String(id) },
    });
  await browser.switchTo().window("boundary-secondary");
  const secondaryFixtureControl = await invoke(browser, "recreate_boundary_owner");
  assert.equal(secondaryFixtureControl.ok, false);
  assert.match(secondaryFixtureControl.error, /only to the main window/);
  await browser.switchTo().window("boundary-remote");
  const remoteFixtureControl = await invoke(browser, "recreate_boundary_owner");
  assert.equal(remoteFixtureControl.ok, false);
  const held = await queueOwner(await armOwner());
  const unknownId = Number(held.id) === 4294967295 ? 4294967294 : 4294967295;
  await browser.switchTo().window("main");
  const foreign = await fetchQueued(held.id);
  const unknown = await fetchQueued(unknownId);
  assert.equal(foreign.ok, false);
  assert.deepEqual(foreign, unknown);
  await browser.switchTo().window("boundary-remote");
  const remoteForeign = await fetchQueued(held.id);
  const remoteUnknown = await fetchQueued(unknownId);
  assert.equal(remoteForeign.ok, false);
  assert.deepEqual(remoteForeign, remoteUnknown);
  await browser.switchTo().window("boundary-secondary");
  await browser.executeScript(() => window.__boundaryRelease());
  await browser.wait(
    () => browser.executeScript(() => window.__boundaryDelivery !== null),
    10_000,
    "owner did not receive its preserved queued payload",
  );
  const delivered = await browser.executeScript(() => ({
    length: window.__boundaryDelivery.length,
    exact: window.__boundaryDelivery === `PORTCOVE_SYNTHETIC_QUEUE:${"Q".repeat(65536)}`,
  }));
  assert.equal(delivered.exact, true);
  const consumed = await fetchQueued(held.id);
  assert.equal(consumed.ok, false);
  report.observations.queuedReplies = {
    secondaryFixtureControl,
    remoteFixtureControl,
    held,
    foreign,
    unknown,
    remoteForeign,
    remoteUnknown,
    delivered,
    consumed,
  };
  // Recreate the same label, before queuing any new reply. A stale entry would
  // otherwise be addressable by that replacement webview under this patch.
  const abandoned = await queueOwner(await armOwner());
  await browser.close();
  await browser.switchTo().window("main");
  const recreated = await invoke(browser, "recreate_boundary_owner");
  assert.equal(recreated.ok, true);
  await browser.switchTo().window("boundary-secondary");
  // Pinned Windows driver registers async completion once per label and
  // cannot reinstall it after same-label recreation. Preserve a discriminator.
  try {
    report.observations.recreatedAsyncControl = await browser.executeAsyncScript((done) =>
      done("ready"),
    );
  } catch (error) {
    if (error.name !== "ScriptTimeoutError") throw error;
    report.observations.recreatedAsyncControl = { error: error.name };
  }
  await browser.executeScript((id) => {
    window.__boundaryDisposedResult = null;
    window.__TAURI_INTERNALS__
      .invoke("plugin:__TAURI_CHANNEL__|fetch", null, {
        headers: { "Tauri-Channel-Id": String(id) },
      })
      .then(
        (value) => {
          window.__boundaryDisposedResult = { ok: true, value };
        },
        (error) => {
          window.__boundaryDisposedResult = { ok: false, error: String(error) };
        },
      );
  }, abandoned.id);
  await browser.wait(
    () => browser.executeScript(() => window.__boundaryDisposedResult !== null),
    10_000,
    "recreated owner did not settle its actual queued fetch",
  );
  const disposed = await browser.executeScript(() => window.__boundaryDisposedResult);
  assert.equal(disposed.ok, false);
  assert.deepEqual(disposed, consumed);
  Object.assign(report.observations.queuedReplies, { abandoned, recreated, disposed });
  await browser.switchTo().window("main");
  report.observations.returnedMain = await invoke(browser, "get_bootstrap_status");
  assert.equal(report.observations.returnedMain.ok, true);
  assert.equal(requests.includes("/untrusted/popup"), false);
  await writeFile(
    path.join(values.output, "returned-main.png"),
    await browser.takeScreenshot(),
    "base64",
  );
  report.outcome = "passed";
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (session) {
    try {
      if (session.browser) await session.browser.quit();
      report.cleanup = await session.close();
    } catch (error) {
      report.outcome = "failed";
      report.cleanupFailure = String(error.stack ?? error);
      process.exitCode = 1;
    }
  }
  await new Promise((resolve) => server.close(resolve));
  report.fixtureRequests = requests;
  report.interpretation =
    "Instrumented Windows native boundary observations; not installed-release, physical-device, normal-user prompt or complete issue acceptance.";
  await writeFile(
    path.join(values.output, "evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
