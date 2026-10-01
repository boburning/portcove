import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  beginEmbeddedEvidence,
  startEmbeddedInstalledSession,
} from "./desktop-windows-embedded-session.mjs";

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
  report.observations.permissionPolicy = await browser.executeScript(() => {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    return {
      secureContext: window.isSecureContext,
      features: Object.fromEntries(
        ["camera", "microphone", "geolocation"].map((name) => [
          name,
          policy?.allowsFeature(name) ?? null,
        ]),
      ),
    };
  });
  report.observations.permissionStates = await browser.executeAsyncScript((done) => {
    Promise.all(
      ["camera", "microphone", "geolocation", "notifications"].map(async (name) => {
        try {
          return [name, (await navigator.permissions.query({ name })).state];
        } catch {
          return [name, "unsupported"];
        }
      }),
    ).then((entries) => done(Object.fromEntries(entries)));
  });
  const initialUrl = await browser.getCurrentUrl();
  const positive = await invoke(browser, "get_bootstrap_status");
  report.observations.main = positive;
  assert.equal(positive.ok, true);
  report.observations.mainMutation = await invoke(browser, "set_locale_preference", {
    locale: "en",
  });
  assert.equal(report.observations.mainMutation.ok, true);
  assert.equal(
    path.resolve(positive.value.library_root),
    path.resolve(process.env.PORTCOVE_LIBRARY),
  );
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
  report.observations.preservedLocale = await invoke(browser, "get_locale_preference");
  assert.equal(report.observations.preservedLocale.value.locale, "en");
  report.observations.popup = await browser.executeAsyncScript((url, done) => {
    const popup = window.open(`${url}/popup`, "_blank");
    if (!popup) {
      done({ refused: true, result: "null" });
      return;
    }
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (popup.closed || Date.now() >= deadline) {
        clearInterval(timer);
        done({ refused: popup.closed, result: "window-proxy" });
      }
    }, 100);
  }, fixtureUrl);
  assert.equal(report.observations.popup.refused, true);
  report.observations.cspInline = await browser.executeAsyncScript((done) => {
    const handler = (event) => {
      if (event.violatedDirective.startsWith("script-src")) {
        document.removeEventListener("securitypolicyviolation", handler);
        done({
          directive: event.violatedDirective,
          blockedUri: event.blockedURI,
          executed: window.__boundaryInline === true,
        });
      }
    };
    document.addEventListener("securitypolicyviolation", handler);
    const script = document.createElement("script");
    script.textContent = "window.__boundaryInline = true";
    document.body.append(script);
  });
  assert.equal(report.observations.cspInline.executed, false);
  assert.equal(report.observations.cspInline.blockedUri, "inline");
  report.observations.permissionRequests = await browser.executeAsyncScript((done) => {
    Promise.all([
      Notification.requestPermission().then((value) => ["notifications", value]),
      new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
          () => resolve(["geolocation", "unexpected-grant"]),
          (error) => resolve(["geolocation", { code: error.code }]),
          { timeout: 5000 },
        ),
      ),
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(
        (stream) => {
          stream.getTracks().forEach((track) => track.stop());
          return ["media", "unexpected-grant"];
        },
        (error) => ["media", { name: error.name }],
      ),
    ]).then((entries) => done(Object.fromEntries(entries)));
  });
  assert.equal(report.observations.permissionRequests.notifications, "denied");
  assert.equal(report.observations.permissionRequests.geolocation.code, 1);
  assert.equal(report.observations.permissionRequests.media.name, "NotAllowedError");
  const diagnosticPath = path.join(process.env.PORTCOVE_LIBRARY, "logs", "portcove-desktop.jsonl");
  const navigationRefusals = async () =>
    (await readFile(diagnosticPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.fields.operation_id === "webview-navigation" &&
          entry.fields.webview_label === "main",
      );
  report.observations.navigationRefusals = [];
  const inactiveAlias = new URL(initialUrl);
  inactiveAlias.protocol = inactiveAlias.protocol === "http:" ? "https:" : "http:";
  for (const destination of [fixtureUrl, inactiveAlias.href]) {
    const previous = (await navigationRefusals()).length;
    await browser.get(destination);
    const deadline = Date.now() + 10_000;
    while ((await navigationRefusals()).length <= previous) {
      if (Date.now() >= deadline)
        throw new Error("New navigation refusal was not observed by the native host");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const currentUrl = await browser.getCurrentUrl();
    assert.equal(currentUrl, initialUrl);
    report.observations.navigationRefusals.push({
      attempted: destination,
      current: currentUrl,
      native: (await navigationRefusals()).at(-1),
    });
  }
  report.observations.mainNavigatedUrl = await browser.getCurrentUrl();
  assert.equal(report.observations.mainNavigatedUrl, initialUrl);
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
  const disposed = await fetchQueued(abandoned.id);
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
