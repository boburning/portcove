import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  beginEmbeddedEvidence,
  startEmbeddedInstalledSession,
} from "./desktop-windows-embedded-session.mts";

import {
  assertMainWebviewAccess,
  assertMainWebviewContainment,
} from "./desktop-main-webview-boundary.mts";

import type { WebDriver } from "selenium-webdriver";
import type { EmbeddedSession, EmbeddedCleanup } from "./desktop-windows-embedded-session.mts";
type EmbeddedBase = Awaited<ReturnType<typeof beginEmbeddedEvidence>>["report"];
interface BoundaryReply {
  ok?: boolean;
  value?: unknown;
  error?: string;
  unavailable?: boolean;
}
interface HeldReply {
  id: string;
  input: string;
}
interface BoundaryBridge {
  invoke(command: string, args?: object | null, options?: object): Promise<unknown>;
  transformCallback(callback: (value: unknown) => void): number;
}
type BoundaryWindow = Window & {
  __TAURI_INTERNALS__?: BoundaryBridge;
  __boundaryDelivery?: string | null;
  __boundaryHeld?: HeldReply | null;
  __boundaryRelease?: () => void;
  __boundaryDisposedResult?: BoundaryReply | null;
  __boundaryOriginReply?: BoundaryReply | null;
};
interface QueuedReplies {
  secondaryFixtureControl: BoundaryReply;
  remoteFixtureControl: BoundaryReply;
  held: HeldReply;
  foreign: BoundaryReply;
  unknown: BoundaryReply;
  remoteForeign: BoundaryReply;
  remoteUnknown: BoundaryReply;
  delivered: { length: number; exact: boolean };
  consumed: BoundaryReply;
  abandoned?: HeldReply;
  recreated?: BoundaryReply;
  disposed?: BoundaryReply;
}
interface SameLabelRemote {
  label: string;
  url: string;
  armedMainNavigation: BoundaryReply;
  custom?: BoundaryReply;
  mutation?: BoundaryReply;
  dialog?: BoundaryReply;
  qualification?: BoundaryReply;
  returnedMain?: BoundaryReply;
}
interface ApprovedExternalLink {
  url: string;
  beforeUrl: string;
  beforeWindows: string[];
  browserDestination: string;
  result?: BoundaryReply;
  afterUrl?: string;
  afterWindows?: string[];
}
type BoundaryObservations = Parameters<typeof assertMainWebviewAccess>[0]["observations"] & {
  createdFixtures?: BoundaryReply;
  secondary?: BoundaryReply;
  secondaryMutation?: BoundaryReply;
  secondaryDialog?: BoundaryReply;
  remoteUrl?: string;
  remote?: BoundaryReply;
  remoteMutation?: BoundaryReply;
  queuedReplies?: QueuedReplies;
  recreatedAsyncControl?: unknown;
  sameLabelRemote?: SameLabelRemote;
  approvedExternalLink?: ApprovedExternalLink;
  returnedMain?: BoundaryReply;
};
interface BoundaryReport extends EmbeddedBase {
  observations: BoundaryObservations;
  executable?: { path: string; sha256: string; bytes: number };
  listener?: EmbeddedSession["listener"];
  failure?: string;
  cleanupFailure?: string;
  cleanup?: EmbeddedCleanup;
  fixtureRequests?: (string | undefined)[];
  interpretation?: string;
}
function required<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}
function reply(value: unknown): BoundaryReply {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const record: Record<string, unknown> = value as Record<string, unknown>;
  assert.ok(record.ok === undefined || typeof record.ok === "boolean");
  assert.ok(record.error === undefined || typeof record.error === "string");
  assert.ok(record.unavailable === undefined || typeof record.unavailable === "boolean");
  if (record.unavailable === true) return { ...record, unavailable: true };
  assert.ok(typeof record.ok === "boolean");
  if (!record.ok) {
    assert.ok(typeof record.error === "string");
    return { ...record, ok: false, error: record.error };
  }
  return { ...record, ok: true, value: record.value };
}
function failureText(error: unknown): string {
  const stack =
    error !== null && (typeof error === "object" || typeof error === "function") && "stack" in error
      ? error.stack
      : undefined;
  return String(stack ?? error);
}
const { values, report: baseReport } = await beginEmbeddedEvidence(
  "qualification-only-native-webview-boundary",
);
const report: BoundaryReport = { ...baseReport, observations: {} };
const requests: (string | undefined)[] = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>Owned untrusted origin fixture</title><h1>Owned untrusted content</h1>",
  );
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const fixtureUrl = `http://127.0.0.1:${address.port}/untrusted`;
process.env.PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL = fixtureUrl;
process.env.PORTCOVE_LIBRARY = path.join(values.output, "library");
process.env.PORTCOVE_PREFERENCES = path.join(values.output, "preferences.json");
let session: EmbeddedSession | undefined;
async function invoke(
  browser: WebDriver,
  command: string,
  arguments_: object | null = {},
  options: object = {},
): Promise<BoundaryReply> {
  return reply(
    await browser.executeAsyncScript<unknown>(
      (
        command_: string,
        arguments__: object | null,
        options_: object,
        done: (value: unknown) => void,
      ) => {
        const host = window as BoundaryWindow;
        const native = host.__TAURI_INTERNALS__;
        if (typeof native?.invoke !== "function") {
          done({ unavailable: true });
          return;
        }
        void native.invoke(command_, arguments__, options_).then(
          (value) => done({ ok: true, value }),
          (error: unknown) => done({ ok: false, error: String(error) }),
        );
      },
      command,
      arguments_,
      options,
    ),
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
  assert.match(required(secondary.error), /only to the main window/);
  report.observations.secondaryMutation = await invoke(browser, "set_locale_preference", {
    locale: null,
  });
  assert.equal(report.observations.secondaryMutation.ok, false);
  assert.match(required(report.observations.secondaryMutation.error), /only to the main window/);
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
    preferencesPath: process.env.PORTCOVE_PREFERENCES,
    observations: report.observations,
    fixtureUrl,
    initialUrl,
  });
  // Hold only the owner's real IPC fetch transport. Rust still queues the real
  // payload; foreign and unknown requests reach Tauri's unmodified fetch handler.
  const armOwner = async () => {
    await browser.switchTo().window("boundary-secondary");
    return executeBrowserScript(browser, () => {
      const host = window as BoundaryWindow;
      const native = host.__TAURI_INTERNALS__;
      if (!native) throw new Error("Boundary native bridge missing");
      host.__boundaryDelivery = null;
      host.__boundaryHeld = null;
      const originalFetch = window.fetch;
      window.fetch = (input, options) => {
        const id = new Headers(options?.headers).get("Tauri-Channel-Id");
        if (id !== null && host.__boundaryHeld === null) {
          host.__boundaryHeld = {
            id,
            input:
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          };
          return new Promise<Response>((resolve, reject) => {
            host.__boundaryRelease = () => {
              window.fetch = originalFetch;
              originalFetch(input, options).then(resolve, reject);
            };
          });
        }
        return originalFetch(input, options);
      };
      return native.transformCallback((value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "message" in value &&
          typeof value.message === "string" &&
          value.message
        )
          host.__boundaryDelivery = value.message;
      });
    });
  };
  const queueOwner = async (callback: number) => {
    await browser.switchTo().window("main");
    const queued = await invoke(browser, "queue_boundary_reply", {
      callback: `__CHANNEL__:${callback}`,
    });
    assert.equal(queued.ok, true);
    await browser.switchTo().window("boundary-secondary");
    await browser.wait(
      () => executeBrowserScript(browser, () => (window as BoundaryWindow).__boundaryHeld !== null),
      10_000,
      "real queued fetch was not intercepted",
    );
    return required(
      await executeBrowserScript(browser, () => (window as BoundaryWindow).__boundaryHeld),
    );
  };
  const fetchQueued = (id: string | number) =>
    invoke(browser, "plugin:__TAURI_CHANNEL__|fetch", null, {
      headers: { "Tauri-Channel-Id": String(id) },
    });
  await browser.switchTo().window("boundary-secondary");
  const secondaryFixtureControl = await invoke(browser, "recreate_boundary_owner");
  assert.equal(secondaryFixtureControl.ok, false);
  assert.match(required(secondaryFixtureControl.error), /only to the main window/);
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
  await executeBrowserScript(browser, () => {
    const release = (window as BoundaryWindow).__boundaryRelease;
    if (!release) throw new Error("Owned queued fetch release missing");
    release();
  });
  await browser.wait(
    () =>
      executeBrowserScript(browser, () => (window as BoundaryWindow).__boundaryDelivery !== null),
    10_000,
    "owner did not receive its preserved queued payload",
  );
  const delivered = await executeBrowserScript(browser, () => {
    const message = (window as BoundaryWindow).__boundaryDelivery;
    if (typeof message !== "string") throw new Error("Owned queued payload missing");
    return {
      length: message.length,
      exact: message === `PORTCOVE_SYNTHETIC_QUEUE:${"Q".repeat(65536)}`,
    };
  });
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
    report.observations.recreatedAsyncControl = await browser.executeAsyncScript<unknown>(
      (done: (value: unknown) => void) => done("ready"),
    );
  } catch (error) {
    if (
      !(
        error !== null &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ScriptTimeoutError"
      )
    )
      throw error;
    report.observations.recreatedAsyncControl = { error: error.name };
  }
  await executeBrowserScript(
    browser,
    (id) => {
      (window as BoundaryWindow).__boundaryDisposedResult = null;
      const native = (window as BoundaryWindow).__TAURI_INTERNALS__;
      if (!native) throw new Error("Boundary native bridge missing");
      void native
        .invoke("plugin:__TAURI_CHANNEL__|fetch", null, {
          headers: { "Tauri-Channel-Id": String(id) },
        })
        .then(
          (value) => {
            (window as BoundaryWindow).__boundaryDisposedResult = { ok: true, value };
          },
          (error: unknown) => {
            (window as BoundaryWindow).__boundaryDisposedResult = {
              ok: false,
              error: String(error),
            };
          },
        );
    },
    abandoned.id,
  );
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        () => (window as BoundaryWindow).__boundaryDisposedResult !== null,
      ),
    10_000,
    "recreated owner did not settle its actual queued fetch",
  );
  const disposed = required(
    await executeBrowserScript(browser, () => (window as BoundaryWindow).__boundaryDisposedResult),
  );
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
  const armedMainNavigation = await invoke(browser, "arm_boundary_main_navigation");
  assert.equal(armedMainNavigation.ok, true);
  await browser.get(fixtureUrl);
  assert.equal(await browser.getWindowHandle(), "main");
  assert.equal(await browser.getCurrentUrl(), fixtureUrl);
  // A navigation replaces the driver's async completion callback. Poll the
  // actual IPC promise through synchronous evaluation, as with label recreation.
  const invokeNavigated = async (command: string, args: object = {}) => {
    await executeBrowserScript(
      browser,
      (command_, args_) => {
        (window as BoundaryWindow).__boundaryOriginReply = null;
        const native = (window as BoundaryWindow).__TAURI_INTERNALS__;
        if (typeof native?.invoke !== "function") {
          (window as BoundaryWindow).__boundaryOriginReply = { unavailable: true };
          return;
        }
        void native.invoke(command_, args_).then(
          (value) => {
            (window as BoundaryWindow).__boundaryOriginReply = { ok: true, value };
          },
          (error: unknown) => {
            (window as BoundaryWindow).__boundaryOriginReply = { ok: false, error: String(error) };
          },
        );
      },
      command,
      args,
    );
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          () => (window as BoundaryWindow).__boundaryOriginReply !== null,
        ),
      10_000,
      `navigated context did not settle ${command}`,
    );
    return required(
      await executeBrowserScript(browser, () => (window as BoundaryWindow).__boundaryOriginReply),
    );
  };
  const sameLabelRemote: SameLabelRemote = {
    label: await browser.getWindowHandle(),
    url: await browser.getCurrentUrl(),
    armedMainNavigation,
  };
  report.observations.sameLabelRemote = sameLabelRemote;
  for (const [name, command, args] of [
    ["custom", "get_bootstrap_status", {}],
    ["mutation", "set_locale_preference", { locale: null }],
    ["dialog", "plugin:dialog|open", { options: {} }],
    ["qualification", "arm_boundary_main_navigation", {}],
  ] as const) {
    const refusal = await invokeNavigated(command, args);
    sameLabelRemote[name] = refusal;
    assert.equal(refusal.ok, false, `${command} must reach and fail the actual IPC boundary`);
    assert.match(
      required(refusal.error),
      /not allowed/i,
      `${command} must fail upstream ACL, not the main-label guard`,
    );
  }
  await browser.get(initialUrl);
  sameLabelRemote.returnedMain = await invokeNavigated("get_bootstrap_status");
  assert.equal(sameLabelRemote.returnedMain.ok, true);
  const approvedExternalLink: ApprovedExternalLink = {
    url: "https://github.com/boburning/portcove",
    beforeUrl: await browser.getCurrentUrl(),
    beforeWindows: await browser.getAllWindowHandles(),
    browserDestination: "requires separate system-browser observation",
  };
  report.observations.approvedExternalLink = approvedExternalLink;
  approvedExternalLink.result = await invokeNavigated("open_external_url", {
    url: approvedExternalLink.url,
  });
  assert.equal(approvedExternalLink.result.ok, true);
  approvedExternalLink.afterUrl = await browser.getCurrentUrl();
  approvedExternalLink.afterWindows = await browser.getAllWindowHandles();
  assert.equal(approvedExternalLink.afterUrl, initialUrl);
  assert.deepEqual(
    required(approvedExternalLink.afterWindows).toSorted(),
    approvedExternalLink.beforeWindows.toSorted(),
    "approved external links preserve the complete window inventory",
  );
  report.outcome = "passed";
} catch (error) {
  report.failure = failureText(error);
  process.exitCode = 1;
} finally {
  if (session) {
    try {
      if (session.browser) await session.browser.quit();
      report.cleanup = await session.close();
    } catch (error) {
      report.outcome = "failed";
      report.cleanupFailure = failureText(error);
      process.exitCode = 1;
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  report.fixtureRequests = requests;
  report.interpretation =
    "Instrumented Windows native boundary observations; not installed-release, physical-device, normal-user prompt or complete issue acceptance.";
  await writeFile(
    path.join(values.output, "evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
