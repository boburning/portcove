import { errorCode, errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";

import type { WebDriver } from "selenium-webdriver";
import type {
  LibraryIdentity,
  LibrarySelection,
  OutputDesktopBootstrapStatus,
} from "../src/transport-types.generated.d.ts";
export type BoundaryInvoke = (
  command: string,
  args?: object | null,
  options?: object,
) => Promise<unknown>;
// Both transports execute value-only functions here; remote values stay unknown.
export interface MainBoundaryBrowser {
  executeScript<Arguments extends unknown[], Result>(
    script: (...args: Arguments) => Result,
    ...args: Arguments
  ): Promise<unknown>;
  executeAsyncScript<Arguments extends unknown[]>(
    script: (...args: [...Arguments, (value: unknown) => void]) => unknown,
    ...args: Arguments
  ): Promise<unknown>;
  getCurrentUrl(): Promise<string>;
  get?(url: string): Promise<unknown>;
  manage(): { setTimeouts(values: { script: number; pageLoad: number }): Promise<void> };
}
interface MainContext {
  browser: Pick<WebDriver, "getCurrentUrl">;
  invoke: BoundaryInvoke;
  library: string;
}
interface MainObservations {
  permissionPolicy?: unknown;
  permissionStates?: unknown;
  main?: unknown;
  mainMutation?: unknown;
  preservedLocale?: unknown;
  popup?: Record<string, unknown>;
  cspInline?: Record<string, unknown>;
  permissionRequests?: Record<string, unknown>;
  permissionRequestDiagnostic?:
    | { status: "captured"; requests: unknown }
    | { status: "unavailable"; reason: string };
  navigationRefusals?: { attempted: string; current: string; native: unknown }[];
  navigationRequests?: { destination: string; trigger: string; scheduled?: unknown }[];
  mainNavigatedUrl?: string;
}
type MainScenarioContext = Omit<MainContext, "browser"> & {
  browser: MainBoundaryBrowser;
  observations: MainObservations;
};

type MainSnapshot = Awaited<ReturnType<typeof readyMainContext>>;
interface ApprovedLinkObservation {
  url: string;
  identities: FileIdentity[];
  networkLog: string;
  before?: MainSnapshot;
  after?: MainSnapshot;
  windowsBefore?: Record<string, unknown>;
  windowsAfter?: Record<string, unknown>;
  request?: Record<string, unknown>;
  actualBrowserVersion?: string;
  actualPageUrl?: string;
  interpretation?: string;
}
interface LinkRefusal {
  command: string;
  args: object;
  expected: { code: string; message: string };
  before?: MainSnapshot;
  after?: MainSnapshot;
  result?: Record<string, unknown>;
}
interface SecondarySnapshot {
  readFailures: Partial<Record<"context" | "locale" | "windows" | "webviews", string>>;
  context?: unknown;
  locale?: unknown;
  windows?: unknown;
  webviews?: unknown;
}
interface CreationObservation {
  request: { command: string; args: object };
  before?: SecondarySnapshot;
  after?: SecondarySnapshot;
  result?: Record<string, unknown>;
  invocationFailure?: string;
}
interface FrameObservation {
  attempted: string;
  before?: MainSnapshot;
  after?: MainSnapshot;
  refusal?: Record<string, unknown>;
}
interface BoundaryRequest {
  method: string | undefined;
  path: string | undefined;
  user_agent: string | null;
  observed_at: string;
  phase: string;
}
interface NormalObservations extends MainObservations {
  package?:
    | Awaited<ReturnType<typeof verifyLinuxPackageEvidence>>
    | Awaited<ReturnType<typeof verifyNormalPackageEvidence>>;
  approvedExternalLink?: ApprovedLinkObservation;
  navigationPhases?: { destination: string; started_at: string }[];
  qualificationCommands?: Partial<
    Record<
      | "create_boundary_windows"
      | "queue_boundary_reply"
      | "recreate_boundary_owner"
      | "arm_boundary_main_navigation",
      unknown
    >
  >;
  reviewedLinkRefusals?: LinkRefusal[];
  secondaryCreation?: CreationObservation;
  cspFrame?: FrameObservation;
  assets?: string[];
  returnedMain?: Record<string, unknown>;
  remoteMarkerExecuted?: unknown;
  nativePermissionDenials?: Record<string, unknown>[];
  nativePermissionInterpretation?: string;
  fixtureCloseStartedAt?: string;
  fixtureClosedAt?: string;
  fixtureRequests?: BoundaryRequest[];
  remoteExecutionBeacon?: { path: string; requests: BoundaryRequest[] };
}
type NormalContext = Omit<MainScenarioContext, "observations"> & {
  observations: NormalObservations;
};
type ExternalBrowser = Awaited<ReturnType<typeof prepareLinuxExternalBrowser>>;
interface SelectedWebview {
  label: string | null;
  ipc: boolean;
  url: string;
  handle: string;
}
interface OriginRefusal {
  command: string;
  args: object;
  result?: Record<string, unknown>;
}
interface OriginObservations {
  main?: SelectedWebview;
  secondary?: SelectedWebview;
  remote?: SelectedWebview;
  before?: MainSnapshot;
  returned?: MainSnapshot;
  positiveMutation?: Record<string, unknown>;
  created?: Record<string, unknown>;
  armed?: Record<string, unknown>;
  sameLabel?: { label: string | null; ipc: boolean; url: string };
  returnedLocale?: unknown;
  restoredLocale?: Record<string, unknown>;
  secondaryRefusals?: OriginRefusal[];
  remoteRefusals?: OriginRefusal[];
  sameLabelRefusals?: OriginRefusal[];
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Boundary evidence must be an object");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Boundary evidence text required");
  return value;
}
async function readObject(file: string) {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  return object(value);
}
function binding(value: unknown): FileIdentity {
  const entry = object(value);
  assert.ok(
    typeof entry.bytes === "number" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0,
  );
  const sha256 = text(entry.sha256);
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  return { ...entry, path: text(entry.path), sha256, bytes: entry.bytes };
}
function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value), "Boundary text collection required");
  const entries: unknown[] = value;
  return entries.map(text);
}
function configurations(value: unknown) {
  assert.ok(Array.isArray(value), "Package configuration identities required");
  const entries: unknown[] = value;
  return entries.map(binding);
}

export function chromeObserverEndpoint(value: string) {
  const lines = value.trim().split("\n");
  assert.equal(lines.length, 2);
  const [port, endpoint] = lines;
  assert.ok(port && endpoint);
  assert.match(port, /^\d{1,5}$/u);
  assert.ok(Number(port) >= 1024 && Number(port) <= 65535);
  assert.match(endpoint, /^\/devtools\/browser\/[a-f0-9-]{36}$/u);
  return `ws://127.0.0.1:${port}${endpoint}`;
}

export async function prepareLinuxExternalBrowser() {
  assert.equal(process.platform, "linux");
  const displayReceipt = process.env.PORTCOVE_QUALIFICATION_DISPLAY_RECEIPT;
  assert.ok(
    displayReceipt && path.isAbsolute(displayReceipt),
    "Maintained private X11 route required",
  );
  const runtime = path.dirname(displayReceipt);
  const receipt = await readObject(displayReceipt);
  assert.equal(object(receipt.gtk_readiness).outcome, "ready");
  for (const [variable, name] of [
    ["XDG_CONFIG_HOME", "xdg_config_home"],
    ["XDG_DATA_HOME", "xdg_data_home"],
    ["XDG_CACHE_HOME", "xdg_cache_home"],
  ] as const) {
    assert.equal(process.env[variable], path.join(runtime, name));
    const directory = process.env[variable];
    assert.ok(directory);
    assert.equal(await realpath(directory), directory);
  }
  const profile = path.join(text(process.env.XDG_CACHE_HOME), "external-browser-profile");
  // Qualification paths are controlled; never interpolate desktop-entry metacharacters.
  assert.match(profile, /^\/[A-Za-z0-9_./-]+$/u);
  await mkdir(profile, { mode: 0o700 });
  const applications = path.join(text(process.env.XDG_DATA_HOME), "applications");
  await mkdir(applications, { mode: 0o700 });
  const desktop = path.join(applications, "portcove-qualification-browser.desktop");
  const association = path.join(text(process.env.XDG_CONFIG_HOME), "mimeapps.list");
  await writeFile(
    desktop,
    `[Desktop Entry]\nType=Application\nName=Portcove isolated qualification browser\nExec=/usr/bin/google-chrome --ozone-platform=x11 --user-data-dir=${profile} --no-first-run --no-default-browser-check --remote-debugging-port=0 --log-net-log=${profile}/network.json --net-log-max-size-mb=4 --net-log-duration=10 %u\nMimeType=x-scheme-handler/https;\nTerminal=false\n`,
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    association,
    "[Default Applications]\nx-scheme-handler/https=portcove-qualification-browser.desktop;\n",
    { flag: "wx", mode: 0o600 },
  );
  assert.equal(
    execFileSync("/usr/bin/xdg-mime", ["query", "default", "x-scheme-handler/https"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim(),
    "portcove-qualification-browser.desktop",
  );
  return {
    profile,
    networkLog: path.join(profile, "network.json"),
    identities: await Promise.all(
      [
        "/usr/bin/xdg-open",
        "/usr/bin/xdg-mime",
        await realpath("/usr/bin/google-chrome"),
        "/opt/google/chrome/chrome",
        desktop,
        association,
      ].map((file) => fileIdentity(file)),
    ),
  };
}

async function observeLinuxApprovedLink({
  browser,
  invoke,
  library,
  observations,
  externalBrowser,
}: NormalContext & { externalBrowser: ExternalBrowser | undefined }) {
  assert.ok(externalBrowser, "Isolated real browser preparation required");
  const record: ApprovedLinkObservation = (observations.approvedExternalLink = {
    url: "https://github.com/boburning/portcove",
    identities: externalBrowser.identities,
    networkLog: externalBrowser.networkLog,
  });
  record.before = await readyMainContext({ browser, invoke, library });
  record.windowsBefore = object(await invoke("plugin:window|get_all_windows"));
  assert.equal(record.windowsBefore.ok, true);
  const deadline = Date.now() + 15_000;
  record.request = object(await invoke("open_external_url", { url: record.url }));
  assert.equal(record.request.ok, true);
  let ownedBrowser;
  try {
    let endpoint;
    while (!endpoint) {
      assert.ok(
        Date.now() < deadline,
        "Actual browser observer was not ready within the startup budget",
      );
      try {
        endpoint = chromeObserverEndpoint(
          await readFile(path.join(externalBrowser.profile, "DevToolsActivePort"), "utf8"),
        );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const { chromium } = await import("playwright");
    ownedBrowser = await chromium.connectOverCDP(endpoint, {
      timeout: Math.max(1, deadline - Date.now()),
    });
    while (
      !ownedBrowser
        .contexts()
        .flatMap((context) => context.pages())
        .some((page) => page.url() === record.url)
    ) {
      assert.ok(
        Date.now() < deadline,
        "Approved destination was not observed in the real external browser",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    record.actualBrowserVersion = ownedBrowser.version();
    const observedPage = ownedBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === record.url);
    assert.ok(observedPage);
    record.actualPageUrl = observedPage.url();
    record.after = await readyMainContext({ browser, invoke, library });
    assert.deepEqual(record.after, record.before);
    record.windowsAfter = object(await invoke("plugin:window|get_all_windows"));
    assert.equal(record.windowsAfter.ok, true);
    assert.deepEqual(
      strings(record.windowsAfter.value).sort(),
      strings(record.windowsBefore.value).sort(),
    );
    record.interpretation =
      "Actual browser tab destination under an isolated desktop association/profile; not the host's ordinary default-browser configuration or network content health.";
  } finally {
    if (ownedBrowser) await ownedBrowser.close();
  }
}

export function assertLocalMainUrl(value: string, platform: string = process.platform) {
  const url = new URL(value);
  assert.ok(["win32", "linux"].includes(platform), "Qualified native boundary platform required");
  assert.equal(url.protocol, platform === "linux" ? "tauri:" : "http:");
  assert.equal(url.hostname, platform === "linux" ? "localhost" : "tauri.localhost");
  assert.equal(url.port, "");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
}

export async function verifyLinuxPackageEvidence(
  file: string,
  revision: string,
  executable: FileIdentity,
  root: string,
) {
  assert.ok(file && path.isAbsolute(file));
  const raw = await readObject(file);
  const manifest = {
    ...raw,
    revision: text(raw.revision),
    build_command: strings(raw.build_command),
    qualification_features: strings(raw.qualification_features),
    execution_context:
      raw.execution_context === undefined ? undefined : text(raw.execution_context),
    configuration: configurations(raw.configuration),
    package: binding(raw.package),
    extraction_evidence: binding(raw.extraction_evidence),
  };
  assert.equal(manifest.revision, revision);
  assert.deepEqual(manifest.build_command, [
    "pnpm",
    "--dir",
    "apps/desktop",
    "desktop:build",
    "--bundles",
    "deb",
  ]);
  assert.deepEqual(manifest.qualification_features, []);
  assert.equal(manifest.execution_context, "extracted-deb-payload");
  assert.deepEqual(
    manifest.configuration.map((entry) => entry.path),
    [
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
    ],
  );
  const identities = [await fileIdentity(file)];
  for (const binding of [
    manifest.package,
    manifest.extraction_evidence,
    ...manifest.configuration,
  ]) {
    assert.ok(path.isAbsolute(binding.path));
    const identity = await fileIdentity(binding.path);
    assert.equal(identity.sha256, binding.sha256, "Linux package input changed");
    assert.equal(identity.bytes, binding.bytes);
    identities.push(identity);
  }
  const rawReceipt = await readObject(manifest.extraction_evidence.path);
  const receipt = {
    ...rawReceipt,
    exit_code: rawReceipt.exit_code,
    package_sha256: rawReceipt.package_sha256,
    command: rawReceipt.command,
    payload_root: text(rawReceipt.payload_root),
    executable_sha256: rawReceipt.executable_sha256,
  };
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.package_sha256, manifest.package.sha256);
  assert.deepEqual(receipt.command, [
    "dpkg-deb",
    "--extract",
    manifest.package.path,
    receipt.payload_root,
  ]);
  assert.ok(path.isAbsolute(receipt.payload_root));
  assert.equal(executable.path, path.join(receipt.payload_root, "usr/bin/portcove-desktop"));
  assert.equal(receipt.executable_sha256, executable.sha256);
  assert.equal((await fileIdentity(executable.path)).sha256, executable.sha256);
  return { manifest, receipt, identities, execution_context: manifest.execution_context };
}

export async function createOriginBoundaryFixture() {
  const requests: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<!doctype html><title>Owned untrusted origin</title><h1>Owned untrusted origin</h1>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/untrusted`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function linuxOriginBoundaryScenario({
  browser,
  invoke,
  library,
  output,
  artifacts,
  fixture,
}: MainContext & {
  browser: WebDriver;
  output: string;
  artifacts: string[];
  fixture: Awaited<ReturnType<typeof createOriginBoundaryFixture>>;
}) {
  assert.equal(process.platform, "linux");
  const report: {
    outcome: string;
    fixture: string;
    observations: OriginObservations;
    failure?: { name: string; message: string; stack: string | undefined };
    fixtureRequests?: (string | undefined)[];
    interpretation?: string;
  } = { outcome: "failed", fixture: fixture.url, observations: {} };
  const observations = report.observations;
  const metadata = () =>
    executeBrowserScript(browser, () => ({
      label:
        (
          window as Window & {
            __TAURI_INTERNALS__?: { metadata?: { currentWebview?: { label?: string } } };
          }
        ).__TAURI_INTERNALS__?.metadata?.currentWebview?.label ?? null,
      ipc:
        typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
          .__TAURI_INTERNALS__?.invoke === "function",
      url: location.href,
    }));
  const select = async (label: string) => {
    let selected: SelectedWebview | undefined;
    await browser.wait(
      async () => {
        for (const handle of await browser.getAllWindowHandles()) {
          await browser.switchTo().window(handle);
          const context = await metadata();
          if (context.label === label) {
            assert.equal(context.ipc, true, "Require actual Tauri IPC, not API absence");
            selected = { handle, ...context };
            return true;
          }
        }
        return false;
      },
      10_000,
      `Owned ${label} webview was not observed`,
    );
    assert.ok(selected);
    return selected;
  };
  const refusals = async (
    name: "secondaryRefusals" | "remoteRefusals" | "sameLabelRefusals",
    customGuard: RegExp,
  ) => {
    const records: OriginRefusal[] = (observations[name] = []);
    for (const [command, args] of [
      ["get_bootstrap_status", {}],
      ["set_locale_preference", { locale: null }],
      ["plugin:dialog|open", { options: {} }],
      ["arm_boundary_main_navigation", {}],
    ] as const) {
      const record: OriginRefusal = { command, args };
      records.push(record);
      record.result = object(await invoke(command, args));
      assert.equal(record.result.ok, false, "The actual privileged request must be refused");
      assert.equal(typeof record.result.error, "string");
      assert.match(
        text(record.result.error),
        command === "plugin:dialog|open" ? /not allowed/i : customGuard,
        "Require the expected host/ACL guard, not malformed arguments or missing IPC",
      );
    }
  };
  try {
    await browser.manage().setTimeouts({ script: 10_000, pageLoad: 10_000 });
    observations.main = await select("main");
    assert.equal(observations.main.url, "tauri://localhost");
    observations.before = await readyMainContext({ browser, invoke, library });
    observations.positiveMutation = object(await invoke("set_locale_preference", { locale: "en" }));
    assert.equal(observations.positiveMutation.ok, true);
    observations.created = object(await invoke("create_boundary_windows"));
    assert.equal(
      observations.created.ok,
      true,
      "Require the explicitly enabled qualification fixture",
    );
    observations.secondary = await select("boundary-secondary");
    assert.equal(observations.secondary.url, observations.main.url);
    await refusals("secondaryRefusals", /only to the main window/);
    observations.remote = await select("boundary-remote");
    assert.equal(observations.remote.url, fixture.url);
    await refusals("remoteRefusals", /not allowed/i);
    await select("main");
    observations.armed = object(await invoke("arm_boundary_main_navigation"));
    assert.equal(observations.armed.ok, true);
    await browser.get(fixture.url);
    observations.sameLabel = await metadata();
    assert.deepEqual(observations.sameLabel, { label: "main", ipc: true, url: fixture.url });
    assert.equal(await browser.getWindowHandle(), observations.main.handle);
    await refusals("sameLabelRefusals", /not allowed/i);
    await browser.get(observations.main.url);
    await browser.wait(async () => (await metadata()).ipc, 10_000);
    observations.returned = await readyMainContext({ browser, invoke, library });
    assert.deepEqual(observations.returned, observations.before);
    observations.returnedLocale = await invoke("get_locale_preference");
    assert.deepEqual(observations.returnedLocale, { ok: true, value: { locale: "en" } });
    observations.restoredLocale = object(await invoke("set_locale_preference", { locale: null }));
    assert.equal(observations.restoredLocale.ok, true);
    report.outcome = "passed";
  } catch (error) {
    report.failure = {
      name: error instanceof Error ? error.name : "Error",
      message: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    throw error;
  } finally {
    report.fixtureRequests = [...fixture.requests];
    report.interpretation =
      "Qualification-feature Linux IPC origin observations; not ordinary shipping, device permissions, installed/updater or minimum-environment proof.";
    const file = path.join(output, "linux-webview-origin-boundary.json");
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    artifacts.push(file);
  }
}

// Evidence binding only; this does not authorize signing, installation or publication.
export async function verifyNormalPackageEvidence(
  file: string,
  revision: string,
  executable: { sha256: string; path?: string },
  root: string,
) {
  assert.ok(file && path.isAbsolute(file), "Normal package evidence requires an absolute path");
  const raw = await readObject(file);
  const manifest = {
    ...raw,
    revision: text(raw.revision),
    build_command: strings(raw.build_command),
    qualification_features: strings(raw.qualification_features),
    configuration: configurations(raw.configuration),
    installer: binding(raw.installer),
    installer_evidence: binding(raw.installer_evidence),
    execution_context:
      raw.execution_context === undefined ? undefined : text(raw.execution_context),
  };
  assert.equal(manifest.revision, revision, "Package source must match the current candidate");
  assert.deepEqual(manifest.build_command, [
    "pnpm",
    "--dir",
    "apps/desktop",
    "desktop:build",
    "--bundles",
    "nsis",
  ]);
  assert.deepEqual(manifest.qualification_features, []);
  const identities = [await fileIdentity(file)];
  for (const binding of [
    manifest.installer,
    manifest.installer_evidence,
    ...manifest.configuration,
  ]) {
    assert.ok(path.isAbsolute(binding.path));
    const identity = await fileIdentity(binding.path);
    assert.equal(identity.sha256, binding.sha256, "Package evidence input changed");
    identities.push(identity);
  }
  assert.deepEqual(
    manifest.configuration.map((binding) => path.resolve(binding.path)),
    [
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      path.join(root, "apps/desktop/src-tauri/tauri.windows.conf.json"),
      path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
    ],
  );
  const rawReceipt = await readObject(manifest.installer_evidence.path);
  const receipt = { ...rawReceipt, phase: rawReceipt.phase, details: object(rawReceipt.details) };
  assert.equal(receipt.details.installer_sha256, manifest.installer.sha256);
  assert.equal(receipt.details.installed_executable_sha256, executable.sha256);
  const context = manifest.execution_context ?? "retained-installed-bytes";
  assert.ok(
    context === "retained-installed-bytes" || context === "current-installed",
    "Unknown normal package execution context",
  );
  if (context === "current-installed") {
    assert.equal(receipt.phase, "current_installed_boundary_ready");
    assert.equal(receipt.details.uninstall_registration_count, 1);
    assert.match(
      text(receipt.details.registration_path),
      /HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\/i,
    );
    assert.ok(executable.path);
    assert.equal(path.resolve(text(receipt.details.installed_executable_path)), executable.path);
    assert.equal(
      path.dirname(executable.path),
      path.resolve(text(receipt.details.install_root)),
      "Native executable must remain in the verified installation",
    );
    const installed = await fileIdentity(executable.path);
    assert.equal(installed.sha256, executable.sha256);
    identities.push(installed);
    assert.equal(receipt.details.application_responding, true);
    assert.equal(receipt.details.application_exit_code, 0);
    assert.equal(receipt.details.persistent_data_preserved, true);
    return { manifest, receipt, identities, execution_context: context };
  }
  assert.equal(receipt.phase, "complete");
  for (const field of [
    "application_responding",
    "persistent_data_preserved",
    "managed_files_removed",
    "registration_removed",
  ])
    assert.equal(receipt.details[field], true, field);
  assert.equal(receipt.details.application_exit_code, 0);
  return { manifest, receipt, identities, execution_context: context };
}

export async function normalPackageBoundaryScenario({
  browser,
  invoke,
  library,
  preferencesPath,
  output,
  artifacts,
  packageEvidence,
  externalBrowser,
}: Omit<NormalContext, "observations"> & {
  preferencesPath: string;
  output: string;
  artifacts: string[];
  packageEvidence: NonNullable<NormalObservations["package"]>;
  externalBrowser?: ExternalBrowser;
}) {
  const observations: NormalObservations = { package: packageEvidence };
  const requests: BoundaryRequest[] = [];
  const marker = `__untrustedBoundary_${randomUUID().replaceAll("-", "")}`;
  const beacon = `/untrusted/executed-${marker}`;
  let phase = "main-controls";
  observations.navigationPhases = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      user_agent: request.headers["user-agent"] ?? null,
      observed_at: new Date().toISOString(),
      phase,
    });
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>Owned untrusted origin</title><script>window[${JSON.stringify(marker)}] = true; new Image().src = ${JSON.stringify(beacon)}</script>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const initialUrl = await browser.getCurrentUrl();
    assertLocalMainUrl(initialUrl);
    await browser.manage().setTimeouts({ script: 10_000, pageLoad: 10_000 });
    await assertMainWebviewAccess({ browser, invoke, library, observations });
    await assertReviewedLinkRefusals({ browser, invoke, library, observations });
    observations.qualificationCommands = {};
    for (const command of [
      "create_boundary_windows",
      "queue_boundary_reply",
      "recreate_boundary_owner",
      "arm_boundary_main_navigation",
    ] as const) {
      const result = object(await invoke(command));
      observations.qualificationCommands[command] = result;
      assert.equal(result.ok, false);
      assert.match(text(result.error), /command .* not found/i);
    }
    await assertSecondaryCreationRefusal({ browser, invoke, library, observations });
    observations.assets = strings(
      await browser.executeScript(() =>
        [...document.scripts].filter((script) => script.src).map((script) => script.src),
      ),
    );
    assert.ok(observations.assets.length > 0);
    assert.ok(
      observations.assets.every((source) => {
        const asset = new URL(source),
          main = new URL(initialUrl);
        return asset.protocol === main.protocol && asset.host === main.host;
      }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const fixtureUrl = `http://127.0.0.1:${address.port}/untrusted`;
    phase = "frame-csp";
    await assertRemoteFrameCsp({ browser, invoke, library, fixtureUrl, observations });
    if (process.platform === "linux") {
      phase = "approved-external-browser";
      await observeLinuxApprovedLink({ browser, invoke, library, observations, externalBrowser });
    }
    phase = "main-containment";
    await assertMainWebviewContainment({
      browser,
      invoke,
      library,
      preferencesPath,
      observations,
      initialUrl,
      fixtureUrl,
      onNavigation: (destination) => {
        phase = destination === fixtureUrl ? "navigation-http" : "navigation-alias";
        observations.navigationPhases?.push({ destination, started_at: new Date().toISOString() });
      },
    });
    phase = "returned-main";
    observations.returnedMain = object(await invoke("get_bootstrap_status"));
    assert.equal(observations.returnedMain.ok, true);
    assert.equal(path.resolve(text(object(observations.returnedMain.value).library_root)), library);
    observations.remoteMarkerExecuted = await browser.executeScript(
      (name) => Reflect.get(window, name) === true,
      marker,
    );
    assert.equal(observations.remoteMarkerExecuted, false);
    const diagnostics = (
      await readFile(
        path.join(path.dirname(preferencesPath), "diagnostics", "portcove-desktop.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return object(value);
      });
    observations.nativePermissionDenials = diagnostics.filter(
      (entry) => object(entry.fields).operation_id === "webview-permission",
    );
    if (process.platform === "win32")
      assert.ok(
        observations.nativePermissionDenials.length > 0,
        "Actual native permission denial is required",
      );
    else
      observations.nativePermissionInterpretation =
        "Linux engine/API outcomes are recorded separately; Windows COM denial callbacks are inapplicable.";
    // WebView2 NavigationStarting cancellation preserves the page but explicitly
    // permits a speculative GET while the host responds. Do not claim network silence.
  } finally {
    observations.fixtureCloseStartedAt = new Date().toISOString();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    observations.fixtureClosedAt = new Date().toISOString();
    observations.fixtureRequests = requests;
    observations.remoteExecutionBeacon = {
      path: beacon,
      requests: requests.filter((request) => request.path === beacon),
    };
    const report = path.join(output, "normal-package-boundary.json");
    await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
    artifacts.push(report);
  }
  return requests;
}

export function assertOwnedBoundaryRequests(
  requests: readonly Pick<BoundaryRequest, "method" | "path" | "phase">[],
) {
  for (const request of requests) {
    assert.equal(request.method, "GET", "Unexpected fixture request method");
    assert.equal(
      request.path,
      "/untrusted",
      "Popup or remote execution beacon must receive no request",
    );
    assert.equal(
      request.phase,
      "navigation-http",
      "Fixture requests must belong to attempted HTTP navigation",
    );
  }
}

async function assertReviewedLinkRefusals({
  browser,
  invoke,
  library,
  observations,
}: NormalContext) {
  observations.reviewedLinkRefusals = [];
  const context = () => readyMainContext({ browser, invoke, library });
  for (const request of [
    {
      command: "open_external_url",
      args: { url: "https://unreviewed.portcove.invalid/boundary" },
      expected: {
        code: "usage",
        message: "only reviewed project, artwork source and GitHub sign-in links may be opened",
      },
    },
    {
      command: "open_source_evidence",
      args: { evidenceId: "portcove-boundary-unknown-evidence" },
      expected: {
        code: "not_found",
        message: "unknown source evidence id: portcove-boundary-unknown-evidence",
      },
    },
  ]) {
    const record: LinkRefusal = { ...request };
    observations.reviewedLinkRefusals.push(record);
    record.before = await context();
    assertLocalMainUrl(record.before.url);
    record.result = object(await invoke(request.command, request.args));
    assert.equal(record.result.ok, false, "Unreviewed link must be refused");
    assert.equal(
      object(record.result.error).code,
      request.expected.code,
      "Require the actual link guard",
    );
    assert.equal(object(record.result.error).message, request.expected.message);
    record.after = await context();
    assert.deepEqual(record.after, record.before, "Refusal must preserve main and library context");
  }
}

async function readyMainContext({ browser, invoke, library }: MainContext) {
  const bootstrapReply = object(await invoke("get_bootstrap_status"));
  assert.equal(bootstrapReply.ok, true);
  const raw = object(bootstrapReply.value);
  assert.equal(raw.ready, true, "Boundary refusal requires a ready library");
  assert.equal(raw.error, null);
  const library_root = text(raw.library_root);
  assert.equal(path.resolve(library_root), path.resolve(library));
  assert.ok(
    typeof raw.generation === "number" &&
      Number.isSafeInteger(raw.generation) &&
      raw.generation > 0,
  );
  const selection = object(raw.selection);
  const selectionRoot = text(selection.root);
  assert.equal(path.resolve(selectionRoot), path.resolve(library));
  // This observation consumes a projection of the Rust-owned contract and keeps
  // all other fields as opaque metadata; it is not full-schema admission.
  const bootstrap: Pick<
    OutputDesktopBootstrapStatus,
    "ready" | "error" | "library_root" | "generation"
  > & { selection: Pick<LibrarySelection, "root"> } = {
    ...raw,
    ready: true,
    error: null,
    library_root,
    generation: raw.generation,
    selection: { ...selection, root: selectionRoot },
  };
  const identityReply = object(
    await invoke("get_library_identity", { generation: bootstrap.generation }),
  );
  assert.equal(identityReply.ok, true, "Library identity must remain available");
  const identityRaw = object(identityReply.value);
  const id = text(identityRaw.id),
    identityRoot = text(identityRaw.root);
  assert.ok(id.length > 0);
  assert.equal(
    path.toNamespacedPath(path.resolve(identityRoot)),
    path.toNamespacedPath(path.resolve(library)),
  );
  const identity: LibraryIdentity = { ...identityRaw, id, root: identityRoot };
  return { bootstrap, identity, url: await browser.getCurrentUrl() };
}

async function captureSecondaryContext({ browser, invoke, library }: MainContext) {
  const readers = [
    ["context", () => readyMainContext({ browser, invoke, library })],
    ["locale", () => invoke("get_locale_preference")],
    ["windows", () => invoke("plugin:window|get_all_windows")],
    ["webviews", () => invoke("plugin:webview|get_all_webviews")],
  ] as const;
  const outcomes = await Promise.allSettled(
    readers.map(([, read]) => Promise.resolve().then(read)),
  );
  const snapshot: SecondarySnapshot = { readFailures: {} };
  for (const [index, outcome] of outcomes.entries()) {
    const reader = readers[index];
    assert.ok(reader);
    const [name] = reader;
    if (outcome.status === "fulfilled") snapshot[name] = outcome.value;
    else
      snapshot.readFailures[name] =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
  }
  return snapshot;
}

function assertSecondaryMainContext(snapshot: SecondarySnapshot) {
  assert.deepEqual(snapshot.readFailures, {}, "Require every actual native context observation");
  assertLocalMainUrl(text(object(snapshot.context).url));
  assert.deepEqual(snapshot.windows, { ok: true, value: ["main"] });
  assert.deepEqual(snapshot.webviews, {
    ok: true,
    value: [{ window_label: "main", label: "main" }],
  });
  assert.equal(object(snapshot.locale).ok, true);
  assert.equal(object(object(snapshot.locale).value).locale, "en");
}

async function assertSecondaryCreationRefusal({
  browser,
  invoke,
  library,
  observations,
}: NormalContext) {
  const command = "plugin:webview|create_webview_window";
  // The pinned SDK sends valid WindowConfig options. ACL refusal precedes
  // argument decoding, so it proves refusal of this request, not option parsing.
  const args = {
    options: {
      label: "portcove-boundary-secondary",
      url: "index.html",
      title: "Owned denied secondary boundary",
      visible: false,
    },
  };
  const record: CreationObservation = { request: { command, args } };
  observations.secondaryCreation = record;
  record.before = await captureSecondaryContext({ browser, invoke, library });
  assertSecondaryMainContext(record.before);
  try {
    record.result = object(await invoke(command, args));
  } catch (error) {
    record.invocationFailure = error instanceof Error ? errorMessage(error) : String(error);
  }
  // Keep every post-attempt observation even when creation unexpectedly succeeds,
  // its reply fails, or another observation fails. Existing IPC bounds still apply.
  record.after = await captureSecondaryContext({ browser, invoke, library });
  assert.equal(record.invocationFailure, undefined, record.invocationFailure);
  assert.ok(record.result);
  assert.equal(record.result.ok, false, "Unauthorized secondary creation must be refused");
  assert.equal(record.result.error, `Command ${command} not allowed by ACL`);
  assertSecondaryMainContext(record.after);
  assert.deepEqual(record.after, record.before, "Creation refusal must preserve native main state");
}

async function assertRemoteFrameCsp({
  browser,
  invoke,
  library,
  fixtureUrl,
  observations,
}: NormalContext & { fixtureUrl: string }) {
  // An origin-root URL keeps the expected resource unambiguous even when an
  // engine strips cross-origin report paths. This server is owned by this run.
  const attempted = new URL("/", fixtureUrl).href;
  const record: FrameObservation = { attempted };
  observations.cspFrame = record;
  record.before = await readyMainContext({ browser, invoke, library });
  record.refusal = object(
    await browser.executeAsyncScript((url, done) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = "Owned untrusted frame boundary fixture";
      let completed = false;
      const finish = (
        result:
          | { observed: false; reason: string }
          | {
              observed: true;
              trusted: boolean;
              directive: string;
              disposition: string;
              blockedUri: string;
              documentUri: string;
              originalPolicy: string;
              frameConnected: boolean;
            },
      ) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        document.removeEventListener("securitypolicyviolation", onViolation);
        frame.remove();
        done({ ...result, frameRemoved: !frame.isConnected });
      };
      const onViolation = (event: SecurityPolicyViolationEvent) => {
        if (
          !event.isTrusted ||
          event.effectiveDirective !== "frame-src" ||
          event.disposition !== "enforce"
        )
          return;
        let blocked;
        try {
          blocked = new URL(event.blockedURI).href;
        } catch {
          return;
        }
        if (blocked !== url) return;
        finish({
          observed: true,
          trusted: event.isTrusted,
          directive: event.effectiveDirective,
          disposition: event.disposition,
          blockedUri: event.blockedURI,
          documentUri: event.documentURI,
          originalPolicy: event.originalPolicy,
          frameConnected: frame.isConnected,
        });
      };
      // Cleanup precedes the existing ten-second WebDriver script deadline.
      const timer = setTimeout(
        () => finish({ observed: false, reason: "no-enforced-frame-refusal" }),
        9000,
      );
      document.addEventListener("securitypolicyviolation", onViolation);
      try {
        frame.src = url;
        document.body.append(frame);
      } catch {
        finish({ observed: false, reason: "frame-setup-failed" });
      }
    }, attempted),
  );
  assert.equal(record.refusal.observed, true, "An enforced owned-frame CSP refusal is required");
  assert.equal(record.refusal.trusted, true);
  assert.equal(record.refusal.directive, "frame-src");
  assert.equal(record.refusal.disposition, "enforce");
  assert.equal(new URL(text(record.refusal.blockedUri)).href, attempted);
  assert.equal(record.refusal.documentUri, record.before.url);
  assert.equal(record.refusal.frameConnected, true);
  assert.equal(record.refusal.frameRemoved, true);
  record.after = await readyMainContext({ browser, invoke, library });
  assert.deepEqual(
    record.after,
    record.before,
    "Frame refusal must preserve main and library context",
  );
}

export async function assertMainWebviewAccess({
  browser,
  invoke,
  library,
  observations,
}: MainScenarioContext) {
  observations.permissionPolicy = await browser.executeScript(() => {
    const policyDocument = document as Document & {
      permissionsPolicy?: { allowsFeature(name: string): boolean };
      featurePolicy?: { allowsFeature(name: string): boolean };
    };
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
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
  observations.permissionStates = await browser.executeAsyncScript((done) => {
    void Promise.all(
      (["camera", "microphone", "geolocation", "notifications"] as const).map(async (name) => {
        try {
          return [name, (await navigator.permissions.query({ name })).state];
        } catch {
          return [name, "unsupported"];
        }
      }),
    ).then((entries) => done(Object.fromEntries(entries)));
  });
  const positive = object(await invoke("get_bootstrap_status"));
  observations.main = positive;
  assert.equal(positive.ok, true);
  const mutation = object(await invoke("set_locale_preference", { locale: "en" }));
  observations.mainMutation = mutation;
  assert.equal(mutation.ok, true);
  assert.equal(path.resolve(text(object(positive.value).library_root)), path.resolve(library));
}

export async function assertMainWebviewContainment({
  browser,
  invoke,
  preferencesPath,
  observations,
  fixtureUrl,
  initialUrl,
  onNavigation = () => {},
}: MainScenarioContext & {
  preferencesPath: string;
  fixtureUrl: string;
  initialUrl: string;
  onNavigation?: (destination: string) => void;
}) {
  const preservedLocale = object(await invoke("get_locale_preference"));
  observations.preservedLocale = preservedLocale;
  assert.equal(object(preservedLocale.value).locale, "en");
  observations.popup = object(
    await browser.executeAsyncScript((url, done) => {
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
    }, fixtureUrl),
  );
  assert.equal(observations.popup.refused, true);
  observations.cspInline = object(
    await browser.executeAsyncScript((done) => {
      const handler = (event: SecurityPolicyViolationEvent) => {
        if (event.violatedDirective.startsWith("script-src")) {
          document.removeEventListener("securitypolicyviolation", handler);
          done({
            directive: event.violatedDirective,
            blockedUri: event.blockedURI,
            executed: (window as Window & { __boundaryInline?: unknown }).__boundaryInline === true,
          });
        }
      };
      document.addEventListener("securitypolicyviolation", handler);
      const script = document.createElement("script");
      script.textContent = "window.__boundaryInline = true";
      document.body.append(script);
    }),
  );
  assert.equal(observations.cspInline.executed, false);
  assert.equal(observations.cspInline.blockedUri, "inline");
  try {
    observations.permissionRequests = object(
      await browser.executeAsyncScript((done) => {
        const kinds = ["notifications", "geolocation", "media"];
        const progress = Object.fromEntries(kinds.map((kind) => [kind, "pending"]));
        (
          window as Window & { __portcovePermissionProgress?: Record<string, string> }
        ).__portcovePermissionProgress = progress;
        type PermissionEntry = [string, string | { code: number } | { name: unknown }];
        const requests: Promise<PermissionEntry>[] = [
          Notification.requestPermission().then((value): PermissionEntry => [
            "notifications",
            value,
          ]),
          new Promise<PermissionEntry>((resolve) =>
            navigator.geolocation.getCurrentPosition(
              () => resolve(["geolocation", "unexpected-grant"]),
              (error) => resolve(["geolocation", { code: error.code }]),
              { timeout: 5000 },
            ),
          ),
          navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(
            (stream): PermissionEntry => {
              stream.getTracks().forEach((track) => track.stop());
              return ["media", "unexpected-grant"];
            },
            (error: unknown): PermissionEntry => [
              "media",
              {
                name:
                  error !== null && typeof error === "object" && "name" in error
                    ? error.name
                    : undefined,
              },
            ],
          ),
        ];
        void Promise.all(
          requests.map((request, index) =>
            request.then(
              (entry) => {
                const value = entry[1];
                const kind = kinds[index];
                if (kind === undefined)
                  return Promise.reject(new Error("Permission request identity missing"));
                const outcome =
                  typeof value === "string"
                    ? value
                    : kinds[index] === "geolocation"
                      ? `code-${"code" in value ? value.code : undefined}`
                      : "name" in value
                        ? value.name
                        : undefined;
                progress[kind] = [
                  "denied",
                  "default",
                  "granted",
                  "unexpected-grant",
                  "code-1",
                  "code-2",
                  "code-3",
                  "NotAllowedError",
                  "OverconstrainedError",
                  "NotFoundError",
                  "NotReadableError",
                  "AbortError",
                  "SecurityError",
                  "InvalidStateError",
                  "NotSupportedError",
                  "TypeError",
                ].includes(typeof outcome === "string" ? outcome : "")
                  ? typeof outcome === "string"
                    ? outcome
                    : "unclassified"
                  : "unclassified";
                return entry;
              },
              (error: unknown) => {
                const kind = kinds[index];
                if (kind !== undefined) progress[kind] = "rejected";
                return Promise.reject(error);
              },
            ),
          ),
        ).then((entries) => done(Object.fromEntries(entries)));
      }),
    );
  } catch (original) {
    // Read-only failure diagnostics cannot supply acceptance or replace the failure.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Error("Permission progress readback deadline");
    try {
      const requests = await Promise.race([
        browser.executeScript(() => {
          const progress = (
            window as Window & { __portcovePermissionProgress?: Record<string, unknown> }
          ).__portcovePermissionProgress;
          const allowed = [
            "pending",
            "rejected",
            "denied",
            "default",
            "granted",
            "unexpected-grant",
            "code-1",
            "code-2",
            "code-3",
            "NotAllowedError",
            "OverconstrainedError",
            "NotFoundError",
            "NotReadableError",
            "AbortError",
            "SecurityError",
            "InvalidStateError",
            "NotSupportedError",
            "TypeError",
            "unclassified",
          ];
          return Object.fromEntries(
            ["notifications", "geolocation", "media"].map((kind) => {
              const outcome = progress?.[kind];
              return [
                kind,
                typeof outcome === "string" && allowed.includes(outcome) ? outcome : "unclassified",
              ];
            }),
          );
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(deadline), 1000);
        }),
      ]);
      observations.permissionRequestDiagnostic = { status: "captured", requests };
    } catch (error) {
      observations.permissionRequestDiagnostic = {
        status: "unavailable",
        reason: error === deadline ? "deadline" : "read-error",
      };
    } finally {
      clearTimeout(timer);
    }
    throw original;
  }
  assert.equal(observations.permissionRequests.notifications, "denied");
  assert.equal(object(observations.permissionRequests.geolocation).code, 1);
  assert.notEqual(observations.permissionRequests.media, "unexpected-grant");
  const diagnosticPath = path.join(
    path.dirname(preferencesPath),
    "diagnostics",
    "portcove-desktop.jsonl",
  );
  const navigationRefusals = async () =>
    (await readFile(diagnosticPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return object(value);
      })
      .filter(
        (entry) =>
          object(entry.fields).operation_id === "webview-navigation" &&
          object(entry.fields).webview_label === "main",
      );
  observations.navigationRefusals = [];
  observations.navigationRequests = [];
  const inactiveAlias =
    process.platform === "linux"
      ? new URL(new URL(initialUrl).pathname, "http://tauri.localhost")
      : new URL(initialUrl);
  if (process.platform !== "linux")
    inactiveAlias.protocol = inactiveAlias.protocol === "http:" ? "https:" : "http:";
  for (const destination of [fixtureUrl, inactiveAlias.href]) {
    onNavigation(destination);
    const previous = (await navigationRefusals()).length;
    const request: { destination: string; trigger: string; scheduled?: unknown } = {
      destination,
      trigger: process.platform === "linux" ? "page-location" : "webdriver-get",
    };
    observations.navigationRequests.push(request);
    let deadline;
    if (process.platform === "linux") {
      deadline = Date.now() + 10_000;
      request.scheduled = await browser.executeScript((url) => {
        setTimeout(() => {
          window.location.href = url;
        }, 0);
        return true;
      }, destination);
      assert.equal(request.scheduled, true, "Navigation scheduling acknowledgement is required");
    } else {
      assert.ok(typeof browser.get === "function", "WebDriver navigation required");
      await browser.get(destination);
      deadline = Date.now() + 10_000;
    }
    while ((await navigationRefusals()).length <= previous) {
      if (Date.now() >= deadline)
        throw new Error("New navigation refusal was not observed by the native host");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const currentUrl = await browser.getCurrentUrl();
    assert.equal(currentUrl, initialUrl);
    observations.navigationRefusals.push({
      attempted: destination,
      current: currentUrl,
      native: (await navigationRefusals()).at(-1),
    });
  }
  observations.mainNavigatedUrl = await browser.getCurrentUrl();
  assert.equal(observations.mainNavigatedUrl, initialUrl);
  // Constraint rejection can precede permission handling on a device-less host.
  // Collect independent navigation evidence before retaining the strict failure.
  assert.equal(object(observations.permissionRequests.media).name, "NotAllowedError");
}
